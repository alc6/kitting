import { describe, expect, it } from "vitest";
import type { Role } from "../src/db/schema";
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
	setRole,
	stmt,
} from "./helpers";

// Distinctive amounts seeded below. None of them may reach a user who does not see costs, in any format
// (HTML with grouping, CSV without it).
const COST = 123456; // standard cost of BOX-LAMP
const OFFER = 111111; // its offer price
const SALE = 999999; // selling price of LAMP-DESK
const PAID = 98765; // PO unit price, also the cost of the receipt moves
const PAST = 77777; // a past standard cost entered as history (D142)
const RATE = 66666; // hourly rate of the FDM printer type (D147)
// The history keeps rows as JSON with raw cents: those must not leak either.
const AMOUNTS = [
	"1,234.56",
	"1234.56",
	"1,111.11",
	"1111.11",
	"9,999.99",
	"9999.99",
	"987.65",
	"123456",
	"111111",
	"999999",
	"98765",
	"777.77",
	"77777",
	"666.66",
	"66666",
];

/**
 * Demo data with the amounts above, a PO received in part, a WIDGET assembly, one done build, and one open build
 * larger than the stock, so the shortage page prices a BOX-LAMP line.
 */
async function seed() {
	await loadDemo();
	const box = await partId("BOX-LAMP");
	// Recorded in the history like a page would, so the history pages hold these amounts too.
	await changeSql(
		"Set prices",
		stmt("UPDATE parts SET cost_cents = ? WHERE id = ?", COST, box),
		stmt("UPDATE part_suppliers SET price_cents = ? WHERE part_id = ?", OFFER, box),
		stmt("UPDATE parts SET sale_price_cents = ? WHERE ref = 'LAMP-DESK'", SALE),
		stmt(
			`INSERT INTO price_history (part_id, kind, price_cents, valid_from, source, created_by, updated_by)
			 VALUES (?, 'standard', ?, '2026-01-01', 'form', 'seed', 'seed')`,
			box,
			COST,
		),
		stmt(
			`INSERT INTO price_history (part_id, kind, price_cents, valid_from, source, created_by, updated_by)
			 VALUES (?, 'standard', ?, '2025-01-01', 'import', 'seed', 'seed')`,
			box,
			PAST,
		),
	);
	const supplier = (await one<{ id: number }>("SELECT supplier_id AS id FROM parts WHERE id = ?", box)).id;
	const po = await postForm("/purchasing/po", { supplier_id: String(supplier), expected_at: "", notes: "" });
	const poId = Number(/\/po\/(\d+)/.exec(po.headers.get("Location") ?? "")?.[1]);
	await postForm(`/purchasing/po/${poId}/lines`, { part: "BOX-LAMP", qty: "10", price: "987.65" });
	await postForm(`/purchasing/po/${poId}/send`, {});
	const line = (await one<{ id: number }>("SELECT id FROM po_lines WHERE po_id = ?", poId)).id;
	await postForm(`/purchasing/po/${poId}/receive`, { [`recv_${line}`]: "4" });

	const widget = await insertPart("WIDGET", "make");
	await importCsv(
		"assemblies",
		"parent_ref,code,revision,status,sale_price,component_ref,qty\nWIDGET,std,R1,active,,BOX-LAMP,1\n",
	);
	const plan = async (qty: string) => {
		const res = await postForm("/builds", {
			part_id: String(widget),
			assembly_id: String(await assemblyId("WIDGET")),
			qty,
			serial: "",
			planned_for: "",
			notes: "",
		});
		return Number(/\/builds\/(\d+)/.exec(res.headers.get("Location") ?? "")?.[1]);
	};
	const done = await plan("1");
	expect((await postForm(`/builds/${done}/complete`, {})).status).toBe(303);
	const open = await plan("100");
	const priced = (await one<{ id: number }>("SELECT min(id) AS id FROM change_sets WHERE summary = 'Set prices'")).id;
	// A machine rate, through the form (logged in the history and the rate history), and a printed clip built with it.
	const type = (await one<{ id: number }>("SELECT id FROM machine_types WHERE name = 'FDM printer'")).id;
	await postForm(`/machines/types/${type}`, { name: "FDM printer", hourly_rate: "666.66", notes: "" });
	const rated = (await one<{ id: number }>("SELECT max(id) AS id FROM change_sets")).id;
	const clip = await partId("LAMP-CLIP");
	const clipAssembly = await assemblyId("LAMP-CLIP");
	const printed = await postForm("/builds", {
		part_id: String(clip),
		assembly_id: String(clipAssembly),
		qty: "1",
		qty_in: "batches",
		serial: "",
		planned_for: "",
		notes: "",
	});
	const clipBuild = Number(/\/builds\/(\d+)/.exec(printed.headers.get("Location") ?? "")?.[1]);
	expect((await postForm(`/builds/${clipBuild}/complete`, {})).status).toBe(303);
	expect(await one("SELECT rate_cents FROM build_machine_times WHERE build_id = ?", clipBuild)).toEqual({
		rate_cents: RATE,
	});
	const machine = (await one<{ id: number }>("SELECT id FROM machines WHERE name = 'PRINTER-1'")).id;
	// A print file on the clip's recipe: listed on its assembly and build pages, edited on its own page.
	await changeSql(
		"Attach a file",
		stmt(
			`INSERT INTO files (assembly_id, name, kind, format, size_bytes, sha256, object_key, uploaded_at, uploaded_by,
				created_by, updated_by) VALUES (?, 'clip plate.3mf', 'print', '3mf', 4096, 'ab', 'files/clip', '2026-01-01', 'seed', 'seed', 'seed')`,
			clipAssembly,
		),
	);
	const file = (await one<{ id: number }>("SELECT max(id) AS id FROM files")).id;
	return {
		box,
		widget,
		supplier,
		poId,
		done,
		open,
		priced,
		assembly: await assemblyId("WIDGET"),
		lampAssembly: await assemblyId("LAMP-DESK"),
		type,
		rated,
		clip,
		clipAssembly,
		clipBuild,
		file,
		machine,
	};
}

function pages(s: Awaited<ReturnType<typeof seed>>): string[] {
	return [
		"/",
		"/parts",
		// WIDGET has no standard cost: the list shows its assembly roll-up, which is BOX-LAMP's cost (D176).
		"/parts?q=WIDGET",
		`/parts/${s.box}`,
		`/parts/${s.box}/prices`,
		`/parts/${s.box}/stock`,
		`/parts/${s.widget}`,
		`/parts/${s.widget}/prices`,
		`/parts/${s.widget}/stock`,
		"/suppliers",
		`/suppliers/${s.supplier}`,
		`/suppliers/${s.supplier}/edit`,
		"/assemblies",
		`/assemblies/${s.assembly}`,
		`/assemblies/${s.assembly}/tree`,
		`/assemblies/${s.assembly}/diagram`,
		`/assemblies/${s.assembly}/explode`,
		`/assemblies/${s.assembly}/explode?qty=1&format=csv`,
		`/assemblies/${s.lampAssembly}`,
		`/assemblies/${s.lampAssembly}/explode`,
		"/builds",
		`/builds/new?part=${s.widget}`,
		`/builds/${s.done}`,
		`/builds/${s.open}`,
		"/purchasing",
		"/purchasing/po",
		`/purchasing/po/${s.poId}`,
		"/stock",
		"/stock/moves",
		"/stock/moves?format=csv",
		"/stock/count",
		"/stock/adjust",
		"/search?q=BOX",
		"/parts/pick",
		"/parts/pick?q=BOX",
		"/history",
		`/history/${s.priced}`,
		`/parts/${s.box}/history`,
		`/suppliers/${s.supplier}/history`,
		`/assemblies/${s.lampAssembly}/history`,
		`/purchasing/po/${s.poId}/history`,
		"/connected-apps",
		"/machines",
		"/machines?retired=1",
		`/machines/types/${s.type}`,
		`/machines/${s.machine}`,
		`/machines/${s.machine}/edit`,
		`/parts/${s.clip}`,
		`/assemblies/${s.clipAssembly}`,
		`/assemblies/${s.clipAssembly}/tree`,
		`/assemblies/${s.clipAssembly}/explode`,
		`/assemblies/${s.clipAssembly}/explode?format=csv`,
		`/builds/${s.clipBuild}`,
		`/history/${s.rated}`,
		// Closed to these roles: refused without leaking anything.
		"/margins",
		"/margins?cost=actual",
		`/margins/assemblies/${s.lampAssembly}`,
		"/stock/valuation",
		`/purchasing/po/${s.poId}/export.csv`,
		"/import/parts/export.csv",
		"/import/price_history/export.csv",
		"/import/price_history/template.csv",
		"/import/machine_types/export.csv",
		// Part options (D168, D177): no amount on them, listed so a future one is caught.
		`/parts/${s.box}/options`,
		"/import/part_options/export.csv",
		`/margins/assemblies/${s.clipAssembly}`,
		"/import/backup.json",
		`/files/${s.file}/edit`,
	];
}

async function leaks(role: Role, s: Awaited<ReturnType<typeof seed>>) {
	await setRole(role);
	const found: string[] = [];
	for (const path of pages(s)) {
		const res = await request(path, {}, NOT_ADMIN);
		expect(res.status, `${role} ${path}`).toBeLessThan(500);
		const body = await res.text();
		for (const amount of AMOUNTS) if (body.includes(amount)) found.push(`${path}: ${amount}`);
	}
	return found;
}

describe("cost visibility", () => {
	it("hides every cost, price and margin from operators and viewers", async () => {
		const s = await seed();
		expect(await leaks("operator", s)).toEqual([]);
		expect(await leaks("viewer", s)).toEqual([]);
	});

	it("shows them to planners, and to the others once an admin allows it", async () => {
		const s = await seed();
		await setRole("planner");
		const part = await (await request(`/parts/${s.box}`, {}, NOT_ADMIN)).text();
		expect(part).toContain("1,234.56");
		// The offer price and the past cost are on the Suppliers & prices tab (D182).
		const prices = await (await request(`/parts/${s.box}/prices`, {}, NOT_ADMIN)).text();
		expect(prices).toContain("1,111.11");
		expect(prices).toContain("777.77");
		expect(await (await request("/parts?q=WIDGET", {}, NOT_ADMIN)).text()).toContain("1,234.56");
		expect(await (await request(`/purchasing/po/${s.poId}`, {}, NOT_ADMIN)).text()).toContain("987.65");
		expect(await (await request("/stock/moves?format=csv", {}, NOT_ADMIN)).text()).toContain("987.65");
		expect(await (await request(`/history/${s.priced}`, {}, NOT_ADMIN)).text()).toContain("1,234.56");
		expect(await (await request(`/purchasing/po/${s.poId}/history`, {}, NOT_ADMIN)).text()).toContain("987.65");
		// The machine rate, where the sweep looks for it (so the sweep would catch a leak there).
		for (const path of ["/machines", `/machines/types/${s.type}`, `/builds/${s.clipBuild}`, `/history/${s.rated}`])
			expect(await (await request(path, {}, NOT_ADMIN)).text(), path).toContain("666.66");
		expect(await (await request(`/assemblies/${s.clipAssembly}/explode?format=csv`, {}, NOT_ADMIN)).text()).toContain(
			"FDM printer,Machine time,machine,h,3.167,,,666.66,",
		);

		await letLowerRolesSeeCosts();
		await setRole("operator");
		expect(await (await request(`/parts/${s.box}`, {}, NOT_ADMIN)).text()).toContain("1,234.56");
		expect(await (await request(`/assemblies/${s.lampAssembly}`, {}, NOT_ADMIN)).text()).toContain("9,999.99");
		expect((await request("/margins", {}, NOT_ADMIN)).status).toBe(200);
	});

	it("lets an operator receive a delivery without seeing its prices", async () => {
		const s = await seed();
		await setRole("operator");
		const page = await (await request(`/purchasing/po/${s.poId}`, {}, NOT_ADMIN)).text();
		expect(page).toContain(`action="/purchasing/po/${s.poId}/receive"`);
		expect(page).not.toContain(`action="/purchasing/po/${s.poId}/close"`);
		const line = (await one<{ id: number }>("SELECT id FROM po_lines WHERE po_id = ?", s.poId)).id;
		const res = await postForm(`/purchasing/po/${s.poId}/receive`, { [`recv_${line}`]: "6" }, NOT_ADMIN);
		expect(res.status).toBe(303);
		expect(await one("SELECT status FROM purchase_orders WHERE id = ?", s.poId)).toEqual({ status: "received" });
		// The receipt is still valued at the PO price, which the operator never saw.
		expect(
			await one("SELECT SUM(qty_milli) AS q, MAX(unit_cost_cents) AS c FROM stock_moves WHERE reason = 'receipt'"),
		).toEqual({ q: 10_000, c: PAID });
	});

	it("hides the controls a role cannot use", async () => {
		const s = await seed();
		await setRole("viewer");
		const build = await (await request(`/builds/${s.open}`, {}, NOT_ADMIN)).text();
		expect(build).not.toContain(`action="/builds/${s.open}/start"`);
		expect(build).not.toContain("Complete build");
		const part = await (await request(`/parts/${s.box}`, {}, NOT_ADMIN)).text();
		expect(part).not.toContain(`href="/parts/${s.box}/edit"`);
		expect(part).not.toContain(`href="/stock/adjust?part=${s.box}"`);
		expect((await request(`/parts/${s.box}/edit`, {}, NOT_ADMIN)).status).toBe(403);

		await setRole("operator");
		const opBuild = await (await request(`/builds/${s.open}`, {}, NOT_ADMIN)).text();
		expect(opBuild).toContain(`action="/builds/${s.open}/start"`);
		const opPart = await (await request(`/parts/${s.box}`, {}, NOT_ADMIN)).text();
		expect(opPart).toContain(`href="/stock/adjust?part=${s.box}"`);
		expect(opPart).not.toContain(`href="/parts/${s.box}/edit"`);
		const assembly = await (await request(`/assemblies/${s.assembly}`, {}, NOT_ADMIN)).text();
		expect(assembly).not.toContain(`action="/assemblies/${s.assembly}/lines"`);
		expect(assembly).not.toContain(`action="/assemblies/${s.assembly}/revision"`);
		const supplier = await (await request(`/suppliers/${s.supplier}`, {}, NOT_ADMIN)).text();
		expect(supplier).not.toContain(`action="/suppliers/${s.supplier}"`);
	});
});
