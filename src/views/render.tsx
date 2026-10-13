import type { Context } from "hono";
import { html } from "hono/html";
import type { Child } from "hono/jsx";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { runChangeSet } from "../domain/history";
import { errorText } from "../i18n";
import type { Statement } from "../lib/db";
import type { FieldErrors } from "../lib/validation";
import type { AppEnv } from "../types";
import { AppViewContext, viewFor } from "./context";
import { icons } from "./icons";
import { Layout } from "./layout";
import { Button, EmptyState } from "./ui";

/** Renders a full page inside the layout, with the per-request view context. */
export function page(c: Context<AppEnv>, title: string, body: Child, status: ContentfulStatusCode = 200) {
	return c.html(
		html`<!DOCTYPE html>${(
			<AppViewContext.Provider value={viewFor(c)}>
				<Layout title={title}>{body}</Layout>
			</AppViewContext.Provider>
		)}`,
		status,
	);
}

/** Renders an HTML fragment (htmx swaps) with the view context but no layout. */
export function fragment(c: Context<AppEnv>, body: Child, status: ContentfulStatusCode = 200) {
	return c.html(<AppViewContext.Provider value={viewFor(c)}>{body}</AppViewContext.Provider>, status);
}

/** Translates field error keys for display. */
export function translateErrors(
	c: Context<AppEnv>,
	errors: FieldErrors,
	vars: Record<string, string | number> = {},
): FieldErrors {
	const out: FieldErrors = {};
	for (const [k, v] of Object.entries(errors)) out[k] = errorText(c.var.t, v, vars);
	return out;
}

/** POST-redirect-GET helper: redirects with an `ok` flash key. */
export function redirectOk(c: Context<AppEnv>, path: string, ok = "saved") {
	const sep = path.includes("?") ? "&" : "?";
	return c.redirect(`${path}${sep}ok=${ok}`, 303);
}

export function notFound(c: Context<AppEnv>) {
	const t = c.var.t;
	return page(
		c,
		t.errors.not_found,
		<EmptyState icon={icons.search} title={t.errors.not_found} class="mt-12">
			<Button href="/" variant="outline">
				{t.nav.dashboard}
			</Button>
		</EmptyState>,
		404,
	);
}

/** Parses a positive integer route parameter, or returns null. */
export function idParam(c: Context<AppEnv>, name = "id"): number | null {
	const v = c.req.param(name);
	return v && /^\d+$/.test(v) ? Number(v) : null;
}

/**
 * Saves a change made on a page: runs the statements in one batch as a change set by the signed-in user
 * (runChangeSet in src/domain/history.ts), with `summary` as its line in the history.
 */
export function saveChanges<T extends Statement[]>(
	c: Context<AppEnv>,
	summary: string,
	statements: [...T],
	opts: { revertible?: boolean } = {},
) {
	return runChangeSet(c.var.db, { user: c.var.user, source: "ui", summary, now: nowIso(), ...opts }, statements);
}

export function nowIso(): string {
	return new Date().toISOString();
}
