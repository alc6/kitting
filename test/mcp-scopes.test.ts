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

describe("MCP scopes", () => {
	it("offers the read scopes to every role", () => {
		for (const role of ROLES) expect(offeredScopes({ role, seeCosts: false })).toEqual(MCP_SCOPE_NAMES);
		expect(MCP_SCOPE_NAMES).toEqual(["catalog:read", "stock:read", "builds:read", "purchasing:read"]);
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

	it("never reaches user management, backups, imports or the connections themselves", () => {
		const actions: Action[] = [
			...Object.values(MCP_SCOPES).flatMap((s) => [...s.actions]),
			...TOOLS.flatMap((t) => (t.rule.action ? [t.rule.action] : [])),
		];
		for (const a of actions) expect(NEVER_OVER_MCP).not.toContain(a);
		for (const t of TOOLS) {
			expect(t.name).not.toMatch(/delete|purge|import|backup|restore|upload|image|user|role/);
			expect(MCP_SCOPE_NAMES).toContain(t.rule.scope);
		}
	});

	it("has one tool per name, every read tool on a read scope", () => {
		expect(new Set(TOOLS.map((t) => t.name)).size).toBe(TOOLS.length);
		expect(TOOLS.map((t) => t.name).sort()).toEqual([
			"explode_bom",
			"get_bom",
			"get_build",
			"get_part",
			"get_purchase_order",
			"get_shortages",
			"list_builds",
			"list_moves",
			"list_purchase_orders",
			"search_parts",
			"stock_on_hand",
		]);
		for (const t of TOOLS) expect(MCP_SCOPES[t.rule.scope].kind).toBe("read");
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
