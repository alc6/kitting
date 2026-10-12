import { and, asc, eq, ne, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { BOM_STATUSES, type Bom, type BomStatus, bomLines, boms, parts } from "../db/schema";
import type { Statement } from "../lib/db";
import { likePattern } from "../lib/sql";
import { field, REF_PATTERN } from "../lib/validation";
import type { Db } from "../types";
import { type BomGraph, buildGraph, CostCalculator, defaultBom } from "./bom-graph";

export const bomInput = z.object({
	parent_part_id: field.id(),
	code: field.ref(),
	revision: field.ref(),
	notes: field.text(),
	copy_from: field.id(),
});

export const bomLineInput = z.object({
	component: field.required(64),
	qty: field.qty({ positive: true }),
	notes: field.text(500),
});

export const DEFAULT_CODE = "std";
export const DEFAULT_REVISION = "Rev1";

/** Loads every part, BoM and line into memory (the catalogue is small). */
export async function loadGraph(db: Db): Promise<BomGraph> {
	const [p, b, l] = await Promise.all([
		db
			.select({
				id: parts.id,
				ref: parts.ref,
				name: parts.name,
				kind: parts.kind,
				unit: parts.unit,
				costCents: parts.costCents,
				trackSerial: parts.trackSerial,
				archived: parts.archived,
			})
			.from(parts),
		db
			.select({
				id: boms.id,
				parentPartId: boms.parentPartId,
				code: boms.code,
				revision: boms.revision,
				status: boms.status,
			})
			.from(boms),
		db
			.select({
				id: bomLines.id,
				bomId: bomLines.bomId,
				componentPartId: bomLines.componentPartId,
				qtyMilli: bomLines.qtyMilli,
				position: bomLines.position,
				notes: bomLines.notes,
			})
			.from(bomLines),
	]);
	return buildGraph(p, b, l);
}

export type BomFilters = { q?: string; status?: string; partId?: number | null };

export async function listBoms(db: Db, f: BomFilters = {}) {
	const conds: SQL[] = [];
	if (f.q) {
		const like = likePattern(f.q);
		conds.push(
			sql`(${parts.ref} LIKE ${like} ESCAPE '\\' OR ${parts.name} LIKE ${like} ESCAPE '\\' OR ${boms.code} LIKE ${like} ESCAPE '\\')`,
		);
	}
	if (f.status === "all") {
		// no filter
	} else if (f.status && (BOM_STATUSES as readonly string[]).includes(f.status)) {
		conds.push(eq(boms.status, f.status as BomStatus));
	} else conds.push(ne(boms.status, "archived"));
	if (f.partId) conds.push(eq(boms.parentPartId, f.partId));
	return db
		.select({
			id: boms.id,
			code: boms.code,
			revision: boms.revision,
			status: boms.status,
			updatedAt: boms.updatedAt,
			partId: parts.id,
			partRef: parts.ref,
			partName: parts.name,
			partKind: parts.kind,
			lineCount: sql<number>`(SELECT count(*) FROM bom_lines bl WHERE bl.bom_id = ${boms.id})`,
		})
		.from(boms)
		.innerJoin(parts, eq(boms.parentPartId, parts.id))
		.where(conds.length ? and(...conds) : undefined)
		.orderBy(asc(parts.ref), asc(boms.code), asc(boms.revision))
		.limit(2000);
}

export async function getBom(db: Db, id: number) {
	const rows = await db
		.select({ bom: boms, part: parts })
		.from(boms)
		.innerJoin(parts, eq(boms.parentPartId, parts.id))
		.where(eq(boms.id, id))
		.limit(1);
	return rows[0];
}

export async function getBomLines(db: Db, bomId: number) {
	return db
		.select({
			id: bomLines.id,
			qtyMilli: bomLines.qtyMilli,
			position: bomLines.position,
			notes: bomLines.notes,
			partId: parts.id,
			ref: parts.ref,
			name: parts.name,
			kind: parts.kind,
			unit: parts.unit,
			archived: parts.archived,
		})
		.from(bomLines)
		.innerJoin(parts, eq(bomLines.componentPartId, parts.id))
		.where(eq(bomLines.bomId, bomId))
		.orderBy(asc(bomLines.position), asc(bomLines.id));
}

export async function findBom(db: Db, parentPartId: number, code: string, revision: string) {
	const rows = await db
		.select()
		.from(boms)
		.where(and(eq(boms.parentPartId, parentPartId), eq(boms.code, code), eq(boms.revision, revision)))
		.limit(1);
	return rows[0];
}

/**
 * True when adding `componentPartId` under `parentPartId` would create a cycle: the
 * component is the parent itself, or the parent is reachable from the component through
 * draft or active BoMs (recursive CTE).
 */
export async function wouldCreateCycle(db: Db, parentPartId: number, componentPartId: number): Promise<boolean> {
	if (parentPartId === componentPartId) return true;
	const rows = await db.all<{ hit: number }>(sql`
		WITH RECURSIVE down(part_id) AS (
			SELECT ${componentPartId}
			UNION
			SELECT l.component_part_id
			FROM down d
			JOIN boms b ON b.parent_part_id = d.part_id AND b.status != 'archived'
			JOIN bom_lines l ON l.bom_id = b.id
		)
		SELECT 1 AS hit FROM down WHERE part_id = ${parentPartId} LIMIT 1`);
	return rows.length > 0;
}

export type WhereUsedRow = {
	bomId: number;
	depth: number;
	qtyMilli: number;
	code: string;
	revision: string;
	status: BomStatus;
	parentId: number;
	parentRef: string;
	parentName: string;
	viaRef: string;
};

/**
 * Every draft/active BoM containing the part, directly (depth 1) or through
 * sub-assemblies and kits (depth > 1, `viaRef` = component of that BoM leading to the part).
 */
export async function whereUsed(db: Db, partId: number): Promise<WhereUsedRow[]> {
	const rows = await db.all<{
		bom_id: number;
		depth: number;
		qty_milli: number;
		code: string;
		revision: string;
		status: BomStatus;
		parent_id: number;
		parent_ref: string;
		parent_name: string;
		via_ref: string;
	}>(sql`
		WITH RECURSIVE used(bom_id, parent_part_id, via_part_id, qty_milli, depth) AS (
			SELECT b.id, b.parent_part_id, l.component_part_id, l.qty_milli, 1
			FROM bom_lines l
			JOIN boms b ON b.id = l.bom_id AND b.status != 'archived'
			WHERE l.component_part_id = ${partId}
			UNION
			SELECT b.id, b.parent_part_id, l.component_part_id, l.qty_milli, u.depth + 1
			FROM used u
			JOIN bom_lines l ON l.component_part_id = u.parent_part_id
			JOIN boms b ON b.id = l.bom_id AND b.status != 'archived'
			WHERE u.depth < 32
		)
		SELECT u.bom_id, u.depth, u.qty_milli, b.code, b.revision, b.status,
			p.id AS parent_id, p.ref AS parent_ref, p.name AS parent_name, v.ref AS via_ref
		FROM used u
		JOIN boms b ON b.id = u.bom_id
		JOIN parts p ON p.id = b.parent_part_id
		JOIN parts v ON v.id = u.via_part_id
		ORDER BY u.depth, p.ref, b.code, b.revision`);
	const seen = new Set<string>();
	const out: WhereUsedRow[] = [];
	for (const r of rows) {
		const key = `${r.bom_id}:${r.via_ref}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({
			bomId: r.bom_id,
			depth: r.depth,
			qtyMilli: r.qty_milli,
			code: r.code,
			revision: r.revision,
			status: r.status,
			parentId: r.parent_id,
			parentRef: r.parent_ref,
			parentName: r.parent_name,
			viaRef: r.via_ref,
		});
	}
	return out;
}

/** "Rev2" -> "Rev3", "A" -> "A-2"; skips labels already used by the part/code. */
export function nextRevision(current: string, taken: string[]): string {
	const used = new Set(taken);
	const m = /^(.*?)(\d+)$/.exec(current);
	let n = m ? Number(m[2]) + 1 : 2;
	const base = m ? (m[1] ?? "") : `${current}-`;
	let candidate = `${base}${n}`;
	while (used.has(candidate)) candidate = `${base}${++n}`;
	return candidate;
}

/** Statements that make `bom` the active BoM of its (parent, code), archiving the previous one. */
export function activateStatements(db: Db, bom: Bom, user: string, now: string): Statement[] {
	return [
		db
			.update(boms)
			.set({ status: "archived", updatedAt: now, updatedBy: user })
			.where(
				and(
					eq(boms.parentPartId, bom.parentPartId),
					eq(boms.code, bom.code),
					eq(boms.status, "active"),
					ne(boms.id, bom.id),
				),
			),
		db.update(boms).set({ status: "active", updatedAt: now, updatedBy: user }).where(eq(boms.id, bom.id)),
	];
}

/** Statements creating a BoM and copying the lines of `sourceBomId` into it (one batch). */
export function createBomStatements(
	db: Db,
	b: { parentPartId: number; code: string; revision: string; notes: string; status?: BomStatus },
	sourceBomId: number | null,
	user: string,
	now: string,
): Statement[] {
	const stmts: Statement[] = [
		db.insert(boms).values({
			parentPartId: b.parentPartId,
			code: b.code,
			revision: b.revision,
			status: b.status ?? "draft",
			notes: b.notes,
			createdBy: user,
			updatedBy: user,
			createdAt: now,
			updatedAt: now,
		}),
	];
	if (sourceBomId) {
		// INSERT ... SELECT over every column of bom_lines, in table order (id is assigned).
		stmts.push(
			db.insert(bomLines).select(sql`
				SELECT NULL,
					(SELECT id FROM boms WHERE parent_part_id = ${b.parentPartId} AND code = ${b.code} AND revision = ${b.revision}),
					component_part_id, qty_milli, position, notes, ${now}, ${now}, ${user}, ${user}
				FROM bom_lines WHERE bom_id = ${sourceBomId}`),
		);
	}
	return stmts;
}

export function isValidCode(code: string): boolean {
	return REF_PATTERN.test(code);
}

/** BoMs of a part with their unit cost, and the part's rolled-up cost (from its default BoM). */
export async function partBomSummary(db: Db, partId: number) {
	const [list, graph] = await Promise.all([
		db.select().from(boms).where(eq(boms.parentPartId, partId)).orderBy(asc(boms.code), asc(boms.revision)),
		loadGraph(db),
	]);
	const calc = new CostCalculator(graph);
	return {
		boms: list.map((b) => ({ ...b, cost: calc.bom(b.id) })),
		rollup: defaultBom(graph, partId) ? calc.part(partId) : null,
		refs: new Map([...graph.parts.values()].map((p) => [p.id, p.ref])),
	};
}
