// Change history views (D114): the History tab of parts, suppliers, assemblies and POs, the Recent changes page
// and a change set's details. Amounts in row snapshots are redacted by entryView() and shown through Money.
import { getTableColumns, getTableName } from "drizzle-orm";
import { type ChangeSet, HISTORY_TABLES } from "../db/schema";
import {
	type ChangeSetSummary,
	type EntryView,
	KEY_COLUMNS,
	keyLabelOf,
	type Labels,
	labelOf,
	REFERENCE_COLUMNS,
	rowName,
} from "../domain/history";
import { can } from "../domain/permissions";
import type { ChangedBy, RevertConflict } from "../domain/revert";
import { fmt } from "../i18n";
import { formatMinutes, formatQty, MILLI } from "../lib/units";
import { type AppView, useApp } from "./context";
import { formatBytes } from "./files";
import { icons } from "./icons";
import { Alert, Badge, CardEmpty, LinkTabs, Money, PostButton, shortDateTime, TableCard } from "./ui";

/** Columns stored as 0/1 for a boolean (Drizzle boolean mode), across the tracked tables. */
const BOOLEAN_COLUMNS = new Set(
	HISTORY_TABLES.flatMap((t) =>
		Object.values(getTableColumns(t))
			.filter((c) => c.dataType === "boolean")
			.map((c) => `${getTableName(t)}.${c.name}`),
	),
);

export type { Labels };

type Row = Record<string, unknown>;

const num = (v: unknown) => (typeof v === "number" ? v : null);

/** "Overview | History" tabs of a record page. */
export function RecordTabs(props: { base: string; active: "overview" | "history" }) {
	const { t } = useApp();
	return (
		<LinkTabs
			items={[
				{ href: props.base, label: t.history.tabOverview, active: props.active === "overview", icon: icons.info },
				{
					href: `${props.base}/history`,
					label: t.history.tab,
					active: props.active === "history",
					icon: icons.history,
				},
			]}
		/>
	);
}

function tableLabel(view: Pick<AppView, "t">, table: string): string {
	return (view.t.history.tables as Record<string, string>)[table] ?? table;
}

/** "Part BOX-LAMP", for messages. */
export function recordName(view: Pick<AppView, "t">, table: string, row: Row | null, labels: Labels): string {
	return `${tableLabel(view, table)} ${rowName(table, row, labels)}`.trim();
}

/** Page of the record a row belongs to, if it has one. */
function recordHref(table: string, rowId: number, row: Row): string | null {
	switch (table) {
		case "parts":
			return `/parts/${rowId}`;
		case "suppliers":
			return `/suppliers/${rowId}`;
		case "assemblies":
			return `/assemblies/${rowId}`;
		case "assembly_lines":
			return num(row.assembly_id) ? `/assemblies/${row.assembly_id}` : null;
		case "part_suppliers":
			return num(row.part_id) ? `/parts/${row.part_id}` : null;
		case "purchase_orders":
			return `/purchasing/po/${rowId}`;
		case "po_lines":
		case "po_shipments":
			return num(row.po_id) ? `/purchasing/po/${row.po_id}` : null;
		case "builds":
			return `/builds/${rowId}`;
		case "machine_types":
			return `/machines/types/${rowId}`;
		case "machines":
			return `/machines/${rowId}`;
		case "storage_units":
			return `/locations/${rowId}`;
		case "part_locations":
			return num(row.part_id) ? `/parts/${row.part_id}` : null;
		case "files":
			return num(row.part_id)
				? `/parts/${row.part_id}#files`
				: num(row.assembly_id)
					? `/assemblies/${row.assembly_id}#files`
					: null;
		default:
			return null;
	}
}

/** One field value as people read it: amounts through Money, quantities, names instead of ids, labels. */
function FieldValue(props: { table: string; column: string; value: unknown; labels: Labels }) {
	const view = useApp();
	const { t, locale } = view;
	const { table, column, value } = props;
	if (column.endsWith("_cents")) return <Money cents={num(value)} />;
	if (value === null || value === undefined || value === "")
		return <span class="text-muted-foreground">{t.common.none}</span>;
	if (column.endsWith("_milli") && typeof value === "number")
		return <span class="num">{formatQty(value, locale)}</span>;
	if (column === "machine_minutes" && typeof value === "number")
		return <span class="num">{formatMinutes(value * MILLI)}</span>;
	if (BOOLEAN_COLUMNS.has(`${table}.${column}`)) return <span>{value ? t.common.yes : t.common.no}</span>;
	const ref = REFERENCE_COLUMNS[column];
	if (ref) return <span>{labelOf(props.labels, ref, value)}</span>;
	if (KEY_COLUMNS[column]) return <span>{keyLabelOf(props.labels, column, value)}</span>;
	const text = String(value);
	if (table === "files") {
		if (column === "kind") return <span>{(t.files.kinds as Record<string, string>)[text] ?? text}</span>;
		if (column === "format") return <span>{(t.files.formats as Record<string, string>)[text] ?? text}</span>;
		if (column === "size_bytes" && typeof value === "number")
			return <span class="num">{formatBytes(value, view)}</span>;
	}
	if (table === "storage_units") {
		if (column === "kind") return <span>{(t.locations.kinds as Record<string, string>)[text] ?? text}</span>;
		if (column === "front") return <span>{(t.locations.fronts as Record<string, string>)[text] ?? text}</span>;
	}
	if (column === "kind") return <span>{(t.kinds as Record<string, string>)[text] ?? text}</span>;
	if (column === "role") return <span>{(t.roles.names as Record<string, string>)[text] ?? text}</span>;
	if (column === "status") {
		const statuses: Record<string, Record<string, string>> = {
			assemblies: t.assemblies.statuses,
			purchase_orders: t.purchasing.statuses,
			builds: t.builds.statuses,
			machines: t.machines.statuses,
		};
		return <span>{statuses[table]?.[text] ?? text}</span>;
	}
	if (column === "charges_spread")
		return <span>{(t.purchasing.charges.spreads as Record<string, string>)[text] ?? text}</span>;
	if (column.endsWith("_at")) return <span class="tabular-nums">{shortDateTime(text)}</span>;
	return <span class="break-words">{text}</span>;
}

function fieldLabel(view: Pick<AppView, "t">, table: string, column: string): string {
	// A unit's code is its bin prefix, not an assembly variant.
	if (table === "storage_units" && column === "code") return view.t.locations.code.toLowerCase();
	return (view.t.history.fields as Record<string, string>)[column] ?? column;
}

/** One row change: what happened to which record, and its fields ("quantity: 3 → 4"). */
function EntryItem(props: { entry: EntryView; labels: Labels }) {
	const view = useApp();
	const { t } = view;
	const e = props.entry;
	const href = e.op === "delete" ? null : recordHref(e.table, e.rowId, e.row);
	const name = rowName(e.table, e.row, props.labels);
	return (
		<li class="flex flex-col gap-1 py-2">
			<div class="flex flex-wrap items-center gap-2">
				<Badge variant={e.op === "insert" ? "success" : e.op === "delete" ? "destructive" : "info"}>
					{t.history.ops[e.op]}
				</Badge>
				<span class="text-muted-foreground">{tableLabel(view, e.table)}</span>
				{href ? (
					<a href={href} class="font-medium">
						{name}
					</a>
				) : (
					<span class="font-medium">{name}</span>
				)}
			</div>
			{e.fields.length === 0 ? (
				<p class="m-0 text-sm text-muted-foreground">{t.history.noVisibleChange}</p>
			) : (
				<ul class="m-0 flex list-none flex-col gap-0.5 p-0 text-sm">
					{e.fields.map((f) => (
						<li class="flex flex-wrap items-baseline gap-x-1.5">
							<span class="text-muted-foreground">{fieldLabel(view, e.table, f.column)}:</span>
							{e.op === "update" ? (
								<>
									<FieldValue table={e.table} column={f.column} value={f.before} labels={props.labels} />
									<span class="text-muted-foreground" aria-hidden="true">
										→
									</span>
									<FieldValue table={e.table} column={f.column} value={f.after} labels={props.labels} />
								</>
							) : (
								<FieldValue
									table={e.table}
									column={f.column}
									value={e.op === "insert" ? f.after : f.before}
									labels={props.labels}
								/>
							)}
						</li>
					))}
				</ul>
			)}
		</li>
	);
}

export function EntryList(props: { entries: EntryView[]; labels: Labels }) {
	return (
		<ul class="m-0 flex list-none flex-col divide-y p-0">
			{props.entries.map((e) => (
				<EntryItem entry={e} labels={props.labels} />
			))}
		</ul>
	);
}

/** Where a change came from: page, import, assistant (with its client name), undo, migration. */
export function SourceBadge(props: { set: Pick<ChangeSet, "source" | "clientName"> }) {
	const { t } = useApp();
	return (
		<span class="inline-flex flex-wrap items-center gap-1">
			<Badge variant={props.set.source === "revert" ? "warning" : props.set.source === "ui" ? "secondary" : "info"}>
				{t.history.sources[props.set.source]}
			</Badge>
			{props.set.clientName ? (
				<span class="text-xs text-muted-foreground">{fmt(t.history.client, { client: props.set.clientName })}</span>
			) : null}
		</span>
	);
}

/** Undone, an undo, or not revertible. */
export function StateBadges(props: { summary: ChangeSetSummary }) {
	const { t } = useApp();
	const { set, undoneBy } = props.summary;
	return (
		<span class="inline-flex flex-wrap items-center gap-1">
			{undoneBy ? (
				<a href={`/history/${undoneBy}`}>
					<Badge variant="muted">{fmt(t.history.undoneBy, { id: undoneBy })}</Badge>
				</a>
			) : null}
			{set.revertsChangeSetId ? (
				<a href={`/history/${set.revertsChangeSetId}`}>
					<Badge variant="outline">{fmt(t.history.undoOf, { id: set.revertsChangeSetId })}</Badge>
				</a>
			) : null}
			{!set.revertible ? (
				<Badge variant="muted" title={t.history.notRevertibleHint}>
					{t.history.notRevertible}
				</Badge>
			) : null}
		</span>
	);
}

/** The Undo button, for those who may undo this change set (see canUndo). */
export function UndoButton(props: { id: number }) {
	const { t } = useApp();
	return (
		<PostButton
			action={`/history/${props.id}/revert`}
			label={t.history.undo}
			confirm={t.history.confirmUndo}
			icon={icons.undo}
			size="sm"
		/>
	);
}

function conflictText(view: Pick<AppView, "t">, c: RevertConflict, labels: Labels): string {
	const m = view.t.history.conflicts;
	const row = recordName(view, c.table, c.row, labels);
	const other = c.other ? tableLabel(view, c.other) : "";
	const by = (b: ChangedBy) => ({ row, user: b.user, at: shortDateTime(b.at), id: b.changeSetId, summary: b.summary });
	if (c.reason === "changed") return c.by ? fmt(m.changedBy, by(c.by)) : fmt(m.changed, { row });
	if (c.reason === "missing") return c.by ? fmt(m.missingBy, by(c.by)) : fmt(m.missing, { row });
	return fmt(m[c.reason], { row, other });
}

/** Why an undo was refused (nothing was changed). */
export function ConflictAlert(props: { conflicts: RevertConflict[]; labels: Labels }) {
	const view = useApp();
	return (
		<Alert variant="destructive" title={view.t.history.conflictTitle}>
			<ul class="m-0 list-disc pl-5">
				{props.conflicts.map((c) => (
					<li>{conflictText(view, c, props.labels)}</li>
				))}
			</ul>
			<p class="m-0">{view.t.history.conflictHint}</p>
		</Alert>
	);
}

/** Who, when, from where: one line under a change's summary. */
export function ChangeMeta(props: { set: ChangeSet }) {
	return (
		<span class="inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
			<span class="tabular-nums">{shortDateTime(props.set.at)}</span>
			<span>{props.set.userEmail}</span>
			<SourceBadge set={props.set} />
		</span>
	);
}

/** A record's History tab: its change sets, newest first, with the rows of this record they touched. */
export function HistoryTimeline(props: {
	groups: { summary: ChangeSetSummary; entries: EntryView[]; undoable: boolean }[];
	labels: Labels;
}) {
	const { t } = useApp();
	return (
		<TableCard title={t.history.tab}>
			{props.groups.length === 0 ? (
				<CardEmpty icon={icons.history}>{t.history.empty}</CardEmpty>
			) : (
				<ol class="m-0 flex list-none flex-col divide-y p-0">
					{props.groups.map((g) => (
						<li class="flex flex-col gap-2 px-4 py-3">
							<div class="flex flex-wrap items-start justify-between gap-2">
								<div class="flex min-w-0 flex-col gap-1">
									<a href={`/history/${g.summary.set.id}`} class="font-medium">
										#{g.summary.set.id} · {g.summary.set.summary}
									</a>
									<span class="inline-flex flex-wrap items-center gap-2">
										<ChangeMeta set={g.summary.set} />
										<StateBadges summary={g.summary} />
									</span>
								</div>
								{g.undoable ? <UndoButton id={g.summary.set.id} /> : null}
							</div>
							<EntryList entries={g.entries} labels={props.labels} />
						</li>
					))}
				</ol>
			)}
		</TableCard>
	);
}

/** Whether this user may press Undo on this change set (the undo still checks the data). */
export function canPressUndo(view: Pick<AppView, "role" | "seeCosts">, summary: ChangeSetSummary, missing: number) {
	const s = summary;
	return can(view, "history.revert") && s.set.revertible && s.entries > 0 && !s.undoneBy && missing === 0;
}
