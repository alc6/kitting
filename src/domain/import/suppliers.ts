import { asc, eq } from "drizzle-orm";
import { suppliers } from "../../db/schema";
import { validate } from "../../lib/validation";
import { supplierInput } from "../suppliers";
import { checkHeader, emptyPlan, fieldIssues, type Importer, type PlanRow, type RowIssue } from "./types";

const COLUMNS = ["name", "email", "phone", "notes"] as const;

export const suppliersImporter: Importer = {
	type: "suppliers",
	required: ["name"],
	optional: ["email", "phone", "notes"],
	example: [
		["Example Components Ltd", "orders@example.com", "+33 1 23 45 67 89", "Net 30"],
		["Example Fasteners", "sales@example.org", "", ""],
	],

	async plan({ db }, table) {
		const { errors, warnings } = checkHeader(this, table);
		if (errors.length) return emptyPlan("suppliers", errors, warnings);

		const existing = await db.select().from(suppliers);
		const byName = new Map(existing.map((s) => [s.name.toLowerCase(), s]));
		const seen = new Map<string, number>();
		const rows: PlanRow[] = [];
		const ops: { id?: number; data: { name: string; email: string; phone: string; notes: string } }[] = [];
		const issues: RowIssue[] = [];

		for (const rec of table.records) {
			const name = (rec.values.name ?? "").trim();
			const current = byName.get(name.toLowerCase());
			// Columns absent from the file keep their current value.
			const input: Record<string, string> = {};
			for (const col of COLUMNS) {
				input[col] = table.header.includes(col)
					? (rec.values[col] ?? "")
					: current
						? String(current[col as keyof typeof current] ?? "")
						: "";
			}
			const v = validate(supplierInput, input);
			if (!v.ok) {
				issues.push(...fieldIssues(rec.line, v.errors, (f) => f));
				continue;
			}
			const firstLine = seen.get(name.toLowerCase());
			if (firstLine !== undefined) {
				issues.push({ line: rec.line, column: "name", key: "duplicate_in_file", vars: { line: firstLine } });
				continue;
			}
			seen.set(name.toLowerCase(), rec.line);
			const changes = current
				? COLUMNS.filter((c) => current[c] !== v.data[c]).map((c) => `${c}: ${current[c] || "∅"} → ${v.data[c] || "∅"}`)
				: [];
			rows.push({
				line: rec.line,
				action: current ? (changes.length ? "update" : "unchanged") : "create",
				cells: [v.data.name, v.data.email, v.data.phone],
				changes,
			});
			if (!current || changes.length) ops.push({ id: current?.id, data: v.data });
		}

		return {
			type: "suppliers",
			previewColumns: ["name", "email", "phone"],
			rows,
			errors: issues,
			warnings,
			statements: (user, now) =>
				ops.map((op) =>
					op.id
						? db
								.update(suppliers)
								.set({ ...op.data, updatedAt: now, updatedBy: user })
								.where(eq(suppliers.id, op.id))
						: db
								.insert(suppliers)
								.values({ ...op.data, createdBy: user, updatedBy: user, createdAt: now, updatedAt: now }),
				),
		};
	},

	async exportRows({ db }) {
		const rows = await db.select().from(suppliers).orderBy(asc(suppliers.name));
		return rows.map((s) => [s.name, s.email, s.phone, s.notes]);
	},
};
