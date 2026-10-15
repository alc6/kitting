// Change history (D106–D114): every write to a tracked table (HISTORY_TABLES) runs inside a change set.
// runChangeSet() wraps the statements of one D1 batch (one transaction) between statements that open the
// change set and close it; SQLite triggers copy each row change into change_log, and abort any write to a
// tracked table made outside a change set. Pages, CSV imports and future API (MCP) tools all write this way.
import { and, asc, desc, eq, gte, inArray, lt, lte, or, type SQL, sql } from "drizzle-orm";
import type { BatchResponse } from "drizzle-orm/batch";
import { AUDIT_COLUMNS } from "../db/history-sql";
import {
	assemblies,
	builds,
	CHANGE_SOURCES,
	type ChangeLogRow,
	type ChangeOp,
	type ChangeSet,
	type ChangeSource,
	changeContext,
	changeLog,
	changeSets,
	machineTypes,
	partOptions,
	partOptionValues,
	parts,
	purchaseOrders,
	suppliers,
} from "../db/schema";
import { runBatch, type Statement } from "../lib/db";
import { chunks, likePattern } from "../lib/sql";
import type { Db } from "../types";
import { idsOf } from "./option-keys";
import { type Access, type Action, redactCosts } from "./permissions";

/** Who changes what, and how to describe it in the history. */
export type ChangeMeta = {
	/** Email of the signed-in user (or of the user an API client acts for). */
	user: string;
	source: ChangeSource;
	/** One line saying what changed, e.g. "Edit assembly LAMP-DESK std Rev3". Never an amount: every role reads it. */
	summary: string;
	/** The API client that made the change (MCP), if any. */
	clientName?: string | null;
	/**
	 * False when an undo could not restore a consistent state (e.g. an image whose file is gone). Writing to a
	 * ledger (stock moves, as-built lines) marks the change set non-revertible on its own, by trigger.
	 */
	revertible?: boolean;
	/** For an undo: the change set it reverts. */
	revertsChangeSetId?: number | null;
	/** Timestamp of the change set (ISO-8601 UTC); defaults to now. */
	now?: string;
};

export type ChangeSetResult<T extends Statement[]> = {
	/** The new change set, or null when the statements changed nothing (no change set is kept then). */
	id: number | null;
	/** The result of each statement, in order (e.g. the rows of an insert … returning). */
	results: BatchResponse<T>;
};

/** Summaries are one line; longer text (e.g. from an API client) is cut. */
export const MAX_SUMMARY = 300;

/**
 * Runs `statements` in one batch as a change set: either everything applies and is recorded, or nothing does.
 * An empty list runs nothing. A change set whose statements changed no tracked row and wrote no ledger row is
 * dropped (e.g. "start" on a build already started).
 */
export async function runChangeSet<T extends Statement[]>(
	db: Db,
	meta: ChangeMeta,
	statements: [...T],
): Promise<ChangeSetResult<T>> {
	if (statements.length === 0) return { id: null, results: [] as unknown as BatchResponse<T> };
	const now = meta.now ?? new Date().toISOString();
	const summary = meta.summary.replace(/\s+/g, " ").trim().slice(0, MAX_SUMMARY);
	const open: Statement[] = [
		db
			.insert(changeSets)
			.values({
				at: now,
				userEmail: meta.user,
				source: meta.source,
				clientName: meta.clientName ?? null,
				summary,
				revertible: meta.revertible ?? true,
				revertsChangeSetId: meta.revertsChangeSetId ?? null,
			})
			.returning({ id: changeSets.id }),
		// Replaces a row an interrupted manual script may have left (inside a batch there is never one).
		db
			.insert(changeContext)
			.values({ id: 1, changeSetId: sql`(SELECT max(id) FROM change_sets)` })
			.onConflictDoUpdate({
				target: changeContext.id,
				set: { changeSetId: sql`(SELECT max(id) FROM change_sets)`, suppress: false, conflict: 0 },
			}),
	];
	const close: Statement[] = [
		db.run(sql`DELETE FROM change_sets
			WHERE id = (SELECT change_set_id FROM change_context) AND revertible = 1
				AND NOT EXISTS (SELECT 1 FROM change_log WHERE change_log.change_set_id = change_sets.id)`),
		db.all<{ kept: number }>(
			sql`SELECT EXISTS (SELECT 1 FROM change_sets WHERE id = (SELECT change_set_id FROM change_context)) AS kept`,
		),
		db.delete(changeContext),
	];
	const all = await runBatch(db, [...open, ...statements, ...close]);
	const id = (all[0] as { id: number }[])[0]?.id ?? null;
	const kept = (all[open.length + statements.length + 1] as { kept: number }[])[0]?.kept === 1;
	return {
		id: kept ? id : null,
		results: all.slice(open.length, open.length + statements.length) as BatchResponse<T>,
	};
}

// ---------------------------------------------------------------------------
// Reading the history

export type ChangeSetFilters = {
	source?: string;
	user?: string;
	/** Dates (YYYY-MM-DD), inclusive. */
	from?: string | null;
	to?: string | null;
	/** Text in the summary. */
	q?: string;
	/** Only change sets older than this id (next page). */
	before?: number | null;
	limit?: number;
};

/**
 * Columns whose change needs an action of its own on top of the edit action of the table, also when undone
 * (D136): table → column → action. Only the archived flag of a part now; assembly statuses stay with `assemblies.edit`.
 */
export const COLUMN_ACTIONS: Record<string, Record<string, Action>> = {
	parts: { archived: "parts.archive" },
};

/** Per (table, column): the action when the change set changed that column of a row, else ''. Literals only. */
const columnActionsSql = sql.join(
	Object.entries(COLUMN_ACTIONS).flatMap(([table, columns]) =>
		Object.entries(columns).map(([column, action]) => {
			if (![table, column, action].every((v) => /^[a-z_.]+$/.test(v))) throw new Error(`unexpected name ${action}`);
			return sql`coalesce((SELECT '${sql.raw(action)}' FROM change_log l WHERE l.change_set_id = change_sets.id
				AND l.table_name = '${sql.raw(table)}' AND l.op = 'update'
				AND json_extract(l.old_row, '$.${sql.raw(column)}') IS NOT json_extract(l.new_row, '$.${sql.raw(column)}')
				LIMIT 1), '')`;
		}),
	),
	sql` || ',' || `,
);

// Correlated subqueries name the outer table explicitly: Drizzle renders ${changeSets.id} unqualified here,
// which inside the subquery would mean change_log.id.
const changeSetSummaryColumns = {
	set: changeSets,
	entries: sql<number>`(SELECT count(*) FROM change_log l WHERE l.change_set_id = change_sets.id)`,
	tables: sql<
		string | null
	>`(SELECT group_concat(DISTINCT l.table_name) FROM change_log l WHERE l.change_set_id = change_sets.id)`,
	// Actions of COLUMN_ACTIONS whose column a row of the change set changed, comma-separated (see columnActionsOf).
	columnActions: sql<string>`(${columnActionsSql})`,
	// The undo currently in effect, if any: an undo that was not itself undone.
	undoneBy: sql<number | null>`(SELECT max(r.id) FROM change_sets r WHERE r.reverts_change_set_id = change_sets.id
		AND NOT EXISTS (SELECT 1 FROM change_sets r2 WHERE r2.reverts_change_set_id = r.id))`,
};

/** Change sets, newest first, with what an undo needs to know: entry count, tables touched, undone or not. */
export async function listChangeSets(db: Db, f: ChangeSetFilters = {}) {
	const conds: SQL[] = [];
	if (f.source && (CHANGE_SOURCES as readonly string[]).includes(f.source))
		conds.push(eq(changeSets.source, f.source as ChangeSource));
	if (f.user) conds.push(eq(changeSets.userEmail, f.user));
	if (f.from) conds.push(gte(sql`substr(${changeSets.at}, 1, 10)`, f.from));
	if (f.to) conds.push(lte(sql`substr(${changeSets.at}, 1, 10)`, f.to));
	if (f.q) conds.push(sql`${changeSets.summary} LIKE ${likePattern(f.q)} ESCAPE '\\'`);
	if (f.before) conds.push(lt(changeSets.id, f.before));
	return db
		.select({ ...changeSetSummaryColumns })
		.from(changeSets)
		.where(conds.length ? and(...conds) : undefined)
		.orderBy(desc(changeSets.id))
		.limit(f.limit ?? 50);
}

export type ChangeSetSummary = Awaited<ReturnType<typeof listChangeSets>>[number];

export async function getChangeSetSummary(db: Db, id: number): Promise<ChangeSetSummary | undefined> {
	const rows = await db.select(changeSetSummaryColumns).from(changeSets).where(eq(changeSets.id, id)).limit(1);
	return rows[0];
}

export async function changeSetSummaries(db: Db, ids: number[]): Promise<Map<number, ChangeSetSummary>> {
	const out = new Map<number, ChangeSetSummary>();
	for (const part of chunks([...new Set(ids)])) {
		const rows = await db.select(changeSetSummaryColumns).from(changeSets).where(inArray(changeSets.id, part));
		for (const r of rows) out.set(r.set.id, r);
	}
	return out;
}

/** The tables a change set touched (from ChangeSetSummary.tables). */
export const tablesOf = (s: Pick<ChangeSetSummary, "tables">): string[] => (s.tables ? s.tables.split(",") : []);

/** The column-level actions an undo of this change set needs (from ChangeSetSummary.columnActions). */
export const columnActionsOf = (s: Pick<ChangeSetSummary, "columnActions">): Action[] =>
	s.columnActions.split(",").filter((a): a is Action => a !== "");

/** Emails that made changes, for the user filter. */
export async function changeSetUsers(db: Db): Promise<string[]> {
	const rows = await db
		.selectDistinct({ user: changeSets.userEmail })
		.from(changeSets)
		.orderBy(asc(changeSets.userEmail));
	return rows.map((r) => r.user);
}

/** The objects that have a History tab, and the child rows shown with them. */
export type HistoryTarget = { kind: "part" | "supplier" | "assembly" | "po"; id: number };

const TARGETS: Record<
	HistoryTarget["kind"],
	{ table: string; children: { table: string; column: string; via?: { table: string; column: string } }[] }
> = {
	part: {
		table: "parts",
		children: [
			{ table: "part_suppliers", column: "part_id" },
			{ table: "files", column: "part_id" },
			{ table: "part_options", column: "part_id" },
			// A value names its option: those of the part's current options (D168).
			{ table: "part_option_values", column: "option_id", via: { table: "part_options", column: "part_id" } },
		],
	},
	supplier: { table: "suppliers", children: [{ table: "part_suppliers", column: "supplier_id" }] },
	assembly: {
		table: "assemblies",
		children: [
			{ table: "assembly_lines", column: "assembly_id" },
			{ table: "files", column: "assembly_id" },
		],
	},
	po: {
		table: "purchase_orders",
		children: [
			{ table: "po_lines", column: "po_id" },
			{ table: "po_shipments", column: "po_id" },
		],
	},
};

/** The changes of one object and its lines (or offers), grouped by change set, newest first. */
export async function objectHistory(db: Db, target: HistoryTarget, limit = 500) {
	const def = TARGETS[target.kind];
	const conds: SQL[] = [and(eq(changeLog.tableName, def.table), eq(changeLog.rowId, target.id)) as SQL];
	for (const child of def.children) {
		const path = `$.${child.column}`;
		const value = sql`COALESCE(json_extract(${changeLog.newRow}, ${path}), json_extract(${changeLog.oldRow}, ${path}))`;
		conds.push(
			child.via
				? sql`(${changeLog.tableName} = ${child.table} AND ${value} IN (SELECT id FROM ${sql.identifier(child.via.table)} WHERE ${sql.identifier(child.via.column)} = ${target.id}))`
				: sql`(${changeLog.tableName} = ${child.table} AND ${value} = ${target.id})`,
		);
	}
	const rows = await db
		.select({ entry: changeLog, set: changeSets })
		.from(changeLog)
		.innerJoin(changeSets, eq(changeLog.changeSetId, changeSets.id))
		.where(or(...conds))
		.orderBy(desc(changeLog.changeSetId), asc(changeLog.id))
		.limit(limit);
	const groups: { set: ChangeSet; entries: ChangeLogRow[] }[] = [];
	for (const r of rows) {
		const last = groups[groups.length - 1];
		if (last && last.set.id === r.set.id) last.entries.push(r.entry);
		else groups.push({ set: r.set, entries: [r.entry] });
	}
	return groups;
}

// ---------------------------------------------------------------------------
// Field-level differences

type Snapshot = Record<string, unknown>;

/**
 * Columns never listed as fields: the row id, who/when, the deprecated supplier columns of parts, and the
 * parent of a line or offer (its name already says it, and it never changes).
 */
const HIDDEN_FIELDS: Record<string, readonly string[]> = {
	parts: ["supplier_ref", "moq_milli", "pack_size_milli", "lead_days"],
	assembly_lines: ["assembly_id"],
	po_lines: ["po_id"],
	po_shipments: ["po_id"],
	part_suppliers: ["part_id", "supplier_id"],
	// The owner is in the file's name; the hash and the object key say nothing to a person (size and date do).
	files: ["part_id", "assembly_id", "sha256", "object_key"],
	// Their part, option or build is in their name.
	part_options: ["part_id"],
	part_option_values: ["option_id"],
	build_option_choices: ["build_id", "part_id"],
};

export type FieldChange = { column: string; before: unknown; after: unknown };

export type EntryView = {
	id: number;
	table: string;
	rowId: number;
	op: ChangeOp;
	/** The row as it was after the change (or before it, for a delete): to name it. */
	row: Snapshot;
	/** Changed fields of an update; the filled-in fields of a created or deleted row. */
	fields: FieldChange[];
};

const parseRow = (json: string | null): Snapshot | null => (json === null ? null : (JSON.parse(json) as Snapshot));
const blank = (v: unknown) => v === null || v === undefined || v === "";

/**
 * What changed in one log entry, field by field, with amounts redacted for users who may not see costs
 * (they still see that a price changed, not its value).
 */
export function entryView(access: Access, entry: ChangeLogRow): EntryView {
	const before = redactCosts(access, parseRow(entry.oldRow));
	const after = redactCosts(access, parseRow(entry.newRow));
	const row = after ?? before ?? {};
	const hidden = HIDDEN_FIELDS[entry.tableName] ?? [];
	const shown = (c: string) => c !== "id" && !AUDIT_COLUMNS.includes(c) && !hidden.includes(c);
	const columns = Object.keys(row).filter(shown);
	const rawBefore = parseRow(entry.oldRow) ?? {};
	const rawAfter = parseRow(entry.newRow) ?? {};
	let fields: FieldChange[];
	if (entry.op === "update") {
		// Compared on the real values: a hidden price that changed is still listed (as "Hidden").
		fields = columns
			.filter((c) => rawBefore[c] !== rawAfter[c])
			.map((c) => ({ column: c, before: before?.[c] ?? null, after: after?.[c] ?? null }));
	} else {
		const raw = entry.op === "insert" ? rawAfter : rawBefore;
		fields = columns
			.filter((c) => !blank(raw[c]))
			.map((c) => ({
				column: c,
				before: entry.op === "delete" ? row[c] : null,
				after: entry.op === "insert" ? row[c] : null,
			}));
	}
	return { id: entry.id, table: entry.tableName, rowId: entry.rowId, op: entry.op, row, fields };
}

/** Column → the table its ids point at, for showing names instead of ids. */
export const REFERENCE_COLUMNS: Record<string, string> = {
	part_id: "parts",
	component_part_id: "parts",
	parent_part_id: "parts",
	supplier_id: "suppliers",
	assembly_id: "assemblies",
	po_id: "purchase_orders",
	machine_type_id: "machine_types",
	option_id: "part_options",
	build_id: "builds",
};

/** Columns holding option keys (D169): value ids, or option ids for the options chosen per build. */
export const KEY_COLUMNS: Record<string, "part_option_values" | "part_options"> = {
	option_values: "part_option_values",
	fixed_option_values: "part_option_values",
	chosen_option_ids: "part_options",
};

/** A key as names: "Colour: white · Size: L" (values), or "Colour · Size" (options). */
export function keyLabelOf(labels: Labels, column: string, key: unknown): string {
	const table = KEY_COLUMNS[column];
	if (!table || typeof key !== "string") return "";
	return idsOf(key)
		.map((id) => labelOf(labels, table, id))
		.join(" · ");
}

/** Labels of referenced rows, keyed "table:id" (from referenceLabels). */
export type Labels = Map<string, string>;

/** The label of row `id` of `table`: "#id" when the row is gone, "" without an id. */
export function labelOf(labels: Labels, table: string, id: unknown): string {
	const n = typeof id === "number" ? id : null;
	return n === null ? "" : (labels.get(`${table}:${n}`) ?? `#${n}`);
}

/** What a row is called, from its snapshot: "LAMP-DESK", "BOX-LAMP · Acme", "PO-0003"… */
export function rowName(table: string, row: Snapshot | null, labels: Labels): string {
	if (!row) return "";
	const s = (k: string) => String(row[k] ?? "");
	switch (table) {
		case "parts":
			return s("ref");
		case "suppliers":
			return s("name");
		case "assemblies":
			return `${labelOf(labels, "parts", row.parent_part_id)} ${s("code")} ${s("revision")}`;
		case "assembly_lines":
			return `${labelOf(labels, "parts", row.component_part_id)} (${labelOf(labels, "assemblies", row.assembly_id)})`;
		case "part_suppliers":
			return `${labelOf(labels, "parts", row.part_id)} · ${labelOf(labels, "suppliers", row.supplier_id)}`;
		case "purchase_orders":
		case "builds":
			return s("number");
		case "po_lines":
			return `${labelOf(labels, "parts", row.part_id)} (${labelOf(labels, "purchase_orders", row.po_id)})`;
		case "po_shipments":
			return `${s("carrier")} ${s("tracking_number")} (${labelOf(labels, "purchase_orders", row.po_id)})`;
		case "users":
			return s("email");
		case "settings":
			return s("key");
		case "machine_types":
		case "machines":
			return s("name");
		case "part_options":
			return `${s("name")} (${labelOf(labels, "parts", row.part_id)})`;
		case "part_option_values":
			return `${s("name")} (${labelOf(labels, "part_options", row.option_id)})`;
		case "build_option_choices":
			return `${labelOf(labels, "parts", row.part_id)} (${labelOf(labels, "builds", row.build_id)})`;
		case "files":
			return `${s("name")} (${
				row.part_id !== null && row.part_id !== undefined
					? labelOf(labels, "parts", row.part_id)
					: labelOf(labels, "assemblies", row.assembly_id)
			})`;
		default:
			return `#${s("id")}`;
	}
}

/** Names of the rows the entries point at, keyed "table:id" (current names; "#id" when the row is gone). */
export async function referenceLabels(db: Db, views: EntryView[]): Promise<Map<string, string>> {
	const ids: Record<string, Set<number>> = {
		parts: new Set(),
		suppliers: new Set(),
		assemblies: new Set(),
		purchase_orders: new Set(),
		machine_types: new Set(),
		part_options: new Set(),
		part_option_values: new Set(),
		builds: new Set(),
	};
	for (const v of views) {
		for (const [col, table] of Object.entries(REFERENCE_COLUMNS)) {
			const id = v.row[col];
			if (typeof id === "number") ids[table]?.add(id);
		}
		for (const f of v.fields) {
			const table = REFERENCE_COLUMNS[f.column];
			for (const id of [f.before, f.after]) if (table && typeof id === "number") ids[table]?.add(id);
			const keyTable = KEY_COLUMNS[f.column];
			for (const key of [f.before, f.after])
				if (keyTable && typeof key === "string") for (const id of idsOf(key)) ids[keyTable]?.add(id);
		}
		if (v.table in ids) ids[v.table]?.add(v.rowId);
	}
	const labels = new Map<string, string>();
	const queries: Record<string, (part: number[]) => Promise<{ id: number; label: string }[]>> = {
		parts: (part) => db.select({ id: parts.id, label: parts.ref }).from(parts).where(inArray(parts.id, part)),
		suppliers: (part) =>
			db.select({ id: suppliers.id, label: suppliers.name }).from(suppliers).where(inArray(suppliers.id, part)),
		assemblies: (part) =>
			db
				.select({
					id: assemblies.id,
					label: sql<string>`${parts.ref} || ' ' || ${assemblies.code} || ' ' || ${assemblies.revision}`,
				})
				.from(assemblies)
				.innerJoin(parts, eq(assemblies.parentPartId, parts.id))
				.where(inArray(assemblies.id, part)),
		purchase_orders: (part) =>
			db
				.select({ id: purchaseOrders.id, label: purchaseOrders.number })
				.from(purchaseOrders)
				.where(inArray(purchaseOrders.id, part)),
		machine_types: (part) =>
			db
				.select({ id: machineTypes.id, label: machineTypes.name })
				.from(machineTypes)
				.where(inArray(machineTypes.id, part)),
		part_options: (part) =>
			db.select({ id: partOptions.id, label: partOptions.name }).from(partOptions).where(inArray(partOptions.id, part)),
		part_option_values: (part) =>
			db
				.select({
					id: partOptionValues.id,
					label: sql<string>`${partOptions.name} || ': ' || ${partOptionValues.name}`,
				})
				.from(partOptionValues)
				.innerJoin(partOptions, eq(partOptionValues.optionId, partOptions.id))
				.where(inArray(partOptionValues.id, part)),
		builds: (part) => db.select({ id: builds.id, label: builds.number }).from(builds).where(inArray(builds.id, part)),
	};
	for (const [table, query] of Object.entries(queries)) {
		for (const part of chunks([...(ids[table] ?? [])])) {
			for (const r of await query(part)) labels.set(`${table}:${r.id}`, r.label);
		}
	}
	return labels;
}
