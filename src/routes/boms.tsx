import { and, asc, eq, sql } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { BOM_STATUSES, type Bom, bomLines, boms, type Part, parts } from "../db/schema";
import { type Cost, CostCalculator, centsOf, type ExplodedNode, type Explosion, explode } from "../domain/bom-graph";
import {
	activateStatements,
	bomInput,
	bomLineInput,
	createBomStatements,
	DEFAULT_CODE,
	DEFAULT_REVISION,
	findBom,
	getBom,
	getBomLines,
	listBoms,
	loadGraph,
	nextRevision,
	wouldCreateCycle,
} from "../domain/boms";
import { onHandMap, partOptions } from "../domain/parts";
import { errorText, fmt } from "../i18n";
import { runBatch } from "../lib/db";
import { isConstraintError } from "../lib/sql";
import { formatCentsInput, formatQtyInput, MILLI, parseMilli, roundDiv } from "../lib/units";
import { type FieldErrors, validate } from "../lib/validation";
import { requireAdmin } from "../middleware/auth";
import type { AppEnv } from "../types";
import { CostView, StatusBadge } from "../views/bom";
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
	TextArea,
	TextField,
} from "../views/ui";
import { csvResponse } from "./import";

export const bomRoutes = new Hono<AppEnv>();

type BomRow = Awaited<ReturnType<typeof listBoms>>[number];
type LineRow = Awaited<ReturnType<typeof getBomLines>>[number];

function qtyParam(c: Context<AppEnv>): number {
	const n = parseMilli(c.req.query("qty") ?? "1");
	return n !== null && n > 0 ? n : MILLI;
}

function BomTabs(props: { bom: Bom; active: "editor" | "tree" | "explode" }) {
	const { t } = useApp();
	const tabs = [
		{ key: "editor", href: `/boms/${props.bom.id}`, label: t.boms.editor },
		{ key: "tree", href: `/boms/${props.bom.id}/tree`, label: t.boms.tree },
		{ key: "explode", href: `/boms/${props.bom.id}/explode`, label: t.boms.explode },
	];
	return (
		<nav class="tabs">
			{tabs.map((tab) => (
				<a href={tab.href} class={tab.key === props.active ? "active" : undefined}>
					{tab.label}
				</a>
			))}
		</nav>
	);
}

function BomHeader(props: { bom: Bom; part: Part; tab: "editor" | "tree" | "explode" }) {
	const { t, isAdmin } = useApp();
	const { bom, part } = props;
	return (
		<>
			<PageHeader
				title={`${part.ref} · ${part.name}`}
				subtitle={
					<>
						<KindBadge kind={part.kind} /> {t.boms.code}: <strong>{bom.code}</strong> · {t.boms.revision}:{" "}
						<strong>{bom.revision}</strong> · <StatusBadge status={bom.status} />
					</>
				}
				actions={
					<>
						{bom.status !== "active" ? (
							<PostButton action={`/boms/${bom.id}/activate`} label={t.boms.activate} />
						) : null}
						{bom.status === "archived" ? <PostButton action={`/boms/${bom.id}/draft`} label={t.boms.toDraft} /> : null}
						<PostButton action={`/boms/${bom.id}/revision`} label={t.boms.newRevision} />
						<LinkButton
							href={`/boms/new?part=${part.id}&copy_from=${bom.id}`}
							label={t.boms.newVariant}
							variant="secondary"
						/>
						{isAdmin && bom.status !== "archived" ? (
							<PostButton action={`/boms/${bom.id}/archive`} label={t.boms.archive} confirm={t.common.confirmArchive} />
						) : null}
						{isAdmin ? (
							<PostButton
								action={`/boms/${bom.id}/delete`}
								label={t.common.delete}
								confirm={t.common.confirmDelete}
								variant="danger"
							/>
						) : null}
					</>
				}
			/>
			<BomTabs bom={bom} active={props.tab} />
		</>
	);
}

// ---------------------------------------------------------------------------
// List

function BomList(props: { rows: BomRow[]; q: string; status: string }) {
	const { t } = useApp();
	return (
		<>
			<PageHeader title={t.boms.title} actions={<LinkButton href="/boms/new" label={t.boms.new} />} />
			<SearchBar action="/boms" q={props.q}>
				<select name="status" aria-label={t.boms.status}>
					<option value="">{t.boms.statusFilter.open}</option>
					{BOM_STATUSES.map((s) => (
						<option value={s} selected={s === props.status}>
							{t.boms.statuses[s]}
						</option>
					))}
					<option value="all" selected={props.status === "all"}>
						{t.boms.statusFilter.all}
					</option>
				</select>
			</SearchBar>
			<div id="results">
				{props.rows.length === 0 ? (
					<Empty>{t.boms.noBoms}</Empty>
				) : (
					<table class="table">
						<thead>
							<tr>
								<th>{t.boms.parent}</th>
								<th>{t.boms.code}</th>
								<th>{t.boms.revision}</th>
								<th>{t.boms.status}</th>
								<th class="num">{t.boms.lines}</th>
							</tr>
						</thead>
						<tbody>
							{props.rows.map((b) => (
								<tr>
									<td>
										<a href={`/boms/${b.id}`}>{b.partRef}</a> {b.partName}
									</td>
									<td>{b.code}</td>
									<td>{b.revision}</td>
									<td>
										<StatusBadge status={b.status} />
									</td>
									<td class="num">{b.lineCount}</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</div>
		</>
	);
}

bomRoutes.get("/", async (c) => {
	const q = c.req.query("q") ?? "";
	const status = c.req.query("status") ?? "";
	const rows = await listBoms(c.var.db, { q, status });
	return page(c, c.var.t.boms.title, <BomList rows={rows} q={q} status={status} />);
});

// ---------------------------------------------------------------------------
// Create

type ParentOption = { id: number; ref: string; name: string };
type SourceOption = { id: number; label: string };

function NewBomForm(props: {
	values: FormValues;
	errors: FormErrors;
	parents: ParentOption[];
	sources: SourceOption[];
}) {
	const { t } = useApp();
	const p = { values: props.values, errors: props.errors };
	return (
		<form method="post" action="/boms" class="card form">
			<ErrorBanner show={Object.keys(props.errors).length > 0} />
			<SelectField
				name="parent_part_id"
				label={t.boms.parent}
				hint={t.boms.parentHint}
				required
				options={[
					{ value: "", label: "—" },
					...props.parents.map((o) => ({ value: String(o.id), label: `${o.ref} · ${o.name}` })),
				]}
				{...p}
			/>
			<div class="grid-2">
				<TextField name="code" label={t.boms.code} hint={t.boms.codeHint} required {...p} />
				<TextField name="revision" label={t.boms.revision} required {...p} />
			</div>
			<SelectField
				name="copy_from"
				label={t.boms.copyFrom}
				options={[
					{ value: "", label: t.boms.copyNone },
					...props.sources.map((s) => ({ value: String(s.id), label: s.label })),
				]}
				{...p}
			/>
			<TextArea name="notes" label={t.common.notes} {...p} />
			<div class="form-actions">
				<button type="submit" class="button primary">
					{t.common.create}
				</button>
				<a class="button secondary" href="/boms">
					{t.common.cancel}
				</a>
			</div>
		</form>
	);
}

async function newBomOptions(c: Context<AppEnv>) {
	const [parents, all] = await Promise.all([
		partOptions(c.var.db, ["make", "kit"]),
		listBoms(c.var.db, { status: "all" }),
	]);
	const sources = all.map((b) => ({ id: b.id, label: `${b.partRef} · ${b.code} · ${b.revision}` }));
	return { parents, sources };
}

bomRoutes.get("/new", async (c) => {
	const t = c.var.t;
	const { parents, sources } = await newBomOptions(c);
	const values: FormValues = {
		parent_part_id: c.req.query("part") ?? "",
		code: DEFAULT_CODE,
		revision: DEFAULT_REVISION,
		copy_from: c.req.query("copy_from") ?? "",
	};
	if (values.copy_from) values.code = "";
	return page(
		c,
		t.boms.new,
		<>
			<PageHeader title={t.boms.new} />
			<NewBomForm values={values} errors={{}} parents={parents} sources={sources} />
		</>,
	);
});

bomRoutes.post("/", async (c) => {
	const t = c.var.t;
	const db = c.var.db;
	const body = await c.req.parseBody();
	const v = validate(bomInput, body);
	const errors: FieldErrors = v.ok ? {} : { ...v.errors };
	if (v.ok) {
		const parentId = v.data.parent_part_id;
		const parent = parentId ? (await db.select().from(parts).where(eq(parts.id, parentId)).limit(1))[0] : undefined;
		if (!parent) errors.parent_part_id = "required";
		else if (parent.kind !== "make" && parent.kind !== "kit") errors.parent_part_id = "bom_parent_kind";
		else if (await findBom(db, parent.id, v.data.code, v.data.revision)) errors.revision = "duplicate_bom";
		if (v.data.copy_from && parent) {
			// Copying lines from another parent's BoM must not create a cycle.
			const src = await getBomLines(db, v.data.copy_from);
			for (const line of src) {
				if (await wouldCreateCycle(db, parent.id, line.partId)) {
					errors.copy_from = "bom_cycle";
					break;
				}
			}
		}
	}
	if (!v.ok || Object.keys(errors).length > 0) {
		const { parents, sources } = await newBomOptions(c);
		return page(
			c,
			t.boms.new,
			<>
				<PageHeader title={t.boms.new} />
				<NewBomForm
					values={body as FormValues}
					errors={translateErrors(c, errors, { ref: "", parent: "" })}
					parents={parents}
					sources={sources}
				/>
			</>,
			422,
		);
	}
	const d = v.data;
	const user = c.var.user;
	const now = nowIso();
	await runBatch(
		db,
		createBomStatements(
			db,
			{ parentPartId: d.parent_part_id as number, code: d.code, revision: d.revision, notes: d.notes },
			d.copy_from,
			user,
			now,
		),
	);
	const created = await findBom(db, d.parent_part_id as number, d.code, d.revision);
	return redirectOk(c, `/boms/${created?.id}`);
});

// ---------------------------------------------------------------------------
// Editor

async function loadBom(c: Context<AppEnv>) {
	const id = idParam(c);
	return id ? getBom(c.var.db, id) : undefined;
}

function LinesEditor(props: {
	bom: Bom;
	part: Part;
	lines: LineRow[];
	costs: Map<number, Cost>;
	total: Cost;
	refs: Map<number, string>;
	options: { ref: string; name: string }[];
	values: FormValues;
	errors: FormErrors;
}) {
	const { t, locale } = useApp();
	const { bom } = props;
	const editable = bom.status !== "archived";
	const hx = {
		"hx-target": "#bom-lines",
		"hx-select": "#bom-lines",
		"hx-swap": "outerHTML",
	};
	return (
		<section id="bom-lines" class="card">
			{bom.status === "active" ? <p class="flash warning">{t.boms.activeWarning}</p> : null}
			{bom.status === "archived" ? <p class="flash">{t.boms.archivedNote}</p> : null}
			{props.lines.length === 0 ? (
				<Empty />
			) : (
				<div class="scroll-x">
					<table class="table lines">
						<thead>
							<tr>
								{editable ? <th class="narrow" /> : null}
								<th>{t.boms.component}</th>
								<th>{t.parts.kind}</th>
								<th class="num">{t.boms.qty}</th>
								<th class="num">{t.boms.unitCost}</th>
								<th class="num">{t.boms.lineCost}</th>
								{editable ? <th class="narrow" /> : null}
							</tr>
						</thead>
						<tbody>
							{props.lines.map((l, i) => {
								const cost = props.costs.get(l.partId);
								return (
									<tr>
										{editable ? (
											<td class="narrow nowrap">
												<form
													method="post"
													action={`/boms/${bom.id}/lines/${l.id}/move`}
													class="inline"
													hx-post={`/boms/${bom.id}/lines/${l.id}/move`}
													{...hx}
												>
													<input type="hidden" name="dir" value="up" />
													<button
														type="submit"
														class="button small icon"
														disabled={i === 0}
														aria-label={t.boms.moveUp}
														title={t.boms.moveUp}
													>
														↑
													</button>
												</form>
												<form
													method="post"
													action={`/boms/${bom.id}/lines/${l.id}/move`}
													class="inline"
													hx-post={`/boms/${bom.id}/lines/${l.id}/move`}
													{...hx}
												>
													<input type="hidden" name="dir" value="down" />
													<button
														type="submit"
														class="button small icon"
														disabled={i === props.lines.length - 1}
														aria-label={t.boms.moveDown}
														title={t.boms.moveDown}
													>
														↓
													</button>
												</form>
											</td>
										) : null}
										<td>
											<a href={`/parts/${l.partId}`}>{l.ref}</a> {l.name}
											{l.archived ? <span class="tag">{t.common.archivedLabel}</span> : null}
											{l.notes ? <div class="muted small">{l.notes}</div> : null}
										</td>
										<td>
											<KindBadge kind={l.kind} />
										</td>
										<td class="num">
											{editable ? (
												<form
													method="post"
													action={`/boms/${bom.id}/lines/${l.id}`}
													class="qty-form"
													hx-post={`/boms/${bom.id}/lines/${l.id}`}
													hx-trigger="change"
													{...hx}
												>
													<input
														type="text"
														name="qty"
														inputmode="decimal"
														value={formatQtyInput(l.qtyMilli, locale)}
														aria-label={`${t.boms.qty} ${l.ref}`}
														data-select-on-focus
														class="qty"
													/>
													<span class="unit">{l.unit !== "pcs" ? l.unit : ""}</span>
													<button type="submit" class="button small">
														{t.common.save}
													</button>
												</form>
											) : (
												<Qty milli={l.qtyMilli} unit={l.unit} />
											)}
										</td>
										<td class="num">{cost ? <CostView cost={cost} refs={props.refs} /> : null}</td>
										<td class="num">
											{cost ? <Money cents={centsOf(roundDiv(l.qtyMilli * cost.millicents, MILLI))} /> : null}
										</td>
										{editable ? (
											<td class="narrow">
												<form
													method="post"
													action={`/boms/${bom.id}/lines/${l.id}/delete`}
													class="inline"
													hx-post={`/boms/${bom.id}/lines/${l.id}/delete`}
													{...hx}
												>
													<button
														type="submit"
														class="button small icon danger"
														aria-label={t.boms.remove}
														title={t.boms.remove}
													>
														✕
													</button>
												</form>
											</td>
										) : null}
									</tr>
								);
							})}
						</tbody>
						<tfoot>
							<tr>
								<td colspan={editable ? 5 : 4}>{t.boms.totalCost}</td>
								<td class="num">
									<CostView cost={props.total} refs={props.refs} />
								</td>
								{editable ? <td /> : null}
							</tr>
						</tfoot>
					</table>
				</div>
			)}
			{props.total.incomplete ? (
				<p class="warn small">
					{fmt(t.boms.incomplete, { refs: props.total.missing.map((id) => props.refs.get(id) ?? id).join(", ") })}
				</p>
			) : null}
			{editable ? (
				<form method="post" action={`/boms/${bom.id}/lines`} class="add-line" hx-post={`/boms/${bom.id}/lines`} {...hx}>
					<ErrorBanner show={Object.keys(props.errors).length > 0} />
					<div class="add-line-grid">
						<TextField
							name="component"
							label={t.boms.component}
							placeholder={t.boms.componentHint}
							list="part-refs"
							required
							values={props.values}
							errors={props.errors}
						/>
						<TextField
							name="qty"
							label={t.boms.qty}
							inputmode="decimal"
							required
							values={props.values}
							errors={props.errors}
						/>
						<TextField name="notes" label={t.common.notes} values={props.values} errors={props.errors} />
						<div class="field">
							<span class="label-spacer" />
							<button type="submit" class="button primary">
								{t.boms.addLine}
							</button>
						</div>
					</div>
					<datalist id="part-refs">
						{props.options.map((o) => (
							<option value={o.ref}>{o.name}</option>
						))}
					</datalist>
				</form>
			) : null}
		</section>
	);
}

async function renderEditor(
	c: Context<AppEnv>,
	data: { bom: Bom; part: Part },
	form: { values: FormValues; errors: FieldErrors; vars?: Record<string, string> } = {
		values: { qty: "1" },
		errors: {},
	},
	status: 200 | 422 = 200,
) {
	const db = c.var.db;
	const { bom, part } = data;
	const [lines, graph, options, siblings] = await Promise.all([
		getBomLines(db, bom.id),
		loadGraph(db),
		partOptions(db),
		db
			.select({ id: boms.id, code: boms.code, revision: boms.revision, status: boms.status })
			.from(boms)
			.where(eq(boms.parentPartId, part.id))
			.orderBy(asc(boms.code), asc(boms.revision)),
	]);
	const calc = new CostCalculator(graph);
	const costs = new Map(lines.map((l) => [l.partId, calc.part(l.partId)]));
	const total = calc.bom(bom.id);
	const refs = new Map([...graph.parts.values()].map((p) => [p.id, p.ref]));
	const t = c.var.t;
	return page(
		c,
		`${part.ref} ${bom.code} ${bom.revision}`,
		<>
			<BomHeader bom={bom} part={part} tab="editor" />
			<Flash ok={c.req.query("ok")} message={c.req.query("ok") === "activated" ? t.boms.activated : undefined} />
			{c.req.query("err") ? <p class="flash error">{errorText(t, c.req.query("err") ?? "")}</p> : null}
			<LinesEditor
				bom={bom}
				part={part}
				lines={lines}
				costs={costs}
				total={total}
				refs={refs}
				options={options.filter((o) => o.id !== part.id)}
				values={form.values}
				errors={translateErrors(c, form.errors, form.vars)}
			/>
			<div class="cards">
				<section class="card">
					<h2>{t.boms.revisions}</h2>
					<ul class="plain">
						{siblings
							.filter((s) => s.code === bom.code)
							.map((s) => (
								<li>
									{s.id === bom.id ? <strong>{s.revision}</strong> : <a href={`/boms/${s.id}`}>{s.revision}</a>}{" "}
									<StatusBadge status={s.status} />
								</li>
							))}
					</ul>
				</section>
				<section class="card">
					<h2>{t.boms.variants}</h2>
					<ul class="plain">
						{siblings
							.filter((s) => s.status === "active")
							.map((s) => (
								<li>
									{s.id === bom.id ? <strong>{s.code}</strong> : <a href={`/boms/${s.id}`}>{s.code}</a>} ({s.revision})
								</li>
							))}
					</ul>
				</section>
				{bom.notes ? (
					<section class="card">
						<h2>{t.common.notes}</h2>
						<p class="pre">{bom.notes}</p>
					</section>
				) : null}
			</div>
		</>,
		status,
	);
}

bomRoutes.get("/:id", async (c) => {
	const data = await loadBom(c);
	if (!data) return notFound(c);
	return renderEditor(c, data);
});

bomRoutes.post("/:id/lines", async (c) => {
	const data = await loadBom(c);
	if (!data) return notFound(c);
	const db = c.var.db;
	const { bom, part } = data;
	const body = await c.req.parseBody();
	const values = body as FormValues;
	if (bom.status === "archived") return renderEditor(c, data, { values, errors: { component: "bom_archived" } }, 422);
	const v = validate(bomLineInput, body);
	const errors: FieldErrors = v.ok ? {} : { ...v.errors };
	const vars: Record<string, string> = {};
	let componentId: number | undefined;
	if (v.ok) {
		const ref = v.data.component.split(/\s+[—·-]\s+/)[0]?.trim() ?? "";
		const comp = (await db.select().from(parts).where(eq(parts.ref, ref)).limit(1))[0];
		if (!comp) {
			errors.component = "unknown_part";
			vars.ref = ref;
		} else if (comp.archived) errors.component = "archived_part";
		else if (comp.trackSerial && v.data.qty % MILLI !== 0) errors.qty = "serial_whole_qty";
		else if (await wouldCreateCycle(db, part.id, comp.id)) {
			errors.component = "bom_cycle";
			vars.ref = comp.ref;
			vars.parent = part.ref;
		} else componentId = comp.id;
	}
	if (!v.ok || componentId === undefined) return renderEditor(c, data, { values, errors, vars }, 422);
	const user = c.var.user;
	await db.insert(bomLines).values({
		bomId: bom.id,
		componentPartId: componentId,
		qtyMilli: v.data.qty,
		notes: v.data.notes,
		position: sql`(SELECT COALESCE(MAX(position), 0) + 1 FROM bom_lines WHERE bom_id = ${bom.id})`,
		createdBy: user,
		updatedBy: user,
	});
	await touchBom(c, bom.id);
	return c.redirect(`/boms/${bom.id}`, 303);
});

async function touchBom(c: Context<AppEnv>, bomId: number) {
	await c.var.db.update(boms).set({ updatedAt: nowIso(), updatedBy: c.var.user }).where(eq(boms.id, bomId));
}

async function editableLine(c: Context<AppEnv>) {
	const data = await loadBom(c);
	const lineId = idParam(c, "lineId");
	if (!data || !lineId) return undefined;
	const line = (
		await c.var.db
			.select()
			.from(bomLines)
			.where(and(eq(bomLines.id, lineId), eq(bomLines.bomId, data.bom.id)))
			.limit(1)
	)[0];
	return line ? { ...data, line } : undefined;
}

bomRoutes.post("/:id/lines/:lineId", async (c) => {
	const data = await editableLine(c);
	if (!data) return notFound(c);
	if (data.bom.status === "archived") return c.redirect(`/boms/${data.bom.id}?err=bom_archived`, 303);
	const body = await c.req.parseBody();
	const qty = parseMilli(typeof body.qty === "string" ? body.qty : "");
	if (qty === null || qty <= 0) return c.redirect(`/boms/${data.bom.id}?err=invalid_quantity`, 303);
	const comp = (await c.var.db.select().from(parts).where(eq(parts.id, data.line.componentPartId)).limit(1))[0];
	if (comp?.trackSerial && qty % MILLI !== 0) return c.redirect(`/boms/${data.bom.id}?err=serial_whole_qty`, 303);
	await c.var.db
		.update(bomLines)
		.set({ qtyMilli: qty, updatedAt: nowIso(), updatedBy: c.var.user })
		.where(eq(bomLines.id, data.line.id));
	await touchBom(c, data.bom.id);
	return c.redirect(`/boms/${data.bom.id}`, 303);
});

bomRoutes.post("/:id/lines/:lineId/delete", async (c) => {
	const data = await editableLine(c);
	if (!data) return notFound(c);
	if (data.bom.status === "archived") return c.redirect(`/boms/${data.bom.id}?err=bom_archived`, 303);
	await c.var.db.delete(bomLines).where(eq(bomLines.id, data.line.id));
	await touchBom(c, data.bom.id);
	return c.redirect(`/boms/${data.bom.id}`, 303);
});

bomRoutes.post("/:id/lines/:lineId/move", async (c) => {
	const data = await editableLine(c);
	if (!data) return notFound(c);
	if (data.bom.status === "archived") return c.redirect(`/boms/${data.bom.id}?err=bom_archived`, 303);
	const body = await c.req.parseBody();
	const dir = body.dir === "up" ? -1 : 1;
	const lines = await getBomLines(c.var.db, data.bom.id);
	const idx = lines.findIndex((l) => l.id === data.line.id);
	const other = lines[idx + dir];
	if (idx >= 0 && other) {
		// Renumber 1..n with the two lines swapped, in one batch.
		const order = lines.map((l) => l.id);
		[order[idx], order[idx + dir]] = [other.id, data.line.id];
		const now = nowIso();
		await runBatch(
			c.var.db,
			order.map((id, i) =>
				c.var.db
					.update(bomLines)
					.set({ position: i + 1, updatedAt: now, updatedBy: c.var.user })
					.where(eq(bomLines.id, id)),
			),
		);
	}
	return c.redirect(`/boms/${data.bom.id}`, 303);
});

// ---------------------------------------------------------------------------
// Status changes, revisions, delete

bomRoutes.post("/:id/activate", async (c) => {
	const data = await loadBom(c);
	if (!data) return notFound(c);
	const { bom, part } = data;
	if (part.kind !== "make" && part.kind !== "kit") return c.redirect(`/boms/${bom.id}?err=bom_parent_kind`, 303);
	// An archived BoM may predate newer BoMs: re-check cycles before it counts again.
	if (bom.status === "archived") {
		for (const line of await getBomLines(c.var.db, bom.id)) {
			if (await wouldCreateCycle(c.var.db, part.id, line.partId))
				return c.redirect(`/boms/${bom.id}?err=bom_cycle`, 303);
		}
	}
	await runBatch(c.var.db, activateStatements(c.var.db, bom, c.var.user, nowIso()));
	return redirectOk(c, `/boms/${bom.id}`, "activated");
});

bomRoutes.post("/:id/draft", async (c) => {
	const data = await loadBom(c);
	if (!data) return notFound(c);
	const { bom, part } = data;
	if (bom.status === "archived") {
		for (const line of await getBomLines(c.var.db, bom.id)) {
			if (await wouldCreateCycle(c.var.db, part.id, line.partId))
				return c.redirect(`/boms/${bom.id}?err=bom_cycle`, 303);
		}
	}
	await c.var.db
		.update(boms)
		.set({ status: "draft", updatedAt: nowIso(), updatedBy: c.var.user })
		.where(eq(boms.id, bom.id));
	return redirectOk(c, `/boms/${bom.id}`);
});

bomRoutes.post("/:id/archive", requireAdmin, async (c) => {
	const data = await loadBom(c);
	if (!data) return notFound(c);
	await c.var.db
		.update(boms)
		.set({ status: "archived", updatedAt: nowIso(), updatedBy: c.var.user })
		.where(eq(boms.id, data.bom.id));
	return redirectOk(c, `/boms/${data.bom.id}`, "archived");
});

bomRoutes.post("/:id/revision", async (c) => {
	const data = await loadBom(c);
	if (!data) return notFound(c);
	const { bom } = data;
	const db = c.var.db;
	const taken = await db
		.select({ revision: boms.revision })
		.from(boms)
		.where(and(eq(boms.parentPartId, bom.parentPartId), eq(boms.code, bom.code)));
	const revision = nextRevision(
		bom.revision,
		taken.map((r) => r.revision),
	);
	await runBatch(
		db,
		createBomStatements(
			db,
			{ parentPartId: bom.parentPartId, code: bom.code, revision, notes: bom.notes },
			bom.id,
			c.var.user,
			nowIso(),
		),
	);
	const created = await findBom(db, bom.parentPartId, bom.code, revision);
	return redirectOk(c, `/boms/${created?.id}`);
});

bomRoutes.post("/:id/delete", requireAdmin, async (c) => {
	const data = await loadBom(c);
	if (!data) return notFound(c);
	try {
		await c.var.db.delete(boms).where(eq(boms.id, data.bom.id));
	} catch (err) {
		if (isConstraintError(err, "FOREIGN KEY")) return c.redirect(`/boms/${data.bom.id}?err=in_use`, 303);
		throw err;
	}
	return redirectOk(c, `/parts/${data.part.id}`, "deleted");
});

// ---------------------------------------------------------------------------
// Tree view and exploded list

function QtyForm(props: { action: string; qty: number; stock?: boolean | undefined; showStock?: boolean }) {
	const { t, locale } = useApp();
	return (
		<form method="get" action={props.action} class="toolbar">
			<label class="inline-field">
				<span>{t.boms.forQty}</span>
				<input type="text" name="qty" inputmode="decimal" value={formatQtyInput(props.qty, locale)} class="qty" />
			</label>
			{props.showStock ? (
				<label class="check">
					<input type="checkbox" name="stock" value="on" checked={props.stock} />
					<span>{t.boms.useStock}</span>
				</label>
			) : null}
			<button type="submit" class="button secondary">
				{t.boms.update}
			</button>
		</form>
	);
}

function TreeNode(props: { node: ExplodedNode; calc: CostCalculator; refs: Map<number, string> }) {
	const { t } = useApp();
	const n = props.node;
	const cost = props.calc.part(n.part.id);
	const row = (
		<span class="tree-row">
			<span class="tree-name">
				<a href={`/parts/${n.part.id}`}>{n.part.ref}</a> <span class="muted">{n.part.name}</span>{" "}
				<KindBadge kind={n.part.kind} />
				{n.mode === "missing_bom" ? <span class="tag warn">{t.boms.modes.missing_bom}</span> : null}
			</span>
			<span class="num muted">
				×<Qty milli={n.perParentMilli} unit={n.part.unit} />
			</span>
			<span class="num">
				<strong>
					<Qty milli={n.qtyMilli} unit={n.part.unit} />
				</strong>
			</span>
			<span class="num">
				<CostView cost={cost} refs={props.refs} />
			</span>
			<span class="num">
				<Money cents={centsOf(props.calc.extended(n.part.id, n.qtyMilli))} />
			</span>
		</span>
	);
	if (n.children.length === 0) return <li class="leaf">{row}</li>;
	return (
		<li>
			<details open>
				<summary>{row}</summary>
				<ul>
					{n.children.map((child) => (
						<TreeNode node={child} calc={props.calc} refs={props.refs} />
					))}
				</ul>
			</details>
		</li>
	);
}

bomRoutes.get("/:id/tree", async (c) => {
	const data = await loadBom(c);
	if (!data) return notFound(c);
	const t = c.var.t;
	const qty = qtyParam(c);
	const graph = await loadGraph(c.var.db);
	const calc = new CostCalculator(graph);
	const refs = new Map([...graph.parts.values()].map((p) => [p.id, p.ref]));
	let explosion: Explosion | null = null;
	let error = "";
	try {
		explosion = explode(graph, data.bom.id, qty);
	} catch (err) {
		error = err instanceof Error ? err.message : String(err);
	}
	const unit = calc.bom(data.bom.id);
	return page(
		c,
		`${data.part.ref} · ${t.boms.tree}`,
		<>
			<BomHeader bom={data.bom} part={data.part} tab="tree" />
			<QtyForm action={`/boms/${data.bom.id}/tree`} qty={qty} />
			{error ? <p class="flash error">{error}</p> : null}
			<section class="card">
				<div class="tree-row tree-head">
					<span>{t.boms.component}</span>
					<span class="num">{t.boms.perParent}</span>
					<span class="num">{t.boms.cumulative}</span>
					<span class="num">{t.boms.unitCost}</span>
					<span class="num">{t.boms.lineCost}</span>
				</div>
				<ul class="tree">
					{explosion?.tree.map((n) => (
						<TreeNode node={n} calc={calc} refs={refs} />
					))}
				</ul>
				<div class="tree-row tree-total">
					<span>
						{t.common.total} ({formatQtyInput(qty, c.var.locale)} × {data.part.ref})
					</span>
					<span />
					<span />
					<span class="num">
						<CostView cost={unit} refs={refs} />
					</span>
					<span class="num">
						<Money cents={centsOf(roundDiv(unit.millicents * qty, MILLI))} />
					</span>
				</div>
				{unit.incomplete ? (
					<p class="warn small">
						{fmt(t.boms.incomplete, { refs: unit.missing.map((id) => refs.get(id) ?? id).join(", ") })}
					</p>
				) : null}
			</section>
		</>,
	);
});

bomRoutes.get("/:id/explode", async (c) => {
	const data = await loadBom(c);
	if (!data) return notFound(c);
	const t = c.var.t;
	const qty = qtyParam(c);
	const useStock = c.req.query("stock") === "on";
	const [graph, stock] = await Promise.all([loadGraph(c.var.db), onHandMap(c.var.db)]);
	const calc = new CostCalculator(graph);
	const refs = new Map([...graph.parts.values()].map((p) => [p.id, p.ref]));
	const ex = explode(graph, data.bom.id, qty, useStock ? { stock } : {});
	const rows = ex.requirements.map((r) => {
		const onHand = stock.get(r.part.id) ?? 0;
		return { ...r, onHand, short: Math.max(0, r.qtyMilli - Math.max(0, onHand)), cost: calc.part(r.part.id) };
	});
	if (c.req.query("format") === "csv") {
		const locale = c.var.locale;
		return csvResponse(c, `${data.part.ref}-${data.bom.code}-${data.bom.revision}-x${formatQtyInput(qty)}.csv`, [
			["ref", "name", "kind", "unit", "qty", "on_hand", "short", "unit_cost", "extended_cost"],
			...[...rows, ...ex.fees.map((f) => ({ ...f, onHand: 0, short: 0, cost: calc.part(f.part.id) }))].map((r) => [
				r.part.ref,
				r.part.name,
				r.part.kind,
				r.part.unit,
				formatQtyInput(r.qtyMilli, locale),
				r.part.kind === "fee" ? "" : formatQtyInput(r.onHand, locale),
				r.part.kind === "fee" ? "" : formatQtyInput(r.short, locale),
				r.cost.incomplete ? "" : formatCentsInput(centsOf(r.cost.millicents), locale),
				r.cost.incomplete ? "" : formatCentsInput(centsOf(calc.extended(r.part.id, r.qtyMilli)), locale),
			]),
		]);
	}
	const totalMillicents = [...ex.requirements, ...ex.fees].reduce(
		(s, r) => s + calc.extended(r.part.id, r.qtyMilli),
		0,
	);
	const total = calc.bom(data.bom.id);
	const query = `qty=${encodeURIComponent(formatQtyInput(qty))}${useStock ? "&stock=on" : ""}`;
	return page(
		c,
		`${data.part.ref} · ${t.boms.explode}`,
		<>
			<BomHeader bom={data.bom} part={data.part} tab="explode" />
			<QtyForm action={`/boms/${data.bom.id}/explode`} qty={qty} stock={useStock} showStock />
			{rows
				.filter((r) => r.missingBom)
				.map((r) => (
					<p class="flash warning">{fmt(t.boms.missingBom, { ref: r.part.ref })}</p>
				))}
			<div class="scroll-x">
				<table class="table">
					<thead>
						<tr>
							<th>{t.parts.ref}</th>
							<th>{t.parts.name}</th>
							<th>{t.parts.kind}</th>
							<th class="num">{t.boms.qty}</th>
							<th class="num">{t.boms.onHand}</th>
							<th class="num">{t.boms.short}</th>
							<th class="num">{t.boms.unitCost}</th>
							<th class="num">{t.boms.lineCost}</th>
						</tr>
					</thead>
					<tbody>
						{rows.map((r) => (
							<tr>
								<td>
									<a href={`/parts/${r.part.id}`}>{r.part.ref}</a>
								</td>
								<td>
									{r.part.name}
									{r.part.kind === "make" ? <span class="tag">{t.boms.fromStock}</span> : null}
								</td>
								<td>
									<KindBadge kind={r.part.kind} />
								</td>
								<td class="num">
									<Qty milli={r.qtyMilli} unit={r.part.unit} />
								</td>
								<td class="num">
									<Qty milli={r.onHand} unit={r.part.unit} />
								</td>
								<td class="num">
									{r.short > 0 ? <strong class="negative">{formatQtyInput(r.short, c.var.locale)}</strong> : ""}
								</td>
								<td class="num">
									<CostView cost={r.cost} refs={refs} />
								</td>
								<td class="num">
									<Money cents={centsOf(calc.extended(r.part.id, r.qtyMilli))} />
								</td>
							</tr>
						))}
					</tbody>
					{ex.fees.length ? (
						<tbody>
							<tr>
								<th colspan={8}>{t.boms.fees}</th>
							</tr>
							{ex.fees.map((f) => (
								<tr>
									<td>
										<a href={`/parts/${f.part.id}`}>{f.part.ref}</a>
									</td>
									<td>{f.part.name}</td>
									<td>
										<KindBadge kind={f.part.kind} />
									</td>
									<td class="num">
										<Qty milli={f.qtyMilli} unit={f.part.unit} />
									</td>
									<td />
									<td />
									<td class="num">
										<CostView cost={calc.part(f.part.id)} refs={refs} />
									</td>
									<td class="num">
										<Money cents={centsOf(calc.extended(f.part.id, f.qtyMilli))} />
									</td>
								</tr>
							))}
						</tbody>
					) : null}
					<tfoot>
						<tr>
							<td colspan={7}>{t.common.total}</td>
							<td class="num">
								<Money cents={centsOf(totalMillicents)} />
								{total.incomplete ? <span class="warn"> *</span> : null}
							</td>
						</tr>
					</tfoot>
				</table>
			</div>
			{total.incomplete ? (
				<p class="warn small">
					{fmt(t.boms.incomplete, { refs: total.missing.map((id) => refs.get(id) ?? id).join(", ") })}
				</p>
			) : null}
			<p class="links">
				<a href={`/boms/${data.bom.id}/explode?${query}&format=csv`}>{t.boms.downloadCsv}</a>
			</p>
		</>,
	);
});
