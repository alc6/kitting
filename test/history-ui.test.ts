import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { AUDIT_COLUMNS, columnNames } from "../src/db/history-sql";
import { HISTORY_TABLES, LEDGER_TABLES } from "../src/db/schema";
import { en } from "../src/i18n/en";
import {
	assemblyId,
	changeSql,
	importCsv,
	loadDemo,
	NOT_ADMIN,
	one,
	partId,
	postForm,
	request,
	rows,
	setRole,
	stmt,
} from "./helpers";

const lastSet = async () => (await one<{ id: number }>("SELECT max(id) AS id FROM change_sets")).id;

async function html(path: string, overrides = {}) {
	const res = await request(path, {}, overrides);
	expect(res.status, path).toBe(200);
	return res.text();
}

/** A supplier edited twice, and an assembly line whose quantity changed. */
async function seed() {
	await loadDemo({ stock: false });
	await postForm("/suppliers", { name: "Acme", email: "", phone: "", notes: "" });
	const acme = (await one<{ id: number }>("SELECT id FROM suppliers WHERE name = 'Acme'")).id;
	await postForm(`/suppliers/${acme}`, { name: "Acme", email: "", phone: "555-0100", notes: "" });
	const assembly = await assemblyId("LAMP-DESK");
	const line = await one<{ id: number }>(
		"SELECT l.id FROM assembly_lines l JOIN parts p ON p.id = l.component_part_id WHERE l.assembly_id = ? AND p.ref = 'BOX-LAMP'",
		assembly,
	);
	await postForm(`/assemblies/${assembly}/lines/${line.id}`, { qty: "3" });
	return { acme, assembly, line: line.id, qtyChange: await lastSet() };
}

describe("history pages", () => {
	it("lists recent changes, filtered by source, user, date and text", async () => {
		await seed();
		const all = await html("/history");
		expect(all).toContain("Recent changes");
		expect(all).toContain("Create supplier Acme");
		expect(all).toContain("Change the quantity of BOX-LAMP in assembly LAMP-DESK std");
		expect(all).toContain("Import parts.csv");
		const ui = await html("/history?source=ui");
		expect(ui).toContain("Create supplier Acme");
		expect(ui).not.toContain("Import parts.csv");
		expect(await html("/history?source=import")).toContain("Import parts.csv");
		expect(await html("/history?user=seed%40example.com")).not.toContain("Create supplier Acme");
		expect(await html("/history?q=quantity")).not.toContain("Create supplier Acme");
		expect(await html("/history?from=2000-01-01&to=2000-12-31")).toContain("No change matches these filters.");
		const today = new Date().toISOString().slice(0, 10);
		expect(await html(`/history?from=${today}&to=${today}`)).toContain("Create supplier Acme");
		expect(all).not.toMatch(/\sstyle=/);
		expect(all).toMatch(/href="\/history" data-slot="sidebar-menu-button" data-active="true"/);
		// The sidebar links to it for every role.
		await setRole("viewer");
		expect(await html("/", NOT_ADMIN)).toContain('href="/history"');
	});

	it("shows a change field by field, and every record's history tab", async () => {
		const s = await seed();
		const detail = await html(`/history/${s.qtyChange}`);
		expect(detail).toContain("Assembly component");
		expect(detail).toMatch(/quantity:<\/span>\s*<span class="num">1<\/span>.*→.*<span class="num">3<\/span>/s);
		expect(detail).toContain(`action="/history/${s.qtyChange}/revert"`);
		expect(detail).not.toMatch(/\sstyle=/);

		const supplier = await html(`/suppliers/${s.acme}/history`);
		expect(supplier).toContain("Edit supplier Acme");
		expect(supplier).toMatch(/phone:<\/span>.*555-0100/s);
		expect(supplier).toContain("Create supplier Acme");
		expect(await html(`/suppliers/${s.acme}`)).toContain(`href="/suppliers/${s.acme}/history"`);

		const assembly = await html(`/assemblies/${s.assembly}/history`);
		expect(assembly).toContain("Change the quantity of BOX-LAMP");
		expect(await html(`/assemblies/${s.assembly}`)).toContain(`href="/assemblies/${s.assembly}/history"`);

		const box = await partId("BOX-LAMP");
		expect(await html(`/parts/${box}`)).toContain(`href="/parts/${box}/history"`);
		expect(await html(`/parts/${box}/history`)).toContain("Import parts.csv");

		await postForm("/purchasing/po", { supplier_id: String(s.acme), expected_at: "", notes: "" });
		const po = (await one<{ id: number }>("SELECT id FROM purchase_orders")).id;
		await postForm(`/purchasing/po/${po}/lines`, { part: "BOX-LAMP", qty: "4", price: "" });
		const poHistory = await html(`/purchasing/po/${po}/history`);
		expect(poHistory).toContain("Add BOX-LAMP to PO");
		expect(poHistory).toContain("Create PO");
		expect(await html(`/purchasing/po/${po}`)).toContain(`href="/purchasing/po/${po}/history"`);
		expect((await request("/history/999999")).status).toBe(404);
	});

	it("undoes a change from its page, and explains a refusal", async () => {
		const s = await seed();
		const res = await postForm(`/history/${s.qtyChange}/revert`, {});
		expect(res.status).toBe(303);
		const undo = await lastSet();
		expect(res.headers.get("Location")).toBe(`/history/${undo}?ok=undone`);
		const page = await html(`/history/${undo}?ok=undone`);
		expect(page).toContain("Change undone.");
		expect(page).toContain(`Undo #${s.qtyChange}: Change the quantity of BOX-LAMP`);
		expect(page).toContain(`Undo of #${s.qtyChange}`);
		expect(await one("SELECT qty_milli FROM assembly_lines WHERE id = ?", s.line)).toEqual({ qty_milli: 1000 });
		// Undone: no second Undo button on the original, which links to its undo.
		const original = await html(`/history/${s.qtyChange}`);
		expect(original).toContain(`Undone by #${undo}`);
		expect(original).not.toContain(`action="/history/${s.qtyChange}/revert"`);

		// The first supplier edit cannot be undone while the supplier was created then edited after it... the
		// creation can: it is the later edit that is in the way.
		const creation = (
			await one<{ id: number }>("SELECT min(id) AS id FROM change_sets WHERE summary = 'Create supplier Acme'")
		).id;
		const refused = await postForm(`/history/${creation}/revert`, {});
		expect(refused.status).toBe(409);
		const text = await refused.text();
		expect(text).toContain("This change cannot be undone now");
		expect(text).toContain("Supplier Acme was changed since by tester@example.com");
		expect(text).toContain("Edit supplier Acme");
		expect(await rows("SELECT name FROM suppliers WHERE id = ?", s.acme)).toEqual([{ name: "Acme" }]);
	});

	it("offers Undo of an archive or unarchive only to those who may archive parts (D136)", async () => {
		await loadDemo({ stock: false });
		const box = await partId("BOX-LAMP");
		await postForm(`/parts/${box}/archive`, {});
		const archive = await lastSet();
		await postForm(`/parts/${box}/unarchive`, {});
		const unarchive = await lastSet();
		await postForm(`/parts/${box}/archive`, {});
		const rearchive = await lastSet();

		await setRole("planner");
		for (const id of [archive, unarchive, rearchive]) {
			const detail = await html(`/history/${id}`, NOT_ADMIN);
			expect(detail).not.toContain(`action="/history/${id}/revert"`);
			expect(detail).toContain("Undoing it needs rights you do not have: Archiving parts.");
			const denied = await postForm(`/history/${id}/revert`, {}, NOT_ADMIN);
			expect(denied.status).toBe(403);
			expect(await denied.text()).toContain("Archiving parts");
		}
		expect(await html("/history", NOT_ADMIN)).not.toContain(`action="/history/${rearchive}/revert"`);
		expect(await html(`/parts/${box}/history`, NOT_ADMIN)).not.toContain(`action="/history/${rearchive}/revert"`);
		expect(await one("SELECT archived FROM parts WHERE id = ?", box)).toEqual({ archived: 1 });

		// An admin sees the button and can undo.
		expect(await html(`/history/${rearchive}`)).toContain(`action="/history/${rearchive}/revert"`);
		expect((await postForm(`/history/${rearchive}/revert`, {})).status).toBe(303);
		expect(await one("SELECT archived FROM parts WHERE id = ?", box)).toEqual({ archived: 0 });

		// A planner still undoes another edit of the part.
		await postForm(`/parts/${box}`, {
			ref: "BOX-LAMP",
			name: "Renamed",
			kind: "buy",
			unit: "pcs",
			cost: "1.00",
			sale_price: "",
			supplier_id: "",
			notes: "",
		});
		const rename = await lastSet();
		expect(await html(`/history/${rename}`, NOT_ADMIN)).toContain(`action="/history/${rename}/revert"`);
	});

	it("offers Undo only to those who may edit what the change touched", async () => {
		const s = await seed();
		await postForm("/stock/adjust", { part: "BOX-LAMP", qty: "1", serial: "", note: "found" });
		const adjusted = await lastSet();
		const adjustedPage = await html(`/history/${adjusted}`);
		expect(adjustedPage).toContain("Cannot be undone");
		expect(adjustedPage).not.toContain(`action="/history/${adjusted}/revert"`);
		expect((await postForm(`/history/${adjusted}/revert`, {})).status).toBe(409);

		await setRole("operator");
		const detail = await html(`/history/${s.qtyChange}`, NOT_ADMIN);
		expect(detail).not.toContain(`action="/history/${s.qtyChange}/revert"`);
		expect(detail).toContain("Undoing it needs rights you do not have: Assembly component.");
		const denied = await postForm(`/history/${s.qtyChange}/revert`, {}, NOT_ADMIN);
		expect(denied.status).toBe(403);
		expect(await one("SELECT qty_milli FROM assembly_lines WHERE id = ?", s.line)).toEqual({ qty_milli: 3000 });

		await setRole("viewer");
		expect(await html("/history", NOT_ADMIN)).not.toContain("/revert");
		expect((await postForm(`/history/${s.qtyChange}/revert`, {}, NOT_ADMIN)).status).toBe(403);
	});

	it("hides amounts in the history from those who may not see costs", async () => {
		await loadDemo({ stock: false });
		const box = await partId("BOX-LAMP");
		const part = await one<Record<string, string | number | null>>("SELECT * FROM parts WHERE id = ?", box);
		await postForm(`/parts/${box}`, {
			ref: "BOX-LAMP",
			name: String(part.name),
			kind: "buy",
			unit: "pcs",
			cost: "4321.98",
			sale_price: "",
			supplier_id: String(part.supplier_id),
			notes: "",
		});
		const set = await lastSet();
		expect(await html(`/history/${set}`)).toContain("4,321.98");
		await setRole("viewer");
		for (const path of [`/history/${set}`, `/parts/${box}/history`]) {
			const page = await html(path, NOT_ADMIN);
			expect(page).toContain("standard cost");
			expect(page).toContain("Hidden");
			expect(page).not.toContain("4,321.98");
			expect(page).not.toContain("432198");
		}
	});

	it("has a label for every tracked table and column, and for the ledgers", () => {
		const missing: string[] = [];
		for (const t of [...HISTORY_TABLES, ...LEDGER_TABLES]) {
			if (!(getTableName(t) in en.history.tables)) missing.push(getTableName(t));
		}
		for (const t of HISTORY_TABLES) {
			for (const c of columnNames(t)) {
				if (c !== "id" && !AUDIT_COLUMNS.includes(c) && !(c in en.history.fields))
					missing.push(`${getTableName(t)}.${c}`);
			}
		}
		expect(missing).toEqual([]);
	});

	it("shows large changes and long histories (D1 binds at most 100 parameters)", async () => {
		const lines = ["ref,name,kind,unit,cost,supplier"];
		for (let i = 0; i < 120; i++) lines.push(`P-${String(i).padStart(3, "0")},Part ${i},buy,pcs,1.00,`);
		await importCsv("parts", lines.join("\n"));
		const imported = await lastSet();
		expect(await html(`/history/${imported}`)).toContain("P-119");
		await postForm("/suppliers", { name: "Acme", email: "", phone: "", notes: "" });
		const acme = (await one<{ id: number }>("SELECT id FROM suppliers WHERE name = 'Acme'")).id;
		for (let i = 0; i < 105; i++)
			await changeSql(`Edit ${i}`, stmt("UPDATE suppliers SET phone = ? WHERE id = ?", String(i), acme));
		const page = await html(`/suppliers/${acme}/history`);
		expect(page).toContain("Edit 104");
		expect(page).toContain("Create supplier Acme");
		// Undoing the import checks and deletes its 120 parts in chunks.
		expect((await postForm(`/history/${imported}/revert`, {})).status).toBe(303);
		expect(await rows("SELECT count(*) AS n FROM parts WHERE ref LIKE 'P-%'")).toEqual([{ n: 0 }]);
	});
});
