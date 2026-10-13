// stock:write tools (D127): adjustments and inventory counts, with the pages' checks. They write the stock ledger,
// which is append-only: their change sets cannot be undone, a mistake is corrected with a reverse adjustment.
import { z } from "zod";
import { onHandOf } from "../domain/parts";
import {
	adjustInput,
	adjustmentErrors,
	adjustmentStatement,
	type CountGroup,
	countStatements,
	isStocked,
	onHandAt,
	planCounts,
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

const now = () => new Date().toISOString();

const adjustStock = tool({
	name: "adjust_stock",
	title: "Adjust stock",
	description:
		'Records a stock adjustment of a buy or make part: a signed quantity ("5" found, "-2" scrapped) with a required note saying why, valued at the part\'s standard cost. With a serial of a serial-tracked part the quantity is 1 or -1. This writes the stock ledger: it cannot be undone, only corrected with the opposite adjustment.',
	rule: { scope: "stock:write", action: "stock.adjust" },
	annotations: writes({ destructive: true, idempotent: false }),
	input: z.object({
		ref: partRef,
		qty: decimal('Signed quantity in the part\'s unit, e.g. "5" or "-2.5" (never 0).'),
		serial: z.string().max(100).default("").describe("Serial number, for one unit of a serial-tracked part."),
		note: z.string().max(500).describe('Why, e.g. "Found during cleanup" or "Scrapped: damaged".'),
	}),
	run: async (a, ctx) => {
		const v = validate(adjustInput, { part: a.ref, qty: formValue(a.qty), serial: a.serial, note: a.note });
		if (!v.ok) refuse(v.errors, {}, { part: "ref" });
		const part = await findPart(ctx.db, a.ref);
		const problems = adjustmentErrors(part, { ...v.data, part: a.ref });
		if (!part || Object.keys(problems.errors).length) refuse(problems.errors, problems.vars, { part: "ref" });
		const { change } = await saveChange(ctx, fmt(ctx.t.history.summaries.stockAdjust, { ref: part.ref }), [
			adjustmentStatement(
				ctx.db,
				{ partId: part.id, qtyMilli: v.data.qty, serial: v.data.serial || null, unitCostCents: part.costCents },
				v.data.note,
				ctx.user,
				now(),
			),
		]);
		return {
			...change,
			part: part.ref,
			unit: part.unit,
			qtyMilli: v.data.qty,
			serial: v.data.serial || undefined,
			onHandMilli: await onHandOf(ctx.db, part.id),
		};
	},
});

const countStock = tool({
	name: "count_stock",
	title: "Post an inventory count",
	description:
		"Posts counted quantities of buy and make parts, as the inventory count page does: for each part, a count move for the difference with the current on-hand (nothing for a part already right). Only the parts listed are touched. This writes the stock ledger: it cannot be undone, only corrected by another count or an adjustment.",
	rule: { scope: "stock:write", action: "stock.count" },
	annotations: writes({ destructive: true, idempotent: true }),
	input: z.object({
		counts: z
			.array(z.object({ ref: partRef, qty: decimal('The quantity counted, e.g. "42" or "12.5" (0 or more).') }))
			.min(1)
			.max(500),
		note: z.string().max(500).default("").describe('Kept on the count moves (default "inventory count").'),
	}),
	run: async (a, ctx) => {
		const problems: string[] = [];
		const groups: CountGroup[] = [];
		const seen = new Set<number>();
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
			else if (seen.has(part.id)) problems.push(`${at}: listed twice.`);
			else {
				seen.add(part.id);
				groups.push({ part, lines: [{ line: i + 1, qtyMilli: v.data.qty, serial: "", unitCostCents: null }] });
			}
		}
		if (problems.length) throw new ToolError(`Refused, nothing was changed. ${problems.join(" ")}`);
		const { moves, results } = planCounts(groups, await onHandAt(ctx.db));
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
				previousMilli: r.current,
				countedMilli: r.counted,
				adjustmentMilli: r.counted - r.current,
			})),
		};
	},
});

export const STOCK_TOOLS: readonly ToolSpec[] = [adjustStock, countStock];
