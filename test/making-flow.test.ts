// The making flow (D153–D157): how a made part is made on its page, one new build form, what to make for the open
// builds (across levels, in whole runs, with planned builds counted as stock to come), and machines set up in one step.
import { describe, expect, it } from "vitest";
import { computeShortages } from "../src/domain/purchasing";
import { revertChangeSet } from "../src/domain/revert";
import {
	assemblyId,
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
	TESTER,
	testDb,
} from "./helpers";
import { callTool, connect, resetKv } from "./mcp-helpers";

async function planBuild(ref: string, opts: { serial?: string; qty?: string } = {}) {
	const res = await postForm("/builds", {
		when: "planned",
		part_id: String(await partId(ref)),
		assembly_id: String(await assemblyId(ref)),
		qty: opts.qty ?? "1",
		serial: opts.serial ?? "",
		planned_for: "",
		notes: "",
	});
	expect(res.status, await res.clone().text()).toBe(303);
}

/** A make part CLIP-PACK holding `clips` printed clips, set up from its page in one click, then activated. */
async function clipPack(clips: string) {
	const pack = await insertPart("CLIP-PACK", "make");
	const created = await postForm(`/parts/${pack}/recipe`, {});
	const id = Number(/\/assemblies\/(\d+)$/.exec(created.headers.get("Location") ?? "")?.[1]);
	expect((await postForm(`/assemblies/${id}/lines`, { component: "LAMP-CLIP", qty: clips, notes: "" })).status).toBe(
		303,
	);
	expect((await postForm(`/assemblies/${id}/activate`, {})).status).toBe(303);
	return pack;
}

/** A make part with an active recipe of these lines, set up from its page. */
async function madePart(ref: string, lines: [string, string][]) {
	const id = await insertPart(ref, "make");
	const created = await postForm(`/parts/${id}/recipe`, {});
	const assembly = Number(/\/assemblies\/(\d+)$/.exec(created.headers.get("Location") ?? "")?.[1]);
	for (const [component, qty] of lines) await postForm(`/assemblies/${assembly}/lines`, { component, qty, notes: "" });
	expect((await postForm(`/assemblies/${assembly}/activate`, {})).status).toBe(303);
	return id;
}

const toMake = async () =>
	(await computeShortages(testDb())).toMake.map((l) => ({
		ref: l.part.ref,
		short: l.shortMilli,
		onHand: l.onHandMilli,
		planned: l.plannedMilli,
		toMake: l.toMakeMilli,
		runs: l.runs,
		builds: l.builds,
	}));

const tubeNeed = async () =>
	(await computeShortages(testDb())).groups.flatMap((g) => g.lines).find((l) => l.part.ref === "ARM-TUBE-300")
		?.needMilli;

describe("what to make for the open builds", () => {
	it("lists the sub-assemblies to make, and counts planned builds as stock to come", async () => {
		await loadDemo();
		// 7 lamps need 7 bases (none in stock) and 14 arms (2 in stock): the first lamp takes the 2 arms.
		for (let i = 1; i <= 7; i++) await planBuild("LAMP-DESK", { serial: `L-${i}` });
		expect(await toMake()).toEqual([
			{
				ref: "ARM-ASSY",
				short: 12_000,
				onHand: 2_000,
				planned: 0,
				toMake: 12_000,
				runs: 12,
				builds: ["B-0002", "B-0003", "B-0004", "B-0005", "B-0006", "B-0007"],
			},
			{
				ref: "BASE-ASSY",
				short: 7_000,
				onHand: 0,
				planned: 0,
				toMake: 7_000,
				runs: 7,
				builds: ["B-0001", "B-0002", "B-0003", "B-0004", "B-0005", "B-0006", "B-0007"],
			},
		]);
		// One tube per arm built: 12.
		expect(await tubeNeed()).toBe(12_000);
		// Planning 5 arms on their own: 7 left to make, and the tubes are still counted once (5 + 7, not 5 + 12).
		await planBuild("ARM-ASSY", { qty: "5" });
		expect((await toMake())[0]).toMatchObject({ ref: "ARM-ASSY", short: 7_000, planned: 5_000, toMake: 7_000 });
		expect(await tubeNeed()).toBe(12_000);
		// All of them planned: nothing left to make for the arms.
		await planBuild("ARM-ASSY", { qty: "7" });
		expect((await toMake()).map((l) => l.ref)).toEqual(["BASE-ASSY"]);
		expect(await tubeNeed()).toBe(12_000);
	});

	it("rounds a printed part up to whole runs, with its machine time, deepest first", async () => {
		await loadDemo();
		await clipPack("30");
		await planBuild("CLIP-PACK");
		const s = await computeShortages(testDb());
		expect(s.toMake).toHaveLength(1);
		const clip = s.toMake[0]!;
		// 30 clips at 24 per plate: 2 plates, 48 clips, 2 × 3 h 10 of printing.
		expect([clip.part.ref, clip.shortMilli, clip.runs, clip.toMakeMilli]).toEqual(["LAMP-CLIP", 30_000, 2, 48_000]);
		expect([clip.machine?.machineType.name, clip.machine?.minutesMilli]).toEqual(["FDM printer", 380_000]);
		// The machine load counts the plates as they will be printed, not 30 clips' worth (237.5 min).
		expect(s.machines.map((m) => [m.machineType.name, m.minutesMilli, m.builds])).toEqual([
			["FDM printer", 380_000, ["B-0001"]],
		]);
		const page = await (await request("/builds")).text();
		expect(page).toContain('id="to-make"');
		expect(page).toContain("2 run(s)");
		expect(page).toContain("6 h 20");
		const plan = `/builds/new?part=${clip.part.id}&amp;assembly_id=${clip.assembly.id}&amp;qty=48&amp;when=planned`;
		expect(page).toContain(plan);
		expect(page).toContain(plan.replace("when=planned", "when=done"));
		// The link opens the form prefilled, to plan.
		const form = await (await request(plan.replaceAll("&amp;", "&"))).text();
		expect(form).toContain('name="qty" inputmode="decimal" required="" value="48"');
		expect(form).toMatch(/name="when" value="planned" checked/);
		// Purchasing points to it.
		expect(await (await request("/purchasing")).text()).toContain("And 1 made part(s) to make for these builds");
	});

	it("tells an assistant what to make, over MCP", async () => {
		await resetKv();
		await loadDemo();
		await clipPack("30");
		await planBuild("CLIP-PACK");
		const token = await connect(["purchasing:read"]);
		const short = await callTool(token, "get_shortages", {});
		expect(short.data.to_make).toEqual([
			{
				ref: "LAMP-CLIP",
				name: "Cable clip (3D printed)",
				unit: "pcs",
				short: "30",
				on_hand: "0",
				planned: "0",
				qty: "48",
				runs: 2,
				assembly: "std Rev1",
				machine_time: { type: "FDM printer", minutes: "380" },
				builds: ["B-0001"],
			},
		]);
	});

	it("lists what a part is made from before it, whatever the depth", async () => {
		await loadDemo();
		await clipPack("30");
		// WRAP holds one pack; BOX holds a WRAP, then a pack of its own. 30 clips are in stock: the pack inside WRAP
		// (deeper, exploded first) takes them, the box's own pack needs its 30 clips printed.
		await insertMove(await partId("LAMP-CLIP"), 30_000);
		await madePart("WRAP", [["CLIP-PACK", "1"]]);
		await madePart("BOX", [
			["WRAP", "1"],
			["CLIP-PACK", "1"],
		]);
		await planBuild("BOX");
		// The pack sits deeper than the clips it needs (inside WRAP), but the clips are made first.
		expect((await toMake()).map((l) => [l.ref, l.short])).toEqual([
			["LAMP-CLIP", 30_000],
			["CLIP-PACK", 2_000],
			["WRAP", 1_000],
		]);
		expect((await computeShortages(testDb())).toMake.map((l) => l.level)).toEqual([0, 1, 2]);
	});

	it("counts a made part's deficit before what its planned builds will add", async () => {
		await loadDemo();
		const arm = await partId("ARM-ASSY");
		// 2 arms in stock, then 5 used outside any build: −3. Planning 5 arms only brings it back to 2.
		await insertMove(arm, -5_000);
		await planBuild("ARM-ASSY", { qty: "5" });
		for (let i = 1; i <= 2; i++) await planBuild("LAMP-DESK", { serial: `L-${i}` });
		// 4 arms needed, 2 available once the deficit is filled: 2 to make.
		expect((await toMake()).find((l) => l.ref === "ARM-ASSY")).toMatchObject({
			short: 2_000,
			onHand: -3_000,
			planned: 5_000,
		});
	});

	it("buys what the whole runs use, and counts the machine time of the parent and its runs", async () => {
		await loadDemo();
		const pack = await clipPack("30");
		const fdm = (await one<{ id: number }>("SELECT id FROM machine_types WHERE name = 'FDM printer'")).id;
		// Packing takes 10 min on the printer bench too.
		const packAssembly = await assemblyId("CLIP-PACK");
		expect(
			(
				await postForm(`/assemblies/${packAssembly}/production`, {
					batch_qty: "1",
					machine_type_id: String(fdm),
					machine_time: "10",
				})
			).status,
		).toBe(303);
		// 0.4 kg of PLA left: enough for 30 clips (0.325 kg), not for the 48 of two plates (0.52 kg).
		await insertMove(await partId("PLA-BLACK"), -2_000);
		await planBuild("CLIP-PACK");
		const s = await computeShortages(testDb());
		const pla = s.groups.flatMap((g) => g.lines).find((l) => l.part.ref === "PLA-BLACK");
		expect([pla?.needMilli, pla?.onHandMilli, pla?.builds]).toEqual([520, 400, ["B-0001"]]);
		// The pack's own 10 min, plus two plates of 3 h 10.
		expect(s.machines.map((m) => m.minutesMilli)).toEqual([390_000]);
		// Recording the 48 suggested clips then never takes the filament below zero.
		expect(await (await request(`/parts/${pack}`)).text()).toContain("How it&#39;s made");
	});
});

describe("how a made part is made, on its page", () => {
	it("shows the recipe builds use, with its machine time and the actions that follow", async () => {
		await loadDemo();
		const clip = await partId("LAMP-CLIP");
		const html = await (await request(`/parts/${clip}`)).text();
		expect(html).toContain('id="how-its-made"');
		expect(html).toContain("How it&#39;s made");
		expect(html).toContain("per run");
		expect(html).toContain("PLA-BLACK");
		expect(html).toContain("FDM printer");
		expect(html).toContain("3 h 10");
		// Printed 24 per plate: recorded or planned one run at a time by default.
		expect(html).toContain(`href="/builds/new?part=${clip}&amp;when=done&amp;qty=1&amp;qty_in=batches"`);
		expect(html).toContain(`href="/builds/new?part=${clip}&amp;when=planned&amp;qty=1&amp;qty_in=batches"`);
		const form = await (await request(`/builds/new?part=${clip}&when=done&qty=1&qty_in=batches`)).text();
		expect(form).toMatch(/<option value="batches" selected/);
		// A made part with no supplier offer has no empty suppliers card.
		expect(html).not.toContain("Add the suppliers you can buy it from");
	});

	it("sets a recipe up in one click, once", async () => {
		await loadDemo();
		const id = await insertPart("SPACER", "make");
		const page = await (await request(`/parts/${id}`)).text();
		expect(page).toContain("Set up how it&#39;s made");
		expect(page).toContain(`action="/parts/${id}/recipe"`);
		const first = await postForm(`/parts/${id}/recipe`, {});
		expect(first.status).toBe(303);
		const location = first.headers.get("Location");
		expect(location).toMatch(/^\/assemblies\/\d+$/);
		expect(await one("SELECT summary FROM change_sets ORDER BY id DESC LIMIT 1")).toEqual({
			summary: "Create assembly SPACER std Rev1",
		});
		// Twice: the same draft, not a second one.
		expect((await postForm(`/parts/${id}/recipe`, {})).headers.get("Location")).toBe(location);
		expect(await rows("SELECT code, revision, status FROM assemblies WHERE parent_part_id = ?", id)).toEqual([
			{ code: "std", revision: "Rev1", status: "draft" },
		]);
		// The draft shows on the part page, without build actions until it is active.
		const draft = await (await request(`/parts/${id}`)).text();
		expect(draft).toContain("Draft: activate it from its page to build with it.");
		expect(draft).not.toContain(`/builds/new?part=${id}&amp;when=done`);
		// Bought parts have no recipe.
		const bolt = await insertPart("BOLT", "buy");
		expect((await postForm(`/parts/${bolt}/recipe`, {})).headers.get("Location")).toBe(`/parts/${bolt}`);
		expect(await rows("SELECT id FROM assemblies WHERE parent_part_id = ?", bolt)).toEqual([]);
	});

	it("needs the right to edit assemblies: an operator records and plans builds, but does not set recipes up", async () => {
		await loadDemo();
		const id = await insertPart("SPACER", "make");
		await setRole("operator");
		expect(await (await request(`/parts/${id}`, {}, NOT_ADMIN)).text()).not.toContain("Set up how it&#39;s made");
		expect((await postForm(`/parts/${id}/recipe`, {}, NOT_ADMIN)).status).toBe(403);
		const clipId = await partId("LAMP-CLIP");
		const link = `href="/assemblies/${await assemblyId("LAMP-CLIP")}"`;
		const clip = await (await request(`/parts/${clipId}`, {}, NOT_ADMIN)).text();
		expect(clip).toContain("Record a build");
		// The recipe's name links to it; its Edit button is for those who may edit it.
		expect(clip.split(link).length - 1).toBe(1);
		expect((await (await request(`/parts/${clipId}`)).text()).split(link).length - 1).toBe(2);
	});

	it("leaves archived parts and archived recipes alone", async () => {
		await loadDemo();
		// An archived made part: no set-up, and the route refuses.
		const old = await insertPart("OLD-SPACER", "make");
		await postForm(`/parts/${old}/archive`, {});
		expect(await (await request(`/parts/${old}`)).text()).not.toContain("Set up how it&#39;s made");
		expect((await postForm(`/parts/${old}/recipe`, {})).headers.get("Location")).toBe(`/parts/${old}`);
		expect(await rows("SELECT id FROM assemblies WHERE parent_part_id = ?", old)).toEqual([]);
		// A part whose only recipe is archived shows it, with what to do, instead of offering a new one.
		const id = await insertPart("SPACER", "make");
		const created = await postForm(`/parts/${id}/recipe`, {});
		const assembly = Number(/\/assemblies\/(\d+)$/.exec(created.headers.get("Location") ?? "")?.[1]);
		await postForm(`/assemblies/${assembly}/lines`, { component: "PLA-BLACK", qty: "0.01", notes: "" });
		await postForm(`/assemblies/${assembly}/activate`, {});
		await postForm(`/assemblies/${assembly}/archive`, {});
		expect(await one("SELECT status FROM assemblies WHERE id = ?", assembly)).toEqual({ status: "archived" });
		const page = await (await request(`/parts/${id}`)).text();
		expect(page).toContain("Archived: open it to activate it again");
		expect(page).not.toContain("Set up how it&#39;s made");
		expect((await postForm(`/parts/${id}/recipe`, {})).headers.get("Location")).toBe(`/assemblies/${assembly}`);
	});
});

describe("machines set up in one step", () => {
	it("creates a machine type with the machines the workshop owns, in one change set", async () => {
		const form = await (await request("/machines/types/new")).text();
		expect(form).toContain("How many do you own?");
		expect(form).toContain('name="owned"');
		// One printer: the machine takes the type's name.
		const one_ = await postForm("/machines/types", {
			name: "Desktop printer",
			hourly_rate: "0.80",
			notes: "",
			owned: "1",
		});
		expect(one_.status).toBe(303);
		// Three: numbered.
		await postForm("/machines/types", { name: "Laser", hourly_rate: "", notes: "", owned: "3" });
		// None: the type alone, as before.
		await postForm("/machines/types", { name: "Lathe", hourly_rate: "", notes: "", owned: "0" });
		expect(
			await rows(
				"SELECT m.name, t.name AS type, m.status FROM machines m JOIN machine_types t ON t.id = m.machine_type_id ORDER BY m.id",
			),
		).toEqual([
			{ name: "Desktop printer", type: "Desktop printer", status: "active" },
			{ name: "Laser 1", type: "Laser", status: "active" },
			{ name: "Laser 2", type: "Laser", status: "active" },
			{ name: "Laser 3", type: "Laser", status: "active" },
		]);
		expect(await rows("SELECT summary FROM change_sets ORDER BY id")).toEqual([
			{ summary: "Create machine type Desktop printer with 1 machine(s)" },
			{ summary: "Create machine type Laser with 3 machine(s)" },
			{ summary: "Create machine type Lathe" },
		]);
		// Refused: too many, or a name another machine has.
		expect(
			await (await postForm("/machines/types", { name: "Mill", hourly_rate: "", notes: "", owned: "21" })).text(),
		).toContain("At most 20 at once");
		// A type name that leaves no room for the machines' numbers.
		const long = await postForm("/machines/types", { name: "M".repeat(199), hourly_rate: "", notes: "", owned: "2" });
		expect(long.status).toBe(422);
		expect(await rows("SELECT id FROM machine_types WHERE name = ?", "M".repeat(199))).toEqual([]);
		await postForm("/machines/types", { name: "Router", hourly_rate: "", notes: "", owned: "0" });
		await postForm("/machines", {
			name: "Saw",
			machine_type_id: String((await one<{ id: number }>("SELECT id FROM machine_types WHERE name = 'Router'")).id),
			status: "active",
			notes: "",
		});
		const taken = await postForm("/machines/types", { name: "Saw", hourly_rate: "", notes: "", owned: "1" });
		expect(taken.status).toBe(422);
		expect(await taken.text()).toContain("A machine already has one of these names");
		// Undoing the creation removes the type and its machines together.
		const set = (await one<{ id: number }>("SELECT id FROM change_sets WHERE summary LIKE '%Laser%'")).id;
		expect(
			await revertChangeSet(testDb(), { role: "admin", seeCosts: true }, set, { user: TESTER, summary: () => "Undo" }),
		).toMatchObject({ ok: true });
		expect(await rows("SELECT name FROM machines WHERE name LIKE 'Laser%'")).toEqual([]);
		expect(await rows("SELECT name FROM machine_types WHERE name = 'Laser'")).toEqual([]);
	});
});
