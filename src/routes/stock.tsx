import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { MOVE_REASONS, parts } from "../db/schema";
import { centsOf } from "../domain/assembly-graph";
import {
	combinations,
	keyLabel,
	keyOf,
	keyText,
	type OptionDef,
	type OptionKey,
	splitStockKey,
	stockKey,
} from "../domain/option-keys";
import { keyFromForm, loadOptions, optionsOf } from "../domain/options";
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
	onHandByKey,
	planCounts,
	stockByKey,
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
import { OptionSelects, OptionValues } from "../views/options";
import { PartPicker, PartPickerDialog } from "../views/part-picker";
import { fragment, nowIso, page, saveChanges, translateErrors } from "../views/render";
import {
	Alert,
	Badge,
	Button,
	Card,
	CardContent,
	CardEmpty,
	DateRange,
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
	const [listed, options, keyed] = await Promise.all([
		listParts(c.var.db, { q }),
		loadOptions(c.var.db),
		stockByKey(c.var.db),
	]);
	const all = listed.filter((p) => isStocked(p.kind));
	// A part with options is counted per values (D184): its rows below it, and the filters look at each.
	const byValues = new Map<number, { optionValues: OptionKey; qty: number }[]>();
	for (const r of keyed) {
		if (r.optionValues === null || !options.has(r.partId)) continue;
		byValues.set(r.partId, [...(byValues.get(r.partId) ?? []), r]);
	}
	const quantities = (p: (typeof all)[number]) => byValues.get(p.id)?.map((r) => r.qty) ?? [p.onHandMilli];
	const rows = all.filter((p) => {
		if (filter === "below_zero") return p.onHandMilli < 0 || quantities(p).some((q) => q < 0);
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
						<CardEmpty large />
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
								{rows.flatMap((p) => {
									// The minimum stock is per part (D187): it compares the total.
									const low = belowMinimum(p);
									const partOptions = options.get(p.id) ?? [];
									const values = (byValues.get(p.id) ?? [])
										.filter((r) => r.qty !== 0)
										.sort((a, b) =>
											keyLabel(partOptions, a.optionValues).localeCompare(keyLabel(partOptions, b.optionValues)),
										);
									return [
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
														variant="ghost"
														size="icon-sm"
														icon={icons.arrowUpDown}
														aria-label={t.stock.adjust}
														title={t.stock.adjust}
													/>
												</TableCell>
											) : null}
										</TableRow>,
										...values.map((r) => (
											<TableRow class="text-muted-foreground">
												<TableCell />
												<TableCell colspan={3} class="pl-6">
													{keyLabel(partOptions, r.optionValues)}
												</TableCell>
												<TableCell class="text-right">
													<Qty milli={r.qty} unit={p.unit} />
												</TableCell>
												{canAdjust ? <TableCell /> : null}
											</TableRow>
										)),
									];
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

/** The selects of a part's options on the adjustment form (D184), refreshed when the part changes. */
function AdjustOptions(props: { options: OptionDef[]; values: FormValues; errors: FormErrors }) {
	return (
		<div
			id="adjust-options"
			class="grid gap-4 empty:hidden md:grid-cols-2"
			hx-get="/stock/adjust/options"
			hx-trigger="change from:#f-part"
			hx-include="#f-part"
			hx-swap="outerHTML"
		>
			<OptionSelects
				options={props.options}
				name={(o) => `option:${o.id}`}
				values={props.values}
				errors={props.errors}
			/>
		</div>
	);
}

function AdjustForm(props: {
	values: FormValues;
	errors: FormErrors;
	options: { ref: string; name: string }[];
	partOptions: OptionDef[];
}) {
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
						<AdjustOptions options={props.partOptions} values={props.values} errors={props.errors} />
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
			<AdjustForm
				values={{ part: part?.ref ?? "" }}
				errors={{}}
				options={await stockedOptions(c)}
				partOptions={part ? await optionsOf(c.var.db, part.id) : []}
			/>
		</>,
	);
});

/** The option selects for the part typed on the adjustment form (htmx; the form works without it, see the POST). */
stockRoutes.get("/adjust/options", requirePermission("stock.adjust"), async (c) => {
	const ref = (c.req.query("part") ?? "").trim();
	const part = ref ? (await c.var.db.select().from(parts).where(eq(parts.ref, ref)).limit(1))[0] : undefined;
	return fragment(
		c,
		<AdjustOptions options={part ? await optionsOf(c.var.db, part.id) : []} values={{}} errors={{}} />,
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
	let partOptionDefs: OptionDef[] = [];
	let optionValues: OptionKey = null;
	if (v.ok) {
		part = (await db.select().from(parts).where(eq(parts.ref, v.data.part)).limit(1))[0];
		const problems = adjustmentErrors(part, v.data);
		Object.assign(errors, problems.errors);
		vars = problems.vars;
		// A part with options is adjusted in one value of each (D184): the selects appear once the part is known.
		partOptionDefs = part ? await optionsOf(db, part.id) : [];
		const chosen = keyFromForm(partOptionDefs, body);
		optionValues = chosen.key;
		if (chosen.missing) {
			errors[`option:${chosen.missing.id}`] = "option_value_required";
			vars.option = chosen.missing.name;
		}
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
					partOptions={partOptionDefs}
				/>
			</>,
			422,
		);
	}
	await saveChanges(c, fmt(t.history.summaries.stockAdjust, { ref: part.ref }), [
		adjustmentStatement(
			db,
			{
				partId: part.id,
				qtyMilli: v.data.qty,
				serial: v.data.serial || null,
				unitCostCents: part.costCents,
				optionValues,
			},
			v.data.note,
			c.var.user,
			nowIso(),
		),
	]);
	return c.redirect(`/parts/${part.id}/stock?ok=adjusted`, 303);
});

// ---------------------------------------------------------------------------
// Inventory count

stockRoutes.get("/count", requirePermission("stock.count"), async (c) => {
	return renderCount(c, {}, {});
});

async function renderCount(c: Context<AppEnv>, values: FormValues, errors: FieldErrors, status: 200 | 422 = 200) {
	const t = c.var.t;
	const q = c.req.query("q") ?? "";
	const [listed, options, onHand] = await Promise.all([
		listParts(c.var.db, { q }),
		loadOptions(c.var.db),
		onHandByKey(c.var.db),
	]);
	// One line per part, and per combination of values for a part with options (D184).
	const rows = listed
		.filter((p) => isStocked(p.kind))
		.flatMap((p) => {
			const partOptions = options.get(p.id) ?? [];
			if (partOptions.length === 0) return [{ part: p, name: `count_${p.id}`, label: "", onHand: p.onHandMilli }];
			return combinations(partOptions).map((ids) => {
				const key = keyOf(ids);
				return {
					part: p,
					name: `count_${p.id}_${ids.join("-")}`,
					label: keyLabel(partOptions, key),
					onHand: onHand.get(stockKey(p.id, key)) ?? 0,
				};
			});
		});
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
							<CardEmpty large />
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
									{rows.map(({ part: p, name, label, onHand: current }) => {
										const error = errors[name];
										return (
											<TableRow class={cn(error && "bg-destructive/5 hover:bg-destructive/10")}>
												<TableCell class="font-medium">
													<a href={`/parts/${p.id}`}>{p.ref}</a>
												</TableCell>
												<TableCell>
													{p.name}
													{label ? <span class="block text-sm text-muted-foreground">{label}</span> : null}
													{error ? <p class="mt-1 text-sm text-destructive">{errorText(t, error)}</p> : null}
												</TableCell>
												<TableCell class="text-right text-muted-foreground">
													<Qty milli={current} unit={p.unit} />
												</TableCell>
												<TableCell class="w-0 text-right">
													<input
														type="text"
														name={name}
														inputmode="decimal"
														value={values[name] ?? ""}
														aria-label={`${t.stock.counted} ${p.ref}${label ? ` ${label}` : ""}`}
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
	const entries: { partId: number; valueIds: number[]; qty: number; line: number }[] = [];
	let line = 0;
	for (const [key, raw] of Object.entries(body)) {
		// count_<part>, or count_<part>_<value ids> for a part with options.
		const m = /^count_(\d+)(?:_(\d+(?:-\d+)*))?$/.exec(key);
		if (!m || typeof raw !== "string") continue;
		values[key] = raw;
		line++;
		if (raw.trim() === "") continue;
		const qty = parseMilli(raw);
		if (qty === null) errors[key] = "invalid_quantity";
		else if (qty < 0) errors[key] = "negative";
		else entries.push({ partId: Number(m[1]), valueIds: m[2] ? m[2].split("-").map(Number) : [], qty, line });
	}
	const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) : "";
	values.note = note;
	if (Object.keys(errors).length > 0) return renderCount(c, values, errors, 422);

	const [allParts, onHand, options] = await Promise.all([db.select().from(parts), onHandByKey(db), loadOptions(db)]);
	const byId = new Map(allParts.map((p) => [p.id, p]));
	const groups: CountGroup[] = [];
	for (const e of entries) {
		const part = byId.get(e.partId);
		if (!part || !isStocked(part.kind)) continue;
		// Only a whole combination of the part's values counts (none for a part without options).
		const partOptions = options.get(part.id) ?? [];
		const key = keyOf(e.valueIds);
		const valid = combinations(partOptions).some((ids) => keyOf(ids) === key) || (!partOptions.length && !key);
		if (!valid) continue;
		groups.push({
			part,
			optionValues: key,
			lines: [{ line: e.line, qtyMilli: e.qty, serial: "", unitCostCents: null }],
		});
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
	const [rows, options] = await Promise.all([
		listMoves(c.var.db, { q, reason, from, to, limit }),
		loadOptions(c.var.db),
	]);
	if (csv) {
		const locale = c.var.locale;
		return csvResponse(c, `stock-moves-${nowIso().slice(0, 10)}.csv`, [
			[
				"at",
				"ref",
				"name",
				"reason",
				"qty",
				"unit",
				"serial",
				"unit_cost",
				"ref_type",
				"ref_id",
				"by",
				"note",
				"options",
			],
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
				keyText(options.get(m.partId) ?? [], m.optionValues),
			]),
		]);
	}
	const query = new URLSearchParams({ q, reason, from: from ?? "", to: to ?? "", format: "csv" }).toString();
	return page(
		c,
		t.stock.tabs.moves,
		<>
			<StockHeader tab="moves" />
			<SearchBar action="/stock/moves" q={q} compact>
				<select name="reason" aria-label={t.stock.reason}>
					<option value="">{t.stock.reasonAll}</option>
					{MOVE_REASONS.map((r) => (
						<option value={r} selected={r === reason}>
							{t.reasons[r]}
						</option>
					))}
				</select>
				<DateRange from={from} to={to} fromLabel={t.stock.from} toLabel={t.stock.to} />
			</SearchBar>
			<div id="results">
				<TableCard
					title={fmt(t.common.results, { n: rows.length })}
					action={<CsvButton href={`/stock/moves?${query}`} />}
				>
					{rows.length === 0 ? (
						<CardEmpty large />
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
											<OptionValues
												options={options.get(m.partId) ?? []}
												values={m.optionValues}
												class="block font-normal"
											/>
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
				"options",
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
				keyText(r.part.options, r.optionValues),
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
				"",
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
					<CardEmpty large />
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
										<OptionValues options={r.part.options} values={r.optionValues} class="block font-normal" />
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
