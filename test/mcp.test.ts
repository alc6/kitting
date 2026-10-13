import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { MCP_SCOPE_NAMES } from "../src/domain/mcp-scopes";
import { oauthOriginOk } from "../src/mcp/oauth";
import { CONTENT_SECURITY_POLICY } from "../src/middleware/security";
import { loadDemo, NOT_ADMIN, ORIGIN, postForm, request, rows, seedSql, setRole, stmt, TESTER } from "./helpers";
import {
	authorizeQuery,
	callTool,
	connect,
	exchangeCode,
	MCP_URL,
	mcp,
	mcpPost,
	openConsent,
	pkce,
	REDIRECT_URI,
	registerClient,
	resetKv,
	rpc,
	submitConsent,
	toolNames,
} from "./mcp-helpers";

const ALL = ["catalog:read", "stock:read", "builds:read", "purchasing:read"];
const CATALOG_TOOLS = ["explode_assembly", "get_assembly", "get_part", "list_recent_changes", "search_parts"];
const STOCK_TOOLS = ["list_moves", "stock_on_hand"];

beforeEach(async () => {
	await resetKv();
});

describe("connecting an AI assistant", () => {
	it("runs the whole flow: register, consent to a subset, PKCE exchange, initialize, tools/list, tools/call", async () => {
		await loadDemo();
		const clientId = await registerClient("Bench assistant");
		const { verifier, challenge } = await pkce();
		const path = authorizeQuery(clientId, challenge, ALL);

		const consent = await openConsent(path);
		expect(consent.res.status).toBe(200);
		expect(consent.html).toContain("Bench assistant");
		expect(consent.html).toContain("assistant.example.com"); // where the tokens go
		for (const scope of ALL) expect(consent.html).toMatch(new RegExp(`value="${scope}" checked`));
		// The form posts here, then redirects to the client: only that origin is added to form-action.
		expect(consent.res.headers.get("Content-Security-Policy")).toContain(
			"form-action 'self' https://assistant.example.com;",
		);
		expect(consent.res.headers.get("X-Frame-Options")).toBe("DENY");

		const approved = await submitConsent(path, consent, "approve", ["catalog:read", "stock:read"]);
		expect(approved.status).toBe(302);
		const redirect = new URL(approved.headers.get("Location") ?? "");
		expect(`${redirect.origin}${redirect.pathname}`).toBe(REDIRECT_URI);
		expect(redirect.searchParams.get("state")).toBe("state-123");
		const tokens = await exchangeCode(clientId, redirect.searchParams.get("code") ?? "", verifier);
		expect(tokens.scope.split(" ").sort()).toEqual(["catalog:read", "stock:read"]);
		expect(tokens.expires_in).toBe(3600);
		expect(tokens.refresh_token).toBeTruthy();

		const init = await mcp(tokens.access_token, "initialize", {
			protocolVersion: "2025-11-25",
			capabilities: {},
			clientInfo: { name: "test", version: "1" },
		});
		expect(init.serverInfo).toMatchObject({ name: "kitting" });
		expect(String(init.instructions)).toContain("decimal");
		expect(String(init.instructions)).toContain("costs_hidden");
		expect(String(init.instructions)).toContain("Confirm before writes");
		expect(String(init.instructions)).toContain("Assembly edits go through draft revisions");
		expect(String(init.instructions)).toContain(
			"except stock and build ledger operations (adjustments, counts, receipts, build completions), which are corrected with reverse movements",
		);
		expect(await toolNames(tokens.access_token)).toEqual([...CATALOG_TOOLS, ...STOCK_TOOLS].sort());
		const found = await callTool(tokens.access_token, "search_parts", { query: "lamp" });
		expect(found.isError, found.text).toBe(false);
		expect(found.text).toContain("LAMP-DESK");
	});

	it("also serves 2026-07-28 clients: server/discover returns the instructions", async () => {
		const token = await connect(["catalog:read"]);
		const meta = {
			"io.modelcontextprotocol/protocolVersion": "2026-07-28",
			"io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
			"io.modelcontextprotocol/clientCapabilities": {},
		};
		const res = await request("/mcp", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
				"MCP-Protocol-Version": "2026-07-28",
				"Mcp-Method": "server/discover",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: meta } }),
		});
		expect(res.status).toBe(200);
		expect(String((await rpc(res)).result?.instructions)).toContain("Kitting");
	});

	it("pre-ticks the read scopes when the client asks for none, and ignores unknown ones", async () => {
		const clientId = await registerClient();
		const { challenge } = await pkce();
		const none = await openConsent(authorizeQuery(clientId, challenge));
		for (const scope of ALL) expect(none.html).toMatch(new RegExp(`value="${scope}" checked`));

		const path = authorizeQuery(clientId, challenge, ["stock:read", "users:manage"]);
		const some = await openConsent(path);
		expect(some.html).toMatch(/value="stock:read" checked/);
		expect(some.html).not.toMatch(/value="catalog:read" checked/);
		expect(some.html).toContain("users:manage"); // listed as not available
		expect(some.html).not.toContain('value="users:manage"');

		// A forged form with only unknown scopes grants nothing: the page comes back with an error.
		const forged = await submitConsent(path, some, "approve", ["users:manage"]);
		expect(forged.status).toBe(422);
		expect(await forged.text()).toContain("Tick at least one permission");
	});

	it("sends the user back to the client with access_denied when they deny", async () => {
		const clientId = await registerClient();
		const { challenge } = await pkce();
		const path = authorizeQuery(clientId, challenge, ["catalog:read"]);
		const denied = await submitConsent(path, await openConsent(path), "deny", []);
		expect(denied.status).toBe(302);
		const location = new URL(denied.headers.get("Location") ?? "");
		expect(location.searchParams.get("error")).toBe("access_denied");
		expect(location.searchParams.get("state")).toBe("state-123");
	});

	it("renders invalid requests locally and never redirects to an unregistered URI", async () => {
		const clientId = await registerClient();
		const { challenge } = await pkce();
		const path = authorizeQuery(clientId, challenge).replace(
			encodeURIComponent(REDIRECT_URI),
			encodeURIComponent("https://evil.example.com/cb"),
		);
		const res = await request(path);
		expect(res.status).toBe(400);
		expect(res.headers.get("Location")).toBeNull();
		expect(await res.text()).toContain("not valid");
	});

	it("refuses a consent handle used twice or from another browser", async () => {
		const clientId = await registerClient();
		const { challenge } = await pkce();
		const path = authorizeQuery(clientId, challenge, ["catalog:read"]);
		const consent = await openConsent(path);
		const stolen = await submitConsent(path, { ...consent, cookie: "" }, "approve", ["catalog:read"]);
		expect(stolen.status).toBe(400);
		expect((await submitConsent(path, consent, "approve", ["catalog:read"])).status).toBe(302);
		expect((await submitConsent(path, consent, "approve", ["catalog:read"])).status).toBe(400);
	});
});

describe("authorization on every MCP request", () => {
	it("refuses /mcp without a token or with a bad one", async () => {
		const none = await mcpPost(null, "tools/list");
		expect(none.status).toBe(401);
		expect(none.headers.get("WWW-Authenticate")).toContain(
			`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
		);
		expect((await mcpPost("x:y:z", "tools/list")).status).toBe(401);
	});

	it("lists only the tools of the granted scopes, and refuses a call outside them", async () => {
		await loadDemo();
		const token = await connect(["stock:read"]);
		expect(await toolNames(token)).toEqual(STOCK_TOOLS);
		const res = await mcpPost(token, "tools/call", { name: "get_part", arguments: { ref: "LAMP-DESK" } });
		expect(res.status).toBe(403);
		const challenge = res.headers.get("WWW-Authenticate") ?? "";
		expect(challenge).toContain('error="insufficient_scope"');
		expect(challenge).toContain('scope="stock:read catalog:read"');
		expect(await res.text()).toContain("not granted catalog:read");
		// An unknown tool is the SDK's error, not a crash.
		const unknown = await rpc(await mcpPost(token, "tools/call", { name: "delete_everything", arguments: {} }));
		expect(unknown.error?.message ?? JSON.stringify(unknown.result)).toContain("not found");
	});

	it("reads the user's role again on every call: a demotion applies at once", async () => {
		await loadDemo();
		await setRole("planner");
		const token = await connect(["catalog:read"], { overrides: NOT_ADMIN });
		const before = await callTool(token, "get_part", { ref: "BOX-LAMP" }, NOT_ADMIN);
		expect(before.data.costs_hidden).toBeUndefined();
		expect((before.data.part as Record<string, unknown>).standard_cost).toBe("1.20");

		await setRole("viewer");
		const after = await callTool(token, "get_part", { ref: "BOX-LAMP" }, NOT_ADMIN);
		expect(after.data.costs_hidden).toBe(true);
		expect(after.data.part).not.toHaveProperty("standard_cost");
		expect(after.text).not.toContain("1.20");
	});

	it("stops a token as soon as its grant is revoked", async () => {
		await loadDemo();
		const token = await connect(["catalog:read"]);
		expect(await toolNames(token)).toEqual(CATALOG_TOOLS);
		const page = await (await request("/connected-apps")).text();
		expect(page).toContain("Test assistant");
		const grant = /\/connected-apps\/([A-Za-z0-9_-]+)\/revoke/.exec(page)?.[1];
		expect(grant).toBeTruthy();
		const res = await postForm(`/connected-apps/${grant}/revoke`, {});
		expect(res.headers.get("Location")).toBe("/connected-apps?ok=revoked");
		expect((await mcpPost(token, "tools/list")).status).toBe(401);
		expect(await (await request("/connected-apps")).text()).not.toContain("Test assistant");
	});
});

describe("connected apps page", () => {
	it("shows people their own connections, and administrators everyone's", async () => {
		await setRole("operator", "op@example.com");
		await connect(["stock:read"], { overrides: { ...NOT_ADMIN, DEV_AUTH_EMAIL: "op@example.com" } });
		await connect(["catalog:read"]);

		const own = await (await request("/connected-apps", {}, { ...NOT_ADMIN, DEV_AUTH_EMAIL: "op@example.com" })).text();
		expect(own).toContain("stock:read");
		expect(own).not.toContain(TESTER);
		expect(own).not.toContain("/connected-apps/all/");

		const all = await (await request("/connected-apps")).text();
		expect(all).toContain("op@example.com");
		expect(all).toContain(TESTER);
		const theirs = /\/connected-apps\/all\/([A-Za-z0-9_-]+)\/revoke/.exec(all)?.[1];
		expect(theirs).toBeTruthy();

		// Only an administrator may revoke someone else's connection.
		const refused = await postForm(`/connected-apps/all/${theirs}/revoke`, {}, { ...NOT_ADMIN });
		expect(refused.status).toBe(403);
		expect((await postForm(`/connected-apps/all/${theirs}/revoke`, {})).status).toBe(303);
		expect(await (await request("/connected-apps")).text()).not.toContain("op@example.com");
	});

	it("links the page from the sidebar", async () => {
		expect(await (await request("/")).text()).toContain('href="/connected-apps"');
	});
});

describe("Access and the optional binding", () => {
	const PROD = { ENVIRONMENT: "production", DEV_AUTH_EMAIL: "" };

	it("keeps every other route behind the Access JWT, the OAuth paths only being exempt", async () => {
		const clientId = await registerClient();
		const { challenge } = await pkce();
		for (const path of [
			"/",
			"/parts",
			"/connected-apps",
			authorizeQuery(clientId, challenge, ["catalog:read"]),
			"/mcp/tools",
			"/mcpx",
			"/tokens",
			"/register/x",
			"/.well-known/security.txt",
		]) {
			const res = await request(path, {}, PROD);
			expect(res.status, path).toBe(403);
			expect(await res.text(), path).toContain("Cloudflare Access");
		}
		expect((await postForm("/connected-apps/x/revoke", {}, PROD)).status).toBe(403);

		// The exempt paths answer on their own terms (OAuth), never with the Access refusal.
		expect((await request("/.well-known/oauth-authorization-server", {}, PROD)).status).toBe(200);
		expect((await request("/.well-known/oauth-protected-resource/mcp", {}, PROD)).status).toBe(200);
		expect((await mcpPost(null, "tools/list", {}, PROD)).status).toBe(401);
		const token = await request("/token", { method: "POST", body: new URLSearchParams({}) }, PROD);
		expect(token.status).toBe(401);
		expect(await token.json()).toMatchObject({ error: "invalid_client" });
	});

	it("answers 404 on every MCP and OAuth route without the OAUTH_KV binding", async () => {
		const off = { OAUTH_KV: undefined };
		for (const path of [
			"/mcp",
			"/token",
			"/register",
			"/authorize",
			"/connected-apps",
			"/.well-known/oauth-authorization-server",
			"/.well-known/oauth-protected-resource/mcp",
		]) {
			expect((await request(path, {}, off)).status, path).toBe(404);
		}
		expect((await mcpPost(null, "tools/list", {}, off)).status).toBe(404);
		expect((await postForm("/register", {}, off)).status).toBe(404);
		expect((await postForm("/connected-apps/x/revoke", {}, off)).status).toBe(404);
		const home = await request("/", {}, off);
		expect(home.headers.get("Content-Security-Policy")).toBe(CONTENT_SECURITY_POLICY);
		expect(await home.text()).not.toContain("/connected-apps");
	});

	it("runs OAuth only over HTTPS or on a loopback host", () => {
		expect(oauthOriginOk("https://kitting.example.com")).toBe(true);
		expect(oauthOriginOk("http://localhost:8787")).toBe(true);
		expect(oauthOriginOk("http://127.0.0.1:8787")).toBe(true);
		expect(oauthOriginOk("http://[::1]:8787")).toBe(true);
		expect(oauthOriginOk("http://kitting.example.com")).toBe(false);
		expect(oauthOriginOk("http://localhost.example.com")).toBe(false);
	});

	it("advertises this deployment's /mcp as the protected resource and every scope", async () => {
		const prm = (await (await request("/.well-known/oauth-protected-resource/mcp")).json()) as Record<string, unknown>;
		expect(prm.resource).toBe(MCP_URL);
		const as = (await (await request("/.well-known/oauth-authorization-server")).json()) as Record<string, unknown>;
		expect(as.authorization_endpoint).toBe(`${ORIGIN}/authorize`);
		expect(as.token_endpoint).toBe(`${ORIGIN}/token`);
		expect(as.registration_endpoint).toBe(`${ORIGIN}/register`);
		expect(as.scopes_supported).toEqual(MCP_SCOPE_NAMES);
		expect(as.code_challenge_methods_supported).toEqual(["S256"]);
	});
});

describe("offboarding (D130)", () => {
	const OP = { ...NOT_ADMIN, DEV_AUTH_EMAIL: "op@example.com" };

	it("lets only listed people connect: others are viewers in the app but get an explanation", async () => {
		const clientId = await registerClient();
		const { challenge } = await pkce();
		const path = authorizeQuery(clientId, challenge, ["catalog:read"]);
		const consent = await openConsent(path, OP);
		expect(consent.res.status).toBe(403);
		expect(consent.handle).toBe("");
		expect(consent.html).toContain("op@example.com must be listed on the Users page");
		const forged = await submitConsent(path, { handle: "x", cookie: "" }, "approve", ["catalog:read"], OP);
		expect(forged.status).toBe(403);
		expect(forged.headers.get("Location")).toBeNull();
		expect((await env.OAUTH_KV.list({ prefix: "grant:" })).keys).toEqual([]);
		// The web app is unchanged: an unlisted person is a viewer there.
		expect((await request("/parts", {}, OP)).status).toBe(200);

		await setRole("viewer", "op@example.com");
		const token = await connect(["catalog:read"], { overrides: OP });
		expect(await toolNames(token, OP)).toEqual(CATALOG_TOOLS);
	});

	it("refuses every call once the user is no longer listed, even with a valid token", async () => {
		await loadDemo();
		await setRole("operator", "op@example.com");
		const token = await connect(["catalog:read", "stock:write"], { overrides: OP });
		expect((await callTool(token, "search_parts", { query: "lamp" }, OP)).isError).toBe(false);
		// Removed outside the Users page (no revocation): the per-call check alone stops it.
		await seedSql(stmt("DELETE FROM users WHERE email = 'op@example.com'"));
		for (const method of ["tools/list", "tools/call"]) {
			const res = await mcpPost(token, method, { name: "adjust_stock", arguments: {} }, OP);
			expect(res.status, method).toBe(403);
			expect((await rpc(res)).error?.message).toContain("op@example.com is not listed on the Users page");
		}
	});

	it("revokes all of a user's connections when they are removed on the Users page", async () => {
		await setRole("operator", "op@example.com");
		const one = await connect(["catalog:read"], { overrides: OP });
		const two = await connect(["stock:read"], { overrides: OP });
		const mine = await connect(["catalog:read"]);
		const id = (await rows<{ id: number }>("SELECT id FROM users WHERE email = 'op@example.com'"))[0]?.id;
		const removed = await postForm(`/users/${id}/delete`, {});
		expect(removed.status).toBe(303);
		expect((await mcpPost(one, "tools/list", {}, OP)).status).toBe(401);
		expect((await mcpPost(two, "tools/list", {}, OP)).status).toBe(401);
		const keys = (await env.OAUTH_KV.list({ prefix: `grant:${encodeURIComponent("op@example.com")}:` })).keys;
		expect(keys).toEqual([]);
		// Other people's connections are untouched.
		expect(await toolNames(mine)).toEqual(CATALOG_TOOLS);
		expect(await (await request("/connected-apps")).text()).not.toContain("op@example.com");
	});
});
