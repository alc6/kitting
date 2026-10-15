import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { PartKind } from "../src/db/schema";
import { buildGraph, type GraphPart } from "../src/domain/assembly-graph";
import { runChangeSet } from "../src/domain/history";
import { planImport } from "../src/domain/import";
import {
	type Activation,
	activeRevisionAt,
	costInputs,
	plannedMarginSeries,
	type SaleRow,
	type StandardRow,
	salePriceAt,
	variantActivations,
} from "../src/domain/margin-history";
import {
	assemblyId,
	changeSql,
	importCsv,
	loadDemo,
	one,
	partId,
	postForm,
	request,
	rows,
	stmt,
	testDb,
} from "./helpers";

const part = (id: number, kind: PartKind, costCents: number | null): GraphPart => ({
	id,
	ref: `P${id}`,
	name: `Part ${id}`,
	kind,
	unit: "pcs",
	costCents,
	trackSerial: false,
	archived: false,
});

const PRODUCT = 100;
const STD = 1;

/** A product built from 10 different components, one of each. */
function tenComponents(costs: (number | null)[] = Array(10).fill(400)) {
	const components = costs.map((c, i) => part(i + 1, "buy", c));
	return buildGraph(
		[part(PRODUCT, "make", null), ...components],
		[{ id: STD, parentPartId: PRODUCT, code: "std", revision: "A", status: "active" }],
		components.map((c, i) => ({
			id: i + 1,
			assemblyId: STD,
			componentPartId: c.id,
			qtyMilli: 1000,
			position: i,
			notes: "",
		})),
	);
}

const standard = (partId: number, priceCents: number | null, validFrom: string): StandardRow => ({
	partId,
	priceCents,
	validFrom,
});

describe("planned margin history", () => {
	it("moves when one of ten components goes from 2.00 to 4.00", () => {
		// t1: ten components at 2.00 each, sold 50.00. t2: component 3 costs 4.00 (today's cost).
		const graph = tenComponents([200, 200, 400, 200, 200, 200, 200, 200, 200, 200]);
		const rows = [
			...Array.from({ length: 10 }, (_, i) => standard(i + 1, 200, "2026-01-05")),
			standard(3, 400, "2026-03-01"),
		].sort((a, b) => a.partId - b.partId || a.validFrom.localeCompare(b.validFrom));
		const sales: SaleRow[] = [{ assemblyId: null, priceCents: 5000, validFrom: "2026-01-05" }];
		const points = plannedMarginSeries(graph, { partId: PRODUCT, assemblyId: STD }, rows, sales, {
			part: 5000,
			assembly: null,
		});

		expect(points).toHaveLength(2);
		expect(points[0]).toMatchObject({
			date: "2026-01-05",
			costCents: 2000,
			priceCents: 5000,
			margin: { marginCents: 3000, rateBp: 6000, markupBp: 15000 },
			costChanges: [],
			priceChange: null,
			incomplete: false,
			fallback: false,
		});
		expect(points[1]).toMatchObject({
			date: "2026-03-01",
			costCents: 2200,
			priceCents: 5000,
			// 28.00 / 50.00 = 56 %; 28.00 / 22.00 = 127.27 %
			margin: { marginCents: 2800, rateBp: 5600, markupBp: 12727 },
			costChanges: [{ partId: 3, fromCents: 200, toCents: 400 }],
			priceChange: null,
		});
	});

	it("moves when the selling price changes, cost unchanged", () => {
		const graph = tenComponents(Array(10).fill(200));
		const rows = Array.from({ length: 10 }, (_, i) => standard(i + 1, 200, "2026-01-05"));
		const sales: SaleRow[] = [
			{ assemblyId: null, priceCents: 5000, validFrom: "2026-01-05" },
			{ assemblyId: null, priceCents: 4000, validFrom: "2026-06-01" },
		];
		const points = plannedMarginSeries(graph, { partId: PRODUCT, assemblyId: STD }, rows, sales, {
			part: 4000,
			assembly: null,
		});
		expect(points.map((p) => [p.date, p.costCents, p.priceCents, p.margin?.rateBp])).toEqual([
			["2026-01-05", 2000, 5000, 6000],
			["2026-06-01", 2000, 4000, 5000],
		]);
		expect(points[1]?.priceChange).toEqual({ fromCents: 5000, toCents: 4000 });
	});

	it("uses a variant's own price while it has one, and ignores the part's price meanwhile", () => {
		const graph = tenComponents(Array(10).fill(200));
		const rows = Array.from({ length: 10 }, (_, i) => standard(i + 1, 200, "2026-01-05"));
		const sales: SaleRow[] = [
			{ assemblyId: null, priceCents: 5000, validFrom: "2026-01-05" },
			{ assemblyId: STD, priceCents: 6000, validFrom: "2026-02-01" }, // the variant gets its own price
			{ assemblyId: null, priceCents: 5500, validFrom: "2026-03-01" }, // hidden by the variant's price
			{ assemblyId: STD, priceCents: null, validFrom: "2026-04-01" }, // own price cleared: back to the part's
		];
		const points = plannedMarginSeries(graph, { partId: PRODUCT, assemblyId: STD }, rows, sales, {
			part: 5500,
			assembly: null,
		});
		expect(points.map((p) => [p.date, p.priceCents])).toEqual([
			["2026-01-05", 5000],
			["2026-02-01", 6000],
			["2026-04-01", 5500],
		]);
	});

	it("flags an incomplete cost and costs taken from before the history started", () => {
		const graph = tenComponents([200, 200, 200, 200, 200, 200, 200, 200, 200, null]);
		// Component 10 has no cost; component 1's history only starts later (its first value is used).
		const rows = [
			standard(1, 300, "2026-05-01"),
			...Array.from({ length: 8 }, (_, i) => standard(i + 2, 200, "2026-01-05")),
		];
		rows.sort((a, b) => a.partId - b.partId || a.validFrom.localeCompare(b.validFrom));
		const points = plannedMarginSeries(graph, { partId: PRODUCT, assemblyId: STD }, rows, [], {
			part: 5000,
			assembly: null,
		});
		expect(points[0]).toMatchObject({ date: "2026-01-05", costCents: 1900, incomplete: true, fallback: true });
		expect(points[0]?.margin?.marginCents).toBe(3100);
		// On 2026-05-01 component 1 records 3.00, the value already used as its fallback: nothing moves.
		expect(points).toHaveLength(1);
	});

	it("rolls up sub-assemblies: their components count, not their own standard cost", () => {
		const graph = buildGraph(
			[part(PRODUCT, "make", null), part(10, "make", 999), part(11, "buy", 100), part(12, "fee", 50)],
			[
				{ id: STD, parentPartId: PRODUCT, code: "std", revision: "A", status: "active" },
				{ id: 2, parentPartId: 10, code: "std", revision: "A", status: "active" },
			],
			[
				{ id: 1, assemblyId: STD, componentPartId: 10, qtyMilli: 2000, position: 0, notes: "" },
				{ id: 2, assemblyId: STD, componentPartId: 12, qtyMilli: 1000, position: 1, notes: "" },
				{ id: 3, assemblyId: 2, componentPartId: 11, qtyMilli: 3000, position: 0, notes: "" },
			],
		);
		expect([...costInputs(graph, { partId: PRODUCT, assemblyId: STD })].sort()).toEqual([11, 12]);
		expect([...costInputs(graph, { partId: 11, assemblyId: null })]).toEqual([11]);
	});
});

describe("selling price on a day", () => {
	const rows: SaleRow[] = [
		{ assemblyId: null, priceCents: 8900, validFrom: "2026-02-01" },
		{ assemblyId: 7, priceCents: 9400, validFrom: "2026-03-01" },
	];

	it("has no price before the first recorded one", () => {
		expect(salePriceAt(rows, null, "2026-01-15", { part: 8900, assembly: null })).toBeNull();
		expect(salePriceAt(rows, 7, "2026-02-15", { part: 8900, assembly: 9400 })).toBe(8900);
		expect(salePriceAt(rows, 7, "2026-03-01", { part: 8900, assembly: 9400 })).toBe(9400);
	});

	it("uses the current price of a level without any history", () => {
		expect(salePriceAt([], 7, "2026-03-01", { part: 8900, assembly: null })).toBe(8900);
	});
});

describe("selling price across the revisions of a variant (D167)", () => {
	// STD is the revision whose history is shown; REV1 and REV2 are other revisions of the same variant.
	const REV1 = 7;
	const REV2 = 8;
	const sale = (assemblyId: number | null, validFrom: string, priceCents: number | null): SaleRow => ({
		assemblyId,
		priceCents,
		validFrom,
	});
	const at = (assemblyId: number, date: string): Activation => ({ assemblyId, date });

	/** Planned prices of STD, its part sold 89.00 since 2026-01-05, costs unchanged: [date, price] per point. */
	function prices(sales: SaleRow[], activations: Activation[]) {
		const graph = tenComponents(Array(10).fill(200));
		const rows = Array.from({ length: 10 }, (_, i) => standard(i + 1, 200, "2026-01-05"));
		const all = [sale(null, "2026-01-05", 8900), ...sales].sort((a, b) => a.validFrom.localeCompare(b.validFrom));
		const variant = { activations, salePrices: new Map<number, number | null>() };
		return plannedMarginSeries(
			graph,
			{ partId: PRODUCT, assemblyId: STD },
			rows,
			all,
			{ part: 8900, assembly: null },
			[],
			variant,
		).map((p) => [p.date, p.priceCents]);
	}

	it("shows no change on the day a new revision kept the variant's price", () => {
		// REV1 sells 94.00 from 2026-02-01; STD is created from it on 2026-05-01 with that price, activated 2026-05-10.
		const sales = [sale(REV1, "2026-02-01", 9400), sale(STD, "2026-05-01", 9400)];
		expect(prices(sales, [at(REV1, "2026-01-05"), at(STD, "2026-05-10")])).toEqual([
			["2026-01-05", 8900],
			["2026-02-01", 9400],
		]);
		// Without the change history, only its own rows count (D98): the part's price until it was created.
		expect(prices(sales, [])).toEqual([
			["2026-01-05", 8900],
			["2026-05-01", 9400],
		]);
		// Builds (actual points) are priced by their own revision, which has its row from the day it exists.
		expect(salePriceAt(sales, STD, "2026-05-01", { part: 8900, assembly: 9400 })).toBe(9400);
	});

	it("takes the price of the revision active each day, a draft's only from its activation", () => {
		const sales = [
			sale(REV1, "2026-01-05", 9400),
			sale(REV2, "2026-03-01", 9400), // REV2 created as a draft
			sale(REV2, "2026-03-10", 9900), // repriced while still a draft
			sale(REV1, "2026-03-15", 9600), // the active one repriced meanwhile
			sale(STD, "2026-04-01", 9900), // STD created from REV2
		];
		const activations = [at(REV1, "2026-01-05"), at(REV2, "2026-03-20"), at(STD, "2026-04-05")];
		expect(prices(sales, activations)).toEqual([
			["2026-01-05", 9400],
			["2026-03-15", 9600],
			["2026-03-20", 9900],
		]);
	});

	it("never takes the price of a draft that was never active", () => {
		const changes = [
			{ assemblyId: REV1, date: "2026-01-05", from: null, to: "active" },
			{ assemblyId: REV2, date: "2026-03-01", from: null, to: "draft" },
			{ assemblyId: REV2, date: "2026-03-10", from: "draft", to: "draft" },
			{ assemblyId: REV2, date: "2026-03-12", from: "draft", to: "archived" }, // abandoned
			{ assemblyId: STD, date: "2026-04-01", from: null, to: "draft" },
			{ assemblyId: REV1, date: "2026-04-05", from: "active", to: "archived" },
			{ assemblyId: STD, date: "2026-04-05", from: "draft", to: "active" },
		];
		const revisions = [
			{ id: REV1, status: "archived" as const },
			{ id: REV2, status: "archived" as const },
			{ id: STD, status: "active" as const },
		];
		const activations = variantActivations(revisions, changes);
		expect(activations).toEqual([at(REV1, "2026-01-05"), at(STD, "2026-04-05")]);
		const sales = [
			sale(REV1, "2026-01-05", 9400),
			sale(REV2, "2026-03-01", 9400),
			sale(REV2, "2026-03-10", 9900),
			sale(STD, "2026-04-01", 9400),
		];
		expect(prices(sales, activations)).toEqual([["2026-01-05", 9400]]);
	});

	it("follows an older revision activated again", () => {
		const sales = [sale(REV1, "2026-01-05", 9400), sale(REV2, "2026-01-20", 9900), sale(STD, "2026-04-01", 9400)];
		const activations = [at(REV1, "2026-01-05"), at(REV2, "2026-02-01"), at(REV1, "2026-03-01"), at(STD, "2026-04-05")];
		expect(prices(sales, activations)).toEqual([
			["2026-01-05", 9400],
			["2026-02-01", 9900],
			["2026-03-01", 9400],
		]);
	});

	it("shows the part's price while an active revision had no price of its own", () => {
		// STD was created without a price (before D166) and activated on 2026-02-10; priced on 2026-03-01.
		const sales = [sale(REV1, "2026-01-05", 9400), sale(STD, "2026-03-01", 9400)];
		expect(prices(sales, [at(REV1, "2026-01-05"), at(STD, "2026-02-10")])).toEqual([
			["2026-01-05", 9400],
			["2026-02-10", 8900],
			["2026-03-01", 9400],
		]);
	});

	it("goes back to the part's price, not an earlier revision's, once its own price is cleared", () => {
		const sales = [sale(REV1, "2026-01-05", 9400), sale(STD, "2026-03-01", 9400), sale(STD, "2026-04-01", null)];
		expect(prices(sales, [at(REV1, "2026-01-05"), at(STD, "2026-03-05")])).toEqual([
			["2026-01-05", 9400],
			["2026-04-01", 8900],
		]);
	});

	it("counts revisions older than the change history as active before it, drafts never", () => {
		const revisions = [
			{ id: 2, status: "archived" as const }, // active when the history started, archived since
			{ id: 4, status: "archived" as const },
			{ id: 3, status: "archived" as const },
			{ id: 5, status: "draft" as const },
			{ id: 6, status: "archived" as const },
			{ id: 7, status: "archived" as const }, // a draft when the history started, archived since
			{ id: 9, status: "active" as const },
		];
		const changes = [
			{ assemblyId: 6, date: "2026-05-01", from: null, to: "draft" },
			{ assemblyId: 6, date: "2026-05-02", from: "draft", to: "archived" },
			{ assemblyId: 7, date: "2026-05-03", from: "draft", to: "archived" },
			{ assemblyId: 2, date: "2026-06-01", from: "active", to: "archived" },
			{ assemblyId: 9, date: "2026-06-01", from: "draft", to: "active" },
			{ assemblyId: 9, date: "2026-06-02", from: "active", to: "active" }, // an edit, not an activation
		];
		const activations = variantActivations(revisions, changes);
		expect(activations).toEqual([at(3, ""), at(4, ""), at(2, ""), at(9, "2026-06-01")]);
		expect(activeRevisionAt(activations, "2026-01-01")).toBe(2);
		expect(activeRevisionAt(activations, "2026-06-01")).toBe(9);
		// Before the first activation, the first revision activated; nothing known, none.
		expect(activeRevisionAt([at(9, "2026-06-01")], "2026-01-01")).toBe(9);
		expect(activeRevisionAt([], "2026-01-01")).toBeNull();
	});
});

describe("margin history page", () => {
	/** KIT-10 is built from C01…C10 at 2.00 and sold 50.00 since 2026-01-05; C03 costs 4.00 since 2026-03-01. */
	async function tenComponentProduct() {
		const parts = ["ref,name,kind,unit,cost,sale_price"];
		parts.push("KIT-10,Ten-part product,make,pcs,,50.00");
		const lines = ["parent_ref,code,revision,status,component_ref,qty"];
		for (let i = 1; i <= 10; i++) {
			const ref = `C${String(i).padStart(2, "0")}`;
			parts.push(`${ref},Component ${i},buy,pcs,2.00,`);
			lines.push(`KIT-10,std,A,active,${ref},1`);
		}
		await importCsv("parts", parts.join("\n"));
		await importCsv("assemblies", lines.join("\n"));
		// The imports dated their history today: move it back to t1, then record the t2 increase.
		await env.DB.prepare("UPDATE price_history SET valid_from = '2026-01-05'").run();
		const c03 = await partId("C03");
		await changeSql(
			"Raise C03",
			stmt("UPDATE parts SET cost_cents = 400 WHERE id = ?", c03),
			stmt(
				`INSERT INTO price_history (part_id, kind, price_cents, valid_from, source, created_by, updated_by)
				 VALUES (?, 'standard', 400, '2026-03-01', 'form', 'seed', 'seed')`,
				c03,
			),
		);
		return { product: await partId("KIT-10"), assembly: await assemblyId("KIT-10"), c03 };
	}

	it("shows each change of the planned margin, with what moved it", async () => {
		const { assembly, c03 } = await tenComponentProduct();
		const res = await request(`/margins/assemblies/${assembly}`);
		expect(res.status).toBe(200);
		const page = await res.text();
		expect(page).not.toMatch(/\sstyle=/);
		expect(page).toContain("Margin history: KIT-10 · std A");
		// The chart, then the two points newest first: 56 % since C03 went 2.00 → 4.00, 60 % before.
		expect(page).toMatch(/<svg[^>]*role="img"[^>]*aria-labelledby="margin-chart-title"/);
		const table = page.slice(page.indexOf("Planned margin changes"));
		const newest = table.indexOf("2026-03-01");
		const oldest = table.indexOf("2026-01-05");
		expect(newest).toBeGreaterThan(-1);
		expect(oldest).toBeGreaterThan(newest);
		const t2 = table.slice(newest, oldest);
		expect(t2).toContain(`href="/parts/${c03}"`);
		for (const v of ["€2.00", "€4.00", "€22.00", "€50.00", "€28.00", "56.0 %", "127.3 %"]) expect(t2).toContain(v);
		const t1 = table.slice(oldest, table.indexOf("</tbody>"));
		for (const v of ["Start of the price history", "€20.00", "€30.00", "60.0 %", "150.0 %"]) expect(t1).toContain(v);
		// Planned rate now, and its change since the first point.
		expect(page).toMatch(/Change since 2026-01-05<\/span>[\s\S]*?−4\.0 pts/);
	});

	it("is linked from the margins page, and speaks French", async () => {
		const { assembly } = await tenComponentProduct();
		expect(await (await request("/margins")).text()).toContain(`href="/margins/assemblies/${assembly}"`);
		const fr = await (
			await request(`/margins/assemblies/${assembly}`, { headers: { Cookie: "kitting_lang=fr" } })
		).text();
		expect(fr).toContain("Historique de marge: KIT-10");
		expect(fr).toContain("56,0 %");
		expect(fr).toMatch(/−4,0 pts/);
	});

	it("lists completed builds at their actual cost against the price of the day", async () => {
		await loadDemo();
		const lamp = await partId("LAMP-DESK");
		const std = await assemblyId("LAMP-DESK");
		await completeLampBuild();
		const page = await (await request(`/margins/assemblies/${std}`)).text();
		const builds = page.slice(page.indexOf("Completed builds</h2>"));
		expect(builds).toMatch(/href="\/builds\/\d+"[^>]*>B-0001<\/a>/);
		expect(builds).toContain("€89.00");
		// A product sold without assembly has a history too; unknown ids are 404.
		expect((await request(`/margins/parts/${lamp}`)).status).toBe(200);
		expect((await request("/margins/assemblies/999999")).status).toBe(404);
		expect((await request("/margins/parts/999999")).status).toBe(404);
	});

	it("follows the variant's price across a new revision, with no change the day it was created (D167)", async () => {
		await loadDemo({ stock: false });
		// LAMP-DESK warm Rev1 sells 94.00, the part 89.00. The import dated them today: move them back.
		await env.DB.prepare("UPDATE price_history SET valid_from = '2026-01-05'").run();
		const rev1 = await assemblyId("LAMP-DESK", "warm");
		expect((await postForm(`/assemblies/${rev1}/revision`, {})).status).toBe(303);
		const rev2 = await assemblyId("LAMP-DESK", "warm", "Rev2");
		expect((await postForm(`/assemblies/${rev2}/activate`, {})).status).toBe(303);

		const page = await (await request(`/margins/assemblies/${rev2}`)).text();
		const table = page.slice(page.indexOf("Planned margin changes"));
		const rowsOf = table.slice(0, table.indexOf("</tbody>"));
		expect(rowsOf).toContain("2026-01-05");
		expect(rowsOf).toContain("€94.00");
		expect(rowsOf).not.toContain("€89.00");
		expect(rowsOf).not.toContain(new Date().toISOString().slice(0, 10));
	});
});

/** Plans and completes one LAMP-DESK std build (serial-tracked product and components). */
async function completeLampBuild(): Promise<number> {
	const res = await postForm("/builds", {
		part_id: String(await partId("LAMP-DESK")),
		assembly_id: String(await assemblyId("LAMP-DESK")),
		qty: "1",
		serial: "L-1",
		planned_for: "",
		notes: "",
	});
	const id = Number(/\/builds\/(\d+)/.exec(res.headers.get("Location") ?? "")?.[1]);
	const pick = await (await request(`/builds/${id}`)).text();
	const fields: Record<string, string> = {};
	for (const m of pick.matchAll(/name="(serial:\d+:\d+)"/g)) fields[m[1] as string] = `S-${m[1]}`;
	expect((await postForm(`/builds/${id}/complete`, fields)).status).toBe(303);
	return id;
}

describe("a supplier price that becomes the standard cost (D99)", () => {
	/** KIT-10 from ten components at 2.00, sold 50.00; C03 is bought from Acme Example at 2.00. */
	async function setup() {
		const parts = ["ref,name,kind,unit,cost,sale_price", "KIT-10,Ten-part product,make,pcs,,50.00"];
		const lines = ["parent_ref,code,revision,status,component_ref,qty"];
		for (let i = 1; i <= 10; i++) {
			const ref = `C${String(i).padStart(2, "0")}`;
			parts.push(`${ref},Component ${i},buy,pcs,2.00,`);
			lines.push(`KIT-10,std,A,active,${ref},1`);
		}
		await importCsv("suppliers", "name\nAcme Example\nOther Example");
		await importCsv("parts", parts.join("\n"));
		await importCsv("assemblies", lines.join("\n"));
		await importCsv("part_suppliers", "ref,supplier,price,preferred\nC03,Acme Example,2.00,yes");
		await env.DB.prepare("UPDATE price_history SET valid_from = '2026-01-05'").run();
		const supplier = await one<{ id: number }>("SELECT id FROM suppliers WHERE name = 'Acme Example'");
		return { c03: await partId("C03"), assembly: await assemblyId("KIT-10"), supplier: supplier.id };
	}

	const offerForm = (over: Record<string, string> = {}) => ({
		supplier_ref: "",
		price: "4.00",
		moq: "",
		pack_size: "",
		lead_days: "",
		notes: "",
		...over,
	});

	it("updates the standard cost from the offer form when asked, and the margin history follows", async () => {
		const { c03, assembly, supplier } = await setup();
		// Unticked: the offer price changes, the standard cost does not.
		expect((await postForm(`/parts/${c03}/offers/${supplier}`, offerForm({ price: "3.00" }))).status).toBe(303);
		expect(await one("SELECT cost_cents FROM parts WHERE id = ?", c03)).toEqual({ cost_cents: 200 });
		// Ticked: both, with a standard history row noting where it came from.
		const res = await postForm(`/parts/${c03}/offers/${supplier}`, offerForm({ set_standard_cost: "on" }));
		expect(res.status).toBe(303);
		expect(await one("SELECT cost_cents FROM parts WHERE id = ?", c03)).toEqual({ cost_cents: 400 });
		expect(
			await rows(
				"SELECT price_cents, note FROM price_history WHERE part_id = ? AND kind = 'standard' ORDER BY id",
				c03,
			),
		).toEqual([
			{ price_cents: 200, note: "" },
			{ price_cents: 400, note: "From the offer of Acme Example" },
		]);
		const page = await (await request(`/margins/assemblies/${assembly}`)).text();
		const today = new Date().toISOString().slice(0, 10);
		const t2 = page.slice(page.indexOf(today, page.indexOf("Planned margin changes")));
		for (const v of ["€2.00", "€4.00", "€22.00", "56.0 %"]) expect(t2).toContain(v);
	});

	it("refuses to use an empty price as the standard cost", async () => {
		const { c03, supplier } = await setup();
		const res = await postForm(`/parts/${c03}/offers/${supplier}`, offerForm({ price: "", set_standard_cost: "on" }));
		expect(res.status).toBe(422);
		expect(await res.text()).toContain("Enter a price to use it as the standard cost.");
		expect(await one("SELECT cost_cents FROM parts WHERE id = ?", c03)).toEqual({ cost_cents: 200 });
	});

	it("does the same from part_suppliers.csv, once per part", async () => {
		const { c03 } = await setup();
		const db = testDb();
		const twice = await planImport(
			{ db, locale: "en" },
			"part_suppliers",
			"ref,supplier,price,set_standard_cost\nC03,Acme Example,4.00,yes\nC03,Other Example,4.50,yes\nC04,Acme Example,,yes",
		);
		expect(twice?.errors.map((e) => [e.line, e.key])).toEqual([
			[3, "standard_twice"],
			[4, "standard_needs_price"],
		]);
		const plan = await planImport(
			{ db, locale: "en" },
			"part_suppliers",
			"ref,supplier,price,set_standard_cost\nC03,Acme Example,4.00,yes",
		);
		expect(plan?.errors).toEqual([]);
		expect(plan?.rows[0]?.changes).toEqual(["price: 2.00 → 4.00", "standard cost: 2.00 → 4.00"]);
		const meta = { user: "seed@example.com", source: "import" as const, summary: "Import part_suppliers.csv" };
		await runChangeSet(db, meta, plan?.statements("seed@example.com", new Date().toISOString()) ?? []);
		expect(await one("SELECT cost_cents FROM parts WHERE id = ?", c03)).toEqual({ cost_cents: 400 });
		expect(
			await one("SELECT source, note FROM price_history WHERE part_id = ? AND kind = 'standard' ORDER BY id DESC", c03),
		).toEqual({ source: "import", note: "From the offer of Acme Example" });
	});
});
