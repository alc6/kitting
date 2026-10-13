// Authorization on the HTTP side (auth.ts says who the user is; src/domain/permissions.ts says what each
// role may do). The role is loaded once per request; each route declares the action it performs with
// requirePermission(), and createApp() refuses to start if a write route declares none (D105).
import type { Context, MiddlewareHandler } from "hono";
import { createMiddleware } from "hono/factory";
import { type Action, can, PERMISSIONS } from "../domain/permissions";
import { resolveAccess } from "../domain/users";
import type { AppEnv } from "../types";
import { icons } from "../views/icons";
import { page } from "../views/render";
import { Button, EmptyState } from "../views/ui";
import { parseAdminEmails } from "./auth";

/** Sets role and seeCosts (the Access of src/domain/permissions.ts). Runs after requestContext (it needs the database). */
export const loadRole = createMiddleware<AppEnv>(async (c, next) => {
	const access = await resolveAccess(c.var.db, c.var.user, parseAdminEmails(c.env.ADMIN_EMAILS));
	c.set("role", access.role);
	c.set("seeCosts", access.seeCosts);
	await next();
});

const ACTION = Symbol("action");
type PermissionMiddleware = MiddlewareHandler<AppEnv> & { [ACTION]: Action };

/** Refuses the request (403 page) unless the user may perform `action`. */
export function requirePermission(action: Action): PermissionMiddleware {
	const mw = createMiddleware<AppEnv>(async (c, next) => {
		if (!can({ role: c.var.role, seeCosts: c.var.seeCosts }, action)) {
			return forbidden(c, PERMISSIONS[action].min === "admin" ? c.var.t.common.adminOnly : undefined);
		}
		await next();
	});
	return Object.assign(mw, { [ACTION]: action });
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

type RouteEntry = { method: string; path: string; handler: unknown };

function actionOf(handler: unknown): Action | undefined {
	return typeof handler === "function" ? (handler as Partial<PermissionMiddleware>)[ACTION] : undefined;
}

/** Whether a middleware registered at `pattern` (exact, or `/prefix/*`) runs for `path`. */
function covers(pattern: string, path: string): boolean {
	if (pattern === path) return true;
	if (!pattern.endsWith("/*")) return false;
	const prefix = pattern.slice(0, -2);
	return path === prefix || path.startsWith(`${prefix}/`);
}

/** Write routes (any method but GET/HEAD/OPTIONS) that no requirePermission() guards. */
export function unguardedWrites(routes: readonly RouteEntry[]): string[] {
	const guards = routes.filter((r) => actionOf(r.handler));
	const missing = routes
		.filter((r) => r.method !== "ALL" && !SAFE_METHODS.has(r.method))
		.filter((r) => !guards.some((g) => (g.method === r.method || g.method === "ALL") && covers(g.path, r.path)))
		.map((r) => `${r.method} ${r.path}`);
	return [...new Set(missing)];
}

/** Fails closed at startup: a write route without a declared action would be open to every role. */
export function assertWritesHavePermissions(routes: readonly RouteEntry[]): void {
	const missing = unguardedWrites(routes);
	if (missing.length) throw new Error(`Write routes without requirePermission(): ${missing.join(", ")}`);
}

/** 403 page: the action or page is beyond the user's role. */
export function forbidden(c: Context<AppEnv>, message?: string) {
	const t = c.var.t;
	return page(
		c,
		t.roles.forbidden,
		<EmptyState
			icon={icons.lock}
			title={t.roles.forbidden}
			description={message ?? t.roles.forbiddenHint}
			class="mt-12"
		>
			<Button href="/" variant="outline">
				{t.nav.dashboard}
			</Button>
		</EmptyState>,
		403,
	);
}
