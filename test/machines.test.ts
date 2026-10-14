// Machines and machine time (D147–D151): types with an hourly rate, machines, machine time in recipes, costs, builds,
// plans, dated readers, undo and CSV.
import { describe, expect, it } from "vitest";
import { loadGraph } from "../src/domain/assemblies";
import { buildGraph, CostCalculator, explode, type GraphPart } from "../src/domain/assembly-graph";
import { planImport } from "../src/domain/import";
import { marginHistory, plannedMarginSeries } from "../src/domain/margin-history";
import { computeShortages } from "../src/domain/purchasing";
import { revertChangeSet } from "../src/domain/revert";
import { valuation } from "../src/domain/stock";
import { formatMinutes, formatMinutesInput, machineMillicents, parseMinutes } from "../src/lib/units";
import {
	assemblyId,
	importCsv,
	loadDemo,
	one,
	partId,
	postForm,
	request,
	rows,
	seedSql,
	stmt,
	TESTER,
	testDb,
} from "./helpers";

describe("machine time arithmetic", () => {
	it("parses durations as the slicer gives them", () => {
		expect(["190", "190 min", "3:10", "3h10", "3 h 10", "3h10m", "3:10:00", "3.17h"].map(parseMinutes)).toEqual([
			190, 190, 190, 190, 190, 190, 190, 190,
		]);
		expect(parseMinutes("3h")).toBe(180);
		expect(parseMinutes("3:09:01")).toBe(190); // seconds round up
		expect(parseMinutes("0")).toBe(0);
		for (const bad of ["", "3:75", "abc", "-5", "3,5"]) expect(parseMinutes(bad), bad).toBeNull();
		expect([formatMinutes(190_000), formatMinutes(7_917), formatMinutes(45_000), formatMinutes(380_001)]).toEqual([
			"3 h 10",
			"8 min",
			"45 min",
			"6 h 21",
		]);
		expect([formatMinutesInput(190), formatMinutesInput(0)]).toEqual(["3:10", ""]);
		// 190 min at 1.50/h = 4.75.
		expect(machineMillicents(150, 190_000)).toBe(475_000);
	});

	const part = (id: number, ref: string, kind: GraphPart["kind"], costCents: number | null): GraphPart => ({
		id,
		ref,
		name: ref,
		kind,
		unit: kind === "buy" ? "kg" : "pcs",
		costCents,
		trackSerial: false,
		archived: false,
	});
	/** A plate of 24 clips: 260 g of PLA and 3 h 10 on a printer; a kit of 4 clips; a holder made of 2 clips. */
	const graph = (rate: number | null) =>
		buildGraph(
			[
				part(1, "PLA", "buy", 2000),
				part(2, "CLIP", "make", null),
				part(3, "KIT", "kit", null),
				part(4, "HOLDER", "make", null),
			],
			[
				{
					id: 10,
					parentPartId: 2,
					code: "std",
					revision: "R1",
					status: "active",
					batchMilli: 24_000,
					machineTypeId: 7,
					machineMinutes: 190,
				},
				{ id: 11, parentPartId: 3, code: "std", revision: "R1", status: "active" },
				{ id: 12, parentPartId: 4, code: "std", revision: "R1", status: "active", machineTypeId: 8, machineMinutes: 5 },
			],
			[
				{ id: 100, assemblyId: 10, componentPartId: 1, qtyMilli: 260, position: 1, notes: "" },
				{ id: 110, assemblyId: 11, componentPartId: 2, qtyMilli: 4000, position: 1, notes: "" },
				{ id: 120, assemblyId: 12, componentPartId: 2, qtyMilli: 2000, position: 1, notes: "" },
			],
			[
				{ id: 7, name: "FDM printer", rateCents: rate },
				{ id: 8, name: "Assembly bench", rateCents: 3000 },
			],
		);

	it("adds machine time to the roll-up, per unit", () => {
		const calc = new CostCalculator(graph(150));
		// (5.20 filament + 4.75 printer) / 24 = 0.41458.
		expect(calc.batch(10).millicents).toBe(995_000);
		expect(calc.part(2).millicents).toBe(41_458);
		// A holder: 2 clips and 5 min on the bench (2.50).
		expect(calc.part(4).millicents).toBe(2 * 41_458 + 250_000);
		const unknown = new CostCalculator(graph(null)).part(4);
		expect([unknown.incomplete, unknown.missing, unknown.missingMachines]).toEqual([true, [], [7]]);
	});

	it("sums machine time per type over everything built, not over sub-assemblies taken from stock", () => {
		const g = graph(150);
		const minutes = (e: ReturnType<typeof explode>) =>
			Object.fromEntries(e.machines.map((m) => [m.machineType.name, m.minutesMilli]));
		// 48 clips: 2 plates.
		expect(minutes(explode(g, 10, 48_000))).toEqual({ "FDM printer": 380_000 });
		// 1 clip: 190 / 24 = 7.917 min.
		expect(minutes(explode(g, 10, 1000))).toEqual({ "FDM printer": 7917 });
		// 6 kits = 24 clips (kits are phantoms: their clips are printed).
		expect(minutes(explode(g, 11, 6000))).toEqual({ "FDM printer": 190_000 });
		// 12 holders: 60 min on the bench, and 24 clips printed unless they come from stock.
		expect(minutes(explode(g, 12, 12_000))).toEqual({ "Assembly bench": 60_000, "FDM printer": 190_000 });
		expect(minutes(explode(g, 12, 12_000, { stock: new Map([[2, 24_000]]) }))).toEqual({ "Assembly bench": 60_000 });
	});

	it("replays rate changes in the planned margin history", () => {
		const g = graph(150);
		const points = plannedMarginSeries(
			g,
			{ partId: 2, assemblyId: 10 },
			[{ partId: 1, priceCents: 2000, validFrom: "2026-01-01" }],
			[{ assemblyId: null, priceCents: 200, validFrom: "2026-01-01" }],
			{ part: 200, assembly: null },
			[
				{ machineTypeId: 7, rateCents: 100, validFrom: "2026-01-01" },
				{ machineTypeId: 7, rateCents: 150, validFrom: "2026-06-01" },
				{ machineTypeId: 8, rateCents: 9999, validFrom: "2026-07-01" }, // not in this roll-up
			],
		);
		expect(points.map((p) => [p.date, p.costCents, p.rateChanges])).toEqual([
			// (5.20 + 3.17) / 24 = 0.35, then (5.20 + 4.75) / 24 = 0.41.
			["2026-01-01", 35, []],
			["2026-06-01", 41, [{ machineTypeId: 7, fromCents: 100, toCents: 150 }]],
		]);
	});
});

/** The full dataset: LAMP-CLIP prints 24 per plate, 0.26 kg of PLA (2.4 kg in stock) and 190 min at 1.50/h. */
async function planClips(qty: string, qtyIn: "units" | "batches" = "units") {
	const res = await postForm("/builds", {
		part_id: String(await partId("LAMP-CLIP")),
		assembly_id: String(await assemblyId("LAMP-CLIP")),
		qty,
		qty_in: qtyIn,
		serial: "",
		planned_for: "",
		notes: "",
	});
	expect(res.status, await res.clone().text()).toBe(303);
	return Number(/\/builds\/(\d+)/.exec(res.headers.get("Location") ?? "")?.[1]);
}

describe("machines pages", () => {
	it("creates, edits and retires machine types and machines, logging rates", async () => {
		await loadDemo({ stock: false });
		const list = await (await request("/machines")).text();
		expect(list).toContain("FDM printer");
		expect(list).toContain("€1.50");
		expect(list).toContain("PRINTER-2");
		expect(list).toContain("2 / 3"); // in service / not retired
		expect(list).not.toContain("Retired");
		// A new type, with its rate in the rate history.
		expect((await postForm("/machines/types", { name: "fdm PRINTER", hourly_rate: "", notes: "" })).status).toBe(422);
		const created = await postForm("/machines/types", { name: "Laser cutter", hourly_rate: "4.00", notes: "CO2" });
		expect(created.status).toBe(303);
		const laser = Number(/\/machines\/types\/(\d+)/.exec(created.headers.get("Location") ?? "")?.[1]);
		await postForm(`/machines/types/${laser}`, { name: "Laser cutter", hourly_rate: "4.50", notes: "CO2" });
		await postForm(`/machines/types/${laser}`, { name: "Laser cutter", hourly_rate: "4.50", notes: "CO2 60 W" });
		expect(
			await rows("SELECT rate_cents, source FROM machine_rate_history WHERE machine_type_id = ? ORDER BY id", laser),
		).toEqual([
			{ rate_cents: 400, source: "form" },
			{ rate_cents: 450, source: "form" },
		]);
		// A machine of that type, unique by name, then retired.
		const bad = await postForm("/machines", {
			name: "printer-1",
			machine_type_id: String(laser),
			status: "active",
			notes: "",
		});
		expect(bad.status).toBe(422);
		expect(await bad.text()).toContain("This name is already used.");
		const made = await postForm("/machines", {
			name: "LASER-1",
			machine_type_id: String(laser),
			status: "active",
			notes: "",
		});
		const machine = Number(/\/machines\/(\d+)/.exec(made.headers.get("Location") ?? "")?.[1]);
		expect((await postForm(`/machines/${machine}/retire`, {})).headers.get("Location")).toBe(
			`/machines/${machine}?ok=retired`,
		);
		expect(await one("SELECT status FROM machines WHERE id = ?", machine)).toEqual({ status: "retired" });
		expect(await (await request("/machines")).text()).not.toContain("LASER-1");
		expect(await (await request("/machines?retired=1")).text()).toContain("LASER-1");
		expect(
			(await rows<{ summary: string }>("SELECT summary FROM change_sets ORDER BY id DESC LIMIT 3")).map(
				(r) => r.summary,
			),
		).toEqual(["Retire machine LASER-1", "Create machine LASER-1", "Edit machine type Laser cutter"]);
		// The type page lists its machines, recipes and rate history.
		const fdm = (await one<{ id: number }>("SELECT id FROM machine_types WHERE name = 'FDM printer'")).id;
		const typePage = await (await request(`/machines/types/${fdm}`)).text();
		expect(typePage).toContain("LAMP-CLIP");
		expect(typePage).toContain("3 h 10");
		expect(typePage).toContain("Hourly rate history");
	});

	it("undoes a rate change and appends the restored rate to its history", async () => {
		await loadDemo({ stock: false });
		const fdm = (await one<{ id: number }>("SELECT id FROM machine_types WHERE name = 'FDM printer'")).id;
		await postForm(`/machines/types/${fdm}`, { name: "FDM printer", hourly_rate: "2.00", notes: "" });
		const set = (await one<{ id: number }>("SELECT max(id) AS id FROM change_sets")).id;
		expect(
			await revertChangeSet(testDb(), { role: "admin", seeCosts: true }, set, { user: TESTER, summary: () => "Undo" }),
		).toMatchObject({
			ok: true,
		});
		expect(await one("SELECT hourly_rate_cents FROM machine_types WHERE id = ?", fdm)).toEqual({
			hourly_rate_cents: 150,
		});
		expect(
			await rows("SELECT rate_cents, source FROM machine_rate_history WHERE machine_type_id = ? ORDER BY id", fdm),
		).toEqual([
			{ rate_cents: 150, source: "import" },
			{ rate_cents: 200, source: "form" },
			{ rate_cents: 150, source: "revert" },
		]);
	});

	it("sets machine time on a draft's Production card, with its checks", async () => {
		await loadDemo({ stock: false });
		await postForm(`/assemblies/${await assemblyId("LAMP-CLIP")}/revision`, {});
		const draft = await assemblyId("LAMP-CLIP", "std", "Rev2");
		const fdm = String((await one<{ id: number }>("SELECT id FROM machine_types WHERE name = 'FDM printer'")).id);
		// The new revision copied the machine time.
		expect(await one("SELECT machine_type_id, machine_minutes FROM assemblies WHERE id = ?", draft)).toEqual({
			machine_type_id: Number(fdm),
			machine_minutes: 190,
		});
		const post = (form: Record<string, string>) =>
			postForm(`/assemblies/${draft}/production`, { batch_qty: "24", ...form });
		expect(await (await post({ machine_type_id: fdm, machine_time: "" })).text()).toContain(
			"Enter the machine time per run.",
		);
		expect(await (await post({ machine_type_id: "", machine_time: "3:00" })).text()).toContain(
			"Choose the machine type this time is spent on.",
		);
		expect(await (await post({ machine_type_id: fdm, machine_time: "3:75" })).text()).toContain("Enter a duration");
		expect((await post({ machine_type_id: fdm, machine_time: "3h05" })).status).toBe(303);
		expect(await one("SELECT machine_minutes FROM assemblies WHERE id = ?", draft)).toEqual({ machine_minutes: 185 });
		// The editor shows the machine time and its cost in the batch cost: 0.26 kg × 20 + 3 h 05 × 1.50 = 5.20 + 4.63.
		const page = await (await request(`/assemblies/${draft}`)).text();
		expect(page).toContain("3 h 05");
		expect(page).toContain("€4.63");
		expect(page).toContain("€9.83");
		expect(page).toContain('value="3:05"');
		// No machine any more.
		expect((await post({ machine_type_id: "", machine_time: "" })).status).toBe(303);
		expect(await one("SELECT machine_type_id, machine_minutes FROM assemblies WHERE id = ?", draft)).toEqual({
			machine_type_id: null,
			machine_minutes: 0,
		});
	});
});

describe("machine time in builds and plans", () => {
	it("records the machine time of a completed build and adds it to its cost", async () => {
		await loadDemo();
		const build = await planClips("2", "batches");
		const open = await (await request(`/builds/${build}`)).text();
		expect(open).toContain('id="machine-time"');
		expect(open).toContain("6 h 20");
		expect((await postForm(`/builds/${build}/complete`, {})).status).toBe(303);
		// 520 g of PLA (10.40) + 380 min at 1.50 (9.50) = 19.90 for 48 clips: 0.41 each.
		expect(
			await rows(
				"SELECT reason, qty_milli, unit_cost_cents FROM stock_moves WHERE ref_type = 'build' AND ref_id = ? ORDER BY id",
				build,
			),
		).toEqual([
			{ reason: "build_consume", qty_milli: -520, unit_cost_cents: 2000 },
			{ reason: "build_output", qty_milli: 48_000, unit_cost_cents: 41 },
		]);
		expect(await rows("SELECT minutes_milli, rate_cents FROM build_machine_times WHERE build_id = ?", build)).toEqual([
			{ minutes_milli: 380_000, rate_cents: 150 },
		]);
		// The change set wrote ledger rows: not revertible.
		expect(await one("SELECT revertible FROM change_sets ORDER BY id DESC LIMIT 1")).toEqual({ revertible: 0 });
		const done = await (await request(`/builds/${build}`)).text();
		expect(done).toContain("Machine time recorded");
		expect(done).toContain("€9.50");
		// The weighted average takes the machine time like a fee: 19.90 for 48.
		const margins = await (await request(`/margins/assemblies/${await assemblyId("LAMP-CLIP")}`)).text();
		expect(margins).toContain("€0.41");
	});

	it("shows the machine hours of the open builds per type, and per machine in service", async () => {
		await loadDemo();
		await planClips("48");
		await planClips("10"); // 10 × 190 / 24 = 79.167 min
		const s = await computeShortages(testDb());
		expect(s.machines.map((m) => [m.machineType.name, m.minutesMilli, m.activeMachines, m.builds])).toEqual([
			["FDM printer", 459_167, 2, ["B-0001", "B-0002"]],
		]);
		// 460 min = 7 h 40, i.e. 3 h 50 on each of the 2 printers in service (PRINTER-3 is under maintenance).
		const page = await (await request("/purchasing")).text();
		expect(page).toContain('id="machine-load"');
		expect(page).toContain("7 h 40");
		expect(page).toContain("3 h 50 per machine in service");
		expect(await (await request("/machines")).text()).toContain("7 h 40");
		// Filament: 520 + 109 = 629 g needed, 2.4 kg on hand: no shortage.
		expect(s.groups.flatMap((g) => g.lines).find((l) => l.part.ref === "PLA-BLACK")).toBeUndefined();
	});

	it("values stock with the machine rate of the day", async () => {
		await loadDemo();
		const clip = await partId("LAMP-CLIP");
		const fdm = (await one<{ id: number }>("SELECT id FROM machine_types WHERE name = 'FDM printer'")).id;
		// 24 clips counted on 2026-05-01, the printer at 1.00/h until 2026-06-01, then 1.50 (today's).
		await seedSql(
			stmt(
				"INSERT INTO stock_moves (part_id, qty_milli, reason, at, by, created_by, updated_by) VALUES (?, 24000, 'count', '2026-05-01T08:00:00Z', 's', 's', 's')",
				clip,
			),
			stmt("UPDATE machine_rate_history SET valid_from = '2026-06-01' WHERE machine_type_id = ?", fdm),
			stmt(
				"INSERT INTO machine_rate_history (machine_type_id, rate_cents, valid_from, source, created_by, updated_by) VALUES (?, 100, '2026-01-01', 'form', 's', 's')",
				fdm,
			),
			stmt(
				"INSERT INTO price_history (part_id, kind, price_cents, valid_from, source, created_by, updated_by) VALUES (?, 'standard', 2000, '2026-01-01', 'form', 's', 's')",
				await partId("PLA-BLACK"),
			),
		);
		const row = async (date: string | null) =>
			(await valuation(testDb(), date)).rows.find((r) => r.part.ref === "LAMP-CLIP");
		// (5.20 + 3.1667) / 24 = 0.34861 then (5.20 + 4.75) / 24 = 0.41458.
		expect((await row("2026-05-15"))?.unitMillicents).toBe(34_861);
		expect((await row(null))?.unitMillicents).toBe(41_458);
		// The margin history has a point on the day the rate changed.
		const history = await marginHistory(testDb(), { partId: clip, assemblyId: await assemblyId("LAMP-CLIP") });
		const change = history?.planned.find((p) => p.date === "2026-06-01");
		expect(change?.rateChanges).toEqual([{ machineTypeId: fdm, fromCents: 100, toCents: 150 }]);
		const graph = await loadGraph(testDb());
		expect(graph.machineTypes.get(fdm)).toEqual({ id: fdm, name: "FDM printer", rateCents: 150 });
	});
});

describe("machines CSV", () => {
	it("imports and exports machine types and machines by name", async () => {
		await loadDemo({ stock: false });
		await importCsv("machine_types", "name,hourly_rate\nfdm printer,1.75\nCNC mill,\n");
		expect(await rows("SELECT name, hourly_rate_cents FROM machine_types ORDER BY id")).toEqual([
			{ name: "fdm printer", hourly_rate_cents: 175 },
			{ name: "CNC mill", hourly_rate_cents: null },
		]);
		expect(await rows("SELECT rate_cents, source FROM machine_rate_history ORDER BY id")).toEqual([
			{ rate_cents: 150, source: "import" },
			{ rate_cents: 175, source: "import" },
		]);
		await importCsv("machines", "name,type,status\nPRINTER-3,FDM PRINTER,active\nMILL-1,cnc mill,\n");
		expect(await rows("SELECT name, status FROM machines ORDER BY id")).toEqual([
			{ name: "PRINTER-1", status: "active" },
			{ name: "PRINTER-2", status: "active" },
			{ name: "PRINTER-3", status: "active" },
			{ name: "MILL-1", status: "active" },
		]);
		const db = testDb();
		const bad = await planImport(
			{ db, locale: "en" },
			"machines",
			"name,type,status\nX-1,Lathe,\nX-2,CNC mill,broken\nX-3,CNC mill,\nx-3,CNC mill,\n",
		);
		expect(bad?.errors.map((e) => [e.line, e.column, e.key])).toEqual([
			[2, "type", "unknown_machine_type"],
			[3, "status", "invalid_status"],
			[5, "name", "duplicate_in_file"],
		]);
		const machinesCsv = await (await request("/import/machines/export.csv")).text();
		expect(machinesCsv).toContain("name,type,status,notes");
		expect(machinesCsv).toContain("PRINTER-3,fdm printer,active,");
		expect(await (await request("/import/machine_types/export.csv")).text()).toContain("fdm printer,1.75,");
	});

	it("checks the machine columns of assemblies.csv", async () => {
		await loadDemo({ stock: false });
		const db = testDb();
		const plan = (csv: string) => planImport({ db, locale: "en" }, "assemblies", csv);
		const header = "parent_ref,code,revision,status,batch_qty,machine,machine_minutes,component_ref,qty\n";
		const errors = await plan(
			`${header}LAMP-CLIP,std,Rev2,draft,24,Lathe,10,PLA-BLACK,0.26\nLAMP-CLIP,std,Rev3,draft,24,FDM printer,,PLA-BLACK,0.26\nLAMP-CLIP,std,Rev4,draft,24,,60,PLA-BLACK,0.26\nLAMP-CLIP,std,Rev5,draft,24,FDM printer,60,PLA-BLACK,0.2\nLAMP-CLIP,std,Rev5,draft,24,FDM printer,70,PLA-BLACK,0.06\nLAMP-CLIP,std,Rev1,active,24,FDM printer,185,PLA-BLACK,0.26\n`,
		);
		expect(errors?.errors.map((e) => [e.line, e.column, e.key])).toEqual([
			[2, "machine", "unknown_machine_type"],
			[3, "machine_minutes", "machine_time_required"],
			[4, "machine", "machine_required"],
			[6, "machine", "assembly_machine_mixed"],
		]);
		// A new draft revision with a slower print is fine.
		await importCsv("assemblies", `${header}LAMP-CLIP,std,Rev2,draft,24,fdm printer,200,PLA-BLACK,0.26\n`);
		expect(
			await one("SELECT machine_minutes FROM assemblies WHERE id = ?", await assemblyId("LAMP-CLIP", "std", "Rev2")),
		).toEqual({ machine_minutes: 200 });
	});
});
