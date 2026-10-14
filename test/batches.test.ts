// Batch recipes (D145, D146): an assembly makes N units, its lines are the quantities for the whole batch.
import { describe, expect, it } from "vitest";
import { loadGraph } from "../src/domain/assemblies";
import { buildGraph, CostCalculator, explode, type GraphPart, lineNeed } from "../src/domain/assembly-graph";
import { planImport } from "../src/domain/import";
import { computeShortages } from "../src/domain/purchasing";
import { mulDivCeil } from "../src/lib/units";
import { assemblyId, importCsv, one, partId, postForm, request, rows, testDb } from "./helpers";

const part = (id: number, ref: string, kind: GraphPart["kind"], costCents: number | null, opts = {}): GraphPart => ({
	id,
	ref,
	name: ref,
	kind,
	unit: "pcs",
	costCents,
	trackSerial: false,
	archived: false,
	...opts,
});

/** A print plate: 24 spacers from 260 g of filament; a kit of 4 spacers; a lamp with one tracked LED per 24. */
function printGraph() {
	return buildGraph(
		[
			part(1, "PLA-BLACK", "buy", 2000, { unit: "kg" }),
			part(2, "SPACER-10", "make", null),
			part(3, "SPACER-KIT", "kit", null),
			part(4, "LED", "buy", 300, { trackSerial: true }),
			part(5, "PANEL", "make", null),
		],
		[
			{ id: 10, parentPartId: 2, code: "std", revision: "R1", status: "active", batchMilli: 24_000 },
			{ id: 11, parentPartId: 3, code: "std", revision: "R1", status: "active" },
			{ id: 12, parentPartId: 5, code: "std", revision: "R1", status: "active", batchMilli: 24_000 },
		],
		[
			{ id: 100, assemblyId: 10, componentPartId: 1, qtyMilli: 260, position: 1, notes: "" },
			{ id: 110, assemblyId: 11, componentPartId: 2, qtyMilli: 4000, position: 1, notes: "" },
			{ id: 120, assemblyId: 12, componentPartId: 4, qtyMilli: 1000, position: 1, notes: "" },
		],
	);
}

const need = (e: ReturnType<typeof explode>, ref: string) => e.requirements.find((r) => r.part.ref === ref)?.qtyMilli;

describe("batch arithmetic", () => {
	it("divides each line by the batch and rounds up to the thousandth", () => {
		const g = printGraph();
		// 260 g / 24 = 10.833 g per spacer.
		expect(need(explode(g, 10, 1000), "PLA-BLACK")).toBe(11);
		expect(need(explode(g, 10, 24_000), "PLA-BLACK")).toBe(260);
		expect(need(explode(g, 10, 25_000), "PLA-BLACK")).toBe(271);
		expect(need(explode(g, 10, 48_000), "PLA-BLACK")).toBe(520);
		// A kit of 4 spacers: 6 kits = 24 spacers = one plate.
		const kits = explode(g, 11, 6000);
		expect(need(kits, "PLA-BLACK")).toBe(260);
		const spacer = kits.tree[0]!;
		expect([spacer.qtyMilli, spacer.children[0]?.perParentMilli, spacer.children[0]?.parentBatchMilli]).toEqual([
			24_000, 260, 24_000,
		]);
		// A serial-tracked component is consumed in whole units, never 0.042 of a serial.
		expect(need(explode(g, 12, 1000), "LED")).toBe(1000);
		expect(need(explode(g, 12, 25_000), "LED")).toBe(2000);
		expect(lineNeed({ qtyMilli: 1000 }, 1000, 24_000, { trackSerial: false })).toBe(42);
		// Exact for large values (BigInt), and the same as before for a batch of one.
		expect(mulDivCeil(9_000_000_000, 3_000_000, 7)).toBe(3_857_142_857_142_858);
		expect(lineNeed({ qtyMilli: 1500 }, 1, 1000, { trackSerial: false })).toBe(2);
	});

	it("rolls the batch cost up per unit", () => {
		const calc = new CostCalculator(printGraph());
		// 0.26 kg × 20.00 = 5.20 per plate; 5.20 / 24 = 0.21667 per spacer.
		expect(calc.batch(10).millicents).toBe(520_000);
		expect(calc.assembly(10).millicents).toBe(21_667);
		expect(calc.part(2).millicents).toBe(21_667);
		// The kit's 4 spacers.
		expect(calc.part(3).millicents).toBe(86_668);
	});
});

const PARTS = `ref,name,kind,unit,cost
PLA-BLACK,PLA filament black,buy,kg,20.00
SPACER-10,Printed spacer 10 mm,make,pcs,
SPACER-KIT,Four spacers,kit,pcs,
`;

async function seedPrint(status = "active") {
	await importCsv("parts", PARTS);
	await importCsv(
		"assemblies",
		`parent_ref,code,revision,status,batch_qty,component_ref,qty
SPACER-10,std,Rev1,${status},24,PLA-BLACK,0.26
SPACER-KIT,std,Rev1,active,,SPACER-10,4
`,
	);
}

async function plan(qty: string, qtyIn: "units" | "batches" = "units") {
	const res = await postForm("/builds", {
		part_id: String(await partId("SPACER-10")),
		assembly_id: String(await assemblyId("SPACER-10")),
		qty,
		qty_in: qtyIn,
		serial: "",
		planned_for: "",
		notes: "",
	});
	expect(res.status, await res.clone().text()).toBe(303);
	return Number(/\/builds\/(\d+)/.exec(res.headers.get("Location") ?? "")?.[1]);
}

describe("batch recipes in the app", () => {
	it("sets the batch with the lines, never on an archived assembly, and carries it into new revisions and variants", async () => {
		await seedPrint("draft");
		const id = await assemblyId("SPACER-10", "std", "Rev1");
		const draft = await request(`/assemblies/${id}`);
		const html = await draft.text();
		expect(html).toContain(`action="/assemblies/${id}/production"`);
		expect(html).toContain("Batch cost (24 pcs)");
		expect(html).toContain("€5.20");
		// Invalid, then saved.
		expect((await postForm(`/assemblies/${id}/production`, { batch_qty: "0" })).status).toBe(422);
		expect((await postForm(`/assemblies/${id}/production`, { batch_qty: "12" })).status).toBe(303);
		expect(await one("SELECT batch_qty_milli FROM assemblies WHERE id = ?", id)).toEqual({ batch_qty_milli: 12_000 });
		expect(
			await one("SELECT summary FROM change_sets ORDER BY id DESC LIMIT 1"),
			"a change set names the assembly",
		).toEqual({ summary: "Edit the production of assembly SPACER-10 std Rev1" });
		// Active: editable like its lines (D153).
		await postForm(`/assemblies/${id}/activate`, {});
		const active = await (await request(`/assemblies/${id}`)).text();
		expect(active).toContain(`action="/assemblies/${id}/production"`);
		expect((await postForm(`/assemblies/${id}/production`, { batch_qty: "6" })).status).toBe(303);
		expect(await one("SELECT batch_qty_milli FROM assemblies WHERE id = ?", id)).toEqual({ batch_qty_milli: 6_000 });
		expect((await postForm(`/assemblies/${id}/production`, { batch_qty: "12" })).status).toBe(303);
		await postForm(`/assemblies/${id}/revision`, {});
		await postForm("/assemblies", {
			parent_part_id: String(await partId("SPACER-10")),
			code: "big",
			revision: "Rev1",
			notes: "",
			copy_from: String(id),
		});
		expect(
			await rows(
				`SELECT b.code, b.revision, b.status, b.batch_qty_milli FROM assemblies b JOIN parts p ON p.id = b.parent_part_id
				 WHERE p.ref = 'SPACER-10' ORDER BY b.id`,
			),
		).toEqual([
			{ code: "std", revision: "Rev1", status: "active", batch_qty_milli: 12_000 },
			{ code: "std", revision: "Rev2", status: "draft", batch_qty_milli: 12_000 },
			{ code: "big", revision: "Rev1", status: "draft", batch_qty_milli: 12_000 },
		]);
	});

	it("plans builds in units or batches, picks and completes per batch", async () => {
		await seedPrint();
		await importCsv("stock", "ref,qty\nPLA-BLACK,1\n");
		// 2 plates = 48 spacers.
		const big = await plan("2", "batches");
		expect(await one("SELECT qty_milli FROM builds WHERE id = ?", big)).toEqual({ qty_milli: 48_000 });
		const page = await (await request(`/builds/${big}`)).text();
		expect(page).toContain("2 batch(es)");
		expect(page).toContain("0.52");
		// One spacer takes 11 g (10.833 rounded up).
		const one1 = await plan("1");
		const done = await postForm(`/builds/${one1}/complete`, {});
		expect(done.status).toBe(303);
		expect(
			await rows("SELECT reason, qty_milli, unit_cost_cents FROM stock_moves WHERE ref_id = ? ORDER BY id", one1),
		).toEqual([
			{ reason: "build_consume", qty_milli: -11, unit_cost_cents: 2000 },
			{ reason: "build_output", qty_milli: 1000, unit_cost_cents: 22 },
		]);
		// 48 spacers consume 520 g; their unit cost is 10.40 / 48.
		expect((await postForm(`/builds/${big}/complete`, {})).status).toBe(303);
		expect(
			await rows("SELECT reason, qty_milli, unit_cost_cents FROM stock_moves WHERE ref_id = ? ORDER BY id", big),
		).toEqual([
			{ reason: "build_consume", qty_milli: -520, unit_cost_cents: 2000 },
			{ reason: "build_output", qty_milli: 48_000, unit_cost_cents: 22 },
		]);
	});

	it("nets batch needs in the shortages and shows the batch where the filament is used", async () => {
		await seedPrint();
		await importCsv("stock", "ref,qty\nPLA-BLACK,0.2\n");
		// 3 builds of 10 spacers: 108.333 → 109 g each.
		for (let i = 0; i < 3; i++) await plan("10");
		const s = await computeShortages(testDb());
		const pla = s.groups.flatMap((g) => g.lines).find((l) => l.part.ref === "PLA-BLACK");
		expect([pla?.needMilli, pla?.onHandMilli, pla?.netMilli]).toEqual([327, 200, 127]);
		const used = await (await request(`/parts/${await partId("PLA-BLACK")}`)).text();
		expect(used).toMatch(/0\.26[\s\S]{0,300}\/ [\s\S]{0,60}>24</);
		// The tree defaults to one batch: the slicer's figures.
		const tree = await (await request(`/assemblies/${await assemblyId("SPACER-10")}/tree`)).text();
		expect(tree).toContain('value="24"');
	});
});

describe("assemblies.csv batch_qty", () => {
	it("imports and exports the batch, one value per assembly", async () => {
		await seedPrint();
		const graph = await loadGraph(testDb());
		expect(graph.assemblies.get(await assemblyId("SPACER-10"))?.batchMilli).toBe(24_000);
		expect(graph.assemblies.get(await assemblyId("SPACER-KIT"))?.batchMilli).toBe(1000);
		const res = await request("/import/assemblies/export.csv");
		const csv = await res.text();
		expect(csv).toContain(
			"parent_ref,code,revision,status,sale_price,batch_qty,machine,machine_minutes,component_ref,qty,notes",
		);
		expect(csv).toContain("SPACER-10,std,Rev1,active,,24,,,PLA-BLACK,0.26,");
		// Without the column, the batch is kept.
		await importCsv(
			"assemblies",
			"parent_ref,code,revision,status,component_ref,qty\nSPACER-10,std,Rev1,active,PLA-BLACK,0.25\n",
		);
		expect(await one("SELECT batch_qty_milli FROM assemblies WHERE id = ?", await assemblyId("SPACER-10"))).toEqual({
			batch_qty_milli: 24_000,
		});
	});

	it("refuses two batches for one assembly, and changes the batch of an active one like its lines", async () => {
		await seedPrint();
		const db = testDb();
		const mixed = await planImport(
			{ db, locale: "en" },
			"assemblies",
			"parent_ref,code,revision,status,batch_qty,component_ref,qty\nNEW-PART,std,Rev1,draft,24,PLA-BLACK,0.26\nSPACER-KIT,std,Rev9,draft,1,SPACER-10,1\nSPACER-KIT,std,Rev9,draft,2,SPACER-10,1\n",
		);
		expect(mixed?.errors.map((e) => e.key)).toEqual(["unknown_part", "assembly_batch_mixed"]);
		const active = await planImport(
			{ db, locale: "en" },
			"assemblies",
			"parent_ref,code,revision,status,batch_qty,component_ref,qty\nSPACER-10,std,Rev1,active,12,PLA-BLACK,0.13\nSPACER-10,std,Rev2,draft,12,PLA-BLACK,0.13\n",
		);
		expect(active?.errors).toEqual([]);
		// A new revision may have its own batch.
		expect(active?.rows.map((r) => [r.cells[2], r.action])).toEqual([
			["Rev1", "update"],
			["Rev2", "create"],
		]);
	});
});
