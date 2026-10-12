import type { DrizzleD1Database } from "drizzle-orm/d1";
import type * as schema from "./db/schema";
import type { Dict, Locale } from "./i18n";
import type { Theme } from "./views/context";

export type Db = DrizzleD1Database<typeof schema>;

export type AppVariables = {
	/** Email of the authenticated user (from the Access JWT). Stored on every write. */
	user: string;
	isAdmin: boolean;
	locale: Locale;
	t: Dict;
	db: Db;
	theme: Theme;
	sidebarCollapsed: boolean;
};

export type AppEnv = { Bindings: Env; Variables: AppVariables };
