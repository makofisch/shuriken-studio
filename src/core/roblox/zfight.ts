/**
 * Z-fighting where agents place and assemble parts (1.17). Kiln keeps a model's own parts apart; how models and parts
 * meet in the PLACE is Shuriken's: a rug laid on a floor at the floor's height, ground tiles over the hidden graybox, a
 * sign plate flush with a wall, a piece placed twice. Two faces of different parts that face the same way and lie in
 * the same plane (or closer than the depth buffer can tell apart at game distance) flicker as the camera moves.
 *
 * The scan runs in Studio's Edit DataModel (Luau through RobloxStudioAdapter). For every visible box part (and the two
 * large faces of a thin MeshPart or union, a plate whose surface is its box) it buckets faces by direction and plane,
 * then measures the real overlap of each candidate pair (the two face rectangles clipped against each other). A pair
 * counts when they overlap by more than MIN_AREA. Faces pointing opposite ways (one part resting on another) never
 * fight: each is hidden behind the other.
 *
 * The fix, pair by pair (the larger face stays put):
 * - an exact duplicate of the same look is removed (the hidden copy; only one with nothing inside it);
 * - two block parts of the same look whose union is a box are merged into one;
 * - a part of the same look lying inside the other's face is sunk behind it (it can't be seen there anyway);
 * - otherwise the smaller part is lifted out along the face's normal to MIN_GAP from the larger face (a downward face
 *   is tucked in instead: it is only seen from under the map).
 * Unanchored parts and anything under an AllowOverlap attribute are left alone (and said so).
 */
import type { RobloxStudioAdapter } from './studio-adapter';

/**
 * The smallest separation that doesn't flicker, in studs. A 24-bit depth buffer resolves about z² / (near · 2²⁴): with
 * a near plane around half a stud that is about 0.005 studs at 200 studs and 0.03 at 500, the far side of a map seen
 * from a high camera. 0.05 is clear of that with room to spare and still invisible at a character's scale (5.2 studs
 * tall; 0.05 studs is 1.4 cm at Roblox's 0.28 m per stud). It is the top of the 0.02-0.05 that map_audit's finding
 * suggested, and 25 times Kiln's in-model nudge (0.002), which is tuned for a model seen up close in Kiln's viewer.
 */
export const ZFIGHT_MIN_GAP = 0.05;
/** Closer than this the faces are in the same plane ("coplanar"); between this and ZFIGHT_MIN_GAP they are a layer that flickers at distance ("near"). */
export const ZFIGHT_COPLANAR = 0.001;
/** Parts scanned at most (the rest is reported as cut short). */
export const ZFIGHT_MAX_PARTS = 25_000;
/** The regression suite's own check (Verifier.regression). */
export const ZFIGHT_CHECK = 'No Z-fighting in the place';

export interface ZFightPair {
  a: string;
  b: string;
  /** 'coplanar': the same plane; 'near': a layer closer than ZFIGHT_MIN_GAP. */
  kind: 'coplanar' | 'near';
  /** Separation of the two faces, studs. */
  gap: number;
  /** Overlapping area, studs². */
  area: number;
  /** Which way the faces point. */
  facing: 'up' | 'down' | 'side';
  /** 'same': same material, colour, transparency and texture (identical smooth surfaces show no flicker); 'different': it flickers. */
  look: 'same' | 'different';
  /** It flickers in play (a different look, or a textured material whose texture is laid out per part). */
  visible: boolean;
  duplicate: boolean;
  /** A mesh or union taken as its box (a thin plate). */
  approx: boolean;
  /** What the fix did: lifted, sunk, merged, removed, or skipped: <why>. */
  fix?: string;
}

export interface ZFightReport {
  areas: string[];
  parts: number;
  faces: number;
  tests: number;
  pairs: number;
  visible: number;
  near: number;
  duplicates: number;
  list: ZFightPair[];
  truncated: boolean;
  minGap: number;
  /** With fix: how many pairs were handled each way, and the moves (part, studs along the face normal) for builder code to follow. */
  fixed?: { lifted: number; sunk: number; merged: number; removed: number; skipped: number; moves: Array<{ part: string; by: [number, number, number] }> };
  missing?: string[];
  error?: string;
}

/** Runs a scan (or a fix) in Studio's Edit DataModel and reads its report. */
export async function runZFight(studio: Pick<RobloxStudioAdapter, 'runLuau'>, opts: Parameters<typeof zfightLuau>[0], signal?: AbortSignal): Promise<ZFightReport> {
  const r = await studio.runLuau(zfightLuau(opts), 'Edit', 120_000, signal);
  if (!r.ok) return { ...EMPTY, areas: opts?.areas ?? [], error: r.output.slice(0, 600) };
  try {
    return JSON.parse(r.output) as ZFightReport;
  } catch {
    return { ...EMPTY, areas: opts?.areas ?? [], error: `no report came back (${r.output.slice(0, 300)})` };
  }
}

const EMPTY: ZFightReport = { areas: [], parts: 0, faces: 0, tests: 0, pairs: 0, visible: 0, near: 0, duplicates: 0, list: [], truncated: false, minGap: ZFIGHT_MIN_GAP };

/** A Workspace path ("Map/Arena", "Workspace.Map.Arena", "" = all) as the scan reads it. */
export function zfightPath(path: string): string {
  return path.trim().replace(/^game[./]/i, '').replace(/^Workspace[/.]?/i, '').replace(/\./g, '/');
}

/**
 * The scan (and with `fix`, the fix): `areas` limits it to these Workspace folders (none: the whole Workspace);
 * `focus` keeps only pairs where at least one part is under one of these (what a task built), the rest of the place
 * still counting as what it may fight with.
 */
export function zfightLuau(opts: { areas?: string[]; focus?: string[]; fix?: boolean; minGap?: number; maxParts?: number; maxTests?: number } = {}): string {
  const list = (xs: string[] | undefined) => `{ ${(xs ?? []).map((x) => JSON.stringify(zfightPath(x))).join(', ')} }`;
  return ZFIGHT.replace('__AREAS__', () => list(opts.areas))
    .replace('__FOCUS__', () => list(opts.focus))
    .replace('__FIX__', opts.fix ? 'true' : 'false')
    .replace('__MIN_GAP__', String(opts.minGap ?? ZFIGHT_MIN_GAP))
    .replace('__COPLANAR__', String(ZFIGHT_COPLANAR))
    .replace('__MAX_PARTS__', String(Math.round(opts.maxParts ?? ZFIGHT_MAX_PARTS)))
    .replace('__MAX_TESTS__', String(Math.round(opts.maxTests ?? 2_000_000)));
}

/**
 * The areas a task built or changed, from its DataModel diff ("Workspace.Map.Lobby.Wall#Part"): the Workspace folders
 * two levels down ("Map/Lobby"), at most 8 (one level down when there are more). Empty when it changed no parts there.
 */
export function zfightFocus(paths: string[]): string[] {
  const PARTISH = /#(Part|MeshPart|UnionOperation|IntersectOperation|NegateOperation|WedgePart|CornerWedgePart|TrussPart|SpawnLocation|Seat|VehicleSeat|Model|Folder)$/;
  const inWs = paths.filter((k) => /^Workspace\./.test(k) && PARTISH.test(k)).map((k) => k.replace(/#[^#]*$/, '').split('.').slice(1));
  const at = (depth: number) => [...new Set(inWs.map((segs) => segs.slice(0, Math.min(depth, Math.max(1, segs.length - 1))).join('/')).filter(Boolean))];
  const two = at(2);
  return two.length <= 8 ? two : at(1).slice(0, 8);
}

/** Pairs that need work: everything but identical smooth surfaces (which show no flicker). */
export const zfightCount = (r: ZFightReport): number => r.visible + r.duplicates;

/** One plain line about a scan. */
export function zfightSummary(r: ZFightReport): string {
  if (r.error) return `The Z-fighting check couldn't run: ${r.error}`;
  const scope = r.areas.length ? r.areas.join(', ') : 'the whole Workspace';
  if (!r.pairs) return `No Z-fighting in ${scope}: ${r.parts} parts, no two faces share a plane or sit closer than ${r.minGap} studs where they overlap.${r.truncated ? ' (Cut short: a very big area; check its parts in smaller areas.)' : ''}`;
  const n = zfightCount(r);
  const names = r.list
    .filter((p) => p.visible || p.duplicate)
    .slice(0, 4)
    .map((p) => `${p.a} × ${p.b}`)
    .join('; ');
  const quiet = r.pairs - n;
  return `${n ? `${n} pair${n === 1 ? '' : 's'} of parts Z-fight in ${scope}` : `No visible Z-fighting in ${scope}`}${r.near ? ` (${r.near} a layer closer than ${r.minGap} studs that flickers at distance)` : ''}${r.duplicates ? `, ${r.duplicates} of them a part placed twice` : ''}${names ? `: ${names}` : ''}${quiet > 0 ? `. ${quiet} more share a plane with an identical smooth surface (no flicker)` : ''}.${r.truncated ? ' (Cut short: a very big area.)' : ''}`;
}

/** Plain findings for an agent. */
export function zfightFindings(r: ZFightReport): string[] {
  if (r.error || !zfightCount(r)) return [];
  const out = [zfightSummary(r)];
  out.push(`Fix: zfight_fix ${r.areas.length ? `{areas: ${JSON.stringify(r.areas)}}` : '{}'} merges duplicates and same-look neighbours, removes a hidden copy and lifts the smaller face ${r.minGap} studs clear; then check again. Change the builder code (world/*.luau) that makes those parts the same way, or a rebuild brings the flicker back. Parts meant to overlap (a deliberate decal plate) get the attribute AllowOverlap = true.`);
  return out;
}

const ZFIGHT = `local HttpService = game:GetService("HttpService")
local AREAS: { string } = __AREAS__
local FOCUS: { string } = __FOCUS__
local FIX: boolean = __FIX__
local MIN_GAP: number = __MIN_GAP__
local COPLANAR: number = __COPLANAR__
local MAX_PARTS: number = __MAX_PARTS__
local MAX_TESTS: number = __MAX_TESTS__
local MIN_AREA = 0.04
local CELL = 32
local EPS = 0.01

local function resolve(path: string): Instance?
	if path == "" then
		return workspace
	end
	local inst: Instance? = workspace
	for seg in string.gmatch(path, "[^/]+") do
		inst = if inst then inst:FindFirstChild(seg) else nil
	end
	return inst
end

local roots: { Instance } = {}
local missing: { string } = {}
if #AREAS == 0 then
	table.insert(roots, workspace)
else
	for _, a in AREAS do
		local r = resolve(a)
		if r then
			table.insert(roots, r)
		else
			table.insert(missing, a)
		end
	end
end
if #roots == 0 then
	return HttpService:JSONEncode({ error = "No such area in Workspace: " .. table.concat(missing, ", ") })
end
local focusRoots: { Instance } = {}
for _, f in FOCUS do
	local r = resolve(f)
	if r then
		table.insert(focusRoots, r)
	end
end

local function inCharacter(p: Instance): boolean
	local m = p:FindFirstAncestorOfClass("Model")
	while m do
		if m:FindFirstChildOfClass("Humanoid") then
			return true
		end
		m = m:FindFirstAncestorOfClass("Model")
	end
	return false
end
local function exempt(p: Instance): boolean
	local i: Instance? = p
	while i and i ~= game do
		if i:GetAttribute("AllowOverlap") == true then
			return true
		end
		i = i.Parent
	end
	return false
end

local seen: { [Instance]: boolean } = {}
local parts: { BasePart } = {}
local truncated = false
local function consider(d: Instance)
	if seen[d] then
		return
	end
	seen[d] = true
	if not d:IsA("BasePart") or d:IsA("Terrain") then
		return
	end
	local p = d :: BasePart
	if p.Transparency >= 0.95 or inCharacter(p) or exempt(p) then
		return
	end
	if #parts >= MAX_PARTS then
		truncated = true
		return
	end
	table.insert(parts, p)
end
for _, r in roots do
	if r ~= workspace then
		consider(r)
	end
	for _, d in r:GetDescendants() do
		consider(d)
	end
end
local ids: { [BasePart]: number } = {}
for i, p in parts do
	ids[p] = i
end
local focused: { [BasePart]: boolean } = {}
for _, p in parts do
	for _, r in focusRoots do
		if p == r or p:IsDescendantOf(r) then
			focused[p] = true
			break
		end
	end
end

type Face = { part: BasePart, n: Vector3, d: number, c: Vector3, u: Vector3, v: Vector3, hu: number, hv: number, area: number, approx: boolean, q: { Vector2 }, lo: Vector2, hi: Vector2 }
local faces: { Face } = {}
local function addFaces(p: BasePart)
	local cf = p.CFrame
	local s = p.Size
	local axes = { cf.XVector, cf.YVector, cf.ZVector }
	local halves = { s.X / 2, s.Y / 2, s.Z / 2 }
	local which: { number } = {}
	local approx = false
	if p:IsA("Part") and (p :: Part).Shape == Enum.PartType.Block then
		which = { 1, 2, 3 }
	elseif p:IsA("MeshPart") or p:IsA("PartOperation") then
		-- A thin mesh or union (a ground tile, a plate, a panel): its two large faces are its surface.
		local mi = 1
		for i = 2, 3 do
			if halves[i] < halves[mi] then
				mi = i
			end
		end
		local largest = math.max(halves[1], halves[2], halves[3])
		if halves[mi] * 2 <= 0.6 or halves[mi] <= 0.05 * largest then
			which = { mi }
			approx = true
		end
	end
	for _, i in which do
		local j = (i % 3) + 1
		local k = ((i + 1) % 3) + 1
		for _, sign in { 1, -1 } do
			local n = axes[i] * sign
			local c = cf.Position + n * halves[i]
			table.insert(faces, { part = p, n = n, d = n:Dot(c), c = c, u = axes[j], v = axes[k], hu = halves[j], hv = halves[k], area = 4 * halves[j] * halves[k], approx = approx, q = {}, lo = Vector2.zero, hi = Vector2.zero })
		end
	end
end
for _, p in parts do
	addFaces(p)
end

local function signedArea(poly: { Vector2 }): number
	local s = 0
	local n = #poly
	for i = 1, n do
		local a = poly[i]
		local b = poly[i % n + 1]
		s += a.X * b.Y - b.X * a.Y
	end
	return s / 2
end
local function clip(poly: { Vector2 }, a: Vector2, b: Vector2): { Vector2 }
	local out: { Vector2 } = {}
	local n = #poly
	if n == 0 then
		return out
	end
	local function side(p: Vector2): number
		return (b.X - a.X) * (p.Y - a.Y) - (b.Y - a.Y) * (p.X - a.X)
	end
	for i = 1, n do
		local cur = poly[i]
		local prev = poly[(i - 2) % n + 1]
		local sc = side(cur)
		local sp = side(prev)
		if sc >= 0 then
			if sp < 0 then
				table.insert(out, prev + (cur - prev) * (sp / (sp - sc)))
			end
			table.insert(out, cur)
		elseif sp >= 0 then
			table.insert(out, prev + (cur - prev) * (sp / (sp - sc)))
		end
	end
	return out
end
local function basis(n: Vector3): (Vector3, Vector3)
	local h = if math.abs(n.Y) < 0.9 then Vector3.yAxis else Vector3.xAxis
	local u = h:Cross(n).Unit
	return u, n:Cross(u)
end
local function prepare(f: Face, bu: Vector3, bv: Vector3)
	local pts: { Vector2 } = {}
	local lo = Vector2.new(math.huge, math.huge)
	local hi = Vector2.new(-math.huge, -math.huge)
	for _, s in { { -1, -1 }, { 1, -1 }, { 1, 1 }, { -1, 1 } } do
		local w = f.c + f.u * (f.hu * s[1]) + f.v * (f.hv * s[2])
		local pt = Vector2.new(w:Dot(bu), w:Dot(bv))
		table.insert(pts, pt)
		lo = lo:Min(pt)
		hi = hi:Max(pt)
	end
	if signedArea(pts) < 0 then
		pts = { pts[4], pts[3], pts[2], pts[1] }
	end
	f.q = pts
	f.lo = lo
	f.hi = hi
end

type Hit = { a: BasePart, b: BasePart, fa: Face, fb: Face, gap: number, area: number }
local hits: { [string]: Hit } = {}
local tests = 0
local function test(fa: Face, fb: Face)
	if fa.part == fb.part then
		return
	end
	local gap = math.abs(fa.d - fb.d)
	if gap >= MIN_GAP or fa.n:Dot(fb.n) < 0.9995 then
		return
	end
	if #focusRoots > 0 and not focused[fa.part] and not focused[fb.part] then
		return
	end
	if fa.hi.X < fb.lo.X or fb.hi.X < fa.lo.X or fa.hi.Y < fb.lo.Y or fb.hi.Y < fa.lo.Y then
		return
	end
	tests += 1
	if tests > MAX_TESTS then
		truncated = true
		return
	end
	local poly = fb.q
	for i = 1, 4 do
		poly = clip(poly, fa.q[i], fa.q[i % 4 + 1])
		if #poly == 0 then
			return
		end
	end
	local area = math.abs(signedArea(poly))
	if area < MIN_AREA then
		return
	end
	local ia = ids[fa.part]
	local ib = ids[fb.part]
	local key = if ia < ib then ia .. ":" .. ib else ib .. ":" .. ia
	local h = hits[key]
	if not h or area > h.area then
		hits[key] = { a = fa.part, b = fb.part, fa = fa, fb = fb, gap = gap, area = area }
	end
end

-- Faces by direction, then by plane: only faces that point the same way and lie within MIN_GAP of each other are compared,
-- and among those only the ones whose rectangles share a grid cell.
local buckets: { [string]: { Face } } = {}
for _, f in faces do
	local key = string.format("%d,%d,%d", math.round(f.n.X * 100), math.round(f.n.Y * 100), math.round(f.n.Z * 100))
	local b = buckets[key]
	if not b then
		b = {}
		buckets[key] = b
	end
	table.insert(b, f)
end
for _, bucket in buckets do
	if #bucket < 2 or tests > MAX_TESTS then
		continue
	end
	local bu, bv = basis(bucket[1].n)
	for _, f in bucket do
		prepare(f, bu, bv)
	end
	table.sort(bucket, function(x: Face, y: Face): boolean
		return x.d < y.d
	end)
	local i = 1
	while i <= #bucket do
		-- A run of faces whose planes are each within MIN_GAP of the next.
		local j = i
		while j < #bucket and bucket[j + 1].d - bucket[j].d < MIN_GAP do
			j += 1
		end
		if j > i then
			local cells: { [string]: { number } } = {}
			local big: { number } = {}
			for k = i, j do
				local f = bucket[k]
				local x0 = math.floor(f.lo.X / CELL)
				local x1 = math.floor(f.hi.X / CELL)
				local y0 = math.floor(f.lo.Y / CELL)
				local y1 = math.floor(f.hi.Y / CELL)
				if (x1 - x0 + 1) * (y1 - y0 + 1) > 256 then
					table.insert(big, k)
				else
					for x = x0, x1 do
						for y = y0, y1 do
							local ck = x .. "," .. y
							local c = cells[ck]
							if not c then
								c = {}
								cells[ck] = c
							end
							table.insert(c, k)
						end
					end
				end
			end
			local done: { [number]: boolean } = {}
			local width = #bucket + 1
			local function pair(a: number, b: number)
				local lo = math.min(a, b)
				local hi = math.max(a, b)
				local key = lo * width + hi
				if done[key] then
					return
				end
				done[key] = true
				test(bucket[lo], bucket[hi])
			end
			for _, c in cells do
				for x = 1, #c do
					for y = x + 1, #c do
						pair(c[x], c[y])
					end
				end
			end
			for _, b in big do
				for k = i, j do
					if k ~= b then
						pair(b, k)
					end
				end
			end
		end
		i = j + 1
	end
end

local SMOOTH = { [Enum.Material.SmoothPlastic] = true, [Enum.Material.Neon] = true, [Enum.Material.ForceField] = true, [Enum.Material.Glass] = true }
local function lookOf(p: BasePart): string
	local tex = ""
	if p:IsA("MeshPart") then
		tex = (p :: MeshPart).TextureID
	end
	if p:FindFirstChildOfClass("SurfaceAppearance") then
		tex = tex .. "|sa"
	end
	local c = p.Color
	return string.format("%s|%d,%d,%d|%.2f|%s", p.Material.Name, math.round(c.R * 255), math.round(c.G * 255), math.round(c.B * 255), p.Transparency, tex)
end
local function smoothLook(p: BasePart): boolean
	return SMOOTH[p.Material] == true and not p:FindFirstChildOfClass("SurfaceAppearance") and not (p:IsA("MeshPart") and (p :: MeshPart).TextureID ~= "")
end
local function duplicateOf(a: BasePart, b: BasePart): boolean
	if a.ClassName ~= b.ClassName or (a.Size - b.Size).Magnitude > EPS or (a.Position - b.Position).Magnitude > EPS then
		return false
	end
	if not a.CFrame.Rotation:FuzzyEq(b.CFrame.Rotation, 1e-3) then
		return false
	end
	if a:IsA("MeshPart") and (a :: MeshPart).MeshId ~= (b :: MeshPart).MeshId then
		return false
	end
	return true
end
local function name(p: Instance): string
	local full = p:GetFullName()
	full = (string.gsub(full, "^Workspace%.", ""))
	if #full > 90 then
		full = "…" .. string.sub(full, -89)
	end
	return full
end

type Meta = { same: boolean, visible: boolean, dup: boolean }
local list: { Hit } = {}
local meta: { [Hit]: Meta } = {}
for _, h in hits do
	table.insert(list, h)
	local same = lookOf(h.a) == lookOf(h.b)
	meta[h] = { same = same, visible = not (same and smoothLook(h.a)), dup = duplicateOf(h.a, h.b) }
end
table.sort(list, function(x: Hit, y: Hit): boolean
	if meta[x].visible ~= meta[y].visible then
		return meta[x].visible
	end
	return x.area > y.area
end)
-- Where an instance sits (sibling positions from the top): of two copies, the later one goes, so a model placed twice
-- loses its whole second copy, not half of each.
local function order(p: Instance): { number }
	local chain: { number } = {}
	local i: Instance? = p
	while i and i.Parent and i ~= workspace do
		local parent = i.Parent :: Instance
		table.insert(chain, 1, table.find(parent:GetChildren(), i) or 0)
		i = parent
	end
	return chain
end
local function later(a: Instance, b: Instance): boolean
	local x, y = order(a), order(b)
	for k = 1, math.max(#x, #y) do
		local u, v = x[k] or -1, y[k] or -1
		if u ~= v then
			return u > v
		end
	end
	return false
end

-- The fix.
local fixes: { [Hit]: string } = {}
local counts = { lifted = 0, sunk = 0, merged = 0, removed = 0, skipped = 0 }
local moves: { { part: string, by: { number } } } = {}
if FIX then
	local touched: { [BasePart]: boolean } = {}
	-- What a part holds besides its look (a SurfaceAppearance, a Decal or Texture): scripts, attachments, welds, sounds.
	local LOOK = { SurfaceAppearance = true, Decal = true, Texture = true, SpecialMesh = true }
	local function children(p: Instance): number
		local n = 0
		for _, c in p:GetChildren() do
			if not LOOK[c.ClassName] then
				n += 1
			end
		end
		return n
	end
	local function sameBody(a: BasePart, b: BasePart): boolean
		return a.Anchored == b.Anchored and a.CanCollide == b.CanCollide and a.CanQuery == b.CanQuery and a.CanTouch == b.CanTouch and a.CastShadow == b.CastShadow and a.Reflectance == b.Reflectance and a.CollisionGroup == b.CollisionGroup and a.Parent == b.Parent
	end
	-- The box two same-look block parts make together, when it is one: its local min and max in big's frame.
	local function union(big: BasePart, small: BasePart): ({ number }?, { number }?)
		if big.ClassName ~= "Part" or small.ClassName ~= "Part" then
			return nil, nil
		end
		if (big :: Part).Shape ~= Enum.PartType.Block or (small :: Part).Shape ~= Enum.PartType.Block then
			return nil, nil
		end
		if children(big) > 0 or children(small) > 0 or not sameBody(big, small) then
			return nil, nil
		end
		if not big.CFrame.Rotation:FuzzyEq(small.CFrame.Rotation, 1e-4) then
			return nil, nil
		end
		local c = big.CFrame:PointToObjectSpace(small.Position)
		local hb = { big.Size.X / 2, big.Size.Y / 2, big.Size.Z / 2 }
		local hs = { small.Size.X / 2, small.Size.Y / 2, small.Size.Z / 2 }
		local cc = { c.X, c.Y, c.Z }
		local mn: { number } = {}
		local mx: { number } = {}
		local equal = 0
		local inside = 0
		local joined = true
		for i = 1, 3 do
			local bmin, bmax = -hb[i], hb[i]
			local smin, smax = cc[i] - hs[i], cc[i] + hs[i]
			mn[i] = math.min(bmin, smin)
			mx[i] = math.max(bmax, smax)
			if math.abs(bmin - smin) < EPS and math.abs(bmax - smax) < EPS then
				equal += 1
			end
			if smin >= bmin - EPS and smax <= bmax + EPS then
				inside += 1
			end
			if smin > bmax + EPS or smax < bmin - EPS then
				joined = false
			end
		end
		if inside == 3 or (equal >= 2 and joined) then
			return mn, mx
		end
		return nil, nil
	end
	for _, h in list do
		if touched[h.a] or touched[h.b] or not h.a.Parent or not h.b.Parent then
			continue
		end
		local m = meta[h]
		local same, visible, dup = m.same, m.visible, m.dup
		local big, small, fbig, fsmall = h.a, h.b, h.fa, h.fb
		if h.fb.area > h.fa.area or (h.fb.area == h.fa.area and h.b.Size.Magnitude > h.a.Size.Magnitude) then
			big, small, fbig, fsmall = h.b, h.a, h.fb, h.fa
		end
		if dup then
			if not same then
				fixes[h] = "skipped: the same part twice in two looks (pick which stays)"
				counts.skipped += 1
				continue
			end
			local first = if later(h.a, h.b) then h.a else h.b
			local other = if first == h.a then h.b else h.a
			local gone = if children(first) == 0 then first elseif children(other) == 0 then other else nil
			if not gone then
				fixes[h] = "skipped: both copies hold children"
				counts.skipped += 1
				continue
			end
			touched[h.a] = true
			touched[h.b] = true
			fixes[h] = "removed " .. name(gone)
			gone:Destroy()
			counts.removed += 1
			continue
		end
		-- Identical smooth surfaces show no flicker: nothing to change.
		if not visible then
			continue
		end
		if same then
			local mn, mx = union(big, small)
			if mn and mx then
				local lo = Vector3.new(mn[1], mn[2], mn[3])
				local hi = Vector3.new(mx[1], mx[2], mx[3])
				local cf = big.CFrame * CFrame.new((lo + hi) / 2)
				touched[big] = true
				touched[small] = true
				fixes[h] = "merged into " .. name(big)
				big.Size = hi - lo
				big.CFrame = cf
				small:Destroy()
				counts.merged += 1
				continue
			end
		end
		if not small.Anchored then
			fixes[h] = "skipped: " .. name(small) .. " is unanchored"
			counts.skipped += 1
			continue
		end
		local n = fbig.n
		-- Inside the larger face with the same look, or facing down (seen only from under the map): tucked in behind it.
		local covered = same and fsmall.lo.X >= fbig.lo.X - EPS and fsmall.hi.X <= fbig.hi.X + EPS and fsmall.lo.Y >= fbig.lo.Y - EPS and fsmall.hi.Y <= fbig.hi.Y + EPS
		local tuck = covered or n.Y < -0.7
		local target = if tuck then fbig.d - MIN_GAP else fbig.d + MIN_GAP
		local by = n * (target - fsmall.d)
		small.CFrame = small.CFrame + by
		touched[small] = true
		table.insert(moves, { part = name(small), by = { math.round(by.X * 1000) / 1000, math.round(by.Y * 1000) / 1000, math.round(by.Z * 1000) / 1000 } })
		if tuck then
			fixes[h] = "sunk " .. name(small)
			counts.sunk += 1
		else
			fixes[h] = "lifted " .. name(small)
			counts.lifted += 1
		end
	end
	pcall(function()
		game:GetService("ChangeHistoryService"):SetWaypoint("Shuriken: fix Z-fighting")
	end)
end

local out = {}
local visibleCount, nearCount, dupCount = 0, 0, 0
for _, h in list do
	local m = meta[h]
	local same, visible, dup = m.same, m.visible, m.dup
	if dup then
		dupCount += 1
	elseif visible then
		visibleCount += 1
	end
	if h.gap >= COPLANAR then
		nearCount += 1
	end
	if #out < 40 then
		local n = h.fa.n
		table.insert(out, {
			a = name(h.a),
			b = name(h.b),
			kind = if h.gap < COPLANAR then "coplanar" else "near",
			gap = math.round(h.gap * 10000) / 10000,
			area = math.round(h.area * 10) / 10,
			facing = if n.Y > 0.7 then "up" elseif n.Y < -0.7 then "down" else "side",
			look = if same then "same" else "different",
			visible = visible,
			duplicate = dup,
			approx = h.fa.approx or h.fb.approx,
			fix = fixes[h],
		})
	end
end
local areaNames: { string } = {}
for _, a in AREAS do
	table.insert(areaNames, a)
end
return HttpService:JSONEncode({
	areas = areaNames,
	parts = #parts,
	faces = #faces,
	tests = tests,
	pairs = #list,
	visible = visibleCount,
	near = nearCount,
	duplicates = dupCount,
	list = out,
	truncated = truncated,
	minGap = MIN_GAP,
	fixed = if FIX then { lifted = counts.lifted, sunk = counts.sunk, merged = counts.merged, removed = counts.removed, skipped = counts.skipped, moves = moves } else nil,
	missing = if #missing > 0 then missing else nil,
})
`;
