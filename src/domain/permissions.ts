// What each role may do, by named action (D105). The single source of truth for authorization: routes
// declare the action they perform (requirePermission in src/middleware/roles.tsx), pages show a control
// only when can() allows its action, and a future API (MCP tools, OAuth scopes) can reuse the same names.
// Actions are `area.verb`; each needs a role at least `min` (viewer < operator < planner < admin).
import { ROLES, type Role } from "../db/schema";

type Rule = {
	min: Role;
	/** Lower roles get it too when an admin lets viewers and operators see costs (D103). */
	costOption?: true;
};

export const PERMISSIONS = {
	// Catalogue (office)
	"parts.edit": { min: "planner" },
	// Archiving hides a part or assembly and is undone by unarchiving; deleting is permanent (D125).
	"parts.archive": { min: "admin" },
	"parts.delete": { min: "admin" },
	"suppliers.edit": { min: "planner" },
	"suppliers.delete": { min: "admin" },
	"assemblies.edit": { min: "planner" },
	"assemblies.archive": { min: "admin" },
	"assemblies.delete": { min: "admin" },
	"prices.edit": { min: "planner" },
	// Machine types (with their hourly rate) and machines, retiring included (D147).
	"machines.edit": { min: "planner" },
	// Files of parts and assembly revisions: attach, rename, replace, remove (D165). Removing only detaches the file
	// (its object stays and the undo brings it back), so it is not an admin delete.
	"files.edit": { min: "planner" },
	// Deleting a wrong row of a price history that is not the current price (D143).
	"prices.delete": { min: "admin" },
	// Shop floor
	"builds.plan": { min: "operator" },
	"builds.complete": { min: "operator" },
	"stock.adjust": { min: "operator" },
	"stock.count": { min: "operator" },
	"purchasing.receive": { min: "operator" },
	// Storage locations (D196): the shop floor puts parts away and moves them, so operators set a part's location;
	// drawing the workshop plan is office work; removing a unit from the plan is a delete.
	"storage.assign": { min: "operator" },
	"storage.plan": { min: "planner" },
	"storage.delete": { min: "admin" },
	// Purchasing (office)
	"purchasing.order": { min: "planner" },
	"purchasing.delete": { min: "admin" },
	// Costs, prices, valuations and margins (reading)
	"costs.view": { min: "planner", costOption: true },
	// Data
	"import.preview": { min: "planner" },
	"import.commit": { min: "admin" },
	"backup.download": { min: "admin" },
	"backup.restore": { min: "admin" },
	"users.manage": { min: "admin" },
	// History: anyone may read it (amounts redacted); undoing a change also needs the edit permission of every
	// area it touched (TABLE_ACTIONS in src/domain/revert.ts), so this is only the floor.
	"history.revert": { min: "operator" },
	// AI assistants (MCP, D117): connect one and revoke one's own connections; see and revoke everyone's.
	"apps.connect": { min: "viewer" },
	"apps.manage": { min: "admin" },
} as const satisfies Record<string, Rule>;

export type Action = keyof typeof PERMISSIONS;

export const ACTIONS = Object.keys(PERMISSIONS) as Action[];

/**
 * The resources the actions are shown under, in display order (the Users page lists what each role may do,
 * generated from PERMISSIONS through can()). Each action is in exactly one group: test/permissions.test.ts fails
 * until a new action is placed. Labels: `t.roles.groups` and `t.roles.actions`.
 */
export const PERMISSION_GROUPS = [
	{ key: "parts", actions: ["parts.edit", "parts.archive", "parts.delete"] },
	{ key: "assemblies", actions: ["assemblies.edit", "assemblies.archive", "assemblies.delete"] },
	{ key: "suppliers", actions: ["suppliers.edit", "suppliers.delete"] },
	{ key: "machines", actions: ["machines.edit"] },
	{ key: "files", actions: ["files.edit"] },
	{ key: "costs", actions: ["costs.view", "prices.edit", "prices.delete"] },
	{ key: "builds", actions: ["builds.plan", "builds.complete"] },
	{ key: "stock", actions: ["stock.adjust", "stock.count"] },
	{ key: "storage", actions: ["storage.assign", "storage.plan", "storage.delete"] },
	{ key: "purchasing", actions: ["purchasing.order", "purchasing.receive", "purchasing.delete"] },
	{ key: "data", actions: ["import.preview", "import.commit", "backup.download", "backup.restore"] },
	{ key: "history", actions: ["history.revert"] },
	{ key: "apps", actions: ["apps.connect", "apps.manage"] },
	{ key: "users", actions: ["users.manage"] },
] as const satisfies readonly { key: string; actions: readonly Action[] }[];

export type PermissionGroup = (typeof PERMISSION_GROUPS)[number]["key"];

/** Who is asking: from resolveAccess() (src/domain/users.ts), once per request. */
export type Access = { role: Role; seeCosts: boolean };

/** True when `role` may do everything `min` may do. */
export function atLeast(role: Role, min: Role): boolean {
	return ROLES.indexOf(role) >= ROLES.indexOf(min);
}

/** Whether this user may perform the action. Usable anywhere: routes, views, an API. */
export function can(access: Access, action: Action): boolean {
	const rule: Rule = PERMISSIONS[action];
	if (rule.costOption) return access.seeCosts;
	return atLeast(access.role, rule.min);
}

// ---------------------------------------------------------------------------
// Cost redaction, for users who may not see costs (!can(access, "costs.view")).

/** Fields holding an amount or a margin rate: camelCase in code, snake_case in database rows (history snapshots). */
const MONEY_KEY = /(Cents|Millicents|_cents|_millicents)$|^(rateBp|rate_bp)$/;

/** A copy of `value` with every amount set to null (nested objects and arrays included). */
export function redactCosts<T>(access: Access, value: T): T {
	if (access.seeCosts) return value;
	return redact(value) as T;
}

function redact(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(redact);
	if (value === null || typeof value !== "object" || value instanceof Date) return value;
	return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, MONEY_KEY.test(k) ? null : redact(v)]));
}

/** CSV columns holding amounts or margin rates, by header name, across every export and import format. */
export const MONEY_COLUMNS: ReadonlySet<string> = new Set([
	"cost",
	"price",
	"sale_price",
	"unit_cost",
	"unit_price",
	"line_total",
	"extended_cost",
	"standard_unit_cost",
	"standard_value",
	"average_unit_cost",
	"average_value",
	"planned_cost",
	"planned_margin",
	"planned_rate_pct",
	"planned_markup_pct",
	"actual_cost",
	"actual_margin",
	"actual_rate_pct",
	"actual_markup_pct",
	"hourly_rate",
]);

/** A CSV table (header row first) without its money columns. */
export function redactCsv<T>(access: Access, rows: T[][]): T[][] {
	if (access.seeCosts || rows.length === 0) return rows;
	const keep = (rows[0] ?? []).flatMap((h, i) => (MONEY_COLUMNS.has(String(h)) ? [] : [i]));
	return rows.map((r) => keep.map((i) => r[i] as T));
}
