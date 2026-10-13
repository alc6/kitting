// Builds: planned production of a `make` part from an exact BoM, completed atomically.
import { and, asc, desc, eq, inArray, ne, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { BUILD_STATUSES, type BuildStatus, boms, buildLines, builds, type Part, parts, stockMoves } from "../db/schema";
import type { Statement } from "../lib/db";
import { likePattern } from "../lib/sql";
import { MILLI, roundDiv } from "../lib/units";
import { type FieldErrors, field } from "../lib/validation";
import type { Db } from "../types";
import {
	type BomGraph,
	CostCalculator,
	centsOf,
	type Explosion,
	explode,
	type MakeChoice,
	type Requirement,
	walkTree,
} from "./bom-graph";
import { moveValues } from "./stock";

export const OPEN_STATUSES: BuildStatus[] = ["planned", "in_progress"];

export const buildInput = z.object({
	part_id: field.id(),
	bom_id: field.id(),
	qty: field.qty({ positive: true, empty: MILLI }),
	serial: field.text(100),
	planned_for: field.date(),
	notes: field.text(),
});

export type BuildInput = z.output<typeof buildInput>;

export const buildEditInput = z.object({
	serial: field.text(100),
	planned_for: field.date(),
	notes: field.text(),
});

/** "B-0042" -> next "B-0043". */
export async function nextBuildNumber(db: Db): Promise<string> {
	const rows = await db.select({ number: builds.number }).from(builds).orderBy(desc(builds.id)).limit(20);
	const max = rows.reduce((m, r) => Math.max(m, Number(/(\d+)$/.exec(r.number)?.[1] ?? 0)), 0);
	return `B-${String(max + 1).padStart(4, "0")}`;
}

export async function getBuild(db: Db, id: number) {
	const rows = await db
		.select({ build: builds, part: parts, bom: boms })
		.from(builds)
		.innerJoin(parts, eq(builds.partId, parts.id))
		.innerJoin(boms, eq(builds.bomId, boms.id))
		.where(eq(builds.id, id))
		.limit(1);
	return rows[0];
}

// ---------------------------------------------------------------------------
// Planning: checks, then statements to run in one batch (completion is completionStatements below).

/** The product of a new build (a make part, else undefined) and its active BoMs, the choices of the form. */
export async function buildableProduct(db: Db, partId: number | null) {
	const product = partId ? (await db.select().from(parts).where(eq(parts.id, partId)).limit(1))[0] : undefined;
	const bomOptions = product
		? await db
				.select({ id: boms.id, code: boms.code, revision: boms.revision })
				.from(boms)
				.where(and(eq(boms.parentPartId, product.id), eq(boms.status, "active")))
				.orderBy(asc(boms.code))
		: [];
	return { product: product?.kind === "make" ? product : undefined, bomOptions };
}

/** Whether another build of this product, not cancelled, already has this serial. */
export async function buildSerialTaken(db: Db, partId: number, serial: string, exceptBuildId?: number) {
	const conds = [eq(builds.partId, partId), eq(builds.serial, serial), ne(builds.status, "cancelled")];
	if (exceptBuildId) conds.push(ne(builds.id, exceptBuildId));
	const taken = await db
		.select({ id: builds.id })
		.from(builds)
		.where(and(...conds))
		.limit(1);
	return taken.length > 0;
}

/**
 * Errors of a build to plan, from the form or an MCP tool: a make part, one of its active BoMs, and for a
 * serial-tracked product one unit with a serial no other build uses.
 */
export async function buildPlanErrors(
	db: Db,
	d: Pick<BuildInput, "part_id" | "bom_id" | "qty" | "serial">,
	product: Part | undefined,
	bomOptions: { id: number }[],
): Promise<FieldErrors> {
	const errors: FieldErrors = {};
	if (!product) {
		errors.part_id = d.part_id ? "build_part_kind" : "required";
		return errors;
	}
	if (!d.bom_id || !bomOptions.some((b) => b.id === d.bom_id)) errors.bom_id = "build_bom_mismatch";
	if (product.trackSerial) {
		if (d.qty !== MILLI) errors.qty = "build_serial_qty";
		if (!d.serial) errors.serial = "build_serial_required";
	}
	if (d.serial && (await buildSerialTaken(db, product.id, d.serial))) errors.serial = "build_serial_taken";
	return errors;
}

export function createBuildStatement(
	db: Db,
	b: {
		number: string;
		partId: number;
		bomId: number;
		qtyMilli: number;
		serial: string | null;
		plannedFor: string | null;
		notes: string;
	},
	user: string,
	now: string,
) {
	return db
		.insert(builds)
		.values({ ...b, createdBy: user, updatedBy: user, createdAt: now, updatedAt: now })
		.returning({ id: builds.id });
}

export function updateBuildStatement(
	db: Db,
	buildId: number,
	d: { serial: string | null; plannedFor: string | null; notes: string },
	user: string,
	now: string,
) {
	return db
		.update(builds)
		.set({ ...d, updatedAt: now, updatedBy: user })
		.where(eq(builds.id, buildId));
}

/** Planned → in progress (another status is left alone). */
export function startBuildStatement(db: Db, buildId: number, user: string, now: string) {
	return db
		.update(builds)
		.set({ status: "in_progress", updatedAt: now, updatedBy: user })
		.where(and(eq(builds.id, buildId), eq(builds.status, "planned")));
}

/** Planned or in progress → cancelled (frees its serial). */
export function cancelBuildStatement(db: Db, buildId: number, user: string, now: string) {
	return db
		.update(builds)
		.set({ status: "cancelled", updatedAt: now, updatedBy: user })
		.where(and(eq(builds.id, buildId), inArray(builds.status, OPEN_STATUSES)));
}

export type BuildFilters = { q?: string; status?: string; partId?: number | null; limit?: number };

export async function listBuilds(db: Db, f: BuildFilters = {}) {
	const conds: SQL[] = [];
	if (f.q) {
		const like = likePattern(f.q);
		// Also matches component serials: "where did serial X go?"
		conds.push(sql`(${builds.number} LIKE ${like} ESCAPE '\\' OR ${builds.serial} LIKE ${like} ESCAPE '\\'
			OR ${parts.ref} LIKE ${like} ESCAPE '\\' OR ${parts.name} LIKE ${like} ESCAPE '\\'
			OR EXISTS (SELECT 1 FROM build_lines bl WHERE bl.build_id = ${builds.id} AND bl.serial LIKE ${like} ESCAPE '\\'))`);
	}
	if (f.status === "open" || !f.status) conds.push(inArray(builds.status, OPEN_STATUSES));
	else if ((BUILD_STATUSES as readonly string[]).includes(f.status))
		conds.push(eq(builds.status, f.status as BuildStatus));
	if (f.partId) conds.push(eq(builds.partId, f.partId));
	return db
		.select({
			id: builds.id,
			number: builds.number,
			status: builds.status,
			qtyMilli: builds.qtyMilli,
			serial: builds.serial,
			plannedFor: builds.plannedFor,
			doneAt: builds.doneAt,
			partId: parts.id,
			partRef: parts.ref,
			partName: parts.name,
			unit: parts.unit,
			bomCode: boms.code,
			bomRevision: boms.revision,
		})
		.from(builds)
		.innerJoin(parts, eq(builds.partId, parts.id))
		.innerJoin(boms, eq(builds.bomId, boms.id))
		.where(conds.length ? and(...conds) : undefined)
		.orderBy(desc(builds.id))
		.limit(f.limit ?? 500);
}

export async function getBuildLines(db: Db, buildId: number) {
	return db
		.select({
			line: buildLines,
			ref: parts.ref,
			name: parts.name,
			kind: parts.kind,
			unit: parts.unit,
			// The build that produced this serial, if it was built here (sub-assembly traceability).
			sourceBuildId: sql<
				number | null
			>`(SELECT b2.id FROM builds b2 WHERE b2.part_id = ${buildLines.partId} AND b2.serial = ${buildLines.serial} AND b2.status = 'done' LIMIT 1)`,
			sourceBuildNumber: sql<
				string | null
			>`(SELECT b2.number FROM builds b2 WHERE b2.part_id = ${buildLines.partId} AND b2.serial = ${buildLines.serial} AND b2.status = 'done' LIMIT 1)`,
		})
		.from(buildLines)
		.innerJoin(parts, eq(buildLines.partId, parts.id))
		.where(eq(buildLines.buildId, buildId))
		.orderBy(parts.ref, buildLines.serial, buildLines.id);
}

/** Builds that consumed a given serial of a part (normally one). */
export async function buildsConsumingSerial(db: Db, partId: number, serial: string) {
	return db
		.select({ id: builds.id, number: builds.number })
		.from(buildLines)
		.innerJoin(builds, eq(buildLines.buildId, builds.id))
		.where(and(eq(buildLines.partId, partId), eq(buildLines.serial, serial)));
}

// ---------------------------------------------------------------------------
// Pick list and completion

const CHOICE_PREFIX = "choice:";
const SERIAL_PREFIX = "serial:";

export const choiceField = (path: string) => `${CHOICE_PREFIX}${path}`;
export const serialField = (partId: number, i: number) => `${SERIAL_PREFIX}${partId}:${i}`;

/** Reads "use stock" / "build now" choices from submitted form fields. */
export function parseChoices(form: Record<string, unknown>): Map<string, MakeChoice> {
	const choices = new Map<string, MakeChoice>();
	for (const [key, value] of Object.entries(form)) {
		if (!key.startsWith(CHOICE_PREFIX)) continue;
		const path = key.slice(CHOICE_PREFIX.length);
		if (!/^\d+(\/\d+)*$/.test(path)) continue;
		if (value === "stock" || value === "build") choices.set(path, value);
	}
	return choices;
}

export type PickList = {
	explosion: Explosion;
	/** Serials entered per serial-tracked part (index = unit). */
	serials: Map<number, string[]>;
	/** Field name -> i18n error key. */
	errors: Record<string, string>;
	/** Errors not tied to a field (i18n key + vars). */
	problems: { key: string; vars?: Record<string, string> }[];
	onHand: Map<number, number>;
};

/** Number of serials needed for a requirement (one per unit). */
export const serialCount = (r: Requirement): number => Math.floor(r.qtyMilli / MILLI);

/**
 * Explodes the build with current stock and the submitted choices, then validates the
 * submitted serials. Used to render the pick list and, unchanged, to complete the build.
 */
export function buildPickList(
	graph: BomGraph,
	onHand: Map<number, number>,
	build: { bomId: number; qtyMilli: number; serial: string | null },
	product: { trackSerial: boolean },
	form: Record<string, unknown>,
	validateSerials: boolean,
): PickList {
	const explosion = explode(graph, build.bomId, build.qtyMilli, { stock: onHand, choices: parseChoices(form) });
	const serials = new Map<number, string[]>();
	const errors: Record<string, string> = {};
	const problems: PickList["problems"] = [];
	for (const r of explosion.requirements) {
		if (r.missingBom) problems.push({ key: "missing_bom_build", vars: { ref: r.part.ref } });
		if (!r.part.trackSerial) continue;
		const list: string[] = [];
		const seen = new Set<string>();
		for (let i = 0; i < serialCount(r); i++) {
			const name = serialField(r.part.id, i);
			const raw = form[name];
			const value = typeof raw === "string" ? raw.trim().slice(0, 100) : "";
			list.push(value);
			if (!validateSerials) continue;
			if (!value) errors[name] = "serial_required";
			else if (seen.has(value)) errors[name] = "serial_duplicate";
			seen.add(value);
		}
		serials.set(r.part.id, list);
	}
	if (validateSerials && product.trackSerial) {
		if (!build.serial) problems.push({ key: "build_serial_required" });
		if (build.qtyMilli !== MILLI) problems.push({ key: "build_serial_qty" });
	}
	return { explosion, serials, errors, problems, onHand };
}

/**
 * The completion batch: consume moves, the output move (with the frozen as-built unit cost),
 * the as-built lines, then the status change. The unique `build_output` index makes a second
 * completion of the same build abort the whole batch.
 */
export function completionStatements(
	db: Db,
	graph: BomGraph,
	build: { id: number; partId: number; qtyMilli: number; serial: string | null; number: string },
	pick: PickList,
	user: string,
	now: string,
): Statement[] {
	const calc = new CostCalculator(graph);
	const ctx = { refType: "build", refId: build.id, note: build.number, user, now };
	const consume: Statement[] = [];
	const lines: Statement[] = [];
	let totalMillicents = 0;
	const lineValues = (partId: number, qtyMilli: number, serial: string | null, unitCostCents: number | null) => ({
		buildId: build.id,
		partId,
		qtyMilli,
		serial,
		unitCostCents,
		createdBy: user,
		updatedBy: user,
		createdAt: now,
		updatedAt: now,
	});
	for (const r of pick.explosion.requirements) {
		const cost = calc.part(r.part.id);
		// Unknown (or partly unknown) costs are stored as NULL so the as-built record can flag them.
		const unitCents = cost.incomplete ? null : centsOf(cost.millicents);
		totalMillicents += calc.extended(r.part.id, r.qtyMilli);
		const units = r.part.trackSerial ? (pick.serials.get(r.part.id) ?? []) : [];
		if (units.length > 0) {
			for (const serial of units) {
				consume.push(
					db
						.insert(stockMoves)
						.values(
							moveValues(
								{ partId: r.part.id, qtyMilli: -MILLI, serial, unitCostCents: unitCents },
								{ ...ctx, reason: "build_consume" },
							),
						),
				);
				lines.push(db.insert(buildLines).values(lineValues(r.part.id, MILLI, serial, unitCents)));
			}
			const rest = r.qtyMilli - units.length * MILLI; // fractional remainder of a tracked part (should not happen)
			if (rest > 0) {
				consume.push(
					db
						.insert(stockMoves)
						.values(
							moveValues(
								{ partId: r.part.id, qtyMilli: -rest, serial: null, unitCostCents: unitCents },
								{ ...ctx, reason: "build_consume" },
							),
						),
				);
				lines.push(db.insert(buildLines).values(lineValues(r.part.id, rest, null, unitCents)));
			}
		} else {
			consume.push(
				db
					.insert(stockMoves)
					.values(
						moveValues(
							{ partId: r.part.id, qtyMilli: -r.qtyMilli, serial: null, unitCostCents: unitCents },
							{ ...ctx, reason: "build_consume" },
						),
					),
			);
			lines.push(db.insert(buildLines).values(lineValues(r.part.id, r.qtyMilli, null, unitCents)));
		}
	}
	for (const f of pick.explosion.fees) totalMillicents += calc.extended(f.part.id, f.qtyMilli);
	const unitCostCents = centsOf(roundDiv(totalMillicents * MILLI, build.qtyMilli));
	const output = db
		.insert(stockMoves)
		.values(
			moveValues(
				{ partId: build.partId, qtyMilli: build.qtyMilli, serial: build.serial, unitCostCents },
				{ ...ctx, reason: "build_output" },
			),
		);
	const done = db
		.update(builds)
		.set({ status: "done", doneAt: now, updatedAt: now, updatedBy: user })
		.where(and(eq(builds.id, build.id), inArray(builds.status, OPEN_STATUSES)));
	return [...consume, output, ...lines, done];
}

/** Make nodes of an explosion (where the user can choose "use stock" or "build now"). */
export function makeNodes(explosion: Explosion) {
	return [...walkTree(explosion.tree)].filter((n) => n.part.kind === "make");
}
