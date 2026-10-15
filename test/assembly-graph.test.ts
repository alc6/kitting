import { describe, expect, it } from "vitest";
import { loadGraph, whereUsed, wouldCreateCycle } from "../src/domain/assemblies";
import {
	AssemblyCycleError,
	buildGraph,
	CostCalculator,
	centsOf,
	defaultAssembly,
	explode,
	findCycle,
	type GraphPart,
	walkTree,
} from "../src/domain/assembly-graph";
import { onHandByKey } from "../src/domain/stock";
import { assemblyId, loadDemo, partId, testDb } from "./helpers";

const part = (id: number, ref: string, kind: GraphPart["kind"], costCents: number | null = 100): GraphPart => ({
	id,
	ref,
	name: ref,
	kind,
	unit: "pcs",
	costCents,
	trackSerial: false,
	archived: false,
	options: [],
});

const req = (e: ReturnType<typeof explode>) => Object.fromEntries(e.requirements.map((r) => [r.part.ref, r.qtyMilli]));

describe("explosion on the demo lamp", () => {
	it("explodes kits and sub-assemblies into leaf requirements", async () => {
		await loadDemo();
		const graph = await loadGraph(testDb());
		const e = explode(graph, await assemblyId("LAMP-DESK"), 1000);
		const r = req(e);
		expect(r["SCREW-M3X8"]).toBe(11_000); // 2 arms x 4 + fixing kit 3
		expect(r["WASHER-M3"]).toBe(3_000);
		expect(r["CABLE-2C"]).toBe(2_200); // base 1.5 m + 2 arms x 0.35 m
		expect(r["ARM-TUBE-300"]).toBe(2_000);
		expect(r["LED-5W-CW"]).toBe(1_000);
		expect(r.MANUAL).toBe(1_000);
		expect(r["HEAD-KIT-CW"]).toBeUndefined(); // phantom
		expect(r["FIX-KIT-HEAD"]).toBeUndefined(); // phantom inside a phantom
		expect(r["ARM-ASSY"]).toBeUndefined(); // no stock given: everything is built
		expect(e.fees.map((f) => [f.part.ref, f.qtyMilli])).toEqual([["FEE-WEEE", 1000]]);
		// Kit inside a kit: both levels explode, the leaves keep their cumulative quantities.
		const head = e.tree.find((n) => n.part.ref === "HEAD-KIT-CW")!;
		const fix = head.children.find((n) => n.part.ref === "FIX-KIT-HEAD")!;
		expect([head.mode, fix.mode, fix.depth]).toEqual(["kit", "kit", 1]);
		expect(fix.children.map((n) => [n.part.ref, n.qtyMilli])).toEqual([
			["SCREW-M3X8", 3000],
			["WASHER-M3", 3000],
		]);
		const arm = e.tree.find((n) => n.part.ref === "ARM-ASSY")!;
		expect(arm.perParentMilli).toBe(2000);
		const screw = arm.children.find((n) => n.part.ref === "SCREW-M3X8")!;
		expect([screw.perParentMilli, screw.qtyMilli]).toEqual([4000, 8000]); // x4, 8 total
	});

	it("scales with the build quantity and uses the variant asked for", async () => {
		await loadDemo();
		const graph = await loadGraph(testDb());
		const r = req(explode(graph, await assemblyId("LAMP-DESK", "warm"), 3000));
		expect(r["SCREW-M3X8"]).toBe(33_000);
		expect(r["LED-5W-WW"]).toBe(3_000);
		expect(r["LED-5W-CW"]).toBeUndefined();
	});

	it("takes make parts from stock up to on-hand, then explodes the rest", async () => {
		await loadDemo();
		const db = testDb();
		const [graph, stock] = await Promise.all([loadGraph(db), onHandByKey(db)]);
		const lamp = await assemblyId("LAMP-DESK");
		const one = explode(graph, lamp, 1000, { stock });
		expect(req(one)["ARM-ASSY"]).toBe(2000);
		expect(req(one)["ARM-TUBE-300"]).toBeUndefined();
		const three = explode(graph, lamp, 3000, { stock });
		expect(req(three)["ARM-ASSY"]).toBe(2000); // 2 in stock
		expect(req(three)["ARM-TUBE-300"]).toBe(4000); // 4 arms built
		const arm = three.tree.find((n) => n.part.ref === "ARM-ASSY")!;
		expect([arm.mode, arm.fromStockMilli, arm.toBuildMilli]).toEqual(["split", 2000, 4000]);
		expect(stock.get(String(await partId("ARM-ASSY")))).toBe(2000); // input map untouched
	});

	it("shares availability across several explosions", async () => {
		await loadDemo();
		const db = testDb();
		const [graph, stock] = await Promise.all([loadGraph(db), onHandByKey(db)]);
		const lamp = await assemblyId("LAMP-DESK");
		const available = new Map(stock);
		const first = explode(graph, lamp, 1000, { available });
		const second = explode(graph, lamp, 1000, { available });
		expect(req(first)["ARM-ASSY"]).toBe(2000);
		expect(req(second)["ARM-ASSY"]).toBeUndefined(); // the 2 arms in stock are already taken
		expect(req(second)["ARM-TUBE-300"]).toBe(2000);
		expect(available.get(String(await partId("ARM-ASSY")))).toBe(0);
	});

	it("honours per-line overrides", async () => {
		await loadDemo();
		const db = testDb();
		const [graph, stock] = await Promise.all([loadGraph(db), onHandByKey(db)]);
		const lamp = await assemblyId("LAMP-DESK");
		const base = explode(graph, lamp, 1000, { stock });
		const armPath = base.tree.find((n) => n.part.ref === "ARM-ASSY")!.path;
		const built = explode(graph, lamp, 1000, { stock, choices: new Map([[armPath, "build"]]) });
		expect(req(built)["ARM-ASSY"]).toBeUndefined();
		expect(req(built)["ARM-TUBE-300"]).toBe(2000);
		const forced = explode(graph, lamp, 5000, { stock, choices: new Map([[armPath, "stock"]]) });
		expect(req(forced)["ARM-ASSY"]).toBe(10_000); // beyond on-hand: shortage, not explosion
	});
});

describe("explosion edge cases", () => {
	it("shares stock across lines and flags make parts without assembly", () => {
		const g = buildGraph(
			[part(1, "TOP", "make"), part(2, "SUB", "make"), part(3, "NOASSEMBLY", "make"), part(4, "SCREW", "buy")],
			[
				{ id: 10, parentPartId: 1, code: "std", revision: "R1", status: "active" },
				{ id: 11, parentPartId: 2, code: "std", revision: "R1", status: "active" },
			],
			[
				{ id: 100, assemblyId: 10, componentPartId: 2, qtyMilli: 2000, position: 1, notes: "" },
				{ id: 101, assemblyId: 10, componentPartId: 2, qtyMilli: 1000, position: 2, notes: "" },
				{ id: 102, assemblyId: 10, componentPartId: 3, qtyMilli: 1000, position: 3, notes: "" },
				{ id: 110, assemblyId: 11, componentPartId: 4, qtyMilli: 1500, position: 1, notes: "" },
			],
		);
		const e = explode(g, 10, 1000, { stock: new Map([["2", 2500]]) });
		const nodes = [...walkTree(e.tree)];
		expect(nodes.filter((n) => n.part.ref === "SUB").map((n) => [n.fromStockMilli, n.toBuildMilli])).toEqual([
			[2000, 0],
			[500, 500],
		]);
		expect(req(e)).toEqual({ NOASSEMBLY: 1000, SCREW: 750, SUB: 2500 });
		expect(e.requirements.find((r) => r.part.ref === "NOASSEMBLY")?.missingAssembly).toBe(true);
		// Fractional quantities round up, never down.
		expect(req(explode(g, 11, 1))).toEqual({ SCREW: 2 });
	});

	it("picks the std variant, else the only active assembly, for sub-levels", () => {
		const g = buildGraph(
			[part(1, "A", "make")],
			[
				{ id: 5, parentPartId: 1, code: "x", revision: "R1", status: "active" },
				{ id: 6, parentPartId: 1, code: "std", revision: "R1", status: "active" },
				{ id: 7, parentPartId: 1, code: "std", revision: "R2", status: "draft" },
			],
			[],
		);
		expect(defaultAssembly(g, 1)?.id).toBe(6);
		g.assemblies.get(6)!.status = "archived";
		expect(defaultAssembly(g, 1)?.id).toBe(5);
	});

	it("refuses to walk a cycle", () => {
		const g = buildGraph(
			[part(1, "A", "make"), part(2, "B", "kit")],
			[
				{ id: 1, parentPartId: 1, code: "std", revision: "R1", status: "active" },
				{ id: 2, parentPartId: 2, code: "std", revision: "R1", status: "active" },
			],
			[
				{ id: 1, assemblyId: 1, componentPartId: 2, qtyMilli: 1000, position: 1, notes: "" },
				{ id: 2, assemblyId: 2, componentPartId: 1, qtyMilli: 1000, position: 1, notes: "" },
			],
		);
		expect(() => explode(g, 1, 1000)).toThrow(AssemblyCycleError);
		expect(findCycle(g)).toEqual(["A", "B", "A"]);
		g.assemblies.get(2)!.status = "archived";
		expect(findCycle(g)).toBeNull();
	});
});

describe("cost roll-up", () => {
	it("rolls up the demo lamp and flags missing costs", async () => {
		await loadDemo();
		const graph = await loadGraph(testDb());
		const calc = new CostCalculator(graph);
		const arm = calc.part(await partId("ARM-ASSY"));
		expect(arm).toEqual({ millicents: 453_750, incomplete: false, missing: [] }); // €4.5375
		expect(centsOf(arm.millicents)).toBe(454);
		const lamp = calc.assembly(await assemblyId("LAMP-DESK"));
		expect(centsOf(lamp.millicents)).toBe(3783); // €37.83 without the manual
		// Head kit cost rolls up through its nested fixing kit: 4.20 + 1.90 + 0.85 + 3 x 0.02 + 3 x 0.01
		expect(centsOf(calc.part(await partId("HEAD-KIT-CW")).millicents)).toBe(704);
		expect(lamp.incomplete).toBe(true);
		expect(lamp.missing).toEqual([await partId("MANUAL")]);
	});

	it("uses the standard cost of make parts without assembly and of buy/fee parts", () => {
		const g = buildGraph(
			[part(1, "TOP", "kit"), part(2, "SUB", "make", 250), part(3, "FEE", "fee", 25), part(4, "NOCOST", "make", null)],
			[{ id: 1, parentPartId: 1, code: "std", revision: "R1", status: "active" }],
			[
				{ id: 1, assemblyId: 1, componentPartId: 2, qtyMilli: 2000, position: 1, notes: "" },
				{ id: 2, assemblyId: 1, componentPartId: 3, qtyMilli: 1000, position: 2, notes: "" },
			],
		);
		const calc = new CostCalculator(g);
		expect(calc.part(1)).toEqual({ millicents: 525_000, incomplete: false, missing: [] });
		expect(calc.part(4).incomplete).toBe(true);
	});
});

describe("where-used and cycle check (recursive CTEs)", () => {
	it("lists direct and indirect uses, ignoring archived assemblies", async () => {
		await loadDemo();
		const rows = await whereUsed(testDb(), await partId("SCREW-M3X8"));
		const direct = rows.filter((r) => r.depth === 1).map((r) => r.parentRef);
		expect(direct.sort()).toEqual(["ARM-ASSY", "FIX-KIT-HEAD", "MINI-HEAD"]);
		const indirect = rows
			.filter((r) => r.depth === 2)
			.map((r) => `${r.parentRef}/${r.code}/${r.revision} via ${r.viaRef}`);
		expect(indirect.sort()).toEqual([
			"HEAD-KIT-CW/std/Rev1 via FIX-KIT-HEAD",
			"HEAD-KIT-WW/std/Rev1 via FIX-KIT-HEAD",
			"LAMP-DESK/std/Rev2 via ARM-ASSY",
			"LAMP-DESK/warm/Rev1 via ARM-ASSY",
			"LAMP-MINI/std/Rev1 via MINI-HEAD",
		]);
		const deepest = rows.filter((r) => r.depth === 3).map((r) => `${r.parentRef}/${r.code} via ${r.viaRef}`);
		expect(deepest.sort()).toEqual(["LAMP-DESK/std via HEAD-KIT-CW", "LAMP-DESK/warm via HEAD-KIT-WW"]);
	});

	it("detects cycles through draft and active assemblies", async () => {
		await loadDemo();
		const db = testDb();
		const lamp = await partId("LAMP-DESK");
		const arm = await partId("ARM-ASSY");
		expect(await wouldCreateCycle(db, arm, lamp)).toBe(true); // lamp contains arm
		expect(await wouldCreateCycle(db, await partId("HEAD-KIT-CW"), lamp)).toBe(true);
		expect(await wouldCreateCycle(db, arm, arm)).toBe(true);
		expect(await wouldCreateCycle(db, lamp, await partId("PAD-FELT"))).toBe(false);
		expect(await wouldCreateCycle(db, arm, await partId("BASE-ASSY"))).toBe(false);
	});
});
