// storage_units.csv (D207): the workshop plan, upserted by code. Rows are checked in file order against the plan as
// the rows before them leave it, so a unit can stand in a bin of a unit created earlier in the file; the export lists
// the units in that order (each followed by the units standing in it), so it imports again. A room's other rectangles
// (D211) are one `areas` cell: "col,row,width,depth" each, separated by semicolons.
import { eq, type SQL, sql } from "drizzle-orm";
import { partLocations, type RoomArea, roomAreas, storageUnits } from "../../db/schema";
import { validate } from "../../lib/validation";
import {
	checkUnitIn,
	loadPlanSettings,
	loadUnits,
	parseAreasCell,
	type Rect,
	roomAreaStatements,
	type ShapedUnit,
	storageUnitInput,
	type UnitValues,
	type UsedBin,
	unitToForm,
	unitTree,
} from "../storage";
import { checkHeader, emptyPlan, fieldIssues, type Importer, type PlanRow, type RowIssue } from "./types";

const COLUMNS = [
	"code",
	"name",
	"kind",
	"col",
	"row",
	"width",
	"depth",
	"areas",
	"front",
	"levels",
	"positions",
	"parent_bin",
	"notes",
] as const;

/** A new unit's values before the file's columns: the schema's defaults. */
const NEW_UNIT: Record<string, string> = {
	name: "",
	kind: "rack",
	parent_bin: "",
	col: "0",
	row: "0",
	width: "2",
	depth: "1",
	areas: "",
	front: "south",
	levels: "1",
	positions: "1",
	notes: "",
};

type Op = {
	/** The unit to update; none for a new one. */
	id?: number;
	values: UnitValues;
	/** A room's other rectangles as the row leaves them, and as they are stored (empty for a new unit). */
	areas: Rect[];
	storedAreas: RoomArea[];
	/** The code of the unit it stands in when that one is created by an earlier row (its id is not known yet). */
	parentCode?: string;
};

export const storageUnitsImporter: Importer = {
	type: "storage_units",
	required: ["code"],
	optional: COLUMNS.filter((c) => c !== "code"),
	example: [
		["STOC", "Stockroom", "room", "0", "0", "16", "10", "0,10,6,4", "south", "", "", "", ""],
		["DOOR", "", "door", "7", "9", "2", "2", "", "south", "", "", "", ""],
		["A", "Rack A", "rack", "1", "1", "6", "1", "", "south", "4", "3", "", "Heavy parts on level 1"],
		["S1", "Screw drawers", "cabinet", "0", "0", "1", "1", "", "south", "2", "4", "A-3-3", ""],
		["P", "Pallet area", "floor", "10", "5", "3", "3", "", "north", "", "", "", ""],
	],

	async plan({ db }, table) {
		const { errors, warnings } = checkHeader(this, table);
		if (errors.length) return emptyPlan("storage_units", errors, warnings);

		const [existing, located, settings, stored] = await Promise.all([
			loadUnits(db),
			db
				.select({ unitId: partLocations.unitId, level: partLocations.level, position: partLocations.position })
				.from(partLocations),
			loadPlanSettings(db),
			db.select().from(roomAreas).orderBy(roomAreas.id),
		]);
		// The plan as the rows so far leave it: existing units as updated, new ones under ids below zero.
		const plan = new Map<number, ShapedUnit>(existing.map((u) => [u.id, u]));
		const idByCode = new Map(existing.map((u) => [u.code, u.id]));
		const used = new Map<number, UsedBin[]>();
		for (const l of located) used.set(l.unitId, [...(used.get(l.unitId) ?? []), l]);
		let nextNewId = -1;

		const issues: RowIssue[] = [];
		const rows: PlanRow[] = [];
		const ops: Op[] = [];
		const seen = new Map<string, number>();

		for (const rec of table.records) {
			// Every row names its unit, rooms and doors included: the form makes up a code when left empty, but a file
			// without one would add the same door again on every import.
			const code = (rec.values.code ?? "").trim().toUpperCase();
			if (code === "") {
				issues.push({ line: rec.line, column: "code", key: "required" });
				continue;
			}
			const first = seen.get(code);
			if (first !== undefined) {
				issues.push({ line: rec.line, column: "code", key: "duplicate_in_file", vars: { line: first } });
				continue;
			}
			seen.set(code, rec.line);
			const id = idByCode.get(code);
			const current = id === undefined ? undefined : plan.get(id);
			// Start from the current values (or the defaults) and overlay the columns present in the file.
			const before = current ? unitToForm(current, plan) : undefined;
			const input: Record<string, string> = { ...(before ?? NEW_UNIT), code };
			for (const col of COLUMNS) if (col !== "code" && table.header.includes(col)) input[col] = rec.values[col] ?? "";
			input.placement = (input.parent_bin ?? "").trim() === "" ? "plan" : "bin";
			const v = validate(storageUnitInput, input);
			const areas = parseAreasCell(input.areas ?? "");
			if (!v.ok || !areas) {
				issues.push(...fieldIssues(rec.line, v.ok ? {} : v.errors, (f) => f));
				if (!areas) issues.push({ line: rec.line, column: "areas", key: "storage_bad_areas" });
				continue;
			}
			const checked = checkUnitIn(
				[...plan.values()],
				current ? (used.get(current.id) ?? []) : [],
				v.data,
				current?.id,
				settings,
				areas,
			);
			if (!checked.ok) {
				// An area's field is a part of the one areas cell.
				issues.push(
					...fieldIssues(rec.line, checked.errors, (f) => (f.startsWith("area") ? "areas" : f), checked.vars),
				);
				continue;
			}
			const values = checked.values;
			const unitId = current?.id ?? nextNewId--;
			const next: ShapedUnit = current
				? { ...current, ...values, areas: checked.areas }
				: { ...values, areas: checked.areas, id: unitId, createdAt: "", updatedAt: "", createdBy: "", updatedBy: "" };
			plan.set(unitId, next);
			idByCode.set(code, unitId);
			const after = unitToForm(next, plan);
			const changes = before
				? COLUMNS.filter((c) => before[c] !== after[c]).map((c) => `${c}: ${before[c] || "∅"} → ${after[c] || "∅"}`)
				: [];
			rows.push({
				line: rec.line,
				action: current ? (changes.length ? "update" : "unchanged") : "create",
				cells: [after.code ?? "", after.name ?? "", after.kind ?? "", after.parent_bin ?? "", onPlanCell(next)],
				changes,
			});
			if (current && !changes.length) continue;
			const parent = values.parentUnitId === null ? undefined : plan.get(values.parentUnitId);
			ops.push({
				id: current?.id,
				values,
				areas: checked.areas,
				storedAreas: current ? stored.filter((a) => a.roomId === current.id) : [],
				parentCode: parent && parent.id < 0 ? parent.code : undefined,
			});
		}

		return {
			type: "storage_units",
			previewColumns: ["code", "name", "kind", "parent_bin", "col,row"],
			rows,
			errors: issues,
			warnings,
			statements: (user, now) =>
				ops.flatMap((op) => {
					// A unit created by an earlier row: found by its code, inserted earlier in the same batch.
					const parentUnitId: number | null | SQL = op.parentCode
						? sql`(SELECT id FROM storage_units WHERE code = ${op.parentCode})`
						: op.values.parentUnitId;
					const row = { ...op.values, parentUnitId };
					const unit = op.id
						? db
								.update(storageUnits)
								.set({ ...row, updatedAt: now, updatedBy: user })
								.where(eq(storageUnits.id, op.id))
						: db
								.insert(storageUnits)
								.values({ ...row, createdAt: now, updatedAt: now, createdBy: user, updatedBy: user });
					const room = op.id ? { id: op.id } : { code: op.values.code };
					return [unit, ...roomAreaStatements(db, room, op.storedAreas, op.areas, user, now)];
				}),
		};
	},

	async exportRows({ db }) {
		const units = await loadUnits(db);
		const idx = new Map(units.map((u) => [u.id, u]));
		// Tree order: a unit standing in a bin comes after the unit it stands in.
		return unitTree(units).map(({ unit }) => {
			const f = unitToForm(unit, idx);
			return COLUMNS.map((c) => f[c] ?? "");
		});
	},
};

const onPlanCell = (u: ShapedUnit) => (u.parentUnitId === null ? `${u.col},${u.row}` : "");
