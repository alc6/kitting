import { env } from "cloudflare:workers";
import { getTableName, is, sql } from "drizzle-orm";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import { tableTriggers } from "../src/db/history-sql";
import * as schema from "../src/db/schema";
import { HISTORY_TABLES, LEDGER_TABLES, UNTRACKED_TABLES } from "../src/db/schema";
import { runChangeSet } from "../src/domain/history";
import { saveUserStatement } from "../src/domain/users";
import {
	bomId,
	changeSql,
	insertPart,
	insertSupplier,
	loadDemo,
	one,
	postForm,
	request,
	returnedId,
	rows,
	seedSql,
	stmt,
	TESTER,
	testDb,
} from "./helpers";

type LogRow = {
	id: number;
	change_set_id: number;
	table_name: string;
	row_id: number;
	op: string;
	old_row: string | null;
	new_row: string | null;
};

const parse = (json: string | null) => (json === null ? null : JSON.parse(json));

async function lastLog(): Promise<LogRow> {
	return one<LogRow>("SELECT * FROM change_log ORDER BY id DESC LIMIT 1");
}

async function rowOf(table: string, id: number) {
	return (await rows(`SELECT * FROM ${table} WHERE id = ?`, id))[0] ?? null;
}

/** Rows every tracked table can reference, created without history. */
async function fixtures() {
	const supplier = await insertSupplier("Acme Example");
	const buy = await insertPart("BOLT", "buy", { costCents: 10 });
	const make = await insertPart("LAMP", "make");
	const [bom] = await seedSql(
		stmt("INSERT INTO boms (parent_part_id, created_by, updated_by) VALUES (?, 'seed', 'seed') RETURNING id", make),
	);
	const [po] = await seedSql(
		stmt(
			"INSERT INTO purchase_orders (number, supplier_id, created_by, updated_by) VALUES ('PO-9000', ?, 'seed', 'seed') RETURNING id",
			supplier,
		),
	);
	return { supplier, buy, make, bom: returnedId(bom), po: returnedId(po) };
}

type Fixtures = Awaited<ReturnType<typeof fixtures>>;

/** For each tracked table: how to insert a row (RETURNING id) and change one of its columns. */
const CASES: Record<string, { insert: (f: Fixtures) => D1PreparedStatement; update: string }> = {
	parts: {
		insert: () =>
			stmt(
				"INSERT INTO parts (ref, name, kind, created_by, updated_by) VALUES ('NEW', 'New', 'buy', 'u', 'u') RETURNING id",
			),
		update: "UPDATE parts SET name = 'Renamed', cost_cents = 250 WHERE id = ?",
	},
	suppliers: {
		insert: () => stmt("INSERT INTO suppliers (name, created_by, updated_by) VALUES ('Other', 'u', 'u') RETURNING id"),
		update: "UPDATE suppliers SET notes = 'Ships on Fridays' WHERE id = ?",
	},
	boms: {
		insert: (f) =>
			stmt(
				"INSERT INTO boms (parent_part_id, code, created_by, updated_by) VALUES (?, 'alt', 'u', 'u') RETURNING id",
				f.make,
			),
		update: "UPDATE boms SET status = 'active' WHERE id = ?",
	},
	bom_lines: {
		insert: (f) =>
			stmt(
				"INSERT INTO bom_lines (bom_id, component_part_id, qty_milli, created_by, updated_by) VALUES (?, ?, 2000, 'u', 'u') RETURNING id",
				f.bom,
				f.buy,
			),
		update: "UPDATE bom_lines SET qty_milli = 3000 WHERE id = ?",
	},
	part_suppliers: {
		insert: (f) =>
			stmt(
				"INSERT INTO part_suppliers (part_id, supplier_id, created_by, updated_by) VALUES (?, ?, 'u', 'u') RETURNING id",
				f.make,
				f.supplier,
			),
		update: "UPDATE part_suppliers SET price_cents = 99 WHERE id = ?",
	},
	purchase_orders: {
		insert: (f) =>
			stmt(
				"INSERT INTO purchase_orders (number, supplier_id, created_by, updated_by) VALUES ('PO-9001', ?, 'u', 'u') RETURNING id",
				f.supplier,
			),
		update: "UPDATE purchase_orders SET notes = 'urgent', expected_at = '2026-11-02' WHERE id = ?",
	},
	po_lines: {
		insert: (f) =>
			stmt(
				"INSERT INTO po_lines (po_id, part_id, qty_milli, created_by, updated_by) VALUES (?, ?, 5000, 'u', 'u') RETURNING id",
				f.po,
				f.buy,
			),
		update: "UPDATE po_lines SET qty_milli = 6000 WHERE id = ?",
	},
	builds: {
		insert: (f) =>
			stmt(
				"INSERT INTO builds (number, part_id, bom_id, created_by, updated_by) VALUES ('B-9000', ?, ?, 'u', 'u') RETURNING id",
				f.make,
				f.bom,
			),
		update: "UPDATE builds SET notes = 'first run' WHERE id = ?",
	},
	users: {
		insert: () =>
			stmt(
				"INSERT INTO users (email, role, created_by, updated_by) VALUES ('ops@example.com', 'operator', 'u', 'u') RETURNING id",
			),
		update: "UPDATE users SET role = 'planner' WHERE id = ?",
	},
	settings: {
		insert: () =>
			stmt("INSERT INTO settings (key, value, created_by, updated_by) VALUES ('k', '0', 'u', 'u') RETURNING id"),
		update: "UPDATE settings SET value = '1' WHERE id = ?",
	},
};

const TRACKED = HISTORY_TABLES.map((t) => getTableName(t));

describe("change capture", () => {
	it("covers every tracked table in these tests", () => {
		expect(Object.keys(CASES).sort()).toEqual([...TRACKED].sort());
	});

	it.each(TRACKED)("%s: logs insert, update and delete with the full rows", async (table) => {
		const f = await fixtures();
		const c = CASES[table]!;
		const [ins] = await changeSql(`Insert into ${table}`, c.insert(f));
		const id = returnedId(ins);
		const inserted = await rowOf(table, id);
		let log = await lastLog();
		expect(log).toMatchObject({ table_name: table, row_id: id, op: "insert", old_row: null });
		expect(parse(log.new_row)).toEqual(inserted);

		await changeSql(`Update ${table}`, stmt(c.update, id));
		const updated = await rowOf(table, id);
		log = await lastLog();
		expect(log).toMatchObject({ table_name: table, row_id: id, op: "update" });
		expect(parse(log.old_row)).toEqual(inserted);
		expect(parse(log.new_row)).toEqual(updated);
		expect(updated).not.toEqual(inserted);

		await changeSql(`Delete from ${table}`, stmt(`DELETE FROM ${table} WHERE id = ?`, id));
		log = await lastLog();
		expect(log).toMatchObject({ table_name: table, row_id: id, op: "delete", new_row: null });
		expect(parse(log.old_row)).toEqual(updated);
		expect(await rowOf(table, id)).toBeNull();
		// One change set per statement batch, each with its own entries.
		expect(await one("SELECT count(DISTINCT change_set_id) AS n FROM change_log WHERE table_name = ?", table)).toEqual({
			n: 3,
		});
	});

	it.each(TRACKED)("%s: refuses a write made outside a change set", async (table) => {
		const f = await fixtures();
		const c = CASES[table]!;
		await expect(c.insert(f).run()).rejects.toThrow(`history: write to ${table} outside a change set`);
		const [ins] = await changeSql("Insert", c.insert(f));
		const id = returnedId(ins);
		const before = await rowOf(table, id);
		await expect(env.DB.prepare(c.update).bind(id).run()).rejects.toThrow("outside a change set");
		await expect(env.DB.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(id).run()).rejects.toThrow(
			"outside a change set",
		);
		expect(await rowOf(table, id)).toEqual(before);
	});

	it("ignores updates that only touch who/when, but still requires a change set for them", async () => {
		const f = await fixtures();
		await changeSql("Touch", stmt("UPDATE boms SET updated_at = '2030-01-01', updated_by = 'x' WHERE id = ?", f.bom));
		expect(await rows("SELECT * FROM change_log")).toEqual([]);
		// A change set that changed nothing is not kept.
		const kept = await runChangeSet(testDb(), { user: TESTER, source: "ui", summary: "Nothing" }, [
			testDb().run(sql`UPDATE boms SET notes = notes WHERE id = 0`),
		]);
		expect(kept.id).toBeNull();
		await expect(env.DB.prepare("UPDATE boms SET updated_at = '2031-01-01'").run()).rejects.toThrow(
			"outside a change set",
		);
	});

	it("recovers from a context row left by an interrupted script", async () => {
		await env.DB.prepare("INSERT INTO change_context (id, suppress) VALUES (1, 1)").run();
		const res = await postForm("/suppliers", { name: "Acme", email: "", phone: "", notes: "" });
		expect(res.status).toBe(303);
		expect(await rows("SELECT table_name, op FROM change_log")).toEqual([{ table_name: "suppliers", op: "insert" }]);
		expect(await rows("SELECT * FROM change_context")).toEqual([]);
	});

	it("logs cascaded deletes and upserts in the same change set", async () => {
		await loadDemo({ stock: false });
		const bom = await bomId("LAMP-DESK");
		const lines = (await one<{ n: number }>("SELECT count(*) AS n FROM bom_lines WHERE bom_id = ?", bom)).n;
		const { revision } = await one<{ revision: string }>("SELECT revision FROM boms WHERE id = ?", bom);
		await postForm(`/boms/${bom}/archive`, {});
		expect((await postForm(`/boms/${bom}/delete`, {})).status).toBe(303);
		const set = await one<{ id: number; summary: string }>(
			"SELECT id, summary FROM change_sets ORDER BY id DESC LIMIT 1",
		);
		expect(set.summary).toBe(`Delete BoM LAMP-DESK std ${revision}`);
		expect(
			await rows(
				"SELECT table_name, op, count(*) AS n FROM change_log WHERE change_set_id = ? GROUP BY 1, 2 ORDER BY 1",
				set.id,
			),
		).toEqual([
			{ table_name: "bom_lines", op: "delete", n: lines },
			{ table_name: "boms", op: "delete", n: 1 },
		]);

		const db = testDb();
		const meta = { user: TESTER, source: "ui" as const, summary: "Role" };
		await runChangeSet(db, meta, [saveUserStatement(db, { email: "a@example.com", role: "viewer" }, TESTER, "t")]);
		await runChangeSet(db, meta, [saveUserStatement(db, { email: "a@example.com", role: "planner" }, TESTER, "t")]);
		expect(await rows("SELECT op FROM change_log WHERE table_name = 'users' ORDER BY id")).toEqual([
			{ op: "insert" },
			{ op: "update" },
		]);
	});

	it("records who changed what, from where, with a summary", async () => {
		const res = await postForm("/suppliers", { name: "Acme", email: "", phone: "", notes: "" });
		expect(res.status).toBe(303);
		expect(
			await rows("SELECT user_email, source, client_name, summary, revertible, reverts_change_set_id FROM change_sets"),
		).toEqual([
			{
				user_email: TESTER,
				source: "ui",
				client_name: null,
				summary: "Create supplier Acme",
				revertible: 1,
				reverts_change_set_id: null,
			},
		]);
	});

	it("marks changes that wrote to a ledger as non-revertible", async () => {
		await loadDemo({ stock: false });
		await postForm("/stock/adjust", { part: "BOX-LAMP", qty: "3", serial: "", note: "found" });
		expect(await one("SELECT summary, revertible FROM change_sets ORDER BY id DESC LIMIT 1")).toEqual({
			summary: "Adjust the stock of BOX-LAMP",
			revertible: 0,
		});
		// An import of stock.csv writes count moves: not revertible either; parts.csv is.
		expect(await rows("SELECT summary, revertible FROM change_sets WHERE source = 'import' ORDER BY id")).toEqual([
			{ summary: "Import suppliers.csv", revertible: 1 },
			{ summary: "Import parts.csv", revertible: 1 },
			{ summary: "Import part_suppliers.csv", revertible: 1 },
			{ summary: "Import boms.csv", revertible: 1 },
		]);
	});
});

describe("history triggers", () => {
	it("classifies every table as tracked or not", async () => {
		const tables = Object.values(schema).filter((v) => is(v, SQLiteTable)) as SQLiteTable[];
		const classified = [...HISTORY_TABLES, ...UNTRACKED_TABLES];
		expect(tables.filter((t) => !classified.includes(t)).map((t) => getTableName(t))).toEqual([]);
		const inDb = await rows<{ name: string }>(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%' AND name NOT LIKE '_cf_%'",
		);
		expect(inDb.map((r) => r.name).sort()).toEqual(classified.map((t) => getTableName(t)).sort());
	});

	it("capture every column of the tracked tables, as the database has them", async () => {
		const missing: string[] = [];
		for (const table of TRACKED) {
			const columns = (await rows<{ name: string }>(`PRAGMA table_info(${table})`)).map((c) => c.name);
			for (const op of ["insert", "update", "delete"]) {
				const trigger = await rows<{ sql: string }>(
					"SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ? AND tbl_name = ?",
					`history_${table}_${op}`,
					table,
				);
				if (!trigger[0]) {
					missing.push(`${table}: no ${op} trigger`);
					continue;
				}
				const refs = op === "insert" ? ["NEW"] : op === "delete" ? ["OLD"] : ["OLD", "NEW"];
				for (const col of columns) {
					for (const ref of refs) {
						if (!trigger[0].sql.includes(`'${col}', ${ref}."${col}"`)) missing.push(`${table}.${col} (${op}, ${ref})`);
					}
				}
			}
		}
		// Fix: `npm run db:generate`, then `npm run -s db:triggers >> migrations/<the new migration>.sql`.
		expect(missing).toEqual([]);
	});

	it("are exactly the generated ones (scripts/history-triggers.mjs)", async () => {
		const norm = (sql: string) => sql.replace(/\s+/g, " ").trim();
		const expected = [...HISTORY_TABLES.flatMap(tableTriggers)];
		const actual = await rows<{ name: string; sql: string }>(
			"SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
		);
		const ledgers = LEDGER_TABLES.map((t) => `history_${getTableName(t)}_ledger`);
		expect(actual.map((t) => t.name).sort()).toEqual([...expected.map((t) => t.name), ...ledgers].sort());
		for (const t of expected) {
			expect(norm(actual.find((a) => a.name === t.name)?.sql ?? ""), t.name).toBe(norm(t.sql));
		}
	});
});

describe("backup and restore", () => {
	it("round-trips the history, and records the restore without logging its rows", async () => {
		await loadDemo({ stock: false });
		await postForm("/suppliers", { name: "Acme", email: "", phone: "", notes: "" });
		const sets = await rows("SELECT * FROM change_sets ORDER BY id");
		const log = await rows("SELECT * FROM change_log ORDER BY id");
		const json = await (await request("/import/backup.json")).text();
		const backup = JSON.parse(json);
		expect(backup.tables.change_sets).toEqual(sets);
		expect(backup.tables.change_log).toHaveLength(log.length);
		expect(backup.tables.change_context).toBeUndefined();

		await postForm("/suppliers", { name: "After the backup", email: "", phone: "", notes: "" });
		expect((await postForm("/import/restore/commit", { json })).status).toBe(303);
		const after = await rows("SELECT * FROM change_sets ORDER BY id");
		expect(after.slice(0, sets.length)).toEqual(sets);
		expect(after.slice(sets.length)).toMatchObject([
			{ source: "import", revertible: 0, user_email: TESTER, summary: expect.stringContaining("Restore the backup") },
		]);
		expect(await rows("SELECT * FROM change_log ORDER BY id")).toEqual(log);
		expect(await rows("SELECT * FROM change_context")).toEqual([]);
		expect(await rows("SELECT name FROM suppliers WHERE name = 'After the backup'")).toEqual([]);
	});
});
