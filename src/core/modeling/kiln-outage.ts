/**
 * Kiln is required (1.17). Every model of a game is Kiln's: a game whose models were hand-modeled in Shuriken's own
 * Blender is worse and spent usage for it. So when Kiln can't be reached or started (the launcher can't bring it up, or
 * a busy Kiln still doesn't answer after the launcher's 3-minute wait), the whole build is PAUSED: no new agent runs
 * start (Orchestrator.hold, the way an agent runtime that can't start holds them), the chat says it once, and nothing
 * falls back to hand-modeling. It resumes by itself as soon as Kiln answers again (looked at every 15 s).
 *
 * The one way past it is the project's own "Run anyway (reduced quality)", a button on that notice: the hold is lifted
 * and Shuriken's own Blender modeling (blender_python) opens for new models until Kiln is back, when the override is
 * dropped by itself (it never carries over into the next outage).
 */

/** What the chat says, once, when Kiln is down. */
export const KILN_PAUSED = "Kiln isn't available, so the build is paused until it's back";
export const KILN_RUN_ANYWAY = 'Run anyway (reduced quality)';
/** How often a down Kiln is asked again (tests shorten it). */
export const KILN_OUTAGE = { pollMs: 15_000 };

export type KilnPauseState = 'paused' | 'override' | 'back';

export interface KilnOutageHooks {
  /** No new agent runs until `until` settles (Orchestrator.hold). */
  hold?: (until: Promise<unknown>, reason: string) => void;
  /** The open project's "Run anyway (reduced quality)". */
  overridden?: () => boolean;
  setOverridden?: (on: boolean) => void;
  /** The notice in the project's chat, with the button while paused; `id` updates the one said before. Returns its id. */
  notice?: (state: KilnPauseState, text: string, id: string | null) => string | null;
  log?: (msg: string) => void;
}

export class KilnOutage {
  private down: { since: number; why: string; release: () => void; noteId: string | null; timer: NodeJS.Timeout; held: boolean } | null = null;

  constructor(
    private readonly hooks: KilnOutageHooks,
    /** Whether Kiln answers now (a forced health check). */
    private readonly answers: () => Promise<boolean>,
  ) {}

  /** Kiln is down (whether or not the project runs anyway). */
  get active(): boolean {
    return !!this.down;
  }

  /** Why Kiln is down, or null. */
  get why(): string | null {
    return this.down?.why ?? null;
  }

  /** The project said to run anyway (only while Kiln is down; Kiln coming back drops it). */
  get overridden(): boolean {
    return !!this.hooks.overridden?.();
  }

  /** The build is held for Kiln now: Kiln is down and the project didn't say to run anyway. */
  get paused(): boolean {
    return !!this.down && !this.overridden;
  }

  /** Kiln couldn't be reached or started: the build pauses (once; a second report only updates why). */
  report(why: string): void {
    const reason = why.replace(/[.\s]+$/, '');
    if (this.down) {
      this.down.why = reason;
      return;
    }
    let release!: () => void;
    const until = new Promise<void>((ok) => (release = ok));
    const timer = setInterval(() => void this.poll(), KILN_OUTAGE.pollMs);
    timer.unref?.();
    this.down = { since: Date.now(), why: reason, release, noteId: null, timer, held: false };
    this.hooks.log?.(`Kiln is down (${reason}): the build is paused until it answers again`);
    if (this.overridden) {
      this.down.noteId = this.hooks.notice?.('override', overrideLine(reason), null) ?? null;
      return;
    }
    this.down.held = true;
    this.hooks.hold?.(until, KILN_PAUSED);
    this.down.noteId = this.hooks.notice?.('paused', `${KILN_PAUSED} (${reason}). It carries on by itself as soon as Kiln answers again. Nothing is modeled by hand meanwhile: "${KILN_RUN_ANYWAY}" lets Shuriken's own Blender build the models until Kiln is back.`, null) ?? null;
  }

  /** The project's "Run anyway (reduced quality)": the hold ends, and Shuriken's own Blender may model until Kiln is back. */
  runAnyway(): { ok: boolean; message: string } {
    if (!this.down) return { ok: false, message: 'Kiln is available: the build uses it.' };
    this.hooks.setOverridden?.(true);
    this.down.release();
    this.hooks.log?.('Running anyway without Kiln (reduced quality), as the project asked');
    this.down.noteId = this.hooks.notice?.('override', overrideLine(this.down.why), this.down.noteId) ?? this.down.noteId;
    return { ok: true, message: "Running anyway: Shuriken's own Blender builds new models until Kiln is back." };
  }

  /** Kiln answered: the pause (or the override) ends. */
  back(): void {
    const d = this.down;
    // Seen answering with no outage on record: an override left from an earlier one is dropped all the same.
    if (!d) {
      if (this.overridden) this.hooks.setOverridden?.(false);
      return;
    }
    this.down = null;
    clearInterval(d.timer);
    d.release();
    if (this.overridden) this.hooks.setOverridden?.(false);
    const mins = Math.max(1, Math.round((Date.now() - d.since) / 60_000));
    this.hooks.log?.(`Kiln answers again after about ${mins} min: the build carries on`);
    this.hooks.notice?.('back', `Kiln is back (it was away about ${mins} min), so the build carries on with Kiln building the models.`, d.noteId);
  }

  private polling = false;
  private async poll(): Promise<void> {
    if (!this.down || this.polling) return;
    this.polling = true;
    try {
      if (await this.answers()) this.back();
    } catch {
      /* still down */
    } finally {
      this.polling = false;
    }
  }

  /** Waits until Kiln is back, the project runs anyway, or the time is up. 'back' | 'override' | 'timeout' | 'aborted'. */
  async waitOut(ms: number, signal?: AbortSignal, onNote?: () => void): Promise<'back' | 'override' | 'timeout' | 'aborted'> {
    const end = Date.now() + ms;
    let noted = Date.now();
    while (this.down) {
      if (this.overridden) return 'override';
      if (signal?.aborted) return 'aborted';
      if (Date.now() >= end) return 'timeout';
      await new Promise((ok) => setTimeout(ok, Math.min(1000, Math.max(10, KILN_OUTAGE.pollMs / 4))));
      if (onNote && Date.now() - noted >= 15_000) {
        noted = Date.now();
        onNote();
      }
    }
    return 'back';
  }

  stop(): void {
    if (this.down) clearInterval(this.down.timer);
  }
}

function overrideLine(why: string): string {
  return `Kiln isn't available (${why}), and this build is running anyway at reduced quality: Shuriken's own Blender builds new models until Kiln is back.`;
}
