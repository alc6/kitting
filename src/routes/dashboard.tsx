import { Hono } from "hono";
import type { Child } from "hono/jsx";
import { listBuilds } from "../domain/builds";
import { listParts } from "../domain/parts";
import { can } from "../domain/permissions";
import { computeShortages, listPos } from "../domain/purchasing";
import { isStocked, valuation } from "../domain/stock";
import { fmt } from "../i18n";
import { cn } from "../lib/cn";
import { formatMoney } from "../lib/units";
import type { AppEnv } from "../types";
import { useApp } from "../views/context";
import { icons } from "../views/icons";
import { nowIso, page } from "../views/render";
import {
	Alert,
	Badge,
	Button,
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardEmpty,
	CardHeader,
	CardTitle,
	EmptyState,
	Money,
	PageHeader,
	Qty,
	StatCard,
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "../views/ui";
import { BuildsTable } from "./builds";
import { PoTable } from "./purchasing";

export const dashboardRoutes = new Hono<AppEnv>();

const LIMIT = 10;

/** A dashboard section: a card with a title, an optional "view all" link and a footer count. */
function Section(props: {
	title: string;
	description?: Child;
	href?: string;
	action?: Child;
	total?: number;
	class?: string;
	children: Child;
}) {
	const { t } = useApp();
	return (
		<Card class={cn("gap-4", props.class)}>
			<CardHeader>
				<CardTitle>{props.title}</CardTitle>
				{props.description ? <CardDescription>{props.description}</CardDescription> : null}
				{props.action || props.href ? (
					<CardAction>
						{props.action ??
							(props.href ? (
								<Button href={props.href} variant="ghost" size="sm">
									{t.dashboard.viewAll}
								</Button>
							) : null)}
					</CardAction>
				) : null}
			</CardHeader>
			<CardContent class="flex flex-col gap-3">
				{props.children}
				{props.total !== undefined && props.total > LIMIT && props.href ? (
					<a href={props.href} class="text-sm">
						{fmt(t.dashboard.more, { n: props.total - LIMIT })}
					</a>
				) : null}
			</CardContent>
		</Card>
	);
}

/**
 * The stock value card shows the standard method (D91: no method is "the" value), so its hint gives the
 * weighted average next to it, and warns when either total misses costs.
 */
function StockValueHint(props: { value: Awaited<ReturnType<typeof valuation>> }) {
	const { t, locale, currency } = useApp();
	const { value } = props;
	return (
		<span class="flex flex-col gap-0.5">
			<span>
				{fmt(t.dashboard.avgValueHint, { value: formatMoney(value.avgTotalCents, locale, currency) })}
				{value.avgIncomplete ? <span class="text-warning"> *</span> : null}
			</span>
			{value.incomplete || value.avgIncomplete ? <span class="text-warning">{t.dashboard.valueIncomplete}</span> : null}
		</span>
	);
}

dashboardRoutes.get("/", async (c) => {
	const t = c.var.t;
	const db = c.var.db;
	const [allParts, shortages, openPos, open, done, value] = await Promise.all([
		listParts(db),
		computeShortages(db),
		listPos(db, { status: "open" }),
		listBuilds(db, { status: "open", limit: 100 }),
		listBuilds(db, { status: "done", limit: LIMIT }),
		c.var.seeCosts ? valuation(db) : null,
	]);
	const canBuild = can(c.var, "builds.plan");
	const today = nowIso().slice(0, 10);
	const stocked = allParts.filter((p) => isStocked(p.kind));
	const belowZero = stocked.filter((p) => p.onHandMilli < 0);
	const belowMoq = stocked.filter((p) => p.moqMilli > 0 && p.onHandMilli >= 0 && p.onHandMilli < p.moqMilli);
	const shortageLines = shortages.groups.flatMap((g) => g.lines.map((l) => ({ ...l, supplierName: g.supplierName })));
	const shortSuppliers = new Set(shortageLines.map((l) => l.supplierName)).size;
	const overdue = openPos.filter((p) => p.expectedAt && p.expectedAt < today).length;
	const inProgress = open.filter((b) => b.status === "in_progress").length;
	const alerts = [
		...belowZero.map((p) => ({ p, label: t.dashboard.belowZero, negative: true })),
		...belowMoq.map((p) => ({ p, label: t.dashboard.belowMoq, negative: false })),
	];
	return page(
		c,
		t.dashboard.title,
		<>
			<PageHeader
				title={t.dashboard.title}
				actions={
					canBuild ? (
						<Button href="/builds/new" icon={icons.plus}>
							{t.builds.new}
						</Button>
					) : undefined
				}
			/>
			{allParts.length === 0 ? (
				<EmptyState
					class="mb-6"
					icon={icons.fileSpreadsheet}
					title={t.dashboard.welcome}
					description={t.dashboard.gettingStarted}
				>
					{can(c.var, "import.preview") ? (
						<Button href="/import" icon={icons.upload}>
							{t.nav.import}
						</Button>
					) : null}
				</EmptyState>
			) : null}

			<div class={cn("mb-6 grid grid-cols-2 gap-3 md:gap-4", value ? "xl:grid-cols-4" : "xl:grid-cols-3")}>
				<StatCard
					label={t.dashboard.openBuilds}
					value={open.length}
					icon={icons.hammer}
					href="/builds"
					hint={fmt(t.dashboard.inProgress, { n: inProgress })}
				/>
				<StatCard
					label={t.dashboard.shortageLines}
					value={shortageLines.length}
					icon={icons.shoppingCart}
					href="/purchasing"
					tone={shortageLines.length ? "warning" : "default"}
					hint={shortageLines.length ? fmt(t.dashboard.suppliersToOrder, { n: shortSuppliers }) : undefined}
				/>
				<StatCard
					label={t.dashboard.openPos}
					value={openPos.length}
					icon={icons.truck}
					href="/purchasing/po"
					tone={overdue ? "destructive" : "default"}
					hint={overdue ? fmt(t.dashboard.overdue, { n: overdue }) : t.dashboard.allOnTime}
				/>
				{value ? (
					<StatCard
						label={t.dashboard.stockValueStandard}
						value={
							<>
								<Money cents={value.totalCents} />
								{value.incomplete ? <span class="text-warning"> *</span> : null}
							</>
						}
						icon={icons.wallet}
						href="/stock/valuation"
						tone={value.incomplete || value.avgIncomplete ? "warning" : "default"}
						hint={<StockValueHint value={value} />}
					/>
				) : null}
			</div>

			{/* A main column and an alerts rail (D137): no void under a short card, whatever the lists hold. */}
			<div class="mb-6 grid grid-cols-1 items-start gap-4 xl:grid-cols-3">
				<div class="flex min-w-0 flex-col gap-4 xl:col-span-2">
					<Section title={t.dashboard.shortages} href="/purchasing" total={shortageLines.length}>
						{shortages.missingAssemblies.map((m) => (
							<Alert variant="warning" class="mb-0">
								{fmt(t.assemblies.missingAssembly, { ref: m.ref })}
							</Alert>
						))}
						{shortageLines.length === 0 ? (
							<CardEmpty icon={icons.circleCheck} class="px-0 py-1">
								{t.dashboard.noShortages}
							</CardEmpty>
						) : (
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead class="pl-0">{t.purchasing.part}</TableHead>
										<TableHead>{t.purchasing.supplier}</TableHead>
										<TableHead class="text-right">{t.purchasing.net}</TableHead>
										<TableHead class="pr-0 text-right">{t.purchasing.order}</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{shortageLines.slice(0, LIMIT).map((l) => (
										<TableRow>
											<TableCell class="pl-0">
												<a href={`/parts/${l.part.id}`} class="font-mono text-[0.8125rem] font-medium">
													{l.part.ref}
												</a>{" "}
												<span class="text-muted-foreground">{l.part.name}</span>
											</TableCell>
											<TableCell>{l.supplierName || <span class="text-warning">—</span>}</TableCell>
											<TableCell class="text-right text-warning">
												<Qty milli={l.netMilli} unit={l.part.unit} />
											</TableCell>
											<TableCell class="pr-0 text-right font-medium">
												<Qty milli={l.orderMilli} unit={l.part.unit} />
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						)}
					</Section>
					<Section
						title={t.dashboard.upcoming}
						href="/builds"
						total={open.length}
						action={
							canBuild ? (
								<Button href="/builds/new" variant="outline" size="sm" icon={icons.plus}>
									{t.builds.new}
								</Button>
							) : undefined
						}
					>
						<BuildsTable rows={[...open].reverse().slice(0, LIMIT)} />
					</Section>
					<Section title={t.dashboard.openPos} href="/purchasing/po" total={openPos.length}>
						<PoTable rows={openPos.slice(0, LIMIT)} today={today} />
					</Section>
				</div>

				<Section title={t.dashboard.alerts} href="/stock" total={alerts.length}>
					{alerts.length === 0 ? (
						<CardEmpty icon={icons.circleCheck} class="px-0 py-1">
							{t.dashboard.noAlerts}
						</CardEmpty>
					) : (
						<ul class="m-0 flex list-none flex-col divide-y p-0">
							{alerts.slice(0, LIMIT).map(({ p, label, negative }) => (
								<li class="flex items-start gap-3 py-2.5 text-sm">
									<div class="flex min-w-0 flex-1 flex-col">
										<a href={`/parts/${p.id}`} class="w-fit max-w-full truncate font-mono text-[0.8125rem] font-medium">
											{p.ref}
										</a>
										<span class="truncate text-muted-foreground">{p.name}</span>
									</div>
									<div class="flex shrink-0 flex-col items-end gap-1">
										<Qty milli={p.onHandMilli} unit={p.unit} />
										<Badge variant={negative ? "destructive" : "warning"}>{label}</Badge>
									</div>
								</li>
							))}
						</ul>
					)}
				</Section>
			</div>

			<Section title={t.dashboard.lastBuilds} href="/builds?status=done">
				<BuildsTable rows={done} />
			</Section>
		</>,
	);
});
