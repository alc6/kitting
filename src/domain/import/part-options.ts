import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { partOptions, partOptionValues, parts } from "../../db/schema";
import type { Statement } from "../../lib/db";
import { field, validate } from "../../lib/validation";
import type { Db } from "../../types";
import { nameKey, type OptionDef, sameName } from "../option-keys";
import {
	addOptionStatements,
	deleteOptionStatement,
	loadOptions,
	optionName,
	optionsKindError,
	valuesInUse,
} from "../options";
import { checkHeader, emptyPlan, fieldIssues, type Importer, type PlanRow, type RowIssue } from "./types";

const optionRow = z.object({
	ref: field.required(64),
	option: optionName(),
	value: optionName(),
	default: field.bool(),
});

type FileValue = { name: string; line: number; isDefault: boolean };
type FileOption = { name: string; line: number; values: FileValue[] };
type PartRef = { id: number; ref: string; kind: string; costCents: number | null };
type FilePart = { part: PartRef; firstLine: number; options: FileOption[]; bad: boolean };

/** What the file makes of one value of an option: a kept value (by id) or a new one. */
type FinalValue = { name: string; id?: number; isDefault: boolean };

/** Everything to write for one part, decided in plan() so statements() only builds SQL. */
type PartOps = {
	part: PartRef;
	/** Options removed (their values go with them), and values removed from kept options. */
	removedOptionIds: number[];
	removedValueIds: number[];
	/** Kept options: rename, value updates, new values, option position. */
	kept: {
		option: OptionDef;
		name: string;
		position: number | null;
		/** Existing values to write, those that stop being the default first (one default per option). */
		valueUpdates: { id: number; name: string; position: number; isDefault: boolean }[];
		inserts: { name: string; position: number; isDefault: boolean }[];
	}[];
	/** New options with their values, the default first (addOptionStatements makes the first one the default). */
	added: { name: string; values: string[]; fileValues: string[]; position: number | null }[];
};

const joinNames = (names: string[]) => names.join(", ");

/**
 * part_options.csv (D177): the options of a part and their values, one row per value in order. For each part named in
 * the file, the file replaces its options: those not listed are removed (refused while a record names one of their
 * values), those listed (matched by name, ignoring case) keep their ids and are reordered, new ones are added, and an
 * option added to a part that has stock moves it onto its default value (D173; the change then cannot be undone).
 * Values are matched the same way; renaming a value other than its case is a removal plus an addition.
 * `default` = yes marks the default value of an option; without one the current default stays if it is still listed,
 * else the first value is the default.
 */
export const partOptionsImporter: Importer = {
	type: "part_options",
	required: ["ref", "option", "value"],
	optional: ["default"],
	example: [
		["COVER-FRONT", "Colour", "black", "yes"],
		["COVER-FRONT", "Colour", "white", "no"],
		["COVER-FRONT", "Size", "S", "no"],
		["COVER-FRONT", "Size", "M", "yes"],
		["COVER-FRONT", "Size", "L", "no"],
	],

	async plan({ db }, table) {
		const { errors, warnings } = checkHeader(this, table);
		if (errors.length) return emptyPlan("part_options", errors, warnings);

		const [allParts, options] = await Promise.all([
			db.select({ id: parts.id, ref: parts.ref, kind: parts.kind, costCents: parts.costCents }).from(parts),
			loadOptions(db),
		]);
		const byRef = new Map(allParts.map((p) => [p.ref, p]));

		// Group the rows by part and option, in file order.
		const issues: RowIssue[] = [];
		const fileParts = new Map<string, FilePart>();
		for (const rec of table.records) {
			const v = validate(optionRow, rec.values);
			const ref = (rec.values.ref ?? "").trim();
			if (!v.ok) {
				issues.push(...fieldIssues(rec.line, v.errors, (f) => f));
				const known = fileParts.get(ref);
				if (known) known.bad = true;
				else if (byRef.has(ref))
					fileParts.set(ref, { part: byRef.get(ref) as PartRef, firstLine: rec.line, options: [], bad: true });
				continue;
			}
			const d = v.data;
			const part = byRef.get(d.ref);
			if (!part) {
				issues.push({ line: rec.line, column: "ref", key: "unknown_part", vars: { ref: d.ref } });
				continue;
			}
			let fp = fileParts.get(d.ref);
			if (!fp) {
				fp = { part, firstLine: rec.line, options: [], bad: false };
				fileParts.set(d.ref, fp);
				const kindError = optionsKindError(part.kind);
				if (kindError) {
					issues.push({ line: rec.line, column: "ref", key: kindError });
					fp.bad = true;
				}
			}
			if (fp.bad) continue;
			let option = fp.options.find((o) => nameKey(o.name) === nameKey(d.option));
			if (!option) {
				option = { name: d.option, line: rec.line, values: [] };
				fp.options.push(option);
			}
			if (option.values.some((x) => sameName(x.name, d.value))) {
				issues.push({ line: rec.line, column: "value", key: "duplicate_name" });
				continue;
			}
			if (d.default && option.values.some((x) => x.isDefault)) {
				issues.push({ line: rec.line, column: "default", key: "option_default_twice" });
				continue;
			}
			option.values.push({ name: d.value, line: rec.line, isDefault: d.default });
		}

		// Positions as stored, to write only the ones that change.
		const stored = await storedPositions(db);

		const rows: PlanRow[] = [];
		const ops: PartOps[] = [];
		const addsOption: number[] = [];
		for (const fp of fileParts.values()) {
			if (fp.bad) continue;
			const current = options.get(fp.part.id) ?? [];
			const op: PartOps = { part: fp.part, removedOptionIds: [], removedValueIds: [], kept: [], added: [] };
			const matched = new Map<number, FileOption>();
			for (const fo of fp.options) {
				const existing = current.find((o) => sameName(o.name, fo.name));
				if (existing) matched.set(existing.id, fo);
			}
			// Options the file leaves out are removed.
			const droppedOptions = current.filter((o) => !matched.has(o.id));
			for (const o of droppedOptions) {
				op.removedOptionIds.push(o.id);
				rows.push({
					line: fp.firstLine,
					action: "update",
					cells: [fp.part.ref, o.name, "", ""],
					changes: [`− ${o.name}`],
				});
			}
			// Is the layout of the part's options changing (added, removed or reordered options)?
			const keptOrder = current.filter((o) => matched.has(o.id)).map((o) => o.id);
			const fileOrder = fp.options.flatMap((fo) => {
				const e = current.find((o) => sameName(o.name, fo.name));
				return e ? [e.id] : [];
			});
			const optionsRelaid =
				droppedOptions.length > 0 ||
				fp.options.some((fo) => !current.some((o) => sameName(o.name, fo.name))) ||
				keptOrder.join() !== fileOrder.join();
			const optionPos = new Map<number, number>(); // final position of each kept option
			let maxPos = 0;
			fp.options.forEach((fo, i) => {
				const e = current.find((o) => sameName(o.name, fo.name));
				if (e) {
					const pos = optionsRelaid ? i + 1 : (stored.options.get(e.id) ?? i + 1);
					optionPos.set(e.id, pos);
					maxPos = Math.max(maxPos, pos);
				}
			});
			// Options not in the file keep nothing: their positions no longer count once deleted.

			for (const [i, fo] of fp.options.entries()) {
				const existing = current.find((o) => sameName(o.name, fo.name));
				// The default: the row marked yes, else the current one if still listed, else the first.
				const currentDefault = existing?.values.find((v) => v.isDefault);
				const keptDefault = currentDefault ? fo.values.find((x) => sameName(x.name, currentDefault.name)) : undefined;
				const defaultName = (fo.values.find((x) => x.isDefault) ?? keptDefault ?? fo.values[0])?.name ?? "";
				const finalValues: FinalValue[] = fo.values.map((x) => ({
					name: x.name,
					id: existing?.values.find((v) => sameName(v.name, x.name))?.id,
					isDefault: x.name === defaultName,
				}));

				if (!existing) {
					addsOption.push(fp.part.id);
					const ordered = [defaultName, ...fo.values.map((x) => x.name).filter((n) => n !== defaultName)];
					maxPos += 1;
					op.added.push({
						name: fo.name,
						values: ordered,
						fileValues: fo.values.map((x) => x.name),
						position: maxPos === i + 1 ? null : i + 1,
					});
					rows.push({
						line: fo.line,
						action: "create",
						cells: [fp.part.ref, fo.name, joinNames(fo.values.map((x) => x.name)), defaultName],
						changes: [],
					});
					continue;
				}

				const keptIds = new Set(finalValues.flatMap((x) => (x.id === undefined ? [] : [x.id])));
				const removed = existing.values.filter((v) => !keptIds.has(v.id));
				op.removedValueIds.push(...removed.map((v) => v.id));
				const changes: string[] = [];
				if (existing.name !== fo.name) changes.push(`name: ${existing.name} → ${fo.name}`);
				for (const x of finalValues) if (x.id === undefined) changes.push(`+ ${x.name}`);
				for (const v of removed) changes.push(`− ${v.name}`);
				for (const x of finalValues) {
					const was = existing.values.find((v) => v.id === x.id);
					if (was && was.name !== x.name) changes.push(`${was.name} → ${x.name}`);
				}
				const before = existing.values.filter((v) => keptIds.has(v.id));
				const after = finalValues.filter((x) => x.id !== undefined);
				const reordered = before.map((v) => v.id).join() !== after.map((x) => x.id).join();
				if (reordered)
					changes.push(`order: ${joinNames(before.map((v) => v.name))} → ${joinNames(after.map((x) => x.name))}`);
				if (currentDefault?.id !== finalValues.find((x) => x.isDefault)?.id)
					changes.push(`default: ${currentDefault?.name ?? ""} → ${defaultName}`);

				const relaid = reordered || removed.length > 0 || finalValues.some((x) => x.id === undefined);
				const valueUpdates: PartOps["kept"][number]["valueUpdates"] = [];
				finalValues.forEach((x, k) => {
					const was = existing.values.find((v) => v.id === x.id);
					if (!was || x.id === undefined) return;
					const position = relaid ? k + 1 : (stored.values.get(x.id) ?? k + 1);
					if (was.name !== x.name || was.isDefault !== x.isDefault || position !== stored.values.get(x.id))
						valueUpdates.push({ id: x.id, name: x.name, position, isDefault: x.isDefault });
				});
				valueUpdates.sort((p, q) => Number(p.isDefault) - Number(q.isDefault));
				const optionPosition = optionPos.get(existing.id) ?? null;
				op.kept.push({
					option: existing,
					name: fo.name,
					position: optionPosition !== stored.options.get(existing.id) ? optionPosition : null,
					valueUpdates,
					inserts: finalValues.flatMap((x, k) =>
						x.id === undefined ? [{ name: x.name, position: k + 1, isDefault: x.isDefault }] : [],
					),
				});
				rows.push({
					line: fo.line,
					action: changes.length ? "update" : "unchanged",
					cells: [fp.part.ref, fo.name, joinNames(fo.values.map((x) => x.name)), defaultName],
					changes,
				});
			}
			ops.push(op);
		}

		// A value that records name cannot be removed (D169).
		for (const op of ops) {
			const ids = [...op.removedValueIds, ...valueIdsOf(options, op.part.id, op.removedOptionIds)];
			if (ids.length === 0) continue;
			const used = await valuesInUse(db, op.part.id, ids);
			if (used.size === 0) continue;
			const fp = fileParts.get(op.part.ref);
			const line = fp?.firstLine ?? 1;
			for (const optionId of op.removedOptionIds) {
				const o = (options.get(op.part.id) ?? []).find((x) => x.id === optionId);
				if (o?.values.some((v) => used.has(v.id))) issues.push({ line, column: "option", key: "option_in_use" });
			}
			for (const k of op.kept) {
				if (k.option.values.some((v) => used.has(v.id) && op.removedValueIds.includes(v.id))) {
					const fo = fp?.options.find((x) => sameName(x.name, k.option.name));
					issues.push({ line: fo?.line ?? line, column: "value", key: "option_value_in_use" });
				}
			}
		}

		// Adding an option to a part with stock moves it onto the default value: the change cannot be undone (D173).
		const withRecords = addsOption.length ? await partsWithRecords(db, addsOption) : new Set<number>();

		return {
			type: "part_options",
			previewColumns: ["ref", "option", "values", "default"],
			rows: rows.sort((a, b) => a.line - b.line),
			errors: issues,
			warnings,
			...(withRecords.size ? { revertible: false } : {}),
			statements: (user, now) => ops.flatMap((op) => partStatements(db, op, user, now)),
		};
	},

	async exportRows({ db }) {
		const [allParts, options] = await Promise.all([
			db.select({ id: parts.id, ref: parts.ref }).from(parts).orderBy(asc(parts.ref)),
			loadOptions(db),
		]);
		return allParts.flatMap((p) =>
			(options.get(p.id) ?? []).flatMap((o) =>
				o.values.map((v) => [p.ref, o.name, v.name, v.isDefault ? "yes" : "no"]),
			),
		);
	},
};

/** The ids of every value of these options of a part. */
function valueIdsOf(options: Map<number, OptionDef[]>, partId: number, optionIds: number[]): number[] {
	return (options.get(partId) ?? []).filter((o) => optionIds.includes(o.id)).flatMap((o) => o.values.map((v) => v.id));
}

/** Stored positions of options and values (OptionDef lists them in order but does not carry the numbers). */
async function storedPositions(db: Db) {
	const [os, vs] = await Promise.all([
		db.select({ id: partOptions.id, position: partOptions.position }).from(partOptions),
		db.select({ id: partOptionValues.id, position: partOptionValues.position }).from(partOptionValues),
	]);
	return {
		options: new Map(os.map((r) => [r.id, r.position])),
		values: new Map(vs.map((r) => [r.id, r.position])),
	};
}

/** Parts (among these) with stock, open order lines or open builds: the ones D173 rewrites keys for. */
async function partsWithRecords(db: Db, partIds: number[]): Promise<Set<number>> {
	const rows = await db.all<{ part_id: number }>(sql`
		SELECT part_id FROM stock_moves GROUP BY part_id HAVING SUM(qty_milli) <> 0
		UNION SELECT l.part_id FROM po_lines l JOIN purchase_orders o ON o.id = l.po_id
			WHERE o.status IN ('draft', 'sent', 'partial') AND l.received_qty_milli < l.qty_milli
		UNION SELECT part_id FROM builds WHERE status IN ('planned', 'in_progress')`);
	const wanted = new Set(partIds);
	return new Set(rows.map((r) => r.part_id).filter((id) => wanted.has(id)));
}

/** Statement order: removals (unique names), kept options (the old default is cleared before the new one is set), new options. */
function partStatements(db: Db, op: PartOps, user: string, now: string): Statement[] {
	const audit = { updatedAt: now, updatedBy: user };
	const stmts: Statement[] = [];
	for (const id of op.removedOptionIds) stmts.push(deleteOptionStatement(db, id));
	for (const id of op.removedValueIds) stmts.push(db.delete(partOptionValues).where(eq(partOptionValues.id, id)));
	for (const k of op.kept) {
		if (k.name !== k.option.name || k.position !== null)
			stmts.push(
				db
					.update(partOptions)
					.set({ name: k.name, ...(k.position !== null ? { position: k.position } : {}), ...audit })
					.where(eq(partOptions.id, k.option.id)),
			);
		for (const u of k.valueUpdates)
			stmts.push(
				db
					.update(partOptionValues)
					.set({ name: u.name, position: u.position, isDefault: u.isDefault, ...audit })
					.where(eq(partOptionValues.id, u.id)),
			);
		for (const x of k.inserts)
			stmts.push(
				db.insert(partOptionValues).values({
					optionId: k.option.id,
					name: x.name,
					position: x.position,
					isDefault: x.isDefault,
					createdBy: user,
					updatedBy: user,
					createdAt: now,
					updatedAt: now,
				}),
			);
	}
	for (const a of op.added) {
		stmts.push(...addOptionStatements(db, op.part, { name: a.name, values: a.values }, "part_options.csv", user, now));
		const optionId = sql`(SELECT id FROM part_options WHERE part_id = ${op.part.id} AND name = ${a.name})`;
		// The values went in default first; the file's order is restored.
		a.fileValues.forEach((name, i) => {
			if (a.values.indexOf(name) !== i)
				stmts.push(
					db
						.update(partOptionValues)
						.set({ position: i + 1, ...audit })
						.where(and(eq(partOptionValues.optionId, optionId), eq(partOptionValues.name, name))),
				);
		});
		if (a.position !== null)
			stmts.push(
				db
					.update(partOptions)
					.set({ position: a.position, ...audit })
					.where(and(eq(partOptions.partId, op.part.id), eq(partOptions.name, a.name))),
			);
	}
	return stmts;
}
