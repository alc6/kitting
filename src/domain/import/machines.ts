// machine_types.csv and machines.csv (D151): upserts by name, like suppliers.csv. Rate changes are appended to the
// machine rate history, as on the machine type form.
import { asc, eq } from "drizzle-orm";
import { type MachineType, machines, machineTypes } from "../../db/schema";
import type { Statement } from "../../lib/db";
import { formatCentsInput } from "../../lib/units";
import { validate } from "../../lib/validation";
import {
	type MachineInput,
	type MachineTypeInput,
	machineInput,
	machineTypeInput,
	saveMachineTypeStatements,
} from "../machines";
import { checkHeader, emptyPlan, fieldIssues, type Importer, type PlanRow, type RowIssue } from "./types";

const money = (v: number | null) => (v === null ? "∅" : formatCentsInput(v));

export const machineTypesImporter: Importer = {
	type: "machine_types",
	required: ["name"],
	optional: ["hourly_rate", "notes"],
	example: [
		["FDM printer", "1.50", "Desktop printers, 0.4 mm nozzle"],
		["Laser cutter", "", ""],
	],

	async plan({ db }, table) {
		const { errors, warnings } = checkHeader(this, table);
		if (errors.length) return emptyPlan("machine_types", errors, warnings);
		const existing = await db.select().from(machineTypes);
		const byName = new Map(existing.map((m) => [m.name.toLowerCase(), m]));
		const seen = new Map<string, number>();
		const rows: PlanRow[] = [];
		const issues: RowIssue[] = [];
		const ops: { current: MachineType | undefined; data: MachineTypeInput }[] = [];

		for (const rec of table.records) {
			const name = (rec.values.name ?? "").trim();
			const current = byName.get(name.toLowerCase());
			// Columns absent from the file keep their current value.
			const keep = (col: string, value: string) => (table.header.includes(col) ? (rec.values[col] ?? "") : value);
			const v = validate(machineTypeInput, {
				name,
				hourly_rate: keep(
					"hourly_rate",
					current?.hourlyRateCents == null ? "" : formatCentsInput(current.hourlyRateCents),
				),
				notes: keep("notes", current?.notes ?? ""),
			});
			if (!v.ok) {
				issues.push(...fieldIssues(rec.line, v.errors, (f) => f));
				continue;
			}
			const first = seen.get(name.toLowerCase());
			if (first !== undefined) {
				issues.push({ line: rec.line, column: "name", key: "duplicate_in_file", vars: { line: first } });
				continue;
			}
			seen.set(name.toLowerCase(), rec.line);
			const changes: string[] = [];
			if (current) {
				if (current.name !== v.data.name) changes.push(`name: ${current.name} → ${v.data.name}`);
				if (current.hourlyRateCents !== v.data.hourly_rate)
					changes.push(`hourly_rate: ${money(current.hourlyRateCents)} → ${money(v.data.hourly_rate)}`);
				if (current.notes !== v.data.notes) changes.push(`notes: ${current.notes || "∅"} → ${v.data.notes || "∅"}`);
			}
			rows.push({
				line: rec.line,
				action: current ? (changes.length ? "update" : "unchanged") : "create",
				cells: [v.data.name, v.data.hourly_rate === null ? "" : formatCentsInput(v.data.hourly_rate)],
				changes,
			});
			if (!current || changes.length) ops.push({ current, data: v.data });
		}
		return {
			type: "machine_types",
			previewColumns: ["name", "hourly_rate"],
			rows,
			errors: issues,
			warnings,
			statements: (user, now) =>
				ops.flatMap((op) => saveMachineTypeStatements(db, op.data, op.current, "import", user, now)),
		};
	},

	async exportRows({ db, locale }) {
		const rows = await db.select().from(machineTypes).orderBy(asc(machineTypes.name));
		return rows.map((m) => [
			m.name,
			m.hourlyRateCents === null ? "" : formatCentsInput(m.hourlyRateCents, locale),
			m.notes,
		]);
	},
};

export const machinesImporter: Importer = {
	type: "machines",
	required: ["name", "type"],
	optional: ["status", "notes"],
	example: [
		["PRINTER-1", "FDM printer", "active", "Serial 12-345"],
		["PRINTER-2", "FDM printer", "maintenance", "New hotend on order"],
	],

	async plan({ db }, table) {
		const { errors, warnings } = checkHeader(this, table);
		if (errors.length) return emptyPlan("machines", errors, warnings);
		const [existing, types] = await Promise.all([db.select().from(machines), db.select().from(machineTypes)]);
		const byName = new Map(existing.map((m) => [m.name.toLowerCase(), m]));
		const typeByName = new Map(types.map((m) => [m.name.toLowerCase(), m]));
		const typeName = new Map(types.map((m) => [m.id, m.name]));
		const seen = new Map<string, number>();
		const rows: PlanRow[] = [];
		const issues: RowIssue[] = [];
		const ops: { id?: number; data: MachineInput }[] = [];

		for (const rec of table.records) {
			const name = (rec.values.name ?? "").trim();
			const current = byName.get(name.toLowerCase());
			const typeText = (rec.values.type ?? "").trim();
			const type = typeByName.get(typeText.toLowerCase());
			if (typeText && !type) {
				issues.push({ line: rec.line, column: "type", key: "unknown_machine_type", vars: { name: typeText } });
				continue;
			}
			const keep = (col: string, value: string) => (table.header.includes(col) ? (rec.values[col] ?? "") : value);
			const v = validate(machineInput, {
				name,
				machine_type_id: type ? String(type.id) : "",
				status: keep("status", current?.status ?? "") || current?.status || "active",
				notes: keep("notes", current?.notes ?? ""),
			});
			if (!v.ok) {
				issues.push(...fieldIssues(rec.line, v.errors, (f) => (f === "machine_type_id" ? "type" : f)));
				continue;
			}
			if (v.data.machine_type_id === null) {
				issues.push({ line: rec.line, column: "type", key: "required" });
				continue;
			}
			const first = seen.get(name.toLowerCase());
			if (first !== undefined) {
				issues.push({ line: rec.line, column: "name", key: "duplicate_in_file", vars: { line: first } });
				continue;
			}
			seen.set(name.toLowerCase(), rec.line);
			const changes: string[] = [];
			if (current) {
				if (current.name !== v.data.name) changes.push(`name: ${current.name} → ${v.data.name}`);
				if (current.machineTypeId !== v.data.machine_type_id)
					changes.push(`type: ${typeName.get(current.machineTypeId)} → ${typeName.get(v.data.machine_type_id)}`);
				if (current.status !== v.data.status) changes.push(`status: ${current.status} → ${v.data.status}`);
				if (current.notes !== v.data.notes) changes.push(`notes: ${current.notes || "∅"} → ${v.data.notes || "∅"}`);
			}
			rows.push({
				line: rec.line,
				action: current ? (changes.length ? "update" : "unchanged") : "create",
				cells: [v.data.name, typeName.get(v.data.machine_type_id) ?? "", v.data.status],
				changes,
			});
			if (!current || changes.length) ops.push({ id: current?.id, data: v.data });
		}
		return {
			type: "machines",
			previewColumns: ["name", "type", "status"],
			rows,
			errors: issues,
			warnings,
			statements: (user, now) =>
				ops.map((op): Statement => {
					const cols = {
						name: op.data.name,
						machineTypeId: op.data.machine_type_id as number,
						status: op.data.status,
						notes: op.data.notes,
					};
					return op.id
						? db
								.update(machines)
								.set({ ...cols, updatedAt: now, updatedBy: user })
								.where(eq(machines.id, op.id))
						: db.insert(machines).values({ ...cols, createdBy: user, updatedBy: user, createdAt: now, updatedAt: now });
				}),
		};
	},

	async exportRows({ db }) {
		const rows = await db
			.select({ name: machines.name, type: machineTypes.name, status: machines.status, notes: machines.notes })
			.from(machines)
			.innerJoin(machineTypes, eq(machines.machineTypeId, machineTypes.id))
			.orderBy(asc(machines.name));
		return rows.map((m) => [m.name, m.type, m.status, m.notes]);
	},
};
