// Pure assembly logic over an in-memory graph: explosion, cost roll-up, cycle detection.
// The whole catalogue is small (tens to hundreds of parts), so loading it once per
// request and walking it in TypeScript is simpler and easier to test than SQL.
import type { AssemblyStatus, PartKind } from "../db/schema";
import { MILLI, mulDivCeil, mulDivRound, roundDiv } from "../lib/units";

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

export type GraphAssembly = {
	id: number;
	parentPartId: number;
	code: string;
	revision: string;
	status: AssemblyStatus;
	/** Units of the parent one batch makes (milli); the lines are the quantities for the whole batch (D145). */
	batchMilli: number;
	lines: GraphLine[];
};

export type AssemblyGraph = {
	parts: Map<number, GraphPart>;
	assemblies: Map<number, GraphAssembly>;
};

export function buildGraph(
	parts: GraphPart[],
	assemblies: (Omit<GraphAssembly, "lines" | "batchMilli"> & { batchMilli?: number })[],
	lines: (GraphLine & { assemblyId: number })[],
) {
	const graph: AssemblyGraph = { parts: new Map(parts.map((p) => [p.id, p])), assemblies: new Map() };
	for (const b of assemblies) graph.assemblies.set(b.id, { ...b, batchMilli: b.batchMilli ?? MILLI, lines: [] });
	for (const l of lines) graph.assemblies.get(l.assemblyId)?.lines.push(l);
	for (const b of graph.assemblies.values()) b.lines.sort((x, y) => x.position - y.position || x.id - y.id);
	return graph;
}

/** Active assemblies of a part (one per variant code). */
export function activeAssemblies(graph: AssemblyGraph, partId: number): GraphAssembly[] {
	return [...graph.assemblies.values()].filter((b) => b.parentPartId === partId && b.status === "active");
}

/**
 * The assembly used when a part is exploded below the top level: its active `std` variant,
 * else its only active assembly, else the active assembly with the lowest id (deterministic).
 */
export function defaultAssembly(graph: AssemblyGraph, partId: number): GraphAssembly | undefined {
	const active = activeAssemblies(graph, partId).sort((a, b) => a.id - b.id);
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
	| "missing_assembly"; // make/kit part that must be built but has no active assembly

export type ExplodedNode = {
	/** Path of assembly line ids from the root, e.g. "12/40/41": stable key for overrides. */
	path: string;
	lineId: number;
	part: GraphPart;
	depth: number;
	/** Quantity per batch of the parent (the assembly line quantity): per one unit when `parentBatchMilli` is 1000. */
	perParentMilli: number;
	/** Units one batch of the parent's assembly makes (milli). */
	parentBatchMilli: number;
	/** Total quantity needed for the requested root quantity. */
	qtyMilli: number;
	mode: NodeMode;
	fromStockMilli: number;
	toBuildMilli: number;
	assemblyId: number | null;
	notes: string;
	children: ExplodedNode[];
};

export type Requirement = {
	part: GraphPart;
	qtyMilli: number;
	/** True for make/kit parts that must be built but have no active assembly. */
	missingAssembly: boolean;
};

export type Explosion = {
	assembly: GraphAssembly;
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

/**
 * Quantity of a line needed for `units` of its parent: line × units / batch (D145), rounded up to the thousandth so
 * nothing is under-picked (D26), and to whole units for a serial-tracked component (one serial per unit).
 */
export function lineNeed(
	line: { qtyMilli: number },
	units: number,
	batchMilli: number,
	part: { trackSerial: boolean },
) {
	const need = mulDivCeil(line.qtyMilli, units, batchMilli);
	return part.trackSerial ? Math.ceil(need / MILLI) * MILLI : need;
}

export class AssemblyCycleError extends Error {
	constructor(public readonly refs: string[]) {
		super(`Assembly cycle: ${refs.join(" → ")}`);
	}
}

/**
 * Explodes `qtyMilli` units of an assembly into leaf requirements.
 * - `kit` lines always explode into their default assembly.
 * - `make` lines are taken from `stock` up to what is available (shared across the whole
 *   explosion), the remainder explodes; `choices` can force "stock" or "build" per line.
 * - `fee` lines are listed separately: cost only.
 */
export function explode(
	graph: AssemblyGraph,
	assemblyId: number,
	qtyMilli: number,
	opts: ExplodeOptions = {},
): Explosion {
	const assembly = graph.assemblies.get(assemblyId);
	if (!assembly) throw new Error(`Unknown assembly ${assemblyId}`);
	const available = opts.available ?? new Map(opts.stock ?? []);
	const useStock = opts.stock !== undefined || opts.available !== undefined;
	const reqs = new Map<number, Requirement>();
	const fees = new Map<number, Requirement>();
	const add = (into: Map<number, Requirement>, part: GraphPart, qty: number, missingAssembly = false) => {
		if (qty <= 0) return;
		const r = into.get(part.id);
		if (r) {
			r.qtyMilli += qty;
			r.missingAssembly ||= missingAssembly;
		} else into.set(part.id, { part, qtyMilli: qty, missingAssembly });
	};

	const walk = (b: GraphAssembly, units: number, prefix: string, depth: number, stack: number[]): ExplodedNode[] => {
		if (depth > MAX_DEPTH || stack.includes(b.parentPartId)) {
			throw new AssemblyCycleError([...stack, b.parentPartId].map((id) => graph.parts.get(id)?.ref ?? String(id)));
		}
		const nextStack = [...stack, b.parentPartId];
		return b.lines.map((line) => {
			const part = graph.parts.get(line.componentPartId);
			if (!part) throw new Error(`Unknown part ${line.componentPartId}`);
			const path = prefix ? `${prefix}/${line.id}` : String(line.id);
			const need = lineNeed(line, units, b.batchMilli, part);
			const node: ExplodedNode = {
				path,
				lineId: line.id,
				part,
				depth,
				perParentMilli: line.qtyMilli,
				parentBatchMilli: b.batchMilli,
				qtyMilli: need,
				mode: "buy",
				fromStockMilli: 0,
				toBuildMilli: 0,
				assemblyId: null,
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
				const sub = defaultAssembly(graph, part.id);
				node.toBuildMilli = need;
				if (sub) {
					node.mode = "kit";
					node.assemblyId = sub.id;
					node.children = walk(sub, need, path, depth + 1, nextStack);
				} else {
					node.mode = "missing_assembly";
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
					const sub = defaultAssembly(graph, part.id);
					if (sub) {
						node.assemblyId = sub.id;
						node.children = walk(sub, toBuild, path, depth + 1, nextStack);
					} else {
						node.mode = fromStock > 0 ? "split" : "missing_assembly";
						add(reqs, part, toBuild, true);
					}
				}
			}
			return node;
		});
	};

	const tree = walk(assembly, qtyMilli, "", 0, []);
	const byRef = (a: Requirement, b: Requirement) => a.part.ref.localeCompare(b.part.ref);
	return {
		assembly,
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
	/** True when some leaf has no known cost (or a make/kit part has no assembly and no cost). */
	incomplete: boolean;
	/** Parts responsible for incompleteness. */
	missing: number[];
};

export const centsOf = (millicents: number): number => roundDiv(millicents, MILLI);

export class CostCalculator {
	private memo = new Map<number, Cost>();
	private inProgress = new Set<number>();
	constructor(private readonly graph: AssemblyGraph) {}

	/**
	 * Unit cost of a part: standard cost for buy/fee parts, rolled up from the default assembly
	 * for make/kit parts (falling back to their own standard cost when they have no assembly).
	 */
	part(partId: number): Cost {
		const cached = this.memo.get(partId);
		if (cached) return cached;
		const part = this.graph.parts.get(partId);
		// Unknown part, or a cycle (prevented on save, guarded here anyway).
		if (!part || this.inProgress.has(partId)) return { millicents: 0, incomplete: true, missing: [partId] };
		const assembly = part.kind === "make" || part.kind === "kit" ? defaultAssembly(this.graph, part.id) : undefined;
		let cost: Cost;
		if (assembly) {
			this.inProgress.add(partId);
			cost = this.assembly(assembly.id);
			this.inProgress.delete(partId);
		} else if (part.costCents === null) {
			cost = { millicents: 0, incomplete: true, missing: [part.id] };
		} else {
			cost = { millicents: part.costCents * MILLI, incomplete: false, missing: [] };
		}
		this.memo.set(partId, cost);
		return cost;
	}

	/** Cost of one unit of an assembly's parent, built from this assembly: its batch cost divided by the batch. */
	assembly(assemblyId: number): Cost {
		const assembly = this.graph.assemblies.get(assemblyId);
		if (!assembly) return { millicents: 0, incomplete: true, missing: [] };
		const batch = this.batch(assemblyId);
		return { ...batch, millicents: mulDivRound(batch.millicents, MILLI, assembly.batchMilli) };
	}

	/** Cost of one batch of an assembly (its lines as written), in millicents. */
	batch(assemblyId: number): Cost {
		const assembly = this.graph.assemblies.get(assemblyId);
		if (!assembly) return { millicents: 0, incomplete: true, missing: [] };
		let millicents = 0;
		let incomplete = false;
		const missing = new Set<number>();
		for (const line of assembly.lines) {
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
// Cycle detection across non-archived assemblies

/** Returns the refs forming a cycle (first and last equal), or null when the graph is acyclic. */
export function findCycle(graph: AssemblyGraph): string[] | null {
	const children = new Map<number, Set<number>>();
	for (const b of graph.assemblies.values()) {
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
