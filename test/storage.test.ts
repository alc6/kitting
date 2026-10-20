// Storage locations (D194–D198): bin codes, plan geometry, drawing units, where parts are kept, and where the location
// shows up (part page, pick list, receipt, inventory count, search), with the permissions and undo.
import { describe, expect, it } from "vitest";
import { revertChangeSet } from "../src/domain/revert";
import {
	binCode,
	DEFAULT_PLAN,
	frontEdge,
	locationSortKey,
	type PlanUnit,
	parseBin,
	planMaxSquares,
	planSize,
	positionRect,
} from "../src/domain/storage";
import { loadDemo, NOT_ADMIN, one, partId, postForm, request, rows, setRole, TESTER, testDb } from "./helpers";

const rack = (front: PlanUnit["front"]): PlanUnit => ({
	col: 2,
	row: 1,
	width: 10,
	depth: 2,
	front,
	positions: 5,
	kind: "rack",
});

describe("bin codes and plan geometry", () => {
	it("reads and writes bin codes", () => {
		expect(parseBin("a-2-3")).toEqual({ code: "A", level: 2, position: 3 });
		expect(parseBin(" B2 4 1 ")).toEqual({ code: "B2", level: 4, position: 1 });
		expect(parseBin("C-4")).toEqual({ code: "C", level: 4, position: null });
		expect(parseBin("P")).toEqual({ code: "P", level: null, position: null });
		expect(parseBin("LED-5W-CW")).toBeNull();
		expect(parseBin("")).toBeNull();
		expect([binCode("A", 2, 3), binCode("A", 2, null), binCode("P", null, null)]).toEqual(["A-2-3", "A-2", "P"]);
	});

	it("counts positions from the left of someone facing the front", () => {
		// Facing a south front you look north: position 1 is at the west end.
		expect(positionRect(rack("south"), 1)).toEqual({ x: 2, y: 1, w: 2, h: 2 });
		// Facing a north front you look south: position 1 is at the east end.
		expect(positionRect(rack("north"), 1)).toEqual({ x: 10, y: 1, w: 2, h: 2 });
		const cabinet: PlanUnit = { col: 20, row: 2, width: 2, depth: 4, front: "west", positions: 4, kind: "cabinet" };
		expect(positionRect(cabinet, 1)).toEqual({ x: 20, y: 2, w: 2, h: 1 });
		expect(positionRect({ ...cabinet, front: "east" }, 1)).toEqual({ x: 20, y: 5, w: 2, h: 1 });
		expect(frontEdge(rack("south"))).toEqual([2, 3, 12, 3]);
		expect(frontEdge(cabinet)).toEqual([20, 2, 20, 6]);
	});

	it("sizes the plan to its units, with a minimum", () => {
		expect(planSize([], DEFAULT_PLAN)).toEqual({ width: 24, depth: 14 });
		expect(planSize([{ col: 30, row: 2, width: 4, depth: 20 }], DEFAULT_PLAN)).toEqual({ width: 35, depth: 23 });
	});

	it("sorts locations by unit, level and position, parts without one last", () => {
		const loc = (code: string, level: number | null, position: number | null) => ({
			unit: { id: 1, code, name: "", kind: "rack" as const },
			level,
			position,
			note: "",
			via: [],
			room: null,
			roomId: null,
		});
		const keys = [loc("B", 1, 1), undefined, loc("A", 2, 10), loc("A", 2, 3), loc("A", null, null)].map(
			locationSortKey,
		);
		expect([...keys].sort()).toEqual([keys[4], keys[3], keys[2], keys[0], keys[1]]);
	});
});

const unitForm = (over: Record<string, string> = {}) => ({
	code: "A",
	name: "Electronics",
	kind: "rack",
	col: "1",
	row: "1",
	width: "10",
	depth: "2",
	front: "south",
	levels: "4",
	positions: "5",
	notes: "",
	...over,
});

async function drawUnit(over: Record<string, string> = {}): Promise<number> {
	const res = await postForm("/locations", unitForm(over));
	expect(res.status).toBe(303);
	return Number(/\/locations\/(\d+)/.exec(res.headers.get("Location") ?? "")?.[1]);
}

async function locate(ref: string, bin: string, note = "") {
	const id = await partId(ref);
	return postForm(`/locations/parts/${id}?back=/parts/${id}`, { bin, note });
}

describe("drawing the plan", () => {
	it("creates units, logged and shown on the plan, and refuses bad ones", async () => {
		const a = await drawUnit();
		expect(await one("SELECT code, kind, levels, positions FROM storage_units WHERE id = ?", a)).toEqual({
			code: "A",
			kind: "rack",
			levels: 4,
			positions: 5,
		});
		expect(await one("SELECT summary FROM change_sets ORDER BY id DESC LIMIT 1")).toEqual({
			summary: "Create storage unit A",
		});
		// Codes are upper-cased; a taken code, an overlap or a bad code is refused.
		const taken = await postForm("/locations", unitForm({ code: "a", col: "15" }));
		expect(taken.status).toBe(422);
		expect(await taken.text()).toContain("Another storage unit has this code.");
		const overlap = await postForm("/locations", unitForm({ code: "B", col: "5" }));
		expect(await overlap.text()).toContain("Overlaps another storage unit on the plan.");
		const bad = await postForm("/locations", unitForm({ code: "A-1", col: "15" }));
		expect(await bad.text()).toContain("Use 1 to 6 letters or digits");
		// A landmark may surround units; a floor area is stored as one place.
		await drawUnit({ code: "IN", kind: "landmark", col: "0", row: "0", width: "20", depth: "10" });
		const p = await drawUnit({ code: "P", kind: "floor", col: "15", row: "5", levels: "9", positions: "9" });
		expect(await one("SELECT levels, positions FROM storage_units WHERE id = ?", p)).toEqual({
			levels: 1,
			positions: 1,
		});
		const plan = await (await request("/locations")).text();
		expect(plan).toContain(`href="/locations/${a}"`);
		expect(plan).toContain("Electronics");
	});

	it("draws the front view with a link per bin, and the editor with the unit to drag", async () => {
		const a = await drawUnit();
		const page = await (await request(`/locations/${a}`)).text();
		expect(page).toContain(`href="/locations/${a}?bin=A-4-5#bin"`);
		expect(page).toContain("4 level(s) × 5 position(s) · front south");
		const editor = await (await request(`/locations/${a}/edit`)).text();
		expect(editor).toContain('data-plan-editor=""');
		expect(editor).toContain('data-form="unit-form"');
		expect(editor).toContain("data-editing");
		expect(editor).toContain("data-handle");
	});
});

describe("where parts are kept", () => {
	it("sets, moves and clears a part's location, with readable history and undo", async () => {
		await loadDemo({ plan: false });
		await drawUnit();
		await drawUnit({ code: "P", kind: "floor", col: "15", row: "5" });
		const led = await partId("LED-5W-CW");
		const res = await locate("LED-5W-CW", "a-2-3", "Antistatic bags");
		expect(res.headers.get("Location")).toBe(`/parts/${led}?ok=saved`);
		expect(await one("SELECT level, position, note FROM part_locations WHERE part_id = ?", led)).toEqual({
			level: 2,
			position: 3,
			note: "Antistatic bags",
		});
		const set = await one<{ id: number; summary: string }>(
			"SELECT id, summary FROM change_sets ORDER BY id DESC LIMIT 1",
		);
		expect(set.summary).toBe("Set the location of LED-5W-CW to A-2-3");
		// The part page shows it in the header and a Location card; its note is on the Location tab.
		const partPage = await (await request(`/parts/${led}`)).text();
		expect(partPage).toContain(">A-2-3</a>");
		expect(partPage).toContain("Rack A · level 2 · position 3");
		expect(await (await request(`/parts/${led}/location`)).text()).toContain("Antistatic bags");
		// A floor area takes its code only; a bin outside the unit is refused.
		expect((await locate("BOX-LAMP", "P")).status).toBe(303);
		for (const [bin, message] of [
			["P-1-1", "A floor area has no levels"],
			["A-5-1", "This unit has fewer levels."],
			["A-1-6", "This unit has fewer positions."],
			["Q-1-1", "No storage unit has this code."],
			["A--", "Not a bin code"],
		]) {
			const refused = await locate("DRV-12V", bin as string);
			expect(refused.status, bin).toBe(422);
			expect(await refused.text()).toContain(message);
		}
		// Moving it is an update; undoing the move brings the old bin back.
		await locate("LED-5W-CW", "A-1-1");
		const moved = (await one<{ id: number }>("SELECT max(id) AS id FROM change_sets")).id;
		expect(
			await revertChangeSet(testDb(), { role: "operator", seeCosts: false }, moved, {
				user: TESTER,
				summary: () => "Undo",
			}),
		).toMatchObject({ ok: true });
		expect(await one("SELECT level, position FROM part_locations WHERE part_id = ?", led)).toEqual({
			level: 2,
			position: 3,
		});
		const history = await (await request(`/history/${set.id}`)).text();
		expect(history).toContain("LED-5W-CW");
		// An empty bin clears the location.
		await locate("LED-5W-CW", "");
		expect(await rows("SELECT id FROM part_locations WHERE part_id = ?", led)).toEqual([]);
		expect(await one("SELECT summary FROM change_sets ORDER BY id DESC LIMIT 1")).toEqual({
			summary: "Clear the location of LED-5W-CW",
		});
	});

	it("assigns a part from a unit's page, and keeps units consistent with what they hold", async () => {
		await loadDemo({ plan: false });
		const a = await drawUnit();
		const res = await postForm(`/locations/${a}/assign`, { part: "drv-12v", bin: "A-4-5", note: "" });
		expect(res.headers.get("Location")).toBe(`/locations/${a}?bin=A-4-5&ok=saved`);
		const page = await (await request(`/locations/${a}?bin=A-4-5`)).text();
		expect(page).toContain("DRV-12V");
		const unknown = await postForm(`/locations/${a}/assign`, { part: "NOPE", bin: "A-1-1", note: "" });
		expect(await unknown.text()).toContain("Unknown part reference");
		// Shrinking under a stored part, turning it into a landmark or deleting it is refused.
		const shrink = await postForm(`/locations/${a}`, unitForm({ levels: "3" }));
		expect(await shrink.text()).toContain("A part is stored in a bin this would remove");
		const landmark = await postForm(`/locations/${a}`, unitForm({ kind: "landmark" }));
		expect(await landmark.text()).toContain("Parts or units are stored in this unit");
		const del = await postForm(`/locations/${a}/delete`, {});
		expect(del.headers.get("Location")).toBe(`/locations/${a}?err=storage_unit_in_use`);
		// A landmark holds no parts.
		await drawUnit({ code: "BENCH", kind: "landmark", col: "1", row: "8" });
		expect(await (await locate("DRV-12V", "BENCH")).text()).toContain("A landmark holds no parts.");
	});

	it("lets operators put parts away but not draw the plan", async () => {
		await loadDemo({ plan: false });
		const a = await drawUnit();
		await setRole("operator");
		const id = await partId("DRV-12V");
		expect((await postForm(`/locations/parts/${id}`, { bin: "A-1-1", note: "" }, NOT_ADMIN)).status).toBe(303);
		expect((await postForm(`/locations/${a}`, unitForm({ name: "Other" }), NOT_ADMIN)).status).toBe(403);
		const page = await (await request(`/locations/${a}`, {}, NOT_ADMIN)).text();
		expect(page).toContain("Assign a part");
		expect(page).not.toContain(`/locations/${a}/edit`);
	});
});

describe("where the location shows up", () => {
	async function plan() {
		await loadDemo({ plan: false });
		await drawUnit();
		await drawUnit({ code: "B", col: "13" });
		await drawUnit({
			code: "C",
			kind: "cabinet",
			col: "23",
			row: "2",
			width: "2",
			depth: "5",
			front: "west",
			levels: "6",
			positions: "4",
		});
		await locate("PSU-EU-12V", "A-1-1");
		await locate("BASE-PLATE", "B-1-1");
		await locate("SCREW-M3X8", "C-4-1");
		await locate("ARM-ASSY", "C-1-1");
	}

	it("orders the pick list by location, grouped by unit, with reference order one link away", async () => {
		await plan();
		const lamp = await partId("LAMP-DESK");
		const planned = await postForm("/builds", {
			part_id: String(lamp),
			assembly_id: String(
				(await one<{ id: number }>("SELECT id FROM assemblies WHERE parent_part_id = ? AND status = 'active'", lamp))
					.id,
			),
			qty: "1",
			serial: "L-9",
			planned_for: "",
			notes: "",
		});
		const build = /\/builds\/(\d+)/.exec(planned.headers.get("Location") ?? "")?.[1];
		const html = await (await request(`/builds/${build}`)).text();
		const pick = html.slice(html.indexOf('id="pick-lines"'));
		const order = ["PSU-EU-12V", "BASE-PLATE", "ARM-ASSY", "SCREW-M3X8", "BOX-LAMP"].map((r) =>
			pick.indexOf(`>${r}</a>`),
		);
		expect(order.every((i) => i > 0)).toBe(true);
		expect([...order].sort((x, y) => x - y)).toEqual(order);
		expect(pick).toContain("Rack A");
		expect(pick).toContain("No location");
		expect(pick).toContain(`href="/builds/${build}?order=ref#pick-lines"`);
		const refPage = await (await request(`/builds/${build}?order=ref`)).text();
		const byRef = refPage.slice(refPage.indexOf('id="pick-lines"'));
		expect(byRef.indexOf(">ARM-ASSY</a>")).toBeLessThan(byRef.indexOf(">PSU-EU-12V</a>"));
	});

	it("filters the inventory count by unit, in bin order, and finds bins and locations in search", async () => {
		await plan();
		const c = (await one<{ id: number }>("SELECT id FROM storage_units WHERE code = 'C'")).id;
		const count = await (await request(`/stock/count?unit=${c}`)).text();
		const results = count.slice(count.indexOf('id="results"'));
		expect(results.indexOf(">ARM-ASSY</a>")).toBeGreaterThan(0);
		expect(results.indexOf(">ARM-ASSY</a>")).toBeLessThan(results.indexOf(">SCREW-M3X8</a>"));
		expect(results).not.toContain(">PSU-EU-12V</a>");
		const none = await (await request("/stock/count?unit=none")).text();
		expect(none).toContain(">DRV-12V</a>");
		expect(none.slice(none.indexOf('id="results"'))).not.toContain(">PSU-EU-12V</a>");
		const search = await (await request("/search?q=C-4")).text();
		expect(search).toContain(`href="/locations/${c}?bin=C-4"`);
		const found = await (await request("/search?q=SCREW-M3X8")).text();
		expect(found).toContain(">C-4-1</span>");
		const onPlan = await (await request("/locations?q=screw-m3x8")).text();
		expect(onPlan).toContain("Drawer cabinet C · level 4 · position 1");
	});

	it("shows where each received line goes, in put-away order", async () => {
		await plan();
		const supplier = (await one<{ id: number }>("SELECT supplier_id AS id FROM parts WHERE ref = 'PSU-EU-12V'")).id;
		const created = await postForm("/purchasing/po", { supplier_id: String(supplier), expected_at: "", notes: "" });
		const po = /\/po\/(\d+)/.exec(created.headers.get("Location") ?? "")?.[1];
		await postForm(`/purchasing/po/${po}/lines`, { part: "DRV-12V", qty: "5", price: "" });
		await postForm(`/purchasing/po/${po}/lines`, { part: "PSU-EU-12V", qty: "5", price: "" });
		await postForm(`/purchasing/po/${po}/send`, {});
		const html = await (await request(`/purchasing/po/${po}`)).text();
		const form = html.slice(html.indexOf('id="receive"'));
		expect(form).toContain("Put away");
		expect(form.indexOf(">PSU-EU-12V</a>")).toBeLessThan(form.indexOf(">DRV-12V</a>"));
		const drv = await partId("DRV-12V");
		expect(form).toContain(`href="/locations/parts/${drv}?back=%2Fpurchasing%2Fpo%2F${po}%23receive"`);
	});
});

describe("rooms, doors and units inside units", () => {
	it("draws rooms and doors without a code, and refuses overlapping rooms", async () => {
		await drawUnit({ kind: "room", code: "", name: "Stockroom", col: "0", row: "0", width: "20", depth: "10" });
		await drawUnit({ kind: "door", code: "", name: "", col: "8", row: "9", width: "2", depth: "2" });
		await drawUnit({ kind: "door", code: "", name: "", col: "12", row: "9", width: "2", depth: "2" });
		expect(await rows("SELECT code, kind FROM storage_units ORDER BY id")).toEqual([
			{ code: "STOC", kind: "room" },
			{ code: "DOOR", kind: "door" },
			{ code: "DOOR2", kind: "door" },
		]);
		const overlap = await postForm(
			"/locations",
			unitForm({ kind: "room", code: "", name: "Office", col: "15", row: "5", width: "10", depth: "10" }),
		);
		expect(await overlap.text()).toContain("Overlaps another room.");
		// A rack needs a code; inside the room it takes the room's name in its locations.
		expect(await (await postForm("/locations", unitForm({ code: "" }))).text()).toContain("Required.");
		await loadDemo({ plan: false });
		await drawUnit();
		await locate("DRV-12V", "A-2-1");
		const part = await (await request(`/parts/${await partId("DRV-12V")}`)).text();
		expect(part).toContain("Stockroom · Rack A · level 2 · position 1");
	});

	it("puts a drawer cabinet in a bin of a rack, and reads its locations through it", async () => {
		await loadDemo({ plan: false });
		const a = await drawUnit();
		const s1 = await drawUnit({
			code: "S1",
			kind: "cabinet",
			placement: "bin",
			parent_bin: "a-3-3",
			levels: "4",
			positions: "3",
		});
		expect(
			await one("SELECT parent_unit_id, parent_level, parent_position FROM storage_units WHERE id = ?", s1),
		).toEqual({
			parent_unit_id: a,
			parent_level: 3,
			parent_position: 3,
		});
		// The rack's front view shows it in its bin, linked to its page; its page says where it stands.
		const rack = await (await request(`/locations/${a}`)).text();
		expect(rack).toContain(`href="/locations/${s1}"`);
		const cabinet = await (await request(`/locations/${s1}`)).text();
		expect(cabinet).toContain("in A-3-3");
		// A part in it is found on the plan through the rack, and listed in walking order.
		await locate("SCREW-M3X8", "S1-2-1");
		await locate("DIFF-OPAL", "A-3-2");
		await locate("SWITCH-INL", "A-3-4");
		const plan = await (await request("/locations?q=SCREW-M3X8")).text();
		expect(plan).toContain("A-3-3 › S1-2-1");
		expect(plan).toContain("Rack A · level 3 · position 3 › Drawer cabinet S1 · level 2 · position 1");
		const order = ["DIFF-OPAL", "SCREW-M3X8", "SWITCH-INL"];
		const count = await (await request(`/stock/count?unit=${a}`)).text();
		const results = count.slice(count.indexOf('id="results"'));
		const at = order.map((r) => results.indexOf(`>${r}</a>`));
		expect(at.every((i) => i > 0)).toBe(true);
		expect([...at].sort((x, y) => x - y)).toEqual(at);
	});

	it("refuses a unit in a bin that cannot hold it, in itself, or too deep", async () => {
		const a = await drawUnit();
		await drawUnit({ code: "P", kind: "floor", col: "15", row: "5" });
		const refused = async (over: Record<string, string>, message: string, path = "/locations") => {
			const res = await postForm(path, unitForm(over));
			expect(res.status, message).toBe(422);
			expect(await res.text()).toContain(message);
		};
		await refused({ code: "S1", placement: "bin", parent_bin: "P" }, "This unit has no bins to stand in.");
		await refused({ code: "S1", placement: "bin", parent_bin: "A-9-1" }, "This unit has fewer levels.");
		await refused({ code: "S1", placement: "bin", parent_bin: "" }, "Required.");
		const s1 = await drawUnit({
			code: "S1",
			kind: "cabinet",
			placement: "bin",
			parent_bin: "A-1-1",
			levels: "2",
			positions: "2",
		});
		const s2 = await drawUnit({
			code: "S2",
			kind: "cabinet",
			placement: "bin",
			parent_bin: "S1-2-2",
			levels: "2",
			positions: "2",
		});
		await drawUnit({
			code: "S3",
			kind: "cabinet",
			placement: "bin",
			parent_bin: "S2-1-1",
			levels: "2",
			positions: "2",
		});
		await refused(
			{ code: "S4", kind: "cabinet", placement: "bin", parent_bin: "S3-1-1" },
			"Too many units inside each other",
		);
		// Rack A cannot move into a cabinet standing in it.
		await refused(
			{ code: "A", placement: "bin", parent_bin: "S2-1-1" },
			"A unit cannot stand in itself",
			`/locations/${a}`,
		);
		// A rack holding a unit cannot shrink under its bin, and cannot be deleted.
		await refused(
			{ code: "S1", kind: "cabinet", placement: "bin", parent_bin: "A-1-1", levels: "2", positions: "1" },
			"A part is stored in a bin this would remove",
			`/locations/${s1}`,
		);
		const del = await postForm(`/locations/${s2}/delete`, {});
		expect(del.headers.get("Location")).toBe(`/locations/${s2}?err=storage_unit_in_use`);
		// Only racks and drawer cabinets stand in bins: a floor area sent with a bin stays on the plan.
		const floor = await drawUnit({
			code: "F",
			kind: "floor",
			placement: "bin",
			parent_bin: "A-2-2",
			col: "1",
			row: "8",
		});
		expect(await one("SELECT parent_unit_id FROM storage_units WHERE id = ?", floor)).toEqual({ parent_unit_id: null });
	});
});

describe("rooms as pages", () => {
	it("shows what a room holds, counts it, and sends doors and landmarks to their editor", async () => {
		await loadDemo({ plan: false });
		const room = await drawUnit({
			kind: "room",
			code: "",
			name: "Stockroom",
			col: "0",
			row: "0",
			width: "20",
			depth: "10",
		});
		await drawUnit({ kind: "room", code: "", name: "Office", col: "20", row: "0", width: "10", depth: "10" });
		await drawUnit();
		await drawUnit({ code: "S1", kind: "cabinet", placement: "bin", parent_bin: "A-3-3", levels: "2", positions: "2" });
		await drawUnit({ code: "B", col: "22", row: "2", width: "4", depth: "1" });
		await locate("DRV-12V", "A-2-1");
		await locate("SCREW-M3X8", "S1-1-1");
		await locate("BASE-PLATE", "B-1-1");
		const page = await (await request(`/locations/${room}`)).text();
		expect(page).toContain(">DRV-12V</a>");
		expect(page).toContain(">SCREW-M3X8</a>");
		expect(page).not.toContain(">BASE-PLATE</a>");
		expect(page).toContain(`href="/stock/count?unit=${room}"`);
		const count = await (await request(`/stock/count?unit=${room}`)).text();
		const results = count.slice(count.indexOf('id="results"'));
		expect(results).toContain(">SCREW-M3X8</a>");
		expect(results).not.toContain(">BASE-PLATE</a>");
		// A door has no page: planners get its editor, the others the plan.
		const door = await drawUnit({ kind: "door", code: "", col: "8", row: "9", width: "2", depth: "2" });
		expect((await request(`/locations/${door}`)).headers.get("Location")).toBe(`/locations/${door}/edit`);
		await setRole("operator");
		expect((await request(`/locations/${door}`, {}, NOT_ADMIN)).headers.get("Location")).toBe("/locations");
		// Locations is its own page in the sidebar, no longer a Stock tab.
		const stock = await (await request("/stock")).text();
		expect(stock).toContain('href="/locations"');
		expect(stock).not.toContain('href="/stock/locations"');
	});
});

describe("the part's Location tab", () => {
	it("appears once a plan is drawn, with the plan, the unit's front and the change form", async () => {
		await loadDemo({ plan: false });
		const id = await partId("DRV-12V");
		const tabs = (html: string) =>
			[...html.matchAll(/data-slot="tabs-trigger"[^>]*>(?:<svg[\s\S]*?<\/svg>)?([^<]+)</g)].map((m) => m[1]);
		expect(tabs(await (await request(`/parts/${id}`)).text())).not.toContain("Location");
		expect((await request(`/parts/${id}/location`)).headers.get("Location")).toBe(`/parts/${id}`);
		const a = await drawUnit();
		await locate("DRV-12V", "A-2-1", "Top shelf box");
		const overview = await (await request(`/parts/${id}`)).text();
		expect(tabs(overview)).toContain("Location");
		expect(overview).toContain(`href="/parts/${id}/location"`);
		const tab = await (await request(`/parts/${id}/location`)).text();
		expect(tab).toContain('aria-label="Workshop plan"');
		expect(tab).toContain(`href="/locations/${a}?bin=A-2-1"`);
		expect(tab).toContain(`action="/locations/parts/${id}?back=%2Fparts%2F${id}%2Flocation"`);
		expect(tab).toContain("Top shelf box");
		const moved = await postForm(`/locations/parts/${id}?back=%2Fparts%2F${id}%2Flocation`, { bin: "A-1-1", note: "" });
		expect(moved.headers.get("Location")).toBe(`/parts/${id}/location?ok=saved`);
	});
});

describe("the plan's square size and main area (D209)", () => {
	const save = (over: Record<string, string> = {}, env = {}) =>
		postForm("/locations/plan-settings", { square_cm: "50", width_m: "", depth_m: "", ...over }, env);
	const unitAt = (code: string) => one("SELECT col, row, width, depth FROM storage_units WHERE code = ?", code);
	const settings = () => rows("SELECT key, value FROM settings WHERE key LIKE 'plan_%' ORDER BY key");
	const refused = async (res: Response, message: string) => {
		expect(res.status, message).toBe(422);
		expect(await res.text()).toContain(message);
	};
	const admin = { role: "admin", seeCosts: true } as const;
	const undo = { user: TESTER, summary: () => "Undo" };

	it("sizes the plan to its fixed area, whatever the units", () => {
		const far = [{ col: 30, row: 2, width: 4, depth: 20 }];
		expect(planSize(far, { squareCm: 50, area: { width: 40, depth: 25 } })).toEqual({ width: 40, depth: 25 });
		// The 12 x 7 m minimum is 48 x 28 squares of 25 cm; units further out make the plan grow.
		expect(planSize(far, { squareCm: 25, area: null })).toEqual({ width: 48, depth: 28 });
		expect(planSize([{ col: 60, row: 2, width: 4, depth: 40 }], { squareCm: 25, area: null })).toEqual({
			width: 65,
			depth: 43,
		});
	});

	it("rescales the units drawn on the plan so they keep their real size", async () => {
		await drawUnit({ code: "A", col: "1", row: "3", width: "10", depth: "2" });
		await drawUnit({ code: "P", kind: "floor", col: "15", row: "5", width: "3", depth: "3" });
		await drawUnit({ code: "S1", kind: "cabinet", placement: "bin", parent_bin: "A-1-1", width: "2" });
		const before = await unitAt("S1");
		expect((await save({ square_cm: "25" })).status).toBe(303);
		expect(await unitAt("A")).toEqual({ col: 2, row: 6, width: 20, depth: 4 });
		expect(await unitAt("P")).toEqual({ col: 30, row: 10, width: 6, depth: 6 });
		// A unit standing in a bin is not drawn on the plan: left alone.
		expect(await unitAt("S1")).toEqual(before);
		expect(await settings()).toEqual([{ key: "plan_square_cm", value: "25" }]);
		const set = await one<{ id: number; summary: string }>(
			"SELECT id, summary FROM change_sets ORDER BY id DESC LIMIT 1",
		);
		expect(set.summary).toBe("Change the settings of the workshop plan");
		expect(await one("SELECT updated_by FROM storage_units WHERE code = 'A'")).toEqual({ updated_by: TESTER });
		// The hints state the size; the form shows it back.
		expect(await (await request("/locations")).text()).toContain("1 square = 0.25 m.");
		expect(await (await request("/locations/new")).text()).toContain("In squares of 0.25 m");
		expect(await (await request("/locations/plan-settings")).text()).toContain('value="25"');
		const fr = await request("/locations", { headers: { Cookie: "kitting_lang=fr" } });
		expect(await fr.text()).toContain("1 carreau = 0,25 m.");
		// Undoing it (an admin action) brings back the squares and the units.
		expect(await revertChangeSet(testDb(), admin, set.id, undo)).toMatchObject({ ok: true });
		expect(await unitAt("A")).toEqual({ col: 1, row: 3, width: 10, depth: 2 });
		expect(await settings()).toEqual([]);
	});

	it("refuses a size that would put a unit between squares, or beyond the plan", async () => {
		await drawUnit({ code: "A", col: "2", row: "4", width: "20", depth: "2" });
		const p = await drawUnit({ code: "P", kind: "floor", col: "25", row: "9", width: "3", depth: "3" });
		// 50 -> 100 cm halves every value: P is odd.
		await refused(await save({ square_cm: "100" }), "Some units would not fall on whole squares at this size.");
		expect(await unitAt("A")).toEqual({ col: 2, row: 4, width: 20, depth: 2 });
		expect(await settings()).toEqual([]);
		const even = unitForm({ code: "P", kind: "floor", col: "26", row: "10", width: "4", depth: "4" });
		expect((await postForm(`/locations/${p}`, even)).status).toBe(303);
		expect((await save({ square_cm: "100" })).status).toBe(303);
		expect(await unitAt("P")).toEqual({ col: 13, row: 5, width: 2, depth: 2 });
		expect(await settings()).toEqual([{ key: "plan_square_cm", value: "100" }]);
		// The limit is 100 m whatever the squares: finer ones never push a unit beyond it, so 5 cm is fine.
		expect((await save({ square_cm: "5" })).status).toBe(303);
		expect(await unitAt("A")).toEqual({ col: 20, row: 40, width: 200, depth: 20 });
		await refused(await save({ square_cm: "4" }), "Between 5 and 500 cm.");
		await refused(await save({ square_cm: "501" }), "Between 5 and 500 cm.");
		await refused(await save({ square_cm: "" }), "Between 5 and 500 cm.");
		await refused(await save({ square_cm: "12.5" }), "Must be a whole number.");
	});

	it("fixes the main area in metres, refuses units outside it, and clears it", async () => {
		await drawUnit({ code: "A", col: "1", row: "1", width: "10", depth: "2" });
		// Squares of 0.5 m: 10 x 6 m is 20 x 12 squares, and the rack needs 11 x 3.
		expect((await save({ width_m: "10", depth_m: "6" })).status).toBe(303);
		expect(await settings()).toEqual([
			{ key: "plan_depth", value: "12" },
			{ key: "plan_width", value: "20" },
		]);
		const form = await (await request("/locations/plan-settings")).text();
		expect(form).toContain('value="10"');
		expect(form).toContain('value="6"');
		// A unit that does not fit is refused, with the plan's size; one that fits is accepted.
		const outside = "Outside the plan, which is 20 × 12 squares.";
		await refused(await postForm("/locations", unitForm({ code: "B", col: "12", row: "6", width: "10" })), outside);
		await refused(await postForm("/locations", unitForm({ code: "B", col: "3", row: "11", depth: "2" })), outside);
		expect((await postForm("/locations", unitForm({ code: "B", col: "10", row: "6", width: "10" }))).status).toBe(303);
		// Smaller than what is drawn: refused, with what it needs. No margin is asked.
		await refused(
			await save({ width_m: "5", depth_m: "6" }),
			"Too small for the units on the plan: 20 × 8 squares at least.",
		);
		expect((await save({ width_m: "10", depth_m: "4" })).status).toBe(303);
		// Both sides or none; whole squares; at most 100 m each way.
		await refused(await save({ width_m: "10" }), "Required.");
		await refused(await save({ width_m: "10.3", depth_m: "4" }), "Must be a whole number of squares of 0.5 m.");
		await refused(await save({ width_m: "101", depth_m: "4" }), "At most 100 m each way.");
		await refused(await save({ width_m: "abc", depth_m: "4" }), "Not a valid length in metres");
		// Neither side removes the area: the plan grows with its units again.
		expect((await save()).status).toBe(303);
		expect(await settings()).toEqual([]);
		const free = unitForm({ code: "C", col: "30", row: "1", width: "4" });
		expect((await postForm("/locations", free)).status).toBe(303);
	});

	it("reads the area in the new squares, and holds the rescaled units to it", async () => {
		await drawUnit({ code: "A", col: "1", row: "1", width: "10", depth: "2" });
		await save({ width_m: "10", depth_m: "6" });
		// The same area in metres with finer squares: 40 x 24 squares of 0.25 m; the rack is 20 wide from column 2.
		expect((await save({ square_cm: "25", width_m: "10", depth_m: "6" })).status).toBe(303);
		expect(await unitAt("A")).toEqual({ col: 2, row: 2, width: 20, depth: 4 });
		expect(await settings()).toEqual([
			{ key: "plan_depth", value: "24" },
			{ key: "plan_square_cm", value: "25" },
			{ key: "plan_width", value: "40" },
		]);
		// The rack reaches 22 squares of 0.25 m: 5.5 m.
		await refused(await save({ square_cm: "25", width_m: "5", depth_m: "6" }), "22 × 6 squares at least");
		// A form that changes nothing writes nothing.
		const sets = await rows("SELECT id FROM change_sets");
		expect((await save({ square_cm: "25", width_m: "10", depth_m: "6" })).status).toBe(303);
		expect(await rows("SELECT id FROM change_sets")).toHaveLength(sets.length);
	});

	it("counts the limits in metres: a small square still covers a big workshop (D210)", async () => {
		expect([5, 10, 50, 7, 500].map(planMaxSquares)).toEqual([2000, 1000, 200, 1428, 20]);
		// The automatic plan is 12 x 7 m at least, whatever the squares.
		expect(planSize([], { squareCm: 10, area: null })).toEqual({ width: 120, depth: 70 });
		expect(planSize([], { squareCm: 7, area: null })).toEqual({ width: 172, depth: 100 });
		expect(planSize([], { squareCm: 500, area: null })).toEqual({ width: 3, depth: 2 });
		expect(planSize([], DEFAULT_PLAN)).toEqual({ width: 24, depth: 14 });
		expect((await save({ square_cm: "10" })).status).toBe(303);
		// Up to 100 m (1000 squares) from the corner, and not past it.
		expect(await drawUnit({ code: "A", col: "900", row: "1", width: "100", depth: "20" })).toBeGreaterThan(0);
		await refused(
			await postForm("/locations", unitForm({ code: "B", col: "991", row: "30", width: "10" })),
			"Too far out: the plan is 100 m at most each way.",
		);
		await refused(
			await postForm("/locations", unitForm({ code: "B", col: "1", row: "990", depth: "11" })),
			"Too far out: the plan is 100 m at most each way.",
		);
		// The same page in French states the metric limit too.
		const fr = await postForm(
			"/locations",
			unitForm({ code: "B", col: "991", row: "30", width: "10" }),
			{},
			{ Cookie: "kitting_lang=fr" },
		);
		expect(await fr.text()).toContain("le plan fait 100 m au plus dans chaque sens");
	});

	it("rescales a plan of 30 m to finer squares, and takes an area of up to 100 m", async () => {
		// 30 m is 300 squares of 10 cm: the old limit of 200 squares refused it.
		await drawUnit({ code: "A", col: "50", row: "1", width: "10", depth: "2" });
		expect((await save({ square_cm: "10" })).status).toBe(303);
		expect(await unitAt("A")).toEqual({ col: 250, row: 5, width: 50, depth: 10 });
		await refused(await save({ square_cm: "10", width_m: "100.1", depth_m: "50" }), "At most 100 m each way.");
		expect((await save({ square_cm: "10", width_m: "80", depth_m: "40" })).status).toBe(303);
		expect(await settings()).toEqual([
			{ key: "plan_depth", value: "400" },
			{ key: "plan_square_cm", value: "10" },
			{ key: "plan_width", value: "800" },
		]);
		const form = await (await request("/locations/plan-settings")).text();
		expect(form).toContain('value="80"');
		expect(form).toContain('value="40"');
		await refused(
			await postForm("/locations", unitForm({ code: "B", col: "790", row: "1", width: "20" })),
			"Outside the plan, which is 800 × 400 squares.",
		);
		expect((await save({ square_cm: "10", width_m: "100", depth_m: "100" })).status).toBe(303);
		expect(await (await request("/locations/plan-settings")).text()).toContain('value="100"');
		// Coarser squares: the area is rescaled with the units, in metres; 100 m is 20 squares of 5 m at most.
		await refused(await save({ square_cm: "500", width_m: "105", depth_m: "50" }), "At most 100 m each way.");
	});

	it("draws the plan to scale: 48 units per metre, a grid thinned to round distances", async () => {
		const lines = (html: string) => [...html.matchAll(/<line [^>]*class="stroke-foreground\/(7|15)"/g)];
		const at50 = await (await request("/locations/new")).text();
		expect(at50).toContain('data-square="24"');
		expect(at50).toContain("M0 350 V354 H48 V350");
		expect(at50).toContain('viewBox="-16 -16 608 382"');
		// 24 x 14 squares: 23 + 13 lines, the strong ones (editor) every second line, i.e. every metre.
		expect(lines(at50)).toHaveLength(36);
		expect(lines(at50).filter((m) => m[1] === "15")).toHaveLength(17);
		expect(at50).toContain('<line x1="24" y1="0" x2="24" y2="336"');
		expect(at50).toContain('<line x1="552" y1="0" x2="552" y2="336"');

		await save({ square_cm: "10" });
		const at10 = await (await request("/locations/new")).text();
		expect(at10).toContain('data-square="4.8"');
		expect(at10).toContain('data-square-cm="10"');
		// 120 x 70 squares of 4.8 units: the same 12 x 7 m, so the same size on screen. The scale bar is 1 m.
		expect(at10).toContain('viewBox="-16 -16 608 382"');
		expect(at10).toContain("M0 350 V354 H48 V350");
		// Lines every 50 cm (5 squares, 24 units apart), the strong ones every metre.
		expect(lines(at10)).toHaveLength(36);
		expect(lines(at10).filter((m) => m[1] === "15")).toHaveLength(17);
		expect(at10).toContain('<line x1="24" y1="0" x2="24" y2="336"');
		expect(at10).not.toContain('<line x1="4.8"');
		// A bigger plan stays bounded: 40 x 25 m has 79 + 49 lines, not 399 + 249.
		await save({ square_cm: "10", width_m: "40", depth_m: "25" });
		expect(lines(await (await request("/locations/new")).text())).toHaveLength(79 + 49);
	});

	it("starts a new rack at 2 x 1 m, half a metre from the corner, whatever the squares", async () => {
		const field = (html: string, name: string) => new RegExp(`name="${name}"[^>]*value="(\\d+)"`).exec(html)?.[1];
		const at50 = await (await request("/locations/new")).text();
		expect(["col", "row", "width", "depth"].map((n) => field(at50, n))).toEqual(["1", "1", "4", "2"]);
		await save({ square_cm: "10" });
		const at10 = await (await request("/locations/new")).text();
		expect(["col", "row", "width", "depth"].map((n) => field(at10, n))).toEqual(["5", "5", "20", "10"]);
	});

	it("draws a unit of a given real size the same whatever the squares", async () => {
		const id = await drawUnit({ code: "A", col: "2", row: "2", width: "10", depth: "2" });
		const rect = (html: string) =>
			/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" rx="2"/.exec(html);
		const at50 = rect(await (await request("/locations")).text());
		await save({ square_cm: "10" });
		const at10 = rect(await (await request("/locations")).text());
		expect(at50?.slice(1)).toEqual(["48", "48", "240", "48"]);
		expect(at10?.slice(1)).toEqual(at50?.slice(1));
		// Dragging in the editor snaps to squares of 4.8 units; the size label is in metres.
		const editor = await (await request(`/locations/${id}/edit`)).text();
		expect(editor).toContain('data-square="4.8"');
		expect(editor).toContain("5 × 1 m");
	});

	it("is for planners; others cannot even open the form", async () => {
		await drawUnit({ col: "2", width: "10" });
		await setRole("planner");
		expect((await save({ square_cm: "25" }, NOT_ADMIN)).status).toBe(303);
		expect(await (await request("/locations/plan-settings", {}, NOT_ADMIN)).text()).toContain('value="25"');
		const page = await (await request("/locations", {}, NOT_ADMIN)).text();
		expect(page).toContain("Plan settings");
		expect(page).toContain("1 square = 0.25 m.");
		expect(await one("SELECT summary FROM change_sets ORDER BY id DESC LIMIT 1")).toEqual({
			summary: "Change the settings of the workshop plan",
		});
		for (const role of ["operator", "viewer"] as const) {
			await setRole(role);
			expect((await save({ square_cm: "50" }, NOT_ADMIN)).status, role).toBe(403);
			expect((await request("/locations/plan-settings", {}, NOT_ADMIN)).status, role).toBe(403);
			expect(await (await request("/locations", {}, NOT_ADMIN)).text(), role).not.toContain("Plan settings");
		}
		expect(await settings()).toEqual([{ key: "plan_square_cm", value: "25" }]);
	});

	it("names the setting in the recent changes; only an administrator can undo it", async () => {
		await save({ square_cm: "25" });
		const set = await one<{ id: number }>("SELECT max(id) AS id FROM change_sets");
		expect(await (await request(`/history/${set.id}`)).text()).toContain("plan_square_cm");
		const planner = { role: "planner", seeCosts: false } as const;
		expect(await revertChangeSet(testDb(), planner, set.id, undo)).toMatchObject({ ok: false });
	});
});
