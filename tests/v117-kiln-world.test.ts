import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventBus } from '../src/core/events';
import { Logger } from '../src/core/log';
import { KilnModeling, goneFromKiln, KilnHttpError } from '../src/core/modeling/kiln-modeling';
import { KILN_BUILD, registerKilnTools } from '../src/core/capabilities/kiln-tools';
import { KilnBuildQueue, type BuildEnd } from '../src/core/modeling/kiln-queue';
import { ROLES, hiddenToolsFor } from '../src/core/agents/roles';
import { ZFIGHT_MIN_GAP, runZFight, zfightCount, zfightFindings, zfightFocus, zfightLuau, zfightPath, zfightSummary, type ZFightReport } from '../src/core/roblox/zfight';
import { LIVE_SUGGESTIONS, LiveSuggestions, STOCK, rotation } from '../src/core/director/live-suggestions';
import { ChatService } from '../src/core/director/chat-service';
import type { ProjectContext } from '../src/core/projects/project-service';
import type { CallerContext, ToolDefinition } from '../src/core/capabilities/tool-registry';
import { fakeBlender, fakeKiln } from './helpers/fake-kiln';
import { coreHarness, waitFor } from './helpers/make-core';

/** 1.17: Kiln gets the login, only this game's Kiln projects are touched, no Z-fighting in the place, and the bubbles rotate. */

const tmp = mkdtempSync(join(tmpdir(), 'v117-kiln-'));
const root = join(tmp, 'project');
mkdirSync(join(root, 'models'), { recursive: true });
const kiln = await fakeKiln(tmp, { running: true });
const blender = fakeBlender();
const modeling = new KilnModeling(
  blender.backend,
  {
    enabled: () => false,
    resourcesDir: resolve(__dirname, '..', 'resources'),
    runtimeFile: () => kiln.runtimeFile,
    // The calling run's account (Kiln follows Shuriken); the UI's own call runs on this window's account.
    account: (runId) => (runId === 'run_mako' ? { kind: 'folder', dir: 'C:\Shuriken\login' } : runId === 'run_key' ? { kind: 'api-key', apiKey: 'sk-ant-api03-test' } : null),
  },
  new EventBus(),
  new Logger(null, null).scope('kiln'),
);
type Handler = ToolDefinition['handler'];
const tools = new Map<string, Handler>();
const reg = { register: (def: { name: string; handler: Handler }) => void tools.set(def.name, def.handler), get: () => undefined, invoke: async () => ({ content: [] }) } as never;
registerKilnTools(reg, { project: () => ({ root }) as unknown as ProjectContext, kiln: () => modeling, modeling: () => blender.backend, bus: new EventBus() });
const agent = (runId: string): CallerContext => ({ kind: 'agent', runId, taskId: null, role: 'modeler', providerId: null, allowedTools: null });
const call = async (name: string, args: Record<string, unknown>, caller: CallerContext = agent('run_mako')) => {
  const out = await tools.get(name)!({ args, caller, signal: new AbortController().signal } as never);
  return { out, text: out.content.map((c) => ('text' in c ? c.text : '')).join('\n'), data: out.data as Record<string, any> | undefined };
};

const savedEnv = process.env.SHURIKEN_NO_KILN;
beforeAll(async () => {
  delete process.env.SHURIKEN_NO_KILN;
  KILN_BUILD.pausedWaitMs = 100;
  await modeling.kiln.check(true);
});
afterAll(async () => {
  if (savedEnv === undefined) delete process.env.SHURIKEN_NO_KILN;
  else process.env.SHURIKEN_NO_KILN = savedEnv;
  modeling.stop();
  await kiln.close();
});

describe('Kiln follows Shuriken: every brief carries the login of the run that asked', () => {
  it('sends the asking run’s login with the brief (Shuriken’s own folder, or its API key)', async () => {
    await call('kiln_request', { model: 'Crate', text: 'A weathered crate.', wait: false });
    expect(kiln.hits(/\/chat$/).at(-1)!.body).toMatchObject({ from: 'shuriken', account: { kind: 'folder', dir: 'C:\Shuriken\login' } });
    await call('kiln_request', { model: 'Barrel', text: 'An oil barrel.', wait: false }, agent('run_key'));
    expect(kiln.hits(/\/chat$/).at(-1)!.body).toMatchObject({ account: { kind: 'api-key', apiKey: 'sk-ant-api03-test' } });
    // Not known (an older run, a test): no account field; Kiln uses the PC's own login.
    await call('kiln_request', { model: 'Lamp', text: 'A street lamp.', wait: false }, agent('run_unknown'));
    expect(kiln.hits(/\/chat$/).at(-1)!.body.account).toBeUndefined();
  });
});

describe('fresh models only: this game’s own Kiln projects, nothing else of Kiln’s', () => {
  it('a link to a project Kiln no longer has counts as a new model and gets a fresh project', async () => {
    mkdirSync(join(root, '.shuriken', 'kiln'), { recursive: true });
    writeFileSync(join(root, '.shuriken', 'kiln', 'Statue.json'), JSON.stringify({ projectId: 'archived-statue' }));
    expect(await modeling.projectExists('archived-statue')).toBe(false);
    const made = kiln.hits(/^\/api\/v1\/projects$/, 'POST').length;
    const r = await call('kiln_request', { model: 'Statue', text: 'A mossy statue.', wait: false });
    expect(r.out.isError).toBeFalsy();
    expect(kiln.hits(/^\/api\/v1\/projects$/, 'POST')).toHaveLength(made + 1);
    const fresh = modeling.linkedProject(root, 'Statue')!;
    expect(fresh).not.toBe('archived-statue');
    expect(fresh).toMatch(/^statue-/);
    expect(kiln.hits(/\/chat$/).at(-1)!.path).toBe(`/api/v1/projects/${fresh}/chat`);
  });

  it('kiln_status lists this game’s projects only, and an agent can’t pick another of Kiln’s projects', async () => {
    const foreign = (await modeling.kiln.post('/api/v1/projects', { title: 'Someone else' })) as { id: string };
    const s = await call('kiln_status', {});
    const ids = (s.data!.projects as Array<{ id: string; models: string[] }>).map((p) => p.id);
    expect(ids).not.toContain(foreign.id);
    expect(ids).toContain(modeling.linkedProject(root, 'Crate'));
    expect(s.data!.projects.find((p: { models: string[] }) => p.models.includes('Crate'))).toBeTruthy();
    await expect(call('kiln_clips', { kiln_project: foreign.id })).rejects.toThrow(/isn't one of this game's Kiln projects \(kiln_status lists them\)\. A new model always gets a fresh Kiln project/);
    // The user (Kiln's own "Use in this game") may bring in any of their projects.
    await expect(call('kiln_clips', { kiln_project: foreign.id }, { ...agent('run_mako'), kind: 'ui' })).resolves.toBeTruthy();
    expect(modeling.gameProjects(root).has(foreign.id)).toBe(false);
    expect(modeling.gameProjects(root).has(modeling.linkedProject(root, 'Crate')!)).toBe(true);
  });

  it('kiln_status drops links Kiln no longer has, and says those models are new', async () => {
    writeFileSync(join(root, '.shuriken', 'kiln', 'Fountain.json'), JSON.stringify({ projectId: 'archived-fountain' }));
    const s = await call('kiln_status', {});
    expect(s.data!.goneFromKiln).toEqual(['Fountain']);
    expect(s.data!.note).toMatch(/Kiln no longer has the projects of Fountain: they count as new models/);
    expect(modeling.linkedProject(root, 'Fountain')).toBeNull();
  });

  it('tells "gone" from an action an older Kiln doesn’t know', () => {
    expect(goneFromKiln(new KilnHttpError('No such project', 404))).toBe(true);
    expect(goneFromKiln(new KilnHttpError('Unknown project action', 404))).toBe(false);
    expect(goneFromKiln(new KilnHttpError('No such project', 500))).toBe(false);
    expect(goneFromKiln(new Error('No such project'))).toBe(false);
  });
});

describe('the Kiln build limit', () => {
  const makeCore = coreHarness();
  it('is set by the director’s kiln_settings, which clears what the queue lowered by itself', async () => {
    const { core } = await makeCore({ respond: async () => null });
    const km = core.modeling as KilnModeling;
    // Three builds refused as busy while several ran: the queue steps itself down.
    const ends: Array<() => void> = [];
    for (let i = 0; i < 3; i++) km.builds.submit({ root: 'C:/game', name: `M${i}`, kilnProject: `p${i}`, kind: 'new', by: null, runId: null, taskId: null }, () => new Promise<BuildEnd<unknown>>((ok) => ends.push(() => ok({ state: 'failed', error: 'Kiln refused the brief (503)', evidence: { refused: true } }))));
    ends[0]!();
    await waitFor(() => km.builds.stepDown());
    expect(km.builds.status().atOnce).toBeLessThan(16);
    const director: CallerContext = { kind: 'agent', runId: null, taskId: null, role: 'director', providerId: null, allowedTools: null };
    const out = await core.tools.invoke('kiln_settings', { limit: 20, scope: 'app' }, director);
    expect(out.isError).toBeFalsy();
    expect(core.prefs.get().kilnBuildsAtOnce).toBe(20);
    expect(km.builds.stepDown()).toBeNull();
    // (No Kiln answers in this harness: an unknown version is held to six, the setting is what was asked.)
    expect(km.builds.status()).toMatchObject({ atOnce: 6, setting: 20 });
    expect(out.content.map((c) => ('text' in c ? c.text : '')).join('')).toMatch(/The Kiln build limit is 20 now \(every game\)\. The step-down was cleared/);
    // Reading only, and a project's own number.
    const read = await core.tools.invoke('kiln_settings', {}, director);
    expect(read.data).toMatchObject({ atOnce: 6, setting: 20, outage: { down: false } });
    await core.tools.invoke('kiln_settings', { limit: 12 }, director);
    expect(core.project!.settings().kilnBuildsAtOnce).toBe(12);
    expect(ROLES.director!.appTools).toContain('kiln_settings');
    for (const e of ends.slice(1)) e();
  });

  it('is not visible to the workers', () => {
    expect(new KilnBuildQueue({ setting: () => 16, kilnVersion: () => '0.9.0' }).status().atOnce).toBe(16);
    expect(ROLES.modeler!.appTools).toBeNull();
  });
});

describe('Kiln down holds the team; several holds at once', () => {
  const makeCore = coreHarness();
  it('a short hold ending never lifts a long one', async () => {
    const { core } = await makeCore({ respond: async () => null });
    const o = core.orchestrator as unknown as { held: string | null };
    let endKiln!: () => void;
    let endRestore!: () => void;
    core.orchestrator.hold(new Promise<void>((ok) => (endKiln = ok)), "Kiln isn't available, so the build is paused until it's back");
    core.orchestrator.hold(new Promise<void>((ok) => (endRestore = ok)), 'Restoring the world before the team continues');
    expect(o.held).toBe('Restoring the world before the team continues');
    endRestore();
    await waitFor(() => o.held !== 'Restoring the world before the team continues', 2000);
    expect(o.held).toBe("Kiln isn't available, so the build is paused until it's back");
    endKiln();
    await waitFor(() => o.held === null, 2000);
    expect(core.kilnOutage()).toMatchObject({ down: false, paused: false });
  });
});

describe('Z-fighting in the place', () => {
  const report = (over: Partial<ZFightReport> = {}): ZFightReport => ({ areas: ['Map/Arena'], parts: 120, faces: 640, tests: 40, pairs: 0, visible: 0, near: 0, duplicates: 0, list: [], truncated: false, minGap: ZFIGHT_MIN_GAP, ...over });

  it('scans from the generated Luau, with the areas, the focus and the fix filled in', () => {
    const code = zfightLuau({ areas: ['Workspace.Map.Arena'], focus: ['Map/Lobby'], fix: true });
    expect(code).toContain('local AREAS: { string } = { "Map/Arena" }');
    expect(code).toContain('local FOCUS: { string } = { "Map/Lobby" }');
    expect(code).toContain('local FIX: boolean = true');
    expect(code).toContain(`local MIN_GAP: number = ${ZFIGHT_MIN_GAP}`);
    expect(code).not.toMatch(/__[A-Z_]+__/);
    expect(zfightLuau()).toContain('local AREAS: { string } = {  }');
    expect(zfightPath('game.Workspace.Map.Arena')).toBe('Map/Arena');
    expect(ZFIGHT_MIN_GAP).toBe(0.05);
  });

  it('turns a task’s DataModel diff into the areas it built', () => {
    expect(zfightFocus(['Workspace.Map.Lobby.Wall_1#Part', 'Workspace.Map.Lobby.Floor#MeshPart', 'Workspace.Map.Arena.Crate#Model', 'ReplicatedStorage.X#ModuleScript', 'Workspace.Map.Lobby.Light#PointLight'])).toEqual(['Map/Lobby', 'Map/Arena']);
    expect(zfightFocus(['Workspace.Crate#Part'])).toEqual(['Crate']);
    expect(zfightFocus(['ServerScriptService.Main#Script'])).toEqual([]);
    const many = Array.from({ length: 12 }, (_, i) => `Workspace.Map.Area${i}.Part#Part`);
    expect(zfightFocus(many)).toEqual(['Map']);
  });

  it('says plainly what flickers and how to fix it, and counts identical smooth surfaces as no flicker', () => {
    expect(zfightSummary(report())).toBe(`No Z-fighting in Map/Arena: 120 parts, no two faces share a plane or sit closer than ${ZFIGHT_MIN_GAP} studs where they overlap.`);
    expect(zfightFindings(report())).toEqual([]);
    const bad = report({
      pairs: 4,
      visible: 2,
      near: 1,
      duplicates: 1,
      list: [
        { a: 'Map.Arena.Rug', b: 'Map.Arena.Floor', kind: 'coplanar', gap: 0, area: 24, facing: 'up', look: 'different', visible: true, duplicate: false, approx: false },
        { a: 'Map.Arena.Crate', b: 'Map.Arena.Crate', kind: 'coplanar', gap: 0, area: 16, facing: 'up', look: 'same', visible: true, duplicate: true, approx: false },
        { a: 'Map.Arena.Plate', b: 'Map.Arena.Wall', kind: 'near', gap: 0.01, area: 4, facing: 'side', look: 'different', visible: true, duplicate: false, approx: true },
        { a: 'Map.Arena.TileA', b: 'Map.Arena.TileB', kind: 'coplanar', gap: 0, area: 2, facing: 'up', look: 'same', visible: false, duplicate: false, approx: false },
      ],
    });
    expect(zfightCount(bad)).toBe(3);
    expect(zfightSummary(bad)).toBe(`3 pairs of parts Z-fight in Map/Arena (1 a layer closer than ${ZFIGHT_MIN_GAP} studs that flickers at distance), 1 of them a part placed twice: Map.Arena.Rug × Map.Arena.Floor; Map.Arena.Crate × Map.Arena.Crate; Map.Arena.Plate × Map.Arena.Wall. 1 more share a plane with an identical smooth surface (no flicker).`);
    const f = zfightFindings(bad);
    expect(f[1]).toMatch(/^Fix: zfight_fix \{areas: \["Map\/Arena"\]\} merges duplicates and same-look neighbours, removes a hidden copy and lifts the smaller face 0\.05 studs clear/);
    expect(f[1]).toMatch(/AllowOverlap = true/);
    expect(zfightSummary({ ...report(), error: 'Studio went away' })).toBe("The Z-fighting check couldn't run: Studio went away");
  });

  it('reads Studio’s answer, and an answer that isn’t a report is an error, never a pass', async () => {
    const ok = await runZFight({ runLuau: async () => ({ ok: true, output: JSON.stringify(report({ pairs: 1, visible: 1 })), durationMs: 5 }) } as never, { areas: ['Map/Arena'] });
    expect(zfightCount(ok)).toBe(1);
    const odd = await runZFight({ runLuau: async () => ({ ok: true, output: 'nil', durationMs: 5 }) } as never, {});
    expect(odd.error).toMatch(/no report came back/);
    const failed = await runZFight({ runLuau: async () => ({ ok: false, output: 'Studio is not connected', durationMs: 5 }) } as never, {});
    expect(failed.error).toBe('Studio is not connected');
  });

  it('is in the builders’ hands and in front of the critic', () => {
    for (const role of ['level-designer', 'environment-artist', 'modeler']) {
      const text = ROLES[role]!.instructions.replace(/\s+/g, ' ');
      expect(text, role).toMatch(/zfight_check/);
      expect(text, role).toMatch(/zfight_fix/);
      // Workers see both tools (no workshop hides them).
      expect(hiddenToolsFor(ROLES[role]!)?.has('zfight_check') ?? false, role).toBe(false);
    }
    expect(ROLES.critic!.appTools).toContain('zfight_check');
    expect(ROLES.critic!.appTools).not.toContain('zfight_fix');
    expect(ROLES.critic!.instructions.replace(/\s+/g, ' ')).toMatch(/Z-fighting fails it too: the notes carry the Z-fighting check of what the task built/);
  });
});

describe('suggestion bubbles', () => {
  const makeCore = coreHarness();
  const bubbles = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => ({ label: `${prefix} ${i + 1}`, prompt: `${prefix} ${i + 1}: the full, specific request.` }));

  it('show a few of a stock at a time, moving on every rotateMs', () => {
    const stock = bubbles('Idea', 12);
    expect(rotation(stock, 0).slice(0, 3).map((s) => s.label)).toEqual(['Idea 1', 'Idea 2', 'Idea 3']);
    expect(rotation(stock, LIVE_SUGGESTIONS.rotateMs).slice(0, 3).map((s) => s.label)).toEqual(['Idea 4', 'Idea 5', 'Idea 6']);
    expect(rotation(stock, 4 * LIVE_SUGGESTIONS.rotateMs).slice(0, 3).map((s) => s.label)).toEqual(['Idea 1', 'Idea 2', 'Idea 3']);
    expect(rotation(stock, 0)).toHaveLength(12);
    expect(rotation(bubbles('Few', 2), 99_999_999)).toHaveLength(2);
    expect(STOCK).toMatchObject({ director: 12, animation: 8, audio: 8, ui: 8, effects: 8 });
  });

  it('are written as a stock by the strongest model, refilled when used up, and capped per hour', async () => {
    let prompt = '';
    let model: string | undefined;
    const { core, ctx, provider } = await makeCore({
      respond: async (req) => {
        const props = (req.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
        if (!('effects' in props && 'director' in props)) return null;
        prompt = String(req.prompt ?? '');
        model = req.modelTier;
        return { director: bubbles('Griever', 12), animation: bubbles('Run', 8), audio: bubbles('Roar', 8), ui: bubbles('Map', 8), effects: bubbles('Sparks', 8) };
      },
    });
    core.orchestrator.pause();
    const saved = { ...LIVE_SUGGESTIONS };
    try {
      LIVE_SUGGESTIONS.throttleMs = 0;
      const live = new LiveSuggestions({ runner: core.runner, bus: core.bus, log: core.logger.scope('test'), enabled: () => true });
      ctx.tasks.create({ kind: 'objective', title: 'Maze Runner: a Griever that chases players', objective: 'x', role: 'executive', status: 'running', createdBy: 'test' });
      expect(await live.refresh(ctx)).toBe(true);
      expect(model).toBe('deep');
      expect(ROLES.suggester!.effort).toBe('medium');
      expect(live.get(ctx, 'director', 0)!.map((s) => s.label)).toEqual(bubbles('Griever', 12).map((s) => s.label));
      expect(live.get(ctx, 'audio', 0)).toHaveLength(8);
      const runs = () => provider.runs.filter((r) => r.role === 'suggester').length;
      expect(runs()).toBe(1);
      // A set as written isn't used up: nothing new is asked for.
      live.get(ctx, 'director', 0);
      await new Promise((r) => setTimeout(r, 50));
      expect(runs()).toBe(1);
      // The user sends nine of the director's: few are left, so a new stock is written, told what was shown already.
      const chat = new ChatService(ctx, core.bus);
      for (const s of bubbles('Griever', 9)) chat.add({ role: 'user', kind: 'text', text: s.prompt });
      expect(live.unused(ctx, 'director')).toHaveLength(3);
      live.get(ctx, 'director', 0);
      await waitFor(() => runs() === 2, 5000);
      expect(prompt).toMatch(/Bubbles the user has been shown already \(write new ones, never these again\):\n- director: Griever 1/);
      // The hourly cap.
      LIVE_SUGGESTIONS.maxPerHour = 2;
      expect(await live.refresh(ctx, { text: 'x', fingerprint: 'other' })).toBe(false);
      expect(runs()).toBe(2);
    } finally {
      Object.assign(LIVE_SUGGESTIONS, saved);
    }
  });
});
