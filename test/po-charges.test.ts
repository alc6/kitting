import { describe, expect, it } from "vitest";
import { revertChangeSet } from "../src/domain/revert";
import { averageCosts } from "../src/domain/stock";
import {
	insertPart,
	insertSupplier,
	NOT_ADMIN,
	one,
	postForm,
	request,
	rows,
	setRole,
	TESTER,
	testDb,
} from "./helpers";

// Charges on purchase orders and landed cost (D201–D204), through the PO page.

const poIdOf = (res: Response) => Number(/\/po\/(\d+)/.exec(res.headers.get("Location") ?? "")?.[1]);

/**
 * A draft PO from a sheet-metal supplier: 4 chassis at 180.00 and 7 doors at 35.10 (parts 965.70), with an offer of
 * each so the parts page shows the last price paid.
 */
async function sheetMetalPo() {
	const supplier = await insertSupplier("Sheet Metal Co");
	const chassis = await insertPart("CHASSIS", "buy", { supplierId: supplier, costCents: 15_000 });
	const door = await insertPart("DOOR", "buy", { supplierId: supplier, costCents: 3_000 });
	const id = poIdOf(await postForm("/purchasing/po", { supplier_id: String(supplier), expected_at: "", notes: "" }));
	for (const [part, qty, price] of [
		["CHASSIS", "4", "180.00"],
		["DOOR", "7", "35.10"],
	] as const)
		expect((await postForm(`/purchasing/po/${id}/lines`, { part, qty, price })).status).toBe(303);
	const lineOf = async (partId: number) =>
		(await one<{ id: number }>("SELECT id FROM po_lines WHERE po_id = ? AND part_id = ?", id, partId)).id;
	return { id, chassis, door, chassisLine: await lineOf(chassis), doorLine: await lineOf(door) };
}

const setCharges = (id: number, c: { shipping?: string; duties?: string; discount?: string; spread?: string }) =>
	postForm(`/purchasing/po/${id}/charges`, {
		shipping: c.shipping ?? "",
		duties: c.duties ?? "",
		discount: c.discount ?? "",
		charges_spread: c.spread ?? "value",
	});

const receipts = (partId: number) =>
	rows<{ qty_milli: number; unit_cost_cents: number }>(
		"SELECT qty_milli, unit_cost_cents FROM stock_moves WHERE reason = 'receipt' AND part_id = ? ORDER BY id",
		partId,
	);

describe("charges on purchase orders", () => {
	it("records shipping and a discount on a draft, totals them and shows each line's landed unit cost", async () => {
		const po = await sheetMetalPo();
		const res = await setCharges(po.id, { shipping: "742.18", discount: "6.30" });
		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toBe(`/purchasing/po/${po.id}?ok=saved#charges`);
		expect(
			await one(
				"SELECT shipping_cents, duties_cents, discount_cents, charges_spread FROM purchase_orders WHERE id = ?",
				po.id,
			),
		).toEqual({ shipping_cents: 74_218, duties_cents: 0, discount_cents: 630, charges_spread: "value" });
		const change = await one<{ id: number; summary: string }>(
			"SELECT id, summary FROM change_sets ORDER BY id DESC LIMIT 1",
		);
		expect(change.summary).toBe("Edit the charges of PO PO-0001");

		const page = await (await request(`/purchasing/po/${po.id}`)).text();
		expect(page).toContain("Shipping and charges");
		expect(page).toContain('action="/purchasing/po/1/charges"');
		expect(page).toMatch(/name="shipping"[^>]*value="742.18"/);
		// Parts, shipping, discount, total (965.70 + 742.18 − 6.30), with the parts and charges under the total figure.
		for (const text of ["Parts", "€965.70", "€742.18", "-€6.30", "€1,701.58", "Parts €965.70 + charges €735.88"])
			expect(page, text).toContain(text);
		// Spread by value: 54 865 and 18 723 of the 73 588 net, per unit 137.16 and 26.75 (rounded).
		expect(page).toContain("Landed unit cost");
		expect(page).toContain("€317.16");
		expect(page).toContain("€61.85");
		// The PO list totals lines and charges too.
		expect(await (await request("/purchasing/po")).text()).toContain("€1,701.58");

		// Undo puts the PO back without charges.
		await revertChangeSet(testDb(), { role: "admin", seeCosts: true }, change.id, {
			user: TESTER,
			summary: (s) => `Undo #${s.id}: ${s.summary}`,
		});
		expect(await one("SELECT shipping_cents, discount_cents FROM purchase_orders WHERE id = ?", po.id)).toEqual({
			shipping_cents: 0,
			discount_cents: 0,
		});
		const plain = await (await request(`/purchasing/po/${po.id}`)).text();
		expect(plain).not.toContain("Landed unit cost");
		expect(plain).not.toContain("Customs and duties</td>");
	});

	it("refuses invalid amounts, a discount larger than the order, and changes once the PO is closed", async () => {
		const po = await sheetMetalPo();
		const bad = await setCharges(po.id, { shipping: "12,3,4", discount: "-1" });
		expect(bad.status).toBe(422);
		const text = await bad.text();
		expect(text).toContain("Not a valid amount (up to 2 decimals).");
		expect(text).toContain("Must be zero or more.");
		// The card opens on the refused values.
		expect(text).toMatch(/<details[^>]*id="charges"[^>]*open/);
		expect(await (await setCharges(po.id, { spread: "weight" })).text()).toContain("Invalid value.");
		const tooMuch = await setCharges(po.id, { shipping: "10", discount: "975.71" });
		expect(tooMuch.status).toBe(422);
		expect(await tooMuch.text()).toContain("The discount is larger than the order.");
		expect((await setCharges(po.id, { shipping: "10", discount: "975.70" })).status).toBe(303);
		expect(await one("SELECT count(*) AS n FROM change_sets WHERE summary LIKE 'Edit the charges%'")).toEqual({ n: 1 });

		// Sent: the freight is often known late, so charges still change.
		await postForm(`/purchasing/po/${po.id}/send`, {});
		expect((await setCharges(po.id, { shipping: "742.18" })).status).toBe(303);
		await postForm(`/purchasing/po/${po.id}/close`, {});
		expect((await setCharges(po.id, { shipping: "1" })).headers.get("Location")).toBe(
			`/purchasing/po/${po.id}?err=po_charges_closed`,
		);
		expect(await one("SELECT shipping_cents FROM purchase_orders WHERE id = ?", po.id)).toEqual({
			shipping_cents: 74_218,
		});
		expect(await (await request(`/purchasing/po/${po.id}`)).text()).not.toContain(
			`action="/purchasing/po/${po.id}/charges"`,
		);
	});

	it("leaves charges to planners: operators neither see the form nor post it", async () => {
		const po = await sheetMetalPo();
		await setCharges(po.id, { shipping: "5" });
		await setRole("operator");
		const res = await postForm(
			`/purchasing/po/${po.id}/charges`,
			{ shipping: "5", duties: "", discount: "", charges_spread: "value" },
			NOT_ADMIN,
		);
		expect(res.status).toBe(403);
		const page = await (await request(`/purchasing/po/${po.id}`, {}, NOT_ADMIN)).text();
		expect(page).not.toContain(`action="/purchasing/po/${po.id}/charges"`);
		expect(page).not.toContain("€5.00");
	});
});

describe("landed cost on receipts", () => {
	it("posts receipts at the landed unit cost; a partial receipt takes the share of what it receives", async () => {
		const po = await sheetMetalPo();
		await setCharges(po.id, { shipping: "742.18", discount: "6.30" });
		await postForm(`/purchasing/po/${po.id}/send`, {});
		const page = await (await request(`/purchasing/po/${po.id}`)).text();
		expect(page).toContain("Stock enters at the landed unit cost");
		expect(
			(
				await postForm(`/purchasing/po/${po.id}/receive`, {
					[`recv_${po.chassisLine}`]: "2",
					[`recv_${po.doorLine}`]: "7",
				})
			).status,
		).toBe(303);
		expect(await receipts(po.chassis)).toEqual([{ qty_milli: 2_000, unit_cost_cents: 31_716 }]);
		expect(await receipts(po.door)).toEqual([{ qty_milli: 7_000, unit_cost_cents: 6_185 }]);
		// The weighted average (valuation, actual margins) starts from the landed cost.
		const average = (await averageCosts(testDb())).costs;
		expect(average.get(po.door)).toMatchObject({ qtyMilli: 7_000, valueMillicents: 7_000 * 6_185 });
		// What went into stock value: 2 × 137.16 + 7 × 26.75.
		const partial = await (await request(`/purchasing/po/${po.id}`)).text();
		expect(partial).toContain("Charges in stock value");
		expect(partial).toContain("€461.57");

		// Customs invoiced after the first delivery: only what is received afterwards takes it (D203).
		expect((await setCharges(po.id, { shipping: "742.18", duties: "100", discount: "6.30" })).status).toBe(303);
		await postForm(`/purchasing/po/${po.id}/receive`, { [`recv_${po.chassisLine}`]: "2" });
		// Net 835.88 by value: 623.21 for the chassis line, 155.80 a unit (rounded); past receipts keep their cost.
		expect(await receipts(po.chassis)).toEqual([
			{ qty_milli: 2_000, unit_cost_cents: 31_716 },
			{ qty_milli: 2_000, unit_cost_cents: 33_580 },
		]);
		expect(await one("SELECT status FROM purchase_orders WHERE id = ?", po.id)).toEqual({ status: "received" });
		// 2 × 137.16 + 2 × 155.80 + 7 × 26.75 of the 835.88: the doors received before the duties never took theirs.
		const received = await (await request(`/purchasing/po/${po.id}`)).text();
		expect(received).toContain("€773.17");
		expect(received).toContain("€1,801.58");
	});

	it("still shows the charges in stock value once the charges are cleared", async () => {
		const po = await sheetMetalPo();
		await setCharges(po.id, { shipping: "100" });
		await postForm(`/purchasing/po/${po.id}/receive`, { [`recv_${po.chassisLine}`]: "1" });
		// 74.56 of the 100.00 for the chassis line: 18.64 a unit.
		expect(await receipts(po.chassis)).toEqual([{ qty_milli: 1_000, unit_cost_cents: 19_864 }]);
		await setCharges(po.id, {});
		const page = await (await request(`/purchasing/po/${po.id}`)).text();
		expect(page).not.toContain("Landed unit cost");
		expect(page).toMatch(/Charges in stock value<\/td>.*€18\.64/s);
	});

	it("keeps receipts at the line price when charges are not spread", async () => {
		const po = await sheetMetalPo();
		await setCharges(po.id, { shipping: "742.18", spread: "none" });
		await postForm(`/purchasing/po/${po.id}/send`, {});
		const page = await (await request(`/purchasing/po/${po.id}`)).text();
		expect(page).not.toContain("Landed unit cost");
		expect(page).not.toContain("Stock enters at the landed unit cost");
		expect(page).toContain("€1,707.88");
		await postForm(`/purchasing/po/${po.id}/receive`, { [`recv_${po.chassisLine}`]: "4" });
		expect(await receipts(po.chassis)).toEqual([{ qty_milli: 4_000, unit_cost_cents: 18_000 }]);
		expect(await (await request(`/purchasing/po/${po.id}`)).text()).toMatch(/Charges in stock value<\/td>.*€0\.00/s);
	});

	it("shows the supplier's price paid on the part, with the landed cost beside it", async () => {
		const po = await sheetMetalPo();
		await setCharges(po.id, { shipping: "742.18", discount: "6.30" });
		await postForm(`/purchasing/po/${po.id}/receive`, { [`recv_${po.chassisLine}`]: "4" });
		const prices = await (await request(`/parts/${po.chassis}/prices`)).text();
		expect(prices).toContain("Landed cost");
		expect(prices).toContain("€317.16");
		// Last paid to the supplier, on its offer: the line price, comparable with offers.
		const offers = prices.slice(prices.indexOf("Sheet Metal Co"), prices.indexOf('id="price-history"'));
		expect(offers).toContain("€180.00");
		expect(offers).not.toContain("€317.16");
	});
});
