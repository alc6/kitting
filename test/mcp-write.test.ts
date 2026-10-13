// MCP write tools (D126–D130): every tool's happy path, its refusals (scope, role), exactly one change set per
// call (source mcp, the client's name) that an undo reverts, and the guardrails.
import { getTableName } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { HISTORY_TABLES, type Role } from "../src/db/schema";
import { MCP_SCOPES } from "../src/domain/mcp-scopes";
import { type Access, PERMISSIONS } from "../src/domain/permissions";
import { revertChangeSet } from "../src/domain/revert";
import { TOOL_BY_NAME, TOOLS } from "../src/mcp/tools";
import { bomId, loadDemo, NOT_ADMIN, one, partId, postForm, rows, setRole, TESTER, testDb } from "./helpers";
import { callTool, connect, mcpPost, resetKv, rpc } from "./mcp-helpers";

const ADMIN: Access = { role: "admin", seeCosts: true };

beforeEach(async () => {
	await resetKv();
});

// ---------------------------------------------------------------------------
// Helpers

/** Every tracked table's rows without who/when (an undo signs and dates the rows it changes). */
async function trackedState() {
	const out: Record<string, unknown[]> = {};
	for (const t of HISTORY_TABLES) {
		const name = getTableName(t);
		const list = await rows<Record<string, unknown>>(`SELECT * FROM ${name} ORDER BY id`);
		out[name] = list.map(({ created_at, updated_at, created_by, updated_by, ...rest }) => rest);
	}
	return out;
}

const lastChangeSetId = async () => (await one<{ id: number | null }>("SELECT max(id) AS id FROM change_sets")).id ?? 0;

type ChangeSetRow = { id: number; source: string; client_name: string | null; user_email: string; revertible: number };

/** Calls a write tool as an admin connected with `scopes`; expects success. */
async function write(token: string, name: string, args: Record<string, unknown>) {
	const r = await callTool(token, name, args);
	expect(r.isError, `${name}: ${r.text}`).toBe(false);
	return r;
}

/** The change sets created since `after`. */
const changeSetsSince = (after: number) =>
	rows<ChangeSetRow>("SELECT id, source, client_name, user_email, revertible FROM change_sets WHERE id > ?", after);

const undo = (id: number) =>
	revertChangeSet(testDb(), ADMIN, id, { user: TESTER, summary: (s) => `Undo #${s.id}: ${s.summary}` });

const buildNumber = async (id: number) =>
	(await one<{ number: string }>("SELECT number FROM builds WHERE id = ?", id)).number;

/** Demo data, a planned build of 1 ARM-ASSY, a draft PO and a sent PO of 10 BOX-LAMP each. */
async function seed() {
	await loadDemo();
	const planned = await postForm("/builds", {
		part_id: String(await partId("ARM-ASSY")),
		bom_id: String(await bomId("ARM-ASSY")),
		qty: "1",
		serial: "",
		planned_for: "",
		notes: "",
	});
	const build = Number(/\/builds\/(\d+)/.exec(planned.headers.get("Location") ?? "")?.[1]);
	const supplier = (await one<{ id: number }>("SELECT supplier_id AS id FROM parts WHERE ref = 'BOX-LAMP'")).id;
	const po = async () => {
		const res = await postForm("/purchasing/po", { supplier_id: String(supplier), expected_at: "", notes: "" });
		const id = Number(/\/po\/(\d+)/.exec(res.headers.get("Location") ?? "")?.[1]);
		await postForm(`/purchasing/po/${id}/lines`, { part: "BOX-LAMP", qty: "10", price: "1.00" });
		return (await one<{ number: string }>("SELECT number FROM purchase_orders WHERE id = ?", id)).number;
	};
	const draftPo = await po();
	const sentPo = await po();
	const sentId = (await one<{ id: number }>("SELECT id FROM purchase_orders WHERE number = ?", sentPo)).id;
	await postForm(`/purchasing/po/${sentId}/send`, {});
	return { build: await buildNumber(build), draftPo, sentPo };
}

type Seed = Awaited<ReturnType<typeof seed>>;

/** Plans a build through the page (as an admin). */
async function planViaForm(ref: string, qty: string) {
	const res = await postForm("/builds", {
		part_id: String(await partId(ref)),
		bom_id: String(await bomId(ref)),
		qty,
		serial: "",
		planned_for: "",
		notes: "",
	});
	expect(res.status).toBe(303);
}

/** Receives a quantity on the only line of a PO through its page. */
async function receiveViaForm(number: string, qty: string) {
	const po = (await one<{ id: number }>("SELECT id FROM purchase_orders WHERE number = ?", number)).id;
	const line = (await one<{ id: number }>("SELECT id FROM po_lines WHERE po_id = ?", po)).id;
	expect((await postForm(`/purchasing/po/${po}/receive`, { [`recv_${line}`]: qty })).status).toBe(303);
}

type WriteCase = {
	tool: string;
	scope: string;
	/** The lowest role allowed (its action's minimum). */
	min: Exclude<Role, "viewer">;
	args: (s: Seed) => Record<string, unknown>;
	/** Writes the stock ledger: its change set cannot be undone. */
	ledger?: true;
	/** Run before the call (as an admin through the pages). */
	prepare?: (s: Seed) => Promise<unknown>;
};

/** One call of every write tool that changes something on the seed. */
const CASES: WriteCase[] = [
	{
		tool: "create_part",
		scope: "catalog:write",
		min: "planner",
		args: () => ({ ref: "NEW-1", name: "New part", kind: "buy" }),
	},
	{
		tool: "update_part",
		scope: "catalog:write",
		min: "planner",
		args: () => ({ ref: "BOX-LAMP", name: "Shipping box, large", unit: "box" }),
	},
	{
		tool: "create_supplier",
		scope: "catalog:write",
		min: "planner",
		args: () => ({ name: "Acme Example", email: "orders@acme.example" }),
	},
	{
		tool: "update_supplier",
		scope: "catalog:write",
		min: "planner",
		args: () => ({ name: "kraft box packaging", phone: "+1 555 0199" }),
	},
	{
		tool: "create_bom",
		scope: "catalog:write",
		min: "planner",
		args: () => ({ part: "ARM-ASSY", code: "long", copy_from: { bom: "ARM-ASSY" } }),
	},
	{
		tool: "set_bom_lines",
		scope: "catalog:write",
		min: "planner",
		args: () => ({ bom: "ARM-ASSY", lines: [{ ref: "ARM-TUBE-300", qty: "2" }] }),
	},
	{ tool: "new_bom_revision", scope: "catalog:write", min: "planner", args: () => ({ bom: "LAMP-DESK" }) },
	{
		tool: "activate_bom",
		scope: "catalog:write",
		min: "planner",
		args: () => ({ bom: "LAMP-DESK", revision: "Rev1" }),
	},
	{
		tool: "set_standard_cost",
		scope: "prices:write",
		min: "planner",
		args: () => ({ ref: "BOX-LAMP", cost: "1.35", note: "Quote 2026-10" }),
	},
	{ tool: "set_sale_price", scope: "prices:write", min: "planner", args: () => ({ ref: "LAMP-DESK", price: 95 }) },
	{
		tool: "upsert_supplier_offer",
		scope: "prices:write",
		min: "planner",
		args: () => ({ ref: "BOX-LAMP", supplier: "Quickparts Express", price: "1.90", moq: "1", preferred: true }),
	},
	{ tool: "archive_part", scope: "catalog:archive", min: "admin", args: () => ({ ref: "PAD-FELT" }) },
	{
		tool: "unarchive_part",
		scope: "catalog:archive",
		min: "admin",
		args: () => ({ ref: "PAD-FELT" }),
		prepare: async () => postForm(`/parts/${await partId("PAD-FELT")}/archive`, {}),
	},
	{ tool: "archive_bom", scope: "catalog:archive", min: "admin", args: () => ({ bom: "LAMP-DESK", code: "warm" }) },
	{
		tool: "adjust_stock",
		scope: "stock:write",
		min: "operator",
		args: () => ({ ref: "PAD-FELT", qty: "-5", note: "Scrapped" }),
		ledger: true,
	},
	{
		tool: "count_stock",
		scope: "stock:write",
		min: "operator",
		args: () => ({ counts: [{ ref: "PAD-FELT", qty: "390" }] }),
		ledger: true,
	},
	{ tool: "plan_build", scope: "builds:write", min: "operator", args: () => ({ ref: "ARM-ASSY", qty: "2" }) },
	{ tool: "complete_build", scope: "builds:write", min: "operator", args: (s) => ({ number: s.build }), ledger: true },
	{ tool: "cancel_build", scope: "builds:write", min: "operator", args: (s) => ({ number: s.build }) },
	{
		tool: "create_draft_pos",
		scope: "purchasing:write",
		min: "planner",
		args: () => ({}),
		prepare: () => planViaForm("ARM-ASSY", "100"),
	},
	{
		tool: "update_draft_po",
		scope: "purchasing:write",
		min: "planner",
		args: (s) => ({
			number: s.draftPo,
			expected_at: "2026-12-01",
			lines: [
				{ ref: "BOX-LAMP", qty: "15" },
				{ ref: "PAD-FELT", qty: "500" },
			],
		}),
	},
	{ tool: "mark_po_sent", scope: "purchasing:write", min: "planner", args: (s) => ({ number: s.draftPo }) },
	{
		tool: "receive_po",
		scope: "purchasing:write",
		min: "operator",
		args: (s) => ({ number: s.sentPo, lines: [{ ref: "BOX-LAMP", qty: "4" }] }),
		ledger: true,
	},
	{ tool: "cancel_po", scope: "purchasing:write", min: "planner", args: (s) => ({ number: s.sentPo }) },
	{
		tool: "close_po",
		scope: "purchasing:write",
		min: "planner",
		args: (s) => ({ number: s.sentPo }),
		prepare: (s) => receiveViaForm(s.sentPo, "4"),
	},
];

const below = (role: Role): Role => (role === "admin" ? "planner" : role === "planner" ? "operator" : "viewer");

// ---------------------------------------------------------------------------

describe("every write tool", () => {
	it("has a case here", () => {
		const writeTools = TOOLS.filter((t) => MCP_SCOPES[t.rule.scope].kind === "write").map((t) => t.name);
		expect(CASES.map((c) => c.tool).sort()).toEqual(writeTools.sort());
		for (const c of CASES) expect(TOOL_BY_NAME.get(c.tool)?.rule.scope, c.tool).toBe(c.scope);
		for (const c of CASES) expect(PERMISSIONS[TOOL_BY_NAME.get(c.tool)?.rule.action ?? "users.manage"].min).toBe(c.min);
	});

	it.each(CASES)("$tool: one change set, source mcp, with the client's name, undone by Undo", async (c) => {
		const s = await seed();
		await c.prepare?.(s);
		const token = await connect([c.scope]);
		const before = await trackedState();
		const after = await lastChangeSetId();
		const r = await write(token, c.tool, c.args(s));

		const sets = await changeSetsSince(after);
		expect(sets, c.tool).toHaveLength(1);
		const set = sets[0] as ChangeSetRow;
		expect(set).toMatchObject({ source: "mcp", client_name: "Test assistant", user_email: TESTER });
		// Never over MCP: permanent deletes of records, users and settings, images.
		const entries = await rows<{ table_name: string; op: string; old_row: string | null; new_row: string | null }>(
			"SELECT table_name, op, old_row, new_row FROM change_log WHERE change_set_id = ?",
			set.id,
		);
		for (const e of entries) {
			if (e.op === "delete")
				expect(["bom_lines", "po_lines"], `${c.tool} deletes ${e.table_name}`).toContain(e.table_name);
			expect(["users", "settings"]).not.toContain(e.table_name);
			if (e.table_name === "parts" && e.old_row && e.new_row)
				expect(JSON.parse(e.new_row).image_key).toBe(JSON.parse(e.old_row).image_key);
		}
		expect(r.data.change_set_id).toBe(set.id);
		expect(r.data.revertible).toBe(!c.ledger);
		if (c.ledger) {
			expect(set.revertible).toBe(0);
			expect(r.data.history_path).toBeUndefined();
			expect(r.text).toContain("reverse movements");
			expect(await undo(set.id)).toMatchObject({ ok: false, reason: "not_revertible" });
		} else {
			expect(set.revertible).toBe(1);
			expect(r.data.history_path).toBe(`/history/${set.id}`);
			expect(r.data.history_url).toBe(`https://kitting.example.com/history/${set.id}`);
			expect(await undo(set.id)).toMatchObject({ ok: true });
			expect(await trackedState()).toEqual(before);
		}
	});

	it.each(CASES)("$tool: refused without its scope, with the step-up answer", async (c) => {
		const s = await seed();
		const token = await connect(["catalog:read", "stock:read", "builds:read", "purchasing:read"]);
		const after = await lastChangeSetId();
		const res = await mcpPost(token, "tools/call", { name: c.tool, arguments: c.args(s) });
		expect(res.status).toBe(403);
		expect(res.headers.get("WWW-Authenticate")).toContain('error="insufficient_scope"');
		expect(res.headers.get("WWW-Authenticate")).toContain(c.scope);
		expect(await lastChangeSetId()).toBe(after);
	});

	it.each(CASES)("$tool: refused when the user's role no longer allows it", async (c) => {
		const s = await seed();
		await c.prepare?.(s);
		await setRole(c.min);
		const token = await connect([c.scope], { overrides: NOT_ADMIN });
		await setRole(below(c.min));
		const after = await lastChangeSetId();
		const res = await rpc(await mcpPost(token, "tools/call", { name: c.tool, arguments: c.args(s) }, NOT_ADMIN));
		expect(res.error?.message).toContain(`your role (${below(c.min)}) does not allow ${c.tool}`);
		expect(await lastChangeSetId()).toBe(after);
	});
});

// ---------------------------------------------------------------------------
// catalog:write

describe("catalog tools", () => {
	it("creates and edits parts with the form's checks, never touching prices", async () => {
		await loadDemo();
		const token = await connect(["catalog:write"]);
		const created = await write(token, "create_part", {
			ref: "KNOB-XL",
			name: "Large knob",
			kind: "buy",
			track_serial: false,
		});
		expect(created.data.part).toMatchObject({ ref: "KNOB-XL", kind: "buy", unit: "pcs", archived: false });
		const dup = await callTool(token, "create_part", { ref: "knob-xl", name: "Again", kind: "buy" });
		expect(dup.isError).toBe(true);
		expect(dup.text).toContain("Differs only by upper/lower case from existing reference KNOB-XL");
		const serialKit = await callTool(token, "create_part", {
			ref: "KIT-9",
			name: "Kit",
			kind: "kit",
			track_serial: true,
		});
		expect(serialKit.text).toContain("track_serial: Only buy and make parts can be serial-tracked.");

		const before = await one<{ cost_cents: number; supplier_id: number }>(
			"SELECT cost_cents, supplier_id FROM parts WHERE ref = 'BOX-LAMP'",
		);
		const history = (await one<{ n: number }>("SELECT count(*) AS n FROM price_history")).n;
		const edited = await write(token, "update_part", { ref: "box-lamp", new_ref: "BOX-LAMP-L", notes: "Bigger" });
		expect(edited.data.part).toMatchObject({ ref: "BOX-LAMP-L", name: "Shipping box", notes: "Bigger" });
		const after = await one<{ cost_cents: number; supplier_id: number }>(
			"SELECT cost_cents, supplier_id FROM parts WHERE ref = 'BOX-LAMP-L'",
		);
		expect(after).toEqual(before);
		expect((await one<{ n: number }>("SELECT count(*) AS n FROM price_history")).n).toBe(history);

		const toKit = await callTool(token, "update_part", { ref: "BOX-LAMP-L", kind: "kit" });
		expect(toKit.text).toContain("kind: This part has stock moves");
		const noBoms = await callTool(token, "update_part", { ref: "ARM-ASSY", kind: "buy" });
		expect(noBoms.text).toContain("This part has BoMs");
	});

	it("creates and edits suppliers, refusing duplicate names", async () => {
		await loadDemo();
		const token = await connect(["catalog:write"]);
		const dup = await callTool(token, "create_supplier", { name: "lumen parts co" });
		expect(dup.text).toContain("name: This name is already used.");
		const created = await write(token, "create_supplier", { name: "Acme Example", email: "a@acme.example" });
		expect(created.data.supplier).toMatchObject({ name: "Acme Example", email: "a@acme.example", phone: "" });
		const bad = await callTool(token, "update_supplier", { name: "Acme Example", email: "not an email" });
		expect(bad.text).toContain("email: Not a valid email address.");
		const renamed = await write(token, "update_supplier", { name: "ACME EXAMPLE", new_name: "Acme Two" });
		expect(renamed.data.supplier).toMatchObject({ name: "Acme Two", email: "a@acme.example" });
		const missing = await callTool(token, "update_supplier", { name: "Nobody" });
		expect(missing.text).toContain('No supplier named "Nobody"');
	});

	it("creates draft BoMs, copied or empty, with the form's checks", async () => {
		await loadDemo();
		const token = await connect(["catalog:write"]);
		const copied = await write(token, "create_bom", { part: "ARM-ASSY", code: "long", copy_from: { bom: "ARM-ASSY" } });
		expect(copied.data.bom).toMatchObject({ part: "ARM-ASSY", code: "long", revision: "Rev1", status: "draft" });
		expect((copied.data.lines as unknown[]).length).toBe(5);
		const dup = await callTool(token, "create_bom", { part: "ARM-ASSY", code: "long" });
		expect(dup.text).toContain("revision: This part already has a BoM with this variant code and revision.");
		const buy = await callTool(token, "create_bom", { part: "PAD-FELT" });
		expect(buy.text).toContain("part: Only make and kit parts can have a BoM.");
		// ARM-ASSY's lines under BASE-ASSY are fine; LAMP-DESK's (which contain ARM-ASSY) under ARM-ASSY are a cycle.
		const cycle = await callTool(token, "create_bom", { part: "ARM-ASSY", code: "x", copy_from: { bom: "LAMP-DESK" } });
		expect(cycle.text).toContain("copy_from: This would create a cycle");
	});

	it("never edits an active BoM in place: set_bom_lines creates a draft revision, activate_bom switches", async () => {
		await loadDemo();
		const token = await connect(["catalog:read", "catalog:write"]);
		const active = await bomId("LAMP-DESK");
		const linesBefore = await rows("SELECT * FROM bom_lines WHERE bom_id = ? ORDER BY id", active);
		const bomBefore = await one("SELECT * FROM boms WHERE id = ?", active);

		const r = await write(token, "set_bom_lines", {
			bom: "LAMP-DESK",
			lines: [
				{ ref: "BASE-ASSY", qty: 1 },
				{ ref: "ARM-ASSY", qty: "2" },
				{ ref: "HEAD-KIT-WW", qty: "1", notes: "warm by default" },
				{ ref: "PSU-EU-12V", qty: "1" },
			],
		});
		expect(r.data.new_revision).toBe(true);
		expect(r.data.bom).toMatchObject({ part: "LAMP-DESK", code: "std", revision: "Rev3", status: "draft" });
		expect(r.data.active_bom).toMatchObject({ revision: "Rev2", status: "active" });
		expect(String(r.data.note)).toContain("Rev2 is active and was left unchanged");
		expect(r.data.lines).toEqual([
			{ ref: "BASE-ASSY", qty: "1" },
			{ ref: "ARM-ASSY", qty: "2" },
			{ ref: "HEAD-KIT-WW", qty: "1", notes: "warm by default" },
			{ ref: "PSU-EU-12V", qty: "1" },
		]);
		// The active BoM is untouched, row for row.
		expect(await rows("SELECT * FROM bom_lines WHERE bom_id = ? ORDER BY id", active)).toEqual(linesBefore);
		expect(await one("SELECT * FROM boms WHERE id = ?", active)).toEqual(bomBefore);
		const summary = await one<{ summary: string }>("SELECT summary FROM change_sets ORDER BY id DESC LIMIT 1");
		expect(summary.summary).toBe("Create BoM LAMP-DESK std Rev3 from Rev2 with new lines");

		// On the draft, the lines are replaced in place (no other revision).
		const draft = r.data.bom as { bom_id: number };
		const again = await write(token, "set_bom_lines", { bom: draft.bom_id, lines: [{ ref: "BASE-ASSY", qty: "1" }] });
		expect(again.data).toMatchObject({ new_revision: false, bom: { revision: "Rev3" } });
		expect(again.data.lines).toEqual([{ ref: "BASE-ASSY", qty: "1" }]);

		// Activating archives Rev2, which can be activated again.
		const on = await write(token, "activate_bom", { bom: "LAMP-DESK", revision: "Rev3" });
		expect(on.data.bom).toMatchObject({ revision: "Rev3", status: "active" });
		expect(on.data.archived).toEqual([expect.objectContaining({ revision: "Rev2", status: "archived" })]);
		expect((await one<{ status: string }>("SELECT status FROM boms WHERE id = ?", active)).status).toBe("archived");
		const read = await callTool(token, "get_bom", { bom: "LAMP-DESK" });
		expect(read.data.bom).toMatchObject({ revision: "Rev3" });
		const back = await write(token, "activate_bom", { bom: active });
		expect(back.data.archived).toEqual([expect.objectContaining({ revision: "Rev3" })]);
		const noop = await write(token, "activate_bom", { bom: active });
		expect(noop.data).toMatchObject({ change_set_id: null, note: "LAMP-DESK std Rev2 is already active." });
	});

	it("checks every line like the editor and changes nothing when one is refused", async () => {
		await loadDemo();
		const token = await connect(["catalog:write"]);
		const draft = await write(token, "create_bom", { part: "BASE-ASSY", code: "alt" });
		const id = (draft.data.bom as { bom_id: number }).bom_id;
		const after = await lastChangeSetId();
		const bad = await callTool(token, "set_bom_lines", {
			bom: id,
			lines: [
				{ ref: "BASE-PLATE", qty: "1" },
				{ ref: "NOPE", qty: "1" },
				{ ref: "LED-5W-CW", qty: "0.5" },
				{ ref: "LAMP-DESK", qty: "1" },
				{ ref: "PAD-FELT", qty: "-1" },
			],
		});
		expect(bad.isError).toBe(true);
		expect(bad.text).toContain("line 2 (NOPE) component: Unknown part reference “NOPE”.");
		expect(bad.text).toContain("line 3 (LED-5W-CW) qty: A serial-tracked component must be used in whole units.");
		expect(bad.text).toContain("line 4 (LAMP-DESK) component: This would create a cycle");
		expect(bad.text).toContain("line 5 (PAD-FELT) qty: Must be more than zero.");
		expect(await lastChangeSetId()).toBe(after);
		expect(await rows("SELECT id FROM bom_lines WHERE bom_id = ?", id)).toEqual([]);

		await postForm(`/boms/${id}/archive`, {});
		const archived = await callTool(token, "set_bom_lines", { bom: id, lines: [{ ref: "BASE-PLATE", qty: "1" }] });
		expect(archived.text).toContain("is archived");
		const revision = await write(token, "new_bom_revision", { bom: id });
		expect(revision.data.bom).toMatchObject({ code: "alt", revision: "Rev2", status: "draft" });
		expect(revision.data.from).toMatchObject({ revision: "Rev1", status: "archived" });
	});
});

// ---------------------------------------------------------------------------
// prices:write

type PriceRow = { kind: string; price_cents: number | null; source: string; note: string; bom_id: number | null };

const priceRows = (ref: string) =>
	rows<PriceRow>(
		`SELECT kind, price_cents, source, note, bom_id FROM price_history
		 WHERE part_id = (SELECT id FROM parts WHERE ref = ?) ORDER BY id`,
		ref,
	);

describe("price tools", () => {
	it("sets standard costs and selling prices, appending the price history as the pages do", async () => {
		await loadDemo();
		const token = await connect(["prices:write"]);
		const cost = await write(token, "set_standard_cost", { ref: "BOX-LAMP", cost: "1.35", note: "Quote 2026-10" });
		expect(cost.data).toMatchObject({ part: "BOX-LAMP", standard_cost: "1.35", previous_standard_cost: "1.20" });
		expect((await priceRows("BOX-LAMP")).at(-1)).toEqual({
			kind: "standard",
			price_cents: 135,
			source: "form",
			note: "Quote 2026-10",
			bom_id: null,
		});
		const same = await write(token, "set_standard_cost", { ref: "BOX-LAMP", cost: 1.35 });
		expect(same.data).toMatchObject({ change_set_id: null, revertible: false });
		const bad = await callTool(token, "set_standard_cost", { ref: "BOX-LAMP", cost: "1.234" });
		expect(bad.text).toContain("cost: Not a valid amount (up to 2 decimals).");
		const cleared = await write(token, "set_standard_cost", { ref: "BOX-LAMP", cost: null });
		expect(cleared.data).toMatchObject({ standard_cost: null });

		const sale = await write(token, "set_sale_price", { ref: "LAMP-DESK", price: "95.00" });
		expect(sale.data).toMatchObject({ sale_price: "95.00", previous_sale_price: "89.00" });
		const variant = await write(token, "set_sale_price", { ref: "LAMP-DESK", code: "warm", price: "99" });
		expect(variant.data).toMatchObject({ bom: { code: "warm", revision: "Rev1" }, sale_price: "99.00" });
		const history = await priceRows("LAMP-DESK");
		expect(history.slice(-2)).toEqual([
			expect.objectContaining({ kind: "sale", price_cents: 9500, bom_id: null }),
			expect.objectContaining({ kind: "sale", price_cents: 9900, bom_id: await bomId("LAMP-DESK", "warm") }),
		]);
		const noCode = await callTool(token, "set_sale_price", { ref: "LAMP-DESK", revision: "Rev1", price: "1" });
		expect(noCode.text).toContain("revision needs code");
		const archived = await callTool(token, "set_sale_price", {
			ref: "LAMP-DESK",
			code: "std",
			revision: "Rev1",
			price: "1",
		});
		expect(archived.text).toContain("Archived BoMs are read-only.");
		const summaries = await rows<{ summary: string }>(
			"SELECT summary FROM change_sets WHERE source = 'mcp' ORDER BY id",
		);
		expect(summaries.map((r) => r.summary)).toEqual([
			"Set the standard cost of BOX-LAMP",
			"Set the standard cost of BOX-LAMP",
			"Set the selling price of LAMP-DESK",
			"Set the selling price of BoM LAMP-DESK warm Rev1",
		]);
	});

	it("creates and edits supplier offers like the offer form", async () => {
		await loadDemo();
		const token = await connect(["prices:write"]);
		const created = await write(token, "upsert_supplier_offer", {
			ref: "BOX-LAMP",
			supplier: "quickparts express",
			supplier_ref: "QP-BOX",
			price: "1.90",
			moq: "1",
			lead_days: 2,
		});
		// The part already has a preferred supplier: a new offer is not preferred unless asked.
		expect(created.data).toMatchObject({ created: true, part: "BOX-LAMP" });
		expect(created.data.offer).toMatchObject({
			supplier: "Quickparts Express",
			preferred: false,
			supplier_ref: "QP-BOX",
			price: "1.90",
			moq: "1",
			pack_size: "0",
			lead_days: 2,
		});
		const edited = await write(token, "upsert_supplier_offer", {
			ref: "BOX-LAMP",
			supplier: "Quickparts Express",
			price: "1.80",
			preferred: true,
			set_standard_cost: true,
		});
		expect(edited.data).toMatchObject({ created: false, standard_cost: "1.80" });
		expect(edited.data.offer).toMatchObject({ preferred: true, supplier_ref: "QP-BOX", price: "1.80", lead_days: 2 });
		expect((await priceRows("BOX-LAMP")).slice(-3)).toEqual([
			expect.objectContaining({ kind: "purchase", price_cents: 190 }),
			expect.objectContaining({ kind: "purchase", price_cents: 180 }),
			expect.objectContaining({ kind: "standard", price_cents: 180, note: "From the offer of Quickparts Express" }),
		]);
		// Clearing "preferred" never removes the preference.
		const kept = await write(token, "upsert_supplier_offer", {
			ref: "BOX-LAMP",
			supplier: "Quickparts Express",
			preferred: false,
		});
		expect(kept.data.offer).toMatchObject({ preferred: true });

		const kit = await callTool(token, "upsert_supplier_offer", { ref: "HEAD-KIT-CW", supplier: "Lumen Parts Co" });
		expect(kit.text).toContain("Only buy and make parts have supplier offers");
		const noPrice = await callTool(token, "upsert_supplier_offer", {
			ref: "MANUAL",
			supplier: "Lumen Parts Co",
			set_standard_cost: true,
		});
		expect(noPrice.text).toContain("set_standard_cost: Enter a price to use it as the standard cost.");
		// MANUAL has no preferred supplier: its first offer becomes the preferred one.
		const first = await write(token, "upsert_supplier_offer", {
			ref: "MANUAL",
			supplier: "Lumen Parts Co",
			price: "0.80",
		});
		expect(first.data.offer).toMatchObject({ preferred: true });
	});
});

// ---------------------------------------------------------------------------
// catalog:archive

describe("archive tools", () => {
	it("archives and unarchives parts and archives BoMs, never deleting anything", async () => {
		await loadDemo();
		const token = await connect(["catalog:archive"]);
		const off = await write(token, "archive_part", { ref: "pad-felt" });
		expect(off.data.part).toMatchObject({ ref: "PAD-FELT", archived: true });
		const again = await write(token, "archive_part", { ref: "PAD-FELT" });
		expect(again.data).toMatchObject({ change_set_id: null, note: "PAD-FELT is already archived." });
		const on = await write(token, "unarchive_part", { ref: "PAD-FELT" });
		expect(on.data.part).toMatchObject({ archived: false });
		const bom = await write(token, "archive_bom", { bom: "LAMP-DESK", code: "warm" });
		expect(bom.data.bom).toMatchObject({ code: "warm", status: "archived" });
		expect(await rows("SELECT id FROM boms WHERE code = 'warm' AND status = 'active'")).toEqual([]);
		const deletes = await rows(
			"SELECT l.id FROM change_log l JOIN change_sets s ON s.id = l.change_set_id WHERE s.source = 'mcp' AND l.op = 'delete'",
		);
		expect(deletes).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// stock:write

const onHand = async (ref: string) =>
	(
		await one<{ qty: number }>(
			"SELECT COALESCE(SUM(qty_milli), 0) AS qty FROM stock_moves WHERE part_id = (SELECT id FROM parts WHERE ref = ?)",
			ref,
		)
	).qty;

describe("stock tools", () => {
	it("adjusts stock with the adjustment form's checks", async () => {
		await loadDemo();
		const token = await connect(["stock:write"]);
		const r = await write(token, "adjust_stock", { ref: "cable-2c", qty: "-2.5", note: "Cut for a test" });
		expect(r.data).toMatchObject({ part: "CABLE-2C", unit: "m", qty: "-2.5", on_hand: "40" });
		const move = await one("SELECT reason, note, by FROM stock_moves ORDER BY id DESC LIMIT 1");
		expect(move).toEqual({ reason: "adjust", note: "Cut for a test", by: TESTER });

		const refused = async (args: Record<string, unknown>, text: string) => {
			const res = await callTool(token, "adjust_stock", { note: "x", ...args });
			expect(res.isError, JSON.stringify(args)).toBe(true);
			expect(res.text).toContain(text);
		};
		await refused({ ref: "PAD-FELT", qty: "0" }, "qty: Must not be zero.");
		await refused(
			{ ref: "LED-5W-CW", qty: "2", serial: "CW-9" },
			"qty: With a serial number, the quantity must be 1 or -1.",
		);
		await refused({ ref: "HEAD-KIT-CW", qty: "1" }, "ref: kit parts are never stocked.");
		await refused({ ref: "NOPE", qty: "1" }, "ref: Unknown part reference “NOPE”.");
		await refused({ ref: "PAD-FELT", qty: "1", note: " " }, "note: Required.");
		await refused({ ref: "PAD-FELT", qty: "1.0001" }, "qty: Not a valid quantity");
	});

	it("posts a count as the differences with on-hand, refusing bad lines all at once", async () => {
		await loadDemo();
		const token = await connect(["stock:write"]);
		const bad = await callTool(token, "count_stock", {
			counts: [
				{ ref: "PAD-FELT", qty: "390" },
				{ ref: "FEE-WEEE", qty: "1" },
				{ ref: "pad-felt", qty: "1" },
				{ ref: "BOX-LAMP", qty: "-1" },
				{ ref: "NOPE", qty: "1" },
			],
		});
		expect(bad.isError).toBe(true);
		expect(bad.text).toContain("line 2 (FEE-WEEE): fee parts are never stocked.");
		expect(bad.text).toContain("line 3 (pad-felt): listed twice.");
		expect(bad.text).toContain("line 4 (BOX-LAMP): Must be zero or more.");
		expect(bad.text).toContain("line 5 (NOPE): Unknown part reference");
		expect(await onHand("PAD-FELT")).toBe(400_000);
		// An empty quantity is not a count of zero.
		const empty = await callTool(token, "count_stock", { counts: [{ ref: "PAD-FELT", qty: " " }] });
		expect(empty.isError).toBe(true);
		expect(await onHand("PAD-FELT")).toBe(400_000);

		const r = await write(token, "count_stock", {
			counts: [
				{ ref: "PAD-FELT", qty: "390" },
				{ ref: "BOX-LAMP", qty: 20 },
			],
			note: "Year-end count",
		});
		expect(r.data.adjusted).toBe(1);
		expect(r.data.counts).toEqual([
			{ ref: "PAD-FELT", unit: "pcs", previous: "400", counted: "390", adjustment: "-10" },
			{ ref: "BOX-LAMP", unit: "pcs", previous: "20", counted: "20", adjustment: "0" },
		]);
		expect(await onHand("PAD-FELT")).toBe(390_000);
		expect(await one("SELECT reason, note FROM stock_moves ORDER BY id DESC LIMIT 1")).toEqual({
			reason: "count",
			note: "Year-end count",
		});
		const same = await write(token, "count_stock", { counts: [{ ref: "PAD-FELT", qty: "390" }] });
		expect(same.data).toMatchObject({ change_set_id: null, adjusted: 0 });
	});
});

// ---------------------------------------------------------------------------
// builds:write

describe("build tools", () => {
	it("plans builds with the new build form's checks", async () => {
		await loadDemo();
		const token = await connect(["builds:write"]);
		const arm = await write(token, "plan_build", { ref: "arm-assy", qty: 3, planned_for: "2026-11-02" });
		expect(arm.data.build).toMatchObject({
			number: "B-0001",
			status: "planned",
			part: "ARM-ASSY",
			qty: "3",
			bom: { code: "std", revision: "Rev1" },
			planned_for: "2026-11-02",
		});
		const noSerial = await callTool(token, "plan_build", { ref: "LAMP-DESK", qty: "2" });
		expect(noSerial.text).toContain("qty: A serial-tracked product is built one unit at a time.");
		expect(noSerial.text).toContain("serial: This product is serial-tracked: enter its serial number.");
		const lamp = await write(token, "plan_build", { ref: "LAMP-DESK", code: "warm", serial: "L-0100" });
		expect(lamp.data.build).toMatchObject({ number: "B-0002", serial: "L-0100", bom: { code: "warm" } });
		const taken = await callTool(token, "plan_build", { ref: "LAMP-DESK", serial: "L-0100" });
		expect(taken.text).toContain("serial: This serial number is already used for this product.");
		const kit = await callTool(token, "plan_build", { ref: "HEAD-KIT-CW" });
		expect(kit.text).toContain("ref: Only make parts can be built.");
		const variant = await callTool(token, "plan_build", { ref: "ARM-ASSY", code: "nope" });
		expect(variant.text).toContain("code: Choose an active BoM of this part.");
		const date = await callTool(token, "plan_build", { ref: "ARM-ASSY", planned_for: "02/11/2026" });
		expect(date.isError).toBe(true);
	});

	it("completes a build through the pick list's checks: serials, sub-assembly choices, once only", async () => {
		await loadDemo();
		const token = await connect(["builds:read", "builds:write"]);
		const planned = await write(token, "plan_build", { ref: "LAMP-DESK", serial: "L-0001" });
		const number = (planned.data.build as { number: string }).number;
		const after = await lastChangeSetId();

		const missing = await callTool(token, "complete_build", { number });
		expect(missing.isError).toBe(true);
		expect(missing.text).toContain("DRV-12V serial 1: Serial required.");
		expect(missing.text).toContain("LED-5W-CW serial 1: Serial required.");
		const extra = await callTool(token, "complete_build", {
			number,
			serials: [
				{ ref: "LED-5W-CW", serials: ["CW-24-0001", "CW-24-0002"] },
				{ ref: "PAD-FELT", serials: ["X"] },
			],
		});
		expect(extra.text).toContain("LED-5W-CW: 2 serials given, 1 needed.");
		expect(extra.text).toContain("PAD-FELT: no serial is scanned for it in this build.");
		const notSub = await callTool(token, "complete_build", {
			number,
			sub_assemblies: [{ ref: "PAD-FELT", mode: "build" }],
		});
		expect(notSub.text).toContain("PAD-FELT is not a sub-assembly of build");
		expect(await lastChangeSetId()).toBe(after);

		// ARM-ASSY is in stock (2): build it now instead, from its components.
		const pick = await callTool(token, "get_build", { number });
		const arm = (pick.data.sub_assemblies as { ref: string; path: string; from_stock: string }[]).find(
			(n) => n.ref === "ARM-ASSY",
		);
		expect(arm).toMatchObject({ from_stock: "2" });
		const tubes = await onHand("ARM-TUBE-300");
		const done = await write(token, "complete_build", {
			number: number.toLowerCase(),
			serials: [
				{ ref: "led-5w-cw", serials: ["CW-24-0001"] },
				{ ref: "DRV-12V", serials: ["DRV-7A-101"] },
			],
			sub_assemblies: [{ path: arm?.path, mode: "build" }],
		});
		expect(done.data).toMatchObject({ revertible: false, build: { number, status: "done", serial: "L-0001" } });
		expect(done.data.history_path).toBeUndefined();
		const asBuilt = done.data.as_built as { ref: string; serial: string | null }[];
		expect(asBuilt).toContainEqual(expect.objectContaining({ ref: "LED-5W-CW", qty: "1", serial: "CW-24-0001" }));
		expect(asBuilt).toContainEqual(expect.objectContaining({ ref: "DRV-12V", serial: "DRV-7A-101" }));
		expect(asBuilt.find((l) => l.ref === "ARM-ASSY")).toBeUndefined();
		expect(await onHand("ARM-TUBE-300")).toBe(tubes - 2000);
		expect(await onHand("ARM-ASSY")).toBe(2000);
		expect(await onHand("LAMP-DESK")).toBe(1000);

		const twice = await callTool(token, "complete_build", { number });
		expect(twice.text).toContain("This build is already done or cancelled.");
		const cancel = await callTool(token, "cancel_build", { number });
		expect(cancel.text).toContain("This build is already done or cancelled.");
	});

	it("cancels open builds, freeing their serial", async () => {
		await loadDemo();
		const token = await connect(["builds:write"]);
		const planned = await write(token, "plan_build", { ref: "LAMP-DESK", serial: "L-0002" });
		const number = (planned.data.build as { number: string }).number;
		const r = await write(token, "cancel_build", { number });
		expect(r.data.build).toMatchObject({ number, status: "cancelled" });
		const again = await write(token, "cancel_build", { number });
		expect(again.data).toMatchObject({ change_set_id: null });
		await write(token, "plan_build", { ref: "LAMP-DESK", serial: "L-0002" });
	});

	it("hides costs in build results from operators who may not see them", async () => {
		const s = await seed();
		await setRole("operator");
		const token = await connect(["builds:write"], { overrides: NOT_ADMIN });
		const r = await callTool(token, "complete_build", { number: s.build }, NOT_ADMIN);
		expect(r.isError, r.text).toBe(false);
		expect(r.data.costs_hidden).toBe(true);
		expect(r.text).not.toMatch(/unit_cost|"price"|_cents/);
		const lines = r.data.as_built as Record<string, unknown>[];
		expect(lines.length).toBeGreaterThan(0);
		for (const l of lines) expect(l).not.toHaveProperty("unit_cost");
	});
});

// ---------------------------------------------------------------------------
// purchasing:write

const poStatus = async (number: string) =>
	(await one<{ status: string }>("SELECT status FROM purchase_orders WHERE number = ?", number)).status;

describe("purchasing tools", () => {
	it("drafts POs from the shortages, for chosen suppliers and from another supplier", async () => {
		const s = await seed();
		const token = await connect(["purchasing:read", "purchasing:write"]);
		const none = await write(token, "create_draft_pos", {});
		expect(none.data).toMatchObject({ change_set_id: null, purchase_orders: [], note: "Nothing to order." });

		await planViaForm("ARM-ASSY", "100");
		const notShort = await callTool(token, "create_draft_pos", {
			order_from: [{ ref: "BOX-LAMP", supplier: "Lumen Parts Co" }],
		});
		expect(notShort.text).toContain("BOX-LAMP is not short");
		const noOffer = await callTool(token, "create_draft_pos", {
			order_from: [{ ref: "ARM-TUBE-300", supplier: "Lumen Parts Co" }],
		});
		expect(noOffer.text).toContain("Lumen Parts Co has no offer for ARM-TUBE-300");

		// Ordered from Quickparts instead of the preferred Ironleaf, once Quickparts offers it.
		const quick = (await one<{ id: number }>("SELECT id FROM suppliers WHERE name = 'Quickparts Express'")).id;
		const offer = await postForm(`/parts/${await partId("ARM-TUBE-300")}/offers`, {
			supplier_id: String(quick),
			price: "2.90",
			moq: "1",
		});
		expect(offer.status).toBe(303);
		const r = await write(token, "create_draft_pos", {
			suppliers: ["ironleaf metalworks"],
			order_from: [{ ref: "arm-tube-300", supplier: "Quickparts Express" }],
		});
		type Draft = { purchase_order: { number: string; supplier: string; status: string }; lines: unknown[] };
		const drafts = r.data.purchase_orders as Draft[];
		expect(drafts).toHaveLength(1);
		expect(drafts[0]?.purchase_order).toMatchObject({ supplier: "Quickparts Express", status: "draft" });
		expect(drafts[0]?.purchase_order.number).not.toBe(s.draftPo);
		// 101 arm tubes for the two builds of ARM-ASSY (1 + 100), minus 10 on hand.
		expect(drafts[0]?.lines).toEqual([expect.objectContaining({ ref: "ARM-TUBE-300", qty: "91", unit_price: "2.90" })]);
		const set = await one<{ summary: string }>("SELECT summary FROM change_sets ORDER BY id DESC LIMIT 1");
		expect(set.summary).toBe("Create 1 draft PO(s) from shortages");
		// Drafts count as on order: the same request now drafts nothing.
		const again = await write(token, "create_draft_pos", { suppliers: ["Ironleaf Metalworks"] });
		expect(again.data.purchase_orders).toEqual([]);
		// Every other supplier group by default (the knobs, springs and screws; the cable is not short).
		const rest = await write(token, "create_draft_pos", {});
		const suppliers = (rest.data.purchase_orders as Draft[]).map((d) => d.purchase_order.supplier);
		expect(suppliers).toEqual(["Bolt & Nut Depot"]);
	});

	it("edits drafts like the PO page: header, added, changed and removed lines", async () => {
		const s = await seed();
		const token = await connect(["purchasing:write"]);
		const r = await write(token, "update_draft_po", {
			number: s.draftPo.toLowerCase(),
			expected_at: "2026-12-01",
			notes: "Call before delivery",
			lines: [
				{ ref: "box-lamp", qty: "15", price: "1.10" },
				{ ref: "PAD-FELT", qty: "500" },
			],
		});
		expect(r.data.purchase_order).toMatchObject({
			number: s.draftPo,
			expected_at: "2026-12-01",
			notes: "Call before delivery",
		});
		expect(r.data.lines).toEqual([
			expect.objectContaining({ ref: "BOX-LAMP", qty: "15", unit_price: "1.10" }),
			// Not offered by this supplier: the standard cost.
			expect.objectContaining({ ref: "PAD-FELT", qty: "500", unit_price: "0.05" }),
		]);
		expect(r.data.total).toBe("41.50");
		const removed = await write(token, "update_draft_po", { number: s.draftPo, lines: [{ ref: "PAD-FELT", qty: 0 }] });
		expect((removed.data.lines as unknown[]).length).toBe(1);

		const bad = await callTool(token, "update_draft_po", {
			number: s.draftPo,
			lines: [
				{ ref: "HEAD-KIT-CW", qty: "1" },
				{ ref: "SWITCH-INL", qty: "0" },
				{ ref: "BOX-LAMP", qty: "-1" },
			],
		});
		expect(bad.text).toContain("line 1 (HEAD-KIT-CW): kit parts are never stocked.");
		expect(bad.text).toContain("line 2 (SWITCH-INL): not on");
		expect(bad.text).toContain("line 3 (BOX-LAMP) qty: Must be zero or more.");
		const sent = await callTool(token, "update_draft_po", { number: s.sentPo, lines: [{ ref: "BOX-LAMP", qty: "1" }] });
		expect(sent.text).toContain("lines: Only draft POs can be changed.");
		const date = await write(token, "update_draft_po", { number: s.sentPo, expected_at: "2026-12-24" });
		expect(date.data.purchase_order).toMatchObject({ status: "sent", expected_at: "2026-12-24" });
	});

	it("sends, receives, cancels and closes POs with the PO page's checks", async () => {
		const s = await seed();
		const token = await connect(["purchasing:write"]);
		const empty = await postForm("/purchasing/po", {
			supplier_id: String((await one<{ id: number }>("SELECT id FROM suppliers WHERE name = 'Lumen Parts Co'")).id),
			expected_at: "",
			notes: "",
		});
		expect(empty.status).toBe(303);
		const emptyNumber = (await one<{ number: string }>("SELECT number FROM purchase_orders ORDER BY id DESC LIMIT 1"))
			.number;
		expect((await callTool(token, "mark_po_sent", { number: emptyNumber })).text).toContain(
			"Add at least one line first.",
		);

		const sent = await write(token, "mark_po_sent", { number: s.draftPo });
		expect(sent.data.purchase_order).toMatchObject({ status: "sent" });
		expect((await write(token, "mark_po_sent", { number: s.draftPo })).data.change_set_id).toBeNull();

		const tooMany = await callTool(token, "receive_po", {
			number: s.sentPo,
			lines: [{ ref: "BOX-LAMP", qty: "2", serials: ["A"] }],
		});
		expect(tooMany.text).toContain("BOX-LAMP serials: Enter exactly one serial per unit received (2).");
		const nothing = await callTool(token, "receive_po", { number: s.sentPo, lines: [{ ref: "BOX-LAMP", qty: "0" }] });
		expect(nothing.text).toContain("Enter a quantity for at least one line.");
		const other = await callTool(token, "receive_po", { number: s.sentPo, lines: [{ ref: "PAD-FELT", qty: "1" }] });
		expect(other.text).toContain(`PAD-FELT is not on ${s.sentPo}`);

		const before = await onHand("BOX-LAMP");
		const got = await write(token, "receive_po", { number: s.sentPo, lines: [{ ref: "BOX-LAMP", qty: "4" }] });
		expect(got.data).toMatchObject({ revertible: false, received: [{ ref: "BOX-LAMP", qty: "4" }] });
		expect(got.data.purchase_order).toMatchObject({ status: "partial" });
		expect(got.data.lines).toEqual([expect.objectContaining({ received: "4", remaining: "6" })]);
		expect(await onHand("BOX-LAMP")).toBe(before + 4000);

		expect((await callTool(token, "cancel_po", { number: s.sentPo })).text).toContain(
			"Goods were already received on this PO.",
		);
		const closed = await write(token, "close_po", { number: s.sentPo });
		expect(closed.data.purchase_order).toMatchObject({ status: "received" });
		expect((await write(token, "close_po", { number: s.sentPo })).data.change_set_id).toBeNull();
		expect(
			(await callTool(token, "receive_po", { number: s.sentPo, lines: [{ ref: "BOX-LAMP", qty: "1" }] })).text,
		).toContain("This PO cannot receive goods.");

		const cancelled = await write(token, "cancel_po", { number: s.draftPo });
		expect(cancelled.data.purchase_order).toMatchObject({ status: "cancelled" });
		expect(await poStatus(s.draftPo)).toBe("cancelled");
		expect((await callTool(token, "close_po", { number: emptyNumber })).text).toContain(
			"only sent and partly received POs can be closed",
		);
	});

	it("lets operators receive (not order), with prices hidden when they may not see costs", async () => {
		const s = await seed();
		await setRole("operator");
		const token = await connect(["purchasing:write"], { overrides: NOT_ADMIN });
		const r = await callTool(
			token,
			"receive_po",
			{ number: s.sentPo, lines: [{ ref: "BOX-LAMP", qty: "1" }] },
			NOT_ADMIN,
		);
		expect(r.isError, r.text).toBe(false);
		expect(r.data.costs_hidden).toBe(true);
		expect(r.text).not.toMatch(/unit_price|"total"|1\.00|10\.00/);
		const order = await rpc(
			await mcpPost(token, "tools/call", { name: "mark_po_sent", arguments: { number: s.draftPo } }, NOT_ADMIN),
		);
		expect(order.error?.message).toContain("does not allow mark_po_sent");
	});
});

// ---------------------------------------------------------------------------
// catalog:read: list_recent_changes

describe("recent changes over MCP", () => {
	it("lists changes with their source, client, field diffs, undo state and page", async () => {
		await loadDemo();
		const token = await connect(["catalog:read", "catalog:write"]);
		await write(token, "update_part", { ref: "BOX-LAMP", name: "Shipping box, large" });
		const created = await write(token, "create_part", { ref: "KNOB-XL", name: "Large knob", kind: "buy" });
		const undone = await undo(created.data.change_set_id as number);
		expect(undone).toMatchObject({ ok: true });

		const r = await callTool(token, "list_recent_changes", { limit: 3 });
		type Change = {
			id: number;
			source: string;
			client?: string;
			summary: string;
			undone_by?: number;
			undoes?: number;
			history_path: string;
			revertible: boolean;
			changes: { table: string; op: string; record: string; fields: unknown[] }[];
		};
		const changes = r.data.changes as Change[];
		expect(changes.map((c) => [c.source, c.summary])).toEqual([
			["revert", `Undo #${created.data.change_set_id}: Create part KNOB-XL`],
			["mcp", "Create part KNOB-XL"],
			["mcp", "Edit part BOX-LAMP"],
		]);
		expect(changes[1]).toMatchObject({
			client: "Test assistant",
			undone_by: changes[0]?.id,
			revertible: true,
			history_path: `/history/${changes[1]?.id}`,
		});
		expect(changes[0]?.undoes).toBe(changes[1]?.id);
		expect(changes[2]?.changes).toEqual([
			{
				table: "parts",
				op: "update",
				record: "BOX-LAMP",
				fields: [{ field: "name", before: "Shipping box", after: "Shipping box, large" }],
			},
		]);
		expect(changes[1]?.changes[0]).toMatchObject({ table: "parts", op: "insert", record: "KNOB-XL" });
		expect(changes[1]?.changes[0]?.fields).toContainEqual({ field: "track_serial", before: null, after: false });
		expect(r.data.next_before).toBe(changes[2]?.id);

		const older = await callTool(token, "list_recent_changes", {
			before: r.data.next_before,
			source: "import",
			include_fields: false,
		});
		const imports = older.data.changes as Change[];
		expect(imports.map((c) => c.summary)).toContain("Import parts.csv");
		expect(imports[0]).not.toHaveProperty("changes");
		const mine = await callTool(token, "list_recent_changes", { source: "mcp", query: "BOX-LAMP" });
		expect((mine.data.changes as Change[]).map((c) => c.summary)).toEqual(["Edit part BOX-LAMP"]);
	});
});
