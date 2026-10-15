import { beforeEach, describe, expect, it } from "vitest";
import { listSuppliers } from "../src/domain/suppliers";
import {
	insertMove,
	insertPart,
	insertSupplier,
	loadDemo,
	NOT_ADMIN,
	one,
	postForm,
	request,
	rows,
	setRole,
	testDb,
} from "./helpers";

// NOT_ADMIN requests run as a planner, so admin-only actions are refused by requireAdmin itself.
beforeEach(() => setRole("planner"));

const partForm = (over: Record<string, string> = {}) => ({
	ref: "LED-5W",
	name: "LED module 5W",
	kind: "buy",
	unit: "pcs",
	cost: "3,25",
	supplier_id: "",
	supplier_ref: "",
	moq: "10",
	pack_size: "",
	lead_days: "14",
	notes: "",
	...over,
});

describe("suppliers", () => {
	it("creates, lists, searches and updates", async () => {
		const res = await postForm("/suppliers", {
			name: "Acme Optics",
			email: "orders@acme.example",
			phone: "",
			notes: "",
		});
		expect(res.status).toBe(303);
		const id = (await one<{ id: number }>("SELECT id FROM suppliers")).id;
		expect(res.headers.get("Location")).toBe(`/suppliers/${id}?ok=saved`);
		expect(await (await request("/suppliers?q=acme")).text()).toContain("Acme Optics");
		expect(await (await request("/suppliers?q=zzz")).text()).not.toContain("Acme Optics");
		const upd = await postForm(`/suppliers/${id}`, { name: "Acme Optics SA", email: "", phone: "+33", notes: "x" });
		expect(upd.status).toBe(303);
		expect(await one("SELECT name, phone FROM suppliers")).toEqual({ name: "Acme Optics SA", phone: "+33" });
	});

	it("rejects invalid input and case-insensitive duplicates", async () => {
		await insertSupplier("Acme");
		const dup = await postForm("/suppliers", { name: "ACME", email: "", phone: "", notes: "" });
		expect(dup.status).toBe(422);
		expect(await dup.text()).toContain("This name is already used.");
		const bad = await postForm("/suppliers", { name: "", email: "not-an-email", phone: "", notes: "" });
		expect(bad.status).toBe(422);
		const html = await bad.text();
		expect(html).toContain("Required.");
		expect(html).toContain("Not a valid email address.");
	});

	it("refuses to delete a supplier still used by parts, and only for admins", async () => {
		const s = await insertSupplier("Acme");
		await insertPart("P1", "buy", { supplierId: s });
		expect((await postForm(`/suppliers/${s}/delete`, {}, NOT_ADMIN)).status).toBe(403);
		const res = await postForm(`/suppliers/${s}/delete`, {});
		expect(res.headers.get("Location")).toBe(`/suppliers/${s}?err=in_use`);
		expect(await rows("SELECT id FROM suppliers")).toHaveLength(1);
	});

	it("counts the active parts each supplier is the preferred supplier of", async () => {
		await loadDemo({ stock: false });
		const list = await listSuppliers(testDb());
		expect(list.find((s) => s.name === "Bolt & Nut Depot")?.partCount).toBe(6);
		const expected = await rows<{ name: string; partCount: number }>(
			`SELECT s.name, count(p.id) AS partCount FROM suppliers s
				LEFT JOIN parts p ON p.supplier_id = s.id AND p.archived = 0 GROUP BY s.id ORDER BY s.name`,
		);
		expect(list.map((s) => ({ name: s.name, partCount: s.partCount }))).toEqual(expected);
	});
});

describe("parts", () => {
	it("creates a part with decimal-comma cost and milli quantities", async () => {
		const s = await insertSupplier("Acme");
		const res = await postForm("/parts", partForm({ supplier_id: String(s), pack_size: "2,5" }));
		expect(res.status).toBe(303);
		// Ordering terms are stored on the preferred supplier's offer; the cost opens the price history.
		const p = await one(
			"SELECT p.ref, p.kind, p.cost_cents, o.moq_milli, o.pack_size_milli, o.lead_days, p.supplier_id, p.track_serial FROM parts p JOIN part_suppliers o ON o.part_id = p.id AND o.supplier_id = p.supplier_id",
		);
		expect(p).toEqual({
			ref: "LED-5W",
			kind: "buy",
			cost_cents: 325,
			moq_milli: 10000,
			pack_size_milli: 2500,
			lead_days: 14,
			supplier_id: s,
			track_serial: 0,
		});
		expect(await rows("SELECT kind, price_cents, source FROM price_history")).toEqual([
			{ kind: "standard", price_cents: 325, source: "form" },
		]);
		const detail = await (await request(res.headers.get("Location")!)).text();
		expect(detail).toContain("LED-5W");
		expect(detail).toContain("€3.25");
	});

	it("edits the selling price from the part form, logged in the price history", async () => {
		await postForm("/parts", partForm({ sale_price: "12,50" }));
		const id = (await one<{ id: number }>("SELECT id FROM parts")).id;
		expect(await one("SELECT sale_price_cents FROM parts")).toEqual({ sale_price_cents: 1250 });
		const form = await (await request(`/parts/${id}/edit`)).text();
		expect(form).toMatch(/name="sale_price"[^>]*value="12.50"/);
		await postForm(`/parts/${id}`, partForm({ sale_price: "" }));
		expect(await one("SELECT sale_price_cents FROM parts")).toEqual({ sale_price_cents: null });
		expect(await rows("SELECT kind, price_cents FROM price_history WHERE kind = 'sale' ORDER BY id")).toEqual([
			{ kind: "sale", price_cents: 1250 },
			{ kind: "sale", price_cents: null },
		]);
	});

	it("saves the minimum stock from the form and shows it on the form, the page and the stock list", async () => {
		const res = await postForm("/parts", partForm({ min_stock: "12,5" }));
		expect(res.status).toBe(303);
		const id = (await one<{ id: number }>("SELECT id FROM parts")).id;
		expect(await one("SELECT min_stock_milli FROM parts")).toEqual({ min_stock_milli: 12500 });
		expect(await (await request(`/parts/${id}/edit`)).text()).toMatch(/name="min_stock"[^>]*value="12.5"/);
		const detail = await (await request(`/parts/${id}`)).text();
		expect(detail).toContain("Minimum stock");
		expect(detail).toContain("12.5");
		// Empty removes it; the change is one history entry with its label.
		expect((await postForm(`/parts/${id}`, partForm({ min_stock: "" }))).status).toBe(303);
		expect(await one("SELECT min_stock_milli FROM parts")).toEqual({ min_stock_milli: null });
		const history = await (await request(`/parts/${id}/history`)).text();
		expect(history).toContain("minimum stock");
	});

	it("refuses a negative minimum and a minimum on a kit or a fee", async () => {
		const neg = await postForm("/parts", partForm({ min_stock: "-2" }));
		expect(neg.status).toBe(422);
		expect(await neg.text()).toContain("Must be zero or more.");
		for (const kind of ["kit", "fee"]) {
			const bad = await postForm("/parts", partForm({ ref: `X-${kind}`, kind, min_stock: "3" }));
			expect(bad.status).toBe(422);
			expect(await bad.text()).toContain("Only buy and make parts have a minimum stock.");
		}
		expect(await rows("SELECT id FROM parts")).toEqual([]);
	});

	it("treats an empty cost as unknown (NULL)", async () => {
		await postForm("/parts", partForm({ cost: "" }));
		expect(await one("SELECT cost_cents FROM parts")).toEqual({ cost_cents: null });
	});

	it("validates refs, kinds, numbers and uniqueness", async () => {
		await insertPart("LED-5W");
		const dup = await postForm("/parts", partForm());
		expect(dup.status).toBe(422);
		expect(await dup.text()).toContain("This reference is already used.");
		const caseDup = await postForm("/parts", partForm({ ref: "led-5w" }));
		expect(await caseDup.text()).toContain("Differs only by upper/lower case from existing reference LED-5W.");
		const bad = await postForm("/parts", partForm({ ref: "has space", kind: "magic", cost: "1.234", moq: "-1" }));
		const html = await bad.text();
		expect(html).toContain("no spaces");
		expect(html).toContain("Kind must be buy, make, kit or fee.");
		expect(html).toContain("Not a valid amount");
		expect(html).toContain("Must be zero or more.");
	});

	it("refuses serial tracking on kits and fees, and kit/fee for stocked parts", async () => {
		const res = await postForm("/parts", partForm({ kind: "kit", track_serial: "on" }));
		expect(await res.text()).toContain("Only buy and make parts can be serial-tracked.");
		const id = await insertPart("P1");
		await insertMove(id, 5000);
		const upd = await postForm(`/parts/${id}`, partForm({ ref: "P1", kind: "fee" }));
		expect(upd.status).toBe(422);
		expect(await upd.text()).toContain("cannot become a kit or a fee");
	});

	it("keeps parts that own assemblies as make or kit", async () => {
		const id = await insertPart("ASSY", "make");
		await postForm("/assemblies", {
			parent_part_id: String(id),
			code: "std",
			revision: "Rev1",
			notes: "",
			copy_from: "",
		});
		const assemblyId = (await one<{ id: number }>("SELECT id FROM assemblies")).id;
		expect(await (await request(`/parts/${id}`)).text()).toContain(`href="/assemblies/${assemblyId}"`);
		const res = await postForm(`/parts/${id}`, partForm({ ref: "ASSY", kind: "buy" }));
		expect(res.status).toBe(422);
		expect(await res.text()).toContain("This part has assemblies: it must stay a make or kit part.");
		expect((await postForm(`/parts/${id}`, partForm({ ref: "ASSY", kind: "kit" }))).status).toBe(303);
	});

	it("filters the list by search, kind and archived flag", async () => {
		await insertPart("BOLT-1", "buy");
		await insertPart("SUB-1", "make");
		const archived = await insertPart("OLD-1", "buy");
		await request(`/parts/${archived}/archive`, { method: "POST" });
		const all = await (await request("/parts")).text();
		expect(all).toContain("BOLT-1");
		expect(all).not.toContain("OLD-1");
		expect(await (await request("/parts?archived=on")).text()).toContain("OLD-1");
		const makes = await (await request("/parts?kind=make")).text();
		expect(makes).toContain("SUB-1");
		expect(makes).not.toContain("BOLT-1");
		const search = await (await request("/parts?q=bolt")).text();
		expect(search).toContain("BOLT-1");
		expect(search).not.toContain("SUB-1");
		// LIKE wildcards are escaped.
		expect(await (await request("/parts?q=%25")).text()).not.toContain("BOLT-1");
	});

	it("shows on-hand and history, archive and delete are admin-only", async () => {
		const id = await insertPart("P1");
		await insertMove(id, 2500, "count");
		await insertMove(id, -500, "adjust");
		const html = await (await request(`/parts/${id}`)).text();
		expect(html).toContain("Inventory count");
		// The "On hand" stat shows 2.5 - 0.5 = 2 (the first quantity after its label).
		expect(html).toMatch(/data-slot="stat"/);
		expect(html.match(/On hand<\/span>[\s\S]*?<span class="num">([^<]*)<\/span>/)?.[1]).toBe("2");
		expect((await request(`/parts/${id}/archive`, { method: "POST" }, NOT_ADMIN)).status).toBe(403);
		expect((await request(`/parts/${id}/delete`, { method: "POST" }, NOT_ADMIN)).status).toBe(403);
		const del = await request(`/parts/${id}/delete`, { method: "POST" });
		expect(del.headers.get("Location")).toBe(`/parts/${id}?err=in_use`);
		const free = await insertPart("P2");
		expect((await request(`/parts/${free}/delete`, { method: "POST" })).headers.get("Location")).toBe(
			"/parts?ok=deleted",
		);
	});

	it("returns 404 for unknown ids", async () => {
		expect((await request("/parts/999")).status).toBe(404);
		expect((await request("/parts/abc")).status).toBe(404);
		expect((await request("/nope")).status).toBe(404);
	});
});

describe("i18n", () => {
	it("switches language with a cookie and only redirects locally", async () => {
		const res = await request("/lang/fr?back=/parts");
		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toBe("/parts");
		const cookie = res.headers.get("Set-Cookie")!.split(";")[0]!;
		const html = await (await request("/parts", { headers: { Cookie: cookie } })).text();
		expect(html).toContain("Articles");
		expect(html).toContain('lang="fr"');
		expect((await request("/lang/fr?back=//evil.example.com")).headers.get("Location")).toBe("/");
		expect((await request("/lang/fr?back=https://evil.example.com")).headers.get("Location")).toBe("/");
	});

	it("uses DEFAULT_LOCALE when no cookie is set", async () => {
		const html = await (await request("/", {}, { DEFAULT_LOCALE: "fr" })).text();
		expect(html).toContain("Tableau de bord");
	});
});

describe("parts search", () => {
	it("finds a part by any of its suppliers' references", async () => {
		const id = await insertPart("RES-1K", "buy");
		const other = await insertSupplier("Other Distributor");
		await postForm(`/parts/${id}/offers`, {
			supplier_id: String(other),
			supplier_ref: "R1K-0603-X",
			price: "",
			moq: "",
			pack_size: "",
			lead_days: "",
			notes: "",
		});
		expect(await (await request("/parts?q=r1k-0603")).text()).toContain(`href="/parts/${id}"`);
		expect(await (await request("/parts?q=nothing-like-it")).text()).not.toContain(`href="/parts/${id}"`);
	});
});
