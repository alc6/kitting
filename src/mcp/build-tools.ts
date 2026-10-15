// builds:write tools (D127): plan, complete and cancel builds with the pages' checks. Completion goes through the
// pick list exactly as the build page does: re-exploded with current stock and the given choices, the same serial
// checks, the same completion batch. It writes the stock ledger, so it cannot be undone.
import { z } from "zod";
import { loadGraph } from "../domain/assemblies";
import { explode, walkTree } from "../domain/assembly-graph";
import {
	buildableProduct,
	buildInput,
	buildPickList,
	buildPicks,
	buildPlanErrors,
	cancelBuildStatement,
	choiceField,
	completionStatements,
	createBuildStatement,
	getBuildLines,
	getBuildMachineTimes,
	nextBuildNumber,
	OPEN_STATUSES,
	recordProblems,
	recordStatements,
	serialField,
	unitsToBuild,
} from "../domain/builds";
import { stockKey } from "../domain/option-keys";
import { can } from "../domain/permissions";
import { onHandByKey } from "../domain/stock";
import { fmt } from "../i18n";
import { isConstraintError } from "../lib/sql";
import { validate } from "../lib/validation";
import {
	buildByNumber,
	date,
	decimal,
	errorMessage,
	exploding,
	formValue,
	NOTHING_CHANGED,
	partByRef,
	partRef,
	refuse,
	saveChange,
	type ToolContext,
	ToolError,
	type ToolSpec,
	tool,
	writes,
} from "./kit";

const now = () => new Date().toISOString();

const buildNumberInput = z.string().trim().min(1).max(32).describe('The build number, e.g. "B-0001".');

/** The fields a build is planned with, over MCP (plan_build, record_build). */
const buildFields = {
	ref: partRef.describe("Reference of the make part to build."),
	qty: decimal('How many units to build (default "1").').optional(),
	batches: decimal(
		'How many batches to build instead of qty, for an assembly that makes batches (e.g. "2" plates of 24 = 48 units).',
	).optional(),
	code: z
		.string()
		.trim()
		.min(1)
		.max(64)
		.optional()
		.describe('Variant code of the active assembly to use (default "std", else its only active assembly).'),
	serial: z.string().max(100).default("").describe("Serial number of the product (serial-tracked products)."),
	notes: z.string().max(2000).default(""),
};

/** A build to plan, checked as the new build form does: the product, its assembly and the validated values. */
async function checkBuildToPlan(
	a: {
		ref: string;
		qty?: string | number | undefined;
		batches?: string | number | undefined;
		code?: string | undefined;
		serial: string;
		planned_for?: string | undefined;
		notes: string;
	},
	ctx: ToolContext,
) {
	if (a.qty !== undefined && a.batches !== undefined) throw new ToolError("Give qty or batches, not both.");
	const part = await partByRef(ctx.db, a.ref);
	const { product, assemblyOptions } = await buildableProduct(ctx.db, part.id);
	const assembly = a.code
		? assemblyOptions.find((b) => b.code === a.code)
		: (assemblyOptions.find((b) => b.code === "std") ?? assemblyOptions[0]);
	const v = validate(buildInput, {
		part_id: String(part.id),
		assembly_id: assembly ? String(assembly.id) : "",
		qty: formValue(a.batches ?? a.qty),
		qty_in: a.batches !== undefined ? "batches" : "units",
		serial: a.serial,
		planned_for: a.planned_for ?? "",
		notes: a.notes,
	});
	const names = { part_id: "ref", assembly_id: "code", qty: a.batches !== undefined ? "batches" : "qty" };
	if (!v.ok) refuse(v.errors, {}, names);
	const d = { ...v.data, qty: unitsToBuild(v.data, assemblyOptions) };
	const errors = await buildPlanErrors(ctx.db, d, product, assemblyOptions);
	if (Object.keys(errors).length || !product || !assembly) refuse(errors, {}, names);
	return { product, assembly, d };
}

const planBuild = tool({
	name: "plan_build",
	title: "Plan a build",
	description:
		"Plans a build (production order) of a make part from one of its active assemblies, as the new build form does. A serial-tracked product is built one unit at a time with its own serial, unused by other builds. Then get_build shows its pick list and complete_build records it.",
	rule: { scope: "builds:write", action: "builds.plan" },
	annotations: writes({ destructive: false, idempotent: false }),
	input: z.object({ ...buildFields, planned_for: date.optional() }),
	run: async (a, ctx) => {
		const { product, assembly, d } = await checkBuildToPlan(a, ctx);
		// Numbers are sequential; retry once if someone took the same number meanwhile (as the page does).
		for (let attempt = 0; ; attempt++) {
			const number = await nextBuildNumber(ctx.db);
			try {
				const { change } = await saveChange(
					ctx,
					fmt(ctx.t.history.summaries.buildCreate, { number, ref: product.ref }),
					[
						createBuildStatement(
							ctx.db,
							{
								number,
								partId: product.id,
								assemblyId: assembly.id,
								qtyMilli: d.qty,
								serial: d.serial || null,
								plannedFor: d.planned_for,
								notes: d.notes,
							},
							ctx.user,
							now(),
						),
					],
				);
				return {
					...change,
					build: {
						number,
						status: "planned",
						part: product.ref,
						unit: product.unit,
						qtyMilli: d.qty,
						serial: d.serial || null,
						assembly: {
							assemblyId: assembly.id,
							code: assembly.code,
							revision: assembly.revision,
							batchMilli: assembly.batchMilli,
						},
						plannedFor: d.planned_for,
					},
				};
			} catch (err) {
				if (attempt > 0 || !isConstraintError(err, "UNIQUE")) throw err;
			}
		}
	},
});

const completeBuild = tool({
	name: "complete_build",
	title: "Complete a build",
	description:
		"Records a planned or in-progress build as done, as the build page's pick list does: components are consumed from stock, the product is added, and the as-built record keeps every serial and frozen unit cost. Give one serial per unit of each serial-tracked component (get_build lists them under serials_to_scan). Sub-assemblies (make parts) are taken from stock when there is enough, else built now; override per sub-assembly with sub_assemblies (by ref for every occurrence, or by the path get_build shows). Refused, with the reasons, when a serial is missing or repeated, a sub-assembly to build has no active assembly, or the product needs a serial. This writes the stock ledger: it cannot be undone.",
	rule: { scope: "builds:write", action: "builds.complete" },
	annotations: writes({ destructive: true, idempotent: false }),
	input: z.object({
		number: buildNumberInput,
		serials: z
			.array(
				z.object({
					ref: partRef.describe("A serial-tracked component."),
					serials: z.array(z.string().trim().min(1).max(100)).min(1).max(1000),
				}),
			)
			.max(200)
			.default([]),
		sub_assemblies: z
			.array(
				z.object({
					ref: partRef.optional().describe("A make part of the assembly: applies to each place it appears."),
					path: z
						.string()
						.regex(/^\d+(\/\d+)*$/)
						.optional()
						.describe("Or one place, by the path get_build shows."),
					mode: z
						.enum(["stock", "build"])
						.describe("stock: take it from stock; build: build it now from its assembly."),
				}),
			)
			.max(200)
			.default([]),
	}),
	run: async (a, ctx) => {
		const { build, part, assembly } = await buildByNumber(ctx.db, a.number);
		if (!OPEN_STATUSES.includes(build.status)) refuse({ _: "build_not_open" });
		const [graph, onHand, picks] = await Promise.all([
			loadGraph(ctx.db),
			onHandByKey(ctx.db),
			buildPicks(ctx.db, build.id),
		]);
		const form: Record<string, string> = {};
		// Every place a make part can appear (the assembly exploded with no stock: all built), to apply a choice by reference.
		const everywhere = exploding(() => explode(graph, build.assemblyId, build.qtyMilli, { stock: new Map() }));
		const makePaths = [...walkTree(everywhere.tree)].filter((n) => n.part.kind === "make");
		for (const choice of a.sub_assemblies) {
			if (!choice.ref === !choice.path) throw new ToolError("Give either ref or path for each sub-assembly choice.");
			const paths = choice.path
				? makePaths.filter((n) => n.path === choice.path).map((n) => n.path)
				: makePaths.filter((n) => n.part.ref.toLowerCase() === choice.ref?.toLowerCase()).map((n) => n.path);
			if (paths.length === 0)
				throw new ToolError(
					`${choice.ref ?? choice.path} is not a sub-assembly of build ${build.number}. get_build lists them.`,
				);
			for (const path of paths) form[choiceField(path)] = choice.mode;
		}
		// Serials go in the pick list's fields; the pick list then checks them as on the page.
		const given = new Map<number, string>();
		for (const s of a.serials) {
			const component = await partByRef(ctx.db, s.ref);
			if (given.has(component.id)) throw new ToolError(`Serials of ${component.ref} are listed twice.`);
			given.set(component.id, component.ref);
			s.serials.forEach((serial, i) => {
				form[serialField(stockKey(component.id, null), i)] = serial;
			});
		}
		const pick = exploding(() => buildPickList(graph, onHand, { ...build, picks }, part, form, true));
		const problems: string[] = pick.problems.map((p) => errorMessage(p.key, p.vars));
		for (const [id, ref] of given) {
			const needed = pick.serials.get(stockKey(id, null))?.length ?? 0;
			const sent = a.serials.find((s) => s.ref.toLowerCase() === ref.toLowerCase())?.serials.length ?? 0;
			if (needed === 0) problems.push(`${ref}: no serial is scanned for it in this build.`);
			else if (sent > needed) problems.push(`${ref}: ${sent} serials given, ${needed} needed.`);
		}
		for (const [name, key] of Object.entries(pick.errors)) {
			const [, partId, index] = name.split(":");
			const ref = graph.parts.get(Number(partId))?.ref ?? partId;
			problems.push(`${ref} serial ${Number(index) + 1}: ${errorMessage(key)}`);
		}
		if (problems.length) throw new ToolError(`Refused, nothing was changed. ${problems.join(" ")}`);
		let change: Awaited<ReturnType<typeof saveChange>>["change"];
		try {
			({ change } = await saveChange(
				ctx,
				fmt(ctx.t.history.summaries.buildComplete, { number: build.number }),
				completionStatements(ctx.db, graph, { ...build }, pick, ctx.user, now()),
			));
		} catch (err) {
			// The unique build_output index aborts a second completion of the same build.
			if (isConstraintError(err, "UNIQUE")) refuse({ _: "build_not_open" });
			throw err;
		}
		const lines = await getBuildLines(ctx.db, build.id);
		return {
			...change,
			build: {
				number: build.number,
				status: "done",
				part: part.ref,
				unit: part.unit,
				qtyMilli: build.qtyMilli,
				serial: build.serial,
				assembly: { assemblyId: assembly.id, code: assembly.code, revision: assembly.revision },
			},
			asBuilt: lines.map((l) => ({
				ref: l.ref,
				unit: l.unit,
				qtyMilli: l.line.qtyMilli,
				serial: l.line.serial,
				unitCostCents: l.line.unitCostCents,
				madeByBuild: l.sourceBuildNumber ?? undefined,
			})),
		};
	},
});

const recordBuild = tool({
	name: "record_build",
	title: "Record a finished build",
	description:
		"Records a build that is already done, in one step: it is planned and completed now, in one change set, as the Record a finished build page does (for a print run recorded after the fact). Same inputs and checks as plan_build. Components are taken from stock, and sub-assemblies too when there are enough (the others are built now); machine time is recorded. Refused when a serial-tracked component needs serials (then plan_build and complete_build with the serials) or something blocks completion. This writes the stock ledger: it cannot be undone.",
	rule: { scope: "builds:write", action: "builds.complete" },
	annotations: writes({ destructive: true, idempotent: false }),
	input: z.object(buildFields),
	run: async (a, ctx) => {
		if (!can(ctx.access, "builds.plan"))
			throw new ToolError("Refused: your role does not allow planning builds, which recording one does.");
		const { product, assembly, d } = await checkBuildToPlan(a, ctx);
		const [graph, onHand] = await Promise.all([loadGraph(ctx.db), onHandByKey(ctx.db)]);
		const pick = exploding(() =>
			buildPickList(
				graph,
				onHand,
				{ assemblyId: assembly.id, qtyMilli: d.qty, serial: d.serial || null },
				product,
				{},
				true,
			),
		);
		const problems = recordProblems(pick);
		if (problems.length)
			throw new ToolError(
				`Refused, nothing was changed. ${problems.map((p) => errorMessage(p.key, p.vars)).join(" ")}`,
			);
		// Numbers are sequential; retry once if someone took the same number meanwhile (as the page does).
		for (let attempt = 0; ; attempt++) {
			const number = await nextBuildNumber(ctx.db);
			try {
				const { change } = await saveChange(
					ctx,
					fmt(ctx.t.history.summaries.buildRecord, { number, ref: product.ref }),
					recordStatements(
						ctx.db,
						graph,
						{
							number,
							partId: product.id,
							assemblyId: assembly.id,
							qtyMilli: d.qty,
							serial: d.serial || null,
							notes: d.notes,
						},
						pick,
						ctx.user,
						now(),
					),
				);
				const { build } = await buildByNumber(ctx.db, number);
				const [lines, machines] = await Promise.all([
					getBuildLines(ctx.db, build.id),
					getBuildMachineTimes(ctx.db, build.id),
				]);
				return {
					...change,
					build: {
						number,
						status: build.status,
						part: product.ref,
						unit: product.unit,
						qtyMilli: build.qtyMilli,
						serial: build.serial,
						assembly: {
							assemblyId: assembly.id,
							code: assembly.code,
							revision: assembly.revision,
							batchMilli: assembly.batchMilli,
						},
						doneAt: build.doneAt,
					},
					asBuilt: lines.map((l) => ({
						ref: l.ref,
						unit: l.unit,
						qtyMilli: l.line.qtyMilli,
						serial: l.line.serial,
						unitCostCents: l.line.unitCostCents,
						madeByBuild: l.sourceBuildNumber ?? undefined,
					})),
					machineTime: machines.map((m) => ({ type: m.name, minutesMilli: m.minutesMilli })),
				};
			} catch (err) {
				if (attempt > 0 || !isConstraintError(err, "UNIQUE")) throw err;
			}
		}
	},
});

const cancelBuild = tool({
	name: "cancel_build",
	title: "Cancel a build",
	description:
		"Cancels a planned or in-progress build: nothing was consumed, and its serial becomes free again. A done build cannot be cancelled.",
	rule: { scope: "builds:write", action: "builds.plan" },
	annotations: writes({ destructive: true, idempotent: true }),
	input: z.object({ number: buildNumberInput }),
	run: async (a, ctx) => {
		const { build, part } = await buildByNumber(ctx.db, a.number);
		const view = { number: build.number, part: part.ref, qtyMilli: build.qtyMilli, serial: build.serial };
		if (build.status === "cancelled")
			return {
				...NOTHING_CHANGED,
				build: { ...view, status: "cancelled" },
				note: `${build.number} is already cancelled.`,
			};
		if (!OPEN_STATUSES.includes(build.status)) refuse({ _: "build_not_open" });
		const { change } = await saveChange(ctx, fmt(ctx.t.history.summaries.buildCancel, { number: build.number }), [
			cancelBuildStatement(ctx.db, build.id, ctx.user, now()),
		]);
		return { ...change, build: { ...view, status: "cancelled" } };
	},
});

export const BUILD_TOOLS: readonly ToolSpec[] = [planBuild, completeBuild, recordBuild, cancelBuild];
