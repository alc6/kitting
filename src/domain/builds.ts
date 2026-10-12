// Builds: planned production of a `make` part from an exact BoM, completed atomically.
import { and, desc, eq, inArray, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { BUILD_STATUSES, type BuildStatus, boms, buildLines, builds, parts, stockMoves } from "../db/schema";
import type { Statement } from "../lib/db";
import { likePattern } from "../lib/sql";
import { MILLI, roundDiv } from "../lib/units";
import { field } from "../lib/validation";
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
		const unitCents = cost.incomplete && cost.millicents === 0 ? null : centsOf(cost.millicents);
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
