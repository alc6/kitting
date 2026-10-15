import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { belowMinimum } from "../src/domain/stock";
import {
	changeSql,
	insertMove,
	insertPart,
	loadDemo,
	NOT_ADMIN,
	one,
	partId,
	postForm,
	request,
	rows,
	setRole,
	stmt,
	TESTER,
} from "./helpers";

// NOT_ADMIN requests run as a planner, so admin-only actions are refused by requireAdmin itself.
beforeEach(() => setRole("planner"));

const onHand = async (id: number) =>
	(await one<{ q: number | null }>("SELECT SUM(qty_milli) AS q FROM stock_moves WHERE part_id = ?", id)).q ?? 0;

describe("adjustments", () => {
	it("posts an adjust move with the reason and the user", async () => {
		const id = await insertPart("BOLT", "buy", { costCents: 12 });
		const res = await postForm("/stock/adjust", { part: "BOLT", qty: "-2,5", serial: "", note: "dropped" });
		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toBe(`/parts/${id}/stock?ok=adjusted`);
		expect(await one("SELECT qty_milli, reason, ref_type, note, by, unit_cost_cents FROM stock_moves")).toEqual({
			qty_milli: -2500,
			reason: "adjust",
			ref_type: "adjustment",
			note: "dropped",
			by: TESTER,
			unit_cost_cents: 12,
		});
		expect(await (await request(`/parts/${id}/stock?ok=adjusted`)).text()).toContain("Stock adjusted.");
	});

	it("refuses kits, fees, zero, unknown parts and multi-unit serial moves", async () => {
		await insertPart("KIT", "kit");
		await insertPart("LED", "buy", { trackSerial: true });
		const kit = await (await postForm("/stock/adjust", { part: "KIT", qty: "1", serial: "", note: "x" })).text();
		expect(kit).toContain("kit parts are never stocked.");
		const zero = await postForm("/stock/adjust", { part: "LED", qty: "0", serial: "", note: "x" });
		expect(zero.status).toBe(422);
		expect(await zero.text()).toContain("Must not be zero.");
		const serial = await (await postForm("/stock/adjust", { part: "LED", qty: "2", serial: "S1", note: "x" })).text();
		expect(serial).toContain("the quantity must be 1 or -1");
		const noNote = await (await postForm("/stock/adjust", { part: "LED", qty: "1", serial: "S1", note: "" })).text();
		expect(noNote).toContain("Required.");
		expect(await (await postForm("/stock/adjust", { part: "NOPE", qty: "1", serial: "", note: "x" })).text()).toContain(
			"Unknown part reference “NOPE”.",
		);
		expect(await rows("SELECT id FROM stock_moves")).toEqual([]);
		expect((await postForm("/stock/adjust", { part: "LED", qty: "1", serial: "S1", note: "found" })).status).toBe(303);
		expect(await one("SELECT serial FROM stock_moves")).toEqual({ serial: "S1" });
	});
});

describe("inventory count", () => {
	it("posts count moves for the differences only", async () => {
		const a = await insertPart("A", "buy");
		const b = await insertPart("B", "buy");
		const c = await insertPart("C", "buy");
		await insertMove(a, 5000);
		await insertMove(b, 3000);
		const res = await postForm("/stock/count", {
			[`count_${a}`]: "7",
			[`count_${b}`]: "3",
			[`count_${c}`]: "",
			note: "year-end count",
		});
		expect(res.headers.get("Location")).toBe("/stock/count?done=2&adjusted=1");
		expect(await onHand(a)).toBe(7000);
		expect(await onHand(b)).toBe(3000);
		expect(await rows("SELECT qty_milli, reason, note FROM stock_moves WHERE reason = 'count'")).toEqual([
			{ qty_milli: 2000, reason: "count", note: "year-end count" },
		]);
		expect(await (await request("/stock/count?done=2&adjusted=1")).text()).toContain("2 part(s) counted, 1 adjusted.");
	});

	it("re-renders with errors for invalid quantities and writes nothing", async () => {
		const a = await insertPart("A", "buy");
		const res = await postForm("/stock/count", { [`count_${a}`]: "abc", note: "" });
		expect(res.status).toBe(422);
		const html = await res.text();
		expect(html).toContain("Not a valid quantity");
		expect(html).toContain('value="abc"');
		expect(await rows("SELECT id FROM stock_moves")).toEqual([]);
	});
});

describe("on-hand list and ledger", () => {
	it("filters parts below zero and below their minimum stock", async () => {
		const neg = await insertPart("NEG", "buy");
		const low = await insertPart("LOW", "buy", { minStockMilli: 10_000 });
		const ok = await insertPart("OK", "buy", { minStockMilli: 1000 });
		// A supplier's MOQ is not a reorder level: with no minimum stock the part never alerts.
		const moqOnly = await insertPart("MOQONLY", "buy", { moqMilli: 100_000 });
		await insertPart("KITTY", "kit");
		await insertMove(neg, -1000);
		await insertMove(low, 2000);
		await insertMove(ok, 5000);
		await insertMove(moqOnly, 1000);
		const all = await (await request("/stock")).text();
		expect(all).toContain("NEG");
		expect(all).not.toContain("KITTY");
		const below = await (await request("/stock?filter=below_zero")).text();
		expect(below).toContain("NEG");
		expect(below).not.toContain(">LOW<");
		const min = await (await request("/stock?filter=below_min")).text();
		expect(min).toContain(">LOW<");
		expect(min).toContain("Below minimum");
		expect(min).not.toContain(">OK<");
		expect(min).not.toContain(">MOQONLY<");
		expect(min).not.toContain(">NEG<");
		// The list flags only the part under its minimum, not the one under a supplier's MOQ.
		const list = await (await request("/stock")).text();
		expect(list.match(/Below minimum/g)).toHaveLength(2); // the filter option and LOW's badge
	});

	it("applies the alert rule: a set minimum, a stocked kind, on hand strictly under it", () => {
		const part = { kind: "buy" as const, minStockMilli: 5000, onHandMilli: 4999 };
		expect(belowMinimum(part)).toBe(true);
		expect(belowMinimum({ ...part, onHandMilli: 5000 })).toBe(false);
		expect(belowMinimum({ ...part, minStockMilli: null })).toBe(false);
		expect(belowMinimum({ ...part, minStockMilli: 0, onHandMilli: 0 })).toBe(false);
		expect(belowMinimum({ ...part, minStockMilli: 0, onHandMilli: -1 })).toBe(true);
		expect(belowMinimum({ ...part, kind: "kit" })).toBe(false);
	});

	it("shows the dashboard alerts for a minimum, not for a MOQ", async () => {
		const low = await insertPart("LOW", "buy", { minStockMilli: 10_000 });
		const neg = await insertPart("NEG", "make", { minStockMilli: 3000 });
		const moqOnly = await insertPart("MOQONLY", "buy", { moqMilli: 100_000 });
		await insertMove(low, 2000);
		await insertMove(neg, -1000);
		await insertMove(moqOnly, 1000);
		const html = await (await request("/")).text();
		expect(html).toContain(`/parts/${low}`);
		expect(html).toContain("Below minimum");
		// A negative part is reported once, as below zero.
		expect(html).toContain(`/parts/${neg}`);
		expect(html.match(new RegExp(`/parts/${neg}"`, "g"))).toHaveLength(1);
		expect(html).not.toContain(`/parts/${moqOnly}`);
		expect(html).not.toContain("Below MOQ");
	});

	it("lists moves with filters and exports them", async () => {
		const a = await insertPart("A", "buy");
		await insertMove(a, 1000, "count", "LOT-7");
		await insertMove(a, -500, "adjust");
		const html = await (await request("/stock/moves?reason=count")).text();
		expect(html).toContain("LOT-7");
		expect(html).toContain("Inventory count");
		expect(html).not.toContain("Adjustment</span>");
		const csv = await (await request("/stock/moves?format=csv")).text();
		expect(csv.split("\r\n")[0]).toBe("at,ref,name,reason,qty,unit,serial,unit_cost,ref_type,ref_id,by,note,options");
		expect(csv).toContain(",A,Part A,adjust,-0.5,pcs,");
	});
});

describe("valuation", () => {
	it("values buy parts at standard cost and make parts at the assembly roll-up", async () => {
		await loadDemo();
		const html = await (await request("/stock/valuation")).text();
		// 2 arms x €4.5375 (roll-up) = €9.075 -> €9.08
		expect(html).toMatch(/ARM-ASSY<\/a>.*?assembly roll-up.*?€4\.54.*?€9\.08/s);
		expect(html).toContain("Some parts have no cost"); // MANUAL
		const csv = await (await request("/stock/valuation?format=csv")).text();
		expect(csv).toContain("ARM-ASSY,Arm sub-assembly,make,pcs,2,4.54,rollup,9.08,");
		expect(csv).toContain("CABLE-2C,2-core cable 0.75mm²,buy,m,42.5,0.45,standard,19.13,");
	});

	it("computes on-hand as of a date", async () => {
		const a = await insertPart("A", "buy", { costCents: 100 });
		await env.DB.prepare(
			"INSERT INTO stock_moves (part_id, qty_milli, reason, at, by, created_by, updated_by) VALUES (?, 4000, 'count', '2025-12-31T18:00:00.000Z', 'x', 'x', 'x')",
		)
			.bind(a)
			.run();
		await insertMove(a, 6000);
		expect(await (await request("/stock/valuation?at=2025-12-31&format=csv")).text()).toContain(
			"A,Part A,buy,pcs,4,1.00,standard,4.00,",
		);
		expect(await (await request("/stock/valuation?format=csv")).text()).toContain(
			"A,Part A,buy,pcs,10,1.00,standard,10.00,",
		);
	});
});

describe("JSON backup and restore", () => {
	it("round-trips the whole database", async () => {
		await loadDemo();
		await postForm("/stock/adjust", { part: "BOX-LAMP", qty: "-1", serial: "", note: "crushed" });
		const minBefore = await rows(
			"SELECT ref, min_stock_milli FROM parts WHERE min_stock_milli IS NOT NULL ORDER BY ref",
		);
		expect(minBefore.length).toBeGreaterThan(0);
		const backupRes = await request("/import/backup.json");
		expect(backupRes.headers.get("Content-Disposition")).toContain("kitting-backup-");
		const json = await backupRes.text();
		const backup = JSON.parse(json);
		expect(backup.format).toBe("kitting-backup");
		expect(backup.tables.parts).toHaveLength(30);
		expect(backup.tables.part_options).toHaveLength(3);
		expect(backup.tables.part_option_values).toHaveLength(6);
		expect(backup.tables.machine_types).toHaveLength(1);
		expect(backup.tables.machines).toHaveLength(3);
		expect(backup.tables.machine_rate_history).toHaveLength(1);
		const before = await rows("SELECT * FROM stock_moves ORDER BY id");

		// Wreck the data, then restore.
		await changeSql("Wreck", stmt("DELETE FROM stock_moves"), stmt("UPDATE parts SET name = 'broken'"));
		const form = new FormData();
		form.set("file", new File([json], "backup.json", { type: "application/json" }));
		const preview = await request("/import/restore/preview", { method: "POST", body: form });
		expect(preview.status).toBe(200);
		const html = await preview.text();
		expect(html).toContain("Replace all data with this backup");
		const res = await postForm("/import/restore/commit", { json });
		expect(res.headers.get("Location")).toBe("/import?restored=1");
		expect(await rows("SELECT * FROM stock_moves ORDER BY id")).toEqual(before);
		expect(await one("SELECT name FROM parts WHERE id = ?", await partId("LAMP-DESK"))).toEqual({
			name: "Modular desk lamp",
		});
		expect(await rows("SELECT ref, min_stock_milli FROM parts WHERE min_stock_milli IS NOT NULL ORDER BY ref")).toEqual(
			minBefore,
		);
		expect(await one("SELECT count(*) AS n FROM assembly_lines")).toEqual({ n: 49 });
		expect(await one("SELECT count(*) AS n FROM part_option_values")).toEqual({ n: 6 });
		expect(await one("SELECT machine_minutes FROM assemblies WHERE machine_type_id IS NOT NULL")).toEqual({
			machine_minutes: 190,
		});
	});

	it("rejects foreign files, unknown columns and other schema versions; admin only", async () => {
		const bad = await postForm("/import/restore/commit", { json: "{nope" });
		expect(bad.status).toBe(422);
		expect(await bad.text()).toContain("Not a valid JSON file.");
		const backup = JSON.parse(await (await request("/import/backup.json")).text());
		backup.tables.parts = [{ id: 1, ref: "X", evil: "1" }];
		expect(await (await postForm("/import/restore/commit", { json: JSON.stringify(backup) })).text()).toContain(
			"unknown column &quot;evil&quot;",
		);
		backup.tables.parts = [];
		backup.migration = "9999_future";
		expect(await (await postForm("/import/restore/commit", { json: JSON.stringify(backup) })).text()).toContain(
			"Schema mismatch",
		);
		expect((await postForm("/import/restore/commit", { json: "{}" }, NOT_ADMIN)).status).toBe(403);
	});
});
