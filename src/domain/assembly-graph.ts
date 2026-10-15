// Pure assembly logic over an in-memory graph: explosion, cost roll-up, cycle detection.
// The whole catalogue is small (tens to hundreds of parts), so loading it once per
// request and walking it in TypeScript is simpler and easier to test than SQL.
import type { AssemblyStatus, PartKind } from "../db/schema";
import { MILLI, machineMillicents, mulDivCeil, mulDivRound, roundDiv } from "../lib/units";
import {
	defaultValue,
	keyOf,
	nameKey,
	type OptionDef,
	type OptionKey,
	type OptionValueDef,
	sameName,
	stockKey,
	valueIn,
} from "./option-keys";

export type GraphPart = {
	id: number;
	ref: string;
	name: string;
	kind: PartKind;
	unit: string;
	costCents: number | null;
	trackSerial: boolean;
	archived: boolean;
	/** The part's options and their values, in order (D183); empty for most parts. */
	options: OptionDef[];
};

export type GraphLine = {
	id: number;
	componentPartId: number;
	qtyMilli: number;
	position: number;
	notes: string;
	/** The values this line always takes, of some options of its component (D186). */
	fixedValueIds: number[];
	/** The options of its component chosen when a build is planned (D187); every other option follows the build. */
	chosenOptionIds: number[];
};

/** A machine type and its hourly rate (null = unknown), D147. */
export type GraphMachineType = { id: number; name: string; rateCents: number | null };

export type GraphAssembly = {
	id: number;
	parentPartId: number;
	code: string;
	revision: string;
	status: AssemblyStatus;
	/** Units of the parent one batch makes (milli); the lines are the quantities for the whole batch (D145). */
	batchMilli: number;
	/** Machine time per batch (D148): a machine type and whole minutes (0 = none). */
	machineTypeId: number | null;
	machineMinutes: number;
	lines: GraphLine[];
};

export type AssemblyGraph = {
	parts: Map<number, GraphPart>;
	assemblies: Map<number, GraphAssembly>;
	machineTypes: Map<number, GraphMachineType>;
};

type AssemblyInput = Omit<GraphAssembly, "lines" | "batchMilli" | "machineTypeId" | "machineMinutes"> &
	Partial<Pick<GraphAssembly, "batchMilli" | "machineTypeId" | "machineMinutes">>;
type PartInput = Omit<GraphPart, "options"> & Partial<Pick<GraphPart, "options">>;
type LineInput = Omit<GraphLine, "fixedValueIds" | "chosenOptionIds"> &
	Partial<Pick<GraphLine, "fixedValueIds" | "chosenOptionIds">> & { assemblyId: number };

export function buildGraph(
	parts: PartInput[],
	assemblies: AssemblyInput[],
	lines: LineInput[],
	machineTypes: GraphMachineType[] = [],
) {
	const graph: AssemblyGraph = {
		parts: new Map(parts.map((p) => [p.id, { ...p, options: p.options ?? [] }])),
		assemblies: new Map(),
		machineTypes: new Map(machineTypes.map((m) => [m.id, m])),
	};
	for (const b of assemblies) {
		graph.assemblies.set(b.id, {
			...b,
			batchMilli: b.batchMilli ?? MILLI,
			machineTypeId: b.machineTypeId ?? null,
			machineMinutes: b.machineMinutes ?? 0,
			lines: [],
		});
	}
	for (const { assemblyId, ...l } of lines)
		graph.assemblies.get(assemblyId)?.lines.push({
			...l,
			fixedValueIds: l.fixedValueIds ?? [],
			chosenOptionIds: l.chosenOptionIds ?? [],
		});
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

/** A value a "follow" line asks for and its component does not come in (D185): the cover has no "red". */
export type MissingValue = { option: string; value: string };

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
	/** The values of the part's options here (D185), null without options. */
	optionValues: OptionKey;
	/** Values the build asks for that the part does not come in: its default stands in, and the build is blocked. */
	missingValues: MissingValue[];
	children: ExplodedNode[];
};

export type Requirement = {
	part: GraphPart;
	/** The values of the part's options (D184): the same part in two keys is two requirements. */
	optionValues: OptionKey;
	qtyMilli: number;
	/** True for make/kit parts that must be built but have no active assembly. */
	missingAssembly: boolean;
	/** A value the build asks for that the part lacks (D185): such a requirement cannot be picked. */
	missingValue: MissingValue | null;
};

/** Machine time needed, per machine type: minutes in milli, rounded up (D148). */
export type MachineNeed = { machineType: GraphMachineType; minutesMilli: number };

export type Explosion = {
	assembly: GraphAssembly;
	qtyMilli: number;
	/** The values of the root part's options (D185). */
	optionValues: OptionKey;
	tree: ExplodedNode[];
	/** Parts consumed from stock: buy parts, make parts taken from stock, unresolved make parts. */
	requirements: Requirement[];
	/** Fee lines: count in cost only. */
	fees: Requirement[];
	/** Machine time of every assembly built: the root, kits and sub-assemblies built now (not those from stock). */
	machines: MachineNeed[];
};

export type ExplodeOptions = {
	/**
	 * Stock available for `make` components, keyed by `stockKey(part, values)` (copied). Omit to explode everything
	 * (pure structure).
	 */
	stock?: Map<string, number>;
	/**
	 * Shared availability, consumed in place: pass the same map to several explosions
	 * (e.g. all planned builds) so they do not take the same sub-assemblies twice.
	 */
	available?: Map<string, number>;
	/** Overrides by node path. */
	choices?: Map<string, MakeChoice>;
	/** The values of the root part's options (ids): the build's (D185); its defaults when omitted or incomplete. */
	values?: number[];
	/** Values chosen when the build was planned, per component part, for the options its lines leave to it (D187). */
	picks?: Map<number, number[]>;
};

export const MAX_DEPTH = 32;

/** Machine time of `units` of an assembly's parent: minutes per batch × units / batch, in milli, rounded up. */
export function machineNeed(assembly: Pick<GraphAssembly, "machineMinutes" | "batchMilli">, units: number): number {
	return mulDivCeil(units, assembly.machineMinutes * MILLI, assembly.batchMilli);
}

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

/** The option values a build passes down (D185): option name (lower case) → value name. */
export type OptionContext = Map<string, string>;

/** The values of the root part's options: those given, else each option's default. */
export function rootValues(part: GraphPart | undefined, values: number[] = []): number[] {
	return (part?.options ?? []).flatMap((o) => {
		const v = valueIn(o, values) ?? defaultValue(o);
		return v ? [v.id] : [];
	});
}

/** The context a part's values give its children: the part's own values override those of the same option name. */
export function contextFor(parent: OptionContext, part: GraphPart, ids: number[]): OptionContext {
	if (part.options.length === 0) return parent;
	const next = new Map(parent);
	for (const o of part.options) {
		const v = valueIn(o, ids);
		if (v) next.set(nameKey(o.name), v.name);
	}
	return next;
}

/**
 * The values of a component's options on a line (D185–D187): per option, the line's fixed value, else the value chosen
 * when the build was planned (else the default) for an option the line leaves to the build, else it follows: the value
 * of the same option name in the context, matched by name, else the default when no ancestor has that option. A value
 * the context asks for that the component lacks is returned in `missing`, its default standing in.
 */
export function resolveValues(
	part: GraphPart,
	line: Pick<GraphLine, "fixedValueIds" | "chosenOptionIds">,
	context: OptionContext,
	picks?: Map<number, number[]>,
): { ids: number[]; missing: MissingValue[] } {
	const ids: number[] = [];
	const missing: MissingValue[] = [];
	for (const option of part.options) {
		let value: OptionValueDef | undefined = valueIn(option, line.fixedValueIds);
		if (!value && line.chosenOptionIds.includes(option.id))
			value = valueIn(option, picks?.get(part.id) ?? []) ?? defaultValue(option);
		if (!value) {
			const wanted = context.get(nameKey(option.name));
			if (wanted !== undefined) {
				value = option.values.find((v) => sameName(v.name, wanted));
				if (!value) missing.push({ option: option.name, value: wanted });
			}
			value ??= defaultValue(option);
		}
		if (value) ids.push(value.id);
	}
	return { ids, missing };
}

/**
 * Explodes `qtyMilli` units of an assembly into leaf requirements.
 * - `kit` lines always explode into their default assembly.
 * - `make` lines are taken from `stock` up to what is available in their values (shared across the whole
 *   explosion), the remainder explodes; `choices` can force "stock" or "build" per line.
 * - `fee` lines are listed separately: cost only.
 * - Option values flow down from the root's (D185): every node carries its resolved values.
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
	const reqs = new Map<string, Requirement>();
	const fees = new Map<string, Requirement>();
	const machines = new Map<number, MachineNeed>();
	const addMachine = (b: GraphAssembly, units: number) => {
		const type = b.machineTypeId === null ? undefined : graph.machineTypes.get(b.machineTypeId);
		if (!type || b.machineMinutes <= 0 || units <= 0) return;
		const m = machines.get(type.id);
		if (m) m.minutesMilli += machineNeed(b, units);
		else machines.set(type.id, { machineType: type, minutesMilli: machineNeed(b, units) });
	};
	const add = (
		into: Map<string, Requirement>,
		part: GraphPart,
		optionValues: OptionKey,
		qty: number,
		missingAssembly = false,
		missingValue: MissingValue | null = null,
	) => {
		if (qty <= 0) return;
		const k = stockKey(part.id, optionValues);
		const r = into.get(k);
		if (r) {
			r.qtyMilli += qty;
			r.missingAssembly ||= missingAssembly;
			r.missingValue ??= missingValue;
		} else into.set(k, { part, optionValues, qtyMilli: qty, missingAssembly, missingValue });
	};

	const walk = (
		b: GraphAssembly,
		units: number,
		prefix: string,
		depth: number,
		stack: number[],
		context: OptionContext,
	): ExplodedNode[] => {
		if (depth > MAX_DEPTH || stack.includes(b.parentPartId)) {
			throw new AssemblyCycleError([...stack, b.parentPartId].map((id) => graph.parts.get(id)?.ref ?? String(id)));
		}
		const nextStack = [...stack, b.parentPartId];
		addMachine(b, units);
		return b.lines.map((line) => {
			const part = graph.parts.get(line.componentPartId);
			if (!part) throw new Error(`Unknown part ${line.componentPartId}`);
			const path = prefix ? `${prefix}/${line.id}` : String(line.id);
			const need = lineNeed(line, units, b.batchMilli, part);
			const { ids, missing } = resolveValues(part, line, context, opts.picks);
			const optionValues = keyOf(ids);
			const missingValue = missing[0] ?? null;
			const inner = contextFor(context, part, ids);
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
				optionValues,
				missingValues: missing,
				children: [],
			};
			if (part.kind === "fee") {
				node.mode = "fee";
				add(fees, part, null, need);
			} else if (part.kind === "buy") {
				node.fromStockMilli = need;
				add(reqs, part, optionValues, need, false, missingValue);
			} else if (part.kind === "kit") {
				const sub = defaultAssembly(graph, part.id);
				node.toBuildMilli = need;
				if (sub) {
					node.mode = "kit";
					node.assemblyId = sub.id;
					node.children = walk(sub, need, path, depth + 1, nextStack, inner);
				} else {
					node.mode = "missing_assembly";
					add(reqs, part, optionValues, need, true, missingValue);
				}
			} else {
				// make
				const choice = opts.choices?.get(path);
				const key = stockKey(part.id, optionValues);
				// A value the part lacks is never in stock: its default stands in only to name the problem.
				const avail = missingValue ? 0 : Math.max(0, available.get(key) ?? 0);
				let fromStock = 0;
				if (choice === "stock") fromStock = need;
				else if (choice !== "build" && useStock) fromStock = Math.min(need, avail);
				const toBuild = need - fromStock;
				if (fromStock > 0) {
					available.set(key, (available.get(key) ?? 0) - fromStock);
					add(reqs, part, optionValues, fromStock, false, missingValue);
				}
				node.fromStockMilli = fromStock;
				node.toBuildMilli = toBuild;
				node.mode = toBuild === 0 ? "stock" : fromStock > 0 ? "split" : "build";
				if (toBuild > 0) {
					const sub = defaultAssembly(graph, part.id);
					if (sub) {
						node.assemblyId = sub.id;
						node.children = walk(sub, toBuild, path, depth + 1, nextStack, inner);
					} else {
						node.mode = fromStock > 0 ? "split" : "missing_assembly";
						add(reqs, part, optionValues, toBuild, true, missingValue);
					}
				}
			}
			return node;
		});
	};

	const root = graph.parts.get(assembly.parentPartId);
	const rootIds = rootValues(root, opts.values);
	const tree = walk(assembly, qtyMilli, "", 0, [], root ? contextFor(new Map(), root, rootIds) : new Map());
	const byRef = (a: Requirement, b: Requirement) =>
		a.part.ref.localeCompare(b.part.ref) || (a.optionValues ?? "").localeCompare(b.optionValues ?? "");
	return {
		assembly,
		qtyMilli,
		optionValues: keyOf(rootIds),
		tree,
		requirements: [...reqs.values()].sort(byRef),
		fees: [...fees.values()].sort(byRef),
		machines: [...machines.values()].sort((a, b) => a.machineType.name.localeCompare(b.machineType.name)),
	};
}

/** Every value a build asks for that a component lacks (D185), with where it is. */
export function missingValues(explosion: Explosion): (MissingValue & { part: GraphPart; path: string })[] {
	return [...walkTree(explosion.tree)].flatMap((n) =>
		n.missingValues.map((m) => ({ ...m, part: n.part, path: n.path })),
	);
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
	/** True when some leaf has no known cost (or a make/kit part has no assembly and no cost, or a machine no rate). */
	incomplete: boolean;
	/** Parts responsible for incompleteness. */
	missing: number[];
	/** Machine types without an hourly rate that the roll-up needs (D148). */
	missingMachines?: number[];
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
		const missingMachines = new Set<number>();
		for (const line of assembly.lines) {
			const c = this.part(line.componentPartId);
			millicents += roundDiv(line.qtyMilli * c.millicents, MILLI);
			if (c.incomplete) {
				incomplete = true;
				for (const m of c.missing) missing.add(m);
				for (const m of c.missingMachines ?? []) missingMachines.add(m);
			}
		}
		const machine = this.machineBatch(assembly);
		if (machine) {
			millicents += machine.millicents;
			if (machine.incomplete) {
				incomplete = true;
				for (const m of machine.missingMachines ?? []) missingMachines.add(m);
			}
		}
		const cost: Cost = { millicents, incomplete, missing: [...missing] };
		if (missingMachines.size) cost.missingMachines = [...missingMachines];
		return cost;
	}

	/** Cost of the machine time of one batch of an assembly, or null when it has none. */
	machineBatch(assembly: Pick<GraphAssembly, "machineTypeId" | "machineMinutes">): Cost | null {
		if (assembly.machineTypeId === null || assembly.machineMinutes <= 0) return null;
		return this.machine(assembly.machineTypeId, assembly.machineMinutes * MILLI);
	}

	/** Cost of machine time on a machine type (minutes in milli), in millicents; incomplete without a rate. */
	machine(machineTypeId: number, minutesMilli: number): Cost {
		const rate = this.graph.machineTypes.get(machineTypeId)?.rateCents ?? null;
		if (rate === null) return { millicents: 0, incomplete: true, missing: [], missingMachines: [machineTypeId] };
		return { millicents: machineMillicents(rate, minutesMilli), incomplete: false, missing: [] };
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
