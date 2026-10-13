// The OAuth 2.1 authorization server behind the MCP endpoint (D115, D118), from @cloudflare/workers-oauth-provider.
// Optional like the images bucket (D100): without the OAUTH_KV binding nothing here is reachable and the app is
// unchanged. Clients, grants and tokens live in that KV namespace (tokens and secrets only as hashes, props
// encrypted); the database is not touched.
import {
	getOAuthApi,
	type OAuthHelpers,
	OAuthProvider,
	type OAuthProviderOptions,
} from "@cloudflare/workers-oauth-provider";
import { MCP_SCOPE_NAMES } from "../domain/mcp-scopes";
import { grantUserId, userGrants } from "./grants";
import { MCP_PATH, mcpApiHandler } from "./server";

export const AUTHORIZE_PATH = "/authorize";
export const TOKEN_PATH = "/token";
export const REGISTER_PATH = "/register";

/** Access tokens: one hour. A demotion or a revoked grant applies sooner anyway (checked on every request). */
export const ACCESS_TOKEN_TTL = 60 * 60;
/** Refresh tokens: 30 days from consent, however often they are used; then the user consents again through Access. */
export const REFRESH_TOKEN_TTL = 30 * 24 * 60 * 60;

export function oauthKv(env: Env): KVNamespace | null {
	return (env as Partial<Env>).OAUTH_KV ?? null;
}

/**
 * The only paths that skip Cloudflare Access and the Origin check, protected by OAuth instead: exact paths, plus
 * the OAuth discovery documents. Nothing broader: /mcp/x, /tokens, /.well-known/other all stay behind Access.
 */
export function isOAuthPath(pathname: string): boolean {
	return (
		pathname === MCP_PATH ||
		pathname === TOKEN_PATH ||
		pathname === REGISTER_PATH ||
		pathname.startsWith("/.well-known/oauth-")
	);
}

/**
 * Whether OAuth can run on this origin: HTTPS (a deployment), or plain http on a loopback host (`wrangler dev`
 * with --local-upstream). Anything else, such as `wrangler dev` rewriting URLs to the custom domain over http,
 * would make the provider refuse its configuration.
 */
export function oauthOriginOk(origin: string): boolean {
	const url = new URL(origin);
	if (url.protocol === "https:") return true;
	return url.protocol === "http:" && /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/.test(url.hostname);
}

function options(origin: string): OAuthProviderOptions<Env> {
	return {
		apiRoute: MCP_PATH,
		apiHandler: mcpApiHandler,
		// Only the OAuth paths reach the provider (src/index.ts); anything else it does not own is not found.
		defaultHandler: { fetch: () => new Response("Not found", { status: 404 }) },
		authorizeEndpoint: AUTHORIZE_PATH,
		tokenEndpoint: TOKEN_PATH,
		clientRegistrationEndpoint: REGISTER_PATH,
		scopesSupported: [...MCP_SCOPE_NAMES],
		// The canonical resource is this deployment's own /mcp: the Worker only answers on its custom domain
		// (workers_dev and preview URLs are off), or on localhost under `wrangler dev`.
		resourceMetadata: { resource: `${origin}${MCP_PATH}`, resource_name: "Kitting" },
		accessTokenTTL: ACCESS_TOKEN_TTL,
		refreshTokenTTL: REFRESH_TOKEN_TTL,
	};
}

const providers = new Map<string, OAuthProvider<Env>>();

/** The provider for this origin (built once per isolate and origin: its resource is an absolute URL). */
export function oauthProvider(origin: string): OAuthProvider<Env> {
	let provider = providers.get(origin);
	if (!provider) {
		provider = new OAuthProvider<Env>(options(origin));
		providers.set(origin, provider);
	}
	return provider;
}

/** The provider's helpers (consent, grants) for the application's own pages. */
export function oauthApi(env: Env, origin: string): OAuthHelpers {
	return getOAuthApi(options(origin), env);
}

/**
 * Revokes every MCP connection of a user at once (their tokens stop working), when they are removed from the
 * Users page (D130). A no-op without the OAUTH_KV binding, or on an origin where OAuth does not run (where no
 * connection could have been made). Returns how many were revoked.
 */
export async function revokeUserGrants(env: Env, origin: string, email: string): Promise<number> {
	if (!oauthKv(env) || !oauthOriginOk(origin)) return 0;
	const api = oauthApi(env, origin);
	const grants = await userGrants(api, grantUserId(email.toLowerCase()));
	for (const g of grants) await api.revokeGrant(g.id, g.userId);
	return grants.length;
}
