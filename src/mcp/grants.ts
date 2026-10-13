// What an MCP grant stores (D117), and listing grants for the connected apps page. Props are encrypted in KV and
// reach every MCP request; metadata is stored in clear for the page, so it holds names only.
import type { GrantSummary, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { z } from "zod";

/** Who consented, and the scopes they granted. Their role is read again on every request, never stored here. */
export const grantProps = z.object({ email: z.string().includes("@"), scopes: z.array(z.string()) });
export type GrantProps = z.output<typeof grantProps>;

export const grantMetadata = z.object({
	email: z.string(),
	clientName: z.string(),
	redirectHost: z.string(),
});
export type GrantMetadata = z.output<typeof grantMetadata>;

/** Grant user IDs may not contain ":" (it separates the parts of tokens and KV keys): the email, URI-encoded. */
export const grantUserId = (email: string): string => encodeURIComponent(email);

/** Grant IDs as the provider issues them (16 URL-safe characters); anything else is not a grant. */
export const isGrantId = (value: string): boolean => /^[A-Za-z0-9_-]{1,64}$/.test(value);

/** One row of the connected apps page. */
export type ConnectedApp = {
	id: string;
	userId: string;
	email: string;
	clientName: string;
	redirectHost: string;
	scopes: string[];
	createdAt: string;
	expiresAt: string | null;
};

function toApp(g: GrantSummary): ConnectedApp {
	const meta = grantMetadata.safeParse(g.metadata);
	const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
	return {
		id: g.id,
		userId: g.userId,
		email: meta.success ? meta.data.email : decodeURIComponent(g.userId),
		clientName: meta.success ? meta.data.clientName : g.clientId,
		redirectHost: meta.success ? meta.data.redirectHost : "",
		scopes: g.scope,
		createdAt: iso(g.createdAt),
		expiresAt: g.expiresAt ? iso(g.expiresAt) : null,
	};
}

/** Every grant of one user, newest first. */
export async function userGrants(api: OAuthHelpers, userId: string): Promise<ConnectedApp[]> {
	const out: ConnectedApp[] = [];
	let cursor: string | undefined;
	do {
		const page = await api.listUserGrants(userId, cursor ? { cursor } : {});
		out.push(...page.items.map(toApp));
		cursor = page.cursor;
	} while (cursor);
	return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Every user's grants, for administrators. The provider can only list one user's grants, so the users are found
 * from the grant keys, `grant:{userId}:{grantId}` (its documented KV layout; user IDs contain no ":"), D122.
 */
export async function allGrants(api: OAuthHelpers, kv: KVNamespace): Promise<ConnectedApp[]> {
	const users = new Set<string>();
	let cursor: string | undefined;
	do {
		const page = await kv.list({ prefix: "grant:", ...(cursor ? { cursor } : {}) });
		for (const key of page.keys) {
			const rest = key.name.slice("grant:".length);
			const sep = rest.lastIndexOf(":");
			if (sep > 0) users.add(rest.slice(0, sep));
		}
		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor);
	const lists = await Promise.all([...users].map((u) => userGrants(api, u)));
	return lists.flat().sort((a, b) => a.email.localeCompare(b.email) || b.createdAt.localeCompare(a.createdAt));
}
