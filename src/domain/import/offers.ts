import { asc, eq } from "drizzle-orm";
import { type PartSupplier, partSuppliers, parts, suppliers } from "../../db/schema";
import { formatCentsInput, formatQtyInput } from "../../lib/units";
import { validate } from "../../lib/validation";
import { offerInput, offerTerms, offerToForm, saveOfferStatements, setPreferredStatement } from "../offers";
import { checkHeader, emptyPlan, fieldIssues, type Importer, type PlanRow, type RowIssue } from "./types";

const CSV_COLUMNS = [
	"ref",
	"supplier",
	"supplier_ref",
	"price",
	"moq",
	"pack_size",
	"lead_days",
	"preferred",
	"notes",
] as const;

const fieldToColumn = (f: string): string => (f === "supplier_id" ? "supplier" : f);

/**
 * part_suppliers.csv: supplier offers, one row per (part, supplier). Upsert by ref + supplier; columns left
 * out keep their current values. `preferred` = yes makes that supplier the part's preferred one (D92).
 */
export const offersImporter: Importer = {
	type: "part_suppliers",
	required: ["ref", "supplier"],
	optional: CSV_COLUMNS.filter((c) => c !== "ref" && c !== "supplier"),
	example: [
		["RES-10K", "Example Components Ltd", "RC0603-10K", "0.008", "100", "100", "7", "yes", ""],
		["RES-10K", "Other Distributor", "R10K-0603", "0.012", "10", "", "2", "no", "faster, pricier"],
	],

	async plan({ db }, table) {
		const { errors, warnings } = checkHeader(this, table);
		if (errors.length) return emptyPlan("part_suppliers", errors, warnings);

		const [allParts, allSuppliers, allOffers] = await Promise.all([
			db.select({ id: parts.id, ref: parts.ref, kind: parts.kind, supplierId: parts.supplierId }).from(parts),
			db.select({ id: suppliers.id, name: suppliers.name }).from(suppliers),
			db.select().from(partSuppliers),
		]);
		const partByRef = new Map(allParts.map((p) => [p.ref, p]));
		const supplierByName = new Map(allSuppliers.map((s) => [s.name.toLowerCase(), s]));
		const offers = new Map(allOffers.map((o) => [`${o.partId}:${o.supplierId}`, o]));
		const present = new Set(table.header);

		const issues: RowIssue[] = [];
		const rows: PlanRow[] = [];
		const ops: {
			partId: number;
			supplierId: number;
			data: ReturnType<typeof offerTerms>;
			previous: PartSupplier | undefined;
			/** Make this supplier preferred (true), stop preferring it (false), or leave as is (null). */
			preferred: boolean | null;
		}[] = [];
		const seen = new Map<string, number>();

		for (const rec of table.records) {
			const ref = (rec.values.ref ?? "").trim();
			const supplierName = (rec.values.supplier ?? "").trim();
			const part = partByRef.get(ref);
			const supplier = supplierByName.get(supplierName.toLowerCase());
			const lineIssues: RowIssue[] = [];
			if (!part) lineIssues.push({ line: rec.line, column: "ref", key: "unknown_part", vars: { ref } });
			else if (part.kind !== "buy" && part.kind !== "make")
				lineIssues.push({ line: rec.line, column: "ref", key: "not_stocked", vars: { kind: part.kind } });
			if (!supplier)
				lineIssues.push({ line: rec.line, column: "supplier", key: "unknown_supplier", vars: { name: supplierName } });
			if (!part || !supplier || lineIssues.length) {
				issues.push(...lineIssues);
				continue;
			}
			const key = `${part.id}:${supplier.id}`;
			const firstLine = seen.get(key);
			if (firstLine !== undefined) {
				issues.push({ line: rec.line, column: "supplier", key: "duplicate_in_file", vars: { line: firstLine } });
				continue;
			}
			seen.set(key, rec.line);
			const previous = offers.get(key);
			const wasPreferred = part.supplierId === supplier.id;
			// Start from the current offer ("en" format) and overlay the columns present in the file.
			const input: Record<string, string> = previous ? offerToForm(previous, wasPreferred, "en") : {};
			input.supplier_id = String(supplier.id);
			for (const col of CSV_COLUMNS) {
				if (col === "ref" || col === "supplier" || !present.has(col)) continue;
				input[col] = rec.values[col] ?? "";
			}
			if (input.preferred === "on") input.preferred = "yes";
			const v = validate(offerInput, input);
			if (!v.ok) {
				issues.push(...fieldIssues(rec.line, v.errors, fieldToColumn));
				continue;
			}
			const data = offerTerms(v.data);
			const preferred = present.has("preferred") ? v.data.preferred : null;
			const changes = previous ? diffOffer(previous, data) : [];
			if (preferred !== null && preferred !== wasPreferred)
				changes.push(`preferred: ${wasPreferred ? "yes" : "no"} → ${preferred ? "yes" : "no"}`);
			rows.push({
				line: rec.line,
				action: previous ? (changes.length ? "update" : "unchanged") : "create",
				cells: [
					ref,
					supplier.name,
					data.supplierRef,
					data.priceCents === null ? "" : formatCentsInput(data.priceCents),
				],
				changes,
			});
			if (!previous || changes.length)
				ops.push({
					partId: part.id,
					supplierId: supplier.id,
					data,
					previous,
					preferred: preferred === wasPreferred ? null : preferred,
				});
		}

		return {
			type: "part_suppliers",
			previewColumns: ["ref", "supplier", "supplier_ref", "price"],
			rows,
			errors: issues,
			warnings,
			statements: (user, now) =>
				ops.flatMap((op) => [
					...saveOfferStatements(db, { partId: op.partId }, op.supplierId, op.data, op.previous, "import", user, now),
					...(op.preferred === null
						? []
						: [setPreferredStatement(db, op.partId, op.preferred ? op.supplierId : null, user, now)]),
				]),
		};
	},

	async exportRows({ db, locale }) {
		const rows = await db
			.select({ offer: partSuppliers, ref: parts.ref, preferredId: parts.supplierId, supplierName: suppliers.name })
			.from(partSuppliers)
			.innerJoin(parts, eq(partSuppliers.partId, parts.id))
			.innerJoin(suppliers, eq(partSuppliers.supplierId, suppliers.id))
			.orderBy(asc(parts.ref), asc(suppliers.name));
		return rows.map(({ offer: o, ref, preferredId, supplierName }) => [
			ref,
			supplierName,
			o.supplierRef,
			o.priceCents === null ? "" : formatCentsInput(o.priceCents, locale),
			o.moqMilli ? formatQtyInput(o.moqMilli, locale) : "",
			o.packSizeMilli ? formatQtyInput(o.packSizeMilli, locale) : "",
			o.leadDays ? String(o.leadDays) : "",
			preferredId === o.supplierId ? "yes" : "no",
			o.notes,
		]);
	},
};

function diffOffer(current: PartSupplier, next: ReturnType<typeof offerTerms>): string[] {
	const out: string[] = [];
	const money = (v: number | null) => (v === null ? "∅" : formatCentsInput(v));
	const qty = (v: number) => (v ? formatQtyInput(v) : "∅");
	if (current.supplierRef !== next.supplierRef)
		out.push(`supplier_ref: ${current.supplierRef || "∅"} → ${next.supplierRef || "∅"}`);
	if (current.priceCents !== next.priceCents)
		out.push(`price: ${money(current.priceCents)} → ${money(next.priceCents)}`);
	if (current.moqMilli !== next.moqMilli) out.push(`moq: ${qty(current.moqMilli)} → ${qty(next.moqMilli)}`);
	if (current.packSizeMilli !== next.packSizeMilli)
		out.push(`pack_size: ${qty(current.packSizeMilli)} → ${qty(next.packSizeMilli)}`);
	if (current.leadDays !== next.leadDays) out.push(`lead_days: ${current.leadDays} → ${next.leadDays}`);
	if (current.notes !== next.notes) out.push(`notes: ${current.notes || "∅"} → ${next.notes || "∅"}`);
	return out;
}
