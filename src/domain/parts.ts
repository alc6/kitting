import { and, asc, eq, ne, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { PART_KINDS, type Part, type PartKind, parts, stockMoves, suppliers } from "../db/schema";
import { likePattern } from "../lib/sql";
import { formatCentsInput, formatQtyInput, type NumberLocale } from "../lib/units";
import { type FieldErrors, field } from "../lib/validation";
import type { Db } from "../types";

export const partInput = z.object({
	ref: field.ref(),
	name: field.required(200),
	kind: field.oneOf(PART_KINDS, "invalid_kind"),
	unit: field.text(20).transform((v) => v || "pcs"),
	cost: field.money(),
	supplier_id: field.id(),
	supplier_ref: field.text(100),
	moq: field.qty(),
	pack_size: field.qty(),
	lead_days: field.int(),
	track_serial: field.bool(),
	notes: field.text(),
});
export type PartInput = z.output<typeof partInput>;

/** Maps validated input to table columns. */
export function partColumns(d: PartInput) {
	return {
		ref: d.ref,
		name: d.name,
		kind: d.kind,
		unit: d.unit,
		costCents: d.cost,
		supplierId: d.supplier_id,
		supplierRef: d.supplier_ref,
		moqMilli: d.moq,
		packSizeMilli: d.pack_size,
		leadDays: d.lead_days,
		trackSerial: d.track_serial,
		notes: d.notes,
	};
}

export function partToForm(p: Part, locale: NumberLocale): Record<string, string> {
	return {
		ref: p.ref,
		name: p.name,
		kind: p.kind,
		unit: p.unit,
		cost: p.costCents === null ? "" : formatCentsInput(p.costCents, locale),
		supplier_id: p.supplierId === null ? "" : String(p.supplierId),
		supplier_ref: p.supplierRef,
		moq: p.moqMilli ? formatQtyInput(p.moqMilli, locale) : "",
		pack_size: p.packSizeMilli ? formatQtyInput(p.packSizeMilli, locale) : "",
		lead_days: p.leadDays ? String(p.leadDays) : "",
		track_serial: p.trackSerial ? "on" : "",
		notes: p.notes,
	};
}

/** Business rules shared by the form and the CSV import. Returns field -> error key. */
export function partRuleErrors(d: { kind: PartKind; trackSerial: boolean }, ctx: { hasMoves: boolean }): FieldErrors {
	const errors: FieldErrors = {};
	if (d.trackSerial && (d.kind === "kit" || d.kind === "fee")) errors.track_serial = "serial_kind";
	if (ctx.hasMoves && (d.kind === "kit" || d.kind === "fee")) errors.kind = "kind_has_stock";
	return errors;
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
			moqMilli: parts.moqMilli,
			trackSerial: parts.trackSerial,
			archived: parts.archived,
			supplierId: parts.supplierId,
			supplierName: suppliers.name,
			onHandMilli: onHandSql,
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
