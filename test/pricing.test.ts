import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { buildActualCost, marginOf, marginReport } from "../src/domain/margins";
import { computeShortages, planDraftOrders } from "../src/domain/purchasing";
import { valuation } from "../src/domain/stock";
import {
	assemblyId,
	DEMO,
	importCsv,
	insertMove,
	insertPart,
	insertSupplier,
	loadDemo,
	one,
	partId,
	postForm,
	request,
	rows,
	testDb,
} from "./helpers";

const supplierId = async (name: string) =>
	(await one<{ id: number }>("SELECT id FROM suppliers WHERE name = ?", name)).id;

async function preview(type: string, csv: string) {
	const form = new FormData();
	form.set("csv", csv);
	return request(`/import/${type}/preview`, { method: "POST", body: form });
}

const partForm = (over: Record<string, string> = {}) => ({
	ref: "LED-5W",
	name: "LED",
	kind: "buy",
	unit: "pcs",
	cost: "3.25",
	sale_price: "",
	supplier_id: "",
	supplier_ref: "",
	moq: "",
	pack_size: "",
	lead_days: "",
	notes: "",
	...over,
});

describe("price history", () => {
	it("logs every change of standard cost and selling price from the part form, and nothing else", async () => {
		await postForm("/parts", partForm());
		const id = await partId("LED-5W");
		await postForm(`/parts/${id}`, partForm({ cost: "3.40", sale_price: "9.90" }));
		await postForm(`/parts/${id}`, partForm({ cost: "3.40", sale_price: "9.90", name: "LED module" }));
		expect(await rows("SELECT kind, price_cents, source FROM price_history ORDER BY id")).toEqual([
			{ kind: "standard", price_cents: 325, source: "form" },
			{ kind: "standard", price_cents: 340, source: "form" },
			{ kind: "sale", price_cents: 990, source: "form" },
		]);
	});

	it("keeps the offer's price when the part form changes its terms, and starts a new offer for a new supplier", async () => {
		const acme = await insertSupplier("Acme");
		const other = await insertSupplier("Other");
		await postForm("/parts", partForm({ supplier_id: String(acme), moq: "10" }));
		const id = await partId("LED-5W");
		await importCsv("part_suppliers", "ref,supplier,price\nLED-5W,Acme,2.95\n");
		await postForm(`/parts/${id}`, partForm({ supplier_id: String(acme), moq: "20" }));
		expect(await one("SELECT price_cents, moq_milli FROM part_suppliers WHERE supplier_id = ?", acme)).toEqual({
			price_cents: 295,
			moq_milli: 20_000,
		});
		await postForm(`/parts/${id}`, partForm({ supplier_id: String(other), moq: "5" }));
		expect(await one("SELECT supplier_id FROM parts WHERE id = ?", id)).toEqual({ supplier_id: other });
		expect(await rows("SELECT supplier_id, moq_milli FROM part_suppliers ORDER BY supplier_id")).toEqual([
			{ supplier_id: acme, moq_milli: 20_000 },
			{ supplier_id: other, moq_milli: 5000 },
		]);
	});
});

describe("supplier offers import", () => {
	it("creates and updates offers, switches the preferred supplier and logs price changes", async () => {
		await loadDemo({ stock: false });
		const quick = await supplierId("Quickparts Express");
		const html = await (
			await preview("part_suppliers", "ref,supplier,price,preferred\nDRV-12V,Quickparts Express,7.50,yes\n")
		).text();
		expect(html).toContain("price: 7.90 → 7.50");
		expect(html).toContain("preferred: no → yes");
		await importCsv("part_suppliers", "ref,supplier,price,preferred\nDRV-12V,Quickparts Express,7.50,yes\n");
		expect(await one("SELECT supplier_id FROM parts WHERE ref = 'DRV-12V'")).toEqual({ supplier_id: quick });
		expect(
			await rows(
				"SELECT h.price_cents, h.source FROM price_history h JOIN parts p ON p.id = h.part_id WHERE p.ref = 'DRV-12V' AND h.kind = 'purchase' AND h.supplier_id = ? ORDER BY h.id",
				quick,
			),
		).toEqual([
			{ price_cents: 790, source: "import" },
			{ price_cents: 750, source: "import" },
		]);
	});

	it("rejects unknown parts and suppliers, kits and duplicates", async () => {
		await loadDemo({ stock: false });
		const csv =
			"ref,supplier\nNOPE,Lumen Parts Co\nDRV-12V,Nobody\nHEAD-KIT-CW,Lumen Parts Co\nDRV-12V,Quickparts Express\nDRV-12V,Quickparts Express\n";
		const html = await (await preview("part_suppliers", csv)).text();
		expect(html).toContain("Unknown part reference “NOPE”.");
		expect(html).toContain("Unknown supplier “Nobody”");
		expect(html).toContain("Duplicate of line 5.");
		expect(html).toContain("4 error(s)");
	});

	it("round-trips through export", async () => {
		await loadDemo({ stock: false });
		const exported = await (await request("/import/part_suppliers/export.csv")).text();
		expect(exported).toContain("DRV-12V,Lumen Parts Co,DRV-700-12,6.60,5,,21,yes,Price list 2026");
		expect(await (await preview("part_suppliers", exported)).text()).toContain(
			"0 to create, 0 to update, 23 unchanged.",
		);
	});
});

describe("ordering from several suppliers", () => {
	it("rounds and prices shortages with the preferred offer", async () => {
		await loadDemo();
		// One lamp needs one driver; 5 in stock: plan 6 lamps → 1 short, rounded to the MOQ of 5 at 6.60.
		for (let i = 1; i <= 6; i++) {
			await postForm("/builds", {
				part_id: String(await partId("LAMP-DESK")),
				assembly_id: String(await assemblyId("LAMP-DESK")),
				qty: "1",
				serial: `L-${i}`,
				planned_for: "",
				notes: "",
			});
		}
		const shortages = await computeShortages(testDb());
		const drv = shortages.groups.flatMap((g) => g.lines).find((l) => l.part.ref === "DRV-12V")!;
		expect(drv).toMatchObject({ netMilli: 1000, orderMilli: 5000, unitPriceCents: 660 });
		expect(drv.offers.map((o) => o.supplierName)).toEqual(["Lumen Parts Co", "Quickparts Express"]);

		// Ordering it from Quickparts instead: their MOQ (1) and price (7.90).
		const quick = await supplierId("Quickparts Express");
		const lumen = await supplierId("Lumen Parts Co");
		const drvId = await partId("DRV-12V");
		const orders = planDraftOrders(
			shortages.groups,
			(id) => id === lumen,
			(key) => (key === String(drvId) ? quick : undefined),
		);
		const fromQuick = orders.find((o) => o.supplierId === quick)!;
		expect(fromQuick.lines).toEqual([
			{ partId: drvId, optionValues: null, qtyMilli: 1000, unitPriceCents: 790, leadDays: 3 },
		]);
		expect(orders.find((o) => o.supplierId === lumen)?.lines.some((l) => l.partId === drvId) ?? false).toBe(false);

		// Through the page: the order_from_<part> field moves the line to that supplier's draft PO.
		const res = await postForm("/purchasing/draft-pos", {
			[`supplier_${lumen}`]: "on",
			[`order_from_${drvId}`]: String(quick),
		});
		expect(res.status).toBe(303);
		expect(
			await one(
				"SELECT l.qty_milli, l.unit_price_cents, po.supplier_id FROM po_lines l JOIN purchase_orders po ON po.id = l.po_id WHERE l.part_id = ?",
				drvId,
			),
		).toEqual({ qty_milli: 1000, unit_price_cents: 790, supplier_id: quick });
	});

	it("prices a manual PO line at that supplier's offer, else the standard cost", async () => {
		await loadDemo({ stock: false });
		const quick = await supplierId("Quickparts Express");
		const created = await postForm("/purchasing/po", { supplier_id: String(quick), expected_at: "", notes: "" });
		const po = Number(/\/po\/(\d+)/.exec(created.headers.get("Location") ?? "")?.[1]);
		await postForm(`/purchasing/po/${po}/lines`, { part: "LED-5W-CW", qty: "2", price: "" });
		await postForm(`/purchasing/po/${po}/lines`, { part: "BASE-PLATE", qty: "1", price: "" });
		expect(
			await rows(
				"SELECT p.ref, l.unit_price_cents FROM po_lines l JOIN parts p ON p.id = l.part_id WHERE l.po_id = ? ORDER BY p.ref",
				po,
			),
		).toEqual([
			{ ref: "BASE-PLATE", unit_price_cents: 550 },
			{ ref: "LED-5W-CW", unit_price_cents: 490 },
		]);
	});
});

describe("valuation by two methods", () => {
	it("shows standard and weighted average values side by side", async () => {
		const p = await insertPart("P1", "buy", { costCents: 200 });
		await insertMove(p, 10_000, "count");
		// Receipts at other prices only move the weighted average.
		const s = await insertSupplier("S1");
		await postForm("/purchasing/po", { supplier_id: String(s), expected_at: "", notes: "" });
		const po = (await one<{ id: number }>("SELECT id FROM purchase_orders")).id;
		await postForm(`/purchasing/po/${po}/lines`, { part: "P1", qty: "10", price: "3.00" });
		const line = (await one<{ id: number }>("SELECT id FROM po_lines")).id;
		await postForm(`/purchasing/po/${po}/receive`, { [`recv_${line}`]: "10" });
		const v = await valuation(testDb());
		const row = v.rows.find((r) => r.part.ref === "P1")!;
		expect(row.onHandMilli).toBe(20_000);
		// Standard: 20 × 2.00. Weighted average: 10 counted at the standard 2.00 + 10 received at 3.00.
		expect(row.valueCents).toBe(4000);
		expect(row.avgIncomplete).toBe(false);
		expect(row.avgUnitCents).toBe(250);
		expect(v.avgTotalCents).toBe(5000);
	});

	it("values the demo stock both ways and dates the standard cost from the history", async () => {
		await loadDemo();
		const now = await valuation(testDb());
		expect(now.totalCents).toBeGreaterThan(0);
		// Initial stock entered at standard cost: both methods agree until purchase prices differ.
		expect(now.avgTotalCents).toBe(now.totalCents);
		const html = await (await request("/stock/valuation")).text();
		expect(html).not.toMatch(/\sstyle=/);
	});

	it("uses the standard cost valid on the 'as of' date, falling back to the first known one", async () => {
		const p = await insertPart("P1", "buy", { costCents: 300 });
		await env.DB.prepare(
			"INSERT INTO stock_moves (part_id, qty_milli, reason, unit_cost_cents, at, by, created_by, updated_by) VALUES (?, 4000, 'count', 200, '2026-01-05T09:00:00.000Z', 'seed', 'seed', 'seed')",
		)
			.bind(p)
			.run();
		const history =
			"INSERT INTO price_history (part_id, kind, price_cents, valid_from, source, created_by, updated_by) VALUES (?, 'standard', ?, ?, 'form', 'seed', 'seed')";
		await env.DB.prepare(history).bind(p, 250, "2026-02-01").run();
		await env.DB.prepare(history).bind(p, 300, "2026-03-01").run();
		const feb = await valuation(testDb(), "2026-02-15");
		expect(feb.rows[0]).toMatchObject({ valueCents: 1000, fallback: false }); // 4 × 2.50
		const jan = await valuation(testDb(), "2026-01-10");
		expect(jan.rows[0]).toMatchObject({ valueCents: 1000, fallback: true }); // before the history: first value
		expect(jan.fallback).toBe(true);
		expect((await valuation(testDb())).rows[0]?.valueCents).toBe(1200); // today: 4 × 3.00
		// The weighted average uses the cost recorded on the count either way.
		expect(jan.rows[0]?.avgValueCents).toBe(800);
	});
});

describe("margins", () => {
	it("computes planned margins per variant, with the variant's own price when it has one", async () => {
		await loadDemo({ stock: false });
		const report = await marginReport(testDb());
		const std = report.find((r) => r.part.ref === "LAMP-DESK" && r.assembly?.code === "std")!;
		const warm = report.find((r) => r.part.ref === "LAMP-DESK" && r.assembly?.code === "warm")!;
		expect(std).toMatchObject({ priceCents: 8900, plannedCostCents: 3783, plannedIncomplete: true });
		expect(std.planned).toEqual({ marginCents: 5117, rateBp: 5749, markupBp: 13526 });
		expect(warm.priceCents).toBe(9400);
		expect(warm.assembly?.ownPrice).toBe(true);
		// Parts without a selling price are not listed.
		expect(report.some((r) => r.part.ref === "ARM-ASSY")).toBe(false);
	});

	it("measures the actual margin of completed builds at weighted average cost", async () => {
		await loadDemo();
		const res = await postForm("/builds", {
			part_id: String(await partId("LAMP-DESK")),
			assembly_id: String(await assemblyId("LAMP-DESK")),
			qty: "1",
			serial: "L-1",
			planned_for: "",
			notes: "",
		});
		const build = Number(/\/builds\/(\d+)/.exec(res.headers.get("Location") ?? "")?.[1]);
		const page = await (await request(`/builds/${build}`)).text();
		const fields: Record<string, string> = {};
		for (const m of page.matchAll(/name="(serial:\d+:\d+)"/g)) fields[m[1] as string] = `S-${m[1]}`;
		expect((await postForm(`/builds/${build}/complete`, fields)).status).toBe(303);
		const actual = await buildActualCost(testDb(), build);
		expect(actual?.unitCents).toBeGreaterThan(0);
		const std = (await marginReport(testDb())).find((r) => r.part.ref === "LAMP-DESK" && r.assembly?.code === "std")!;
		expect(std.doneBuilds).toBe(1);
		expect(std.actualCostCents).toBe(actual?.unitCents);
		expect(std.actual).toEqual(marginOf(8900, actual?.unitCents ?? null));
	});

	it("needs both a price and a cost", () => {
		expect(marginOf(null, 100)).toBeNull();
		expect(marginOf(100, null)).toBeNull();
		expect(marginOf(100, 0)).toEqual({ marginCents: 100, rateBp: 10_000, markupBp: null });
	});
});

describe("backup", () => {
	it("includes offers and price history", async () => {
		await loadDemo({ stock: false });
		const json = await (await request("/import/backup.json")).json<{ tables: Record<string, unknown[]> }>();
		expect(json.tables.part_suppliers).toHaveLength(23);
		expect((json.tables.price_history ?? []).length).toBeGreaterThan(0);
		expect(DEMO.part_suppliers).toContain("Quickparts Express");
	});
});
