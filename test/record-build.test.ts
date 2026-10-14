// Recording a finished build in one step (D152): planned and completed now, in one change set.
import { describe, expect, it } from "vitest";
import { importCsv, loadDemo, NOT_ADMIN, one, partId, postForm, request, rows, setRole } from "./helpers";

const today = () => new Date().toISOString().slice(0, 10);

async function record(ref: string, form: Record<string, string> = {}, overrides = {}) {
	const assembly = await one<{ id: number }>(
		"SELECT b.id FROM assemblies b JOIN parts p ON p.id = b.parent_part_id WHERE p.ref = ? AND b.status = 'active' ORDER BY b.code = 'std' DESC LIMIT 1",
		ref,
	);
	return postForm(
		"/builds/record",
		{
			part_id: String(await partId(ref)),
			assembly_id: String(assembly.id),
			qty: "1",
			qty_in: "units",
			serial: "",
			notes: "",
			...form,
		},
		overrides,
	);
}

const lastChangeSet = () =>
	one<{ id: number; summary: string; revertible: number }>(
		"SELECT id, summary, revertible FROM change_sets ORDER BY id DESC LIMIT 1",
	);

describe("record a finished build", () => {
	it("plans and completes a print run in one change set, with its machine time", async () => {
		await loadDemo();
		const page = await (await request("/builds/record")).text();
		expect(page).toContain("Record a finished build");
		expect(page).not.toContain('name="planned_for"');
		expect(await (await request("/builds")).text()).toContain('href="/builds/record"');
		const res = await record("LAMP-CLIP", { qty: "2", qty_in: "batches", notes: "Friday plates" });
		expect(res.status, await res.clone().text()).toBe(303);
		const id = Number(/\/builds\/(\d+)\?ok=recorded/.exec(res.headers.get("Location") ?? "")?.[1]);
		expect(await one("SELECT number, status, qty_milli, planned_for, notes FROM builds WHERE id = ?", id)).toEqual({
			number: "B-0001",
			status: "done",
			qty_milli: 48_000,
			planned_for: today(),
			notes: "Friday plates",
		});
		// One change set: the build planned then done, its moves and its machine time; ledger rows, so no undo.
		const set = await lastChangeSet();
		expect(set).toMatchObject({ summary: "Record build B-0001 of LAMP-CLIP", revertible: 0 });
		expect(await rows("SELECT table_name, op FROM change_log WHERE change_set_id = ? ORDER BY id", set.id)).toEqual([
			{ table_name: "builds", op: "insert" },
			{ table_name: "builds", op: "update" },
		]);
		expect(
			await rows(
				"SELECT reason, qty_milli, unit_cost_cents, ref_id FROM stock_moves WHERE ref_type = 'build' ORDER BY id",
			),
		).toEqual([
			{ reason: "build_consume", qty_milli: -520, unit_cost_cents: 2000, ref_id: id },
			{ reason: "build_output", qty_milli: 48_000, unit_cost_cents: 41, ref_id: id },
		]);
		expect(await rows("SELECT build_id, minutes_milli, rate_cents FROM build_machine_times")).toEqual([
			{ build_id: id, minutes_milli: 380_000, rate_cents: 150 },
		]);
		expect(await rows("SELECT build_id, qty_milli FROM build_lines")).toEqual([{ build_id: id, qty_milli: 520 }]);
		const done = await (await request(`/builds/${id}?ok=recorded`)).text();
		expect(done).toContain("Build recorded: stock updated.");
		expect(done).toContain("6 h 20");
	});

	it("takes sub-assemblies from stock when there are enough and builds the rest", async () => {
		await loadDemo();
		await importCsv("parts", "ref,name,kind\nSTAND,Lamp stand,make\n");
		await importCsv(
			"assemblies",
			"parent_ref,code,revision,status,component_ref,qty\nSTAND,std,Rev1,active,ARM-ASSY,1\nSTAND,std,Rev1,active,LAMP-CLIP,2\n",
		);
		// 2 arms in stock: the third is built; no clip in stock: 6 are printed (65 g, 47.5 min).
		const res = await record("STAND", { qty: "3" });
		expect(res.status, await res.clone().text()).toBe(303);
		const consumed = await rows<{ ref: string; qty: number }>(
			`SELECT p.ref, -SUM(m.qty_milli) AS qty FROM stock_moves m JOIN parts p ON p.id = m.part_id
			 WHERE m.reason = 'build_consume' GROUP BY p.ref ORDER BY p.ref`,
		);
		expect(consumed).toContainEqual({ ref: "ARM-ASSY", qty: 2000 });
		expect(consumed).toContainEqual({ ref: "ARM-TUBE-300", qty: 1000 });
		expect(consumed).toContainEqual({ ref: "PLA-BLACK", qty: 65 });
		expect(consumed.find((c) => c.ref === "LAMP-CLIP")).toBeUndefined();
		expect(await rows("SELECT minutes_milli FROM build_machine_times")).toEqual([{ minutes_milli: 47_500 }]);
	});

	it("refuses what the build page would ask for, writing nothing", async () => {
		await loadDemo();
		const before = (await lastChangeSet()).id;
		// The lamp's LED and driver are serial-tracked: they need the build page.
		const tracked = await record("LAMP-DESK", { serial: "L-0900" });
		expect(tracked.status).toBe(422);
		const html = await tracked.text();
		expect(html).toContain("This build cannot be recorded in one step");
		expect(html).toContain("DRV-12V, LED-5W-CW need one serial number per unit");
		// A serial-tracked product needs its serial, and one unit.
		expect(await (await record("LAMP-DESK")).text()).toContain("This product is serial-tracked");
		expect((await record("LAMP-CLIP", { qty: "0" })).status).toBe(422);
		expect((await lastChangeSet()).id).toBe(before);
		expect(await rows("SELECT id FROM builds")).toEqual([]);
	});

	it("needs the rights to plan and to complete builds", async () => {
		await loadDemo();
		await setRole("viewer");
		expect((await request("/builds/record", {}, NOT_ADMIN)).status).toBe(403);
		expect((await record("LAMP-CLIP", {}, NOT_ADMIN)).status).toBe(403);
		await setRole("operator");
		expect((await request("/builds", {}, NOT_ADMIN)).status).toBe(200);
		expect((await record("LAMP-CLIP", {}, NOT_ADMIN)).status).toBe(303);
	});
});
