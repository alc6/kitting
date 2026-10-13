import { beforeEach, describe, expect, it } from "vitest";
import {
	bomId,
	importCsv,
	insertPart,
	letLowerRolesSeeCosts,
	loadDemo,
	NOT_ADMIN,
	one,
	partId,
	postForm,
	request,
	seedSql,
	setRole,
	stmt,
} from "./helpers";
import { callTool, connect, resetKv } from "./mcp-helpers";

const ALL = ["catalog:read", "stock:read", "builds:read", "purchasing:read"];

beforeEach(async () => {
	await resetKv();
});

async function planBuild(ref: string, opts: { serial?: string; qty?: string } = {}): Promise<number> {
	const res = await postForm("/builds", {
		part_id: String(await partId(ref)),
		bom_id: String(await bomId(ref)),
		qty: opts.qty ?? "1",
		serial: opts.serial ?? "",
		planned_for: "",
		notes: "",
	});
	expect(res.status).toBe(303);
	return Number(/\/builds\/(\d+)/.exec(res.headers.get("Location") ?? "")?.[1]);
}

const buildNumber = async (id: number) =>
	(await one<{ number: string }>("SELECT number FROM builds WHERE id = ?", id)).number;

// Distinctive amounts (as on the costs-hidden sweep): none may reach a user who does not see costs.
const COST = 123456; // standard cost of BOX-LAMP
const OFFER = 111111; // its offer price
const SALE = 999999; // selling price of LAMP-DESK
const AMOUNTS = ["1234.56", "1111.11", "9999.99", "987.65", "9876.50"];

/**
 * Demo data, the amounts above, a lamp built with serial components, a WIDGET (one BOX-LAMP each) with an open
 * build of 100 (a shortage), and a PO of 10 BOX-LAMP at 987.65, 4 received.
 */
async function seed() {
	await loadDemo();
	const box = await partId("BOX-LAMP");
	// Fixture prices, written outside the change history (as a restore would).
	await seedSql(
		stmt("UPDATE parts SET cost_cents = ? WHERE id = ?", COST, box),
		stmt("UPDATE part_suppliers SET price_cents = ? WHERE part_id = ?", OFFER, box),
		stmt("UPDATE parts SET sale_price_cents = ? WHERE ref = 'LAMP-DESK'", SALE),
	);

	const lamp = await planBuild("LAMP-DESK", { serial: "L-0042" });
	const page = await (await request(`/builds/${lamp}`)).text();
	const led = await partId("LED-5W-CW");
	const fields: Record<string, string> = {};
	for (const m of page.matchAll(/name="(serial:(\d+):\d+)"/g))
		fields[m[1] as string] = Number(m[2]) === led ? "CW-24-0003" : "DRV-7A-101";
	expect((await postForm(`/builds/${lamp}/complete`, fields)).status).toBe(303);

	await insertPart("WIDGET", "make");
	await importCsv(
		"boms",
		"parent_ref,code,revision,status,sale_price,component_ref,qty\nWIDGET,std,R1,active,,BOX-LAMP,1\n",
	);
	const widget = await planBuild("WIDGET", { qty: "100" });

	const supplier = (await one<{ id: number }>("SELECT supplier_id AS id FROM parts WHERE id = ?", box)).id;
	const po = await postForm("/purchasing/po", { supplier_id: String(supplier), expected_at: "", notes: "" });
	const poId = Number(/\/po\/(\d+)/.exec(po.headers.get("Location") ?? "")?.[1]);
	await postForm(`/purchasing/po/${poId}/lines`, { part: "BOX-LAMP", qty: "10", price: "987.65" });
	await postForm(`/purchasing/po/${poId}/send`, {});
	const line = (await one<{ id: number }>("SELECT id FROM po_lines WHERE po_id = ?", poId)).id;
	await postForm(`/purchasing/po/${poId}/receive`, { [`recv_${line}`]: "4" });
	const poNumber = (await one<{ number: string }>("SELECT number FROM purchase_orders WHERE id = ?", poId)).number;
	return { lamp: await buildNumber(lamp), widget: await buildNumber(widget), po: poNumber };
}

/** One call of every tool, with arguments that reach the seeded amounts. */
function calls(s: Awaited<ReturnType<typeof seed>>): [string, Record<string, unknown>][] {
	return [
		["search_parts", { query: "BOX" }],
		["get_part", { ref: "BOX-LAMP" }],
		["get_part", { ref: "LAMP-DESK" }],
		["get_bom", { bom: "LAMP-DESK" }],
		["get_bom", { bom: "WIDGET", qty: "8" }],
		["explode_bom", { bom: "WIDGET", qty: "8" }],
		["explode_bom", { bom: "LAMP-DESK", qty: "1", use_stock: true }],
		["stock_on_hand", {}],
		["list_moves", {}],
		["list_builds", { status: "all" }],
		["get_build", { number: s.lamp }],
		["get_build", { number: s.widget }],
		["get_shortages", {}],
		["list_purchase_orders", { status: "all" }],
		["get_purchase_order", { number: s.po }],
	];
}

describe("cost redaction over MCP", () => {
	it("gives no cost field to users who may not see costs, whatever the tool", async () => {
		const s = await seed();
		for (const role of ["viewer", "operator"] as const) {
			await setRole(role);
			const token = await connect(ALL, { overrides: NOT_ADMIN });
			for (const [name, args] of calls(s)) {
				const r = await callTool(token, name, args, NOT_ADMIN);
				expect(r.isError, `${role} ${name}: ${r.text}`).toBe(false);
				expect(r.data.costs_hidden, `${role} ${name}`).toBe(true);
				for (const amount of AMOUNTS) expect(r.text, `${role} ${name} leaks ${amount}`).not.toContain(amount);
				expect(r.text, `${role} ${name}`).not.toMatch(
					/"(standard_cost|sale_price|unit_cost|unit_price|price|total|total_cost|extended_cost|line_total)"/,
				);
			}
		}
	});

	it("shows them to planners, and to others once an admin allows it", async () => {
		const s = await seed();
		await setRole("planner");
		const planner = await connect(ALL, { overrides: NOT_ADMIN });
		const part = await callTool(planner, "get_part", { ref: "BOX-LAMP" }, NOT_ADMIN);
		expect(part.text).toContain('"standard_cost":"1234.56"');
		expect(part.text).toContain('"price":"1111.11"');
		const po = await callTool(planner, "get_purchase_order", { number: s.po }, NOT_ADMIN);
		expect(po.text).toContain('"unit_price":"987.65"');
		expect(po.text).toContain('"total":"9876.50"');

		await letLowerRolesSeeCosts();
		await setRole("viewer");
		const viewer = await connect(ALL, { overrides: NOT_ADMIN });
		expect((await callTool(viewer, "get_part", { ref: "BOX-LAMP" }, NOT_ADMIN)).text).toContain("1234.56");
	});
});

describe("read tools", () => {
	it("searches parts and returns one part with its offers, BoMs and where-used", async () => {
		await loadDemo();
		const token = await connect(["catalog:read"]);
		const found = await callTool(token, "search_parts", { query: "head kit", kind: "kit" });
		expect((found.data.parts as { ref: string }[]).map((p) => p.ref)).toEqual(["HEAD-KIT-CW", "HEAD-KIT-WW"]);

		const led = await callTool(token, "get_part", { ref: "led-5w-cw" });
		expect(led.data.part).toMatchObject({ ref: "LED-5W-CW", kind: "buy", on_hand: "6", track_serial: true });
		expect(led.data.offers).toEqual([
			expect.objectContaining({ supplier: "Lumen Parts Co", preferred: true, price: "4.10", moq: "10" }),
			expect.objectContaining({ supplier: "Quickparts Express", preferred: false, price: "4.90" }),
		]);
		const used = led.data.where_used as { parent: string; depth: number; via: string }[];
		expect(used).toContainEqual(expect.objectContaining({ parent: "HEAD-KIT-CW", depth: 1, via: "LED-5W-CW" }));
		expect(used).toContainEqual(expect.objectContaining({ parent: "LAMP-DESK", depth: 2, via: "HEAD-KIT-CW" }));

		const lamp = await callTool(token, "get_part", { ref: "LAMP-DESK" });
		expect((lamp.data.boms as { code: string; status: string }[]).map((b) => `${b.code}:${b.status}`)).toEqual([
			"std:archived",
			"std:active",
			"warm:active",
		]);
		expect(lamp.data.rolled_up_cost).toMatchObject({ unit_cost: "37.83", incomplete: true, missing_costs: ["MANUAL"] });
	});

	it("returns a BoM tree with per-parent and cumulative quantities and the cost roll-up", async () => {
		await loadDemo();
		const token = await connect(["catalog:read"]);
		const tree = await callTool(token, "get_bom", { bom: "LAMP-DESK", qty: "2" });
		expect(tree.data.bom).toMatchObject({ part: "LAMP-DESK", code: "std", revision: "Rev2", status: "active" });
		expect(tree.data.cost).toMatchObject({ unit_cost: "37.83", total_cost: "75.66", incomplete: true });
		const lines = tree.data.lines as { ref: string; per_parent: string; qty: string; children?: unknown[] }[];
		const base = lines.find((l) => l.ref === "BASE-ASSY");
		expect(base).toMatchObject({ per_parent: "1", qty: "2", mode: "build" });
		expect(base?.children).toContainEqual(expect.objectContaining({ ref: "PAD-FELT", per_parent: "4", qty: "8" }));
		expect(base?.children).toContainEqual(expect.objectContaining({ ref: "CABLE-2C", per_parent: "1.5", qty: "3" }));

		const warm = await callTool(token, "get_bom", { bom: "LAMP-DESK", code: "warm" });
		expect(warm.data.bom).toMatchObject({ code: "warm", revision: "Rev1" });
		const old = await callTool(token, "get_bom", { bom: "LAMP-DESK", revision: "Rev1" });
		expect(old.data.bom).toMatchObject({ code: "std", revision: "Rev1", status: "archived" });
		const byId = await callTool(token, "get_bom", { bom: await bomId("ARM-ASSY") });
		expect(byId.data.bom).toMatchObject({ part: "ARM-ASSY" });
	});

	it("explodes a BoM, taking sub-assemblies from stock when asked", async () => {
		await loadDemo();
		const token = await connect(["catalog:read"]);
		type Line = { ref: string; qty: string; on_hand?: string; short?: string };
		const flat = await callTool(token, "explode_bom", { bom: "LAMP-DESK", qty: 3 });
		const comps = flat.data.components as Line[];
		expect(comps.find((c) => c.ref === "ARM-TUBE-300")).toMatchObject({ qty: "6", on_hand: "10", short: "0" });
		expect(comps.find((c) => c.ref === "BASE-PLATE")).toMatchObject({ qty: "3", on_hand: "3", short: "0" });
		expect(comps.find((c) => c.ref === "ARM-ASSY")).toBeUndefined();
		expect(flat.data.fees).toEqual([expect.objectContaining({ ref: "FEE-WEEE", qty: "3" })]);

		const stocked = await callTool(token, "explode_bom", { bom: "LAMP-DESK", qty: "1", use_stock: true });
		const used = stocked.data.components as Line[];
		expect(used.find((c) => c.ref === "ARM-ASSY")).toMatchObject({ qty: "2", on_hand: "2" });
		expect(used.find((c) => c.ref === "ARM-TUBE-300")).toBeUndefined();
	});

	it("reports stock on hand with filters, and the moves ledger", async () => {
		await loadDemo();
		await postForm("/stock/adjust", { part: "PAD-FELT", qty: "-450", serial: "", note: "scrapped" });
		const token = await connect(["stock:read"]);
		const below = await callTool(token, "stock_on_hand", { filter: "below_zero" });
		expect(below.data.parts).toEqual([expect.objectContaining({ ref: "PAD-FELT", on_hand: "-50" })]);
		const stocked = await callTool(token, "stock_on_hand", { filter: "in_stock", query: "cable" });
		expect(stocked.data.parts).toEqual([expect.objectContaining({ ref: "CABLE-2C", unit: "m", on_hand: "42.5" })]);
		const moves = await callTool(token, "list_moves", { reason: "adjust" });
		expect(moves.data.moves).toEqual([
			expect.objectContaining({ ref: "PAD-FELT", qty: "-450", reason: "adjust", note: "scrapped" }),
		]);
		const bad = await callTool(token, "list_moves", { from: "13/10/2026" });
		expect(bad.isError).toBe(true);
		expect(bad.text).toContain("YYYY-MM-DD");
	});

	it("finds the build that used a component serial, and returns as-built records and pick lists", async () => {
		const s = await seed();
		const token = await connect(["builds:read"]);
		const bySerial = await callTool(token, "list_builds", { query: "CW-24-0003" });
		expect(bySerial.data.builds).toEqual([
			expect.objectContaining({ number: s.lamp, status: "done", serial: "L-0042" }),
		]);
		const open = await callTool(token, "list_builds", {});
		expect((open.data.builds as { number: string }[]).map((b) => b.number)).toEqual([s.widget]);

		const done = await callTool(token, "get_build", { number: s.lamp.toLowerCase() });
		expect(done.data.as_built).toContainEqual(
			expect.objectContaining({ ref: "LED-5W-CW", qty: "1", serial: "CW-24-0003" }),
		);
		expect(done.data.as_built).toContainEqual(expect.objectContaining({ ref: "ARM-ASSY", qty: "2" }));

		const pick = await callTool(token, "get_build", { number: s.widget });
		expect(pick.data.pick_list).toEqual([
			expect.objectContaining({ ref: "BOX-LAMP", qty: "100", on_hand: "23", short: "77" }),
		]);
		const missing = await callTool(token, "get_build", { number: "B-9999" });
		expect(missing.isError).toBe(true);
		expect(missing.text).toContain("No build numbered");
	});

	it("returns shortages and purchase orders", async () => {
		const s = await seed();
		const token = await connect(["purchasing:read"]);
		const short = await callTool(token, "get_shortages", {});
		expect(short.data.open_builds).toBe(1);
		const lines = (short.data.suppliers as { lines: { ref: string }[] }[]).flatMap((g) => g.lines);
		expect(lines).toContainEqual(
			// Rounded up to the preferred offer's pack size (25).
			expect.objectContaining({ ref: "BOX-LAMP", need: "100", on_hand: "23", on_order: "6", net: "71", order: "75" }),
		);

		const open = await callTool(token, "list_purchase_orders", {});
		expect(open.data.purchase_orders).toEqual([expect.objectContaining({ number: s.po, status: "partial", lines: 1 })]);
		const po = await callTool(token, "get_purchase_order", { number: s.po });
		expect(po.data.purchase_order).toMatchObject({ number: s.po, status: "partial" });
		expect(po.data.lines).toEqual([
			expect.objectContaining({ ref: "BOX-LAMP", qty: "10", received: "4", remaining: "6", unit_price: "987.65" }),
		]);
	});

	it("answers bad input with clear errors", async () => {
		await loadDemo();
		const token = await connect(["catalog:read"]);
		const unknown = await callTool(token, "get_part", { ref: "NOPE" });
		expect(unknown).toMatchObject({ isError: true });
		expect(unknown.text).toContain('No part with reference "NOPE"');
		const negative = await callTool(token, "explode_bom", { bom: "LAMP-DESK", qty: "-2" });
		expect(negative.isError).toBe(true);
		expect(negative.text).toContain("positive decimal number");
		const tooPrecise = await callTool(token, "explode_bom", { bom: "LAMP-DESK", qty: "1.0001" });
		expect(tooPrecise.isError).toBe(true);
		const noBom = await callTool(token, "get_bom", { bom: "PAD-FELT" });
		expect(noBom.text).toContain("PAD-FELT has no active BoM");
		const noRevision = await callTool(token, "get_bom", { bom: "LAMP-DESK", revision: "Rev9" });
		expect(noRevision.text).toContain("no revision Rev9");
	});
});
