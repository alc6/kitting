// Margins: every sellable item (active BoM variant, or product sold without BoM) with its selling price,
// planned margin (standard cost roll-up) and actual margin (completed builds at weighted average cost).
import { Hono } from "hono";
import { type Margin, type MarginRow, marginReport } from "../domain/margins";
import { fmt } from "../i18n";
import { cn } from "../lib/cn";
import { formatCentsInput, formatPercent, formatScaled, roundDiv } from "../lib/units";
import type { AppEnv } from "../types";
import { useApp } from "../views/context";
import { icons } from "../views/icons";
import { nowIso, page } from "../views/render";
import {
	Badge,
	Button,
	CardEmpty,
	EmptyState,
	LinkButton,
	Money,
	PageHeader,
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
