// purchasing:write tools (D127): draft POs from the shortages, edit drafts, send, receive, cancel and close, record
// shipments (D168), with the purchasing pages' checks and statement builders. Receiving writes the stock ledger: it
// cannot be undone.
import { z } from "zod";
import { getOffer, poUnitPrice } from "../domain/offers";
import { type OptionDef, type OptionKey, stockKey } from "../domain/option-keys";
import { optionsOf } from "../domain/options";
import {
	addPoLineStatement,
	addShipmentStatement,
	cancelPoStatement,
	closePoStatement,
	computeShortages,
	deletePoLineStatement,
	draftPoStatements,
	getPoLines,
	getPoShipments,
	nextPoNumbers,
	planDraftOrders,
	planReceipts,
	RECEIVABLE_PO_STATUSES,
	receiptStatements,
	receiveQtyField,
	receiveSerialsField,
	sendPoStatement,
	shipmentByTracking,
	shipmentFormValues,
	shipmentInput,
	shipmentRuleErrors,
	shipmentValues,
	updatePoLineStatement,
	updatePoStatement,
	updateShipmentStatement,
} from "../domain/purchasing";
import { isStocked } from "../domain/stock";
import { fmt } from "../i18n";
import type { Statement } from "../lib/db";
import { isConstraintError } from "../lib/sql";
import { formatQtyInput, lineCostCents } from "../lib/units";
import { field, validate } from "../lib/validation";
import type { Db } from "../types";
import { supplierByName } from "./catalog-tools";
import {
	date,
	decimal,
	errorMessage,
	findPart,
	formValue,
	NOTHING_CHANGED,
	poByNumber,
	refuse,
	saveChange,
	shipmentViews,
	ToolError,
	type ToolSpec,
	tool,
	writes,
} from "./kit";
import { completeKey, optionsInput, optionsView, selectByOptions } from "./options";

const now = () => new Date().toISOString();

const poNumberInput = z.string().trim().min(1).max(32).describe('The PO number, e.g. "PO-0001".');

/** A purchase order with its lines, as the write tools return it. */
async function poView(db: Db, number: string) {
	const { po, supplier } = await poByNumber(db, number);
	const [lines, shipments] = await Promise.all([getPoLines(db, po.id), getPoShipments(db, po.id)]);
	return {
		purchaseOrder: {
			number: po.number,
			status: po.status,
			supplier: supplier.name,
			expectedAt: po.expectedAt,
			sentAt: po.sentAt,
			notes: po.notes || undefined,
		},
		lines: lines.map((l) => ({
			ref: l.ref,
			unit: l.unit,
			options: optionsView(l.options, l.line.optionValues),
			qtyMilli: l.line.qtyMilli,
			receivedMilli: l.line.receivedQtyMilli,
			remainingMilli: Math.max(0, l.line.qtyMilli - l.line.receivedQtyMilli),
			unitPriceCents: l.line.unitPriceCents,
		})),
		totalCents: lines.reduce((s, l) => s + lineCostCents(l.line.qtyMilli, l.line.unitPriceCents), 0),
		shipments: shipmentViews(shipments),
	};
}

/**
 * The line of a part on a PO, found by reference and, for a part ordered in several values, by options (D193). None:
 * undefined. Refused when the part is on several lines and the options do not say which.
 */
function lineFor<T extends { ref: string; line: { optionValues: OptionKey }; options: OptionDef[] }>(
	lines: T[],
	ref: string,
	given: Record<string, string> | undefined,
	number: string,
	defs?: OptionDef[],
): { line: T | undefined; ids: number[]; defs: OptionDef[] } {
	const same = lines.filter((l) => l.ref.toLowerCase() === ref.toLowerCase());
	// A part on no line has nothing to match: the caller says it is not on the PO (its options may be unknown here).
	if (same.length === 0 && !defs) return { line: undefined, ids: [], defs: [] };
	const options = defs ?? same[0]?.options ?? [];
	const { item, ids } = selectByOptions(same, options, given, (l) => l.line.optionValues, `${ref} on ${number}`);
	return { line: item, ids, defs: options };
}

const createDraftPos = tool({
	name: "create_draft_pos",
	title: "Draft POs from shortages",
	description:
		"Turns the current shortages (get_shortages) into draft purchase orders, as the shortage page's button does: one draft per supplier, each line (a part in some options) rounded up to that supplier's MOQ and pack size and priced at its offer (else the standard cost). By default every supplier group is drafted; suppliers limits it to some. order_from orders a part from another supplier that has an offer for it (parts without a preferred supplier are drafted only this way). Drafts are not sent: review them, then mark_po_sent.",
	rule: { scope: "purchasing:write", action: "purchasing.order" },
	annotations: writes({ destructive: false, idempotent: false }),
	input: z.object({
		suppliers: z
			.array(z.string().trim().min(1).max(200))
			.max(100)
			.optional()
			.describe("Only these suppliers' groups (names, case-insensitive)."),
		order_from: z
			.array(
				z.object({
					ref: z.string().trim().min(1).max(64),
					options: optionsInput("the shortage line, when the part is short in several values"),
					supplier: z.string().trim().min(1).max(200),
				}),
			)
			.max(500)
			.default([])
			.describe("Order these parts (in these options) from another supplier with an offer for them."),
	}),
	run: async (a, ctx) => {
		const shortages = await computeShortages(ctx.db);
		const lines = shortages.groups.flatMap((g) => g.lines);
		let include = (_supplierId: number) => true;
		if (a.suppliers) {
			const ids = new Set<number>();
			for (const name of a.suppliers) ids.add((await supplierByName(ctx.db, name)).id);
			include = (supplierId) => ids.has(supplierId);
		}
		const chosen = new Map<string, number>();
		for (const o of a.order_from) {
			const short = lines.filter((l) => l.part.ref.toLowerCase() === o.ref.toLowerCase());
			const { item: line } = !short.length
				? { item: undefined }
				: selectByOptions(short, short[0]?.part.options ?? [], o.options, (l) => l.optionValues, `${o.ref} to order`);
			if (!line)
				throw new ToolError(
					`${o.ref} is not short${o.options ? " in these options" : ""}: get_shortages lists what to order.`,
				);
			const supplier = await supplierByName(ctx.db, o.supplier);
			if (!line.offers.some((offer) => offer.supplierId === supplier.id))
				throw new ToolError(`${supplier.name} has no offer for ${line.part.ref}: add one with upsert_supplier_offer.`);
			chosen.set(line.key, supplier.id);
		}
		const orders = planDraftOrders(shortages.groups, include, (key) => chosen.get(key));
		if (orders.length === 0) return { ...NOTHING_CHANGED, purchaseOrders: [], note: "Nothing to order." };
		for (let attempt = 0; ; attempt++) {
			const numbers = await nextPoNumbers(ctx.db, orders.length);
			try {
				const { change } = await saveChange(
					ctx,
					fmt(ctx.t.history.summaries.draftPos, { n: orders.length }),
					draftPoStatements(ctx.db, orders, numbers, ctx.user, now()),
				);
				const created = [];
				for (const n of numbers) created.push(await poView(ctx.db, n));
				return { ...change, purchaseOrders: created };
			} catch (err) {
				if (attempt > 0 || !isConstraintError(err, "UNIQUE")) throw err;
			}
		}
	},
});

const updateDraftPo = tool({
	name: "update_draft_po",
	title: "Edit a draft PO",
	description:
		"Edits a purchase order: its expected date and notes (any open PO, as on its page), and the lines of a draft. Each line sets the quantity of a part on the PO: an existing line is changed (its price too when given), a new part is added (priced at this supplier's offer, else the standard cost, unless a price is given), and qty \"0\" removes the part's line. A part with options is on one line per values: options says which line (a value of every option is needed to add one). Lines of a sent PO cannot change.",
	rule: { scope: "purchasing:write", action: "purchasing.order" },
	annotations: writes({ destructive: true, idempotent: true }),
	input: z.object({
		number: poNumberInput,
		expected_at: date.nullable().optional().describe("Expected delivery date, YYYY-MM-DD (null clears it)."),
		notes: z.string().max(2000).optional(),
		lines: z
			.array(
				z.object({
					ref: z.string().trim().min(1).max(64),
					options: optionsInput("the line, to tell lines of the same part apart or to add one"),
					qty: decimal('Quantity to order in the part\'s unit; "0" removes the line.'),
					price: decimal('Unit price, e.g. "1.05".').optional(),
				}),
			)
			.max(500)
			.default([]),
	}),
	run: async (a, ctx) => {
		const { po } = await poByNumber(ctx.db, a.number);
		if (a.lines.length && po.status !== "draft") refuse({ lines: "po_not_draft" });
		const stamp = now();
		const stmts: Statement[] = [];
		if (a.expected_at !== undefined || a.notes !== undefined) {
			const v = validate(z.object({ expected_at: field.date(), notes: field.text() }), {
				expected_at: a.expected_at === undefined ? (po.expectedAt ?? "") : (a.expected_at ?? ""),
				notes: a.notes ?? po.notes,
			});
			if (!v.ok) refuse(v.errors);
			stmts.push(
				updatePoStatement(ctx.db, po.id, { expectedAt: v.data.expected_at, notes: v.data.notes }, ctx.user, stamp),
			);
		}
		const current = await getPoLines(ctx.db, po.id);
		const problems: string[] = [];
		const edited = new Set<number>();
		const added = new Set<string>();
		for (const [i, l] of a.lines.entries()) {
			const at = `line ${i + 1} (${l.ref})`;
			const v = validate(z.object({ qty: field.qty(), price: field.money() }), {
				qty: formValue(l.qty),
				price: formValue(l.price),
			});
			if (!v.ok) {
				problems.push(...Object.entries(v.errors).map(([f, key]) => `${at} ${f}: ${errorMessage(key)}`));
				continue;
			}
			const part = await findPart(ctx.db, l.ref);
			if (!part) {
				problems.push(`${at}: ${errorMessage("unknown_part", { ref: l.ref })}`);
				continue;
			}
			let found: ReturnType<typeof lineFor<(typeof current)[number]>>;
			try {
				found = lineFor(current, part.ref, l.options, po.number, await optionsOf(ctx.db, part.id));
			} catch (err) {
				if (!(err instanceof ToolError)) throw err;
				problems.push(`${at}: ${err.message}`);
				continue;
			}
			const existing = found.line;
			const { qty, price } = v.data;
			if (existing) {
				if (edited.has(existing.line.id)) {
					problems.push(`${at}: listed twice.`);
					continue;
				}
				edited.add(existing.line.id);
				if (qty === 0) stmts.push(deletePoLineStatement(ctx.db, po.id, existing.line.id));
				else
					stmts.push(
						updatePoLineStatement(
							ctx.db,
							po.id,
							existing.line.id,
							{ qtyMilli: qty, unitPriceCents: price ?? existing.line.unitPriceCents },
							ctx.user,
							stamp,
						),
					);
			} else if (qty === 0) problems.push(`${at}: not on ${po.number}.`);
			else if (!isStocked(part.kind)) problems.push(`${at}: ${errorMessage("not_stocked", { kind: part.kind })}`);
			else {
				// A new line of a part with options needs a value of each (D191).
				let optionValues: OptionKey;
				try {
					optionValues = completeKey(found.defs, found.ids, `${at} options`);
				} catch (err) {
					if (!(err instanceof ToolError)) throw err;
					problems.push(err.message);
					continue;
				}
				if (added.has(stockKey(part.id, optionValues))) {
					problems.push(`${at}: listed twice.`);
					continue;
				}
				added.add(stockKey(part.id, optionValues));
				const unitPriceCents =
					price ?? poUnitPrice((await getOffer(ctx.db, part.id, po.supplierId))?.priceCents, part.costCents);
				stmts.push(
					addPoLineStatement(
						ctx.db,
						po.id,
						{ partId: part.id, qtyMilli: qty, unitPriceCents, optionValues },
						ctx.user,
						stamp,
					),
				);
			}
		}
		if (problems.length) throw new ToolError(`Refused, nothing was changed. ${problems.join(" ")}`);
		const { change } = await saveChange(ctx, fmt(ctx.t.history.summaries.poEdit, { number: po.number }), stmts);
		return { ...change, ...(await poView(ctx.db, po.number)) };
	},
});

const markPoSent = tool({
	name: "mark_po_sent",
	title: "Mark a PO as sent",
	description:
		"Marks a draft purchase order as sent to its supplier (Kitting does not send anything itself: the user sends the order). Its lines can no longer change; it waits for receive_po.",
	rule: { scope: "purchasing:write", action: "purchasing.order" },
	annotations: writes({ destructive: false, idempotent: true }),
	input: z.object({ number: poNumberInput }),
	run: async (a, ctx) => {
		const { po } = await poByNumber(ctx.db, a.number);
		if (po.status === "sent") return { ...NOTHING_CHANGED, ...(await poView(ctx.db, po.number)) };
		if (po.status !== "draft") refuse({ _: "po_not_draft" });
		if ((await getPoLines(ctx.db, po.id)).length === 0) refuse({ _: "po_empty" });
		const { change } = await saveChange(ctx, fmt(ctx.t.history.summaries.poSend, { number: po.number }), [
			sendPoStatement(ctx.db, po.id, ctx.user, now()),
		]);
		return { ...change, ...(await poView(ctx.db, po.number)) };
	},
});

const receivePo = tool({
	name: "receive_po",
	title: "Receive goods on a PO",
	description:
		"Records goods received on a purchase order, as its receive form does: per line (a part, and its options when it is ordered in several values), the quantity received now (more deliveries can follow), and optionally one serial per unit. Stock goes up at the PO's price; the PO becomes partly received or received. This writes the stock ledger: it cannot be undone, only corrected with an adjustment.",
	rule: { scope: "purchasing:write", action: "purchasing.receive" },
	annotations: writes({ destructive: true, idempotent: false }),
	input: z.object({
		number: poNumberInput,
		lines: z
			.array(
				z.object({
					ref: z.string().trim().min(1).max(64),
					options: optionsInput("the line, when the part is on several lines of the PO in different values"),
					qty: decimal('Quantity received now, e.g. "4".'),
					serials: z.array(z.string().trim().min(1).max(100)).max(1000).default([]).describe("One per unit, if any."),
				}),
			)
			.min(1)
			.max(500),
	}),
	run: async (a, ctx) => {
		const { po } = await poByNumber(ctx.db, a.number);
		if (!RECEIVABLE_PO_STATUSES.includes(po.status)) refuse({ _: "po_not_receivable" });
		const lines = await getPoLines(ctx.db, po.id);
		const values: Record<string, string> = {};
		const names: Record<string, string> = {};
		for (const l of a.lines) {
			const { line } = lineFor(lines, l.ref, l.options, po.number);
			if (!line)
				throw new ToolError(
					`${l.ref} is not on ${po.number}${l.options ? " in these options" : ""}. get_purchase_order lists its lines.`,
				);
			const qtyField = receiveQtyField(line.line.id);
			const serialsField = receiveSerialsField(line.line.id);
			const label = line.values ? `${line.ref} (${line.values})` : line.ref;
			if (qtyField in values) throw new ToolError(`${label} is listed twice.`);
			values[qtyField] = formValue(l.qty);
			values[serialsField] = l.serials.join("\n");
			names[qtyField] = `${label} qty`;
			names[serialsField] = `${label} serials`;
		}
		const { receipts, errors } = planReceipts(po, lines, values);
		if (Object.keys(errors).length) {
			const messages = Object.entries(errors).map(([f, key]) => {
				// serial_count names the quantity received on that line.
				const r = receipts.find((x) => receiveSerialsField(x.lineId) === f);
				const message = errorMessage(key, { n: r ? formatQtyInput(r.qtyMilli) : "" });
				return names[f] ? `${names[f]}: ${message}` : message;
			});
			throw new ToolError(`Refused, nothing was changed. ${messages.join(" ")}`);
		}
		const { change } = await saveChange(
			ctx,
			fmt(ctx.t.history.summaries.poReceive, { number: po.number }),
			receiptStatements(ctx.db, po, receipts, ctx.user, now()),
		);
		const view = await poView(ctx.db, po.number);
		return {
			...change,
			received: receipts.map((r) => {
				const line = lines.find((l) => l.line.id === r.lineId);
				return {
					ref: line?.ref,
					options: optionsView(line?.options ?? [], r.optionValues),
					qtyMilli: r.qtyMilli,
					serials: r.serials.length ? r.serials : undefined,
				};
			}),
			...view,
		};
	},
});

const cancelPo = tool({
	name: "cancel_po",
	title: "Cancel a PO",
	description:
		"Cancels a draft or sent purchase order that received nothing: its quantities are no longer on order. A partly received PO is closed with close_po instead. POs are never deleted over MCP.",
	rule: { scope: "purchasing:write", action: "purchasing.order" },
	annotations: writes({ destructive: true, idempotent: true }),
	input: z.object({ number: poNumberInput }),
	run: async (a, ctx) => {
		const { po } = await poByNumber(ctx.db, a.number);
		if (po.status === "cancelled") return { ...NOTHING_CHANGED, ...(await poView(ctx.db, po.number)) };
		const lines = await getPoLines(ctx.db, po.id);
		if (lines.some((l) => l.line.receivedQtyMilli > 0)) refuse({ _: "po_has_receipts" });
		if (po.status !== "draft" && po.status !== "sent")
			throw new ToolError(`${po.number} is ${po.status}: only draft and sent POs can be cancelled.`);
		const { change } = await saveChange(ctx, fmt(ctx.t.history.summaries.poCancel, { number: po.number }), [
			cancelPoStatement(ctx.db, po.id, ctx.user, now()),
		]);
		return { ...change, ...(await poView(ctx.db, po.number)) };
	},
});

const closePo = tool({
	name: "close_po",
	title: "Close a PO",
	description:
		"Closes a sent or partly received purchase order whose remaining quantities will not come (short shipment): they are no longer on order. Nothing moves in stock.",
	rule: { scope: "purchasing:write", action: "purchasing.order" },
	annotations: writes({ destructive: true, idempotent: true }),
	input: z.object({ number: poNumberInput }),
	run: async (a, ctx) => {
		const { po } = await poByNumber(ctx.db, a.number);
		if (po.status === "received") return { ...NOTHING_CHANGED, ...(await poView(ctx.db, po.number)) };
		if (po.status !== "sent" && po.status !== "partial")
			throw new ToolError(`${po.number} is ${po.status}: only sent and partly received POs can be closed.`);
		const { change } = await saveChange(ctx, fmt(ctx.t.history.summaries.poClose, { number: po.number }), [
			closePoStatement(ctx.db, po.id, ctx.user, now()),
		]);
		return { ...change, ...(await poView(ctx.db, po.number)) };
	},
});

const recordPoShipment = tool({
	name: "record_po_shipment",
	title: "Record a PO shipment",
	description:
		"Records a parcel the supplier sent for a purchase order, as the Shipments card of its page does: carrier, tracking number, and optionally the carrier's tracking link, the date it was shipped and a note. Recording a tracking number already on the PO updates that shipment instead (fields left out keep their value). Only on sent, partly received and received POs. Kitting keeps these details for the team: it never contacts the carrier.",
	rule: { scope: "purchasing:write", action: "purchasing.order" },
	annotations: writes({ destructive: true, idempotent: true }),
	input: z.object({
		number: poNumberInput,
		tracking_number: z.string().trim().min(1).max(100).describe("The carrier's tracking number."),
		carrier: z
			.string()
			.trim()
			.min(1)
			.max(100)
			.optional()
			.describe('Who carries the parcel, e.g. "Parcel Co". Required for a new shipment.'),
		tracking_url: z
			.string()
			.trim()
			.max(2000)
			.optional()
			.describe(
				"The carrier's tracking page for this parcel (https://…), when the supplier gave one. Empty removes it.",
			),
		shipped_at: date.nullable().optional().describe("When the supplier shipped it, YYYY-MM-DD; null clears it."),
		notes: z.string().trim().max(2000).optional(),
	}),
	run: async (a, ctx) => {
		const { po } = await poByNumber(ctx.db, a.number);
		const shipments = await getPoShipments(ctx.db, po.id);
		const existing = shipmentByTracking(shipments, a.tracking_number);
		// The form as the Shipments card would post it: the shipment being updated, with the fields given.
		const values: Record<string, string> = {
			...(existing
				? shipmentFormValues(existing)
				: { carrier: "", tracking_url: "", shipped_at: "", shipment_notes: "" }),
			tracking_number: existing?.trackingNumber ?? a.tracking_number,
		};
		for (const key of ["carrier", "tracking_url", "shipped_at"] as const)
			if (a[key] !== undefined) values[key] = formValue(a[key]);
		if (a.notes !== undefined) values.shipment_notes = a.notes;
		const v = validate(shipmentInput, values);
		if (!v.ok) refuse(v.errors, {}, { shipment_notes: "notes" });
		const errors = shipmentRuleErrors(po, shipments, v.data.tracking_number, existing?.id);
		if (Object.keys(errors).length) refuse(errors);
		const s = shipmentValues(v.data);
		if (existing && Object.entries(s).every(([k, val]) => existing[k as keyof typeof s] === val))
			return { ...NOTHING_CHANGED, ...(await poView(ctx.db, po.number)) };
		const summary = existing ? ctx.t.history.summaries.poShipmentEdit : ctx.t.history.summaries.poShipmentAdd;
		const { change } = await saveChange(ctx, fmt(summary, { tracking: s.trackingNumber, number: po.number }), [
			existing
				? updateShipmentStatement(ctx.db, po.id, existing.id, s, ctx.user, now())
				: addShipmentStatement(ctx.db, po.id, s, ctx.user, now()),
		]);
		return { ...change, ...(await poView(ctx.db, po.number)) };
	},
});

export const PURCHASING_TOOLS: readonly ToolSpec[] = [
	createDraftPos,
	updateDraftPo,
	markPoSent,
	receivePo,
	cancelPo,
	closePo,
	recordPoShipment,
];
