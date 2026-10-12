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
import { importRoutes } from "./routes/import";
import { partRoutes } from "./routes/parts";
import { stockRoutes } from "./routes/stock";
import { supplierRoutes } from "./routes/suppliers";
import type { AppEnv } from "./types";
import { notFound, page } from "./views/render";

const LOCALE_COOKIE = "kitting_lang";

const requestContext = createMiddleware<AppEnv>(async (c, next) => {
	const cookie = getCookie(c, LOCALE_COOKIE);
	const fallback: Locale = isLocale(c.env.DEFAULT_LOCALE) ? c.env.DEFAULT_LOCALE : "en";
	const locale: Locale = isLocale(cookie) ? cookie : fallback;
	c.set("locale", locale);
	c.set("t", dict(locale));
	c.set("db", drizzle(c.env.DB, { schema }));
	await next();
});

export function createApp() {
	const app = new Hono<AppEnv>();

	app.use("*", securityHeaders);
	app.use("*", accessAuth);
	app.use("*", originCheck);
	app.use("*", requestContext);

	app.get("/lang/:locale", (c) => {
		const locale = c.req.param("locale");
		if (isLocale(locale)) {
			setCookie(c, LOCALE_COOKIE, locale, {
				path: "/",
				sameSite: "Lax",
				secure: true,
				httpOnly: true,
				maxAge: 60 * 60 * 24 * 365,
			});
		}
		const back = c.req.query("back") ?? "/";
		// Only same-site relative paths: never redirect to another host.
		const safe = back.startsWith("/") && !back.startsWith("//") && !back.startsWith("/\\") ? back : "/";
		return c.redirect(safe, 303);
	});

	app.route("/", dashboardRoutes);
	app.route("/suppliers", supplierRoutes);
	app.route("/parts", partRoutes);
	app.route("/builds", buildRoutes);
	app.route("/boms", bomRoutes);
	app.route("/stock", stockRoutes);
	app.route("/import", importRoutes);

	app.notFound((c) => (c.var.t ? notFound(c) : c.text("Not found", 404)));
	app.onError((err, c) => {
		console.error(err);
		const t = c.var.t;
		if (!t) return c.text("Internal error", 500);
		return page(
			c,
			t.errors.server,
			<div class="card">
				<h1>{t.errors.server}</h1>
			</div>,
			500,
		);
	});

	return app;
}
