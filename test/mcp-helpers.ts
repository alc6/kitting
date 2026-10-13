// Helpers for the MCP and OAuth tests: a real client going through dynamic registration, the consent page,
// the PKCE code exchange and JSON-RPC calls to /mcp, all against the Worker's default export.
import { env } from "cloudflare:workers";
import { type EnvOverrides, ORIGIN, request } from "./helpers";

export const MCP_URL = `${ORIGIN}/mcp`;
export const REDIRECT_URI = "https://assistant.example.com/oauth/callback";

/** KV keeps its content across the tests of a file, like D1: start each test without clients or grants. */
export async function resetKv(): Promise<void> {
	let cursor: string | undefined;
	do {
		const page = await env.OAUTH_KV.list(cursor ? { cursor } : {});
		await Promise.all(page.keys.map((k) => env.OAUTH_KV.delete(k.name)));
		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor);
}

/** Registers a public client (RFC 7591, as an MCP client does) and returns its client_id. */
export async function registerClient(name = "Test assistant"): Promise<string> {
	const res = await request("/register", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ client_name: name, redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: "none" }),
	});
	if (res.status !== 201) throw new Error(`register: ${res.status} ${await res.text()}`);
	return ((await res.json()) as { client_id: string }).client_id;
}

const b64url = (bytes: Uint8Array) =>
	btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");

export async function pkce(): Promise<{ verifier: string; challenge: string }> {
	const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
	return { verifier, challenge: b64url(digest) };
}

/** The /authorize query of an MCP client asking for `scopes` (none: let the consent page choose). */
export function authorizeQuery(clientId: string, challenge: string, scopes: string[] = []): string {
	const q = new URLSearchParams({
		response_type: "code",
		client_id: clientId,
		redirect_uri: REDIRECT_URI,
		state: "state-123",
		code_challenge: challenge,
		code_challenge_method: "S256",
		resource: MCP_URL,
	});
	if (scopes.length) q.set("scope", scopes.join(" "));
	return `/authorize?${q}`;
}

/** Opens the consent page: its HTML, the form handle and the browser-binding cookie. */
export async function openConsent(path: string, overrides: EnvOverrides = {}) {
	const res = await request(path, {}, overrides);
	const html = await res.text();
	const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1] ?? "";
	const cookie = res.headers
		.getSetCookie()
		.map((c) => c.split(";")[0])
		.join("; ");
	return { res, html, handle, cookie };
}

/** Submits the consent form (Allow with these scopes, or Deny). */
export async function submitConsent(
	path: string,
	consent: { handle: string; cookie: string },
	decision: "approve" | "deny",
	scopes: string[],
	overrides: EnvOverrides = {},
): Promise<Response> {
	const body = new URLSearchParams({ handle: consent.handle, decision });
	for (const s of scopes) body.append("scope", s);
	return request(path, { method: "POST", body, headers: { Cookie: consent.cookie } }, overrides);
}

/** Exchanges the code for tokens at /token (PKCE). */
export async function exchangeCode(clientId: string, code: string, verifier: string) {
	const res = await request("/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code,
			redirect_uri: REDIRECT_URI,
			client_id: clientId,
			code_verifier: verifier,
			resource: MCP_URL,
		}),
	});
	if (res.status !== 200) throw new Error(`token: ${res.status} ${await res.text()}`);
	return (await res.json()) as { access_token: string; refresh_token?: string; scope: string; expires_in: number };
}

/** The whole flow: register, consent to `granted` (the client asks for `requested`), exchange. Returns the token. */
export async function connect(
	granted: string[],
	opts: { requested?: string[]; overrides?: EnvOverrides } = {},
): Promise<string> {
	const clientId = await registerClient();
	const { verifier, challenge } = await pkce();
	const path = authorizeQuery(clientId, challenge, opts.requested ?? granted);
	const consent = await openConsent(path, opts.overrides);
	if (!consent.handle) throw new Error(`no consent form: ${consent.res.status} ${consent.html.slice(0, 500)}`);
	const res = await submitConsent(path, consent, "approve", granted, opts.overrides);
	const location = res.headers.get("Location") ?? "";
	const code = new URL(location).searchParams.get("code");
	if (res.status !== 302 || !code) throw new Error(`consent: ${res.status} ${location}`);
	return (await exchangeCode(clientId, code, verifier)).access_token;
}

let nextId = 1;

/** Sends one JSON-RPC request to /mcp (2025-era, stateless) and returns the HTTP response. */
export function mcpPost(
	token: string | null,
	method: string,
	params: Record<string, unknown> = {},
	overrides: EnvOverrides = {},
) {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Accept: "application/json, text/event-stream",
		"MCP-Protocol-Version": "2025-11-25",
	};
	if (token) headers.Authorization = `Bearer ${token}`;
	return request(
		"/mcp",
		{ method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }) },
		overrides,
	);
}

type RpcResponse = { result?: Record<string, unknown>; error?: { code: number; message: string } };

/** The JSON-RPC response of a call, whether the server answered JSON or an SSE stream. */
export async function rpc(res: Response): Promise<RpcResponse> {
	const text = await res.text();
	if ((res.headers.get("Content-Type") ?? "").includes("text/event-stream")) {
		const data = text
			.split("\n")
			.filter((l) => l.startsWith("data:"))
			.map((l) => l.slice(5).trim())
			.filter(Boolean);
		const last = data.at(-1);
		if (!last) throw new Error(`empty SSE stream (${res.status})`);
		return JSON.parse(last) as RpcResponse;
	}
	try {
		return JSON.parse(text) as RpcResponse;
	} catch {
		throw new Error(`not JSON (${res.status}): ${text.slice(0, 300)}`);
	}
}

/** Calls an MCP method and returns its result (throws on a JSON-RPC error). */
export async function mcp(
	token: string,
	method: string,
	params: Record<string, unknown> = {},
	overrides: EnvOverrides = {},
) {
	const res = await mcpPost(token, method, params, overrides);
	if (res.status !== 200) throw new Error(`${method}: HTTP ${res.status} ${await res.text()}`);
	const body = await rpc(res);
	if (body.error) throw new Error(`${method}: ${body.error.message}`);
	return body.result ?? {};
}

/** The names tools/list returns. */
export async function toolNames(token: string, overrides: EnvOverrides = {}): Promise<string[]> {
	const result = await mcp(token, "tools/list", {}, overrides);
	return ((result.tools ?? []) as { name: string }[]).map((t) => t.name).sort();
}

/** Calls a tool; returns the parsed JSON text content, the raw text and whether it is an error result. */
export async function callTool(
	token: string,
	name: string,
	args: Record<string, unknown> = {},
	overrides: EnvOverrides = {},
) {
	const result = await mcp(token, "tools/call", { name, arguments: args }, overrides);
	const text = ((result.content ?? []) as { type: string; text?: string }[]).map((c) => c.text ?? "").join("");
	let data: Record<string, unknown> = {};
	try {
		data = JSON.parse(text) as Record<string, unknown>;
	} catch {
		// error results are plain text
	}
	return { data, text, isError: result.isError === true };
}
