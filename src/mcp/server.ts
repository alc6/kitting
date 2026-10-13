// The MCP endpoint (D115, D116): reached only with a valid OAuth access token (the provider in ./oauth.ts checks
// it), served statelessly by the official SDK: a fresh server per request, no session, no Durable Object.
// Every request reads the user's access again (a demotion applies at once), lists and runs only the tools the
// token's scopes AND the user's role allow, and redacts costs for users who may not see them.
import { insufficientScope, type OAuthResourceContext } from "@cloudflare/workers-oauth-provider";
import { type AuthInfo, createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/schema";
import { knownScopes, MCP_SCOPES, toolAllowed, toolRefusal } from "../domain/mcp-scopes";
import type { Access } from "../domain/permissions";
import { resolveAccess } from "../domain/users";
import { dict, isLocale } from "../i18n";
import { parseAdminEmails } from "../middleware/auth";
import { grantProps } from "./grants";
import { READ_ONLY_ANNOTATIONS, TOOL_BY_NAME, TOOLS, type ToolContext, ToolError, type ToolSpec } from "./tools";
import { toWire } from "./wire";

export const MCP_PATH = "/mcp";

export const SERVER_INFO = { name: "kitting", title: "Kitting", version: "0.1.0" };

/** Returned at initialize (and server/discover): what the server is and how to read its numbers. */
export const INSTRUCTIONS = [
	"Kitting is a small manufacturer's MRP: parts (buy, make, kit, fee), bills of materials (BoMs), stock moves, builds and purchase orders.",
	'Quantities and prices are decimal strings ("1.5", "12.30") in the part\'s unit and the workshop\'s currency; send quantities the same way.',
	"Read before you write: look parts and BoMs up (search_parts, get_part, get_bom) before relying on them. The tools offered depend on what the user granted and on their role.",
	"Confirm before writes: say exactly what you are about to change (records, quantities, prices) and wait for the user's go-ahead before calling any tool that changes data. Every change is made in the user's name.",
	"BoM edits go through draft revisions: set_bom_lines never changes an active BoM, it creates a new draft revision and edits that; activate_bom then makes it the one builds use (the previous revision is archived and can be activated again).",
	"Every change can be undone from Recent changes in the app (each write result gives its change set and history page), except stock and build ledger operations (adjustments, counts, receipts, build completions), which are corrected with reverse movements. You cannot undo changes yourself.",
	"Costs, prices and margins may be hidden for this user's role: they are then left out and the result has costs_hidden: true. Never guess them.",
].join("\n");

/** One MCP server for one request, with only the tools this request may use. */
export function buildServer(tools: readonly ToolSpec[], ctx: ToolContext): McpServer {
	const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
	for (const t of tools) {
		server.registerTool(
			t.name,
			{
				title: t.title,
				description: t.description,
				inputSchema: t.input,
				annotations: t.annotations ?? (MCP_SCOPES[t.rule.scope].kind === "read" ? READ_ONLY_ANNOTATIONS : undefined),
			},
			async (args: unknown) => {
				let data: Record<string, unknown>;
				try {
					data = await t.run(args, ctx);
				} catch (err) {
					if (err instanceof ToolError) throw err;
					console.error(err);
					throw new Error(`${t.name} failed with an internal error.`);
				}
				const wire = toWire(ctx.access, data);
				return { content: [{ type: "text" as const, text: JSON.stringify(wire) }], structuredContent: wire };
			},
		);
	}
	return server;
}

/** Bodies above this are left to the SDK (it answers 413 over 4 MiB); tool calls are tiny. */
const MAX_INSPECTED_BODY = 256 * 1024;

type JsonRpcCall = { id?: unknown; method?: unknown; params?: { name?: unknown } };

/**
 * Refuses a tools/call for a tool this request may not use, with a clear answer instead of the SDK's "not found":
 * the connection lacks its scope → 403 insufficient_scope naming the scopes to ask for (MCP step-up: the client
 * may re-authorize, and the consent page offers it); the user's role forbids it → a JSON-RPC error.
 */
async function refusal(
	request: Request,
	granted: readonly string[],
	access: Access,
	auth: OAuthResourceContext<unknown>["auth"],
): Promise<Response | null> {
	if (request.method !== "POST") return null;
	let body: unknown;
	try {
		const text = await request.clone().text();
		if (text.length > MAX_INSPECTED_BODY) return null;
		body = JSON.parse(text);
	} catch {
		return null;
	}
	const messages = (Array.isArray(body) ? body : [body]) as JsonRpcCall[];
	const missing = new Set<string>();
	for (const m of messages) {
		if (!m || typeof m !== "object" || m.method !== "tools/call") continue;
		const name = m.params?.name;
		const spec = typeof name === "string" ? TOOL_BY_NAME.get(name) : undefined;
		if (!spec) continue;
		const why = toolRefusal(spec.rule, granted, access);
		if (why === "role") {
			return Response.json({
				jsonrpc: "2.0",
				id: m.id ?? null,
				error: {
					code: -32602,
					message: `Refused: your role (${access.role}) does not allow ${spec.name}. An administrator can change roles in Kitting.`,
				},
			});
		}
		if (why === "scope") missing.add(spec.rule.scope);
	}
	if (missing.size === 0) return null;
	const needed = [...missing];
	return insufficientScope(
		auth,
		[...new Set([...granted, ...needed])],
		`This connection was not granted ${needed.join(", ")}. Reconnect the app and allow it.`,
	);
}

/** Refuses every call of a connection whose user is no longer listed on the Users page nor in ADMIN_EMAILS. */
function notListed(email: string): Response {
	return Response.json(
		{
			jsonrpc: "2.0",
			id: null,
			error: {
				code: -32001,
				message: `Forbidden: ${email} is not listed on the Users page of Kitting, so this connection may not be used. An administrator can add them.`,
			},
		},
		{ status: 403 },
	);
}

/** The apiHandler of the OAuth provider: called only with a valid token for this deployment's /mcp. */
export const mcpApiHandler = {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		if (new URL(request.url).pathname !== MCP_PATH) return new Response("Not found", { status: 404 });
		const { auth, props } = ctx as unknown as OAuthResourceContext<unknown>;
		const grant = grantProps.safeParse(props);
		if (!grant.success) return new Response("Forbidden: invalid grant", { status: 403 });
		const db = drizzle(env.DB, { schema });
		const email = grant.data.email.toLowerCase();
		const { listed, ...access } = await resolveAccess(db, email, parseAdminEmails(env.ADMIN_EMAILS));
		// /mcp skips Access: being listed (Users page or ADMIN_EMAILS) is what lets a connection work (D130).
		if (!listed) return notListed(email);
		const granted = knownScopes(auth.scope);
		const refused = await refusal(request, granted, access, auth);
		if (refused) return refused;
		const tools = TOOLS.filter((t) => toolAllowed(t.rule, granted, access));
		const authInfo: AuthInfo = {
			token: auth.token,
			clientId: auth.clientId ?? "",
			scopes: granted,
			...(auth.expiresAt !== undefined && { expiresAt: auth.expiresAt }),
			resource: new URL(auth.audience),
		};
		const locale = isLocale(env.DEFAULT_LOCALE) ? env.DEFAULT_LOCALE : "en";
		const context: ToolContext = {
			db,
			access,
			user: email,
			// Grants made before the client's name was kept in their props show the client ID instead.
			clientName: grant.data.clientName ?? auth.clientId ?? "MCP client",
			origin: new URL(request.url).origin,
			t: dict(locale),
		};
		const handler = createMcpHandler(() => buildServer(tools, context), {
			onerror: (error) => console.error(error),
		});
		return handler.fetch(request, { authInfo });
	},
};
