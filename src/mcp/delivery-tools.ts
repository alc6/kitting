// Customer delivery tools (D216): reading deliveries (stock:read) and shipping or cancelling one (stock:write), with
// the delivery page's checks. A delivery writes the stock ledger: its change set cannot be undone, only the delivery
// cancelled (opposite moves).
import { z } from "zod";
import { DELIVERY_STATUSES } from "../db/schema";
import {
	cancelDeliveryStatements,
	type DeliveryLine,
	type DeliveryLineRequest,
	deliveryByNumber,
	deliveryHeader,
	deliveryInput,
	deliveryStatements,
	isGuardError,
	listDeliveries,
	nextDeliveryNumber,
	planDelivery,
	serialsBackInStock,
} from "../domain/deliveries";
import type { OptionDef } from "../domain/option-keys";
import { loadOptions, optionsOf } from "../domain/options";
import { isStocked } from "../domain/stock";
import { fmt } from "../i18n";
import { isConstraintError } from "../lib/sql";
import { type FieldErrors, validate } from "../lib/validation";
import type { Db } from "../types";
import {
	date,
	decimal,
	errorMessage,
	findPart,
	formValue,
	limit,
	NOTHING_CHANGED,
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

const deliveryNumberInput = z.string().trim().min(1).max(20).describe('A delivery number, e.g. "D-0003".');

type Found = NonNullable<Awaited<ReturnType<typeof deliveryByNumber>>>;

/** A delivery as the tools return it: its header and what left, line by line. */
async function deliveryViews(db: Db, found: Found[]) {
	const options = await loadOptions(db, [
		...new Set(found.flatMap((f) => f.lines.filter((l) => l.optionValues).map((l) => l.partId))),
	]);
	const line = (l: DeliveryLine) => ({
		ref: l.ref,
		name: l.name,
		unit: l.unit,
		options: optionsView(options.get(l.partId) ?? [], l.optionValues),
		qtyMilli: l.qtyMilli,
		serial: l.serial ?? undefined,
		build: l.buildNumber ?? undefined,
	});
	return found.map(({ delivery: d, lines }) => ({
		number: d.number,
		status: d.status,
		customer: d.customer,
		customerRef: d.customerRef || undefined,
		shippedOn: d.shippedOn,
		carrier: d.carrier || undefined,
		trackingNumber: d.trackingNumber || undefined,
		notes: d.notes || undefined,
		cancelledAt: d.cancelledAt ?? undefined,
		by: d.createdBy,
		lines: lines.map(line),
	}));
}

async function deliveryView(db: Db, found: Found) {
	const [view] = await deliveryViews(db, [found]);
	return view;
}

/** Refuses a delivery's lines, each error with its own words (two lines can name two parts). */
function refuseLines(plan: { errors: FieldErrors; vars: Record<string, Record<string, string>> }): never {
	const lines = Object.entries(plan.errors).map(([name, key]) => {
		const message = errorMessage(key, plan.vars[name] ?? {});
		return name === "_" ? message : `${name}: ${message}`;
	});
	throw new ToolError(`Refused, nothing was changed. ${lines.join(" ")}`);
}

async function byNumber(db: Db, number: string): Promise<Found> {
	const found = await deliveryByNumber(db, number);
	if (!found) throw new ToolError(`No delivery numbered "${number}". Use list_deliveries to find it.`);
	return found;
}

const listDeliveriesTool = tool({
	name: "list_deliveries",
	title: "Customer deliveries",
	description:
		"Customer deliveries, newest first: number, customer, date, status (shipped or cancelled) and what left (parts, quantities, serials, the build that made each serial). The query matches numbers, customers, their references, tracking numbers, part references and names, and serials: use it to find where a serial went.",
	rule: { scope: "stock:read" },
	input: z.object({
		query: z
			.string()
			.trim()
			.max(100)
			.optional()
			.describe("Text to look for: a delivery number, a customer, a serial, a part reference…"),
		status: z.enum(DELIVERY_STATUSES).optional(),
		limit: limit(50, 300),
	}),
	run: async (a, { db }) => {
		const rows = await listDeliveries(db, { q: a.query ?? "", status: a.status ?? "", limit: a.limit });
		return { count: rows.length, deliveries: await deliveryViews(db, rows) };
	},
});

const getDeliveryTool = tool({
	name: "get_delivery",
	title: "Get a customer delivery",
	description: "One customer delivery by number: its customer, dates, tracking, status and every line that left.",
	rule: { scope: "stock:read" },
	input: z.object({ number: deliveryNumberInput }),
	run: async (a, { db }) => ({ delivery: await deliveryView(db, await byNumber(db, a.number)) }),
});

const recordDelivery = tool({
	name: "record_delivery",
	title: "Deliver to a customer",
	description:
		"Records a delivery to a customer, as the delivery page does: buy or make parts leave stock (negative moves, valued at standard cost) under a new number D-xxxx. Each line names a part with a quantity, or for a serial-tracked part one serial per unit: each serial must be in stock (a completed build's output, a receipt, a count) and leaves in its own option values. A part with options and no serials needs its values (options). Other parts may go below zero, as on the page. Nothing is written if one line is wrong. This writes the stock ledger: it cannot be undone, only cancelled with cancel_delivery (the units come back).",
	rule: { scope: "stock:write", action: "deliveries.ship" },
	annotations: writes({ destructive: true, idempotent: false }),
	input: z.object({
		customer: z
			.string()
			.trim()
			.min(1)
			.max(200)
			.describe("Who receives it, as written before (list_deliveries shows the customers already used)."),
		customer_ref: z.string().trim().max(100).default("").describe("The customer's order or purchase order number."),
		shipped_on: date.optional().describe("The shipping date, YYYY-MM-DD (UTC). Default: today."),
		carrier: z.string().trim().max(100).default(""),
		tracking_number: z.string().trim().max(100).default(""),
		notes: z.string().max(2000).default(""),
		lines: z
			.array(
				z.object({
					ref: partRef,
					qty: decimal(
						'Quantity in the part\'s unit, e.g. "2". Leave out for a serial-tracked part: one per serial.',
					).optional(),
					serials: z
						.array(z.string().trim().min(1).max(100))
						.max(500)
						.default([])
						.describe("The serial of each unit, for a serial-tracked part (only then)."),
					options: optionsInput(
						"the units delivered",
						"Required, with a value for every option, for a part with options and no serials; leave out for serials (each leaves in its own values).",
					),
				}),
			)
			.min(1)
			.max(50),
	}),
	run: async (a, ctx) => {
		const v = validate(deliveryInput, {
			customer: a.customer,
			customer_ref: a.customer_ref,
			shipped_on: a.shipped_on ?? "",
			carrier: a.carrier,
			tracking_number: a.tracking_number,
			notes: a.notes,
		});
		if (!v.ok) refuse(v.errors);
		const requests: DeliveryLineRequest[] = [];
		for (const [i, l] of a.lines.entries()) {
			const at = `lines[${i}]`;
			const part = await findPart(ctx.db, l.ref);
			const options: OptionDef[] =
				part && isStocked(part.kind) && !part.trackSerial ? await optionsOf(ctx.db, part.id) : [];
			// Values are required for a part with options and no serials (resolveKey refuses an incomplete set). Serials on
			// such a part are left to planDelivery, which says the part is not serial-tracked.
			const key =
				options.length && l.serials.length === 0
					? resolveKey(options, l.options, `${at}.options (${l.ref})`, { require: true })
					: null;
			requests.push({
				fields: { part: `${at}.ref`, qty: `${at}.qty`, serials: `${at}.serials`, option: () => `${at}.options` },
				ref: l.ref,
				part,
				options,
				qty: l.qty === undefined ? "" : formValue(l.qty),
				serials: l.serials,
				chosen: { key, missing: null },
			});
		}
		const at = now();
		const header = deliveryHeader(v.data, at);
		// Planned again when the batch is refused: another user took the number (D66), or a serial since (its guard).
		for (let attempt = 0; ; attempt++) {
			const plan = await planDelivery(ctx.db, requests);
			if (Object.keys(plan.errors).length) refuseLines(plan);
			try {
				const number = await nextDeliveryNumber(ctx.db);
				const { change } = await saveChange(
					ctx,
					fmt(ctx.t.history.summaries.deliveryCreate, { number, customer: header.customer }),
					deliveryStatements(ctx.db, number, header, plan.moves, ctx.user, at),
				);
				return { ...change, delivery: await deliveryView(ctx.db, await byNumber(ctx.db, number)) };
			} catch (err) {
				if (attempt > 1 || !(isConstraintError(err, "UNIQUE") || isGuardError(err))) throw err;
			}
		}
	},
});

const cancelDelivery = tool({
	name: "cancel_delivery",
	title: "Cancel a customer delivery",
	description:
		"Cancels a shipped delivery, as its page does: every unit comes back into stock (opposite moves, same values and serials) and the delivery is marked cancelled. Use it to correct a delivery recorded by mistake. This writes the stock ledger: it cannot be undone.",
	rule: { scope: "stock:write", action: "deliveries.cancel" },
	annotations: writes({ destructive: true, idempotent: true }),
	input: z.object({ number: deliveryNumberInput }),
	run: async (a, ctx) => {
		const found = await byNumber(ctx.db, a.number);
		const d = found.delivery;
		if (d.status === "cancelled")
			return {
				...NOTHING_CHANGED,
				delivery: await deliveryView(ctx.db, found),
				note: `${d.number} is already cancelled.`,
			};
		// A serial in stock again (taken back, maybe delivered again) would be counted twice (D218).
		const back = await serialsBackInStock(ctx.db, d.id);
		if (back.length > 0)
			throw new ToolError(
				`Refused, nothing was changed. ${errorMessage("delivery_serial_back_in_stock")} In stock again: ${back.map((b) => `${b.ref} ${b.serial}`).join(", ")}.`,
			);
		try {
			const { change } = await saveChange(
				ctx,
				fmt(ctx.t.history.summaries.deliveryCancel, { number: d.number }),
				cancelDeliveryStatements(ctx.db, d, fmt(ctx.t.deliveries.cancelNote, { number: d.number }), ctx.user, now()),
			);
			return { ...change, delivery: await deliveryView(ctx.db, await byNumber(ctx.db, d.number)) };
		} catch (err) {
			if (isGuardError(err)) refuse({ _: "delivery_serial_back_in_stock" });
			throw err;
		}
	},
});

export const DELIVERY_READ_TOOLS: readonly ToolSpec[] = [listDeliveriesTool, getDeliveryTool];
export const DELIVERY_WRITE_TOOLS: readonly ToolSpec[] = [recordDelivery, cancelDelivery];
