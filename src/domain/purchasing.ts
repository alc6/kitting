// Purchasing: shortage engine, purchase orders and receipts.
import { and, asc, desc, eq, inArray, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import {
	builds,
	CHARGE_SPREADS,
	machines,
	type PoShipment,
	type PoStatus,
	partSuppliers,
	parts,
	poLines,
	poShipments,
	purchaseOrders,
	stockMoves,
	suppliers,
} from "../db/schema";
import type { Statement } from "../lib/db";
import { likePattern } from "../lib/sql";
import { formatCentsInput, lineCostCents, MILLI, parseMilli, roundDiv, roundOrderQty } from "../lib/units";
import { type FieldErrors, field } from "../lib/validation";
import type { Db } from "../types";
import { loadGraph } from "./assemblies";
import {
	defaultAssembly,
	type ExplodedNode,
	explode,
	type GraphMachineType,
	type GraphPart,
	machineNeed,
	missingValues,
	walkTree,
} from "./assembly-graph";
import { OPEN_STATUSES, openBuildPicks } from "./builds";
import { type PoCharges, spreadCharges } from "./landed-cost";
import { NO_TERMS, type OfferTerms, offersByPart, poUnitPrice } from "./offers";
import { idsOf, keyLabel, keyValues, type OptionKey, splitStockKey, stockKey } from "./option-keys";
import { loadOptions } from "./options";
import { moveValues, onHandByKey } from "./stock";

/** POs whose remaining quantities count as "on order". Drafts count too, so drafting twice never doubles. */
export const OPEN_PO_STATUSES: PoStatus[] = ["draft", "sent", "partial"];
/** POs that can receive goods. */
export const RECEIVABLE_PO_STATUSES: PoStatus[] = ["draft", "sent", "partial"];
/** POs whose charges can change (D201): open ones, since the real freight is often known after sending. */
export const CHARGES_PO_STATUSES: PoStatus[] = ["draft", "sent", "partial"];

// ---------------------------------------------------------------------------
// Shortages

/** A supplier's offer as seen from the shortage list. */
export type ShortageOffer = OfferTerms & { supplierId: number; supplierName: string };

export type ShortageLine = {
	/** The part and option values short (`stockKey`): one line per values of a part with options (D191). */
	key: string;
	optionValues: OptionKey;
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

/**
 * Machine time the open builds need on one machine type (D150): their own, and that of what is to make for them in
 * whole runs (D156); with how many of its machines are in service.
 */
export type MachineLoad = {
	machineType: GraphMachineType;
	minutesMilli: number;
	activeMachines: number;
	builds: string[];
};

/**
 * A made part the open builds need but that is neither in stock nor planned (D156): what to make, before what to buy.
 * Sub-assemblies built inside their parent's build show here too, so making them ahead is one click.
 */
export type ToMakeLine = {
	part: GraphPart;
	/** The values to make it in (D191). */
	optionValues: OptionKey;
	/** The assembly a build of it would use (its default active one): its batch and machine time. */
	assembly: { id: number; code: string; revision: string; batchMilli: number };
	/** Short: needed by the open builds and covered neither by stock nor by planned builds of it. */
	shortMilli: number;
	onHandMilli: number;
	/** Output of its own open builds (planned and in progress). */
	plannedMilli: number;
	/** Short, rounded up to whole runs of its assembly (D145). */
	toMakeMilli: number;
	runs: number;
	/** Machine time of `toMakeMilli` on its machine type, or null. */
	machine: { machineType: GraphMachineType; minutesMilli: number } | null;
	/**
	 * Order of making (D156): 0 when it is made from bought parts and stock only, else 1 + the level of the made parts it
	 * is made from. The list goes from 0 up: what a part is made from comes before it.
	 */
	level: number;
	builds: string[];
};

export type Shortages = {
	groups: SupplierGroup[];
	/** Made parts to make for the open builds, what they are made from first (D156). */
	toMake: ToMakeLine[];
	/** Make/kit parts that must be built for open builds but have no active assembly. */
	missingAssemblies: {
		ref: string;
		name: string;
		optionValues: OptionKey;
		values: string;
		qtyMilli: number;
		builds: string[];
	}[];
	/** Values open builds ask of a component that does not come in them (D185): nothing is ordered for those. */
	missingValues: { ref: string; name: string; option: string; value: string; builds: string[] }[];
	/** Machine time of the open builds, per machine type (sub-assemblies taken from stock need none). */
	machines: MachineLoad[];
	buildCount: number;
};

/** Remaining quantity to receive per part and option values (`stockKey`) on open POs. */
export async function onOrderMap(db: Db): Promise<Map<string, number>> {
	const rows = await db
		.select({
			partId: poLines.partId,
			optionValues: poLines.optionValues,
			qty: sql<number>`SUM(MAX(${poLines.qtyMilli} - ${poLines.receivedQtyMilli}, 0))`,
		})
		.from(poLines)
		.innerJoin(purchaseOrders, eq(poLines.poId, purchaseOrders.id))
		.where(inArray(purchaseOrders.status, OPEN_PO_STATUSES))
		.groupBy(poLines.partId, poLines.optionValues);
	return new Map(rows.map((r) => [stockKey(r.partId, r.optionValues), r.qty]));
}

/** The made parts built inside a node (through kits, which are phantoms): what it is made from, for the order (D156). */
const nodeKey = (n: ExplodedNode) => stockKey(n.part.id, n.optionValues);

function* subBuilds(node: ExplodedNode): Generator<ExplodedNode> {
	for (const child of node.children) {
		if (child.part.kind === "make" && child.toBuildMilli > 0 && child.assemblyId !== null) yield child;
		else if (child.mode === "kit") yield* subBuilds(child);
	}
}

/**
 * Shortages for all planned and in-progress builds:
 * 1. explode every open build (earliest planned first), sharing sub-assembly stock so two builds
 *    never take the same units; the output of open builds counts as stock to come (D156), so a sub-assembly planned
 *    on its own is not built a second time inside its parent;
 * 2. for buy parts: net = need − on-hand − on order (make parts taken from stock are already covered);
 * 3. round up to MOQ and pack size; group by supplier.
 * Parts already below zero count as a need of their deficit. Everything is counted per part and option values (D191):
 * each build explodes in its values and with the values chosen for it.
 */
export async function computeShortages(db: Db): Promise<Shortages> {
	const [graph, onHand, onOrder, open, partRows, offers, active, picks] = await Promise.all([
		loadGraph(db),
		onHandByKey(db),
		onOrderMap(db),
		db
			.select({
				id: builds.id,
				number: builds.number,
				partId: builds.partId,
				assemblyId: builds.assemblyId,
				qtyMilli: builds.qtyMilli,
				optionValues: builds.optionValues,
			})
			.from(builds)
			.where(inArray(builds.status, OPEN_STATUSES))
			.orderBy(sql`${builds.plannedFor} IS NULL`, asc(builds.plannedFor), asc(builds.id)),
		db.select({ id: parts.id, supplierId: parts.supplierId }).from(parts),
		offersByPart(db),
		db
			.select({ typeId: machines.machineTypeId, n: sql<number>`count(*)` })
			.from(machines)
			.where(eq(machines.status, "active"))
			.groupBy(machines.machineTypeId),
		openBuildPicks(db),
	]);
	const preferredSupplier = new Map(partRows.map((p) => [p.id, p.supplierId]));
	// Stock to come from the open builds (D156): what they will make is available to the builds that need it.
	const planned = new Map<string, number>();
	for (const b of open) {
		const k = stockKey(b.partId, b.optionValues);
		planned.set(k, (planned.get(k) ?? 0) + b.qtyMilli);
	}
	// Planned output first fills a deficit: 5 arms planned with stock at −3 make 2 available (explode() clamps at 0).
	const available = new Map(onHand);
	for (const [k, qty] of planned) available.set(k, (available.get(k) ?? 0) + qty);
	/** Per made part and values to make: how many, for which builds, and the made parts it is built from (`uses`). */
	const toMake = new Map<string, { qty: number; builds: Set<string>; uses: Set<string> }>();
	const need = new Map<string, { qty: number; builds: Set<string> }>();
	const missing = new Map<string, { qty: number; builds: Set<string> }>();
	const lacking = new Map<string, Shortages["missingValues"][number]>();
	const add = (into: typeof need, k: string, qty: number, build: string) => {
		const e = into.get(k) ?? { qty: 0, builds: new Set<string>() };
		e.qty += qty;
		e.builds.add(build);
		into.set(k, e);
	};
	const load = new Map<number, MachineLoad>();
	const activeOf = new Map(active.map((a) => [a.typeId, a.n]));
	const addLoad = (machineType: GraphMachineType, minutesMilli: number, builds: Iterable<string>) => {
		const l = load.get(machineType.id) ?? {
			machineType,
			minutesMilli: 0,
			activeMachines: activeOf.get(machineType.id) ?? 0,
			builds: [],
		};
		l.minutesMilli += minutesMilli;
		for (const n of builds) if (!l.builds.includes(n)) l.builds.push(n);
		load.set(machineType.id, l);
	};
	for (const b of open) {
		const ex = explode(graph, b.assemblyId, b.qtyMilli, {
			available,
			values: idsOf(b.optionValues),
			picks: picks.get(b.id),
		});
		for (const m of missingValues(ex)) {
			const k = `${m.part.id}|${m.option}|${m.value}`;
			const e = lacking.get(k) ?? { ref: m.part.ref, name: m.part.name, option: m.option, value: m.value, builds: [] };
			if (!e.builds.includes(b.number)) e.builds.push(b.number);
			lacking.set(k, e);
		}
		// Machine time of the build itself and its kits; that of the sub-assemblies to make is added below, in whole
		// runs as they will be made (D156).
		const subTime = new Map<number, number>();
		for (const node of walkTree(ex.tree)) {
			// A make part built now, with an assembly to build it from (one without is in missingAssemblies).
			if (node.part.kind !== "make" || node.toBuildMilli <= 0 || node.assemblyId === null) continue;
			if (node.missingValues.length) continue;
			const e = toMake.get(nodeKey(node)) ?? { qty: 0, builds: new Set<string>(), uses: new Set<string>() };
			e.qty += node.toBuildMilli;
			e.builds.add(b.number);
			for (const sub of subBuilds(node)) e.uses.add(nodeKey(sub));
			toMake.set(nodeKey(node), e);
			const sub = node.assemblyId === null ? undefined : graph.assemblies.get(node.assemblyId);
			if (sub?.machineTypeId != null && sub.machineMinutes > 0)
				subTime.set(sub.machineTypeId, (subTime.get(sub.machineTypeId) ?? 0) + machineNeed(sub, node.toBuildMilli));
		}
		for (const r of ex.requirements) {
			// A value the part lacks is never ordered: its default only stands in (listed in missingValues).
			if (r.missingValue) continue;
			const k = stockKey(r.part.id, r.optionValues);
			if (r.missingAssembly) add(missing, k, r.qtyMilli, b.number);
			else if (r.part.kind === "buy") add(need, k, r.qtyMilli, b.number);
		}
		for (const m of ex.machines) {
			const own = m.minutesMilli - (subTime.get(m.machineType.id) ?? 0);
			if (own > 0) addLoad(m.machineType, own, [b.number]);
		}
	}
	// What to make, in whole runs (D156); what a part is made from comes first.
	const level = new Map<string, number>();
	const levelOf = (k: string, stack: string[] = []): number => {
		const known = level.get(k);
		if (known !== undefined) return known;
		if (stack.includes(k)) return 0;
		const uses = [...(toMake.get(k)?.uses ?? [])];
		const l = uses.length ? 1 + Math.max(...uses.map((u) => levelOf(u, [...stack, k]))) : 0;
		level.set(k, l);
		return l;
	};
	const toMakeLines: ToMakeLine[] = [];
	for (const [k, m] of toMake) {
		const { partId, key: optionValues } = splitStockKey(k);
		const part = graph.parts.get(partId);
		const assembly = defaultAssembly(graph, partId);
		if (!part || !assembly) continue;
		const runs = Math.ceil(m.qty / assembly.batchMilli);
		const toMakeMilli = assembly.batchMilli === MILLI ? m.qty : runs * assembly.batchMilli;
		const machineType =
			assembly.machineTypeId !== null && assembly.machineMinutes > 0
				? graph.machineTypes.get(assembly.machineTypeId)
				: undefined;
		toMakeLines.push({
			part,
			optionValues,
			assembly: { id: assembly.id, code: assembly.code, revision: assembly.revision, batchMilli: assembly.batchMilli },
			shortMilli: m.qty,
			onHandMilli: onHand.get(k) ?? 0,
			plannedMilli: planned.get(k) ?? 0,
			toMakeMilli,
			runs,
			machine: machineType ? { machineType, minutesMilli: machineNeed(assembly, toMakeMilli) } : null,
			level: levelOf(k),
			builds: [...m.builds],
		});
		// Rounded up to whole runs: what the rest of the last run uses is bought too, so making the suggested quantity
		// never takes stock below zero. Its own machine time is in the line; that of sub-assemblies inside it is not.
		if (toMakeMilli > m.qty) {
			const extra = explode(graph, assembly.id, toMakeMilli - m.qty, { available, values: idsOf(optionValues) });
			for (const r of extra.requirements) {
				if (r.missingValue) continue;
				const into = r.missingAssembly ? missing : r.part.kind === "buy" ? need : undefined;
				if (!into) continue;
				const rk = stockKey(r.part.id, r.optionValues);
				const e = into.get(rk) ?? { qty: 0, builds: new Set<string>() };
				e.qty += r.qtyMilli;
				for (const build of m.builds) e.builds.add(build);
				into.set(rk, e);
			}
		}
	}
	toMakeLines.sort(
		(a, b) =>
			a.level - b.level ||
			a.part.ref.localeCompare(b.part.ref) ||
			(a.optionValues ?? "").localeCompare(b.optionValues ?? ""),
	);
	for (const l of toMakeLines) if (l.machine) addLoad(l.machine.machineType, l.machine.minutesMilli, l.builds);
	// Parts already below zero (in some values) are short of their deficit even without open builds.
	for (const [k, qty] of onHand) {
		if (qty < 0 && graph.parts.get(splitStockKey(k).partId)?.kind === "buy" && !need.has(k))
			need.set(k, { qty: 0, builds: new Set() });
	}

	const groups = new Map<number | null, SupplierGroup>();
	for (const [k, n] of need) {
		const { partId, key: optionValues } = splitStockKey(k);
		const gp = graph.parts.get(partId);
		if (!gp) continue;
		const supplierId = preferredSupplier.get(partId) ?? null;
		const partOffers = offers.get(partId) ?? [];
		const preferred = partOffers.find((o) => o.supplierId === supplierId);
		const terms = preferred ?? NO_TERMS;
		const stock = onHand.get(k) ?? 0;
		const ordered = onOrder.get(k) ?? 0;
		const net = n.qty - stock - ordered;
		if (net <= 0) continue;
		const line: ShortageLine = {
			key: k,
			optionValues,
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
	for (const g of sorted)
		g.lines.sort(
			(a, b) => a.part.ref.localeCompare(b.part.ref) || (a.optionValues ?? "").localeCompare(b.optionValues ?? ""),
		);
	return {
		groups: sorted,
		toMake: toMakeLines,
		missingAssemblies: [...missing].map(([k, m]) => {
			const { partId, key } = splitStockKey(k);
			const part = graph.parts.get(partId);
			return {
				ref: part?.ref ?? String(partId),
				name: part?.name ?? "",
				optionValues: key,
				values: keyValues(part?.options ?? [], key),
				qtyMilli: m.qty,
				builds: [...m.builds],
			};
		}),
		missingValues: [...lacking.values()],
		machines: [...load.values()].sort((a, b) => a.machineType.name.localeCompare(b.machineType.name)),
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

/** The charges form of a PO (D201): amounts in the workshop's currency, empty = 0. */
export const poChargesInput = z.object({
	shipping: field.money(),
	duties: field.money(),
	discount: field.money(),
	charges_spread: field.oneOf(CHARGE_SPREADS),
});

export type ChargeValues = PoCharges;

export function chargeValues(d: z.output<typeof poChargesInput>): ChargeValues {
	return {
		shippingCents: d.shipping ?? 0,
		dutiesCents: d.duties ?? 0,
		discountCents: d.discount ?? 0,
		chargesSpread: d.charges_spread,
	};
}

/** The charges of a PO as its form shows them (to edit them, or to build the form an MCP call would post). */
export function chargeFormValues(c: ChargeValues): Record<string, string> {
	const amount = (cents: number) => (cents ? formatCentsInput(cents) : "");
	return {
		shipping: amount(c.shippingCents),
		duties: amount(c.dutiesCents),
		discount: amount(c.discountCents),
		charges_spread: c.chargesSpread,
	};
}

/** Rules shared by the charges form and update_draft_po (D201): a discount cannot exceed the rest of the order. */
export function chargeRuleErrors(c: ChargeValues, partsCents: number): FieldErrors {
	return c.discountCents > partsCents + c.shippingCents + c.dutiesCents ? { discount: "discount_too_large" } : {};
}

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
	lines: { partId: number; optionValues: OptionKey; qtyMilli: number; unitPriceCents: number; leadDays: number }[];
};

/**
 * Turns the shortage list into draft orders: lines of the checked supplier groups, each ordered from the
 * supplier chosen for it (its preferred one by default). A line moved to another supplier is rounded to
 * that supplier's MOQ and pack size and priced at its offer (else the standard cost). Lines without a
 * preferred supplier are ordered only when a supplier is chosen for them. `choice` takes a line's key (part and values).
 */
export function planDraftOrders(
	groups: SupplierGroup[],
	include: (supplierId: number) => boolean,
	choice: (key: string) => number | undefined,
): DraftOrder[] {
	const orders = new Map<number, DraftOrder>();
	for (const g of groups) {
		if (g.supplierId !== null && !include(g.supplierId)) continue;
		for (const l of g.lines) {
			const chosen = choice(l.key) ?? g.supplierId;
			const offer = l.offers.find((o) => o.supplierId === chosen);
			if (chosen === null || !offer) continue;
			const order = orders.get(chosen) ?? { supplierId: chosen, lines: [] };
			order.lines.push({
				partId: l.part.id,
				optionValues: l.optionValues,
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
					optionValues: l.optionValues,
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

export function updatePoChargesStatement(db: Db, poId: number, c: ChargeValues, user: string, now: string) {
	return db
		.update(purchaseOrders)
		.set({ ...c, updatedAt: now, updatedBy: user })
		.where(and(eq(purchaseOrders.id, poId), inArray(purchaseOrders.status, CHARGES_PO_STATUSES)));
}

export function addPoLineStatement(
	db: Db,
	poId: number,
	line: { partId: number; qtyMilli: number; unitPriceCents: number; optionValues?: OptionKey },
	user: string,
	now: string,
) {
	return db.insert(poLines).values({ poId, ...line, createdBy: user, updatedBy: user, createdAt: now, updatedAt: now });
}

export function updatePoLineStatement(
	db: Db,
	poId: number,
	lineId: number,
	d: { qtyMilli: number; unitPriceCents: number; optionValues?: OptionKey },
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
// Shipments (D168): the parcels a supplier sent for a PO, with their tracking numbers.

/** POs that shipments are recorded on: the supplier has the order. */
export const SHIPPING_PO_STATUSES: PoStatus[] = ["sent", "partial", "received"];

export const shipmentInput = z.object({
	carrier: field.required(100),
	tracking_number: field.required(100),
	tracking_url: field.url(),
	shipped_at: field.date(),
	// Not "notes": the PO's own form, on the same page, has that field (one id per page).
	shipment_notes: field.text(),
});

export type ShipmentValues = Pick<PoShipment, "carrier" | "trackingNumber" | "trackingUrl" | "shippedAt" | "notes">;

export function shipmentValues(d: z.output<typeof shipmentInput>): ShipmentValues {
	return {
		carrier: d.carrier,
		trackingNumber: d.tracking_number,
		trackingUrl: d.tracking_url,
		shippedAt: d.shipped_at,
		notes: d.shipment_notes,
	};
}

/** A shipment as its form shows it (to edit it, or to say what an MCP call would change). */
export function shipmentFormValues(s: ShipmentValues): Record<string, string> {
	return {
		carrier: s.carrier,
		tracking_number: s.trackingNumber,
		tracking_url: s.trackingUrl,
		shipped_at: s.shippedAt ?? "",
		shipment_notes: s.notes,
	};
}

/** The shipment of a PO with this tracking number (ignoring case), if any. */
export function shipmentByTracking<T extends Pick<PoShipment, "trackingNumber">>(shipments: T[], tracking: string) {
	const needle = tracking.trim().toLowerCase();
	return shipments.find((s) => s.trackingNumber.toLowerCase() === needle);
}

/**
 * Rules shared by the shipment form and record_po_shipment: only on a PO the supplier has (sent or received), and
 * one shipment per tracking number on a PO (`selfId`: the shipment being edited).
 */
export function shipmentRuleErrors(
	po: { status: PoStatus },
	shipments: Pick<PoShipment, "id" | "trackingNumber">[],
	trackingNumber: string,
	selfId?: number,
): FieldErrors {
	if (!SHIPPING_PO_STATUSES.includes(po.status)) return { _: "po_no_shipments" };
	const same = shipmentByTracking(shipments, trackingNumber);
	return same && same.id !== selfId ? { tracking_number: "duplicate_tracking" } : {};
}

export async function getPoShipments(db: Db, poId: number) {
	return db.select().from(poShipments).where(eq(poShipments.poId, poId)).orderBy(asc(poShipments.id));
}

/** Carriers already used, to suggest them in the form. */
export async function knownCarriers(db: Db): Promise<string[]> {
	const rows = await db
		.selectDistinct({ carrier: poShipments.carrier })
		.from(poShipments)
		.orderBy(asc(poShipments.carrier))
		.limit(100);
	return rows.map((r) => r.carrier);
}

export function addShipmentStatement(db: Db, poId: number, s: ShipmentValues, user: string, now: string) {
	return db
		.insert(poShipments)
		.values({ ...s, poId, createdBy: user, updatedBy: user, createdAt: now, updatedAt: now });
}

export function updateShipmentStatement(
	db: Db,
	poId: number,
	shipmentId: number,
	s: ShipmentValues,
	user: string,
	now: string,
) {
	return db
		.update(poShipments)
		.set({ ...s, updatedAt: now, updatedBy: user })
		.where(and(eq(poShipments.id, shipmentId), eq(poShipments.poId, poId)));
}

export function deleteShipmentStatement(db: Db, poId: number, shipmentId: number) {
	return db.delete(poShipments).where(and(eq(poShipments.id, shipmentId), eq(poShipments.poId, poId)));
}

// ---------------------------------------------------------------------------
// PO lists and details

export type PoFilters = { q?: string; status?: string };

export async function listPos(db: Db, f: PoFilters = {}) {
	const conds: SQL[] = [];
	if (f.q) {
		const like = likePattern(f.q);
		// A tracking number finds its PO too (pasted from a carrier's email into the search).
		conds.push(
			sql`(${purchaseOrders.number} LIKE ${like} ESCAPE '\\' OR ${suppliers.name} LIKE ${like} ESCAPE '\\'
				OR EXISTS (SELECT 1 FROM po_shipments s WHERE s.po_id = ${purchaseOrders.id} AND s.tracking_number LIKE ${like} ESCAPE '\\'))`,
		);
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
			// Lines and charges (D201), as the PO page totals them.
			totalCents: sql<number>`(SELECT COALESCE(SUM((l.qty_milli * l.unit_price_cents + 500) / 1000), 0) FROM po_lines l WHERE l.po_id = ${purchaseOrders.id})
				+ ${purchaseOrders.shippingCents} + ${purchaseOrders.dutiesCents} - ${purchaseOrders.discountCents}`,
			// The shipment recorded last, for the list's tracking column.
			shipmentCount: sql<number>`(SELECT count(*) FROM po_shipments s WHERE s.po_id = ${purchaseOrders.id})`,
			carrier: sql<
				string | null
			>`(SELECT s.carrier FROM po_shipments s WHERE s.po_id = ${purchaseOrders.id} ORDER BY s.id DESC LIMIT 1)`,
			trackingNumber: sql<
				string | null
			>`(SELECT s.tracking_number FROM po_shipments s WHERE s.po_id = ${purchaseOrders.id} ORDER BY s.id DESC LIMIT 1)`,
			trackingUrl: sql<
				string | null
			>`(SELECT s.tracking_url FROM po_shipments s WHERE s.po_id = ${purchaseOrders.id} ORDER BY s.id DESC LIMIT 1)`,
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

/** The lines of a PO, with each part's options and the line's values as text (D191). */
export async function getPoLines(db: Db, poId: number) {
	const rows = await queryPoLines(db, poId);
	const options = await loadOptions(db, [...new Set(rows.map((r) => r.line.partId))]);
	return rows.map((r) => {
		const partOptions = options.get(r.line.partId) ?? [];
		return { ...r, options: partOptions, values: keyLabel(partOptions, r.line.optionValues) };
	});
}

/** The landed unit cost of every line of a PO (D202), keyed by line id; the line price when nothing is spread. */
export function poLanded(po: PoCharges, lines: { line: { id: number; qtyMilli: number; unitPriceCents: number } }[]) {
	return spreadCharges(
		po,
		lines.map((l) => l.line),
	);
}

/**
 * How much of a PO's charges is in stock value (D203): what its receipt moves added above the line prices. Read from
 * the ledger, so it is what valuation and costing use: shares rounded per unit, and charges changed after a receipt,
 * make it differ from the charges.
 */
export async function chargesInStockCents(
	db: Db,
	poId: number,
	lines: { line: { receivedQtyMilli: number; unitPriceCents: number } }[],
): Promise<number> {
	const rows = await db
		.select({ value: sql<number | null>`SUM(${stockMoves.qtyMilli} * ${stockMoves.unitCostCents})` })
		.from(stockMoves)
		.where(and(eq(stockMoves.refType, "po"), eq(stockMoves.refId, poId), eq(stockMoves.reason, "receipt")));
	const atPrices = lines.reduce((s, l) => s + l.line.receivedQtyMilli * l.line.unitPriceCents, 0);
	return roundDiv((rows[0]?.value ?? 0) - atPrices, MILLI);
}

function queryPoLines(db: Db, poId: number) {
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

export type Receipt = {
	lineId: number;
	partId: number;
	/** The line's option values: what is received (D191). */
	optionValues: OptionKey;
	qtyMilli: number;
	/** What the units enter stock at: the line price, plus the line's share of the charges when they are spread (D202). */
	unitCostCents: number;
	serials: string[];
};

/** Form field names of a receipt: the quantity and the serials received on a PO line. */
export const receiveQtyField = (lineId: number) => `recv_${lineId}`;
export const receiveSerialsField = (lineId: number) => `serials_${lineId}`;

/**
 * Reads what was received from the receive form's fields (or the same fields built by an MCP tool): a quantity per
 * line, zero or more, and optionally one serial per unit (newlines, commas or semicolons between them). Errors are
 * keyed by field; nothing received at all is an error too. Each receipt is valued at its line's landed unit cost,
 * from the PO's charges as they are now and all its lines (D202, D203).
 */
export function planReceipts(
	po: PoCharges,
	lines: {
		line: { id: number; partId: number; qtyMilli: number; unitPriceCents: number; optionValues: OptionKey };
	}[],
	values: Record<string, string>,
): { receipts: Receipt[]; errors: FieldErrors } {
	const errors: FieldErrors = {};
	const receipts: Receipt[] = [];
	const landed = poLanded(po, lines);
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
			optionValues: l.line.optionValues,
			qtyMilli: qty,
			unitCostCents: landed.get(l.line.id)?.landedUnitCents ?? l.line.unitPriceCents,
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
					db.insert(stockMoves).values(
						moveValues(
							{
								partId: r.partId,
								qtyMilli: MILLI,
								serial,
								unitCostCents: r.unitCostCents,
								optionValues: r.optionValues,
							},
							ctx,
						),
					),
				);
			}
		} else {
			stmts.push(
				db.insert(stockMoves).values(
					moveValues(
						{
							partId: r.partId,
							qtyMilli: r.qtyMilli,
							serial: null,
							unitCostCents: r.unitCostCents,
							optionValues: r.optionValues,
						},
						ctx,
					),
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
