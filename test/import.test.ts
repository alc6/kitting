import { beforeEach, describe, expect, it } from "vitest";
import smallAssemblies from "../examples/demo/assemblies.csv?raw";
import smallParts from "../examples/demo/parts.csv?raw";
import smallStock from "../examples/demo/stock.csv?raw";
import smallSuppliers from "../examples/demo/suppliers.csv?raw";
import demoAssemblies from "../examples/full/assemblies.csv?raw";
import demoMachineTypes from "../examples/full/machine_types.csv?raw";
import demoMachines from "../examples/full/machines.csv?raw";
import demoPartOptions from "../examples/full/part_options.csv?raw";
import demoOffers from "../examples/full/part_suppliers.csv?raw";
import demoParts from "../examples/full/parts.csv?raw";
import demoStock from "../examples/full/stock.csv?raw";
import demoSuppliers from "../examples/full/suppliers.csv?raw";
import {
	assemblyId,
	insertMove,
	insertPart,
	insertSupplier,
	NOT_ADMIN,
	one,
	postForm,
	request,
	rows,
	setRole,
} from "./helpers";

// NOT_ADMIN requests run as a planner, so admin-only actions are refused by requireAdmin itself.
beforeEach(() => setRole("planner"));

const preview = (type: string, csv: string, overrides = {}) => postForm(`/import/${type}/preview`, { csv }, overrides);
const commit = (type: string, csv: string, overrides = {}) => postForm(`/import/${type}/commit`, { csv }, overrides);

async function importOk(type: string, csv: string) {
	const p = await preview(type, csv);
	const html = await p.text();
	expect(p.status, html.match(/data-slot="alert".*?<\/table>/s)?.[0]).toBe(200);
	const c = await commit(type, csv);
	expect(c.status).toBe(303);
	return c.headers.get("Location")!;
}

describe("suppliers import", () => {
	it("previews, commits, then detects updates and unchanged rows", async () => {
		const csv = "name,email\nAcme,a@acme.example\nBolt Co,\n";
		const p = await preview("suppliers", csv);
		const html = await p.text();
		expect(html).toContain("2 to create, 0 to update, 0 unchanged.");
		expect(await rows("SELECT * FROM suppliers")).toHaveLength(0);
		expect(await importOk("suppliers", csv)).toBe("/import?done=suppliers&create=2&update=0");
		const again = await (await preview("suppliers", "name,email\nACME,new@acme.example\nBolt Co,\n")).text();
		expect(again).toContain("0 to create, 1 to update, 1 unchanged.");
		expect(again).toContain("email: a@acme.example → new@acme.example");
	});

	it("keeps columns that are absent from the file", async () => {
		await importOk("suppliers", "name,email,phone\nAcme,a@acme.example,+33 1\n");
		await importOk("suppliers", "name,notes\nAcme,Net 30\n");
		expect(await one("SELECT email, phone, notes FROM suppliers")).toEqual({
			email: "a@acme.example",
			phone: "+33 1",
			notes: "Net 30",
		});
	});
});

describe("parts import", () => {
	it("reports row-level errors with line numbers and writes nothing", async () => {
		await insertSupplier("Acme");
		const csv = [
			"ref,name,kind,cost,supplier,moq",
			"OK-1,Fine,buy,1.5,Acme,10",
			"BAD-1,Bad kind,gizmo,,,",
			"BAD-2,Bad cost,buy,abc,,",
			"BAD-3,Unknown supplier,buy,,Nobody,",
			"OK-1,Duplicate,buy,,,",
			",No ref,buy,,,",
		].join("\n");
		const res = await preview("parts", csv);
		expect(res.status).toBe(422);
		const html = await res.text();
		expect(html).toContain("5 error(s)");
		expect(html).toContain("Kind must be buy, make, kit or fee.");
		expect(html).toContain("Not a valid amount");
		expect(html).toContain("Unknown supplier “Nobody”");
		expect(html).toContain("Duplicate of line 2.");
		expect(html).not.toContain("Confirm import");
		// Committing anyway is refused and atomic.
		expect((await commit("parts", csv)).status).toBe(422);
		expect(await rows("SELECT * FROM parts")).toHaveLength(0);
	});

	it("imports and exports the minimum stock, empty meaning none", async () => {
		await importOk("parts", "ref,name,kind,min_stock\nA,Alpha,buy,25\nB,Beta,make,2.5\nC,Gamma,buy,\n");
		expect(await rows("SELECT ref, min_stock_milli FROM parts ORDER BY ref")).toEqual([
			{ ref: "A", min_stock_milli: 25000 },
			{ ref: "B", min_stock_milli: 2500 },
			{ ref: "C", min_stock_milli: null },
		]);
		const csv = await (await request("/import/parts/export.csv")).text();
		expect(csv).toContain(",min_stock,");
		expect(csv).toMatch(/^A,Alpha,buy,pcs,.*,25,no,$/m);
		expect(await (await preview("parts", csv)).text()).toContain("0 to create, 0 to update, 3 unchanged.");
		// The diff shows the change; a file without the column keeps the value; an empty cell removes it.
		const diff = await (await preview("parts", "ref,min_stock\nA,30\nB,\n")).text();
		expect(diff).toContain("min_stock: 25 → 30");
		expect(diff).toContain("min_stock: 2.5 → ∅");
		await importOk("parts", "ref,name\nA,Alpha 2\n");
		expect(await one("SELECT min_stock_milli FROM parts WHERE ref = 'A'")).toEqual({ min_stock_milli: 25000 });
		await importOk("parts", "ref,min_stock\nA,\n");
		expect(await one("SELECT min_stock_milli FROM parts WHERE ref = 'A'")).toEqual({ min_stock_milli: null });
	});

	it("refuses a negative or invalid minimum, and a minimum on a kit or a fee", async () => {
		const html = await (
			await preview("parts", "ref,name,kind,min_stock\nA,A,buy,-1\nB,B,buy,lots\nC,C,kit,5\nD,D,fee,1\n")
		).text();
		expect(html).toContain("Must be zero or more.");
		expect(html).toContain("Not a valid quantity");
		expect(html.match(/Only buy and make parts have a minimum stock\./g)).toHaveLength(2);
		expect((await commit("parts", "ref,name,kind,min_stock\nC,C,kit,5\n")).status).toBe(422);
		expect(await rows("SELECT * FROM parts")).toHaveLength(0);
	});

	it("upserts by ref and only touches the columns present", async () => {
		await insertSupplier("Acme");
		await importOk(
			"parts",
			"ref,name,kind,unit,cost,supplier,moq,pack_size,track_serial\nP1,Panel,buy,m,1.50,Acme,10,2.5,no\n",
		);
		expect(
			await one(
				`SELECT p.name, p.unit, p.cost_cents, o.moq_milli, o.pack_size_milli FROM parts p LEFT JOIN part_suppliers o ON o.part_id = p.id AND o.supplier_id = p.supplier_id`,
			),
		).toEqual({
			name: "Panel",
			unit: "m",
			cost_cents: 150,
			moq_milli: 10000,
			pack_size_milli: 2500,
		});
		const html = await (await preview("parts", "ref,cost\nP1,1.75\n")).text();
		expect(html).toContain("cost: 1.50 → 1.75");
		await importOk("parts", "ref,cost\nP1,1.75\n");
		expect(
			await one(
				`SELECT p.name, p.unit, p.cost_cents, o.moq_milli FROM parts p LEFT JOIN part_suppliers o ON o.part_id = p.id AND o.supplier_id = p.supplier_id`,
			),
		).toEqual({
			name: "Panel",
			unit: "m",
			cost_cents: 175,
			moq_milli: 10000,
		});
		// Each cost change is in the price history, tagged as an import.
		expect(await rows("SELECT price_cents, source FROM price_history WHERE kind = 'standard' ORDER BY id")).toEqual([
			{ price_cents: 150, source: "import" },
			{ price_cents: 175, source: "import" },
		]);
	});

	it("accepts French spreadsheets: semicolons, decimal commas, oui/non, Windows-1252", async () => {
		await insertSupplier("Acme");
		const text = "ref;name;kind;cost;supplier;track_serial\nP1;Câble éco;buy;0,45;Acme;oui\n";
		const bytes = new Uint8Array([...text].map((ch) => ({ â: 0xe2, é: 0xe9 })[ch] ?? ch.charCodeAt(0)));
		const form = new FormData();
		form.set("file", new File([bytes], "parts.csv", { type: "text/csv" }));
		const res = await request("/import/parts/preview", { method: "POST", body: form });
		expect(res.status).toBe(200);
		await commit("parts", text);
		expect(await one("SELECT name, cost_cents, track_serial FROM parts")).toEqual({
			name: "Câble éco",
			cost_cents: 45,
			track_serial: 1,
		});
	});

	it("rejects refs differing only by case and kit/fee for stocked parts", async () => {
		const id = await insertPart("ABC-1");
		await insertMove(id, 1000);
		const html = await (await preview("parts", "ref,name,kind\nabc-1,X,buy\nABC-1,X,kit\n")).text();
		expect(html).toContain("Differs only by upper/lower case from existing reference ABC-1.");
		expect(html).toContain("cannot become a kit or a fee");
	});

	it("only lets admins commit", async () => {
		const csv = "ref,name,kind\nP1,Part,buy\n";
		const html = await (await preview("parts", csv, NOT_ADMIN)).text();
		expect(html).toContain("Only administrators can confirm an import.");
		expect(html).not.toContain("Confirm import");
		expect((await commit("parts", csv, NOT_ADMIN)).status).toBe(403);
		expect(await rows("SELECT * FROM parts")).toHaveLength(0);
	});

	it("round-trips through export", async () => {
		await importOk("suppliers", demoSuppliers);
		await importOk("parts", demoParts);
		const res = await request("/import/parts/export.csv");
		const bytes = new Uint8Array(await res.clone().arrayBuffer());
		expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // BOM so Excel detects UTF-8
		const exported = await res.text();
		expect(exported.startsWith("ref,name,kind,unit,cost,sale_price,supplier")).toBe(true);
		const html = await (await preview("parts", exported)).text();
		expect(html).toContain("0 to create, 0 to update, 30 unchanged.");
		// French export uses semicolons and decimal commas, and re-imports cleanly too.
		const fr = await (await request("/import/parts/export.csv", { headers: { Cookie: "kitting_lang=fr" } })).text();
		expect(fr).toContain("LED-5W-CW;LED module 5W cool white;buy;pcs;4,20;;Lumen Parts Co");
		expect(await (await preview("parts", fr)).text()).toContain("0 to create, 0 to update, 30 unchanged.");
	});

	it("serves templates", async () => {
		const res = await request("/import/parts/template.csv");
		expect(res.headers.get("Content-Type")).toContain("text/csv");
		expect(res.headers.get("Content-Disposition")).toContain("parts-template.csv");
		const csv = await res.text();
		expect(csv).toContain(
			"ref,name,kind,unit,cost,sale_price,supplier,supplier_ref,moq,pack_size,lead_days,min_stock,track_serial,notes",
		);
		expect((await request("/import/nope/template.csv")).status).toBe(404);
	});
});

describe("stock import", () => {
	it("posts count moves for the difference only", async () => {
		const a = await insertPart("A", "buy", { costCents: 120 });
		await insertPart("B", "buy");
		await insertMove(a, 4000);
		await importOk("stock", "ref,qty\nA,10\nB,2.5\n");
		const moves = await rows<{ ref: string; qty_milli: number; reason: string; unit_cost_cents: number | null }>(
			"SELECT p.ref, m.qty_milli, m.reason, m.unit_cost_cents FROM stock_moves m JOIN parts p ON p.id = m.part_id WHERE m.reason = 'count' ORDER BY p.ref",
		);
		expect(moves).toEqual([
			{ ref: "A", qty_milli: 6000, reason: "count", unit_cost_cents: 120 },
			{ ref: "B", qty_milli: 2500, reason: "count", unit_cost_cents: null },
		]);
		// Same counts again: nothing to do.
		expect(await (await preview("stock", "ref,qty\nA,10\nB,2.5\n")).text()).toContain("0 to update, 2 unchanged");
	});

	it("records one move per serial for serial-tracked parts", async () => {
		await insertPart("LED", "buy", { trackSerial: true });
		await importOk("stock", "ref,qty,serial\nLED,1,S1\nLED,1,S2\n");
		expect(await rows("SELECT serial, qty_milli FROM stock_moves ORDER BY serial")).toEqual([
			{ serial: "S1", qty_milli: 1000 },
			{ serial: "S2", qty_milli: 1000 },
		]);
	});

	it("rejects unknown refs, kits, bad serial rows and duplicates", async () => {
		await insertPart("KIT", "kit");
		await insertPart("PLAIN", "buy");
		await insertPart("OTHER", "buy");
		await insertPart("TRACKED", "buy", { trackSerial: true });
		const csv = ["ref,qty,serial", "NOPE,1,", "KIT,1,", "PLAIN,1,X1", "TRACKED,2,S1", "OTHER,3,", "OTHER,4,"].join(
			"\n",
		);
		const html = await (await preview("stock", csv)).text();
		expect(html).toContain("Unknown part reference “NOPE”.");
		expect(html).toContain("kit parts are never stocked.");
		expect(html).toContain("one row per serial with quantity 1");
		expect(html).toContain("Duplicate of line 6.");
		// Errors are listed in file order.
		const lines = [
			...html.matchAll(/<td data-slot="table-cell"[^>]*>(\d+)<\/td><td data-slot="table-cell"[^>]*><code>/g),
		].map((m) => Number(m[1]));
		expect(lines).toHaveLength(5);
		expect(lines).toEqual([...lines].sort((a, b) => a - b));
	});
});

describe("small demo dataset", () => {
	it("imports cleanly in order", async () => {
		await importOk("suppliers", smallSuppliers);
		await importOk("parts", smallParts);
		await importOk("assemblies", smallAssemblies);
		await importOk("stock", smallStock);
		expect(await one("SELECT count(*) AS n FROM parts")).toEqual({ n: 6 });
		expect(await one("SELECT count(*) AS n FROM assembly_lines")).toEqual({ n: 5 });
		expect(await one("SELECT count(*) AS n FROM part_suppliers")).toEqual({ n: 4 });
		// The README's numbers: the lamp costs 17.60 (base 6.60 + LED 4.20 + shade 6.80) and sells for 49.00.
		const tree = await (await request(`/assemblies/${await assemblyId("DESK-LAMP")}/tree`)).text();
		expect(tree).toContain("€17.60");
	});
});

describe("full dataset", () => {
	it("imports cleanly in order", async () => {
		await importOk("suppliers", demoSuppliers);
		await importOk("parts", demoParts);
		await importOk("part_options", demoPartOptions);
		await importOk("part_suppliers", demoOffers);
		await importOk("machine_types", demoMachineTypes);
		await importOk("machines", demoMachines);
		await importOk("assemblies", demoAssemblies);
		await importOk("stock", demoStock);
		expect(await one("SELECT count(*) AS n FROM suppliers")).toEqual({ n: 7 });
		expect(await one("SELECT count(*) AS n FROM parts")).toEqual({ n: 30 });
		// 19 preferred offers from parts.csv plus 4 alternatives from part_suppliers.csv.
		expect(await one("SELECT count(*) AS n FROM part_suppliers")).toEqual({ n: 23 });
		// The printed cable clip: 24 per plate, 190 minutes on an FDM printer (3 h 10).
		expect(
			await one(
				`SELECT b.batch_qty_milli, m.name AS machine, b.machine_minutes, m.hourly_rate_cents
				 FROM assemblies b JOIN parts p ON p.id = b.parent_part_id JOIN machine_types m ON m.id = b.machine_type_id
				 WHERE p.ref = 'LAMP-CLIP'`,
			),
		).toEqual({ batch_qty_milli: 24_000, machine: "FDM printer", machine_minutes: 190, hourly_rate_cents: 150 });
		expect(await rows("SELECT name, status FROM machines ORDER BY name")).toEqual([
			{ name: "PRINTER-1", status: "active" },
			{ name: "PRINTER-2", status: "active" },
			{ name: "PRINTER-3", status: "maintenance" },
		]);
		expect(
			await one(
				"SELECT o.price_cents, o.lead_days FROM part_suppliers o JOIN parts p ON p.id = o.part_id JOIN suppliers s ON s.id = o.supplier_id WHERE p.ref = 'DRV-12V' AND s.name = 'Quickparts Express'",
			),
		).toEqual({ price_cents: 790, lead_days: 3 });
		expect(await one("SELECT sale_price_cents FROM parts WHERE ref = 'LAMP-DESK'")).toEqual({ sale_price_cents: 8900 });
		expect(await one("SELECT sale_price_cents FROM assemblies WHERE code = 'warm'")).toEqual({
			sale_price_cents: 9400,
		});
		expect(
			await one(
				"SELECT SUM(qty_milli) AS n FROM stock_moves m JOIN parts p ON p.id = m.part_id WHERE p.ref = 'LED-5W-CW'",
			),
		).toEqual({ n: 6000 });
		expect(
			await one(
				"SELECT SUM(qty_milli) AS n FROM stock_moves m JOIN parts p ON p.id = m.part_id WHERE p.ref = 'CABLE-2C'",
			),
		).toEqual({ n: 42500 });
	});
});
