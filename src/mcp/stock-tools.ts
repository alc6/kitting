// stock:write tools (D127): adjustments and inventory counts, with the pages' checks. They write the stock ledger,
// which is append-only: their change sets cannot be undone, a mistake is corrected with a reverse adjustment.
import { z } from "zod";
import { type OptionDef, type OptionKey, stockKey } from "../domain/option-keys";
import { optionsOf } from "../domain/options";
import { onHandOf } from "../domain/parts";
import {
	adjustInput,
	adjustmentErrors,
	adjustmentStatement,
	type CountGroup,
	countStatements,
	isStocked,
	onHandByKey,
	planCounts,
	stockByKey,
} from "../domain/stock";
import { fmt } from "../i18n";
import { field, validate } from "../lib/validation";
import {
	decimal,
	errorMessage,
	findPart,
	formValue,
	partRef,
	refuse,
	saveChange,
	ToolError,
	type ToolSpec,
	tool,
	writes,
} from "./kit";
import { optionsInput, optionsView, resolveKey } from "./options";

const now = () => new Date().toISOString();

const adjustStock = tool({
	name: "adjust_stock",
	title: "Adjust stock",
	description:
		'Records a stock adjustment of a buy or make part: a signed quantity ("5" found, "-2" scrapped) with a required note saying why, valued at the part\'s standard cost. A part with options is adjusted in one value of each (options). With a serial of a serial-tracked part the quantity is 1 or -1. This writes the stock ledger: it cannot be undone, only corrected with the opposite adjustment.',
	rule: { scope: "stock:write", action: "stock.adjust" },
	annotations: writes({ destructive: true, idempotent: false }),
	input: z.object({
		ref: partRef,
		qty: decimal('Signed quantity in the part\'s unit, e.g. "5" or "-2.5" (never 0).'),
		serial: z.string().max(100).default("").describe("Serial number, for one unit of a serial-tracked part."),
		options: optionsInput("the stock moved"),
		note: z.string().max(500).describe('Why, e.g. "Found during cleanup" or "Scrapped: damaged".'),
	}),
	run: async (a, ctx) => {
		const v = validate(adjustInput, { part: a.ref, qty: formValue(a.qty), serial: a.serial, note: a.note });
		if (!v.ok) refuse(v.errors, {}, { part: "ref" });
		const part = await findPart(ctx.db, a.ref);
		const problems = adjustmentErrors(part, { ...v.data, part: a.ref });
		if (!part || Object.keys(problems.errors).length) refuse(problems.errors, problems.vars, { part: "ref" });
		// A part with options is counted in one value of each (D169): stock never sits on an incomplete key.
		const defs = await optionsOf(ctx.db, part.id);
		const optionValues = resolveKey(defs, a.options, `${part.ref} options`, { require: true });
		const { change } = await saveChange(ctx, fmt(ctx.t.history.summaries.stockAdjust, { ref: part.ref }), [
			adjustmentStatement(
				ctx.db,
				{
					partId: part.id,
					qtyMilli: v.data.qty,
					serial: v.data.serial || null,
					unitCostCents: part.costCents,
					optionValues,
				},
				v.data.note,
				ctx.user,
				now(),
			),
		]);
		const inValues = defs.length
			? ((await stockByKey(ctx.db, null, part.id)).find((r) => r.optionValues === optionValues)?.qty ?? 0)
			: undefined;
		const total = await onHandOf(ctx.db, part.id);
		return {
			...change,
			part: part.ref,
			unit: part.unit,
			options: optionsView(defs, optionValues),
			qtyMilli: v.data.qty,
			serial: v.data.serial || undefined,
			// With options, the stock in these values; the whole part's apart.
			onHandMilli: inValues ?? total,
			totalOnHandMilli: inValues === undefined ? undefined : total,
		};
	},
});

const countStock = tool({
	name: "count_stock",
	title: "Post an inventory count",
	description:
		"Posts counted quantities of buy and make parts, as the inventory count page does: for each part, a count move for the difference with the current on-hand (nothing for a part already right). A part with options is counted per values: one entry per values (options), and only the values listed are touched. Only the parts listed are touched. This writes the stock ledger: it cannot be undone, only corrected by another count or an adjustment.",
	rule: { scope: "stock:write", action: "stock.count" },
	annotations: writes({ destructive: true, idempotent: true }),
	input: z.object({
		counts: z
			.array(
				z.object({
					ref: partRef,
					options: optionsInput("the stock counted"),
					qty: decimal('The quantity counted, e.g. "42" or "12.5" (0 or more).'),
				}),
			)
			.min(1)
			.max(500),
		note: z.string().max(500).default("").describe('Kept on the count moves (default "inventory count").'),
	}),
	run: async (a, ctx) => {
		const problems: string[] = [];
		const groups: CountGroup[] = [];
		const seen = new Set<string>();
		const defsOf = new Map<number, OptionDef[]>();
		for (const [i, c] of a.counts.entries()) {
			const at = `line ${i + 1} (${c.ref})`;
			const v = validate(z.object({ qty: field.qty() }), { qty: formValue(c.qty) });
			if (!v.ok) {
				problems.push(`${at}: ${errorMessage(v.errors.qty ?? "invalid")}`);
				continue;
			}
			const part = await findPart(ctx.db, c.ref);
			if (!part) problems.push(`${at}: ${errorMessage("unknown_part", { ref: c.ref })}`);
			else if (!isStocked(part.kind)) problems.push(`${at}: ${errorMessage("not_stocked", { kind: part.kind })}`);
			else {
				if (!defsOf.has(part.id)) defsOf.set(part.id, await optionsOf(ctx.db, part.id));
				const defs = defsOf.get(part.id) ?? [];
				let optionValues: OptionKey = null;
				try {
					optionValues = resolveKey(defs, c.options, `${at} options`, { require: true });
				} catch (err) {
					if (!(err instanceof ToolError)) throw err;
					problems.push(err.message);
					continue;
				}
				const key = stockKey(part.id, optionValues);
				if (seen.has(key)) problems.push(`${at}: listed twice${optionValues ? " in these options" : ""}.`);
				else {
					seen.add(key);
					groups.push({
						part,
						optionValues,
						lines: [{ line: i + 1, qtyMilli: v.data.qty, serial: "", unitCostCents: null }],
					});
				}
			}
		}
		if (problems.length) throw new ToolError(`Refused, nothing was changed. ${problems.join(" ")}`);
		const { moves, results } = planCounts(groups, await onHandByKey(ctx.db));
		const { change } = await saveChange(
			ctx,
			fmt(ctx.t.history.summaries.stockCount, { n: new Set(moves.map((m) => m.partId)).size }),
			countStatements(ctx.db, moves, a.note.trim() || "inventory count", ctx.user, now()),
		);
		return {
			...change,
			adjusted: moves.length,
			counts: results.map((r) => ({
				ref: r.part.ref,
				unit: r.part.unit,
				options: optionsView(defsOf.get(r.part.id) ?? [], r.optionValues),
				previousMilli: r.current,
				countedMilli: r.counted,
				adjustmentMilli: r.counted - r.current,
			})),
		};
	},
});

export const STOCK_TOOLS: readonly ToolSpec[] = [adjustStock, countStock];
