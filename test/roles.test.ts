import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { ROLES, type Role } from "../src/db/schema";
import { atLeast, PERMISSION_GROUPS } from "../src/domain/permissions";
import { canSeeCosts, resolveAccess } from "../src/domain/users";
import { en } from "../src/i18n/en";
import { assertWritesHavePermissions, requirePermission, unguardedWrites } from "../src/middleware/roles";
import type { AppEnv } from "../src/types";
import {
	insertPart,
	insertSupplier,
	letLowerRolesSeeCosts,
	NOT_ADMIN,
	one,
	postForm,
	request,
	rows,
	setRole,
	TESTER,
	testDb,
} from "./helpers";

/** TESTER signs in with this role (ADMIN_EMAILS no longer lists them). */
async function as(role: Role) {
	await setRole(role);
	return NOT_ADMIN;
}

describe("role resolution", () => {
	it("puts ADMIN_EMAILS first, then the users table, else viewer (unlisted)", async () => {
		const db = testDb();
		expect(await resolveAccess(db, "nobody@example.com", [])).toEqual({
			role: "viewer",
			seeCosts: false,
			listed: false,
		});
		await setRole("operator", "op@example.com");
		expect(await resolveAccess(db, "op@example.com", [])).toEqual({ role: "operator", seeCosts: false, listed: true });
		// ADMIN_EMAILS cannot be demoted from the users table.
		await setRole("viewer", "boss@example.com");
		expect(await resolveAccess(db, "boss@example.com", ["boss@example.com"])).toEqual({
			role: "admin",
			seeCosts: true,
			listed: true,
		});
		expect(await resolveAccess(db, "boss@example.com", [])).toEqual({ role: "viewer", seeCosts: false, listed: true });
		await letLowerRolesSeeCosts();
		expect(await resolveAccess(db, "op@example.com", [])).toEqual({ role: "operator", seeCosts: true, listed: true });
	});

	it("orders roles and keeps costs visible to planners and admins", () => {
		expect(atLeast("admin", "planner")).toBe(true);
		expect(atLeast("planner", "planner")).toBe(true);
		expect(atLeast("operator", "planner")).toBe(false);
		expect(atLeast("viewer", "operator")).toBe(false);
		expect(canSeeCosts("planner", false)).toBe(true);
		expect(canSeeCosts("operator", false)).toBe(false);
		expect(canSeeCosts("viewer", true)).toBe(true);
	});

	it("shows the role in the sidebar and only the sections the role may open", async () => {
		const viewer = await (await request("/", {}, await as("viewer"))).text();
		expect(viewer).toContain("Viewer");
		for (const href of ['href="/import"', 'href="/users"', 'href="/margins"']) expect(viewer).not.toContain(href);
		const planner = await (await request("/", {}, await as("planner"))).text();
		expect(planner).toContain('href="/import"');
		expect(planner).toContain('href="/margins"');
		expect(planner).not.toContain('href="/users"');
		const admin = await (await request("/")).text();
		expect(admin).toContain("Administrator");
		expect(admin).toContain('href="/users"');
	});
});

describe("access policy", () => {
	it("refuses to start while a write route declares no action", () => {
		const sub = new Hono<AppEnv>();
		sub.use("*", requirePermission("users.manage"));
		sub.post("/", (c) => c.text("ok"));
		const app = new Hono<AppEnv>();
		app.use("*", async (_c, next) => next());
		app.post("/guarded", requirePermission("parts.edit"), (c) => c.text("ok"));
		app.post("/open", (c) => c.text("ok"));
		app.get("/page", (c) => c.text("ok"));
		app.route("/area", sub);
		// A router-level guard covers its routes once mounted; the untagged global middleware covers nothing.
		expect(unguardedWrites(app.routes)).toEqual(["POST /open"]);
		expect(() => assertWritesHavePermissions(app.routes)).toThrow("POST /open");
	});

	it("declares an action on every write route of the app", () => {
		expect(unguardedWrites(createApp().routes)).toEqual([]);
	});

	it("lets a viewer read but never write", async () => {
		const env = await as("viewer");
		expect((await request("/parts", {}, env)).status).toBe(200);
		const denied = await postForm("/suppliers", { name: "Acme" }, env);
		expect(denied.status).toBe(403);
		expect(await denied.text()).toContain("Your role does not allow this.");
		expect((await postForm("/stock/adjust", { part: "X", qty: "1", serial: "", note: "x" }, env)).status).toBe(403);
		expect(await rows("SELECT id FROM suppliers")).toEqual([]);
	});

	it("lets an operator adjust stock but not edit the catalogue", async () => {
		const env = await as("operator");
		const id = await insertPart("BOLT", "buy", { costCents: 12 });
		const adjust = await postForm("/stock/adjust", { part: "BOLT", qty: "3", serial: "", note: "found" }, env);
		expect(adjust.status).toBe(303);
		expect(await one("SELECT qty_milli, by FROM stock_moves")).toEqual({ qty_milli: 3000, by: TESTER });
		expect((await postForm("/suppliers", { name: "Acme" }, env)).status).toBe(403);
		expect((await postForm(`/parts/${id}`, { ref: "BOLT", name: "Renamed", kind: "buy" }, env)).status).toBe(403);
		expect((await request("/import", {}, env)).status).toBe(403);
	});

	it("lets a planner edit the catalogue but not delete, import or manage users", async () => {
		const env = await as("planner");
		expect((await postForm("/suppliers", { name: "Acme" }, env)).status).toBe(303);
		const s = await insertSupplier("Other");
		expect((await postForm(`/suppliers/${s}/delete`, {}, env)).status).toBe(403);
		expect((await request("/import", {}, env)).status).toBe(200);
		expect((await request("/import/backup.json", {}, env)).status).toBe(403);
		expect((await request("/users", {}, env)).status).toBe(403);
		expect((await postForm("/users", { email: "me@example.com", role: "admin" }, env)).status).toBe(403);
		expect(await rows("SELECT email FROM users WHERE role = 'admin'")).toEqual([]);
	});

	it("closes margins and valuation to lower roles unless an admin allows costs", async () => {
		const env = await as("operator");
		expect((await request("/margins", {}, env)).status).toBe(403);
		expect((await request("/stock/valuation", {}, env)).status).toBe(403);
		await letLowerRolesSeeCosts();
		expect((await request("/margins", {}, env)).status).toBe(200);
		expect((await request("/stock/valuation", {}, env)).status).toBe(200);
	});
});

describe("users page", () => {
	it("gives, changes and removes roles", async () => {
		const page = await (await request("/users")).text();
		expect(page).toContain("tester@example.com");
		expect(page).toContain("ADMIN_EMAILS");

		expect((await postForm("/users", { email: " Op@Example.com ", role: "operator" })).status).toBe(303);
		expect(await one("SELECT email, role, created_by FROM users")).toEqual({
			email: "op@example.com",
			role: "operator",
			created_by: TESTER,
		});
		expect((await postForm("/users", { email: "op@example.com", role: "planner" })).status).toBe(303);
		const user = await one<{ id: number; role: string }>("SELECT id, role FROM users");
		expect(user.role).toBe("planner");
		expect(await (await request(`/users?edit=${user.id}`)).text()).toContain('value="op@example.com"');

		expect((await postForm(`/users/${user.id}/delete`, {})).status).toBe(303);
		expect(await rows("SELECT id FROM users")).toEqual([]);
	});

	it("validates the form and refuses to change an ADMIN_EMAILS user", async () => {
		const bad = await postForm("/users", { email: "not-an-email", role: "boss" });
		expect(bad.status).toBe(422);
		expect(await bad.text()).toContain("Not a valid email address.");
		const config = await postForm("/users", { email: "TESTER@example.com", role: "viewer" });
		expect(config.status).toBe(422);
		expect(await config.text()).toContain("it is always an administrator");
		expect(await rows("SELECT id FROM users")).toEqual([]);
	});

	it("turns cost visibility for viewers and operators on and off", async () => {
		await postForm("/users/settings", { lower_roles_see_costs: "on" });
		expect(await one("SELECT value, updated_by FROM settings")).toEqual({ value: "1", updated_by: TESTER });
		expect(await (await request("/users")).text()).toMatch(/name="lower_roles_see_costs" value="on" checked/);
		await postForm("/users/settings", {});
		expect(await one("SELECT value FROM settings")).toEqual({ value: "0" });
	});

	it("shows what each role can do as a matrix generated from the permission table", async () => {
		const page = await (await request("/users")).text();
		expect(page).toContain(en.roles.seeEverything);
		for (const role of ROLES) expect(page).toContain(en.roles.names[role]);
		for (const group of PERMISSION_GROUPS) {
			expect(page).toContain(en.roles.groups[group.key]);
			for (const action of group.actions)
				expect(page, action).toContain(en.roles.actions[action].replace("'", "&#39;"));
		}
	});

	it("shows costs to viewers and operators in the matrix only when the setting is on", async () => {
		// The cells of the costs.view row, in role order: viewer, operator, planner, administrator.
		const costsRow = async () => {
			const html = await (await request("/users")).text();
			const row = html.split("<tr").find((r) => r.includes("See costs, prices, valuations and margins")) ?? "";
			return row
				.split("<td")
				.slice(2)
				.map((cell) => (cell.includes(">Not allowed<") ? "no" : cell.includes(">Allowed<") ? "yes" : "?"));
		};
		expect(await costsRow()).toEqual(["no", "no", "yes", "yes"]);
		await postForm("/users/settings", { lower_roles_see_costs: "on" });
		expect(await costsRow()).toEqual(["yes", "yes", "yes", "yes"]);
		await postForm("/users/settings", {});
		expect(await costsRow()).toEqual(["no", "no", "yes", "yes"]);
	});

	it("is included in the JSON backup", async () => {
		await setRole("operator", "op@example.com");
		const backup = (await (await request("/import/backup.json")).json()) as { tables: Record<string, unknown[]> };
		expect(backup.tables.users).toEqual([expect.objectContaining({ email: "op@example.com", role: "operator" })]);
		expect(backup.tables.settings).toEqual([]);
	});
});
