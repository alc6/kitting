// Part picker (D138): the search behind the "Browse" dialog of the forms that pick a part. One query per page of
// results (count + 20 rows), filtered and ordered in SQL. The forms keep their own rules (stock adjustments and
// purchase orders take stocked parts, a new assembly a make or kit part, an assembly line anything but its own product):
// each form passes the same restriction to the picker so it never offers a part the form then rejects.
import { and, asc, eq, inArray, ne, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { PART_KINDS, type PartKind, parts, suppliers } from "../db/schema";
import { escapeLike, likePattern } from "../lib/sql";
import { field, validate } from "../lib/validation";
import type { Db } from "../types";
import { onHandSql } from "./parts";

export const PICKER_PAGE_SIZE = 20;

const kindList = z
	.string()
	.trim()
	.transform((v) => (v === "" ? [] : v.split(",").map((k) => k.trim().toLowerCase())))
	.refine((list) => list.every((k) => (PART_KINDS as readonly string[]).includes(k)), "invalid_kind")
	.transform((list) => [...new Set(list)] as PartKind[]);

export const pickerInput = z.object({
	q: field.text(100),
	/** 1-based; empty means the first page, anything beyond the last is clamped by the search. */
	page: z
		.string()
		.trim()
		.refine((v) => v === "" || (/^\d{1,9}$/.test(v) && Number(v) >= 1), "invalid")
		.transform((v) => (v === "" ? 1 : Number(v))),
	/** The kinds the form accepts (comma separated). Empty means every kind. */
	kinds: kindList,
	/** The kind chosen in the dialog, within `kinds`. Empty means all of them. */
	kind: z
		.string()
		.trim()
		.refine((v) => v === "" || (PART_KINDS as readonly string[]).includes(v.toLowerCase()), "invalid_kind")
		.transform((v) => (v === "" ? null : (v.toLowerCase() as PartKind))),
	/** A part id the form refuses (an assembly's own product). */
	exclude: field.id(),
});

export type PickerQuery = z.output<typeof pickerInput>;

export const validatePickerQuery = (input: Record<string, unknown>) => validate(pickerInput, input);

export type PickerRow = {
	id: number;
	ref: string;
	name: string;
	kind: PartKind;
	unit: string;
	imageKey: string | null;
	supplierName: string | null;
	onHandMilli: number;
};

export type PickerPage = { rows: PickerRow[]; total: number; page: number; pages: number };

/** Kinds the search may return: the form's, narrowed to the chosen one when that is one of them. */
export function pickerKinds(q: Pick<PickerQuery, "kinds" | "kind">): PartKind[] {
	const allowed = q.kinds.length > 0 ? q.kinds : [...PART_KINDS];
	return q.kind && allowed.includes(q.kind) ? [q.kind] : allowed;
}

/**
 * Active parts matching the text in their reference or name (case-insensitive, contains). Ordered by exact
 * reference, then reference prefix, then reference. `page` past the end gives the last page.
 */
export async function searchPickerParts(db: Db, query: PickerQuery): Promise<PickerPage> {
	const conds: SQL[] = [eq(parts.archived, false), inArray(parts.kind, pickerKinds(query))];
	if (query.exclude !== null) conds.push(ne(parts.id, query.exclude));
	const text = query.q.trim();
	if (text) {
		const like = likePattern(text);
		conds.push(sql`(${parts.ref} LIKE ${like} ESCAPE '\\' OR ${parts.name} LIKE ${like} ESCAPE '\\')`);
	}
	const where = and(...conds);

	const counted = await db.select({ n: sql<number>`count(*)` }).from(parts).where(where);
	const total = counted[0]?.n ?? 0;
	const pages = Math.max(1, Math.ceil(total / PICKER_PAGE_SIZE));
	const page = Math.min(query.page, pages);

	// Without text there is nothing to rank (and a bare constant in ORDER BY would be a column position).
	const order = text
		? [
				sql`CASE WHEN lower(${parts.ref}) = lower(${text}) THEN 0
					WHEN ${parts.ref} LIKE ${`${escapeLike(text)}%`} ESCAPE '\\' THEN 1 ELSE 2 END`,
				asc(parts.ref),
			]
		: [asc(parts.ref)];
	const rows = await db
		.select({
			id: parts.id,
			ref: parts.ref,
			name: parts.name,
			kind: parts.kind,
			unit: parts.unit,
			imageKey: parts.imageKey,
			supplierName: suppliers.name,
			onHandMilli: onHandSql,
		})
		.from(parts)
		.leftJoin(suppliers, eq(parts.supplierId, suppliers.id))
		.where(where)
		.orderBy(...order)
		.limit(PICKER_PAGE_SIZE)
		.offset((page - 1) * PICKER_PAGE_SIZE);
	return { rows, total, page, pages };
}
