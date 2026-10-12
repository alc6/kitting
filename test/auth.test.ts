import { createLocalJWKSet, exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { isDevBypass, normalizeTeamDomain, parseAdminEmails, verifyAccessJwt } from "../src/middleware/auth";
import { CONTENT_SECURITY_POLICY } from "../src/middleware/security";
import { one, postForm, request, TESTER } from "./helpers";

const TEAM = "kitting-test.cloudflareaccess.com";
const AUD = "test-aud-tag";
const PROD = { ENVIRONMENT: "production", TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, DEV_AUTH_EMAIL: "" };

let privateKey: CryptoKey;
let jwks: { keys: JWK[] };

beforeAll(async () => {
	const pair = await generateKeyPair("RS256", { extractable: true });
	privateKey = pair.privateKey;
	jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" }] };
});

afterEach(() => {
	vi.restoreAllMocks();
});

function sign(claims: Record<string, unknown>, opts: { iss?: string; aud?: string; exp?: string } = {}) {
	return new SignJWT(claims)
		.setProtectedHeader({ alg: "RS256", kid: "k1" })
		.setIssuer(opts.iss ?? `https://${TEAM}`)
		.setAudience(opts.aud ?? AUD)
		.setIssuedAt()
		.setExpirationTime(opts.exp ?? "1h")
		.sign(privateKey);
}

describe("verifyAccessJwt", () => {
	const verify = (token: string) =>
		verifyAccessJwt(token, { teamDomain: TEAM, aud: AUD, jwks: createLocalJWKSet(jwks) });

	it("accepts a valid token and returns the lower-cased email", async () => {
		expect(await verify(await sign({ email: "Alice@Example.com" }))).toBe("alice@example.com");
	});

	it("rejects wrong audience, wrong issuer, expiry and missing email", async () => {
		await expect(verify(await sign({ email: "a@example.com" }, { aud: "other" }))).rejects.toThrow();
		await expect(verify(await sign({ email: "a@example.com" }, { iss: "https://evil.example.com" }))).rejects.toThrow();
		await expect(verify(await sign({ email: "a@example.com" }, { exp: "-1m" }))).rejects.toThrow();
		await expect(verify(await sign({ sub: "service-token" }))).rejects.toThrow();
		await expect(verify("not-a-jwt")).rejects.toThrow();
	});

	it("refuses to verify when Access is not configured", async () => {
		await expect(
			verifyAccessJwt(await sign({ email: "a@example.com" }), { teamDomain: "", aud: AUD }),
		).rejects.toThrow();
		await expect(
			verifyAccessJwt(await sign({ email: "a@example.com" }), { teamDomain: TEAM, aud: "" }),
		).rejects.toThrow();
	});
});

describe("Access middleware", () => {
	it("returns 403 without a token in production", async () => {
		expect((await request("/", {}, PROD)).status).toBe(403);
	});

	it("ignores DEV_AUTH_EMAIL outside development", async () => {
		const res = await request("/", {}, { ...PROD, DEV_AUTH_EMAIL: "dev@example.com" });
		expect(res.status).toBe(403);
		const staging = await request("/", {}, { ...PROD, ENVIRONMENT: "staging", DEV_AUTH_EMAIL: "dev@example.com" });
		expect(staging.status).toBe(403);
	});

	it("returns 403 for an invalid token", async () => {
		const res = await request("/", { headers: { "Cf-Access-Jwt-Assertion": "garbage" } }, PROD);
		expect(res.status).toBe(403);
	});

	it("accepts a valid token verified against the team certs", async () => {
		const realFetch = globalThis.fetch;
		const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url === `https://${TEAM}/cdn-cgi/access/certs`) return Response.json(jwks);
			return realFetch(input, init);
		});
		const token = await sign({ email: "bob@example.com" });
		const res = await request("/", { headers: { "Cf-Access-Jwt-Assertion": token } }, PROD);
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("bob@example.com");
		expect(spy).toHaveBeenCalled();
		// A token for another application is refused.
		const other = await sign({ email: "bob@example.com" }, { aud: "another-app" });
		expect((await request("/", { headers: { "Cf-Access-Jwt-Assertion": other } }, PROD)).status).toBe(403);
	});

	it("uses DEV_AUTH_EMAIL in development and stores it on writes", async () => {
		const res = await postForm("/suppliers", { name: "Dev Supplier", email: "", phone: "", notes: "" });
		expect(res.status).toBe(303);
		const row = await one<{ created_by: string; updated_by: string }>(
			"SELECT created_by, updated_by FROM suppliers WHERE name = 'Dev Supplier'",
		);
		expect(row).toEqual({ created_by: TESTER, updated_by: TESTER });
	});
});

describe("security headers and CSRF", () => {
	it("sends a strict CSP without inline allowances", async () => {
		const res = await request("/");
		expect(res.headers.get("Content-Security-Policy")).toBe(CONTENT_SECURITY_POLICY);
		expect(CONTENT_SECURITY_POLICY).toContain("default-src 'self'");
		expect(CONTENT_SECURITY_POLICY).not.toContain("unsafe-inline");
		expect(CONTENT_SECURITY_POLICY).not.toContain("unsafe-eval");
		expect(res.headers.get("X-Frame-Options")).toBe("DENY");
	});

	it("rejects POSTs with a foreign or missing Origin", async () => {
		const data = { name: "X", email: "", phone: "", notes: "" };
		expect((await postForm("/suppliers", data, {}, { Origin: "https://evil.example.com" })).status).toBe(403);
		const noOrigin = await request("/suppliers", {
			method: "POST",
			body: new URLSearchParams(data),
			headers: { Origin: "" },
		});
		expect(noOrigin.status).toBe(403);
		expect((await postForm("/suppliers", data)).status).toBe(303);
	});

	it("never renders inline scripts or styles", async () => {
		const html = await (await request("/parts/new")).text();
		expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
		expect(html).not.toMatch(/\sstyle=/);
		expect(html).not.toContain("<style");
		expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
	});
});

describe("helpers", () => {
	it("normalises team domains and admin lists", () => {
		expect(normalizeTeamDomain("https://Acme.cloudflareaccess.com/")).toBe("acme.cloudflareaccess.com");
		expect(parseAdminEmails(" A@x.com, b@y.com ,, nope")).toEqual(["a@x.com", "b@y.com"]);
		expect(isDevBypass({ ENVIRONMENT: "development", DEV_AUTH_EMAIL: "" })).toBe(false);
		expect(isDevBypass({ ENVIRONMENT: "production", DEV_AUTH_EMAIL: "a@b.c" })).toBe(false);
		expect(isDevBypass({ ENVIRONMENT: "development", DEV_AUTH_EMAIL: "a@b.c" })).toBe(true);
	});
});
