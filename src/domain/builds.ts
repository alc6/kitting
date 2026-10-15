// Builds: planned production of a `make` part from an exact assembly, completed atomically.
import { and, asc, desc, eq, inArray, ne, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import {
	assemblies,
	BUILD_STATUSES,
	type BuildStatus,
	buildLines,
	buildMachineTimes,
	buildOptionChoices,
	builds,
	machineTypes,
	type Part,
	parts,
	stockMoves,
} from "../db/schema";
import type { Statement } from "../lib/db";
import { likePattern } from "../lib/sql";
import { MILLI, mulDivCeil, roundDiv } from "../lib/units";
import { type FieldErrors, field } from "../lib/validation";
import type { Db } from "../types";
import {
	type AssemblyGraph,
	CostCalculator,
	centsOf,
	defaultAssembly,
	type Explosion,
	explode,
	type GraphPart,
	type MakeChoice,
	missingValues,
	type Requirement,
	walkTree,
} from "./assembly-graph";
import { idsOf, keyOf, keyValues, type OptionDef, type OptionKey, stockKey } from "./option-keys";
import { keyFromForm, loadOptions } from "./options";
import { moveValues } from "./stock";

export const OPEN_STATUSES: BuildStatus[] = ["planned", "in_progress"];

export const buildInput = z.object({
	part_id: field.id(),
	assembly_id: field.id(),
	qty: field.qty({ positive: true, empty: MILLI }),
	/** What `qty` counts: units of the product (the default) or batches of the chosen assembly (D145). */
	qty_in: z
		.string()
		.trim()
		.transform((v): "units" | "batches" => (v === "batches" ? "batches" : "units")),
	serial: field.text(100),
	planned_for: field.date(),
	notes: field.text(),
});

export type BuildInput = z.output<typeof buildInput>;

/** The quantity to build in units of the product: `qty` itself, or that many batches of the chosen assembly. */
export function unitsToBuild(
	d: Pick<BuildInput, "qty" | "qty_in" | "assembly_id">,
	assemblyOptions: { id: number; batchMilli: number }[],
): number {
	if (d.qty_in !== "batches") return d.qty;
	const batch = assemblyOptions.find((b) => b.id === d.assembly_id)?.batchMilli ?? MILLI;
	return mulDivCeil(d.qty, batch, MILLI);
}

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
		.select({ build: builds, part: parts, assembly: assemblies })
		.from(builds)
		.innerJoin(parts, eq(builds.partId, parts.id))
		.innerJoin(assemblies, eq(builds.assemblyId, assemblies.id))
		.where(eq(builds.id, id))
		.limit(1);
	return rows[0];
}

// ---------------------------------------------------------------------------
// Planning: checks, then statements to run in one batch (completion is completionStatements below).

/** The product of a new build (a make part, else undefined) and its active assemblies, the choices of the form. */
export async function buildableProduct(db: Db, partId: number | null) {
	const product = partId ? (await db.select().from(parts).where(eq(parts.id, partId)).limit(1))[0] : undefined;
	const assemblyOptions = product
		? await db
				.select({
					id: assemblies.id,
					code: assemblies.code,
					revision: assemblies.revision,
					batchMilli: assemblies.batchQtyMilli,
				})
				.from(assemblies)
				.where(and(eq(assemblies.parentPartId, product.id), eq(assemblies.status, "active")))
				.orderBy(asc(assemblies.code))
		: [];
	return { product: product?.kind === "make" ? product : undefined, assemblyOptions };
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
 * Errors of a build to plan, from the form or an MCP tool: a make part, one of its active assemblies, and for a
 * serial-tracked product one unit with a serial no other build uses.
 */
export async function buildPlanErrors(
	db: Db,
	d: Pick<BuildInput, "part_id" | "assembly_id" | "qty" | "serial">,
	product: Part | undefined,
	assemblyOptions: { id: number }[],
): Promise<FieldErrors> {
	const errors: FieldErrors = {};
	if (!product) {
		errors.part_id = d.part_id ? "build_part_kind" : "required";
		return errors;
	}
	if (!d.assembly_id || !assemblyOptions.some((b) => b.id === d.assembly_id))
		errors.assembly_id = "build_assembly_mismatch";
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
		assemblyId: number;
		qtyMilli: number;
		serial: string | null;
		plannedFor: string | null;
		notes: string;
		/** The values of the product's options (D185). */
		optionValues?: OptionKey;
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
	d: { serial: string | null; plannedFor: string | null; notes: string; optionValues?: OptionKey },
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
	const rows = await queryBuilds(db, f);
	// The values each build makes (D185), as text: "white · L".
	const ids = [...new Set(rows.filter((r) => r.optionValues).map((r) => r.partId))];
	const options = await loadOptions(db, ids);
	return rows.map((r) => ({ ...r, values: keyValues(options.get(r.partId) ?? [], r.optionValues) }));
}

function queryBuilds(db: Db, f: BuildFilters) {
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
			optionValues: builds.optionValues,
			plannedFor: builds.plannedFor,
			doneAt: builds.doneAt,
			partId: parts.id,
			partRef: parts.ref,
			partName: parts.name,
			unit: parts.unit,
			assemblyCode: assemblies.code,
			assemblyRevision: assemblies.revision,
		})
		.from(builds)
		.innerJoin(parts, eq(builds.partId, parts.id))
		.innerJoin(assemblies, eq(builds.assemblyId, assemblies.id))
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

/** The machine time a completed build recorded, per machine type, with the rate frozen at completion (D148). */
export async function getBuildMachineTimes(db: Db, buildId: number) {
	return db
		.select({
			machineTypeId: buildMachineTimes.machineTypeId,
			name: machineTypes.name,
			minutesMilli: buildMachineTimes.minutesMilli,
			rateCents: buildMachineTimes.rateCents,
		})
		.from(buildMachineTimes)
		.innerJoin(machineTypes, eq(buildMachineTimes.machineTypeId, machineTypes.id))
		.where(eq(buildMachineTimes.buildId, buildId))
		.orderBy(machineTypes.name);
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
// Option values of a build (D185, D187): the product's, and those chosen for the options its lines leave to the build.

const PICK_PREFIX = "pick:";
/** Form field of a value chosen when planning: `pick:<partId>:<optionId>`. */
export const pickField = (partId: number, optionId: number) => `${PICK_PREFIX}${partId}:${optionId}`;
/** Form field of a value of the product's options: `option:<optionId>`. */
export const optionField = (optionId: number) => `option:${optionId}`;

/**
 * The components whose lines leave options to the build, anywhere in the assembly's structure (through kits and the
 * sub-assemblies it may build), with those options, in the order met.
 */
export function chosenComponents(
	graph: AssemblyGraph,
	assemblyId: number,
): { part: GraphPart; options: OptionDef[] }[] {
	const found = new Map<number, { part: GraphPart; options: OptionDef[] }>();
	const seen = new Set<number>();
	const visit = (id: number) => {
		const b = graph.assemblies.get(id);
		if (!b || seen.has(id)) return;
		seen.add(id);
		for (const line of b.lines) {
			const part = graph.parts.get(line.componentPartId);
			if (!part) continue;
			const options = part.options.filter((o) => line.chosenOptionIds.includes(o.id));
			if (options.length) {
				const entry = found.get(part.id) ?? { part, options: [] };
				for (const o of options) if (!entry.options.some((x) => x.id === o.id)) entry.options.push(o);
				found.set(part.id, entry);
			}
			if (part.kind === "make" || part.kind === "kit") {
				const sub = defaultAssembly(graph, part.id);
				if (sub) visit(sub.id);
			}
		}
	};
	visit(assemblyId);
	return [...found.values()];
}

/** The values a build form chose: the product's (`option:<id>`) and those of `pick:<partId>:<optionId>` fields. */
export function readBuildValues(
	graph: AssemblyGraph,
	product: { id: number },
	assemblyId: number | null,
	form: Record<string, unknown>,
): { optionValues: OptionKey; missing: OptionDef | null; picks: Map<number, number[]> } {
	const options = graph.parts.get(product.id)?.options ?? [];
	const { key, missing } = keyFromForm(options, form);
	const picks = new Map<number, number[]>();
	for (const c of assemblyId === null ? [] : chosenComponents(graph, assemblyId)) {
		const ids: number[] = [];
		for (const o of c.options) {
			const raw = form[pickField(c.part.id, o.id)];
			const id = Number(typeof raw === "string" ? raw : "");
			if (o.values.some((v) => v.id === id)) ids.push(id);
		}
		if (ids.length) picks.set(c.part.id, ids);
	}
	return { optionValues: key, missing, picks };
}

/**
 * What blocks a build in these values (D185): a value of the product's options left out, or a value the build asks
 * of a component that does not come in it (the cover has no "red"). Problems are i18n keys with their variables.
 */
export function buildValueProblems(
	graph: AssemblyGraph,
	assemblyId: number,
	qtyMilli: number,
	values: { optionValues: OptionKey; missing: OptionDef | null; picks: Map<number, number[]> },
): { key: string; vars?: Record<string, string> }[] {
	const problems: { key: string; vars?: Record<string, string> }[] = [];
	if (values.missing) problems.push({ key: "option_value_required", vars: { option: values.missing.name } });
	const ex = explode(graph, assemblyId, qtyMilli, { values: idsOf(values.optionValues), picks: values.picks });
	for (const m of missingValues(ex))
		problems.push({ key: "option_value_missing", vars: { ref: m.part.ref, option: m.option, value: m.value } });
	return problems;
}

/** Replaces the values chosen for a build (D187): one row per component part. `buildId` is SQL for a new build. */
export function buildChoicesStatements(
	db: Db,
	buildId: number | SQL,
	picks: Map<number, number[]>,
	user: string,
	now: string,
): Statement[] {
	return [
		db.delete(buildOptionChoices).where(eq(buildOptionChoices.buildId, buildId)),
		...[...picks].flatMap(([partId, ids]) => {
			const optionValues = keyOf(ids);
			return optionValues
				? [
						db.insert(buildOptionChoices).values({
							buildId,
							partId,
							optionValues,
							createdBy: user,
							updatedBy: user,
							createdAt: now,
							updatedAt: now,
						}),
					]
				: [];
		}),
	];
}

/** The values chosen for a build, per component part. */
export async function buildPicks(db: Db, buildId: number): Promise<Map<number, number[]>> {
	const rows = await db
		.select({ partId: buildOptionChoices.partId, optionValues: buildOptionChoices.optionValues })
		.from(buildOptionChoices)
		.where(eq(buildOptionChoices.buildId, buildId));
	return new Map(rows.map((r) => [r.partId, idsOf(r.optionValues)]));
}

/** The values chosen for every open build, per build. */
export async function openBuildPicks(db: Db): Promise<Map<number, Map<number, number[]>>> {
	const rows = await db
		.select({
			buildId: buildOptionChoices.buildId,
			partId: buildOptionChoices.partId,
			key: buildOptionChoices.optionValues,
		})
		.from(buildOptionChoices)
		.innerJoin(builds, eq(buildOptionChoices.buildId, builds.id))
		.where(inArray(builds.status, OPEN_STATUSES));
	const byBuild = new Map<number, Map<number, number[]>>();
	for (const r of rows) {
		const m = byBuild.get(r.buildId) ?? new Map<number, number[]>();
		m.set(r.partId, idsOf(r.key));
		byBuild.set(r.buildId, m);
	}
	return byBuild;
}

// ---------------------------------------------------------------------------
// Pick list and completion

const CHOICE_PREFIX = "choice:";
const SERIAL_PREFIX = "serial:";

export const choiceField = (path: string) => `${CHOICE_PREFIX}${path}`;
/** Serial field of a unit of a requirement: `serial:<partId>:<i>`, with the values for a part with options (D184). */
export const serialField = (key: number | string, i: number) => `${SERIAL_PREFIX}${key}:${i}`;

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
	/** Serials entered per serial-tracked requirement, keyed by `stockKey` (index = unit). */
	serials: Map<string, string[]>;
	/** Field name -> i18n error key. */
	errors: Record<string, string>;
	/** Errors not tied to a field (i18n key + vars). */
	problems: { key: string; vars?: Record<string, string> }[];
	/** On-hand per part and values (`stockKey`). */
	onHand: Map<string, number>;
};

/** The on-hand of a requirement's part in its values. */
export const onHandOfReq = (onHand: Map<string, number>, r: Pick<Requirement, "part" | "optionValues">) =>
	onHand.get(stockKey(r.part.id, r.optionValues)) ?? 0;

/** Number of serials needed for a requirement (one per unit). */
export const serialCount = (r: Requirement): number => Math.floor(r.qtyMilli / MILLI);

/**
 * Explodes the build with current stock and the submitted choices, then validates the
 * submitted serials. Used to render the pick list and, unchanged, to complete the build.
 */
export function buildPickList(
	graph: AssemblyGraph,
	onHand: Map<string, number>,
	build: {
		assemblyId: number;
		qtyMilli: number;
		serial: string | null;
		optionValues?: OptionKey;
		picks?: Map<number, number[]>;
	},
	product: { trackSerial: boolean },
	form: Record<string, unknown>,
	validateSerials: boolean,
): PickList {
	const explosion = explode(graph, build.assemblyId, build.qtyMilli, {
		stock: onHand,
		choices: parseChoices(form),
		values: idsOf(build.optionValues),
		picks: build.picks,
	});
	const serials = new Map<string, string[]>();
	const errors: Record<string, string> = {};
	const problems: PickList["problems"] = [];
	for (const m of missingValues(explosion))
		problems.push({ key: "option_value_missing", vars: { ref: m.part.ref, option: m.option, value: m.value } });
	for (const r of explosion.requirements) {
		if (r.missingAssembly) problems.push({ key: "missing_assembly_build", vars: { ref: r.part.ref } });
		// A sub-assembly with options taken from stock must exist in its values (D189); "build now" makes it.
		else if (
			r.part.kind === "make" &&
			r.part.options.length > 0 &&
			!r.missingValue &&
			r.qtyMilli > Math.max(0, onHandOfReq(onHand, r))
		)
			problems.push({
				key: "option_stock_short",
				vars: { ref: r.part.ref, values: keyValues(r.part.options, r.optionValues) },
			});
		if (!r.part.trackSerial) continue;
		const key = stockKey(r.part.id, r.optionValues);
		const list: string[] = [];
		const seen = new Set<string>();
		for (let i = 0; i < serialCount(r); i++) {
			const name = serialField(key, i);
			const raw = form[name];
			const value = typeof raw === "string" ? raw.trim().slice(0, 100) : "";
			list.push(value);
			if (!validateSerials) continue;
			if (!value) errors[name] = "serial_required";
			else if (seen.has(value)) errors[name] = "serial_duplicate";
			seen.add(value);
		}
		serials.set(key, list);
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
 * completion of the same build abort the whole batch. `build.id` is SQL for a build planned in the same batch.
 */
export function completionStatements(
	db: Db,
	graph: AssemblyGraph,
	build: {
		id: number | SQL;
		partId: number;
		qtyMilli: number;
		serial: string | null;
		number: string;
		optionValues?: OptionKey;
	},
	pick: PickList,
	user: string,
	now: string,
): Statement[] {
	const calc = new CostCalculator(graph);
	const ctx = { refType: "build", refId: build.id, note: build.number, user, now };
	const consume: Statement[] = [];
	const lines: Statement[] = [];
	let totalMillicents = 0;
	const lineValues = (
		partId: number,
		qtyMilli: number,
		serial: string | null,
		unitCostCents: number | null,
		optionValues: OptionKey,
	) => ({
		buildId: build.id,
		partId,
		qtyMilli,
		serial,
		unitCostCents,
		optionValues,
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
		const units = r.part.trackSerial ? (pick.serials.get(stockKey(r.part.id, r.optionValues)) ?? []) : [];
		const optionValues = r.optionValues;
		if (units.length > 0) {
			for (const serial of units) {
				consume.push(
					db
						.insert(stockMoves)
						.values(
							moveValues(
								{ partId: r.part.id, qtyMilli: -MILLI, serial, unitCostCents: unitCents, optionValues },
								{ ...ctx, reason: "build_consume" },
							),
						),
				);
				lines.push(db.insert(buildLines).values(lineValues(r.part.id, MILLI, serial, unitCents, optionValues)));
			}
			const rest = r.qtyMilli - units.length * MILLI; // fractional remainder of a tracked part (should not happen)
			if (rest > 0) {
				consume.push(
					db
						.insert(stockMoves)
						.values(
							moveValues(
								{ partId: r.part.id, qtyMilli: -rest, serial: null, unitCostCents: unitCents, optionValues },
								{ ...ctx, reason: "build_consume" },
							),
						),
				);
				lines.push(db.insert(buildLines).values(lineValues(r.part.id, rest, null, unitCents, optionValues)));
			}
		} else {
			consume.push(
				db
					.insert(stockMoves)
					.values(
						moveValues(
							{ partId: r.part.id, qtyMilli: -r.qtyMilli, serial: null, unitCostCents: unitCents, optionValues },
							{ ...ctx, reason: "build_consume" },
						),
					),
			);
			lines.push(db.insert(buildLines).values(lineValues(r.part.id, r.qtyMilli, null, unitCents, optionValues)));
		}
	}
	for (const f of pick.explosion.fees) totalMillicents += calc.extended(f.part.id, f.qtyMilli);
	// Machine time (D148): priced like a fee, and recorded with the rate of the day.
	for (const m of pick.explosion.machines) {
		totalMillicents += calc.machine(m.machineType.id, m.minutesMilli).millicents;
		lines.push(
			db.insert(buildMachineTimes).values({
				buildId: build.id,
				machineTypeId: m.machineType.id,
				minutesMilli: m.minutesMilli,
				rateCents: m.machineType.rateCents,
				createdBy: user,
				updatedBy: user,
				createdAt: now,
				updatedAt: now,
			}),
		);
	}
	const unitCostCents = centsOf(roundDiv(totalMillicents * MILLI, build.qtyMilli));
	const output = db.insert(stockMoves).values(
		moveValues(
			{
				partId: build.partId,
				qtyMilli: build.qtyMilli,
				serial: build.serial,
				unitCostCents,
				optionValues: build.optionValues ?? pick.explosion.optionValues,
			},
			{ ...ctx, reason: "build_output" },
		),
	);
	const done = db
		.update(builds)
		.set({ status: "done", doneAt: now, updatedAt: now, updatedBy: user })
		.where(and(eq(builds.id, build.id), inArray(builds.status, OPEN_STATUSES)));
	return [...consume, output, ...lines, done];
}

/**
 * Why a finished build cannot be recorded in one step (D152): what blocks its completion, and the serial-tracked
 * components, whose serials only the build page asks for. Empty when it can be recorded.
 */
export function recordProblems(pick: PickList): { key: string; vars?: Record<string, string> }[] {
	const problems = [...pick.problems];
	const tracked = pick.explosion.requirements.filter((r) => r.part.trackSerial && serialCount(r) > 0);
	if (tracked.length)
		problems.push({ key: "record_needs_serials", vars: { refs: tracked.map((r) => r.part.ref).join(", ") } });
	return problems;
}

/**
 * A finished build recorded in one change set (D152): planned for today and completed now, with the pick list's
 * default choices (sub-assemblies from stock when there are enough). The completion finds the build by its number.
 */
export function recordStatements(
	db: Db,
	graph: AssemblyGraph,
	b: {
		number: string;
		partId: number;
		assemblyId: number;
		qtyMilli: number;
		serial: string | null;
		notes: string;
		optionValues?: OptionKey;
		picks?: Map<number, number[]>;
	},
	pick: PickList,
	user: string,
	now: string,
): Statement[] {
	const { picks, ...build } = b;
	const id = sql`(SELECT id FROM builds WHERE number = ${b.number})`;
	return [
		createBuildStatement(db, { ...build, plannedFor: now.slice(0, 10) }, user, now),
		...(picks?.size ? buildChoicesStatements(db, id, picks, user, now) : []),
		...completionStatements(
			db,
			graph,
			{
				id,
				partId: b.partId,
				qtyMilli: b.qtyMilli,
				serial: b.serial,
				number: b.number,
				optionValues: b.optionValues ?? null,
			},
			pick,
			user,
			now,
		),
	];
}

/** Make nodes of an explosion (where the user can choose "use stock" or "build now"). */
export function makeNodes(explosion: Explosion) {
	return [...walkTree(explosion.tree)].filter((n) => n.part.kind === "make");
}
