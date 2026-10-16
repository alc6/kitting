// Storage locations (D194–D200): the workshop plan, drawn as rooms, doors, landmarks and storage units on a grid of
// half-metre squares, and the home location of each part. Bins are not rows: a unit of L levels × P positions has the
// bins "<code>-<level>-<position>", level counted from the floor and position from the left when facing the unit's
// front. A unit can stand in a bin of another one (a drawer cabinet on a shelf): a location is then read through the
// chain of bins that holds it. Stock is not counted per bin: a location tells people where to look and where to put
// away.
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
	type PartKind,
	type PartLocation,
	partLocations,
	parts,
	STORAGE_FRONTS,
	STORAGE_KINDS,
	type StorageFront,
	type StorageKind,
	type StorageUnit,
	storageUnits,
} from "../db/schema";
import type { Statement } from "../lib/db";
import { type FieldErrors, field } from "../lib/validation";
import type { Db } from "../types";
import { listParts, onHandSql } from "./parts";

/** More is a typing mistake, and the front view would not fit a tablet. */
export const MAX_LEVELS = 20;
export const MAX_POSITIONS = 30;
/** The plan is at least this many squares, and grows with the units, up to PLAN_MAX each way. */
export const PLAN_MIN = { width: 24, depth: 14 } as const;
export const PLAN_MAX = 200;
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

export function unitToForm(u: StorageUnit, units: Map<number, StorageUnit>): Record<string, string> {
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
	};
}

type Rect = { col: number; row: number; width: number; depth: number };
const overlaps = (a: Rect, b: Rect) =>
	a.col < b.col + b.width && b.col < a.col + a.width && a.row < b.row + b.depth && b.row < a.row + a.depth;

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

export type CheckedUnit = { ok: true; values: UnitValues } | { ok: false; errors: FieldErrors };
/** The bins of a unit that hold parts (level and position as in `part_locations`). */
export type UsedBin = { level: number | null; position: number | null };

/**
 * Rules a form or an import must pass beyond field formats: sizes, the plan, the code, the bin a unit stands in, bins
 * still in use. Returns the values to write, or the field errors.
 */
export async function checkUnit(db: Db, d: StorageUnitInput, id?: number): Promise<CheckedUnit> {
	const [all, used] = await Promise.all([
		db.select().from(storageUnits),
		id
			? db
					.select({ level: partLocations.level, position: partLocations.position })
					.from(partLocations)
					.where(eq(partLocations.unitId, id))
			: Promise.resolve([]),
	]);
	return checkUnitIn(all, used, d, id);
}

/**
 * `checkUnit` against a plan in memory: `all` the units as they stand (an import passes the plan as the rows before
 * this one leave it), `used` the bins of unit `id` that hold parts.
 */
export function checkUnitIn(all: StorageUnit[], used: UsedBin[], d: StorageUnitInput, id?: number): CheckedUnit {
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
		if (d.col + d.width > PLAN_MAX) errors.col = "storage_outside_plan";
		if (d.row + d.depth > PLAN_MAX) errors.row = "storage_outside_plan";
		if (!errors.width && !errors.depth) {
			const drawn = others.filter(onPlan);
			// Two storage units cannot stand on the same squares, nor two rooms; rooms, doors and landmarks contain units.
			if (holdsParts(d.kind) && drawn.some((u) => holdsParts(u.kind) && overlaps(u, d))) errors.col = "storage_overlap";
			if (d.kind === "room" && drawn.some((u) => u.kind === "room" && overlaps(u, d)))
				errors.col = "storage_room_overlap";
		}
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
	if (Object.keys(errors).length) return { ok: false, errors };
	return {
		ok: true,
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

export function deleteUnitStatement(db: Db, id: number) {
	return db.delete(storageUnits).where(eq(storageUnits.id, id));
}

// ---------------------------------------------------------------------------
// Reads

export async function listUnits(db: Db) {
	return db
		.select({
			unit: storageUnits,
			partCount: sql<number>`(SELECT count(*) FROM part_locations pl WHERE pl.unit_id = storage_units.id)`,
		})
		.from(storageUnits)
		.orderBy(asc(storageUnits.code));
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

export async function getUnit(db: Db, id: number): Promise<StorageUnit | undefined> {
	const rows = await db.select().from(storageUnits).where(eq(storageUnits.id, id)).limit(1);
	return rows[0];
}

/** The plan's size in squares: the minimum, or more when units stand further out (one square of margin). */
export function planSize(units: (Rect & Partial<Pick<StorageUnit, "parentUnitId">>)[]): {
	width: number;
	depth: number;
} {
	const drawn = units.filter((u) => (u.parentUnitId ?? null) === null);
	return {
		width: Math.max(PLAN_MIN.width, ...drawn.map((u) => u.col + u.width + 1)),
		depth: Math.max(PLAN_MIN.depth, ...drawn.map((u) => u.row + u.depth + 1)),
	};
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

export type UnitIndex = Map<number, StorageUnit>;
export const indexUnits = (units: StorageUnit[]): UnitIndex => new Map(units.map((u) => [u.id, u]));

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

/** The room a unit is in: the one around the centre of the unit drawn on the plan. */
export function roomOf(idx: UnitIndex, unitId: number): StorageUnit | undefined {
	const chain = chainOf(idx, unitId);
	const drawn = idx.get(chain[0]?.unit.id ?? unitId);
	if (!drawn || drawn.kind === "room") return undefined;
	const cx = drawn.col + drawn.width / 2;
	const cy = drawn.row + drawn.depth / 2;
	return [...idx.values()].find(
		(r) => r.kind === "room" && onPlan(r) && cx > r.col && cx < r.col + r.width && cy > r.row && cy < r.row + r.depth,
	);
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
		db.select().from(storageUnits),
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
	const units = await db.select().from(storageUnits);
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
export function unitTree(units: StorageUnit[]): { unit: StorageUnit; depth: number }[] {
	const idx = indexUnits(units);
	const out: { unit: StorageUnit; depth: number }[] = [];
	const walk = (u: StorageUnit, depth: number) => {
		out.push({ unit: u, depth });
		if (depth < MAX_DEPTH * 2)
			for (const k of nestedIn(idx, u.id).sort((a, b) => (a.code < b.code ? -1 : 1))) walk(k, depth + 1);
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
