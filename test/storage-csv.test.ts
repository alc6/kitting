// Storage locations in CSV files (D207): storage_units.csv (the plan, upserted by code, units standing in bins of units
// created earlier in the file) and the location column of parts.csv; the example plan of examples/full.
import { describe, expect, it } from "vitest";
import { type ImportPlan, planImport } from "../src/domain/import";
import { revertChangeSet } from "../src/domain/revert";
import { fullCode, locationsOf } from "../src/domain/storage";
import { changeSql, importCsv, loadDemo, one, partId, request, rows, seedSql, stmt, TESTER, testDb } from "./helpers";

const plan = async (type: "storage_units" | "parts", csv: string): Promise<ImportPlan> => {
	const p = await planImport({ db: testDb(), locale: "en" }, type, csv);
	if (!p) throw new Error(type);
	return p;
};
const issues = (p: ImportPlan) => p.errors.map((e) => `${e.line}:${e.column}:${e.key}`);
const actions = (p: ImportPlan) => p.rows.map((r) => r.action);
const exported = async (type: string) => (await (await request(`/import/${type}/export.csv`)).text()).replace(/^﻿/, "");

const HEADER = "code,name,kind,col,row,width,depth,front,levels,positions,parent_bin,notes";

describe("the example plan", () => {
	it("loads with the demo: rooms, racks, a cabinet in a rack's bin, and most parts put away", async () => {
		await loadDemo();
		const where = await locationsOf(testDb());
		const at = async (ref: string) => {
			const l = where.get(await partId(ref));
			return l ? `${fullCode(l)} @ ${l.room}` : "none";
		};
		expect(await at("SCREW-M3X8")).toBe("A-3-3 › S1-1-1 @ Stockroom");
		expect(await at("BOX-LAMP")).toBe("P @ Stockroom");
		expect(await at("PLA-BLACK")).toBe("A-4 @ Stockroom");
		expect(await at("LAMP-DESK")).toBe("D-1-1 @ Assembly");
		// Kits and fees are never stocked; one stocked part is left to put away.
		expect(await at("HEAD-KIT-CW")).toBe("none");
		expect(await at("SWITCH-INL")).toBe("none");
		const page = await (await request("/locations")).text();
		expect(page).toContain("1 stocked part(s) without a location");
	});

	it("exports both files as they were imported", async () => {
		await loadDemo();
		const units = await exported("storage_units");
		const codes = units
			.split("\r\n")
			.slice(1, -1)
			.map((l) => l.split(",")[0]);
		// Tree order: S1 right after A, the unit it stands in.
		expect(codes).toEqual(["A", "S1", "ASSE", "B", "C", "D", "DOOR", "P", "STOC"]);
		expect(units).toContain("S1,Screw drawers,cabinet,0,0,1,1,south,3,4,A-3-3,");
		const again = await plan("storage_units", units);
		expect(issues(again)).toEqual([]);
		expect(new Set(actions(again))).toEqual(new Set(["unchanged"]));
		const parts = await exported("parts");
		expect(parts).toMatch(/^SCREW-M3X8,.*,S1-1-1$/m);
		expect(new Set(actions(await plan("parts", parts)))).toEqual(new Set(["unchanged"]));
	});
});

describe("storage_units.csv", () => {
	it("creates a unit in a bin of a unit created earlier in the same file", async () => {
		await importCsv(
			"storage_units",
			`${HEADER}\nA,Rack A,rack,1,1,6,1,south,4,3,,\nS1,Drawers,cabinet,,,,,south,2,4,a-3-3,\nSTOC,Stockroom,room,0,0,12,8,south,,,,\n`,
		);
		expect(
			await rows(
				"SELECT u.code, u.levels, u.positions, p.code AS parent, u.parent_level, u.parent_position FROM storage_units u LEFT JOIN storage_units p ON p.id = u.parent_unit_id ORDER BY u.code",
			),
		).toEqual([
			{ code: "A", levels: 4, positions: 3, parent: null, parent_level: null, parent_position: null },
			{ code: "S1", levels: 2, positions: 4, parent: "A", parent_level: 3, parent_position: 3 },
			// A room has no bins, whatever the file says.
			{ code: "STOC", levels: 1, positions: 1, parent: null, parent_level: null, parent_position: null },
		]);
		expect(await one("SELECT summary, revertible FROM change_sets")).toEqual({
			summary: "Import storage_units.csv",
			revertible: 1,
		});
	});

	it("updates by code, keeping the columns left out of the file", async () => {
		await loadDemo();
		const p = await plan("storage_units", "code,name\na,Rack A (heavy)\nB,Rack B\n");
		expect(issues(p)).toEqual([]);
		expect(actions(p)).toEqual(["update", "unchanged"]);
		expect(p.rows[0]?.changes).toEqual(["name: Rack A → Rack A (heavy)"]);
		await importCsv("storage_units", "code,name\na,Rack A (heavy)\n");
		expect(await one("SELECT name, levels, positions, col FROM storage_units WHERE code = 'A'")).toEqual({
			name: "Rack A (heavy)",
			levels: 4,
			positions: 3,
			col: 1,
		});
	});

	it("refuses rows without a code, repeated codes, a parent listed later, overlaps and bins still in use", async () => {
		await loadDemo();
		const p = await plan(
			"storage_units",
			[
				HEADER,
				",Somewhere,rack,30,1,2,1,south,1,1,,",
				"X1,Drawers,cabinet,0,0,1,1,south,1,1,X2-1-1,",
				"X2,Rack,rack,30,3,2,1,south,1,1,,",
				"X2,Again,rack,30,5,2,1,south,1,1,,",
				"X3,On rack A,rack,2,1,2,1,south,1,1,,",
				"X4,Room,room,30,8,2,2,south,,,X2-1-1,",
				"A,Rack A,rack,1,1,6,1,south,2,3,,",
				"P,Pallet area,floor,8,7,4,4,sideways,,,,",
			].join("\n"),
		);
		expect(issues(p)).toEqual([
			"2:code:required",
			"3:parent_bin:storage_unknown_unit",
			"5:code:duplicate_in_file",
			"6:col:storage_overlap",
			"7:kind:storage_not_nestable",
			// S1 stands in A-3-3 and parts are on levels 1 to 4.
			"8:levels:storage_bin_in_use",
			"9:front:invalid",
		]);
	});

	it("is undone as one change", async () => {
		await importCsv(
			"storage_units",
			`${HEADER}\nA,Rack A,rack,1,1,6,1,south,4,3,,\nS1,Drawers,cabinet,,,,,south,2,4,A-3-3,\n`,
		);
		const set = (await one<{ id: number }>("SELECT id FROM change_sets")).id;
		const undone = await revertChangeSet(testDb(), { role: "admin", seeCosts: true }, set, {
			user: TESTER,
			summary: (s) => `Undo #${s.id}`,
		});
		expect(undone).toMatchObject({ ok: true });
		expect(await rows("SELECT code FROM storage_units")).toEqual([]);
	});
});

describe("the location column of parts.csv", () => {
	it("sets, moves and keeps locations, checking the bins against the plan", async () => {
		await loadDemo();
		// A note on the location (set from the page): a file, which has no notes, keeps it.
		await changeSql(
			"Note where the boxes are",
			stmt("UPDATE part_locations SET note = 'Behind the door' WHERE part_id = ?", await partId("BOX-LAMP")),
		);
		const bad = await plan(
			"parts",
			"ref,name,kind,location\nNEW-2,Two,buy,STOC\nNEW-3,Three,buy,A-9\nNEW-4,Four,buy,Q-1-1\nNEW-5,Five,buy,P-1\nNEW-6,Six,buy,A 2 3 4\n",
		);
		expect(issues(bad)).toEqual([
			"2:location:storage_landmark",
			"3:location:storage_bad_level",
			"4:location:storage_unknown_unit",
			"5:location:storage_no_bins",
			"6:location:storage_bad_bin",
		]);
		const moves = "ref,location\nBOX-LAMP,b-1-2\nPAD-FELT,\nSWITCH-INL,B-1-2\n";
		const valid = await plan("parts", moves);
		expect(issues(valid)).toEqual([]);
		expect(actions(valid)).toEqual(["update", "unchanged", "update"]);
		expect(valid.rows[0]?.changes).toEqual(["location: P → B-1-2"]);
		expect(valid.rows[2]?.changes).toEqual(["location: ∅ → B-1-2"]);
		await importCsv("parts", moves);
		// A part created by the file gets its location in the same change.
		await importCsv("parts", "ref,name,kind,location\nNEW-1,New part,buy,C-2\n");
		const where = await locationsOf(testDb());
		const code = async (ref: string) => {
			const l = where.get(await partId(ref));
			return l ? `${fullCode(l)} ${l.note}`.trim() : "none";
		};
		expect(await code("BOX-LAMP")).toBe("B-1-2 Behind the door");
		expect(await code("PAD-FELT")).toBe("A-2-3");
		expect(await code("SWITCH-INL")).toBe("B-1-2");
		expect(await code("NEW-1")).toBe("C-2");
	});
});

describe("storage_units.csv and the plan's main area (D209)", () => {
	it("refuses a unit outside a fixed area, with the plan's size, and accepts one inside it", async () => {
		await seedSql(
			stmt("INSERT INTO settings (key, value, created_by, updated_by) VALUES ('plan_width', '20', 's', 's')"),
			stmt("INSERT INTO settings (key, value, created_by, updated_by) VALUES ('plan_depth', '12', 's', 's')"),
		);
		const p = await plan(
			"storage_units",
			`${HEADER}\nIN,Inside,rack,10,5,10,2,south,2,2,,\nOUT,Outside,rack,15,8,10,2,south,2,2,,\nLOW,Too low,rack,1,11,2,2,south,2,2,,\n`,
		);
		expect(issues(p)).toEqual(["3:col:storage_outside_area", "4:row:storage_outside_area"]);
		expect(p.errors[0]?.vars).toEqual({ width: 20, depth: 12 });
		expect(actions(await plan("storage_units", `${HEADER}\nIN,Inside,rack,10,5,10,2,south,2,2,,\n`))).toEqual([
			"create",
		]);
	});

	it("keeps the limit of 100 m when the area is automatic", async () => {
		const p = await plan("storage_units", `${HEADER}\nFAR,Far,rack,195,1,10,2,south,2,2,,\n`);
		expect(issues(p)).toEqual(["2:col:storage_outside_plan"]);
	});

	it("counts the limit in metres: with squares of 10 cm it is 1000 squares", async () => {
		await seedSql(
			stmt("INSERT INTO settings (key, value, created_by, updated_by) VALUES ('plan_square_cm', '10', 's', 's')"),
		);
		const p = await plan(
			"storage_units",
			`${HEADER}\nOK,Fits,rack,990,1,10,2,south,2,2,,\nFAR,Far,rack,995,10,10,2,south,2,2,,\n`,
		);
		expect(issues(p)).toEqual(["3:col:storage_outside_plan"]);
	});
});
