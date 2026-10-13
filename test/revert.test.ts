import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { HISTORY_TABLES } from "../src/db/schema";
import { runChangeSet } from "../src/domain/history";
import type { Access } from "../src/domain/permissions";
import { changeSetEntries, getChangeSet, revertChangeSet, revertStatements, TABLE_ACTIONS } from "../src/domain/revert";
import { bomId, changeSql, loadDemo, one, partId, postForm, rows, stmt, TESTER, testDb } from "./helpers";

const ADMIN: Access = { role: "admin", seeCosts: true };
const by = { user: TESTER, summary: (s: { id: number; summary: string }) => `Undo #${s.id}: ${s.summary}` };

async function lastSetId(): Promise<number> {
	return (await one<{ id: number }>("SELECT max(id) AS id FROM change_sets")).id;
}

async function revert(id: number, access: Access = ADMIN) {
	return revertChangeSet(testDb(), access, id, by);
}

/** Every tracked table's rows, to compare whole database states. */
async function snapshot() {
	const out: Record<string, unknown[]> = {};
	for (const t of HISTORY_TABLES) {
		const name = getTableName(t);
		out[name] = await rows(`SELECT * FROM ${name} ORDER BY id`);
	}
	return out;
}

/** Data columns only: an undo signs and dates the rows it changes. */
function withoutAudit(state: Record<string, unknown[]>) {
	return Object.fromEntries(
		Object.entries(state).map(([k, list]) => [
			k,
			(list as Record<string, unknown>[]).map(({ created_at, updated_at, created_by, updated_by, ...rest }) => rest),
		]),
	);
}

describe("undo", () => {
	it("maps every tracked table to the permission that edits it", () => {
		expect(Object.keys(TABLE_ACTIONS).sort()).toEqual(HISTORY_TABLES.map((t) => getTableName(t)).sort());
	});

	it("restores an update, and logs the restored prices in the price history", async () => {
		await loadDemo({ stock: false });
		const box = await partId("BOX-LAMP");
		const before = await one("SELECT * FROM parts WHERE id = ?", box);
		const edit = await postForm(`/parts/${box}`, {
			ref: "BOX-LAMP",
			name: "Renamed box",
			kind: "buy",
			unit: "pcs",
			cost: "9.99",
			sale_price: "",
			supplier_id: String(before.supplier_id),
			notes: "",
		});
		expect(edit.status).toBe(303);
		const changed = await lastSetId();
		expect(await one("SELECT name, cost_cents FROM parts WHERE id = ?", box)).toEqual({
			name: "Renamed box",
			cost_cents: 999,
		});

		const result = await revert(changed);
		expect(result).toEqual({ ok: true, id: expect.any(Number) });
		const after = await one("SELECT * FROM parts WHERE id = ?", box);
		expect({ ...after, updated_at: null, updated_by: null }).toEqual({ ...before, updated_at: null, updated_by: null });
		expect(after.updated_by).toBe(TESTER);
		const undo = await getChangeSet(testDb(), result.ok ? (result.id as number) : 0);
		expect(undo).toMatchObject({ source: "revert", revertsChangeSetId: changed, revertible: true, userEmail: TESTER });
		expect(undo?.summary).toBe(`Undo #${changed}: Edit part BOX-LAMP`);
		// The price history stays append-only and follows the price back.
		expect(
			await rows(
				"SELECT price_cents, source, note FROM price_history WHERE part_id = ? AND kind = 'standard' ORDER BY id",
				box,
			),
		).toEqual([
			{ price_cents: before.cost_cents, source: "import", note: "" },
			{ price_cents: 999, source: "form", note: "" },
			{ price_cents: before.cost_cents, source: "revert", note: `#${changed}` },
		]);
	});

	it("re-inserts deleted rows with their ids, children included", async () => {
		await loadDemo({ stock: false });
		const bom = await bomId("LAMP-DESK");
		const state = await snapshot();
		await postForm(`/boms/${bom}/archive`, {});
		const archived = await lastSetId();
		await postForm(`/boms/${bom}/delete`, {});
		const deleted = await lastSetId();
		expect(await rows("SELECT id FROM boms WHERE id = ?", bom)).toEqual([]);

		expect((await revert(deleted)).ok).toBe(true);
		expect((await revert(archived)).ok).toBe(true);
		expect(withoutAudit(await snapshot())).toEqual(withoutAudit(state));
		// Re-inserted rows come back exactly, who/when included.
		expect((await snapshot()).bom_lines).toEqual(state.bom_lines);
	});

	it("deletes inserted rows, and undoes an undo", async () => {
		const state = await snapshot();
		await postForm("/suppliers", { name: "Acme", email: "", phone: "", notes: "" });
		const created = await lastSetId();
		const withAcme = await snapshot();

		const undo = await revert(created);
		expect(undo.ok).toBe(true);
		expect(await snapshot()).toEqual(state);

		const redo = await revert(undo.ok ? (undo.id as number) : 0);
		expect(redo.ok).toBe(true);
		expect(await snapshot()).toEqual(withAcme);
		expect(await rows("SELECT source, reverts_change_set_id FROM change_sets ORDER BY id")).toEqual([
			{ source: "ui", reverts_change_set_id: null },
			{ source: "revert", reverts_change_set_id: created },
			{ source: "revert", reverts_change_set_id: undo.ok ? undo.id : 0 },
		]);
	});

	it("restores a change spanning several rows in reverse order (activating a BoM)", async () => {
		await loadDemo({ stock: false });
		const active = await bomId("LAMP-DESK");
		await postForm(`/boms/${active}/revision`, {});
		const draft = (await one<{ id: number }>("SELECT max(id) AS id FROM boms")).id;
		const state = await snapshot();
		await postForm(`/boms/${draft}/activate`, {});
		expect(await one("SELECT status FROM boms WHERE id = ?", active)).toEqual({ status: "archived" });
		expect((await revert(await lastSetId())).ok).toBe(true);
		expect(withoutAudit(await snapshot())).toEqual(withoutAudit(state));
	});

	it("refuses, changing nothing, when a row changed since", async () => {
		await postForm("/suppliers", { name: "Acme", email: "", phone: "", notes: "" });
		const id = (await one<{ id: number }>("SELECT id FROM suppliers")).id;
		await postForm(`/suppliers/${id}`, { name: "Acme", email: "", phone: "", notes: "first" });
		const first = await lastSetId();
		await postForm(`/suppliers/${id}`, { name: "Acme", email: "", phone: "", notes: "second" });
		const second = await lastSetId();
		const state = await snapshot();
		const sets = await rows("SELECT * FROM change_sets");

		const result = await revert(first);
		expect(result).toMatchObject({
			ok: false,
			reason: "conflict",
			conflicts: [
				{
					table: "suppliers",
					rowId: id,
					reason: "changed",
					by: { changeSetId: second, user: TESTER, summary: "Edit supplier Acme" },
				},
			],
		});
		expect(await snapshot()).toEqual(state);
		expect(await rows("SELECT * FROM change_sets")).toEqual(sets);
		// Undoing the later change first makes the earlier one undoable.
		expect((await revert(second)).ok).toBe(true);
		expect((await revert(first)).ok).toBe(true);
		expect(await one("SELECT notes FROM suppliers WHERE id = ?", id)).toEqual({ notes: "" });
	});

	it("refuses to delete a row that is used since, and to restore a row whose parent is gone", async () => {
		await loadDemo({ stock: false });
		await postForm("/parts", { ref: "NEW-1", name: "New", kind: "buy", unit: "pcs" });
		const created = await lastSetId();
		expect((await postForm("/stock/adjust", { part: "NEW-1", qty: "2", serial: "", note: "found" })).status).toBe(303);
		expect(await revert(created)).toMatchObject({
			ok: false,
			reason: "conflict",
			conflicts: [{ table: "parts", reason: "in_use", other: "stock_moves" }],
		});
		expect(await rows("SELECT ref FROM parts WHERE ref = 'NEW-1'")).toEqual([{ ref: "NEW-1" }]);

		// A BoM line removed, then its component deleted: the line cannot come back.
		await postForm("/parts", { ref: "NEW-2", name: "New", kind: "buy", unit: "pcs" });
		const bom = await bomId("LAMP-DESK");
		await postForm(`/boms/${bom}/lines`, { component: "NEW-2", qty: "1", notes: "" });
		const line = (await one<{ id: number }>("SELECT max(id) AS id FROM bom_lines")).id;
		await postForm(`/boms/${bom}/lines/${line}/delete`, {});
		const removed = await lastSetId();
		await postForm(`/parts/${await partId("NEW-2")}/delete`, {});
		expect(await revert(removed)).toMatchObject({
			ok: false,
			reason: "conflict",
			conflicts: [{ table: "bom_lines", rowId: line, reason: "parent_missing", other: "parts" }],
		});
	});

	it("refuses to give back a unique value another row took since", async () => {
		await postForm("/parts", { ref: "OLD-REF", name: "Part", kind: "buy", unit: "pcs" });
		const id = (await one<{ id: number }>("SELECT id FROM parts WHERE ref = 'OLD-REF'")).id;
		await postForm(`/parts/${id}`, { ref: "NEW-REF", name: "Part", kind: "buy", unit: "pcs" });
		const renamed = await lastSetId();
		await postForm("/parts", { ref: "OLD-REF", name: "Another part", kind: "buy", unit: "pcs" });
		const state = await snapshot();
		expect(await revert(renamed)).toMatchObject({
			ok: false,
			reason: "conflict",
			conflicts: [{ table: "parts", rowId: id, reason: "duplicate" }],
		});
		expect(await snapshot()).toEqual(state);
	});

	it("brings back a deleted part with its offers, and restarts its price history", async () => {
		await postForm("/suppliers", { name: "Acme", email: "", phone: "", notes: "" });
		const acme = (await one<{ id: number }>("SELECT id FROM suppliers")).id;
		await postForm("/parts", {
			ref: "GONE",
			name: "Soon deleted",
			kind: "buy",
			unit: "pcs",
			cost: "2.50",
			supplier_id: String(acme),
			supplier_ref: "AC-1",
		});
		const id = (await one<{ id: number }>("SELECT id FROM parts WHERE ref = 'GONE'")).id;
		const state = await snapshot();
		expect((await postForm(`/parts/${id}/delete`, {})).status).toBe(303);
		expect(await rows("SELECT * FROM price_history WHERE part_id = ?", id)).toEqual([]);
		const deleted = await lastSetId();
		expect(await rows("SELECT table_name, op FROM change_log WHERE change_set_id = ? ORDER BY id", deleted)).toEqual([
			{ table_name: "part_suppliers", op: "delete" },
			{ table_name: "parts", op: "delete" },
		]);

		expect((await revert(deleted)).ok).toBe(true);
		expect(await snapshot()).toEqual(state);
		expect(await rows("SELECT kind, price_cents, source FROM price_history WHERE part_id = ?", id)).toEqual([
			{ kind: "standard", price_cents: 250, source: "revert" },
		]);
	});

	it("rolls the whole undo back when a row changes while it runs", async () => {
		await postForm("/suppliers", { name: "Acme", email: "", phone: "", notes: "" });
		const id = (await one<{ id: number }>("SELECT id FROM suppliers")).id;
		await postForm(`/suppliers/${id}`, { name: "Acme", email: "", phone: "", notes: "edited" });
		const db = testDb();
		const set = (await getChangeSet(db, await lastSetId()))!;
		const statements = revertStatements(db, set, await changeSetEntries(db, set.id), TESTER, new Date().toISOString());
		// Someone saves the supplier between the checks and the batch.
		await changeSql("Meanwhile", stmt("UPDATE suppliers SET phone = '555' WHERE id = ?", id));
		const state = await snapshot();
		const meta = { user: TESTER, source: "revert" as const, summary: "Undo", revertsChangeSetId: set.id };
		await expect(runChangeSet(db, meta, statements)).rejects.toThrow(/revert_conflict/);
		expect(await snapshot()).toEqual(state);
		expect(await rows("SELECT * FROM change_context")).toEqual([]);
	});

	it("never lets a cascade delete rows added while the undo runs", async () => {
		await loadDemo({ stock: false });
		const lamp = await partId("LAMP-DESK");
		await postForm("/boms", { parent_part_id: String(lamp), code: "alt", revision: "R1", notes: "", copy_from: "" });
		const created = await lastSetId();
		const bom = (await one<{ id: number }>("SELECT max(id) AS id FROM boms")).id;
		const db = testDb();
		const set = (await getChangeSet(db, created))!;
		const statements = revertStatements(db, set, await changeSetEntries(db, set.id), TESTER, new Date().toISOString());
		await postForm(`/boms/${bom}/lines`, { component: "BOX-LAMP", qty: "1", notes: "" });
		const meta = { user: TESTER, source: "revert" as const, summary: "Undo", revertsChangeSetId: set.id };
		await expect(runChangeSet(db, meta, statements)).rejects.toThrow(/revert_conflict/);
		expect(await rows("SELECT count(*) AS n FROM bom_lines WHERE bom_id = ?", bom)).toEqual([{ n: 1 }]);
		// Checked beforehand, the same undo is refused with a reason.
		expect(await revert(created)).toMatchObject({
			ok: false,
			conflicts: [{ table: "boms", rowId: bom, reason: "in_use", other: "bom_lines" }],
		});
	});

	it("refuses change sets that wrote ledger rows, and empty or unknown ones", async () => {
		await loadDemo();
		expect((await postForm("/stock/adjust", { part: "BOX-LAMP", qty: "1", serial: "", note: "found" })).status).toBe(
			303,
		);
		expect(await revert(await lastSetId())).toEqual({ ok: false, reason: "not_revertible" });
		expect(await revert(999_999)).toEqual({ ok: false, reason: "not_found" });
		const restore = await rows<{ id: number }>("SELECT id FROM change_sets WHERE summary = 'Import stock.csv'");
		expect(await revert(restore[0]!.id)).toEqual({ ok: false, reason: "not_revertible" });
	});

	it("needs the edit permission of every area the change touched", async () => {
		await loadDemo({ stock: false });
		const box = await partId("BOX-LAMP");
		await postForm(`/parts/${box}/archive`, {});
		const archived = await lastSetId();
		expect(await revert(archived, { role: "operator", seeCosts: false })).toEqual({
			ok: false,
			reason: "forbidden",
			actions: ["parts.edit"],
		});
		const lamp = await partId("LAMP-DESK");
		await postForm("/builds", {
			part_id: String(lamp),
			bom_id: String(await bomId("LAMP-DESK")),
			qty: "1",
			serial: "L-1",
			planned_for: "",
			notes: "",
		});
		const planned = await lastSetId();
		expect((await revert(planned, { role: "operator", seeCosts: false })).ok).toBe(true);
		expect(await rows("SELECT id FROM builds")).toEqual([]);
		expect((await revert(archived, { role: "planner", seeCosts: true })).ok).toBe(true);
	});
});
