import { beforeEach, describe, expect, it } from "vitest";
import {
	insertPart,
	insertSupplier,
	loadDemo,
	NOT_ADMIN,
	one,
	partId,
	postForm,
	request,
	rows,
	setRole,
} from "./helpers";

// NOT_ADMIN requests run as a planner, so admin-only actions are refused by requireAdmin itself.
beforeEach(() => setRole("planner"));

const supplierId = async (name: string) =>
	(await one<{ id: number }>("SELECT id FROM suppliers WHERE name = ?", name)).id;

const offerForm = (over: Record<string, string> = {}) => ({
	supplier_id: "",
	supplier_ref: "",
	price: "",
	moq: "",
	pack_size: "",
	lead_days: "",
	notes: "",
	...over,
});

/** The table row (<tr>…</tr>) of a page that contains `needle`. */
function rowWith(html: string, needle: string): string {
	const row = html
		.split("<tr")
		.slice(1)
		.map((r) => r.slice(0, r.indexOf("</tr>")))
		.find((r) => r.includes(needle));
	if (!row) throw new Error(`no row with ${needle}`);
	return row;
}

/** Receives `qty` of a part on a new PO from `supplier` at `price` (through the real routes). */
async function receive(supplier: number, ref: string, qty: string, price: string) {
	await postForm("/purchasing/po", { supplier_id: String(supplier), expected_at: "", notes: "" });
	const po = (await one<{ id: number }>("SELECT MAX(id) AS id FROM purchase_orders")).id;
	await postForm(`/purchasing/po/${po}/lines`, { part: ref, qty, price });
	const line = (await one<{ id: number }>("SELECT id FROM po_lines WHERE po_id = ?", po)).id;
	await postForm(`/purchasing/po/${po}/receive`, { [`recv_${line}`]: qty });
	return po;
}

describe("supplier offers on the part page", () => {
	it("lists every offer, the preferred one badged and first, with its price and terms", async () => {
		await loadDemo({ stock: false });
		const id = await partId("DRV-12V");
		const lumenId = await supplierId("Lumen Parts Co");
		const html = await (await request(`/parts/${id}`)).text();
		const lumen = rowWith(html, `href="/suppliers/${lumenId}"`);
		const quick = rowWith(html, `href="/suppliers/${await supplierId("Quickparts Express")}"`);
		expect(lumen).toContain("€6.60");
		expect(lumen).toContain("DRV-700-12");
		expect(lumen).toMatch(/data-slot="badge"[\s\S]*Preferred<\/span>/);
		expect(lumen).not.toContain("Make preferred");
		expect(quick).toContain("€7.90");
		expect(quick).not.toMatch(/data-slot="badge"[\s\S]*Preferred<\/span>/);
		expect(quick).toContain("Make preferred");
		expect(html.indexOf(lumen)).toBeLessThan(html.indexOf(quick));
		expect(lumen).toContain(`href="/parts/${id}/offers/${lumenId}"`);
		// Only admins see the remove button.
		expect(lumen).toContain(`action="/parts/${id}/offers/${lumenId}/delete"`);
		const asUser = await (await request(`/parts/${id}`, {}, NOT_ADMIN)).text();
		expect(asUser).not.toContain(`/offers/${lumenId}/delete`);
		expect(asUser).toContain("Make preferred");
	});

	it("shows the standard cost a PO would use when an offer has no price", async () => {
		const s = await insertSupplier("Acme");
		const id = await insertPart("P1", "buy", { costCents: 500, supplierId: s });
		const row = rowWith(await (await request(`/parts/${id}`)).text(), `href="/suppliers/${s}"`);
		expect(row).toContain("€5.00");
		expect(row).toContain("standard cost used");
	});

	it("creates an offer, and makes it preferred when asked", async () => {
		const acme = await insertSupplier("Acme");
		const other = await insertSupplier("Other");
		const id = await insertPart("P1", "buy", { costCents: 500, supplierId: acme });
		const form = await (await request(`/parts/${id}/offers/new`)).text();
		expect(form).toContain('name="supplier_id"');
		expect(form).toContain('name="preferred"');
		const res = await postForm(
			`/parts/${id}/offers`,
			offerForm({ supplier_id: String(other), supplier_ref: "OT-1", price: "4,20", moq: "10", lead_days: "5" }),
		);
		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toBe(`/parts/${id}?ok=saved`);
		expect(
			await one(
				"SELECT supplier_ref, price_cents, moq_milli, lead_days FROM part_suppliers WHERE supplier_id = ?",
				other,
			),
		).toEqual({ supplier_ref: "OT-1", price_cents: 420, moq_milli: 10_000, lead_days: 5 });
		expect(await one("SELECT supplier_id FROM parts WHERE id = ?", id)).toEqual({ supplier_id: acme });
		expect(await rows("SELECT kind, price_cents, supplier_id, source FROM price_history")).toEqual([
			{ kind: "purchase", price_cents: 420, supplier_id: other, source: "form" },
		]);
		// A third supplier, ticked as preferred, takes over the pointer.
		const third = await insertSupplier("Third");
		await postForm(`/parts/${id}/offers/new`, offerForm({ supplier_id: String(third), preferred: "on" }));
		expect(await one("SELECT supplier_id FROM parts WHERE id = ?", id)).toEqual({ supplier_id: third });
	});

	it("rejects a missing or duplicate supplier, and offers on kits and fees", async () => {
		const acme = await insertSupplier("Acme");
		const id = await insertPart("P1", "buy", { supplierId: acme });
		const missing = await postForm(`/parts/${id}/offers`, offerForm({ price: "1" }));
		expect(missing.status).toBe(422);
		expect(await missing.text()).toContain("Required.");
		const dup = await postForm(`/parts/${id}/offers`, offerForm({ supplier_id: String(acme), price: "1" }));
		expect(dup.status).toBe(422);
		expect(await dup.text()).toContain("This supplier already has an offer for this part");
		const bad = await postForm(`/parts/${id}/offers`, offerForm({ supplier_id: String(acme), price: "1.234" }));
		expect(bad.status).toBe(422);
		expect(await bad.text()).toContain("Not a valid amount");
		expect(await rows("SELECT id FROM part_suppliers")).toHaveLength(1);

		const kit = await insertPart("KIT-1", "kit");
		expect((await request(`/parts/${kit}/offers/new`)).status).toBe(422);
		const refused = await postForm(`/parts/${kit}/offers`, offerForm({ supplier_id: String(acme) }));
		expect(refused.status).toBe(422);
		expect(await refused.text()).toContain("Only buy and make parts have supplier offers");
		expect(await rows("SELECT id FROM part_suppliers WHERE part_id = ?", kit)).toHaveLength(0);
		expect(await (await request(`/parts/${kit}`)).text()).not.toContain("/offers/new");
	});

	it("edits an offer and logs its new price", async () => {
		const acme = await insertSupplier("Acme");
		const id = await insertPart("P1", "buy", { supplierId: acme, moqMilli: 5000 });
		const form = await (await request(`/parts/${id}/offers/${acme}`)).text();
		expect(form).toContain('value="5"');
		expect(form).not.toContain('name="supplier_id"');
		expect(form).toContain("This is the preferred supplier.");
		const res = await postForm(
			`/parts/${id}/offers/${acme}`,
			offerForm({ supplier_ref: "AC-9", price: "3.10", moq: "5" }),
		);
		expect(res.status).toBe(303);
		expect(await one("SELECT supplier_ref, price_cents FROM part_suppliers")).toEqual({
			supplier_ref: "AC-9",
			price_cents: 310,
		});
		expect(await rows("SELECT kind, price_cents, supplier_id FROM price_history")).toEqual([
			{ kind: "purchase", price_cents: 310, supplier_id: acme },
		]);
		// Same price again: nothing new in the history. An unticked box leaves the preferred supplier alone.
		await postForm(`/parts/${id}/offers/${acme}`, offerForm({ supplier_ref: "AC-10", price: "3.10" }));
		expect(await rows("SELECT id FROM price_history")).toHaveLength(1);
		expect(await one("SELECT supplier_id FROM parts WHERE id = ?", id)).toEqual({ supplier_id: acme });
		expect((await request(`/parts/${id}/offers/999`)).status).toBe(404);
	});

	it("makes another supplier preferred", async () => {
		await loadDemo({ stock: false });
		const id = await partId("DRV-12V");
		const quick = await supplierId("Quickparts Express");
		const res = await postForm(`/parts/${id}/offers/${quick}/prefer`, {});
		expect(res.headers.get("Location")).toBe(`/parts/${id}?ok=saved`);
		expect(await one("SELECT supplier_id FROM parts WHERE id = ?", id)).toEqual({ supplier_id: quick });
		const row = rowWith(await (await request(`/parts/${id}`)).text(), `href="/suppliers/${quick}"`);
		expect(row).toMatch(/Preferred<\/span>/);
	});

	it("removes an offer (admins only) and clears the preferred supplier when it was that one", async () => {
		const acme = await insertSupplier("Acme");
		const other = await insertSupplier("Other");
		const id = await insertPart("P1", "buy", { supplierId: acme });
		await postForm(`/parts/${id}/offers`, offerForm({ supplier_id: String(other) }));
		expect((await postForm(`/parts/${id}/offers/${acme}/delete`, {}, NOT_ADMIN)).status).toBe(403);
		expect(await rows("SELECT id FROM part_suppliers")).toHaveLength(2);
		// Removing a non-preferred offer keeps the pointer.
		await postForm(`/parts/${id}/offers/${other}/delete`, {});
		expect(await one("SELECT supplier_id FROM parts WHERE id = ?", id)).toEqual({ supplier_id: acme });
		const res = await postForm(`/parts/${id}/offers/${acme}/delete`, {});
		expect(res.headers.get("Location")).toBe(`/parts/${id}?ok=deleted`);
		expect(await rows("SELECT id FROM part_suppliers")).toHaveLength(0);
		expect(await one("SELECT supplier_id FROM parts WHERE id = ?", id)).toEqual({ supplier_id: null });
	});
});

describe("prices on the part page", () => {
	it("copies the weighted average into the standard cost, logged in the history", async () => {
		const s = await insertSupplier("S1");
		const id = await insertPart("P1", "buy", { costCents: 200, supplierId: s });
		// A count records the standard cost of the day, as the stock routes do.
		await rows(
			"INSERT INTO stock_moves (part_id, qty_milli, reason, unit_cost_cents, by, created_by, updated_by) VALUES (?, 10000, 'count', 200, 'seed', 'seed', 'seed')",
			id,
		);
		await receive(s, "P1", "10", "3.00");
		const html = await (await request(`/parts/${id}`)).text();
		// 10 counted at 2.00 + 10 received at 3.00.
		expect(html).toContain("Weighted average cost");
		expect(html).toContain("€2.50");
		expect(html).toContain("Use average as standard cost");
		// The last price paid to S1 shows on its offer row.
		expect(rowWith(html, `href="/suppliers/${s}"`)).toContain("€3.00");
		const res = await postForm(`/parts/${id}/cost/average`, {});
		expect(res.headers.get("Location")).toBe(`/parts/${id}?ok=saved`);
		expect(await one("SELECT cost_cents, updated_by FROM parts WHERE id = ?", id)).toEqual({
			cost_cents: 250,
			updated_by: "tester@example.com",
		});
		expect(await rows("SELECT kind, price_cents, source, note FROM price_history WHERE kind = 'standard'")).toEqual([
			{ kind: "standard", price_cents: 250, source: "form", note: "From the weighted average cost" },
		]);
		expect(await (await request(`/parts/${id}`)).text()).not.toContain("Use average as standard cost");
	});

	it("copies the preferred offer's price into the standard cost", async () => {
		await loadDemo({ stock: false });
		const id = await partId("DRV-12V");
		expect(await (await request(`/parts/${id}`)).text()).toContain("Use preferred offer price as standard cost");
		await postForm(`/parts/${id}/cost/offer`, {});
		expect(await one("SELECT cost_cents FROM parts WHERE id = ?", id)).toEqual({ cost_cents: 660 });
		expect(
			await one(
				"SELECT price_cents, note FROM price_history WHERE part_id = ? AND kind = 'standard' ORDER BY id DESC",
				id,
			),
		).toEqual({ price_cents: 660, note: "From the offer of Lumen Parts Co" });
	});

	it("shows the selling price and the planned margin on the BoM roll-up", async () => {
		await loadDemo({ stock: false });
		const html = await (await request(`/parts/${await partId("LAMP-DESK")}`)).text();
		expect(html).toContain("Selling price");
		expect(html).toContain("€89.00");
		expect(html).toContain("Planned margin");
		// Rate on the price and markup on the cost, both as percentages (formatPercent uses a no-break space).
		expect(html).toMatch(/[\d.]+ % of the price · [\d.]+ % markup/);
	});

	it("draws the price history as an inline SVG chart, with the changes and the prices paid", async () => {
		const s = await insertSupplier("S1");
		const id = await insertPart("P1", "buy", { supplierId: s });
		await postForm(`/parts/${id}/offers/${s}`, offerForm({ price: "2.80" }));
		await postForm(`/parts/${id}`, {
			ref: "P1",
			name: "Part P1",
			kind: "buy",
			unit: "pcs",
			cost: "2.50",
			sale_price: "",
			supplier_id: String(s),
			supplier_ref: "",
			moq: "",
			pack_size: "",
			lead_days: "",
			notes: "",
		});
		const po = await receive(s, "P1", "4", "2.90");
		const html = await (await request(`/parts/${id}`)).text();
		expect(html).toContain("Price history");
		expect(html).toMatch(/<svg[^>]*role="img"/);
		expect(html).toContain("stroke-chart-1");
		expect(html).toContain("fill-chart-2");
		expect(html).not.toMatch(/\sstyle=/);
		expect(html).toContain("Supplier price");
		expect(html).toContain("Standard cost");
		expect(html).toContain(`href="/purchasing/po/${po}"`);
		expect(html).toContain("€2.90");
	});

	it("shows an empty state when a part has no price yet", async () => {
		const id = await insertPart("P1");
		const html = await (await request(`/parts/${id}`)).text();
		expect(html).toContain("No price recorded yet.");
		expect(html).not.toMatch(/<svg[^>]*role="img"/);
	});
});

describe("supplier page", () => {
	it("lists the supplier's offers with prices and the preferred badge", async () => {
		await loadDemo({ stock: false });
		const lumen = await (await request(`/suppliers/${await supplierId("Lumen Parts Co")}`)).text();
		const drv = rowWith(lumen, `href="/parts/${await partId("DRV-12V")}"`);
		expect(drv).toContain("DRV-700-12");
		expect(drv).toContain("€6.60");
		expect(drv).toMatch(/Preferred<\/span>/);
		const quick = await (await request(`/suppliers/${await supplierId("Quickparts Express")}`)).text();
		const qdrv = rowWith(quick, `href="/parts/${await partId("DRV-12V")}"`);
		expect(qdrv).toContain("€7.90");
		expect(qdrv).not.toMatch(/Preferred<\/span>/);
		expect(quick).toContain("PSU-EU-12V");
	});
});
