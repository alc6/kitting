import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../types";

/**
 * The policy of every page. `formActionOrigin` adds one origin a form on the page may end up at: the MCP consent
 * form posts here, then redirects to the client's registered redirect URI, and browsers check form-action on
 * that redirect too (D121). Only an origin parsed by URL is passed, never raw input.
 */
export function contentSecurityPolicy(formActionOrigin?: string): string {
	return [
		"default-src 'self'",
		"script-src 'self'",
		"style-src 'self'",
		"img-src 'self' data:",
		"connect-src 'self'",
		formActionOrigin ? `form-action 'self' ${formActionOrigin}` : "form-action 'self'",
		"frame-ancestors 'none'",
		"base-uri 'none'",
		"object-src 'none'",
	].join("; ");
}

export const CONTENT_SECURITY_POLICY = contentSecurityPolicy();

/** Security headers on every Worker response. Inline scripts and styles are never allowed. */
export const securityHeaders = createMiddleware<AppEnv>(async (c, next) => {
	await next();
	const formAction = c.get("formActionOrigin");
	c.header("Content-Security-Policy", formAction ? contentSecurityPolicy(formAction) : CONTENT_SECURITY_POLICY);
	c.header("X-Content-Type-Options", "nosniff");
	c.header("X-Frame-Options", "DENY");
	c.header("Referrer-Policy", "same-origin");
	c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
	// Pages are never cached; a handler may opt in (product images, served at immutable URLs).
	if (!c.res.headers.has("Cache-Control")) c.header("Cache-Control", "no-store");
});

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** CSRF: rejects any non-GET request whose Origin header is missing or not this app's origin. */
export const originCheck = createMiddleware<AppEnv>(async (c, next) => {
	if (SAFE_METHODS.has(c.req.method)) return next();
	const origin = c.req.header("Origin");
	if (!origin || origin !== new URL(c.req.url).origin) {
		return c.text("Forbidden: cross-origin request", 403);
	}
	await next();
});
