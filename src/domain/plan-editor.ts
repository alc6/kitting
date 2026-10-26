// The plan editor (D214): the whole workshop plan edited on one page and saved at once. The form posts the fields of
// every unit drawn on the plan (`u<id>_col`…) and of the units added on the page (`n<k>_kind`…); each unit that changed
// is checked against the plan as the whole edit leaves it, with the same rules as the unit form, and everything is
// saved in one change set.
import { asc } from "drizzle-orm";
import { partLocations, type RoomArea, roomAreas, STORAGE_KINDS, type StorageKind } from "../db/schema";
import type { Statement } from "../lib/db";
import { type FieldErrors, validate } from "../lib/validation";
import type { Db } from "../types";
import {
	checkUnitIn,
	createUnitStatement,
	indexUnits,
	loadPlanSettings,
	loadUnits,
	onPlan,
	outlineToForm,
	type PlanSettings,
	type Rect,
	readAreaFields,
	roomAreaStatements,
	type ShapedUnit,
	type StorageUnitInput,
	storageUnitInput,
	type UnitValues,
	type UsedBin,
	unitToForm,
	updateUnitStatement,
} from "./storage";

/** The fields of one unit on the editor; `kind` only counts for a new unit, `outline` only for a room. */
export const PLAN_ITEM_FIELDS = [
	"kind",
	"code",
	"name",
	"col",
	"row",
	"width",
	"depth",
	"front",
	"levels",
	"positions",
	"outline",
] as const;
export type PlanItemField = (typeof PLAN_ITEM_FIELDS)[number];

/** At most this many units added in one save. */
export const MAX_NEW_UNITS = 40;

/** One unit as the editor posts it: an existing one (`u<id>_`) or one added on the page (`n<k>_`). */
export type PlanItem = { prefix: string; id: number | null; fields: Partial<Record<PlanItemField, string>> };

export const itemPrefix = (id: number) => `u${id}_`;
export const newPrefix = (k: number) => `n${k}_`;

/** The kinds a new unit of the editor can be: anything drawn on the plan. */
export const PLAN_KINDS: readonly StorageKind[] = STORAGE_KINDS;

/**
 * The units a plan form posts: every unit drawn on the plan that has fields in the body (the others stay as they are),
 * then the new ones, `n1_` to `n<MAX_NEW_UNITS>_`, each with a kind.
 */
export function readPlanForm(body: Record<string, unknown>, units: ShapedUnit[]): PlanItem[] {
	const read = (prefix: string) => {
		const fields: Partial<Record<PlanItemField, string>> = {};
		for (const f of PLAN_ITEM_FIELDS) {
			const v = body[prefix + f];
			if (typeof v === "string") fields[f] = v;
		}
		return fields;
	};
	const items: PlanItem[] = [];
	for (const u of units) {
		if (!onPlan(u)) continue;
		const fields = read(itemPrefix(u.id));
		if (Object.keys(fields).length) items.push({ prefix: itemPrefix(u.id), id: u.id, fields });
	}
	for (let k = 1; k <= MAX_NEW_UNITS; k++) {
		const fields = read(newPrefix(k));
		if (fields.kind !== undefined) items.push({ prefix: newPrefix(k), id: null, fields });
	}
	return items;
}

/** A new unit's fields before the posted ones: 4 × 4 bins, facing south, at the top left corner. */
const NEW_UNIT: Record<string, string> = {
	code: "",
	name: "",
	placement: "plan",
	parent_bin: "",
	col: "0",
	row: "0",
	width: "1",
	depth: "1",
	front: "south",
	levels: "4",
	positions: "4",
	notes: "",
};

/** What a save of the editor writes: each unit that changed or was added, with a room's rectangles. */
export type PlanOp = { id: number | null; values: UnitValues; areas: Rect[]; storedAreas: RoomArea[] };
export type PlanEditCheck =
	| { ok: true; ops: PlanOp[] }
	| { ok: false; errors: FieldErrors; vars?: Record<string, number> };

const PLACE = ["code", "name", "col", "row", "width", "depth", "front", "levels", "positions"] as const;
const sameRects = (a: Rect[], b: Rect[]) =>
	a.length === b.length &&
	a.every((r, i) => {
		const o = b[i];
		return o !== undefined && r.col === o.col && r.row === o.row && r.width === o.width && r.depth === o.depth;
	});

/**
 * Checks an edit of the plan. Each unit that changed, and each new one, is checked by `checkUnitIn` against the plan
 * as the whole edit leaves it, so that two racks can trade places in one save; a code must also be free before the
 * save (the unique index would refuse a swap of codes inside the batch). Errors are keyed by the item's field names
 * (`u12_col`), a room's area errors on its outline.
 */
export function checkPlanEdit(
	all: ShapedUnit[],
	stored: RoomArea[],
	used: Map<number, UsedBin[]>,
	plan: PlanSettings,
	items: PlanItem[],
): PlanEditCheck {
	const idx = indexUnits(all);
	const errors: FieldErrors = {};
	let vars: Record<string, number> | undefined;
	const fail = (prefix: string, e: FieldErrors, outline: boolean) => {
		for (const [k, v] of Object.entries(e)) {
			const name = /^(areas|area\d+_\w+)$/.test(k) || (outline && /^(col|row|width|depth)$/.test(k)) ? "outline" : k;
			errors[prefix + name] ??= v;
		}
	};

	// 1. Every posted unit read as the unit form would read it: its current values, the posted fields over them.
	type Draft = {
		item: PlanItem;
		id: number;
		current?: ShapedUnit;
		d: StorageUnitInput;
		areas: Rect[];
		outline: boolean;
	};
	const drafts: Draft[] = [];
	let nextNewId = -1;
	for (const item of items) {
		const current = item.id === null ? undefined : idx.get(item.id);
		if (item.id !== null && !current) continue;
		const base = current ? unitToForm(current, idx) : { ...NEW_UNIT, kind: item.fields.kind ?? "" };
		const input: Record<string, string> = { ...base };
		for (const f of PLAN_ITEM_FIELDS) {
			const v = item.fields[f];
			// The kind of a unit is changed on its own form, where its bins and contents are checked.
			if (v !== undefined && f !== "outline" && !(f === "kind" && current)) input[f] = v;
		}
		input.placement = "plan";
		const outline = input.kind === "room" && (item.fields.outline ?? "").trim() !== "";
		let areas: Rect[] = current?.kind === "room" ? current.areas : [];
		if (outline) {
			const split = outlineToForm(item.fields.outline ?? "", plan);
			if (!split.ok) {
				fail(item.prefix, { outline: split.error }, true);
				continue;
			}
			Object.assign(input, split.values);
			const read = readAreaFields(split.values);
			areas = read.ok ? read.areas : [];
		}
		const v = validate(storageUnitInput, input);
		if (!v.ok) {
			fail(item.prefix, v.errors, outline);
			continue;
		}
		drafts.push({ item, id: current?.id ?? nextNewId--, current, d: v.data, areas, outline });
	}
	if (Object.keys(errors).length) return { ok: false, errors };

	// 2. The plan as the edit leaves it, unchanged units skipped.
	const changed = drafts.filter((x) => {
		const c = x.current;
		if (!c) return true;
		const now = unitToForm(c, idx);
		return PLACE.some((f) => String(x.d[f]) !== now[f]) || !sameRects(x.areas, c.kind === "room" ? c.areas : []);
	});
	const after = new Map<number, ShapedUnit>(all.map((u) => [u.id, u]));
	const stamp = { createdAt: "", updatedAt: "", createdBy: "", updatedBy: "" };
	for (const x of changed) {
		const fromInput = {
			code: x.d.code,
			name: x.d.name,
			kind: x.d.kind,
			col: x.d.col,
			row: x.d.row,
			width: x.d.width,
			depth: x.d.depth,
			front: x.d.front,
			levels: x.d.levels,
			positions: x.d.positions,
		};
		after.set(
			x.id,
			x.current
				? { ...x.current, ...fromInput, areas: x.areas }
				: {
						...fromInput,
						...stamp,
						id: x.id,
						notes: "",
						parentUnitId: null,
						parentLevel: null,
						parentPosition: null,
						areas: x.areas,
					},
		);
	}

	// 3. Each change checked against that plan; a code made up for a room or door is taken for the next ones.
	const ops: PlanOp[] = [];
	for (const x of changed) {
		const before = x.current?.code;
		if (x.d.code !== "" && x.d.code !== before && all.some((u) => u.id !== x.id && u.code === x.d.code)) {
			fail(x.item.prefix, { code: "storage_code_taken" }, false);
			continue;
		}
		const checked = checkUnitIn([...after.values()], used.get(x.id) ?? [], x.d, x.id, plan, x.areas);
		if (!checked.ok) {
			fail(x.item.prefix, checked.errors, x.outline);
			vars ??= checked.vars;
			continue;
		}
		const unit = after.get(x.id);
		if (unit) after.set(x.id, { ...unit, code: checked.values.code });
		ops.push({
			id: x.current?.id ?? null,
			values: checked.values,
			areas: checked.areas,
			storedAreas: x.current ? stored.filter((a) => a.roomId === x.current?.id) : [],
		});
	}
	if (Object.keys(errors).length) return { ok: false, errors, vars };
	return { ok: true, ops };
}

/** The statements of a checked edit: updates, then inserts (a new room's areas find it by its code). */
export function planEditStatements(db: Db, ops: PlanOp[], user: string, now: string): Statement[] {
	const order = [...ops.filter((o) => o.id !== null), ...ops.filter((o) => o.id === null)];
	return order.flatMap((op) => {
		const unit =
			op.id === null
				? createUnitStatement(db, op.values, user, now)
				: updateUnitStatement(db, op.id, op.values, user, now);
		const room = op.id === null ? { code: op.values.code } : { id: op.id };
		return [unit, ...roomAreaStatements(db, room, op.storedAreas, op.areas, user, now)];
	});
}

/** Reads and checks a posted plan form against the database: the units, their rooms' areas and the bins in use. */
export async function checkPlanForm(db: Db, body: Record<string, unknown>): Promise<PlanEditCheck> {
	const [all, stored, located, plan] = await Promise.all([
		loadUnits(db),
		db.select().from(roomAreas).orderBy(asc(roomAreas.id)),
		db
			.select({ unitId: partLocations.unitId, level: partLocations.level, position: partLocations.position })
			.from(partLocations),
		loadPlanSettings(db),
	]);
	const used = new Map<number, UsedBin[]>();
	for (const l of located) used.set(l.unitId, [...(used.get(l.unitId) ?? []), l]);
	return checkPlanEdit(all, stored, used, plan, readPlanForm(body, all));
}

/** The codes a save names in its summary: the first six, then an ellipsis. */
export function planEditCodes(ops: PlanOp[]): string {
	const codes = ops.map((o) => o.values.code);
	return codes.length > 6 ? `${codes.slice(0, 6).join(", ")}…` : codes.join(", ");
}
