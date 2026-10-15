import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { MOVE_REASONS, parts } from "../db/schema";
import { centsOf } from "../domain/assembly-graph";
import { getPart, listParts, partOptions } from "../domain/parts";
import { can } from "../domain/permissions";
import {
	adjustInput,
	adjustmentErrors,
	adjustmentStatement,
	belowMinimum,
	type CountGroup,
	countStatements,
	isStocked,
	listMoves,
	onHandAt,
	planCounts,
	valuation,
} from "../domain/stock";
import { errorText, fmt } from "../i18n";
import { cn } from "../lib/cn";
import { formatCentsInput, formatQtyInput, parseMilli } from "../lib/units";
import { type FieldErrors, validate } from "../lib/validation";
import { requirePermission } from "../middleware/roles";
import type { AppEnv } from "../types";
import { useApp } from "../views/context";
import { type IconNode, icons } from "../views/icons";
import { PartPicker, PartPickerDialog } from "../views/part-picker";
import { nowIso, page, saveChanges, translateErrors } from "../views/render";
import {
	Alert,
	Badge,
	Button,
	Card,
	CardContent,
	CardEmpty,
	FieldGroup,
	Flash,
	type FormErrors,
	type FormValues,
	KindBadge,
	LinkButton,
	LinkTabs,
	Money,
	PageHeader,
	Qty,
	SearchBar,
	StatCard,
	shortDateTime,
	Table,
	TableBody,
	TableCard,
	TableCell,
	TableFooter,
	TableHead,
	TableHeader,
	TableRow,
	TextField,
} from "../views/ui";
import { csvResponse } from "./import";

export const stockRoutes = new Hono<AppEnv>();

type Tab = "onHand" | "moves" | "count" | "valuation";

function StockTabs(props: { active: Tab }) {
	const view = useApp();
	const { t } = view;
	const tabs: { key: Tab; href: string; icon: IconNode; shown: boolean }[] = [
		{ key: "onHand", href: "/stock", icon: icons.boxes, shown: true },
		{ key: "moves", href: "/stock/moves", icon: icons.history, shown: true },
		{ key: "count", href: "/stock/count", icon: icons.clipboardCheck, shown: can(view, "stock.count") },
		{ key: "valuation", href: "/stock/valuation", icon: icons.coins, shown: can(view, "costs.view") },
	];
	return (
		<LinkTabs
			items={tabs
				.filter((tab) => tab.shown)
				.map((tab) => ({
					href: tab.href,
					label: t.stock.tabs[tab.key],
					icon: tab.icon,
					active: tab.key === props.active,
				}))}
		/>
	);
}

function StockHeader(props: { tab: Tab }) {
	const view = useApp();
	const { t } = view;
	return (
		<>
			<PageHeader
				title={t.stock.title}
				actions={
					can(view, "stock.adjust") ? (
						<LinkButton href="/stock/adjust" label={t.stock.adjustTitle} icon={icons.arrowUpDown} />
					) : undefined
				}
			/>
			<StockTabs active={props.tab} />
		</>
	);
}

function CsvButton(props: { href: string }) {
	const { t } = useApp();
	return (
		<Button href={props.href} variant="outline" size="sm" icon={icons.download}>
			{t.stock.downloadCsv}
		</Button>
	);
}

const dateParam = (v: string | undefined) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

// ---------------------------------------------------------------------------
// On-hand list

const FILTERS = ["all", "below_zero", "below_min", "in_stock"] as const;
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
		if (filter === "below_min") return belowMinimum(p);
		if (filter === "in_stock") return p.onHandMilli > 0;
		return true;
	});
	const canAdjust = can(c.var, "stock.adjust");
	return page(
		c,
		t.stock.title,
		<>
			<StockHeader tab="onHand" />
			<Flash ok={c.req.query("ok")} message={c.req.query("ok") === "adjusted" ? t.stock.adjusted : undefined} />
			<SearchBar action="/stock" q={q}>
				<select name="filter" aria-label={t.common.filter} class="w-auto flex-[0_1_220px]">
					{FILTERS.map((f) => (
						<option value={f} selected={f === filter}>
							{t.stock.filters[f]}
						</option>
					))}
				</select>
			</SearchBar>
			<div id="results">
				<TableCard title={fmt(t.common.results, { n: rows.length })}>
					{rows.length === 0 ? (
						<CardEmpty />
					) : (
						<Table>
							<TableHeader class="bg-muted/50">
								<TableRow>
									<TableHead>{t.parts.ref}</TableHead>
									<TableHead>{t.parts.name}</TableHead>
									<TableHead>{t.parts.kind}</TableHead>
									<TableHead class="text-right">{t.parts.minStock}</TableHead>
									<TableHead class="text-right">{t.stock.onHand}</TableHead>
									{canAdjust ? (
										<TableHead class="w-0">
											<span class="sr-only">{t.common.actions}</span>
										</TableHead>
									) : null}
								</TableRow>
							</TableHeader>
							<TableBody>
								{rows.map((p) => {
									const low = belowMinimum(p);
									return (
										<TableRow>
											<TableCell class="font-medium">
												<a href={`/parts/${p.id}`}>{p.ref}</a>
											</TableCell>
											<TableCell>{p.name}</TableCell>
											<TableCell>
												<KindBadge kind={p.kind} />
											</TableCell>
											<TableCell class="text-right text-muted-foreground">
												{p.minStockMilli !== null ? <Qty milli={p.minStockMilli} unit={p.unit} /> : ""}
											</TableCell>
											<TableCell class={cn("text-right whitespace-nowrap", low && "font-medium text-warning")}>
												{low ? (
													<Badge variant="warning" class="mr-2">
														{t.stock.filters.below_min}
													</Badge>
												) : null}
												<Qty milli={p.onHandMilli} unit={p.unit} />
											</TableCell>
											{canAdjust ? (
												<TableCell class="w-0 text-right">
													<Button
														href={`/stock/adjust?part=${p.id}`}
														variant="outline"
														size="sm"
														icon={icons.arrowUpDown}
													>
														{t.stock.adjust}
													</Button>
												</TableCell>
											) : null}
										</TableRow>
									);
								})}
							</TableBody>
						</Table>
					)}
				</TableCard>
			</div>
		</>,
	);
});

// ---------------------------------------------------------------------------
// Adjustments

function AdjustForm(props: { values: FormValues; errors: FormErrors; options: { ref: string; name: string }[] }) {
	const { t } = useApp();
	const p = { values: props.values, errors: props.errors };
	return (
		<Card class="max-w-2xl">
			<CardContent>
				<form method="post" action="/stock/adjust" class="flex flex-col gap-6">
					{Object.keys(props.errors).length > 0 ? (
						<Alert variant="destructive" class="mb-0">
							{t.common.fixErrors}
						</Alert>
					) : null}
					<FieldGroup>
						<PartPicker
							name="part"
							label={t.stock.part}
							listId="stock-parts"
							options={props.options}
							required
							autofocus
							{...p}
						/>
						<div class="grid gap-4 md:grid-cols-2">
							<TextField name="qty" label={t.stock.qty} hint={t.stock.adjustHint} inputmode="decimal" required {...p} />
							<TextField name="serial" label={t.stock.serial} hint={t.stock.serialHint} {...p} />
						</div>
						<TextField name="note" label={t.stock.note} placeholder={t.stock.noteHint} required {...p} />
					</FieldGroup>
					<div class="flex flex-wrap items-center gap-2">
						<Button icon={icons.save}>{t.common.save}</Button>
						<Button href="/stock" variant="outline">
							{t.common.cancel}
						</Button>
					</div>
				</form>
				<PartPickerDialog name="part" scope={{ kinds: ["buy", "make"] }} />
			</CardContent>
		</Card>
	);
}

async function stockedOptions(c: Context<AppEnv>) {
	return (await partOptions(c.var.db)).filter((o) => isStocked(o.kind));
}

stockRoutes.get("/adjust", requirePermission("stock.adjust"), async (c) => {
	const t = c.var.t;
	const partParam = c.req.query("part") ?? "";
	const part = /^\d+$/.test(partParam) ? await getPart(c.var.db, Number(partParam)) : undefined;
	return page(
		c,
		t.stock.adjustTitle,
		<>
			<PageHeader title={t.stock.adjustTitle} subtitle={t.stock.adjustIntro} />
			<AdjustForm values={{ part: part?.ref ?? "" }} errors={{}} options={await stockedOptions(c)} />
		</>,
	);
});

stockRoutes.post("/adjust", requirePermission("stock.adjust"), async (c) => {
	const t = c.var.t;
	const db = c.var.db;
	const body = await c.req.parseBody();
	const v = validate(adjustInput, body);
	const errors: FieldErrors = v.ok ? {} : { ...v.errors };
	let vars: Record<string, string> = {};
	let part: typeof parts.$inferSelect | undefined;
	if (v.ok) {
		part = (await db.select().from(parts).where(eq(parts.ref, v.data.part)).limit(1))[0];
		const problems = adjustmentErrors(part, v.data);
		Object.assign(errors, problems.errors);
		vars = problems.vars;
	}
	if (!v.ok || !part || Object.keys(errors).length > 0) {
		return page(
			c,
			t.stock.adjustTitle,
			<>
				<PageHeader title={t.stock.adjustTitle} subtitle={t.stock.adjustIntro} />
				<AdjustForm
					values={body as FormValues}
					errors={translateErrors(c, errors, vars)}
					options={await stockedOptions(c)}
				/>
			</>,
			422,
		);
	}
	await saveChanges(c, fmt(t.history.summaries.stockAdjust, { ref: part.ref }), [
		adjustmentStatement(
			db,
			{ partId: part.id, qtyMilli: v.data.qty, serial: v.data.serial || null, unitCostCents: part.costCents },
			v.data.note,
			c.var.user,
			nowIso(),
		),
	]);
	return c.redirect(`/parts/${part.id}?ok=adjusted`, 303);
});

// ---------------------------------------------------------------------------
// Inventory count

stockRoutes.get("/count", requirePermission("stock.count"), async (c) => {
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
			<p class="mb-4 max-w-3xl text-sm text-muted-foreground">{t.stock.countIntro}</p>
			<SearchBar action="/stock/count" q={q} />
			<form method="post" action={`/stock/count${q ? `?q=${encodeURIComponent(q)}` : ""}`} class="flex flex-col gap-6">
				{Object.keys(errors).length > 0 ? (
					<Alert variant="destructive" class="mb-0">
						{t.common.fixErrors}
					</Alert>
				) : null}
				<div id="results">
					<TableCard>
						{rows.length === 0 ? (
							<CardEmpty />
						) : (
							<Table>
								<TableHeader class="bg-muted/50">
									<TableRow>
										<TableHead>{t.parts.ref}</TableHead>
										<TableHead>{t.parts.name}</TableHead>
										<TableHead class="text-right">{t.stock.onHand}</TableHead>
										<TableHead class="text-right">{t.stock.counted}</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{rows.map((p) => {
										const name = `count_${p.id}`;
										const error = errors[name];
										return (
											<TableRow class={cn(error && "bg-destructive/5 hover:bg-destructive/10")}>
												<TableCell class="font-medium">
													<a href={`/parts/${p.id}`}>{p.ref}</a>
												</TableCell>
												<TableCell>
													{p.name}
													{error ? <p class="mt-1 text-sm text-destructive">{errorText(t, error)}</p> : null}
												</TableCell>
												<TableCell class="text-right text-muted-foreground">
													<Qty milli={p.onHandMilli} unit={p.unit} />
												</TableCell>
												<TableCell class="w-0 text-right">
													<input
														type="text"
														name={name}
														inputmode="decimal"
														value={values[name] ?? ""}
														aria-label={`${t.stock.counted} ${p.ref}`}
														aria-invalid={error ? "true" : undefined}
														data-select-on-focus
														class="w-28 text-right tabular-nums"
													/>
												</TableCell>
											</TableRow>
										);
									})}
								</TableBody>
							</Table>
						)}
					</TableCard>
				</div>
				<div class="flex flex-col gap-4 md:flex-row md:items-end print:hidden">
					<div class="md:max-w-md md:flex-1">
						<TextField name="note" label={t.stock.note} values={values} errors={translateErrors(c, errors)} />
					</div>
					<Button icon={icons.clipboardCheck}>{t.stock.postCount}</Button>
				</div>
			</form>
		</>,
		status,
	);
}

stockRoutes.post("/count", requirePermission("stock.count"), async (c) => {
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
	await saveChanges(
		c,
		fmt(c.var.t.history.summaries.stockCount, { n: new Set(moves.map((m) => m.partId)).size }),
		countStatements(db, moves, note || "inventory count", c.var.user, nowIso()),
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
				<select name="reason" aria-label={t.stock.reason} class="w-auto flex-[0_1_220px]">
					<option value="">{t.stock.reasonAll}</option>
					{MOVE_REASONS.map((r) => (
						<option value={r} selected={r === reason}>
							{t.reasons[r]}
						</option>
					))}
				</select>
				<label class="inline-flex items-center gap-2 text-sm font-medium">
					<span class="text-muted-foreground">{t.stock.from}</span>
					<input type="date" name="from" value={from ?? ""} class="w-auto" />
				</label>
				<label class="inline-flex items-center gap-2 text-sm font-medium">
					<span class="text-muted-foreground">{t.stock.to}</span>
					<input type="date" name="to" value={to ?? ""} class="w-auto" />
				</label>
			</SearchBar>
			<div id="results">
				<TableCard
					title={fmt(t.common.results, { n: rows.length })}
					action={<CsvButton href={`/stock/moves?${query}`} />}
				>
					{rows.length === 0 ? (
						<CardEmpty />
					) : (
						<Table>
							<TableHeader class="bg-muted/50">
								<TableRow>
									<TableHead>{t.stock.at}</TableHead>
									<TableHead>{t.parts.ref}</TableHead>
									<TableHead>{t.stock.reason}</TableHead>
									<TableHead class="text-right">{t.stock.qty}</TableHead>
									<TableHead>{t.stock.serial}</TableHead>
									<TableHead>{t.stock.by}</TableHead>
									<TableHead>{t.common.notes}</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{rows.map(({ move: m, ref, unit }) => (
									<TableRow>
										<TableCell class="whitespace-nowrap text-muted-foreground tabular-nums">
											{shortDateTime(m.at)}
										</TableCell>
										<TableCell class="font-medium">
											<a href={`/parts/${m.partId}`}>{ref}</a>
										</TableCell>
										<TableCell>
											<MoveReference reason={m.reason} refType={m.refType} refId={m.refId} />
										</TableCell>
										<TableCell class="text-right">
											<Qty milli={m.qtyMilli} unit={unit} />
										</TableCell>
										<TableCell class="font-mono text-xs">{m.serial ?? ""}</TableCell>
										<TableCell class="text-muted-foreground">{m.by}</TableCell>
										<TableCell class="min-w-40 text-muted-foreground">{m.note}</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					)}
				</TableCard>
				{rows.length === limit ? (
					<p class="mt-3 text-sm text-muted-foreground">{fmt(t.stock.limitNote, { n: limit })}</p>
				) : null}
			</div>
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
// Valuation: two methods side by side, neither shown as "the" value (D91).

/** Warning asterisk after a cost that is unknown or incomplete, with its explanation for screen readers. */
function IncompleteMark(props: { show: boolean }) {
	const { t } = useApp();
	if (!props.show) return null;
	return (
		<span class="ml-0.5 font-medium text-warning" title={t.stock.rowIncomplete}>
			*<span class="sr-only"> {t.stock.rowIncomplete}</span>
		</span>
	);
}

/** Hint of a method's total: the date it is valued at, and how many parts lack a cost. */
function MethodHint(props: { asOf: string; missing: number }) {
	const { t } = useApp();
	return (
		<span class="flex flex-col gap-0.5">
			<span>{props.asOf}</span>
			{props.missing > 0 ? <span class="text-warning">{fmt(t.stock.incompleteRows, { n: props.missing })}</span> : null}
		</span>
	);
}

stockRoutes.get("/valuation", requirePermission("costs.view"), async (c) => {
	const t = c.var.t;
	const at = dateParam(c.req.query("at"));
	const v = await valuation(c.var.db, at);
	if (c.req.query("format") === "csv") {
		const locale = c.var.locale;
		const yes = (b: boolean) => (b ? "yes" : "");
		return csvResponse(c, `stock-valuation-${at ?? nowIso().slice(0, 10)}.csv`, [
			[
				"ref",
				"name",
				"kind",
				"unit",
				"on_hand",
				"standard_unit_cost",
				"cost_source",
				"standard_value",
				"standard_incomplete",
				"average_unit_cost",
				"average_value",
				"average_incomplete",
			],
			...v.rows.map((r) => [
				r.part.ref,
				r.part.name,
				r.part.kind,
				r.part.unit,
				formatQtyInput(r.onHandMilli, locale),
				formatCentsInput(centsOf(r.unitMillicents), locale),
				r.source,
				formatCentsInput(r.valueCents, locale),
				yes(r.incomplete),
				r.avgUnitCents === null ? "" : formatCentsInput(r.avgUnitCents, locale),
				formatCentsInput(r.avgValueCents, locale),
				yes(r.avgIncomplete),
			]),
			[
				"",
				"",
				"",
				"",
				"",
				"",
				"total",
				formatCentsInput(v.totalCents, locale),
				yes(v.incomplete),
				"",
				formatCentsInput(v.avgTotalCents, locale),
				yes(v.avgIncomplete),
			],
		]);
	}
	const asOf = at ? fmt(t.stock.valueAsOf, { date: at }) : t.stock.valueNow;
	const missingStandard = v.rows.filter((r) => r.incomplete).length;
	const missingAverage = v.rows.filter((r) => r.avgIncomplete).length;
	const anyIncomplete = v.incomplete || v.avgIncomplete;
	return page(
		c,
		t.stock.tabs.valuation,
		<>
			<StockHeader tab="valuation" />
			<form method="get" action="/stock/valuation" class="mb-4 flex flex-wrap items-center gap-2">
				<label class="inline-flex items-center gap-2 text-sm font-medium">
					<span>{t.stock.asOf}</span>
					<input type="date" name="at" value={at ?? ""} class="w-auto" />
				</label>
				<Button variant="outline" icon={icons.calendar}>
					{t.assemblies.update}
				</Button>
				<span class="text-sm text-muted-foreground">{t.stock.asOfHint}</span>
			</form>
			<p class="mb-4 max-w-3xl text-sm text-muted-foreground">{t.stock.methodsIntro}</p>
			{at && v.fallback ? <Alert>{fmt(t.stock.fallbackNote, { date: v.historyStart ?? "" })}</Alert> : null}
			<div class="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
				<StatCard
					label={t.stock.valueStandard}
					value={
						<>
							<Money cents={v.totalCents} />
							<IncompleteMark show={v.incomplete} />
						</>
					}
					icon={icons.coins}
					hint={<MethodHint asOf={asOf} missing={missingStandard} />}
					tone={v.incomplete ? "warning" : "default"}
				/>
				<StatCard
					label={t.stock.valueAverage}
					value={
						<>
							<Money cents={v.avgTotalCents} />
							<IncompleteMark show={v.avgIncomplete} />
						</>
					}
					icon={icons.receipt}
					hint={<MethodHint asOf={asOf} missing={missingAverage} />}
					tone={v.avgIncomplete ? "warning" : "default"}
				/>
				<div class="col-span-2 grid sm:col-span-1">
					<StatCard
						label={t.stock.valueDifference}
						value={
							<>
								<Money cents={v.avgTotalCents - v.totalCents} />
								<IncompleteMark show={anyIncomplete} />
							</>
						}
						icon={icons.scale}
						hint={t.stock.differenceHint}
					/>
				</div>
			</div>
			{anyIncomplete ? <Alert variant="warning">{t.stock.valuationIncomplete}</Alert> : null}
			<TableCard
				title={fmt(t.common.results, { n: v.rows.length })}
				action={<CsvButton href={`/stock/valuation?${new URLSearchParams({ at: at ?? "", format: "csv" })}`} />}
			>
				{v.rows.length === 0 ? (
					<CardEmpty />
				) : (
					<Table>
						<TableHeader class="bg-muted/50">
							<TableRow class="hover:bg-transparent">
								<TableHead colspan={3} />
								<TableHead colspan={2} scope="colgroup" class="border-l text-center">
									{t.stock.methodStandard}
								</TableHead>
								<TableHead colspan={2} scope="colgroup" class="border-l text-center">
									{t.stock.methodAverage}
								</TableHead>
							</TableRow>
							<TableRow class="hover:bg-transparent">
								<TableHead>{t.parts.ref}</TableHead>
								<TableHead>{t.parts.name}</TableHead>
								<TableHead class="text-right">{t.stock.onHand}</TableHead>
								<TableHead class="border-l text-right">{t.stock.unitCost}</TableHead>
								<TableHead class="text-right">{t.stock.value}</TableHead>
								<TableHead class="border-l text-right">{t.stock.unitCost}</TableHead>
								<TableHead class="text-right">{t.stock.value}</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{v.rows.map((r) => (
								<TableRow>
									<TableCell class="font-medium">
										<a href={`/parts/${r.part.id}`}>{r.part.ref}</a>
									</TableCell>
									<TableCell>
										<span class="mr-2">{r.part.name}</span>
										<Badge variant={r.source === "rollup" ? "info" : "muted"}>{t.stock.source[r.source]}</Badge>
									</TableCell>
									<TableCell class="text-right">
										<Qty milli={r.onHandMilli} unit={r.part.unit} />
									</TableCell>
									<TableCell class="border-l text-right whitespace-nowrap">
										<Money cents={centsOf(r.unitMillicents)} />
										<IncompleteMark show={r.incomplete} />
									</TableCell>
									<TableCell class="text-right">
										<Money cents={r.valueCents} />
									</TableCell>
									<TableCell class="border-l text-right whitespace-nowrap">
										<Money cents={r.avgUnitCents} />
										<IncompleteMark show={r.avgIncomplete} />
									</TableCell>
									<TableCell class="text-right">
										<Money cents={r.avgValueCents} />
									</TableCell>
								</TableRow>
							))}
						</TableBody>
						<TableFooter>
							<TableRow class="hover:bg-transparent">
								<TableCell colspan={3}>{t.stock.totalValue}</TableCell>
								<TableCell class="border-l" />
								<TableCell class={cn("text-right", v.incomplete && "text-warning")}>
									<Money cents={v.totalCents} />
								</TableCell>
								<TableCell class="border-l" />
								<TableCell class={cn("text-right", v.avgIncomplete && "text-warning")}>
									<Money cents={v.avgTotalCents} />
								</TableCell>
							</TableRow>
						</TableFooter>
					</Table>
				)}
			</TableCard>
		</>,
	);
});
