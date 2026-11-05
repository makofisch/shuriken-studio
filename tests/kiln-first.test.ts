import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EventBus } from '../src/core/events';
import { Logger } from '../src/core/log';
import { KilnModeling, fallbackLine } from '../src/core/modeling/kiln-modeling';
import { KILN_OUTAGE, KILN_PAUSED, type KilnPauseState } from '../src/core/modeling/kiln-outage';
import { KilnLauncher, kilnStartDecision, kilnStartForbidden } from '../src/core/modeling/kiln-launch';
import { KILN_BUILD, registerKilnTools } from '../src/core/capabilities/kiln-tools';
import { registerBlenderTools } from '../src/core/capabilities/blender-tools';
import type { ProjectContext } from '../src/core/projects/project-service';
import type { CallerContext, ToolDefinition } from '../src/core/capabilities/tool-registry';
import { fakeBlender, fakeKiln } from './helpers/fake-kiln';

// Kiln first, for everything: Shuriken starts a Kiln that is installed but not running when a build needs a
// model, agents can't hand-model a new model while Kiln can be reached, and when Kiln can't be reached the
// fallback is said in the chat in one plain line. A fake Kiln and a fake Blender; the user's Kiln is never touched.

const tmp = mkdtempSync(join(tmpdir(), 'kiln-first-'));
const root = join(tmp, 'project');
mkdirSync(join(root, 'models'), { recursive: true });
const kiln = await fakeKiln(tmp, { running: false });
const blender = fakeBlender();
const resourcesDir = resolve(__dirname, '..', 'resources');

let allowed = true;
let exe: string = kiln.exe;
const spawned: string[] = [];
/** The chat's status lines, by id (a line with an id is rewritten). */
const chat = new Map<string, string>();
/** Kiln is required (1.17): the holds the team was put under, the pause notices (by id), and the project's "Run anyway". */
const holds: Array<{ reason: string; released: boolean }> = [];
const notices = new Map<string, { state: KilnPauseState; text: string }>();
let runAnyway = false;
KILN_OUTAGE.pollMs = 40;
KILN_BUILD.pausedWaitMs = 150;
const modeling = new KilnModeling(
  blender.backend,
  {
    enabled: () => false,
    resourcesDir,
    runtimeFile: () => kiln.runtimeFile,
    launch: {
      configured: () => exe,
      allowed: () => allowed,
      spawn: (path) => {
        spawned.push(path);
        kiln.writeRuntime();
      },
      timeoutMs: 3000,
      pollMs: 20,
    },
    note: (text, id) => {
      const key = id ?? `msg${chat.size + 1}`;
      chat.set(key, text);
      return key;
    },
    outage: {
      hold: (until, reason) => {
        const h = { reason, released: false };
        holds.push(h);
        void until.then(() => (h.released = true));
      },
      overridden: () => runAnyway,
      setOverridden: (on) => (runAnyway = on),
      notice: (state, text, id) => {
        const key = id ?? `pause${notices.size + 1}`;
        notices.set(key, { state, text });
        return key;
      },
    },
  },
  new EventBus(),
  new Logger(null, null).scope('kiln'),
);

type Handler = ToolDefinition['handler'];
const tools = new Map<string, Handler>();
const reg = { register: (def: { name: string; handler: Handler }) => void tools.set(def.name, def.handler), get: () => undefined, invoke: async () => ({ content: [] }) } as never;
registerKilnTools(reg, { project: () => ({ root }) as unknown as ProjectContext, kiln: () => modeling, modeling: () => blender.backend, bus: new EventBus() });
registerBlenderTools(reg, { project: () => ({ root }) as unknown as ProjectContext, modeling: blender.backend, bus: new EventBus(), kilnFirst: (r, m) => modeling.kilnFirst(r, m) });
const agent: CallerContext = { kind: 'agent', runId: 'run_first', taskId: null, role: 'modeler', providerId: null, allowedTools: null };
const call = async (name: string, args: Record<string, unknown>, caller: CallerContext = agent) => {
  const out = await tools.get(name)!({ args, caller, signal: new AbortController().signal } as never);
  const text = out.content.map((c) => ('text' in c ? c.text : '')).join('\n');
  return { out, text, data: out.data as Record<string, any> | undefined };
};

const savedEnv = process.env.SHURIKEN_NO_KILN;
beforeAll(async () => {
  delete process.env.SHURIKEN_NO_KILN;
  await modeling.kiln.check(true);
});
afterAll(async () => {
  if (savedEnv === undefined) delete process.env.SHURIKEN_NO_KILN;
  else process.env.SHURIKEN_NO_KILN = savedEnv;
  modeling.stop();
  await kiln.close();
});

describe('whether Shuriken starts Kiln', () => {
  it('starts an installed Kiln that is not running, waits for one that is starting, and says why it cannot', () => {
    expect(kilnStartDecision({ answers: true, processAlive: true, exe: 'K.exe', allowed: true })).toEqual({ do: 'nothing' });
    expect(kilnStartDecision({ answers: false, processAlive: false, exe: 'K.exe', allowed: true })).toEqual({ do: 'start', exe: 'K.exe' });
    // A process that is alive is never launched a second time.
    expect(kilnStartDecision({ answers: false, processAlive: true, exe: 'K.exe', allowed: true })).toEqual({ do: 'wait' });
    expect(kilnStartDecision({ answers: false, processAlive: true, exe: null, allowed: false })).toEqual({ do: 'wait' });
    const off = kilnStartDecision({ answers: false, processAlive: false, exe: 'K.exe', allowed: false });
    expect(off).toMatchObject({ do: 'cannot' });
    expect((off as { why: string }).why).toMatch(/switched off \(Settings → Agents → Kiln\)/);
    expect((kilnStartDecision({ answers: false, processAlive: false, exe: null, allowed: true }) as { why: string }).why).toMatch(/Kiln\.exe wasn't found/);
  });

  it('never starts the real Kiln from a test run, a smoke run or a setup with Kiln switched off', async () => {
    // No `spawn` given: under a test runner the launcher is not permitted to start anything.
    const real = new KilnLauncher({ runtimeFile: () => join(tmp, 'none', 'runtime.json'), check: async () => ({ ok: false, detail: 'Kiln is not running' }), configured: () => kiln.exe, allowed: () => true });
    expect(real.facts(false).allowed).toBe(false);
    expect(await real.ensure()).toMatchObject({ ok: false });
    const starts: string[] = [];
    const faked = new KilnLauncher({ runtimeFile: () => join(tmp, 'none', 'runtime.json'), check: async () => ({ ok: false, detail: 'Kiln is not running' }), configured: () => kiln.exe, allowed: () => true, spawn: (e) => void starts.push(e), timeoutMs: 60, pollMs: 10 });
    process.env.SHURIKEN_NO_KILN = '1';
    expect(kilnStartForbidden()).toMatch(/switched off/);
    expect(faked.facts(false).allowed).toBe(false);
    delete process.env.SHURIKEN_NO_KILN;
    process.env.SHURIKEN_SMOKE = '1';
    expect(faked.facts(false).allowed).toBe(false);
    delete process.env.SHURIKEN_SMOKE;
    expect(starts).toHaveLength(0);
    // Allowed: one start, and a plain reason when it never comes up.
    const r = await faked.ensure();
    expect(starts).toEqual([kiln.exe]);
    expect(r).toEqual({ ok: false, reason: "Kiln didn't start within 0 s" });
  });

  it('waits for a Kiln whose process is alive instead of starting another', async () => {
    const dir = join(tmp, 'starting');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'runtime.json'), JSON.stringify({ port: 1, token: 'x', pid: process.pid }));
    let asks = 0;
    const starts: string[] = [];
    const l = new KilnLauncher({ runtimeFile: () => join(dir, 'runtime.json'), check: async () => (++asks >= 4 ? { ok: true, detail: 'Kiln 0.8.1' } : { ok: false, detail: 'Kiln is not running' }), configured: () => kiln.exe, allowed: () => true, spawn: (e) => void starts.push(e), timeoutMs: 2000, pollMs: 10 });
    expect(l.startable(false)).toBe(true);
    expect(await l.ensure()).toEqual({ ok: true, launched: false });
    expect(starts).toHaveLength(0);
  });
});

describe('a build that needs a model while Kiln is not running', () => {
  it('plans for Kiln: it is startable, and blender_python already refuses a new model', async () => {
    expect(modeling.kiln.health.ok).toBe(false);
    expect(modeling.startable).toBe(true);
    expect(modeling.reachable).toBe(true);
    const r = await call('blender_python', { model: 'Crate', code: 'pass' });
    expect(r.out.isError).toBe(true);
    expect(r.text).toMatch(/Kiln builds this game's models, and it starts with the first request: ask it for Crate with kiln_request \{model: "Crate", kind: "new"/);
    expect(blender.execs).toHaveLength(0);
  });

  it('starts Kiln with the first kiln_request, says so in one line, and sends the brief', async () => {
    const r = await call('kiln_request', { model: 'Crate', text: 'A weathered shipping crate for the dock; seen at 10-40 studs.', wait: false });
    expect(r.out.isError).toBeFalsy();
    expect(spawned).toEqual([kiln.exe]);
    expect([...chat.values()]).toEqual(["Kiln wasn't running, so I started it in the background to build the models."]);
    expect(kiln.hits(/\/chat$/)).toHaveLength(1);
    expect(kiln.hits(/\/chat$/)[0]!.body).toMatchObject({ from: 'shuriken', kind: 'new' });
    // Running now: nothing is started again, and nothing more is said.
    await call('kiln_request', { model: 'Barrel', text: 'An oil barrel.', wait: false });
    expect(spawned).toHaveLength(1);
    expect(chat.size).toBe(1);
  });

  it('keeps agents out of hand-modeling a new model while Kiln answers, but not the user or a model that already lives in Blender', async () => {
    const refused = await call('blender_python', { model: 'Lantern', code: 'pass' });
    expect(refused.out.isError).toBe(true);
    expect(refused.text).toMatch(/Kiln builds this game's models, and it is running/);
    expect(refused.text).toMatch(/never the method/);
    expect(refused.text).toMatch(/Nothing is modeled by hand: when Kiln is down the build pauses until it is back/);
    // A hand-built model of an older build keeps being edited where it lives.
    writeFileSync(join(root, 'models', 'OldChest.blend'), 'BLENDER');
    expect((await call('blender_python', { model: 'OldChest', code: 'pass' })).out.isError).toBeFalsy();
    // The user's own Models panel is not an agent.
    expect((await call('blender_python', { model: 'Lantern', code: 'pass' }, { ...agent, kind: 'ui', role: 'user' })).out.isError).toBeFalsy();
    expect(blender.execs.map((e) => e.name)).toEqual(['OldChest', 'Lantern']);
  });
});

const until = async (cond: () => unknown, ms = 5000) => {
  for (const t0 = Date.now(); !cond(); ) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((ok) => setTimeout(ok, 10));
  }
};

// Kiln is required (1.17): games built without it are worse and waste usage. A Kiln that can't be reached or started
// pauses the whole build until it answers again; only the project's "Run anyway (reduced quality)" opens Blender.
describe('when Kiln cannot be reached', () => {
  it('pauses the build instead of hand-modeling: said once with Run anyway, blender_python refuses, and it resumes by itself when Kiln is back', async () => {
    // Kiln quit (0.8 removes runtime.json) and Shuriken may not start it.
    kiln.removeRuntime();
    allowed = false;
    await modeling.kiln.check(true);
    chat.clear();
    blender.execs.length = 0;
    expect(modeling.reachable).toBe(false);
    const r = await call('kiln_request', { model: 'Torso_Light', text: 'The light mech torso.' });
    expect(r.out.isError).toBe(true);
    expect(r.text).toMatch(/^Kiln isn't available, so the build is paused until it's back \(Kiln isn't running, and starting it for builds is switched off \(Settings → Agents → Kiln\)\)\./);
    expect(r.text).toMatch(/Don't model Torso_Light by hand/);
    expect(r.text).not.toMatch(/yourself with blender_python/);
    expect(modeling.outage.paused).toBe(true);
    expect(holds).toEqual([{ reason: KILN_PAUSED, released: false }]);
    expect([...notices.values()]).toEqual([{ state: 'paused', text: expect.stringMatching(/^Kiln isn't available, so the build is paused until it's back \(.*\)\. It carries on by itself as soon as Kiln answers again\..*"Run anyway \(reduced quality\)"/) }]);
    // Nothing goes to Blender: not the model asked for, not a model a modeler takes straight to Blender.
    for (const m of ['Torso_Light', 'Torso_Heavy']) {
      const b = await call('blender_python', { model: m, code: 'pass' });
      expect(b.out.isError).toBe(true);
      expect(b.text).toMatch(/paused until it's back/);
    }
    expect(blender.execs).toHaveLength(0);
    // Said once, held once.
    await call('kiln_request', { model: 'Torso_Heavy', text: 'The heavy mech torso.' });
    expect(notices.size).toBe(1);
    expect(holds).toHaveLength(1);
    expect(chat.size).toBe(0);
    // Kiln is back: the pause ends by itself, and the notice says so.
    kiln.writeRuntime();
    await until(() => !modeling.outage.active);
    expect(holds[0]!.released).toBe(true);
    expect([...notices.values()][0]).toMatchObject({ state: 'back', text: expect.stringMatching(/^Kiln is back/) });
    expect((await call('kiln_request', { model: 'Torso_Light', text: 'The light mech torso.', wait: false })).out.isError).toBeFalsy();
  }, 30_000);

  it('"Run anyway (reduced quality)" lifts the pause and opens Blender until Kiln is back, when it ends by itself', async () => {
    kiln.removeRuntime();
    allowed = false;
    await modeling.kiln.check(true);
    holds.length = 0;
    notices.clear();
    chat.clear();
    blender.execs.length = 0;
    const waiting = call('kiln_request', { model: 'Barricade', text: 'A wooden barricade.' });
    await until(() => holds.length === 1);
    expect(modeling.outage.paused).toBe(true);
    expect(modeling.outage.runAnyway()).toEqual({ ok: true, message: "Running anyway: Shuriken's own Blender builds new models until Kiln is back." });
    expect(runAnyway).toBe(true);
    await until(() => holds[0]!.released);
    const r = await waiting;
    expect(r.text).toMatch(/The user chose to run anyway at reduced quality until Kiln is back: build Barricade yourself with blender_python/);
    expect([...notices.values()][0]).toMatchObject({ state: 'override' });
    expect((await call('blender_python', { model: 'Lamp', code: 'pass' })).out.isError).toBeFalsy();
    expect([...chat.values()][0]).toMatch(/^Kiln isn't building Barricade, Lamp \(Kiln isn't available .*; the build runs anyway at reduced quality\): the 3D modeler is building them in Shuriken's own Blender instead\.$/);
    // Kiln is back: the override is dropped with the outage.
    kiln.writeRuntime();
    allowed = true;
    await until(() => !modeling.outage.active);
    expect(runAnyway).toBe(false);
    expect(modeling.outage.runAnyway()).toMatchObject({ ok: false });
  }, 30_000);

  it('pauses on a PC that has no Kiln at all too: Kiln is required', async () => {
    kiln.removeRuntime();
    exe = join(tmp, 'nowhere', 'Kiln.exe');
    await modeling.kiln.check(true);
    holds.length = 0;
    notices.clear();
    expect(modeling.kilnFirst(root, 'Rock')).toMatch(/^Kiln isn't available, so the build is paused until it's back \(Kiln isn't running and Kiln\.exe wasn't found/);
    expect(holds).toHaveLength(1);
    exe = kiln.exe;
    kiln.writeRuntime();
    await until(() => !modeling.outage.active);
  }, 30_000);

  it('a Kiln that is up but still too busy to answer after the wait pauses the build too, never hand-modeling', async () => {
    // What a busy Kiln looks like from here: its process is alive (runtime.json names one), its port doesn't answer.
    writeFileSync(kiln.runtimeFile, JSON.stringify({ app: 'kiln', version: kiln.version, port: 9, token: 't', pid: process.pid, startedAt: new Date().toISOString() }));
    allowed = true;
    await modeling.kiln.check(true);
    holds.length = 0;
    notices.clear();
    chat.clear();
    blender.execs.length = 0;
    const launches = spawned.length;
    const r = await call('kiln_request', { model: 'Reactor_Core', text: 'The lab reactor core.' });
    expect(r.out.isError).toBe(true);
    expect(r.text).toMatch(/^Kiln isn't available, so the build is paused until it's back \(Kiln is running but didn't answer for 3 s/);
    expect(r.text).toMatch(/Don't model Reactor_Core by hand/);
    expect(chat.size).toBe(0);
    // Waited for, not started a second time.
    expect(spawned.length).toBe(launches);
    expect((await call('blender_python', { model: 'Reactor_Core', code: 'pass' })).out.isError).toBe(true);
    expect(blender.execs).toHaveLength(0);
    kiln.writeRuntime();
    await until(() => !modeling.outage.active);
  }, 30_000);

  it('a model Kiln fails on gets a fresh brief, then a quicker one, then goes to the planner: never hand-modeling', async () => {
    kiln.writeRuntime();
    await modeling.kiln.check(true);
    chat.clear();
    kiln.autoFinish = null;
    const fail = async (reply = 'Blender crashed.') => {
      const pending = call('kiln_request', { model: 'Gate', text: 'A scrapyard gate.', timeout_min: 1 });
      const mine = () => kiln.running().find((t) => t.projectId.startsWith('gate-'));
      for (let i = 0; i < 300 && !mine(); i++) await new Promise((ok) => setTimeout(ok, 10));
      kiln.finish(mine()!.turnId, { state: 'failed', reply });
      return pending;
    };
    // An account out of credit is not Kiln failing on the model: it never counts.
    const credit = await fail('Credit balance is too low');
    expect(credit.text).toMatch(/That is the account Kiln ran it on \(its usage or its login\), not the model/);
    const first = await fail();
    expect(first.text).toMatch(/Kiln's turn ended failed: Blender crashed\./);
    expect(first.text).toMatch(/Ask again with a fresh brief: kiln_request \{model: "Gate", kind: "rework"\}/);
    const second = await fail();
    expect(second.text).toMatch(/Kiln failed on Gate twice\. Rework the request, not the method/);
    expect(second.text).toMatch(/If it fails a third time, stop and report the task blocked/);
    const third = await fail();
    expect(third.text).toMatch(/Kiln has failed on Gate 3 times\. Stop asking: report your task blocked/);
    for (const t of [first, second, third]) expect(t.text).not.toMatch(/yourself with blender_python/);
    expect(chat.size).toBe(0);
    kiln.autoFinish = 1;
  }, 60_000);

  it('keeps the fallback line short for many models (said only while the user runs anyway)', () => {
    const line = fallbackLine(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'], 'Kiln is not running.');
    expect(line).toBe("Kiln isn't building A, B, C, D, E, F, G, H and 2 more (Kiln is not running): the 3D modeler is building them in Shuriken's own Blender instead.");
  });
});

// The user's test: a 2,900-character brief for a low-poly forge (four sockets, a triangle budget, an exact size, a
// must-have list) at Kiln's own choice of effort ran 37 minutes. "All you need are looser requirements, rough
// dimensions, and go with the flow."
describe('how much a Kiln build is worth', () => {
  it('is quick unless it is a family, has sockets, names a subject or animates', async () => {
    const { kilnDetail, briefTooLong, KILN_EFFORT, KILN_BRIEF_LIMIT } = await import('../src/core/capabilities/kiln-tools');
    expect(kilnDetail({})).toBe('quick');
    expect(kilnDetail({ family: 'MechTorsos' })).toBe('standard');
    expect(kilnDetail({ sockets: [{}] })).toBe('standard');
    expect(kilnDetail({ references: 'the Griever from The Maze Runner films' })).toBe('standard');
    expect(kilnDetail({ kind: 'animate' })).toBe('standard');
    expect(kilnDetail({ family: 'Props', detail: 'quick' })).toBe('quick');
    expect(kilnDetail({ detail: 'hero' })).toBe('hero');
    // Shuriken always says the effort, and never max by itself.
    expect(KILN_EFFORT).toEqual({ quick: 'low', standard: 'high', hero: 'xhigh' });
    expect(KILN_BRIEF_LIMIT).toEqual({ quick: 280, standard: 600, hero: 1200 });
    expect(briefTooLong('A blocky Minecraft-style forge: furnace with glowing coals, chimney, anvil, tool rack.', 'quick')).toBeNull();
    const long = briefTooLong('x'.repeat(1641), 'quick')!;
    expect(long).toMatch(/^The brief is 1641 characters; a quick build takes at most 280. Kiln decides the design/);
    expect(long).toMatch(/pass detail: "standard"/);
    expect(briefTooLong("x".repeat(1100), "hero")).toBeNull();
    expect(briefTooLong('x'.repeat(3000), 'hero')).not.toMatch(/pass detail/);
  });
});

// Kiln built vending machines with separate Door and Display objects; the export merged them into one part per
// material, and the game had no door to open.
describe('parts the code finds by name', () => {
  it('are asked of Kiln as their own objects, marked for the export', async () => {
    const { renderBrief } = await import('../src/core/modeling/kiln-brief');
    const one = renderBrief({ text: 'A neon vending machine.', parts: ['Door', 'Display'] });
    expect(one).toContain("The game's code finds and moves these by name: Door, Display.");
    expect(one).toContain('give it the custom property kiln_part set to that name, e.g. obj["kiln_part"] = "Door". Everything else may be merged.');
    expect(renderBrief({ text: 'Vending machines.', members: [{ name: 'A' }, { name: 'B' }], parts: ['Door'] })).toContain('obj["kiln_part"] = "Door", in every model that has one.');
    expect(renderBrief({ text: 'A crate.' })).not.toContain('kiln_part');
  });
});

describe('named parts against Kiln 0.8.5', () => {
  it('are sent as spec.parts so Kiln checks that each came back; an older Kiln gets the sentence only', async () => {
    const { briefBody, KILN_PARTS_VERSION } = await import('../src/core/modeling/kiln-brief');
    expect(KILN_PARTS_VERSION).toBe('0.8.5');
    const brief = { text: 'A neon vending machine.', parts: ['Door', 'Display'] };
    expect(briefBody(brief, { fields: true, parts: true }).spec).toEqual({ parts: ['Door', 'Display'] });
    expect(briefBody(brief, { fields: true }).spec).toBeUndefined();
    // A Kiln that checks named parts knows what one is: the names go as data only. An older one gets the sentence.
    expect(briefBody(brief, { fields: true, parts: true }).text).toBe('A neon vending machine.');
    expect(briefBody(brief, { fields: true }).text).toContain('kiln_part');
  });
});
