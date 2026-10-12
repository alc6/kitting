import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { MOVE_REASONS, parts, stockMoves } from "../db/schema";
import { centsOf } from "../domain/bom-graph";
import { getPart, listParts, partOptions } from "../domain/parts";
import { type CountGroup, isStocked, listMoves, moveValues, onHandAt, planCounts, valuation } from "../domain/stock";
import { errorText, fmt } from "../i18n";
import { runBatch } from "../lib/db";
import { formatCentsInput, formatQtyInput, MILLI, parseMilli } from "../lib/units";
import { type FieldErrors, field, validate } from "../lib/validation";
import type { AppEnv } from "../types";
import { useApp } from "../views/context";
import { nowIso, page, translateErrors } from "../views/render";
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
	Qty,
	SearchBar,
	shortDateTime,
	TextField,
} from "../views/ui";
import { csvResponse } from "./import";

export const stockRoutes = new Hono<AppEnv>();

type Tab = "onHand" | "moves" | "count" | "valuation";

function StockTabs(props: { active: Tab }) {
	const { t } = useApp();
	const tabs: { key: Tab; href: string }[] = [
		{ key: "onHand", href: "/stock" },
		{ key: "moves", href: "/stock/moves" },
		{ key: "count", href: "/stock/count" },
		{ key: "valuation", href: "/stock/valuation" },
	];
	return (
		<nav class="tabs">
			{tabs.map((tab) => (
				<a href={tab.href} class={tab.key === props.active ? "active" : undefined}>
					{t.stock.tabs[tab.key]}
				</a>
			))}
		</nav>
	);
}

function StockHeader(props: { tab: Tab }) {
	const { t } = useApp();
	return (
		<>
			<PageHeader title={t.stock.title} actions={<LinkButton href="/stock/adjust" label={t.stock.adjustTitle} />} />
			<StockTabs active={props.tab} />
		</>
	);
}

const dateParam = (v: string | undefined) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

// ---------------------------------------------------------------------------
// On-hand list

const FILTERS = ["all", "below_zero", "below_moq", "in_stock"] as const;
type Filter = (typeof FILTERS)[number];

stockRoutes.get("/", async (c) => {
	const t = c.var.t;
	const q = c.req.query("q") ?? "";
	const filter = (FILTERS as readonly string[]).includes(c.req.query("filter") ?? "")
		? (c.req.query("filter") as Filter)
		: "all";
	const all = (await listParts(c.var.db, { q })).filter((p) => isStocked(p.kind));
	const rows = all.filter((p) => {
		if (filter === "below_zero") return p.onHandMilli < 0;
		if (filter === "below_moq") return p.moqMilli > 0 && p.onHandMilli < p.moqMilli;
		if (filter === "in_stock") return p.onHandMilli > 0;
		return true;
	});
	return page(
		c,
		t.stock.title,
		<>
			<StockHeader tab="onHand" />
			<Flash ok={c.req.query("ok")} message={c.req.query("ok") === "adjusted" ? t.stock.adjusted : undefined} />
			<SearchBar action="/stock" q={q}>
				<select name="filter" aria-label={t.common.filter}>
					{FILTERS.map((f) => (
						<option value={f} selected={f === filter}>
							{t.stock.filters[f]}
						</option>
					))}
				</select>
			</SearchBar>
			<div id="results">
				{rows.length === 0 ? (
					<Empty />
				) : (
					<table class="table">
						<thead>
							<tr>
								<th>{t.parts.ref}</th>
								<th>{t.parts.name}</th>
								<th>{t.parts.kind}</th>
								<th class="num">{t.parts.moq}</th>
								<th class="num">{t.stock.onHand}</th>
								<th class="narrow" />
							</tr>
						</thead>
						<tbody>
							{rows.map((p) => (
								<tr>
									<td>
										<a href={`/parts/${p.id}`}>{p.ref}</a>
									</td>
									<td>{p.name}</td>
									<td>
										<KindBadge kind={p.kind} />
									</td>
									<td class="num">{p.moqMilli ? <Qty milli={p.moqMilli} unit={p.unit} /> : ""}</td>
									<td class={p.moqMilli > 0 && p.onHandMilli < p.moqMilli ? "num warn" : "num"}>
										<Qty milli={p.onHandMilli} unit={p.unit} />
									</td>
									<td class="narrow">
										<a class="button small" href={`/stock/adjust?part=${p.id}`}>
											{t.stock.adjust}
										</a>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</div>
		</>,
	);
});

// ---------------------------------------------------------------------------
// Adjustments

const adjustInput = z.object({
	part: field.required(64),
	qty: field.signedQty(),
	serial: field.text(100),
	note: field.required(500),
});

function AdjustForm(props: { values: FormValues; errors: FormErrors; options: { ref: string; name: string }[] }) {
	const { t } = useApp();
	const p = { values: props.values, errors: props.errors };
	return (
		<form method="post" action="/stock/adjust" class="card form">
			<ErrorBanner show={Object.keys(props.errors).length > 0} />
			<TextField name="part" label={t.stock.part} list="stock-parts" required autofocus {...p} />
			<datalist id="stock-parts">
				{props.options.map((o) => (
					<option value={o.ref}>{o.name}</option>
				))}
			</datalist>
			<div class="grid-2">
				<TextField name="qty" label={t.stock.qty} hint={t.stock.adjustHint} inputmode="decimal" required {...p} />
				<TextField name="serial" label={t.stock.serial} hint={t.stock.serialHint} {...p} />
			</div>
			<TextField name="note" label={t.stock.note} placeholder={t.stock.noteHint} required {...p} />
			<div class="form-actions">
				<button type="submit" class="button primary">
					{t.common.save}
				</button>
				<a class="button secondary" href="/stock">
					{t.common.cancel}
				</a>
			</div>
		</form>
	);
}

async function stockedOptions(c: Context<AppEnv>) {
	return (await partOptions(c.var.db)).filter((o) => isStocked(o.kind));
}

stockRoutes.get("/adjust", async (c) => {
	const t = c.var.t;
	const partParam = c.req.query("part") ?? "";
	const part = /^\d+$/.test(partParam) ? await getPart(c.var.db, Number(partParam)) : undefined;
	return page(
		c,
		t.stock.adjustTitle,
		<>
			<PageHeader title={t.stock.adjustTitle} />
			<AdjustForm values={{ part: part?.ref ?? "" }} errors={{}} options={await stockedOptions(c)} />
		</>,
	);
});

stockRoutes.post("/adjust", async (c) => {
	const t = c.var.t;
	const db = c.var.db;
	const body = await c.req.parseBody();
	const v = validate(adjustInput, body);
	const errors: FieldErrors = v.ok ? {} : { ...v.errors };
	const vars: Record<string, string> = {};
	let part: typeof parts.$inferSelect | undefined;
	if (v.ok) {
		part = (await db.select().from(parts).where(eq(parts.ref, v.data.part)).limit(1))[0];
		if (!part) {
			errors.part = "unknown_part";
			vars.ref = v.data.part;
		} else if (!isStocked(part.kind)) {
			errors.part = "not_stocked";
			vars.kind = part.kind;
		}
		if (v.data.qty === 0) errors.qty = "zero_qty";
		else if (v.data.serial && part?.trackSerial && Math.abs(v.data.qty) !== MILLI) errors.qty = "serial_one";
	}
	if (!v.ok || !part || Object.keys(errors).length > 0) {
		return page(
			c,
			t.stock.adjustTitle,
			<>
				<PageHeader title={t.stock.adjustTitle} />
				<AdjustForm
					values={body as FormValues}
					errors={translateErrors(c, errors, vars)}
					options={await stockedOptions(c)}
				/>
			</>,
			422,
		);
	}
	const user = c.var.user;
	await db
		.insert(stockMoves)
		.values(
			moveValues(
				{ partId: part.id, qtyMilli: v.data.qty, serial: v.data.serial || null, unitCostCents: part.costCents },
				{ reason: "adjust", refType: "adjustment", note: v.data.note, user, now: nowIso() },
			),
		);
	return c.redirect(`/parts/${part.id}?ok=adjusted`, 303);
});

// ---------------------------------------------------------------------------
// Inventory count

stockRoutes.get("/count", async (c) => {
	return renderCount(c, {}, {});
});

async function renderCount(c: Context<AppEnv>, values: FormValues, errors: FieldErrors, status: 200 | 422 = 200) {
	const t = c.var.t;
	const q = c.req.query("q") ?? "";
	const rows = (await listParts(c.var.db, { q })).filter((p) => isStocked(p.kind));
	const done = c.req.query("done");
	return page(
		c,
		t.stock.tabs.count,
		<>
			<StockHeader tab="count" />
			{done ? <Flash message={fmt(t.stock.countDone, { n: done, m: c.req.query("adjusted") ?? "0" })} /> : null}
			<p>{t.stock.countIntro}</p>
			<SearchBar action="/stock/count" q={q} />
			<form method="post" action={`/stock/count${q ? `?q=${encodeURIComponent(q)}` : ""}`} class="form">
				<ErrorBanner show={Object.keys(errors).length > 0} />
				<div id="results">
					<table class="table">
						<thead>
							<tr>
								<th>{t.parts.ref}</th>
								<th>{t.parts.name}</th>
								<th class="num">{t.stock.onHand}</th>
								<th class="num">{t.stock.counted}</th>
							</tr>
						</thead>
						<tbody>
							{rows.map((p) => {
								const name = `count_${p.id}`;
								return (
									<tr class={errors[name] ? "has-error" : undefined}>
										<td>
											<a href={`/parts/${p.id}`}>{p.ref}</a>
										</td>
										<td>
											{p.name}
											{errors[name] ? <div class="error small">{errorText(t, errors[name] ?? "")}</div> : null}
										</td>
										<td class="num">
											<Qty milli={p.onHandMilli} unit={p.unit} />
										</td>
										<td class="num">
											<input
												type="text"
												name={name}
												inputmode="decimal"
												class="qty"
												value={values[name] ?? ""}
												aria-label={`${t.stock.counted} ${p.ref}`}
											/>
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
				<TextField name="note" label={t.stock.note} values={values} errors={translateErrors(c, errors)} />
				<div class="form-actions">
					<button type="submit" class="button primary">
						{t.stock.postCount}
					</button>
				</div>
			</form>
		</>,
		status,
	);
}

stockRoutes.post("/count", async (c) => {
	const db = c.var.db;
	const body = await c.req.parseBody();
	const values: FormValues = {};
	const errors: FieldErrors = {};
	const entries: { partId: number; qty: number; line: number }[] = [];
	let line = 0;
	for (const [key, raw] of Object.entries(body)) {
		const m = /^count_(\d+)$/.exec(key);
		if (!m || typeof raw !== "string") continue;
		values[key] = raw;
		line++;
		if (raw.trim() === "") continue;
		const qty = parseMilli(raw);
		if (qty === null) errors[key] = "invalid_quantity";
		else if (qty < 0) errors[key] = "negative";
		else entries.push({ partId: Number(m[1]), qty, line });
	}
	const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) : "";
	values.note = note;
	if (Object.keys(errors).length > 0) return renderCount(c, values, errors, 422);

	const [allParts, onHand] = await Promise.all([db.select().from(parts), onHandAt(db)]);
	const byId = new Map(allParts.map((p) => [p.id, p]));
	const groups: CountGroup[] = [];
	for (const e of entries) {
		const part = byId.get(e.partId);
		if (!part || !isStocked(part.kind)) continue;
		groups.push({ part, lines: [{ line: e.line, qtyMilli: e.qty, serial: "", unitCostCents: null }] });
	}
	const { moves, results } = planCounts(groups, onHand);
	const user = c.var.user;
	const now = nowIso();
	await runBatch(
		db,
		moves.map((m) =>
			db
				.insert(stockMoves)
				.values(moveValues(m, { reason: "count", refType: "count", note: note || "inventory count", user, now })),
		),
	);
	return c.redirect(`/stock/count?done=${results.length}&adjusted=${moves.length}`, 303);
});

// ---------------------------------------------------------------------------
// Moves ledger

stockRoutes.get("/moves", async (c) => {
	const t = c.var.t;
	const q = c.req.query("q") ?? "";
	const reason = c.req.query("reason") ?? "";
	const from = dateParam(c.req.query("from"));
	const to = dateParam(c.req.query("to"));
	const csv = c.req.query("format") === "csv";
	const limit = csv ? 100_000 : 300;
	const rows = await listMoves(c.var.db, { q, reason, from, to, limit });
	if (csv) {
		const locale = c.var.locale;
		return csvResponse(c, `stock-moves-${nowIso().slice(0, 10)}.csv`, [
			["at", "ref", "name", "reason", "qty", "unit", "serial", "unit_cost", "ref_type", "ref_id", "by", "note"],
			...rows.map(({ move: m, ref, name, unit }) => [
				m.at,
				ref,
				name,
				m.reason,
				formatQtyInput(m.qtyMilli, locale),
				unit,
				m.serial ?? "",
				m.unitCostCents === null ? "" : formatCentsInput(m.unitCostCents, locale),
				m.refType ?? "",
				m.refId ?? "",
				m.by,
				m.note,
			]),
		]);
	}
	const query = new URLSearchParams({ q, reason, from: from ?? "", to: to ?? "", format: "csv" }).toString();
	return page(
		c,
		t.stock.tabs.moves,
		<>
			<StockHeader tab="moves" />
			<SearchBar action="/stock/moves" q={q}>
				<select name="reason" aria-label={t.stock.reason}>
					<option value="">{t.stock.reasonAll}</option>
					{MOVE_REASONS.map((r) => (
						<option value={r} selected={r === reason}>
							{t.reasons[r]}
						</option>
					))}
				</select>
				<label class="inline-field">
					<span>{t.stock.from}</span>
					<input type="date" name="from" value={from ?? ""} />
				</label>
				<label class="inline-field">
					<span>{t.stock.to}</span>
					<input type="date" name="to" value={to ?? ""} />
				</label>
			</SearchBar>
			<div id="results">
				{rows.length === 0 ? (
					<Empty />
				) : (
					<div class="scroll-x">
						<table class="table">
							<thead>
								<tr>
									<th>{t.stock.at}</th>
									<th>{t.parts.ref}</th>
									<th>{t.stock.reason}</th>
									<th class="num">{t.stock.qty}</th>
									<th>{t.stock.serial}</th>
									<th>{t.stock.by}</th>
									<th>{t.common.notes}</th>
								</tr>
							</thead>
							<tbody>
								{rows.map(({ move: m, ref, unit }) => (
									<tr>
										<td class="nowrap">{shortDateTime(m.at)}</td>
										<td>
											<a href={`/parts/${m.partId}`}>{ref}</a>
										</td>
										<td>
											<MoveReference reason={m.reason} refType={m.refType} refId={m.refId} />
										</td>
										<td class="num">
											<Qty milli={m.qtyMilli} unit={unit} />
										</td>
										<td>{m.serial ?? ""}</td>
										<td>{m.by}</td>
										<td>{m.note}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
				{rows.length === limit ? <p class="muted small">{fmt(t.stock.limitNote, { n: limit })}</p> : null}
			</div>
			<p class="links">
				<a href={`/stock/moves?${query}`}>{t.stock.downloadCsv}</a>
			</p>
		</>,
	);
});

/** Reason label, linked to the document that caused the move when there is one. */
export function MoveReference(props: {
	reason: (typeof MOVE_REASONS)[number];
	refType: string | null;
	refId: number | null;
}) {
	const { t } = useApp();
	const label = t.reasons[props.reason];
	if (props.refType === "build" && props.refId) return <a href={`/builds/${props.refId}`}>{label}</a>;
	if (props.refType === "po" && props.refId) return <a href={`/purchasing/po/${props.refId}`}>{label}</a>;
	return <span>{label}</span>;
}

// ---------------------------------------------------------------------------
// Valuation

stockRoutes.get("/valuation", async (c) => {
	const t = c.var.t;
	const at = dateParam(c.req.query("at"));
	const v = await valuation(c.var.db, at);
	if (c.req.query("format") === "csv") {
		const locale = c.var.locale;
		return csvResponse(c, `stock-valuation-${at ?? nowIso().slice(0, 10)}.csv`, [
			["ref", "name", "kind", "unit", "on_hand", "unit_cost", "cost_source", "value", "incomplete"],
			...v.rows.map((r) => [
				r.part.ref,
				r.part.name,
				r.part.kind,
				r.part.unit,
				formatQtyInput(r.onHandMilli, locale),
				formatCentsInput(centsOf(r.unitMillicents), locale),
				r.source,
				formatCentsInput(r.valueCents, locale),
				r.incomplete ? "yes" : "",
			]),
			["", "", "", "", "", "", "total", formatCentsInput(v.totalCents, locale), v.incomplete ? "yes" : ""],
		]);
	}
	return page(
		c,
		t.stock.tabs.valuation,
		<>
			<StockHeader tab="valuation" />
			<form method="get" action="/stock/valuation" class="toolbar">
				<label class="inline-field">
					<span>{t.stock.asOf}</span>
					<input type="date" name="at" value={at ?? ""} />
				</label>
				<button type="submit" class="button secondary">
					{t.boms.update}
				</button>
				<small class="hint">{t.stock.asOfHint}</small>
			</form>
			{v.incomplete ? <p class="flash warning">{t.stock.valuationIncomplete}</p> : null}
			<div class="scroll-x">
				<table class="table">
					<thead>
						<tr>
							<th>{t.parts.ref}</th>
							<th>{t.parts.name}</th>
							<th class="num">{t.stock.onHand}</th>
							<th class="num">{t.stock.unitCost}</th>
							<th class="num">{t.stock.value}</th>
						</tr>
					</thead>
					<tbody>
						{v.rows.map((r) => (
							<tr>
								<td>
									<a href={`/parts/${r.part.id}`}>{r.part.ref}</a>
								</td>
								<td>
									{r.part.name} <span class="muted small">({t.stock.source[r.source]})</span>
								</td>
								<td class="num">
									<Qty milli={r.onHandMilli} unit={r.part.unit} />
								</td>
								<td class="num">
									<Money cents={centsOf(r.unitMillicents)} />
									{r.incomplete ? <span class="warn"> *</span> : null}
								</td>
								<td class="num">
									<Money cents={r.valueCents} />
								</td>
							</tr>
						))}
					</tbody>
					<tfoot>
						<tr>
							<td colspan={4}>{t.stock.totalValue}</td>
							<td class="num">
								<Money cents={v.totalCents} />
							</td>
						</tr>
					</tfoot>
				</table>
			</div>
			<p class="links">
				<a href={`/stock/valuation?${new URLSearchParams({ at: at ?? "", format: "csv" })}`}>{t.stock.downloadCsv}</a>
			</p>
		</>,
	);
});
