// Full JSON backup and restore of the database. Tables are listed in foreign-key order:
// restore deletes in reverse order and inserts in this order, preserving ids. The change history is part of
// the backup; a restore does not log itself row by row (it suppresses the history triggers) but appends one
// non-revertible change set saying it happened.
import { getTableColumns, getTableName } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import {
	assemblies,
	assemblyLines,
	buildLines,
	buildMachineTimes,
	buildOptionChoices,
	builds,
	changeLog,
	changeSets,
	files,
	machineRateHistory,
	machines,
	machineTypes,
	partOptions,
	partOptionValues,
	partSuppliers,
	parts,
	poLines,
	poShipments,
	priceHistory,
	purchaseOrders,
	settings,
	stockMoves,
	suppliers,
	users,
} from "../db/schema";

export const BACKUP_FORMAT = "kitting-backup";
export const BACKUP_VERSION = 1;

const TABLES: SQLiteTable[] = [
	suppliers,
	parts,
	// A part's options and their values (D168), before the records that name them.
	partOptions,
	partOptionValues,
	// Machine types before the assemblies that name them (D147).
	machineTypes,
	machineRateHistory,
	machines,
	assemblies,
	assemblyLines,
	purchaseOrders,
	poLines,
	poShipments,
	builds,
	buildOptionChoices,
	buildLines,
	buildMachineTimes,
	stockMoves,
	partSuppliers,
	priceHistory,
	// File rows, not their content: the objects stay in the R2 bucket (D160, docs/administration.md).
	files,
	// Roles and admin options: a restore brings back who may do what (ADMIN_EMAILS still apply).
	users,
	settings,
	// The change history (D113). change_context is not data: it only exists while a batch runs.
	changeSets,
	changeLog,
];

export const TABLE_NAMES = TABLES.map((t) => getTableName(t));

/** Allowed column names per table, from the Drizzle schema (never from user input). */
const COLUMNS = new Map(TABLES.map((t) => [getTableName(t), Object.values(getTableColumns(t)).map((c) => c.name)]));

type Value = string | number | null;
export type Backup = {
	format: typeof BACKUP_FORMAT;
	version: number;
	exported_at: string;
	/** Last applied D1 migration when exported: restore requires the same schema. */
	migration: string | null;
	tables: Record<string, Record<string, Value>[]>;
};

async function lastMigration(d1: D1Database): Promise<string | null> {
	try {
		const row = await d1.prepare("SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1").first<{ name: string }>();
		return row?.name ?? null;
	} catch {
		return null;
	}
}

export async function exportBackup(d1: D1Database, now: string): Promise<Backup> {
	// Table names come from the schema constant above, never from the request.
	const results = await d1.batch(TABLE_NAMES.map((name) => d1.prepare(`SELECT * FROM ${name} ORDER BY id`)));
	const tables: Backup["tables"] = {};
	TABLE_NAMES.forEach((name, i) => {
		tables[name] = (results[i]?.results ?? []) as Record<string, Value>[];
	});
	return {
		format: BACKUP_FORMAT,
		version: BACKUP_VERSION,
		exported_at: now,
		migration: await lastMigration(d1),
		tables,
	};
}

const cell = z.union([z.string(), z.number(), z.null(), z.boolean().transform((b) => (b ? 1 : 0))]);
const backupSchema = z.object({
	format: z.literal(BACKUP_FORMAT),
	version: z.literal(BACKUP_VERSION),
	exported_at: z.string(),
	migration: z.string().nullable(),
	tables: z.record(z.string(), z.array(z.record(z.string(), cell))),
});

export type RestorePlan =
	| { ok: true; backup: Backup; counts: { table: string; rows: number }[] }
	| { ok: false; errors: string[] };

/** Validates a backup: format, schema version, known tables and columns, integer ids. */
export async function planRestore(d1: D1Database, text: string): Promise<RestorePlan> {
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		return { ok: false, errors: ["Not a valid JSON file."] };
	}
	const parsed = backupSchema.safeParse(json);
	if (!parsed.success) {
		return {
			ok: false,
			errors: parsed.error.issues.slice(0, 20).map((i) => `${i.path.join(".") || "file"}: ${i.message}`),
		};
	}
	const backup = parsed.data as Backup;
	const errors: string[] = [];
	const current = await lastMigration(d1);
	if (backup.migration !== current) {
		errors.push(
			`Schema mismatch: the backup was taken at migration "${backup.migration}", this database is at "${current}".`,
		);
	}
	for (const [name, rows] of Object.entries(backup.tables)) {
		const allowed = COLUMNS.get(name);
		if (!allowed) {
			errors.push(`Unknown table "${name}".`);
			continue;
		}
		rows.forEach((row, i) => {
			for (const key of Object.keys(row)) {
				if (!allowed.includes(key)) errors.push(`${name}[${i}]: unknown column "${key}".`);
			}
			if (typeof row.id !== "number" || !Number.isSafeInteger(row.id))
				errors.push(`${name}[${i}]: missing integer id.`);
		});
		if (errors.length > 50) break;
	}
	if (errors.length) return { ok: false, errors: errors.slice(0, 50) };
	return {
		ok: true,
		backup,
		counts: TABLE_NAMES.map((table) => ({ table, rows: backup.tables[table]?.length ?? 0 })),
	};
}

/** D1 limits bound parameters per statement: insert rows in chunks that fit. */
const MAX_PARAMS = 100;

/**
 * Statements that replace the whole database with the backup (run them in one batch). The history triggers
 * are suppressed meanwhile; the restore itself is then recorded as one change set by `by.user`.
 */
export function restoreStatements(
	d1: D1Database,
	backup: Backup,
	by: { user: string; now: string; summary: string },
): D1PreparedStatement[] {
	const stmts: D1PreparedStatement[] = [
		d1.prepare("PRAGMA defer_foreign_keys = ON"),
		d1.prepare("INSERT INTO change_context (id, suppress) VALUES (1, 1)"),
	];
	for (const name of [...TABLE_NAMES].reverse()) stmts.push(d1.prepare(`DELETE FROM ${name}`));
	for (const name of TABLE_NAMES) {
		const rows = backup.tables[name] ?? [];
		const columns = COLUMNS.get(name) ?? [];
		if (rows.length === 0) continue;
		// Only columns that exist in the schema; missing ones fall back to defaults via NULL-free subsets.
		const used = columns.filter((col) => rows.some((r) => col in r));
		const perStatement = Math.max(1, Math.floor(MAX_PARAMS / used.length));
		for (let i = 0; i < rows.length; i += perStatement) {
			const chunk = rows.slice(i, i + perStatement);
			const placeholders = chunk.map(() => `(${used.map(() => "?").join(", ")})`).join(", ");
			const values = chunk.flatMap((r) => used.map((col) => r[col] ?? null));
			stmts.push(d1.prepare(`INSERT INTO ${name} (${used.join(", ")}) VALUES ${placeholders}`).bind(...values));
		}
	}
	stmts.push(
		d1.prepare("DELETE FROM change_context"),
		d1
			.prepare("INSERT INTO change_sets (at, user_email, source, summary, revertible) VALUES (?, ?, 'import', ?, 0)")
			.bind(by.now, by.user, by.summary),
	);
	return stmts;
}
