import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { valuation } from "../src/domain/stock";
import { formatCentsInput, formatMoney } from "../src/lib/units";
import {
	assemblyId,
	insertPart,
	insertSupplier,
	loadDemo,
	one,
	partId,
	postForm,
	request,
	rows,
	seedSql,
	stmt,
	testDb,
} from "./helpers";

const supplierId = async (name: string) =>
	(await one<{ id: number }>("SELECT id FROM suppliers WHERE name = ?", name)).id;

const money = (cents: number) => formatMoney(cents, "en", "EUR");

const noInlineStyle = (html: string) => expect(html).not.toMatch(/\sstyle=/);

async function planLamps(n: number) {
	for (let i = 1; i <= n; i++) {
		const res = await postForm("/builds", {
			part_id: String(await partId("LAMP-DESK")),
			assembly_id: String(await assemblyId("LAMP-DESK")),
			qty: "1",
			serial: `L-${i}`,
			planned_for: "",
			notes: "",
		});
		expect(res.status).toBe(303);
	}
}

/** The fields a browser would submit from the draft-pos form as rendered: checked boxes and selected options. */
function draftPosFields(html: string): Record<string, string> {
	const start = html.indexOf('<form id="draft-pos"');
	const form = html.slice(start, html.indexOf("</form>", start));
	const fields: Record<string, string> = {};
	for (const m of form.matchAll(/<input[^>]*name="(supplier_\d+)"[^>]*>/g)) {
		if (/\schecked/.test(m[0])) fields[m[1] as string] = "on";
	}
	for (const m of form.matchAll(/<select[^>]*name="(order_from_\d+)"[^>]*>([\s\S]*?)<\/select>/g)) {
		const options = [...(m[2] as string).matchAll(/<option value="([^"]*)"([^>]*)>/g)];
		const chosen = options.find((o) => /\sselected/.test(o[2] as string)) ?? options[0];
		fields[m[1] as string] = chosen?.[1] ?? "";
	}
	return fields;
}

/** The <select name="order_from_<part>"> markup of a page. */
function orderFromSelect(html: string, part: number): string {
	const at = html.indexOf(`name="order_from_${part}"`);
	expect(at).toBeGreaterThan(-1);
	return html.slice(html.lastIndexOf("<select", at), html.indexOf("</select>", at));
}

describe("valuation page", () => {
	it("shows both methods side by side: totals, columns and their difference", async () => {
		await loadDemo();
		const v = await valuation(testDb());
		const html = await (await request("/stock/valuation")).text();
		expect(html).toContain("Value at standard cost");
		expect(html).toContain("Value at weighted average");
		expect(html).toContain("Difference between methods");
		expect(html).toContain(money(v.totalCents));
		expect(html).toContain(money(v.avgTotalCents));
		// Column groups for each method, and a footer with both totals.
		expect(html).toMatch(/colspan="2"[^>]*>Standard cost<\/th>.*?colspan="2"[^>]*>Weighted average<\/th>/s);
		const footer = html.slice(html.indexOf("<tfoot"), html.indexOf("</tfoot>"));
		expect(footer).toContain(money(v.totalCents));
		expect(footer).toContain(money(v.avgTotalCents));
		// The method explanation, and the incomplete warning (MANUAL has no cost).
		expect(html).toContain("neither is the official value");
		expect(html).toContain("Some parts have no cost");
		noInlineStyle(html);
	});

	it("shows a weighted average that differs from the standard cost after a receipt at another price", async () => {
		await insertPart("P1", "buy", { costCents: 200 });
		const s = await insertSupplier("S1");
		await postForm("/purchasing/po", { supplier_id: String(s), expected_at: "", notes: "" });
		const po = (await one<{ id: number }>("SELECT id FROM purchase_orders")).id;
		await postForm(`/purchasing/po/${po}/lines`, { part: "P1", qty: "10", price: "3.00" });
		const line = (await one<{ id: number }>("SELECT id FROM po_lines")).id;
		await postForm(`/purchasing/po/${po}/receive`, { [`recv_${line}`]: "10" });
		const html = await (await request("/stock/valuation")).text();
		// Standard 10 × 2.00, weighted average 10 × 3.00, difference +10.00.
		expect(html).toMatch(/P1<\/a>.*?€2\.00.*?€20\.00.*?€3\.00.*?€30\.00/s);
		expect(html).toMatch(/Difference between methods.*?€10\.00/s);
		expect(html).not.toContain("Some parts have no cost");
	});

	it("exports both methods' columns in the CSV", async () => {
		await loadDemo();
		const csv = await (await request("/stock/valuation?format=csv")).text();
		const lines = csv.trim().split(/\r?\n/);
		expect(lines[0]).toBe(
			"ref,name,kind,unit,on_hand,standard_unit_cost,cost_source,standard_value,standard_incomplete,average_unit_cost,average_value,average_incomplete",
		);
		// Initial stock entered at standard cost: both methods agree on the arms (2 × 4.54 roll-up).
		expect(csv).toContain("ARM-ASSY,Arm sub-assembly,make,pcs,2,4.54,rollup,9.08,,4.54,9.08,");
		const v = await valuation(testDb());
		const yes = (b: boolean) => (b ? "yes" : "");
		expect(lines.at(-1)).toBe(
			`,,,,,,total,${formatCentsInput(v.totalCents)},${yes(v.incomplete)},,${formatCentsInput(v.avgTotalCents)},${yes(v.avgIncomplete)}`,
		);
	});

	it("explains the fallback to the first known standard cost before the price history starts", async () => {
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
		const note = "Standard costs were only recorded from 2026-02-01 on";
		const jan = await (await request("/stock/valuation?at=2026-01-10")).text();
		expect(jan).toContain(note);
		noInlineStyle(jan);
		expect(await (await request("/stock/valuation?at=2026-02-15")).text()).not.toContain(note);
		expect(await (await request("/stock/valuation")).text()).not.toContain(note);
	});
});

describe("shortages: ordering from another supplier", () => {
	it("offers every supplier of a part, preferred selected, and moves the line when another is chosen", async () => {
		await loadDemo();
		await planLamps(6); // one driver short
		const drv = await partId("DRV-12V");
		const lumen = await supplierId("Lumen Parts Co");
		const quick = await supplierId("Quickparts Express");
		const html = await (await request("/purchasing")).text();
		noInlineStyle(html);
		const select = orderFromSelect(html, drv);
		expect(select).toContain(`aria-label="Order from DRV-12V"`);
		expect(select).toMatch(
			new RegExp(
				`<option value="${lumen}"[^>]*selected[^>]*>Lumen Parts Co \\(preferred\\) · €6\\.60 · MOQ 5 · 21 d lead time<`,
			),
		);
		expect(select).toMatch(
			new RegExp(
				`<option value="${quick}"(?![^>]*selected)[^>]*>Quickparts Express · €7\\.90 · MOQ 1 · 3 d lead time<`,
			),
		);
		expect(html).toContain("a line moved to another supplier is re-rounded to that supplier&#39;s MOQ and pack size");
		// Unit price and line total at the preferred supplier's terms: 5 × 6.60.
		expect(html).toMatch(/DRV-12V<\/a>.*?€6\.60.*?€33\.00/s);

		// Submitting the form as rendered, with Quickparts chosen for the driver.
		const fields = draftPosFields(html);
		expect(fields[`supplier_${lumen}`]).toBe("on");
		expect(fields[`order_from_${drv}`]).toBe(String(lumen));
		fields[`order_from_${drv}`] = String(quick);
		const res = await postForm("/purchasing/draft-pos", fields);
		expect(res.status).toBe(303);
		expect(
			await rows(
				"SELECT l.qty_milli, l.unit_price_cents, po.supplier_id FROM po_lines l JOIN purchase_orders po ON po.id = l.po_id WHERE l.part_id = ?",
				drv,
			),
		).toEqual([{ qty_milli: 1000, unit_price_cents: 790, supplier_id: quick }]);
	});

	it("lets a line without preferred supplier be ordered once a supplier is chosen", async () => {
		const acme = await insertSupplier("Acme");
		const loose = await insertPart("LOOSE", "buy", { costCents: 100 });
		await seedSql(
			stmt(
				"INSERT INTO part_suppliers (part_id, supplier_id, price_cents, moq_milli, pack_size_milli, lead_days, created_by, updated_by) VALUES (?, ?, 120, 10000, 0, 4, 'seed', 'seed')",
				loose,
				acme,
			),
		);
		await insertPart("BARE", "buy", { costCents: 50 });
		const top = await insertPart("TOP", "make");
		await postForm("/assemblies", {
			parent_part_id: String(top),
			code: "std",
			revision: "Rev1",
			notes: "",
			copy_from: "",
		});
		const b = (await one<{ id: number }>("SELECT id FROM assemblies")).id;
		await postForm(`/assemblies/${b}/lines`, { component: "LOOSE", qty: "2", notes: "" });
		await postForm(`/assemblies/${b}/lines`, { component: "BARE", qty: "1", notes: "" });
		await postForm(`/assemblies/${b}/activate`, {});
		await postForm("/builds", {
			part_id: String(top),
			assembly_id: String(b),
			qty: "1",
			serial: "",
			planned_for: "",
			notes: "",
		});
		const html = await (await request("/purchasing")).text();
		// The only group has no preferred supplier, yet the form can be submitted.
		expect(html).toContain('form="draft-pos"');
		const select = orderFromSelect(html, loose);
		expect(select).toMatch(/<option value="">Choose a supplier…<\/option>/);
		expect(select).toMatch(
			new RegExp(`<option value="${acme}"(?![^>]*selected)[^>]*>Acme · €1\\.20 · MOQ 10 · 4 d lead time<`),
		);
		expect(html).toContain("No offer: add a supplier on the part"); // BARE
		// As rendered (nothing chosen): no PO.
		expect((await postForm("/purchasing/draft-pos", draftPosFields(html))).headers.get("Location")).toBe("/purchasing");
		expect(await rows("SELECT id FROM purchase_orders")).toEqual([]);
		// Acme chosen: rounded to its MOQ, at its offer price.
		await postForm("/purchasing/draft-pos", { ...draftPosFields(html), [`order_from_${loose}`]: String(acme) });
		expect(
			await rows(
				"SELECT l.qty_milli, l.unit_price_cents, po.supplier_id FROM po_lines l JOIN purchase_orders po ON po.id = l.po_id",
			),
		).toEqual([{ qty_milli: 10_000, unit_price_cents: 120, supplier_id: acme }]);
	});
});

describe("dashboard stock value", () => {
	it("names the standard method and gives the weighted average next to it", async () => {
		await loadDemo();
		const v = await valuation(testDb());
		const html = await (await request("/")).text();
		expect(html).toContain("Stock at standard cost");
		expect(html).toContain(`Weighted average: ${money(v.avgTotalCents)}`);
		expect(html).toContain("Incomplete: some costs are unknown"); // MANUAL has no cost
		expect(html).toContain('href="/stock/valuation"');
		noInlineStyle(html);
	});
});

describe("purchase order detail", () => {
	it("says an empty price uses the supplier's offer, and renders without inline styles", async () => {
		const s = await insertSupplier("S1");
		const created = await postForm("/purchasing/po", { supplier_id: String(s), expected_at: "", notes: "" });
		const html = await (await request(created.headers.get("Location") ?? "")).text();
		expect(html).toContain("Empty = this supplier&#39;s offer price, else the standard cost.");
		noInlineStyle(html);
	});
});
