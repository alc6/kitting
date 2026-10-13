// Supplier offers: one row per (part, supplier) with the supplier's reference, price and ordering terms.
// The preferred offer is the part's supplier_id; it drives shortages and draft POs.
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { type PartSupplier, type PriceSource, partSuppliers, parts, suppliers } from "../db/schema";
import type { Statement } from "../lib/db";
import { formatCentsInput, formatQtyInput, type NumberLocale } from "../lib/units";
import { field } from "../lib/validation";
import type { Db } from "../types";
import { priceRecordForRefStatement, priceRecordStatement } from "./prices";

export type OfferTerms = {
	supplierRef: string;
	priceCents: number | null;
	moqMilli: number;
	packSizeMilli: number;
	leadDays: number;
	notes: string;
};

export const NO_TERMS: OfferTerms = {
	supplierRef: "",
	priceCents: null,
	moqMilli: 0,
	packSizeMilli: 0,
	leadDays: 0,
	notes: "",
};

export const offerInput = z.object({
	supplier_id: field.id(),
	supplier_ref: field.text(100),
	price: field.money(),
	moq: field.qty(),
	pack_size: field.qty(),
	lead_days: field.int(),
	notes: field.text(),
	preferred: field.bool(),
	/** Also make this price the part's standard cost (D99). Not stored on the offer. */
	set_standard_cost: field.bool(),
});
export type OfferInput = z.output<typeof offerInput>;

export function offerTerms(d: OfferInput): OfferTerms {
	return {
		supplierRef: d.supplier_ref,
		priceCents: d.price,
		moqMilli: d.moq,
		packSizeMilli: d.pack_size,
		leadDays: d.lead_days,
		notes: d.notes,
	};
}

export function offerToForm(o: PartSupplier, preferred: boolean, locale: NumberLocale): Record<string, string> {
	return {
		supplier_id: String(o.supplierId),
		supplier_ref: o.supplierRef,
		price: o.priceCents === null ? "" : formatCentsInput(o.priceCents, locale),
		moq: o.moqMilli ? formatQtyInput(o.moqMilli, locale) : "",
		pack_size: o.packSizeMilli ? formatQtyInput(o.packSizeMilli, locale) : "",
		lead_days: o.leadDays ? String(o.leadDays) : "",
		notes: o.notes,
		preferred: preferred ? "on" : "",
		set_standard_cost: "",
	};
}

/** Offers of a part, preferred first, with supplier names. */
export async function partOffers(db: Db, partId: number) {
	const rows = await db
		.select({ offer: partSuppliers, supplierName: suppliers.name, preferredId: parts.supplierId })
		.from(partSuppliers)
		.innerJoin(suppliers, eq(partSuppliers.supplierId, suppliers.id))
		.innerJoin(parts, eq(partSuppliers.partId, parts.id))
		.where(eq(partSuppliers.partId, partId))
		.orderBy(asc(suppliers.name));
	return rows
		.map((r) => ({ ...r.offer, supplierName: r.supplierName, preferred: r.preferredId === r.offer.supplierId }))
		.sort((a, b) => Number(b.preferred) - Number(a.preferred));
}
export type PartOffer = Awaited<ReturnType<typeof partOffers>>[number];

export async function getOffer(db: Db, partId: number, supplierId: number) {
	const [row] = await db
		.select()
		.from(partSuppliers)
		.where(and(eq(partSuppliers.partId, partId), eq(partSuppliers.supplierId, supplierId)));
	return row;
}

/** Parts a supplier offers, with whether it is their preferred supplier. */
export async function supplierOffers(db: Db, supplierId: number) {
	return db
		.select({
			offer: partSuppliers,
			partId: parts.id,
			ref: parts.ref,
			name: parts.name,
			kind: parts.kind,
			unit: parts.unit,
			costCents: parts.costCents,
			archived: parts.archived,
			preferred: sql<number>`${parts.supplierId} = ${partSuppliers.supplierId}`,
		})
		.from(partSuppliers)
		.innerJoin(parts, eq(partSuppliers.partId, parts.id))
		.where(eq(partSuppliers.supplierId, supplierId))
		.orderBy(asc(parts.ref));
}

/** Terms of every part's preferred offer, for the shortage engine and draft POs. */
export async function preferredTerms(db: Db): Promise<Map<number, OfferTerms>> {
	const rows = await db
		.select({ partId: partSuppliers.partId, offer: partSuppliers })
		.from(partSuppliers)
		.innerJoin(parts, and(eq(parts.id, partSuppliers.partId), eq(parts.supplierId, partSuppliers.supplierId)));
	return new Map(rows.map((r) => [r.partId, r.offer]));
}

/** All offers by part (for choosing another supplier on the shortage list). */
export async function offersByPart(db: Db) {
	const rows = await db
		.select({ offer: partSuppliers, supplierName: suppliers.name })
		.from(partSuppliers)
		.innerJoin(suppliers, eq(partSuppliers.supplierId, suppliers.id))
		.orderBy(asc(suppliers.name));
	const map = new Map<number, (PartSupplier & { supplierName: string })[]>();
	for (const r of rows) {
		const list = map.get(r.offer.partId) ?? [];
		list.push({ ...r.offer, supplierName: r.supplierName });
		map.set(r.offer.partId, list);
	}
	return map;
}

/** Unit price for a PO line: the supplier's offer price, else the part's standard cost, else 0. */
export function poUnitPrice(offerPriceCents: number | null | undefined, standardCents: number | null): number {
	return offerPriceCents ?? standardCents ?? 0;
}

const termColumns = (t: OfferTerms) => ({
	supplierRef: t.supplierRef,
	priceCents: t.priceCents,
	moqMilli: t.moqMilli,
	packSizeMilli: t.packSizeMilli,
	leadDays: t.leadDays,
	notes: t.notes,
});

/**
 * Statements that create or update the offer of `supplierId` for a part, and log its price when it
 * changes. `previous` is the current offer (undefined when there is none). Pass `partRef` instead of
 * `partId` for a part created in the same batch.
 */
export function saveOfferStatements(
	db: Db,
	target: { partId: number } | { partRef: string },
	supplierId: number,
	terms: OfferTerms,
	previous: Pick<PartSupplier, "priceCents"> | undefined,
	source: PriceSource,
	user: string,
	now: string,
): Statement[] {
	const stmts: Statement[] = [];
	const audit = { updatedAt: now, updatedBy: user };
	if ("partId" in target) {
		stmts.push(
			db
				.insert(partSuppliers)
				.values({ partId: target.partId, supplierId, ...termColumns(terms), ...audit, createdAt: now, createdBy: user })
				.onConflictDoUpdate({
					target: [partSuppliers.partId, partSuppliers.supplierId],
					set: { ...termColumns(terms), ...audit },
				}),
		);
	} else {
		// INSERT ... SELECT over every column of part_suppliers, in table order (id is assigned).
		stmts.push(
			db.insert(partSuppliers).select(sql`
				SELECT NULL, id, ${supplierId}, ${terms.supplierRef}, ${terms.priceCents}, ${terms.moqMilli},
					${terms.packSizeMilli}, ${terms.leadDays}, ${terms.notes}, ${now}, ${now}, ${user}, ${user}
				FROM parts WHERE ref = ${target.partRef}`),
		);
	}
	const priceChanged = previous ? previous.priceCents !== terms.priceCents : terms.priceCents !== null;
	if (priceChanged) {
		const record = { kind: "purchase" as const, priceCents: terms.priceCents, supplierId, source };
		stmts.push(
			"partId" in target
				? priceRecordStatement(db, { ...record, partId: target.partId }, user, now)
				: priceRecordForRefStatement(db, target.partRef, record, user, now),
		);
	}
	return stmts;
}

/** Makes `supplierId` (or nobody) the preferred supplier of a part. */
export function setPreferredStatement(db: Db, partId: number, supplierId: number | null, user: string, now: string) {
	return db.update(parts).set({ supplierId, updatedAt: now, updatedBy: user }).where(eq(parts.id, partId));
}

/** Removes an offer; if it was the preferred one, the part has no preferred supplier any more. */
export function deleteOfferStatements(db: Db, partId: number, supplierId: number, user: string, now: string) {
	return [
		db
			.update(parts)
			.set({ supplierId: null, updatedAt: now, updatedBy: user })
			.where(and(eq(parts.id, partId), eq(parts.supplierId, supplierId))),
		db.delete(partSuppliers).where(and(eq(partSuppliers.partId, partId), eq(partSuppliers.supplierId, supplierId))),
	];
}
