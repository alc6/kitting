// Undo (D109): reverting change set N writes a new change set (source "revert") that walks N's entries
// backwards: an update gets its old values back, an insert is deleted, a delete is re-inserted with its id.
// Nothing is written when a row changed since N, when a deleted row is still used, or when a restored row
// points at something that is gone: the caller gets the conflicts instead. The checks are made twice: in
// TypeScript first, for a clear message, then as guards inside the batch, so that a change made in between
// still rolls everything back.
import { and, asc, desc, eq, getTableColumns, getTableName, gt, type SQL, sql } from "drizzle-orm";
import { getTableConfig, type SQLiteTable } from "drizzle-orm/sqlite-core";
import { AUDIT_COLUMNS, columnNames } from "../db/history-sql";
import {
	type ChangeLogRow,
	type ChangeSet,
	changeContext,
	changeLog,
	changeSets,
	HISTORY_TABLES,
	machineRateHistory,
	type PriceKind,
	priceHistory,
	UNTRACKED_TABLES,
} from "../db/schema";
import type { Statement } from "../lib/db";
import { chunks, isConstraintError } from "../lib/sql";
import type { Db } from "../types";
import { COLUMN_ACTIONS, runChangeSet } from "./history";
import { type Access, type Action, can } from "./permissions";

/** The permission needed to undo a change to each tracked table: the one that edits it (D112). */
export const TABLE_ACTIONS: Record<string, Action> = {
	parts: "parts.edit",
	suppliers: "suppliers.edit",
	assemblies: "assemblies.edit",
	assembly_lines: "assemblies.edit",
	part_suppliers: "prices.edit",
	purchase_orders: "purchasing.order",
	po_lines: "purchasing.order",
	po_shipments: "purchasing.order",
	builds: "builds.plan",
	users: "users.manage",
	settings: "users.manage",
	machine_types: "machines.edit",
	machines: "machines.edit",
	files: "files.edit",
};

/** Price columns whose changes the append-only price history must follow (CLAUDE.md, "Data rules"). */
const PRICE_COLUMNS: Record<string, { column: string; kind: PriceKind }[]> = {
	parts: [
		{ column: "cost_cents", kind: "standard" },
		{ column: "sale_price_cents", kind: "sale" },
	],
	assemblies: [{ column: "sale_price_cents", kind: "sale" }],
	part_suppliers: [{ column: "price_cents", kind: "purchase" }],
};

const TRACKED = new Map(HISTORY_TABLES.map((t) => [getTableName(t), t]));
const ALL_TABLES: SQLiteTable[] = [...HISTORY_TABLES, ...UNTRACKED_TABLES];

type Row = Record<string, unknown>;

/** Who changed a row after the change set being reverted. */
export type ChangedBy = { changeSetId: number; user: string; at: string; summary: string };

export type RevertConflict = {
	table: string;
	rowId: number;
	/** The row as the change set left it (or as it is now): enough to name it. */
	row: Row | null;
	reason:
		| "changed" // the row differs from what the change set left
		| "missing" // the row was deleted since
		| "exists" // a row the undo would re-insert exists again
		| "in_use" // the undo would delete a row other rows now use
		| "parent_missing" // a restored row points at a row that no longer exists
		| "duplicate" // a restored value is now used by another row (a unique ref, number, email…)
		| "concurrent"; // something changed while the undo was running: try again
	/** For in_use / parent_missing: the other table. */
	other?: string;
	by?: ChangedBy;
};

export type RevertOutcome =
	| { ok: true; id: number | null }
	| { ok: false; reason: "not_found" | "not_revertible" | "empty" }
	| { ok: false; reason: "forbidden"; actions: Action[] }
	| { ok: false; reason: "conflict"; conflicts: RevertConflict[] };

/** Why a change set cannot be undone at all, whatever the data (null when it can be tried). */
export function revertBlocker(set: Pick<ChangeSet, "revertible">, entries: Pick<ChangeLogRow, "tableName">[]) {
	if (!set.revertible) return "not_revertible" as const;
	if (entries.length === 0) return "empty" as const;
	if (entries.some((e) => !TRACKED.has(e.tableName))) return "not_revertible" as const;
	return null;
}

/**
 * The permissions needed to undo changes to these tables that `access` lacks, plus those of `columnActions`
 * (see columnActionsNeeded): archiving a part needs `parts.archive` also when undone (D136).
 */
export function missingActions(access: Access, tables: string[], columnActions: Action[] = []): Action[] {
	const needed = new Set([...tables.map((t) => TABLE_ACTIONS[t]).filter((a): a is Action => !!a), ...columnActions]);
	return [...needed].filter((a) => !can(access, a));
}

/** The COLUMN_ACTIONS actions needed to undo these entries: an update that changed a gated column. */
export function columnActionsNeeded(entries: Pick<ChangeLogRow, "tableName" | "op" | "oldRow" | "newRow">[]): Action[] {
	const needed = new Set<Action>();
	for (const e of entries) {
		const gated = COLUMN_ACTIONS[e.tableName];
		const [before, after] = [parse(e.oldRow), parse(e.newRow)];
		if (!gated || e.op !== "update" || !before || !after) continue;
		for (const [column, action] of Object.entries(gated))
			if ((before[column] ?? null) !== (after[column] ?? null)) needed.add(action);
	}
	return [...needed];
}

const parse = (json: string | null): Row | null => (json === null ? null : (JSON.parse(json) as Row));

/** Columns compared and restored: the table's columns, minus who/when, present in the snapshot. */
function dataColumns(table: SQLiteTable, snapshot: Row): string[] {
	return columnNames(table).filter((c) => !AUDIT_COLUMNS.includes(c) && c in snapshot);
}

function sameData(table: SQLiteTable, current: Row, expected: Row): boolean {
	return dataColumns(table, expected).every((c) => (current[c] ?? null) === (expected[c] ?? null));
}

/** One row touched by the change set: its first and last entries, and its state before and after. */
type Touched = {
	table: SQLiteTable;
	name: string;
	rowId: number;
	before: Row | null;
	after: Row | null;
};

function touchedRows(entries: ChangeLogRow[]): Touched[] {
	const byRow = new Map<string, Touched>();
	for (const e of entries) {
		const key = `${e.tableName}:${e.rowId}`;
		const t = byRow.get(key);
		if (t) t.after = parse(e.newRow);
		else {
			const table = TRACKED.get(e.tableName);
			if (!table) continue;
			byRow.set(key, { table, name: e.tableName, rowId: e.rowId, before: parse(e.oldRow), after: parse(e.newRow) });
		}
	}
	return [...byRow.values()];
}

/** Foreign keys of every table, as (child table, child column) → (parent table, on delete). */
function foreignKeys() {
	return ALL_TABLES.flatMap((child) =>
		getTableConfig(child).foreignKeys.map((fk) => {
			const ref = fk.reference();
			return {
				child,
				childName: getTableName(child),
				column: ref.columns[0]?.name ?? "",
				parentName: getTableName(ref.foreignTable),
				onDelete: fk.onDelete,
			};
		}),
	);
}

type Fk = ReturnType<typeof foreignKeys>[number];

/**
 * Whether rows of `fk.childName` keep the parent from being deleted. The price history of a part or an assembly
 * goes with it (ON DELETE CASCADE), as when deleting the part or assembly from its page; so does the rate history of
 * a machine type.
 */
const HISTORY_LOGS: string[] = [getTableName(priceHistory), getTableName(machineRateHistory)];
const blocksDelete = (fk: Fk) => !(HISTORY_LOGS.includes(fk.childName) && fk.onDelete === "cascade");

async function changedSince(db: Db, after: number, table: string, rowId: number): Promise<ChangedBy | undefined> {
	const rows = await db
		.select({ id: changeSets.id, user: changeSets.userEmail, at: changeSets.at, summary: changeSets.summary })
		.from(changeLog)
		.innerJoin(changeSets, eq(changeLog.changeSetId, changeSets.id))
		.where(and(eq(changeLog.tableName, table), eq(changeLog.rowId, rowId), gt(changeLog.changeSetId, after)))
		.orderBy(desc(changeLog.id))
		.limit(1);
	const r = rows[0];
	return r ? { changeSetId: r.id, user: r.user, at: r.at, summary: r.summary } : undefined;
}

/** Current rows of `table` among `ids`, by id (one query per 90 ids). */
async function currentRows(db: Db, table: string, ids: number[]): Promise<Map<number, Row>> {
	const found = new Map<number, Row>();
	for (const part of chunks([...new Set(ids)])) {
		const rows = await db.all<Row>(
			sql`SELECT * FROM ${sql.identifier(table)} WHERE id IN (${sql.join(
				part.map((id) => sql`${id}`),
				sql`, `,
			)})`,
		);
		for (const r of rows) found.set(r.id as number, r);
	}
	return found;
}

/** Rows of `fk.childName` pointing at any of `ids`: [child id, parent id]. */
async function referencing(db: Db, fk: Fk, ids: number[]): Promise<[number, number][]> {
	const out: [number, number][] = [];
	for (const part of chunks([...new Set(ids)])) {
		const rows = await db.all<{ id: number; parent: number }>(
			sql`SELECT id, ${sql.identifier(fk.column)} AS parent FROM ${sql.identifier(fk.childName)}
				WHERE ${sql.identifier(fk.column)} IN (${sql.join(
					part.map((id) => sql`${id}`),
					sql`, `,
				)})`,
		);
		for (const r of rows) out.push([r.id, r.parent]);
	}
	return out;
}

const byTable = <T extends { name: string }>(list: T[]) => {
	const map = new Map<string, T[]>();
	for (const item of list) map.set(item.name, [...(map.get(item.name) ?? []), item]);
	return map;
};

/** Checks the undo against the database as it is now (a few queries per table, not per row). */
async function findConflicts(db: Db, setId: number, rows: Touched[]): Promise<RevertConflict[]> {
	const conflicts: RevertConflict[] = [];
	const key = (table: string, id: number) => `${table}:${id}`;
	const deleted = rows.filter((r) => r.before === null && r.after !== null);
	const deletedKeys = new Set(deleted.map((r) => key(r.name, r.rowId)));
	const restoredKeys = new Set(rows.filter((r) => r.before !== null).map((r) => key(r.name, r.rowId)));
	const fks = foreignKeys();

	// Each row must be as the change set left it.
	for (const [table, list] of byTable(rows)) {
		const current = await currentRows(
			db,
			table,
			list.map((r) => r.rowId),
		);
		for (const r of list) {
			const now = current.get(r.rowId) ?? null;
			if (r.after === null) {
				if (now) conflicts.push({ table, rowId: r.rowId, row: now, reason: "exists" });
			} else if (!now) {
				const by = await changedSince(db, setId, table, r.rowId);
				conflicts.push({ table, rowId: r.rowId, row: r.after, reason: "missing", ...(by ? { by } : {}) });
			} else if (!sameData(r.table, now, r.after)) {
				const by = await changedSince(db, setId, table, r.rowId);
				conflicts.push({ table, rowId: r.rowId, row: now, reason: "changed", ...(by ? { by } : {}) });
			}
		}
	}

	// A row the undo deletes must not be used by rows it keeps.
	for (const [table, list] of byTable(deleted)) {
		for (const fk of fks.filter((f) => f.parentName === table && blocksDelete(f))) {
			const users = await referencing(
				db,
				fk,
				list.map((r) => r.rowId),
			);
			const inUse = new Set(
				users.filter(([id]) => !deletedKeys.has(key(fk.childName, id))).map(([, parent]) => parent),
			);
			for (const r of list.filter((r) => inUse.has(r.rowId)))
				conflicts.push({ table, rowId: r.rowId, row: r.after, reason: "in_use", other: fk.childName });
		}
	}

	// What a restored row points at must still exist (or come back with it).
	const wanted = new Map<string, { r: Touched; fk: Fk; parentId: number }[]>();
	for (const r of rows) {
		if (r.before === null) continue;
		for (const fk of fks.filter((f) => f.childName === r.name)) {
			const parentId = r.before[fk.column];
			if (typeof parentId !== "number") continue;
			wanted.set(fk.parentName, [...(wanted.get(fk.parentName) ?? []), { r, fk, parentId }]);
		}
	}
	for (const [parent, refs] of wanted) {
		const existing = await currentRows(
			db,
			parent,
			refs.map((x) => x.parentId),
		);
		for (const { r, parentId } of refs) {
			const k = key(parent, parentId);
			const gone = deletedKeys.has(k) || (!restoredKeys.has(k) && !existing.has(parentId));
			if (gone)
				conflicts.push({ table: r.name, rowId: r.rowId, row: r.before, reason: "parent_missing", other: parent });
		}
	}
	return conflicts;
}

// Statements are query builders, never db.run(sql) with parameters: Drizzle's D1 batch cannot bind those.

/** `UPDATE change_context SET conflict = 1 WHERE <cond>`: fails the batch (CHECK revert_conflict) when true. */
function guard(db: Db, condition: SQL): Statement {
	return db.update(changeContext).set({ conflict: 1 }).where(condition);
}

/**
 * The row still holds what the change set left (compared on data columns, read from the JSON snapshot). Two
 * parameters per row: the JSON paths are literals, built from schema column names (never from input).
 */
function matchesSnapshot(table: SQLiteTable, name: string, rowId: number, snapshot: Row) {
	const checks = dataColumns(table, snapshot).map((c) => {
		if (!/^[a-z_][a-z0-9_]*$/.test(c)) throw new Error(`unexpected column name ${c}`);
		return sql`t.${sql.identifier(c)} IS json_extract(s.j, ${sql.raw(`'$.${c}'`)})`;
	});
	return sql`EXISTS (SELECT 1 FROM ${sql.identifier(name)} AS t, (SELECT ${JSON.stringify(snapshot)} AS j) AS s
		WHERE t.id = ${rowId} AND ${sql.join(checks, sql` AND `)})`;
}

/** Snapshot values (snake_case column names) keyed by the table's Drizzle property names, for insert/set. */
function toProperties(table: SQLiteTable, row: Row, columns: string[]): Record<string, unknown> {
	const keyOf = new Map(Object.entries(getTableColumns(table)).map(([key, col]) => [col.name, key]));
	return Object.fromEntries(columns.map((c) => [keyOf.get(c) ?? c, row[c] ?? null]));
}

const byId = (rowId: number) => sql`${sql.identifier("id")} = ${rowId}`;

function restoreUpdate(db: Db, table: SQLiteTable, rowId: number, old: Row, user: string, now: string): Statement {
	const values = toProperties(
		table,
		old,
		dataColumns(table, old).filter((c) => c !== "id"),
	);
	// An undo is a change like any other: it is dated and signed by whoever makes it.
	if (columnNames(table).includes("updated_at")) Object.assign(values, { updatedAt: now, updatedBy: user });
	return db
		.update(table)
		.set(values as never)
		.where(byId(rowId));
}

function reinsert(db: Db, table: SQLiteTable, old: Row): Statement {
	// Every column of the snapshot that the table still has, id and who/when included: the same row comes back.
	const values = toProperties(
		table,
		old,
		columnNames(table).filter((c) => c in old),
	);
	return db.insert(table).values(values as never);
}

/** price_history rows for the prices the undo changes back (source "revert"). */
function priceStatements(db: Db, rows: Touched[], setId: number, user: string, now: string): Statement[] {
	const stmts: Statement[] = [];
	for (const r of rows) {
		const restored = r.before;
		if (!restored) continue; // deleted by the undo: its price history goes with it, or stays as it was
		for (const p of PRICE_COLUMNS[r.name] ?? []) {
			const price = (restored[p.column] ?? null) as number | null;
			const current = (r.after?.[p.column] ?? null) as number | null;
			if (r.after !== null && price === current) continue;
			if (r.after === null && price === null) continue;
			const partId = (
				r.name === "parts" ? r.rowId : r.name === "assemblies" ? restored.parent_part_id : restored.part_id
			) as number;
			stmts.push(
				db.insert(priceHistory).values({
					partId,
					kind: p.kind,
					priceCents: price,
					supplierId: r.name === "part_suppliers" ? (restored.supplier_id as number) : null,
					assemblyId: r.name === "assemblies" ? r.rowId : null,
					validFrom: now.slice(0, 10),
					source: "revert",
					note: `#${setId}`,
					createdBy: user,
					updatedBy: user,
					createdAt: now,
					updatedAt: now,
				}),
			);
		}
		// A machine type's hourly rate follows the same rule, in its own log (D149).
		if (r.name === "machine_types") {
			const rate = (restored.hourly_rate_cents ?? null) as number | null;
			const current = (r.after?.hourly_rate_cents ?? null) as number | null;
			if (r.after !== null ? rate === current : rate === null) continue;
			stmts.push(
				db.insert(machineRateHistory).values({
					machineTypeId: r.rowId,
					rateCents: rate,
					validFrom: now.slice(0, 10),
					source: "revert",
					note: `#${setId}`,
					createdBy: user,
					updatedBy: user,
					createdAt: now,
					updatedAt: now,
				}),
			);
		}
	}
	return stmts;
}

/**
 * The statements of an undo, without the checks made beforehand (revertChangeSet runs them in a change set):
 * guards, then the entries walked backwards, then the price history.
 */
export function revertStatements(db: Db, set: ChangeSet, entries: ChangeLogRow[], user: string, now: string) {
	const rows = touchedRows(entries);
	const stmts: Statement[] = [db.run(sql`PRAGMA defer_foreign_keys = ON`)];
	// Every row still as the change set left it: one guard per 40 rows (2 parameters each).
	for (const part of chunks(rows, 40)) {
		const unchanged = part.map((r) =>
			r.after === null
				? sql`EXISTS (SELECT 1 FROM ${sql.identifier(r.name)} WHERE id = ${r.rowId})`
				: sql`NOT ${matchesSnapshot(r.table, r.name, r.rowId, r.after)}`,
		);
		stmts.push(guard(db, sql`(${sql.join(unchanged, sql`) OR (`)})`));
	}
	const fks = foreignKeys();
	for (const e of [...entries].reverse()) {
		const table = TRACKED.get(e.tableName);
		if (!table) continue;
		const old = parse(e.oldRow);
		if (e.op === "update" && old && dataColumns(table, old).some((c) => c !== "id"))
			stmts.push(restoreUpdate(db, table, e.rowId, old, user, now));
		else if (e.op === "delete" && old) stmts.push(reinsert(db, table, old));
		else if (e.op === "insert") {
			// A cascade would silently delete rows added since (lines of an assembly or PO, offers of a part): the rows
			// this change set created after this one were deleted just before, so any left are someone else's.
			// Other references fail the deferred foreign key check at commit.
			for (const fk of fks.filter((f) => f.parentName === e.tableName && f.onDelete === "cascade" && blocksDelete(f))) {
				stmts.push(
					guard(
						db,
						sql`EXISTS (SELECT 1 FROM ${sql.identifier(fk.childName)} WHERE ${sql.identifier(fk.column)} = ${e.rowId})`,
					),
				);
			}
			stmts.push(db.delete(table).where(byId(e.rowId)));
		}
	}
	stmts.push(...priceStatements(db, rows, set.id, user, now));
	return stmts;
}

export async function getChangeSet(db: Db, id: number) {
	const rows = await db.select().from(changeSets).where(eq(changeSets.id, id)).limit(1);
	return rows[0];
}

export async function changeSetEntries(db: Db, id: number) {
	return db.select().from(changeLog).where(eq(changeLog.changeSetId, id)).orderBy(asc(changeLog.id));
}

/**
 * Undoes change set `id` as `by.user` (who must be allowed to edit every area it touched, and to change the gated columns it changed), in one batch.
 * `by.summary` names the undo in the history; `by.source` is "revert" unless an API client says otherwise.
 */
export async function revertChangeSet(
	db: Db,
	access: Access,
	id: number,
	by: { user: string; summary: (set: ChangeSet) => string; clientName?: string | null; now?: string },
): Promise<RevertOutcome> {
	const set = await getChangeSet(db, id);
	if (!set) return { ok: false, reason: "not_found" };
	const entries = await changeSetEntries(db, id);
	const blocker = revertBlocker(set, entries);
	if (blocker) return { ok: false, reason: blocker };
	const actions = missingActions(
		access,
		entries.map((e) => e.tableName),
		columnActionsNeeded(entries),
	);
	if (actions.length) return { ok: false, reason: "forbidden", actions };
	const rows = touchedRows(entries);
	const conflicts = await findConflicts(db, id, rows);
	if (conflicts.length) return { ok: false, reason: "conflict", conflicts };
	const now = by.now ?? new Date().toISOString();
	try {
		const result = await runChangeSet(
			db,
			{
				user: by.user,
				source: "revert",
				summary: by.summary(set),
				clientName: by.clientName ?? null,
				revertsChangeSetId: id,
				now,
			},
			revertStatements(db, set, entries, by.user, now),
		);
		return { ok: true, id: result.id };
	} catch (err) {
		const conflict = batchConflict(err, rows);
		if (!conflict) throw err;
		return { ok: false, reason: "conflict", conflicts: [conflict] };
	}
}

/**
 * Turns a constraint error of the undo batch into a conflict. The checks above make these rare: a value made
 * unique again (a part's ref now used by another part), or a change made while the undo ran.
 */
function batchConflict(err: unknown, rows: Touched[]): RevertConflict | null {
	const message = String(err instanceof Error ? `${err.message} ${String((err as { cause?: unknown }).cause)}` : err);
	const reason: RevertConflict["reason"] | null = isConstraintError(err, "UNIQUE")
		? "duplicate"
		: isConstraintError(err, "FOREIGN KEY") || message.includes("revert_conflict")
			? "concurrent"
			: null;
	if (!reason) return null;
	// "UNIQUE constraint failed: parts.ref" or "… failed: index 'assemblies_one_active_per_code'": find the table.
	const index = /index '(\w+)'/.exec(message)?.[1];
	const table =
		/constraint failed: (\w+)\./.exec(message)?.[1] ??
		HISTORY_TABLES.map((t) => getTableConfig(t)).find((c) => c.indexes.some((i) => i.config.name === index))?.name;
	const row = rows.find((r) => r.name === table && r.before !== null) ?? rows[0];
	return { table: row?.name ?? "", rowId: row?.rowId ?? 0, row: row?.before ?? row?.after ?? null, reason };
}
