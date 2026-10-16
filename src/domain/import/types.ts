import type { CsvTable } from "../../lib/csv";
import type { Statement } from "../../lib/db";
import type { NumberLocale } from "../../lib/units";
import type { Db } from "../../types";

export const IMPORT_TYPES = [
	"suppliers",
	"storage_units",
	"parts",
	"part_options",
	"part_suppliers",
	"price_history",
	"machine_types",
	"machines",
	"assemblies",
	"stock",
] as const;
export type ImportType = (typeof IMPORT_TYPES)[number];

/** A problem tied to a CSV line. `key` is an i18n error key (Dict.errors). */
export type RowIssue = { line: number; column?: string; key: string; vars?: Record<string, string | number> };

export type PlanAction = "create" | "update" | "unchanged";

export type PlanRow = {
	line: number;
	action: PlanAction;
	/** Preview cells, aligned with ImportPlan.previewColumns. */
	cells: string[];
	/** Human-readable list of changed fields for updates ("cost: 1.20 → 1.35"). */
	changes: string[];
};

export type ImportPlan = {
	type: ImportType;
	previewColumns: string[];
	rows: PlanRow[];
	errors: RowIssue[];
	warnings: RowIssue[];
	/** Statements to run in one batch on commit. Only meaningful when errors is empty. */
	statements: (user: string, now: string) => Statement[];
	/** False when the change set cannot be undone (default: true). */
	revertible?: boolean;
};

export type ImportContext = { db: Db; locale: NumberLocale };

export interface Importer {
	type: ImportType;
	/** Columns that must be present in the header. */
	required: string[];
	/** Other recognised columns. */
	optional: string[];
	/** Column order for templates and exports (defaults to required + optional). */
	columns?: string[];
	/** Example rows for the downloadable template (canonical format: "," and "."). */
	example: string[][];
	plan(ctx: ImportContext, table: CsvTable): Promise<ImportPlan>;
	/** Current data in the import format, for round-trips and backups. */
	exportRows(ctx: ImportContext): Promise<string[][]>;
}

/** Header checks shared by all importers: missing required columns are errors, unknown ones warnings. */
export function checkHeader(importer: Importer, table: CsvTable): { errors: RowIssue[]; warnings: RowIssue[] } {
	const errors: RowIssue[] = [];
	const warnings: RowIssue[] = [];
	if (table.header.length === 0 || table.records.length === 0) {
		errors.push({ line: 1, key: "empty_file" });
		return { errors, warnings };
	}
	for (const col of importer.required) {
		if (!table.header.includes(col))
			errors.push({ line: 1, column: col, key: "missing_column", vars: { column: col } });
	}
	const known = new Set([...importer.required, ...importer.optional]);
	for (const col of table.header) {
		if (col && !known.has(col)) warnings.push({ line: 1, column: col, key: "unknown_column", vars: { column: col } });
	}
	return { errors, warnings };
}

/** Converts validation errors (field -> key) into row issues. */
export function fieldIssues(line: number, errors: Record<string, string>, columnFor: (field: string) => string) {
	return Object.entries(errors).map(([fieldName, key]) => ({ line, column: columnFor(fieldName), key }));
}

export function emptyPlan(type: ImportType, errors: RowIssue[], warnings: RowIssue[]): ImportPlan {
	return { type, previewColumns: [], rows: [], errors, warnings, statements: () => [] };
}
