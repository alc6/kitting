import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../types";

export const CONTENT_SECURITY_POLICY = [
	"default-src 'self'",
	"script-src 'self'",
	"style-src 'self'",
	"img-src 'self' data:",
	"connect-src 'self'",
	"form-action 'self'",
	"frame-ancestors 'none'",
	"base-uri 'none'",
	"object-src 'none'",
].join("; ");

/** Security headers on every Worker response. Inline scripts and styles are never allowed. */
export const securityHeaders = createMiddleware<AppEnv>(async (c, next) => {
	await next();
	c.header("Content-Security-Policy", CONTENT_SECURITY_POLICY);
	c.header("X-Content-Type-Options", "nosniff");
	c.header("X-Frame-Options", "DENY");
	c.header("Referrer-Policy", "same-origin");
	c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
	c.header("Cache-Control", "no-store");
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
