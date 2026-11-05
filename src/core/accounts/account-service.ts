import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { nowIso } from '@shared/ids';
import { clockText } from '@shared/usage';
import type { Store } from '../db/store';
import { j, pj } from '../db/store';
import type { EventBus } from '../events';
import type { UsageTracker } from '../orchestrator/usage-tracker';
import { claudeConfigDir } from '../providers/claude/session-carry';

/**
 * Shuriken runs on ONE Claude login (1.17). There is no list of accounts, no switching between them and no failover:
 * moving between accounts to get around a plan's usage limits isn't allowed by Anthropic's terms, and several logins
 * renewing in several places signed each other out. At a usage limit a build waits for the reset.
 *
 * The login is one of three, chosen in Settings → Claude login:
 * - 'pc' (the default): the Claude Code login already on this PC (`claude /login`); no folder of Shuriken's own.
 * - 'folder': a separate Claude login just for Shuriken, in its own folder (signed in with Claude Code's own login,
 *   in a terminal the app opens).
 * - 'api-key': an Anthropic API key, kept encrypted by the app (the secret 'claude.apiKey'); runs pay per use.
 */
export type LoginKind = 'pc' | 'folder' | 'api-key';

export interface ProviderAccount {
  id: string;
  providerId: string;
  label: string;
  /** Its Claude Code folder ('' = the PC's own). */
  dir: string;
  email: string | null;
  plan: string | null;
  signedIn: boolean;
  checkedAt: string | null;
  createdAt: string;
  kind: LoginKind;
}

export interface AccountPolicy {
  /** At the usage limit, resume by itself once it resets (otherwise stay paused until the user resumes). */
  autoResume: boolean;
}

/** The ids of the three logins (each is "the account" when chosen). */
export const PC_ACCOUNT_ID = 'pc';
export const FOLDER_ACCOUNT_ID = 'login';
export const API_ACCOUNT_ID = 'api-key';
const LABELS: Record<LoginKind, string> = { pc: "This PC's Claude login", folder: "Shuriken's own Claude login", 'api-key': 'Anthropic API key' };
const IDS: Record<LoginKind, string> = { pc: PC_ACCOUNT_ID, folder: FOLDER_ACCOUNT_ID, 'api-key': API_ACCOUNT_ID };

export interface AccountPick {
  ok: boolean;
  account: ProviderAccount | null;
  /** Key under which usage and limits are tracked for runs on this login. */
  usageKey: string;
  reason?: string;
  /** When it can't start now: when its limit resets (ms since epoch). */
  resumeAt?: number | null;
}

/** How Kiln is told which login a brief's turn runs on (Kiln follows Shuriken; Kiln's docs/INTEGRATION.md). */
export type KilnAccount = { kind: 'pc' } | { kind: 'folder'; dir: string } | { kind: 'api-key'; apiKey: string };

const KIND = 'login.kind';
const POLICY = 'accounts.policy';
const META = (id: string) => (id === PC_ACCOUNT_ID ? 'accounts.pc' : `login.meta.${id}`);
/** Before 1.17: the list of added accounts and the app-wide pick (read once, to carry the choice over). */
const LEGACY_LIST = 'accounts';
const LEGACY_ACTIVE = 'accounts.active';
const LEGACY_DIR = 'login.folderDir';
const MIGRATED = 'login.migratedFrom';

export class AccountService {
  /** The API key, decrypted by the main process and held in memory only (Core.loadApiKey). */
  private apiKey: string | null = null;

  constructor(
    private readonly global: Store,
    private readonly dataDir: string,
    private readonly bus: EventBus,
  ) {
    this.migrate();
  }

  /** Which login runs use. */
  kind(): LoginKind {
    const k = this.read(KIND);
    return k === 'folder' || k === 'api-key' ? k : 'pc';
  }

  /** Choose the login (Settings). Nothing else changes: a build in progress carries on with its next run on it. */
  setKind(kind: LoginKind): ProviderAccount {
    this.write(KIND, kind);
    if (kind === 'folder') mkdirSync(this.folderDir(), { recursive: true });
    this.changed();
    return this.login();
  }

  /** The folder of Shuriken's own login (kept from before 1.17 when the user had picked an added account). */
  folderDir(): string {
    return this.read(LEGACY_DIR) || join(this.dataDir, 'login');
  }

  /** The login runs use now, as an account. */
  login(providerId = 'claude'): ProviderAccount {
    return this.account(providerId, this.kind());
  }

  private account(providerId: string, kind: LoginKind): ProviderAccount {
    const id = IDS[kind];
    const meta = pj<Partial<ProviderAccount>>(this.read(META(id)), {});
    const dir = kind === 'pc' ? '' : kind === 'folder' ? this.folderDir() : join(this.dataDir, 'login-api');
    // Until the first check (a few seconds after starting): is there a login at all?
    const signedIn = kind === 'api-key' ? !!this.apiKey && (meta.signedIn ?? true) : (meta.signedIn ?? existsSync(join(claudeConfigDir(dir), '.credentials.json')));
    return { id, providerId, label: LABELS[kind], dir, email: meta.email ?? null, plan: kind === 'api-key' ? 'API credits' : (meta.plan ?? null), signedIn, checkedAt: meta.checkedAt ?? null, createdAt: '', kind };
  }

  /** The chosen login when it is not the PC's own (callers that treat "no account" as the PC's login use this). */
  list(providerId?: string): ProviderAccount[] {
    const a = this.login(providerId ?? 'claude');
    return a.id === PC_ACCOUNT_ID ? [] : [a];
  }

  get(id: string): ProviderAccount | null {
    const kind = (Object.keys(IDS) as LoginKind[]).find((k) => IDS[k] === id);
    return kind ? this.account('claude', kind) : null;
  }

  /** The PC's own Claude login as an account (dir '' = no override: the provider's default credentials). */
  pc(providerId: string): ProviderAccount {
    return this.account(providerId, 'pc');
  }

  /** The login runs may use: the chosen one, when it is signed in. */
  candidates(providerId: string): ProviderAccount[] {
    const a = this.login(providerId);
    return a.signedIn ? [a] : [];
  }

  update(id: string, patch: Partial<Pick<ProviderAccount, 'email' | 'plan' | 'signedIn' | 'checkedAt'>>): ProviderAccount | null {
    const acct = this.get(id);
    if (!acct) return null;
    this.write(META(id), j({ ...pj<Record<string, unknown>>(this.read(META(id)), {}), ...patch }));
    this.changed();
    return this.get(id);
  }

  /** The id of the login in use. */
  activeId(_providerId: string): string {
    return IDS[this.kind()];
  }

  /** The account runs use: null for the PC's own login (runs use the provider's default credentials). */
  active(providerId: string): ProviderAccount | null {
    const a = this.login(providerId);
    return a.id === PC_ACCOUNT_ID ? null : a;
  }

  /** The API key from the app's encrypted store (null: none set). Held in memory only. */
  setApiKey(key: string | null): void {
    const had = !!this.apiKey;
    this.apiKey = key?.trim() || null;
    if (had !== !!this.apiKey) this.changed();
  }

  hasApiKey(): boolean {
    return !!this.apiKey;
  }

  /** The environment a run on this login adds (its folder and, for the API key, the key). Never logged. */
  env(account: ProviderAccount | null): Record<string, string> | undefined {
    if (!account || account.kind === 'pc') return undefined;
    if (account.kind === 'folder') return { CLAUDE_CONFIG_DIR: account.dir };
    if (!this.apiKey) return undefined;
    mkdirSync(account.dir, { recursive: true });
    // The key wins over any login: Claude Code would prefer a subscription token from the environment otherwise.
    return { CLAUDE_CONFIG_DIR: account.dir, ANTHROPIC_API_KEY: this.apiKey, CLAUDE_CODE_OAUTH_TOKEN: '' };
  }

  /** The login Kiln runs a brief's turn on: Shuriken's own (Kiln follows Shuriken). */
  kilnAccount(account: ProviderAccount | null): KilnAccount {
    if (!account || account.kind === 'pc') return { kind: 'pc' };
    if (account.kind === 'folder') return { kind: 'folder', dir: account.dir };
    return this.apiKey ? { kind: 'api-key', apiKey: this.apiKey } : { kind: 'pc' };
  }

  policy(): AccountPolicy {
    const p = pj<Partial<AccountPolicy>>(this.read(POLICY), {});
    return { autoResume: p.autoResume ?? true };
  }

  setPolicy(patch: Partial<AccountPolicy>): AccountPolicy {
    const next = { ...this.policy(), ...patch };
    this.write(POLICY, j(next));
    this.changed();
    return next;
  }

  usageKey(providerId: string, account: ProviderAccount | null): string {
    // The PC login is the provider's default credentials: the same usage bucket as runs without a login of their own.
    return account && account.id !== PC_ACCOUNT_ID ? `${providerId}:${account.id}` : providerId;
  }

  /** Whether a run could start now (a look: nothing changes). */
  anyCanStart(providerId: string, usage: UsageTracker): boolean {
    return usage.canStartRun(this.usageKey(providerId, this.active(providerId))).ok;
  }

  /**
   * Whether the next run can start, on the one login. At its usage limit nothing switches: the build waits, and says
   * when the limit resets (policy.autoResume: whether it then resumes by itself).
   */
  pick(providerId: string, usage: UsageTracker): AccountPick {
    const account = this.active(providerId);
    const usageKey = this.usageKey(providerId, account);
    const gate = usage.canStartRun(usageKey);
    if (gate.ok) return { ok: true, account, usageKey };
    const resumeAt = usage.snapshot(usageKey).blockedUntil ?? null;
    const when = resumeAt ? clockText(resumeAt, Date.now()) : 'soon';
    const who = (account ?? this.pc(providerId)).label;
    // "Resuming at" only when it will: with auto-resume off the team stays paused until the user resumes it.
    const reason = gate.reason && !/usage limit/i.test(gate.reason) ? gate.reason : this.policy().autoResume ? `${who} is at its usage limit; resuming at ${when}` : `${who} is at its usage limit; it resets at ${when}`;
    return { ok: false, account, usageKey, resumeAt, reason };
  }

  /** How many accounts the app had before 1.17 (0: none, or already moved), for Settings' one-time note. */
  migratedFrom(): number {
    return Number(this.read(MIGRATED) ?? 0) || 0;
  }

  dismissMigrated(): void {
    this.write(MIGRATED, '0');
  }

  /**
   * Before 1.17 the app kept a list of accounts. The one in use carries over: an added account the user had picked
   * becomes Shuriken's own login (its folder, its sign-in), otherwise the PC's login. The other folders stay on disk.
   */
  private migrate(): void {
    const legacy = pj<Array<{ id: string; dir: string; signedIn?: boolean; email?: string | null; plan?: string | null }>>(this.read(LEGACY_LIST), []);
    if (!Array.isArray(legacy) || !legacy.length) return;
    const pickedId = pj<Record<string, string | null>>(this.read(LEGACY_ACTIVE), {})['claude'] ?? null;
    const picked = legacy.find((a) => a.id === pickedId && a.signedIn && a.dir && existsSync(a.dir));
    if (this.read(KIND) === null) {
      if (picked) {
        this.write(LEGACY_DIR, picked.dir);
        this.write(KIND, 'folder');
        this.write(META(FOLDER_ACCOUNT_ID), j({ email: picked.email ?? null, plan: picked.plan ?? null, signedIn: true }));
      } else this.write(KIND, 'pc');
    }
    this.write(MIGRATED, String(legacy.length));
    this.write(`${LEGACY_LIST}.before-1.17`, j(legacy));
    this.write(LEGACY_LIST, '[]');
  }

  private changed(): void {
    this.bus.emit('accounts.changed', { providerId: 'claude', activeId: this.activeId('claude') });
  }

  private read(key: string): string | null {
    return this.global.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key])?.value ?? null;
  }

  private write(key: string, value: string): void {
    this.global.run('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)', [key, value, nowIso()]);
  }
}
