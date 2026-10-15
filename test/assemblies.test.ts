import { beforeEach, describe, expect, it } from "vitest";
import {
	assemblyId,
	DEMO,
	insertPart,
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

// NOT_ADMIN requests run as a planner, so admin-only actions are refused by requireAdmin itself.
beforeEach(() => setRole("planner"));

async function createAssembly(parentId: number, code = "std", revision = "Rev1", copyFrom = "") {
	const res = await postForm("/assemblies", {
		parent_part_id: String(parentId),
		code,
		revision,
		notes: "",
		copy_from: copyFrom,
	});
	return res;
}

const lines = (id: number) =>
	rows<{ ref: string; qty_milli: number; position: number }>(
		"SELECT p.ref, l.qty_milli, l.position FROM assembly_lines l JOIN parts p ON p.id = l.component_part_id WHERE l.assembly_id = ? ORDER BY l.position",
		id,
	);

describe("Assembly editor", () => {
	it("creates an assembly for make/kit parts only", async () => {
		const make = await insertPart("ASSY", "make");
		const buy = await insertPart("BOLT", "buy");
		const res = await createAssembly(make);
		expect(res.status).toBe(303);
		const assembly = await one<{ id: number; status: string; code: string }>("SELECT id, status, code FROM assemblies");
		expect(assembly).toMatchObject({ status: "draft", code: "std" });
		expect(res.headers.get("Location")).toBe(`/assemblies/${assembly.id}?ok=saved`);
		const bad = await createAssembly(buy);
		expect(bad.status).toBe(422);
		expect(await bad.text()).toContain("Only make and kit parts can have an assembly.");
		const dup = await createAssembly(make);
		expect(await dup.text()).toContain("already has an assembly with this variant code and revision");
	});

	it("adds, updates, reorders and removes lines", async () => {
		const make = await insertPart("ASSY", "make");
		await insertPart("BOLT", "buy", { costCents: 10 });
		await insertPart("NUT", "buy", { costCents: 5 });
		await createAssembly(make);
		const id = (await one<{ id: number }>("SELECT id FROM assemblies")).id;
		expect((await postForm(`/assemblies/${id}/lines`, { component: "BOLT", qty: "4", notes: "" })).status).toBe(303);
		await postForm(`/assemblies/${id}/lines`, { component: "NUT — Part NUT", qty: "2,5", notes: "" });
		expect(await lines(id)).toEqual([
			{ ref: "BOLT", qty_milli: 4000, position: 1 },
			{ ref: "NUT", qty_milli: 2500, position: 2 },
		]);
		const nutLine = (await one<{ id: number }>("SELECT id FROM assembly_lines WHERE qty_milli = 2500")).id;
		await postForm(`/assemblies/${id}/lines/${nutLine}/move`, { dir: "up" });
		expect((await lines(id)).map((l) => l.ref)).toEqual(["NUT", "BOLT"]);
		await postForm(`/assemblies/${id}/lines/${nutLine}`, { qty: "3" });
		expect((await lines(id))[0]).toEqual({ ref: "NUT", qty_milli: 3000, position: 1 });
		const html = await (await request(`/assemblies/${id}`)).text();
		expect(html).toContain("€0.55"); // 3 x 0.05 + 4 x 0.10
		await postForm(`/assemblies/${id}/lines/${nutLine}/delete`, {});
		expect((await lines(id)).map((l) => l.ref)).toEqual(["BOLT"]);
	});

	it("validates lines: unknown part, zero quantity, self and cycles", async () => {
		await loadDemo({ stock: false });
		const arm = await assemblyId("ARM-ASSY");
		const unknown = await postForm(`/assemblies/${arm}/lines`, { component: "NOPE", qty: "1", notes: "" });
		expect(unknown.status).toBe(422);
		expect(await unknown.text()).toContain("Unknown part reference “NOPE”.");
		expect(
			await (await postForm(`/assemblies/${arm}/lines`, { component: "PAD-FELT", qty: "0", notes: "" })).text(),
		).toContain("Must be more than zero.");
		const self = await postForm(`/assemblies/${arm}/lines`, { component: "ARM-ASSY", qty: "1", notes: "" });
		expect(await self.text()).toContain("This would create a cycle");
		const cycle = await postForm(`/assemblies/${arm}/lines`, { component: "LAMP-DESK", qty: "1", notes: "" });
		expect(cycle.status).toBe(422);
		expect(await cycle.text()).toContain("This would create a cycle: LAMP-DESK already contains ARM-ASSY");
		expect(await one("SELECT count(*) AS n FROM assembly_lines WHERE assembly_id = ?", arm)).toEqual({ n: 5 });
		const half = await postForm(`/assemblies/${arm}/lines`, { component: "LED-5W-CW", qty: "0.5", notes: "" });
		expect(await half.text()).toContain("A serial-tracked component must be used in whole units.");
	});

	it("activates a revision and archives the previous active one", async () => {
		await loadDemo({ stock: false });
		const rev2 = await assemblyId("LAMP-DESK", "std", "Rev2");
		const res = await postForm(`/assemblies/${rev2}/revision`, {});
		const rev3 = await assemblyId("LAMP-DESK", "std", "Rev3");
		expect(res.headers.get("Location")).toBe(`/assemblies/${rev3}?ok=saved`);
		expect((await lines(rev3)).map((l) => [l.ref, l.qty_milli])).toEqual(
			(await lines(rev2)).map((l) => [l.ref, l.qty_milli]),
		);
		expect(await one("SELECT status FROM assemblies WHERE id = ?", rev3)).toEqual({ status: "draft" });
		await postForm(`/assemblies/${rev3}/activate`, {});
		const statuses = await rows<{ revision: string; code: string; status: string }>(
			"SELECT b.code, b.revision, b.status FROM assemblies b JOIN parts p ON p.id = b.parent_part_id WHERE p.ref = 'LAMP-DESK' ORDER BY b.code, b.revision",
		);
		expect(statuses).toEqual([
			{ code: "std", revision: "Rev1", status: "archived" },
			{ code: "std", revision: "Rev2", status: "archived" },
			{ code: "std", revision: "Rev3", status: "active" },
			{ code: "warm", revision: "Rev1", status: "active" }, // other variant untouched
		]);
	});

	it("copies lines into a new variant", async () => {
		await loadDemo({ stock: false });
		const std = await assemblyId("LAMP-DESK");
		const res = await createAssembly(await partId("LAMP-DESK"), "3-3-3-4-4", "Rev1", String(std));
		expect(res.status).toBe(303);
		expect((await lines(await assemblyId("LAMP-DESK", "3-3-3-4-4", "Rev1"))).length).toBe(7);
	});

	it("keeps archived assemblies read-only and archive/delete admin-only", async () => {
		await loadDemo({ stock: false });
		const rev1 = await assemblyId("LAMP-DESK", "std", "Rev1");
		const add = await postForm(`/assemblies/${rev1}/lines`, { component: "PAD-FELT", qty: "1", notes: "" });
		expect(add.status).toBe(422);
		expect(await add.text()).toContain("Archived assemblies are read-only.");
		const rev2 = await assemblyId("LAMP-DESK", "std", "Rev2");
		expect((await postForm(`/assemblies/${rev2}/archive`, {}, NOT_ADMIN)).status).toBe(403);
		expect((await postForm(`/assemblies/${rev2}/delete`, {}, NOT_ADMIN)).status).toBe(403);
		expect((await postForm(`/assemblies/${rev2}/archive`, {})).status).toBe(303);
		expect(await one("SELECT status FROM assemblies WHERE id = ?", rev2)).toEqual({ status: "archived" });
		expect((await postForm(`/assemblies/${rev1}/delete`, {})).headers.get("Location")).toContain("ok=deleted");
		expect(await rows("SELECT id FROM assembly_lines WHERE assembly_id = ?", rev1)).toEqual([]);
	});
});

describe("Assembly views", () => {
	it("renders the tree with cumulative quantities and the roll-up", async () => {
		await loadDemo({ stock: false });
		const html = await (await request(`/assemblies/${await assemblyId("LAMP-DESK")}/tree?qty=2`)).text();
		expect(html).toContain("ARM-ASSY");
		expect(html).toContain("<details open=");
		expect(html).toContain("€37.83");
		expect(html).toContain("€75.66");
		expect(html).toContain("FIX-KIT-HEAD"); // nested kit shown in the tree
		expect(html).toContain("Incomplete: no cost for MANUAL.");
	});

	it("draws the structure diagram down to the nested kit, with links and totals", async () => {
		await loadDemo({ stock: false });
		const id = await assemblyId("LAMP-DESK");
		const html = await (await request(`/assemblies/${id}/diagram?qty=2`)).text();
		expect(html).toContain("<svg");
		expect(html).toContain("Structure of LAMP-DESK");
		// Root, a kit, the kit inside it, and its leaves; each box links to its part.
		for (const ref of ["LAMP-DESK", "HEAD-KIT-CW", "FIX-KIT-HEAD", "WASHER-M3"]) {
			expect(html).toContain(`<a href="/parts/${await partId(ref)}"`);
		}
		expect(html).toMatch(/data-kind="kit" data-mode="kit"/);
		// Sub-assemblies and kits open their own diagram.
		expect(html).toContain(`href="/assemblies/${await assemblyId("FIX-KIT-HEAD")}/diagram"`);
		// Totals for 2 lamps: 2 × 1 head kit × 1 fixing kit × 3 washers = 6, and the roll-up.
		expect(html).toMatch(/WASHER-M3.*?6 pcs/s);
		expect(html).toContain("€75.66 *");
		// The tab is there on every assembly page; strict CSP: no inline styles.
		expect(await (await request(`/assemblies/${id}`)).text()).toContain(`href="/assemblies/${id}/diagram"`);
		expect(html).not.toMatch(/\sstyle=/);
	});

	it("limits the diagram by depth or to sub-assemblies and kits", async () => {
		await loadDemo({ stock: false });
		const id = await assemblyId("LAMP-DESK");
		const top = await (await request(`/assemblies/${id}/diagram?depth=1`)).text();
		expect(top).toContain("HEAD-KIT-CW");
		expect(top).not.toContain("FIX-KIT-HEAD");
		// HEAD-KIT-CW hides 4 components plus the 2 inside the fixing kit; the pill opens one more level.
		expect(top).toContain(">+6</text>");
		expect(top).toContain(`href="/assemblies/${id}/diagram?depth=2"`);

		const structure = await (await request(`/assemblies/${id}/diagram?only=assemblies`)).text();
		expect(structure).toContain("FIX-KIT-HEAD");
		expect(structure).not.toContain("SCREW-M4X10");
		expect(structure).toContain(`href="/assemblies/${id}/diagram"`); // "+N" shows everything again
	});

	it("lists the flat explosion, optionally using sub-assembly stock, and exports CSV", async () => {
		await loadDemo();
		const id = await assemblyId("LAMP-DESK");
		const html = await (await request(`/assemblies/${id}/explode?qty=3`)).text();
		expect(html).toMatch(/SCREW-M3X8<\/a>.*?<span class="num">33<\/span>/s);
		// A sub-assembly row (marked "from stock") only appears when taking sub-assemblies from stock.
		const fromStock = /ARM-ASSY<\/a><\/td><td[^>]*>Arm sub-assembly<span data-slot="badge"[^>]*>from stock</;
		expect(html).not.toMatch(fromStock);
		expect(html).toContain(`href="/assemblies/${id}/explode?qty=3&amp;format=csv"`);
		const withStock = await (await request(`/assemblies/${id}/explode?qty=3&stock=on`)).text();
		expect(withStock).toMatch(fromStock);
		const csv = await (await request(`/assemblies/${id}/explode?qty=3&format=csv`)).text();
		expect(csv).toContain("SCREW-M3X8,Screw M3x8,buy,pcs,33,350,0,0.02,0.66");
		expect(csv).toContain("FEE-WEEE,WEEE eco-fee,fee,pcs,3,,,0.25,0.75");
	});

	it("shows assemblies, roll-up and where-used on the part page", async () => {
		await loadDemo({ stock: false });
		const lamp = await (await request(`/parts/${await partId("LAMP-DESK")}`)).text();
		expect(lamp).toContain("Assemblies");
		expect(lamp).toContain("Rev2");
		expect(lamp).toContain("Incomplete: no cost for MANUAL.");
		const screw = await (await request(`/parts/${await partId("SCREW-M3X8")}`)).text();
		expect(screw).toContain("Where used");
		expect(screw).toContain("via ARM-ASSY");
	});

	it("lists and searches assemblies", async () => {
		await loadDemo({ stock: false });
		const html = await (await request("/assemblies?q=assy")).text();
		expect(html).toContain("ARM-ASSY");
		expect(html).toContain("BASE-ASSY");
		expect(html).not.toContain(">LAMP-DESK<");
		expect(html).toContain(`href="/assemblies/${await assemblyId("ARM-ASSY")}/diagram"`);
		// Archived assemblies are hidden unless asked for (only StatusBadge renders "status-archived").
		expect(await (await request("/assemblies")).text()).not.toContain("status-archived");
		expect(await (await request("/assemblies?status=archived")).text()).toContain("status-archived");
	});
});

describe("assemblies.csv import", () => {
	const preview = (csv: string) => postForm("/import/assemblies/preview", { csv });

	it("imports the demo assemblies and is idempotent", async () => {
		await loadDemo();
		expect(await one("SELECT count(*) AS n FROM assemblies")).toEqual({ n: 11 });
		expect(await one("SELECT count(*) AS n FROM assemblies WHERE status = 'active'")).toEqual({ n: 10 });
		const html = await (await preview(DEMO.assemblies)).text();
		expect(html).toContain("0 to create, 0 to update, 11 unchanged.");
		const exported = await (await request("/import/assemblies/export.csv")).text();
		expect(
			exported.startsWith(
				"parent_ref,code,revision,status,sale_price,batch_qty,machine,machine_minutes,component_ref,qty,notes",
			),
		).toBe(true);
		// The warm variant's own selling price survives the round trip.
		expect(exported).toContain("LAMP-DESK,warm,Rev1,active,94.00,1,");
		expect(await (await preview(exported)).text()).toContain("0 to create, 0 to update, 11 unchanged.");
		expect(exported).toContain("LAMP-CLIP,std,Rev1,active,,24,FDM printer,190,PLA-BLACK,0.26,");
	});

	it("replaces lines, activates and archives the previous revision", async () => {
		await loadDemo({ stock: false });
		const csv =
			"parent_ref,code,revision,status,component_ref,qty\nARM-ASSY,std,Rev2,active,ARM-TUBE-300,1\nARM-ASSY,std,Rev2,active,JOINT-KNOB,3\n";
		const html = await (await preview(csv)).text();
		expect(html).toContain("1 to create");
		expect(html).toContain("Rev1: active → archived");
		expect((await postForm("/import/assemblies/commit", { csv })).status).toBe(303);
		const rev2 = await assemblyId("ARM-ASSY", "std", "Rev2");
		expect((await lines(rev2)).map((l) => [l.ref, l.qty_milli])).toEqual([
			["ARM-TUBE-300", 1000],
			["JOINT-KNOB", 3000],
		]);
		expect(
			await one("SELECT status FROM assemblies WHERE id = ?", await assemblyId("ARM-ASSY", "std", "Rev1")),
		).toEqual({
			status: "archived",
		});
		const update = "parent_ref,code,revision,status,component_ref,qty\nARM-ASSY,std,Rev2,active,ARM-TUBE-300,2\n";
		const diff = await (await preview(update)).text();
		expect(diff).toContain("ARM-TUBE-300: 1 → 2");
		expect(diff).toContain("− JOINT-KNOB");
	});

	it("keeps the variant's own price on a new revision unless the file has a sale_price column (D166)", async () => {
		await loadDemo({ stock: false });
		const price = async (code: string, revision: string) => {
			const id = await assemblyId("LAMP-DESK", code, revision);
			return {
				own: (
					await one<{ sale_price_cents: number | null }>("SELECT sale_price_cents FROM assemblies WHERE id = ?", id)
				).sale_price_cents,
				history: await rows("SELECT price_cents, source FROM price_history WHERE assembly_id = ? ORDER BY id", id),
			};
		};
		const lampCsv = (status: string, revision: string, code = "warm", salePrice?: string) =>
			[
				`parent_ref,code,revision,status,${salePrice === undefined ? "" : "sale_price,"}component_ref,qty`,
				...["BASE-ASSY,1", "ARM-ASSY,2", "HEAD-KIT-WW,1"].map(
					(line) => `LAMP-DESK,${code},${revision},${status},${salePrice === undefined ? "" : `${salePrice},`}${line}`,
				),
			].join("\n");
		// Without the column: the new revision keeps the variant's price, logged; the archived one keeps its own.
		expect((await postForm("/import/assemblies/commit", { csv: lampCsv("active", "Rev2") })).status).toBe(303);
		expect(await price("warm", "Rev2")).toEqual({ own: 9400, history: [{ price_cents: 9400, source: "import" }] });
		expect((await price("warm", "Rev1")).own).toBe(9400);
		// A draft revision takes the active one's; with the column, the file decides (empty: none).
		await seedSql(
			stmt("UPDATE assemblies SET sale_price_cents = 9900 WHERE id = ?", await assemblyId("LAMP-DESK", "warm", "Rev2")),
		);
		expect((await postForm("/import/assemblies/commit", { csv: lampCsv("draft", "Rev3") })).status).toBe(303);
		expect((await price("warm", "Rev3")).own).toBe(9900);
		expect((await postForm("/import/assemblies/commit", { csv: lampCsv("draft", "Rev4", "warm", "") })).status).toBe(
			303,
		);
		expect(await price("warm", "Rev4")).toEqual({ own: null, history: [] });
		// The active revision's price, not the newest's (Rev4 has none).
		expect((await postForm("/import/assemblies/commit", { csv: lampCsv("draft", "Rev5") })).status).toBe(303);
		expect((await price("warm", "Rev5")).own).toBe(9900);
		// A new variant code has nothing to keep.
		expect((await postForm("/import/assemblies/commit", { csv: lampCsv("draft", "Rev1", "cool") })).status).toBe(303);
		expect(await price("cool", "Rev1")).toEqual({ own: null, history: [] });
	});

	it("rejects cycles, bad parents, mixed statuses and duplicate active variants", async () => {
		await loadDemo({ stock: false });
		const csv = [
			"parent_ref,code,revision,status,component_ref,qty",
			"ARM-ASSY,std,Rev9,active,LAMP-DESK,1",
			"PAD-FELT,std,Rev1,active,SCREW-M3X8,1",
			"BASE-ASSY,std,Rev5,draft,PAD-FELT,1",
			"BASE-ASSY,std,Rev5,active,SCREW-M3X8,1",
			"HEAD-KIT-CW,std,Rev7,active,LED-5W-CW,1",
			"HEAD-KIT-CW,std,Rev8,active,LED-5W-CW,1",
			"BASE-ASSY,std,Rev6,draft,NOPE,1",
			"BASE-ASSY,std,Rev6,draft,DRV-12V,0.5",
		].join("\n");
		const res = await preview(csv);
		expect(res.status).toBe(422);
		const html = await res.text();
		expect(html).toContain("Assembly cycle: ");
		expect(html).toContain("Only make and kit parts can have an assembly.");
		expect(html).toContain("All lines of an assembly must have the same status.");
		expect(html).toContain("Two active assemblies for the same part and variant code (line 6).");
		expect(html).toContain("Unknown part reference “NOPE”.");
		expect(html).toContain("A serial-tracked component must be used in whole units.");
	});
});
