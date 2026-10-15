// UI polish (D176-D179): the "More actions" menu, forms folded in place, read views for suppliers and machines,
// and the import list.
import { describe, expect, it } from "vitest";
import { IMPORTERS } from "../src/domain/import";
import {
	assemblyId,
	insertPart,
	insertSupplier,
	loadDemo,
	NOT_ADMIN,
	one,
	partId,
	postForm,
	request,
	rows,
	setRole,
} from "./helpers";

const MENU = 'data-slot="dropdown-menu-content"';
const MORE = 'aria-label="More actions"';

async function as(role: "viewer" | "operator" | "planner" | "admin") {
	await setRole(role);
	return NOT_ADMIN;
}

async function html(path: string, env = {}) {
	const res = await request(path, {}, env);
	expect(res.status, path).toBe(200);
	return res.text();
}

/** The menu of a page: its markup, or "" when there is none. */
function menuOf(page: string): string {
	const start = page.indexOf(MENU);
	return start < 0 ? "" : page.slice(start, page.indexOf("</div>", start));
}

/** Whether the first folded form (InlineEdit) at or after `anchor` in the page starts open. */
function foldedOpen(page: string, anchor: string): boolean {
	const tag = /<details[^>]*data-slot="inline-edit"[^>]*>/.exec(page.slice(page.indexOf(anchor)));
	expect(tag, `a folded form after ${anchor}`).not.toBeNull();
	return /\sopen=""/.test(tag?.[0] ?? "");
}

describe("More actions menu (D176)", () => {
	it("holds archive and delete of a part, the destructive one last, with its confirmation", async () => {
		const id = await insertPart("BOLT", "buy");
		const page = await html(`/parts/${id}`);
		expect(page).toContain(MORE);
		expect(page).toContain('aria-haspopup="menu"');
		const menu = menuOf(page);
		expect(menu).toContain(`action="/parts/${id}/archive"`);
		expect(menu).toContain(`action="/parts/${id}/delete"`);
		expect(menu).toContain('role="menuitem"');
		expect(menu).toContain('data-slot="dropdown-menu-separator"');
		expect(menu.indexOf("/archive")).toBeLessThan(menu.indexOf("/delete"));
		expect(menu).toMatch(/action="\/parts\/\d+\/delete" data-confirm="[^"]+"/);
		// Delete is in the destructive colour, Archive is not.
		expect(menu.slice(menu.indexOf("/delete"))).toContain("text-destructive");
		expect(menu.slice(0, menu.indexOf("/delete"))).not.toMatch(/\btext-destructive\b(?! )/);
		// The header keeps the everyday action and no longer shows a red Delete button.
		expect(page).toContain(`href="/parts/${id}/edit"`);
		expect(page.replace(menu, "")).not.toContain(`action="/parts/${id}/delete"`);
	});

	it("offers Unarchive on an archived part", async () => {
		const id = await insertPart("OLD", "buy");
		await postForm(`/parts/${id}/archive`, {});
		const menu = menuOf(await html(`/parts/${id}`));
		expect(menu).toContain(`action="/parts/${id}/unarchive"`);
		expect(menu).toContain(`action="/parts/${id}/delete"`);
		expect(menu.indexOf("/unarchive")).toBeLessThan(menu.indexOf("/delete"));
	});

	it("is hidden when the role can use none of its actions", async () => {
		const id = await insertPart("BOLT", "buy");
		// Archive and delete are admin actions: a planner sees Edit but no menu.
		const planner = await html(`/parts/${id}`, await as("planner"));
		expect(planner).toContain(`href="/parts/${id}/edit"`);
		expect(planner).not.toContain(MORE);
		expect(planner).not.toContain(MENU);
		const viewer = await html(`/parts/${id}`, await as("viewer"));
		expect(viewer).not.toContain(MORE);
		const admin = await html(`/parts/${id}`);
		expect(admin).toContain(MORE);
	});

	it("is on assembly, supplier, build, purchase order, machine and file pages for who may use it", async () => {
		await loadDemo();
		const asm = await assemblyId("LAMP-DESK");
		const adminAsm = menuOf(await html(`/assemblies/${asm}`));
		expect(adminAsm).toContain(`action="/assemblies/${asm}/archive"`);
		expect(adminAsm).toContain(`action="/assemblies/${asm}/delete"`);
		// Revisions stay in the header.
		const asmPage = await html(`/assemblies/${asm}`);
		expect(asmPage.replace(adminAsm, "")).toContain(`action="/assemblies/${asm}/revision"`);
		expect(await html(`/assemblies/${asm}`, await as("planner"))).not.toContain(MORE);

		const supplier = await one<{ id: number }>("SELECT id FROM suppliers ORDER BY id LIMIT 1");
		expect(menuOf(await html(`/suppliers/${supplier.id}`))).toContain(`action="/suppliers/${supplier.id}/delete"`);
		expect(await html(`/suppliers/${supplier.id}`, await as("planner"))).not.toContain(MORE);
	});

	it("moves Cancel build and Close/Cancel/Delete of a purchase order into the menu", async () => {
		await loadDemo();
		const res = await postForm("/builds", {
			part_id: String(await partId("ARM-ASSY")),
			assembly_id: String(await assemblyId("ARM-ASSY")),
			qty: "1",
			serial: "",
			planned_for: "",
			notes: "",
		});
		expect(res.status).toBe(303);
		const buildPath = res.headers.get("Location")?.split("?")[0] ?? "";
		const build = await html(buildPath);
		const buildMenu = menuOf(build);
		expect(buildMenu).toMatch(/action="\/builds\/\d+\/cancel"/);
		expect(buildMenu).toContain("text-destructive");
		expect(build.replace(buildMenu, "")).toMatch(/action="\/builds\/\d+\/start"/);
		expect(build.replace(buildMenu, "")).not.toMatch(/action="\/builds\/\d+\/cancel"/);
		// An operator may plan builds, so the menu stays for them.
		expect(await html(buildPath, await as("operator"))).toContain(MORE);
		expect(await html(buildPath, await as("viewer"))).not.toContain(MORE);

		await setRole("admin");
		const supplier = await one<{ id: number }>("SELECT id FROM suppliers WHERE name = 'Lumen Parts Co'");
		const created = await postForm("/purchasing/po", { supplier_id: String(supplier.id), expected_at: "", notes: "" });
		const poPath = created.headers.get("Location")?.split("?")[0] ?? "";
		expect(poPath).toMatch(/^\/purchasing\/po\/\d+$/);
		const poId = poPath.split("/").pop();
		expect((await postForm(`${poPath}/lines`, { part: "LED-5W-CW", qty: "3", price: "" })).status).toBe(303);
		const po = await html(poPath);
		const poMenu = menuOf(po);
		expect(poMenu).toContain(`action="/purchasing/po/${poId}/cancel"`);
		expect(poMenu).toContain(`action="/purchasing/po/${poId}/delete"`);
		expect(po.replace(poMenu, "")).toContain(`action="/purchasing/po/${poId}/send"`);
		expect(await html(poPath, await as("operator"))).not.toContain(MORE);
	});

	it("hides the machine menu once it is retired", async () => {
		await loadDemo();
		const machine = await one<{ id: number }>("SELECT id FROM machines ORDER BY id LIMIT 1");
		const page = await html(`/machines/${machine.id}`);
		expect(menuOf(page)).toContain(`action="/machines/${machine.id}/retire"`);
		expect(menuOf(page)).toMatch(/data-confirm="/);
		expect((await postForm(`/machines/${machine.id}/retire`, {})).status).toBe(303);
		expect(await html(`/machines/${machine.id}`)).not.toContain(MORE);
	});
});

describe("forms folded in place (D177)", () => {
	it("shows the production settings as one line and folds the form open on errors", async () => {
		await loadDemo();
		const id = await assemblyId("LAMP-DESK");
		const page = await html(`/assemblies/${id}`);
		expect(foldedOpen(page, 'id="assembly-lines"')).toBe(false);
		expect(page).toMatch(/Batch\s*<span[^>]*>1<\/span>|Batch[^<]*1/);
		expect(page).toContain("Machine time");
		expect(page).toContain(`action="/assemblies/${id}/production"`);

		const refused = await postForm(`/assemblies/${id}/production`, { batch_qty: "0" });
		expect(refused.status).toBe(422);
		const text = await refused.text();
		expect(foldedOpen(text, 'id="assembly-lines"')).toBe(true);
		expect(text).toContain("Must be more than zero.");
	});

	it("shows the variant's price with its badge and folds the form open on errors", async () => {
		await loadDemo({ stock: false });
		const std = await assemblyId("LAMP-DESK");
		let page = await html(`/assemblies/${std}`);
		const card = () => page.slice(page.indexOf('id="sale-price"'));
		expect(card()).toContain("product&#39;s price");
		expect(foldedOpen(page, 'id="sale-price"')).toBe(false);
		await postForm(`/assemblies/${std}/sale-price`, { sale_price: "99.50" });
		page = await html(`/assemblies/${std}`);
		expect(card()).toContain("own price");
		const bad = await postForm(`/assemblies/${std}/sale-price`, { sale_price: "abc" });
		expect(bad.status).toBe(422);
		page = await bad.text();
		expect(foldedOpen(page, 'id="sale-price"')).toBe(true);
		expect(card()).toContain("Not a valid amount");
	});

	it("keeps Add a past price in the price history header, open when refused", async () => {
		const id = await insertPart("BOLT", "buy", { costCents: 100 });
		const page = await html(`/parts/${id}`);
		const header = page.slice(page.indexOf('id="price-history"'));
		expect(header).toMatch(/<details[^>]*data-slot="inline-edit"[^>]*>\s*<summary/);
		expect(header).toContain("Add a past price");
		expect(foldedOpen(page, 'id="price-history"')).toBe(false);
		expect(header).toContain(`action="/parts/${id}/prices/past#price-history"`);
		const refused = await postForm(`/parts/${id}/prices/past`, { date: "", price: "x", supplier_id: "", note: "" });
		expect(refused.status).toBe(422);
		const text = await refused.text();
		expect(foldedOpen(text, 'id="price-history"')).toBe(true);
		// No right to edit prices, no button and no form.
		const viewer = await html(`/parts/${id}`, await as("viewer"));
		expect(viewer).not.toContain("Add a past price");
	});
});

describe("supplier pages (D178)", () => {
	it("opens as a read view with linked contacts, and edits on its own page", async () => {
		const id = await insertSupplier("Acme");
		await postForm(`/suppliers/${id}`, {
			name: "Acme",
			email: "sales@acme.example",
			phone: "+33 1 23 45",
			notes: "Net 30",
		});
		const page = await html(`/suppliers/${id}`);
		expect(page).toContain('href="mailto:sales@acme.example"');
		expect(page).toContain('href="tel:+3312345"'); // "+33 1 23 45" without the spaces
		expect(page).toContain("Net 30");
		expect(page).toContain(`href="/suppliers/${id}/edit"`);
		expect(page).not.toContain(`action="/suppliers/${id}"`);
		expect(page).not.toContain("autofocus");

		const edit = await html(`/suppliers/${id}/edit`);
		expect(edit).toContain(`action="/suppliers/${id}"`);
		expect(edit).toContain('value="Acme"');
		expect(edit).not.toContain("autofocus");
		expect(edit).toContain(`href="/suppliers/${id}"`); // Cancel
		// Creating still focuses the name.
		expect(await html("/suppliers/new")).toContain("autofocus");
	});

	it("re-renders the edit form with its errors and saves from it", async () => {
		const id = await insertSupplier("Acme");
		await insertSupplier("Other");
		const refused = await postForm(`/suppliers/${id}`, { name: "Other" });
		expect(refused.status).toBe(422);
		const text = await refused.text();
		expect(text).toContain(`action="/suppliers/${id}"`);
		expect(text).toContain("This name is already used.");
		const saved = await postForm(`/suppliers/${id}`, { name: "Acme 2" });
		expect(saved.headers.get("Location")).toBe(`/suppliers/${id}?ok=saved`);
		expect(await one("SELECT name FROM suppliers WHERE id = ?", id)).toEqual({ name: "Acme 2" });
	});

	it("limits Edit to who may edit suppliers", async () => {
		const id = await insertSupplier("Acme");
		for (const role of ["viewer", "operator"] as const) {
			const env = await as(role);
			const page = await html(`/suppliers/${id}`, env);
			expect(page).not.toContain(`/suppliers/${id}/edit`);
			expect(page).not.toContain(MORE);
			expect((await request(`/suppliers/${id}/edit`, {}, env)).status).toBe(403);
		}
		const planner = await html(`/suppliers/${id}`, await as("planner"));
		expect(planner).toContain(`href="/suppliers/${id}/edit"`);
		expect((await request(`/suppliers/${id}/edit`, {}, NOT_ADMIN)).status).toBe(200);
		expect((await request("/suppliers/999/edit")).status).toBe(404);
	});
});

describe("machine pages (D178)", () => {
	it("opens as a read view, and edits on its own page", async () => {
		await loadDemo();
		const machine = await one<{ id: number; name: string; machine_type_id: number }>(
			"SELECT id, name, machine_type_id FROM machines ORDER BY id LIMIT 1",
		);
		const page = await html(`/machines/${machine.id}`);
		expect(page).toContain(machine.name);
		expect(page).toContain(`href="/machines/types/${machine.machine_type_id}"`);
		expect(page).toContain(`href="/machines/${machine.id}/edit"`);
		expect(page).not.toContain(`action="/machines/${machine.id}"`);
		expect(page).not.toContain("autofocus");

		const edit = await html(`/machines/${machine.id}/edit`);
		expect(edit).toContain(`action="/machines/${machine.id}"`);
		expect(edit).not.toContain("autofocus");
		expect(edit).toContain(`href="/machines/${machine.id}"`);
		expect(await html("/machines/new")).toContain("autofocus");

		const refused = await postForm(`/machines/${machine.id}`, {
			name: "",
			machine_type_id: String(machine.machine_type_id),
			status: "active",
		});
		expect(refused.status).toBe(422);
		expect(await refused.text()).toContain(`action="/machines/${machine.id}"`);
		expect(await rows("SELECT name FROM machines WHERE id = ?", machine.id)).toEqual([{ name: machine.name }]);
	});

	it("limits Edit to who may edit machines", async () => {
		await loadDemo();
		const machine = await one<{ id: number }>("SELECT id FROM machines ORDER BY id LIMIT 1");
		const env = await as("operator");
		const page = await html(`/machines/${machine.id}`, env);
		expect(page).not.toContain(`/machines/${machine.id}/edit`);
		expect(page).not.toContain(MORE);
		expect((await request(`/machines/${machine.id}/edit`, {}, env)).status).toBe(403);
		const planner = await html(`/machines/${machine.id}`, await as("planner"));
		expect(planner).toContain(`/machines/${machine.id}/edit`);
		expect((await request("/machines/999/edit")).status).toBe(404);
	});
});

describe("import list (D179)", () => {
	it("lists the importers in order, each with template, export and its own form", async () => {
		const page = await html("/import");
		const types = IMPORTERS.map((i) => i.type);
		const positions = types.map((t) => page.indexOf(`id="import-${t}"`));
		expect(positions.every((p) => p > 0)).toBe(true);
		expect([...positions].sort((a, b) => a - b)).toEqual(positions);
		for (const type of types) {
			expect(page).toContain(`href="/import/${type}/template.csv"`);
			expect(page).toContain(`href="/import/${type}/export.csv"`);
			expect(page).toContain(`popovertarget="import-form-${type}"`);
			expect(page).toContain(`id="import-form-${type}"`);
			expect(page).toContain(`action="/import/${type}/preview"`);
		}
		expect(page).toContain("Import…");
		expect(page).toContain("Backup");
		expect(page).not.toMatch(/\sstyle=/);
	});

	it("keeps the preview flow: a valid file previews, a refused one gets its own page, both back to the list", async () => {
		const good = new FormData();
		good.set("csv", "name\nAcme\n");
		const ok = await request("/import/suppliers/preview", { method: "POST", body: good });
		expect(ok.status).toBe(200);
		const okText = await ok.text();
		expect(okText).toContain('href="/import#import-suppliers"');
		expect(okText).toContain("Confirm import");
		const bad = new FormData();
		bad.set("csv", "nothing,here\n1,2\n");
		const refused = await request("/import/suppliers/preview", { method: "POST", body: bad });
		expect(refused.status).toBe(422);
		expect(await refused.text()).toContain('href="/import#import-suppliers"');
	});

	it("still shows the import list to a planner, without the restore form", async () => {
		const page = await html("/import", await as("planner"));
		expect(page).toContain('id="import-form-parts"');
		expect(page).not.toContain("/import/restore/preview");
	});
});
