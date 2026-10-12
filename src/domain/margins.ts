// Margins: selling price against cost, planned (standard cost roll-up) and actual (what completed builds
// really cost at weighted average). Percentages are integer basis points (1 % = 100), never floats.
import { and, asc, eq, inArray } from "drizzle-orm";
import { boms, builds, type PartKind, parts } from "../db/schema";
import { basisPoints, roundDiv } from "../lib/units";
import type { Db } from "../types";
import { CostCalculator, centsOf } from "./bom-graph";
import { loadGraph } from "./boms";
import { buildUnitCents } from "./costing";
import { averageCosts } from "./stock";

export type Margin = {
	/** Price − cost, in cents. */
	marginCents: number;
	/** Margin over the selling price ("taux de marque"), in basis points. */
	rateBp: number | null;
	/** Margin over the cost ("taux de marge", markup), in basis points. */
	markupBp: number | null;
};

/** Margin of a price over a cost; null when either is unknown. */
export function marginOf(priceCents: number | null, costCents: number | null): Margin | null {
	if (priceCents === null || costCents === null) return null;
	const marginCents = priceCents - costCents;
	return { marginCents, rateBp: basisPoints(marginCents, priceCents), markupBp: basisPoints(marginCents, costCents) };
}

/** Selling price of a BoM variant: its own price, else the part's. */
export function salePriceOf(part: { salePriceCents: number | null }, bom?: { salePriceCents: number | null }) {
	return bom?.salePriceCents ?? part.salePriceCents;
}

export type MarginRow = {
	part: { id: number; ref: string; name: string; kind: PartKind; unit: string };
	/** The active BoM variant priced (null for a part sold without BoM, e.g. a resold buy part). */
	bom: { id: number; code: string; revision: string; ownPrice: boolean } | null;
	priceCents: number | null;
	/** Planned unit cost: the BoM roll-up at standard costs (or the standard cost without BoM). */
	plannedCostCents: number | null;
	plannedIncomplete: boolean;
	planned: Margin | null;
	/** Completed builds of this variant, and their average actual unit cost (weighted average costing). */
	doneBuilds: number;
	actualCostCents: number | null;
	actualIncomplete: boolean;
	actual: Margin | null;
};

/**
 * One row per sellable item: each active BoM variant of a part that has a selling price (its own or the
 * part's), and each part with a price but no active BoM. Actual cost = the average, over completed builds
 * of that variant, of their output value at weighted average cost.
 */
export async function marginReport(db: Db): Promise<MarginRow[]> {
	const [graph, partRows, bomRows, done, average] = await Promise.all([
		loadGraph(db),
		db
			.select({
				id: parts.id,
				ref: parts.ref,
				name: parts.name,
				kind: parts.kind,
				unit: parts.unit,
				costCents: parts.costCents,
				salePriceCents: parts.salePriceCents,
				archived: parts.archived,
			})
			.from(parts),
		db
			.select({
				id: boms.id,
				parentPartId: boms.parentPartId,
				code: boms.code,
				revision: boms.revision,
				salePriceCents: boms.salePriceCents,
			})
			.from(boms)
			.where(eq(boms.status, "active"))
			.orderBy(asc(boms.code)),
		db
			.select({ id: builds.id, partId: builds.partId, bomId: builds.bomId, code: boms.code })
			.from(builds)
			.innerJoin(boms, eq(builds.bomId, boms.id))
			.where(inArray(builds.status, ["done"])),
		averageCosts(db),
	]);
	const calc = new CostCalculator(graph);
	const bomsByPart = new Map<number, typeof bomRows>();
	for (const b of bomRows) bomsByPart.set(b.parentPartId, [...(bomsByPart.get(b.parentPartId) ?? []), b]);

	/** Actual unit costs of the done builds of a part's variant (any revision of that code). */
	const actualFor = (partId: number, code: string | null) => {
		const costs = done
			.filter((b) => b.partId === partId && (code === null || b.code === code))
			.map((b) => average.builds.get(b.id));
		const known = costs.flatMap((c) => {
			const u = buildUnitCents(c);
			return u === null ? [] : [u];
		});
		return {
			count: costs.length,
			cost: known.length
				? roundDiv(
						known.reduce((s, v) => s + v, 0),
						known.length,
					)
				: null,
			incomplete: costs.some((c) => !c || c.incomplete),
		};
	};

	const rows: MarginRow[] = [];
	for (const p of partRows) {
		if (p.archived) continue;
		const variants = bomsByPart.get(p.id) ?? [];
		const part = { id: p.id, ref: p.ref, name: p.name, kind: p.kind, unit: p.unit };
		if (variants.length === 0) {
			if (p.salePriceCents === null) continue;
			const actual = actualFor(p.id, null);
			rows.push({
				part,
				bom: null,
				priceCents: p.salePriceCents,
				plannedCostCents: p.costCents,
				plannedIncomplete: p.costCents === null,
				planned: marginOf(p.salePriceCents, p.costCents),
				doneBuilds: actual.count,
				actualCostCents: actual.cost,
				actualIncomplete: actual.incomplete,
				actual: marginOf(p.salePriceCents, actual.cost),
			});
			continue;
		}
		for (const b of variants) {
			const price = salePriceOf(p, b);
			if (price === null) continue;
			const cost = calc.bom(b.id);
			const plannedCost = centsOf(cost.millicents);
			const actual = actualFor(p.id, b.code);
			rows.push({
				part,
				bom: { id: b.id, code: b.code, revision: b.revision, ownPrice: b.salePriceCents !== null },
				priceCents: price,
				plannedCostCents: plannedCost,
				plannedIncomplete: cost.incomplete,
				planned: marginOf(price, plannedCost),
				doneBuilds: actual.count,
				actualCostCents: actual.cost,
				actualIncomplete: actual.incomplete,
				actual: marginOf(price, actual.cost),
			});
		}
	}
	return rows.sort(
		(a, b) => a.part.ref.localeCompare(b.part.ref) || (a.bom?.code ?? "").localeCompare(b.bom?.code ?? ""),
	);
}

/** Actual unit cost of one completed build at weighted average cost (null when not done or unknown). */
export async function buildActualCost(db: Db, buildId: number) {
	const [b] = await db
		.select({ id: builds.id })
		.from(builds)
		.where(and(eq(builds.id, buildId), eq(builds.status, "done")));
	if (!b) return null;
	const average = await averageCosts(db);
	const cost = average.builds.get(buildId);
	return { unitCents: buildUnitCents(cost), incomplete: cost?.incomplete ?? true };
}
