// Rooms made of several rectangles (D211): the outline, which room a unit is in, the editor's areas, the checks, undo,
// the plan's rescaling and storage_units.csv.
import { describe, expect, it } from "vitest";
import { type ImportPlan, planImport } from "../src/domain/import";
import { revertChangeSet } from "../src/domain/revert";
import {
	areasCell,
	detachedAreas,
	insideRects,
	locationsOf,
	outlineOf,
	parseAreasCell,
	type Rect,
	withNewArea,
	withoutArea,
} from "../src/domain/storage";
import { importCsv, loadDemo, one, partId, postForm, request, rows, TESTER, testDb } from "./helpers";

const r = (col: number, row: number, width: number, depth: number): Rect => ({ col, row, width, depth });
const admin = { role: "admin", seeCosts: true } as const;
const undo = { user: TESTER, summary: () => "Undo" };

/** An L-shaped stockroom: 10 × 6 squares, plus 4 × 4 below its left end. */
const roomForm = (over: Record<string, string> = {}) => ({
	code: "",
	name: "Stockroom",
	kind: "room",
	col: "0",
	row: "0",
	width: "10",
	depth: "6",
	front: "south",
	levels: "1",
	positions: "1",
	notes: "",
	area2_col: "0",
	area2_row: "6",
	area2_width: "4",
	area2_depth: "4",
	...over,
});
const rackForm = (over: Record<string, string> = {}) => ({
	code: "A",
	name: "",
	kind: "rack",
	col: "1",
	row: "7",
	width: "2",
	depth: "1",
	front: "south",
	levels: "2",
	positions: "2",
	notes: "",
	...over,
});

async function draw(form: Record<string, string>): Promise<number> {
	const res = await postForm("/locations", form);
	expect(res.status, await res.clone().text()).toBe(303);
	return Number(/\/locations\/(\d+)/.exec(res.headers.get("Location") ?? "")?.[1]);
}
const areas = (roomId: number) =>
	rows("SELECT col, row, width, depth FROM room_areas WHERE room_id = ? ORDER BY id", roomId);
const lastSet = () =>
	one<{ id: number; summary: string }>("SELECT id, summary FROM change_sets ORDER BY id DESC LIMIT 1");

describe("the shape of a room (pure)", () => {
	it("draws the walls around the rectangles taken together", () => {
		expect(outlineOf([r(0, 0, 4, 2)])).toEqual([
			[
				[0, 0],
				[4, 0],
				[4, 2],
				[0, 2],
			],
		]);
		// An L: six corners, no wall where the two rectangles meet.
		expect(outlineOf([r(0, 0, 10, 6), r(0, 6, 4, 4)])).toEqual([
			[
				[0, 0],
				[10, 0],
				[10, 6],
				[4, 6],
				[4, 10],
				[0, 10],
			],
		]);
		// A T and a U have 8 corners; overlapping rectangles and one inside another draw no inner wall.
		expect(outlineOf([r(0, 0, 9, 3), r(3, 3, 3, 5)])[0]).toHaveLength(8);
		expect(outlineOf([r(0, 0, 3, 8), r(3, 5, 3, 3), r(6, 0, 3, 8)])[0]).toHaveLength(8);
		expect(outlineOf([r(0, 0, 6, 4), r(4, 2, 4, 4)])).toEqual([
			[
				[0, 0],
				[6, 0],
				[6, 2],
				[8, 2],
				[8, 6],
				[4, 6],
				[4, 4],
				[0, 4],
			],
		]);
		expect(outlineOf([r(0, 0, 6, 6), r(1, 1, 2, 2)])).toEqual(outlineOf([r(0, 0, 6, 6)]));
	});

	it("puts a unit standing on the line between two rectangles inside the room, not one on its outer wall", () => {
		const l = [r(0, 0, 10, 6), r(0, 6, 4, 4)];
		expect(insideRects(l, 2, 6)).toBe(true); // on the seam
		expect(insideRects(l, 2, 8)).toBe(true); // in the area
		expect(insideRects(l, 6, 8)).toBe(false); // outside the L
		expect(insideRects(l, 4, 8)).toBe(false); // on the area's outer wall
		expect(insideRects([r(0, 0, 4, 4)], 0.5, 0.5)).toBe(true);
	});

	it("finds the areas that are not joined to the room along a wall", () => {
		const main = r(0, 0, 4, 4);
		expect(detachedAreas(main, [r(4, 0, 2, 2), r(6, 0, 2, 2)])).toEqual([]); // through another area
		expect(detachedAreas(main, [r(4, 4, 2, 2)])).toEqual([0]); // a corner only
		expect(detachedAreas(main, [r(10, 0, 2, 2), r(2, 2, 4, 4)])).toEqual([0]);
	});

	it("writes and reads the areas cell, and edits the form's areas", () => {
		const cell = areasCell([r(0, 6, 4, 4), r(10, 0, 2, 3)]);
		expect(cell).toBe("0,6,4,4; 10,0,2,3");
		expect(parseAreasCell(cell)).toEqual([r(0, 6, 4, 4), r(10, 0, 2, 3)]);
		expect(parseAreasCell(" 1, 2 ,3,4 ")).toEqual([r(1, 2, 3, 4)]);
		expect(parseAreasCell("")).toEqual([]);
		expect(parseAreasCell("1,2,3")).toBeNull();
		const two = withNewArea(withNewArea({ col: "2", row: "1", width: "6", depth: "3" }));
		expect([two.area2_col, two.area2_row, two.area2_width, two.area2_depth]).toEqual(["2", "4", "3", "3"]);
		expect(two.area3_col).toBe("2");
		const one = withoutArea({ ...two, area3_col: "9" }, 2);
		expect(one.area2_col).toBe("9");
		expect(one.area3_col).toBeUndefined();
	});
});

describe("drawing a room of several rectangles", () => {
	it("saves the room and its areas in one change set, and the units in an area belong to the room", async () => {
		await loadDemo({ plan: false });
		const room = await draw(roomForm());
		expect(await areas(room)).toEqual([{ col: 0, row: 6, width: 4, depth: 4 }]);
		const set = await lastSet();
		expect(set.summary).toBe("Create storage unit STOC");
		expect(await rows("SELECT table_name, op FROM change_log WHERE change_set_id = ? ORDER BY id", set.id)).toEqual([
			{ table_name: "storage_units", op: "insert" },
			{ table_name: "room_areas", op: "insert" },
		]);
		// Rack A stands in the area; rack B on the seam (centre on row 6); rack C outside the L.
		await draw(rackForm());
		await draw(rackForm({ code: "B", col: "1", row: "5", width: "2", depth: "2" }));
		await draw(rackForm({ code: "C", col: "6", row: "7" }));
		await postForm(`/locations/parts/${await partId("DRV-12V")}`, { bin: "A-1-1", note: "" });
		await postForm(`/locations/parts/${await partId("LED-5W-CW")}`, { bin: "B-1-1", note: "" });
		await postForm(`/locations/parts/${await partId("BASE-PLATE")}`, { bin: "C-1-1", note: "" });
		const where = await locationsOf(testDb());
		expect(where.get(await partId("DRV-12V"))?.room).toBe("Stockroom");
		expect(where.get(await partId("LED-5W-CW"))?.room).toBe("Stockroom");
		expect(where.get(await partId("BASE-PLATE"))?.room).toBeNull();
		const page = await (await request(`/locations/${room}`)).text();
		expect(page).toContain(">DRV-12V</a>");
		expect(page).not.toContain(">BASE-PLATE</a>");
		// The plan draws one outline around the L.
		const plan = await (await request("/locations")).text();
		expect(plan).toMatch(/<path d="M0 0 L240 0 L240 144 L96 144 L96 240 L0 240 Z"/);
	});

	it("adds and removes areas in the form without saving anything", async () => {
		const before = (await one<{ n: number }>("SELECT count(*) AS n FROM change_sets")).n;
		const add = await postForm("/locations", { ...roomForm(), area_add: "1" });
		expect(add.status).toBe(200);
		const added = await add.text();
		expect(added).toContain('name="area3_col"');
		expect(added).toContain("Area 3");
		const removed = await (await postForm("/locations", { ...roomForm(), area_remove: "2" })).text();
		expect(removed).not.toContain('name="area2_col"');
		expect((await one<{ n: number }>("SELECT count(*) AS n FROM change_sets")).n).toBe(before);
		// The editor of a saved room shows its areas, each to drag.
		const room = await draw(roomForm());
		const editor = await (await request(`/locations/${room}/edit`)).text();
		expect(editor).toContain('name="area2_col" type="text" value="0"');
		expect(editor).toContain('data-prefix="area2_"');
	});

	it("refuses an area apart from the room, over another room or outside the plan", async () => {
		await draw(roomForm({ name: "Office", col: "20", area2_col: "20", area2_row: "6" }));
		const refused = async (over: Record<string, string>, message: string) => {
			const res = await postForm("/locations", roomForm(over));
			expect(res.status, message).toBe(422);
			expect(await res.text()).toContain(message);
		};
		await refused({ area2_col: "10", area2_row: "6" }, "Must touch the room along a wall, or overlap it.");
		await refused({ area2_col: "8", area2_width: "13" }, "Overlaps another room.");
		await refused({ area2_col: "198" }, "Too far out: the plan is 100 m at most each way.");
		await refused({ area2_width: "0" }, "Must be more than zero.");
		// The room's own rectangle cannot overlap another room's area either.
		await refused({ col: "18", width: "4", area2_col: "18" }, "Overlaps another room.");
	});

	it("edits only the areas that changed, drops them when the room becomes something else, and deletes them with it", async () => {
		const room = await draw(roomForm({ area3_col: "10", area3_row: "0", area3_width: "2", area3_depth: "6" }));
		await postForm(
			`/locations/${room}`,
			roomForm({ code: "STOC", area3_col: "10", area3_row: "0", area3_width: "3", area3_depth: "6" }),
		);
		const edit = await lastSet();
		expect(await rows("SELECT table_name, op FROM change_log WHERE change_set_id = ?", edit.id)).toEqual([
			{ table_name: "room_areas", op: "update" },
		]);
		// Undoing the edit brings the old width back.
		expect(await revertChangeSet(testDb(), admin, edit.id, undo)).toMatchObject({ ok: true });
		expect((await areas(room))[1]).toEqual({ col: 10, row: 0, width: 2, depth: 6 });
		// A landmark has no areas: they go in the same change set.
		await postForm(
			`/locations/${room}`,
			roomForm({ code: "STOC", kind: "landmark", area3_col: "10", area3_row: "0", area3_width: "2", area3_depth: "6" }),
		);
		expect(await areas(room)).toEqual([]);
		const toLandmark = await lastSet();
		expect(await revertChangeSet(testDb(), admin, toLandmark.id, undo)).toMatchObject({ ok: true });
		expect(await areas(room)).toHaveLength(2);
		// Deleting the room deletes its areas; undoing it brings both back.
		expect((await postForm(`/locations/${room}/delete`, {})).status).toBe(303);
		expect(await rows("SELECT id FROM room_areas")).toEqual([]);
		const deleted = await lastSet();
		expect(await revertChangeSet(testDb(), admin, deleted.id, undo)).toMatchObject({ ok: true });
		expect(await areas(room)).toHaveLength(2);
		expect(await (await request(`/history/${deleted.id}`)).text()).toContain("Room area");
	});

	it("rescales the areas with the plan's squares, refuses squares that would cut one, and holds them to the main area", async () => {
		const settings = (over: Record<string, string>) =>
			postForm("/locations/plan-settings", { square_cm: "50", width_m: "", depth_m: "", ...over });
		const room = await draw(roomForm({ area2_width: "3" }));
		// Squares of 1 m would cut the 1.5 m wide area.
		const cut = await settings({ square_cm: "100" });
		expect(cut.status).toBe(422);
		expect(await cut.text()).toContain("Some units would not fall on whole squares at this size.");
		expect((await settings({ square_cm: "25" })).status).toBe(303);
		expect(await areas(room)).toEqual([{ col: 0, row: 12, width: 6, depth: 8 }]);
		// A fixed area must hold the areas too: the L reaches 5 m down, 20 squares of 25 cm.
		const small = await settings({ square_cm: "25", width_m: "12", depth_m: "4" });
		expect(small.status).toBe(422);
		expect(await small.text()).toContain("20 × 20 squares at least");
	});
});

describe("rooms of several rectangles in storage_units.csv", () => {
	const HEADER = "code,name,kind,col,row,width,depth,areas,front,levels,positions,parent_bin,notes";
	const plan = async (csv: string): Promise<ImportPlan> => {
		const p = await planImport({ db: testDb(), locale: "en" }, "storage_units", csv);
		if (!p) throw new Error("storage_units");
		return p;
	};
	const issues = (p: ImportPlan) => p.errors.map((e) => `${e.line}:${e.column}:${e.key}`);

	it("imports a room's areas, exports them, and imports a change of areas alone", async () => {
		await importCsv("storage_units", `${HEADER}\nSTOC,Stockroom,room,0,0,10,6,"0,6,4,4; 6,6,4,2",south,,,,\n`);
		const room = await one<{ id: number }>("SELECT id FROM storage_units WHERE code = 'STOC'");
		expect(await areas(room.id)).toEqual([
			{ col: 0, row: 6, width: 4, depth: 4 },
			{ col: 6, row: 6, width: 4, depth: 2 },
		]);
		const exported = (await (await request("/import/storage_units/export.csv")).text()).replace(/^﻿/, "");
		expect(exported).toContain('STOC,Stockroom,room,0,0,10,6,"0,6,4,4; 6,6,4,2",south');
		const again = await plan(exported);
		expect(issues(again)).toEqual([]);
		expect(again.rows.map((row) => row.action)).toEqual(["unchanged"]);
		const changed = await plan(`code,areas\nSTOC,"0,6,4,4"\n`);
		expect(changed.rows.map((row) => row.action)).toEqual(["update"]);
		expect(changed.rows[0]?.changes).toEqual(["areas: 0,6,4,4; 6,6,4,2 → 0,6,4,4"]);
		await importCsv("storage_units", `code,areas\nSTOC,"0,6,4,4"\n`);
		expect(await areas(room.id)).toEqual([{ col: 0, row: 6, width: 4, depth: 4 }]);
		// A file without the column leaves them as they are.
		await importCsv("storage_units", "code,name\nSTOC,Main stockroom\n");
		expect(await areas(room.id)).toHaveLength(1);
	});

	it("refuses a badly written cell and an area apart from the room", async () => {
		expect(issues(await plan(`${HEADER}\nSTOC,,room,0,0,10,6,"0,6,4",south,,,,\n`))).toEqual([
			"2:areas:storage_bad_areas",
		]);
		expect(issues(await plan(`${HEADER}\nSTOC,,room,0,0,10,6,"20,20,2,2",south,,,,\n`))).toEqual([
			"2:areas:storage_area_apart",
		]);
	});

	it("loads the example plan with its L-shaped assembly room", async () => {
		await loadDemo();
		const where = await locationsOf(testDb());
		expect(where.get(await partId("LAMP-DESK"))?.room).toBe("Assembly");
		expect(await rows("SELECT col, row, width, depth FROM room_areas")).toEqual([
			{ col: 14, row: 12, width: 6, depth: 4 },
		]);
	});
});

describe("undoing changes to rooms of several rectangles", () => {
	const undoLast = async () => revertChangeSet(testDb(), admin, (await lastSet()).id, undo);
	const settings = (over: Record<string, string>) =>
		postForm("/locations/plan-settings", { square_cm: "50", width_m: "", depth_m: "", ...over });

	it("undoes creating a room with its areas, unless an area was added since", async () => {
		await draw(roomForm());
		expect(await undoLast()).toMatchObject({ ok: true });
		expect(await rows("SELECT id FROM storage_units")).toEqual([]);
		expect(await rows("SELECT id FROM room_areas")).toEqual([]);
		const room = await draw(roomForm());
		const created = (await lastSet()).id;
		await postForm(
			`/locations/${room}`,
			roomForm({ code: "STOC", area3_col: "10", area3_row: "0", area3_width: "2", area3_depth: "2" }),
		);
		expect(await revertChangeSet(testDb(), admin, created, undo)).toMatchObject({ ok: false, reason: "conflict" });
		expect(await areas(room)).toHaveLength(2);
	});

	it("undoes a change of squares and an import of areas", async () => {
		const room = await draw(roomForm());
		expect((await settings({ square_cm: "25" })).status).toBe(303);
		expect(await undoLast()).toMatchObject({ ok: true });
		expect(await areas(room)).toEqual([{ col: 0, row: 6, width: 4, depth: 4 }]);
		await importCsv("storage_units", `code,areas\nSTOC,"0,6,4,4; 6,6,4,2;"\n`);
		expect(await areas(room)).toHaveLength(2);
		expect(await undoLast()).toMatchObject({ ok: true });
		expect(await areas(room)).toEqual([{ col: 0, row: 6, width: 4, depth: 4 }]);
	});

	it("leaves areas an undo left on a unit that is no longer a room out of the plan, and drops them on its next save", async () => {
		// A rack becomes a room, then gets an area; undoing the change of kind leaves the area on the rack.
		const x = await draw(rackForm({ code: "X", col: "0", row: "0", width: "4", depth: "2" }));
		const { area2_col, area2_row, area2_width, area2_depth, ...room } = roomForm({
			code: "X",
			col: "0",
			row: "0",
			width: "4",
			depth: "2",
		});
		await postForm(`/locations/${x}`, room);
		const toRoom = (await lastSet()).id;
		await postForm(`/locations/${x}`, { ...room, area2_col: "0", area2_row: "2", area2_width: "1", area2_depth: "1" });
		expect(await revertChangeSet(testDb(), admin, toRoom, undo)).toMatchObject({ ok: true });
		expect(await one("SELECT kind FROM storage_units WHERE id = ?", x)).toEqual({ kind: "rack" });
		expect(await areas(x)).toHaveLength(1);
		// Squares of 1 m would cut that 0.5 m area: it is not a room's, so it is neither checked nor rescaled.
		expect((await settings({ square_cm: "100" })).status).toBe(303);
		expect(await areas(x)).toEqual([{ col: 0, row: 2, width: 1, depth: 1 }]);
		expect(
			(await postForm(`/locations/${x}`, rackForm({ code: "X", col: "0", row: "0", width: "2", depth: "1" }))).status,
		).toBe(303);
		expect(await areas(x)).toEqual([]);
	});

	it("saves a unit that is not a room whatever its hidden area fields hold", async () => {
		const res = await postForm("/locations", { ...rackForm(), area2_col: "2.5", area2_row: "x" });
		expect(res.status).toBe(303);
		expect(await rows("SELECT id FROM room_areas")).toEqual([]);
	});
});
