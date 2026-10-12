// Cloudflare Access authentication. Fails closed: any request without a valid
// Access JWT gets a 403. The only bypass is DEV_AUTH_EMAIL, honoured only when
// ENVIRONMENT is exactly "development" (local `wrangler dev`).
import { createMiddleware } from "hono/factory";
import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";
import type { AppEnv } from "../types";

export const ACCESS_JWT_HEADER = "Cf-Access-Jwt-Assertion";

const remoteJwks = new Map<string, JWTVerifyGetKey>();

/** "https://acme.cloudflareaccess.com/" -> "acme.cloudflareaccess.com" */
export function normalizeTeamDomain(value: string): string {
	return value
		.trim()
		.replace(/^https?:\/\//i, "")
		.replace(/\/+$/, "")
		.toLowerCase();
}

function jwksFor(teamDomain: string): JWTVerifyGetKey {
	let jwks = remoteJwks.get(teamDomain);
	if (!jwks) {
		jwks = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
		remoteJwks.set(teamDomain, jwks);
	}
	return jwks;
}

/**
 * Verifies an Access JWT (signature, `iss`, `aud`, expiry) and returns the user's email.
 * Throws on any failure. `jwks` is injectable for tests.
 */
export async function verifyAccessJwt(
	token: string,
	opts: { teamDomain: string; aud: string; jwks?: JWTVerifyGetKey },
): Promise<string> {
	const teamDomain = normalizeTeamDomain(opts.teamDomain);
	if (!teamDomain || !opts.aud) throw new Error("Access is not configured");
	const { payload } = await jwtVerify(token, opts.jwks ?? jwksFor(teamDomain), {
		issuer: `https://${teamDomain}`,
		audience: opts.aud,
		algorithms: ["RS256"],
	});
	const email = payload.email;
	if (typeof email !== "string" || !email.includes("@")) throw new Error("Access JWT has no email");
	return email.toLowerCase();
}

export function isDevBypass(env: Pick<Env, "ENVIRONMENT" | "DEV_AUTH_EMAIL">): boolean {
	return (
		env.ENVIRONMENT === "development" && typeof env.DEV_AUTH_EMAIL === "string" && env.DEV_AUTH_EMAIL.includes("@")
	);
}

export function parseAdminEmails(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((e) => e.trim().toLowerCase())
		.filter((e) => e.includes("@"));
}

export const accessAuth = createMiddleware<AppEnv>(async (c, next) => {
	let email: string;
	if (isDevBypass(c.env)) {
		email = c.env.DEV_AUTH_EMAIL.trim().toLowerCase();
	} else {
		const token = c.req.header(ACCESS_JWT_HEADER);
		if (!token) return c.text("Forbidden: missing Cloudflare Access token", 403);
		try {
			email = await verifyAccessJwt(token, { teamDomain: c.env.TEAM_DOMAIN ?? "", aud: c.env.ACCESS_AUD ?? "" });
		} catch {
			return c.text("Forbidden: invalid Cloudflare Access token", 403);
		}
	}
	c.set("user", email);
	c.set("isAdmin", parseAdminEmails(c.env.ADMIN_EMAILS).includes(email));
	await next();
});

/** Gates destructive actions (import commit, delete, archive) behind ADMIN_EMAILS. */
export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
	if (!c.var.isAdmin) return c.text(c.var.t?.common.adminOnly ?? "Forbidden", 403);
	await next();
});
