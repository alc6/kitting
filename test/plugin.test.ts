// The Claude plugin (plugins/kitting) is kept in sync with the MCP tools and the package version (D132): a tool
// missing from references/tools.md, a tool name the skill invents, or a version that drifts fails here.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import marketplaceRaw from "../.claude-plugin/marketplace.json?raw";
import packageRaw from "../package.json?raw";
import pluginRaw from "../plugins/kitting/.claude-plugin/plugin.json?raw";
import mcpRaw from "../plugins/kitting/.mcp.json?raw";
import examples from "../plugins/kitting/skills/kitting/references/examples.md?raw";
import glossary from "../plugins/kitting/skills/kitting/references/glossary.md?raw";
import toolsDoc from "../plugins/kitting/skills/kitting/references/tools.md?raw";
import skill from "../plugins/kitting/skills/kitting/SKILL.md?raw";
import { MCP_SCOPES } from "../src/domain/mcp-scopes";
import { INSTRUCTIONS, SERVER_INFO } from "../src/mcp/server";
import { TOOLS } from "../src/mcp/tools";

const pkg = JSON.parse(packageRaw) as { version: string };
const plugin = JSON.parse(pluginRaw) as { name: string; version: string; description: string; license: string };
const marketplace = JSON.parse(marketplaceRaw) as {
	name: string;
	owner: { name: string };
	plugins: { name: string; source: string; version?: string }[];
};
const mcp = JSON.parse(mcpRaw) as { mcpServers: Record<string, { type: string; url: string }> };

const DOCS = { "SKILL.md": skill, "tools.md": toolsDoc, "glossary.md": glossary, "examples.md": examples };
const toolNames = TOOLS.map((t) => t.name);

/** Names the skill may use besides tool names: every tool input field (from the schemas), and the result fields. */
const RESULT_FIELDS = [
	"change_set_id",
	"costs_hidden",
	"history_path",
	"history_url",
	"next_before",
	"serials_to_scan",
	"sub_assemblies",
	"pick_list",
	"as_built",
	"made_by_build",
	"new_revision",
	"active_assembly",
	"unit_cost",
	"extended_cost",
	"total_cost",
	"unit_cost_cents",
	"cost_incomplete",
	"missing_costs",
	"missing_assemblies",
	"missing_assembly",
	"to_make",
	"open_builds",
	"on_hand",
	"on_order",
	"qty_per_parent",
	"per_parent",
	"parent_batch",
	"machine_time",
	"machine_types",
	"hourly_rate",
	"active_machines",
	"planned_minutes",
	"rolled_up_cost",
	"where_used",
	"standard_cost",
	"sale_price",
	"previous_standard_cost",
	"previous_sale_price",
	"preferred_supplier",
	"supplier_ref",
	"lead_days",
	"min_stock",
	"pack_size",
	"order_milli",
	"planned_for",
	"done_at",
	"sent_at",
	"expected_at",
	"received_at",
	"created_at",
	"line_total",
	"rate_pct",
	"revertible",
	"undone_by",
	"rows_touched",
	"serial_count",
	"unit_price",
	"remaining",
	"from_stock",
	"to_build",
	"build_number",
	"insufficient_scope",
	// Values of enum inputs and records.
	"assembly_id",
	"below_zero",
	"below_min",
	"in_stock",
	"in_progress",
	"build_consume",
	"build_output",
	"purchase_order",
	"purchase_orders",
	// Attached files (D165).
	"size_bytes",
	"uploaded_at",
	"uploaded_by",
	"download_path",
	"download_url",
	"attached_to",
	// Part options (D193).
	"stock_by_options",
	"by_options",
	"missing_values",
	"missing_value",
	"total_on_hand",
	// PO charges and landed cost (D205).
	"lines_total",
	"landed_unit_cost",
	"charges_in_stock",
];

function inputFields(): Set<string> {
	const names = new Set<string>();
	const walk = (schema: unknown) => {
		if (!schema || typeof schema !== "object") return;
		const s = schema as { properties?: Record<string, unknown>; items?: unknown; anyOf?: unknown[] };
		for (const [name, child] of Object.entries(s.properties ?? {})) {
			names.add(name);
			walk(child);
		}
		walk(s.items);
		for (const a of s.anyOf ?? []) walk(a);
	};
	for (const t of TOOLS) walk(z.toJSONSchema(t.input, { io: "input", unrepresentable: "any" }));
	return names;
}

/** The snake_case words of a document (tool names, fields, scopes excluded: those use a colon). */
const snakeWords = (text: string) => new Set(text.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? []);

describe("plugin versions and manifests", () => {
	it("plugin.json has the package's version, a name and a license", () => {
		expect(plugin.version).toBe(pkg.version);
		expect(plugin.name).toBe("kitting");
		expect(plugin.license).toBe("MIT");
		expect(plugin.description.length).toBeGreaterThan(20);
	});

	it("the server reports the package's version", () => {
		expect(SERVER_INFO.version).toBe(pkg.version);
	});

	it("the marketplace lists the plugin by its manifest name, without a version of its own", () => {
		expect(marketplace.name).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
		expect(marketplace.owner.name).toBeTruthy();
		expect(marketplace.plugins).toHaveLength(1);
		const entry = marketplace.plugins[0];
		expect(entry?.name).toBe(plugin.name);
		expect(entry?.source).toBe("./plugins/kitting");
		// plugin.json's version wins over the entry's: a second one could only drift.
		expect(entry?.version).toBeUndefined();
	});

	it("the bundled MCP server takes its URL from KITTING_MCP_URL, never a real domain", () => {
		expect(mcp.mcpServers.kitting).toEqual({ type: "http", url: `\${KITTING_MCP_URL}` });
	});
});

describe("the skill", () => {
	it("has valid frontmatter (name = folder, description within claude.ai's limit) and stays short", () => {
		const front = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1] ?? "";
		const name = /^name: (.+)$/m.exec(front)?.[1];
		const description = /^description: (.+)$/m.exec(front)?.[1] ?? "";
		expect(name).toBe("kitting");
		expect(description.length).toBeGreaterThan(100);
		expect(description.length).toBeLessThanOrEqual(1024);
		expect(skill.split("\n").length).toBeLessThan(500);
		// Only fields every Agent Skills client knows.
		expect(front.split("\n").filter((l) => /^[a-z-]+:/.test(l))).toHaveLength(2);
	});

	it("links to each of its reference files", () => {
		for (const file of ["references/tools.md", "references/glossary.md", "references/examples.md"])
			expect(skill, file).toContain(`(${file})`);
	});

	it("triggers on English and French wording", () => {
		const description = /^description: (.+)$/m.exec(skill)?.[1] ?? "";
		for (const word of [
			"Assembly",
			"nomenclature",
			"stock",
			"serial",
			"shortage",
			"purchase order",
			"commandes fournisseur",
		])
			expect(description.toLowerCase(), word).toContain(word.toLowerCase());
	});
});

describe("tools.md", () => {
	const sections = new Map<string, string>();
	for (const part of toolsDoc.split(/^### /m).slice(1)) {
		const name = /^`([a-z_]+)`/.exec(part)?.[1];
		if (name) sections.set(name, part);
	}

	it("documents every registered tool exactly once", () => {
		expect([...sections.keys()].sort()).toEqual([...toolNames].sort());
		expect(toolsDoc.match(/^### `/gm)).toHaveLength(toolNames.length);
	});

	it("gives each tool's scope, permission action and an example call", () => {
		for (const t of TOOLS) {
			const section = sections.get(t.name) ?? "";
			expect(section, `${t.name} scope`).toContain(`**Scope:** \`${t.rule.scope}\``);
			if (t.rule.action) expect(section, `${t.name} permission`).toContain(`\`${t.rule.action}\``);
			expect(section, `${t.name} example`).toContain(`${t.name}(`);
			expect(section, `${t.name} inputs`).toContain("**Inputs:**");
			expect(section, `${t.name} returns`).toContain("**Returns:**");
		}
	});

	it("names every input field of the tool in its section", () => {
		for (const t of TOOLS) {
			const section = sections.get(t.name) ?? "";
			const schema = z.toJSONSchema(t.input, { io: "input", unrepresentable: "any" }) as {
				properties?: Record<string, unknown>;
			};
			for (const field of Object.keys(schema.properties ?? {})) expect(section, `${t.name}.${field}`).toContain(field);
		}
	});

	it("lists every scope", () => {
		for (const scope of Object.keys(MCP_SCOPES)) expect(toolsDoc, scope).toContain(scope);
	});
});

describe("names used by the skill and its references", () => {
	const known = new Set<string>([...toolNames, ...inputFields(), ...RESULT_FIELDS]);

	for (const [file, text] of Object.entries(DOCS)) {
		it(`${file} mentions only tools and fields that exist`, () => {
			const unknown = [...snakeWords(text)].filter((w) => !known.has(w));
			expect(unknown).toEqual([]);
		});
	}

	it("a tool-like name (verb_noun) that is not a tool is caught", () => {
		const fake = snakeWords("call create_widget then get_part");
		expect([...fake].filter((w) => !known.has(w))).toEqual(["create_widget"]);
	});

	it("SKILL.md mentions the tools its workflows rely on", () => {
		for (const name of [
			"search_parts",
			"get_shortages",
			"create_draft_pos",
			"mark_po_sent",
			"receive_po",
			"complete_build",
			"count_stock",
			"set_assembly_lines",
			"activate_assembly",
			"explode_assembly",
			"get_part",
			"list_builds",
			"upsert_supplier_offer",
			"archive_part",
		])
			expect(skill, name).toContain(name);
	});
});

describe("server instructions", () => {
	it("point to the skill and stay under Claude Code's 2,048 character limit", () => {
		expect(INSTRUCTIONS).toMatch(/skill/i);
		expect(INSTRUCTIONS).toMatch(/plugin/i);
		expect(INSTRUCTIONS.length).toBeLessThan(2048);
	});
});
