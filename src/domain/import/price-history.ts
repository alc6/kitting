import { asc, eq, inArray } from "drizzle-orm";
import { parts, priceHistory, suppliers } from "../../db/schema";
import { formatCentsInput } from "../../lib/units";
import { validate } from "../../lib/validation";
import {
	loadSeries,
	type PastPriceInput,
	pastPriceInput,
	pastPriceRuleErrors,
	pastPriceStatement,
	seriesKey,
} from "../past-prices";
import { checkHeader, emptyPlan, fieldIssues, type Importer, type PlanRow, type RowIssue } from "./types";

/** Form field -> CSV column. */
const fieldToColumn = (f: string): string => (f === "date" ? "valid_from" : f === "supplier_id" ? "supplier" : f);

type Add = { partId: number; priceCents: number; supplierId: number | null; date: string; note: string };

/**
 * price_history.csv: prices a part had before Kitting (D142), one row per price. Every row is a new history
 * row: nothing is updated. A row is refused unless its date is before today and before the latest row of its
 * series in the database (same part and same supplier, or the standard cost when `supplier` is empty); rows of
 * the file may come in any order. No current value (standard cost, offer) changes.
 */
export const priceHistoryImporter: Importer = {
	type: "price_history",
	required: ["ref", "price", "valid_from"],
	optional: ["supplier", "note"],
	example: [
		["RES-10K", "0.0085", "2024-03-01", "", "Standard cost before Kitting"],
		["RES-10K", "0.0120", "2024-03-01", "Example Components Ltd", "Quote from the 2024 price list"],
	],

	async plan({ db }, table) {
		const { errors, warnings } = checkHeader(this, table);
		if (errors.length) return emptyPlan("price_history", errors, warnings);

		const [allParts, allSuppliers, series] = await Promise.all([
			db.select({ id: parts.id, ref: parts.ref, kind: parts.kind }).from(parts),
			db.select({ id: suppliers.id, name: suppliers.name }).from(suppliers),
			loadSeries(db),
		]);
		const partByRef = new Map(allParts.map((p) => [p.ref, p]));
		const supplierByName = new Map(allSuppliers.map((s) => [s.name.toLowerCase(), s]));
		const today = new Date().toISOString().slice(0, 10);

		const issues: RowIssue[] = [];
		const rows: PlanRow[] = [];
		const adds: Add[] = [];
		const seen = new Map<string, number>();

		for (const rec of table.records) {
			const ref = (rec.values.ref ?? "").trim();
			const supplierName = (rec.values.supplier ?? "").trim();
			const part = partByRef.get(ref);
			const supplier = supplierName ? supplierByName.get(supplierName.toLowerCase()) : undefined;
			const lineIssues: RowIssue[] = [];
			if (!part) lineIssues.push({ line: rec.line, column: "ref", key: "unknown_part", vars: { ref } });
			if (supplierName && !supplier)
				lineIssues.push({ line: rec.line, column: "supplier", key: "unknown_supplier", vars: { name: supplierName } });
			const v = validate(pastPriceInput, {
				date: rec.values.valid_from ?? "",
				price: rec.values.price ?? "",
				supplier_id: supplier ? String(supplier.id) : "",
				note: rec.values.note ?? "",
			});
			if (!v.ok) lineIssues.push(...fieldIssues(rec.line, v.errors, fieldToColumn));
			if (lineIssues.length || !part || !v.ok) {
				issues.push(...lineIssues);
				continue;
			}
			const d: PastPriceInput = v.data;
			const supplierId = supplier?.id ?? null;
			const key = `${seriesKey(part.id, supplierId)}:${d.date}`;
			const firstLine = seen.get(key);
			if (firstLine !== undefined) {
				issues.push({ line: rec.line, column: "valid_from", key: "duplicate_in_file", vars: { line: firstLine } });
				continue;
			}
			seen.set(key, rec.line);
			const rule = pastPriceRuleErrors({
				date: d.date,
				supplierId,
				partKind: part.kind,
				series: series.get(seriesKey(part.id, supplierId)),
				today,
			});
			if (Object.keys(rule).length) {
				issues.push(...fieldIssues(rec.line, rule, fieldToColumn).map((i) => ({ ...i, vars: { kind: part.kind } })));
				continue;
			}
			rows.push({
				line: rec.line,
				action: "create",
				cells: [ref, supplier?.name ?? "", d.date, formatCentsInput(d.price)],
				changes: [],
			});
			adds.push({ partId: part.id, priceCents: d.price, supplierId, date: d.date, note: d.note });
		}

		return {
			type: "price_history",
			previewColumns: ["ref", "supplier", "valid_from", "price"],
			rows,
			errors: issues,
			warnings,
			// Added rows are not tracked row by row (D92), so the change set has nothing to undo (D142).
			revertible: false,
			statements: (user, now) =>
				adds.map((a) =>
					pastPriceStatement(
						db,
						a.partId,
						{ date: a.date, priceCents: a.priceCents, supplierId: a.supplierId, note: a.note },
						"import",
						user,
						now,
					),
				),
		};
	},

	async exportRows({ db, locale }) {
		const rows = await db
			.select({
				ref: parts.ref,
				supplierName: suppliers.name,
				priceCents: priceHistory.priceCents,
				validFrom: priceHistory.validFrom,
				note: priceHistory.note,
			})
			.from(priceHistory)
			.innerJoin(parts, eq(priceHistory.partId, parts.id))
			.leftJoin(suppliers, eq(priceHistory.supplierId, suppliers.id))
			.where(inArray(priceHistory.kind, ["standard", "purchase"]))
			.orderBy(asc(parts.ref), asc(suppliers.name), asc(priceHistory.validFrom), asc(priceHistory.id));
		return rows.map((r) => [
			r.ref,
			r.priceCents === null ? "" : formatCentsInput(r.priceCents, locale),
			r.validFrom,
			r.supplierName ?? "",
			r.note,
		]);
	},
};
