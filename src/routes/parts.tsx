import { asc, desc, eq } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { PART_KINDS, type Part, parts, stockMoves, suppliers } from "../db/schema";
import { partBomSummary, type WhereUsedRow, whereUsed } from "../domain/boms";
import {
	findRefClash,
	getPart,
	hasBoms,
	hasStockMoves,
	listParts,
	onHandOf,
	partColumns,
	partInput,
	partRuleErrors,
	partToForm,
} from "../domain/parts";
import { fmt } from "../i18n";
import { isConstraintError } from "../lib/sql";
import { type FieldErrors, validate } from "../lib/validation";
import { requireAdmin } from "../middleware/auth";
import type { AppEnv } from "../types";
import { CostView, StatusBadge } from "../views/bom";
import { useApp } from "../views/context";
import { idParam, notFound, nowIso, page, redirectOk, translateErrors } from "../views/render";
import {
	CheckboxField,
	DecimalField,
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
import { MoveReference } from "./stock";

export const partRoutes = new Hono<AppEnv>();

type PartRow = Awaited<ReturnType<typeof listParts>>[number];
type SupplierOption = { id: number; name: string };

async function supplierOptions(c: Context<AppEnv>): Promise<SupplierOption[]> {
	return c.var.db.select({ id: suppliers.id, name: suppliers.name }).from(suppliers).orderBy(asc(suppliers.name));
}

function PartsTable(props: { rows: PartRow[] }) {
	const { t } = useApp();
	if (props.rows.length === 0) return <Empty />;
	return (
		<table class="table">
			<thead>
				<tr>
					<th>{t.parts.ref}</th>
					<th>{t.parts.name}</th>
					<th>{t.parts.kind}</th>
					<th>{t.parts.supplier}</th>
					<th class="num">{t.parts.cost}</th>
					<th class="num">{t.parts.onHand}</th>
				</tr>
			</thead>
			<tbody>
				{props.rows.map((p) => (
					<tr class={p.archived ? "archived" : undefined}>
						<td>
							<a href={`/parts/${p.id}`}>{p.ref}</a>
						</td>
						<td>
							{p.name}
							{p.trackSerial ? <span class="tag">S/N</span> : null}
							{p.archived ? <span class="tag">{t.common.archivedLabel}</span> : null}
						</td>
						<td>
							<KindBadge kind={p.kind} />
						</td>
						<td>{p.supplierName ?? ""}</td>
						<td class="num">
							<Money cents={p.costCents} />
						</td>
						<td class="num">
							{p.kind === "buy" || p.kind === "make" ? <Qty milli={p.onHandMilli} unit={p.unit} /> : null}
						</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}

function PartForm(props: {
	action: string;
	values: FormValues;
	errors: FormErrors;
	suppliers: SupplierOption[];
	submit: string;
	cancel: string;
}) {
	const { t } = useApp();
	const p = { values: props.values, errors: props.errors };
	return (
		<form method="post" action={props.action} class="card form">
			<ErrorBanner show={Object.keys(props.errors).length > 0} />
			<div class="grid-2">
				<TextField name="ref" label={t.parts.ref} required autofocus {...p} />
				<SelectField
					name="kind"
					label={t.parts.kind}
					required
					options={PART_KINDS.map((k) => ({ value: k, label: `${t.kinds[k]} (${k}): ${t.kindHelp[k]}` }))}
					{...p}
				/>
			</div>
			<TextField name="name" label={t.parts.name} required {...p} />
			<div class="grid-3">
				<TextField name="unit" label={t.parts.unit} placeholder="pcs" list="units" {...p} />
				<DecimalField name="cost" label={t.parts.cost} hint={t.parts.costHint} {...p} />
				<CheckboxField name="track_serial" label={t.parts.trackSerial} {...p} />
			</div>
			<datalist id="units">
				{["pcs", "m", "kg", "g", "l", "m2", "set"].map((u) => (
					<option value={u} />
				))}
			</datalist>
			<fieldset>
				<legend>{t.parts.purchasing}</legend>
				<div class="grid-2">
					<SelectField
						name="supplier_id"
						label={t.parts.supplier}
						options={[
							{ value: "", label: t.parts.noSupplier },
							...props.suppliers.map((s) => ({ value: String(s.id), label: s.name })),
						]}
						{...p}
					/>
					<TextField name="supplier_ref" label={t.parts.supplierRef} {...p} />
				</div>
				<div class="grid-3">
					<DecimalField name="moq" label={t.parts.moq} {...p} />
					<DecimalField name="pack_size" label={t.parts.packSize} {...p} />
					<TextField name="lead_days" label={t.parts.leadDays} inputmode="numeric" {...p} />
				</div>
			</fieldset>
			<TextArea name="notes" label={t.common.notes} {...p} />
			<div class="form-actions">
				<button type="submit" class="button primary">
					{props.submit}
				</button>
				<a class="button secondary" href={props.cancel}>
					{t.common.cancel}
				</a>
			</div>
		</form>
	);
}

/** Validates a part form, including uniqueness and kind/serial rules. */
async function validatePart(c: Context<AppEnv>, body: Record<string, unknown>, existing?: Part) {
	const result = validate(partInput, body);
	if (!result.ok) return { ok: false as const, errors: result.errors };
	const d = result.data;
	const errors: FieldErrors = {};
	const clash = await findRefClash(c.var.db, d.ref, existing?.id);
	if (clash) {
		if (clash.ref === d.ref) errors.ref = "duplicate_ref";
		else errors.ref = "ref_case";
	}
	const hasMoves = existing ? await hasStockMoves(c.var.db, existing.id) : false;
	const ownsBoms = existing ? await hasBoms(c.var.db, existing.id) : false;
	Object.assign(errors, partRuleErrors({ kind: d.kind, trackSerial: d.track_serial }, { hasMoves, hasBoms: ownsBoms }));
	if (Object.keys(errors).length > 0) return { ok: false as const, errors, clashRef: clash?.ref };
	return { ok: true as const, data: d };
}

partRoutes.get("/", async (c) => {
	const t = c.var.t;
	const q = c.req.query("q") ?? "";
	const kind = c.req.query("kind") ?? "";
	const supplierParam = c.req.query("supplier") ?? "";
	const supplierId = /^\d+$/.test(supplierParam) ? Number(supplierParam) : null;
	const archived = c.req.query("archived") === "on";
	const [rows, sups] = await Promise.all([listParts(c.var.db, { q, kind, supplierId, archived }), supplierOptions(c)]);
	return page(
		c,
		t.parts.title,
		<>
			<PageHeader title={t.parts.title} actions={<LinkButton href="/parts/new" label={t.parts.new} />} />
			<Flash ok={c.req.query("ok")} />
			<SearchBar action="/parts" q={q}>
				<select name="kind" aria-label={t.parts.kind}>
					<option value="">
						{t.parts.kind}: {t.common.all}
					</option>
					{PART_KINDS.map((k) => (
						<option value={k} selected={k === kind}>
							{t.kinds[k]}
						</option>
					))}
				</select>
				<select name="supplier" aria-label={t.parts.supplier}>
					<option value="">
						{t.parts.supplier}: {t.common.all}
					</option>
					{sups.map((s) => (
						<option value={String(s.id)} selected={s.id === supplierId}>
							{s.name}
						</option>
					))}
				</select>
				<label class="check">
					<input type="checkbox" name="archived" value="on" checked={archived} />
					<span>{t.parts.showArchived}</span>
				</label>
			</SearchBar>
			<div id="results">
				<p class="muted">{fmt(t.common.results, { n: rows.length })}</p>
				<PartsTable rows={rows} />
			</div>
		</>,
	);
});

partRoutes.get("/new", async (c) => {
	const t = c.var.t;
	return page(
		c,
		t.parts.new,
		<>
			<PageHeader title={t.parts.new} />
			<PartForm
				action="/parts"
				values={{ kind: "buy", unit: "pcs" }}
				errors={{}}
				suppliers={await supplierOptions(c)}
				submit={t.common.create}
				cancel="/parts"
			/>
		</>,
	);
});

partRoutes.post("/", async (c) => {
	const t = c.var.t;
	const body = await c.req.parseBody();
	const v = await validatePart(c, body);
	if (!v.ok) {
		return page(
			c,
			t.parts.new,
			<>
				<PageHeader title={t.parts.new} />
				<PartForm
					action="/parts"
					values={body as FormValues}
					errors={translateErrors(c, v.errors, { ref: v.clashRef ?? "" })}
					suppliers={await supplierOptions(c)}
					submit={t.common.create}
					cancel="/parts"
				/>
			</>,
			422,
		);
	}
	const user = c.var.user;
	const [row] = await c.var.db
		.insert(parts)
		.values({ ...partColumns(v.data), createdBy: user, updatedBy: user })
		.returning({ id: parts.id });
	return redirectOk(c, `/parts/${row?.id}`);
});

function PartDetail(props: {
	part: Part;
	supplier: { id: number; name: string; email: string; phone: string } | undefined;
	onHand: number;
	moves: (typeof stockMoves.$inferSelect)[];
	bomSummary: Awaited<ReturnType<typeof partBomSummary>>;
	usedIn: WhereUsedRow[];
	ok?: string | undefined;
	err?: string | undefined;
}) {
	const { t, isAdmin } = useApp();
	const p = props.part;
	const stocked = p.kind === "buy" || p.kind === "make";
	return (
		<>
			<PageHeader
				title={`${p.ref} · ${p.name}`}
				subtitle={
					<>
						<KindBadge kind={p.kind} /> {t.kindHelp[p.kind]}
						{p.archived ? <span class="tag">{t.common.archivedLabel}</span> : null}
					</>
				}
				actions={
					<>
						<LinkButton href={`/parts/${p.id}/edit`} label={t.common.edit} variant="secondary" />
						{isAdmin ? (
							p.archived ? (
								<PostButton action={`/parts/${p.id}/unarchive`} label={t.common.unarchive} />
							) : (
								<PostButton
									action={`/parts/${p.id}/archive`}
									label={t.common.archive}
									confirm={t.common.confirmArchive}
								/>
							)
						) : null}
						{isAdmin ? (
							<PostButton
								action={`/parts/${p.id}/delete`}
								label={t.common.delete}
								confirm={t.common.confirmDelete}
								variant="danger"
							/>
						) : null}
					</>
				}
			/>
			<Flash ok={props.ok} message={props.ok === "adjusted" ? t.stock.adjusted : undefined} />
			{props.err === "in_use" ? <p class="flash error">{t.errors.in_use}</p> : null}
			<div class="cards">
				{stocked ? (
					<section class="card stat">
						<h2>{t.parts.onHand}</h2>
						<p class="big">
							<Qty milli={props.onHand} unit={p.unit} />
						</p>
						<p>
							<a class="button small" href={`/stock/adjust?part=${p.id}`}>
								{t.stock.adjust}
							</a>
						</p>
					</section>
				) : null}
				<section class="card">
					<h2>{t.parts.info}</h2>
					<dl class="dl">
						<dt>{t.parts.unit}</dt>
						<dd>{p.unit}</dd>
						<dt>{t.parts.cost}</dt>
						<dd>
							<Money cents={p.costCents} />
						</dd>
						<dt>{t.parts.trackSerial}</dt>
						<dd>{p.trackSerial ? t.common.yes : t.common.no}</dd>
						{p.notes ? (
							<>
								<dt>{t.common.notes}</dt>
								<dd class="pre">{p.notes}</dd>
							</>
						) : null}
					</dl>
				</section>
				<section class="card">
					<h2>{t.parts.purchasing}</h2>
					<dl class="dl">
						<dt>{t.parts.supplier}</dt>
						<dd>
							{props.supplier ? <a href={`/suppliers/${props.supplier.id}`}>{props.supplier.name}</a> : t.common.none}
						</dd>
						{props.supplier?.email ? (
							<>
								<dt>{t.suppliers.email}</dt>
								<dd>
									<a href={`mailto:${props.supplier.email}`}>{props.supplier.email}</a>
								</dd>
							</>
						) : null}
						{props.supplier?.phone ? (
							<>
								<dt>{t.suppliers.phone}</dt>
								<dd>{props.supplier.phone}</dd>
							</>
						) : null}
						<dt>{t.parts.supplierRef}</dt>
						<dd>{p.supplierRef || t.common.none}</dd>
						<dt>{t.parts.moq}</dt>
						<dd>
							<Qty milli={p.moqMilli} unit={p.unit} />
						</dd>
						<dt>{t.parts.packSize}</dt>
						<dd>{p.packSizeMilli ? <Qty milli={p.packSizeMilli} unit={p.unit} /> : t.common.none}</dd>
						<dt>{t.parts.leadDays}</dt>
						<dd>{p.leadDays}</dd>
					</dl>
				</section>
			</div>
			{p.kind === "make" || p.kind === "kit" ? <PartBoms part={p} summary={props.bomSummary} /> : null}
			<WhereUsed rows={props.usedIn} />
			{stocked ? (
				<section class="card">
					<h2>{t.parts.history}</h2>
					<MovesTable moves={props.moves} unit={p.unit} />
				</section>
			) : null}
			<p class="muted small">
				{fmt(t.common.createdBy, { by: p.createdBy, at: shortDateTime(p.createdAt) })} ·{" "}
				{fmt(t.common.updatedBy, { by: p.updatedBy, at: shortDateTime(p.updatedAt) })}
			</p>
		</>
	);
}

function PartBoms(props: { part: Part; summary: Awaited<ReturnType<typeof partBomSummary>> }) {
	const { t } = useApp();
	const { summary } = props;
	return (
		<section class="card">
			<div class="section-header">
				<h2>{t.parts.boms}</h2>
				<LinkButton href={`/boms/new?part=${props.part.id}`} label={t.boms.new} variant="secondary" />
			</div>
			{summary.rollup ? (
				<p>
					{t.boms.totalCost}: <CostView cost={summary.rollup} refs={summary.refs} long />
				</p>
			) : null}
			{summary.boms.length === 0 ? (
				<Empty>{t.boms.noBoms}</Empty>
			) : (
				<table class="table">
					<thead>
						<tr>
							<th>{t.boms.code}</th>
							<th>{t.boms.revision}</th>
							<th>{t.boms.status}</th>
							<th class="num">{t.boms.totalCost}</th>
						</tr>
					</thead>
					<tbody>
						{summary.boms.map((b) => (
							<tr>
								<td>
									<a href={`/boms/${b.id}`}>{b.code}</a>
								</td>
								<td>{b.revision}</td>
								<td>
									<StatusBadge status={b.status} />
								</td>
								<td class="num">
									<CostView cost={b.cost} refs={summary.refs} />
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</section>
	);
}

function WhereUsed(props: { rows: WhereUsedRow[] }) {
	const { t } = useApp();
	return (
		<section class="card">
			<h2>{t.parts.whereUsed}</h2>
			{props.rows.length === 0 ? (
				<Empty />
			) : (
				<table class="table">
					<thead>
						<tr>
							<th>{t.boms.parent}</th>
							<th>{t.boms.code}</th>
							<th>{t.boms.revision}</th>
							<th>{t.boms.status}</th>
							<th>{t.boms.level}</th>
							<th class="num">{t.boms.qty}</th>
						</tr>
					</thead>
					<tbody>
						{props.rows.map((r) => (
							<tr>
								<td>
									<a href={`/boms/${r.bomId}`}>{r.parentRef}</a> {r.parentName}
								</td>
								<td>{r.code}</td>
								<td>{r.revision}</td>
								<td>
									<StatusBadge status={r.status} />
								</td>
								<td>{r.depth === 1 ? t.boms.direct : fmt(t.boms.via, { ref: r.viaRef })}</td>
								<td class="num">{r.depth === 1 ? <Qty milli={r.qtyMilli} /> : null}</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</section>
	);
}

export function MovesTable(props: { moves: (typeof stockMoves.$inferSelect)[]; unit: string }) {
	const { t } = useApp();
	if (props.moves.length === 0) return <Empty />;
	return (
		<table class="table">
			<thead>
				<tr>
					<th>{t.stock.at}</th>
					<th>{t.stock.reason}</th>
					<th class="num">{t.stock.qty}</th>
					<th>{t.stock.serial}</th>
					<th>{t.stock.by}</th>
					<th>{t.common.notes}</th>
				</tr>
			</thead>
			<tbody>
				{props.moves.map((m) => (
					<tr>
						<td>{shortDateTime(m.at)}</td>
						<td>
							<MoveReference reason={m.reason} refType={m.refType} refId={m.refId} />
						</td>
						<td class="num">
							<Qty milli={m.qtyMilli} unit={props.unit} />
						</td>
						<td>{m.serial ?? ""}</td>
						<td>{m.by}</td>
						<td>{m.note}</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}

partRoutes.get("/:id", async (c) => {
	const id = idParam(c);
	const part = id ? await getPart(c.var.db, id) : undefined;
	if (!part) return notFound(c);
	const db = c.var.db;
	const [supplierRows, onHand, moves, bomSummary, usedIn] = await Promise.all([
		part.supplierId
			? db
					.select({ id: suppliers.id, name: suppliers.name, email: suppliers.email, phone: suppliers.phone })
					.from(suppliers)
					.where(eq(suppliers.id, part.supplierId))
			: Promise.resolve([]),
		onHandOf(db, part.id),
		db
			.select()
			.from(stockMoves)
			.where(eq(stockMoves.partId, part.id))
			.orderBy(desc(stockMoves.at), desc(stockMoves.id))
			.limit(100),
		partBomSummary(db, part.id),
		whereUsed(db, part.id),
	]);
	return page(
		c,
		part.ref,
		<PartDetail
			part={part}
			supplier={supplierRows[0]}
			onHand={onHand}
			moves={moves}
			bomSummary={bomSummary}
			usedIn={usedIn}
			ok={c.req.query("ok")}
			err={c.req.query("err")}
		/>,
	);
});

partRoutes.get("/:id/edit", async (c) => {
	const t = c.var.t;
	const id = idParam(c);
	const part = id ? await getPart(c.var.db, id) : undefined;
	if (!part) return notFound(c);
	return page(
		c,
		t.parts.edit,
		<>
			<PageHeader title={`${t.parts.edit}: ${part.ref}`} />
			<PartForm
				action={`/parts/${part.id}`}
				values={partToForm(part, c.var.locale)}
				errors={{}}
				suppliers={await supplierOptions(c)}
				submit={t.common.save}
				cancel={`/parts/${part.id}`}
			/>
		</>,
	);
});

partRoutes.post("/:id", async (c) => {
	const t = c.var.t;
	const id = idParam(c);
	const part = id ? await getPart(c.var.db, id) : undefined;
	if (!part) return notFound(c);
	const body = await c.req.parseBody();
	const v = await validatePart(c, body, part);
	if (!v.ok) {
		return page(
			c,
			t.parts.edit,
			<>
				<PageHeader title={`${t.parts.edit}: ${part.ref}`} />
				<PartForm
					action={`/parts/${part.id}`}
					values={body as FormValues}
					errors={translateErrors(c, v.errors, { ref: v.clashRef ?? "" })}
					suppliers={await supplierOptions(c)}
					submit={t.common.save}
					cancel={`/parts/${part.id}`}
				/>
			</>,
			422,
		);
	}
	await c.var.db
		.update(parts)
		.set({ ...partColumns(v.data), updatedAt: nowIso(), updatedBy: c.var.user })
		.where(eq(parts.id, part.id));
	return redirectOk(c, `/parts/${part.id}`);
});

for (const [action, archived] of [
	["archive", true],
	["unarchive", false],
] as const) {
	partRoutes.post(`/:id/${action}`, requireAdmin, async (c) => {
		const id = idParam(c);
		if (!id) return notFound(c);
		await c.var.db.update(parts).set({ archived, updatedAt: nowIso(), updatedBy: c.var.user }).where(eq(parts.id, id));
		return redirectOk(c, `/parts/${id}`, archived ? "archived" : "unarchived");
	});
}

partRoutes.post("/:id/delete", requireAdmin, async (c) => {
	const id = idParam(c);
	if (!id) return notFound(c);
	try {
		await c.var.db.delete(parts).where(eq(parts.id, id));
	} catch (err) {
		if (isConstraintError(err, "FOREIGN KEY")) return c.redirect(`/parts/${id}?err=in_use`, 303);
		throw err;
	}
	return redirectOk(c, "/parts", "deleted");
});
