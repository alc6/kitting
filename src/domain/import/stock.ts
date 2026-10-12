import { asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { parts, stockMoves } from "../../db/schema";
import { formatCentsInput, formatQtyInput } from "../../lib/units";
import { field, validate } from "../../lib/validation";
import { type CountGroup, type CountResult, isStocked, moveValues, planCounts } from "../stock";
import { checkHeader, emptyPlan, fieldIssues, type Importer, type PlanRow, type RowIssue } from "./types";

const stockRow = z.object({
	ref: field.required(64),
	qty: field.qty(),
	serial: field.text(100),
	unit_cost: field.money(),
});

/**
 * stock.csv sets on-hand to a counted quantity: one `count` move for the difference.
 * Serial-tracked parts may list one row per serial (qty 1) while they have no stock yet;
 * each serial then gets its own +1 move so later builds can trace it.
 */
export const stockImporter: Importer = {
	type: "stock",
	required: ["ref", "qty"],
	optional: ["serial", "unit_cost"],
	example: [
		["RES-10K", "1200", "", "0.01"],
		["CBL-2C", "35.5", "", ""],
		["SA-MAIN", "1", "SN-0001", ""],
		["SA-MAIN", "1", "SN-0002", ""],
	],

	async plan({ db }, table) {
		const { errors, warnings } = checkHeader(this, table);
		if (errors.length) return emptyPlan("stock", errors, warnings);

		const [allParts, onHandRows] = await Promise.all([
			db.select().from(parts),
			db
				.select({ partId: stockMoves.partId, qty: sql<number>`SUM(${stockMoves.qtyMilli})` })
				.from(stockMoves)
				.groupBy(stockMoves.partId),
		]);
		const byRef = new Map(allParts.map((p) => [p.ref, p]));
		const onHand = new Map(onHandRows.map((r) => [r.partId, r.qty]));

		const issues: RowIssue[] = [];
		// Group valid rows by part, preserving file order.
		const groups = new Map<number, CountGroup>();
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
			const g = groups.get(part.id) ?? { part, lines: [] };
			g.lines.push({ line: rec.line, qtyMilli: v.data.qty, serial: v.data.serial, unitCostCents: v.data.unit_cost });
			groups.set(part.id, g);
		}

		const counted = planCounts([...groups.values()], onHand);
		issues.push(...counted.issues);
		const rows = counted.results.map(planRow).sort((a, b) => a.line - b.line);

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

	async exportRows({ db, locale }) {
		const rows = await db
			.select({
				ref: parts.ref,
				costCents: parts.costCents,
				qty: sql<number>`COALESCE(SUM(${stockMoves.qtyMilli}), 0)`,
			})
			.from(parts)
			.leftJoin(stockMoves, eq(stockMoves.partId, parts.id))
			.where(sql`${parts.kind} IN ('buy', 'make') AND ${parts.archived} = 0`)
			.groupBy(parts.id)
			.orderBy(asc(parts.ref));
		return rows.map((r) => [
			r.ref,
			formatQtyInput(r.qty, locale),
			"",
			r.costCents === null ? "" : formatCentsInput(r.costCents, locale),
		]);
	},
};

function planRow(r: CountResult): PlanRow {
	const delta = r.counted - r.current;
	return {
		line: r.line,
		action: delta === 0 ? "unchanged" : "update",
		cells: [
			r.part.ref,
			r.part.name,
			formatQtyInput(r.current),
			formatQtyInput(r.counted),
			`${delta > 0 ? "+" : ""}${formatQtyInput(delta)}`,
		],
		changes: r.serials.length ? [`serials: ${r.serials.join(", ")}`] : [],
	};
}
