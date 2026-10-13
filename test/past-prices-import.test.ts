import { beforeEach, describe, expect, it } from "vitest";
import { planImport } from "../src/domain/import";
import {
	insertPart,
	insertSupplier,
	NOT_ADMIN,
	one,
	postForm,
	request,
	rows,
	seedSql,
	setRole,
	stmt,
	testDb,
} from "./helpers";

const preview = (csv: string, overrides = {}) => postForm("/import/price_history/preview", { csv }, overrides);
const commit = (csv: string, overrides = {}) => postForm("/import/price_history/commit", { csv }, overrides);
const today = () => new Date().toISOString().slice(0, 10);

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

/** RES-10K (buy, 5.00 since 2026-01-01), Acme (offer 4.00 since 2026-02-01) and SHIP (a fee). */
async function setup() {
	const acme = await insertSupplier("Acme");
	const part = await insertPart("RES-10K", "buy", { costCents: 500, supplierId: acme, offerPriceCents: 400 });
	const fee = await insertPart("SHIP", "fee", { costCents: 100 });
	await seedSql(
		historyRow(part, "standard", 500, "2026-01-01"),
		historyRow(part, "purchase", 400, "2026-02-01", acme),
		stmt(
			`INSERT INTO price_history (part_id, kind, price_cents, valid_from, source, created_by, updated_by)
			 VALUES (?, 'sale', 900, '2020-01-01', 'form', 'seed', 'seed')`,
			part,
		),
	);
	return { acme, part, fee };
}

const HEADER = "ref,price,valid_from,supplier,note\n";
const count = async () => (await one<{ n: number }>("SELECT COUNT(*) AS n FROM price_history")).n;

// Requests run as a planner (not in ADMIN_EMAILS): previews are allowed, commits are admin actions.
beforeEach(() => setRole("planner"));

describe("past prices import", () => {
	it("previews rows, then commits them without touching any current value", async () => {
		const { acme } = await setup();
		const before = await rows("SELECT * FROM parts ORDER BY id");
		const offers = await rows("SELECT * FROM part_suppliers ORDER BY part_id");
		const csv = `${HEADER}RES-10K,3.00,2024-03-01,,Before Kitting\nRES-10K,"2,50",2023-01-15,Acme,2023 quote\n`;
		const p = await preview(csv, NOT_ADMIN);
		expect(p.status).toBe(200);
		const html = await p.text();
		expect(html).toContain("2024-03-01");
		expect(html).toContain("Acme");
		expect(html).toContain("2 to create");

		// Commit is an admin action.
		expect((await commit(csv, NOT_ADMIN)).status).toBe(403);
		expect(await count()).toBe(3);

		const res = await commit(csv);
		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toBe("/import?done=price_history&create=2&update=0");
		expect(
			await rows(
				"SELECT kind, supplier_id, price_cents, valid_from, source, note FROM price_history WHERE source = 'import' ORDER BY valid_from",
			),
		).toEqual([
			{
				kind: "purchase",
				supplier_id: acme,
				price_cents: 250,
				valid_from: "2023-01-15",
				source: "import",
				note: "2023 quote",
			},
			{
				kind: "standard",
				supplier_id: null,
				price_cents: 300,
				valid_from: "2024-03-01",
				source: "import",
				note: "Before Kitting",
			},
		]);
		expect(await rows("SELECT * FROM parts ORDER BY id")).toEqual(before);
		expect(await rows("SELECT * FROM part_suppliers ORDER BY part_id")).toEqual(offers);
		// One change set, kept although no tracked row changed; it cannot be undone (D142).
		expect(await one("SELECT summary, source, revertible FROM change_sets")).toEqual({
			summary: "Import price_history.csv: 2 created, 0 updated",
			source: "import",
			revertible: 0,
		});
	});

	it("accepts a French spreadsheet: semicolons and decimal commas", async () => {
		await setup();
		const csv = "ref;price;valid_from;supplier;note\nRES-10K;3,25;2024-03-01;;\n";
		expect((await commit(csv)).status).toBe(303);
		expect(await one("SELECT price_cents FROM price_history WHERE valid_from = '2024-03-01'")).toEqual({
			price_cents: 325,
		});
	});

	it("takes the rows in any order, each compared with the database only", async () => {
		await setup();
		const csv = `${HEADER}RES-10K,1,2025-12-31,,\nRES-10K,2,2020-05-05,,\nRES-10K,3,2024-01-01,,\n`;
		expect((await commit(csv)).status).toBe(303);
		expect(await count()).toBe(6);
	});

	it("reports every problem with its line and column, and writes nothing", async () => {
		await setup();
		const csv = [
			HEADER.trim(),
			"NOPE,1.00,2024-01-01,,", // 2 unknown part
			"RES-10K,1.00,2024-01-01,Nobody,", // 3 unknown supplier
			"RES-10K,1.00,2024-13-01,,", // 4 bad date
			"RES-10K,1.00,2024-02-31,,", // 5 impossible date
			`RES-10K,1.00,${today()},,`, // 6 today
			"RES-10K,1.00,2999-01-01,,", // 7 future
			"RES-10K,1.00,2026-01-02,,", // 8 after the current price
			"RES-10K,1.00,2026-01-01,,", // 9 the date of the current price
			"RES-10K,,2024-01-01,,", // 10 no price
			"RES-10K,abc,2024-01-01,,", // 11 bad price
			"RES-10K,1.00,,,", // 12 no date
			"SHIP,1.00,2024-01-01,Acme,", // 13 supplier price for a fee
			"RES-10K,1.00,2026-02-02,Acme,", // 14 after the offer's current price
			"",
		].join("\n");
		const p = await preview(csv, NOT_ADMIN);
		expect(p.status).toBe(422);
		const html = await p.text();
		for (const message of [
			"Unknown part reference",
			"Unknown supplier",
			"Use the YYYY-MM-DD format.",
			"The date must be before today.",
			"Only prices older than the current one can be added",
			"already has a price on this date",
			"Not a valid amount",
			"never stocked",
		])
			expect(html).toContain(message);
		const plan = await planImport({ db: testDb(), locale: "en" }, "price_history", csv);
		expect(plan?.errors.map((e) => [e.line, e.column, e.key])).toEqual([
			[2, "ref", "unknown_part"],
			[3, "supplier", "unknown_supplier"],
			[4, "valid_from", "invalid_date"],
			[5, "valid_from", "invalid_date"],
			[6, "valid_from", "past_price_not_past"],
			[7, "valid_from", "past_price_not_past"],
			[8, "valid_from", "past_price_not_older"],
			[9, "valid_from", "duplicate_date"],
			[10, "price", "required"],
			[11, "price", "invalid_money"],
			[12, "valid_from", "required"],
			[13, "supplier", "not_stocked"],
			[14, "valid_from", "past_price_not_older"],
		]);
		const res = await commit(csv);
		expect(res.status).toBe(422);
		expect(await count()).toBe(3);
		expect(await rows("SELECT * FROM change_sets")).toEqual([]);
	});

	it("is atomic: one wrong row keeps the valid ones out", async () => {
		await setup();
		const csv = `${HEADER}RES-10K,1.00,2024-01-01,,\nRES-10K,1.00,2999-01-01,,\n`;
		expect((await commit(csv)).status).toBe(422);
		expect(await count()).toBe(3);
	});

	it("refuses the same date twice in the file, per series", async () => {
		await setup();
		const csv = `${HEADER}RES-10K,1.00,2024-01-01,,\nRES-10K,2.00,2024-01-01,Acme,\nRES-10K,3.00,2024-01-01,,\nRES-10K,4.00,2024-01-01,acme,\n`;
		const plan = await planImport({ db: testDb(), locale: "en" }, "price_history", csv);
		// Lines 2 and 3 are different series; 4 repeats line 2 (the supplier is matched without case) and 5 repeats 3...
		expect(plan?.errors.map((e) => [e.line, e.key, e.vars])).toEqual([
			[4, "duplicate_in_file", { line: 2 }],
			[5, "duplicate_in_file", { line: 3 }],
		]);
		expect(plan?.rows.map((r) => r.line)).toEqual([2, 3]);
	});

	it("needs the ref, price and valid_from columns", async () => {
		await setup();
		const plan = await planImport({ db: testDb(), locale: "en" }, "price_history", "ref,price\nRES-10K,1\n");
		expect(plan?.errors.map((e) => [e.line, e.column, e.key])).toEqual([[1, "valid_from", "missing_column"]]);
		const empty = await planImport({ db: testDb(), locale: "en" }, "price_history", "");
		expect(empty?.errors.map((e) => e.key)).toEqual(["empty_file"]);
	});

	it("serves a template and exports the standard cost and offer price rows only", async () => {
		await setup();
		const template = await (await request("/import/price_history/template.csv", {}, NOT_ADMIN)).text();
		expect(template.split("\r\n")[0]).toBe("ref,price,valid_from,supplier,note");
		const res = await request("/import/price_history/export.csv", {}, NOT_ADMIN);
		expect(res.status).toBe(200);
		expect((await res.text()).trim().split("\r\n")).toEqual([
			"ref,price,valid_from,supplier,note",
			"RES-10K,5.00,2026-01-01,,",
			"RES-10K,4.00,2026-02-01,Acme,",
		]);
		// What is exported is already in the history: importing it again is refused row by row.
		const again = await planImport(
			{ db: testDb(), locale: "en" },
			"price_history",
			"ref,price,valid_from,supplier,note\nRES-10K,5,2026-01-01,,\n",
		);
		expect(again?.errors.map((e) => e.key)).toEqual(["duplicate_date"]);
	});

	it("is listed on the import page after the supplier offers", async () => {
		const html = await (await request("/import", {}, NOT_ADMIN)).text();
		const order = [
			"import-suppliers",
			"import-parts",
			"import-part_suppliers",
			"import-price_history",
			"import-assemblies",
			"import-stock",
		];
		const positions = order.map((id) => html.indexOf(`id="${id}"`));
		expect(positions.every((p) => p > -1)).toBe(true);
		expect([...positions].sort((a, b) => a - b)).toEqual(positions);
		expect(html).toContain("Past prices");
	});
});
