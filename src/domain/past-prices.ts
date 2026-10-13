// Past prices (D142): prices a part had before Kitting, entered as history from the part page or from
// price_history.csv. A past price is a price_history row dated before today and before the latest row of its
// series (same part, same kind, same supplier), so it can never become the current price: it never changes
// parts.cost_cents, an offer or any other current value. The series is the standard cost (no supplier) or one
// supplier's offer price. The supplier may have no offer for the part any more.
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { type PartKind, type PriceKind, priceHistory } from "../db/schema";
import type { Statement } from "../lib/db";
import { type FieldErrors, field } from "../lib/validation";
import type { Db } from "../types";
import { priceRecordStatement } from "./prices";

/** Form fields (and CSV columns, renamed): date, price, supplier, note. */
export const pastPriceInput = z.object({
	date: z
		.string()
		.trim()
		.transform((v, ctx): string => {
			if (v === "") ctx.addIssue({ code: "custom", message: "required" });
			else if (!isCalendarDate(v)) ctx.addIssue({ code: "custom", message: "invalid_date" });
			return v;
		}),
	price: field.money().transform((v, ctx): number => {
		if (v === null) ctx.addIssue({ code: "custom", message: "required" });
		return v ?? 0;
	}),
	/** Empty: the standard cost. */
	supplier_id: field.id(),
	note: field.text(500),
});
export type PastPriceInput = z.output<typeof pastPriceInput>;

/** A real YYYY-MM-DD date (Date.parse alone accepts 2026-02-31). */
export function isCalendarDate(v: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
	const d = new Date(`${v}T00:00:00Z`);
	return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** What a price is of: the standard cost (no supplier) or a supplier's offer price. */
export const pastKind = (supplierId: number | null): PriceKind => (supplierId === null ? "standard" : "purchase");

/** The rows already in a series: the date of the latest one and every date taken. */
export type Series = { latest: string; dates: Set<string> };
export type SeriesMap = Map<string, Series>;

export const seriesKey = (partId: number, supplierId: number | null) => `${partId}:${supplierId ?? 0}`;

/** Standard cost and offer price series of one part, or of every part. */
export async function loadSeries(db: Db, partId?: number): Promise<SeriesMap> {
	const kinds = inArray(priceHistory.kind, ["standard", "purchase"]);
	const rows = await db
		.select({ partId: priceHistory.partId, supplierId: priceHistory.supplierId, validFrom: priceHistory.validFrom })
		.from(priceHistory)
		.where(partId === undefined ? kinds : and(kinds, eq(priceHistory.partId, partId)));
	const out: SeriesMap = new Map();
	for (const r of rows) {
		const key = seriesKey(r.partId, r.supplierId);
		const s = out.get(key);
		if (!s) out.set(key, { latest: r.validFrom, dates: new Set([r.validFrom]) });
		else {
			s.dates.add(r.validFrom);
			if (r.validFrom > s.latest) s.latest = r.validFrom;
		}
	}
	return out;
}

/**
 * The business rules, shared by the form and the import (errors are keys of Dict.errors by field name):
 * a supplier price only for a stocked part, a date before today, not taken yet, and before the latest row of
 * the series. Rows of the same import file are not compared with each other here.
 */
export function pastPriceRuleErrors(args: {
	date: string;
	supplierId: number | null;
	partKind: PartKind;
	series: Series | undefined;
	today: string;
}): FieldErrors {
	const { date, supplierId, partKind, series, today } = args;
	if (supplierId !== null && partKind !== "buy" && partKind !== "make") return { supplier_id: "not_stocked" };
	if (date >= today) return { date: "past_price_not_past" };
	if (series?.dates.has(date)) return { date: "duplicate_date" };
	if (series && date > series.latest) return { date: "past_price_not_older" };
	return {};
}

/** The insert for one past price. `source` is how it was entered; the date is the past one. */
export function pastPriceStatement(
	db: Db,
	partId: number,
	d: { date: string; priceCents: number; supplierId: number | null; note: string },
	source: "form" | "import",
	user: string,
	now: string,
): Statement {
	return priceRecordStatement(
		db,
		{
			partId,
			kind: pastKind(d.supplierId),
			priceCents: d.priceCents,
			source,
			supplierId: d.supplierId,
			note: d.note,
			validFrom: d.date,
		},
		user,
		now,
	);
}

/** Why a price history row cannot be deleted: only a standard cost or supplier price that is not the current one can. */
export type PriceDeleteRefusal = "not_found" | "price_not_deletable" | "price_is_current";

export type DeletablePrice = { id: number; validFrom: string; kind: PriceKind; supplierId: number | null };

/** True when the series (same part, kind and supplier) has a later row: a later date, or the same date and a later id. */
const hasLaterRow = (partId: number, row: DeletablePrice) =>
	sql`EXISTS (SELECT 1 FROM price_history AS later WHERE later.part_id = ${partId} AND later.kind = ${row.kind} AND later.supplier_id IS ${row.supplierId} AND (later.valid_from > ${row.validFrom} OR (later.valid_from = ${row.validFrom} AND later.id > ${row.id})))`;

/**
 * The row to delete (D143): it must belong to that part, be a standard cost or a supplier price (a selling price
 * is not covered), and not be the latest row of its series, ordered by date then id like every reader does,
 * because that row is the current value: it is changed on the part's form.
 */
export async function checkPriceDelete(
	db: Db,
	partId: number,
	priceId: number,
): Promise<{ ok: true; row: DeletablePrice } | { ok: false; reason: PriceDeleteRefusal }> {
	const [row] = await db
		.select({
			id: priceHistory.id,
			validFrom: priceHistory.validFrom,
			kind: priceHistory.kind,
			supplierId: priceHistory.supplierId,
		})
		.from(priceHistory)
		.where(and(eq(priceHistory.id, priceId), eq(priceHistory.partId, partId)));
	if (!row) return { ok: false, reason: "not_found" };
	if (row.kind !== "standard" && row.kind !== "purchase") return { ok: false, reason: "price_not_deletable" };
	const [later] = await db
		.select({ id: priceHistory.id })
		.from(priceHistory)
		.where(and(eq(priceHistory.id, row.id), hasLaterRow(partId, row)));
	return later ? { ok: true, row } : { ok: false, reason: "price_is_current" };
}

/**
 * The delete for a row that passed checkPriceDelete. It repeats the "a later row exists" condition, so a row that
 * became the current one in the meantime is kept.
 */
export function priceDeleteStatement(db: Db, partId: number, row: DeletablePrice): Statement {
	return db
		.delete(priceHistory)
		.where(and(eq(priceHistory.id, row.id), eq(priceHistory.partId, partId), hasLaterRow(partId, row)));
}
