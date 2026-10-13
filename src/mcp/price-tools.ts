// prices:write tools (D127): standard costs, selling prices (of a part or a BoM variant) and supplier offers. Every
// price change appends its row to the price history in the same change set, exactly as the pages do.
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { boms } from "../db/schema";
import { bomLabel, bomSalePriceStatements, getBom } from "../domain/boms";
import { getOffer, offerInput, offerToForm } from "../domain/offers";
import { getPart, offerFormStatements, setSalePriceStatements, setStandardCostStatements } from "../domain/parts";
import { isStocked } from "../domain/stock";
import { fmt } from "../i18n";
import { field, validate } from "../lib/validation";
import { supplierByName } from "./catalog-tools";
import {
	decimal,
	errorMessage,
	formValue,
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

const OFFER_KIND = "Only buy and make parts have supplier offers: kits and fees are never purchased.";

/** An amount, or null for "unknown" / "none", parsed by the form's money field (at most 2 decimals, not negative). */
const amount = (description: string) =>
	z.union([z.string().trim().max(32), z.number(), z.null()]).describe(`${description} null clears it.`);

const parseAmount = (value: string | number | null, name: string): number | null => {
	const v = validate(z.object({ [name]: field.money() }), { [name]: formValue(value) });
	if (!v.ok) refuse(v.errors);
	return v.data[name] as number | null;
};

const setStandardCost = tool({
	name: "set_standard_cost",
	title: "Set a standard cost",
	description:
		"Sets a part's standard cost (the unit cost used in cost roll-ups, valuations and planned margins). The change is appended to the part's price history, with the note if given.",
	rule: { scope: "prices:write", action: "prices.edit" },
	annotations: writes({ destructive: true, idempotent: true }),
	input: z.object({
		ref: partRef,
		cost: amount('The unit cost in the workshop\'s currency, e.g. "4.20".'),
		note: z.string().max(200).default("").describe("Why or where from, kept in the price history."),
	}),
	run: async (a, ctx) => {
		const part = await partByRef(ctx.db, a.ref);
		const cents = parseAmount(a.cost, "cost");
		const { change } = await saveChange(
			ctx,
			fmt(ctx.t.history.summaries.partCost, { ref: part.ref }),
			setStandardCostStatements(ctx.db, part, cents, "form", ctx.user, now(), a.note),
		);
		return { ...change, part: part.ref, standardCostCents: cents, previousStandardCostCents: part.costCents };
	},
});

const setSalePrice = tool({
	name: "set_sale_price",
	title: "Set a selling price",
	description:
		"Sets the selling price of a part, or of one of its BoM variants (code, and revision when not the active one) which then overrides the part's price for that variant. Appended to the price history. Archived BoMs are read-only.",
	rule: { scope: "prices:write", action: "prices.edit" },
	annotations: writes({ destructive: true, idempotent: true }),
	input: z.object({
		ref: partRef,
		price: amount('The selling price, e.g. "89.00".'),
		code: z.string().trim().min(1).max(64).optional().describe("A BoM variant code, to price that variant."),
		revision: z
			.string()
			.trim()
			.min(1)
			.max(64)
			.optional()
			.describe("With code: a specific revision (default: the active one)."),
	}),
	run: async (a, ctx) => {
		const part = await partByRef(ctx.db, a.ref);
		const cents = parseAmount(a.price, "price");
		if (a.revision !== undefined && a.code === undefined)
			throw new ToolError("revision needs code: give the BoM's variant code too (get_part lists them).");
		if (a.code === undefined) {
			const { change } = await saveChange(
				ctx,
				fmt(ctx.t.history.summaries.partSalePrice, { ref: part.ref }),
				setSalePriceStatements(ctx.db, part, cents, "form", ctx.user, now()),
			);
			return { ...change, part: part.ref, salePriceCents: cents, previousSalePriceCents: part.salePriceCents };
		}
		const conds = [eq(boms.parentPartId, part.id), eq(boms.code, a.code)];
		conds.push(a.revision ? eq(boms.revision, a.revision) : eq(boms.status, "active"));
		const hit = (
			await ctx.db
				.select({ id: boms.id })
				.from(boms)
				.where(and(...conds))
				.limit(1)
		)[0];
		const found = hit ? await getBom(ctx.db, hit.id) : undefined;
		if (!found)
			throw new ToolError(
				`${part.ref} has no ${a.revision ? `revision ${a.revision} of` : "active"} BoM "${a.code}". Use get_part to list its BoMs.`,
			);
		const label = bomLabel(part.ref, found.bom);
		if (found.bom.status === "archived") throw new ToolError(`BoM ${label}: ${errorMessage("bom_archived")}`);
		const { change } = await saveChange(
			ctx,
			fmt(ctx.t.history.summaries.bomSalePrice, { bom: label }),
			bomSalePriceStatements(ctx.db, found.bom, cents, ctx.user, now()),
		);
		return {
			...change,
			part: part.ref,
			bom: { bomId: found.bom.id, code: found.bom.code, revision: found.bom.revision },
			salePriceCents: cents,
			previousSalePriceCents: found.bom.salePriceCents,
		};
	},
});

const upsertSupplierOffer = tool({
	name: "upsert_supplier_offer",
	title: "Create or edit a supplier offer",
	description:
		"Creates a supplier's offer for a buy or make part, or edits it (fields left out keep their value): the supplier's reference, unit price, minimum order quantity, pack size, lead time and notes. preferred: true makes this supplier the part's preferred one (used by shortages and draft POs); false never removes the preference. set_standard_cost: true also makes the price the part's standard cost. Price changes are appended to the price history.",
	rule: { scope: "prices:write", action: "prices.edit" },
	annotations: writes({ destructive: true, idempotent: true }),
	input: z.object({
		ref: partRef,
		supplier: z.string().trim().min(1).max(200).describe("The supplier's name (case-insensitive)."),
		supplier_ref: z.string().max(100).optional().describe("The supplier's own reference for the part."),
		price: amount('Unit price from this supplier, e.g. "4.10".').optional(),
		moq: decimal('Minimum order quantity, e.g. "10" ("0": none).').optional(),
		pack_size: decimal('Pack size: orders are rounded up to a multiple of it ("0": none).').optional(),
		lead_days: z.number().int().min(0).max(3650).optional().describe("Lead time in days."),
		notes: z.string().max(2000).optional(),
		preferred: z
			.boolean()
			.optional()
			.describe("Make this supplier the preferred one (default for a part's first offer)."),
		set_standard_cost: z.boolean().default(false).describe("Also make this price the part's standard cost."),
	}),
	run: async (a, ctx) => {
		const part = await partByRef(ctx.db, a.ref);
		if (!isStocked(part.kind)) throw new ToolError(`${part.ref} is a ${part.kind} part. ${OFFER_KIND}`);
		const supplier = await supplierByName(ctx.db, a.supplier);
		const existing = await getOffer(ctx.db, part.id, supplier.id);
		const isPreferred = part.supplierId === supplier.id;
		// The current terms (or the defaults of a new offer: preferred when the part has none), with the given fields.
		const form: Record<string, string> = existing
			? offerToForm(existing, isPreferred, "en")
			: { preferred: part.supplierId === null ? "on" : "" };
		form.supplier_id = String(supplier.id);
		if (a.supplier_ref !== undefined) form.supplier_ref = a.supplier_ref;
		if (a.price !== undefined) form.price = formValue(a.price);
		if (a.moq !== undefined) form.moq = formValue(a.moq);
		if (a.pack_size !== undefined) form.pack_size = formValue(a.pack_size);
		if (a.lead_days !== undefined) form.lead_days = String(a.lead_days);
		if (a.notes !== undefined) form.notes = a.notes;
		if (a.preferred !== undefined) form.preferred = formValue(a.preferred);
		form.set_standard_cost = formValue(a.set_standard_cost);
		const v = validate(offerInput, form);
		if (!v.ok) refuse(v.errors);
		if (v.data.set_standard_cost && v.data.price === null) refuse({ set_standard_cost: "standard_needs_price" });
		const summaries = ctx.t.history.summaries;
		const { change } = await saveChange(
			ctx,
			fmt(existing ? summaries.offerEdit : summaries.offerCreate, { supplier: supplier.name, ref: part.ref }),
			offerFormStatements(
				ctx.db,
				part,
				supplier.id,
				v.data,
				existing,
				fmt(ctx.t.parts.noteOffer, { supplier: supplier.name }),
				ctx.user,
				now(),
			),
		);
		const [offer, after] = await Promise.all([getOffer(ctx.db, part.id, supplier.id), getPart(ctx.db, part.id)]);
		return {
			...change,
			created: !existing,
			part: part.ref,
			offer: offer
				? {
						supplier: supplier.name,
						preferred: after?.supplierId === supplier.id,
						supplierRef: offer.supplierRef,
						priceCents: offer.priceCents,
						moqMilli: offer.moqMilli,
						packSizeMilli: offer.packSizeMilli,
						leadDays: offer.leadDays,
						notes: offer.notes || undefined,
					}
				: null,
			standardCostCents: after?.costCents ?? null,
		};
	},
});

export const PRICE_TOOLS: readonly ToolSpec[] = [setStandardCost, setSalePrice, upsertSupplierOffer];
