import { and, asc, eq, ne, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import {
	ASSEMBLY_STATUSES,
	type Assembly,
	type AssemblyStatus,
	assemblies,
	assemblyLines,
	machineTypes,
	type Part,
	type PartKind,
	parts,
} from "../db/schema";
import type { Statement } from "../lib/db";
import { likePattern } from "../lib/sql";
import { MILLI } from "../lib/units";
import { type FieldErrors, field, REF_PATTERN } from "../lib/validation";
import type { Db } from "../types";
import {
	type AssemblyGraph,
	buildGraph,
	type Cost,
	CostCalculator,
	defaultAssembly,
	type GraphAssembly,
	type GraphMachineType,
	type GraphPart,
} from "./assembly-graph";
import { copyFilesStatement } from "./files";
import { priceRecordStatement } from "./prices";

export const assemblyInput = z.object({
	parent_part_id: field.id(),
	code: field.ref(),
	revision: field.ref(),
	notes: field.text(),
	copy_from: field.id(),
});

export const assemblyLineInput = z.object({
	component: field.required(64),
	qty: field.qty({ positive: true }),
	notes: field.text(500),
});

/**
 * How an assembly is produced (D145, D148, D153): the units one run (batch) makes, and the machine time per run (a
 * machine type and whole minutes). It is edited with the lines and under the same rule (D23): on a draft or an active
 * assembly, never an archived one; new revisions and variants copy it.
 */
export const productionInput = z.object({
	batch_qty: field.qty({ positive: true, empty: MILLI }),
	machine_type_id: field.id(),
	machine_time: field.duration(),
});

export type Production = { batchMilli: number; machineTypeId: number | null; machineMinutes: number };

/** The production settings of an assembly. */
export function productionOf(a: Pick<Assembly, "batchQtyMilli" | "machineTypeId" | "machineMinutes">): Production {
	return { batchMilli: a.batchQtyMilli, machineTypeId: a.machineTypeId, machineMinutes: a.machineMinutes };
}

/** The production settings of validated input, and what is wrong with them (a machine and a time go together). */
export async function checkProduction(
	db: Db,
	d: z.output<typeof productionInput>,
): Promise<{ production: Production; errors: FieldErrors }> {
	const errors: FieldErrors = {};
	if (d.machine_type_id !== null) {
		const [type] = await db
			.select({ id: machineTypes.id })
			.from(machineTypes)
			.where(eq(machineTypes.id, d.machine_type_id))
			.limit(1);
		if (!type) errors.machine_type_id = "invalid";
		else if (d.machine_time === 0) errors.machine_time = "machine_time_required";
	} else if (d.machine_time > 0) errors.machine_type_id = "machine_required";
	return {
		production: {
			batchMilli: d.batch_qty,
			machineTypeId: d.machine_type_id,
			machineMinutes: d.machine_type_id === null ? 0 : d.machine_time,
		},
		errors,
	};
}

/** Why the production settings of this assembly cannot be changed in place, or null: like its lines (D153). */
export function productionError(assembly: Pick<Assembly, "status">): string | null {
	return assembly.status === "archived" ? "assembly_archived" : null;
}

/** Sets the production settings of a draft or active assembly (the status is checked again in the statement). */
export function setProductionStatement(db: Db, assemblyId: number, p: Production, user: string, now: string) {
	return db
		.update(assemblies)
		.set({
			batchQtyMilli: p.batchMilli,
			machineTypeId: p.machineTypeId,
			machineMinutes: p.machineMinutes,
			updatedAt: now,
			updatedBy: user,
		})
		.where(and(eq(assemblies.id, assemblyId), ne(assemblies.status, "archived")));
}

export const DEFAULT_CODE = "std";
export const DEFAULT_REVISION = "Rev1";

/** Loads every part, assembly, line and machine type into memory (the catalogue is small). */
export async function loadGraph(db: Db): Promise<AssemblyGraph> {
	const [p, b, l, m] = await Promise.all([
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
				id: assemblies.id,
				parentPartId: assemblies.parentPartId,
				code: assemblies.code,
				revision: assemblies.revision,
				status: assemblies.status,
				batchMilli: assemblies.batchQtyMilli,
				machineTypeId: assemblies.machineTypeId,
				machineMinutes: assemblies.machineMinutes,
			})
			.from(assemblies),
		db
			.select({
				id: assemblyLines.id,
				assemblyId: assemblyLines.assemblyId,
				componentPartId: assemblyLines.componentPartId,
				qtyMilli: assemblyLines.qtyMilli,
				position: assemblyLines.position,
				notes: assemblyLines.notes,
			})
			.from(assemblyLines),
		db
			.select({ id: machineTypes.id, name: machineTypes.name, rateCents: machineTypes.hourlyRateCents })
			.from(machineTypes),
	]);
	return buildGraph(p, b, l, m);
}

export type AssemblyFilters = { q?: string; status?: string; partId?: number | null };

export async function listAssemblies(db: Db, f: AssemblyFilters = {}) {
	const conds: SQL[] = [];
	if (f.q) {
		const like = likePattern(f.q);
		conds.push(
			sql`(${parts.ref} LIKE ${like} ESCAPE '\\' OR ${parts.name} LIKE ${like} ESCAPE '\\' OR ${assemblies.code} LIKE ${like} ESCAPE '\\')`,
		);
	}
	if (f.status === "all") {
		// no filter
	} else if (f.status && (ASSEMBLY_STATUSES as readonly string[]).includes(f.status)) {
		conds.push(eq(assemblies.status, f.status as AssemblyStatus));
	} else conds.push(ne(assemblies.status, "archived"));
	if (f.partId) conds.push(eq(assemblies.parentPartId, f.partId));
	return db
		.select({
			id: assemblies.id,
			code: assemblies.code,
			revision: assemblies.revision,
			status: assemblies.status,
			updatedAt: assemblies.updatedAt,
			partId: parts.id,
			partRef: parts.ref,
			partName: parts.name,
			partKind: parts.kind,
			lineCount: sql<number>`(SELECT count(*) FROM assembly_lines bl WHERE bl.assembly_id = ${assemblies.id})`,
		})
		.from(assemblies)
		.innerJoin(parts, eq(assemblies.parentPartId, parts.id))
		.where(conds.length ? and(...conds) : undefined)
		.orderBy(asc(parts.ref), asc(assemblies.code), asc(assemblies.revision))
		.limit(2000);
}

export async function getAssembly(db: Db, id: number) {
	const rows = await db
		.select({ assembly: assemblies, part: parts })
		.from(assemblies)
		.innerJoin(parts, eq(assemblies.parentPartId, parts.id))
		.where(eq(assemblies.id, id))
		.limit(1);
	return rows[0];
}

export async function getAssemblyLines(db: Db, assemblyId: number) {
	return db
		.select({
			id: assemblyLines.id,
			qtyMilli: assemblyLines.qtyMilli,
			position: assemblyLines.position,
			notes: assemblyLines.notes,
			partId: parts.id,
			ref: parts.ref,
			name: parts.name,
			kind: parts.kind,
			unit: parts.unit,
			archived: parts.archived,
		})
		.from(assemblyLines)
		.innerJoin(parts, eq(assemblyLines.componentPartId, parts.id))
		.where(eq(assemblyLines.assemblyId, assemblyId))
		.orderBy(asc(assemblyLines.position), asc(assemblyLines.id));
}

export async function findAssembly(db: Db, parentPartId: number, code: string, revision: string) {
	const rows = await db
		.select()
		.from(assemblies)
		.where(and(eq(assemblies.parentPartId, parentPartId), eq(assemblies.code, code), eq(assemblies.revision, revision)))
		.limit(1);
	return rows[0];
}

/**
 * True when adding `componentPartId` under `parentPartId` would create a cycle: the
 * component is the parent itself, or the parent is reachable from the component through
 * draft or active assemblies (recursive CTE).
 */
export async function wouldCreateCycle(db: Db, parentPartId: number, componentPartId: number): Promise<boolean> {
	if (parentPartId === componentPartId) return true;
	const rows = await db.all<{ hit: number }>(sql`
		WITH RECURSIVE down(part_id) AS (
			SELECT ${componentPartId}
			UNION
			SELECT l.component_part_id
			FROM down d
			JOIN assemblies b ON b.parent_part_id = d.part_id AND b.status != 'archived'
			JOIN assembly_lines l ON l.assembly_id = b.id
		)
		SELECT 1 AS hit FROM down WHERE part_id = ${parentPartId} LIMIT 1`);
	return rows.length > 0;
}

/**
 * Errors of a new assembly, from the form or an MCP tool: the parent must be a make or kit part, its (code, revision)
 * new, and the lines copied from `copyFrom` must not create a cycle under it.
 */
export async function newAssemblyErrors(
	db: Db,
	d: { parentPartId: number | null; code: string; revision: string; copyFrom: number | null },
): Promise<FieldErrors> {
	const errors: FieldErrors = {};
	const parent = d.parentPartId
		? (await db.select().from(parts).where(eq(parts.id, d.parentPartId)).limit(1))[0]
		: undefined;
	if (!parent) errors.parent_part_id = "required";
	else if (parent.kind !== "make" && parent.kind !== "kit") errors.parent_part_id = "assembly_parent_kind";
	else if (await findAssembly(db, parent.id, d.code, d.revision)) errors.revision = "duplicate_assembly";
	if (d.copyFrom && parent) {
		// Copying lines from another parent's assembly must not create a cycle.
		for (const line of await getAssemblyLines(db, d.copyFrom)) {
			if (await wouldCreateCycle(db, parent.id, line.partId)) {
				errors.copy_from = "assembly_cycle";
				break;
			}
		}
	}
	return errors;
}

/**
 * Why `component` (looked up from `ref`) cannot be a line of an assembly of `parent`, in the editor or over MCP: unknown,
 * archived, a serial-tracked part in a fractional quantity, or a cycle. Null when it can.
 */
export async function componentError(
	db: Db,
	parent: Pick<Part, "id" | "ref">,
	component: Pick<Part, "id" | "ref" | "archived" | "trackSerial"> | undefined,
	ref: string,
	qtyMilli: number,
): Promise<{ field: "component" | "qty"; key: string; vars: Record<string, string> } | null> {
	if (!component) return { field: "component", key: "unknown_part", vars: { ref } };
	if (component.archived) return { field: "component", key: "archived_part", vars: {} };
	if (component.trackSerial && qtyMilli % MILLI !== 0) return { field: "qty", key: "serial_whole_qty", vars: {} };
	if (await wouldCreateCycle(db, parent.id, component.id))
		return { field: "component", key: "assembly_cycle", vars: { ref: component.ref, parent: parent.ref } };
	return null;
}

/** Whether an archived assembly would close a cycle if it counted again (activated or set back to draft). */
export async function archivedAssemblyCycles(
	db: Db,
	assembly: Pick<Assembly, "id" | "status" | "parentPartId">,
): Promise<boolean> {
	if (assembly.status !== "archived") return false;
	// An archived assembly may predate newer assemblies: its lines are checked again.
	for (const line of await getAssemblyLines(db, assembly.id)) {
		if (await wouldCreateCycle(db, assembly.parentPartId, line.partId)) return true;
	}
	return false;
}

export type WhereUsedRow = {
	assemblyId: number;
	depth: number;
	/** Quantity of `viaRef` per batch of the assembly, which makes `batchMilli` units of its parent. */
	qtyMilli: number;
	batchMilli: number;
	code: string;
	revision: string;
	status: AssemblyStatus;
	parentId: number;
	parentRef: string;
	parentName: string;
	viaRef: string;
};

/**
 * Every draft/active assembly containing the part, directly (depth 1) or through
 * sub-assemblies and kits (depth > 1, `viaRef` = component of that assembly leading to the part).
 */
export async function whereUsed(db: Db, partId: number): Promise<WhereUsedRow[]> {
	const rows = await db.all<{
		assembly_id: number;
		depth: number;
		qty_milli: number;
		batch_milli: number;
		code: string;
		revision: string;
		status: AssemblyStatus;
		parent_id: number;
		parent_ref: string;
		parent_name: string;
		via_ref: string;
	}>(sql`
		WITH RECURSIVE used(assembly_id, parent_part_id, via_part_id, qty_milli, depth) AS (
			SELECT b.id, b.parent_part_id, l.component_part_id, l.qty_milli, 1
			FROM assembly_lines l
			JOIN assemblies b ON b.id = l.assembly_id AND b.status != 'archived'
			WHERE l.component_part_id = ${partId}
			UNION
			SELECT b.id, b.parent_part_id, l.component_part_id, l.qty_milli, u.depth + 1
			FROM used u
			JOIN assembly_lines l ON l.component_part_id = u.parent_part_id
			JOIN assemblies b ON b.id = l.assembly_id AND b.status != 'archived'
			WHERE u.depth < 32
		)
		SELECT u.assembly_id, u.depth, u.qty_milli, b.batch_qty_milli AS batch_milli, b.code, b.revision, b.status,
			p.id AS parent_id, p.ref AS parent_ref, p.name AS parent_name, v.ref AS via_ref
		FROM used u
		JOIN assemblies b ON b.id = u.assembly_id
		JOIN parts p ON p.id = b.parent_part_id
		JOIN parts v ON v.id = u.via_part_id
		ORDER BY u.depth, p.ref, b.code, b.revision`);
	const seen = new Set<string>();
	const out: WhereUsedRow[] = [];
	for (const r of rows) {
		const key = `${r.assembly_id}:${r.via_ref}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({
			assemblyId: r.assembly_id,
			depth: r.depth,
			qtyMilli: r.qty_milli,
			batchMilli: r.batch_milli,
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

/** How the history and pages name an assembly: "LAMP-DESK std Rev3". */
export function assemblyLabel(parentRef: string, assembly: { code: string; revision: string }): string {
	return `${parentRef} ${assembly.code} ${assembly.revision}`;
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

/** Statements that make `assembly` the active assembly of its (parent, code), archiving the previous one. */
export function activateStatements(db: Db, assembly: Assembly, user: string, now: string): Statement[] {
	return [
		db
			.update(assemblies)
			.set({ status: "archived", updatedAt: now, updatedBy: user })
			.where(
				and(
					eq(assemblies.parentPartId, assembly.parentPartId),
					eq(assemblies.code, assembly.code),
					eq(assemblies.status, "active"),
					ne(assemblies.id, assembly.id),
				),
			),
		db
			.update(assemblies)
			.set({ status: "active", updatedAt: now, updatedBy: user })
			.where(eq(assemblies.id, assembly.id)),
	];
}

/**
 * The variant's own selling price a new assembly starts with (D166): a new revision of the same variant (same part and
 * code) keeps its source's; a new variant, or a copy of another part's assembly, starts without one (the part's applies).
 */
export function keptSalePrice(
	source: Pick<Assembly, "parentPartId" | "code" | "salePriceCents"> | undefined,
	target: { parentPartId: number; code: string },
): number | null {
	return source?.parentPartId === target.parentPartId && source.code === target.code ? source.salePriceCents : null;
}

/**
 * Statements creating an assembly and copying the lines of `sourceAssemblyId` into it (one batch). The lines are
 * quantities per batch, so the production settings are copied with them; `production` overrides them. The variant's
 * selling price is not copied with the lines: the caller passes it (`keptSalePrice`, D166), logged in the price history.
 */
export function createAssemblyStatements(
	db: Db,
	b: {
		parentPartId: number;
		code: string;
		revision: string;
		notes: string;
		status?: AssemblyStatus;
		production?: Production;
		salePriceCents?: number | null;
	},
	sourceAssemblyId: number | null,
	user: string,
	now: string,
): Statement[] {
	const copied = (column: SQL) =>
		sourceAssemblyId ? sql`(SELECT ${column} FROM assemblies WHERE id = ${sourceAssemblyId})` : undefined;
	const created = sql`(SELECT id FROM assemblies WHERE parent_part_id = ${b.parentPartId} AND code = ${b.code} AND revision = ${b.revision})`;
	const salePriceCents = b.salePriceCents ?? null;
	const stmts: Statement[] = [
		db.insert(assemblies).values({
			parentPartId: b.parentPartId,
			code: b.code,
			revision: b.revision,
			status: b.status ?? "draft",
			notes: b.notes,
			batchQtyMilli: b.production?.batchMilli ?? copied(sql.raw("batch_qty_milli")),
			machineTypeId: b.production ? b.production.machineTypeId : copied(sql.raw("machine_type_id")),
			machineMinutes: b.production?.machineMinutes ?? copied(sql.raw("machine_minutes")),
			salePriceCents,
			createdBy: user,
			updatedBy: user,
			createdAt: now,
			updatedAt: now,
		}),
	];
	if (salePriceCents !== null) {
		stmts.push(
			priceRecordStatement(
				db,
				{ partId: b.parentPartId, kind: "sale", assemblyId: created, priceCents: salePriceCents, source: "form" },
				user,
				now,
			),
		);
	}
	if (sourceAssemblyId) {
		// INSERT ... SELECT over every column of assembly_lines, in table order (id is assigned).
		stmts.push(
			db.insert(assemblyLines).select(sql`
				SELECT NULL, ${created}, component_part_id, qty_milli, position, notes, ${now}, ${now}, ${user}, ${user}
				FROM assembly_lines WHERE assembly_id = ${sourceAssemblyId}`),
			// The files go with the revision they describe: same objects, only the rows are copied (D164).
			copyFilesStatement(db, b, sourceAssemblyId, user, now),
		);
	}
	return stmts;
}

/** Marks an assembly as changed now (its lines changed). */
function touchAssemblyStatement(db: Db, assemblyId: number, user: string, now: string) {
	return db.update(assemblies).set({ updatedAt: now, updatedBy: user }).where(eq(assemblies.id, assemblyId));
}

/** Appends a line at the end of an assembly. */
export function addAssemblyLineStatements(
	db: Db,
	assemblyId: number,
	line: { componentPartId: number; qtyMilli: number; notes: string },
	user: string,
	now: string,
): Statement[] {
	return [
		db.insert(assemblyLines).values({
			assemblyId,
			componentPartId: line.componentPartId,
			qtyMilli: line.qtyMilli,
			notes: line.notes,
			position: sql`(SELECT COALESCE(MAX(position), 0) + 1 FROM assembly_lines WHERE assembly_id = ${assemblyId})`,
			createdBy: user,
			updatedBy: user,
			createdAt: now,
			updatedAt: now,
		}),
		touchAssemblyStatement(db, assemblyId, user, now),
	];
}

export function updateAssemblyLineQtyStatements(
	db: Db,
	assemblyId: number,
	lineId: number,
	qtyMilli: number,
	user: string,
	now: string,
): Statement[] {
	return [
		db
			.update(assemblyLines)
			.set({ qtyMilli, updatedAt: now, updatedBy: user })
			.where(and(eq(assemblyLines.id, lineId), eq(assemblyLines.assemblyId, assemblyId))),
		touchAssemblyStatement(db, assemblyId, user, now),
	];
}

export function deleteAssemblyLineStatements(
	db: Db,
	assemblyId: number,
	lineId: number,
	user: string,
	now: string,
): Statement[] {
	return [
		db.delete(assemblyLines).where(and(eq(assemblyLines.id, lineId), eq(assemblyLines.assemblyId, assemblyId))),
		touchAssemblyStatement(db, assemblyId, user, now),
	];
}

/**
 * Replaces every line of an assembly with `lines`, in that order (positions 1..n), in one batch. `assembly` is an id, or the
 * (parent, code, revision) of an assembly created earlier in the same batch.
 */
export function replaceAssemblyLinesStatements(
	db: Db,
	assembly: number | { parentPartId: number; code: string; revision: string },
	lines: { componentPartId: number; qtyMilli: number; notes: string }[],
	user: string,
	now: string,
): Statement[] {
	const assemblyId =
		typeof assembly === "number"
			? sql`${assembly}`
			: sql`(SELECT id FROM assemblies WHERE parent_part_id = ${assembly.parentPartId} AND code = ${assembly.code} AND revision = ${assembly.revision})`;
	return [
		db.delete(assemblyLines).where(eq(assemblyLines.assemblyId, assemblyId)),
		...lines.map((l, i) =>
			db.insert(assemblyLines).values({
				assemblyId,
				componentPartId: l.componentPartId,
				qtyMilli: l.qtyMilli,
				notes: l.notes,
				position: i + 1,
				createdBy: user,
				updatedBy: user,
				createdAt: now,
				updatedAt: now,
			}),
		),
		db.update(assemblies).set({ updatedAt: now, updatedBy: user }).where(eq(assemblies.id, assemblyId)),
	];
}

/** Renumbers the lines of an assembly 1..n in the given order of line ids. */
export function reorderAssemblyLinesStatements(
	db: Db,
	assemblyId: number,
	order: number[],
	user: string,
	now: string,
): Statement[] {
	return order.map((id, i) =>
		db
			.update(assemblyLines)
			.set({ position: i + 1, updatedAt: now, updatedBy: user })
			.where(and(eq(assemblyLines.id, id), eq(assemblyLines.assemblyId, assemblyId))),
	);
}

/** Sets an assembly back to draft or archives it (activating goes through activateStatements). */
export function setAssemblyStatusStatement(
	db: Db,
	assemblyId: number,
	status: Exclude<AssemblyStatus, "active">,
	user: string,
	now: string,
) {
	return db.update(assemblies).set({ status, updatedAt: now, updatedBy: user }).where(eq(assemblies.id, assemblyId));
}

/** Deletes an assembly with its lines; fails with a FOREIGN KEY error while builds use it. */
export function deleteAssemblyStatement(db: Db, assemblyId: number) {
	return db.delete(assemblies).where(eq(assemblies.id, assemblyId));
}

export function isValidCode(code: string): boolean {
	return REF_PATTERN.test(code);
}

/**
 * How a made part is made, as its page shows it (D154): the assembly builds use (its default active one, else its newest
 * draft, else its newest archived one) with its lines resolved, its machine step, and its cost per unit; the other active variants are listed by name.
 */
export type PartRecipe = {
	assembly: GraphAssembly;
	lines: { part: GraphPart; qtyMilli: number; notes: string }[];
	machine: GraphMachineType | null;
	unitCost: Cost;
	otherVariants: { id: number; code: string; revision: string }[];
};

/** The assembly shown as a part's recipe: its default active one, else its newest draft, else its newest (D154). */
export function partRecipe(graph: AssemblyGraph, calc: CostCalculator, partId: number): PartRecipe | null {
	const own = [...graph.assemblies.values()].filter((b) => b.parentPartId === partId).sort((a, b) => b.id - a.id);
	const shown = defaultAssembly(graph, partId) ?? own.find((b) => b.status === "draft") ?? own[0];
	if (!shown) return null;
	const lines = shown.lines.flatMap((l) => {
		const part = graph.parts.get(l.componentPartId);
		return part ? [{ part, qtyMilli: l.qtyMilli, notes: l.notes }] : [];
	});
	return {
		assembly: shown,
		lines,
		machine:
			shown.machineTypeId !== null && shown.machineMinutes > 0
				? (graph.machineTypes.get(shown.machineTypeId) ?? null)
				: null,
		unitCost: calc.assembly(shown.id),
		otherVariants: own
			.filter((b) => b.status === "active" && b.id !== shown.id)
			.sort((a, b) => a.code.localeCompare(b.code))
			.map((b) => ({ id: b.id, code: b.code, revision: b.revision })),
	};
}

/** Assemblies of a part with their unit cost, and the part's rolled-up cost (from its default assembly). */
export async function partAssemblySummary(db: Db, partId: number) {
	const [list, graph] = await Promise.all([
		db
			.select()
			.from(assemblies)
			.where(eq(assemblies.parentPartId, partId))
			.orderBy(asc(assemblies.code), asc(assemblies.revision)),
		loadGraph(db),
	]);
	const calc = new CostCalculator(graph);
	return {
		assemblies: list.map((b) => ({ ...b, cost: calc.assembly(b.id) })),
		rollup: defaultAssembly(graph, partId) ? calc.part(partId) : null,
		recipe: partRecipe(graph, calc, partId),
		refs: new Map([...graph.parts.values()].map((p) => [p.id, p.ref])),
		machines: new Map([...graph.machineTypes.values()].map((m) => [m.id, m.name])),
	};
}

/**
 * Assembly roll-ups for the parts list (D176): the unit cost rolled up from the default active assembly of each listed
 * make or kit part that has no standard cost of its own. One pass for the whole page: the graph is loaded once (and
 * not at all when no listed part qualifies) and the costs are memoized across parts, never one query per row.
 * `refs` names the parts a cost is missing, for the incomplete marker.
 */
export async function listRollupCosts(db: Db, rows: { id: number; kind: PartKind; costCents: number | null }[]) {
	const costs = new Map<number, Cost>();
	const wanted = rows.filter((r) => (r.kind === "make" || r.kind === "kit") && r.costCents === null);
	if (wanted.length === 0) return { costs, refs: new Map<number, string>() };
	const graph = await loadGraph(db);
	const withActive = new Set<number>();
	for (const b of graph.assemblies.values()) if (b.status === "active") withActive.add(b.parentPartId);
	const calc = new CostCalculator(graph);
	for (const r of wanted) if (withActive.has(r.id)) costs.set(r.id, calc.part(r.id));
	return { costs, refs: new Map([...graph.parts.values()].map((p) => [p.id, p.ref])) };
}

/** Statements setting an assembly variant's selling price (NULL = use the part's), logged in the price history. */
export function assemblySalePriceStatements(
	db: Db,
	assembly: { id: number; parentPartId: number; salePriceCents: number | null },
	priceCents: number | null,
	user: string,
	now: string,
): Statement[] {
	if (assembly.salePriceCents === priceCents) return [];
	return [
		db
			.update(assemblies)
			.set({ salePriceCents: priceCents, updatedAt: now, updatedBy: user })
			.where(eq(assemblies.id, assembly.id)),
		priceRecordStatement(
			db,
			{ partId: assembly.parentPartId, kind: "sale", assemblyId: assembly.id, priceCents, source: "form" },
			user,
			now,
		),
	];
}
