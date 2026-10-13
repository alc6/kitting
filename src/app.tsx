import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import * as schema from "./db/schema";
import { dict, isLocale, type Locale } from "./i18n";
import { accessAuth } from "./middleware/auth";
import { originCheck, securityHeaders } from "./middleware/security";
import { bomRoutes } from "./routes/boms";
import { buildRoutes } from "./routes/builds";
import { dashboardRoutes } from "./routes/dashboard";
import { imageRoutes } from "./routes/images";
import { importRoutes } from "./routes/import";
import { marginRoutes } from "./routes/margins";
import { partRoutes } from "./routes/parts";
import { purchasingRoutes } from "./routes/purchasing";
import { searchRoutes } from "./routes/search";
import { stockRoutes } from "./routes/stock";
import { supplierRoutes } from "./routes/suppliers";
import type { AppEnv } from "./types";
import { isTheme } from "./views/context";
import { icons } from "./views/icons";
import { notFound, page } from "./views/render";
import { Button, EmptyState } from "./views/ui";

const LOCALE_COOKIE = "kitting_lang";
const THEME_COOKIE = "kitting_theme";
const SIDEBAR_COOKIE = "kitting_sidebar";
const PREF_COOKIE = { path: "/", sameSite: "Lax", secure: true, httpOnly: true, maxAge: 60 * 60 * 24 * 365 } as const;

/** Only same-site relative paths: never redirect to another host. */
function safeBack(back: string | undefined): string {
	const b = back ?? "/";
	return b.startsWith("/") && !b.startsWith("//") && !b.startsWith("/\\") ? b : "/";
}

const requestContext = createMiddleware<AppEnv>(async (c, next) => {
	const cookie = getCookie(c, LOCALE_COOKIE);
	const fallback: Locale = isLocale(c.env.DEFAULT_LOCALE) ? c.env.DEFAULT_LOCALE : "en";
	const locale: Locale = isLocale(cookie) ? cookie : fallback;
	c.set("locale", locale);
	c.set("t", dict(locale));
	const theme = getCookie(c, THEME_COOKIE);
	c.set("theme", isTheme(theme) ? theme : "system");
	c.set("sidebarCollapsed", getCookie(c, SIDEBAR_COOKIE) === "collapsed");
	c.set("db", drizzle(c.env.DB, { schema }));
	await next();
});

export function createApp() {
	const app = new Hono<AppEnv>();

	app.use("*", securityHeaders);
	app.use("*", accessAuth);
	app.use("*", originCheck);
	app.use("*", requestContext);

	// Preferences: plain links that set a cookie and come back (they work without JavaScript;
	// app.js applies theme and sidebar changes in place and calls them in the background).
	app.get("/lang/:locale", (c) => {
		const locale = c.req.param("locale");
		if (isLocale(locale)) setCookie(c, LOCALE_COOKIE, locale, PREF_COOKIE);
		return c.redirect(safeBack(c.req.query("back")), 303);
	});

	app.get("/theme/:mode", (c) => {
		const mode = c.req.param("mode");
		if (isTheme(mode)) setCookie(c, THEME_COOKIE, mode, PREF_COOKIE);
		return c.redirect(safeBack(c.req.query("back")), 303);
	});

	app.get("/sidebar/:state", (c) => {
		const state = c.req.param("state");
		if (state === "collapsed" || state === "expanded") setCookie(c, SIDEBAR_COOKIE, state, PREF_COOKIE);
		return c.redirect(safeBack(c.req.query("back")), 303);
	});

	app.route("/", dashboardRoutes);
	app.route("/suppliers", supplierRoutes);
	app.route("/parts", imageRoutes);
	app.route("/parts", partRoutes);
	app.route("/builds", buildRoutes);
	app.route("/boms", bomRoutes);
	app.route("/stock", stockRoutes);
	app.route("/purchasing", purchasingRoutes);
	app.route("/import", importRoutes);
	app.route("/margins", marginRoutes);
	app.route("/search", searchRoutes);

	app.notFound((c) => (c.var.t ? notFound(c) : c.text("Not found", 404)));
	app.onError((err, c) => {
		console.error(err);
		const t = c.var.t;
		if (!t) return c.text("Internal error", 500);
		return page(
			c,
			t.errors.server,
			<EmptyState icon={icons.triangleAlert} title={t.errors.server} class="mt-12">
				<Button href="/" variant="outline">
					{t.nav.dashboard}
				</Button>
			</EmptyState>,
			500,
		);
	});

	return app;
}
