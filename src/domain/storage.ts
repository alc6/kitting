// Storage locations (D194–D200): the workshop plan, drawn as rooms, doors, landmarks and storage units on a grid of
// squares (half a metre unless changed, D209), and the home location of each part. Bins are not rows: a unit of L levels × P positions has the
// bins "<code>-<level>-<position>", level counted from the floor and position from the left when facing the unit's
// front. A unit can stand in a bin of another one (a drawer cabinet on a shelf): a location is then read through the
// chain of bins that holds it. Stock is not counted per bin: a location tells people where to look and where to put
// away.
import { type AnyColumn, and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
	type PartKind,
	type PartLocation,
	partLocations,
	parts,
	type RoomArea,
	roomAreas,
	STORAGE_FRONTS,
	STORAGE_KINDS,
	type StorageFront,
	type StorageKind,
	type StorageUnit,
	settings,
	storageUnits,
} from "../db/schema";
import type { Statement } from "../lib/db";
import { type FieldErrors, field } from "../lib/validation";
import type { Db } from "../types";
import { listParts, onHandSql } from "./parts";

/** More is a typing mistake, and the front view would not fit a tablet. */
export const MAX_LEVELS = 20;
export const MAX_POSITIONS = 30;
/** The size of a square of the plan, in centimetres: half a metre unless the workshop sets another (D209). */
export const SQUARE_CM = { default: 50, min: 5, max: 500 } as const;
/** The plan is at least this big, and grows with the units up to PLAN_MAX_CM each way: limits are in centimetres (D210). */
export const PLAN_MIN_CM = { width: 1200, depth: 700 } as const;
export const PLAN_MAX_CM = 10000;
/** How many squares of this size fit in the plan's largest side. */
export const planMaxSquares = (squareCm: number) => Math.floor(PLAN_MAX_CM / squareCm);

/** Keys of the plan's rows in `settings`. A missing row means the default. */
export const PLAN_SETTINGS = { squareCm: "plan_square_cm", width: "plan_width", depth: "plan_depth" } as const;

/** The plan's settings: the square's size, and a fixed main area in squares (null: it grows with the units). */
export type PlanSettings = { squareCm: number; area: { width: number; depth: number } | null };
export const DEFAULT_PLAN: PlanSettings = { squareCm: SQUARE_CM.default, area: null };
/** How many units deep a location can be: a box in a drawer cabinet on a rack is three. */
export const MAX_DEPTH = 4;

/** Unit codes: upper-case letters and digits, short enough for a shelf label. No hyphen: it separates the bin parts. */
const CODE = /^[A-Z0-9]{1,6}$/;

export const PLACEMENTS = ["plan", "bin"] as const;
export type Placement = (typeof PLACEMENTS)[number];

export const storageUnitInput = z.object({
	code: z
		.string()
		.trim()
		.transform((v) => v.toUpperCase())
		.refine((v) => v === "" || CODE.test(v), "invalid_storage_code"),
	name: field.text(200),
	kind: field.oneOf(STORAGE_KINDS, "invalid"),
	placement: z
		.string()
		.trim()
		.transform((v) => (v === "bin" ? "bin" : "plan") as Placement),
	parent_bin: field.text(40),
	col: field.int(),
	row: field.int(),
	width: field.int(),
	depth: field.int(),
	front: field.oneOf(STORAGE_FRONTS, "invalid"),
	levels: field.int(),
	positions: field.int(),
	notes: field.text(),
});
export type StorageUnitInput = z.output<typeof storageUnitInput>;

/** Kinds that hold parts; kinds whose bins are levels × positions (a floor area is one place); kinds that can stand in a bin. */
export const holdsParts = (kind: StorageKind) => kind === "rack" || kind === "cabinet" || kind === "floor";
export const hasBins = (kind: StorageKind) => kind === "rack" || kind === "cabinet";
export const nestable = hasBins;
/** Rooms, doors and landmarks: drawn for orientation, their code made up when left empty. */
export const drawnOnly = (kind: StorageKind) => !holdsParts(kind);

export const onPlan = (u: Pick<StorageUnit, "parentUnitId">) => u.parentUnitId === null;

/** A unit as the form and storage_units.csv show it: `areas` is the CSV's cell, `area2_col`… the form's fields. */
export function unitToForm(u: ShapedUnit, units: Map<number, StorageUnit>): Record<string, string> {
	const parent = u.parentUnitId === null ? undefined : units.get(u.parentUnitId);
	return {
		code: u.code,
		name: u.name,
		kind: u.kind,
		placement: parent ? "bin" : "plan",
		parent_bin: parent ? binCode(parent.code, u.parentLevel, u.parentPosition) : "",
		col: String(u.col),
		row: String(u.row),
		width: String(u.width),
		depth: String(u.depth),
		front: u.front,
		levels: String(u.levels),
		positions: String(u.positions),
		notes: u.notes,
		areas: areasCell(u.areas),
		...areasToForm(u.areas),
	};
}

export type Rect = { col: number; row: number; width: number; depth: number };
const overlaps = (a: Rect, b: Rect) =>
	a.col < b.col + b.width && b.col < a.col + a.width && a.row < b.row + b.depth && b.row < a.row + a.depth;
const rectOf = (r: Rect): Rect => ({ col: r.col, row: r.row, width: r.width, depth: r.depth });

// ---------------------------------------------------------------------------
// Rooms made of several rectangles (D211)

/** A room is its own rectangle plus at most this many areas: an L needs one, a U two. */
export const MAX_AREAS = 7;

/**
 * A unit as the plan reads it: a room carries its other rectangles (`room_areas`, D211), any other unit none. Every
 * function that draws the plan or says which room a unit is in takes this type, so that a loader that forgets the areas
 * does not compile.
 */
export type ShapedUnit = StorageUnit & { areas: Rect[] };

/** Attaches the rooms' areas (in id order) to the units. */
export function withAreas(units: StorageUnit[], areas: Pick<RoomArea, "roomId" | "col" | "row" | "width" | "depth">[]) {
	const byRoom = new Map<number, Rect[]>();
	for (const a of areas) byRoom.set(a.roomId, [...(byRoom.get(a.roomId) ?? []), rectOf(a)]);
	return units.map((u): ShapedUnit => ({ ...u, areas: u.kind === "room" ? (byRoom.get(u.id) ?? []) : [] }));
}

/** Every unit of the plan with its areas. */
export async function loadUnits(db: Db): Promise<ShapedUnit[]> {
	const [units, areas] = await Promise.all([
		db.select().from(storageUnits),
		db.select().from(roomAreas).orderBy(asc(roomAreas.id)),
	]);
	return withAreas(units, areas);
}

/** The rectangles a unit covers on the plan: a room's own and its areas, one for any other unit. */
export const rectsOf = (u: Rect & { areas?: Rect[] }): Rect[] => [rectOf(u), ...(u.areas ?? [])];

/** The smallest rectangle around these. */
export function boundsOf(rects: Rect[]): Rect {
	const col = Math.min(...rects.map((r) => r.col));
	const row = Math.min(...rects.map((r) => r.row));
	return {
		col,
		row,
		width: Math.max(...rects.map((r) => r.col + r.width)) - col,
		depth: Math.max(...rects.map((r) => r.row + r.depth)) - row,
	};
}

/**
 * Whether a point (a unit's centre: a multiple of half a square) is strictly inside these rectangles taken together. A
 * point on the line where two of them meet is inside, one on the outer walls is not: the four points a quarter of a
 * square around it must all be inside one of the rectangles.
 */
export function insideRects(rects: Rect[], x: number, y: number): boolean {
	const within = (px: number, py: number) =>
		rects.some((r) => px > r.col && px < r.col + r.width && py > r.row && py < r.row + r.depth);
	return [-0.25, 0.25].every((dx) => [-0.25, 0.25].every((dy) => within(x + dx, y + dy)));
}

/** Two rectangles are one room when they overlap or share a stretch of wall; touching at a corner is not enough. */
function joined(a: Rect, b: Rect): boolean {
	const x = Math.min(a.col + a.width, b.col + b.width) - Math.max(a.col, b.col);
	const y = Math.min(a.row + a.depth, b.row + b.depth) - Math.max(a.row, b.row);
	return x >= 0 && y >= 0 && (x > 0 || y > 0);
}

/** The indexes of the areas that are not joined to the room's own rectangle, directly or through other areas. */
export function detachedAreas(main: Rect, areas: Rect[]): number[] {
	const reached = new Set<number>();
	const queue: Rect[] = [main];
	while (queue.length) {
		const r = queue.shift() as Rect;
		areas.forEach((a, i) => {
			if (!reached.has(i) && joined(r, a)) {
				reached.add(i);
				queue.push(a);
			}
		});
	}
	return areas.map((_, i) => i).filter((i) => !reached.has(i));
}

/**
 * The walls around these rectangles taken together, as closed loops of corners (in squares, clockwise on screen). Lines
 * where two rectangles meet or overlap are inside, so they are no wall. Worked out on the grid of the rectangles' own
 * edges, not on squares, so it stays small whatever the size of a square.
 */
export function outlineOf(rects: Rect[]): [number, number][][] {
	const xs = [...new Set(rects.flatMap((r) => [r.col, r.col + r.width]))].sort((a, b) => a - b);
	const ys = [...new Set(rects.flatMap((r) => [r.row, r.row + r.depth]))].sort((a, b) => a - b);
	const nx = xs.length - 1;
	const ny = ys.length - 1;
	const x = (i: number) => xs[i] as number;
	const y = (j: number) => ys[j] as number;
	const covered: boolean[] = [];
	for (let j = 0; j < ny; j++)
		for (let i = 0; i < nx; i++)
			covered.push(
				rects.some((r) => r.col <= x(i) && x(i + 1) <= r.col + r.width && r.row <= y(j) && y(j + 1) <= r.row + r.depth),
			);
	const inside = (i: number, j: number) => i >= 0 && j >= 0 && i < nx && j < ny && covered[j * nx + i] === true;
	// Each wall is an edge between a covered cell and an uncovered one, directed so that the room is on its right.
	type Edge = { from: [number, number]; to: [number, number]; used: boolean };
	const edges: Edge[] = [];
	const add = (from: [number, number], to: [number, number]) => edges.push({ from, to, used: false });
	for (let j = 0; j < ny; j++)
		for (let i = 0; i < nx; i++) {
			if (!inside(i, j)) continue;
			if (!inside(i, j - 1)) add([x(i), y(j)], [x(i + 1), y(j)]);
			if (!inside(i + 1, j)) add([x(i + 1), y(j)], [x(i + 1), y(j + 1)]);
			if (!inside(i, j + 1)) add([x(i + 1), y(j + 1)], [x(i), y(j + 1)]);
			if (!inside(i - 1, j)) add([x(i), y(j + 1)], [x(i), y(j)]);
		}
	const key = (p: [number, number]) => `${p[0]},${p[1]}`;
	const starting = new Map<string, Edge[]>();
	for (const e of edges) starting.set(key(e.from), [...(starting.get(key(e.from)) ?? []), e]);
	const loops: [number, number][][] = [];
	for (const first of edges) {
		if (first.used) continue;
		const corners: [number, number][] = [];
		for (let e: Edge | undefined = first; e && !e.used; ) {
			e.used = true;
			corners.push(e.from);
			e = starting.get(key(e.to))?.find((n) => !n.used);
		}
		// Keep the corners only: drop the points in the middle of a straight wall.
		const n = corners.length;
		loops.push(
			corners.filter((p, k) => {
				const a = corners[(k + n - 1) % n] as [number, number];
				const b = corners[(k + 1) % n] as [number, number];
				return !((a[0] === p[0] && p[0] === b[0]) || (a[1] === p[1] && p[1] === b[1]));
			}),
		);
	}
	return loops;
}

/** Areas as one cell of storage_units.csv: "col,row,width,depth" each, separated by semicolons. */
export const areasCell = (areas: Rect[]) => areas.map((a) => `${a.col},${a.row},${a.width},${a.depth}`).join("; ");

/** Reads the `areas` cell back: null when it is not shaped like one. */
export function parseAreasCell(text: string): Rect[] | null {
	const t = text.trim();
	if (t === "") return [];
	const out: Rect[] = [];
	for (const group of t.split(";")) {
		if (group.trim() === "") continue;
		const m = /^\s*(\d{1,6})\s*,\s*(\d{1,6})\s*,\s*(\d{1,6})\s*,\s*(\d{1,6})\s*$/.exec(group);
		if (!m) return null;
		out.push({ col: Number(m[1]), row: Number(m[2]), width: Number(m[3]), depth: Number(m[4]) });
	}
	return out;
}

/** The form's names of area `n` (counted from 2: the room's own rectangle is the first). */
export const areaField = (n: number, side: keyof Rect) => `area${n}_${side}`;
const SIDES = ["col", "row", "width", "depth"] as const;

/** The form's fields of these areas. */
export function areasToForm(areas: Rect[]): Record<string, string> {
	const out: Record<string, string> = {};
	areas.forEach((a, i) => {
		for (const side of SIDES) out[areaField(i + 2, side)] = String(a[side]);
	});
	return out;
}

/** How many areas a posted form has: area2_*, area3_*… up to the first missing one. */
export function areaCount(body: Record<string, unknown>): number {
	let n = 0;
	while (n < MAX_AREAS && SIDES.some((side) => body[areaField(n + 2, side)] !== undefined)) n++;
	return n;
}

/** The areas a form posted, or the errors of their fields. */
export function readAreaFields(
	body: Record<string, unknown>,
): { ok: true; areas: Rect[] } | { ok: false; errors: FieldErrors } {
	const areas: Rect[] = [];
	const errors: FieldErrors = {};
	const whole = field.int();
	for (let i = 0; i < areaCount(body); i++) {
		const a: Rect = { col: 0, row: 0, width: 0, depth: 0 };
		for (const side of SIDES) {
			const name = areaField(i + 2, side);
			const raw = body[name];
			const r = whole.safeParse(typeof raw === "string" ? raw : "");
			if (r.success) a[side] = r.data;
			else errors[name] = r.error.issues[0]?.message ?? "invalid";
		}
		areas.push(a);
	}
	return Object.keys(errors).length ? { ok: false, errors } : { ok: true, areas };
}

/** The form's fields without area `n`, the next ones moved up. */
export function withoutArea(body: Record<string, string>, n: number): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(body)) if (!/^area\d+_/.test(k)) out[k] = v;
	const count = areaCount(body);
	let to = 2;
	for (let from = 2; from < count + 2; from++) {
		if (from === n) continue;
		for (const side of SIDES) out[areaField(to, side)] = body[areaField(from, side)] ?? "";
		to++;
	}
	return out;
}

/** The form's fields with one more area: below the room's rectangle, half its width and as deep, to start an L. */
export function withNewArea(body: Record<string, string>): Record<string, string> {
	const count = areaCount(body);
	if (count >= MAX_AREAS) return body;
	const num = (k: string, d: number) => (/^\d+$/.test(body[k]?.trim() ?? "") ? Number(body[k]) : d);
	const main = {
		col: num("col", 0),
		row: num("row", 0),
		width: Math.max(1, num("width", 2)),
		depth: Math.max(1, num("depth", 2)),
	};
	const n = count + 2;
	return {
		...body,
		[areaField(n, "col")]: String(main.col),
		[areaField(n, "row")]: String(main.row + main.depth),
		[areaField(n, "width")]: String(Math.max(1, Math.ceil(main.width / 2))),
		[areaField(n, "depth")]: String(main.depth),
	};
}

/** What a unit's row holds once checked: the code made up if needed, the parent bin resolved. */
export type UnitValues = Omit<StorageUnit, "id" | "createdAt" | "updatedAt" | "createdBy" | "updatedBy">;

/** A free code for a room, door or landmark left without one: "ROOM", "DOOR2"… from its name or its kind. */
function madeUpCode(d: StorageUnitInput, taken: Set<string>): string {
	const fromName = d.name.toUpperCase().replace(/[^A-Z0-9]/g, "");
	const base = (fromName || d.kind.toUpperCase()).slice(0, 4);
	if (!taken.has(base)) return base;
	for (let n = 2; n < 100; n++) if (!taken.has(`${base}${n}`)) return `${base}${n}`;
	return `${base.slice(0, 2)}${Date.now() % 10000}`;
}

/** `vars` fill the error messages that state a size (the plan's area). */
export type CheckedUnit =
	| { ok: true; values: UnitValues; areas: Rect[] }
	| { ok: false; errors: FieldErrors; vars?: Record<string, number> };
/** The bins of a unit that hold parts (level and position as in `part_locations`). */
export type UsedBin = { level: number | null; position: number | null };

/**
 * Rules a form or an import must pass beyond field formats: sizes, the plan, the code, the bin a unit stands in, bins
 * still in use. Returns the values to write, or the field errors.
 */
export async function checkUnit(db: Db, d: StorageUnitInput, areas: Rect[], id?: number): Promise<CheckedUnit> {
	const [all, used, plan] = await Promise.all([
		loadUnits(db),
		id
			? db
					.select({ level: partLocations.level, position: partLocations.position })
					.from(partLocations)
					.where(eq(partLocations.unitId, id))
			: Promise.resolve([]),
		loadPlanSettings(db),
	]);
	return checkUnitIn(all, used, d, id, plan, areas);
}

/**
 * `checkUnit` against a plan in memory: `all` the units as they stand (an import passes the plan as the rows before
 * this one leave it), `used` the bins of unit `id` that hold parts, `plan` the plan's settings (a fixed area is a wall),
 * `areas` a room's other rectangles (ignored for any other kind: saving drops them).
 */
export function checkUnitIn(
	all: ShapedUnit[],
	used: UsedBin[],
	d: StorageUnitInput,
	id: number | undefined,
	plan: PlanSettings,
	areas: Rect[] = [],
): CheckedUnit {
	const errors: FieldErrors = {};
	const others = all.filter((u) => u.id !== id);
	const bins = hasBins(d.kind);
	let { levels, positions } = d;
	if (!bins) {
		levels = 1;
		positions = 1;
	} else {
		if (levels < 1 || levels > MAX_LEVELS) errors.levels = "storage_levels_range";
		if (positions < 1 || positions > MAX_POSITIONS) errors.positions = "storage_positions_range";
	}
	const taken = new Set(others.map((u) => u.code));
	let code = d.code;
	if (code === "") {
		if (holdsParts(d.kind)) errors.code = "required";
		else code = madeUpCode(d, taken);
	} else if (taken.has(code)) errors.code = "storage_code_taken";

	let parent: { unitId: number; level: number | null; position: number | null } | null = null;
	const ownAreas = d.kind === "room" && d.placement === "plan" ? areas : [];
	if (ownAreas.length > MAX_AREAS) errors.areas = "storage_areas_many";
	if (d.placement === "bin") {
		if (!nestable(d.kind)) errors.kind = "storage_not_nestable";
		const b = parseBin(d.parent_bin);
		const host = b ? others.find((u) => u.code === b.code) : undefined;
		if (!b) errors.parent_bin = d.parent_bin.trim() === "" ? "required" : "storage_bad_bin";
		else if (!host) errors.parent_bin = "storage_unknown_unit";
		else if (!hasBins(host.kind)) errors.parent_bin = "storage_parent_no_bins";
		else if (b.level !== null && b.level > host.levels) errors.parent_bin = "storage_bad_level";
		else if (b.position !== null && b.position > host.positions) errors.parent_bin = "storage_bad_position";
		else {
			const idx = indexUnits(all);
			// The host's own chain must not go through this unit, and the whole stack stays MAX_DEPTH deep at most.
			const hostChain = chainOf(idx, host.id);
			const below = id ? subtreeHeight(idx, id) : 1;
			if (id && (host.id === id || hostChain.some((s) => s.unit.id === id))) errors.parent_bin = "storage_cycle";
			else if (hostChain.length + 1 + below > MAX_DEPTH) errors.parent_bin = "storage_too_deep";
			else parent = { unitId: host.id, level: b.level, position: b.level === null ? null : b.position };
		}
	} else {
		if (d.width < 1) errors.width = "not_positive";
		if (d.depth < 1) errors.depth = "not_positive";
		const max = planMaxSquares(plan.squareCm);
		const limit = plan.area ?? { width: max, depth: max };
		const outside = plan.area ? "storage_outside_area" : "storage_outside_plan";
		if (d.col + d.width > limit.width) errors.col = outside;
		if (d.row + d.depth > limit.depth) errors.row = outside;
		const drawn = others.filter(onPlan);
		const otherRooms = drawn.filter((u) => u.kind === "room").flatMap(rectsOf);
		if (!errors.width && !errors.depth) {
			// Two storage units cannot stand on the same squares, nor two rooms; rooms, doors and landmarks contain units.
			if (holdsParts(d.kind) && drawn.some((u) => holdsParts(u.kind) && overlaps(u, d))) errors.col = "storage_overlap";
			if (d.kind === "room" && otherRooms.some((r) => overlaps(r, d))) errors.col = "storage_room_overlap";
		}
		// A room's other rectangles: on the plan, joined to the rest of the room, clear of the other rooms (D211).
		const apart = errors.width || errors.depth ? new Set<number>() : new Set(detachedAreas(d, ownAreas));
		ownAreas.forEach((a, i) => {
			const n = i + 2;
			const col = areaField(n, "col");
			if (a.width < 1) errors[areaField(n, "width")] = "not_positive";
			if (a.depth < 1) errors[areaField(n, "depth")] = "not_positive";
			if (a.width < 1 || a.depth < 1) return;
			if (a.col + a.width > limit.width) errors[col] = outside;
			else if (a.row + a.depth > limit.depth) errors[areaField(n, "row")] = outside;
			else if (otherRooms.some((r) => overlaps(r, a))) errors[col] = "storage_room_overlap";
			else if (apart.has(i)) errors[col] = "storage_area_apart";
		});
	}

	if (id) {
		const children = others
			.filter((u) => u.parentUnitId === id)
			.map((u) => ({ level: u.parentLevel, position: u.parentPosition }));
		const inside = [...used, ...children];
		if (inside.length && !holdsParts(d.kind)) errors.kind = "storage_unit_in_use";
		else if (inside.length && !bins && inside.some((u) => u.level !== null)) errors.kind = "storage_bins_in_use";
		else if (children.length && !bins) errors.kind = "storage_bins_in_use";
		else {
			if (!errors.levels && inside.some((u) => u.level !== null && u.level > levels))
				errors.levels = "storage_bin_in_use";
			if (!errors.positions && inside.some((u) => u.position !== null && u.position > positions))
				errors.positions = "storage_bin_in_use";
		}
	}
	if (Object.keys(errors).length) return { ok: false, errors, vars: plan.area ?? undefined };
	return {
		ok: true,
		areas: ownAreas.map(rectOf),
		values: {
			code,
			name: d.name,
			kind: d.kind,
			col: d.col,
			row: d.row,
			width: Math.max(1, d.width),
			depth: Math.max(1, d.depth),
			front: d.front,
			levels,
			positions,
			notes: d.notes,
			parentUnitId: parent?.unitId ?? null,
			parentLevel: parent?.level ?? null,
			parentPosition: parent?.position ?? null,
		},
	};
}

export function createUnitStatement(db: Db, v: UnitValues, user: string, now: string) {
	return db
		.insert(storageUnits)
		.values({ ...v, createdAt: now, updatedAt: now, createdBy: user, updatedBy: user })
		.returning({ id: storageUnits.id });
}

export function updateUnitStatement(db: Db, id: number, v: UnitValues, user: string, now: string) {
	return db
		.update(storageUnits)
		.set({ ...v, updatedAt: now, updatedBy: user })
		.where(eq(storageUnits.id, id));
}

/** Only an empty unit can go: parts and the units standing in it stay until someone moves them. */
export async function unitInUse(db: Db, id: number): Promise<boolean> {
	const [located, nested] = await Promise.all([
		db.select({ id: partLocations.id }).from(partLocations).where(eq(partLocations.unitId, id)).limit(1),
		db.select({ id: storageUnits.id }).from(storageUnits).where(eq(storageUnits.parentUnitId, id)).limit(1),
	]);
	return located.length > 0 || nested.length > 0;
}

/** Deletes a unit, a room's areas first (an undo then puts the room back before them). */
export function deleteUnitStatements(db: Db, id: number): Statement[] {
	return [db.delete(roomAreas).where(eq(roomAreas.roomId, id)), db.delete(storageUnits).where(eq(storageUnits.id, id))];
}

/**
 * Brings a room's areas from `existing` (in id order) to `next`, matched by their order: an area that moved is updated,
 * extra ones are added or deleted, unchanged ones are left alone (no noise in the history). A room created in the same
 * batch is targeted by its code, as an import targets a unit created by an earlier row.
 */
export function roomAreaStatements(
	db: Db,
	room: { id: number } | { code: string },
	existing: Pick<RoomArea, "id" | "col" | "row" | "width" | "depth">[],
	next: Rect[],
	user: string,
	now: string,
): Statement[] {
	const out: Statement[] = [];
	next.forEach((a, i) => {
		const old = existing[i];
		if (!old) {
			const roomId = "id" in room ? room.id : sql<number>`(SELECT id FROM storage_units WHERE code = ${room.code})`;
			out.push(
				db
					.insert(roomAreas)
					.values({ roomId, ...rectOf(a), createdAt: now, updatedAt: now, createdBy: user, updatedBy: user }),
			);
		} else if (SIDES.some((side) => old[side] !== a[side]))
			out.push(
				db
					.update(roomAreas)
					.set({ ...rectOf(a), updatedAt: now, updatedBy: user })
					.where(eq(roomAreas.id, old.id)),
			);
	});
	for (const old of existing.slice(next.length)) out.push(db.delete(roomAreas).where(eq(roomAreas.id, old.id)));
	return out;
}

/** A room's areas as stored, in id order. */
export function areasOf(db: Db, roomId: number) {
	return db.select().from(roomAreas).where(eq(roomAreas.roomId, roomId)).orderBy(asc(roomAreas.id));
}

// ---------------------------------------------------------------------------
// Reads

/** Every unit (rooms with their areas), by code, with the number of parts kept in it. */
export async function listUnits(db: Db): Promise<{ unit: ShapedUnit; partCount: number }[]> {
	const [rows, areas] = await Promise.all([
		db
			.select({
				unit: storageUnits,
				partCount: sql<number>`(SELECT count(*) FROM part_locations pl WHERE pl.unit_id = storage_units.id)`,
			})
			.from(storageUnits)
			.orderBy(asc(storageUnits.code)),
		db.select().from(roomAreas).orderBy(asc(roomAreas.id)),
	]);
	const units = withAreas(
		rows.map((r) => r.unit),
		areas,
	);
	return rows.map((r, i) => ({ unit: units[i] as ShapedUnit, partCount: r.partCount }));
}

/** Whether a plan is drawn: at least one unit that holds parts (pages show locations only then). */
export async function hasPlan(db: Db): Promise<boolean> {
	const rows = await db
		.select({ id: storageUnits.id })
		.from(storageUnits)
		.where(inArray(storageUnits.kind, ["rack", "cabinet", "floor"]))
		.limit(1);
	return rows.length > 0;
}

export async function getUnit(db: Db, id: number): Promise<ShapedUnit | undefined> {
	const [rows, areas] = await Promise.all([
		db.select().from(storageUnits).where(eq(storageUnits.id, id)).limit(1),
		areasOf(db, id),
	]);
	return withAreas(rows, areas)[0];
}

/** The plan's size in squares: the fixed area when there is one, else the minimum or more when units stand further out. */
export function planSize(
	units: (Rect & Partial<Pick<StorageUnit, "parentUnitId">> & { areas?: Rect[] })[],
	plan: PlanSettings,
): {
	width: number;
	depth: number;
} {
	if (plan.area) return { ...plan.area };
	const drawn = units.filter((u) => (u.parentUnitId ?? null) === null).flatMap(rectsOf);
	return {
		width: Math.max(Math.ceil(PLAN_MIN_CM.width / plan.squareCm), ...drawn.map((u) => u.col + u.width + 1)),
		depth: Math.max(Math.ceil(PLAN_MIN_CM.depth / plan.squareCm), ...drawn.map((u) => u.row + u.depth + 1)),
	};
}

// ---------------------------------------------------------------------------
// The plan's settings (D209): the size of a square, and a fixed main area

const wholeSetting = (v: string | undefined, min: number, max: number): number | null =>
	v !== undefined && /^\d+$/.test(v) && Number(v) >= min && Number(v) <= max ? Number(v) : null;

/** The settings in force; a missing or unusable row is the default, and an area needs both its sides. */
export async function loadPlanSettings(db: Db): Promise<PlanSettings> {
	const rows = await db
		.select({ key: settings.key, value: settings.value })
		.from(settings)
		.where(inArray(settings.key, Object.values(PLAN_SETTINGS)));
	const byKey = new Map(rows.map((r) => [r.key, r.value]));
	const squareCm = wholeSetting(byKey.get(PLAN_SETTINGS.squareCm), SQUARE_CM.min, SQUARE_CM.max) ?? SQUARE_CM.default;
	const width = wholeSetting(byKey.get(PLAN_SETTINGS.width), 1, planMaxSquares(squareCm));
	const depth = wholeSetting(byKey.get(PLAN_SETTINGS.depth), 1, planMaxSquares(squareCm));
	return {
		squareCm,
		area: width !== null && depth !== null ? { width, depth } : null,
	};
}

/** The form: the square in centimetres, the main area in metres (both sides or none). */
export const planSettingsInput = z.object({
	square_cm: field.int(),
	width_m: field.metres(),
	depth_m: field.metres(),
});
export type PlanSettingsInput = z.output<typeof planSettingsInput>;

/** What saving the settings does: the new settings, and by how much the drawn units' squares are multiplied. */
export type PlanChange = { plan: PlanSettings; rescale: { from: number; to: number } | null };
export type CheckedPlanSettings =
	| { ok: true; change: PlanChange }
	| { ok: false; errors: FieldErrors; vars: Record<string, number> };

/** Squares of the plan units need, from the top left corner. */
const extent = (units: Rect[]) => ({
	width: Math.max(0, ...units.map((u) => u.col + u.width)),
	depth: Math.max(0, ...units.map((u) => u.row + u.depth)),
});

/**
 * The drawn units after the squares change from `from` to `to` cm: each value multiplied by from/to, so that a unit keeps
 * its real size. An error key when one would not be a whole number of squares, or would end up beyond the plan's limit.
 */
function rescaled(units: Rect[], from: number, to: number): { rects: Rect[] } | { error: string } {
	const rects: Rect[] = [];
	const max = planMaxSquares(to);
	for (const u of units) {
		const values = [u.col, u.row, u.width, u.depth];
		if (values.some((n) => (n * from) % to !== 0)) return { error: "plan_square_fraction" };
		const [col, row, width, depth] = values.map((n) => (n * from) / to) as [number, number, number, number];
		if (width < 1 || depth < 1) return { error: "plan_square_fraction" };
		if (col + width > max || row + depth > max) return { error: "plan_square_outside" };
		rects.push({ col, row, width, depth });
	}
	return { rects };
}

/**
 * Checks the settings form against the units drawn on the plan (not those standing in a bin). Changing the square
 * rescales them; the main area is typed in metres and must be a whole number of the new squares, and big enough for
 * the units (after they are rescaled).
 */
export function checkPlanSettings(
	units: ShapedUnit[],
	current: PlanSettings,
	input: PlanSettingsInput,
): CheckedPlanSettings {
	const errors: FieldErrors = {};
	const squareCm = input.square_cm;
	if (squareCm < SQUARE_CM.min || squareCm > SQUARE_CM.max) errors.square_cm = "plan_square_range";

	let area: PlanSettings["area"] = null;
	const sides = [
		["width_m", input.width_m],
		["depth_m", input.depth_m],
	] as const;
	if (sides.some(([, cm]) => cm !== null)) {
		const squares: number[] = [];
		for (const [name, cm] of sides) {
			if (cm === null) errors[name] = "required";
			else if (!errors.square_cm) {
				if (cm % squareCm !== 0) errors[name] = "plan_area_whole";
				else if (cm / squareCm > planMaxSquares(squareCm)) errors[name] = "plan_area_range";
				else squares.push(cm / squareCm);
			}
		}
		if (squares.length === 2) area = { width: squares[0] as number, depth: squares[1] as number };
	}

	// Rooms' areas are rescaled with them, and must fit too (D211).
	const drawn = units.filter(onPlan).flatMap(rectsOf);
	let rects: Rect[] = drawn;
	const rescale = !errors.square_cm && squareCm !== current.squareCm ? { from: current.squareCm, to: squareCm } : null;
	if (rescale) {
		const r = rescaled(drawn, rescale.from, rescale.to);
		if ("error" in r) errors.square_cm = r.error;
		else rects = r.rects;
	}

	const need = extent(rects);
	if (area && !errors.width_m && area.width < need.width) errors.width_m = "plan_area_small";
	if (area && !errors.depth_m && area.depth < need.depth) errors.depth_m = "plan_area_small";
	if (Object.keys(errors).length) return { ok: false, errors, vars: { width: need.width, depth: need.depth } };
	return { ok: true, change: { plan: { squareCm, area }, rescale } };
}

/** Whether saving changes nothing (no row to write). */
export const planUnchanged = (current: PlanSettings, next: PlanSettings) =>
	current.squareCm === next.squareCm &&
	current.area?.width === next.area?.width &&
	current.area?.depth === next.area?.depth;

const upsertSetting = (db: Db, key: string, value: string, user: string, now: string) =>
	db
		.insert(settings)
		.values({ key, value, createdAt: now, createdBy: user, updatedAt: now, updatedBy: user })
		.onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now, updatedBy: user } });

/**
 * The statements that save the settings, in one change set: the rows of `settings` (a removed area deletes its rows),
 * and one UPDATE that multiplies the drawn units' squares (exact: `checkPlanSettings` saw that every value divides).
 */
export function planSettingsStatements(db: Db, current: PlanSettings, change: PlanChange, user: string, now: string) {
	const { plan, rescale } = change;
	const out: Statement[] = [];
	if (plan.squareCm !== current.squareCm)
		out.push(upsertSetting(db, PLAN_SETTINGS.squareCm, String(plan.squareCm), user, now));
	if (plan.area) {
		if (plan.area.width !== current.area?.width)
			out.push(upsertSetting(db, PLAN_SETTINGS.width, String(plan.area.width), user, now));
		if (plan.area.depth !== current.area?.depth)
			out.push(upsertSetting(db, PLAN_SETTINGS.depth, String(plan.area.depth), user, now));
	} else if (current.area) {
		out.push(db.delete(settings).where(inArray(settings.key, [PLAN_SETTINGS.width, PLAN_SETTINGS.depth])));
	}
	if (rescale) {
		const by = (col: AnyColumn) => sql`${col} * ${rescale.from} / ${rescale.to}`;
		out.push(
			db
				.update(storageUnits)
				.set({
					col: by(storageUnits.col),
					row: by(storageUnits.row),
					width: by(storageUnits.width),
					depth: by(storageUnits.depth),
					updatedAt: now,
					updatedBy: user,
				})
				.where(isNull(storageUnits.parentUnitId)),
		);
		out.push(
			db
				.update(roomAreas)
				.set({
					col: by(roomAreas.col),
					row: by(roomAreas.row),
					width: by(roomAreas.width),
					depth: by(roomAreas.depth),
					updatedAt: now,
					updatedBy: user,
				})
				// Only rooms' areas: an undo can leave areas on a unit that is no longer a room (it changed kind in an
				// earlier change set); those are never drawn nor checked, and its next save deletes them.
				.where(
					inArray(
						roomAreas.roomId,
						db.select({ id: storageUnits.id }).from(storageUnits).where(eq(storageUnits.kind, "room")),
					),
				),
		);
	}
	return out;
}

// ---------------------------------------------------------------------------
// Bins, chains of bins and locations

export type Bin = { code: string; level: number | null; position: number | null };

/** "A-2-3", "A-2" (anywhere on level 2) or "A" (anywhere in the unit). */
export function binCode(code: string, level: number | null, position: number | null): string {
	if (level === null) return code;
	return position === null ? `${code}-${level}` : `${code}-${level}-${position}`;
}

/** Reads "a-2-3", "A 2 3", "A-2" or "A"; null when it is not shaped like a bin code. */
export function parseBin(text: string): Bin | null {
	const m = /^([A-Za-z0-9]{1,6})(?:[-\s.]+(\d{1,3})(?:[-\s.]+(\d{1,3}))?)?$/.exec(text.trim());
	if (!m?.[1]) return null;
	return {
		code: m[1].toUpperCase(),
		level: m[2] === undefined ? null : Number(m[2]),
		position: m[3] === undefined ? null : Number(m[3]),
	};
}

export type UnitRef = Pick<StorageUnit, "id" | "code" | "name" | "kind">;
export type BinRef = { unit: UnitRef; level: number | null; position: number | null };
/**
 * Where a part is kept: its own bin, the bins it stands in from the plan inwards (`via`, empty for a unit on the plan),
 * and the room around it.
 */
export type Location = BinRef & { note: string; via: BinRef[]; room: string | null; roomId: number | null };

const ref = (u: StorageUnit): UnitRef => ({ id: u.id, code: u.code, name: u.name, kind: u.kind });
export const binRefCode = (b: BinRef) => binCode(b.unit.code, b.level, b.position);
/** The bin itself: what the label on the drawer says. */
export const locationCode = (l: BinRef) => binRefCode(l);
/** The whole way to it: "A-3-3 › S1-2-1". */
export const fullCode = (l: Location) => [...l.via, l].map(binRefCode).join(" › ");
/** The bin on the plan: the unit drawn there, and its bin that holds everything else. */
export const rootBin = (l: Location): BinRef => l.via[0] ?? l;

export type UnitIndex = Map<number, ShapedUnit>;
export const indexUnits = (units: ShapedUnit[]): UnitIndex => new Map(units.map((u) => [u.id, u]));

/** The bins a unit stands in, from the plan inwards (empty for a unit on the plan). */
export function chainOf(idx: UnitIndex, unitId: number): BinRef[] {
	const chain: BinRef[] = [];
	let u = idx.get(unitId);
	for (let i = 0; u && u.parentUnitId !== null && i < MAX_DEPTH * 2; i++) {
		const parent = idx.get(u.parentUnitId);
		if (!parent) break;
		chain.unshift({ unit: ref(parent), level: u.parentLevel, position: u.parentPosition });
		u = parent;
	}
	return chain;
}

/** How many units high the stack starting at this one is (1 when nothing stands in it). */
function subtreeHeight(idx: UnitIndex, unitId: number, depth = 0): number {
	if (depth > MAX_DEPTH * 2) return depth;
	const kids = [...idx.values()].filter((u) => u.parentUnitId === unitId);
	return 1 + Math.max(0, ...kids.map((k) => subtreeHeight(idx, k.id, depth + 1)));
}

/** This unit and every unit standing in it, at any depth. */
export function withNested(idx: UnitIndex, unitId: number): Set<number> {
	const out = new Set([unitId]);
	for (let grew = true; grew; ) {
		grew = false;
		for (const u of idx.values())
			if (u.parentUnitId !== null && out.has(u.parentUnitId) && !out.has(u.id)) {
				out.add(u.id);
				grew = true;
			}
	}
	return out;
}

/** The units standing in a unit's bins. */
export const nestedIn = (idx: UnitIndex, unitId: number) => [...idx.values()].filter((u) => u.parentUnitId === unitId);

/** The room a unit is in: the one around the centre of the unit drawn on the plan, in any of its rectangles (D211). */
export function roomOf(idx: UnitIndex, unitId: number): ShapedUnit | undefined {
	const chain = chainOf(idx, unitId);
	const drawn = idx.get(chain[0]?.unit.id ?? unitId);
	if (!drawn || drawn.kind === "room") return undefined;
	const cx = drawn.col + drawn.width / 2;
	const cy = drawn.row + drawn.depth / 2;
	return [...idx.values()].find((r) => r.kind === "room" && onPlan(r) && insideRects(rectsOf(r), cx, cy));
}

/** The units in a room: those drawn inside it, and the units standing in them. */
export function unitsInRoom(idx: UnitIndex, roomId: number): Set<number> {
	const out = new Set<number>();
	for (const u of idx.values()) if (holdsParts(u.kind) && roomOf(idx, u.id)?.id === roomId) out.add(u.id);
	return out;
}

/** A bin of a unit, read with the chain that holds it. */
export function locate(
	idx: UnitIndex,
	unit: StorageUnit,
	level: number | null,
	position: number | null,
	note = "",
): Location {
	const room = roomOf(idx, unit.id);
	return {
		unit: ref(unit),
		level,
		position,
		note,
		via: chainOf(idx, unit.id),
		room: room ? room.name || room.code : null,
		roomId: room?.id ?? null,
	};
}

/** Sorts in walking order: by the bin on the plan, then inwards; parts without a location last. */
export function locationSortKey(l: Location | undefined): string {
	if (!l) return "￿";
	const pad = (n: number | null) => String(n ?? 0).padStart(3, "0");
	return [...l.via, l].map((b) => `${b.unit.code}\u0000${pad(b.level)}${pad(b.position)}`).join("\u0001");
}

/** The home location of these parts (all parts when no ids are given). */
export async function locationsOf(db: Db, partIds?: number[]): Promise<Map<number, Location>> {
	if (partIds && partIds.length === 0) return new Map();
	const [rows, units] = await Promise.all([
		db
			.select()
			.from(partLocations)
			.where(partIds && partIds.length <= 90 ? inArray(partLocations.partId, partIds) : undefined),
		loadUnits(db),
	]);
	const idx = indexUnits(units);
	const out = new Map<number, Location>();
	for (const r of rows) {
		const unit = idx.get(r.unitId);
		if (unit) out.set(r.partId, locate(idx, unit, r.level, r.position, r.note));
	}
	return out;
}

export async function locationOf(db: Db, partId: number): Promise<Location | undefined> {
	return (await locationsOf(db, [partId])).get(partId);
}

export type StoredPart = {
	partId: number;
	ref: string;
	name: string;
	kind: PartKind;
	unit: string;
	level: number | null;
	position: number | null;
	note: string;
	onHandMilli: number;
};

/** What a unit holds, in bin order. */
export async function unitContents(db: Db, unitId: number): Promise<StoredPart[]> {
	return db
		.select({
			partId: parts.id,
			ref: parts.ref,
			name: parts.name,
			kind: parts.kind,
			unit: parts.unit,
			level: partLocations.level,
			position: partLocations.position,
			note: partLocations.note,
			onHandMilli: onHandSql,
		})
		.from(partLocations)
		.innerJoin(parts, eq(partLocations.partId, parts.id))
		.where(eq(partLocations.unitId, unitId))
		.orderBy(asc(partLocations.level), asc(partLocations.position), asc(parts.ref));
}

/** The parts kept in these units, with the unit they are in. */
export async function partsInUnits(db: Db, unitIds: number[]): Promise<(StoredPart & { unitId: number })[]> {
	if (unitIds.length === 0) return [];
	return db
		.select({
			partId: parts.id,
			ref: parts.ref,
			name: parts.name,
			kind: parts.kind,
			unit: parts.unit,
			level: partLocations.level,
			position: partLocations.position,
			note: partLocations.note,
			onHandMilli: onHandSql,
			unitId: partLocations.unitId,
		})
		.from(partLocations)
		.innerJoin(parts, eq(partLocations.partId, parts.id))
		.where(inArray(partLocations.unitId, unitIds));
}

/** Stocked, active parts that have no location yet: what is left to put on the plan. */
export async function unlocatedParts(db: Db) {
	return db
		.select({ id: parts.id, ref: parts.ref, name: parts.name, kind: parts.kind })
		.from(parts)
		.where(
			and(
				eq(parts.archived, false),
				inArray(parts.kind, ["buy", "make"]),
				sql`NOT EXISTS (SELECT 1 FROM part_locations pl WHERE pl.part_id = ${parts.id})`,
			),
		)
		.orderBy(asc(parts.ref));
}

export const locationInput = z.object({
	bin: field.text(40),
	note: field.text(200),
});
export type LocationInput = z.output<typeof locationInput>;

export type ResolvedBin = { unit: StorageUnit; level: number | null; position: number | null };

export type BinCheck = { ok: true; bin: ResolvedBin | null } | { ok: false; error: string };

/** A typed bin checked against the plan, or the error key that says why not (empty = no location). */
export async function resolveBin(db: Db, text: string): Promise<BinCheck> {
	const code = parseBin(text)?.code;
	const units = code ? await db.select().from(storageUnits).where(eq(storageUnits.code, code)).limit(1) : [];
	return resolveBinIn(units, text);
}

/** `resolveBin` against units already loaded (an import checks every row against one read of the plan). */
export function resolveBinIn(units: readonly StorageUnit[], text: string): BinCheck {
	if (text.trim() === "") return { ok: true, bin: null };
	const b = parseBin(text);
	if (!b) return { ok: false, error: "storage_bad_bin" };
	const unit = units.find((u) => u.code === b.code);
	if (!unit) return { ok: false, error: "storage_unknown_unit" };
	if (!holdsParts(unit.kind)) return { ok: false, error: "storage_landmark" };
	if (b.level !== null && !hasBins(unit.kind)) return { ok: false, error: "storage_no_bins" };
	if (b.level !== null && (b.level < 1 || b.level > unit.levels)) return { ok: false, error: "storage_bad_level" };
	if (b.position !== null && (b.position < 1 || b.position > unit.positions))
		return { ok: false, error: "storage_bad_position" };
	return { ok: true, bin: { unit, level: b.level, position: b.position } };
}

/** Sets, moves or clears (bin null) a part's home location: at most one statement. */
export async function setLocationStatements(
	db: Db,
	partId: number,
	bin: ResolvedBin | null,
	note: string,
	user: string,
	now: string,
): Promise<Statement[]> {
	const existing = (await db.select().from(partLocations).where(eq(partLocations.partId, partId)).limit(1))[0];
	return locationStatements(db, { partId }, existing, bin, note, user, now);
}

/**
 * `setLocationStatements` with the part's current location already read: a part created in the same batch is
 * targeted by its reference (an import), as its offers are.
 */
export function locationStatements(
	db: Db,
	target: { partId: number } | { partRef: string },
	existing: Pick<PartLocation, "id"> | undefined,
	bin: ResolvedBin | null,
	note: string,
	user: string,
	now: string,
): Statement[] {
	if (!bin) return existing ? [db.delete(partLocations).where(eq(partLocations.id, existing.id))] : [];
	const values = { unitId: bin.unit.id, level: bin.level, position: bin.level === null ? null : bin.position, note };
	if (!existing) {
		const partId =
			"partId" in target ? target.partId : sql<number>`(SELECT id FROM parts WHERE ref = ${target.partRef})`;
		return [
			db
				.insert(partLocations)
				.values({ partId, ...values, createdAt: now, updatedAt: now, createdBy: user, updatedBy: user }),
		];
	}
	return [
		db
			.update(partLocations)
			.set({ ...values, updatedAt: now, updatedBy: user })
			.where(eq(partLocations.id, existing.id)),
	];
}

/** A part by reference, ignoring case (forms type references). */
export async function partByRef(db: Db, ref: string) {
	const rows = await db
		.select({ id: parts.id, ref: parts.ref, name: parts.name, kind: parts.kind })
		.from(parts)
		.where(sql`lower(${parts.ref}) = lower(${ref.trim()})`)
		.limit(1);
	return rows[0];
}

/** A bin of an existing unit holding parts ("A-2-3", "A-2", "C"), read with its chain; undefined otherwise. */
export async function findBin(db: Db, text: string): Promise<Location | undefined> {
	const b = parseBin(text);
	if (!b) return undefined;
	const units = await loadUnits(db);
	const unit = units.find((u) => u.code === b.code);
	if (!unit || !holdsParts(unit.kind)) return undefined;
	if (
		(b.level !== null && (!hasBins(unit.kind) || b.level > unit.levels)) ||
		(b.position !== null && b.position > unit.positions)
	)
		return undefined;
	return locate(indexUnits(units), unit, b.level, b.position);
}

export type PlanSearch =
	| { kind: "part"; part: { id: number; ref: string; name: string }; location: Location | undefined }
	| { kind: "bin"; location: Location }
	| { kind: "none" };

/**
 * What the plan's search box points at: a part by exact reference, else a bin of an existing unit ("A-2-3", "C"), else
 * the first part whose reference or name contains the text.
 */
export async function findOnPlan(db: Db, q: string): Promise<PlanSearch> {
	const exact = await partByRef(db, q);
	if (!exact) {
		const bin = await findBin(db, q);
		if (bin) return { kind: "bin", location: bin };
	}
	const part = exact ?? (await listParts(db, { q }))[0];
	if (!part) return { kind: "none" };
	return {
		kind: "part",
		part: { id: part.id, ref: part.ref, name: part.name },
		location: await locationOf(db, part.id),
	};
}

/** Every bin code of these units, for a datalist: "A", "A-1-1"… (a floor area only has its code). */
export function binCodes(units: Pick<StorageUnit, "code" | "kind" | "levels" | "positions">[], max = 800): string[] {
	const out: string[] = [];
	for (const u of units) {
		if (!holdsParts(u.kind)) continue;
		out.push(u.code);
		if (!hasBins(u.kind)) continue;
		for (let l = 1; l <= u.levels; l++) for (let p = 1; p <= u.positions; p++) out.push(`${u.code}-${l}-${p}`);
	}
	return out.slice(0, max);
}

/** Units sorted for lists: on the plan by code, each followed by the units standing in it. */
export function unitTree<U extends StorageUnit>(units: U[]): { unit: U; depth: number }[] {
	const idx = new Map(units.map((u) => [u.id, u]));
	const out: { unit: U; depth: number }[] = [];
	const nested = (id: number) => [...idx.values()].filter((u) => u.parentUnitId === id);
	const walk = (u: U, depth: number) => {
		out.push({ unit: u, depth });
		if (depth < MAX_DEPTH * 2)
			for (const k of nested(u.id).sort((a, b) => (a.code < b.code ? -1 : 1))) walk(k, depth + 1);
	};
	for (const u of units.filter(onPlan).sort((a, b) => (a.code < b.code ? -1 : 1))) walk(u, 0);
	return out;
}

// ---------------------------------------------------------------------------
// Plan geometry (pure): where a position sits on the plan, for the drawings.

export type PlanUnit = Pick<StorageUnit, "col" | "row" | "width" | "depth" | "front" | "positions" | "kind">;

/** The part of the unit's rectangle that holds position `p` (in squares), counted from the left facing the front. */
export function positionRect(u: PlanUnit, p: number): { x: number; y: number; w: number; h: number } {
	const n = hasBins(u.kind) ? u.positions : 1;
	const along = (u.front === "south" || u.front === "north" ? u.width : u.depth) / n;
	const k = Math.min(Math.max(p, 1), n);
	switch (u.front as StorageFront) {
		case "south": // standing south of it, facing north: the left is west
			return { x: u.col + (k - 1) * along, y: u.row, w: along, h: u.depth };
		case "north": // facing south: the left is east
			return { x: u.col + u.width - k * along, y: u.row, w: along, h: u.depth };
		case "west": // facing east: the left is north
			return { x: u.col, y: u.row + (k - 1) * along, w: u.width, h: along };
		default: // east, facing west: the left is south
			return { x: u.col, y: u.row + u.depth - k * along, w: u.width, h: along };
	}
}

/** The front edge of a unit, as a segment in squares. */
export function frontEdge(u: PlanUnit): [number, number, number, number] {
	const { col: x, row: y, width: w, depth: h } = u;
	if (u.front === "north") return [x, y, x + w, y];
	if (u.front === "west") return [x, y, x, y + h];
	if (u.front === "east") return [x + w, y, x + w, y + h];
	return [x, y + h, x + w, y + h];
}

/** Kinds offered in the editor, in this order. */
export const KIND_ORDER: readonly StorageKind[] = ["rack", "cabinet", "floor", "room", "door", "landmark"];
