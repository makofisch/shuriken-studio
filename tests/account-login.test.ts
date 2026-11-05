import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROLES } from '../src/core/agents/roles';
import { claudeLoginState, hasClaudeLogin } from '../src/core/providers/claude/claude-provider';
import type { LoginState, ProviderAuthStatus } from '../src/core/providers/types';
import { coreHarness, waitFor } from './helpers/make-core';

/**
 * Logins that were lost (their .credentials.json kept no token) stayed "signed in": nothing looked again, and every run
 * failed with "OAuth token has expired". With one login (1.17) the team pauses and asks for it to be signed in again.
 */
const makeCore = coreHarness();

function folder(credentials?: unknown, claudeJson?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'shuriken-login-'));
  if (credentials !== undefined) writeFileSync(join(dir, '.credentials.json'), typeof credentials === 'string' ? credentials : JSON.stringify(credentials));
  if (claudeJson !== undefined) writeFileSync(join(dir, '.claude.json'), JSON.stringify(claudeJson));
  return dir;
}

describe('a Claude login', () => {
  it('is no login when Claude Code reports none', () => {
    expect(hasClaudeLogin({ tokenSource: 'none', apiProvider: 'firstParty' })).toBe(false);
    expect(hasClaudeLogin({ apiKeySource: 'none', tokenSource: 'none' })).toBe(false);
    expect(hasClaudeLogin({ email: 'me@example.com', tokenSource: 'claude.ai' })).toBe(true);
    expect(hasClaudeLogin({ apiKeySource: 'ANTHROPIC_API_KEY' })).toBe(true);
    expect(hasClaudeLogin({ apiProvider: 'bedrock' })).toBe(true);
  });

  it('is read from its folder: gone when no token is left to use or renew', () => {
    const now = Date.parse('2026-11-03T08:00:00Z');
    const signedIn = claudeLoginState(folder({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: now - 1000 } }), now);
    expect(signedIn.state).toBe('signed-in');
    expect(typeof signedIn.changedAt).toBe('number');
    expect(claudeLoginState(folder({ claudeAiOauth: { accessToken: 'a', expiresAt: now + 60_000 } }), now).state).toBe('signed-in');
    // What the three folders held: the login emptied (an MCP sign-in kept), or an access token past renewing.
    expect(claudeLoginState(folder({ claudeAiOauth: {}, mcpOAuth: { x: { accessToken: 'm' } } }), now).state).toBe('signed-out');
    expect(claudeLoginState(folder({ mcpOAuth: {} }), now).state).toBe('signed-out');
    expect(claudeLoginState(folder({ claudeAiOauth: { accessToken: 'a', expiresAt: now - 1000 } }), now).state).toBe('signed-out');
    expect(claudeLoginState(folder(), now)).toEqual({ state: 'signed-out', changedAt: null });
    // A folder it can't read, or one that signs in with an API key, says nothing.
    expect(claudeLoginState(folder('{not json'), now).state).toBe('unknown');
    expect(claudeLoginState(folder(undefined, { primaryApiKey: 'k' }), now).state).toBe('unknown');
  });
});

describe('the login, when it is gone', () => {
  async function setup(respond: Parameters<typeof makeCore>[0]['respond'] = async () => ({ status: 'implemented', summary: 'Done.' })) {
    const made = await makeCore({ respond });
    const { core } = made;
    core.orchestrator.pause();
    const own = core.accounts.setKind('folder');
    core.accounts.update(own.id, { signedIn: true, email: 'a@example.com' });
    return { ...made, own: core.accounts.login('fake') };
  }
  const expired = () => Object.assign(new Error('Failed to authenticate. API Error: 401 OAuth token has expired.'), { errorKind: 'auth' });

  it('is marked signed out when a run fails on it', async () => {
    let calls = 0;
    const { core, ctx, own } = await setup(async () => {
      if (calls++ === 0) throw expired();
      return { status: 'implemented', summary: 'Done.' };
    });
    const changed: Array<string | null> = [];
    core.bus.on('accounts.changed', (e) => changed.push(e.activeId));
    const run = () => core.runner.run({ project: ctx, role: ROLES['roblox-engineer']!, task: null, signal: new AbortController().signal, directive: 'Go.' });

    const failed = await run();
    expect(failed.completion.errorKind).toBe('auth');
    expect(failed.signedOut).toBe("Shuriken's own Claude login");
    expect(core.accounts.get(own.id)!.signedIn).toBe(false);
    // Nothing to move to: it stays the login in use.
    expect(core.accounts.active('fake')!.id).toBe(own.id);
    expect(changed.length).toBeGreaterThan(0);
  });

  it('a failure that is not about the login leaves it alone', async () => {
    const { core, ctx, own } = await setup(async () => {
      throw new Error('Tool crashed');
    });
    const out = await core.runner.run({ project: ctx, role: ROLES['roblox-engineer']!, task: null, signal: new AbortController().signal, directive: 'Go.' });
    expect(out.completion.ok).toBe(false);
    expect(out.signedOut).toBeUndefined();
    expect(core.accounts.get(own.id)!.signedIn).toBe(true);
  });

  it('is found by the folder check, and comes back once it is signed in again', async () => {
    const { core, provider, own } = await setup();
    const states: Record<string, LoginState> = { [own.dir]: { state: 'signed-out', changedAt: null } };
    const asked: string[] = [];
    Object.assign(provider, {
      loginState: (dir: string): LoginState => states[dir] ?? { state: 'unknown', changedAt: null },
      authFor: async (dir: string | null): Promise<ProviderAuthStatus> => {
        asked.push(dir ?? '');
        return { authenticated: true, method: 'fake', account: 'a@example.com', plan: 'max', detail: 'ok' };
      },
    });

    core.checkLogins();
    expect(core.accounts.get(own.id)!.signedIn).toBe(false);
    // Still the login it was marked out with (a refused token left in its folder): it stays out, nobody is asked.
    const markedAt = Date.parse(core.accounts.get(own.id)!.checkedAt!);
    states[own.dir] = { state: 'signed-in', changedAt: markedAt - 5000 };
    core.checkLogins();
    expect(core.accounts.get(own.id)!.signedIn).toBe(false);
    expect(asked).toEqual([]);

    // Signed in again since: asked once who it is, then it counts again.
    states[own.dir] = { state: 'signed-in', changedAt: markedAt + 5000 };
    core.checkLogins();
    await waitFor(() => core.accounts.get(own.id)!.signedIn);
    expect(asked).toEqual([own.dir]);
    expect(core.accounts.get(own.id)!.plan).toBe('max');
    core.checkLogins();
    expect(asked).toEqual([own.dir]);
  });

  it('pauses the team with no card and the attempt given back, and signing in again resumes it', async () => {
    let work = 0;
    const { core, ctx, provider, own } = await setup(async (_req, kind) => {
      if (kind !== 'work') return null;
      if (work++ === 0) throw expired();
      return { status: 'implemented', summary: 'Done.' };
    });
    // Ask mode, where a sign-in problem used to park the task on a card for the user.
    ctx.updateSettings({ autonomy: 'manual', permissionMode: 'ask' });
    core.orchestrator.attach(ctx);
    core.orchestrator.resume();
    const task = ctx.tasks.create({ kind: 'implement', title: 'Make the lobby', objective: 'x', role: 'roblox-engineer', createdBy: 't', status: 'ready', acceptanceCriteria: ['works'], verification: [] });
    core.orchestrator.runNow(task.id);
    await waitFor(() => ctx.audit.timeline({ limit: 50 }).find((e) => e.kind === 'run.notice' && /needs signing in: Shuriken's own Claude login has expired/.test(e.title)));
    expect(core.accounts.get(own.id)!.signedIn).toBe(false);
    expect(ctx.tasks.get(task.id)).toMatchObject({ status: 'ready', attempts: 0 });
    expect(ctx.governance.escalations()).toHaveLength(0);
    expect(core.orchestrator.state().paused).toBe(true);

    Object.assign(provider, { authFor: async (): Promise<ProviderAuthStatus> => ({ authenticated: true, method: 'fake', account: 'a@example.com', plan: 'max', detail: 'ok' }) });
    await core.refreshAccount(own.id);
    expect(core.orchestrator.state().paused).toBe(false);
  }, 40000);

  it("a pause of the user's own stays theirs", async () => {
    const { core, ctx, provider, own } = await setup(async (_req, kind) => {
      if (kind === 'work') throw expired();
      return null;
    });
    ctx.updateSettings({ autonomy: 'manual', permissionMode: 'ask' });
    core.orchestrator.attach(ctx);
    const task = ctx.tasks.create({ kind: 'implement', title: 'Make the lobby', objective: 'x', role: 'roblox-engineer', createdBy: 't', status: 'ready', acceptanceCriteria: ['works'], verification: [] });
    core.orchestrator.runNow(task.id);
    await waitFor(() => ctx.audit.timeline({ limit: 50 }).find((e) => e.kind === 'run.notice' && /then press Resume/.test(e.title)));
    expect(ctx.tasks.get(task.id)!.status).toBe('ready');
    Object.assign(provider, { authFor: async (): Promise<ProviderAuthStatus> => ({ authenticated: true, method: 'fake', account: 'a@example.com', plan: 'max', detail: 'ok' }) });
    await core.refreshAccount(own.id);
    expect(core.orchestrator.state().paused).toBe(true);
  }, 40000);
});
