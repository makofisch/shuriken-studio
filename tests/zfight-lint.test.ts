import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { zfightLuau } from '@core/roblox/zfight';
import { LUAURC, SELENE_TOML } from '@core/projects/project-service';
import { DEFAULT_SYNC_MAP, LuauToolchain } from '@core/roblox/luau-toolchain';

// The Z-fighting scan and its fix (1.17) run as plugin-level Luau in Studio: like map_audit, they must at least pass the
// strict checker agents' code passes (selene + strict luau-lsp with Roblox's types).
const bin = (t: string) => join(homedir(), '.local', 'bin', `${t}${process.platform === 'win32' ? '.exe' : ''}`);
const typesDir = process.env.LUAU_TYPES ?? join(process.env.APPDATA ?? join(homedir(), '.config'), 'Shuriken Studio', 'luau-types');
const available = existsSync(bin('selene')) && existsSync(bin('luau-lsp')) && existsSync(join(typesDir, 'globalTypes.d.luau'));

describe.skipIf(!available)('the Z-fighting scan', () => {
  it('passes selene and strict luau-lsp, as a check and as the fix', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shuriken-zfight-lint-'));
    writeFileSync(join(root, 'selene.toml'), SELENE_TOML);
    writeFileSync(join(root, '.luaurc'), LUAURC);
    mkdirSync(join(root, 'src', 'Server'), { recursive: true });
    writeFileSync(join(root, 'src/Server/ZCheck.server.luau'), `--!strict\n${zfightLuau({ areas: ['Map/Arena'], focus: ['Map/Lobby'] })}`);
    writeFileSync(join(root, 'src/Server/ZFix.server.luau'), `--!strict\n${zfightLuau({ fix: true })}`);
    const types = mkdtempSync(join(tmpdir(), 'shuriken-types-'));
    copyFileSync(join(typesDir, 'globalTypes.d.luau'), join(types, 'globalTypes.d.luau'));
    const r = await new LuauToolchain(types).check(root, DEFAULT_SYNC_MAP);
    expect(r.toolErrors).toEqual([]);
    expect(r.problems.map((p) => `${p.file} ${p.tool} ${p.line} ${p.code} ${p.message}`)).toEqual([]);
  }, 120_000);
});
