import { and, asc, eq, ne, sql } from "drizzle-orm";
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
			// Names the outer table explicitly: in a select without joins Drizzle renders ${suppliers.id} unqualified,
			// which inside the subquery would mean parts.id.
			partCount: sql<number>`(SELECT count(*) FROM parts WHERE parts.supplier_id = suppliers.id AND parts.archived = 0)`,
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

/** Whether another supplier has this name, ignoring case (the form and the MCP tools refuse duplicates). */
export async function supplierNameTaken(db: Db, name: string, exceptId?: number): Promise<boolean> {
	const same = sql`lower(${suppliers.name}) = lower(${name.trim()})`;
	const rows = await db
		.select({ id: suppliers.id })
		.from(suppliers)
		.where(exceptId ? and(same, ne(suppliers.id, exceptId)) : same)
		.limit(1);
	return rows.length > 0;
}

export async function getSupplier(db: Db, id: number) {
	const rows = await db.select().from(suppliers).where(eq(suppliers.id, id)).limit(1);
	return rows[0];
}

// ---------------------------------------------------------------------------
// Writes: statements to run in one change set (see runChangeSet in ./history.ts).

export function createSupplierStatement(db: Db, d: SupplierInput, user: string, now: string) {
	return db
		.insert(suppliers)
		.values({ ...d, createdBy: user, updatedBy: user, createdAt: now, updatedAt: now })
		.returning({ id: suppliers.id });
}

export function updateSupplierStatement(db: Db, id: number, d: SupplierInput, user: string, now: string) {
	return db
		.update(suppliers)
		.set({ ...d, updatedAt: now, updatedBy: user })
		.where(eq(suppliers.id, id));
}

/** Fails with a FOREIGN KEY error while parts, offers or POs use the supplier. */
export function deleteSupplierStatement(db: Db, id: number) {
	return db.delete(suppliers).where(eq(suppliers.id, id));
}
