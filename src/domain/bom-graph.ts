// Pure BoM logic over an in-memory graph: explosion, cost roll-up, cycle detection.
// The whole catalogue is small (tens to hundreds of parts), so loading it once per
// request and walking it in TypeScript is simpler and easier to test than SQL.
import type { BomStatus, PartKind } from "../db/schema";
import { MILLI, mulMilli, roundDiv } from "../lib/units";

export type GraphPart = {
	id: number;
	ref: string;
	name: string;
	kind: PartKind;
	unit: string;
	costCents: number | null;
	trackSerial: boolean;
	archived: boolean;
};

export type GraphLine = { id: number; componentPartId: number; qtyMilli: number; position: number; notes: string };

export type GraphBom = {
	id: number;
	parentPartId: number;
	code: string;
	revision: string;
	status: BomStatus;
	lines: GraphLine[];
};

export type BomGraph = {
	parts: Map<number, GraphPart>;
	boms: Map<number, GraphBom>;
};

export function buildGraph(
	parts: GraphPart[],
	boms: Omit<GraphBom, "lines">[],
	lines: (GraphLine & { bomId: number })[],
) {
	const graph: BomGraph = { parts: new Map(parts.map((p) => [p.id, p])), boms: new Map() };
	for (const b of boms) graph.boms.set(b.id, { ...b, lines: [] });
	for (const l of lines) graph.boms.get(l.bomId)?.lines.push(l);
	for (const b of graph.boms.values()) b.lines.sort((x, y) => x.position - y.position || x.id - y.id);
	return graph;
}

/** Active BoMs of a part (one per variant code). */
export function activeBoms(graph: BomGraph, partId: number): GraphBom[] {
	return [...graph.boms.values()].filter((b) => b.parentPartId === partId && b.status === "active");
}

/**
 * The BoM used when a part is exploded below the top level: its active `std` variant,
 * else its only active BoM, else the active BoM with the lowest id (deterministic).
 */
export function defaultBom(graph: BomGraph, partId: number): GraphBom | undefined {
	const active = activeBoms(graph, partId).sort((a, b) => a.id - b.id);
	return active.find((b) => b.code === "std") ?? active[0];
}

// ---------------------------------------------------------------------------
// Explosion

/** Per-line choice for `make` components: take from stock or build now (explode). */
export type MakeChoice = "stock" | "build";

export type NodeMode =
	| "buy" // purchased leaf
	| "fee" // cost only
	| "kit" // phantom, always exploded
	| "stock" // make part fully taken from stock
	| "build" // make part fully built now (exploded)
	| "split" // make part partly from stock, rest built
	| "missing_bom"; // make/kit part that must be built but has no active BoM

export type ExplodedNode = {
	/** Path of BoM line ids from the root, e.g. "12/40/41": stable key for overrides. */
	path: string;
	lineId: number;
	part: GraphPart;
	depth: number;
	/** Quantity per one unit of the parent line (the BoM line quantity). */
	perParentMilli: number;
	/** Total quantity needed for the requested root quantity. */
	qtyMilli: number;
	mode: NodeMode;
	fromStockMilli: number;
	toBuildMilli: number;
	bomId: number | null;
	notes: string;
	children: ExplodedNode[];
};

export type Requirement = {
	part: GraphPart;
	qtyMilli: number;
	/** True for make/kit parts that must be built but have no active BoM. */
	missingBom: boolean;
};

export type Explosion = {
	bom: GraphBom;
	qtyMilli: number;
	tree: ExplodedNode[];
	/** Parts consumed from stock: buy parts, make parts taken from stock, unresolved make parts. */
	requirements: Requirement[];
	/** Fee lines: count in cost only. */
	fees: Requirement[];
};

export type ExplodeOptions = {
	/** Stock available for `make` components (copied). Omit to explode everything (pure structure). */
	stock?: Map<number, number>;
	/**
	 * Shared availability, consumed in place: pass the same map to several explosions
	 * (e.g. all planned builds) so they do not take the same sub-assemblies twice.
	 */
	available?: Map<number, number>;
	/** Overrides by node path. */
	choices?: Map<string, MakeChoice>;
};

export const MAX_DEPTH = 32;

export class BomCycleError extends Error {
	constructor(public readonly refs: string[]) {
		super(`BoM cycle: ${refs.join(" → ")}`);
	}
}

/**
 * Explodes `qtyMilli` units of a BoM into leaf requirements.
 * - `kit` lines always explode into their default BoM.
 * - `make` lines are taken from `stock` up to what is available (shared across the whole
 *   explosion), the remainder explodes; `choices` can force "stock" or "build" per line.
 * - `fee` lines are listed separately: cost only.
 */
export function explode(graph: BomGraph, bomId: number, qtyMilli: number, opts: ExplodeOptions = {}): Explosion {
	const bom = graph.boms.get(bomId);
	if (!bom) throw new Error(`Unknown BoM ${bomId}`);
	const available = opts.available ?? new Map(opts.stock ?? []);
	const useStock = opts.stock !== undefined || opts.available !== undefined;
	const reqs = new Map<number, Requirement>();
	const fees = new Map<number, Requirement>();
	const add = (into: Map<number, Requirement>, part: GraphPart, qty: number, missingBom = false) => {
		if (qty <= 0) return;
		const r = into.get(part.id);
		if (r) {
			r.qtyMilli += qty;
			r.missingBom ||= missingBom;
		} else into.set(part.id, { part, qtyMilli: qty, missingBom });
	};

	const walk = (b: GraphBom, units: number, prefix: string, depth: number, stack: number[]): ExplodedNode[] => {
		if (depth > MAX_DEPTH || stack.includes(b.parentPartId)) {
			throw new BomCycleError([...stack, b.parentPartId].map((id) => graph.parts.get(id)?.ref ?? String(id)));
		}
		const nextStack = [...stack, b.parentPartId];
		return b.lines.map((line) => {
			const part = graph.parts.get(line.componentPartId);
			if (!part) throw new Error(`Unknown part ${line.componentPartId}`);
			const path = prefix ? `${prefix}/${line.id}` : String(line.id);
			const need = mulMilli(line.qtyMilli, units);
			const node: ExplodedNode = {
				path,
				lineId: line.id,
				part,
				depth,
				perParentMilli: line.qtyMilli,
				qtyMilli: need,
				mode: "buy",
				fromStockMilli: 0,
				toBuildMilli: 0,
				bomId: null,
				notes: line.notes,
				children: [],
			};
			if (part.kind === "fee") {
				node.mode = "fee";
				add(fees, part, need);
			} else if (part.kind === "buy") {
				node.fromStockMilli = need;
				add(reqs, part, need);
			} else if (part.kind === "kit") {
				const sub = defaultBom(graph, part.id);
				node.toBuildMilli = need;
				if (sub) {
					node.mode = "kit";
					node.bomId = sub.id;
					node.children = walk(sub, need, path, depth + 1, nextStack);
				} else {
					node.mode = "missing_bom";
					add(reqs, part, need, true);
				}
			} else {
				// make
				const choice = opts.choices?.get(path);
				const avail = Math.max(0, available.get(part.id) ?? 0);
				let fromStock = 0;
				if (choice === "stock") fromStock = need;
				else if (choice !== "build" && useStock) fromStock = Math.min(need, avail);
				const toBuild = need - fromStock;
				if (fromStock > 0) {
					available.set(part.id, (available.get(part.id) ?? 0) - fromStock);
					add(reqs, part, fromStock);
				}
				node.fromStockMilli = fromStock;
				node.toBuildMilli = toBuild;
				node.mode = toBuild === 0 ? "stock" : fromStock > 0 ? "split" : "build";
				if (toBuild > 0) {
					const sub = defaultBom(graph, part.id);
					if (sub) {
						node.bomId = sub.id;
						node.children = walk(sub, toBuild, path, depth + 1, nextStack);
					} else {
						node.mode = fromStock > 0 ? "split" : "missing_bom";
						add(reqs, part, toBuild, true);
					}
				}
			}
			return node;
		});
	};

	const tree = walk(bom, qtyMilli, "", 0, []);
	const byRef = (a: Requirement, b: Requirement) => a.part.ref.localeCompare(b.part.ref);
	return {
		bom,
		qtyMilli,
		tree,
		requirements: [...reqs.values()].sort(byRef),
		fees: [...fees.values()].sort(byRef),
	};
}

/** Visits every node of an exploded tree, depth first. */
export function* walkTree(nodes: ExplodedNode[]): Generator<ExplodedNode> {
	for (const n of nodes) {
		yield n;
		yield* walkTree(n.children);
	}
}

// ---------------------------------------------------------------------------
// Cost roll-up (in millicents: cents x 1000, so fractional quantities stay exact enough)

export type Cost = {
	/** Unit cost in millicents. */
	millicents: number;
	/** True when some leaf has no known cost (or a make/kit part has no BoM and no cost). */
	incomplete: boolean;
	/** Parts responsible for incompleteness. */
	missing: number[];
};

export const centsOf = (millicents: number): number => roundDiv(millicents, MILLI);

export class CostCalculator {
	private memo = new Map<number, Cost>();
	private inProgress = new Set<number>();
	constructor(private readonly graph: BomGraph) {}

	/**
	 * Unit cost of a part: standard cost for buy/fee parts, rolled up from the default BoM
	 * for make/kit parts (falling back to their own standard cost when they have no BoM).
	 */
	part(partId: number): Cost {
		const cached = this.memo.get(partId);
		if (cached) return cached;
		const part = this.graph.parts.get(partId);
		// Unknown part, or a cycle (prevented on save, guarded here anyway).
		if (!part || this.inProgress.has(partId)) return { millicents: 0, incomplete: true, missing: [partId] };
		const bom = part.kind === "make" || part.kind === "kit" ? defaultBom(this.graph, part.id) : undefined;
		let cost: Cost;
		if (bom) {
			this.inProgress.add(partId);
			cost = this.bom(bom.id);
			this.inProgress.delete(partId);
		} else if (part.costCents === null) {
			cost = { millicents: 0, incomplete: true, missing: [part.id] };
		} else {
			cost = { millicents: part.costCents * MILLI, incomplete: false, missing: [] };
		}
		this.memo.set(partId, cost);
		return cost;
	}

	/** Cost of one unit of a BoM's parent, built from this BoM. */
	bom(bomId: number): Cost {
		const bom = this.graph.boms.get(bomId);
		if (!bom) return { millicents: 0, incomplete: true, missing: [] };
		let millicents = 0;
		let incomplete = false;
		const missing = new Set<number>();
		for (const line of bom.lines) {
			const c = this.part(line.componentPartId);
			millicents += roundDiv(line.qtyMilli * c.millicents, MILLI);
			if (c.incomplete) {
				incomplete = true;
				for (const m of c.missing) missing.add(m);
			}
		}
		return { millicents, incomplete, missing: [...missing] };
	}

	/** Extended cost of a quantity of a part, in millicents. */
	extended(partId: number, qtyMilli: number): number {
		return roundDiv(qtyMilli * this.part(partId).millicents, MILLI);
	}
}

// ---------------------------------------------------------------------------
// Cycle detection across non-archived BoMs

/** Returns the refs forming a cycle (first and last equal), or null when the graph is acyclic. */
export function findCycle(graph: BomGraph): string[] | null {
	const children = new Map<number, Set<number>>();
	for (const b of graph.boms.values()) {
		if (b.status === "archived") continue;
		const set = children.get(b.parentPartId) ?? new Set<number>();
		for (const l of b.lines) set.add(l.componentPartId);
		children.set(b.parentPartId, set);
	}
	const state = new Map<number, 1 | 2>(); // 1 = on stack, 2 = done
	const stack: number[] = [];
	const ref = (id: number) => graph.parts.get(id)?.ref ?? String(id);
	const visit = (id: number): string[] | null => {
		state.set(id, 1);
		stack.push(id);
		for (const child of children.get(id) ?? []) {
			const s = state.get(child);
			if (s === 1) return [...stack.slice(stack.indexOf(child)), child].map(ref);
			if (s === undefined) {
				const found = visit(child);
				if (found) return found;
			}
		}
		stack.pop();
		state.set(id, 2);
		return null;
	};
	for (const id of children.keys()) {
		if (!state.has(id)) {
			const found = visit(id);
			if (found) return found;
		}
	}
	return null;
}
