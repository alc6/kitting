import { asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { type Part, parts, stockMoves } from "../../db/schema";
import { formatCentsInput, formatQtyInput } from "../../lib/units";
import { field, validate } from "../../lib/validation";
import { checkHeader, emptyPlan, fieldIssues, type Importer, type PlanRow, type RowIssue } from "./types";

const stockRow = z.object({
	ref: field.required(64),
	qty: field.qty(),
	serial: field.text(100),
	unit_cost: field.money(),
});

type Move = { partId: number; qtyMilli: number; serial: string | null; unitCostCents: number | null };

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
		const groups = new Map<
			number,
			{ part: Part; lines: { line: number; qty: number; serial: string; unitCost: number | null }[] }
		>();
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
			if (part.kind !== "buy" && part.kind !== "make") {
				issues.push({ line: rec.line, column: "ref", key: "not_stocked", vars: { kind: part.kind } });
				continue;
			}
			const g = groups.get(part.id) ?? { part, lines: [] };
			g.lines.push({ line: rec.line, qty: v.data.qty, serial: v.data.serial, unitCost: v.data.unit_cost });
			groups.set(part.id, g);
		}

		const rows: PlanRow[] = [];
		const moves: Move[] = [];
		for (const { part, lines } of groups.values()) {
			const first = lines[0];
			if (!first) continue;
			const current = onHand.get(part.id) ?? 0;
			const withSerial = lines.filter((l) => l.serial !== "");
			if (withSerial.length > 0) {
				// Serial rows: every row needs a serial and qty 1, the part must be tracked and have no stock yet.
				const bad = lines.find((l) => l.serial === "" || l.qty !== 1000);
				if (!part.trackSerial || bad) {
					issues.push({ line: (bad ?? first).line, column: "serial", key: "serial_qty" });
					continue;
				}
				if (current !== 0) {
					issues.push({ line: first.line, column: "serial", key: "serial_initial_only" });
					continue;
				}
				const seen = new Map<string, number>();
				let dup = false;
				for (const l of lines) {
					const prev = seen.get(l.serial);
					if (prev !== undefined) {
						issues.push({ line: l.line, column: "serial", key: "duplicate_in_file", vars: { line: prev } });
						dup = true;
					}
					seen.set(l.serial, l.line);
				}
				if (dup) continue;
				for (const l of lines) {
					moves.push({
						partId: part.id,
						qtyMilli: 1000,
						serial: l.serial,
						unitCostCents: l.unitCost ?? part.costCents,
					});
				}
				rows.push(
					planRow(
						part,
						first.line,
						current,
						lines.length * 1000,
						lines.map((l) => l.serial),
					),
				);
				continue;
			}
			if (lines.length > 1) {
				for (const l of lines.slice(1)) {
					issues.push({ line: l.line, column: "ref", key: "duplicate_in_file", vars: { line: first.line } });
				}
				continue;
			}
			const delta = first.qty - current;
			if (delta !== 0) {
				moves.push({ partId: part.id, qtyMilli: delta, serial: null, unitCostCents: first.unitCost ?? part.costCents });
			}
			rows.push(planRow(part, first.line, current, first.qty, []));
		}
		rows.sort((a, b) => a.line - b.line);

		return {
			type: "stock",
			previewColumns: ["ref", "name", "on_hand", "counted", "delta"],
			rows,
			errors: issues,
			warnings,
			statements: (user, now) =>
				moves.map((m) =>
					db.insert(stockMoves).values({
						...m,
						reason: "count",
						refType: "import",
						at: now,
						by: user,
						note: "stock.csv",
						createdBy: user,
						updatedBy: user,
						createdAt: now,
						updatedAt: now,
					}),
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

function planRow(part: Part, line: number, current: number, counted: number, serials: string[]): PlanRow {
	const delta = counted - current;
	return {
		line,
		action: delta === 0 ? "unchanged" : "update",
		cells: [
			part.ref,
			part.name,
			formatQtyInput(current),
			formatQtyInput(counted),
			`${delta > 0 ? "+" : ""}${formatQtyInput(delta)}`,
		],
		changes: serials.length ? [`serials: ${serials.join(", ")}`] : [],
	};
}
