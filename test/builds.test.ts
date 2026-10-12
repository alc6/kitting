import { describe, expect, it } from "vitest";
import { loadGraph } from "../src/domain/boms";
import { buildPickList, completionStatements, getBuild } from "../src/domain/builds";
import { onHandAt } from "../src/domain/stock";
import { runBatch } from "../src/lib/db";
import { bomId, insertMove, insertPart, loadDemo, one, partId, postForm, request, rows, testDb } from "./helpers";

const onHand = async (ref: string) =>
	(
		await one<{ q: number | null }>(
			"SELECT SUM(m.qty_milli) AS q FROM stock_moves m JOIN parts p ON p.id = m.part_id WHERE p.ref = ?",
			ref,
		)
	).q ?? 0;

async function planBuild(ref: string, opts: { serial?: string; qty?: string; code?: string } = {}) {
	const res = await postForm("/builds", {
		part_id: String(await partId(ref)),
		bom_id: String(await bomId(ref, opts.code ?? "std")),
		qty: opts.qty ?? "1",
		serial: opts.serial ?? "",
		planned_for: "2026-11-02",
		notes: "",
	});
	expect(res.status, await res.clone().text()).toBe(303);
	return Number(/\/builds\/(\d+)/.exec(res.headers.get("Location") ?? "")?.[1]);
}

/** Field names of the serial inputs on a pick list page. */
const serialInputs = (html: string) => [...html.matchAll(/name="(serial:\d+:\d+)"/g)].map((m) => m[1] as string);

/** A section of the build page, from the element with this id to `end` (searched after it). */
function section(html: string, id: string, end: string): string {
	const start = html.indexOf(`id="${id}"`);
	expect(start, `missing #${id}`).toBeGreaterThan(-1);
	const stop = html.indexOf(end, start);
	return html.slice(start, stop === -1 ? undefined : stop);
}
/** The sub-assemblies card ("use stock" / "build now" choices), which precedes the pick lines. */
const subAssemblies = (html: string) => section(html, "sub-assemblies", 'id="pick-lines"');
/** The pick lines card: what is actually taken from stock. */
const pickLines = (html: string) => section(html, "pick-lines", "</form>");

describe("planning builds", () => {
	it("numbers builds and enforces serial rules for tracked products", async () => {
		await loadDemo();
		const lamp = await partId("LAMP-DESK");
		const base = { part_id: String(lamp), bom_id: String(await bomId("LAMP-DESK")), planned_for: "", notes: "" };
		const noSerial = await postForm("/builds", { ...base, qty: "1", serial: "" });
		expect(noSerial.status).toBe(422);
		expect(await noSerial.text()).toContain("This product is serial-tracked: enter its serial number.");
		const two = await postForm("/builds", { ...base, qty: "2", serial: "L-1" });
		expect(await two.text()).toContain("A serial-tracked product is built one unit at a time.");
		const first = await planBuild("LAMP-DESK", { serial: "L-1" });
		const dup = await postForm("/builds", { ...base, qty: "1", serial: "L-1" });
		expect(await dup.text()).toContain("This serial number is already used for this product.");
		expect(await one("SELECT number, status, qty_milli, serial, planned_for FROM builds WHERE id = ?", first)).toEqual({
			number: "B-0001",
			status: "planned",
			qty_milli: 1000,
			serial: "L-1",
			planned_for: "2026-11-02",
		});
		// Cancelling frees the serial.
		await postForm(`/builds/${first}/cancel`, {});
		const again = await planBuild("LAMP-DESK", { serial: "L-1" });
		expect(await one("SELECT number FROM builds WHERE id = ?", again)).toEqual({ number: "B-0002" });
	});

	it("refuses buy parts and BoMs of another part", async () => {
		await loadDemo({ stock: false });
		const res = await postForm("/builds", {
			part_id: String(await partId("LAMP-DESK")),
			bom_id: String(await bomId("ARM-ASSY")),
			qty: "1",
			serial: "X",
			planned_for: "",
			notes: "",
		});
		expect(await res.text()).toContain("Choose an active BoM of this part.");
		const buy = await postForm("/builds", {
			part_id: String(await partId("PAD-FELT")),
			bom_id: "",
			qty: "1",
			serial: "",
			planned_for: "",
			notes: "",
		});
		expect(await buy.text()).toContain("Only make parts can be built.");
	});

	it("shows variants of the chosen product", async () => {
		await loadDemo({ stock: false });
		const html = await (await request(`/builds/new?part_id=${await partId("LAMP-DESK")}`)).text();
		expect(html).toContain("std (Rev2)");
		expect(html).toContain("warm (Rev1)");
		expect(html).not.toContain('Rev1)</option><option value=""');
	});
});

describe("pick list", () => {
	it("takes sub-assemblies from stock by default and lets the user build them instead", async () => {
		await loadDemo();
		const id = await planBuild("LAMP-DESK", { serial: "L-1" });
		const html = await (await request(`/builds/${id}`)).text();
		expect(html).toContain("Pick list");
		expect(pickLines(html)).toContain(">ARM-ASSY</a>"); // consumed from stock
		expect(html).not.toContain("ARM-TUBE-300</a>");
		expect(serialInputs(html)).toHaveLength(2); // one LED + one driver
		const path = /ARM-ASSY<\/a>.*?name="choice:([\d/]+)"/s.exec(subAssemblies(html))?.[1];
		expect(path).toBeTruthy();
		const built = await (await request(`/builds/${id}?${new URLSearchParams({ [`choice:${path}`]: "build" })}`)).text();
		expect(built).toContain("ARM-TUBE-300</a>");
		expect(pickLines(built)).not.toContain(">ARM-ASSY</a>");
		expect(subAssemblies(built)).toContain(">ARM-ASSY</a>"); // still offered, now built
		expect(built).toContain(`name="choice:${path}" value="build" checked`);
	});
});

describe("completing builds", () => {
	it("refuses to complete while serials are missing and writes nothing", async () => {
		await loadDemo();
		const id = await planBuild("LAMP-DESK", { serial: "L-1" });
		const res = await postForm(`/builds/${id}/complete`, {});
		expect(res.status).toBe(422);
		const html = await res.text();
		expect(html.match(/Serial required\./g)).toHaveLength(2);
		expect(await rows("SELECT id FROM stock_moves WHERE ref_type = 'build'")).toEqual([]);
		expect(await one("SELECT status FROM builds WHERE id = ?", id)).toEqual({ status: "planned" });
	});

	it("consumes components, outputs the serial and records the as-built lines", async () => {
		await loadDemo();
		const id = await planBuild("LAMP-DESK", { serial: "L-0042" });
		const page = await (await request(`/builds/${id}`)).text();
		const [ledField, drvField] = serialInputs(page).sort();
		const led = await partId("LED-5W-CW");
		const fields: Record<string, string> = {};
		for (const f of serialInputs(page)) fields[f] = f.startsWith(`serial:${led}:`) ? "CW-24-0003" : "DRV-7A-101";
		expect(ledField && drvField).toBeTruthy();
		const before = {
			arms: await onHand("ARM-ASSY"),
			screws: await onHand("SCREW-M3X8"),
			washers: await onHand("WASHER-M3"),
			leds: await onHand("LED-5W-CW"),
		};
		const res = await postForm(`/builds/${id}/complete`, fields);
		expect(res.headers.get("Location")).toBe(`/builds/${id}?ok=completed`);
		expect(await one("SELECT status FROM builds WHERE id = ?", id)).toEqual({ status: "done" });
		expect(await onHand("ARM-ASSY")).toBe(before.arms - 2000);
		expect(await onHand("SCREW-M3X8")).toBe(before.screws - 3000); // fixing kit only; arms came from stock
		expect(await onHand("WASHER-M3")).toBe(before.washers - 3000); // two kit levels down
		expect(await onHand("FIX-KIT-HEAD")).toBe(0); // kits are never stocked
		expect(await onHand("LED-5W-CW")).toBe(before.leds - 1000);
		expect(await onHand("LAMP-DESK")).toBe(1000);
		expect(await onHand("FEE-WEEE")).toBe(0); // fees are never stocked
		const output = await one<{ serial: string; unit_cost_cents: number; qty_milli: number }>(
			"SELECT serial, unit_cost_cents, qty_milli FROM stock_moves WHERE reason = 'build_output' AND ref_id = ?",
			id,
		);
		expect(output).toEqual({ serial: "L-0042", unit_cost_cents: 3783, qty_milli: 1000 }); // frozen as-built cost
		const lines = await rows<{ ref: string; serial: string | null; qty_milli: number }>(
			"SELECT p.ref, l.serial, l.qty_milli FROM build_lines l JOIN parts p ON p.id = l.part_id WHERE l.build_id = ? ORDER BY p.ref",
			id,
		);
		expect(lines.find((l) => l.ref === "LED-5W-CW")).toEqual({
			ref: "LED-5W-CW",
			serial: "CW-24-0003",
			qty_milli: 1000,
		});
		expect(lines.find((l) => l.ref === "ARM-ASSY")).toEqual({ ref: "ARM-ASSY", serial: null, qty_milli: 2000 });
		expect(lines.map((l) => l.ref)).not.toContain("FEE-WEEE");
		expect(lines.map((l) => l.ref)).not.toContain("HEAD-KIT-CW");
		expect(lines.map((l) => l.ref)).not.toContain("FIX-KIT-HEAD");
		expect(lines.find((l) => l.ref === "WASHER-M3")).toEqual({ ref: "WASHER-M3", serial: null, qty_milli: 3000 });
		const detail = await (await request(`/builds/${id}`)).text();
		expect(detail).toContain("As-built record");
		expect(detail).toContain("CW-24-0003");
		// "What is inside serial L-0042?" and "where did LED CW-24-0003 go?"
		expect(await (await request("/builds?status=all&q=CW-24-0003")).text()).toContain("B-0001");
		expect(await (await request("/builds?status=all&q=L-0042")).text()).toContain("B-0001");
	});

	it("refuses a second completion, even when racing past the status check", async () => {
		await loadDemo();
		const id = await planBuild("ARM-ASSY", { qty: "2" });
		expect((await postForm(`/builds/${id}/complete`, {})).status).toBe(303);
		const again = await postForm(`/builds/${id}/complete`, {});
		expect(again.headers.get("Location")).toBe(`/builds/${id}?err=build_not_open`);
		// Simulate a race: a batch prepared while the build was still open.
		const db = testDb();
		const data = (await getBuild(db, id))!;
		const graph = await loadGraph(db);
		const pick = buildPickList(graph, await onHandAt(db), data.build, data.part, {}, true);
		const stmts = completionStatements(db, graph, data.build, pick, "racer@example.com", new Date().toISOString());
		await expect(runBatch(db, stmts)).rejects.toThrow();
		expect(await one("SELECT count(*) AS n FROM stock_moves WHERE reason = 'build_output' AND ref_id = ?", id)).toEqual(
			{
				n: 1,
			},
		);
		expect(await rows("SELECT id FROM stock_moves WHERE by = 'racer@example.com'")).toEqual([]);
	});

	it("pre-builds sub-assemblies in batches", async () => {
		await loadDemo();
		const id = await planBuild("ARM-ASSY", { qty: "3" });
		const tubes = await onHand("ARM-TUBE-300");
		await postForm(`/builds/${id}/complete`, {});
		expect(await onHand("ARM-ASSY")).toBe(5000);
		expect(await onHand("ARM-TUBE-300")).toBe(tubes - 3000);
		expect(await onHand("CABLE-2C")).toBe(42_500 - 1050);
	});

	it("traces serials through sub-assemblies", async () => {
		const sub = await insertPart("SUB", "make", { trackSerial: true });
		const top = await insertPart("TOP", "make", { trackSerial: true });
		const cell = await insertPart("CELL", "buy", { trackSerial: true, costCents: 500 });
		await insertMove(cell, 1000, "count", "C-1");
		for (const [parent, comp] of [
			[sub, "CELL"],
			[top, "SUB"],
		] as const) {
			await postForm("/boms", {
				parent_part_id: String(parent),
				code: "std",
				revision: "Rev1",
				notes: "",
				copy_from: "",
			});
			const b = (await one<{ id: number }>("SELECT id FROM boms WHERE parent_part_id = ?", parent)).id;
			await postForm(`/boms/${b}/lines`, { component: comp, qty: "1", notes: "" });
			await postForm(`/boms/${b}/activate`, {});
		}
		const subBuild = await planBuild("SUB", { serial: "S-1" });
		await postForm(`/builds/${subBuild}/complete`, { [`serial:${cell}:0`]: "C-1" });
		const topBuild = await planBuild("TOP", { serial: "T-1" });
		const res = await postForm(`/builds/${topBuild}/complete`, { [`serial:${sub}:0`]: "S-1" });
		expect(res.status).toBe(303);
		const html = await (await request(`/builds/${topBuild}`)).text();
		// The serial links to the build that produced it.
		expect(html).toMatch(
			new RegExp(`>S-1</span><a [^>]*href="/builds/${subBuild}"[^>]*>(?:<svg[\\s\\S]*?</svg>)?built in B-0001</a>`),
		);
		expect(await onHand("SUB")).toBe(0);
		expect(await onHand("TOP")).toBe(1000);
	});

	it("refuses a build whose sub-assembly has no BoM and must be built", async () => {
		const top = await insertPart("TOP", "make");
		await insertPart("NOBOM", "make");
		await postForm("/boms", { parent_part_id: String(top), code: "std", revision: "Rev1", notes: "", copy_from: "" });
		const b = (await one<{ id: number }>("SELECT id FROM boms")).id;
		await postForm(`/boms/${b}/lines`, { component: "NOBOM", qty: "1", notes: "" });
		await postForm(`/boms/${b}/activate`, {});
		const id = await planBuild("TOP");
		const res = await postForm(`/builds/${id}/complete`, {});
		expect(res.status).toBe(422);
		expect(await res.text()).toContain("NOBOM must be built but has no active BoM.");
	});

	it("starts and cancels builds without touching stock", async () => {
		await loadDemo();
		const id = await planBuild("ARM-ASSY");
		await postForm(`/builds/${id}/start`, {});
		expect(await one("SELECT status FROM builds WHERE id = ?", id)).toEqual({ status: "in_progress" });
		await postForm(`/builds/${id}/cancel`, {});
		expect(await one("SELECT status FROM builds WHERE id = ?", id)).toEqual({ status: "cancelled" });
		expect(await rows("SELECT id FROM stock_moves WHERE ref_type = 'build'")).toEqual([]);
		expect((await postForm(`/builds/${id}/complete`, {})).headers.get("Location")).toBe(
			`/builds/${id}?err=build_not_open`,
		);
	});
});
