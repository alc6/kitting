// What an AI assistant connected over MCP may do (D116). A connection's OAuth scopes are a ceiling the user
// chose at consent; the permission table (./permissions.ts) still decides, on every request, with the user's
// current role: a tool is listed and callable only when the token carries its scope AND can() allows its action.
// Write scopes (catalog:write → parts.edit/boms.edit, prices:write → prices.edit, catalog:archive → parts.delete,
// stock:write → stock.adjust/stock.count, builds:write → builds.plan/builds.complete, purchasing:write →
// purchasing.order/purchasing.receive) are added here, with their actions, when their tools exist.
import { type Access, type Action, can } from "./permissions";

type ScopeRule = {
	/** "read" scopes only read. A client that asks for nothing gets the read scopes pre-ticked, never a write one. */
	kind: "read" | "write";
	/**
	 * The permission actions this scope's tools perform. Empty: reading, open to every signed-in user (as the
	 * pages are). The scope is offered at consent when the user's role allows at least one of them.
	 */
	actions: readonly Action[];
};

export const MCP_SCOPES = {
	"catalog:read": { kind: "read", actions: [] },
	"stock:read": { kind: "read", actions: [] },
	"builds:read": { kind: "read", actions: [] },
	"purchasing:read": { kind: "read", actions: [] },
} as const satisfies Record<string, ScopeRule>;

export type McpScope = keyof typeof MCP_SCOPES;

export const MCP_SCOPE_NAMES = Object.keys(MCP_SCOPES) as McpScope[];

/**
 * Never reachable over MCP, now or later: user management, backup and restore, CSV import, and these connections
 * themselves. Permanent deletes and image uploads have no tool either (they share actions with archiving and
 * editing, so the rule is on tools: test/mcp-scopes.test.ts checks the names).
 */
export const NEVER_OVER_MCP: readonly Action[] = [
	"users.manage",
	"backup.download",
	"backup.restore",
	"import.preview",
	"import.commit",
	"apps.connect",
	"apps.manage",
];

export function isMcpScope(value: unknown): value is McpScope {
	return typeof value === "string" && Object.hasOwn(MCP_SCOPES, value);
}

/** Whether this user's role allows a scope at all (what consent offers). */
export function scopeAllowed(access: Access, scope: McpScope): boolean {
	const actions: readonly Action[] = MCP_SCOPES[scope].actions;
	return actions.length === 0 || actions.some((a) => can(access, a));
}

/** The scopes this user may grant to an app, in table order. */
export function offeredScopes(access: Access): McpScope[] {
	return MCP_SCOPE_NAMES.filter((s) => scopeAllowed(access, s));
}

/** Known scopes among `values` (a token's or a form's), deduplicated, in table order. */
export function knownScopes(values: readonly unknown[]): McpScope[] {
	return MCP_SCOPE_NAMES.filter((s) => values.includes(s));
}

/** What a tool needs: its scope on the token, and (for tools that change data) a permission action. */
export type ToolRule = { scope: McpScope; action?: Action };

/** Whether a tool may be listed and called on this request. */
export function toolAllowed(rule: ToolRule, granted: readonly string[], access: Access): boolean {
	if (!granted.includes(rule.scope) || !scopeAllowed(access, rule.scope)) return false;
	return rule.action === undefined || can(access, rule.action);
}

/** Why a tool may not run: the connection lacks its scope (re-authorize), or the user's role forbids it. */
export function toolRefusal(rule: ToolRule, granted: readonly string[], access: Access): "scope" | "role" | null {
	if (rule.action !== undefined && !can(access, rule.action)) return "role";
	if (!scopeAllowed(access, rule.scope)) return "role";
	if (!granted.includes(rule.scope)) return "scope";
	return null;
}
