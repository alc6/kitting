// list_recent_changes (catalog:read, D129): the Recent changes page for an assistant, with each change's field
// diffs. Amounts are redacted by entryView() first, as on the page, then formatted here: snapshot columns are
// snake_case (`cost_cents`), which toWire() does not convert, so this tool turns them into decimals itself and
// leaves out the values of amounts the user may not see.
import { asc, getTableColumns, getTableName, inArray } from "drizzle-orm";
import { z } from "zod";
import { CHANGE_SOURCES, type ChangeLogRow, changeLog, HISTORY_TABLES } from "../db/schema";
import {
	type EntryView,
	entryView,
	KEY_COLUMNS,
	keyLabelOf,
	labelOf,
	listChangeSets,
	REFERENCE_COLUMNS,
	referenceLabels,
	rowName,
} from "../domain/history";
import { chunks } from "../lib/sql";
import { formatCentsInput, formatQtyInput } from "../lib/units";
import { date, limit, type ToolSpec, tool } from "./kit";

/** Entries shown per change set (an import can touch hundreds of rows: its page has them all). */
const MAX_ENTRIES = 50;

/** Columns stored as 0/1 for a boolean, as "table.column". */
const BOOLEAN_COLUMNS = new Set(
	HISTORY_TABLES.flatMap((t) =>
		Object.values(getTableColumns(t))
			.filter((c) => c.dataType === "boolean")
			.map((c) => `${getTableName(t)}.${c.name}`),
	),
);

type Labels = Awaited<ReturnType<typeof referenceLabels>>;

/** One field of an entry as the model reads it: decimal strings, names instead of ids, no hidden amount. */
function wireField(
	table: string,
	f: { column: string; before: unknown; after: unknown },
	labels: Labels,
	seeCosts: boolean,
) {
	const money = f.column.endsWith("_cents");
	const qty = f.column.endsWith("_milli");
	const ref = REFERENCE_COLUMNS[f.column];
	const name = money
		? f.column.slice(0, -"_cents".length)
		: qty
			? f.column.slice(0, -"_milli".length)
			: ref
				? f.column.replace(/_id$/, "")
				: f.column;
	if (money && !seeCosts) return { field: name, hidden: true };
	const value = (v: unknown) => {
		if (v === null || v === undefined) return null;
		if (money && typeof v === "number") return formatCentsInput(v);
		if (qty && typeof v === "number") return formatQtyInput(v);
		if (ref) return labelOf(labels, ref, v);
		if (KEY_COLUMNS[f.column]) return keyLabelOf(labels, f.column, v);
		if (BOOLEAN_COLUMNS.has(`${table}.${f.column}`)) return v === 1 || v === true;
		return v;
	};
	return { field: name, before: value(f.before), after: value(f.after) };
}

function wireEntry(e: EntryView, labels: Labels, seeCosts: boolean) {
	return {
		table: e.table,
		op: e.op,
		record: rowName(e.table, e.row, labels),
		fields: e.fields.map((f) => wireField(e.table, f, labels, seeCosts)),
	};
}

const listRecentChanges = tool({
	name: "list_recent_changes",
	title: "Recent changes",
	description:
		"The change history, newest first, as on the Recent changes page: who changed what, when, from where (ui: a page, import, mcp: an assistant with its name, revert: an undo, migration), and each row touched with its fields before and after. Says whether a change can still be undone and gives its page in the app, where the user can undo it (you cannot). Use before to page through older changes.",
	rule: { scope: "catalog:read" },
	input: z.object({
		source: z.enum(CHANGE_SOURCES).optional(),
		user: z.string().trim().max(200).optional().describe("Only the changes of this email."),
		query: z.string().trim().max(100).optional().describe("Text to look for in the summaries."),
		from: date.optional(),
		to: date.optional(),
		before: z.number().int().positive().optional().describe("Only changes older than this change id (next page)."),
		include_fields: z.boolean().default(true).describe("Include each change's rows and fields."),
		limit: limit(20, 100),
	}),
	run: async (a, { db, access, origin }) => {
		const sets = await listChangeSets(db, {
			source: a.source ?? "",
			user: a.user?.toLowerCase() ?? "",
			q: a.query ?? "",
			from: a.from ?? null,
			to: a.to ?? null,
			before: a.before ?? null,
			limit: a.limit,
		});
		const entries = new Map<number, ChangeLogRow[]>();
		if (a.include_fields) {
			for (const ids of chunks(sets.map((s) => s.set.id))) {
				const rows = await db
					.select()
					.from(changeLog)
					.where(inArray(changeLog.changeSetId, ids))
					.orderBy(asc(changeLog.id));
				for (const r of rows) {
					const list = entries.get(r.changeSetId) ?? [];
					if (list.length < MAX_ENTRIES) list.push(r);
					entries.set(r.changeSetId, list);
				}
			}
		}
		const views = new Map([...entries].map(([id, list]) => [id, list.map((e) => entryView(access, e))]));
		const labels = await referenceLabels(db, [...views.values()].flat());
		const last = sets.at(-1);
		return {
			count: sets.length,
			nextBefore: sets.length === a.limit && last ? last.set.id : undefined,
			changes: sets.map((s) => {
				const historyPath = `/history/${s.set.id}`;
				return {
					id: s.set.id,
					at: s.set.at,
					user: s.set.userEmail,
					source: s.set.source,
					client: s.set.clientName ?? undefined,
					summary: s.set.summary,
					revertible: s.set.revertible,
					undoneBy: s.undoneBy ?? undefined,
					undoes: s.set.revertsChangeSetId ?? undefined,
					historyPath,
					historyUrl: `${origin}${historyPath}`,
					rowsTouched: s.entries,
					changes: a.include_fields
						? (views.get(s.set.id) ?? []).map((v) => wireEntry(v, labels, access.seeCosts))
						: undefined,
				};
			}),
		};
	},
});

export const HISTORY_TOOLS: readonly ToolSpec[] = [listRecentChanges];
