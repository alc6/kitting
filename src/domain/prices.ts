// Price history: an append-only log of standard costs, supplier offer prices and selling prices.
// Prices actually paid are not copied here: they are the receipt moves of the ledger (PO price).
import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
	boms,
	type PriceKind,
	type PriceSource,
	parts,
	priceHistory,
	purchaseOrders,
	stockMoves,
	suppliers,
} from "../db/schema";
import type { Db } from "../types";

export type PriceRecord = {
	partId: number;
	kind: PriceKind;
	priceCents: number | null;
	source: PriceSource;
	supplierId?: number | null;
	bomId?: number | null;
	note?: string;
};

/** Insert statement for one history row, dated today (UTC). Add it to the batch that changes the price. */
export function priceRecordStatement(db: Db, r: PriceRecord, user: string, now: string) {
	return db.insert(priceHistory).values({
		partId: r.partId,
		kind: r.kind,
		priceCents: r.priceCents,
		supplierId: r.supplierId ?? null,
		bomId: r.bomId ?? null,
		validFrom: now.slice(0, 10),
		source: r.source,
		note: r.note ?? "",
		createdBy: user,
		updatedBy: user,
		createdAt: now,
		updatedAt: now,
	});
}

/** Same, for a part created in the same batch (looked up by its unique ref). */
export function priceRecordForRefStatement(
	db: Db,
	ref: string,
	r: Omit<PriceRecord, "partId">,
	user: string,
	now: string,
) {
	// INSERT ... SELECT over every column of price_history, in table order (id is assigned).
	return db.insert(priceHistory).select(sql`
		SELECT NULL, id, ${r.kind}, ${r.supplierId ?? null}, ${r.bomId ?? null}, ${r.priceCents}, ${now.slice(0, 10)},
			${r.source}, ${r.note ?? ""}, ${now}, ${now}, ${user}, ${user}
		FROM parts WHERE ref = ${ref}`);
}

/** The history of a part, newest first, with supplier names and BoM variants. */
export async function partPriceHistory(db: Db, partId: number) {
	return db
		.select({
			id: priceHistory.id,
			kind: priceHistory.kind,
			priceCents: priceHistory.priceCents,
			validFrom: priceHistory.validFrom,
			source: priceHistory.source,
			note: priceHistory.note,
			createdAt: priceHistory.createdAt,
			createdBy: priceHistory.createdBy,
			supplierId: priceHistory.supplierId,
			supplierName: suppliers.name,
			bomId: priceHistory.bomId,
			bomCode: boms.code,
		})
		.from(priceHistory)
		.leftJoin(suppliers, eq(priceHistory.supplierId, suppliers.id))
		.leftJoin(boms, eq(priceHistory.bomId, boms.id))
		.where(eq(priceHistory.partId, partId))
		.orderBy(desc(priceHistory.validFrom), desc(priceHistory.id));
}

/** Prices actually paid for a part: its receipts (at the PO price), newest first. */
export async function paidPrices(db: Db, partId: number, limit = 50) {
	return db
		.select({
			at: stockMoves.at,
			qtyMilli: stockMoves.qtyMilli,
			unitCostCents: stockMoves.unitCostCents,
			poId: purchaseOrders.id,
			poNumber: purchaseOrders.number,
			supplierId: suppliers.id,
			supplierName: suppliers.name,
		})
		.from(stockMoves)
		.innerJoin(purchaseOrders, and(eq(stockMoves.refType, "po"), eq(stockMoves.refId, purchaseOrders.id)))
		.innerJoin(suppliers, eq(purchaseOrders.supplierId, suppliers.id))
		.where(and(eq(stockMoves.partId, partId), eq(stockMoves.reason, "receipt")))
		.orderBy(desc(stockMoves.at), desc(stockMoves.id))
		.limit(limit);
}

/** Last price paid to each supplier for a part (for the offers card). */
export async function lastPaidBySupplier(db: Db, partId: number) {
	const rows = await paidPrices(db, partId, 500);
	const last = new Map<number, { unitCostCents: number | null; at: string }>();
	for (const r of rows)
		if (!last.has(r.supplierId)) last.set(r.supplierId, { unitCostCents: r.unitCostCents, at: r.at });
	return last;
}

/**
 * Standard cost of every part on a date: the latest history row on or before that day. A part whose
 * history starts later falls back to its earliest row (before migration 0002 nothing was recorded), and a
 * part without history to its current cost. Returns the parts whose cost comes from such a fallback too.
 */
export async function standardCostsAt(db: Db, date: string) {
	const [rows, current] = await Promise.all([
		db
			.select({ partId: priceHistory.partId, priceCents: priceHistory.priceCents, validFrom: priceHistory.validFrom })
			.from(priceHistory)
			.where(eq(priceHistory.kind, "standard"))
			.orderBy(asc(priceHistory.partId), asc(priceHistory.validFrom), asc(priceHistory.id)),
		db.select({ id: parts.id, costCents: parts.costCents }).from(parts),
	]);
	return resolveCostsAt(rows, current, date);
}

/** Pure part of standardCostsAt (rows sorted by part, date, id). */
export function resolveCostsAt(
	rows: { partId: number; priceCents: number | null; validFrom: string }[],
	current: { id: number; costCents: number | null }[],
	date: string,
) {
	const costs = new Map<number, number | null>();
	const fallback = new Set<number>();
	const first = new Map<number, number | null>();
	for (const r of rows) {
		if (!first.has(r.partId)) first.set(r.partId, r.priceCents);
		if (r.validFrom <= date) costs.set(r.partId, r.priceCents);
	}
	for (const p of current) {
		if (costs.has(p.id)) continue;
		if (first.has(p.id)) {
			fallback.add(p.id);
			costs.set(p.id, first.get(p.id) ?? null);
		} else costs.set(p.id, p.costCents);
	}
	return { costs, fallback };
}

/** Date of the oldest history row (the migration seed), to explain fallbacks on the valuation page. */
export async function historyStart(db: Db): Promise<string | null> {
	const [row] = await db.select({ d: sql<string | null>`MIN(${priceHistory.validFrom})` }).from(priceHistory);
	return row?.d ?? null;
}
