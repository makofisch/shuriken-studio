import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nowIso } from '@shared/ids';
import { suggestionsOf, type Suggestion } from '@shared/suggestions';
import type { EventBus } from '../events';
import type { ScopedLogger } from '../log';
import { errorMessage } from '../log';
import type { ProjectContext } from '../projects/project-service';
import type { AgentRunner } from '../orchestrator/agent-runner';
import { ROLES } from '../agents/roles';
import { COPILOT_IDS, type CopilotId } from '../copilots/copilot-roles';
import { AnimationStore } from '../animation/animation-service';
import { EffectStore } from '../effects/effects-service';
import { SoundLibrary } from '../audio/audio-library';
import { ModelStore } from '../modeling/model-store';
import { UiStore } from '../ui/ui-workshop';
import { DossierStore } from '../projects/game-study';
import { ChatService } from './chat-service';
import { finishedWork } from './game-digest';

/**
 * Suggestion bubbles that know the game: for the director's chat and each dock, ideas about what this
 * game has and what the user has been asking for ("Make the Griever scarier", "More detail in the
 * maze") instead of generic templates. One call writes every place's bubbles at once; they are kept in
 * .shuriken/suggestions.json. Director and copilot replies bring their own follow-ups in between.
 *
 * 1.17: written by Opus 5.5 (the fast model's ideas were generic) from a richer digest (the spec, what failed, what
 * the user asked), as a STOCK per place (12 for the director, 8 per dock) shown a few at a time in rotation, so the
 * bubbles change every ROTATE_MS. The stock is written again when the game changed or when what is left of it (not
 * sent yet) runs low, at most every THROTTLE_MS and MAX_PER_HOUR times an hour per project (about $0.10 a set).
 */

export type SuggestionScope = 'director' | CopilotId;
export const SUGGESTION_SCOPES: readonly SuggestionScope[] = ['director', ...COPILOT_IDS];

/** The live-suggestion pacing (tests shorten it). */
export const LIVE_SUGGESTIONS = {
  /** A new set at most this often per project. */
  throttleMs: 3 * 60_000,
  /** And at most this many sets an hour per project (the cost cap). */
  maxPerHour: 8,
  /** The window of bubbles shown moves on this often. */
  rotateMs: 90_000,
  /** Bubbles shown at once from the stock. */
  window: 3,
  /** A stock with this few unsent bubbles left is written again. */
  low: 4,
};
/** How many bubbles a place keeps in stock. */
export const STOCK: Record<SuggestionScope, number> = Object.fromEntries(SUGGESTION_SCOPES.map((s) => [s, s === 'director' ? 12 : 8])) as Record<SuggestionScope, number>;
const DIGEST_TTL_MS = 30_000;

interface Stored {
  at: string;
  fingerprint: string;
  scopes: Partial<Record<SuggestionScope, Suggestion[]>>;
}

/** The chat channel each place's user messages are in (a sent bubble is used up). */
const channelOf = (scope: SuggestionScope) => (scope === 'director' ? 'director' : `copilot:${scope}`);

/** The window of a stock shown at `now`: `size` bubbles from a place that moves on every rotateMs. */
export function rotation<T>(stock: T[], now: number, size = LIVE_SUGGESTIONS.window, everyMs = LIVE_SUGGESTIONS.rotateMs): T[] {
  if (stock.length <= size) return stock;
  const start = (Math.floor(now / everyMs) * size) % stock.length;
  return [...stock.slice(start), ...stock.slice(0, start)];
}

/** What the bubbles are written from: the game's goals, its work, its content and what the user asked; null for an empty game. */
export function gameDigest(ctx: ProjectContext, chat: ChatService): { text: string; fingerprint: string } | null {
  const root = ctx.root;
  const tasks = ctx.tasks.list({});
  const objectives = tasks.filter((t) => t.kind === 'objective');
  const work = tasks.filter((t) => t.kind !== 'objective' && t.kind !== 'plan' && t.kind !== 'research');
  // What counts as built is the director's digest's rule too (game-digest.ts).
  const finished = finishedWork(tasks);
  const open = work.filter((t) => !['done', 'verified', 'cancelled'].includes(t.status));
  const anims = new AnimationStore(root).all().map((f) => `${f.clip.name}${f.draft ? ' (draft)' : ''}`);
  const effects = new EffectStore(root).all().map((f) => `${f.effect.name}${f.draft ? ' (draft)' : ''}`);
  const sounds = new SoundLibrary(root).all();
  const store = new ModelStore(root);
  const models = [...new Set(store.all().map((m) => m.assembly ?? m.name))];
  const rigs = Object.keys(store.rigs());
  const ui = new UiStore(root).get()?.screens.map((s) => s.name) ?? [];
  const study = ctx.extras().adopted ? new DossierStore(root).summary(1200) : null;
  if (!objectives.length && !study && !anims.length && !effects.length && !sounds.length && !models.length && !ui.length) return null;
  // What the game is meant to be (the living spec, briefly), and where it is in trouble: the ideas are grounded in both.
  let spec: string[] = [];
  try {
    spec = ctx.governance
      .spec()
      .filter((x) => x.body?.trim())
      .slice(0, 6)
      .map((x) => `- ${x.title}: ${x.body.replace(/\s+/g, ' ').slice(0, 220)}`);
  } catch {
    /* no spec yet */
  }
  const trouble = work.filter((t) => t.status === 'failed' || t.status === 'escalated' || t.status === 'blocked').slice(-5);
  const asked = chat
    .list(80)
    .filter((m) => m.role === 'user')
    .slice(-6)
    .map((m) => `- ${m.text.replace(/\s+/g, ' ').slice(0, 240)}`);
  const lines = [
    `Game: ${ctx.summary.name}${ctx.summary.description ? ` — ${ctx.summary.description.slice(0, 300)}` : ''}`,
    ...(study ? ['', 'What the game is (its study):', study] : []),
    ...(objectives.length ? ['', 'Goals:', ...objectives.slice(-5).map((o) => `- ${o.title} (${o.status})`)] : []),
    ...(finished.length ? ['', 'Finished:', ...finished.slice(-12).map((t) => `- ${t.title}`)] : []),
    ...(spec.length ? ['', 'The spec (what the game is meant to be):', ...spec] : []),
    ...(open.length ? ['', 'Being worked on or waiting:', ...open.slice(0, 10).map((t) => `- ${t.title} (${t.status})`)] : []),
    ...(trouble.length ? ['', 'In trouble (failed, blocked or asking):', ...trouble.map((t) => `- ${t.title} (${t.status})`)] : []),
    '',
    'What the game has:',
    `- 3D models: ${models.slice(0, 20).join(', ') || 'none'}${rigs.length ? ` (rigged creatures: ${rigs.join(', ')})` : ''}`,
    `- Animations: ${anims.slice(0, 30).join(', ') || 'none'}`,
    `- Sounds: ${sounds.slice(0, 20).map((s) => `${s.name}${s.draft ? ' (draft)' : ''}`).join(', ') || 'none'}`,
    `- Effects: ${effects.slice(0, 20).join(', ') || 'none'}`,
    `- UI screens: ${ui.slice(0, 15).join(', ') || 'none read yet'}`,
    ...(asked.length ? ['', 'What the user asked lately:', ...asked] : []),
  ];
  // Written again when the game changes: goals, finished work (every few tasks), content — not every message.
  const key = JSON.stringify([objectives.map((o) => `${o.id}:${o.status}`), Math.floor(finished.length / 3), models, rigs, anims.length, effects, sounds.map((s) => s.name), ui, !!study]);
  return { text: lines.join('\n'), fingerprint: createHash('sha1').update(key).digest('hex').slice(0, 16) };
}

/** Whether the project has a game to suggest changes to: a goal, or a game it plugged in. */
export function hasGame(ctx: ProjectContext): boolean {
  return !!ctx.extras().adopted || ctx.tasks.list({}).some((t) => t.kind === 'objective');
}

export class LiveSuggestions {
  private readonly running = new Set<string>();
  private readonly lastTry = new Map<string, number>();
  /** When each project's recent sets were asked for (the hourly cap). */
  private readonly tries = new Map<string, number[]>();
  private readonly digests = new Map<string, { at: number; value: { text: string; fingerprint: string } | null }>();

  constructor(
    private readonly d: {
      runner: AgentRunner;
      bus: EventBus;
      log: ScopedLogger;
      /** Off where no model may be called for bubbles. */
      enabled?: () => boolean;
      /** Game ideas (the start page's): the director's bubbles in a project with no game yet. */
      ideas?: (count: number) => Suggestion[];
    },
  ) {}

  private file(ctx: ProjectContext): string {
    return join(ctx.dir, 'suggestions.json');
  }

  private read(ctx: ProjectContext): Stored | null {
    try {
      const f = this.file(ctx);
      return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as Stored) : null;
    } catch {
      return null;
    }
  }

  /** The game's digest, read again at most every 30 s for the UI's frequent asks (`fresh`: now). */
  private digest(ctx: ProjectContext, fresh = false): { text: string; fingerprint: string } | null {
    const hit = this.digests.get(ctx.summary.id);
    if (!fresh && hit && Date.now() - hit.at < DIGEST_TTL_MS) return hit.value;
    const value = gameDigest(ctx, new ChatService(ctx, this.d.bus));
    this.digests.set(ctx.summary.id, { at: Date.now(), value });
    return value;
  }

  /** What the user sent in that place lately (a bubble sent there is used up). */
  private sent(ctx: ProjectContext, scope: SuggestionScope): Set<string> {
    try {
      return new Set(
        new ChatService(ctx, this.d.bus, channelOf(scope))
          .list(200)
          .filter((m) => m.role === 'user')
          .map((m) => m.text.trim().toLowerCase()),
      );
    } catch {
      return new Set();
    }
  }

  /** The stock of `scope` that hasn't been sent yet. */
  unused(ctx: ProjectContext, scope: SuggestionScope, stored = this.read(ctx)): Suggestion[] {
    const all = stored?.scopes[scope] ?? [];
    if (!all.length) return all;
    const sent = this.sent(ctx, scope);
    return all.filter((s) => !sent.has(s.label.toLowerCase()) && !sent.has(s.prompt.trim().toLowerCase()));
  }

  /**
   * The bubbles of `scope` for this game now (null until some are written): the unsent part of its stock, rotated so
   * the first few change every rotateMs. A new stock is written in the background once the game changed, or when the
   * unsent part runs low.
   */
  get(ctx: ProjectContext, scope: SuggestionScope, now = Date.now()): Suggestion[] | null {
    // No game yet (a blank project): the director's bubbles are games to start, like the start page's. What a
    // dock holds then is the user trying things, not a game to suggest changes to.
    if (scope === 'director' && this.d.ideas && !hasGame(ctx)) return this.d.ideas(4);
    const stored = this.read(ctx);
    const digest = this.digest(ctx);
    const all = stored?.scopes[scope] ?? [];
    const left = this.unused(ctx, scope, stored);
    // Runs low by being used: some of it was sent, and few are left (a small set as written is not a reason to ask again).
    const usedUp = all.length > left.length && left.length <= LIVE_SUGGESTIONS.low;
    if (digest && (stored?.fingerprint !== digest.fingerprint || usedUp)) void this.refresh(ctx, digest);
    if (!stored?.scopes[scope]) return null;
    return rotation(left, now);
  }

  /** Writes every place's bubbles for the game now (unless a set is being written or was tried within the throttle). */
  async refresh(ctx: ProjectContext, digest = this.digest(ctx, true)): Promise<boolean> {
    const id = ctx.summary.id;
    const now = Date.now();
    const recent = (this.tries.get(id) ?? []).filter((t) => now - t < 3_600_000);
    if (!digest || this.d.enabled?.() === false || this.running.has(id) || now - (this.lastTry.get(id) ?? 0) < LIVE_SUGGESTIONS.throttleMs || recent.length >= LIVE_SUGGESTIONS.maxPerHour) return false;
    this.running.add(id);
    this.lastTry.set(id, now);
    this.tries.set(id, [...recent, now]);
    try {
      // What is in stock and not sent yet stays welcome; what was sent is done: the new set says neither again.
      const before = this.read(ctx);
      const shown = SUGGESTION_SCOPES.flatMap((sc) => (before?.scopes[sc] ?? []).map((x) => `- ${sc}: ${x.label}`)).slice(0, 60);
      const outcome = await this.d.runner.run({
        project: ctx,
        role: ROLES.suggester!,
        task: null,
        signal: new AbortController().signal,
        directive: `Write the suggestion bubbles for this game: ${STOCK.director} for the director and ${STOCK.animation} for each dock, every one different.`,
        contextText: `${digest.text}${shown.length ? `\n\nBubbles the user has been shown already (write new ones, never these again):\n${shown.join('\n')}` : ''}`,
      });
      const out = outcome.structured as Record<string, unknown> | null;
      if (!outcome.completion.ok || !out) return false;
      const scopes: Stored['scopes'] = {};
      for (const s of SUGGESTION_SCOPES) {
        const list = suggestionsOf(out[s], STOCK[s], 48);
        if (list.length) scopes[s] = list;
      }
      if (!Object.keys(scopes).length) return false;
      mkdirSync(ctx.dir, { recursive: true });
      // A place the new set left out keeps what it had.
      for (const sc of SUGGESTION_SCOPES) if (!scopes[sc] && before?.scopes[sc]?.length) scopes[sc] = before.scopes[sc];
      writeFileSync(this.file(ctx), `${JSON.stringify({ at: nowIso(), fingerprint: digest.fingerprint, scopes } satisfies Stored, null, 2)}\n`, 'utf8');
      this.d.bus.emit('suggestions.changed', { projectId: id });
      return true;
    } catch (e) {
      this.d.log.warn('Writing suggestion bubbles failed', errorMessage(e));
      return false;
    } finally {
      this.running.delete(id);
    }
  }
}
