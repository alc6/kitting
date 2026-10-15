import type { Context } from "hono";
import { Hono } from "hono";
import { exportBackup, planRestore, type RestorePlan, restoreStatements } from "../domain/backup";
import { runChangeSet } from "../domain/history";
import {
	headerOf,
	IMPORTERS,
	type Importer,
	type ImportPlan,
	type ImportType,
	importerFor,
	planImport,
	type RowIssue,
} from "../domain/import";
import { can, redactCsv } from "../domain/permissions";
import { errorText, fmt } from "../i18n";
import { cn } from "../lib/cn";
import { toCsv } from "../lib/csv";
import { decodeText } from "../lib/encoding";
import { requirePermission } from "../middleware/roles";
import type { AppEnv } from "../types";
import { useApp } from "../views/context";
import { Icon, type IconNode, icons } from "../views/icons";
import { notFound, nowIso, page } from "../views/render";
import {
	Alert,
	Badge,
	type BadgeVariant,
	Button,
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
	Dialog,
	DialogFooter,
	FieldGroup,
	FieldLabel,
	Flash,
	PageHeader,
	StatCard,
	Table,
	TableBody,
	TableCard,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "../views/ui";

export const importRoutes = new Hono<AppEnv>();
// Import / Export is for planners; confirming, backups and restores need more (route by route).
importRoutes.use("*", requirePermission("import.preview"));

const MAX_CSV_BYTES = 2 * 1024 * 1024;
const MAX_JSON_BYTES = 50 * 1024 * 1024;

/** Locale-appropriate CSV dialect: French spreadsheets expect ";" and decimal commas. */
export function csvDelimiter(c: Context<AppEnv>): string {
	return c.var.locale === "fr" ? ";" : ",";
}

/** Every CSV download goes through here: money columns are dropped for users who may not see costs. */
export function csvResponse(c: Context<AppEnv>, filename: string, rows: (string | number | null)[][]) {
	c.header("Content-Type", "text/csv; charset=utf-8");
	c.header("Content-Disposition", `attachment; filename="${filename}"`);
	return c.body(toCsv(redactCsv(c.var, rows), csvDelimiter(c)));
}

async function readCsvInput(c: Context<AppEnv>): Promise<string> {
	const body = await c.req.parseBody();
	const file = body.file;
	if (file instanceof File && file.size > 0) {
		if (file.size > MAX_CSV_BYTES) return "";
		return decodeText(new Uint8Array(await file.arrayBuffer()));
	}
	const text = typeof body.csv === "string" ? body.csv : "";
	return text.length > MAX_CSV_BYTES ? "" : text;
}

// ---------------------------------------------------------------------------
// Local building blocks

const TYPE_ICONS: Record<ImportType, IconNode> = {
	suppliers: icons.factory,
	parts: icons.package,
	part_suppliers: icons.truck,
	price_history: icons.history,
	machine_types: icons.cog,
	machines: icons.cog,
	assemblies: icons.listTree,
	stock: icons.warehouse,
};

type PlanAction = ImportPlan["rows"][number]["action"];

const ACTION_BADGES: Record<PlanAction, BadgeVariant> = {
	create: "success",
	update: "warning",
	unchanged: "muted",
};

/** The square icon in front of a card title. */
function IconTile(props: { icon: IconNode }) {
	return (
		<span class="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-foreground">
			<Icon icon={props.icon} class="size-4" />
		</span>
	);
}

// ---------------------------------------------------------------------------
// Import page

/** The form of one importer, in its dialog: columns, file or pasted text, then Preview (which opens its own page). */
function ImportDialog(props: { importer: Importer }) {
	const { t } = useApp();
	const i = props.importer;
	const id = `import-form-${i.type}`;
	return (
		<Dialog
			id={id}
			title={fmt(t.import.importTitle, { type: t.import.types[i.type] })}
			description={t.import.help[i.type]}
		>
			<div class="flex flex-col gap-2">
				<span class="text-xs font-medium tracking-wide text-muted-foreground uppercase">{t.import.columns}</span>
				<ul class="m-0 flex list-none flex-wrap gap-1.5 p-0">
					{headerOf(i).map((col) => {
						const required = i.required.includes(col);
						return (
							<li>
								<Badge variant={required ? "secondary" : "outline"} class="font-mono font-normal">
									{col}
									{required ? (
										<>
											<span class="text-destructive" aria-hidden="true">
												*
											</span>
											<span class="sr-only">({t.import.required})</span>
										</>
									) : null}
								</Badge>
							</li>
						);
					})}
				</ul>
				<p class="text-xs text-muted-foreground">
					<span class="text-destructive">*</span> {t.import.required}
				</p>
			</div>
			<form
				method="post"
				action={`/import/${i.type}/preview`}
				enctype="multipart/form-data"
				class="flex flex-col gap-4"
			>
				<FieldGroup class="gap-3">
					<div data-slot="field" class="flex w-full min-w-0 flex-col gap-2">
						<FieldLabel for={`file-${i.type}`}>{t.import.file}</FieldLabel>
						<input id={`file-${i.type}`} type="file" name="file" accept=".csv,text/csv,text/plain" />
					</div>
					<details class="text-sm">
						<summary class="text-muted-foreground hover:text-foreground">{t.import.orPaste}</summary>
						<textarea name="csv" rows={6} aria-label={t.import.orPaste} class="mt-2" />
					</details>
				</FieldGroup>
				<DialogFooter dialog={id}>
					<Button icon={icons.eye}>{t.import.preview}</Button>
				</DialogFooter>
			</form>
		</Dialog>
	);
}

/**
 * The importers as one list, in the order to import them (a dependent type needs the earlier ones). Each row has its
 * template, its export and "Import…", which opens that type's form in a dialog: the form never shows errors inline
 * (a refused file gets its own preview page), so a dialog is fine here.
 */
function ImporterList() {
	const { t } = useApp();
	return (
		<Card class="mb-6 gap-0 overflow-hidden py-0">
			<CardHeader class="border-b px-4 py-3 [.border-b]:pb-3">
				<CardDescription>{t.import.order}</CardDescription>
			</CardHeader>
			<ol class="m-0 flex list-none flex-col p-0">
				{IMPORTERS.map((i, n) => (
					<li
						id={`import-${i.type}`}
						class="flex scroll-mt-20 flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-3 last:border-b-0"
					>
						<span class="w-4 shrink-0 text-right text-sm text-muted-foreground tabular-nums">{n + 1}</span>
						<IconTile icon={TYPE_ICONS[i.type]} />
						<div class="flex min-w-48 flex-1 flex-col">
							<span class="text-sm font-medium">{t.import.types[i.type]}</span>
							<span class="truncate text-sm text-muted-foreground">{t.import.summaries[i.type]}</span>
						</div>
						<div class="flex flex-wrap items-center gap-2">
							<Button href={`/import/${i.type}/template.csv`} variant="ghost" size="sm" icon={icons.fileSpreadsheet}>
								{t.import.template}
							</Button>
							<Button href={`/import/${i.type}/export.csv`} variant="ghost" size="sm" icon={icons.download}>
								{t.import.export}
							</Button>
							<Button
								type="button"
								variant="outline"
								size="sm"
								icon={icons.upload}
								popovertarget={`import-form-${i.type}`}
							>
								{t.import.importAction}
							</Button>
						</div>
					</li>
				))}
			</ol>
			{IMPORTERS.map((i) => (
				<ImportDialog importer={i} />
			))}
		</Card>
	);
}

function IssueTable(props: { issues: RowIssue[] }) {
	const { t } = useApp();
	return (
		<Table>
			<TableHeader class="bg-muted/50">
				<TableRow>
					<TableHead class="w-0 text-right">{t.import.line}</TableHead>
					<TableHead>{t.import.field}</TableHead>
					<TableHead>{t.import.message}</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{props.issues.map((i) => (
					<TableRow>
						<TableCell class="text-right tabular-nums">{i.line}</TableCell>
						<TableCell>{i.column ? <code>{i.column}</code> : null}</TableCell>
						<TableCell>{errorText(t, i.key, i.vars)}</TableCell>
					</TableRow>
				))}
			</TableBody>
		</Table>
	);
}

function Preview(props: { plan: ImportPlan; csv: string }) {
	const view = useApp();
	const { t } = view;
	const canCommit = can(view, "import.commit");
	const { plan } = props;
	const count = (a: PlanAction) => plan.rows.filter((r) => r.action === a).length;
	const created = count("create");
	const updated = count("update");
	const unchanged = count("unchanged");
	const hasErrors = plan.errors.length > 0;
	const pending = created + updated;
	return (
		<>
			<PageHeader
				title={fmt(t.import.previewTitle, { type: t.import.types[plan.type] })}
				subtitle={fmt(t.import.summary, { create: created, update: updated, unchanged })}
			/>
			<div class="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
				<StatCard
					label={t.import.stats.create}
					value={created}
					icon={icons.circlePlus}
					tone={created > 0 ? "success" : "default"}
				/>
				<StatCard label={t.import.stats.update} value={updated} icon={icons.pencil} />
				<StatCard label={t.import.stats.unchanged} value={unchanged} icon={icons.check} />
				<StatCard
					label={t.import.stats.errors}
					value={plan.errors.length}
					icon={icons.circleAlert}
					tone={hasErrors ? "destructive" : "default"}
				/>
			</div>
			{hasErrors ? (
				<>
					<Alert variant="destructive" title={fmt(t.import.errorsTitle, { n: plan.errors.length })} />
					<TableCard class="mb-4 border-destructive/40">
						<IssueTable issues={plan.errors} />
					</TableCard>
				</>
			) : null}
			{plan.warnings.length ? (
				<>
					<Alert variant="warning" title={t.import.warningsTitle} />
					<TableCard class="mb-4 border-warning/40">
						<IssueTable issues={plan.warnings} />
					</TableCard>
				</>
			) : null}
			<div class="mb-6 flex flex-wrap items-center gap-2">
				{!hasErrors && pending > 0 && canCommit ? (
					<form method="post" action={`/import/${plan.type}/commit`}>
						<textarea name="csv" hidden>
							{props.csv}
						</textarea>
						<Button size="lg" icon={icons.check}>
							{t.import.commit}
						</Button>
					</form>
				) : null}
				<Button href={`/import#import-${plan.type}`} variant="outline" size="lg" icon={icons.arrowLeft}>
					{t.common.back}
				</Button>
			</div>
			{!hasErrors && !canCommit ? <Alert>{t.import.noAdmin}</Alert> : null}
			{plan.rows.length ? (
				<TableCard title={fmt(t.common.results, { n: plan.rows.length })}>
					<Table>
						<TableHeader class="bg-muted/50">
							<TableRow>
								<TableHead class="w-0 text-right">{t.import.line}</TableHead>
								<TableHead>{t.import.action}</TableHead>
								{plan.previewColumns.map((col) => (
									<TableHead class="font-mono tracking-normal normal-case">{col}</TableHead>
								))}
								<TableHead>{t.import.changes}</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{plan.rows.map((r) => (
								<TableRow class={cn(r.action === "unchanged" && "text-muted-foreground")}>
									<TableCell class="text-right tabular-nums">{r.line}</TableCell>
									<TableCell>
										<Badge variant={ACTION_BADGES[r.action]}>{t.import.actions[r.action]}</Badge>
									</TableCell>
									{r.cells.map((cell) => (
										<TableCell>{cell}</TableCell>
									))}
									<TableCell class="text-xs text-muted-foreground">
										{r.changes.length ? (
											<ul class="m-0 flex list-none flex-col gap-0.5 p-0">
												{r.changes.map((ch) => (
													<li>{ch}</li>
												))}
											</ul>
										) : null}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</TableCard>
			) : null}
		</>
	);
}

// ---------------------------------------------------------------------------
// Backup and restore

function BackupCard() {
	const view = useApp();
	const { t } = view;
	return (
		<Card id="backup" class="scroll-mt-20">
			<CardHeader>
				<CardTitle class="flex items-center gap-3">
					<IconTile icon={icons.database} />
					{t.import.backupTitle}
				</CardTitle>
				<CardDescription class="pt-1">{t.import.backupIntro}</CardDescription>
			</CardHeader>
			<CardContent class="flex flex-col gap-6">
				{can(view, "backup.download") ? (
					<Button href="/import/backup.json" variant="outline" icon={icons.fileJson} class="self-start">
						{t.import.backupDownload}
					</Button>
				) : null}
				{can(view, "backup.restore") ? (
					<div class="flex flex-col gap-4 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
						<div class="flex flex-col gap-1">
							<h3 class="flex items-center gap-2 text-sm font-semibold text-destructive">
								<Icon icon={icons.triangleAlert} class="size-4" />
								{t.import.restoreTitle}
							</h3>
							<p class="text-sm text-muted-foreground">{t.import.restoreIntro}</p>
						</div>
						<form
							method="post"
							action="/import/restore/preview"
							enctype="multipart/form-data"
							class="flex flex-col gap-3 sm:flex-row sm:items-end"
						>
							<div data-slot="field" class="flex w-full min-w-0 flex-col gap-2 sm:max-w-md">
								<FieldLabel for="restore-file">{t.import.backupFile}</FieldLabel>
								<input id="restore-file" type="file" name="file" accept=".json,application/json" required />
							</div>
							<Button variant="destructive" icon={icons.rotateCcw}>
								{t.import.restorePreview}
							</Button>
						</form>
					</div>
				) : null}
			</CardContent>
		</Card>
	);
}

importRoutes.get("/backup.json", requirePermission("backup.download"), async (c) => {
	const now = nowIso();
	const backup = await exportBackup(c.env.DB, now);
	c.header("Content-Type", "application/json; charset=utf-8");
	c.header("Content-Disposition", `attachment; filename="kitting-backup-${now.slice(0, 10)}.json"`);
	return c.body(JSON.stringify(backup));
});

async function readJsonInput(c: Context<AppEnv>): Promise<string> {
	const body = await c.req.parseBody();
	const file = body.file;
	if (file instanceof File && file.size > 0) {
		return file.size > MAX_JSON_BYTES ? "" : new TextDecoder().decode(await file.arrayBuffer());
	}
	return typeof body.json === "string" && body.json.length <= MAX_JSON_BYTES ? body.json : "";
}

function RestorePreview(props: { plan: RestorePlan; json: string }) {
	const { t } = useApp();
	const { plan } = props;
	return (
		<>
			<PageHeader title={t.import.restoreTitle} />
			{plan.ok ? (
				<>
					<Alert variant="warning">{t.import.restoreIntro}</Alert>
					<Card class="max-w-2xl border-destructive/40">
						<CardHeader>
							<CardTitle class="flex items-center gap-3">
								<IconTile icon={icons.fileJson} />
								{t.import.backupTitle}
							</CardTitle>
							<CardDescription class="pt-1">
								{fmt(t.import.restoreSummary, { at: plan.backup.exported_at.replace("T", " ").slice(0, 16) })}
							</CardDescription>
						</CardHeader>
						<CardContent>
							<div class="overflow-hidden rounded-lg border">
								<Table>
									<TableHeader class="bg-muted/50">
										<TableRow>
											<TableHead>{t.import.table}</TableHead>
											<TableHead class="text-right">{t.import.rows}</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{plan.counts.map((r) => (
											<TableRow>
												<TableCell>
													<code>{r.table}</code>
												</TableCell>
												<TableCell class="text-right tabular-nums">{r.rows}</TableCell>
											</TableRow>
										))}
									</TableBody>
								</Table>
							</div>
						</CardContent>
						<CardFooter class="border-t">
							<form
								method="post"
								action="/import/restore/commit"
								class="flex flex-wrap items-center gap-2"
								data-confirm={t.import.restoreConfirmPrompt}
							>
								<textarea name="json" hidden>
									{props.json}
								</textarea>
								<Button variant="destructive" icon={icons.rotateCcw}>
									{t.import.restoreConfirm}
								</Button>
								<Button href="/import#backup" variant="outline">
									{t.common.cancel}
								</Button>
							</form>
						</CardFooter>
					</Card>
				</>
			) : (
				<>
					<Alert variant="destructive" title={t.import.restoreInvalid}>
						<ul class="m-0 list-disc pl-5">
							{plan.errors.map((e) => (
								<li>{e}</li>
							))}
						</ul>
					</Alert>
					<Button href="/import#backup" variant="outline" icon={icons.arrowLeft}>
						{t.common.back}
					</Button>
				</>
			)}
		</>
	);
}

importRoutes.post("/restore/preview", requirePermission("backup.restore"), async (c) => {
	const json = await readJsonInput(c);
	const plan = await planRestore(c.env.DB, json);
	return page(c, c.var.t.import.restoreTitle, <RestorePreview plan={plan} json={json} />, plan.ok ? 200 : 422);
});

importRoutes.post("/restore/commit", requirePermission("backup.restore"), async (c) => {
	const json = await readJsonInput(c);
	const plan = await planRestore(c.env.DB, json);
	if (!plan.ok) return page(c, c.var.t.import.restoreTitle, <RestorePreview plan={plan} json={json} />, 422);
	const summary = fmt(c.var.t.history.summaries.restore, { at: plan.backup.exported_at.slice(0, 10) });
	await c.env.DB.batch(restoreStatements(c.env.DB, plan.backup, { user: c.var.user, now: nowIso(), summary }));
	return c.redirect("/import?restored=1", 303);
});

importRoutes.get("/", (c) => {
	const t = c.var.t;
	const done = importerFor(c.req.query("done") ?? "");
	return page(
		c,
		t.import.title,
		<>
			<PageHeader title={t.import.title} subtitle={t.import.intro} />
			{done ? (
				<Flash
					message={`${t.import.types[done.type]} — ${fmt(t.import.done, {
						create: c.req.query("create") ?? "0",
						update: c.req.query("update") ?? "0",
					})}`}
				/>
			) : null}
			{c.req.query("restored") ? <Flash message={t.import.restored} /> : null}
			<ImporterList />
			<BackupCard />
		</>,
	);
});

importRoutes.get("/:type/template.csv", (c) => {
	const importer = importerFor(c.req.param("type"));
	if (!importer) return notFound(c);
	return csvResponse(c, `${importer.type}-template.csv`, [headerOf(importer), ...importer.example]);
});

importRoutes.get("/:type/export.csv", async (c) => {
	const importer = importerFor(c.req.param("type"));
	if (!importer) return notFound(c);
	const rows = await importer.exportRows({ db: c.var.db, locale: c.var.locale });
	return csvResponse(c, `${importer.type}-${nowIso().slice(0, 10)}.csv`, [headerOf(importer), ...rows]);
});

importRoutes.post("/:type/preview", async (c) => {
	const importer = importerFor(c.req.param("type"));
	if (!importer) return notFound(c);
	const csv = await readCsvInput(c);
	const plan = await planImport({ db: c.var.db, locale: c.var.locale }, importer.type, csv);
	if (!plan) return notFound(c);
	return page(c, c.var.t.import.preview, <Preview plan={plan} csv={csv} />, plan.errors.length ? 422 : 200);
});

importRoutes.post("/:type/commit", requirePermission("import.commit"), async (c) => {
	const importer = importerFor(c.req.param("type"));
	if (!importer) return notFound(c);
	const csv = await readCsvInput(c);
	// Re-validate against the current database: it may have changed since the preview.
	const plan = await planImport({ db: c.var.db, locale: c.var.locale }, importer.type, csv);
	if (!plan) return notFound(c);
	if (plan.errors.length) return page(c, c.var.t.import.preview, <Preview plan={plan} csv={csv} />, 422);
	const created = plan.rows.filter((r) => r.action === "create").length;
	const updated = plan.rows.filter((r) => r.action === "update").length;
	const now = nowIso();
	await runChangeSet(
		c.var.db,
		{
			user: c.var.user,
			source: "import",
			summary: fmt(c.var.t.history.summaries.import, {
				file: `${importer.type}.csv`,
				create: created,
				update: updated,
			}),
			now,
			...(plan.revertible === false ? { revertible: false } : {}),
		},
		plan.statements(c.var.user, now),
	);
	return c.redirect(`/import?done=${importer.type}&create=${created}&update=${updated}`, 303);
});
