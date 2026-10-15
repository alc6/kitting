import { beforeEach, describe, expect, it } from "vitest";
import { listRollupCosts, partAssemblySummary } from "../src/domain/assemblies";
import { centsOf } from "../src/domain/assembly-graph";
import { listParts } from "../src/domain/parts";
import { insertPart, loadDemo, NOT_ADMIN, one, partId, request, rows, seedSql, setRole, stmt, testDb } from "./helpers";

beforeEach(() => setRole("planner"));

/** The table row (<tr>…</tr>) holding this link. */
function rowWith(page: string, href: string): string {
	const at = page.indexOf(`href="${href}"`);
	expect(at, `no link to ${href}`).toBeGreaterThan(-1);
	const start = page.lastIndexOf("<tr", at);
	return page.slice(start, page.indexOf("</tr>", at));
}

describe("parts list: standard cost column (D175)", () => {
	it("shows the assembly roll-up, muted and marked, for made parts without a standard cost", async () => {
		await loadDemo({ stock: false });
		const page = await (await request("/parts")).text();
		// LAMP-DESK has no standard cost and an active assembly; MANUAL (a component) has no cost, so it is incomplete.
		const lamp = rowWith(page, `/parts/${await partId("LAMP-DESK")}`);
		expect(lamp).toContain("€37.83");
		expect(lamp).toContain("text-muted-foreground");
		expect(lamp).toContain('title="Assembly cost roll-up: this part has no standard cost of its own."');
		expect(lamp).toContain("MANUAL"); // the incomplete marker names the part without a cost
		expect(lamp).not.toContain("unknown");
		// A kit rolls up too.
		expect(rowWith(page, `/parts/${await partId("HEAD-KIT-CW")}`)).not.toContain("unknown");
		expect(page).toContain("Muted amounts are the assembly cost roll-up");
		// A part with its own cost is unchanged, and a buy part without a cost is still unknown.
		const felt = rowWith(page, `/parts/${await partId("PAD-FELT")}`);
		expect(felt).toContain("€0.05");
		expect(felt).not.toContain("Assembly cost roll-up");
		expect(rowWith(page, `/parts/${await partId("MANUAL")}`)).toContain("unknown");
	});

	it("keeps unknown for a made part without an active assembly, and prefers its own standard cost", async () => {
		await insertPart("BARE", "make");
		const priced = await insertPart("PRICED", "make", { costCents: 777 });
		await seedSql(
			stmt(
				"INSERT INTO assemblies (parent_part_id, code, revision, status, created_by, updated_by) VALUES (?, 'std', 'R1', 'active', 'seed', 'seed')",
				priced,
			),
			stmt(
				"INSERT INTO assemblies (parent_part_id, code, revision, status, created_by, updated_by) SELECT id, 'std', 'R1', 'draft', 'seed', 'seed' FROM parts WHERE ref = 'BARE'",
			),
		);
		const page = await (await request("/parts")).text();
		const bare = rowWith(page, `/parts/${await partId("BARE")}`);
		expect(bare).toContain("unknown"); // a draft assembly is not an active one
		expect(rowWith(page, `/parts/${priced}`)).toContain("€7.77");
		// Nothing to roll up: no legend.
		expect(page).not.toContain("Muted amounts");
	});

	it("is hidden from roles without costs, and the parts CSV keeps its columns", async () => {
		await loadDemo({ stock: false });
		await setRole("operator");
		const page = await (await request("/parts", {}, NOT_ADMIN)).text();
		expect(page).not.toContain("37.83");
		expect(page).not.toContain("Assembly cost roll-up");
		expect(page).not.toContain("Muted amounts");
		await setRole("planner");
		const csv = await (await request("/import/parts/export.csv")).text();
		expect(csv.split("\r\n")[0]).toBe(
			"ref,name,kind,unit,cost,sale_price,supplier,supplier_ref,moq,pack_size,lead_days,min_stock,track_serial,notes",
		);
		// The export holds stored values only: no roll-up in the cost column.
		expect(csv).toMatch(/^LAMP-DESK,Modular desk lamp,make,pcs,,89\.00,/m);
	});

	it("loads the graph once, and not at all when no listed part qualifies", async () => {
		await loadDemo({ stock: false });
		const db = testDb();
		const all = await listParts(db);
		const { costs } = await listRollupCosts(db, all);
		// Exactly the made parts with no standard cost and an active assembly.
		const expected = await rows<{ id: number }>(
			`SELECT p.id FROM parts p WHERE p.kind IN ('make','kit') AND p.cost_cents IS NULL
			   AND EXISTS (SELECT 1 FROM assemblies a WHERE a.parent_part_id = p.id AND a.status = 'active')`,
		);
		expect([...costs.keys()].sort((a, b) => a - b)).toEqual(expected.map((r) => r.id).sort((a, b) => a - b));
		const buyOnly = await listRollupCosts(
			db,
			all.filter((p) => p.kind === "buy"),
		);
		expect(buyOnly.costs.size).toBe(0);
		expect(buyOnly.refs.size).toBe(0);
	});
});

/** Parts: B-1..B-1500 buy (every 50th without a cost), M-1..M-450 make, K-1..K-50 kit; M-1..M-300 and K-1..K-20 have an active assembly. */
async function seedCatalogue() {
	const gen = (n: number) => `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${n})`;
	await seedSql(
		stmt(
			`${gen(1500)} INSERT INTO parts (ref, name, kind, unit, cost_cents, created_by, updated_by)
			 SELECT 'B-' || i, 'Bought part ' || i, 'buy', 'pcs', CASE WHEN i % 50 = 0 THEN NULL ELSE 10 + (i % 97) * 13 END, 'seed', 'seed' FROM n`,
		),
		stmt(
			`${gen(450)} INSERT INTO parts (ref, name, kind, unit, cost_cents, created_by, updated_by)
			 SELECT 'M-' || i, 'Made part ' || i, 'make', 'pcs', NULL, 'seed', 'seed' FROM n`,
		),
		stmt(
			`${gen(50)} INSERT INTO parts (ref, name, kind, unit, cost_cents, created_by, updated_by)
			 SELECT 'K-' || i, 'Kit ' || i, 'kit', 'pcs', NULL, 'seed', 'seed' FROM n`,
		),
		stmt(
			`${gen(300)} INSERT INTO assemblies (parent_part_id, code, revision, status, created_by, updated_by)
			 SELECT p.id, 'std', 'R1', 'active', 'seed', 'seed' FROM n JOIN parts p ON p.ref = 'M-' || n.i`,
		),
		stmt(
			`${gen(20)} INSERT INTO assemblies (parent_part_id, code, revision, status, created_by, updated_by)
			 SELECT p.id, 'std', 'R1', 'active', 'seed', 'seed' FROM n JOIN parts p ON p.ref = 'K-' || n.i`,
		),
		// Six bought components per made part, plus two sub-assemblies (M-k/2 and M-k/3, so the graph is a few levels deep).
		stmt(
			`${gen(300)}, j(j) AS (SELECT 0 UNION ALL SELECT j + 1 FROM j WHERE j < 5)
			 INSERT INTO assembly_lines (assembly_id, component_part_id, qty_milli, position, created_by, updated_by)
			 SELECT a.id, c.id, 1000 + j * 500, j, 'seed', 'seed' FROM n JOIN j
			   JOIN parts m ON m.ref = 'M-' || n.i JOIN assemblies a ON a.parent_part_id = m.id
			   JOIN parts c ON c.ref = 'B-' || (((n.i * 7 + j * 13) % 1500) + 1)`,
		),
		stmt(
			`${gen(300)}, d(d) AS (SELECT 2 UNION ALL SELECT 3)
			 INSERT INTO assembly_lines (assembly_id, component_part_id, qty_milli, position, created_by, updated_by)
			 SELECT a.id, c.id, 1000, 6 + d, 'seed', 'seed' FROM n JOIN d
			   JOIN parts m ON m.ref = 'M-' || n.i JOIN assemblies a ON a.parent_part_id = m.id
			   JOIN parts c ON c.ref = 'M-' || (n.i / d) WHERE n.i / d >= 1`,
		),
		stmt(
			`${gen(20)}, j(j) AS (SELECT 0 UNION ALL SELECT j + 1 FROM j WHERE j < 3)
			 INSERT INTO assembly_lines (assembly_id, component_part_id, qty_milli, position, created_by, updated_by)
			 SELECT a.id, c.id, 2000, j, 'seed', 'seed' FROM n JOIN j
			   JOIN parts k ON k.ref = 'K-' || n.i JOIN assemblies a ON a.parent_part_id = k.id
			   JOIN parts c ON c.ref = CASE WHEN j = 3 THEN 'M-' || (n.i * 5) ELSE 'B-' || (n.i * 11 + j) END`,
		),
	);
}

describe("parts list performance on a large catalogue", () => {
	it("rolls up hundreds of assemblies in one pass (timings printed)", async () => {
		await seedCatalogue();
		expect(await one("SELECT count(*) AS n FROM parts")).toEqual({ n: 2000 });
		expect(await one("SELECT count(*) AS n FROM assemblies")).toEqual({ n: 320 });
		const db = testDb();

		const t0 = performance.now();
		const list = await listParts(db);
		const t1 = performance.now();
		const { costs, refs } = await listRollupCosts(db, list);
		const t2 = performance.now();
		expect(list).toHaveLength(2000);
		expect(costs.size).toBe(320);
		expect(refs.size).toBe(2000);

		// The same figures as the part page (an independent path through the graph) for a sample of parts.
		for (const ref of ["M-1", "M-2", "M-7", "M-64", "M-299", "M-300", "K-1", "K-20"]) {
			const id = await partId(ref);
			const summary = await partAssemblySummary(db, id);
			const mine = costs.get(id);
			expect(mine, ref).toBeDefined();
			expect(centsOf(mine?.millicents ?? 0), ref).toBe(centsOf(summary.rollup?.millicents ?? -1));
			expect(mine?.incomplete, ref).toBe(summary.rollup?.incomplete);
		}

		// The whole page, as a planner (roll-ups) and as an operator (no costs, so no graph).
		const t3 = performance.now();
		const page = await request("/parts");
		const html = await page.text();
		const t4 = performance.now();
		await setRole("operator");
		const bare = await request("/parts", {}, NOT_ADMIN);
		await bare.text();
		const t5 = performance.now();
		expect(page.status).toBe(200);
		expect(html.match(/Assembly cost roll-up: this part/g)).toHaveLength(320);

		const ms = (a: number, b: number) => Math.round(b - a);
		console.info(
			`[D175] 2000 parts / 320 assemblies: listParts ${ms(t0, t1)} ms, listRollupCosts ${ms(t1, t2)} ms, ` +
				`GET /parts with roll-ups ${ms(t3, t4)} ms, without costs ${ms(t4, t5)} ms`,
		);
		// A generous bound that only a per-row query pattern (thousands of round trips) would break.
		expect(ms(t3, t4)).toBeLessThan(5000);
	});

	it("times the page on the full example dataset", async () => {
		await loadDemo();
		const t0 = performance.now();
		const res = await request("/parts");
		await res.text();
		const t1 = performance.now();
		expect(res.status).toBe(200);
		console.info(`[D175] examples/full: GET /parts ${Math.round(t1 - t0)} ms`);
	});
});
