import { Hono } from "hono";
import type { Child } from "hono/jsx";
import { globalSearch, SEARCH_GROUP_LIMIT, type SearchResults } from "../domain/search";
import { fullCode } from "../domain/storage";
import { fmt } from "../i18n";
import type { AppEnv } from "../types";
import { StatusBadge } from "../views/assembly";
import { useApp } from "../views/context";
import { Icon, type IconNode, icons } from "../views/icons";
import { page } from "../views/render";
import { binHref, LocationBadge, whereText } from "../views/storage";
import { Badge, Card, CardAction, CardContent, CardHeader, CardTitle, EmptyState, Kbd, KindBadge } from "../views/ui";
import { BuildStatusBadge } from "./builds";
import { PoStatusBadge } from "./purchasing";

export const searchRoutes = new Hono<AppEnv>();

function Group(props: { title: string; icon: IconNode; count: number; all: string; children: Child }) {
	const { t } = useApp();
	if (props.count === 0) return null;
	return (
		<Card class="gap-3 py-4">
			<CardHeader class="px-4">
				<CardTitle icon={props.icon} class="text-sm">
					{props.title}
					<Badge variant="secondary">{props.count}</Badge>
				</CardTitle>
				{props.count > SEARCH_GROUP_LIMIT ? (
					<CardAction>
						<a href={props.all} class="text-sm">
							{fmt(t.search.seeAll, { n: props.count })}
						</a>
					</CardAction>
				) : null}
			</CardHeader>
			<CardContent class="px-2">
				<ul class="m-0 flex list-none flex-col p-0">{props.children}</ul>
			</CardContent>
		</Card>
	);
}

function Row(props: { href: string; primary: Child; secondary?: Child; extra?: Child }) {
	return (
		<li>
			<a
				href={props.href}
				class="flex min-h-(--control-h) items-center gap-3 rounded-md px-2 py-1.5 text-sm no-underline hover:bg-accent hover:text-accent-foreground"
			>
				<span class="font-mono text-[0.8125rem] font-medium">{props.primary}</span>
				<span class="min-w-0 flex-1 truncate text-muted-foreground">{props.secondary}</span>
				{props.extra}
			</a>
		</li>
	);
}

function Results(props: { q: string; r: SearchResults }) {
	const { t } = useApp();
	const { r, q } = props;
	const enc = encodeURIComponent(q);
	const total =
		r.parts.length + r.assemblies.length + r.builds.length + r.pos.length + r.suppliers.length + r.bins.length;
	if (total === 0) {
		return <EmptyState icon={icons.search} title={fmt(t.search.none, { q })} description={t.search.prompt} />;
	}
	const top = <T,>(rows: T[]) => rows.slice(0, SEARCH_GROUP_LIMIT);
	return (
		<div class="grid gap-4 lg:grid-cols-2">
			<Group title={t.locations.title} icon={icons.mapPin} count={r.bins.length} all="/locations">
				{r.bins.map((b) => (
					<Row
						href={b.level !== null ? binHref(b) : `/locations/${b.unit.id}`}
						primary={fullCode(b)}
						secondary={whereText(t, b)}
						extra={b.unit.name ? <span class="text-xs text-muted-foreground">{b.unit.name}</span> : null}
					/>
				))}
			</Group>
			<Group title={t.nav.parts} icon={icons.package} count={r.parts.length} all={`/parts?q=${enc}`}>
				{top(r.parts).map((p) => (
					<Row
						href={`/parts/${p.id}`}
						primary={p.ref}
						secondary={p.name}
						extra={
							<>
								{p.archived ? <Badge variant="muted">{t.common.archivedLabel}</Badge> : null}
								{r.locations.has(p.id) ? <LocationBadge location={r.locations.get(p.id)} link={false} /> : null}
								<KindBadge kind={p.kind} />
							</>
						}
					/>
				))}
			</Group>
			<Group
				title={t.nav.assemblies}
				icon={icons.listTree}
				count={r.assemblies.length}
				all={`/assemblies?q=${enc}&status=all`}
			>
				{top(r.assemblies).map((b) => (
					<Row
						href={`/assemblies/${b.id}`}
						primary={b.partRef}
						secondary={`${b.partName} · ${b.code} ${b.revision}`}
						extra={<StatusBadge status={b.status} />}
					/>
				))}
			</Group>
			<Group title={t.nav.builds} icon={icons.hammer} count={r.builds.length} all={`/builds?q=${enc}&status=all`}>
				{top(r.builds).map((b) => (
					<Row
						href={`/builds/${b.id}`}
						primary={b.number}
						secondary={`${b.partRef}${b.serial ? ` · #${b.serial}` : ""}`}
						extra={<BuildStatusBadge status={b.status} />}
					/>
				))}
			</Group>
			<Group
				title={t.purchasing.tabs.pos}
				icon={icons.shoppingCart}
				count={r.pos.length}
				all={`/purchasing/po?q=${enc}&status=all`}
			>
				{top(r.pos).map((po) => (
					<Row
						href={`/purchasing/po/${po.id}`}
						primary={po.number}
						secondary={po.supplierName}
						extra={<PoStatusBadge status={po.status} />}
					/>
				))}
			</Group>
			<Group title={t.nav.suppliers} icon={icons.factory} count={r.suppliers.length} all={`/suppliers?q=${enc}`}>
				{top(r.suppliers).map((s) => (
					<Row href={`/suppliers/${s.id}`} primary={s.name} secondary={s.email} />
				))}
			</Group>
		</div>
	);
}

searchRoutes.get("/", async (c) => {
	const t = c.var.t;
	const q = (c.req.query("q") ?? "").trim();
	const results = q ? await globalSearch(c.var.db, q) : null;
	return page(
		c,
		q ? `${t.search.title}: ${q}` : t.search.title,
		<>
			<search>
				<form method="get" action="/search" class="mb-6 flex flex-col gap-2">
					<h1 class="text-2xl font-semibold tracking-tight">{t.search.title}</h1>
					<div class="relative max-w-2xl">
						<Icon
							icon={icons.search}
							class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
						/>
						<input
							type="search"
							name="q"
							value={q}
							placeholder={t.app.searchAll}
							aria-label={t.search.title}
							autofocus={!q}
							class="h-11 pl-9 text-base coarse:h-12"
						/>
					</div>
					<p class="flex items-center gap-1.5 text-sm text-muted-foreground">
						{t.search.prompt}
						<span class="inline-flex items-center gap-1 coarse:hidden">
							<Kbd>/</Kbd>
						</span>
					</p>
				</form>
			</search>
			{results ? <Results q={q} r={results} /> : null}
		</>,
	);
});
