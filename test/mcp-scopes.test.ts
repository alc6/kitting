import { describe, expect, it } from "vitest";
import { ROLES } from "../src/db/schema";
import {
	isMcpScope,
	knownScopes,
	MCP_SCOPE_NAMES,
	MCP_SCOPES,
	NEVER_OVER_MCP,
	offeredScopes,
	toolAllowed,
	toolRefusal,
} from "../src/domain/mcp-scopes";
import type { Action } from "../src/domain/permissions";
import { TOOLS } from "../src/mcp/tools";
import { toWire } from "../src/mcp/wire";

const viewer = { role: "viewer", seeCosts: false } as const;
const operator = { role: "operator", seeCosts: false } as const;
const READ = ["catalog:read", "stock:read", "builds:read", "purchasing:read"];

/** Every tool, by scope (sorted): the list docs/mcp.md documents. */
const TOOLS_BY_SCOPE: Record<string, string[]> = {
	"catalog:read": [
		"explode_assembly",
		"get_assembly",
		"get_part",
		"list_machines",
		"list_recent_changes",
		"search_parts",
	],
	"catalog:write": [
		"activate_assembly",
		"create_assembly",
		"create_part",
		"create_supplier",
		"new_assembly_revision",
		"set_assembly_lines",
		"set_assembly_production",
		"update_part",
		"update_supplier",
	],
	"prices:write": ["set_sale_price", "set_standard_cost", "upsert_supplier_offer"],
	"catalog:archive": ["archive_assembly", "archive_part", "unarchive_part"],
	"stock:read": ["list_moves", "stock_on_hand"],
	"stock:write": ["adjust_stock", "count_stock"],
	"builds:read": ["get_build", "list_builds"],
	"builds:write": ["cancel_build", "complete_build", "plan_build", "record_build"],
	"purchasing:read": ["get_purchase_order", "get_shortages", "list_purchase_orders"],
	"purchasing:write": ["cancel_po", "close_po", "create_draft_pos", "mark_po_sent", "receive_po", "update_draft_po"],
};

describe("MCP scopes", () => {
	it("offers the read scopes to every role, and the write scopes whose actions the role has", () => {
		for (const role of ROLES) {
			const offered = offeredScopes({ role, seeCosts: false });
			for (const scope of READ) expect(offered, role).toContain(scope);
		}
		expect(offeredScopes(viewer)).toEqual(READ);
		expect(offeredScopes(operator)).toEqual([
			"catalog:read",
			"stock:read",
			"stock:write",
			"builds:read",
			"builds:write",
			"purchasing:read",
			"purchasing:write",
		]);
		expect(offeredScopes({ role: "planner", seeCosts: true })).toEqual(
			MCP_SCOPE_NAMES.filter((s) => s !== "catalog:archive"),
		);
		expect(offeredScopes({ role: "admin", seeCosts: true })).toEqual(MCP_SCOPE_NAMES);
		expect(MCP_SCOPE_NAMES).toEqual([
			"catalog:read",
			"catalog:write",
			"prices:write",
			"catalog:archive",
			"stock:read",
			"stock:write",
			"builds:read",
			"builds:write",
			"purchasing:read",
			"purchasing:write",
		]);
	});

	it("allows a tool only with its scope on the token AND its action in the user's role", () => {
		const read = { scope: "stock:read" } as const;
		expect(toolAllowed(read, ["stock:read"], viewer)).toBe(true);
		expect(toolAllowed(read, ["catalog:read"], viewer)).toBe(false);
		// A tool that changes data (the shape write tools will have): the role decides too.
		const write = { scope: "stock:read", action: "stock.adjust" } as const;
		expect(toolAllowed(write, ["stock:read"], viewer)).toBe(false);
		expect(toolAllowed(write, ["stock:read"], operator)).toBe(true);
		expect(toolAllowed(write, [], operator)).toBe(false);
		expect(toolRefusal(write, ["stock:read"], viewer)).toBe("role");
		expect(toolRefusal(write, [], operator)).toBe("scope");
		expect(toolRefusal(write, ["stock:read"], operator)).toBeNull();
	});

	it("keeps unknown scope strings out", () => {
		expect(knownScopes(["users:manage", "stock:read", "catalog:read", "stock:read"])).toEqual([
			"catalog:read",
			"stock:read",
		]);
		expect(isMcpScope("toString")).toBe(false);
		expect(isMcpScope("builds:read")).toBe(true);
	});

	it("never deletes permanently, undoes, manages users, backs up, imports, uploads images or manages connections", () => {
		for (const a of [
			"parts.delete",
			"suppliers.delete",
			"assemblies.delete",
			"purchasing.delete",
			"prices.delete",
			"history.revert",
			"users.manage",
			"backup.download",
			"backup.restore",
			"import.preview",
			"import.commit",
			"apps.connect",
			"apps.manage",
		] as const)
			expect(NEVER_OVER_MCP).toContain(a);
		const actions: Action[] = [
			...Object.values(MCP_SCOPES).flatMap((s) => [...s.actions]),
			...TOOLS.flatMap((t) => (t.rule.action ? [t.rule.action] : [])),
		];
		for (const a of actions) expect(NEVER_OVER_MCP).not.toContain(a);
		for (const t of TOOLS) {
			expect(t.name).not.toMatch(/delete|remove|purge|import|backup|restore|upload|image|user|role|revert|undo/);
			expect(MCP_SCOPE_NAMES).toContain(t.rule.scope);
		}
	});

	it("gives every write tool an action of its scope and annotations, and every read tool neither", () => {
		for (const t of TOOLS) {
			const scope = MCP_SCOPES[t.rule.scope];
			if (scope.kind === "read") {
				expect(t.rule.action, t.name).toBeUndefined();
				expect(t.annotations, t.name).toBeUndefined();
				continue;
			}
			expect(t.rule.action, t.name).toBeDefined();
			expect(scope.actions as readonly string[], t.name).toContain(t.rule.action);
			expect(t.annotations, t.name).toMatchObject({ readOnlyHint: false, openWorldHint: false });
			expect(typeof t.annotations?.destructiveHint, t.name).toBe("boolean");
			expect(typeof t.annotations?.idempotentHint, t.name).toBe("boolean");
		}
	});

	it("has one tool per name, each on its scope", () => {
		expect(new Set(TOOLS.map((t) => t.name)).size).toBe(TOOLS.length);
		const byScope = Object.fromEntries(
			MCP_SCOPE_NAMES.map((s) => [
				s,
				TOOLS.filter((t) => t.rule.scope === s)
					.map((t) => t.name)
					.sort(),
			]),
		);
		expect(byScope).toEqual(TOOLS_BY_SCOPE);
	});
});

describe("results on the wire", () => {
	const data = {
		ref: "BOX",
		onHandMilli: 1500,
		unitCostCents: 1230,
		costIncomplete: false,
		rollup: { totalMillicents: 123_456, missing: [] },
		lines: [{ qtyPerParentMilli: 250, lineTotalCents: null, rateBp: 3825 }],
	};

	it("turns integer fields into decimal strings with snake_case keys", () => {
		expect(toWire({ role: "planner", seeCosts: true }, data)).toEqual({
			ref: "BOX",
			on_hand: "1.5",
			unit_cost: "12.30",
			cost_incomplete: false,
			rollup: { total: "1.23", missing: [] },
			lines: [{ qty_per_parent: "0.25", line_total: null, rate_pct: "38.25" }],
		});
	});

	it("drops every amount, and says so, when the user may not see costs", () => {
		expect(toWire(viewer, data)).toEqual({
			ref: "BOX",
			on_hand: "1.5",
			cost_incomplete: false,
			rollup: { missing: [] },
			lines: [{ qty_per_parent: "0.25" }],
			costs_hidden: true,
		});
	});
});
