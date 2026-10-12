import type { Context } from "hono";
import { Hono } from "hono";
import {
	headerOf,
	IMPORTERS,
	type Importer,
	type ImportPlan,
	importerFor,
	planImport,
	type RowIssue,
} from "../domain/import";
import { errorText, fmt } from "../i18n";
import { toCsv } from "../lib/csv";
import { runBatch } from "../lib/db";
import { decodeText } from "../lib/encoding";
import { requireAdmin } from "../middleware/auth";
import type { AppEnv } from "../types";
import { useApp } from "../views/context";
import { notFound, nowIso, page } from "../views/render";
import { Flash, PageHeader } from "../views/ui";

export const importRoutes = new Hono<AppEnv>();

const MAX_CSV_BYTES = 2 * 1024 * 1024;

/** Locale-appropriate CSV dialect: French spreadsheets expect ";" and decimal commas. */
export function csvDelimiter(c: Context<AppEnv>): string {
	return c.var.locale === "fr" ? ";" : ",";
}

export function csvResponse(c: Context<AppEnv>, filename: string, rows: (string | number | null)[][]) {
	c.header("Content-Type", "text/csv; charset=utf-8");
	c.header("Content-Disposition", `attachment; filename="${filename}"`);
	return c.body(toCsv(rows, csvDelimiter(c)));
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

function ImporterCard(props: { importer: Importer }) {
	const { t } = useApp();
	const i = props.importer;
	return (
		<section class="card" id={`import-${i.type}`}>
			<h2>{t.import.types[i.type]}</h2>
			<p>{t.import.help[i.type]}</p>
			<p class="small">
				{t.import.columns}:{" "}
				{headerOf(i).map((col, idx) => (
					<>
						{idx > 0 ? ", " : ""}
						<code>{col}</code>
						{i.required.includes(col) ? <span class="req"> ({t.import.required})</span> : null}
					</>
				))}
			</p>
			<p class="links">
				<a href={`/import/${i.type}/template.csv`}>{t.import.template}</a>
				<a href={`/import/${i.type}/export.csv`}>{t.import.export}</a>
			</p>
			<form method="post" action={`/import/${i.type}/preview`} enctype="multipart/form-data" class="form">
				<div class="field">
					<label for={`file-${i.type}`}>{t.import.file}</label>
					<input id={`file-${i.type}`} type="file" name="file" accept=".csv,text/csv,text/plain" />
				</div>
				<details>
					<summary>{t.import.orPaste}</summary>
					<textarea name="csv" rows={6} aria-label={t.import.orPaste} />
				</details>
				<div class="form-actions">
					<button type="submit" class="button primary">
						{t.import.preview}
					</button>
				</div>
			</form>
		</section>
	);
}

function IssueTable(props: { issues: RowIssue[] }) {
	const { t } = useApp();
	return (
		<table class="table">
			<thead>
				<tr>
					<th class="num">{t.import.line}</th>
					<th>{t.import.field}</th>
					<th>{t.import.message}</th>
				</tr>
			</thead>
			<tbody>
				{props.issues.map((i) => (
					<tr>
						<td class="num">{i.line}</td>
						<td>
							<code>{i.column ?? ""}</code>
						</td>
						<td>{errorText(t, i.key, i.vars)}</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}

function Preview(props: { plan: ImportPlan; csv: string }) {
	const { t, isAdmin } = useApp();
	const { plan } = props;
	const count = (a: string) => plan.rows.filter((r) => r.action === a).length;
	const hasErrors = plan.errors.length > 0;
	const pending = count("create") + count("update");
	return (
		<>
			<PageHeader title={fmt(t.import.previewTitle, { type: t.import.types[plan.type] })} />
			<p class="lead">
				{fmt(t.import.summary, { create: count("create"), update: count("update"), unchanged: count("unchanged") })}
			</p>
			{hasErrors ? (
				<section class="card danger">
					<h2>{fmt(t.import.errorsTitle, { n: plan.errors.length })}</h2>
					<IssueTable issues={plan.errors} />
				</section>
			) : null}
			{plan.warnings.length ? (
				<section class="card warning">
					<h2>{t.import.warningsTitle}</h2>
					<IssueTable issues={plan.warnings} />
				</section>
			) : null}
			<div class="form-actions">
				{!hasErrors && pending > 0 && isAdmin ? (
					<form method="post" action={`/import/${plan.type}/commit`} class="inline">
						<textarea name="csv" hidden>
							{props.csv}
						</textarea>
						<button type="submit" class="button primary">
							{t.import.commit}
						</button>
					</form>
				) : null}
				<a class="button secondary" href={`/import#import-${plan.type}`}>
					{t.common.back}
				</a>
			</div>
			{!hasErrors && !isAdmin ? <p class="flash">{t.import.noAdmin}</p> : null}
			{plan.rows.length ? (
				<table class="table">
					<thead>
						<tr>
							<th class="num">{t.import.line}</th>
							<th>{t.import.action}</th>
							{plan.previewColumns.map((col) => (
								<th>{col}</th>
							))}
							<th />
						</tr>
					</thead>
					<tbody>
						{plan.rows.map((r) => (
							<tr class={`action-${r.action}`}>
								<td class="num">{r.line}</td>
								<td>
									<span class={`tag action-${r.action}`}>{t.import.actions[r.action]}</span>
								</td>
								{r.cells.map((cell) => (
									<td>{cell}</td>
								))}
								<td class="small">
									{r.changes.map((ch) => (
										<div>{ch}</div>
									))}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			) : null}
		</>
	);
}

importRoutes.get("/", (c) => {
	const t = c.var.t;
	const done = importerFor(c.req.query("done") ?? "");
	return page(
		c,
		t.import.title,
		<>
			<PageHeader title={t.import.title} />
			{done ? (
				<Flash
					message={`${t.import.types[done.type]} — ${fmt(t.import.done, {
						create: c.req.query("create") ?? "0",
						update: c.req.query("update") ?? "0",
					})}`}
				/>
			) : null}
			<p>{t.import.intro}</p>
			<p class="muted">{t.import.order}</p>
			<div class="cards">
				{IMPORTERS.map((i) => (
					<ImporterCard importer={i} />
				))}
			</div>
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

importRoutes.post("/:type/commit", requireAdmin, async (c) => {
	const importer = importerFor(c.req.param("type"));
	if (!importer) return notFound(c);
	const csv = await readCsvInput(c);
	// Re-validate against the current database: it may have changed since the preview.
	const plan = await planImport({ db: c.var.db, locale: c.var.locale }, importer.type, csv);
	if (!plan) return notFound(c);
	if (plan.errors.length) return page(c, c.var.t.import.preview, <Preview plan={plan} csv={csv} />, 422);
	await runBatch(c.var.db, plan.statements(c.var.user, nowIso()));
	const created = plan.rows.filter((r) => r.action === "create").length;
	const updated = plan.rows.filter((r) => r.action === "update").length;
	return c.redirect(`/import?done=${importer.type}&create=${created}&update=${updated}`, 303);
});
