import { asc, eq } from "drizzle-orm";
import { boms, type Part, parts, stockMoves, suppliers } from "../../db/schema";
import { formatCentsInput, formatQtyInput } from "../../lib/units";
import { validate } from "../../lib/validation";
import { partColumns, partInput, partRuleErrors, partToForm } from "../parts";
import { checkHeader, emptyPlan, fieldIssues, type Importer, type PlanRow, type RowIssue } from "./types";

// CSV column -> form field name (they differ only for the supplier).
const CSV_COLUMNS = [
	"ref",
	"name",
	"kind",
	"unit",
	"cost",
	"supplier",
	"supplier_ref",
	"moq",
	"pack_size",
	"lead_days",
	"track_serial",
	"notes",
] as const;
type CsvColumn = (typeof CSV_COLUMNS)[number];

const fieldToColumn = (f: string): string => (f === "supplier_id" ? "supplier" : f);

type Columns = ReturnType<typeof partColumns>;

export const partsImporter: Importer = {
	type: "parts",
	required: ["ref"],
	optional: CSV_COLUMNS.filter((c) => c !== "ref"),
	example: [
		[
			"RES-10K",
			"Resistor 10k 0603",
			"buy",
			"pcs",
			"0.01",
			"Example Components Ltd",
			"RC0603-10K",
			"100",
			"100",
			"7",
			"no",
			"",
		],
		[
			"CBL-2C",
			"2-core cable",
			"buy",
			"m",
			"0.45",
			"Example Components Ltd",
			"C2X075",
			"50",
			"",
			"10",
			"no",
			"sold by the metre",
		],
		["SA-MAIN", "Main sub-assembly", "make", "pcs", "", "", "", "", "", "", "yes", ""],
		["KIT-SCREWS", "Screw kit", "kit", "pcs", "", "", "", "", "", "", "no", "phantom"],
		["FEE-ECO", "Eco-fee", "fee", "pcs", "0.25", "", "", "", "", "", "no", ""],
	],

	async plan({ db }, table) {
		const { errors, warnings } = checkHeader(this, table);
		if (errors.length) return emptyPlan("parts", errors, warnings);

		const [allParts, allSuppliers, withMoves, withBoms] = await Promise.all([
			db.select().from(parts),
			db.select({ id: suppliers.id, name: suppliers.name }).from(suppliers),
			db.select({ partId: stockMoves.partId }).from(stockMoves).groupBy(stockMoves.partId),
			db.select({ partId: boms.parentPartId }).from(boms).groupBy(boms.parentPartId),
		]);
		const byRef = new Map(allParts.map((p) => [p.ref, p]));
		const byLowerRef = new Map(allParts.map((p) => [p.ref.toLowerCase(), p]));
		const supplierByName = new Map(allSuppliers.map((s) => [s.name.toLowerCase(), s]));
		const supplierName = new Map(allSuppliers.map((s) => [s.id, s.name]));
		const hasMoves = new Set(withMoves.map((r) => r.partId));
		const ownsBoms = new Set(withBoms.map((r) => r.partId));
		const present = new Set(table.header);

		const issues: RowIssue[] = [];
		const rows: PlanRow[] = [];
		const ops: { id?: number; data: Columns }[] = [];
		const seen = new Map<string, number>();

		for (const rec of table.records) {
			const ref = (rec.values.ref ?? "").trim();
			const current: Part | undefined = byRef.get(ref);
			const caseClash = !current ? byLowerRef.get(ref.toLowerCase()) : undefined;
			if (caseClash) {
				issues.push({ line: rec.line, column: "ref", key: "ref_case", vars: { ref: caseClash.ref } });
				continue;
			}
			// Start from the current values ("en" format) and overlay the columns present in the file.
			const input: Record<string, string> = current ? partToForm(current, "en") : {};
			const lineIssues: RowIssue[] = [];
			for (const col of CSV_COLUMNS) {
				if (!present.has(col)) continue;
				const value = rec.values[col] ?? "";
				if (col === "supplier") {
					if (value === "") input.supplier_id = "";
					else {
						const s = supplierByName.get(value.toLowerCase());
						if (s) input.supplier_id = String(s.id);
						else
							lineIssues.push({ line: rec.line, column: "supplier", key: "unknown_supplier", vars: { name: value } });
					}
				} else {
					input[col] = value;
				}
			}
			// Checkbox semantics differ from CSV: an absent value means "no".
			if (input.track_serial === "on") input.track_serial = "yes";
			const v = validate(partInput, input);
			if (!v.ok) lineIssues.push(...fieldIssues(rec.line, v.errors, fieldToColumn));
			else {
				const rules = partRuleErrors(
					{ kind: v.data.kind, trackSerial: v.data.track_serial },
					{
						hasMoves: current ? hasMoves.has(current.id) : false,
						hasBoms: current ? ownsBoms.has(current.id) : false,
					},
				);
				lineIssues.push(...fieldIssues(rec.line, rules, fieldToColumn));
			}
			const firstLine = seen.get(ref);
			if (firstLine !== undefined) {
				lineIssues.push({ line: rec.line, column: "ref", key: "duplicate_in_file", vars: { line: firstLine } });
			} else if (ref) seen.set(ref, rec.line);
			if (lineIssues.length || !v.ok) {
				issues.push(...lineIssues);
				continue;
			}

			const data = partColumns(v.data);
			const changes = current ? diffPart(current, data, supplierName) : [];
			rows.push({
				line: rec.line,
				action: current ? (changes.length ? "update" : "unchanged") : "create",
				cells: [
					data.ref,
					data.name,
					data.kind,
					data.supplierId ? (supplierName.get(data.supplierId) ?? "") : "",
					data.costCents === null ? "" : formatCentsInput(data.costCents),
				],
				changes,
			});
			if (!current || changes.length) ops.push({ id: current?.id, data });
		}

		return {
			type: "parts",
			previewColumns: ["ref", "name", "kind", "supplier", "cost"],
			rows,
			errors: issues,
			warnings,
			statements: (user, now) =>
				ops.map((op) =>
					op.id
						? db
								.update(parts)
								.set({ ...op.data, updatedAt: now, updatedBy: user })
								.where(eq(parts.id, op.id))
						: db.insert(parts).values({ ...op.data, createdBy: user, updatedBy: user, createdAt: now, updatedAt: now }),
				),
		};
	},

	async exportRows({ db, locale }) {
		const rows = await db
			.select({ part: parts, supplierName: suppliers.name })
			.from(parts)
			.leftJoin(suppliers, eq(parts.supplierId, suppliers.id))
			.orderBy(asc(parts.ref));
		return rows.map(({ part: p, supplierName }) => [
			p.ref,
			p.name,
			p.kind,
			p.unit,
			p.costCents === null ? "" : formatCentsInput(p.costCents, locale),
			supplierName ?? "",
			p.supplierRef,
			p.moqMilli ? formatQtyInput(p.moqMilli, locale) : "",
			p.packSizeMilli ? formatQtyInput(p.packSizeMilli, locale) : "",
			p.leadDays ? String(p.leadDays) : "",
			p.trackSerial ? "yes" : "no",
			p.notes,
		]);
	},
};

const DIFF_FIELDS: { key: keyof Columns; column: CsvColumn }[] = [
	{ key: "name", column: "name" },
	{ key: "kind", column: "kind" },
	{ key: "unit", column: "unit" },
	{ key: "costCents", column: "cost" },
	{ key: "supplierId", column: "supplier" },
	{ key: "supplierRef", column: "supplier_ref" },
	{ key: "moqMilli", column: "moq" },
	{ key: "packSizeMilli", column: "pack_size" },
	{ key: "leadDays", column: "lead_days" },
	{ key: "trackSerial", column: "track_serial" },
	{ key: "notes", column: "notes" },
];

function diffPart(current: Part, next: Columns, supplierName: Map<number, string>): string[] {
	const show = (key: keyof Columns, value: unknown): string => {
		if (value === null || value === "" || value === undefined) return "∅";
		if (key === "costCents") return formatCentsInput(value as number);
		if (key === "moqMilli" || key === "packSizeMilli") return formatQtyInput(value as number);
		if (key === "supplierId") return supplierName.get(value as number) ?? String(value);
		return String(value);
	};
	return DIFF_FIELDS.filter((f) => current[f.key] !== next[f.key]).map(
		(f) => `${f.column}: ${show(f.key, current[f.key])} → ${show(f.key, next[f.key])}`,
	);
}
