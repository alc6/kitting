// The making flow (D153–D157): how a made part is made on its page, one new build form, what to make for the open
// builds (across levels, in whole runs, with planned builds counted as stock to come), and machines set up in one step.
import { describe, expect, it } from "vitest";
import { computeShortages } from "../src/domain/purchasing";
import { revertChangeSet } from "../src/domain/revert";
import {
	assemblyId,
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

	it("puts deeper parts first", async () => {
		await loadDemo();
		const pack = await clipPack("30");
		// A box of 2 packs: the packs are made from clips, so the clips come first.
		const box = await insertPart("CLIP-BOX", "make");
		const created = await postForm(`/parts/${box}/recipe`, {});
		const id = Number(/\/assemblies\/(\d+)$/.exec(created.headers.get("Location") ?? "")?.[1]);
		await postForm(`/assemblies/${id}/lines`, { component: "CLIP-PACK", qty: "2", notes: "" });
		await postForm(`/assemblies/${id}/activate`, {});
		await planBuild("CLIP-BOX");
		expect((await toMake()).map((l) => [l.ref, l.short])).toEqual([
			["LAMP-CLIP", 60_000],
			["CLIP-PACK", 2_000],
		]);
		expect(pack).toBeGreaterThan(0);
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
		expect(html).toContain(`href="/builds/new?part=${clip}&amp;when=done"`);
		expect(html).toContain(`href="/builds/new?part=${clip}&amp;when=planned"`);
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

	it("needs the right to edit assemblies", async () => {
		await loadDemo();
		const id = await insertPart("SPACER", "make");
		await setRole("viewer");
		expect(await (await request(`/parts/${id}`, {}, NOT_ADMIN)).text()).not.toContain("Set up how it&#39;s made");
		expect((await postForm(`/parts/${id}/recipe`, {}, NOT_ADMIN)).status).toBe(403);
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
