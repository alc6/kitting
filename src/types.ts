import type { DrizzleD1Database } from "drizzle-orm/d1";
import type * as schema from "./db/schema";
import type { Role } from "./db/schema";
import type { Dict, Locale } from "./i18n";
import type { Theme } from "./views/context";

export type Db = DrizzleD1Database<typeof schema>;

export type AppVariables = {
	/** Email of the authenticated user (from the Access JWT). Stored on every write. */
	user: string;
	/** From ADMIN_EMAILS or the users table (src/domain/users.ts); viewer by default. */
	role: Role;
	/** can(access, "costs.view"), computed once per request: costs, prices, valuations and margins are shown. */
	seeCosts: boolean;
	locale: Locale;
	t: Dict;
	db: Db;
	theme: Theme;
	sidebarCollapsed: boolean;
	/** Set by the MCP consent page only: the client's redirect origin, allowed in the CSP form-action (D121). */
	formActionOrigin?: string;
};

export type AppEnv = { Bindings: Env; Variables: AppVariables };
