// The read-only MCP tools (D119): catalogue, stock, builds and purchasing, over the existing domain queries.
import { z } from "zod";
import { BUILD_STATUSES, type FileRow, MOVE_REASONS, PART_KINDS, PO_STATUSES } from "../db/schema";
import { loadGraph, partAssemblySummary, whereUsed } from "../domain/assemblies";
import { CostCalculator, centsOf, type ExplodedNode, explode, type MachineNeed } from "../domain/assembly-graph";
import {
	buildPickList,
	getBuildLines,
	getBuildMachineTimes,
	listBuilds,
	makeNodes,
	serialCount,
} from "../domain/builds";
import { assemblyFiles, partFiles } from "../domain/files";
import { listMachines, listMachineTypes } from "../domain/machines";
import { partOffers } from "../domain/offers";
import { listParts, onHandMap, onHandOf } from "../domain/parts";
import { computeShortages, getPoLines, listPos } from "../domain/purchasing";
import { belowMinimum, isStocked, listMoves, onHandAt } from "../domain/stock";
import { lineCostCents, MILLI, machineMillicents, roundDiv } from "../lib/units";
import {
	assemblySelector,
	buildByNumber,
	date,
	exploding,
	limit,
	partByRef,
	partRef,
	poByNumber,
	quantity,
	refsOf,
	resolveAssembly,
	type ToolSpec,
	tool,
} from "./kit";

// ---------------------------------------------------------------------------
// catalog:read

/**
 * Attached files (D165): what they are, and where the user downloads them in the app (behind Access, so the link
 * is for the person, not for the assistant). Uploading or changing files is not available over MCP.
 */
function filesView(files: FileRow[], origin: string, attachedTo?: "assembly" | "part") {
	return files.map((f) => ({
		name: f.name,
		kind: f.kind,
		format: f.format,
		sizeBytes: f.sizeBytes,
		uploadedAt: f.uploadedAt,
		uploadedBy: f.uploadedBy,
		note: f.note || undefined,
		attachedTo,
		downloadPath: `/files/${f.id}/download`,
		downloadUrl: `${origin}/files/${f.id}/download`,
	}));
}

/** Machine time of an explosion, with its cost (D148). */
function machineTimeView(needs: MachineNeed[], calc: CostCalculator) {
	return needs.map((m) => {
		const cost = calc.machine(m.machineType.id, m.minutesMilli);
		return {
			type: m.machineType.name,
			minutesMilli: m.minutesMilli,
			hourlyRateCents: m.machineType.rateCents,
			costCents: cost.incomplete ? null : centsOf(cost.millicents),
		};
	});
}

const searchParts = tool({
	name: "search_parts",
	title: "Search parts",
	description:
		"Search the parts catalogue by reference, name or any supplier's reference. Returns each part's kind (buy: purchased, make: built from an assembly, kit: phantom assembly, fee: cost only), unit, on-hand quantity, preferred supplier and standard cost.",
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
		"One part: details, standard cost and selling price, supplier offers (preferred first), on-hand quantity, its assemblies with their unit cost, where it is used (directly or through sub-assemblies), and its own files (drawings, datasheets…; a revision's files are in get_assembly).",
	rule: { scope: "catalog:read" },
	input: z.object({ ref: partRef }),
	run: async (a, { db, origin }) => {
		const part = await partByRef(db, a.ref);
		const [onHand, summary, used, offers, files] = await Promise.all([
			onHandOf(db, part.id),
			partAssemblySummary(db, part.id),
			whereUsed(db, part.id),
			partOffers(db, part.id),
			partFiles(db, part.id),
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
				minStockMilli: part.minStockMilli,
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
			assemblies: summary.assemblies.map((b) => ({
				assemblyId: b.id,
				code: b.code,
				revision: b.revision,
				status: b.status,
				batchMilli: b.batchQtyMilli,
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
				assemblyId: w.assemblyId,
				code: w.code,
				revision: w.revision,
				status: w.status,
				depth: w.depth,
				via: w.viaRef,
				qtyPerParentMilli: w.qtyMilli,
				batchMilli: w.batchMilli,
			})),
			files: filesView(files, origin),
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
		parentBatchMilli: n.parentBatchMilli !== MILLI ? n.parentBatchMilli : undefined,
		qtyMilli: n.qtyMilli,
		mode: n.mode,
		unitCostCents: centsOf(cost.millicents),
		extendedCostCents: centsOf(calc.extended(n.part.id, n.qtyMilli)),
		costIncomplete: cost.incomplete,
		notes: n.notes || undefined,
		children: n.children.length ? n.children.map((c) => treeNode(c, calc)) : undefined,
	};
}

const getAssemblyTool = tool({
	name: "get_assembly",
	title: "Assembly tree",
	description:
		"The full structure of an assembly as a tree: per line the quantity per parent (per_parent: per batch of the parent when it makes batches, parent_batch units at a time) and the cumulative quantity for the requested quantity (qty), with unit and extended costs and the cost roll-up per unit. Sub-assemblies (make) and kits are expanded through their active assemblies. Also the files of this revision (print files, assembly instructions…).",
	rule: { scope: "catalog:read" },
	input: z.object({ ...assemblySelector, qty: quantity.optional().describe('How many to build (default "1").') }),
	run: async (a, { db, origin }) => {
		const graph = await loadGraph(db);
		const { assembly, part } = await resolveAssembly(db, graph, a);
		const qty = a.qty ?? MILLI;
		const calc = new CostCalculator(graph);
		const ex = exploding(() => explode(graph, assembly.id, qty));
		const unit = calc.assembly(assembly.id);
		const machine = assembly.machineTypeId === null ? undefined : graph.machineTypes.get(assembly.machineTypeId);
		return {
			assembly: {
				assemblyId: assembly.id,
				part: part.ref,
				name: part.name,
				code: assembly.code,
				revision: assembly.revision,
				status: assembly.status,
				batchMilli: assembly.batchQtyMilli,
				machineType: machine?.name ?? null,
				machineMinutes: machine ? assembly.machineMinutes : 0,
			},
			qtyMilli: qty,
			cost: {
				unitCostCents: centsOf(unit.millicents),
				totalCostCents: centsOf(roundDiv(qty * unit.millicents, MILLI)),
				incomplete: unit.incomplete,
				missingCosts: [
					...refsOf(graph, unit.missing),
					...(unit.missingMachines ?? []).map((id) => graph.machineTypes.get(id)?.name ?? String(id)),
				],
			},
			lines: ex.tree.map((n) => treeNode(n, calc)),
			machineTime: machineTimeView(ex.machines, calc),
			files: filesView(await assemblyFiles(db, assembly.id), origin),
		};
	},
});

const explodeAssembly = tool({
	name: "explode_assembly",
	title: "Explode an assembly",
	description:
		"The flat list of components needed to build a quantity of an assembly, with on-hand and shortfall per component. With use_stock, sub-assemblies already in stock are taken from stock instead of being built (their components are then not needed). Fee lines are listed separately (cost only).",
	rule: { scope: "catalog:read" },
	input: z.object({ ...assemblySelector, qty: quantity, use_stock: z.boolean().default(false) }),
	run: async (a, { db }) => {
		const [graph, stock] = await Promise.all([loadGraph(db), onHandMap(db)]);
		const { assembly, part } = await resolveAssembly(db, graph, a);
		const calc = new CostCalculator(graph);
		const ex = exploding(() => explode(graph, assembly.id, a.qty, a.use_stock ? { stock } : {}));
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
				missingAssembly: r.missingAssembly || undefined,
				unitCostCents: centsOf(cost.millicents),
				extendedCostCents: centsOf(extended),
				costIncomplete: cost.incomplete,
			};
		};
		const components = ex.requirements.map((r) => line(r, true));
		const fees = ex.fees.map((f) => line(f, false));
		const machineTime = machineTimeView(ex.machines, calc);
		for (const m of ex.machines) total += calc.machine(m.machineType.id, m.minutesMilli).millicents;
		const unit = calc.assembly(assembly.id);
		return {
			assembly: {
				assemblyId: assembly.id,
				part: part.ref,
				code: assembly.code,
				revision: assembly.revision,
				status: assembly.status,
				batchMilli: assembly.batchQtyMilli,
			},
			qtyMilli: a.qty,
			useStock: a.use_stock,
			components,
			fees,
			machineTime,
			totalCostCents: centsOf(total),
			costIncomplete: unit.incomplete,
		};
	},
});

const listMachinesTool = tool({
	name: "list_machines",
	title: "Machines",
	description:
		"The machine types (what recipes name, with their hourly rate) and the machines of each type with their status (active = in service, maintenance, retired). Each type also gives how many recipes use it and the machine time its planned and in-progress builds need (planned_minutes).",
	rule: { scope: "catalog:read" },
	input: z.object({ include_retired: z.boolean().default(false).describe("Also list retired machines.") }),
	run: async (a, { db }) => {
		const [types, list, shortages] = await Promise.all([
			listMachineTypes(db),
			listMachines(db, { retired: a.include_retired }),
			computeShortages(db),
		]);
		const load = new Map(shortages.machines.map((m) => [m.machineType.id, m.minutesMilli]));
		return {
			machineTypes: types.map((m) => ({
				name: m.name,
				hourlyRateCents: m.hourlyRateCents,
				activeMachines: m.activeMachines,
				recipes: m.recipeCount,
				plannedMinutesMilli: load.get(m.id) ?? 0,
				notes: m.notes || undefined,
			})),
			machines: list.map((m) => ({ name: m.name, type: m.typeName, status: m.status, notes: m.notes || undefined })),
		};
	},
});

// ---------------------------------------------------------------------------
// stock:read

const STOCK_FILTERS = ["all", "below_zero", "below_min", "in_stock"] as const;

const stockOnHand = tool({
	name: "stock_on_hand",
	title: "Stock on hand",
	description:
		"On-hand quantities of stocked parts (buy and make), with each part's minimum stock (null: none). Filters: below_zero (negative stock), below_min (under a set minimum stock), in_stock (positive).",
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
			if (a.filter === "below_min") return belowMinimum(p);
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
				minStockMilli: p.minStockMilli,
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
				assembly: `${b.assemblyCode} ${b.assemblyRevision}`,
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
		"One build by number (e.g. B-0001). A done build returns its as-built record (consumed components with serials and frozen unit costs, and which build made each serial sub-assembly). An open build returns its pick list from current stock: components, shortfalls, serials to scan, sub-assemblies taken from stock or built, and problems blocking completion. Every build lists the files to make it: its assembly revision's, then the part's own.",
	rule: { scope: "builds:read" },
	input: z.object({ number: z.string().trim().min(1).max(32).describe('The build number, e.g. "B-0001".') }),
	run: async (a, { db, origin }) => {
		const { build, part, assembly } = await buildByNumber(db, a.number);
		const [revisionFiles, ownFiles] = await Promise.all([assemblyFiles(db, assembly.id), partFiles(db, part.id)]);
		const files = [...filesView(revisionFiles, origin, "assembly"), ...filesView(ownFiles, origin, "part")];
		const header = {
			number: build.number,
			status: build.status,
			part: part.ref,
			name: part.name,
			unit: part.unit,
			qtyMilli: build.qtyMilli,
			serial: build.serial,
			assembly: { assemblyId: assembly.id, code: assembly.code, revision: assembly.revision },
			plannedFor: build.plannedFor,
			doneAt: build.doneAt,
			notes: build.notes || undefined,
		};
		if (build.status === "done") {
			const [lines, machines] = await Promise.all([getBuildLines(db, build.id), getBuildMachineTimes(db, build.id)]);
			const known = lines.every((l) => l.line.unitCostCents !== null) && machines.every((m) => m.rateCents !== null);
			const machineTime = machines.map((m) => ({
				type: m.name,
				minutesMilli: m.minutesMilli,
				hourlyRateCents: m.rateCents,
				costCents: m.rateCents === null ? null : centsOf(machineMillicents(m.rateCents, m.minutesMilli)),
			}));
			const total =
				lines.reduce((s, l) => s + lineCostCents(l.line.qtyMilli, l.line.unitCostCents ?? 0), 0) +
				machineTime.reduce((s, m) => s + (m.costCents ?? 0), 0);
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
				machineTime,
				totalCostCents: total,
				costIncomplete: !known,
				files,
			};
		}
		if (build.status === "cancelled") return { build: header, files };
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
					missingAssembly: r.missingAssembly || undefined,
				};
			}),
			subAssemblies: makeNodes(pick.explosion).map((n) => ({
				ref: n.part.ref,
				// The node's path in the assembly tree: complete_build can take or build each one separately.
				path: n.path,
				qtyMilli: n.qtyMilli,
				fromStockMilli: n.fromStockMilli,
				toBuildMilli: n.toBuildMilli,
			})),
			fees: pick.explosion.fees.map((f) => ({ ref: f.part.ref, name: f.part.name, qtyMilli: f.qtyMilli })),
			machineTime: machineTimeView(pick.explosion.machines, new CostCalculator(graph)),
			problems: pick.problems.map((p) => ({ problem: p.key, ...p.vars })),
			files,
		};
	},
});

// ---------------------------------------------------------------------------
// purchasing:read

const getShortages = tool({
	name: "get_shortages",
	title: "Shortages",
	description:
		"What to make and what to buy for all planned and in-progress builds. to_make: made parts (sub-assemblies, printed parts) the builds need beyond stock and the builds already planned for them, deepest first (make them first), rounded up to whole runs, with their machine time. suppliers: per purchased part, need − on hand − on order, rounded up to the preferred supplier's MOQ and pack size, grouped by supplier. Also lists make or kit parts that must be built but have no active assembly, and the machine time the builds need per machine type (what is to make counted in whole runs), with the number of machines in service.",
	rule: { scope: "purchasing:read" },
	input: z.object({}),
	run: async (_a, { db }) => {
		const s = await computeShortages(db);
		return {
			openBuilds: s.buildCount,
			toMake: s.toMake.map((l) => ({
				ref: l.part.ref,
				name: l.part.name,
				unit: l.part.unit,
				shortMilli: l.shortMilli,
				onHandMilli: l.onHandMilli,
				plannedMilli: l.plannedMilli,
				qtyMilli: l.toMakeMilli,
				runs: l.runs,
				assembly: `${l.assembly.code} ${l.assembly.revision}`,
				machineTime: l.machine ? { type: l.machine.machineType.name, minutesMilli: l.machine.minutesMilli } : undefined,
				builds: l.builds,
			})),
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
			missingAssemblies: s.missingAssemblies.map((m) => ({
				ref: m.ref,
				name: m.name,
				qtyMilli: m.qtyMilli,
				builds: m.builds,
			})),
			machineTime: s.machines.map((m) => ({
				type: m.machineType.name,
				minutesMilli: m.minutesMilli,
				activeMachines: m.activeMachines,
				builds: m.builds,
			})),
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
		const found = await poByNumber(db, a.number);
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

/** The read-only tools, in the order tools/list shows them. */
export const READ_TOOLS: readonly ToolSpec[] = [
	searchParts,
	getPartTool,
	getAssemblyTool,
	explodeAssembly,
	listMachinesTool,
	stockOnHand,
	listMovesTool,
	listBuildsTool,
	getBuildTool,
	getShortages,
	listPurchaseOrders,
	getPurchaseOrder,
];
