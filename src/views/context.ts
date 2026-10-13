import type { Context } from "hono";
import { createContext, useContext } from "hono/jsx";
import type { Role } from "../db/schema";
import { type Dict, dict, type Locale } from "../i18n";
import type { AppEnv } from "../types";

export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

export function isTheme(value: unknown): value is Theme {
	return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}

/** Per-request values available to every component through useApp(). */
export type AppView = {
	t: Dict;
	locale: Locale;
	user: string;
	/** With seeCosts, the Access that can() checks (src/domain/permissions.ts). */
	role: Role;
	/** False hides every cost, price, valuation and margin (Money renders a placeholder). */
	seeCosts: boolean;
	currency: string;
	/** Current path + query, used for active nav links and language switch. */
	path: string;
	/** Colour theme from the kitting_theme cookie; "system" follows the OS. */
	theme: Theme;
	/** Desktop sidebar collapsed to icons (kitting_sidebar cookie). */
	sidebarCollapsed: boolean;
};

export const AppViewContext = createContext<AppView>({
	t: dict("en"),
	locale: "en",
	user: "",
	role: "viewer",
	seeCosts: false,
	currency: "EUR",
	path: "/",
	theme: "system",
	sidebarCollapsed: false,
});

export const useApp = (): AppView => useContext(AppViewContext);

export function viewFor(c: Context<AppEnv>): AppView {
	const url = new URL(c.req.url);
	return {
		t: c.var.t,
		locale: c.var.locale,
		user: c.var.user,
		role: c.var.role,
		seeCosts: c.var.seeCosts,
		currency: c.env.CURRENCY || "EUR",
		path: url.pathname + url.search,
		theme: c.var.theme,
		sidebarCollapsed: c.var.sidebarCollapsed,
	};
}
