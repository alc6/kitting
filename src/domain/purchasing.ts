// Purchasing: shortage engine, purchase orders and receipts.
import { and, asc, desc, eq, inArray, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import {
	builds,
	type PoStatus,
	partSuppliers,
	parts,
	poLines,
	purchaseOrders,
	stockMoves,
	suppliers,
} from "../db/schema";
import type { Statement } from "../lib/db";
import { likePattern } from "../lib/sql";
import { lineCostCents, MILLI, parseMilli, roundOrderQty } from "../lib/units";
import { type FieldErrors, field } from "../lib/validation";
import type { Db } from "../types";
import { explode, type GraphPart } from "./bom-graph";
import { loadGraph } from "./boms";
import { OPEN_STATUSES } from "./builds";
import { NO_TERMS, type OfferTerms, offersByPart, poUnitPrice } from "./offers";
import { moveValues, onHandAt } from "./stock";

/** POs whose remaining quantities count as "on order". Drafts count too, so drafting twice never doubles. */
export const OPEN_PO_STATUSES: PoStatus[] = ["draft", "sent", "partial"];
/** POs that can receive goods. */
export const RECEIVABLE_PO_STATUSES: PoStatus[] = ["draft", "sent", "partial"];

// ---------------------------------------------------------------------------
// Shortages

/** A supplier's offer as seen from the shortage list. */
export type ShortageOffer = OfferTerms & { supplierId: number; supplierName: string };

export type ShortageLine = {
	/** The part with its preferred supplier's terms (empty terms without a preferred offer). */
	part: GraphPart & {
		supplierId: number | null;
		supplierRef: string;
		moqMilli: number;
		packSizeMilli: number;
		leadDays: number;
	};
	/** Every supplier offering the part (preferred included), to order from another one. */
	offers: ShortageOffer[];
	/** PO unit price from the preferred supplier: its offer price, else the standard cost. */
	unitPriceCents: number;
	/** Exploded need of all open builds. */
	needMilli: number;
	onHandMilli: number;
	onOrderMilli: number;
	/** need − on-hand − on order (> 0). */
	netMilli: number;
	/** Net rounded up to MOQ and pack size. */
	orderMilli: number;
	builds: string[];
};

export type SupplierGroup = {
	supplierId: number | null;
	supplierName: string;
	lines: ShortageLine[];
	totalCents: number;
};

export type Shortages = {
	groups: SupplierGroup[];
	/** Make/kit parts that must be built for open builds but have no active BoM. */
	missingBoms: { ref: string; name: string; qtyMilli: number; builds: string[] }[];
	buildCount: number;
};

/** Remaining quantity to receive per part on open POs. */
export async function onOrderMap(db: Db): Promise<Map<number, number>> {
	const rows = await db
		.select({
			partId: poLines.partId,
			qty: sql<number>`SUM(MAX(${poLines.qtyMilli} - ${poLines.receivedQtyMilli}, 0))`,
		})
		.from(poLines)
		.innerJoin(purchaseOrders, eq(poLines.poId, purchaseOrders.id))
		.where(inArray(purchaseOrders.status, OPEN_PO_STATUSES))
		.groupBy(poLines.partId);
	return new Map(rows.map((r) => [r.partId, r.qty]));
}

/**
 * Shortages for all planned and in-progress builds:
 * 1. explode every open build (earliest planned first), sharing sub-assembly stock so two builds
 *    never take the same units;
 * 2. for buy parts: net = need − on-hand − on order (make parts taken from stock are already covered);
 * 3. round up to MOQ and pack size; group by supplier.
 * Parts already below zero count as a need of their deficit.
 */
export async function computeShortages(db: Db): Promise<Shortages> {
	const [graph, onHand, onOrder, open, partRows, offers] = await Promise.all([
		loadGraph(db),
		onHandAt(db),
		onOrderMap(db),
		db
			.select({ number: builds.number, bomId: builds.bomId, qtyMilli: builds.qtyMilli })
			.from(builds)
			.where(inArray(builds.status, OPEN_STATUSES))
			.orderBy(sql`${builds.plannedFor} IS NULL`, asc(builds.plannedFor), asc(builds.id)),
		db.select({ id: parts.id, supplierId: parts.supplierId }).from(parts),
		offersByPart(db),
	]);
	const preferredSupplier = new Map(partRows.map((p) => [p.id, p.supplierId]));
	const available = new Map(onHand);
	const need = new Map<number, { qty: number; builds: Set<string> }>();
	const missing = new Map<number, { qty: number; builds: Set<string> }>();
	const add = (into: typeof need, partId: number, qty: number, build: string) => {
		const e = into.get(partId) ?? { qty: 0, builds: new Set<string>() };
		e.qty += qty;
		e.builds.add(build);
		into.set(partId, e);
	};
	for (const b of open) {
		const ex = explode(graph, b.bomId, b.qtyMilli, { available });
		for (const r of ex.requirements) {
			if (r.missingBom) add(missing, r.part.id, r.qtyMilli, b.number);
			else if (r.part.kind === "buy") add(need, r.part.id, r.qtyMilli, b.number);
		}
	}
	// Parts already below zero are short of their deficit even without open builds.
	for (const [partId, qty] of onHand) {
		if (qty < 0 && graph.parts.get(partId)?.kind === "buy" && !need.has(partId))
			need.set(partId, { qty: 0, builds: new Set() });
	}

	const groups = new Map<number | null, SupplierGroup>();
	for (const [partId, n] of need) {
		const gp = graph.parts.get(partId);
		if (!gp) continue;
		const supplierId = preferredSupplier.get(partId) ?? null;
		const partOffers = offers.get(partId) ?? [];
		const preferred = partOffers.find((o) => o.supplierId === supplierId);
		const terms = preferred ?? NO_TERMS;
		const stock = onHand.get(partId) ?? 0;
		const ordered = onOrder.get(partId) ?? 0;
		const net = n.qty - stock - ordered;
		if (net <= 0) continue;
		const line: ShortageLine = {
			part: {
				...gp,
				supplierId,
				supplierRef: terms.supplierRef,
				moqMilli: terms.moqMilli,
				packSizeMilli: terms.packSizeMilli,
				leadDays: terms.leadDays,
			},
			offers: partOffers,
			unitPriceCents: poUnitPrice(terms.priceCents, gp.costCents),
			needMilli: n.qty,
			onHandMilli: stock,
			onOrderMilli: ordered,
			netMilli: net,
			orderMilli: roundOrderQty(net, terms.moqMilli, terms.packSizeMilli),
			builds: [...n.builds],
		};
		const key = supplierId;
		const g = groups.get(key) ?? {
			supplierId: key,
			supplierName: preferred?.supplierName ?? "",
			lines: [],
			totalCents: 0,
		};
		g.lines.push(line);
		g.totalCents += lineCostCents(line.orderMilli, line.unitPriceCents);
		groups.set(key, g);
	}
	const sorted = [...groups.values()].sort((a, b) =>
		a.supplierId === null ? 1 : b.supplierId === null ? -1 : a.supplierName.localeCompare(b.supplierName),
	);
	for (const g of sorted) g.lines.sort((a, b) => a.part.ref.localeCompare(b.part.ref));
	return {
		groups: sorted,
		missingBoms: [...missing].map(([partId, m]) => ({
			ref: graph.parts.get(partId)?.ref ?? String(partId),
			name: graph.parts.get(partId)?.name ?? "",
			qtyMilli: m.qty,
			builds: [...m.builds],
		})),
		buildCount: open.length,
	};
}

// ---------------------------------------------------------------------------
// Purchase orders

export const poInput = z.object({
	supplier_id: field.id(),
	expected_at: field.date(),
	notes: field.text(),
});

export const poEditInput = z.object({
	expected_at: field.date(),
	notes: field.text(),
});

export const poLineInput = z.object({
	part: field.required(64),
	qty: field.qty({ positive: true }),
	price: field.money(),
});

/** Next purchase order numbers: "PO-0007", "PO-0008"… */
export async function nextPoNumbers(db: Db, count: number): Promise<string[]> {
	const rows = await db
		.select({ number: purchaseOrders.number })
		.from(purchaseOrders)
		.orderBy(desc(purchaseOrders.id))
		.limit(50);
	const max = rows.reduce((m, r) => Math.max(m, Number(/(\d+)$/.exec(r.number)?.[1] ?? 0)), 0);
	return Array.from({ length: count }, (_, i) => `PO-${String(max + i + 1).padStart(4, "0")}`);
}

const poIdByNumber = (number: string) => sql`(SELECT id FROM purchase_orders WHERE number = ${number})`;

/** What to order from one supplier. */
export type DraftOrder = {
	supplierId: number;
	lines: { partId: number; qtyMilli: number; unitPriceCents: number; leadDays: number }[];
};

/**
 * Turns the shortage list into draft orders: lines of the checked supplier groups, each ordered from the
 * supplier chosen for it (its preferred one by default). A line moved to another supplier is rounded to
 * that supplier's MOQ and pack size and priced at its offer (else the standard cost). Lines without a
 * preferred supplier are ordered only when a supplier is chosen for them.
 */
export function planDraftOrders(
	groups: SupplierGroup[],
	include: (supplierId: number) => boolean,
	choice: (partId: number) => number | undefined,
): DraftOrder[] {
	const orders = new Map<number, DraftOrder>();
	for (const g of groups) {
		if (g.supplierId !== null && !include(g.supplierId)) continue;
		for (const l of g.lines) {
			const chosen = choice(l.part.id) ?? g.supplierId;
			const offer = l.offers.find((o) => o.supplierId === chosen);
			if (chosen === null || !offer) continue;
			const order = orders.get(chosen) ?? { supplierId: chosen, lines: [] };
			order.lines.push({
				partId: l.part.id,
				qtyMilli: roundOrderQty(l.netMilli, offer.moqMilli, offer.packSizeMilli),
				unitPriceCents: poUnitPrice(offer.priceCents, l.part.costCents),
				leadDays: offer.leadDays,
			});
			orders.set(chosen, order);
		}
	}
	return [...orders.values()];
}

/** Statements creating one draft PO per order (expected date = today + longest lead time). */
export function draftPoStatements(
	db: Db,
	orders: DraftOrder[],
	numbers: string[],
	user: string,
	now: string,
): Statement[] {
	const stmts: Statement[] = [];
	orders.forEach((g, i) => {
		const number = numbers[i];
		if (!number) return;
		const lead = Math.max(0, ...g.lines.map((l) => l.leadDays));
		const expected = new Date(Date.parse(now) + lead * 86_400_000).toISOString().slice(0, 10);
		stmts.push(
			db.insert(purchaseOrders).values({
				number,
				supplierId: g.supplierId,
				status: "draft",
				expectedAt: lead > 0 ? expected : null,
				createdBy: user,
				updatedBy: user,
				createdAt: now,
				updatedAt: now,
			}),
		);
		for (const l of g.lines) {
			stmts.push(
				db.insert(poLines).values({
					poId: poIdByNumber(number),
					partId: l.partId,
					qtyMilli: l.qtyMilli,
					unitPriceCents: l.unitPriceCents,
					createdBy: user,
					updatedBy: user,
					createdAt: now,
					updatedAt: now,
				}),
			);
		}
	});
	return stmts;
}

// ---------------------------------------------------------------------------
// PO edits: statements to run in one batch.

export function createPoStatement(
	db: Db,
	po: { number: string; supplierId: number; expectedAt: string | null; notes: string },
	user: string,
	now: string,
) {
	return db
		.insert(purchaseOrders)
		.values({ ...po, createdBy: user, updatedBy: user, createdAt: now, updatedAt: now })
		.returning({ id: purchaseOrders.id });
}

export function updatePoStatement(
	db: Db,
	poId: number,
	d: { expectedAt: string | null; notes: string },
	user: string,
	now: string,
) {
	return db
		.update(purchaseOrders)
		.set({ ...d, updatedAt: now, updatedBy: user })
		.where(eq(purchaseOrders.id, poId));
}

export function addPoLineStatement(
	db: Db,
	poId: number,
	line: { partId: number; qtyMilli: number; unitPriceCents: number },
	user: string,
	now: string,
) {
	return db.insert(poLines).values({ poId, ...line, createdBy: user, updatedBy: user, createdAt: now, updatedAt: now });
}

export function updatePoLineStatement(
	db: Db,
	poId: number,
	lineId: number,
	d: { qtyMilli: number; unitPriceCents: number },
	user: string,
	now: string,
) {
	return db
		.update(poLines)
		.set({ ...d, updatedAt: now, updatedBy: user })
		.where(and(eq(poLines.id, lineId), eq(poLines.poId, poId)));
}

export function deletePoLineStatement(db: Db, poId: number, lineId: number) {
	return db.delete(poLines).where(and(eq(poLines.id, lineId), eq(poLines.poId, poId)));
}

/** Draft → sent (a PO in another status is left alone). */
export function sendPoStatement(db: Db, poId: number, user: string, now: string) {
	return db
		.update(purchaseOrders)
		.set({ status: "sent", sentAt: now, updatedAt: now, updatedBy: user })
		.where(and(eq(purchaseOrders.id, poId), eq(purchaseOrders.status, "draft")));
}

/** Draft or sent → cancelled. */
export function cancelPoStatement(db: Db, poId: number, user: string, now: string) {
	return db
		.update(purchaseOrders)
		.set({ status: "cancelled", updatedAt: now, updatedBy: user })
		.where(and(eq(purchaseOrders.id, poId), inArray(purchaseOrders.status, ["draft", "sent"])));
}

/** Closes a short-shipped PO: the remaining quantities are no longer expected (no stock move). */
export function closePoStatement(db: Db, poId: number, user: string, now: string) {
	return db
		.update(purchaseOrders)
		.set({ status: "received", updatedAt: now, updatedBy: user })
		.where(and(eq(purchaseOrders.id, poId), inArray(purchaseOrders.status, ["sent", "partial"])));
}

/** Deletes a PO with its lines. */
export function deletePoStatement(db: Db, poId: number) {
	return db.delete(purchaseOrders).where(eq(purchaseOrders.id, poId));
}

// ---------------------------------------------------------------------------
// PO lists and details

export type PoFilters = { q?: string; status?: string };

export async function listPos(db: Db, f: PoFilters = {}) {
	const conds: SQL[] = [];
	if (f.q) {
		const like = likePattern(f.q);
		conds.push(sql`(${purchaseOrders.number} LIKE ${like} ESCAPE '\\' OR ${suppliers.name} LIKE ${like} ESCAPE '\\')`);
	}
	if (!f.status || f.status === "open") conds.push(inArray(purchaseOrders.status, OPEN_PO_STATUSES));
	else if (f.status !== "all") conds.push(eq(purchaseOrders.status, f.status as PoStatus));
	return db
		.select({
			id: purchaseOrders.id,
			number: purchaseOrders.number,
			status: purchaseOrders.status,
			expectedAt: purchaseOrders.expectedAt,
			sentAt: purchaseOrders.sentAt,
			createdAt: purchaseOrders.createdAt,
			supplierId: suppliers.id,
			supplierName: suppliers.name,
			lineCount: sql<number>`(SELECT count(*) FROM po_lines l WHERE l.po_id = ${purchaseOrders.id})`,
			totalCents: sql<number>`(SELECT COALESCE(SUM((l.qty_milli * l.unit_price_cents + 500) / 1000), 0) FROM po_lines l WHERE l.po_id = ${purchaseOrders.id})`,
		})
		.from(purchaseOrders)
		.innerJoin(suppliers, eq(purchaseOrders.supplierId, suppliers.id))
		.where(conds.length ? and(...conds) : undefined)
		.orderBy(desc(purchaseOrders.id))
		.limit(500);
}

export async function getPo(db: Db, id: number) {
	const rows = await db
		.select({ po: purchaseOrders, supplier: suppliers })
		.from(purchaseOrders)
		.innerJoin(suppliers, eq(purchaseOrders.supplierId, suppliers.id))
		.where(eq(purchaseOrders.id, id))
		.limit(1);
	return rows[0];
}

export async function getPoLines(db: Db, poId: number) {
	return db
		.select({
			line: poLines,
			ref: parts.ref,
			name: parts.name,
			unit: parts.unit,
			supplierRef: sql<string>`COALESCE(${partSuppliers.supplierRef}, '')`,
			trackSerial: parts.trackSerial,
		})
		.from(poLines)
		.innerJoin(parts, eq(poLines.partId, parts.id))
		.innerJoin(purchaseOrders, eq(poLines.poId, purchaseOrders.id))
		.leftJoin(
			partSuppliers,
			and(eq(partSuppliers.partId, poLines.partId), eq(partSuppliers.supplierId, purchaseOrders.supplierId)),
		)
		.where(eq(poLines.poId, poId))
		.orderBy(asc(poLines.id));
}

export type Receipt = { lineId: number; partId: number; qtyMilli: number; unitPriceCents: number; serials: string[] };

/** Form field names of a receipt: the quantity and the serials received on a PO line. */
export const receiveQtyField = (lineId: number) => `recv_${lineId}`;
export const receiveSerialsField = (lineId: number) => `serials_${lineId}`;

/**
 * Reads what was received from the receive form's fields (or the same fields built by an MCP tool): a quantity per
 * line, zero or more, and optionally one serial per unit (newlines, commas or semicolons between them). Errors are
 * keyed by field; nothing received at all is an error too.
 */
export function planReceipts(
	lines: { line: { id: number; partId: number; unitPriceCents: number } }[],
	values: Record<string, string>,
): { receipts: Receipt[]; errors: FieldErrors } {
	const errors: FieldErrors = {};
	const receipts: Receipt[] = [];
	for (const l of lines) {
		const qtyName = receiveQtyField(l.line.id);
		const serialName = receiveSerialsField(l.line.id);
		const raw = (values[qtyName] ?? "").trim();
		if (raw === "") continue;
		const qty = parseMilli(raw);
		if (qty === null) {
			errors[qtyName] = "invalid_quantity";
			continue;
		}
		if (qty < 0) {
			errors[qtyName] = "negative";
			continue;
		}
		if (qty === 0) continue;
		const serials = (values[serialName] ?? "")
			.split(/[\r\n,;]+/)
			.map((s) => s.trim())
			.filter(Boolean);
		if (serials.length > 0) {
			if (qty % MILLI !== 0 || serials.length !== qty / MILLI) errors[serialName] = "serial_count";
			else if (new Set(serials).size !== serials.length) errors[serialName] = "serial_duplicate";
		}
		receipts.push({
			lineId: l.line.id,
			partId: l.line.partId,
			qtyMilli: qty,
			unitPriceCents: l.line.unitPriceCents,
			serials,
		});
	}
	if (Object.keys(errors).length === 0 && receipts.length === 0) errors._ = "nothing_received";
	return { receipts, errors };
}

/**
 * One batch: receipt moves (one per serial when serials are given), received quantities
 * incremented in SQL, then the PO status recomputed from its lines.
 */
export function receiptStatements(
	db: Db,
	po: { id: number; number: string },
	receipts: Receipt[],
	user: string,
	now: string,
): Statement[] {
	const ctx = { reason: "receipt" as const, refType: "po", refId: po.id, note: po.number, user, now };
	const stmts: Statement[] = [];
	for (const r of receipts) {
		if (r.serials.length > 0) {
			for (const serial of r.serials) {
				stmts.push(
					db
						.insert(stockMoves)
						.values(moveValues({ partId: r.partId, qtyMilli: MILLI, serial, unitCostCents: r.unitPriceCents }, ctx)),
				);
			}
		} else {
			stmts.push(
				db
					.insert(stockMoves)
					.values(
						moveValues({ partId: r.partId, qtyMilli: r.qtyMilli, serial: null, unitCostCents: r.unitPriceCents }, ctx),
					),
			);
		}
		stmts.push(
			db
				.update(poLines)
				.set({
					receivedQtyMilli: sql`${poLines.receivedQtyMilli} + ${r.qtyMilli}`,
					updatedAt: now,
					updatedBy: user,
				})
				.where(and(eq(poLines.id, r.lineId), eq(poLines.poId, po.id))),
		);
	}
	stmts.push(
		db
			.update(purchaseOrders)
			.set({
				status: sql`CASE WHEN EXISTS (SELECT 1 FROM po_lines l WHERE l.po_id = ${po.id} AND l.received_qty_milli < l.qty_milli) THEN 'partial' ELSE 'received' END`,
				sentAt: sql`COALESCE(${purchaseOrders.sentAt}, ${now})`,
				updatedAt: now,
				updatedBy: user,
			})
			.where(and(eq(purchaseOrders.id, po.id), inArray(purchaseOrders.status, RECEIVABLE_PO_STATUSES))),
	);
	return stmts;
}
