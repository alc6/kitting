import { and, asc, eq, inArray, ne } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import type { Child } from "hono/jsx";
import { BUILD_STATUSES, type BuildStatus, boms, builds, type Part, parts, stockMoves } from "../db/schema";
import type { ExplodedNode } from "../domain/bom-graph";
import { loadGraph } from "../domain/boms";
import {
	buildEditInput,
	buildInput,
	buildPickList,
	choiceField,
	completionStatements,
	getBuild,
	getBuildLines,
	listBuilds,
	makeNodes,
	nextBuildNumber,
	OPEN_STATUSES,
	type PickList,
	serialCount,
	serialField,
} from "../domain/builds";
import { onHandAt, serialsInStock } from "../domain/stock";
import { errorText, fmt } from "../i18n";
import { runBatch } from "../lib/db";
import { isConstraintError } from "../lib/sql";
import { formatQtyInput, lineCostCents, MILLI } from "../lib/units";
import { type FieldErrors, validate } from "../lib/validation";
import type { AppEnv } from "../types";
import { useApp } from "../views/context";
import { idParam, notFound, nowIso, page, redirectOk, translateErrors } from "../views/render";
import {
	Empty,
	ErrorBanner,
	Flash,
	type FormErrors,
	type FormValues,
	KindBadge,
	LinkButton,
	Money,
	PageHeader,
	PostButton,
	Qty,
	SearchBar,
	SelectField,
	shortDateTime,
	TextArea,
	TextField,
} from "../views/ui";

export const buildRoutes = new Hono<AppEnv>();

type BuildRow = Awaited<ReturnType<typeof listBuilds>>[number];
type BuildData = NonNullable<Awaited<ReturnType<typeof getBuild>>>;

export function BuildStatusBadge(props: { status: BuildStatus }) {
	const { t } = useApp();
	return <span class={`status status-${props.status}`}>{t.builds.statuses[props.status]}</span>;
}

export function BuildsTable(props: { rows: BuildRow[] }) {
	const { t } = useApp();
	if (props.rows.length === 0) return <Empty>{t.builds.noBuilds}</Empty>;
	return (
		<table class="table">
			<thead>
				<tr>
					<th>{t.builds.number}</th>
					<th>{t.builds.part}</th>
					<th>{t.builds.bom}</th>
					<th class="num">{t.builds.qty}</th>
					<th>{t.builds.serial}</th>
					<th>{t.builds.status}</th>
					<th>{t.builds.plannedFor}</th>
				</tr>
			</thead>
			<tbody>
				{props.rows.map((b) => (
					<tr>
						<td>
							<a href={`/builds/${b.id}`}>{b.number}</a>
						</td>
						<td>
							{b.partRef} <span class="muted">{b.partName}</span>
						</td>
						<td>
							{b.bomCode} · {b.bomRevision}
						</td>
						<td class="num">
							<Qty milli={b.qtyMilli} unit={b.unit} />
						</td>
						<td>{b.serial ?? ""}</td>
						<td>
							<BuildStatusBadge status={b.status} />
						</td>
						<td class="nowrap">{b.status === "done" ? shortDateTime(b.doneAt).slice(0, 10) : (b.plannedFor ?? "")}</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}

buildRoutes.get("/", async (c) => {
	const t = c.var.t;
	const q = c.req.query("q") ?? "";
	const status = c.req.query("status") ?? "open";
	const rows = await listBuilds(c.var.db, { q, status });
	return page(
		c,
		t.builds.title,
		<>
			<PageHeader title={t.builds.title} actions={<LinkButton href="/builds/new" label={t.builds.new} />} />
			<Flash ok={c.req.query("ok")} message={c.req.query("ok") === "cancelled" ? t.builds.cancelled : undefined} />
			<SearchBar action="/builds" q={q}>
				<select name="status" aria-label={t.builds.status}>
					<option value="open">{t.builds.statusFilter.open}</option>
					{BUILD_STATUSES.map((s) => (
						<option value={s} selected={s === status}>
							{t.builds.statuses[s]}
						</option>
					))}
					<option value="all" selected={status === "all"}>
						{t.builds.statusFilter.all}
					</option>
				</select>
			</SearchBar>
			<div id="results">
				<BuildsTable rows={rows} />
			</div>
		</>,
	);
});

// ---------------------------------------------------------------------------
// New build

type BomOption = { id: number; code: string; revision: string };

function NewBuildForm(props: {
	values: FormValues;
	errors: FormErrors;
	products: { id: number; ref: string; name: string }[];
	product: Part | undefined;
	bomOptions: BomOption[];
}) {
	const { t } = useApp();
	const p = { values: props.values, errors: props.errors };
	const reload = {
		"hx-get": "/builds/new",
		"hx-include": "closest form",
		"hx-target": "#build-form",
		"hx-select": "#build-form",
		"hx-swap": "outerHTML",
	};
	return (
		<form method="post" action="/builds" class="card form" id="build-form">
			<ErrorBanner show={Object.keys(props.errors).length > 0} />
			<div class="field">
				<label for="f-part_id">
					{t.builds.part}
					<span class="req"> *</span>
				</label>
				<div class="inline-row">
					<select id="f-part_id" name="part_id" required {...reload} hx-trigger="change">
						<option value="">—</option>
						{props.products.map((o) => (
							<option value={String(o.id)} selected={String(o.id) === props.values.part_id}>
								{o.ref} · {o.name}
							</option>
						))}
					</select>
					<button type="submit" class="button secondary" formmethod="get" formaction="/builds/new">
						{t.builds.choosePart}
					</button>
				</div>
				<small class="hint">{t.builds.partHint}</small>
				{props.errors.part_id ? <small class="error">{props.errors.part_id}</small> : null}
			</div>
			{props.product ? (
				props.bomOptions.length === 0 ? (
					<p class="flash warning">
						{t.builds.noActiveBom} <a href={`/boms/new?part=${props.product.id}`}>{t.boms.new}</a>
					</p>
				) : (
					<>
						<SelectField
							name="bom_id"
							label={t.builds.variant}
							required
							options={props.bomOptions.map((b) => ({ value: String(b.id), label: `${b.code} (${b.revision})` }))}
							{...p}
						/>
						<div class="grid-3">
							<TextField name="qty" label={t.builds.qty} inputmode="decimal" required {...p} />
							<TextField
								name="serial"
								label={t.builds.serial}
								hint={props.product.trackSerial ? t.builds.serialHint : undefined}
								required={props.product.trackSerial}
								{...p}
							/>
							<TextField name="planned_for" label={t.builds.plannedFor} type="date" {...p} />
						</div>
						<TextArea name="notes" label={t.common.notes} {...p} />
						<div class="form-actions">
							<button type="submit" class="button primary">
								{t.common.create}
							</button>
							<a class="button secondary" href="/builds">
								{t.common.cancel}
							</a>
						</div>
					</>
				)
			) : null}
		</form>
	);
}

async function newBuildData(c: Context<AppEnv>, partId: number | null) {
	const db = c.var.db;
	const products = await db
		.select({ id: parts.id, ref: parts.ref, name: parts.name })
		.from(parts)
		.where(and(eq(parts.kind, "make"), eq(parts.archived, false)))
		.orderBy(asc(parts.ref));
	const product = partId ? (await db.select().from(parts).where(eq(parts.id, partId)).limit(1))[0] : undefined;
	const bomOptions = product
		? await db
				.select({ id: boms.id, code: boms.code, revision: boms.revision })
				.from(boms)
				.where(and(eq(boms.parentPartId, product.id), eq(boms.status, "active")))
				.orderBy(asc(boms.code))
		: [];
	return { products, product: product?.kind === "make" ? product : undefined, bomOptions };
}

buildRoutes.get("/new", async (c) => {
	const t = c.var.t;
	const q = c.req.query();
	const partId = /^\d+$/.test(q.part_id ?? q.part ?? "") ? Number(q.part_id ?? q.part) : null;
	const data = await newBuildData(c, partId);
	const std = data.bomOptions.find((b) => b.code === "std") ?? data.bomOptions[0];
	const values: FormValues = {
		qty: "1",
		...q,
		part_id: partId ? String(partId) : "",
		bom_id: q.bom_id && data.bomOptions.some((b) => String(b.id) === q.bom_id) ? q.bom_id : std ? String(std.id) : "",
	};
	return page(
		c,
		t.builds.new,
		<>
			<PageHeader title={t.builds.new} />
			<NewBuildForm values={values} errors={{}} {...data} />
		</>,
	);
});

buildRoutes.post("/", async (c) => {
	const t = c.var.t;
	const db = c.var.db;
	const body = await c.req.parseBody();
	const v = validate(buildInput, body);
	const errors: FieldErrors = v.ok ? {} : { ...v.errors };
	const partId = v.ok ? v.data.part_id : null;
	const data = await newBuildData(c, partId);
	if (v.ok) {
		const d = v.data;
		if (!data.product) errors.part_id = d.part_id ? "build_part_kind" : "required";
		else {
			if (!d.bom_id || !data.bomOptions.some((b) => b.id === d.bom_id)) errors.bom_id = "build_bom_mismatch";
			if (data.product.trackSerial) {
				if (d.qty !== MILLI) errors.qty = "build_serial_qty";
				if (!d.serial) errors.serial = "build_serial_required";
			}
			if (d.serial) {
				const taken = await db
					.select({ id: builds.id })
					.from(builds)
					.where(and(eq(builds.partId, data.product.id), eq(builds.serial, d.serial), ne(builds.status, "cancelled")))
					.limit(1);
				if (taken.length) errors.serial = "build_serial_taken";
			}
		}
	}
	if (!v.ok || Object.keys(errors).length > 0 || !data.product) {
		return page(
			c,
			t.builds.new,
			<>
				<PageHeader title={t.builds.new} />
				<NewBuildForm values={body as FormValues} errors={translateErrors(c, errors)} {...data} />
			</>,
			422,
		);
	}
	const d = v.data;
	const user = c.var.user;
	// Numbers are sequential; retry once if another user took the same number meanwhile.
	for (let attempt = 0; ; attempt++) {
		try {
			const [row] = await db
				.insert(builds)
				.values({
					number: await nextBuildNumber(db),
					partId: data.product.id,
					bomId: d.bom_id as number,
					qtyMilli: d.qty,
					serial: d.serial || null,
					plannedFor: d.planned_for,
					notes: d.notes,
					createdBy: user,
					updatedBy: user,
				})
				.returning({ id: builds.id });
			return redirectOk(c, `/builds/${row?.id}`, "created");
		} catch (err) {
			if (attempt > 0 || !isConstraintError(err, "UNIQUE")) throw err;
		}
	}
});

// ---------------------------------------------------------------------------
// Detail, pick list, completion

function BuildHeader(props: { data: BuildData }) {
	const { t } = useApp();
	const { build, part, bom } = props.data;
	const open = OPEN_STATUSES.includes(build.status);
	return (
		<PageHeader
			title={`${build.number} · ${part.ref}`}
			subtitle={
				<>
					<BuildStatusBadge status={build.status} /> {part.name} · {t.builds.bom}:{" "}
					<a href={`/boms/${bom.id}`}>
						{bom.code} ({bom.revision})
					</a>{" "}
					· {t.builds.qty}: <Qty milli={build.qtyMilli} unit={part.unit} />
					{build.serial ? (
						<>
							{" "}
							· {t.builds.serial}: <strong>{build.serial}</strong>
						</>
					) : null}
				</>
			}
			actions={
				open ? (
					<>
						{build.status === "planned" ? (
							<PostButton action={`/builds/${build.id}/start`} label={t.builds.start} />
						) : null}
						<PostButton
							action={`/builds/${build.id}/cancel`}
							label={t.builds.cancel}
							confirm={t.builds.confirmCancel}
						/>
					</>
				) : null
			}
		/>
	);
}

function EditCard(props: { data: BuildData; values: FormValues; errors: FormErrors }) {
	const { t } = useApp();
	const p = { values: props.values, errors: props.errors };
	return (
		<details class="card" open={Object.keys(props.errors).length > 0}>
			<summary>{t.common.edit}</summary>
			<form method="post" action={`/builds/${props.data.build.id}`} class="form">
				<div class="grid-2">
					<TextField name="serial" label={t.builds.serial} required={props.data.part.trackSerial} {...p} />
					<TextField name="planned_for" label={t.builds.plannedFor} type="date" {...p} />
				</div>
				<TextArea name="notes" label={t.common.notes} {...p} />
				<div class="form-actions">
					<button type="submit" class="button secondary">
						{t.builds.edit}
					</button>
				</div>
			</form>
		</details>
	);
}

function ChoiceRadios(props: { buildId: number; node: ExplodedNode; current: string }) {
	const { t } = useApp();
	const name = choiceField(props.node.path);
	const recalc = {
		"hx-get": `/builds/${props.buildId}`,
		"hx-include": "closest form",
		"hx-target": "#picklist",
		"hx-select": "#picklist",
		"hx-swap": "outerHTML",
		"hx-trigger": "change",
	};
	const option = (value: string, label: string) => (
		<label class="choice">
			<input type="radio" name={name} value={value} checked={props.current === value} {...recalc} />
			<span>{label}</span>
		</label>
	);
	return (
		<div class="choices">
			{option("", `${t.builds.auto} (${t.boms.modes[props.node.mode]})`)}
			{option("stock", t.builds.useStock)}
			{option("build", t.builds.buildNow)}
		</div>
	);
}

function PickListForm(props: {
	data: BuildData;
	pick: PickList;
	values: Record<string, string>;
	serialHints: Map<number, string[]>;
}) {
	const { t, locale } = useApp();
	const { build } = props.data;
	const { pick } = props;
	const nodes = makeNodes(pick.explosion);
	const goesNegative = pick.explosion.requirements.some(
		(r) => r.qtyMilli > Math.max(0, pick.onHand.get(r.part.id) ?? 0),
	);
	const hasErrors = Object.keys(pick.errors).length > 0 || pick.problems.length > 0;
	return (
		<form
			method="post"
			action={`/builds/${build.id}/complete`}
			id="picklist"
			class="form"
			data-confirm={t.builds.completeConfirm}
		>
			<ErrorBanner show={hasErrors} />
			{pick.problems.map((p) => (
				<p class="flash error">{errorText(t, p.key, p.vars)}</p>
			))}
			{nodes.length ? (
				<section class="card">
					<h2>{t.builds.subAssemblies}</h2>
					<p class="muted">{t.builds.subIntro}</p>
					<table class="table">
						<tbody>
							{nodes.map((n) => (
								<tr>
									<td class={`depth-${Math.min(n.depth, 4)}`}>
										<a href={`/parts/${n.part.id}`}>{n.part.ref}</a> <span class="muted">{n.part.name}</span>
									</td>
									<td class="num">
										<Qty milli={n.qtyMilli} unit={n.part.unit} />
									</td>
									<td class="muted small">
										{fmt(t.builds.available, {
											n: formatQtyInput(Math.max(0, pick.onHand.get(n.part.id) ?? 0), locale),
										})}
									</td>
									<td>
										<ChoiceRadios buildId={build.id} node={n} current={props.values[choiceField(n.path)] ?? ""} />
									</td>
								</tr>
							))}
						</tbody>
					</table>
					<noscript>
						<button type="submit" class="button secondary" formmethod="get" formaction={`/builds/${build.id}`}>
							{t.builds.recalculate}
						</button>
					</noscript>
				</section>
			) : null}
			<section class="card">
				<h2>{t.builds.pickList}</h2>
				<p class="muted">{t.builds.pickIntro}</p>
				{goesNegative ? <p class="flash warning">{t.builds.negativeWarning}</p> : null}
				<div class="scroll-x">
					<table class="table picklist">
						<thead>
							<tr>
								<th class="narrow">{t.builds.picked}</th>
								<th>{t.builds.component}</th>
								<th class="num">{t.builds.need}</th>
								<th class="num">{t.builds.onHand}</th>
								<th>{t.builds.serials}</th>
							</tr>
						</thead>
						<tbody>
							{pick.explosion.requirements.map((r) => {
								const onHand = pick.onHand.get(r.part.id) ?? 0;
								const short = r.qtyMilli - Math.max(0, onHand);
								const listId = `serials-${r.part.id}`;
								return (
									<tr>
										<td class="narrow">
											<input
												type="checkbox"
												name={`picked:${r.part.id}`}
												aria-label={`${t.builds.picked} ${r.part.ref}`}
											/>
										</td>
										<td>
											<a href={`/parts/${r.part.id}`}>{r.part.ref}</a> {r.part.name} <KindBadge kind={r.part.kind} />
										</td>
										<td class="num">
											<strong>
												<Qty milli={r.qtyMilli} unit={r.part.unit} />
											</strong>
										</td>
										<td class="num">
											<Qty milli={onHand} unit={r.part.unit} />
											{short > 0 ? (
												<div class="warn small">{fmt(t.builds.short, { n: formatQtyInput(short, locale) })}</div>
											) : null}
										</td>
										<td>
											{r.part.trackSerial ? (
												<div class="serials">
													{Array.from({ length: serialCount(r) }, (_, i) => {
														const name = serialField(r.part.id, i);
														const error = pick.errors[name];
														return (
															<span class={error ? "serial has-error" : "serial"}>
																<input
																	type="text"
																	name={name}
																	value={props.values[name] ?? ""}
																	list={listId}
																	placeholder={`#${i + 1}`}
																	aria-label={`${t.builds.serial} ${r.part.ref} ${i + 1}`}
																	aria-invalid={error ? "true" : undefined}
																	autocomplete="off"
																/>
																{error ? <small class="error">{errorText(t, error)}</small> : null}
															</span>
														);
													})}
													<datalist id={listId}>
														{(props.serialHints.get(r.part.id) ?? []).map((s) => (
															<option value={s} />
														))}
													</datalist>
												</div>
											) : null}
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
				{pick.explosion.fees.length ? (
					<p class="muted small">
						{t.builds.fees}:{" "}
						{pick.explosion.fees.map((f) => `${f.part.ref} × ${formatQtyInput(f.qtyMilli, locale)}`).join(", ")}
					</p>
				) : null}
			</section>
			<div class="form-actions">
				<button type="submit" class="button primary big">
					{t.builds.complete}
				</button>
			</div>
		</form>
	);
}

function AsBuilt(props: {
	lines: Awaited<ReturnType<typeof getBuildLines>>;
	outputCost: number | null;
	qtyMilli: number;
}) {
	const { t } = useApp();
	const incomplete = props.lines.some((l) => l.line.unitCostCents === null);
	const materials = props.lines.reduce(
		(s, l) => s + (l.line.unitCostCents === null ? 0 : lineCostCents(l.line.qtyMilli, l.line.unitCostCents)),
		0,
	);
	return (
		<section class="card">
			<h2>{t.builds.asBuilt}</h2>
			<p class="muted">{t.builds.asBuiltIntro}</p>
			<div class="scroll-x">
				<table class="table">
					<thead>
						<tr>
							<th>{t.builds.component}</th>
							<th>{t.builds.serial}</th>
							<th class="num">{t.builds.qty}</th>
							<th class="num">{t.builds.unitCost}</th>
							<th class="num">{t.builds.lineCost}</th>
						</tr>
					</thead>
					<tbody>
						{props.lines.map(({ line, ref, name, kind, unit, sourceBuildId, sourceBuildNumber }) => (
							<tr>
								<td>
									<a href={`/parts/${line.partId}`}>{ref}</a> {name} <KindBadge kind={kind} />
								</td>
								<td>
									{line.serial ?? ""}
									{sourceBuildId ? (
										<>
											{" "}
											<a class="small" href={`/builds/${sourceBuildId}`}>
												({fmt(t.builds.builtIn, { number: sourceBuildNumber ?? "" })})
											</a>
										</>
									) : null}
								</td>
								<td class="num">
									<Qty milli={line.qtyMilli} unit={unit} />
								</td>
								<td class="num">
									<Money cents={line.unitCostCents} />
								</td>
								<td class="num">
									{line.unitCostCents === null ? null : (
										<Money cents={lineCostCents(line.qtyMilli, line.unitCostCents)} />
									)}
								</td>
							</tr>
						))}
					</tbody>
					<tfoot>
						<tr>
							<td colspan={4}>{t.common.total}</td>
							<td class="num">
								<Money cents={materials} />
							</td>
						</tr>
						{props.outputCost !== null ? (
							<tr>
								<td colspan={4}>{t.builds.totalCost}</td>
								<td class="num">
									<Money cents={lineCostCents(props.qtyMilli, props.outputCost)} />
									{incomplete ? <span class="warn"> *</span> : null}
								</td>
							</tr>
						) : null}
					</tfoot>
				</table>
			</div>
			{incomplete ? <p class="warn small">{t.builds.costIncomplete}</p> : null}
		</section>
	);
}

async function renderBuild(
	c: Context<AppEnv>,
	data: BuildData,
	form: Record<string, string>,
	opts: { validate?: boolean; editErrors?: FieldErrors; editValues?: FormValues; status?: 200 | 422 } = {},
) {
	const t = c.var.t;
	const db = c.var.db;
	const { build, part } = data;
	const ok = c.req.query("ok");
	const flash =
		ok === "completed"
			? t.builds.completed
			: ok === "started"
				? t.builds.started
				: ok === "cancelled"
					? t.builds.cancelled
					: ok === "created"
						? t.builds.created
						: undefined;
	const open = OPEN_STATUSES.includes(build.status);
	let body: Child;
	if (open) {
		const [graph, onHand] = await Promise.all([loadGraph(db), onHandAt(db)]);
		const pick = buildPickList(graph, onHand, build, part, form, opts.validate ?? false);
		const tracked = pick.explosion.requirements.filter((r) => r.part.trackSerial);
		const hints = new Map(
			await Promise.all(tracked.map(async (r) => [r.part.id, await serialsInStock(db, r.part.id)] as const)),
		);
		body = (
			<>
				<EditCard
					data={data}
					values={
						opts.editValues ?? {
							serial: build.serial ?? "",
							planned_for: build.plannedFor ?? "",
							notes: build.notes,
						}
					}
					errors={translateErrors(c, opts.editErrors ?? {})}
				/>
				<PickListForm data={data} pick={pick} values={form} serialHints={hints} />
			</>
		);
	} else {
		const [lines, output] = await Promise.all([
			getBuildLines(db, build.id),
			db
				.select({ unitCostCents: stockMoves.unitCostCents })
				.from(stockMoves)
				.where(
					and(eq(stockMoves.refType, "build"), eq(stockMoves.refId, build.id), eq(stockMoves.reason, "build_output")),
				)
				.limit(1),
		]);
		body = (
			<>
				{build.status === "done" ? (
					<p>
						{t.builds.doneAt}: {shortDateTime(build.doneAt)} · {build.updatedBy}
					</p>
				) : null}
				{build.notes ? <p class="pre">{build.notes}</p> : null}
				{build.status === "done" ? (
					<AsBuilt lines={lines} outputCost={output[0]?.unitCostCents ?? null} qtyMilli={build.qtyMilli} />
				) : null}
			</>
		);
	}
	return page(
		c,
		`${build.number} · ${part.ref}`,
		<>
			<BuildHeader data={data} />
			<Flash message={flash} />
			{c.req.query("err") ? <p class="flash error">{errorText(t, c.req.query("err") ?? "")}</p> : null}
			{body}
		</>,
		opts.status ?? 200,
	);
}

async function loadBuildData(c: Context<AppEnv>) {
	const id = idParam(c);
	return id ? getBuild(c.var.db, id) : undefined;
}

buildRoutes.get("/:id", async (c) => {
	const data = await loadBuildData(c);
	if (!data) return notFound(c);
	// Choices and serials typed so far travel in the query string when recalculating.
	return renderBuild(c, data, c.req.query());
});

buildRoutes.post("/:id", async (c) => {
	const data = await loadBuildData(c);
	if (!data) return notFound(c);
	const { build, part } = data;
	if (!OPEN_STATUSES.includes(build.status)) return c.redirect(`/builds/${build.id}?err=build_not_open`, 303);
	const body = await c.req.parseBody();
	const v = validate(buildEditInput, body);
	const errors: FieldErrors = v.ok ? {} : { ...v.errors };
	if (v.ok) {
		if (part.trackSerial && !v.data.serial) errors.serial = "build_serial_required";
		if (v.data.serial) {
			const taken = await c.var.db
				.select({ id: builds.id })
				.from(builds)
				.where(
					and(
						eq(builds.partId, part.id),
						eq(builds.serial, v.data.serial),
						ne(builds.status, "cancelled"),
						ne(builds.id, build.id),
					),
				)
				.limit(1);
			if (taken.length) errors.serial = "build_serial_taken";
		}
	}
	if (!v.ok || Object.keys(errors).length > 0) {
		return renderBuild(c, data, {}, { editErrors: errors, editValues: body as FormValues, status: 422 });
	}
	await c.var.db
		.update(builds)
		.set({
			serial: v.data.serial || null,
			plannedFor: v.data.planned_for,
			notes: v.data.notes,
			updatedAt: nowIso(),
			updatedBy: c.var.user,
		})
		.where(eq(builds.id, build.id));
	return redirectOk(c, `/builds/${build.id}`);
});

buildRoutes.post("/:id/start", async (c) => {
	const data = await loadBuildData(c);
	if (!data) return notFound(c);
	await c.var.db
		.update(builds)
		.set({ status: "in_progress", updatedAt: nowIso(), updatedBy: c.var.user })
		.where(and(eq(builds.id, data.build.id), eq(builds.status, "planned")));
	return redirectOk(c, `/builds/${data.build.id}`, "started");
});

buildRoutes.post("/:id/cancel", async (c) => {
	const data = await loadBuildData(c);
	if (!data) return notFound(c);
	await c.var.db
		.update(builds)
		.set({ status: "cancelled", updatedAt: nowIso(), updatedBy: c.var.user })
		.where(and(eq(builds.id, data.build.id), inArray(builds.status, OPEN_STATUSES)));
	return redirectOk(c, `/builds/${data.build.id}`, "cancelled");
});

buildRoutes.post("/:id/complete", async (c) => {
	const data = await loadBuildData(c);
	if (!data) return notFound(c);
	const db = c.var.db;
	const { build, part } = data;
	if (!OPEN_STATUSES.includes(build.status)) return c.redirect(`/builds/${build.id}?err=build_not_open`, 303);
	const body = await c.req.parseBody();
	const form: Record<string, string> = {};
	for (const [k, v] of Object.entries(body)) if (typeof v === "string") form[k] = v;
	// Never trust client quantities: re-explode with current stock and the submitted choices.
	const [graph, onHand] = await Promise.all([loadGraph(db), onHandAt(db)]);
	const pick = buildPickList(graph, onHand, build, part, form, true);
	if (Object.keys(pick.errors).length > 0 || pick.problems.length > 0) {
		return renderBuild(c, data, form, { validate: true, status: 422 });
	}
	try {
		await runBatch(db, completionStatements(db, graph, { ...build }, pick, c.var.user, nowIso()));
	} catch (err) {
		// The unique build_output index aborts a second completion of the same build.
		if (isConstraintError(err, "UNIQUE")) return c.redirect(`/builds/${build.id}?err=build_not_open`, 303);
		throw err;
	}
	return redirectOk(c, `/builds/${build.id}`, "completed");
});

/** Recent builds of a part, for the part page. */
export async function recentBuildsOf(c: Context<AppEnv>, partId: number) {
	return listBuilds(c.var.db, { status: "all", partId, limit: 10 });
}
