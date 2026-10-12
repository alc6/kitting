// Stock: the append-only ledger of moves. On-hand is always SUM(qty_milli) per part.
import { and, desc, eq, gte, lte, type SQL, sql } from "drizzle-orm";
import { MOVE_REASONS, type MoveReason, type Part, type PartKind, parts, stockMoves } from "../db/schema";
import { likePattern } from "../lib/sql";
import { MILLI } from "../lib/units";
import type { Db } from "../types";
import { CostCalculator, centsOf } from "./bom-graph";
import { loadGraph } from "./boms";
import type { RowIssue } from "./import/types";

export const isStocked = (kind: PartKind): boolean => kind === "buy" || kind === "make";

export type NewMove = {
	partId: number;
	qtyMilli: number;
	serial: string | null;
	unitCostCents: number | null;
};

/** Values for inserting a move; every caller goes through here so audit fields are never missed. */
export function moveValues(
	m: NewMove,
	ctx: { reason: MoveReason; refType: string | null; refId?: number | null; note: string; user: string; now: string },
) {
	return {
		partId: m.partId,
		qtyMilli: m.qtyMilli,
		serial: m.serial,
		unitCostCents: m.unitCostCents,
		reason: ctx.reason,
		refType: ctx.refType,
		refId: ctx.refId ?? null,
		at: ctx.now,
		by: ctx.user,
		note: ctx.note,
		createdBy: ctx.user,
		updatedBy: ctx.user,
		createdAt: ctx.now,
		updatedAt: ctx.now,
	};
}

// ---------------------------------------------------------------------------
// Inventory counts (shared by stock.csv and the count screen)

export type CountLine = { line: number; qtyMilli: number; serial: string; unitCostCents: number | null };
export type CountGroup = { part: Part; lines: CountLine[] };
export type CountResult = { part: Part; line: number; current: number; counted: number; serials: string[] };

/**
 * Turns counted quantities into `count` moves for the difference with the current on-hand.
 * A serial-tracked part with no stock yet may list one line per serial (qty 1): each serial
 * gets its own +1 move. Otherwise one line per part.
 */
export function planCounts(
	groups: CountGroup[],
	onHand: Map<number, number>,
): { moves: NewMove[]; results: CountResult[]; issues: RowIssue[] } {
	const moves: NewMove[] = [];
	const results: CountResult[] = [];
	const issues: RowIssue[] = [];
	for (const { part, lines } of groups) {
		const first = lines[0];
		if (!first) continue;
		const current = onHand.get(part.id) ?? 0;
		if (lines.some((l) => l.serial !== "")) {
			const bad = lines.find((l) => l.serial === "" || l.qtyMilli !== MILLI);
			if (!part.trackSerial || bad) {
				issues.push({ line: (bad ?? first).line, column: "serial", key: "serial_qty" });
				continue;
			}
			if (current !== 0) {
				issues.push({ line: first.line, column: "serial", key: "serial_initial_only" });
				continue;
			}
			const seen = new Map<string, number>();
			const dups = lines.filter((l) => {
				const prev = seen.get(l.serial);
				if (prev !== undefined) {
					issues.push({ line: l.line, column: "serial", key: "duplicate_in_file", vars: { line: prev } });
					return true;
				}
				seen.set(l.serial, l.line);
				return false;
			});
			if (dups.length) continue;
			for (const l of lines) {
				moves.push({
					partId: part.id,
					qtyMilli: MILLI,
					serial: l.serial,
					unitCostCents: l.unitCostCents ?? part.costCents,
				});
			}
			results.push({
				part,
				line: first.line,
				current,
				counted: lines.length * MILLI,
				serials: lines.map((l) => l.serial),
			});
			continue;
		}
		if (lines.length > 1) {
			for (const l of lines.slice(1)) {
				issues.push({ line: l.line, column: "ref", key: "duplicate_in_file", vars: { line: first.line } });
			}
			continue;
		}
		const delta = first.qtyMilli - current;
		if (delta !== 0) {
			moves.push({
				partId: part.id,
				qtyMilli: delta,
				serial: null,
				unitCostCents: first.unitCostCents ?? part.costCents,
			});
		}
		results.push({ part, line: first.line, current, counted: first.qtyMilli, serials: [] });
	}
	return { moves, results, issues };
}

// ---------------------------------------------------------------------------
// Queries

/** On-hand per part, optionally as of the end of a day (YYYY-MM-DD, UTC). */
export async function onHandAt(db: Db, date?: string | null): Promise<Map<number, number>> {
	const rows = await db
		.select({ partId: stockMoves.partId, qty: sql<number>`SUM(${stockMoves.qtyMilli})` })
		.from(stockMoves)
		.where(date ? lte(stockMoves.at, `${date}T23:59:59.999Z`) : undefined)
		.groupBy(stockMoves.partId);
	return new Map(rows.map((r) => [r.partId, r.qty]));
}

export type MoveFilters = { q?: string; reason?: string; from?: string | null; to?: string | null; limit?: number };

export async function listMoves(db: Db, f: MoveFilters = {}) {
	const conds: SQL[] = [];
	if (f.q) {
		const like = likePattern(f.q);
		conds.push(
			sql`(${parts.ref} LIKE ${like} ESCAPE '\\' OR ${parts.name} LIKE ${like} ESCAPE '\\' OR ${stockMoves.serial} LIKE ${like} ESCAPE '\\' OR ${stockMoves.note} LIKE ${like} ESCAPE '\\')`,
		);
	}
	if (f.reason && (MOVE_REASONS as readonly string[]).includes(f.reason)) {
		conds.push(eq(stockMoves.reason, f.reason as MoveReason));
	}
	if (f.from) conds.push(gte(stockMoves.at, `${f.from}T00:00:00.000Z`));
	if (f.to) conds.push(lte(stockMoves.at, `${f.to}T23:59:59.999Z`));
	return db
		.select({
			move: stockMoves,
			ref: parts.ref,
			name: parts.name,
			unit: parts.unit,
		})
		.from(stockMoves)
		.innerJoin(parts, eq(stockMoves.partId, parts.id))
		.where(conds.length ? and(...conds) : undefined)
		.orderBy(desc(stockMoves.at), desc(stockMoves.id))
		.limit(f.limit ?? 500);
}

export type ValuationRow = {
	part: Pick<Part, "id" | "ref" | "name" | "kind" | "unit">;
	onHandMilli: number;
	/** Unit cost in millicents (standard cost for buy parts, roll-up for make parts). */
	unitMillicents: number;
	source: "standard" | "rollup";
	incomplete: boolean;
	valueCents: number;
};

/**
 * Stock valuation: on-hand × unit cost for every stocked part with non-zero on-hand.
 * Buy parts use their standard cost; make parts their rolled-up cost (or their own
 * standard cost when they have no active BoM). Missing costs are flagged.
 */
export async function valuation(db: Db, date?: string | null) {
	const [graph, onHand] = await Promise.all([loadGraph(db), onHandAt(db, date)]);
	const calc = new CostCalculator(graph);
	const rows: ValuationRow[] = [];
	for (const [partId, qty] of onHand) {
		const part = graph.parts.get(partId);
		if (!part || qty === 0 || !isStocked(part.kind)) continue;
		const cost = calc.part(partId);
		const hasBom =
			part.kind === "make" && [...graph.boms.values()].some((b) => b.parentPartId === partId && b.status === "active");
		rows.push({
			part,
			onHandMilli: qty,
			unitMillicents: cost.millicents,
			source: hasBom ? "rollup" : "standard",
			incomplete: cost.incomplete,
			valueCents: centsOf(calc.extended(partId, qty)),
		});
	}
	rows.sort((a, b) => a.part.ref.localeCompare(b.part.ref));
	const totalCents = rows.reduce((s, r) => s + r.valueCents, 0);
	return { rows, totalCents, incomplete: rows.some((r) => r.incomplete) };
}

/** Serials seen in stock for a part (net quantity > 0), newest first. Used as input hints. */
export async function serialsInStock(db: Db, partId: number): Promise<string[]> {
	const rows = await db.all<{ serial: string }>(sql`
		SELECT serial FROM stock_moves
		WHERE part_id = ${partId} AND serial IS NOT NULL AND serial != ''
		GROUP BY serial HAVING SUM(qty_milli) > 0
		ORDER BY MAX(at) DESC LIMIT 500`);
	return rows.map((r) => r.serial);
}
