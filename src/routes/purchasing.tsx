import { and, asc, eq, inArray } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { PO_STATUSES, type PoStatus, parts, poLines, purchaseOrders, suppliers } from "../db/schema";
import {
	computeShortages,
	draftPoStatements,
	getPo,
	getPoLines,
	listPos,
	nextPoNumbers,
	OPEN_PO_STATUSES,
	poEditInput,
	poInput,
	poLineInput,
	RECEIVABLE_PO_STATUSES,
	type Receipt,
	receiptStatements,
	type Shortages,
} from "../domain/purchasing";
import { errorText, fmt } from "../i18n";
import { runBatch } from "../lib/db";
import { isConstraintError } from "../lib/sql";
import { formatCentsInput, formatQtyInput, lineCostCents, MILLI, parseCents, parseMilli } from "../lib/units";
import { type FieldErrors, validate } from "../lib/validation";
import { requireAdmin } from "../middleware/auth";
import type { AppEnv } from "../types";
import { useApp } from "../views/context";
import { idParam, notFound, nowIso, page, redirectOk, translateErrors } from "../views/render";
import {
	Empty,
	ErrorBanner,
	Flash,
	type FormErrors,
	type FormValues,
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

export const purchasingRoutes = new Hono<AppEnv>();

type Tab = "shortages" | "pos";

function PurchasingTabs(props: { active: Tab }) {
	const { t } = useApp();
	return (
		<nav class="tabs">
			<a href="/purchasing" class={props.active === "shortages" ? "active" : undefined}>
				{t.purchasing.tabs.shortages}
			</a>
			<a href="/purchasing/po" class={props.active === "pos" ? "active" : undefined}>
				{t.purchasing.tabs.pos}
			</a>
		</nav>
	);
}

export function PoStatusBadge(props: { status: PoStatus }) {
	const { t } = useApp();
	return <span class={`status status-${props.status}`}>{t.purchasing.statuses[props.status]}</span>;
}

// ---------------------------------------------------------------------------
// Shortages

export function ShortageTables(props: { shortages: Shortages; selectable?: boolean }) {
	const { t } = useApp();
	const { shortages } = props;
	return (
		<>
			{shortages.missingBoms.length ? (
				<section class="card warning">
					<h2>{t.purchasing.missingBoms}</h2>
					<ul>
						{shortages.missingBoms.map((m) => (
							<li>
								<strong>{m.ref}</strong> {m.name} × <Qty milli={m.qtyMilli} /> ({m.builds.join(", ")})
							</li>
						))}
					</ul>
				</section>
			) : null}
			{shortages.groups.map((g) => (
				<section class="card">
					<div class="section-header">
						<h2>
							{g.supplierId === null ? (
								<span class="warn">{t.purchasing.unassigned}</span>
							) : props.selectable ? (
								<label class="check">
									<input type="checkbox" name={`supplier_${g.supplierId}`} value="on" checked />
									<span>{g.supplierName}</span>
								</label>
							) : (
								<a href={`/suppliers/${g.supplierId}`}>{g.supplierName}</a>
							)}
						</h2>
						<span class="muted">
							{t.purchasing.estimated}: <Money cents={g.totalCents} />
						</span>
					</div>
					<div class="scroll-x">
						<table class="table">
							<thead>
								<tr>
									<th>{t.purchasing.part}</th>
									<th class="num">{t.purchasing.need}</th>
									<th class="num">{t.purchasing.onHand}</th>
									<th class="num">{t.purchasing.onOrder}</th>
									<th class="num">{t.purchasing.net}</th>
									<th class="num">{t.purchasing.order}</th>
									<th>{t.purchasing.builds}</th>
								</tr>
							</thead>
							<tbody>
								{g.lines.map((l) => (
									<tr>
										<td>
											<a href={`/parts/${l.part.id}`}>{l.part.ref}</a> {l.part.name}
											{l.part.supplierRef ? <div class="muted small">{l.part.supplierRef}</div> : null}
										</td>
										<td class="num">
											<Qty milli={l.needMilli} unit={l.part.unit} />
										</td>
										<td class="num">
											<Qty milli={l.onHandMilli} unit={l.part.unit} />
										</td>
										<td class="num">{l.onOrderMilli ? <Qty milli={l.onOrderMilli} unit={l.part.unit} /> : ""}</td>
										<td class="num warn">
											<Qty milli={l.netMilli} unit={l.part.unit} />
										</td>
										<td class="num">
											<strong>
												<Qty milli={l.orderMilli} unit={l.part.unit} />
											</strong>
										</td>
										<td class="small">{l.builds.join(", ")}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				</section>
			))}
		</>
	);
}

purchasingRoutes.get("/", async (c) => {
	const t = c.var.t;
	const shortages = await computeShortages(c.var.db);
	const orderable = shortages.groups.some((g) => g.supplierId !== null);
	return page(
		c,
		t.purchasing.title,
		<>
			<PageHeader title={t.purchasing.title} />
			<PurchasingTabs active="shortages" />
			<p>{fmt(t.purchasing.shortagesIntro, { n: shortages.buildCount })}</p>
			{shortages.groups.length === 0 && shortages.missingBoms.length === 0 ? (
				<Empty>{t.purchasing.noShortages}</Empty>
			) : (
				<form method="post" action="/purchasing/draft-pos">
					<ShortageTables shortages={shortages} selectable />
					{orderable ? (
						<div class="form-actions">
							<button type="submit" class="button primary">
								{t.purchasing.createDrafts}
							</button>
							<small class="hint">{t.purchasing.createDraftsHint}</small>
						</div>
					) : null}
				</form>
			)}
		</>,
	);
});

purchasingRoutes.post("/draft-pos", async (c) => {
	const db = c.var.db;
	const body = await c.req.parseBody();
	const shortages = await computeShortages(db);
	const groups = shortages.groups.filter((g) => g.supplierId !== null && body[`supplier_${g.supplierId}`] === "on");
	if (groups.length === 0) return c.redirect("/purchasing", 303);
	for (let attempt = 0; ; attempt++) {
		const numbers = await nextPoNumbers(db, groups.length);
		try {
			await runBatch(db, draftPoStatements(db, groups, numbers, c.var.user, nowIso()));
			break;
		} catch (err) {
			if (attempt > 0 || !isConstraintError(err, "UNIQUE")) throw err;
		}
	}
	return c.redirect(`/purchasing/po?created=${groups.length}`, 303);
});

// ---------------------------------------------------------------------------
// Purchase order list and creation

purchasingRoutes.get("/po", async (c) => {
	const t = c.var.t;
	const q = c.req.query("q") ?? "";
	const status = c.req.query("status") ?? "open";
	const rows = await listPos(c.var.db, { q, status });
	const today = nowIso().slice(0, 10);
	const created = c.req.query("created");
	return page(
		c,
		t.purchasing.pos,
		<>
			<PageHeader
				title={t.purchasing.title}
				actions={<LinkButton href="/purchasing/po/new" label={t.purchasing.newPo} />}
			/>
			<PurchasingTabs active="pos" />
			{created ? <Flash message={fmt(t.purchasing.draftsCreated, { n: created })} /> : null}
			<SearchBar action="/purchasing/po" q={q}>
				<select name="status" aria-label={t.purchasing.status}>
					<option value="open">{t.purchasing.statusFilter.open}</option>
					{PO_STATUSES.map((s) => (
						<option value={s} selected={s === status}>
							{t.purchasing.statuses[s]}
						</option>
					))}
					<option value="all" selected={status === "all"}>
						{t.purchasing.statusFilter.all}
					</option>
				</select>
			</SearchBar>
			<div id="results">
				<PoTable rows={rows} today={today} />
			</div>
		</>,
	);
});

export function PoTable(props: { rows: Awaited<ReturnType<typeof listPos>>; today: string }) {
	const { t } = useApp();
	if (props.rows.length === 0) return <Empty>{t.purchasing.noPos}</Empty>;
	return (
		<table class="table">
			<thead>
				<tr>
					<th>{t.purchasing.number}</th>
					<th>{t.purchasing.supplier}</th>
					<th>{t.purchasing.status}</th>
					<th>{t.purchasing.expectedAt}</th>
					<th class="num">{t.purchasing.lines}</th>
					<th class="num">{t.purchasing.total}</th>
				</tr>
			</thead>
			<tbody>
				{props.rows.map((po) => (
					<tr>
						<td>
							<a href={`/purchasing/po/${po.id}`}>{po.number}</a>
						</td>
						<td>{po.supplierName}</td>
						<td>
							<PoStatusBadge status={po.status} />
						</td>
						<td class="nowrap">
							{po.expectedAt ?? ""}
							{po.expectedAt && po.expectedAt < props.today && OPEN_PO_STATUSES.includes(po.status) ? (
								<span class="tag warn">{t.purchasing.overdue}</span>
							) : null}
						</td>
						<td class="num">{po.lineCount}</td>
						<td class="num">
							<Money cents={po.totalCents} />
						</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}

async function supplierOptions(c: Context<AppEnv>) {
	return c.var.db.select({ id: suppliers.id, name: suppliers.name }).from(suppliers).orderBy(asc(suppliers.name));
}

function NewPoForm(props: { values: FormValues; errors: FormErrors; suppliers: { id: number; name: string }[] }) {
	const { t } = useApp();
	const p = { values: props.values, errors: props.errors };
	return (
		<form method="post" action="/purchasing/po" class="card form">
			<ErrorBanner show={Object.keys(props.errors).length > 0} />
			<SelectField
				name="supplier_id"
				label={t.purchasing.supplier}
				required
				options={[{ value: "", label: "—" }, ...props.suppliers.map((s) => ({ value: String(s.id), label: s.name }))]}
				{...p}
			/>
			<TextField name="expected_at" label={t.purchasing.expectedAt} type="date" {...p} />
			<TextArea name="notes" label={t.common.notes} {...p} />
			<div class="form-actions">
				<button type="submit" class="button primary">
					{t.common.create}
				</button>
				<a class="button secondary" href="/purchasing/po">
					{t.common.cancel}
				</a>
			</div>
		</form>
	);
}

purchasingRoutes.get("/po/new", async (c) => {
	const t = c.var.t;
	return page(
		c,
		t.purchasing.newPo,
		<>
			<PageHeader title={t.purchasing.newPo} />
			<NewPoForm
				values={{ supplier_id: c.req.query("supplier") ?? "" }}
				errors={{}}
				suppliers={await supplierOptions(c)}
			/>
		</>,
	);
});

purchasingRoutes.post("/po", async (c) => {
	const t = c.var.t;
	const db = c.var.db;
	const body = await c.req.parseBody();
	const v = validate(poInput, body);
	const errors: FieldErrors = v.ok ? {} : { ...v.errors };
	const sups = await supplierOptions(c);
	if (v.ok && !sups.some((s) => s.id === v.data.supplier_id)) errors.supplier_id = "required";
	if (!v.ok || Object.keys(errors).length > 0) {
		return page(
			c,
			t.purchasing.newPo,
			<>
				<PageHeader title={t.purchasing.newPo} />
				<NewPoForm values={body as FormValues} errors={translateErrors(c, errors)} suppliers={sups} />
			</>,
			422,
		);
	}
	const user = c.var.user;
	for (let attempt = 0; ; attempt++) {
		try {
			const [number] = await nextPoNumbers(db, 1);
			const [row] = await db
				.insert(purchaseOrders)
				.values({
					number: number as string,
					supplierId: v.data.supplier_id as number,
					expectedAt: v.data.expected_at,
					notes: v.data.notes,
					createdBy: user,
					updatedBy: user,
				})
				.returning({ id: purchaseOrders.id });
			return redirectOk(c, `/purchasing/po/${row?.id}`, "created");
		} catch (err) {
			if (attempt > 0 || !isConstraintError(err, "UNIQUE")) throw err;
		}
	}
});

// ---------------------------------------------------------------------------
// Purchase order detail

type PoData = NonNullable<Awaited<ReturnType<typeof getPo>>>;
type PoLineRow = Awaited<ReturnType<typeof getPoLines>>[number];

async function loadPo(c: Context<AppEnv>) {
	const id = idParam(c);
	return id ? getPo(c.var.db, id) : undefined;
}

function DraftLines(props: {
	po: PoData["po"];
	lines: PoLineRow[];
	options: { ref: string; name: string }[];
	values: FormValues;
	errors: FormErrors;
}) {
	const { t, locale } = useApp();
	const { po } = props;
	const hx = { "hx-target": "#po-lines", "hx-select": "#po-lines", "hx-swap": "outerHTML" };
	const total = props.lines.reduce((s, l) => s + lineCostCents(l.line.qtyMilli, l.line.unitPriceCents), 0);
	return (
		<section class="card" id="po-lines">
			{props.lines.length === 0 ? (
				<Empty />
			) : (
				<div class="scroll-x">
					<table class="table lines">
						<thead>
							<tr>
								<th>{t.purchasing.part}</th>
								<th class="num">{t.purchasing.qty}</th>
								<th class="num">{t.purchasing.price}</th>
								<th class="num">{t.purchasing.lineTotal}</th>
								<th class="narrow" />
							</tr>
						</thead>
						<tbody>
							{props.lines.map((l) => (
								<tr>
									<td>
										<a href={`/parts/${l.line.partId}`}>{l.ref}</a> {l.name}
										{l.supplierRef ? <div class="muted small">{l.supplierRef}</div> : null}
									</td>
									<td class="num" colspan={2}>
										<form
											method="post"
											action={`/purchasing/po/${po.id}/lines/${l.line.id}`}
											class="qty-form"
											hx-post={`/purchasing/po/${po.id}/lines/${l.line.id}`}
											hx-trigger="change"
											{...hx}
										>
											<input
												type="text"
												name="qty"
												inputmode="decimal"
												class="qty"
												value={formatQtyInput(l.line.qtyMilli, locale)}
												aria-label={`${t.purchasing.qty} ${l.ref}`}
												data-select-on-focus
											/>
											<span class="unit">{l.unit !== "pcs" ? l.unit : ""}</span>
											<input
												type="text"
												name="price"
												inputmode="decimal"
												class="qty"
												value={formatCentsInput(l.line.unitPriceCents, locale)}
												aria-label={`${t.purchasing.price} ${l.ref}`}
												data-select-on-focus
											/>
											<button type="submit" class="button small">
												{t.common.save}
											</button>
										</form>
									</td>
									<td class="num">
										<Money cents={lineCostCents(l.line.qtyMilli, l.line.unitPriceCents)} />
									</td>
									<td class="narrow">
										<form
											method="post"
											action={`/purchasing/po/${po.id}/lines/${l.line.id}/delete`}
											class="inline"
											hx-post={`/purchasing/po/${po.id}/lines/${l.line.id}/delete`}
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
								</tr>
							))}
						</tbody>
						<tfoot>
							<tr>
								<td colspan={3}>{t.purchasing.total}</td>
								<td class="num">
									<Money cents={total} />
								</td>
								<td />
							</tr>
						</tfoot>
					</table>
				</div>
			)}
			<form
				method="post"
				action={`/purchasing/po/${po.id}/lines`}
				class="add-line"
				hx-post={`/purchasing/po/${po.id}/lines`}
				{...hx}
			>
				<ErrorBanner show={Object.keys(props.errors).length > 0} />
				<div class="add-line-grid">
					<TextField
						name="part"
						label={t.purchasing.part}
						list="po-parts"
						required
						values={props.values}
						errors={props.errors}
					/>
					<TextField
						name="qty"
						label={t.purchasing.qty}
						inputmode="decimal"
						required
						values={props.values}
						errors={props.errors}
					/>
					<TextField
						name="price"
						label={t.purchasing.price}
						hint={t.purchasing.priceHint}
						inputmode="decimal"
						values={props.values}
						errors={props.errors}
					/>
					<div class="field">
						<span class="label-spacer" />
						<button type="submit" class="button primary">
							{t.purchasing.addLine}
						</button>
					</div>
				</div>
				<datalist id="po-parts">
					{props.options.map((o) => (
						<option value={o.ref}>{o.name}</option>
					))}
				</datalist>
			</form>
		</section>
	);
}

function ReceiveForm(props: { po: PoData["po"]; lines: PoLineRow[]; values: FormValues; errors: FieldErrors }) {
	const { t, locale } = useApp();
	const { po } = props;
	return (
		<form method="post" action={`/purchasing/po/${po.id}/receive`} class="card form" id="receive">
			<h2>{t.purchasing.receiveTitle}</h2>
			<p class="muted">{t.purchasing.receiveIntro}</p>
			<ErrorBanner show={Object.keys(props.errors).length > 0} />
			{props.errors._ ? <p class="flash error">{errorText(t, props.errors._)}</p> : null}
			<div class="scroll-x">
				<table class="table">
					<thead>
						<tr>
							<th>{t.purchasing.part}</th>
							<th class="num">{t.purchasing.qty}</th>
							<th class="num">{t.purchasing.received}</th>
							<th class="num">{t.purchasing.receiveNow}</th>
							<th>{t.purchasing.serials}</th>
						</tr>
					</thead>
					<tbody>
						{props.lines.map((l) => {
							const remaining = Math.max(0, l.line.qtyMilli - l.line.receivedQtyMilli);
							const qtyName = `recv_${l.line.id}`;
							const serialName = `serials_${l.line.id}`;
							return (
								<tr>
									<td>
										<a href={`/parts/${l.line.partId}`}>{l.ref}</a> {l.name}
									</td>
									<td class="num">
										<Qty milli={l.line.qtyMilli} unit={l.unit} />
									</td>
									<td class="num">
										<Qty milli={l.line.receivedQtyMilli} unit={l.unit} />
									</td>
									<td class="num">
										<input
											type="text"
											name={qtyName}
											inputmode="decimal"
											class="qty"
											value={props.values[qtyName] ?? (remaining ? formatQtyInput(remaining, locale) : "")}
											aria-label={`${t.purchasing.receiveNow} ${l.ref}`}
											data-select-on-focus
										/>
										{props.errors[qtyName] ? (
											<div class="error small">{errorText(t, props.errors[qtyName] ?? "")}</div>
										) : null}
									</td>
									<td>
										{l.trackSerial ? (
											<>
												<textarea name={serialName} rows={2} aria-label={`${t.purchasing.serials} ${l.ref}`}>
													{props.values[serialName] ?? ""}
												</textarea>
												{props.errors[serialName] ? (
													<div class="error small">
														{errorText(t, props.errors[serialName] ?? "", { n: props.values[qtyName] ?? "" })}
													</div>
												) : null}
											</>
										) : null}
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>
			<div class="form-actions">
				<button type="submit" class="button primary big">
					{t.purchasing.postReceipt}
				</button>
			</div>
		</form>
	);
}

function ReadOnlyLines(props: { lines: PoLineRow[] }) {
	const { t } = useApp();
	const total = props.lines.reduce((s, l) => s + lineCostCents(l.line.qtyMilli, l.line.unitPriceCents), 0);
	return (
		<section class="card">
			<table class="table">
				<thead>
					<tr>
						<th>{t.purchasing.part}</th>
						<th class="num">{t.purchasing.qty}</th>
						<th class="num">{t.purchasing.received}</th>
						<th class="num">{t.purchasing.price}</th>
						<th class="num">{t.purchasing.lineTotal}</th>
					</tr>
				</thead>
				<tbody>
					{props.lines.map((l) => (
						<tr>
							<td>
								<a href={`/parts/${l.line.partId}`}>{l.ref}</a> {l.name}
								{l.supplierRef ? <div class="muted small">{l.supplierRef}</div> : null}
							</td>
							<td class="num">
								<Qty milli={l.line.qtyMilli} unit={l.unit} />
							</td>
							<td class="num">
								<Qty milli={l.line.receivedQtyMilli} unit={l.unit} />
							</td>
							<td class="num">
								<Money cents={l.line.unitPriceCents} />
							</td>
							<td class="num">
								<Money cents={lineCostCents(l.line.qtyMilli, l.line.unitPriceCents)} />
							</td>
						</tr>
					))}
				</tbody>
				<tfoot>
					<tr>
						<td colspan={4}>{t.purchasing.total}</td>
						<td class="num">
							<Money cents={total} />
						</td>
					</tr>
				</tfoot>
			</table>
		</section>
	);
}

async function renderPo(
	c: Context<AppEnv>,
	data: PoData,
	form: {
		lineValues?: FormValues;
		lineErrors?: FieldErrors;
		lineVars?: Record<string, string>;
		receiveValues?: FormValues;
		receiveErrors?: FieldErrors;
	} = {},
	status: 200 | 422 = 200,
) {
	const t = c.var.t;
	const db = c.var.db;
	const { po, supplier } = data;
	const [lines, options] = await Promise.all([
		getPoLines(db, po.id),
		db
			.select({ ref: parts.ref, name: parts.name })
			.from(parts)
			.where(and(eq(parts.archived, false), inArray(parts.kind, ["buy", "make"])))
			.orderBy(asc(parts.ref)),
	]);
	const ok = c.req.query("ok");
	const flash = ok
		? (
				{
					received: t.purchasing.receivedOk,
					sent: t.purchasing.sentOk,
					cancelled: t.purchasing.cancelledOk,
					created: t.purchasing.createdOk,
				} as Record<string, string>
			)[ok]
		: undefined;
	const isDraft = po.status === "draft";
	const canReceive = RECEIVABLE_PO_STATUSES.includes(po.status) && lines.length > 0;
	const anyReceived = lines.some((l) => l.line.receivedQtyMilli > 0);
	return page(
		c,
		`${po.number} · ${supplier.name}`,
		<>
			<PageHeader
				title={`${po.number} · ${supplier.name}`}
				subtitle={
					<>
						<PoStatusBadge status={po.status} />
						{po.sentAt ? ` · ${t.purchasing.sentAt}: ${po.sentAt.slice(0, 10)}` : ""}
						{supplier.email ? (
							<>
								{" "}
								· <a href={`mailto:${supplier.email}`}>{supplier.email}</a>
							</>
						) : null}
					</>
				}
				actions={
					<>
						{isDraft ? <PostButton action={`/purchasing/po/${po.id}/send`} label={t.purchasing.markSent} /> : null}
						{(po.status === "draft" || po.status === "sent") && !anyReceived ? (
							<PostButton
								action={`/purchasing/po/${po.id}/cancel`}
								label={t.purchasing.cancelPo}
								confirm={t.purchasing.confirmCancel}
							/>
						) : null}
						{po.status === "sent" || po.status === "partial" ? (
							<PostButton
								action={`/purchasing/po/${po.id}/close`}
								label={t.purchasing.closePo}
								confirm={t.purchasing.confirmClose}
							/>
						) : null}
						{c.var.isAdmin && isDraft ? (
							<PostButton
								action={`/purchasing/po/${po.id}/delete`}
								label={t.common.delete}
								confirm={t.common.confirmDelete}
								variant="danger"
							/>
						) : null}
					</>
				}
			/>
			<PurchasingTabs active="pos" />
			<Flash message={flash} />
			{c.req.query("err") ? <p class="flash error">{errorText(t, c.req.query("err") ?? "")}</p> : null}
			{isDraft ? (
				<DraftLines
					po={po}
					lines={lines}
					options={options}
					values={form.lineValues ?? {}}
					errors={translateErrors(c, form.lineErrors ?? {}, form.lineVars)}
				/>
			) : (
				<ReadOnlyLines lines={lines} />
			)}
			{canReceive ? (
				<ReceiveForm po={po} lines={lines} values={form.receiveValues ?? {}} errors={form.receiveErrors ?? {}} />
			) : null}
			{po.status !== "cancelled" ? (
				<details class="card">
					<summary>{t.common.edit}</summary>
					<form method="post" action={`/purchasing/po/${po.id}`} class="form">
						<TextField
							name="expected_at"
							label={t.purchasing.expectedAt}
							type="date"
							values={{ expected_at: po.expectedAt ?? "" }}
							errors={{}}
						/>
						<TextArea name="notes" label={t.common.notes} values={{ notes: po.notes }} errors={{}} />
						<div class="form-actions">
							<button type="submit" class="button secondary">
								{t.common.save}
							</button>
						</div>
					</form>
				</details>
			) : null}
			{po.notes ? <p class="pre">{po.notes}</p> : null}
			<p class="links">
				<a href={`/purchasing/po/${po.id}/export.csv`}>{t.purchasing.downloadCsv}</a>
			</p>
		</>,
		status,
	);
}

purchasingRoutes.get("/po/:id", async (c) => {
	const data = await loadPo(c);
	if (!data) return notFound(c);
	return renderPo(c, data);
});

purchasingRoutes.post("/po/:id", async (c) => {
	const data = await loadPo(c);
	if (!data) return notFound(c);
	const v = validate(poEditInput, await c.req.parseBody());
	if (v.ok) {
		await c.var.db
			.update(purchaseOrders)
			.set({ expectedAt: v.data.expected_at, notes: v.data.notes, updatedAt: nowIso(), updatedBy: c.var.user })
			.where(eq(purchaseOrders.id, data.po.id));
	}
	return redirectOk(c, `/purchasing/po/${data.po.id}`);
});

purchasingRoutes.post("/po/:id/lines", async (c) => {
	const data = await loadPo(c);
	if (!data) return notFound(c);
	const db = c.var.db;
	const body = await c.req.parseBody();
	if (data.po.status !== "draft") return c.redirect(`/purchasing/po/${data.po.id}?err=po_not_draft`, 303);
	const v = validate(poLineInput, body);
	const errors: FieldErrors = v.ok ? {} : { ...v.errors };
	const vars: Record<string, string> = {};
	let part: typeof parts.$inferSelect | undefined;
	if (v.ok) {
		part = (await db.select().from(parts).where(eq(parts.ref, v.data.part)).limit(1))[0];
		if (!part) {
			errors.part = "unknown_part";
			vars.ref = v.data.part;
		} else if (part.kind !== "buy" && part.kind !== "make") {
			errors.part = "not_stocked";
			vars.kind = part.kind;
		}
	}
	if (!v.ok || !part || Object.keys(errors).length) {
		return renderPo(c, data, { lineValues: body as FormValues, lineErrors: errors, lineVars: vars }, 422);
	}
	const user = c.var.user;
	await db.insert(poLines).values({
		poId: data.po.id,
		partId: part.id,
		qtyMilli: v.data.qty,
		unitPriceCents: v.data.price ?? part.costCents ?? 0,
		createdBy: user,
		updatedBy: user,
	});
	return c.redirect(`/purchasing/po/${data.po.id}`, 303);
});

async function draftLine(c: Context<AppEnv>) {
	const data = await loadPo(c);
	const lineId = idParam(c, "lineId");
	if (!data || !lineId) return undefined;
	const line = (
		await c.var.db
			.select()
			.from(poLines)
			.where(and(eq(poLines.id, lineId), eq(poLines.poId, data.po.id)))
			.limit(1)
	)[0];
	return line ? { ...data, line } : undefined;
}

purchasingRoutes.post("/po/:id/lines/:lineId", async (c) => {
	const data = await draftLine(c);
	if (!data) return notFound(c);
	if (data.po.status !== "draft") return c.redirect(`/purchasing/po/${data.po.id}?err=po_not_draft`, 303);
	const body = await c.req.parseBody();
	const qty = parseMilli(typeof body.qty === "string" ? body.qty : "");
	const price = parseCents(typeof body.price === "string" ? body.price : "");
	if (qty === null || qty <= 0) return c.redirect(`/purchasing/po/${data.po.id}?err=invalid_quantity`, 303);
	if (price === null || price < 0) return c.redirect(`/purchasing/po/${data.po.id}?err=invalid_money`, 303);
	await c.var.db
		.update(poLines)
		.set({ qtyMilli: qty, unitPriceCents: price, updatedAt: nowIso(), updatedBy: c.var.user })
		.where(eq(poLines.id, data.line.id));
	return c.redirect(`/purchasing/po/${data.po.id}`, 303);
});

purchasingRoutes.post("/po/:id/lines/:lineId/delete", async (c) => {
	const data = await draftLine(c);
	if (!data) return notFound(c);
	if (data.po.status !== "draft") return c.redirect(`/purchasing/po/${data.po.id}?err=po_not_draft`, 303);
	await c.var.db.delete(poLines).where(eq(poLines.id, data.line.id));
	return c.redirect(`/purchasing/po/${data.po.id}`, 303);
});

purchasingRoutes.post("/po/:id/send", async (c) => {
	const data = await loadPo(c);
	if (!data) return notFound(c);
	const lines = await getPoLines(c.var.db, data.po.id);
	if (lines.length === 0) return c.redirect(`/purchasing/po/${data.po.id}?err=po_empty`, 303);
	const now = nowIso();
	await c.var.db
		.update(purchaseOrders)
		.set({ status: "sent", sentAt: now, updatedAt: now, updatedBy: c.var.user })
		.where(and(eq(purchaseOrders.id, data.po.id), eq(purchaseOrders.status, "draft")));
	return redirectOk(c, `/purchasing/po/${data.po.id}`, "sent");
});

purchasingRoutes.post("/po/:id/cancel", async (c) => {
	const data = await loadPo(c);
	if (!data) return notFound(c);
	const lines = await getPoLines(c.var.db, data.po.id);
	if (lines.some((l) => l.line.receivedQtyMilli > 0)) {
		return c.redirect(`/purchasing/po/${data.po.id}?err=po_has_receipts`, 303);
	}
	await c.var.db
		.update(purchaseOrders)
		.set({ status: "cancelled", updatedAt: nowIso(), updatedBy: c.var.user })
		.where(and(eq(purchaseOrders.id, data.po.id), inArray(purchaseOrders.status, ["draft", "sent"])));
	return redirectOk(c, `/purchasing/po/${data.po.id}`, "cancelled");
});

/** Closes a short-shipped PO: the remaining quantities are no longer expected (no stock move). */
purchasingRoutes.post("/po/:id/close", async (c) => {
	const data = await loadPo(c);
	if (!data) return notFound(c);
	await c.var.db
		.update(purchaseOrders)
		.set({ status: "received", updatedAt: nowIso(), updatedBy: c.var.user })
		.where(and(eq(purchaseOrders.id, data.po.id), inArray(purchaseOrders.status, ["sent", "partial"])));
	return redirectOk(c, `/purchasing/po/${data.po.id}`, "closed");
});

purchasingRoutes.post("/po/:id/delete", requireAdmin, async (c) => {
	const data = await loadPo(c);
	if (!data) return notFound(c);
	if (data.po.status !== "draft") return c.redirect(`/purchasing/po/${data.po.id}?err=po_not_draft`, 303);
	await c.var.db.delete(purchaseOrders).where(eq(purchaseOrders.id, data.po.id));
	return c.redirect("/purchasing/po?ok=deleted", 303);
});

purchasingRoutes.post("/po/:id/receive", async (c) => {
	const data = await loadPo(c);
	if (!data) return notFound(c);
	const db = c.var.db;
	if (!RECEIVABLE_PO_STATUSES.includes(data.po.status)) {
		return c.redirect(`/purchasing/po/${data.po.id}?err=po_not_receivable`, 303);
	}
	const body = await c.req.parseBody();
	const values: FormValues = {};
	for (const [k, v] of Object.entries(body)) if (typeof v === "string") values[k] = v;
	const lines = await getPoLines(db, data.po.id);
	const errors: FieldErrors = {};
	const receipts: Receipt[] = [];
	for (const l of lines) {
		const qtyName = `recv_${l.line.id}`;
		const serialName = `serials_${l.line.id}`;
		const raw = (values[qtyName] ?? "").trim();
		if (raw === "") continue;
		const qty = parseMilli(raw);
		if (qty === null) {
			errors[qtyName] = "invalid_quantity";
			continue;
		}
		if (qty < 0) {
			errors[qtyName] = "negative";
			continue;
		}
		if (qty === 0) continue;
		const serials = (values[serialName] ?? "")
			.split(/[\r\n,;]+/)
			.map((s) => s.trim())
			.filter(Boolean);
		if (serials.length > 0) {
			if (qty % MILLI !== 0 || serials.length !== qty / MILLI) errors[serialName] = "serial_count";
			else if (new Set(serials).size !== serials.length) errors[serialName] = "serial_duplicate";
		}
		receipts.push({
			lineId: l.line.id,
			partId: l.line.partId,
			qtyMilli: qty,
			unitPriceCents: l.line.unitPriceCents,
			serials,
		});
	}
	if (Object.keys(errors).length === 0 && receipts.length === 0) errors._ = "nothing_received";
	if (Object.keys(errors).length > 0) {
		return renderPo(c, data, { receiveValues: values, receiveErrors: errors }, 422);
	}
	await runBatch(db, receiptStatements(db, data.po, receipts, c.var.user, nowIso()));
	return redirectOk(c, `/purchasing/po/${data.po.id}`, "received");
});

purchasingRoutes.get("/po/:id/export.csv", async (c) => {
	const data = await loadPo(c);
	if (!data) return notFound(c);
	const locale = c.var.locale;
	const lines = await getPoLines(c.var.db, data.po.id);
	return csvResponse(c, `${data.po.number}.csv`, [
		["supplier_ref", "ref", "name", "qty", "unit", "unit_price", "line_total"],
		...lines.map((l) => [
			l.supplierRef,
			l.ref,
			l.name,
			formatQtyInput(l.line.qtyMilli, locale),
			l.unit,
			formatCentsInput(l.line.unitPriceCents, locale),
			formatCentsInput(lineCostCents(l.line.qtyMilli, l.line.unitPriceCents), locale),
		]),
	]);
});
