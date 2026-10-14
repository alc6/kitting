// Margin history of one sellable item, derived (never stored, D98):
// - planned: replayed from the price history, one point per day on which the standard cost of a component
//   of its roll-up or its selling price changed. The assembly structure is today's (as for valuation, D91);
// - actual: one point per completed build, its output at weighted average cost against the selling price
//   valid on the day it was completed (there is no sales record).
import { and, asc, eq } from "drizzle-orm";
import { assemblies, builds, parts, priceHistory } from "../db/schema";
import type { Db } from "../types";
import { loadGraph } from "./assemblies";
import { type AssemblyGraph, CostCalculator, centsOf, defaultAssembly } from "./assembly-graph";
import { buildUnitCents } from "./costing";
import { machineRateRows } from "./machines";
import { type Margin, marginOf } from "./margins";
import { resolveCostsAt } from "./prices";
import { averageCosts } from "./stock";

/** What is priced: an assembly variant of a part, or a part sold without assembly (`assemblyId` null). */
export type MarginTarget = { partId: number; assemblyId: number | null };

/** Standard cost rows, sorted by part, date, id. */
export type StandardRow = { partId: number; priceCents: number | null; validFrom: string };
/** Selling price rows of the target part, sorted by date, id (`assemblyId` set for a variant's own price). */
export type SaleRow = { assemblyId: number | null; priceCents: number | null; validFrom: string };

export type CostChange = { partId: number; fromCents: number | null; toCents: number | null };

/** Hourly rate rows of machine types, sorted by type, date, id (D149). */
export type RateRow = { machineTypeId: number; rateCents: number | null; validFrom: string };
export type RateChange = { machineTypeId: number; fromCents: number | null; toCents: number | null };

export type PlannedPoint = {
	/** YYYY-MM-DD: the values hold from this day until the next point. */
	date: string;
	costCents: number;
	incomplete: boolean;
	priceCents: number | null;
	margin: Margin | null;
	/** A component's cost predates its price history: its first recorded value was used. */
	fallback: boolean;
	/** Components whose standard cost changed that day (none on the first point). */
	costChanges: CostChange[];
	/** Machine types whose hourly rate changed that day (none on the first point). */
	rateChanges: RateChange[];
	priceChange: { fromCents: number | null; toCents: number | null } | null;
};

export type ActualPoint = {
	buildId: number;
	number: string;
	/** Day the build was completed. */
	date: string;
	qtyMilli: number;
	unitCents: number | null;
	incomplete: boolean;
	priceCents: number | null;
	margin: Margin | null;
};

/**
 * Parts whose standard cost feeds the planned cost of the target: the leaves of its roll-up (buy and fee
 * parts, make and kit parts without an active assembly). A make part with an assembly is rolled up, so its own
 * standard cost does not count.
 */
export function costInputs(graph: AssemblyGraph, target: MarginTarget): Set<number> {
	return rollupInputs(graph, target).parts;
}

/** Machine types whose hourly rate feeds the planned cost of the target: those of every assembly rolled up. */
export function machineInputs(graph: AssemblyGraph, target: MarginTarget): Set<number> {
	return rollupInputs(graph, target).machines;
}

function rollupInputs(graph: AssemblyGraph, target: MarginTarget) {
	const inputs = new Set<number>();
	const machines = new Set<number>();
	const visiting = new Set<number>();
	const visitAssembly = (assemblyId: number) => {
		const assembly = graph.assemblies.get(assemblyId);
		if (assembly?.machineTypeId != null && assembly.machineMinutes > 0) machines.add(assembly.machineTypeId);
		for (const line of assembly?.lines ?? []) visitPart(line.componentPartId);
	};
	const visitPart = (partId: number) => {
		const part = graph.parts.get(partId);
		const assembly = part && (part.kind === "make" || part.kind === "kit") ? defaultAssembly(graph, partId) : undefined;
		if (!assembly) {
			inputs.add(partId);
			return;
		}
		if (visiting.has(partId)) return; // a cycle: prevented on save, guarded here anyway
		visiting.add(partId);
		visitAssembly(assembly.id);
		visiting.delete(partId);
	};
	if (target.assemblyId === null) visitPart(target.partId);
	else visitAssembly(target.assemblyId);
	return { parts: inputs, machines };
}

/**
 * Selling price on a day: the variant's own price when it had one, else the part's. A level with history
 * but no row yet on that day had no price; a level without any history uses its current price.
 */
export function salePriceAt(
	rows: SaleRow[],
	assemblyId: number | null,
	date: string,
	current: { part: number | null; assembly: number | null },
): number | null {
	const level = (forAssembly: number | null, now: number | null) => {
		let seen = false;
		let price: number | null = null;
		for (const r of rows) {
			if (r.assemblyId !== forAssembly) continue;
			seen = true;
			if (r.validFrom <= date) price = r.priceCents;
		}
		return seen ? price : now;
	};
	return (assemblyId === null ? null : level(assemblyId, current.assembly)) ?? level(null, current.part);
}

/** Planned margin over time (oldest first). Pure: the caller loads the graph and the history. */
export function plannedMarginSeries(
	graph: AssemblyGraph,
	target: MarginTarget,
	standardRows: StandardRow[],
	saleRows: SaleRow[],
	currentSale: { part: number | null; assembly: number | null },
	rateRows: RateRow[] = [],
): PlannedPoint[] {
	const { parts: inputs, machines } = rollupInputs(graph, target);
	const relevant = standardRows.filter((r) => inputs.has(r.partId));
	// Machine rates replay like standard costs (resolveCostsAt keyed by machine type).
	const rates = rateRows
		.filter((r) => machines.has(r.machineTypeId))
		.map((r) => ({ partId: r.machineTypeId, priceCents: r.rateCents, validFrom: r.validFrom }));
	const sales = saleRows.filter((r) => r.assemblyId === null || r.assemblyId === target.assemblyId);
	const dates = [
		...new Set([
			...relevant.map((r) => r.validFrom),
			...rates.map((r) => r.validFrom),
			...sales.map((r) => r.validFrom),
		]),
	].sort();
	const current = [...inputs].map((id) => ({ id, costCents: graph.parts.get(id)?.costCents ?? null }));
	const currentRates = [...machines].map((id) => ({ id, costCents: graph.machineTypes.get(id)?.rateCents ?? null }));

	const points: PlannedPoint[] = [];
	let previous: Map<number, number | null> | null = null;
	let previousRates: Map<number, number | null> | null = null;
	for (const date of dates) {
		const { costs, fallback } = resolveCostsAt(relevant, current, date);
		const datedRates = resolveCostsAt(rates, currentRates, date);
		const dated: AssemblyGraph = {
			parts: new Map(graph.parts),
			assemblies: graph.assemblies,
			machineTypes: new Map(graph.machineTypes),
		};
		for (const id of inputs) {
			const part = dated.parts.get(id);
			if (part) dated.parts.set(id, { ...part, costCents: costs.get(id) ?? null });
		}
		for (const id of machines) {
			const type = dated.machineTypes.get(id);
			if (type) dated.machineTypes.set(id, { ...type, rateCents: datedRates.costs.get(id) ?? null });
		}
		const calc = new CostCalculator(dated);
		const cost = target.assemblyId === null ? calc.part(target.partId) : calc.assembly(target.assemblyId);
		const costCents = centsOf(cost.millicents);
		const priceCents = salePriceAt(sales, target.assemblyId, date, currentSale);
		const last = points.at(-1);
		const costChanges: CostChange[] = [];
		if (previous) {
			for (const id of inputs) {
				const from = previous.get(id) ?? null;
				const to = costs.get(id) ?? null;
				if (from !== to) costChanges.push({ partId: id, fromCents: from, toCents: to });
			}
		}
		const rateChanges: RateChange[] = [];
		if (previousRates) {
			for (const id of machines) {
				const from = previousRates.get(id) ?? null;
				const to = datedRates.costs.get(id) ?? null;
				if (from !== to) rateChanges.push({ machineTypeId: id, fromCents: from, toCents: to });
			}
		}
		const priceChange =
			last && last.priceCents !== priceCents ? { fromCents: last.priceCents, toCents: priceCents } : null;
		previous = costs;
		previousRates = datedRates.costs;
		// A day whose changes did not move this item (e.g. the part's price under a variant's own price).
		if (last && costChanges.length === 0 && rateChanges.length === 0 && !priceChange) continue;
		points.push({
			date,
			costCents,
			incomplete: cost.incomplete,
			priceCents,
			// Like the margins page: an incomplete cost still gives a (flagged, overstated) margin.
			margin: marginOf(priceCents, costCents),
			fallback: [...inputs].some((id) => fallback.has(id)) || [...machines].some((id) => datedRates.fallback.has(id)),
			costChanges,
			rateChanges,
			priceChange,
		});
	}
	return points;
}

/** Loads everything the margin history of a sellable item needs; null when the part or assembly does not exist. */
export async function marginHistory(db: Db, target: MarginTarget) {
	const [part] = await db
		.select({
			id: parts.id,
			ref: parts.ref,
			name: parts.name,
			kind: parts.kind,
			unit: parts.unit,
			salePriceCents: parts.salePriceCents,
		})
		.from(parts)
		.where(eq(parts.id, target.partId));
	if (!part) return null;
	const partAssemblies = await db
		.select({
			id: assemblies.id,
			code: assemblies.code,
			revision: assemblies.revision,
			status: assemblies.status,
			salePriceCents: assemblies.salePriceCents,
		})
		.from(assemblies)
		.where(eq(assemblies.parentPartId, part.id));
	const assembly = target.assemblyId === null ? null : partAssemblies.find((b) => b.id === target.assemblyId);
	if (assembly === undefined) return null;

	const [graph, standardRows, saleRows, done, rateRows] = await Promise.all([
		loadGraph(db),
		db
			.select({ partId: priceHistory.partId, priceCents: priceHistory.priceCents, validFrom: priceHistory.validFrom })
			.from(priceHistory)
			.where(eq(priceHistory.kind, "standard"))
			.orderBy(asc(priceHistory.partId), asc(priceHistory.validFrom), asc(priceHistory.id)),
		db
			.select({
				assemblyId: priceHistory.assemblyId,
				priceCents: priceHistory.priceCents,
				validFrom: priceHistory.validFrom,
			})
			.from(priceHistory)
			.where(and(eq(priceHistory.partId, part.id), eq(priceHistory.kind, "sale")))
			.orderBy(asc(priceHistory.validFrom), asc(priceHistory.id)),
		db
			.select({
				id: builds.id,
				number: builds.number,
				assemblyId: builds.assemblyId,
				qtyMilli: builds.qtyMilli,
				doneAt: builds.doneAt,
			})
			.from(builds)
			.where(and(eq(builds.partId, part.id), eq(builds.status, "done")))
			.orderBy(asc(builds.doneAt), asc(builds.id)),
		machineRateRows(db),
	]);

	const planned = plannedMarginSeries(
		graph,
		target,
		standardRows,
		saleRows,
		{ part: part.salePriceCents, assembly: assembly?.salePriceCents ?? null },
		rateRows,
	);

	// Builds of this variant, any revision (as on the margins page); of any assembly for a part without one.
	const codeOf = new Map(partAssemblies.map((b) => [b.id, b]));
	const mine = done.filter((b) => assembly === null || codeOf.get(b.assemblyId)?.code === assembly.code);
	const average = mine.length ? await averageCosts(db) : null;
	const actual: ActualPoint[] = mine.map((b) => {
		const date = (b.doneAt ?? "").slice(0, 10);
		const cost = average?.builds.get(b.id);
		const unitCents = buildUnitCents(cost);
		const incomplete = !cost || cost.incomplete;
		const priceCents = salePriceAt(saleRows, b.assemblyId, date, {
			part: part.salePriceCents,
			assembly: codeOf.get(b.assemblyId)?.salePriceCents ?? null,
		});
		return {
			buildId: b.id,
			number: b.number,
			date,
			qtyMilli: b.qtyMilli,
			unitCents,
			incomplete,
			priceCents,
			margin: marginOf(priceCents, unitCents),
		};
	});

	return {
		part,
		assembly,
		planned,
		actual,
		refs: new Map([...graph.parts].map(([id, p]) => [id, p.ref])),
		machineNames: new Map([...graph.machineTypes].map(([id, m]) => [id, m.name])),
	};
}
