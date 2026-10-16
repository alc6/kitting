import { beforeEach, describe, expect, it } from "vitest";
import { toWire } from "../src/mcp/wire";
import {
	assemblyId,
	changeSql,
	importCsv,
	insertPart,
	letLowerRolesSeeCosts,
	loadDemo,
	NOT_ADMIN,
	one,
	partId,
	postForm,
	request,
	rows,
	seedSql,
	setRole,
	stmt,
} from "./helpers";
import { callTool, connect, resetKv } from "./mcp-helpers";
import { addOption, adjustViaForm, nightLight, optionId, valueId } from "./mcp-options-fixture";

const ALL = ["catalog:read", "stock:read", "builds:read", "purchasing:read"];

beforeEach(async () => {
	await resetKv();
});

async function planBuild(ref: string, opts: { serial?: string; qty?: string } = {}): Promise<number> {
	const res = await postForm("/builds", {
		part_id: String(await partId(ref)),
		assembly_id: String(await assemblyId(ref)),
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
const RATE = 66666; // hourly rate of the FDM printer type
const SHIPPING = 55555; // shipping and duties on the PO (D201), spread over its line: 1087.65 a unit landed
const DUTIES = 44444;
const AMOUNTS = [
	"1234.56",
	"1111.11",
	"9999.99",
	"987.65",
	"9876.50",
	"666.66",
	"555.55",
	"444.44",
	"1087.65",
	"10876.49",
];
/** The same amounts in cents, as a raw snapshot would hold them. */
const CENTS = ["123456", "111111", "999999", "98765", "987650", "66666", "55555", "44444", "108765", "1087649"];

/**
 * Demo data, the amounts above, a lamp built with serial components, a WIDGET (one BOX-LAMP each) with an open
 * build of 100 (a shortage), and a PO of 10 BOX-LAMP at 987.65, 4 received.
 */
async function seed() {
	await loadDemo();
	const box = await partId("BOX-LAMP");
	// Fixture prices, written outside the change history (as a restore would), except the standard cost: its change
	// is in the history, which list_recent_changes must not reveal either.
	await seedSql(
		stmt("UPDATE part_suppliers SET price_cents = ? WHERE part_id = ?", OFFER, box),
		stmt("UPDATE parts SET sale_price_cents = ? WHERE ref = 'LAMP-DESK'", SALE),
	);
	await changeSql("Set the standard cost of BOX-LAMP", stmt("UPDATE parts SET cost_cents = ? WHERE id = ?", COST, box));

	const lamp = await planBuild("LAMP-DESK", { serial: "L-0042" });
	const page = await (await request(`/builds/${lamp}`)).text();
	const led = await partId("LED-5W-CW");
	const fields: Record<string, string> = {};
	for (const m of page.matchAll(/name="(serial:(\d+):\d+)"/g))
		fields[m[1] as string] = Number(m[2]) === led ? "CW-24-0003" : "DRV-7A-101";
	expect((await postForm(`/builds/${lamp}/complete`, fields)).status).toBe(303);

	await insertPart("WIDGET", "make");
	await importCsv(
		"assemblies",
		"parent_ref,code,revision,status,sale_price,component_ref,qty\nWIDGET,std,R1,active,,BOX-LAMP,1\n",
	);
	const widget = await planBuild("WIDGET", { qty: "100" });

	const supplier = (await one<{ id: number }>("SELECT supplier_id AS id FROM parts WHERE id = ?", box)).id;
	const po = await postForm("/purchasing/po", { supplier_id: String(supplier), expected_at: "", notes: "" });
	const poId = Number(/\/po\/(\d+)/.exec(po.headers.get("Location") ?? "")?.[1]);
	await postForm(`/purchasing/po/${poId}/lines`, { part: "BOX-LAMP", qty: "10", price: "987.65" });
	await postForm(`/purchasing/po/${poId}/charges`, {
		shipping: String(SHIPPING / 100),
		duties: String(DUTIES / 100),
		discount: "",
		charges_spread: "value",
	});
	await postForm(`/purchasing/po/${poId}/send`, {});
	const line = (await one<{ id: number }>("SELECT id FROM po_lines WHERE po_id = ?", poId)).id;
	await postForm(`/purchasing/po/${poId}/receive`, { [`recv_${line}`]: "4" });
	const poNumber = (await one<{ number: string }>("SELECT number FROM purchase_orders WHERE id = ?", poId)).number;
	// A machine rate (in the history too), a printed clip built with it and another one planned.
	await changeSql(
		"Set the rate of FDM printer",
		stmt("UPDATE machine_types SET hourly_rate_cents = ? WHERE name = 'FDM printer'", RATE),
	);
	const clipDone = await planBuild("LAMP-CLIP", { qty: "24" });
	expect((await postForm(`/builds/${clipDone}/complete`, {})).status).toBe(303);
	const clipOpen = await planBuild("LAMP-CLIP", { qty: "10" });
	return {
		lamp: await buildNumber(lamp),
		widget: await buildNumber(widget),
		po: poNumber,
		clipDone: await buildNumber(clipDone),
		clipOpen: await buildNumber(clipOpen),
	};
}

/** One call of every tool, with arguments that reach the seeded amounts. */
function calls(s: Awaited<ReturnType<typeof seed>>): [string, Record<string, unknown>][] {
	return [
		["search_parts", { query: "BOX" }],
		["get_part", { ref: "BOX-LAMP" }],
		["get_part", { ref: "LAMP-DESK" }],
		["get_assembly", { assembly: "LAMP-DESK" }],
		["get_assembly", { assembly: "WIDGET", qty: "8" }],
		["explode_assembly", { assembly: "WIDGET", qty: "8" }],
		["explode_assembly", { assembly: "LAMP-DESK", qty: "1", use_stock: true }],
		["stock_on_hand", {}],
		["list_moves", {}],
		["list_builds", { status: "all" }],
		["get_build", { number: s.lamp }],
		["get_build", { number: s.widget }],
		["get_shortages", {}],
		["list_purchase_orders", { status: "all" }],
		["get_purchase_order", { number: s.po }],
		["list_recent_changes", { limit: 100 }],
		["list_machines", { include_retired: true }],
		["get_assembly", { assembly: "LAMP-CLIP" }],
		["explode_assembly", { assembly: "LAMP-CLIP", qty: "24" }],
		["get_build", { number: s.clipDone }],
		["get_build", { number: s.clipOpen }],
		// Parts with options (the mini lamp comes in white or black).
		["get_part", { ref: "MINI-COVER" }],
		["get_assembly", { assembly: "LAMP-MINI", qty: "2" }],
		["explode_assembly", { assembly: "LAMP-MINI", qty: "2", options: { Colour: "black" }, use_stock: true }],
		["stock_on_hand", { query: "MINI" }],
		// Where things are kept (D208).
		["get_location", {}],
		["get_location", { ref: "BOX-LAMP" }],
		["get_location", { ref: "STOC" }],
		["get_location", { ref: "A-3" }],
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
				for (const amount of [...AMOUNTS, ...CENTS])
					expect(r.text, `${role} ${name} leaks ${amount}`).not.toContain(amount);
				// No amount field (as a key: list_recent_changes names a changed price, hidden, as a value).
				expect(r.text, `${role} ${name}`).not.toMatch(
					/"(standard_cost|sale_price|unit_cost|unit_price|price|total|total_cost|extended_cost|line_total|lines_total|shipping|duties|discount|landed_unit_cost|charges_in_stock)":/,
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
		const history = await callTool(planner, "list_recent_changes", { query: "standard cost" }, NOT_ADMIN);
		expect((history.data.changes as { changes: unknown[] }[])[0]?.changes).toEqual([
			{
				table: "parts",
				op: "update",
				record: "BOX-LAMP",
				fields: [{ field: "cost", before: "1.20", after: "1234.56" }],
			},
		]);
		expect(po.text).toContain('"lines_total":"9876.50"');
		expect(po.text).toContain('"total":"10876.49"');
		expect(po.text).toContain('"landed_unit_cost":"1087.65"');

		await letLowerRolesSeeCosts();
		await setRole("viewer");
		const viewer = await connect(ALL, { overrides: NOT_ADMIN });
		expect((await callTool(viewer, "get_part", { ref: "BOX-LAMP" }, NOT_ADMIN)).text).toContain("1234.56");
	});
});

describe("read tools", () => {
	it("searches parts and returns one part with its offers, assemblies and where-used", async () => {
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
		// The minimum stock is in the examples (D173): LED-5W-CW has 6 on hand against a minimum of 20.
		expect(led.data.part).toMatchObject({ min_stock: "20" });
		expect((await callTool(token, "get_part", { ref: "MANUAL" })).data.part).toMatchObject({ min_stock: null });
		const used = led.data.where_used as { parent: string; depth: number; via: string }[];
		expect(used).toContainEqual(expect.objectContaining({ parent: "HEAD-KIT-CW", depth: 1, via: "LED-5W-CW" }));
		expect(used).toContainEqual(expect.objectContaining({ parent: "LAMP-DESK", depth: 2, via: "HEAD-KIT-CW" }));

		const lamp = await callTool(token, "get_part", { ref: "LAMP-DESK" });
		expect((lamp.data.assemblies as { code: string; status: string }[]).map((b) => `${b.code}:${b.status}`)).toEqual([
			"std:archived",
			"std:active",
			"warm:active",
		]);
		expect(lamp.data.rolled_up_cost).toMatchObject({ unit_cost: "37.83", incomplete: true, missing_costs: ["MANUAL"] });
	});

	it("lists the files of a part, of an assembly revision and of a build, with their download links", async () => {
		await loadDemo();
		const lamp = await partId("LAMP-DESK");
		const rev = await assemblyId("LAMP-DESK");
		const file = (owner: string, id: number, name: string, kind: string, format: string) =>
			stmt(
				`INSERT INTO files (${owner}, name, kind, format, size_bytes, sha256, object_key, note, uploaded_at, uploaded_by,
					created_by, updated_by) VALUES (?, ?, ?, ?, 2048, 'ab', 'files/k', '', '2026-03-02T10:00:00.000Z',
					'designer@example.com', 'u', 'u')`,
				id,
				name,
				kind,
				format,
			);
		await changeSql(
			"Attach files",
			file("part_id", lamp, "lamp label.dxf", "drawing", "dxf"),
			file("assembly_id", rev, "assembly guide.pdf", "instructions", "pdf"),
		);
		const [label, guide] = await rows<{ id: number }>("SELECT id FROM files ORDER BY id");
		const token = await connect(["catalog:read", "builds:read"]);
		const part = await callTool(token, "get_part", { ref: "LAMP-DESK" });
		expect(part.data.files).toEqual([
			{
				name: "lamp label.dxf",
				kind: "drawing",
				format: "dxf",
				size_bytes: 2048,
				uploaded_at: "2026-03-02T10:00:00.000Z",
				uploaded_by: "designer@example.com",
				download_path: `/files/${label?.id}/download`,
				download_url: `https://kitting.example.com/files/${label?.id}/download`,
			},
		]);
		const tree = await callTool(token, "get_assembly", { assembly: "LAMP-DESK" });
		expect(tree.data.files).toEqual([expect.objectContaining({ name: "assembly guide.pdf", kind: "instructions" })]);
		const build = await callTool(token, "get_build", {
			number: await buildNumber(await planBuild("LAMP-DESK", { serial: "L-9" })),
		});
		expect(
			(build.data.files as { name: string; attached_to: string; download_path: string }[]).map((f) => [
				f.name,
				f.attached_to,
				f.download_path,
			]),
		).toEqual([
			["assembly guide.pdf", "assembly", `/files/${guide?.id}/download`],
			["lamp label.dxf", "part", `/files/${label?.id}/download`],
		]);
	});

	it("returns an assembly tree with per-parent and cumulative quantities and the cost roll-up", async () => {
		await loadDemo();
		const token = await connect(["catalog:read"]);
		const tree = await callTool(token, "get_assembly", { assembly: "LAMP-DESK", qty: "2" });
		expect(tree.data.assembly).toMatchObject({ part: "LAMP-DESK", code: "std", revision: "Rev2", status: "active" });
		expect(tree.data.cost).toMatchObject({ unit_cost: "37.83", total_cost: "75.66", incomplete: true });
		const lines = tree.data.lines as { ref: string; per_parent: string; qty: string; children?: unknown[] }[];
		const base = lines.find((l) => l.ref === "BASE-ASSY");
		expect(base).toMatchObject({ per_parent: "1", qty: "2", mode: "build" });
		expect(base?.children).toContainEqual(expect.objectContaining({ ref: "PAD-FELT", per_parent: "4", qty: "8" }));
		expect(base?.children).toContainEqual(expect.objectContaining({ ref: "CABLE-2C", per_parent: "1.5", qty: "3" }));

		const warm = await callTool(token, "get_assembly", { assembly: "LAMP-DESK", code: "warm" });
		expect(warm.data.assembly).toMatchObject({ code: "warm", revision: "Rev1" });
		const old = await callTool(token, "get_assembly", { assembly: "LAMP-DESK", revision: "Rev1" });
		expect(old.data.assembly).toMatchObject({ code: "std", revision: "Rev1", status: "archived" });
		const byId = await callTool(token, "get_assembly", { assembly: await assemblyId("ARM-ASSY") });
		expect(byId.data.assembly).toMatchObject({ part: "ARM-ASSY" });
	});

	it("explodes an assembly, taking sub-assemblies from stock when asked", async () => {
		await loadDemo();
		const token = await connect(["catalog:read"]);
		type Line = { ref: string; qty: string; on_hand?: string; short?: string };
		const flat = await callTool(token, "explode_assembly", { assembly: "LAMP-DESK", qty: 3 });
		const comps = flat.data.components as Line[];
		expect(comps.find((c) => c.ref === "ARM-TUBE-300")).toMatchObject({ qty: "6", on_hand: "10", short: "0" });
		expect(comps.find((c) => c.ref === "BASE-PLATE")).toMatchObject({ qty: "3", on_hand: "3", short: "0" });
		expect(comps.find((c) => c.ref === "ARM-ASSY")).toBeUndefined();
		expect(flat.data.fees).toEqual([expect.objectContaining({ ref: "FEE-WEEE", qty: "3" })]);

		const stocked = await callTool(token, "explode_assembly", { assembly: "LAMP-DESK", qty: "1", use_stock: true });
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
		const belowMin = await callTool(token, "stock_on_hand", { filter: "below_min" });
		const refs = (belowMin.data.parts as { ref: string; min_stock: string; on_hand: string }[]).map((p) => p.ref);
		expect(refs).toContain("LED-5W-CW");
		expect(refs).toContain("PAD-FELT"); // 50 on hand after the scrap, minimum 200
		expect(belowMin.data.parts).toContainEqual(
			expect.objectContaining({ ref: "LED-5W-CW", on_hand: "6", min_stock: "20" }),
		);
		expect(refs).not.toContain("CABLE-2C"); // no minimum set
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
		expect((open.data.builds as { number: string }[]).map((b) => b.number)).toEqual([s.clipOpen, s.widget]);

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
		expect(short.data.open_builds).toBe(2);
		expect(short.data.to_make, "nothing to make: the lamp's sub-assemblies are in stock").toEqual([]);
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

	it("lists machines and gives machine time in assemblies, builds and shortages", async () => {
		const s = await seed();
		const token = await connect(ALL);
		const machines = await callTool(token, "list_machines", {});
		expect(machines.data.machine_types).toEqual([
			{
				name: "FDM printer",
				hourly_rate: "666.66",
				active_machines: 2,
				recipes: 1,
				planned_minutes: "79.167",
				notes: expect.any(String),
			},
		]);
		expect((machines.data.machines as { name: string; status: string }[]).map((m) => [m.name, m.status])).toEqual([
			["PRINTER-1", "active"],
			["PRINTER-2", "active"],
			["PRINTER-3", "maintenance"],
		]);
		const clip = await callTool(token, "get_assembly", { assembly: "LAMP-CLIP", qty: "48" });
		expect(clip.data.assembly).toMatchObject({ batch: "24", machine_type: "FDM printer", machine_minutes: 190 });
		expect(clip.data.machine_time).toEqual([
			{ type: "FDM printer", minutes: "380", hourly_rate: "666.66", cost: "4222.18" },
		]);
		const open = await callTool(token, "get_build", { number: s.clipOpen });
		expect(open.data.machine_time).toEqual([expect.objectContaining({ type: "FDM printer", minutes: "79.167" })]);
		const done = await callTool(token, "get_build", { number: s.clipDone });
		expect(done.data.machine_time).toEqual([
			{ type: "FDM printer", minutes: "190", hourly_rate: "666.66", cost: "2111.09" },
		]);
		const short = await callTool(token, "get_shortages", {});
		expect(short.data.machine_time).toEqual([
			{ type: "FDM printer", minutes: "79.167", active_machines: 2, builds: [s.clipOpen] },
		]);
	});

	it("answers bad input with clear errors", async () => {
		await loadDemo();
		const token = await connect(["catalog:read"]);
		const unknown = await callTool(token, "get_part", { ref: "NOPE" });
		expect(unknown).toMatchObject({ isError: true });
		expect(unknown.text).toContain('No part with reference "NOPE"');
		const negative = await callTool(token, "explode_assembly", { assembly: "LAMP-DESK", qty: "-2" });
		expect(negative.isError).toBe(true);
		expect(negative.text).toContain("positive decimal number");
		const tooPrecise = await callTool(token, "explode_assembly", { assembly: "LAMP-DESK", qty: "1.0001" });
		expect(tooPrecise.isError).toBe(true);
		const noAssembly = await callTool(token, "get_assembly", { assembly: "PAD-FELT" });
		expect(noAssembly.text).toContain("PAD-FELT has no active assembly");
		const noRevision = await callTool(token, "get_assembly", { assembly: "LAMP-DESK", revision: "Rev9" });
		expect(noRevision.text).toContain("no revision Rev9");
	});
});

describe("where things are kept (get_location)", () => {
	type Node = { code: string; part_count: number; in_bin?: string; units?: Node[] };
	type Stored = { ref: string; bin: string; on_hand: string; path?: string };

	it("lists the plan: rooms, the units as a tree with their part counts, the parts not put away", async () => {
		await loadDemo();
		const token = await connect(["stock:read"]);
		const r = await callTool(token, "get_location", {});
		expect(r.isError, r.text).toBe(false);
		expect(r.data.rooms).toEqual([
			{ code: "ASSE", name: "Assembly" },
			{ code: "STOC", name: "Stockroom" },
		]);
		const units = r.data.units as (Node & { room: string })[];
		expect(units.map((u) => `${u.code} ${u.room} ${u.part_count}`)).toEqual([
			"A Stockroom 6",
			"B Stockroom 8",
			"C Stockroom 1",
			"D Assembly 6",
			"P Stockroom 1",
		]);
		expect(units[0]?.units).toEqual([
			expect.objectContaining({ code: "S1", kind: "cabinet", in_bin: "A-3-3", part_count: 3, levels: 3, positions: 4 }),
		]);
		expect(r.data.without_location).toEqual([{ ref: "SWITCH-INL", name: "Inline switch" }]);
		expect(r.data.without_location_count).toBe(1);
	});

	it("says where a part is kept, through the units it stands in", async () => {
		await loadDemo();
		const token = await connect(["stock:read"]);
		const screws = await callTool(token, "get_location", { ref: "screw-m3x8" });
		expect(screws.data.part).toMatchObject({ ref: "SCREW-M3X8", on_hand: "350", unit: "pcs" });
		expect(screws.data.location).toEqual({
			bin: "S1-1-1",
			path: "A-3-3 › S1-1-1",
			room: "Stockroom",
			storage_unit: { code: "S1", name: "Screw drawers", kind: "cabinet" },
			note: "",
		});
		const unlocated = await callTool(token, "get_location", { ref: "SWITCH-INL" });
		expect(unlocated.data.location).toBeNull();
		expect(unlocated.data.hint).toContain("update_part");
		// get_part gives the same location.
		const catalog = await connect(["catalog:read"]);
		const part = await callTool(catalog, "get_part", { ref: "BOX-LAMP" });
		expect((part.data.part as { location: unknown }).location).toMatchObject({
			bin: "P",
			path: "P",
			room: "Stockroom",
		});
		expect((await callTool(catalog, "get_part", { ref: "HEAD-KIT-CW" })).data.part).toMatchObject({ location: null });
	});

	it("says what a bin, a unit or a room holds", async () => {
		await loadDemo();
		const token = await connect(["stock:read"]);
		const level = await callTool(token, "get_location", { ref: "a-2" });
		expect(level.data.place).toMatchObject({ kind: "bin", code: "A-2", path: "A-2", room: "Stockroom" });
		expect((level.data.parts as Stored[]).map((p) => `${p.ref} ${p.bin} ${p.on_hand}`)).toEqual([
			"SPRING-TENS A-2-1 120",
			"JOINT-KNOB A-2-2 150",
			"PAD-FELT A-2-3 400",
		]);
		const shelf = await callTool(token, "get_location", { ref: "A-3-3" });
		expect(shelf.data.parts).toEqual([]);
		expect((shelf.data.units as Node[]).map((u) => `${u.code} ${u.in_bin} ${u.part_count}`)).toEqual(["S1 A-3-3 3"]);
		const drawers = await callTool(token, "get_location", { ref: "S1" });
		expect(drawers.data.place).toMatchObject({ kind: "unit", code: "S1", path: "A-3-3 › S1" });
		expect((drawers.data.parts as Stored[]).map((p) => p.bin)).toEqual(["S1-1-1", "S1-1-2", "S1-1-3"]);

		// A room, by code or name: its units and every part kept there, in walking order.
		const room = await callTool(token, "get_location", { ref: "assembly" });
		expect(room.data.place).toEqual({ kind: "room", code: "ASSE", name: "Assembly" });
		expect((room.data.units as Node[]).map((u) => u.code)).toEqual(["D"]);
		expect((room.data.parts as Stored[]).map((p) => `${p.ref} ${p.path}`)).toEqual([
			"LAMP-DESK D-1-1",
			"LAMP-MINI D-1-2",
			"ARM-ASSY D-2-1",
			"BASE-ASSY D-2-2",
			"MINI-HEAD D-3-1",
			"LAMP-CLIP D-3-2",
		]);
		const stockroom = await callTool(token, "get_location", { ref: "STOC", limit: 2 });
		expect((stockroom.data.parts as Stored[]).map((p) => p.path)).toEqual(["A-1-1", "A-1-2"]);
		expect(stockroom.data.part_count).toBe(19);
	});

	it("answers codes that hold nothing or do not exist with clear errors", async () => {
		await loadDemo();
		const token = await connect(["stock:read"]);
		expect((await callTool(token, "get_location", { ref: "DOOR" })).text).toContain("DOOR is a door on the plan");
		expect((await callTool(token, "get_location", { ref: "A-9-1" })).text).toContain(
			"A has 4 level(s) of 3 position(s): there is no bin A-9-1.",
		);
		expect((await callTool(token, "get_location", { ref: "P-1" })).text).toContain("P has no levels");
		const nothing = await callTool(token, "get_location", { ref: "NOPE" });
		expect(nothing.isError).toBe(true);
		expect(nothing.text).toContain('Nothing is called "NOPE"');
	});

	it("says when no plan is drawn yet", async () => {
		await loadDemo({ plan: false });
		const token = await connect(["stock:read"]);
		const r = await callTool(token, "get_location", {});
		expect(r.data).toMatchObject({ rooms: [], units: [], without_location_count: 26 });
		expect(r.data.hint).toContain("Locations page");
	});
});

describe("read tools with part options", () => {
	const SCOPES = ["catalog:read", "stock:read", "builds:read", "purchasing:read"];

	it("keeps option names as they are on the wire, whatever the user sees", () => {
		const data = {
			options: { Colour: "white", "Fit Size": "XL" },
			lines: [{ fixed: { Colour: "black" }, choose: ["Colour"], unitCostCents: 125 }],
			part: { options: [{ name: "Colour", values: ["white", "black"], default: "white" }], stockByOptions: [] },
		};
		const planner = toWire({ role: "planner", seeCosts: true }, data);
		expect(planner).toEqual({
			options: { Colour: "white", "Fit Size": "XL" },
			lines: [{ fixed: { Colour: "black" }, choose: ["Colour"], unit_cost: "1.25" }],
			part: { options: [{ name: "Colour", values: ["white", "black"], default: "white" }], stock_by_options: [] },
		});
		const viewer = toWire({ role: "viewer", seeCosts: false }, data);
		expect(viewer.options).toEqual({ Colour: "white", "Fit Size": "XL" });
		expect(viewer.lines).toEqual([{ fixed: { Colour: "black" }, choose: ["Colour"] }]);
		expect(viewer.costs_hidden).toBe(true);
	});

	it("shows a part's options and its stock per values", async () => {
		await nightLight();
		await adjustViaForm("NL-COVER", "5", "white");
		await adjustViaForm("NL-COVER", "3", "black");
		await adjustViaForm("NL-COVER", "-3", "black");
		const token = await connect(SCOPES);
		const cover = await callTool(token, "get_part", { ref: "NL-COVER" });
		expect(cover.data.part).toMatchObject({
			ref: "NL-COVER",
			on_hand: "5",
			options: [{ name: "Colour", values: ["white", "black"], default: "white" }],
			stock_by_options: [{ options: { Colour: "white" }, on_hand: "5" }],
		});
		const screw = await callTool(token, "get_part", { ref: "NL-SCREW" });
		expect(screw.data.part).not.toHaveProperty("options");
		expect(screw.data.part).not.toHaveProperty("stock_by_options");

		const stock = await callTool(token, "stock_on_hand", { query: "NL-" });
		const parts = stock.data.parts as { ref: string; by_options?: unknown }[];
		expect(parts.find((p) => p.ref === "NL-COVER")?.by_options).toEqual([
			{ options: { Colour: "white" }, on_hand: "5" },
		]);
		expect(parts.find((p) => p.ref === "NL-SCREW")).not.toHaveProperty("by_options");

		const moves = await callTool(token, "list_moves", { query: "NL-COVER" });
		expect((moves.data.moves as { options: object; qty: string }[]).map((m) => [m.options, m.qty])).toEqual([
			[{ Colour: "black" }, "-3"],
			[{ Colour: "black" }, "3"],
			[{ Colour: "white" }, "5"],
		]);
	});

	it("flags a part negative in one value as below zero, though its total is positive", async () => {
		await nightLight();
		await adjustViaForm("NL-COVER", "5", "white");
		await adjustViaForm("NL-COVER", "-2", "black");
		const token = await connect(SCOPES);
		const below = await callTool(token, "stock_on_hand", { filter: "below_zero" });
		expect(below.data.parts).toEqual([
			expect.objectContaining({
				ref: "NL-COVER",
				on_hand: "3",
				by_options: [
					{ options: { Colour: "white" }, on_hand: "5" },
					{ options: { Colour: "black" }, on_hand: "-2" },
				],
			}),
		]);
	});

	it("shows the rules of a recipe line and the values each component takes, and explodes in a value", async () => {
		const n = await nightLight();
		const colour = await optionId("NL-COVER");
		// The cover line is chosen when planned; the head follows the light.
		await seedSql(
			stmt(
				"UPDATE assembly_lines SET chosen_option_ids = ? WHERE assembly_id = ? AND component_part_id = ?",
				String(colour),
				n.headAssembly,
				n.cover,
			),
			stmt(
				"UPDATE assembly_lines SET fixed_option_values = ? WHERE assembly_id = ? AND component_part_id = ?",
				String(await valueId("NL-HEAD", "black")),
				n.lightAssembly,
				n.head,
			),
		);
		const token = await connect(SCOPES);
		const tree = await callTool(token, "get_assembly", { assembly: "NL-LIGHT" });
		expect(tree.data.assembly).toMatchObject({ options: { Colour: "white" } });
		const [head, screw] = tree.data.lines as {
			ref: string;
			options?: object;
			fixed?: object;
			children: { ref: string; options?: object; choose?: string[]; fixed?: object }[];
		}[];
		expect(head).toMatchObject({ ref: "NL-HEAD", options: { Colour: "black" }, fixed: { Colour: "black" } });
		expect(head?.children[0]).toMatchObject({ ref: "NL-COVER", choose: ["Colour"], options: { Colour: "white" } });
		expect(head?.children[0]).not.toHaveProperty("fixed");
		expect(screw).not.toHaveProperty("options");

		await adjustViaForm("NL-COVER", "1", "white");
		await adjustViaForm("NL-COVER", "4", "black");
		await adjustViaForm("NL-HEAD", "1", "black");
		const black = await callTool(token, "explode_assembly", {
			assembly: "NL-LIGHT",
			qty: "2",
			options: { colour: "BLACK" },
		});
		expect(black.data.assembly).toMatchObject({ options: { Colour: "black" } });
		type Line = { ref: string; options?: { Colour: string }; qty: string; on_hand?: string };
		const cover = (black.data.components as Line[]).find((c) => c.ref === "NL-COVER");
		// The head is fixed to black, whatever the light is; the cover line is chosen at planning (the default here).
		expect(cover).toMatchObject({ options: { Colour: "white" }, qty: "2", on_hand: "1" });
		const stocked = await callTool(token, "explode_assembly", {
			assembly: "NL-LIGHT",
			qty: "1",
			options: { Colour: "white" },
			use_stock: true,
		});
		expect((stocked.data.components as Line[]).find((c) => c.ref === "NL-HEAD")).toMatchObject({
			options: { Colour: "black" },
			qty: "1",
			on_hand: "1",
		});

		for (const [options, text] of [
			[{ Colour: "red" }, "NL-LIGHT options: Colour has no value “red”. Values: white, black."],
			[{ Size: "L" }, "This part has no option “Size”"],
		] as const) {
			const bad = await callTool(token, "explode_assembly", { assembly: "NL-LIGHT", qty: "1", options });
			expect(bad.isError).toBe(true);
			expect(bad.text).toContain(text);
		}
		const plain = await callTool(token, "explode_assembly", {
			assembly: "NL-HEAD",
			qty: "1",
			options: { Colour: "white" },
		});
		expect(plain.isError).toBe(false);
		const screws = await callTool(token, "explode_assembly", { assembly: "NL-LIGHT", qty: "1" });
		expect((screws.data.components as Line[]).find((c) => c.ref === "NL-SCREW")).not.toHaveProperty("options");
	});

	it("shows the values of builds, their choices and pick lists, and the shortages and POs per values", async () => {
		const n = await nightLight();
		await seedSql(
			stmt(
				"UPDATE assembly_lines SET chosen_option_ids = ? WHERE assembly_id = ? AND component_part_id = ?",
				String(await optionId("NL-COVER")),
				n.headAssembly,
				n.cover,
			),
		);
		await adjustViaForm("NL-SCREW", "100");
		await adjustViaForm("NL-COVER", "2", "black");
		const token = await connect([...SCOPES, "builds:write", "purchasing:write"]);
		const plan = async (colour: string, cover: string) =>
			(
				await callTool(token, "plan_build", {
					ref: "NL-LIGHT",
					qty: "3",
					options: { Colour: colour },
					choices: [{ ref: "NL-COVER", options: { Colour: cover } }],
				})
			).data.build as { number: string };
		const first = await plan("white", "black");
		await plan("black", "white");

		const list = await callTool(token, "list_builds", {});
		expect(
			(list.data.builds as { options: object }[])
				.map((b) => b.options)
				.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
		).toEqual([{ Colour: "black" }, { Colour: "white" }]);
		const build = await callTool(token, "get_build", { number: first.number });
		expect(build.data.build).toMatchObject({
			options: { Colour: "white" },
			choices: [{ ref: "NL-COVER", options: { Colour: "black" } }],
		});
		const pickList = build.data.pick_list as {
			ref: string;
			options?: object;
			qty: string;
			on_hand: string;
			short: string;
		}[];
		expect(pickList.find((l) => l.ref === "NL-COVER")).toMatchObject({
			options: { Colour: "black" },
			qty: "3",
			on_hand: "2",
			short: "1",
		});
		expect(build.data.sub_assemblies).toEqual([
			expect.objectContaining({ ref: "NL-HEAD", options: { Colour: "white" } }),
		]);

		const short = await callTool(token, "get_shortages", {});
		type Group = { lines: { ref: string; options?: { Colour: string }; net: string; order: string }[] };
		const lines = (short.data.suppliers as Group[]).flatMap((g) => g.lines).filter((l) => l.ref === "NL-COVER");
		// Black: 3 needed by the white light's choice, 2 in stock; white: 3 for the black light.
		expect(lines.map((l) => [l.options?.Colour, l.net, l.order])).toEqual([
			["white", "3", "5"],
			["black", "1", "5"],
		]);
		expect(short.data.to_make).toEqual([
			expect.objectContaining({ ref: "NL-HEAD", options: { Colour: "white" }, qty: "3", builds: ["B-0001"] }),
			expect.objectContaining({ ref: "NL-HEAD", options: { Colour: "black" }, qty: "3", builds: ["B-0002"] }),
		]);

		const drafted = await callTool(token, "create_draft_pos", {});
		const number =
			(drafted.data.purchase_orders as { purchase_order: { number: string } }[])[0]?.purchase_order.number ?? "";
		const po = await callTool(token, "get_purchase_order", { number });
		expect(po.data.lines).toEqual([
			expect.objectContaining({ ref: "NL-COVER", options: { Colour: "white" }, qty: "5" }),
			expect.objectContaining({ ref: "NL-COVER", options: { Colour: "black" }, qty: "5" }),
		]);
	});

	it("lists a value a build asks of a component that does not come in it, and orders nothing for it", async () => {
		await nightLight();
		const coverWg = await insertPart("NL-COVER-WG", "buy", { supplierId: null });
		const plain = await insertPart("NL-PLAIN", "make");
		await seedSql(
			stmt(
				"INSERT INTO assemblies (parent_part_id, status, created_by, updated_by) VALUES (?, 'active', 's', 's')",
				plain,
			),
		);
		const assembly = (await one<{ id: number }>("SELECT id FROM assemblies WHERE parent_part_id = ?", plain)).id;
		await seedSql(
			stmt(
				"INSERT INTO assembly_lines (assembly_id, component_part_id, qty_milli, position, created_by, updated_by) VALUES (?, ?, 1000, 1, 's', 's')",
				assembly,
				coverWg,
			),
		);
		await addOption(plain, "Colour", ["white", "black"]);
		await addOption(coverWg, "Colour", ["white", "grey"]);
		// Planned through the page, which refuses it; a build made before the cover lost "black" is seeded.
		await seedSql(
			stmt(
				"INSERT INTO builds (number, part_id, assembly_id, status, qty_milli, option_values, created_by, updated_by) VALUES ('B-0001', ?, ?, 'planned', 1000, ?, 's', 's')",
				plain,
				assembly,
				String(await valueId("NL-PLAIN", "black")),
			),
		);
		const token = await connect(SCOPES);
		const short = await callTool(token, "get_shortages", {});
		expect(short.data.missing_values).toEqual([
			{ ref: "NL-COVER-WG", name: "Part NL-COVER-WG", option: "Colour", value: "black", builds: ["B-0001"] },
		]);
		expect(short.data.suppliers).toEqual([]);
		const build = await callTool(token, "get_build", { number: "B-0001" });
		expect(build.data.problems).toEqual([
			{ problem: "option_value_missing", ref: "NL-COVER-WG", option: "Colour", value: "black" },
		]);
		const flat = await callTool(token, "explode_assembly", {
			assembly: "NL-PLAIN",
			qty: "1",
			options: { Colour: "black" },
		});
		expect((flat.data.components as object[])[0]).toMatchObject({
			ref: "NL-COVER-WG",
			missing_value: { option: "Colour", value: "black" },
		});
	});
});
