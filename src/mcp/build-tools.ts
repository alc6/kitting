// builds:write tools (D127): plan, complete and cancel builds with the pages' checks. Completion goes through the
// pick list exactly as the build page does: re-exploded with current stock and the given choices, the same serial
// checks, the same completion batch. It writes the stock ledger, so it cannot be undone.
import { sql } from "drizzle-orm";
import { z } from "zod";
import { loadGraph } from "../domain/assemblies";
import { explode, walkTree } from "../domain/assembly-graph";
import {
	buildableProduct,
	buildChoicesStatements,
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
import { keyLabel, type OptionDef, type OptionKey, stockKey } from "../domain/option-keys";
import { loadOptions } from "../domain/options";
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
import { choicesInput, choicesView, optionsInput, optionsView, readToolBuildValues, selectByOptions } from "./options";

const now = () => new Date().toISOString();

/** `serial:<partId>:<i>`, or `serial:<partId>:<values>:<i>` for a part in some option values (D169). */
const SERIAL_FIELD = /^serial:(\d+)(?::(\d+(?:,\d+)*))?:(\d+)$/;

/** "LED-5W (Colour: white)": a requirement's part and values. */
const requirementLabel = (r: { part: { ref: string; options: OptionDef[] }; optionValues: OptionKey }) =>
	r.optionValues ? `${r.part.ref} (${keyLabel(r.part.options, r.optionValues)})` : r.part.ref;

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
	options: optionsInput("the product to build"),
	choices: choicesInput,
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
		options?: Record<string, string> | undefined;
		choices: { ref: string; options: Record<string, string> }[];
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
	// The values of the product and of the components its recipe leaves to the build (D170, D172).
	const graph = await loadGraph(ctx.db);
	const values = readToolBuildValues(graph, product, assembly.id, d.qty, a);
	return { product, assembly, d, graph, values };
}

const planBuild = tool({
	name: "plan_build",
	title: "Plan a build",
	description:
		"Plans a build (production order) of a make part from one of its active assemblies, as the new build form does. A product with options is planned in one value of each (options), and components whose recipe lines leave options to the build need their values too (choices): they are stored on the build and followed by the pick list, the shortages and completion. A serial-tracked product is built one unit at a time with its own serial, unused by other builds. Then get_build shows its pick list and complete_build records it.",
	rule: { scope: "builds:write", action: "builds.plan" },
	annotations: writes({ destructive: false, idempotent: false }),
	input: z.object({ ...buildFields, planned_for: date.optional() }),
	run: async (a, ctx) => {
		const { product, assembly, d, graph, values } = await checkBuildToPlan(a, ctx);
		// Numbers are sequential; retry once if someone took the same number meanwhile (as the page does).
		for (let attempt = 0; ; attempt++) {
			const number = await nextBuildNumber(ctx.db);
			try {
				const stamp = now();
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
								optionValues: values.optionValues,
							},
							ctx.user,
							stamp,
						),
						...buildChoicesStatements(
							ctx.db,
							sql`(SELECT id FROM builds WHERE number = ${number})`,
							values.picks,
							ctx.user,
							stamp,
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
						options: optionsView(graph.parts.get(product.id)?.options ?? [], values.optionValues),
						choices: choicesView(graph.parts, values.picks),
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
		"Records a planned or in-progress build as done, as the build page's pick list does: components are consumed from stock, the product is added, and the as-built record keeps every serial and frozen unit cost. Give one serial per unit of each serial-tracked component (get_build lists them under serials_to_scan; options tells which values when the build consumes the part in several). The values are those stored when the build was planned. Sub-assemblies (make parts) are taken from stock when there is enough, else built now; override per sub-assembly with sub_assemblies (by ref for every occurrence, or by the path get_build shows). Refused, with the reasons, when a serial is missing or repeated, a sub-assembly to build has no active assembly, or the product needs a serial. This writes the stock ledger: it cannot be undone.",
	rule: { scope: "builds:write", action: "builds.complete" },
	annotations: writes({ destructive: true, idempotent: false }),
	input: z.object({
		number: buildNumberInput,
		serials: z
			.array(
				z.object({
					ref: partRef.describe("A serial-tracked component."),
					options: optionsInput(
						"the component, when the build uses it in several values (get_build lists each in its pick list)",
					),
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
		// Serials go in the pick list's fields, named by the requirement's part and values (D169): a first pass
		// without serials tells which requirements the build has, then each entry is matched to one by ref and options.
		const first = exploding(() => buildPickList(graph, onHand, { ...build, picks }, part, form, false));
		const problems: string[] = [];
		const given = new Map<string, { label: string; sent: number }>();
		for (const s of a.serials) {
			const component = await partByRef(ctx.db, s.ref);
			const at = `Serials of ${component.ref}`;
			const { item: req } = selectByOptions(
				first.explosion.requirements.filter((r) => r.part.id === component.id && r.part.trackSerial),
				graph.parts.get(component.id)?.options ?? [],
				s.options,
				(r) => r.optionValues,
				at,
			);
			if (!req) {
				problems.push(`${s.ref}: no serial is scanned for it in this build${s.options ? " in these options" : ""}.`);
				continue;
			}
			const key = stockKey(req.part.id, req.optionValues);
			if (given.has(key)) {
				problems.push(`${at} are listed twice${req.optionValues ? " in these options" : ""}.`);
				continue;
			}
			given.set(key, { label: requirementLabel(req), sent: s.serials.length });
			s.serials.forEach((serial, i) => {
				form[serialField(key, i)] = serial;
			});
		}
		const pick = exploding(() => buildPickList(graph, onHand, { ...build, picks }, part, form, true));
		problems.push(...pick.problems.map((p) => errorMessage(p.key, p.vars)));
		for (const [key, { label, sent }] of given) {
			const needed = pick.serials.get(key)?.length ?? 0;
			if (sent > needed) problems.push(`${label}: ${sent} serials given, ${needed} needed.`);
		}
		for (const [name, key] of Object.entries(pick.errors)) {
			// serial:<partId>[:<values>]:<index>
			const found = SERIAL_FIELD.exec(name);
			const req = pick.explosion.requirements.find(
				(r) => stockKey(r.part.id, r.optionValues) === stockKey(Number(found?.[1]), found?.[2] ?? null),
			);
			problems.push(`${req ? requirementLabel(req) : name} serial ${Number(found?.[3]) + 1}: ${errorMessage(key)}`);
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
		const [lines, options] = await Promise.all([getBuildLines(ctx.db, build.id), loadOptions(ctx.db)]);
		return {
			...change,
			build: {
				number: build.number,
				status: "done",
				part: part.ref,
				unit: part.unit,
				qtyMilli: build.qtyMilli,
				serial: build.serial,
				options: optionsView(options.get(part.id) ?? [], build.optionValues),
				choices: choicesView(graph.parts, picks),
				assembly: { assemblyId: assembly.id, code: assembly.code, revision: assembly.revision },
			},
			asBuilt: lines.map((l) => ({
				ref: l.ref,
				unit: l.unit,
				options: optionsView(options.get(l.line.partId) ?? [], l.line.optionValues),
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
		"Records a build that is already done, in one step: it is planned and completed now, in one change set, as the Record a finished build page does (for a print run recorded after the fact). Same inputs and checks as plan_build (options, choices included). Components are taken from stock, and sub-assemblies too when there are enough (the others are built now); machine time is recorded. Refused when a serial-tracked component needs serials (then plan_build and complete_build with the serials) or something blocks completion. This writes the stock ledger: it cannot be undone.",
	rule: { scope: "builds:write", action: "builds.complete" },
	annotations: writes({ destructive: true, idempotent: false }),
	input: z.object(buildFields),
	run: async (a, ctx) => {
		if (!can(ctx.access, "builds.plan"))
			throw new ToolError("Refused: your role does not allow planning builds, which recording one does.");
		const { product, assembly, d, graph, values } = await checkBuildToPlan(a, ctx);
		const onHand = await onHandByKey(ctx.db);
		const { optionValues, picks } = values;
		const pick = exploding(() =>
			buildPickList(
				graph,
				onHand,
				{ assemblyId: assembly.id, qtyMilli: d.qty, serial: d.serial || null, optionValues, picks },
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
							optionValues,
							picks,
						},
						pick,
						ctx.user,
						now(),
					),
				);
				const { build } = await buildByNumber(ctx.db, number);
				const [lines, machines, options] = await Promise.all([
					getBuildLines(ctx.db, build.id),
					getBuildMachineTimes(ctx.db, build.id),
					loadOptions(ctx.db),
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
						options: optionsView(options.get(product.id) ?? [], optionValues),
						choices: choicesView(graph.parts, picks),
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
						options: optionsView(options.get(l.line.partId) ?? [], l.line.optionValues),
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
