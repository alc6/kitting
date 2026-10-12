import { describe, expect, it } from "vitest";
import { bomId, DEMO, insertPart, loadDemo, one, partId, postForm, request, rows } from "./helpers";

const NOT_ADMIN = { ADMIN_EMAILS: "someone-else@example.com" };

async function createBom(parentId: number, code = "std", revision = "Rev1", copyFrom = "") {
	const res = await postForm("/boms", {
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
		"SELECT p.ref, l.qty_milli, l.position FROM bom_lines l JOIN parts p ON p.id = l.component_part_id WHERE l.bom_id = ? ORDER BY l.position",
		id,
	);

describe("BoM editor", () => {
	it("creates a BoM for make/kit parts only", async () => {
		const make = await insertPart("ASSY", "make");
		const buy = await insertPart("BOLT", "buy");
		const res = await createBom(make);
		expect(res.status).toBe(303);
		const bom = await one<{ id: number; status: string; code: string }>("SELECT id, status, code FROM boms");
		expect(bom).toMatchObject({ status: "draft", code: "std" });
		expect(res.headers.get("Location")).toBe(`/boms/${bom.id}?ok=saved`);
		const bad = await createBom(buy);
		expect(bad.status).toBe(422);
		expect(await bad.text()).toContain("Only make and kit parts can have a BoM.");
		const dup = await createBom(make);
		expect(await dup.text()).toContain("already has a BoM with this variant code and revision");
	});

	it("adds, updates, reorders and removes lines", async () => {
		const make = await insertPart("ASSY", "make");
		await insertPart("BOLT", "buy", { costCents: 10 });
		await insertPart("NUT", "buy", { costCents: 5 });
		await createBom(make);
		const id = (await one<{ id: number }>("SELECT id FROM boms")).id;
		expect((await postForm(`/boms/${id}/lines`, { component: "BOLT", qty: "4", notes: "" })).status).toBe(303);
		await postForm(`/boms/${id}/lines`, { component: "NUT — Part NUT", qty: "2,5", notes: "" });
		expect(await lines(id)).toEqual([
			{ ref: "BOLT", qty_milli: 4000, position: 1 },
			{ ref: "NUT", qty_milli: 2500, position: 2 },
		]);
		const nutLine = (await one<{ id: number }>("SELECT id FROM bom_lines WHERE qty_milli = 2500")).id;
		await postForm(`/boms/${id}/lines/${nutLine}/move`, { dir: "up" });
		expect((await lines(id)).map((l) => l.ref)).toEqual(["NUT", "BOLT"]);
		await postForm(`/boms/${id}/lines/${nutLine}`, { qty: "3" });
		expect((await lines(id))[0]).toEqual({ ref: "NUT", qty_milli: 3000, position: 1 });
		const html = await (await request(`/boms/${id}`)).text();
		expect(html).toContain("€0.55"); // 3 x 0.05 + 4 x 0.10
		await postForm(`/boms/${id}/lines/${nutLine}/delete`, {});
		expect((await lines(id)).map((l) => l.ref)).toEqual(["BOLT"]);
	});

	it("validates lines: unknown part, zero quantity, self and cycles", async () => {
		await loadDemo({ stock: false });
		const arm = await bomId("ARM-ASSY");
		const unknown = await postForm(`/boms/${arm}/lines`, { component: "NOPE", qty: "1", notes: "" });
		expect(unknown.status).toBe(422);
		expect(await unknown.text()).toContain("Unknown part reference “NOPE”.");
		expect(
			await (await postForm(`/boms/${arm}/lines`, { component: "PAD-FELT", qty: "0", notes: "" })).text(),
		).toContain("Must be more than zero.");
		const self = await postForm(`/boms/${arm}/lines`, { component: "ARM-ASSY", qty: "1", notes: "" });
		expect(await self.text()).toContain("This would create a cycle");
		const cycle = await postForm(`/boms/${arm}/lines`, { component: "LAMP-DESK", qty: "1", notes: "" });
		expect(cycle.status).toBe(422);
		expect(await cycle.text()).toContain("This would create a cycle: LAMP-DESK already contains ARM-ASSY");
		expect(await one("SELECT count(*) AS n FROM bom_lines WHERE bom_id = ?", arm)).toEqual({ n: 5 });
		const half = await postForm(`/boms/${arm}/lines`, { component: "LED-5W-CW", qty: "0.5", notes: "" });
		expect(await half.text()).toContain("A serial-tracked component must be used in whole units.");
	});

	it("activates a revision and archives the previous active one", async () => {
		await loadDemo({ stock: false });
		const rev2 = await bomId("LAMP-DESK", "std", "Rev2");
		const res = await postForm(`/boms/${rev2}/revision`, {});
		const rev3 = await bomId("LAMP-DESK", "std", "Rev3");
		expect(res.headers.get("Location")).toBe(`/boms/${rev3}?ok=saved`);
		expect((await lines(rev3)).map((l) => [l.ref, l.qty_milli])).toEqual(
			(await lines(rev2)).map((l) => [l.ref, l.qty_milli]),
		);
		expect(await one("SELECT status FROM boms WHERE id = ?", rev3)).toEqual({ status: "draft" });
		await postForm(`/boms/${rev3}/activate`, {});
		const statuses = await rows<{ revision: string; code: string; status: string }>(
			"SELECT b.code, b.revision, b.status FROM boms b JOIN parts p ON p.id = b.parent_part_id WHERE p.ref = 'LAMP-DESK' ORDER BY b.code, b.revision",
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
		const std = await bomId("LAMP-DESK");
		const res = await createBom(await partId("LAMP-DESK"), "3-3-3-4-4", "Rev1", String(std));
		expect(res.status).toBe(303);
		expect((await lines(await bomId("LAMP-DESK", "3-3-3-4-4", "Rev1"))).length).toBe(7);
	});

	it("keeps archived BoMs read-only and archive/delete admin-only", async () => {
		await loadDemo({ stock: false });
		const rev1 = await bomId("LAMP-DESK", "std", "Rev1");
		const add = await postForm(`/boms/${rev1}/lines`, { component: "PAD-FELT", qty: "1", notes: "" });
		expect(add.status).toBe(422);
		expect(await add.text()).toContain("Archived BoMs are read-only.");
		const rev2 = await bomId("LAMP-DESK", "std", "Rev2");
		expect((await postForm(`/boms/${rev2}/archive`, {}, NOT_ADMIN)).status).toBe(403);
		expect((await postForm(`/boms/${rev2}/delete`, {}, NOT_ADMIN)).status).toBe(403);
		expect((await postForm(`/boms/${rev2}/archive`, {})).status).toBe(303);
		expect(await one("SELECT status FROM boms WHERE id = ?", rev2)).toEqual({ status: "archived" });
		expect((await postForm(`/boms/${rev1}/delete`, {})).headers.get("Location")).toContain("ok=deleted");
		expect(await rows("SELECT id FROM bom_lines WHERE bom_id = ?", rev1)).toEqual([]);
	});
});

describe("BoM views", () => {
	it("renders the tree with cumulative quantities and the roll-up", async () => {
		await loadDemo({ stock: false });
		const html = await (await request(`/boms/${await bomId("LAMP-DESK")}/tree?qty=2`)).text();
		expect(html).toContain("ARM-ASSY");
		expect(html).toContain("<details open=");
		expect(html).toContain("€37.80");
		expect(html).toContain("€75.60");
		expect(html).toContain("Incomplete: no cost for MANUAL.");
	});

	it("lists the flat explosion, optionally using sub-assembly stock, and exports CSV", async () => {
		await loadDemo();
		const id = await bomId("LAMP-DESK");
		const html = await (await request(`/boms/${id}/explode?qty=3`)).text();
		expect(html).toMatch(/SCREW-M3X8<\/a>.*?<span class="num">33<\/span>/s);
		expect(html).not.toMatch(/ARM-ASSY<\/a><\/td><td>Arm sub-assembly<span class="tag">from stock/);
		const withStock = await (await request(`/boms/${id}/explode?qty=3&stock=on`)).text();
		expect(withStock).toMatch(/ARM-ASSY<\/a><\/td><td>Arm sub-assembly<span class="tag">from stock/);
		const csv = await (await request(`/boms/${id}/explode?qty=3&format=csv`)).text();
		expect(csv).toContain("SCREW-M3X8,Screw M3x8,buy,pcs,33,350,0,0.02,0.66");
		expect(csv).toContain("FEE-WEEE,WEEE eco-fee,fee,pcs,3,,,0.25,0.75");
	});

	it("shows BoMs, roll-up and where-used on the part page", async () => {
		await loadDemo({ stock: false });
		const lamp = await (await request(`/parts/${await partId("LAMP-DESK")}`)).text();
		expect(lamp).toContain("Bills of materials");
		expect(lamp).toContain("Rev2");
		expect(lamp).toContain("Incomplete: no cost for MANUAL.");
		const screw = await (await request(`/parts/${await partId("SCREW-M3X8")}`)).text();
		expect(screw).toContain("Where used");
		expect(screw).toContain("via ARM-ASSY");
	});

	it("lists and searches BoMs", async () => {
		await loadDemo({ stock: false });
		const html = await (await request("/boms?q=assy")).text();
		expect(html).toContain("ARM-ASSY");
		expect(html).toContain("BASE-ASSY");
		expect(html).not.toContain(">LAMP-DESK<");
		expect(await (await request("/boms")).text()).not.toContain('Rev1</td><td><span class="status status-archived');
		expect(await (await request("/boms?status=archived")).text()).toContain("status-archived");
	});
});

describe("boms.csv import", () => {
	const preview = (csv: string) => postForm("/import/boms/preview", { csv });

	it("imports the demo BoMs and is idempotent", async () => {
		await loadDemo();
		expect(await one("SELECT count(*) AS n FROM boms")).toEqual({ n: 7 });
		expect(await one("SELECT count(*) AS n FROM boms WHERE status = 'active'")).toEqual({ n: 6 });
		const html = await (await preview(DEMO.boms)).text();
		expect(html).toContain("0 to create, 0 to update, 7 unchanged.");
		const exported = await (await request("/import/boms/export.csv")).text();
		expect(exported.startsWith("parent_ref,code,revision,status,component_ref,qty,notes")).toBe(true);
		expect(await (await preview(exported)).text()).toContain("0 to create, 0 to update, 7 unchanged.");
	});

	it("replaces lines, activates and archives the previous revision", async () => {
		await loadDemo({ stock: false });
		const csv =
			"parent_ref,code,revision,status,component_ref,qty\nARM-ASSY,std,Rev2,active,ARM-TUBE-300,1\nARM-ASSY,std,Rev2,active,JOINT-KNOB,3\n";
		const html = await (await preview(csv)).text();
		expect(html).toContain("1 to create");
		expect(html).toContain("Rev1: active → archived");
		expect((await postForm("/import/boms/commit", { csv })).status).toBe(303);
		const rev2 = await bomId("ARM-ASSY", "std", "Rev2");
		expect((await lines(rev2)).map((l) => [l.ref, l.qty_milli])).toEqual([
			["ARM-TUBE-300", 1000],
			["JOINT-KNOB", 3000],
		]);
		expect(await one("SELECT status FROM boms WHERE id = ?", await bomId("ARM-ASSY", "std", "Rev1"))).toEqual({
			status: "archived",
		});
		const update = "parent_ref,code,revision,status,component_ref,qty\nARM-ASSY,std,Rev2,active,ARM-TUBE-300,2\n";
		const diff = await (await preview(update)).text();
		expect(diff).toContain("ARM-TUBE-300: 1 → 2");
		expect(diff).toContain("− JOINT-KNOB");
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
		expect(html).toContain("BoM cycle: ");
		expect(html).toContain("Only make and kit parts can have a BoM.");
		expect(html).toContain("All lines of a BoM must have the same status.");
		expect(html).toContain("Two active BoMs for the same part and variant code (line 6).");
		expect(html).toContain("Unknown part reference “NOPE”.");
		expect(html).toContain("A serial-tracked component must be used in whole units.");
	});
});
