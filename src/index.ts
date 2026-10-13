import { createApp } from "./app";
import { isOAuthPath, oauthKv, oauthOriginOk, oauthProvider } from "./mcp/oauth";

const app = createApp();

/**
 * The Worker: the app behind Cloudflare Access, plus (only with the OAUTH_KV binding) the MCP endpoint and its
 * OAuth server on a few exact paths, which are protected by OAuth tokens instead of Access (D118). Without the
 * binding every request goes to the app, exactly as before, and those paths are not found.
 */
export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
		const url = new URL(request.url);
		// A liveness check for deploy tooling: public (Access lets it through, see infra/terraform), reveals nothing.
		if (url.pathname === "/health" && (request.method === "GET" || request.method === "HEAD")) {
			return new Response("ok", { headers: { "content-type": "text/plain", "cache-control": "no-store" } });
		}
		if (oauthKv(env) && isOAuthPath(url.pathname)) {
			if (!oauthOriginOk(url.origin)) {
				return new Response("Not found: MCP needs HTTPS, or http://localhost (see docs/mcp.md).", { status: 404 });
			}
			return oauthProvider(url.origin).fetch(request, env, ctx);
		}
		return app.fetch(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
