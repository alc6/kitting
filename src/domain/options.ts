// Part options (D168–D173): loading a part's options, editing them, and what uses their values. Records name values
// by id in a text key (src/domain/option-keys.ts), so the integrity a foreign key would give is checked here: a value
// is deleted only while no record names it, and undo asks the same question (revert.ts).
import { and, asc, eq, inArray, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { builds, partOptions, partOptionValues, poLines, purchaseOrders, stockMoves } from "../db/schema";
import type { Statement } from "../lib/db";
import { chunks } from "../lib/sql";
import { type FieldErrors, field } from "../lib/validation";
import type { Db } from "../types";
import { idsOf, keyOf, type OptionDef, type OptionKey, RESERVED_NAME, sameName } from "./option-keys";

/** The options of parts (all, or those listed), each with its values in order. */
export async function loadOptions(db: Db, partIds?: number[]): Promise<Map<number, OptionDef[]>> {
	if (partIds && partIds.length === 0) return new Map();
	const rows = await db
		.select({
			partId: partOptions.partId,
			optionId: partOptions.id,
			optionName: partOptions.name,
			optionPosition: partOptions.position,
			valueId: partOptionValues.id,
			valueName: partOptionValues.name,
			valuePosition: partOptionValues.position,
			isDefault: partOptionValues.isDefault,
		})
		.from(partOptions)
		.leftJoin(partOptionValues, eq(partOptionValues.optionId, partOptions.id))
		.where(partIds ? inArray(partOptions.partId, partIds) : undefined)
		.orderBy(
			asc(partOptions.partId),
			asc(partOptions.position),
			asc(partOptions.id),
			asc(partOptionValues.position),
			asc(partOptionValues.id),
		);
	const byPart = new Map<number, OptionDef[]>();
	for (const r of rows) {
		const list = byPart.get(r.partId) ?? [];
		let option = list.find((o) => o.id === r.optionId);
		if (!option) {
			option = { id: r.optionId, name: r.optionName, values: [] };
			list.push(option);
			byPart.set(r.partId, list);
		}
		if (r.valueId !== null && r.valueName !== null)
			option.values.push({ id: r.valueId, name: r.valueName, isDefault: r.isDefault ?? false });
	}
	return byPart;
}

export async function optionsOf(db: Db, partId: number): Promise<OptionDef[]> {
	return (await loadOptions(db, [partId])).get(partId) ?? [];
}

// ---------------------------------------------------------------------------
// What uses a value (D169)

/** Every column holding a key, with the part whose values it names. */
export const OPTION_KEY_COLUMNS = [
	{ table: "stock_moves", column: "option_values", part: "part_id" },
	{ table: "build_lines", column: "option_values", part: "part_id" },
	{ table: "po_lines", column: "option_values", part: "part_id" },
	{ table: "builds", column: "option_values", part: "part_id" },
	{ table: "build_option_choices", column: "option_values", part: "part_id" },
	{ table: "assembly_lines", column: "fixed_option_values", part: "component_part_id" },
] as const;

/** SQL that is true when a key column names a value id. */
// The id is cast: D1 binds JavaScript numbers as reals, and ',' || 2.0 || ',' would never match ",2,".
export const keyNames = (column: SQL, valueId: number | SQL) =>
	sql`instr(',' || ${column} || ',', ',' || CAST(${valueId} AS INTEGER) || ',') > 0`;

/** The values of a part that records name (deleting them, or their option, is refused). */
export async function valuesInUse(db: Db, partId: number, valueIds: number[]): Promise<Set<number>> {
	const used = new Set<number>();
	if (valueIds.length === 0) return used;
	const wanted = new Set(valueIds);
	for (const k of OPTION_KEY_COLUMNS) {
		const rows = await db.all<{ key: string }>(
			sql`SELECT DISTINCT ${sql.identifier(k.column)} AS key FROM ${sql.identifier(k.table)}
				WHERE ${sql.identifier(k.part)} = ${partId} AND ${sql.identifier(k.column)} IS NOT NULL`,
		);
		for (const r of rows) for (const id of idsOf(r.key)) if (wanted.has(id)) used.add(id);
	}
	return used;
}

/** Of these value ids, those that no longer exist (an undo must not restore a record naming them). */
export async function missingValueIds(db: Db, valueIds: number[]): Promise<Set<number>> {
	const missing = new Set(valueIds);
	for (const part of chunks([...missing])) {
		const rows = await db
			.select({ id: partOptionValues.id })
			.from(partOptionValues)
			.where(inArray(partOptionValues.id, part));
		for (const r of rows) missing.delete(r.id);
	}
	return missing;
}

// ---------------------------------------------------------------------------
// Editing a part's options (D168, D173), from the Options page and part_options.csv

/** Option and value names: short, and free of the text form's syntax (`=`, `|`, `*`, D177). */
export const optionName = () => field.required(40).refine((v) => !RESERVED_NAME.test(v), "option_name_invalid");

/** Values typed one per line: trimmed, blank lines dropped. */
export const valueLines = (text: string) =>
	text
		.split(/\r?\n/)
		.map((s) => s.trim())
		.filter(Boolean);

export const newOptionInput = z.object({ name: optionName(), values: field.required(4000) });

/** The checks of a set of names: valid, and unique ignoring case. Returns an error key or null. */
export function namesError(names: string[]): string | null {
	for (const n of names) {
		if (n.length > 40) return "too_long";
		if (RESERVED_NAME.test(n)) return "option_name_invalid";
	}
	const seen = new Set<string>();
	for (const n of names) {
		const k = n.trim().toLowerCase();
		if (seen.has(k)) return "duplicate_name";
		seen.add(k);
	}
	return null;
}

/** Why a part cannot have options, or null: only stocked parts come in values (D168). */
export function optionsKindError(kind: string): string | null {
	return kind === "buy" || kind === "make" ? null : "options_kind";
}

/** Errors of a new option for a part: its name free on that part, at least one value, valid and unique values. */
export function newOptionErrors(existing: OptionDef[], name: string, values: string[]): FieldErrors {
	const errors: FieldErrors = {};
	if (existing.some((o) => sameName(o.name, name))) errors.name = "duplicate_name";
	if (values.length === 0) errors.values = "required";
	else {
		const e = namesError(values);
		if (e) errors.values = e;
	}
	return errors;
}

const optionIdOf = (partId: number, name: string) =>
	sql`(SELECT id FROM part_options WHERE part_id = ${partId} AND name = ${name})`;

/**
 * Adds an option to a part, its first value the default, in one batch. A part with stock or open records gets their
 * keys completed with that default (D173): each key with stock moves out and back in with the new value (adjust moves,
 * so the change set is not revertible), and the open PO lines and builds of the part name it too. A new value's id is
 * larger than every existing one (AUTOINCREMENT), so appending it keeps a key in ascending order.
 */
export function addOptionStatements(
	db: Db,
	part: { id: number; costCents: number | null },
	option: { name: string; values: string[] },
	note: string,
	user: string,
	now: string,
): Statement[] {
	const audit = { createdBy: user, updatedBy: user, createdAt: now, updatedAt: now };
	const optionId = optionIdOf(part.id, option.name);
	const stmts: Statement[] = [
		db.insert(partOptions).values({
			partId: part.id,
			name: option.name,
			position: sql`(SELECT COALESCE(MAX(position), 0) + 1 FROM part_options WHERE part_id = ${part.id})`,
			...audit,
		}),
		...option.values.map((name, i) =>
			db.insert(partOptionValues).values({ optionId, name, position: i + 1, isDefault: i === 0, ...audit }),
		),
	];
	const def = sql`(SELECT v.id FROM part_option_values v JOIN part_options o ON o.id = v.option_id
		WHERE o.part_id = ${part.id} AND o.name = ${option.name} AND v.is_default = 1)`;
	const appended = (column: SQL) =>
		sql`CASE WHEN ${column} IS NULL THEN CAST(${def} AS TEXT) ELSE ${column} || ',' || ${def} END`;
	// Stock: in with the new key first (grouped over the old keys), then out of the old keys (the new rows excluded).
	const move = (sign: 1 | -1, key: SQL) => sql`
		SELECT NULL, part_id, ${sign} * SUM(qty_milli), 'adjust', 'part_options', NULL, NULL, ${part.costCents}, ${now},
			${user}, ${note}, ${now}, ${now}, ${user}, ${user}, ${key}
		FROM stock_moves WHERE part_id = ${part.id} AND (option_values IS NULL OR NOT ${keyNames(sql`option_values`, def)})
		GROUP BY option_values HAVING SUM(qty_milli) <> 0`;
	stmts.push(
		db.insert(stockMoves).select(move(1, appended(sql`option_values`))),
		db.insert(stockMoves).select(move(-1, sql`option_values`)),
		db
			.update(poLines)
			.set({ optionValues: appended(sql`${poLines.optionValues}`), updatedAt: now, updatedBy: user })
			.where(
				and(
					eq(poLines.partId, part.id),
					sql`${poLines.receivedQtyMilli} < ${poLines.qtyMilli}`,
					inArray(
						poLines.poId,
						db
							.select({ id: purchaseOrders.id })
							.from(purchaseOrders)
							.where(inArray(purchaseOrders.status, ["draft", "sent", "partial"])),
					),
				),
			),
		db
			.update(builds)
			.set({ optionValues: appended(sql`${builds.optionValues}`), updatedAt: now, updatedBy: user })
			.where(and(eq(builds.partId, part.id), inArray(builds.status, ["planned", "in_progress"]))),
	);
	return stmts;
}

/** What the edit form of an option posts, read from its fields. */
export type OptionEdit = {
	name: string;
	/** Existing values: new name, removed or not, in the order they are listed. */
	values: { id: number; name: string; remove: boolean }[];
	/** The default value's id. */
	defaultId: number | null;
	/** New values, appended in order. */
	added: string[];
};

/** Reads the edit form: `name`, `value_<id>`, `remove_<id>`, `default`, `add` (one per line), `move` (`<id>:up|down`). */
export function readOptionEdit(option: OptionDef, form: Record<string, string>): OptionEdit {
	const values = option.values.map((v) => ({
		id: v.id,
		name: (form[`value_${v.id}`] ?? v.name).trim(),
		remove: form[`remove_${v.id}`] === "on",
	}));
	const [moveId, dir] = (form.move ?? "").split(":");
	const at = values.findIndex((v) => String(v.id) === moveId);
	const to = dir === "up" ? at - 1 : dir === "down" ? at + 1 : -1;
	if (at >= 0 && to >= 0 && to < values.length) {
		const [moved] = values.splice(at, 1);
		if (moved) values.splice(to, 0, moved);
	}
	const defaultId = Number(form.default);
	return {
		name: (form.name ?? option.name).trim(),
		values,
		defaultId: option.values.some((v) => v.id === defaultId) ? defaultId : null,
		added: valueLines(form.add ?? ""),
	};
}

/** Errors of an edit: names valid and unique, a value left, the default kept, nothing in use removed. */
export function optionEditErrors(
	others: OptionDef[],
	edit: OptionEdit,
	inUse: Set<number>,
): { errors: FieldErrors; vars: Record<string, string> } {
	const errors: FieldErrors = {};
	const vars: Record<string, string> = {};
	if (!edit.name) errors.name = "required";
	else if (edit.name.length > 40) errors.name = "too_long";
	else if (RESERVED_NAME.test(edit.name)) errors.name = "option_name_invalid";
	else if (others.some((o) => sameName(o.name, edit.name))) errors.name = "duplicate_name";
	const kept = edit.values.filter((v) => !v.remove);
	for (const v of edit.values) if (!v.name) errors[`value_${v.id}`] = "required";
	const removedInUse = edit.values.find((v) => v.remove && inUse.has(v.id));
	if (removedInUse) {
		errors[`value_${removedInUse.id}`] = "option_value_in_use";
	}
	const names = [...kept.map((v) => v.name), ...edit.added];
	if (names.length === 0) errors.add = "option_values_required";
	else {
		const e = namesError(names.filter(Boolean));
		if (e) errors.add = e;
	}
	const def = edit.values.find((v) => v.id === edit.defaultId);
	if (def?.remove) errors.default = "option_default_removed";
	return { errors, vars };
}

/** Saves an edit in one batch: removed values first (unique names), then renames, order, default, new values. */
export function editOptionStatements(
	db: Db,
	option: OptionDef,
	edit: OptionEdit,
	user: string,
	now: string,
): Statement[] {
	const audit = { updatedAt: now, updatedBy: user };
	const stmts: Statement[] = [];
	const kept = edit.values.filter((v) => !v.remove);
	for (const v of edit.values.filter((v) => v.remove))
		stmts.push(db.delete(partOptionValues).where(eq(partOptionValues.id, v.id)));
	if (edit.name !== option.name)
		stmts.push(
			db
				.update(partOptions)
				.set({ name: edit.name, ...audit })
				.where(eq(partOptions.id, option.id)),
		);
	// A renamed value whose current name another value takes (two names swapped) first moves to a temporary name, so
	// no update meets the unique index; other renames are written once.
	const names = new Map(option.values.map((v) => [v.id, v.name]));
	const renamed = kept.filter((v) => v.name !== names.get(v.id));
	for (const v of renamed.filter((r) => renamed.some((o) => o.id !== r.id && o.name === names.get(r.id))))
		stmts.push(
			db
				.update(partOptionValues)
				.set({ name: `~${v.id}` })
				.where(eq(partOptionValues.id, v.id)),
		);
	const current = option.values.find((v) => v.isDefault)?.id ?? null;
	// The default chosen, else the current one; when it is removed, the first value kept (or else the first added).
	const wanted = edit.defaultId ?? current;
	const defaultId = kept.some((v) => v.id === wanted) ? wanted : (kept[0]?.id ?? null);
	if (defaultId !== current && current !== null && kept.some((v) => v.id === current))
		stmts.push(
			db
				.update(partOptionValues)
				.set({ isDefault: false, ...audit })
				.where(eq(partOptionValues.id, current)),
		);
	kept.forEach((v, i) => {
		const before = option.values.find((o) => o.id === v.id);
		const position = i + 1;
		const isDefault = v.id === defaultId;
		if (!before || before.name !== v.name || isDefault !== before.isDefault || option.values.indexOf(before) !== i)
			stmts.push(
				db
					.update(partOptionValues)
					.set({ name: v.name, position, isDefault, ...audit })
					.where(eq(partOptionValues.id, v.id)),
			);
	});
	const hasDefault = kept.some((v) => v.id === defaultId);
	edit.added.forEach((name, i) => {
		stmts.push(
			db.insert(partOptionValues).values({
				optionId: option.id,
				name,
				position: kept.length + i + 1,
				// The first value added becomes the default when the option has none left.
				isDefault: !hasDefault && i === 0,
				createdBy: user,
				updatedBy: user,
				createdAt: now,
				updatedAt: now,
			}),
		);
	});
	return stmts;
}

/** Deletes an option with its values (refused beforehand while any value is in use). */
export function deleteOptionStatement(db: Db, optionId: number) {
	return db.delete(partOptions).where(eq(partOptions.id, optionId));
}

/** Moves an option up or down among the part's options. */
export function moveOptionStatements(
	db: Db,
	options: OptionDef[],
	optionId: number,
	dir: "up" | "down",
	user: string,
	now: string,
): Statement[] {
	const order = options.map((o) => o.id);
	const at = order.indexOf(optionId);
	const to = dir === "up" ? at - 1 : at + 1;
	if (at < 0 || to < 0 || to >= order.length) return [];
	order.splice(at, 1);
	order.splice(to, 0, optionId);
	return order.map((id, i) =>
		db
			.update(partOptions)
			.set({ position: i + 1, updatedAt: now, updatedBy: user })
			.where(eq(partOptions.id, id)),
	);
}

/** The key of a value set chosen in a form: `option:<optionId>` → value id, per option of the part. */
export function keyFromForm(
	options: OptionDef[],
	form: Record<string, unknown>,
	prefix = "option:",
): { key: OptionKey; missing: OptionDef | null } {
	const ids: number[] = [];
	let missing: OptionDef | null = null;
	for (const o of options) {
		const raw = form[`${prefix}${o.id}`];
		const id = Number(typeof raw === "string" ? raw : "");
		if (o.values.some((v) => v.id === id)) ids.push(id);
		else missing ??= o;
	}
	return { key: keyOf(ids), missing };
}
