// Change history pages (D114): Recent changes (/history), a change set's details, Undo, and the History tab
// that parts, suppliers, assemblies and POs mount with recordHistoryPage().
import type { Context } from "hono";
import { Hono } from "hono";
import type { Child } from "hono/jsx";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { CHANGE_SOURCES, type ChangeLogRow, type ChangeSet } from "../db/schema";
import {
	type ChangeSetSummary,
	changeSetSummaries,
	changeSetUsers,
	columnActionsOf,
	entryView,
	getChangeSetSummary,
	type HistoryTarget,
	listChangeSets,
	objectHistory,
	referenceLabels,
	tablesOf,
} from "../domain/history";
import type { Access } from "../domain/permissions";
import {
	changeSetEntries,
	missingActions,
	type RevertConflict,
	revertChangeSet,
	TABLE_ACTIONS,
} from "../domain/revert";
import { fmt } from "../i18n";
import { forbidden, requirePermission } from "../middleware/roles";
import type { AppEnv } from "../types";
import { useApp } from "../views/context";
import {
	ConflictAlert,
	canPressUndo,
	EntryList,
	HistoryTimeline,
	type Labels,
	SourceBadge,
	StateBadges,
	UndoButton,
} from "../views/history";
import { icons } from "../views/icons";
import { idParam, notFound, nowIso, page, redirectOk } from "../views/render";
import {
	Alert,
	Button,
	Card,
	CardContent,
	CardDescription,
	CardEmpty,
	CardHeader,
	CardTitle,
	DetailList,
	Flash,
	PageHeader,
	SearchBar,
	shortDateTime,
	Table,
	TableBody,
	TableCard,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "../views/ui";

export const historyRoutes = new Hono<AppEnv>();

const PAGE_SIZE = 50;

const accessOf = (c: Context<AppEnv>): Access => ({ role: c.var.role, seeCosts: c.var.seeCosts });

function undoable(c: Context<AppEnv>, s: ChangeSetSummary): boolean {
	return canPressUndo(c.var, s, missingActions(accessOf(c), tablesOf(s), columnActionsOf(s)).length);
}

const dateParam = (v: string | undefined) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

// ---------------------------------------------------------------------------
// Recent changes

function ChangeSetTable(props: { rows: { summary: ChangeSetSummary; undoable: boolean }[] }) {
	const { t } = useApp();
	return (
		<Table>
			<TableHeader class="bg-muted/50">
				<TableRow>
					<TableHead>#</TableHead>
					<TableHead>{t.history.at}</TableHead>
					<TableHead>{t.history.by}</TableHead>
					<TableHead>{t.history.source}</TableHead>
					<TableHead>{t.history.summary}</TableHead>
					<TableHead class="text-right">{t.history.entries}</TableHead>
					<TableHead>
						<span class="sr-only">{t.common.actions}</span>
					</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{props.rows.map(({ summary: s, undoable }) => (
					<TableRow>
						<TableCell class="text-muted-foreground tabular-nums">
							<a href={`/history/${s.set.id}`}>{s.set.id}</a>
						</TableCell>
						<TableCell class="whitespace-nowrap text-muted-foreground tabular-nums">
							{shortDateTime(s.set.at)}
						</TableCell>
						<TableCell class="text-muted-foreground">{s.set.userEmail}</TableCell>
						<TableCell>
							<SourceBadge set={s.set} />
						</TableCell>
						<TableCell class="min-w-56">
							<span class="flex flex-col gap-1">
								<a href={`/history/${s.set.id}`} class="font-medium">
									{s.set.summary}
								</a>
								<StateBadges summary={s} />
							</span>
						</TableCell>
						<TableCell class="text-right tabular-nums">{s.entries}</TableCell>
						<TableCell class="text-right">{undoable ? <UndoButton id={s.set.id} /> : null}</TableCell>
					</TableRow>
				))}
			</TableBody>
		</Table>
	);
}

historyRoutes.get("/", async (c) => {
	const t = c.var.t;
	const q = c.req.query("q") ?? "";
	const source = c.req.query("source") ?? "";
	const user = c.req.query("user") ?? "";
	const from = dateParam(c.req.query("from"));
	const to = dateParam(c.req.query("to"));
	const beforeRaw = c.req.query("before");
	const before = beforeRaw && /^\d+$/.test(beforeRaw) ? Number(beforeRaw) : null;
	const [list, users] = await Promise.all([
		listChangeSets(c.var.db, { q, source, user, from, to, before, limit: PAGE_SIZE }),
		changeSetUsers(c.var.db),
	]);
	const filtered = Boolean(q || source || user || from || to);
	const query = (extra: Record<string, string>) =>
		new URLSearchParams({ q, source, user, from: from ?? "", to: to ?? "", ...extra }).toString();
	const last = list[list.length - 1];
	return page(
		c,
		t.history.title,
		<>
			<PageHeader title={t.history.title} subtitle={t.history.intro} />
			<Flash message={c.req.query("ok") === "undone" ? t.history.undone : undefined} />
			<SearchBar action="/history" q={q}>
				<select name="source" aria-label={t.history.source}>
					<option value="">{t.history.allSources}</option>
					{CHANGE_SOURCES.map((s) => (
						<option value={s} selected={s === source}>
							{t.history.sources[s]}
						</option>
					))}
				</select>
				<select name="user" aria-label={t.history.by}>
					<option value="">{t.history.allUsers}</option>
					{users.map((u) => (
						<option value={u} selected={u === user}>
							{u}
						</option>
					))}
				</select>
				<label class="inline-flex items-center gap-2 text-sm font-medium">
					<span class="text-muted-foreground">{t.history.from}</span>
					<input type="date" name="from" value={from ?? ""} class="w-auto" />
				</label>
				<label class="inline-flex items-center gap-2 text-sm font-medium">
					<span class="text-muted-foreground">{t.history.to}</span>
					<input type="date" name="to" value={to ?? ""} class="w-auto" />
				</label>
			</SearchBar>
			<div id="results" class="flex flex-col gap-3">
				<TableCard title={fmt(t.common.results, { n: list.length })}>
					{list.length === 0 ? (
						<CardEmpty icon={icons.history}>{filtered ? t.history.emptyFiltered : t.history.empty}</CardEmpty>
					) : (
						<ChangeSetTable rows={list.map((s) => ({ summary: s, undoable: undoable(c, s) }))} />
					)}
				</TableCard>
				<div class="flex flex-wrap gap-2">
					{before ? (
						<Button href={`/history?${query({})}`} variant="outline" icon={icons.arrowUp}>
							{t.history.newest}
						</Button>
					) : null}
					{list.length === PAGE_SIZE && last ? (
						<Button
							href={`/history?${query({ before: String(last.set.id) })}`}
							variant="outline"
							icon={icons.arrowDown}
						>
							{t.history.older}
						</Button>
					) : null}
				</div>
			</div>
		</>,
	);
});

// ---------------------------------------------------------------------------
// One change set

async function renderChangeSet(
	c: Context<AppEnv>,
	summary: ChangeSetSummary,
	entries: ChangeLogRow[],
	problem?: { conflicts?: RevertConflict[]; notRevertible?: boolean },
	status: ContentfulStatusCode = 200,
) {
	const t = c.var.t;
	const access = accessOf(c);
	const views = entries.map((e) => entryView(access, e));
	const labels = await referenceLabels(c.var.db, [...views, ...conflictViews(problem?.conflicts)]);
	const set = summary.set;
	const missing = missingActions(access, tablesOf(summary), columnActionsOf(summary));
	return page(
		c,
		fmt(t.history.change, { id: set.id }),
		<>
			<PageHeader
				title={fmt(t.history.change, { id: set.id })}
				subtitle={set.summary}
				actions={undoable(c, summary) ? <UndoButton id={set.id} /> : null}
			/>
			<Flash message={c.req.query("ok") === "undone" ? t.history.undone : undefined} />
			{problem?.conflicts ? <ConflictAlert conflicts={problem.conflicts} labels={labels} /> : null}
			{problem?.notRevertible ? <Alert variant="destructive">{t.history.notRevertibleHint}</Alert> : null}
			<div class="flex flex-col gap-4">
				<Card>
					<CardContent>
						<DetailList
							items={[
								{ label: t.history.at, value: <span class="tabular-nums">{shortDateTime(set.at)}</span> },
								{ label: t.history.by, value: set.userEmail },
								{ label: t.history.source, value: <SourceBadge set={set} /> },
								{ label: t.history.entries, value: <span class="tabular-nums">{summary.entries}</span> },
								...(summary.undoneBy || set.revertsChangeSetId || !set.revertible
									? [{ label: t.history.state, value: <StateBadges summary={summary} /> }]
									: []),
							]}
						/>
						{set.revertible && !summary.undoneBy && missing.length > 0 && summary.entries > 0 ? (
							<p class="mt-4 mb-0 text-sm text-muted-foreground">
								{fmt(t.history.noRights, { areas: missingAreas(c, summary) })}
							</p>
						) : null}
					</CardContent>
				</Card>
				<Card>
					<CardHeader>
						<CardTitle tag="h2">{t.history.details}</CardTitle>
						<CardDescription>{t.history.allRows}</CardDescription>
					</CardHeader>
					<CardContent>
						{views.length === 0 ? (
							<p class="m-0 text-sm text-muted-foreground">{t.history.noVisibleChange}</p>
						) : (
							<EntryList entries={views} labels={labels} />
						)}
					</CardContent>
				</Card>
			</div>
		</>,
		status,
	);
}

/** Conflicts name rows by their snapshots: make their references resolvable too. */
function conflictViews(conflicts: RevertConflict[] | undefined) {
	return (conflicts ?? []).map((c) => ({
		id: 0,
		table: c.table,
		rowId: c.rowId,
		op: "update" as const,
		row: c.row ?? {},
		fields: [],
	}));
}

/** Names of the record kinds a user may not edit, for "Undoing it needs rights you do not have". */
function missingAreas(c: Context<AppEnv>, summary: ChangeSetSummary): string {
	const tables = tablesOf(summary);
	const gated = columnActionsOf(summary);
	const lacking = missingActions(accessOf(c), tables, gated);
	const names = tables
		.filter((t) => {
			const action = TABLE_ACTIONS[t];
			return action ? lacking.includes(action) : false;
		})
		.map((t) => (c.var.t.history.tables as Record<string, string>)[t] ?? t);
	const rights = c.var.t.history.rights as Record<string, string>;
	names.push(...gated.filter((a) => lacking.includes(a)).map((a) => rights[a] ?? a));
	return [...new Set(names)].join(", ");
}

historyRoutes.get("/:id", async (c) => {
	const id = idParam(c);
	const summary = id ? await getChangeSetSummary(c.var.db, id) : undefined;
	if (!summary) return notFound(c);
	return renderChangeSet(c, summary, await changeSetEntries(c.var.db, summary.set.id));
});

historyRoutes.post("/:id/revert", requirePermission("history.revert"), async (c) => {
	const t = c.var.t;
	const id = idParam(c);
	if (!id) return notFound(c);
	const outcome = await revertChangeSet(c.var.db, accessOf(c), id, {
		user: c.var.user,
		summary: (set: ChangeSet) => fmt(t.history.summaries.revert, { id: set.id, summary: set.summary }),
		now: nowIso(),
	});
	if (outcome.ok) return redirectOk(c, `/history/${outcome.id ?? id}`, "undone");
	if (outcome.reason === "not_found") return notFound(c);
	const summary = await getChangeSetSummary(c.var.db, id);
	if (!summary) return notFound(c);
	if (outcome.reason === "forbidden") return forbidden(c, fmt(t.history.noRights, { areas: missingAreas(c, summary) }));
	const entries = await changeSetEntries(c.var.db, id);
	if (outcome.reason === "conflict") return renderChangeSet(c, summary, entries, { conflicts: outcome.conflicts }, 409);
	return renderChangeSet(c, summary, entries, { notRevertible: true }, 409);
});

// ---------------------------------------------------------------------------
// The History tab of a record

/**
 * Renders the History tab of a part, supplier, assembly or PO: `header` is the record's page header and tabs.
 * Only the rows of this record (and of its lines or offers) are listed; the change set page has them all.
 */
export async function recordHistoryPage(c: Context<AppEnv>, title: string, header: Child, target: HistoryTarget) {
	const t = c.var.t;
	const access = accessOf(c);
	const groups = await objectHistory(c.var.db, target);
	const summaries = await changeSetSummaries(
		c.var.db,
		groups.map((g) => g.set.id),
	);
	const shown = groups.flatMap((g) => {
		const summary = summaries.get(g.set.id);
		return summary ? [{ summary, entries: g.entries.map((e) => entryView(access, e)) }] : [];
	});
	const labels: Labels = await referenceLabels(
		c.var.db,
		shown.flatMap((g) => g.entries),
	);
	return page(
		c,
		`${title} · ${t.history.tab}`,
		<>
			{header}
			<p class="-mt-3 mb-4 text-sm text-muted-foreground">{t.history.objectIntro}</p>
			<HistoryTimeline groups={shown.map((g) => ({ ...g, undoable: undoable(c, g.summary) }))} labels={labels} />
		</>,
	);
}
