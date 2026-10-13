// builds:write tools (D127): plan, complete and cancel builds with the pages' checks. Completion goes through the
// pick list exactly as the build page does: re-exploded with current stock and the given choices, the same serial
// checks, the same completion batch. It writes the stock ledger, so it cannot be undone.
import { z } from "zod";
import { explode, walkTree } from "../domain/bom-graph";
import { loadGraph } from "../domain/boms";
import {
	buildableProduct,
	buildInput,
	buildPickList,
	buildPlanErrors,
	cancelBuildStatement,
	choiceField,
	completionStatements,
	createBuildStatement,
	getBuildLines,
	nextBuildNumber,
	OPEN_STATUSES,
	serialField,
} from "../domain/builds";
import { onHandAt } from "../domain/stock";
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
	ToolError,
	type ToolSpec,
	tool,
	writes,
} from "./kit";

const now = () => new Date().toISOString();

const buildNumberInput = z.string().trim().min(1).max(32).describe('The build number, e.g. "B-0001".');

const planBuild = tool({
	name: "plan_build",
	title: "Plan a build",
	description:
		"Plans a build (production order) of a make part from one of its active BoMs, as the new build form does. A serial-tracked product is built one unit at a time with its own serial, unused by other builds. Then get_build shows its pick list and complete_build records it.",
	rule: { scope: "builds:write", action: "builds.plan" },
	annotations: writes({ destructive: false, idempotent: false }),
	input: z.object({
		ref: partRef.describe("Reference of the make part to build."),
		qty: decimal('How many to build (default "1").').optional(),
		code: z
			.string()
			.trim()
			.min(1)
			.max(64)
			.optional()
			.describe('Variant code of the active BoM to use (default "std", else its only active BoM).'),
		serial: z.string().max(100).default("").describe("Serial number of the product (serial-tracked products)."),
		planned_for: date.optional(),
		notes: z.string().max(2000).default(""),
	}),
	run: async (a, ctx) => {
		const part = await partByRef(ctx.db, a.ref);
		const { product, bomOptions } = await buildableProduct(ctx.db, part.id);
		const bom = a.code
			? bomOptions.find((b) => b.code === a.code)
			: (bomOptions.find((b) => b.code === "std") ?? bomOptions[0]);
		const v = validate(buildInput, {
			part_id: String(part.id),
			bom_id: bom ? String(bom.id) : "",
			qty: formValue(a.qty),
			serial: a.serial,
			planned_for: a.planned_for ?? "",
			notes: a.notes,
		});
		if (!v.ok) refuse(v.errors, {}, { part_id: "ref", bom_id: "code" });
		const errors = await buildPlanErrors(ctx.db, v.data, product, bomOptions);
		if (Object.keys(errors).length || !product || !bom) refuse(errors, {}, { part_id: "ref", bom_id: "code" });
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
								bomId: bom.id,
								qtyMilli: v.data.qty,
								serial: v.data.serial || null,
								plannedFor: v.data.planned_for,
								notes: v.data.notes,
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
						qtyMilli: v.data.qty,
						serial: v.data.serial || null,
						bom: { bomId: bom.id, code: bom.code, revision: bom.revision },
						plannedFor: v.data.planned_for,
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
		"Records a planned or in-progress build as done, as the build page's pick list does: components are consumed from stock, the product is added, and the as-built record keeps every serial and frozen unit cost. Give one serial per unit of each serial-tracked component (get_build lists them under serials_to_scan). Sub-assemblies (make parts) are taken from stock when there is enough, else built now; override per sub-assembly with sub_assemblies (by ref for every occurrence, or by the path get_build shows). Refused, with the reasons, when a serial is missing or repeated, a sub-assembly to build has no active BoM, or the product needs a serial. This writes the stock ledger: it cannot be undone.",
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
					ref: partRef.optional().describe("A make part of the BoM: applies to each place it appears."),
					path: z
						.string()
						.regex(/^\d+(\/\d+)*$/)
						.optional()
						.describe("Or one place, by the path get_build shows."),
					mode: z.enum(["stock", "build"]).describe("stock: take it from stock; build: build it now from its BoM."),
				}),
			)
			.max(200)
			.default([]),
	}),
	run: async (a, ctx) => {
		const { build, part, bom } = await buildByNumber(ctx.db, a.number);
		if (!OPEN_STATUSES.includes(build.status)) refuse({ _: "build_not_open" });
		const [graph, onHand] = await Promise.all([loadGraph(ctx.db), onHandAt(ctx.db)]);
		const form: Record<string, string> = {};
		// Every place a make part can appear (the BoM exploded with no stock: all built), to apply a choice by reference.
		const everywhere = exploding(() => explode(graph, build.bomId, build.qtyMilli, { stock: new Map() }));
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
				form[serialField(component.id, i)] = serial;
			});
		}
		const pick = exploding(() => buildPickList(graph, onHand, build, part, form, true));
		const problems: string[] = pick.problems.map((p) => errorMessage(p.key, p.vars));
		for (const [id, ref] of given) {
			const needed = pick.serials.get(id)?.length ?? 0;
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
				bom: { bomId: bom.id, code: bom.code, revision: bom.revision },
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

export const BUILD_TOOLS: readonly ToolSpec[] = [planBuild, completeBuild, cancelBuild];
