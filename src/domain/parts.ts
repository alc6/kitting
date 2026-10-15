import { and, asc, eq, ne, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import {
	assemblies,
	PART_KINDS,
	type Part,
	type PartKind,
	type PriceSource,
	parts,
	stockMoves,
	suppliers,
} from "../db/schema";
import type { Statement } from "../lib/db";
import { likePattern } from "../lib/sql";
import { formatCentsInput, formatQtyInput, type NumberLocale } from "../lib/units";
import { type FieldErrors, field, validate } from "../lib/validation";
import type { Db } from "../types";
import {
	NO_TERMS,
	type OfferInput,
	type OfferTerms,
	offerTerms,
	saveOfferStatements,
	setPreferredStatement,
} from "./offers";
import { optionsOf } from "./options";
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
	min_stock: field.optionalQty(),
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
		minStockMilli: d.min_stock,
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
		min_stock: p.minStockMilli === null ? "" : formatQtyInput(p.minStockMilli, locale),
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

/** Statements setting a part's selling price (null: none), logged in the price history like the part form does. */
export function setSalePriceStatements(
	db: Db,
	part: Pick<Part, "id" | "salePriceCents">,
	priceCents: number | null,
	source: PriceSource,
	user: string,
	now: string,
	note = "",
): Statement[] {
	if (part.salePriceCents === priceCents) return [];
	return [
		db.update(parts).set({ salePriceCents: priceCents, updatedAt: now, updatedBy: user }).where(eq(parts.id, part.id)),
		priceRecordStatement(db, { partId: part.id, kind: "sale", priceCents, source, note }, user, now),
	];
}

/**
 * Statements saving a supplier offer from the offer form or an MCP tool: the offer (its price logged when it
 * changes; `previous` is the current offer, undefined to create it), the preferred supplier when `preferred` is
 * set (clearing it never unsets the preferred supplier), and the part's standard cost when `set_standard_cost`
 * (D99), noted with `standardNote`.
 */
export function offerFormStatements(
	db: Db,
	part: Pick<Part, "id" | "supplierId" | "costCents">,
	supplierId: number,
	d: OfferInput,
	previous: OfferTerms | undefined,
	standardNote: string,
	user: string,
	now: string,
): Statement[] {
	const stmts = saveOfferStatements(db, { partId: part.id }, supplierId, offerTerms(d), previous, "form", user, now);
	if (d.preferred && part.supplierId !== supplierId)
		stmts.push(setPreferredStatement(db, part.id, supplierId, user, now));
	if (d.set_standard_cost && d.price !== null)
		stmts.push(...setStandardCostStatements(db, part, d.price, "form", user, now, standardNote));
	return stmts;
}

/** Archives a part (hidden from pickers and lists) or brings it back. */
export function archivePartStatement(db: Db, partId: number, archived: boolean, user: string, now: string) {
	return db.update(parts).set({ archived, updatedAt: now, updatedBy: user }).where(eq(parts.id, partId));
}

/** Deletes a part with its offers; fails with a FOREIGN KEY error while assemblies, moves, POs or builds use it. */
export function deletePartStatement(db: Db, partId: number) {
	return db.delete(parts).where(eq(parts.id, partId));
}

/** Business rules shared by the form and the CSV import. Returns field -> error key. */
export function partRuleErrors(
	d: { kind: PartKind; trackSerial: boolean; minStockMilli?: number | null },
	ctx: { hasMoves: boolean; hasAssemblies?: boolean; hasOptions?: boolean },
): FieldErrors {
	const errors: FieldErrors = {};
	if (d.trackSerial && (d.kind === "kit" || d.kind === "fee")) errors.track_serial = "serial_kind";
	if (d.minStockMilli != null && (d.kind === "kit" || d.kind === "fee")) errors.min_stock = "min_stock_kind";
	if (ctx.hasMoves && (d.kind === "kit" || d.kind === "fee")) errors.kind = "kind_has_stock";
	if (ctx.hasAssemblies && d.kind !== "make" && d.kind !== "kit") errors.kind = "kind_has_assemblies";
	// Only stocked parts come in values (D168).
	if (ctx.hasOptions && d.kind !== "buy" && d.kind !== "make") errors.kind = "kind_has_options";
	return errors;
}

/**
 * Validates a part as the form and the MCP tools do (string values, as posted): the fields, a reference unique
 * ignoring case, and the kind/serial rules against the existing part's stock and assemblies. `clashRef` is the other
 * part's reference, for the ref_case message.
 */
export async function checkPart(db: Db, body: Record<string, unknown>, existing?: Pick<Part, "id">) {
	const result = validate(partInput, body);
	if (!result.ok) return { ok: false as const, errors: result.errors, clashRef: undefined };
	const d = result.data;
	const errors: FieldErrors = {};
	const clash = await findRefClash(db, d.ref, existing?.id);
	if (clash) errors.ref = clash.ref === d.ref ? "duplicate_ref" : "ref_case";
	const hasMoves = existing ? await hasStockMoves(db, existing.id) : false;
	const ownsAssemblies = existing ? await hasAssemblies(db, existing.id) : false;
	const hasOptions = existing ? (await optionsOf(db, existing.id)).length > 0 : false;
	Object.assign(
		errors,
		partRuleErrors(
			{ kind: d.kind, trackSerial: d.track_serial, minStockMilli: d.min_stock },
			{ hasMoves, hasAssemblies: ownsAssemblies, hasOptions },
		),
	);
	if (Object.keys(errors).length > 0) return { ok: false as const, errors, clashRef: clash?.ref };
	return { ok: true as const, data: d };
}

export async function hasAssemblies(db: Db, partId: number): Promise<boolean> {
	const rows = await db
		.select({ id: assemblies.id })
		.from(assemblies)
		.where(eq(assemblies.parentPartId, partId))
		.limit(1);
	return rows.length > 0;
}

// Names the outer table explicitly: a select without joins would render ${parts.id} unqualified, as sm.id.
export const onHandSql = sql<number>`(SELECT COALESCE(SUM(sm.qty_milli), 0) FROM stock_moves sm WHERE sm.part_id = parts.id)`;

export type PartFilters = { q?: string; kind?: string; supplierId?: number | null; archived?: boolean };

export async function listParts(db: Db, f: PartFilters = {}) {
	const conds: SQL[] = [];
	if (f.q) {
		const like = likePattern(f.q);
		conds.push(
			// Supplier references live on the offers (D90): any supplier's reference matches.
			sql`(${parts.ref} LIKE ${like} ESCAPE '\\' OR ${parts.name} LIKE ${like} ESCAPE '\\' OR EXISTS (
				SELECT 1 FROM part_suppliers ps WHERE ps.part_id = ${parts.id} AND ps.supplier_ref LIKE ${like} ESCAPE '\\'))`,
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
			// Minimum stock (D173), for the stock alerts.
			minStockMilli: parts.minStockMilli,
			trackSerial: parts.trackSerial,
			archived: parts.archived,
			supplierId: parts.supplierId,
			supplierName: suppliers.name,
			onHandMilli: onHandSql,
			imageKey: parts.imageKey,
		})
		.from(parts)
		.leftJoin(suppliers, eq(parts.supplierId, suppliers.id))
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
