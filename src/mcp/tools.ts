// The MCP tools (D119). Each one: a scope (and, for tools that change data, a permission action) in its rule,
// zod input validation with decimals parsed by src/lib/units.ts, the existing domain queries, and a result in the
// app's integer fields that src/mcp/wire.ts redacts and converts. Adding a tool = rule + permission check (the
// rule) + redaction (toWire, automatic) + a test in test/mcp.test.ts.
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { BUILD_STATUSES, boms, builds, MOVE_REASONS, PART_KINDS, PO_STATUSES, purchaseOrders } from "../db/schema";
import {
	BomCycleError,
	type BomGraph,
	CostCalculator,
	centsOf,
	defaultBom,
	type ExplodedNode,
	explode,
} from "../domain/bom-graph";
import { getBom, loadGraph, partBomSummary, whereUsed } from "../domain/boms";
import { buildPickList, getBuild, getBuildLines, listBuilds, makeNodes, serialCount } from "../domain/builds";
import type { ToolRule } from "../domain/mcp-scopes";
import { partOffers } from "../domain/offers";
import { findRefClash, getPart, listParts, onHandMap, onHandOf } from "../domain/parts";
import type { Access } from "../domain/permissions";
import { computeShortages, getPo, getPoLines, listPos } from "../domain/purchasing";
import { isStocked, listMoves, onHandAt } from "../domain/stock";
import { lineCostCents, MILLI, parseMilli, roundDiv } from "../lib/units";
import type { Db } from "../types";

export type ToolContext = { db: Db; access: Access };

export type ToolSpec<S extends z.ZodType = z.ZodType> = {
	name: string;
	title: string;
	description: string;
	rule: ToolRule;
	input: S;
	/** Data in the app's integer fields (`*Milli`, `*Cents`): toWire() redacts and converts it. */
	run: (args: z.output<S>, ctx: ToolContext) => Promise<Record<string, unknown>>;
};

const tool = <S extends z.ZodType>(spec: ToolSpec<S>): ToolSpec => spec as unknown as ToolSpec;

/** A tool error the model can act on (the SDK returns it as an `isError` result). */
export class ToolError extends Error {}

// ---------------------------------------------------------------------------
// Inputs

/** A positive decimal quantity ("2", "1.5", or a number), at most 3 decimals, as milli. */
const quantity = z
	.union([z.string(), z.number()])
	.transform((v, ctx) => {
		const milli = parseMilli(String(v));
		if (milli === null || milli <= 0) {
			ctx.addIssue({
				code: "custom",
				message: 'must be a positive decimal number with at most 3 decimals, e.g. "2" or "1.5"',
			});
			return z.NEVER;
		}
		return milli;
	})
	.describe('A decimal quantity, e.g. "2" or "0.25" (in the part\'s unit).');

const limit = (fallback: number, max: number) =>
	z
		.number()
		.int()
		.min(1)
		.max(max)
		.default(fallback)
		.describe(`Maximum rows to return (default ${fallback}, at most ${max}).`);

const date = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/, "must be a date as YYYY-MM-DD")
	.describe("A date, YYYY-MM-DD (UTC).");

const partRef = z.string().trim().min(1).max(64).describe('A part reference, e.g. "LAMP-DESK" (case-insensitive).');

const bomSelector = {
	bom: z
		.union([z.number().int().positive(), z.string().trim().min(1).max(64)])
		.describe("A BoM id (number), or the reference of the part it builds (string): its active BoM is used."),
	code: z
		.string()
		.trim()
		.min(1)
		.max(64)
		.optional()
		.describe('Variant code when giving a part reference (default: "std", else its only active BoM).'),
	revision: z
		.string()
		.trim()
		.min(1)
		.max(64)
		.optional()
		.describe("A specific revision (any status) instead of the active one."),
};

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
export const READ_ONLY_ANNOTATIONS = READ_ONLY;

// ---------------------------------------------------------------------------
// Lookups with clear errors

async function partByRef(db: Db, ref: string) {
	const hit = await findRefClash(db, ref);
	const part = hit ? await getPart(db, hit.id) : undefined;
	if (!part) throw new ToolError(`No part with reference "${ref}". Use search_parts to find it.`);
	return part;
}

async function resolveBom(
	db: Db,
	graph: BomGraph,
	args: { bom: number | string; code?: string | undefined; revision?: string | undefined },
) {
	if (typeof args.bom === "number") {
		const found = await getBom(db, args.bom);
		if (!found) throw new ToolError(`No BoM with id ${args.bom}. Use get_part to list a part's BoMs.`);
		return found;
	}
	const part = await partByRef(db, args.bom);
	let id: number | undefined;
	if (args.revision) {
		const rows = await db
			.select({ id: boms.id })
			.from(boms)
			.where(and(eq(boms.parentPartId, part.id), eq(boms.code, args.code ?? "std"), eq(boms.revision, args.revision)));
		id = rows[0]?.id;
	} else if (args.code) {
		id = [...graph.boms.values()].find(
			(b) => b.parentPartId === part.id && b.code === args.code && b.status === "active",
		)?.id;
	} else id = defaultBom(graph, part.id)?.id;
	const found = id ? await getBom(db, id) : undefined;
	if (!found) {
		const which = args.revision ? `revision ${args.revision}` : args.code ? `active BoM "${args.code}"` : "active BoM";
		throw new ToolError(`${part.ref} has no ${which}. Use get_part to list its BoMs.`);
	}
	return found;
}

function exploding<T>(fn: () => T): T {
	try {
		return fn();
	} catch (err) {
		if (err instanceof BomCycleError) throw new ToolError(`This BoM contains a cycle: ${err.refs.join(" → ")}.`);
		throw err;
	}
}

function refsOf(graph: BomGraph, ids: number[]): string[] {
	return ids.map((id) => graph.parts.get(id)?.ref ?? String(id));
}

// ---------------------------------------------------------------------------
// catalog:read

const searchParts = tool({
	name: "search_parts",
	title: "Search parts",
	description:
		"Search the parts catalogue by reference, name or any supplier's reference. Returns each part's kind (buy: purchased, make: built from a BoM, kit: phantom BoM, fee: cost only), unit, on-hand quantity, preferred supplier and standard cost.",
	rule: { scope: "catalog:read" },
	input: z.object({
		query: z.string().trim().max(100).optional().describe("Text to look for; omit to list every part."),
		kind: z.enum(PART_KINDS).optional(),
		include_archived: z.boolean().default(false),
		limit: limit(50, 500),
	}),
	run: async (a, { db }) => {
		const rows = await listParts(db, { q: a.query ?? "", kind: a.kind ?? "", archived: a.include_archived });
		return {
			count: rows.length,
			truncated: rows.length > a.limit,
			parts: rows.slice(0, a.limit).map((p) => ({
				ref: p.ref,
				name: p.name,
				kind: p.kind,
				unit: p.unit,
				onHandMilli: p.onHandMilli,
				preferredSupplier: p.supplierName,
				standardCostCents: p.costCents,
				trackSerial: p.trackSerial,
				archived: p.archived,
			})),
		};
	},
});

const getPartTool = tool({
	name: "get_part",
	title: "Part details",
	description:
		"One part: details, standard cost and selling price, supplier offers (preferred first), on-hand quantity, its BoMs with their unit cost, and where it is used (directly or through sub-assemblies).",
	rule: { scope: "catalog:read" },
	input: z.object({ ref: partRef }),
	run: async (a, { db }) => {
		const part = await partByRef(db, a.ref);
		const [onHand, summary, used, offers] = await Promise.all([
			onHandOf(db, part.id),
			partBomSummary(db, part.id),
			whereUsed(db, part.id),
			partOffers(db, part.id),
		]);
		const ref = (id: number) => summary.refs.get(id) ?? String(id);
		return {
			part: {
				ref: part.ref,
				name: part.name,
				kind: part.kind,
				unit: part.unit,
				trackSerial: part.trackSerial,
				archived: part.archived,
				notes: part.notes,
				onHandMilli: onHand,
				standardCostCents: part.costCents,
				salePriceCents: part.salePriceCents,
			},
			offers: offers.map((o) => ({
				supplier: o.supplierName,
				preferred: o.preferred,
				supplierRef: o.supplierRef,
				priceCents: o.priceCents,
				moqMilli: o.moqMilli,
				packSizeMilli: o.packSizeMilli,
				leadDays: o.leadDays,
			})),
			boms: summary.boms.map((b) => ({
				bomId: b.id,
				code: b.code,
				revision: b.revision,
				status: b.status,
				unitCostCents: centsOf(b.cost.millicents),
				costIncomplete: b.cost.incomplete,
				salePriceCents: b.salePriceCents,
			})),
			rolledUpCost: summary.rollup
				? {
						unitCostCents: centsOf(summary.rollup.millicents),
						incomplete: summary.rollup.incomplete,
						missingCosts: summary.rollup.missing.map(ref),
					}
				: null,
			whereUsed: used.map((w) => ({
				parent: w.parentRef,
				parentName: w.parentName,
				bomId: w.bomId,
				code: w.code,
				revision: w.revision,
				status: w.status,
				depth: w.depth,
				via: w.viaRef,
				qtyPerParentMilli: w.qtyMilli,
			})),
		};
	},
});

function treeNode(n: ExplodedNode, calc: CostCalculator): Record<string, unknown> {
	const cost = calc.part(n.part.id);
	return {
		ref: n.part.ref,
		name: n.part.name,
		kind: n.part.kind,
		unit: n.part.unit,
		perParentMilli: n.perParentMilli,
		qtyMilli: n.qtyMilli,
		mode: n.mode,
		unitCostCents: centsOf(cost.millicents),
		extendedCostCents: centsOf(calc.extended(n.part.id, n.qtyMilli)),
		costIncomplete: cost.incomplete,
		notes: n.notes || undefined,
		children: n.children.length ? n.children.map((c) => treeNode(c, calc)) : undefined,
	};
}

const getBomTool = tool({
	name: "get_bom",
	title: "BoM tree",
	description:
		"The full structure of a BoM as a tree: per line the quantity per parent (per_parent) and the cumulative quantity for the requested quantity (qty), with unit and extended costs and the cost roll-up. Sub-assemblies (make) and kits are expanded through their active BoMs.",
	rule: { scope: "catalog:read" },
	input: z.object({ ...bomSelector, qty: quantity.optional().describe('How many to build (default "1").') }),
	run: async (a, { db }) => {
		const graph = await loadGraph(db);
		const { bom, part } = await resolveBom(db, graph, a);
		const qty = a.qty ?? MILLI;
		const calc = new CostCalculator(graph);
		const ex = exploding(() => explode(graph, bom.id, qty));
		const unit = calc.bom(bom.id);
		return {
			bom: {
				bomId: bom.id,
				part: part.ref,
				name: part.name,
				code: bom.code,
				revision: bom.revision,
				status: bom.status,
			},
			qtyMilli: qty,
			cost: {
				unitCostCents: centsOf(unit.millicents),
				totalCostCents: centsOf(roundDiv(qty * unit.millicents, MILLI)),
				incomplete: unit.incomplete,
				missingCosts: refsOf(graph, unit.missing),
			},
			lines: ex.tree.map((n) => treeNode(n, calc)),
		};
	},
});

const explodeBom = tool({
	name: "explode_bom",
	title: "Explode a BoM",
	description:
		"The flat list of components needed to build a quantity of a BoM, with on-hand and shortfall per component. With use_stock, sub-assemblies already in stock are taken from stock instead of being built (their components are then not needed). Fee lines are listed separately (cost only).",
	rule: { scope: "catalog:read" },
	input: z.object({ ...bomSelector, qty: quantity, use_stock: z.boolean().default(false) }),
	run: async (a, { db }) => {
		const [graph, stock] = await Promise.all([loadGraph(db), onHandMap(db)]);
		const { bom, part } = await resolveBom(db, graph, a);
		const calc = new CostCalculator(graph);
		const ex = exploding(() => explode(graph, bom.id, a.qty, a.use_stock ? { stock } : {}));
		let total = 0;
		const line = (r: (typeof ex.requirements)[number], withStock: boolean) => {
			const cost = calc.part(r.part.id);
			const extended = calc.extended(r.part.id, r.qtyMilli);
			total += extended;
			const onHand = stock.get(r.part.id) ?? 0;
			return {
				ref: r.part.ref,
				name: r.part.name,
				kind: r.part.kind,
				unit: r.part.unit,
				qtyMilli: r.qtyMilli,
				...(withStock ? { onHandMilli: onHand, shortMilli: Math.max(0, r.qtyMilli - Math.max(0, onHand)) } : {}),
				missingBom: r.missingBom || undefined,
				unitCostCents: centsOf(cost.millicents),
				extendedCostCents: centsOf(extended),
				costIncomplete: cost.incomplete,
			};
		};
		const components = ex.requirements.map((r) => line(r, true));
		const fees = ex.fees.map((f) => line(f, false));
		const unit = calc.bom(bom.id);
		return {
			bom: { bomId: bom.id, part: part.ref, code: bom.code, revision: bom.revision, status: bom.status },
			qtyMilli: a.qty,
			useStock: a.use_stock,
			components,
			fees,
			totalCostCents: centsOf(total),
			costIncomplete: unit.incomplete,
		};
	},
});

// ---------------------------------------------------------------------------
// stock:read

const STOCK_FILTERS = ["all", "below_zero", "below_moq", "in_stock"] as const;

const stockOnHand = tool({
	name: "stock_on_hand",
	title: "Stock on hand",
	description:
		"On-hand quantities of stocked parts (buy and make), with the preferred supplier's minimum order quantity. Filters: below_zero (negative stock), below_moq (under the MOQ), in_stock (positive).",
	rule: { scope: "stock:read" },
	input: z.object({
		query: z.string().trim().max(100).optional().describe("Text to look for in references and names."),
		filter: z.enum(STOCK_FILTERS).default("all"),
		limit: limit(100, 1000),
	}),
	run: async (a, { db }) => {
		const rows = (await listParts(db, { q: a.query ?? "" })).filter((p) => isStocked(p.kind));
		const kept = rows.filter((p) => {
			if (a.filter === "below_zero") return p.onHandMilli < 0;
			if (a.filter === "below_moq") return p.moqMilli > 0 && p.onHandMilli < p.moqMilli;
			if (a.filter === "in_stock") return p.onHandMilli > 0;
			return true;
		});
		return {
			filter: a.filter,
			count: kept.length,
			truncated: kept.length > a.limit,
			parts: kept.slice(0, a.limit).map((p) => ({
				ref: p.ref,
				name: p.name,
				kind: p.kind,
				unit: p.unit,
				onHandMilli: p.onHandMilli,
				moqMilli: p.moqMilli,
				preferredSupplier: p.supplierName,
			})),
		};
	},
});

const listMovesTool = tool({
	name: "list_moves",
	title: "Stock moves",
	description:
		"The stock ledger, newest first: receipts, build consumption and output, adjustments and counts. Each move is a signed quantity; on-hand is their sum.",
	rule: { scope: "stock:read" },
	input: z.object({
		query: z
			.string()
			.trim()
			.max(100)
			.optional()
			.describe("Text to look for in part references and names, serials and notes."),
		reason: z.enum(MOVE_REASONS).optional(),
		from: date.optional(),
		to: date.optional(),
		limit: limit(100, 500),
	}),
	run: async (a, { db }) => {
		const rows = await listMoves(db, {
			q: a.query ?? "",
			reason: a.reason ?? "",
			from: a.from ?? null,
			to: a.to ?? null,
			limit: a.limit,
		});
		return {
			count: rows.length,
			moves: rows.map((r) => ({
				at: r.move.at,
				ref: r.ref,
				name: r.name,
				unit: r.unit,
				qtyMilli: r.move.qtyMilli,
				reason: r.move.reason,
				serial: r.move.serial,
				unitCostCents: r.move.unitCostCents,
				source: r.move.refType ? `${r.move.refType}:${r.move.note || r.move.refId}` : undefined,
				note: r.move.note || undefined,
				by: r.move.by,
			})),
		};
	},
});

// ---------------------------------------------------------------------------
// builds:read

const BUILD_FILTERS = ["open", "all", ...BUILD_STATUSES] as const;

const listBuildsTool = tool({
	name: "list_builds",
	title: "Builds",
	description:
		"Builds (production orders), newest first. The query matches build numbers, product serials, part references and names, and the serials of consumed components: use it to find which build used a component serial. Status defaults to open (planned and in progress), or all when a query is given.",
	rule: { scope: "builds:read" },
	input: z.object({
		query: z.string().trim().max(100).optional(),
		status: z.enum(BUILD_FILTERS).optional(),
		limit: limit(50, 500),
	}),
	run: async (a, { db }) => {
		const status = a.status ?? (a.query ? "all" : "open");
		const rows = await listBuilds(db, { q: a.query ?? "", status, limit: a.limit });
		return {
			status,
			count: rows.length,
			builds: rows.map((b) => ({
				number: b.number,
				status: b.status,
				part: b.partRef,
				name: b.partName,
				unit: b.unit,
				qtyMilli: b.qtyMilli,
				serial: b.serial,
				bom: `${b.bomCode} ${b.bomRevision}`,
				plannedFor: b.plannedFor,
				doneAt: b.doneAt,
			})),
		};
	},
});

const getBuildTool = tool({
	name: "get_build",
	title: "Build details",
	description:
		"One build by number (e.g. B-0001). A done build returns its as-built record (consumed components with serials and frozen unit costs, and which build made each serial sub-assembly). An open build returns its pick list from current stock: components, shortfalls, serials to scan, sub-assemblies taken from stock or built, and problems blocking completion.",
	rule: { scope: "builds:read" },
	input: z.object({ number: z.string().trim().min(1).max(32).describe('The build number, e.g. "B-0001".') }),
	run: async (a, { db }) => {
		const hit = await db
			.select({ id: builds.id })
			.from(builds)
			.where(sql`lower(${builds.number}) = lower(${a.number})`)
			.limit(1);
		const found = hit[0] ? await getBuild(db, hit[0].id) : undefined;
		if (!found) throw new ToolError(`No build numbered "${a.number}". Use list_builds to find it.`);
		const { build, part, bom } = found;
		const header = {
			number: build.number,
			status: build.status,
			part: part.ref,
			name: part.name,
			unit: part.unit,
			qtyMilli: build.qtyMilli,
			serial: build.serial,
			bom: { bomId: bom.id, code: bom.code, revision: bom.revision },
			plannedFor: build.plannedFor,
			doneAt: build.doneAt,
			notes: build.notes || undefined,
		};
		if (build.status === "done") {
			const lines = await getBuildLines(db, build.id);
			const known = lines.every((l) => l.line.unitCostCents !== null);
			const total = lines.reduce((s, l) => s + lineCostCents(l.line.qtyMilli, l.line.unitCostCents ?? 0), 0);
			return {
				build: header,
				asBuilt: lines.map((l) => ({
					ref: l.ref,
					name: l.name,
					kind: l.kind,
					unit: l.unit,
					qtyMilli: l.line.qtyMilli,
					serial: l.line.serial,
					unitCostCents: l.line.unitCostCents,
					madeByBuild: l.sourceBuildNumber ?? undefined,
				})),
				totalCostCents: total,
				costIncomplete: !known,
			};
		}
		if (build.status === "cancelled") return { build: header };
		const [graph, onHand] = await Promise.all([loadGraph(db), onHandAt(db)]);
		const pick = exploding(() => buildPickList(graph, onHand, build, part, {}, false));
		return {
			build: header,
			pickList: pick.explosion.requirements.map((r) => {
				const stock = onHand.get(r.part.id) ?? 0;
				return {
					ref: r.part.ref,
					name: r.part.name,
					kind: r.part.kind,
					unit: r.part.unit,
					qtyMilli: r.qtyMilli,
					onHandMilli: stock,
					shortMilli: Math.max(0, r.qtyMilli - Math.max(0, stock)),
					serialsToScan: r.part.trackSerial ? serialCount(r) : undefined,
					missingBom: r.missingBom || undefined,
				};
			}),
			subAssemblies: makeNodes(pick.explosion).map((n) => ({
				ref: n.part.ref,
				qtyMilli: n.qtyMilli,
				fromStockMilli: n.fromStockMilli,
				toBuildMilli: n.toBuildMilli,
			})),
			fees: pick.explosion.fees.map((f) => ({ ref: f.part.ref, name: f.part.name, qtyMilli: f.qtyMilli })),
			problems: pick.problems.map((p) => ({ problem: p.key, ...p.vars })),
		};
	},
});

// ---------------------------------------------------------------------------
// purchasing:read

const getShortages = tool({
	name: "get_shortages",
	title: "Shortages",
	description:
		"What to buy for all planned and in-progress builds: per purchased part, need − on hand − on order, rounded up to the preferred supplier's MOQ and pack size, grouped by supplier. Also lists make or kit parts that must be built but have no active BoM.",
	rule: { scope: "purchasing:read" },
	input: z.object({}),
	run: async (_a, { db }) => {
		const s = await computeShortages(db);
		return {
			openBuilds: s.buildCount,
			suppliers: s.groups.map((g) => ({
				supplier: g.supplierName || null,
				totalCents: g.totalCents,
				lines: g.lines.map((l) => ({
					ref: l.part.ref,
					name: l.part.name,
					unit: l.part.unit,
					needMilli: l.needMilli,
					onHandMilli: l.onHandMilli,
					onOrderMilli: l.onOrderMilli,
					netMilli: l.netMilli,
					orderMilli: l.orderMilli,
					unitPriceCents: l.unitPriceCents,
					supplierRef: l.part.supplierRef || undefined,
					moqMilli: l.part.moqMilli,
					packSizeMilli: l.part.packSizeMilli,
					leadDays: l.part.leadDays,
					builds: l.builds,
				})),
			})),
			missingBoms: s.missingBoms.map((m) => ({ ref: m.ref, name: m.name, qtyMilli: m.qtyMilli, builds: m.builds })),
		};
	},
});

const PO_FILTERS = ["open", "all", ...PO_STATUSES] as const;

const listPurchaseOrders = tool({
	name: "list_purchase_orders",
	title: "Purchase orders",
	description: "Purchase orders, newest first. Status defaults to open (draft, sent and partly received).",
	rule: { scope: "purchasing:read" },
	input: z.object({
		query: z.string().trim().max(100).optional().describe("Text to look for in PO numbers and supplier names."),
		status: z.enum(PO_FILTERS).default("open"),
		limit: limit(50, 500),
	}),
	run: async (a, { db }) => {
		const rows = await listPos(db, { q: a.query ?? "", status: a.status });
		return {
			status: a.status,
			count: rows.length,
			truncated: rows.length > a.limit,
			purchaseOrders: rows.slice(0, a.limit).map((p) => ({
				number: p.number,
				status: p.status,
				supplier: p.supplierName,
				createdAt: p.createdAt,
				sentAt: p.sentAt,
				expectedAt: p.expectedAt,
				lines: p.lineCount,
				totalCents: p.totalCents,
			})),
		};
	},
});

const getPurchaseOrder = tool({
	name: "get_purchase_order",
	title: "Purchase order",
	description:
		"One purchase order by number (e.g. PO-0001): supplier, dates, and lines with ordered, received and remaining quantities and prices.",
	rule: { scope: "purchasing:read" },
	input: z.object({ number: z.string().trim().min(1).max(32).describe('The PO number, e.g. "PO-0001".') }),
	run: async (a, { db }) => {
		const hit = await db
			.select({ id: purchaseOrders.id })
			.from(purchaseOrders)
			.where(sql`lower(${purchaseOrders.number}) = lower(${a.number})`)
			.limit(1);
		const found = hit[0] ? await getPo(db, hit[0].id) : undefined;
		if (!found) throw new ToolError(`No purchase order numbered "${a.number}". Use list_purchase_orders to find it.`);
		const lines = await getPoLines(db, found.po.id);
		return {
			purchaseOrder: {
				number: found.po.number,
				status: found.po.status,
				supplier: found.supplier.name,
				supplierEmail: found.supplier.email || undefined,
				createdAt: found.po.createdAt,
				sentAt: found.po.sentAt,
				expectedAt: found.po.expectedAt,
				notes: found.po.notes || undefined,
			},
			lines: lines.map((l) => ({
				ref: l.ref,
				name: l.name,
				unit: l.unit,
				supplierRef: l.supplierRef || undefined,
				qtyMilli: l.line.qtyMilli,
				receivedMilli: l.line.receivedQtyMilli,
				remainingMilli: Math.max(0, l.line.qtyMilli - l.line.receivedQtyMilli),
				unitPriceCents: l.line.unitPriceCents,
				lineTotalCents: lineCostCents(l.line.qtyMilli, l.line.unitPriceCents),
			})),
			totalCents: lines.reduce((s, l) => s + lineCostCents(l.line.qtyMilli, l.line.unitPriceCents), 0),
		};
	},
});

/** Every MCP tool, in the order tools/list shows them. */
export const TOOLS: readonly ToolSpec[] = [
	searchParts,
	getPartTool,
	getBomTool,
	explodeBom,
	stockOnHand,
	listMovesTool,
	listBuildsTool,
	getBuildTool,
	getShortages,
	listPurchaseOrders,
	getPurchaseOrder,
];

export const TOOL_BY_NAME: ReadonlyMap<string, ToolSpec> = new Map(TOOLS.map((t) => [t.name, t]));
