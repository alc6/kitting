import { describe, expect, it } from "vitest";
import { marginHistory } from "../src/domain/margin-history";
import { isCalendarDate, pastPriceRuleErrors } from "../src/domain/past-prices";
import { standardCostsAt } from "../src/domain/prices";
import { revertChangeSet } from "../src/domain/revert";
import {
	insertPart,
	insertSupplier,
	letLowerRolesSeeCosts,
	NOT_ADMIN,
	one,
	postForm,
	request,
	rows,
	seedSql,
	setRole,
	stmt,
	TESTER,
	testDb,
} from "./helpers";

const today = () => new Date().toISOString().slice(0, 10);
const daysFromToday = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

/** A history row as the app would have written it (the series' "current" price). */
const historyRow = (
	partId: number,
	kind: "standard" | "purchase",
	cents: number,
	validFrom: string,
	supplierId?: number,
) =>
	stmt(
		`INSERT INTO price_history (part_id, kind, supplier_id, price_cents, valid_from, source, created_by, updated_by)
		 VALUES (?, ?, ?, ?, ?, 'form', 'seed', 'seed')`,
		partId,
		kind,
		supplierId ?? null,
		cents,
		validFrom,
	);

const form = (over: Record<string, string> = {}) => ({
	date: "2024-03-01",
	price: "3.00",
	supplier_id: "",
	note: "",
	...over,
});
const post = (id: number, data: Record<string, string>, overrides = {}) =>
	postForm(`/parts/${id}/prices/past`, data, overrides);

const countHistory = async () => (await one<{ n: number }>("SELECT COUNT(*) AS n FROM price_history")).n;

/** A buy part whose standard cost history is 5.00 since 2026-01-01. */
async function setup() {
	const id = await insertPart("RES-10K", "buy", { costCents: 500 });
	await seedSql(historyRow(id, "standard", 500, "2026-01-01"));
	return id;
}

describe("past price rules", () => {
	it("accepts real calendar dates only", () => {
		expect(isCalendarDate("2024-02-29")).toBe(true);
		expect(isCalendarDate("2025-02-29")).toBe(false);
		expect(isCalendarDate("2026-02-31")).toBe(false);
		expect(isCalendarDate("01/02/2024")).toBe(false);
	});

	const rule = (over: Partial<Parameters<typeof pastPriceRuleErrors>[0]> = {}) =>
		pastPriceRuleErrors({
			date: "2024-03-01",
			supplierId: null,
			partKind: "buy",
			series: { latest: "2026-01-01", dates: new Set(["2026-01-01"]) },
			today: "2026-10-13",
			...over,
		});

	it("needs a date before today, not taken, and before the latest row of the series", () => {
		expect(rule()).toEqual({});
		expect(rule({ date: "2026-10-13" })).toEqual({ date: "past_price_not_past" });
		expect(rule({ date: "2026-10-14" })).toEqual({ date: "past_price_not_past" });
		expect(rule({ date: "2026-06-01" })).toEqual({ date: "past_price_not_older" });
		expect(rule({ date: "2026-01-01" })).toEqual({ date: "duplicate_date" });
		expect(rule({ series: { latest: "2026-01-01", dates: new Set(["2026-01-01", "2024-03-01"]) } })).toEqual({
			date: "duplicate_date",
		});
	});

	it("allows any past date in a series without rows, and no supplier price for kits and fees", () => {
		expect(rule({ series: undefined, date: "2026-10-12" })).toEqual({});
		expect(rule({ supplierId: 3, partKind: "fee" })).toEqual({ supplier_id: "not_stocked" });
		expect(rule({ supplierId: 3, partKind: "make" })).toEqual({});
	});
});

describe("adding a past price from the part page", () => {
	it("adds a standard cost row, changes nothing current, and logs a change set without an amount", async () => {
		const id = await setup();
		const before = await one("SELECT * FROM parts WHERE id = ?", id);
		const res = await post(id, form({ price: "3,25", note: "Price list 2024" }));
		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toBe(`/parts/${id}/prices?ok=pastprice#price-history`);
		expect(
			await rows(
				"SELECT kind, supplier_id, price_cents, valid_from, source, note, created_by FROM price_history ORDER BY id",
			),
		).toEqual([
			{
				kind: "standard",
				supplier_id: null,
				price_cents: 500,
				valid_from: "2026-01-01",
				source: "form",
				note: "",
				created_by: "seed",
			},
			{
				kind: "standard",
				supplier_id: null,
				price_cents: 325,
				valid_from: "2024-03-01",
				source: "form",
				note: "Price list 2024",
				created_by: TESTER,
			},
		]);
		expect(await one("SELECT * FROM parts WHERE id = ?", id)).toEqual(before);
		const set = await one<{ summary: string; revertible: number; source: string; user_email: string }>(
			"SELECT summary, revertible, source, user_email FROM change_sets",
		);
		expect(set).toEqual({ summary: "Add a past price to RES-10K", revertible: 0, source: "ui", user_email: TESTER });
		expect(set.summary).not.toMatch(/\d\.\d/);
	});

	it("adds a supplier price without requiring an offer, and keeps the series apart", async () => {
		const id = await setup();
		const gone = await insertSupplier("Former Supplier");
		expect((await post(id, form({ supplier_id: String(gone), price: "2.80", date: "2023-05-01" }))).status).toBe(303);
		expect(
			await one("SELECT kind, supplier_id, price_cents, valid_from FROM price_history WHERE supplier_id IS NOT NULL"),
		).toEqual({
			kind: "purchase",
			supplier_id: gone,
			price_cents: 280,
			valid_from: "2023-05-01",
		});
		expect(await rows("SELECT * FROM part_suppliers")).toEqual([]);
		// Each series has its own latest row: 2025-01-01 is after the supplier's (2023-05-01) but before the
		// standard cost's (2026-01-01).
		expect((await post(id, form({ supplier_id: String(gone), date: "2025-01-01" }))).status).toBe(422);
		expect((await post(id, form({ date: "2025-01-01" }))).status).toBe(303);
	});

	it("shows the new row in date order whatever the insertion order, and in the chart's steps", async () => {
		const id = await setup();
		await post(id, form({ date: "2024-03-01", price: "3.00" }));
		await post(id, form({ date: "2025-06-15", price: "4.00" }));
		await post(id, form({ date: "2022-01-10", price: "2.00" }));
		const html = await (await request(`/parts/${id}/prices?ok=pastprice`)).text();
		expect(html).toContain("Past price added.");
		const at = (d: string) => html.indexOf(`>${d}</td>`);
		expect(at("2026-01-01")).toBeGreaterThan(-1);
		expect(at("2026-01-01")).toBeLessThan(at("2025-06-15"));
		expect(at("2025-06-15")).toBeLessThan(at("2024-03-01"));
		expect(at("2024-03-01")).toBeLessThan(at("2022-01-10"));
		expect(html).toContain("price-chart-title");
		expect(html).toContain("2022-01-10 · Standard cost");
		const list = await rows<{ valid_from: string }>("SELECT valid_from FROM price_history ORDER BY valid_from, id");
		expect(list.map((r) => r.valid_from)).toEqual(["2022-01-10", "2024-03-01", "2025-06-15", "2026-01-01"]);
	});

	it("accepts a price of zero", async () => {
		const id = await setup();
		expect((await post(id, form({ price: "0" }))).status).toBe(303);
		expect(await one("SELECT price_cents FROM price_history WHERE valid_from = '2024-03-01'")).toEqual({
			price_cents: 0,
		});
	});

	it.each([
		["today", () => form({ date: today() }), "The date must be before today."],
		["tomorrow", () => form({ date: daysFromToday(1) }), "The date must be before today."],
		[
			"a day after the current price",
			() => form({ date: "2026-01-02" }),
			"Only prices older than the current one can be added; change the current price on the part&#39;s form.",
		],
		["the date of the current price", () => form({ date: "2026-01-01" }), "already has a price on this date"],
		["a missing date", () => form({ date: "" }), "Required"],
		["an impossible date", () => form({ date: "2024-02-31" }), "YYYY-MM-DD"],
		["a missing price", () => form({ price: "" }), "Required"],
		["a bad price", () => form({ price: "abc" }), "Not a valid amount"],
		["a negative price", () => form({ price: "-1" }), "Must be zero or more"],
		["an unknown supplier", () => form({ supplier_id: "9999" }), "Invalid value"],
	])("refuses %s and writes nothing", async (_name, data, message) => {
		const id = await setup();
		const res = await post(id, data());
		expect(res.status).toBe(422);
		const html = await res.text();
		expect(html).toContain(message.replace("Required", ""));
		expect(html).toContain('data-invalid="true"');
		expect(await countHistory()).toBe(1);
		expect(await rows("SELECT * FROM change_sets")).toEqual([]);
	});

	it("keeps what was typed when it refuses", async () => {
		const id = await setup();
		const html = await (await post(id, form({ date: "2026-06-01", price: "7,77", note: "kept note" }))).text();
		expect(html).toContain('value="2026-06-01"');
		expect(html).toContain('value="7,77"');
		expect(html).toContain('value="kept note"');
		expect(html).toContain("<details");
	});

	it("refuses the same date twice for the same series", async () => {
		const id = await setup();
		expect((await post(id, form())).status).toBe(303);
		const again = await post(id, form({ price: "9" }));
		expect(again.status).toBe(422);
		expect(await again.text()).toContain("already has a price on this date");
		expect(await countHistory()).toBe(2);
	});

	it("refuses a supplier price for a part that is never purchased", async () => {
		const fee = await insertPart("SHIP", "fee", { costCents: 100 });
		const supplier = await insertSupplier("Carrier");
		const res = await post(fee, form({ supplier_id: String(supplier) }));
		expect(res.status).toBe(422);
		expect(await res.text()).toContain("never stocked");
		// Its standard cost can have a past price, in a series that has no row yet.
		expect((await post(fee, form())).status).toBe(303);
	});

	it("refuses a missing part", async () => {
		expect((await post(9999, form())).status).toBe(404);
	});

	it("is for planners: the form is shown to them only", async () => {
		const id = await setup();
		await setRole("planner");
		const html = await (await request(`/parts/${id}/prices`, {}, NOT_ADMIN)).text();
		expect(html).toContain(`action="/parts/${id}/prices/past#price-history"`);
		expect((await post(id, form(), NOT_ADMIN)).status).toBe(303);

		await letLowerRolesSeeCosts();
		for (const role of ["operator", "viewer"] as const) {
			await setRole(role);
			const page = await request(`/parts/${id}/prices`, {}, NOT_ADMIN);
			expect(page.status).toBe(200);
			const body = await page.text();
			expect(body).toContain("Price history");
			expect(body).not.toContain("/prices/past");
			expect((await post(id, form({ date: "2020-01-01" }), NOT_ADMIN)).status).toBe(403);
		}
		expect(await countHistory()).toBe(2);
	});

	it("shows neither the form nor the amounts to someone who may not see costs", async () => {
		const id = await setup();
		await setRole("operator");
		const body = await (await request(`/parts/${id}/prices`, {}, NOT_ADMIN)).text();
		expect(body).not.toContain("Price history");
		expect(body).not.toContain("/prices/past");
		expect((await post(id, form(), NOT_ADMIN)).status).toBe(403);
	});
});

describe("what a past price changes", () => {
	it("feeds the dated standard cost and the margin history, and no current value", async () => {
		const id = await setup();
		await seedSql(
			stmt("UPDATE parts SET sale_price_cents = 1000 WHERE id = ?", id),
			stmt(
				`INSERT INTO price_history (part_id, kind, price_cents, valid_from, source, created_by, updated_by)
				 VALUES (?, 'sale', 1000, '2026-01-01', 'form', 'seed', 'seed')`,
				id,
			),
		);
		const db = testDb();
		// Before: nothing older than the first row, so the first value is used (flagged as a fallback).
		const before = await standardCostsAt(db, "2025-06-01");
		expect(before.costs.get(id)).toBe(500);
		expect(before.fallback.has(id)).toBe(true);

		expect((await post(id, form({ date: "2025-01-01", price: "3.00" }))).status).toBe(303);
		const after = await standardCostsAt(db, "2025-06-01");
		expect(after.costs.get(id)).toBe(300);
		expect(after.fallback.has(id)).toBe(false);
		expect((await standardCostsAt(db, "2026-02-01")).costs.get(id)).toBe(500);
		// Before the first row of the series the first value still stands in.
		expect((await standardCostsAt(db, "2024-01-01")).costs.get(id)).toBe(300);

		const history = await marginHistory(db, { partId: id, assemblyId: null });
		expect(history?.planned.map((p) => [p.date, p.costCents])).toEqual([
			["2025-01-01", 300],
			["2026-01-01", 500],
		]);
		expect(await one("SELECT cost_cents FROM parts WHERE id = ?", id)).toEqual({ cost_cents: 500 });
	});
});

describe("undo", () => {
	it("is refused: the price history is append-only (D92), so the change set is not revertible", async () => {
		const id = await setup();
		await post(id, form({ price: "7.77" }));
		const set = await one<{ id: number }>("SELECT id FROM change_sets");
		expect(
			await revertChangeSet(testDb(), { role: "admin", seeCosts: true }, set.id, {
				user: TESTER,
				summary: () => "Undo",
			}),
		).toEqual({
			ok: false,
			reason: "not_revertible",
		});
		const res = await postForm(`/history/${set.id}/revert`, {});
		expect(res.status).toBe(409);
		expect(await countHistory()).toBe(2);
		// It is listed in the history, without the amount.
		const list = await (await request("/history")).text();
		expect(list).toContain("Add a past price to RES-10K");
		expect(list).toContain("Cannot be undone");
		expect(list).not.toContain("7.77");
	});
});

describe("deleting a wrong row of the price history (D143)", () => {
	const del = (partId: number, priceId: number, overrides = {}) =>
		postForm(`/parts/${partId}/prices/${priceId}/delete`, {}, overrides);
	const priceId = async (validFrom: string, supplierId?: number) =>
		(
			await one<{ id: number }>(
				"SELECT id FROM price_history WHERE valid_from = ? AND supplier_id IS ?",
				validFrom,
				supplierId ?? null,
			)
		).id;
	/** setup() plus a wrong past price of 9.99 on 2024-03-01. */
	async function withTypo() {
		const id = await setup();
		await post(id, form({ price: "9.99" }));
		return id;
	}
	const location = (res: Response) => res.headers.get("Location");

	it("deletes an old row as an administrator: one change set naming the part and the date, no amount", async () => {
		const id = await withTypo();
		const row = await priceId("2024-03-01");
		const res = await del(id, row);
		expect(res.status).toBe(303);
		expect(location(res)).toBe(`/parts/${id}/prices?ok=pricedeleted#price-history`);
		expect(await rows("SELECT valid_from, price_cents FROM price_history")).toEqual([
			{ valid_from: "2026-01-01", price_cents: 500 },
		]);
		const sets = await rows<{ summary: string; revertible: number; source: string; user_email: string }>(
			"SELECT summary, revertible, source, user_email FROM change_sets ORDER BY id",
		);
		expect(sets.at(-1)).toEqual({
			summary: "Delete the 2024-03-01 price of RES-10K",
			revertible: 0,
			source: "ui",
			user_email: TESTER,
		});
		expect(sets.at(-1)?.summary).not.toMatch(/\d\.\d/);
		expect(await one("SELECT cost_cents FROM parts WHERE id = ?", id)).toEqual({ cost_cents: 500 });
		const page = await (await request(`/parts/${id}/prices?ok=pricedeleted`)).text();
		expect(page).toContain("Price deleted from the history.");
	});

	it("refuses the latest row of its series and says to change the current price instead", async () => {
		const id = await withTypo();
		const res = await del(id, await priceId("2026-01-01"));
		expect(res.status).toBe(303);
		expect(location(res)).toBe(`/parts/${id}/prices?err=price_is_current#price-history`);
		expect(await countHistory()).toBe(2);
		expect((await rows("SELECT * FROM change_sets")).length).toBe(1);
		const page = await (await request(`/parts/${id}/prices?err=price_is_current`)).text();
		expect(page).toContain("Change the current price on the part&#39;s form instead.");
	});

	it("keeps the series apart: each has its own current row", async () => {
		const id = await setup();
		const supplier = await insertSupplier("Former Supplier");
		await seedSql(
			historyRow(id, "purchase", 280, "2023-05-01", supplier),
			historyRow(id, "purchase", 290, "2024-05-01", supplier),
		);
		// The standard cost is newer than every supplier row, yet the latest supplier row is still current.
		expect(location(await del(id, await priceId("2024-05-01", supplier)))).toContain("err=price_is_current");
		expect(location(await del(id, await priceId("2023-05-01", supplier)))).toContain("ok=pricedeleted");
		// The only standard row is current, whatever the supplier rows say.
		expect(location(await del(id, await priceId("2026-01-01")))).toContain("err=price_is_current");
		expect(await countHistory()).toBe(2);
	});

	it("orders rows of the same date by id: only the last one is current", async () => {
		const id = await setup();
		await seedSql(historyRow(id, "standard", 600, "2026-01-01"));
		const [first, second] = (await rows<{ id: number }>("SELECT id FROM price_history ORDER BY id")).map((r) => r.id);
		expect(location(await del(id, second as number))).toContain("err=price_is_current");
		expect(location(await del(id, first as number))).toContain("ok=pricedeleted");
		expect(await rows("SELECT price_cents FROM price_history")).toEqual([{ price_cents: 600 }]);
	});

	it("does not cover selling prices", async () => {
		const id = await setup();
		await seedSql(
			stmt(
				`INSERT INTO price_history (part_id, kind, price_cents, valid_from, source, created_by, updated_by)
				 VALUES (?, 'sale', 1000, '2025-01-01', 'form', 'seed', 'seed'), (?, 'sale', 1200, '2026-01-01', 'form', 'seed', 'seed')`,
				id,
				id,
			),
		);
		const res = await del(id, await priceId("2025-01-01"));
		expect(location(res)).toBe(`/parts/${id}/prices?err=price_not_deletable#price-history`);
		expect(await countHistory()).toBe(3);
		// And no button is shown for it: only the standard cost row has one.
		expect((await (await request(`/parts/${id}/prices`)).text()).match(/\/prices\/\d+\/delete"/g)?.length).toBe(1);
	});

	it("is a 404 for a row of another part or that does not exist, and writes nothing", async () => {
		const id = await withTypo();
		const other = await insertPart("CAP-1U", "buy", { costCents: 10 });
		await seedSql(historyRow(other, "standard", 10, "2025-01-01"), historyRow(other, "standard", 12, "2026-01-01"));
		const theirs = (
			await one<{ id: number }>("SELECT id FROM price_history WHERE part_id = ? AND price_cents = 10", other)
		).id;
		expect((await del(id, theirs)).status).toBe(404);
		expect((await del(id, 9999)).status).toBe(404);
		expect((await del(9999, await priceId("2024-03-01"))).status).toBe(404);
		expect(await countHistory()).toBe(4);
	});

	it("is for administrators: planners and operators get a 403 and see no delete button", async () => {
		const id = await withTypo();
		const row = await priceId("2024-03-01");
		const adminPage = await (await request(`/parts/${id}/prices`)).text();
		expect(adminPage).toContain(`action="/parts/${id}/prices/${row}/delete"`);
		// One button per standard cost or supplier price row.
		expect(adminPage.match(/\/prices\/\d+\/delete"/g)?.length).toBe(2);

		await letLowerRolesSeeCosts();
		for (const role of ["planner", "operator", "viewer"] as const) {
			await setRole(role);
			const page = await request(`/parts/${id}/prices`, {}, NOT_ADMIN);
			expect(page.status).toBe(200);
			expect(await page.text()).not.toMatch(/\/prices\/\d+\/delete/);
			expect((await del(id, row, NOT_ADMIN)).status).toBe(403);
		}
		expect(await countHistory()).toBe(2);
	});

	it("no longer feeds the dated standard cost or the margin history, and the date can be added again", async () => {
		const id = await withTypo();
		await seedSql(
			stmt("UPDATE parts SET sale_price_cents = 1000 WHERE id = ?", id),
			stmt(
				`INSERT INTO price_history (part_id, kind, price_cents, valid_from, source, created_by, updated_by)
				 VALUES (?, 'sale', 1000, '2026-01-01', 'form', 'seed', 'seed')`,
				id,
			),
		);
		const db = testDb();
		const plannedCosts = async () =>
			(await marginHistory(db, { partId: id, assemblyId: null }))?.planned.map((p) => [p.date, p.costCents]);
		expect((await standardCostsAt(db, "2025-06-01")).costs.get(id)).toBe(999);
		expect(await plannedCosts()).toEqual([
			["2024-03-01", 999],
			["2026-01-01", 500],
		]);

		expect(location(await del(id, await priceId("2024-03-01")))).toContain("ok=pricedeleted");
		// Only the first row is left, so the dated cost falls back to it (flagged), as before any past price.
		const after = await standardCostsAt(db, "2025-06-01");
		expect(after.costs.get(id)).toBe(500);
		expect(after.fallback.has(id)).toBe(true);
		expect(await plannedCosts()).toEqual([["2026-01-01", 500]]);

		// The date is free again.
		expect((await post(id, form({ price: "3.00" }))).status).toBe(303);
		expect(await one("SELECT price_cents FROM price_history WHERE valid_from = '2024-03-01'")).toEqual({
			price_cents: 300,
		});
	});

	it("is listed in the history and cannot be undone", async () => {
		const id = await withTypo();
		await del(id, await priceId("2024-03-01"));
		const set = await one<{ id: number }>("SELECT max(id) AS id FROM change_sets");
		expect(
			await revertChangeSet(testDb(), { role: "admin", seeCosts: true }, set.id, {
				user: TESTER,
				summary: () => "Undo",
			}),
		).toEqual({ ok: false, reason: "not_revertible" });
		expect((await postForm(`/history/${set.id}/revert`, {})).status).toBe(409);
		const list = await (await request("/history")).text();
		expect(list).toContain("Delete the 2024-03-01 price of RES-10K");
		expect(list).toContain("Cannot be undone");
		expect(list).not.toContain("9.99");
		expect(await countHistory()).toBe(1);
	});
});
