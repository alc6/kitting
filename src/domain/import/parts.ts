import { asc, eq } from "drizzle-orm";
import { boms, type Part, parts, stockMoves, suppliers } from "../../db/schema";
import { formatCentsInput, formatQtyInput } from "../../lib/units";
import { validate } from "../../lib/validation";
import { NO_TERMS, type OfferTerms, preferredTerms } from "../offers";
import {
	type PartInput,
	partInput,
	partRuleErrors,
	partToForm,
	preferredOfferTerms,
	savePartStatements,
} from "../parts";
import { checkHeader, emptyPlan, fieldIssues, type Importer, type PlanRow, type RowIssue } from "./types";

// CSV column -> form field name (they differ only for the supplier).
const CSV_COLUMNS = [
	"ref",
	"name",
	"kind",
	"unit",
	"cost",
	"sale_price",
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

// The supplier columns describe the preferred supplier's offer (part_suppliers.csv adds the others).
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
			"",
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
			"",
			"Example Components Ltd",
			"C2X075",
			"50",
			"",
			"10",
			"no",
			"sold by the metre",
		],
		["SA-MAIN", "Main sub-assembly", "make", "pcs", "", "", "", "", "", "", "", "yes", ""],
		["KIT-SCREWS", "Screw kit", "kit", "pcs", "", "", "", "", "", "", "", "no", "phantom"],
		["FEE-ECO", "Eco-fee", "fee", "pcs", "0.25", "", "", "", "", "", "", "no", ""],
		["PROD-1", "Finished product", "make", "pcs", "", "149.00", "", "", "", "", "", "yes", "sold at 149.00"],
	],

	async plan({ db }, table) {
		const { errors, warnings } = checkHeader(this, table);
		if (errors.length) return emptyPlan("parts", errors, warnings);

		const [allParts, allSuppliers, withMoves, withBoms, offers] = await Promise.all([
			db.select().from(parts),
			db.select({ id: suppliers.id, name: suppliers.name }).from(suppliers),
			db.select({ partId: stockMoves.partId }).from(stockMoves).groupBy(stockMoves.partId),
			db.select({ partId: boms.parentPartId }).from(boms).groupBy(boms.parentPartId),
			preferredTerms(db),
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
		const ops: { data: PartInput; previous?: { part: Part; offer: OfferTerms | undefined } }[] = [];
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
			const offer = current ? offers.get(current.id) : undefined;
			const input: Record<string, string> = current ? partToForm(current, "en", offer) : {};
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

			const data = v.data;
			const changes = current ? diffPart(flatten(current, offer), flattenInput(data, offer), supplierName) : [];
			rows.push({
				line: rec.line,
				action: current ? (changes.length ? "update" : "unchanged") : "create",
				cells: [
					data.ref,
					data.name,
					data.kind,
					data.supplier_id ? (supplierName.get(data.supplier_id) ?? "") : "",
					data.cost === null ? "" : formatCentsInput(data.cost),
				],
				changes,
			});
			if (!current || changes.length) ops.push({ data, previous: current ? { part: current, offer } : undefined });
		}

		return {
			type: "parts",
			previewColumns: ["ref", "name", "kind", "supplier", "cost"],
			rows,
			errors: issues,
			warnings,
			statements: (user, now) => ops.flatMap((op) => savePartStatements(db, op.data, op.previous, "import", user, now)),
		};
	},

	async exportRows({ db, locale }) {
		const [rows, offers] = await Promise.all([
			db
				.select({ part: parts, supplierName: suppliers.name })
				.from(parts)
				.leftJoin(suppliers, eq(parts.supplierId, suppliers.id))
				.orderBy(asc(parts.ref)),
			preferredTerms(db),
		]);
		return rows.map(({ part: p, supplierName }) => {
			const o = offers.get(p.id) ?? NO_TERMS;
			return [
				p.ref,
				p.name,
				p.kind,
				p.unit,
				p.costCents === null ? "" : formatCentsInput(p.costCents, locale),
				p.salePriceCents === null ? "" : formatCentsInput(p.salePriceCents, locale),
				supplierName ?? "",
				o.supplierRef,
				o.moqMilli ? formatQtyInput(o.moqMilli, locale) : "",
				o.packSizeMilli ? formatQtyInput(o.packSizeMilli, locale) : "",
				o.leadDays ? String(o.leadDays) : "",
				p.trackSerial ? "yes" : "no",
				p.notes,
			];
		});
	},
};

/** A part and its preferred offer as comparable values, keyed by CSV column. */
type Flat = Record<Exclude<CsvColumn, "ref">, string | number | boolean | null>;

function flatten(p: Part, offer: OfferTerms | undefined): Flat {
	const o = offer ?? NO_TERMS;
	return {
		name: p.name,
		kind: p.kind,
		unit: p.unit,
		cost: p.costCents,
		sale_price: p.salePriceCents,
		supplier: p.supplierId,
		supplier_ref: p.supplierId === null ? "" : o.supplierRef,
		moq: p.supplierId === null ? 0 : o.moqMilli,
		pack_size: p.supplierId === null ? 0 : o.packSizeMilli,
		lead_days: p.supplierId === null ? 0 : o.leadDays,
		track_serial: p.trackSerial,
		notes: p.notes,
	};
}

function flattenInput(d: PartInput, offer: OfferTerms | undefined): Flat {
	const t = preferredOfferTerms(d, offer);
	return {
		name: d.name,
		kind: d.kind,
		unit: d.unit,
		cost: d.cost,
		sale_price: d.sale_price,
		supplier: d.supplier_id,
		supplier_ref: d.supplier_id === null ? "" : t.supplierRef,
		moq: d.supplier_id === null ? 0 : t.moqMilli,
		pack_size: d.supplier_id === null ? 0 : t.packSizeMilli,
		lead_days: d.supplier_id === null ? 0 : t.leadDays,
		track_serial: d.track_serial,
		notes: d.notes,
	};
}

function diffPart(current: Flat, next: Flat, supplierName: Map<number, string>): string[] {
	const show = (col: keyof Flat, value: unknown): string => {
		if (value === null || value === "" || value === undefined) return "∅";
		if (col === "cost" || col === "sale_price") return formatCentsInput(value as number);
		if (col === "moq" || col === "pack_size") return value === 0 ? "∅" : formatQtyInput(value as number);
		if (col === "supplier") return supplierName.get(value as number) ?? String(value);
		return String(value);
	};
	return (Object.keys(current) as (keyof Flat)[])
		.filter((col) => current[col] !== next[col])
		.map((col) => `${col}: ${show(col, current[col])} → ${show(col, next[col])}`);
}
