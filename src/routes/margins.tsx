// Margins: every sellable item (active BoM variant, or product sold without BoM) with its selling price,
// planned margin (standard cost roll-up) and actual margin (completed builds at weighted average cost).
import { eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { boms } from "../db/schema";
import { type MarginTarget, marginHistory, type PlannedPoint } from "../domain/margin-history";
import { type Margin, type MarginRow, marginReport } from "../domain/margins";
import { historyStart } from "../domain/prices";
import { fmt } from "../i18n";
import { cn } from "../lib/cn";
import { formatCentsInput, formatMoney, formatPercent, formatScaled, roundDiv } from "../lib/units";
import { requirePermission } from "../middleware/roles";
import type { AppEnv } from "../types";
import { StepChart } from "../views/chart";
import { useApp } from "../views/context";
import { icons } from "../views/icons";
import { idParam, notFound, nowIso, page } from "../views/render";
import {
	Badge,
	Button,
	Card,
	CardContent,
	CardDescription,
	CardEmpty,
	CardHeader,
	CardTitle,
	EmptyState,
	LinkButton,
	Money,
	PageHeader,
	Qty,
	StatCard,
	Table,
	TableBody,
	TableCard,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
	ToggleLinks,
} from "../views/ui";
import { csvResponse } from "./import";

export const marginRoutes = new Hono<AppEnv>();
// Every margins page and export shows costs.
marginRoutes.use("*", requirePermission("costs.view"));

/** Planned rate on the selling price under which an item is flagged as low margin: 30 %, in basis points. */
export const LOW_MARGIN_BP = 3000;

/** Text colour of a margin: a loss in destructive, a margin rate below LOW_MARGIN_BP in warning. */
export function marginTone(m: Margin | null | undefined): string {
	return cn(
		m && m.marginCents < 0 && "text-destructive",
		m && m.marginCents >= 0 && m.rateBp !== null && m.rateBp < LOW_MARGIN_BP && "text-warning",
	);
}

const FILTERS = ["all", "planned", "built"] as const;
type Filter = (typeof FILTERS)[number];

const filterParam = (v: string | undefined): Filter => (v === "planned" || v === "built" ? v : "all");

/** "Planned only" = no completed build yet; "built" = at least one completed build of the variant. */
function matches(filter: Filter, r: MarginRow): boolean {
	if (filter === "planned") return r.doneBuilds === 0;
	if (filter === "built") return r.doneBuilds > 0;
	return true;
}

function filterHref(filter: Filter, format?: "csv"): string {
	const params = new URLSearchParams();
	if (filter !== "all") params.set("show", filter);
	if (format) params.set("format", format);
	const qs = params.toString();
	return qs ? `/margins?${qs}` : "/margins";
}

/** "*" after a cost that misses some component costs. */
function IncompleteMark() {
	const { t } = useApp();
	return (
		<abbr class="ml-0.5 cursor-help font-medium text-warning no-underline" title={t.margins.incompleteMark}>
			*
		</abbr>
	);
}

/** A margin percentage (basis points) or a dash when undefined. */
function Percent(props: { bp: number | null | undefined }) {
	const { t, locale } = useApp();
	if (props.bp === null || props.bp === undefined) return <span class="text-muted-foreground">{t.common.none}</span>;
	return <span class="num">{formatPercent(props.bp, locale)}</span>;
}

function MarginsTable(props: { rows: MarginRow[] }) {
	const { t } = useApp();
	const none = <span class="text-muted-foreground">{t.common.none}</span>;
	return (
		<Table>
			<TableHeader class="bg-muted/50">
				<TableRow class="hover:bg-transparent">
					<TableHead colspan={3} />
					<TableHead colspan={4} scope="colgroup" class="border-l text-center">
						{t.margins.planned}
					</TableHead>
					<TableHead colspan={4} scope="colgroup" class="border-l text-center">
						{t.margins.actual}
					</TableHead>
					<TableHead />
				</TableRow>
				<TableRow class="hover:bg-transparent">
					<TableHead>{t.margins.product}</TableHead>
					<TableHead>{t.margins.variant}</TableHead>
					<TableHead class="text-right">{t.margins.price}</TableHead>
					<TableHead class="border-l text-right">{t.margins.cost}</TableHead>
					<TableHead class="text-right">{t.margins.margin}</TableHead>
					<TableHead class="text-right">{t.margins.rate}</TableHead>
					<TableHead class="text-right">{t.margins.markup}</TableHead>
					<TableHead class="border-l text-right">{t.margins.builds}</TableHead>
					<TableHead class="text-right">{t.margins.cost}</TableHead>
					<TableHead class="text-right">{t.margins.margin}</TableHead>
					<TableHead class="text-right">{t.margins.rate}</TableHead>
					<TableHead class="w-0">
						<span class="sr-only">{t.margins.history}</span>
					</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{props.rows.map((r) => (
					<TableRow>
						<TableCell class="min-w-44">
							<div class="flex flex-col gap-0.5">
								<a href={`/parts/${r.part.id}`} class="font-medium">
									{r.part.ref}
								</a>
								<span class="text-xs text-muted-foreground">{r.part.name}</span>
							</div>
						</TableCell>
						<TableCell class="whitespace-nowrap">
							{r.bom ? (
								<span class="inline-flex items-center gap-1.5">
									<a href={`/boms/${r.bom.id}`}>{r.bom.code}</a>
									<span class="text-xs text-muted-foreground">{r.bom.revision}</span>
									{r.bom.ownPrice ? (
										<Badge variant="info" title={t.margins.ownPriceTitle}>
											{t.margins.ownPrice}
										</Badge>
									) : null}
								</span>
							) : (
								none
							)}
						</TableCell>
						<TableCell class="text-right font-medium">
							<Money cents={r.priceCents} />
						</TableCell>
						<TableCell class="border-l text-right whitespace-nowrap">
							<Money cents={r.plannedCostCents} />
							{r.plannedIncomplete ? <IncompleteMark /> : null}
						</TableCell>
						<TableCell class={cn("text-right font-medium", marginTone(r.planned))}>
							{r.planned ? <Money cents={r.planned.marginCents} /> : none}
						</TableCell>
						<TableCell class={cn("text-right", marginTone(r.planned))}>
							<Percent bp={r.planned?.rateBp} />
						</TableCell>
						<TableCell class={cn("text-right", marginTone(r.planned))}>
							<Percent bp={r.planned?.markupBp} />
						</TableCell>
						<TableCell class={cn("border-l text-right tabular-nums", r.doneBuilds === 0 && "text-muted-foreground")}>
							{r.doneBuilds}
						</TableCell>
						<TableCell class="text-right whitespace-nowrap">
							{r.doneBuilds > 0 ? (
								<>
									<Money cents={r.actualCostCents} />
									{r.actualIncomplete ? <IncompleteMark /> : null}
								</>
							) : (
								none
							)}
						</TableCell>
						<TableCell class={cn("text-right font-medium", marginTone(r.actual))}>
							{r.actual ? <Money cents={r.actual.marginCents} /> : none}
						</TableCell>
						<TableCell class={cn("text-right", marginTone(r.actual))}>
							<Percent bp={r.actual?.rateBp} />
						</TableCell>
						<TableCell class="py-1">
							<Button
								href={historyHref(r)}
								variant="ghost"
								size="icon-sm"
								icon={icons.chartLine}
								aria-label={fmt(t.margins.historyLink, { item: r.bom ? `${r.part.ref} · ${r.bom.code}` : r.part.ref })}
								title={t.margins.historyTitle}
							/>
						</TableCell>
					</TableRow>
				))}
			</TableBody>
		</Table>
	);
}

marginRoutes.get("/", async (c) => {
	const t = c.var.t;
	const locale = c.var.locale;
	const filter = filterParam(c.req.query("show"));
	const rows = await marginReport(c.var.db);
	const shown = rows.filter((r) => matches(filter, r));

	if (c.req.query("format") === "csv") {
		const cents = (v: number | null | undefined) => (v === null || v === undefined ? "" : formatCentsInput(v, locale));
		// Percent with one decimal, no "%" sign nor grouping, so spreadsheets read it as a number.
		const pct = (bp: number | null | undefined) =>
			bp === null || bp === undefined
				? ""
				: formatScaled(roundDiv(bp, 10), 1, { locale, minDecimals: 1, group: false });
		return csvResponse(c, `margins-${nowIso().slice(0, 10)}${filter === "all" ? "" : `-${filter}`}.csv`, [
			[
				"part_ref",
				"part_name",
				"variant",
				"revision",
				"own_price",
				"sale_price",
				"planned_cost",
				"planned_incomplete",
				"planned_margin",
				"planned_rate_pct",
				"planned_markup_pct",
				"done_builds",
				"actual_cost",
				"actual_incomplete",
				"actual_margin",
				"actual_rate_pct",
			],
			...shown.map((r) => [
				r.part.ref,
				r.part.name,
				r.bom?.code ?? "",
				r.bom?.revision ?? "",
				r.bom?.ownPrice ? "yes" : "",
				cents(r.priceCents),
				cents(r.plannedCostCents),
				r.plannedIncomplete ? "yes" : "",
				cents(r.planned?.marginCents),
				pct(r.planned?.rateBp),
				pct(r.planned?.markupBp),
				r.doneBuilds,
				cents(r.actualCostCents),
				r.doneBuilds > 0 && r.actualIncomplete ? "yes" : "",
				cents(r.actual?.marginCents),
				pct(r.actual?.rateBp),
			]),
		]);
	}

	const header = <PageHeader title={t.margins.title} subtitle={t.margins.intro} />;
	if (rows.length === 0) {
		return page(
			c,
			t.margins.title,
			<>
				{header}
				<EmptyState icon={icons.tag} title={t.margins.empty} description={t.margins.emptyHint}>
					<LinkButton href="/parts" label={t.margins.goToParts} variant="outline" icon={icons.package} />
				</EmptyState>
			</>,
		);
	}

	const rates = rows.flatMap((r) => (r.planned && r.planned.rateBp !== null ? [r.planned.rateBp] : []));
	const averageRate = rates.length
		? roundDiv(
				rates.reduce((s, v) => s + v, 0),
				rates.length,
			)
		: null;
	const incomplete = rows.filter((r) => r.plannedIncomplete).length;
	const low = rows.filter((r) => r.planned && r.planned.rateBp !== null && r.planned.rateBp < LOW_MARGIN_BP).length;
	const threshold = formatPercent(LOW_MARGIN_BP, locale);

	return page(
		c,
		t.margins.title,
		<>
			{header}
			<div class="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
				<StatCard label={t.margins.sellable} value={rows.length} icon={icons.tag} hint={t.margins.sellableHint} />
				<StatCard
					label={t.margins.averageRate}
					value={averageRate === null ? t.common.none : formatPercent(averageRate, locale)}
					icon={icons.chartColumn}
					hint={t.margins.averageRateHint}
					tone={averageRate !== null && averageRate < LOW_MARGIN_BP ? "warning" : "default"}
				/>
				<StatCard
					label={t.margins.incompleteCost}
					value={incomplete}
					icon={icons.triangleAlert}
					hint={t.margins.incompleteCostHint}
					tone={incomplete > 0 ? "warning" : "default"}
				/>
				<StatCard
					label={t.margins.lowMargin}
					value={low}
					icon={icons.trendingDown}
					hint={fmt(t.margins.lowMarginHint, { pct: threshold })}
					tone={low > 0 ? "warning" : "default"}
				/>
			</div>
			<div class="mb-4 flex flex-wrap items-center gap-3">
				<ToggleLinks
					label={t.common.show}
					items={FILTERS.map((f) => ({
						href: filterHref(f),
						label: t.margins.filters[f],
						active: f === filter,
						title: f === "all" ? undefined : t.margins.filterTitles[f],
					}))}
				/>
			</div>
			<TableCard
				title={fmt(t.common.results, { n: shown.length })}
				action={
					<Button href={filterHref(filter, "csv")} variant="outline" size="sm" icon={icons.download}>
						{t.margins.downloadCsv}
					</Button>
				}
			>
				{shown.length === 0 ? <CardEmpty icon={icons.filter} /> : <MarginsTable rows={shown} />}
				<div class="flex flex-col gap-1 border-t px-4 py-3 text-xs text-muted-foreground">
					<p>{t.margins.legend}</p>
					{shown.some((r) => r.plannedIncomplete || (r.doneBuilds > 0 && r.actualIncomplete)) ? (
						<p>{t.margins.legendIncomplete}</p>
					) : null}
				</div>
			</TableCard>
		</>,
	);
});

// ---------------------------------------------------------------------------
// Margin history of one sellable item (D98)

/** Link to the margin history of a margins row. */
export const historyHref = (r: { part: { id: number }; bom: { id: number } | null }) =>
	r.bom ? `/margins/boms/${r.bom.id}` : `/margins/parts/${r.part.id}`;

/** A change of percentage points, signed: "+1.5 pts", "−4.0 pts". */
function Points(props: { bp: number }) {
	const { t, locale } = useApp();
	const sign = props.bp > 0 ? "+" : props.bp < 0 ? "−" : "";
	const n = formatScaled(roundDiv(Math.abs(props.bp), 10), 1, { locale, minDecimals: 1 });
	return <span class="num">{fmt(t.margins.points, { n: `${sign}${n}` })}</span>;
}

/** What moved the planned margin on one day: the selling price and component costs. */
function ChangeList(props: { point: PlannedPoint; first: boolean; refs: Map<number, string> }) {
	const { t } = useApp();
	const { point, refs } = props;
	if (props.first) return <span class="text-muted-foreground">{t.margins.start}</span>;
	const MAX = 5;
	const costs = [...point.costChanges].sort((a, b) =>
		(refs.get(a.partId) ?? "").localeCompare(refs.get(b.partId) ?? ""),
	);
	const hidden = costs.slice(MAX);
	return (
		<ul class="flex flex-col gap-0.5">
			{point.priceChange ? (
				<li class="whitespace-nowrap">
					<span class="font-medium">{t.margins.salePriceChange}</span> <Money cents={point.priceChange.fromCents} />
					{" → "}
					<Money cents={point.priceChange.toCents} />
				</li>
			) : null}
			{costs.slice(0, MAX).map((ch) => (
				<li class="whitespace-nowrap">
					<a href={`/parts/${ch.partId}`} class="font-medium">
						{refs.get(ch.partId) ?? ch.partId}
					</a>{" "}
					<Money cents={ch.fromCents} />
					{" → "}
					<Money cents={ch.toCents} />
				</li>
			))}
			{hidden.length ? (
				<li class="text-muted-foreground" title={hidden.map((ch) => refs.get(ch.partId) ?? ch.partId).join(", ")}>
					{fmt(t.margins.moreChanges, { n: hidden.length })}
				</li>
			) : null}
		</ul>
	);
}

async function historyPage(c: Context<AppEnv>, target: MarginTarget) {
	const t = c.var.t;
	const locale = c.var.locale;
	const currency = c.env.CURRENCY;
	const data = await marginHistory(c.var.db, target);
	if (!data) return notFound(c);
	const { part, bom, planned, actual, refs } = data;
	const start = planned.some((p) => p.fallback) ? await historyStart(c.var.db) : null;
	const item = bom ? `${part.ref} · ${bom.code} ${bom.revision}` : part.ref;
	const title = `${t.margins.historyTitle}: ${item}`;
	const money = (cents: number | null) => (cents === null ? t.common.none : formatMoney(cents, locale, currency));
	const pct = (bp: number | null | undefined) =>
		bp === null || bp === undefined ? t.common.none : formatPercent(bp, locale);

	const first = planned[0];
	const last = planned.at(-1);
	const lastBuild = actual.at(-1);
	const firstRate = first?.margin?.rateBp ?? null;
	const lastRate = last?.margin?.rateBp ?? null;
	const delta = firstRate !== null && lastRate !== null && planned.length > 1 ? lastRate - firstRate : null;

	const header = (
		<PageHeader
			title={title}
			subtitle={part.name}
			actions={
				<>
					<Button href="/margins" variant="outline" icon={icons.arrowLeft}>
						{t.margins.allMargins}
					</Button>
					<Button
						href={bom ? `/boms/${bom.id}` : `/parts/${part.id}`}
						variant="outline"
						icon={bom ? icons.listTree : icons.package}
					>
						{bom ? t.margins.openBom : t.margins.openPart}
					</Button>
				</>
			}
		/>
	);
	if (planned.length === 0 && actual.length === 0) {
		return page(
			c,
			title,
			<>
				{header}
				<EmptyState icon={icons.history} title={t.margins.noHistory} description={t.margins.noHistoryHint} />
			</>,
		);
	}

	const steps = planned.map((p) => ({
		date: p.date,
		value: p.margin?.rateBp ?? null,
		title: `${p.date} · ${t.margins.cost} ${money(p.costCents)} · ${t.margins.price} ${money(p.priceCents)} · ${pct(p.margin?.rateBp)}`,
	}));
	const dots = actual.flatMap((b) =>
		b.margin?.rateBp === null || b.margin?.rateBp === undefined
			? []
			: [
					{
						date: b.date,
						value: b.margin.rateBp,
						title: `${b.date} · ${b.number} · ${t.margins.cost} ${money(b.unitCents)} · ${pct(b.margin.rateBp)}`,
					},
				],
	);

	return page(
		c,
		title,
		<>
			{header}
			<div class="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
				<StatCard
					label={t.margins.rateNow}
					value={pct(lastRate)}
					icon={icons.chartLine}
					hint={t.margins.rateNowHint}
					tone={lastRate !== null && lastRate < LOW_MARGIN_BP ? "warning" : "default"}
				/>
				<StatCard
					label={fmt(t.margins.rateChange, { date: first?.date ?? t.common.none })}
					value={delta === null ? t.common.none : <Points bp={delta} />}
					icon={delta !== null && delta < 0 ? icons.trendingDown : icons.trendingUp}
					hint={t.margins.rateChangeHint}
					tone={delta !== null && delta < 0 ? "warning" : "default"}
				/>
				<StatCard
					label={t.margins.lastActual}
					value={pct(lastBuild?.margin?.rateBp)}
					icon={icons.hammer}
					hint={
						lastBuild ? fmt(t.margins.lastActualHint, { number: lastBuild.number, date: lastBuild.date }) : undefined
					}
				/>
				<StatCard
					label={t.margins.doneBuilds}
					value={actual.length}
					icon={icons.packageCheck}
					hint={t.margins.doneBuildsHint}
				/>
			</div>
			<div class="flex flex-col gap-6">
				{steps.some((s) => s.value !== null) || dots.length ? (
					<Card>
						<CardHeader>
							<CardTitle icon={icons.chartLine}>{t.margins.chartTitle}</CardTitle>
							<CardDescription>{t.margins.chartDescription}</CardDescription>
						</CardHeader>
						<CardContent>
							<StepChart
								id="margin-chart"
								label={t.margins.chartLabel}
								steps={steps}
								dots={dots}
								stepLabel={t.margins.plannedRate}
								dotLabel={t.margins.actualRate}
								format={(bp) => formatPercent(bp, locale)}
								today={nowIso().slice(0, 10)}
							/>
						</CardContent>
					</Card>
				) : null}
				{planned.length ? (
					<TableCard title={t.margins.changesTitle}>
						<p class="border-b px-4 py-2 text-xs text-muted-foreground">{t.margins.changesDescription}</p>
						<Table>
							<TableHeader class="bg-muted/50">
								<TableRow class="hover:bg-transparent">
									<TableHead>{t.margins.date}</TableHead>
									<TableHead>{t.margins.change}</TableHead>
									<TableHead class="text-right">{t.margins.cost}</TableHead>
									<TableHead class="text-right">{t.margins.price}</TableHead>
									<TableHead class="text-right">{t.margins.margin}</TableHead>
									<TableHead class="text-right">{t.margins.rate}</TableHead>
									<TableHead class="text-right">{t.margins.markup}</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{[...planned].reverse().map((p) => (
									<TableRow>
										<TableCell class="whitespace-nowrap tabular-nums">{p.date}</TableCell>
										<TableCell class="min-w-56">
											<ChangeList point={p} first={p === first} refs={refs} />
										</TableCell>
										<TableCell class="text-right whitespace-nowrap">
											<Money cents={p.costCents} />
											{p.incomplete ? <IncompleteMark /> : null}
										</TableCell>
										<TableCell class="text-right">
											{p.priceCents === null ? (
												<span class="text-muted-foreground">{t.margins.noPrice}</span>
											) : (
												<Money cents={p.priceCents} />
											)}
										</TableCell>
										<TableCell class={cn("text-right font-medium", marginTone(p.margin))}>
											{p.margin ? <Money cents={p.margin.marginCents} /> : t.common.none}
										</TableCell>
										<TableCell class={cn("text-right", marginTone(p.margin))}>
											<Percent bp={p.margin?.rateBp} />
										</TableCell>
										<TableCell class={cn("text-right", marginTone(p.margin))}>
											<Percent bp={p.margin?.markupBp} />
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</TableCard>
				) : null}
				{actual.length ? (
					<TableCard title={t.margins.buildsTitle}>
						<p class="border-b px-4 py-2 text-xs text-muted-foreground">{t.margins.buildsDescription}</p>
						<Table>
							<TableHeader class="bg-muted/50">
								<TableRow class="hover:bg-transparent">
									<TableHead>{t.margins.date}</TableHead>
									<TableHead>{t.margins.build}</TableHead>
									<TableHead class="text-right">{t.margins.qty}</TableHead>
									<TableHead class="text-right">{t.margins.cost}</TableHead>
									<TableHead class="text-right">{t.margins.price}</TableHead>
									<TableHead class="text-right">{t.margins.margin}</TableHead>
									<TableHead class="text-right">{t.margins.rate}</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{[...actual].reverse().map((b) => (
									<TableRow>
										<TableCell class="whitespace-nowrap tabular-nums">{b.date}</TableCell>
										<TableCell>
											<a href={`/builds/${b.buildId}`} class="font-medium">
												{b.number}
											</a>
										</TableCell>
										<TableCell class="text-right">
											<Qty milli={b.qtyMilli} unit={part.unit} />
										</TableCell>
										<TableCell class="text-right whitespace-nowrap">
											<Money cents={b.unitCents} />
											{b.incomplete ? <IncompleteMark /> : null}
										</TableCell>
										<TableCell class="text-right">
											{b.priceCents === null ? (
												<span class="text-muted-foreground">{t.margins.noPrice}</span>
											) : (
												<Money cents={b.priceCents} />
											)}
										</TableCell>
										<TableCell class={cn("text-right font-medium", marginTone(b.margin))}>
											{b.margin ? <Money cents={b.margin.marginCents} /> : t.common.none}
										</TableCell>
										<TableCell class={cn("text-right", marginTone(b.margin))}>
											<Percent bp={b.margin?.rateBp} />
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</TableCard>
				) : null}
				<div class="flex flex-col gap-1 text-xs text-muted-foreground">
					<p>{t.margins.historyLegend}</p>
					<p>{t.margins.legend}</p>
					{start ? <p>{fmt(t.margins.historyFallback, { date: start })}</p> : null}
					{planned.some((p) => p.incomplete) || actual.some((b) => b.incomplete) ? (
						<p>{t.margins.legendIncomplete}</p>
					) : null}
				</div>
			</div>
		</>,
	);
}

marginRoutes.get("/boms/:id", async (c) => {
	const id = idParam(c);
	if (!id) return notFound(c);
	const [bom] = await c.var.db.select({ partId: boms.parentPartId }).from(boms).where(eq(boms.id, id));
	if (!bom) return notFound(c);
	return historyPage(c, { partId: bom.partId, bomId: id });
});

marginRoutes.get("/parts/:id", async (c) => {
	const id = idParam(c);
	if (!id) return notFound(c);
	return historyPage(c, { partId: id, bomId: null });
});
