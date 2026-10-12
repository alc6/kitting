import { asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { type Supplier, suppliers } from "../db/schema";
import { likePattern } from "../lib/sql";
import { field } from "../lib/validation";
import type { Db } from "../types";

export const supplierInput = z.object({
	name: field.required(200),
	email: field.email(),
	phone: field.text(50),
	notes: field.text(),
});
export type SupplierInput = z.output<typeof supplierInput>;

export function supplierToForm(s: Supplier): Record<string, string> {
	return { name: s.name, email: s.email, phone: s.phone, notes: s.notes };
}

export async function listSuppliers(db: Db, q = "") {
	const where = q
		? sql`(${suppliers.name} LIKE ${likePattern(q)} ESCAPE '\\' OR ${suppliers.email} LIKE ${likePattern(q)} ESCAPE '\\')`
		: undefined;
	return db
		.select({
			id: suppliers.id,
			name: suppliers.name,
			email: suppliers.email,
			phone: suppliers.phone,
			partCount: sql<number>`(SELECT count(*) FROM parts WHERE parts.supplier_id = ${suppliers.id} AND parts.archived = 0)`,
		})
		.from(suppliers)
		.where(where)
		.orderBy(asc(suppliers.name))
		.limit(1000);
}

/** Case-insensitive lookup by name (used for uniqueness checks and CSV matching). */
export async function findSupplierByName(db: Db, name: string) {
	const rows = await db.select().from(suppliers).where(sql`lower(${suppliers.name}) = lower(${name.trim()})`).limit(1);
	return rows[0];
}

export async function getSupplier(db: Db, id: number) {
	const rows = await db.select().from(suppliers).where(eq(suppliers.id, id)).limit(1);
	return rows[0];
}
