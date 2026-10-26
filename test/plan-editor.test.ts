// The plan editor (D214): the whole plan on one page, every change checked against the plan as the edit leaves it, saved
// in one change set; new units, rooms drawn as outlines, doors with made-up codes, refusals shown on the unit, undo.
import { describe, expect, it } from "vitest";
import { revertChangeSet } from "../src/domain/revert";
import { loadDemo, NOT_ADMIN, one, postForm, request, rows, setRole, TESTER, testDb } from "./helpers";

const admin = { role: "admin", seeCosts: true } as const;
const undo = { user: TESTER, summary: () => "Undo" };

const idOf = async (code: string) =>
	(await one<{ id: number }>("SELECT id FROM storage_units WHERE code = ?", code)).id;
const unit = (code: string) =>
	one<{ col: number; row: number; width: number; depth: number; front: string; kind: string; levels: number }>(
		"SELECT col, row, width, depth, front, kind, levels FROM storage_units WHERE code = ?",
		code,
	);
const sets = async () => (await one<{ n: number }>("SELECT count(*) AS n FROM change_sets")).n;
const lastSet = () =>
	one<{ id: number; summary: string }>("SELECT id, summary FROM change_sets ORDER BY id DESC LIMIT 1");
const save = (form: Record<string, string>, env = {}) => postForm("/locations/plan", form, env);

/** The fields of a new unit `n<k>_`, a rack 2 × 0.5 m facing south unless told otherwise. */
const added = (k: number, fields: Record<string, string>) => {
	const base: Record<string, string> = {
		kind: "rack",
		code: "",
		name: "",
		col: "0",
		row: "0",
		width: "4",
		depth: "1",
		front: "south",
		levels: "3",
		positions: "3",
		outline: "",
	};
	return Object.fromEntries(Object.entries({ ...base, ...fields }).map(([f, v]) => [`n${k}_${f}`, v]));
};

describe("the plan editor page", () => {
	it("lists every unit drawn on the plan as a section of one form, with the tools and the templates", async () => {
		await loadDemo();
		const html = await (await request("/locations/plan")).text();
		for (const code of ["A", "B", "C", "D", "P", "STOC", "ASSE", "DOOR"])
			expect(html).toContain(`data-plan-item="u${await idOf(code)}_"`);
		// A unit standing in a bin is not on the plan: it is placed on its own form.
		expect(html).not.toContain(`data-plan-item="u${await idOf("S1")}_"`);
		expect(html).toContain(`name="u${await idOf("A")}_col" type="text" value="1"`);
		expect(html).toContain('data-plan-template="rack"');
		expect(html).toContain('data-plan-add="room"');
		// The L-shaped assembly room carries its outline for the board.
		expect(html).toContain('data-outline="14,0 26,0 26,12 20,12 20,16 14,16"');
		// Without JavaScript, the drawing and a way to the unit form.
		expect(html).toContain('<a href="/locations/new">Add unit</a>');
	});

	it("is for planners: operators and viewers cannot open it or post to it", async () => {
		await loadDemo();
		await setRole("planner");
		expect((await request("/locations/plan", {}, NOT_ADMIN)).status).toBe(200);
		for (const role of ["operator", "viewer"] as const) {
			await setRole(role);
			expect((await request("/locations/plan", {}, NOT_ADMIN)).status).toBe(403);
			expect((await save({ [`u${await idOf("A")}_col`]: "2" }, NOT_ADMIN)).status).toBe(403);
			const page = await (await request("/locations", {}, NOT_ADMIN)).text();
			expect(page).not.toContain('href="/locations/plan"');
		}
		expect((await unit("A")).col).toBe(1);
	});

	it("is where Locations sends planners to draw, also when nothing is drawn yet", async () => {
		expect(await (await request("/locations")).text()).toContain('href="/locations/plan"');
		await loadDemo();
		const page = await (await request("/locations")).text();
		expect(page).toContain("Edit plan");
		expect(page).not.toContain('href="/locations/new"');
		const rack = await (await request(`/locations/${await idOf("A")}`)).text();
		expect(rack).toContain(`href="/locations/plan?select=u${await idOf("A")}_"`);
	});
});

describe("saving the plan", () => {
	it("lets two racks trade places in one save, one change set naming them", async () => {
		await loadDemo();
		const [a, b] = [await idOf("A"), await idOf("B")];
		const before = await sets();
		// A (1..7) moves onto B's place and B (8..13) onto A's: checked one by one against the plan as it stands, the
		// first move would overlap.
		const res = await save({ [`u${a}_col`]: "7", [`u${b}_col`]: "1" });
		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toBe("/locations?ok=saved");
		expect(await unit("A")).toMatchObject({ col: 7, row: 1, width: 6 });
		expect(await unit("B")).toMatchObject({ col: 1, row: 1, width: 5 });
		expect(await sets()).toBe(before + 1);
		const set = await lastSet();
		expect(set.summary).toBe("Edit the workshop plan: A, B");
		const edits = await rows("SELECT table_name, op FROM change_log WHERE change_set_id = ?", set.id);
		expect(edits).toHaveLength(2);
		// The parts and the drawer cabinet standing in A-3-3 go with A.
		expect(await one("SELECT parent_unit_id AS p FROM storage_units WHERE code = 'S1'")).toEqual({ p: a });
		// One undo puts both back.
		expect(await revertChangeSet(testDb(), admin, set.id, undo)).toMatchObject({ ok: true });
		expect((await unit("A")).col).toBe(1);
		expect((await unit("B")).col).toBe(8);
	});

	it("saves nothing, and opens no change set, when nothing changed", async () => {
		await loadDemo();
		const a = await idOf("A");
		const asse = await idOf("ASSE");
		const before = await sets();
		const res = await save({
			[`u${a}_code`]: "a",
			[`u${a}_name`]: "Rack A",
			[`u${a}_col`]: "1",
			[`u${a}_front`]: "south",
			[`u${a}_levels`]: "4",
			[`u${a}_positions`]: "3",
			// The outline the room already has is no change either.
			[`u${asse}_outline`]: "14,0 26,0 26,12 20,12 20,16 14,16",
		});
		expect(res.status).toBe(303);
		expect(await sets()).toBe(before);
	});

	it("refuses a unit standing on another, shows why on that unit, and keeps what was posted", async () => {
		await loadDemo();
		const b = await idOf("B");
		const res = await save({ [`u${b}_col`]: "2" });
		expect(res.status).toBe(422);
		const html = await res.text();
		expect(html).toContain("Not saved: check B.");
		expect(html).toContain("Overlaps another storage unit on the plan.");
		expect(html).toMatch(new RegExp(`data-plan-item="u${b}_"[^>]*data-invalid="true"`));
		expect(html).toContain(`name="u${b}_col" type="text" value="2"`);
		expect((await unit("B")).col).toBe(8);
	});

	it("refuses a code another unit has, even when that one gives it up in the same save", async () => {
		await loadDemo();
		const [a, b] = [await idOf("A"), await idOf("B")];
		const taken = await save({ [`u${b}_code`]: "S1" });
		expect(taken.status).toBe(422);
		expect(await taken.text()).toContain("Another storage unit has this code.");
		// Swapping codes would break the unique index inside the batch: one at a time, through a free code.
		const swap = await save({ [`u${a}_code`]: "B", [`u${b}_code`]: "A" });
		expect(swap.status).toBe(422);
		expect(await one("SELECT code FROM storage_units WHERE id = ?", a)).toEqual({ code: "A" });
	});

	it("checks the bins as the unit form does: no level removed under a part", async () => {
		await loadDemo();
		const res = await save({ [`u${await idOf("A")}_levels`]: "1" });
		expect(res.status).toBe(422);
		expect(await res.text()).toContain("A part is stored in a bin this would remove: move it first.");
	});

	it("changes no unit's kind: that is the unit form's job", async () => {
		await loadDemo();
		const a = await idOf("A");
		expect((await save({ [`u${a}_kind`]: "room", [`u${a}_row`]: "2" })).status).toBe(303);
		expect(await unit("A")).toMatchObject({ kind: "rack", row: 2 });
	});

	it("adds units: racks with their code, rooms from their outline, doors with a code made up", async () => {
		await loadDemo();
		const res = await save({
			...added(1, { code: "e", name: "Rack E", col: "16", row: "6" }),
			...added(2, { kind: "room", name: "Shipping", outline: "0,12 12,12 12,16 6,16 6,20 0,20" }),
			...added(3, { kind: "door", col: "13", row: "9", width: "2", depth: "2", front: "east" }),
			...added(4, { kind: "door", col: "5", row: "11", width: "2", depth: "2" }),
		});
		expect(res.status).toBe(303);
		expect(await unit("E")).toMatchObject({ kind: "rack", col: 16, row: 6, width: 4, depth: 1, levels: 3 });
		expect(await one("SELECT created_by AS by FROM storage_units WHERE code = 'E'")).toEqual({ by: TESTER });
		// The room's largest band is its own rectangle, the rest an area.
		expect(await unit("SHIP")).toMatchObject({ kind: "room", col: 0, row: 12, width: 12, depth: 4 });
		expect(await rows("SELECT col, row, width, depth FROM room_areas WHERE room_id = ?", await idOf("SHIP"))).toEqual([
			{ col: 0, row: 16, width: 6, depth: 4 },
		]);
		// DOOR exists: two new doors without a code get DOOR2 and DOOR3.
		expect(await rows("SELECT code FROM storage_units WHERE kind = 'door' ORDER BY code")).toEqual([
			{ code: "DOOR" },
			{ code: "DOOR2" },
			{ code: "DOOR3" },
		]);
		expect((await lastSet()).summary).toBe("Edit the workshop plan: E, SHIP, DOOR2, DOOR3");
		// Undoing the save takes them all out, the room's area first.
		expect(await revertChangeSet(testDb(), admin, (await lastSet()).id, undo)).toMatchObject({ ok: true });
		expect(await rows("SELECT code FROM storage_units WHERE code IN ('E', 'SHIP', 'DOOR2', 'DOOR3')")).toEqual([]);
		expect(await rows("SELECT id FROM room_areas")).toHaveLength(1);
	});

	it("refuses a new storage unit without a code, and shows the units added back with their values", async () => {
		await loadDemo();
		const res = await save({
			...added(1, { name: "Rack E", col: "16", row: "6" }),
			...added(2, { kind: "landmark", name: "Bench", col: "16", row: "8" }),
		});
		expect(res.status).toBe(422);
		const html = await res.text();
		expect(html).toContain('data-plan-item="n1_"');
		expect(html).toContain('name="n1_name" type="text" value="Rack E"');
		expect(html).toContain('data-plan-item="n2_"');
		expect(html).toContain('name="n1_kind" value="rack"');
		expect(await rows("SELECT id FROM storage_units WHERE name IN ('Rack E', 'Bench')")).toEqual([]);
	});

	it("reshapes a room from its outline, and refuses one that crosses another room", async () => {
		await loadDemo();
		const asse = await idOf("ASSE");
		// The arm of the L grows two squares to the right.
		expect((await save({ [`u${asse}_outline`]: "14,0 26,0 26,12 22,12 22,16 14,16" })).status).toBe(303);
		expect(await rows("SELECT col, row, width, depth FROM room_areas WHERE room_id = ?", asse)).toEqual([
			{ col: 14, row: 12, width: 8, depth: 4 },
		]);
		// Into the stockroom: refused on the outline.
		const res = await save({ [`u${asse}_outline`]: "10,0 26,0 26,12 14,12 14,16 10,16" });
		expect(res.status).toBe(422);
		expect(await res.text()).toContain("Overlaps another room.");
		const bad = await save({ [`u${asse}_outline`]: "14,0 26,0 20,5" });
		expect(bad.status).toBe(422);
		expect(await bad.text()).toContain("The walls must follow the grid");
	});

	it("moves a room with its areas when it moves as a whole", async () => {
		await loadDemo({ plan: false });
		await save(added(1, { kind: "room", name: "Store", outline: "0,0 10,0 10,4 4,4 4,8 0,8" }));
		const store = await idOf("STOR");
		// The whole L two squares to the right and one down: its own rectangle and its area follow.
		expect((await save({ [`u${store}_outline`]: "2,1 12,1 12,5 6,5 6,9 2,9" })).status).toBe(303);
		expect(await unit("STOR")).toMatchObject({ col: 2, row: 1, width: 10, depth: 4 });
		expect(await rows("SELECT col, row, width, depth FROM room_areas WHERE room_id = ?", store)).toEqual([
			{ col: 2, row: 5, width: 4, depth: 4 },
		]);
	});

	it("reads the place fields without JavaScript, and refuses a unit off the plan's main area", async () => {
		await loadDemo({ plan: false });
		await save(added(1, { code: "A", col: "1", row: "1" }));
		const a = await idOf("A");
		expect((await save({ [`u${a}_col`]: "3", [`u${a}_width`]: "6", [`u${a}_front`]: "north" })).status).toBe(303);
		expect(await unit("A")).toMatchObject({ col: 3, width: 6, front: "north" });
		const zero = await save({ [`u${a}_width`]: "0" });
		expect(zero.status).toBe(422);
		await postForm("/locations/plan-settings", { square_cm: "50", width_m: "6", depth_m: "4" });
		const outside = await save({ [`u${a}_col`]: "8" });
		expect(outside.status).toBe(422);
		expect(await outside.text()).toContain("Outside the plan, which is 12 × 8 squares.");
	});
});
