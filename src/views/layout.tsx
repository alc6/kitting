import type { Child } from "hono/jsx";
import { can } from "../domain/permissions";
import { type Dict, fmt, LOCALES } from "../i18n";
import { cn } from "../lib/cn";
import { type AppView, THEMES, useApp } from "./context";
import { Icon, type IconNode, icons } from "./icons";
import { Kbd, Separator } from "./ui";

const HTMX_CONFIG = JSON.stringify({
	includeIndicatorStyles: false,
	allowEval: false,
	allowScriptTags: false,
	historyCacheSize: 0,
	// Swap 422 responses too: validation errors re-render the form fragment.
	responseHandling: [
		{ code: "204", swap: false },
		{ code: "[23]..", swap: true },
		{ code: "422", swap: true },
		{ code: "[45]..", swap: false, error: true },
	],
});

type NavKey = keyof Dict["nav"];
/** `shown` hides an item from users who may not open it (the route refuses them too). */
type NavItem = { key: NavKey; href: string; icon: IconNode; shown?: (v: AppView) => boolean };

/** Sidebar sections, grouped, in order. */
export const NAV_GROUPS: { key: keyof Dict["navGroups"]; items: NavItem[] }[] = [
	{ key: "overview", items: [{ key: "dashboard", href: "/", icon: icons.layoutDashboard }] },
	{
		key: "catalogue",
		items: [
			{ key: "parts", href: "/parts", icon: icons.package },
			{ key: "boms", href: "/boms", icon: icons.listTree },
			{ key: "suppliers", href: "/suppliers", icon: icons.factory },
			{ key: "margins", href: "/margins", icon: icons.chartColumn, shown: (v) => can(v, "costs.view") },
		],
	},
	{
		key: "operations",
		items: [
			{ key: "builds", href: "/builds", icon: icons.hammer },
			{ key: "stock", href: "/stock", icon: icons.warehouse },
			{ key: "purchasing", href: "/purchasing", icon: icons.shoppingCart },
		],
	},
	{
		key: "data",
		items: [{ key: "import", href: "/import", icon: icons.fileSpreadsheet, shown: (v) => can(v, "import.preview") }],
	},
	{ key: "admin", items: [{ key: "users", href: "/users", icon: icons.users, shown: (v) => can(v, "users.manage") }] },
];

/** The sidebar groups and items this user may open; empty groups are dropped. */
function navFor(view: AppView) {
	return NAV_GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => !i.shown || i.shown(view)) })).filter(
		(g) => g.items.length > 0,
	);
}

export const NAV: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

function isActive(path: string, href: string): boolean {
	const pathname = path.split("?")[0] ?? "/";
	return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

const THEME_ICONS = { system: icons.monitor, light: icons.sun, dark: icons.moon } as const;

/** Labels hidden when the desktop sidebar is collapsed to icons. */
const WHEN_EXPANDED = "in-data-[sidebar=collapsed]:lg:hidden";

function SidebarMenuButton(props: { item: NavItem; active: boolean; label: string }) {
	return (
		<a
			href={props.item.href}
			data-slot="sidebar-menu-button"
			data-active={props.active ? "true" : "false"}
			aria-current={props.active ? "page" : undefined}
			title={props.label}
			class="flex h-8 w-full items-center gap-2 overflow-hidden rounded-md p-2 text-left text-sm text-sidebar-foreground no-underline ring-sidebar-ring outline-hidden transition-[width,height,padding] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground coarse:h-12 in-data-[sidebar=collapsed]:lg:justify-center [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0"
		>
			<Icon icon={props.item.icon} />
			<span class={WHEN_EXPANDED}>{props.label}</span>
		</a>
	);
}

/** A row of links acting as a toggle group (shadcn ToggleGroup look), e.g. theme or language. */
function SegmentedLinks(props: {
	label: string;
	items: { href: string; label: string; active: boolean; icon?: IconNode; text?: string; data?: string }[];
}) {
	return (
		<nav
			aria-label={props.label}
			class="flex w-full items-center gap-0.5 rounded-md border border-sidebar-border bg-sidebar p-0.5"
		>
			{props.items.map((i) => (
				<a
					href={i.href}
					title={i.label}
					aria-label={i.label}
					aria-current={i.active ? "true" : undefined}
					data-state={i.active ? "on" : "off"}
					data-theme-set={i.data}
					class="flex h-7 flex-1 items-center justify-center rounded-sm text-xs font-medium text-sidebar-foreground/70 no-underline transition-colors hover:text-sidebar-foreground data-[state=on]:bg-sidebar-accent data-[state=on]:text-sidebar-accent-foreground coarse:h-10 [&>svg]:size-4"
				>
					{i.icon ? <Icon icon={i.icon} /> : i.text}
				</a>
			))}
		</nav>
	);
}

function Sidebar(props: { view: AppView }) {
	const { t, locale, user, role, path, theme } = props.view;
	const back = encodeURIComponent(path);
	return (
		<aside
			id="sidebar"
			popover="auto"
			data-slot="sidebar"
			aria-label={t.app.menu}
			class={cn(
				"sidebar m-0 h-svh max-h-none w-72 max-w-[85vw] flex-col border-0 border-r border-sidebar-border bg-sidebar p-0 text-sidebar-foreground shadow-lg backdrop:bg-black/50 open:flex",
				"lg:sticky lg:top-0 lg:flex lg:w-(--sidebar-width) lg:max-w-none lg:shrink-0 lg:shadow-none lg:transition-[width] lg:duration-200 lg:ease-linear in-data-[sidebar=collapsed]:lg:w-(--sidebar-width-icon)",
			)}
		>
			<div data-slot="sidebar-header" class="flex flex-col gap-2 p-2">
				<a
					href="/"
					class="flex items-center gap-2 rounded-md p-2 text-sidebar-foreground no-underline hover:bg-sidebar-accent in-data-[sidebar=collapsed]:lg:justify-center in-data-[sidebar=collapsed]:lg:p-1"
				>
					<span class="flex aspect-square size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground [&>svg]:size-4">
						<Icon icon={icons.boxes} />
					</span>
					<span class={cn("grid flex-1 text-left text-sm leading-tight", WHEN_EXPANDED)}>
						<span class="truncate font-semibold">{t.app.name}</span>
						<span class="truncate text-xs text-sidebar-foreground/70">{t.app.tagline}</span>
					</span>
				</a>
			</div>
			<nav data-slot="sidebar-content" class="flex min-h-0 flex-1 flex-col gap-1 overflow-auto">
				{navFor(props.view).map((group) => (
					<div data-slot="sidebar-group" class="relative flex w-full min-w-0 flex-col p-2">
						<div
							data-slot="sidebar-group-label"
							class={cn(
								"flex h-8 shrink-0 items-center rounded-md px-2 text-xs font-medium text-sidebar-foreground/70",
								WHEN_EXPANDED,
							)}
						>
							{t.navGroups[group.key]}
						</div>
						<ul data-slot="sidebar-menu" class="m-0 flex w-full min-w-0 list-none flex-col gap-1 p-0">
							{group.items.map((item) => (
								<li data-slot="sidebar-menu-item" class="relative">
									<SidebarMenuButton item={item} active={isActive(path, item.href)} label={t.nav[item.key]} />
								</li>
							))}
						</ul>
					</div>
				))}
			</nav>
			<div data-slot="sidebar-footer" class="flex flex-col gap-2 border-t border-sidebar-border p-2">
				<div class={cn("flex flex-col gap-2", WHEN_EXPANDED)}>
					<SegmentedLinks
						label={t.app.theme}
						items={THEMES.map((m) => ({
							href: `/theme/${m}?back=${back}`,
							label: t.app.themes[m],
							active: theme === m,
							icon: THEME_ICONS[m],
							data: m,
						}))}
					/>
					<SegmentedLinks
						label={t.app.language}
						items={LOCALES.map((l) => ({
							href: `/lang/${l}?back=${back}`,
							label: l.toUpperCase(),
							active: l === locale,
							text: l.toUpperCase(),
						}))}
					/>
				</div>
				<div class="flex items-center gap-2 rounded-md p-2 in-data-[sidebar=collapsed]:lg:justify-center in-data-[sidebar=collapsed]:lg:p-1">
					<span
						class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-accent text-sm font-medium text-sidebar-accent-foreground uppercase"
						title={fmt(t.app.signedInAs, { email: user })}
					>
						{user.slice(0, 1) || "?"}
					</span>
					<span class={cn("grid min-w-0 flex-1 text-left text-sm leading-tight", WHEN_EXPANDED)}>
						<span class="truncate font-medium">{user}</span>
						<span class="truncate text-xs text-sidebar-foreground/70">{t.roles.names[role]}</span>
					</span>
				</div>
			</div>
		</aside>
	);
}

function Breadcrumb(props: { section?: string; sectionHref?: string; title: string }) {
	const { t } = useApp();
	const showTitle = props.title !== props.section;
	return (
		<nav aria-label={t.app.breadcrumb} class="min-w-0">
			<ol class="m-0 flex min-w-0 list-none items-center gap-1.5 p-0 text-sm text-muted-foreground sm:gap-2">
				{props.section ? (
					<li class={cn("inline-flex min-w-0 items-center gap-1.5", showTitle && "max-sm:hidden")}>
						{showTitle ? (
							<a href={props.sectionHref} class="truncate no-underline transition-colors hover:text-foreground">
								{props.section}
							</a>
						) : (
							<span aria-current="page" class="truncate font-normal text-foreground">
								{props.section}
							</span>
						)}
					</li>
				) : null}
				{showTitle ? (
					<>
						{props.section ? (
							<li role="presentation" aria-hidden="true" class="max-sm:hidden [&>svg]:size-3.5">
								<Icon icon={icons.chevronRight} />
							</li>
						) : null}
						<li class="inline-flex min-w-0 items-center">
							<span aria-current="page" class="truncate font-normal text-foreground">
								{props.title}
							</span>
						</li>
					</>
				) : null}
			</ol>
		</nav>
	);
}

function Header(props: { title: string }) {
	const view = useApp();
	const { t, path, sidebarCollapsed } = view;
	const current = NAV.find((n) => isActive(path, n.href));
	const iconButton =
		"inline-flex size-(--control-h-sm) shrink-0 items-center justify-center rounded-md text-foreground no-underline hover:bg-accent hover:text-accent-foreground [&>svg]:size-4";
	return (
		<header class="app-header sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b bg-background/85 px-4 backdrop-blur coarse:h-16 md:px-6">
			<button type="button" popovertarget="sidebar" class={cn(iconButton, "lg:hidden")} aria-label={t.app.menu}>
				<Icon icon={icons.panelLeft} />
			</button>
			<a
				href={`/sidebar/${sidebarCollapsed ? "expanded" : "collapsed"}?back=${encodeURIComponent(path)}`}
				data-sidebar-toggle
				class={cn(iconButton, "-ml-1 max-lg:hidden")}
				aria-label={t.app.toggleSidebar}
				title={t.app.toggleSidebar}
			>
				<Icon icon={icons.panelLeft} />
			</a>
			<Separator orientation="vertical" class="mr-1 data-[orientation=vertical]:h-4" />
			<Breadcrumb section={current ? t.nav[current.key] : undefined} sectionHref={current?.href} title={props.title} />
			<search class="ml-auto">
				<form action="/search" method="get" class="flex items-center">
					<label class="relative max-md:hidden">
						<span class="sr-only">{t.common.search}</span>
						<Icon
							icon={icons.search}
							class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
						/>
						<input
							type="search"
							name="q"
							id="global-search"
							placeholder={t.app.searchAll}
							autocomplete="off"
							class="h-(--control-h-sm) w-64 bg-muted/50 pr-12 pl-8 shadow-none lg:w-80"
						/>
						<Kbd class="absolute top-1/2 right-2 -translate-y-1/2 coarse:hidden">/</Kbd>
					</label>
					<a href="/search" class={cn(iconButton, "md:hidden")} aria-label={t.common.search}>
						<Icon icon={icons.search} />
					</a>
				</form>
			</search>
		</header>
	);
}

export function Layout(props: { title: string; children: Child }) {
	const view = useApp();
	const { t, locale, theme, sidebarCollapsed } = view;
	return (
		<html
			lang={locale}
			class={theme === "system" ? undefined : theme}
			data-sidebar={sidebarCollapsed ? "collapsed" : "expanded"}
		>
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<meta name="htmx-config" content={HTMX_CONFIG} />
				<meta name="robots" content="noindex, nofollow" />
				<meta name="color-scheme" content={theme === "system" ? "light dark" : theme} />
				<title>{`${props.title} · ${t.app.name}`}</title>
				<link rel="icon" href="/static/favicon.svg" type="image/svg+xml" />
				<link rel="stylesheet" href="/static/app.css" />
				<script src="/static/htmx.min.js" defer />
				<script src="/static/app.js" defer />
			</head>
			<body class="min-h-svh">
				<a class="skip" href="#main">
					{t.app.skip}
				</a>
				<div class="flex min-h-svh w-full">
					<Sidebar view={view} />
					<div class="flex min-w-0 flex-1 flex-col">
						<Header title={props.title} />
						<main id="main" class="mx-auto w-full max-w-7xl flex-1 px-4 py-6 md:px-6 lg:px-8">
							{props.children}
						</main>
					</div>
				</div>
			</body>
		</html>
	);
}
