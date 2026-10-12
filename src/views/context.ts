import type { Context } from "hono";
import { createContext, useContext } from "hono/jsx";
import { type Dict, dict, type Locale } from "../i18n";
import type { AppEnv } from "../types";

/** Per-request values available to every component through useApp(). */
export type AppView = {
	t: Dict;
	locale: Locale;
	user: string;
	isAdmin: boolean;
	currency: string;
	/** Current path + query, used for active nav links and language switch. */
	path: string;
};

export const AppViewContext = createContext<AppView>({
	t: dict("en"),
	locale: "en",
	user: "",
	isAdmin: false,
	currency: "EUR",
	path: "/",
});

export const useApp = (): AppView => useContext(AppViewContext);

export function viewFor(c: Context<AppEnv>): AppView {
	const url = new URL(c.req.url);
	return {
		t: c.var.t,
		locale: c.var.locale,
		user: c.var.user,
		isAdmin: c.var.isAdmin,
		currency: c.env.CURRENCY || "EUR",
		path: url.pathname + url.search,
	};
}
