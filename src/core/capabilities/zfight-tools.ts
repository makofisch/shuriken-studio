import { z } from 'zod';
import type { ProjectContext } from '../projects/project-service';
import type { RobloxStudioAdapter } from '../roblox/studio-adapter';
import type { EventBus } from '../events';
import { ZFIGHT_MIN_GAP, runZFight, zfightCount, zfightFindings, zfightSummary } from '../roblox/zfight';

export { runZFight };
import { errorOutput, jsonOutput, type ToolRegistry } from './tool-registry';

/**
 * No Z-fighting in the place (1.17, roblox/zfight.ts): zfight_check finds coplanar overlapping parts and layers close
 * enough to flicker at game distance; zfight_fix removes, merges or offsets them. Agents run them after placing and
 * assembling parts; the critic reads zfight_check; the orchestrator puts a scan of what a task built in front of the
 * critic, and the regression suite runs one over the whole place.
 */
export interface ZFightToolDeps {
  project: () => ProjectContext | null;
  studio: RobloxStudioAdapter;
  bus: EventBus;
}

const areaInput = {
  area: z.string().optional().describe('A Workspace folder or model ("Map/Arena", "Workspace.Map.Lobby"); without it, the whole Workspace'),
  areas: z.array(z.string()).max(8).optional().describe('Several areas at once'),
};

export function registerZFightTools(reg: ToolRegistry, d: ZFightToolDeps): void {
  const studioAvail = () => d.studio.availability();
  const blocked = async () => {
    const w = await d.studio.waitForLease();
    return w.ok ? null : errorOutput(w.message);
  };
  const areasOf = (args: { area?: string; areas?: string[] }) => [...(args.area ? [args.area] : []), ...(args.areas ?? [])];

  reg.register({
    name: 'zfight_check',
    title: 'Check for Z-fighting',
    description: `Finds Z-fighting in the place: faces of two different parts that point the same way and lie in the same plane where they overlap (a rug laid at the floor's height, ground tiles over the graybox, a plate flush with a wall, a part or model placed twice), and layers closer than ${ZFIGHT_MIN_GAP} studs, which flicker at game distance. Box parts exactly; a thin MeshPart or union (a tile, a plate, a panel) by its box. Faces pointing opposite ways (a part resting on another) don't count. Returns the pairs (paths, gap, overlapping area, which way they face, same look or not, duplicates) and plain findings. Identical smooth surfaces are listed but don't flicker. Run it after you place or assemble parts; zfight_fix fixes what it finds. Parts under an attribute AllowOverlap = true are skipped.`,
    capability: 'roblox.app.inspect',
    permission: 'roblox_read',
    available: studioAvail,
    annotations: { readOnlyHint: true },
    input: areaInput,
    handler: async ({ args, signal }) => {
      const b = await blocked();
      if (b) return b;
      const r = await runZFight(d.studio, { areas: areasOf(args) }, signal);
      if (r.error) return errorOutput(`zfight_check failed: ${r.error}`);
      const findings = zfightFindings(r);
      return jsonOutput({ ...r, findings }, zfightSummary(r));
    },
  });

  reg.register({
    name: 'zfight_fix',
    title: 'Fix Z-fighting',
    description: `Fixes the Z-fighting zfight_check finds, pair by pair (the larger face stays where it is): a part placed twice loses its later copy; two block parts of the same look whose union is a box become one part; a same-look part inside the other's face is sunk behind it; otherwise the smaller part is lifted out along the face's normal until it is ${ZFIGHT_MIN_GAP} studs clear (the smallest gap that doesn't flicker at game distance; a downward face is tucked in instead). Unanchored parts and AllowOverlap parts are left alone and named. It changes the place in Studio (one undo step) and checks again: the result says what was moved (studs along each axis), merged and removed, and what is left. Make the same change in the builder code (world/*.luau, a geometry spec) that makes those parts, or a rebuild brings the flicker back.`,
    capability: 'roblox.app.geometry',
    permission: 'roblox_write',
    available: studioAvail,
    input: areaInput,
    handler: async ({ args, signal }) => {
      const b = await blocked();
      if (b) return b;
      const areas = areasOf(args);
      const fixed = await runZFight(d.studio, { areas, fix: true }, signal);
      if (fixed.error) return errorOutput(`zfight_fix failed: ${fixed.error}`);
      d.bus.emit('roblox.changed', { reason: 'luau' });
      // A second pass: what a move made meet, and what was left.
      const after = await runZFight(d.studio, { areas }, signal);
      const f = fixed.fixed ?? { lifted: 0, sunk: 0, merged: 0, removed: 0, skipped: 0, moves: [] };
      const did = [f.lifted && `${f.lifted} lifted`, f.sunk && `${f.sunk} sunk`, f.merged && `${f.merged} merged`, f.removed && `${f.removed} duplicate${f.removed === 1 ? '' : 's'} removed`, f.skipped && `${f.skipped} left alone`].filter(Boolean).join(', ') || 'nothing to change';
      const left = after.error ? null : zfightCount(after);
      return jsonOutput(
        { fixed: f, pairsFixed: fixed.list.filter((x) => x.fix), after: after.error ? { error: after.error } : { ...after, findings: zfightFindings(after) } },
        `${did}.${left === null ? '' : left ? ` Still ${left} pair${left === 1 ? '' : 's'}: ${zfightSummary(after)}` : ' No Z-fighting left.'}${f.moves.length ? ' Update the builder code that makes the moved parts the same way.' : ''}`,
      );
    },
  });
}
