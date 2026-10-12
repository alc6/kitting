import { and, asc, eq, ne, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import {
	boms,
	PART_KINDS,
	type Part,
	type PartKind,
	type PriceSource,
	partSuppliers,
	parts,
	stockMoves,
	suppliers,
} from "../db/schema";
import type { Statement } from "../lib/db";
import { likePattern } from "../lib/sql";
import { formatCentsInput, formatQtyInput, type NumberLocale } from "../lib/units";
import { type FieldErrors, field } from "../lib/validation";
import type { Db } from "../types";
import { NO_TERMS, type OfferTerms, saveOfferStatements } from "./offers";
import { priceRecordForRefStatement, priceRecordStatement } from "./prices";

export const partInput = z.object({
	ref: field.ref(),
	name: field.required(200),
	kind: field.oneOf(PART_KINDS, "invalid_kind"),
	unit: field.text(20).transform((v) => v || "pcs"),
	cost: field.money(),
	sale_price: field.money(),
	supplier_id: field.id(),
	supplier_ref: field.text(100),
	moq: field.qty(),
	pack_size: field.qty(),
	lead_days: field.int(),
	track_serial: field.bool(),
	notes: field.text(),
});
export type PartInput = z.output<typeof partInput>;

/** Maps validated input to parts columns (the supplier terms go to the preferred offer). */
export function partColumns(d: PartInput) {
	return {
		ref: d.ref,
		name: d.name,
		kind: d.kind,
		unit: d.unit,
		costCents: d.cost,
		salePriceCents: d.sale_price,
		supplierId: d.supplier_id,
		trackSerial: d.track_serial,
		notes: d.notes,
	};
}

/** The preferred supplier's terms entered with the part (form or parts.csv). Price and notes are kept. */
export function preferredOfferTerms(d: PartInput, previous: OfferTerms | undefined): OfferTerms {
	return {
		supplierRef: d.supplier_ref,
		moqMilli: d.moq,
		packSizeMilli: d.pack_size,
		leadDays: d.lead_days,
		priceCents: previous?.priceCents ?? null,
		notes: previous?.notes ?? "",
	};
}

/** Form values of a part; the supplier terms come from its preferred offer. */
export function partToForm(p: Part, locale: NumberLocale, offer?: OfferTerms): Record<string, string> {
	const o = offer ?? NO_TERMS;
	return {
		ref: p.ref,
		name: p.name,
		kind: p.kind,
		unit: p.unit,
		cost: p.costCents === null ? "" : formatCentsInput(p.costCents, locale),
		sale_price: p.salePriceCents === null ? "" : formatCentsInput(p.salePriceCents, locale),
		supplier_id: p.supplierId === null ? "" : String(p.supplierId),
		supplier_ref: o.supplierRef,
		moq: o.moqMilli ? formatQtyInput(o.moqMilli, locale) : "",
		pack_size: o.packSizeMilli ? formatQtyInput(o.packSizeMilli, locale) : "",
		lead_days: o.leadDays ? String(o.leadDays) : "",
		track_serial: p.trackSerial ? "on" : "",
		notes: p.notes,
	};
}

/**
 * Statements that save a part from the form or parts.csv, in one batch: the part, its preferred offer
 * (created or updated with the terms entered), and a price_history row for each price that changed.
 * `previous` is the current part and its preferred offer; omit it to create the part.
 */
export function savePartStatements(
	db: Db,
	d: PartInput,
	previous: { part: Part; offer: OfferTerms | undefined } | undefined,
	source: PriceSource,
	user: string,
	now: string,
): Statement[] {
	const cols = partColumns(d);
	const stmts: Statement[] = [];
	if (previous) {
		stmts.push(
			db
				.update(parts)
				.set({ ...cols, updatedAt: now, updatedBy: user })
				.where(eq(parts.id, previous.part.id)),
		);
	} else {
		stmts.push(db.insert(parts).values({ ...cols, createdBy: user, updatedBy: user, createdAt: now, updatedAt: now }));
	}
	const target = previous ? { partId: previous.part.id } : { partRef: d.ref };
	const log = (kind: "standard" | "sale", priceCents: number | null) =>
		previous
			? priceRecordStatement(db, { partId: previous.part.id, kind, priceCents, source }, user, now)
			: priceRecordForRefStatement(db, d.ref, { kind, priceCents, source }, user, now);
	if (previous ? previous.part.costCents !== cols.costCents : cols.costCents !== null)
		stmts.push(log("standard", cols.costCents));
	if (previous ? previous.part.salePriceCents !== cols.salePriceCents : cols.salePriceCents !== null)
		stmts.push(log("sale", cols.salePriceCents));
	if (cols.supplierId !== null) {
		// The offer of the supplier now preferred (it may differ from the previous preferred one).
		const prevOffer = previous && previous.part.supplierId === cols.supplierId ? previous.offer : undefined;
		const terms = preferredOfferTerms(d, prevOffer);
		const changed =
			!prevOffer ||
			prevOffer.supplierRef !== terms.supplierRef ||
			prevOffer.moqMilli !== terms.moqMilli ||
			prevOffer.packSizeMilli !== terms.packSizeMilli ||
			prevOffer.leadDays !== terms.leadDays;
		if (changed) stmts.push(...saveOfferStatements(db, target, cols.supplierId, terms, prevOffer, source, user, now));
	}
	return stmts;
}

/** Statements setting a part's standard cost (e.g. from its weighted average or an offer), logged in the history. */
export function setStandardCostStatements(
	db: Db,
	part: Pick<Part, "id" | "costCents">,
	costCents: number | null,
	source: PriceSource,
	user: string,
	now: string,
	note = "",
): Statement[] {
	if (part.costCents === costCents) return [];
	return [
		db.update(parts).set({ costCents, updatedAt: now, updatedBy: user }).where(eq(parts.id, part.id)),
		priceRecordStatement(db, { partId: part.id, kind: "standard", priceCents: costCents, source, note }, user, now),
	];
}

/** Business rules shared by the form and the CSV import. Returns field -> error key. */
export function partRuleErrors(
	d: { kind: PartKind; trackSerial: boolean },
	ctx: { hasMoves: boolean; hasBoms?: boolean },
): FieldErrors {
	const errors: FieldErrors = {};
	if (d.trackSerial && (d.kind === "kit" || d.kind === "fee")) errors.track_serial = "serial_kind";
	if (ctx.hasMoves && (d.kind === "kit" || d.kind === "fee")) errors.kind = "kind_has_stock";
	if (ctx.hasBoms && d.kind !== "make" && d.kind !== "kit") errors.kind = "kind_has_boms";
	return errors;
}

export async function hasBoms(db: Db, partId: number): Promise<boolean> {
	const rows = await db.select({ id: boms.id }).from(boms).where(eq(boms.parentPartId, partId)).limit(1);
	return rows.length > 0;
}

export const onHandSql = sql<number>`(SELECT COALESCE(SUM(sm.qty_milli), 0) FROM stock_moves sm WHERE sm.part_id = ${parts.id})`;

export type PartFilters = { q?: string; kind?: string; supplierId?: number | null; archived?: boolean };

export async function listParts(db: Db, f: PartFilters = {}) {
	const conds: SQL[] = [];
	if (f.q) {
		const like = likePattern(f.q);
		conds.push(
			sql`(${parts.ref} LIKE ${like} ESCAPE '\\' OR ${parts.name} LIKE ${like} ESCAPE '\\' OR ${parts.supplierRef} LIKE ${like} ESCAPE '\\')`,
		);
	}
	if (f.kind && (PART_KINDS as readonly string[]).includes(f.kind)) conds.push(eq(parts.kind, f.kind as PartKind));
	if (f.supplierId) conds.push(eq(parts.supplierId, f.supplierId));
	if (!f.archived) conds.push(eq(parts.archived, false));
	return db
		.select({
			id: parts.id,
			ref: parts.ref,
			name: parts.name,
			kind: parts.kind,
			unit: parts.unit,
			costCents: parts.costCents,
			// MOQ of the preferred offer (0 without one), for the below-MOQ alerts.
			moqMilli: sql<number>`COALESCE(${partSuppliers.moqMilli}, 0)`,
			trackSerial: parts.trackSerial,
			archived: parts.archived,
			supplierId: parts.supplierId,
			supplierName: suppliers.name,
			onHandMilli: onHandSql,
		})
		.from(parts)
		.leftJoin(suppliers, eq(parts.supplierId, suppliers.id))
		.leftJoin(partSuppliers, and(eq(partSuppliers.partId, parts.id), eq(partSuppliers.supplierId, parts.supplierId)))
		.where(conds.length ? and(...conds) : undefined)
		.orderBy(asc(parts.ref))
		.limit(2000);
}

export async function getPart(db: Db, id: number) {
	const rows = await db.select().from(parts).where(eq(parts.id, id)).limit(1);
	return rows[0];
}

/** Another part whose ref equals `ref` ignoring case (exact duplicates included). */
export async function findRefClash(db: Db, ref: string, excludeId?: number) {
	const conds: SQL[] = [sql`lower(${parts.ref}) = lower(${ref})`];
	if (excludeId) conds.push(ne(parts.id, excludeId));
	const rows = await db
		.select({ id: parts.id, ref: parts.ref })
		.from(parts)
		.where(and(...conds))
		.limit(1);
	return rows[0];
}

export async function hasStockMoves(db: Db, partId: number): Promise<boolean> {
	const rows = await db.select({ id: stockMoves.id }).from(stockMoves).where(eq(stockMoves.partId, partId)).limit(1);
	return rows.length > 0;
}

export async function onHandOf(db: Db, partId: number): Promise<number> {
	const rows = await db
		.select({ qty: sql<number>`COALESCE(SUM(${stockMoves.qtyMilli}), 0)` })
		.from(stockMoves)
		.where(eq(stockMoves.partId, partId));
	return rows[0]?.qty ?? 0;
}

/** On-hand quantity for every part that has moves. */
export async function onHandMap(db: Db): Promise<Map<number, number>> {
	const rows = await db
		.select({ partId: stockMoves.partId, qty: sql<number>`SUM(${stockMoves.qtyMilli})` })
		.from(stockMoves)
		.groupBy(stockMoves.partId);
	return new Map(rows.map((r) => [r.partId, r.qty]));
}

/** Options for part pickers: active parts, optionally restricted to some kinds. */
export async function partOptions(db: Db, kinds?: PartKind[]) {
	const rows = await db
		.select({ id: parts.id, ref: parts.ref, name: parts.name, kind: parts.kind, unit: parts.unit })
		.from(parts)
		.where(eq(parts.archived, false))
		.orderBy(asc(parts.ref));
	return kinds ? rows.filter((r) => kinds.includes(r.kind)) : rows;
}
