import { asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { parts, stockMoves } from "../../db/schema";
import { formatCentsInput, formatQtyInput } from "../../lib/units";
import { field, validate } from "../../lib/validation";
import { defaultKey, keyOf, keyText, missingValueIssue, type OptionDef, parseKeyText, stockKey } from "../option-keys";
import { loadOptions } from "../options";
import { type CountGroup, type CountResult, isStocked, moveValues, onHandByKey, planCounts } from "../stock";
import { checkHeader, emptyPlan, fieldIssues, type Importer, type PlanRow, type RowIssue } from "./types";

const stockRow = z.object({
	ref: field.required(64),
	qty: field.qty(),
	serial: field.text(100),
	unit_cost: field.money(),
	options: field.text(500),
});

/**
 * stock.csv sets on-hand to a counted quantity: one `count` move for the difference.
 * Serial-tracked parts may list one row per serial (qty 1) while they have no stock yet;
 * each serial then gets its own +1 move so later builds can trace it.
 * A part with options is counted per values (D192): `options` names one value of each ("Colour=white|Size=L", or
 * "white" for a single option), and each values is a row of its own.
 */
export const stockImporter: Importer = {
	type: "stock",
	required: ["ref", "qty"],
	optional: ["serial", "unit_cost", "options"],
	example: [
		["RES-10K", "1200", "", "0.01"],
		["CBL-2C", "35.5", "", ""],
		["SA-MAIN", "1", "SN-0001", ""],
		["SA-MAIN", "1", "SN-0002", ""],
	],

	async plan({ db }, table) {
		const { errors, warnings } = checkHeader(this, table);
		if (errors.length) return emptyPlan("stock", errors, warnings);

		const [allParts, onHand, options] = await Promise.all([db.select().from(parts), onHandByKey(db), loadOptions(db)]);
		const byRef = new Map(allParts.map((p) => [p.ref, p]));

		const issues: RowIssue[] = [];
		// Group valid rows by part and values, preserving file order.
		const groups = new Map<string, CountGroup>();
		for (const rec of table.records) {
			const v = validate(stockRow, rec.values);
			if (!v.ok) {
				issues.push(...fieldIssues(rec.line, v.errors, (f) => f));
				continue;
			}
			const part = byRef.get(v.data.ref);
			if (!part) {
				issues.push({ line: rec.line, column: "ref", key: "unknown_part", vars: { ref: v.data.ref } });
				continue;
			}
			if (!isStocked(part.kind)) {
				issues.push({ line: rec.line, column: "ref", key: "not_stocked", vars: { kind: part.kind } });
				continue;
			}
			const partOptions = options.get(part.id) ?? [];
			const parsed = parseKeyText(partOptions, v.data.options);
			const issue = parsed.issue ?? (partOptions.length ? missingValueIssue(partOptions, parsed.ids) : null);
			if (issue) {
				issues.push({ line: rec.line, column: "options", key: issue.key, vars: { ref: part.ref, ...issue.vars } });
				continue;
			}
			const optionValues = keyOf(parsed.ids);
			const k = stockKey(part.id, optionValues);
			const g = groups.get(k) ?? { part, optionValues, lines: [] };
			g.lines.push({ line: rec.line, qtyMilli: v.data.qty, serial: v.data.serial, unitCostCents: v.data.unit_cost });
			groups.set(k, g);
		}

		const counted = planCounts([...groups.values()], onHand);
		issues.push(...counted.issues);
		const rows = counted.results.map((r) => planRow(r, options.get(r.part.id) ?? [])).sort((a, b) => a.line - b.line);

		return {
			type: "stock",
			previewColumns: ["ref", "name", "on_hand", "counted", "delta"],
			rows,
			errors: issues,
			warnings,
			statements: (user, now) =>
				counted.moves.map((m) =>
					db
						.insert(stockMoves)
						.values(moveValues(m, { reason: "count", refType: "import", note: "stock.csv", user, now })),
				),
		};
	},

	/** One row per part, and per values in stock for a part with options (its default values when it has none). */
	async exportRows({ db, locale }) {
		const [rows, options] = await Promise.all([
			db
				.select({
					id: parts.id,
					ref: parts.ref,
					costCents: parts.costCents,
					optionValues: stockMoves.optionValues,
					qty: sql<number>`COALESCE(SUM(${stockMoves.qtyMilli}), 0)`,
				})
				.from(parts)
				.leftJoin(stockMoves, eq(stockMoves.partId, parts.id))
				.where(sql`${parts.kind} IN ('buy', 'make') AND ${parts.archived} = 0`)
				.groupBy(parts.id, stockMoves.optionValues)
				.orderBy(asc(parts.ref), asc(stockMoves.optionValues)),
			loadOptions(db),
		]);
		const out: string[][] = [];
		const row = (r: (typeof rows)[number], partOptions: OptionDef[], key: string | null, qty: number) => [
			r.ref,
			formatQtyInput(qty, locale),
			"",
			r.costCents === null ? "" : formatCentsInput(r.costCents, locale),
			keyText(partOptions, key),
		];
		const listed = new Set<number>();
		for (const r of rows) {
			const partOptions = options.get(r.id) ?? [];
			if (partOptions.length === 0) out.push(row(r, partOptions, null, r.qty));
			else if (r.optionValues !== null && r.qty !== 0) {
				out.push(row(r, partOptions, r.optionValues, r.qty));
				listed.add(r.id);
			}
		}
		for (const r of rows) {
			const partOptions = options.get(r.id) ?? [];
			if (partOptions.length && !listed.has(r.id)) {
				out.push(row(r, partOptions, defaultKey(partOptions), 0));
				listed.add(r.id);
			}
		}
		return out.sort((a, b) => (a[0] ?? "").localeCompare(b[0] ?? "") || (a[4] ?? "").localeCompare(b[4] ?? ""));
	},
};

function planRow(r: CountResult, options: OptionDef[]): PlanRow {
	const delta = r.counted - r.current;
	const values = keyText(options, r.optionValues);
	return {
		line: r.line,
		action: delta === 0 ? "unchanged" : "update",
		cells: [
			values ? `${r.part.ref} (${values})` : r.part.ref,
			r.part.name,
			formatQtyInput(r.current),
			formatQtyInput(r.counted),
			`${delta > 0 ? "+" : ""}${formatQtyInput(delta)}`,
		],
		changes: r.serials.length ? [`serials: ${r.serials.join(", ")}`] : [],
	};
}
