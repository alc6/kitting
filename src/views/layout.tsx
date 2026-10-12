import type { Child } from "hono/jsx";
import { fmt, LOCALES } from "../i18n";
import { useApp } from "./context";

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

type NavKey = "dashboard" | "parts" | "suppliers" | "boms" | "builds" | "purchasing" | "stock" | "import";

/** Sections shown in the top navigation, in order. */
export const NAV: { key: NavKey; href: string }[] = [
	{ key: "dashboard", href: "/" },
	{ key: "parts", href: "/parts" },
	{ key: "builds", href: "/builds" },
	{ key: "boms", href: "/boms" },
	{ key: "stock", href: "/stock" },
	{ key: "purchasing", href: "/purchasing" },
	{ key: "suppliers", href: "/suppliers" },
	{ key: "import", href: "/import" },
];

function isActive(path: string, href: string): boolean {
	const pathname = path.split("?")[0] ?? "/";
	return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

export function Layout(props: { title: string; children: Child }) {
	const { t, locale, user, isAdmin, path } = useApp();
	return (
		<html lang={locale}>
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<meta name="htmx-config" content={HTMX_CONFIG} />
				<meta name="robots" content="noindex, nofollow" />
				<title>{`${props.title} · ${t.app.name}`}</title>
				<link rel="icon" href="/static/favicon.svg" type="image/svg+xml" />
				<link rel="stylesheet" href="/static/app.css" />
				<script src="/static/htmx.min.js" defer />
				<script src="/static/app.js" defer />
			</head>
			<body>
				<a class="skip" href="#main">
					{t.app.skip}
				</a>
				<header class="topbar">
					<a class="brand" href="/">
						{t.app.name}
					</a>
					<nav class="nav">
						{NAV.map((n) => (
							<a href={n.href} class={isActive(path, n.href) ? "active" : undefined}>
								{t.nav[n.key]}
							</a>
						))}
					</nav>
				</header>
				<main id="main">{props.children}</main>
				<footer class="footer">
					<span>
						{fmt(t.app.signedInAs, { email: user })}
						{isAdmin ? <span class="badge">{t.app.admin}</span> : null}
					</span>
					<nav class="lang" aria-label={t.app.language}>
						{LOCALES.map((l) => (
							<a
								href={`/lang/${l}?back=${encodeURIComponent(path)}`}
								class={l === locale ? "active" : undefined}
								hreflang={l}
							>
								{l.toUpperCase()}
							</a>
						))}
					</nav>
				</footer>
			</body>
		</html>
	);
}
