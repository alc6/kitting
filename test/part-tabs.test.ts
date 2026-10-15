// The part page in tabs (D181-D182): header thumbnail, Overview, Suppliers & prices, Stock and History, each its own URL.
import { describe, expect, it } from "vitest";
import type { PartKind } from "../src/db/schema";
import {
	insertMove,
	insertPart,
	insertSupplier,
	letLowerRolesSeeCosts,
	NOT_ADMIN,
	postForm,
	request,
	setRole,
} from "./helpers";

const PNG = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2, 3,
]);

async function as(role: "viewer" | "operator" | "planner" | "admin") {
	await setRole(role);
	return NOT_ADMIN;
}

async function html(path: string, env = {}) {
	const res = await request(path, {}, env);
	expect(res.status, path).toBe(200);
	return res.text();
}

/** The tab bar of a page: the href and label of each tab, and the active one. */
function tabsOf(page: string) {
	const nav = /<nav[^>]*data-slot="tabs-list"[^>]*>([\s\S]*?)<\/nav>/.exec(page)?.[1] ?? "";
	const items = [...nav.matchAll(/<a href="([^"]+)"[^>]*data-state="(active|inactive)"[^>]*>([\s\S]*?)<\/a>/g)].map(
		(m) => ({
			href: m[1] ?? "",
			active: m[2] === "active",
			label: (m[3] ?? "").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&"),
		}),
	);
	return { items, active: items.find((i) => i.active)?.label };
}

const labels = (page: string) => tabsOf(page).items.map((i) => i.label);

async function upload(id: number) {
	const form = new FormData();
	form.set("image", new File([PNG], "photo.png", { type: "image/png" }));
	return request(`/parts/${id}/image`, { method: "POST", body: form });
}

describe("tabs of the part page (D182)", () => {
	it("offers Overview, Suppliers & prices, Stock and History for a bought part, each its own URL", async () => {
		const id = await insertPart("BOLT", "buy", { costCents: 100 });
		const page = await html(`/parts/${id}`);
		expect(labels(page)).toEqual(["Overview", "Suppliers & prices", "Stock", "History"]);
		expect(tabsOf(page).items.map((i) => i.href)).toEqual([
			`/parts/${id}`,
			`/parts/${id}/prices`,
			`/parts/${id}/stock`,
			`/parts/${id}/history`,
		]);
		expect(tabsOf(page).active).toBe("Overview");
		expect(tabsOf(await html(`/parts/${id}/prices`)).active).toBe("Suppliers & prices");
		expect(tabsOf(await html(`/parts/${id}/stock`)).active).toBe("Stock");
		const history = await html(`/parts/${id}/history`);
		expect(tabsOf(history).active).toBe("History");
		expect(labels(history)).toEqual(["Overview", "Suppliers & prices", "Stock", "History"]);
	});

	it("hides the tabs a kit or a fee can never fill, and a roles without costs loses Prices too", async () => {
		const kit = await insertPart("KIT", "kit");
		const fee = await insertPart("SHIP", "fee", { costCents: 100 });
		const make = await insertPart("LAMP", "make");
		// A kit and a fee are not stocked and never purchased: only prices (who sees costs).
		expect(labels(await html(`/parts/${kit}`))).toEqual(["Overview", "Prices", "History"]);
		expect(labels(await html(`/parts/${fee}`))).toEqual(["Overview", "Prices", "History"]);
		expect(labels(await html(`/parts/${make}`))).toEqual(["Overview", "Suppliers & prices", "Stock", "History"]);
		const viewer = await as("viewer");
		expect(labels(await html(`/parts/${kit}`, viewer))).toEqual(["Overview", "History"]);
		expect(labels(await html(`/parts/${fee}`, viewer))).toEqual(["Overview", "History"]);
		// Offers show without costs (who supplies it, MOQ, lead time): a bought part keeps its tab.
		expect(labels(await html(`/parts/${make}`, viewer))).toEqual([
			"Overview",
			"Suppliers & prices",
			"Stock",
			"History",
		]);
	});

	it("sends a tab the part cannot have back to the overview", async () => {
		const kit = await insertPart("KIT", "kit");
		const stock = await request(`/parts/${kit}/stock`);
		expect(stock.status).toBe(303);
		expect(stock.headers.get("Location")).toBe(`/parts/${kit}`);
		// A kit has prices for who sees costs, and none for who does not.
		expect((await request(`/parts/${kit}/prices`)).status).toBe(200);
		const viewer = await as("viewer");
		const prices = await request(`/parts/${kit}/prices`, {}, viewer);
		expect(prices.status).toBe(303);
		expect(prices.headers.get("Location")).toBe(`/parts/${kit}`);
		expect((await request("/parts/9999/prices")).status).toBe(404);
		expect((await request("/parts/9999/stock")).status).toBe(404);
	});

	it("keeps each section on its tab", async () => {
		const supplier = await insertSupplier("Acme");
		const id = await insertPart("LAMP", "make", { costCents: 500, supplierId: supplier });
		await insertMove(id, 3000, "count");
		const overview = await html(`/parts/${id}`);
		const prices = await html(`/parts/${id}/prices`);
		const stock = await html(`/parts/${id}/stock`);
		// Overview: figures, how it's made, details and prices, files, where used.
		expect(overview).toContain('id="how-its-made"');
		expect(overview).toContain("Where used");
		expect(overview).toContain("Details");
		expect(overview).toContain(">Prices<");
		for (const moved of ['id="suppliers"', 'id="price-history"', "Stock moves", "Recent builds"])
			expect(overview).not.toContain(moved);
		// Suppliers & prices: the offers and the price history with its past price form.
		expect(prices).toContain('id="suppliers"');
		expect(prices).toContain('id="price-history"');
		expect(prices).toContain("Add a past price");
		expect(prices).not.toContain("Where used");
		expect(prices).not.toContain("Stock moves");
		// Stock: the moves and the recent builds of a made part.
		expect(stock).toContain("Stock moves");
		expect(stock).toContain("Recent builds");
		expect(stock).toContain(`href="/builds/new?part=${id}"`);
		expect(stock).not.toContain('id="suppliers"');
		expect(stock).not.toContain("Where used");
		// Not a made part: no builds card.
		const bolt = await insertPart("BOLT", "buy");
		expect(await html(`/parts/${bolt}/stock`)).not.toContain("Recent builds");
	});

	it("shows a note about an outcome on the tab it lands on", async () => {
		const id = await insertPart("BOLT", "buy", { costCents: 100 });
		await postForm("/stock/adjust", { part: "BOLT", qty: "3", serial: "", note: "found" });
		expect(await html(`/parts/${id}/stock?ok=adjusted`)).toContain("Stock adjusted.");
		const added = await postForm(`/parts/${id}/prices/past`, {
			date: "2020-01-01",
			price: "1.00",
			supplier_id: "",
			note: "",
		});
		expect(added.headers.get("Location")).toBe(`/parts/${id}/prices?ok=pastprice#price-history`);
		expect(await html(`/parts/${id}/prices?ok=pastprice`)).toContain("Past price added.");
	});

	it("sends the old offers URL to the Suppliers & prices tab", async () => {
		const id = await insertPart("BOLT", "buy");
		const res = await request(`/parts/${id}/offers`);
		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toBe(`/parts/${id}/prices`);
	});

	it("lets the offers show without costs, and keeps the price history for who sees them", async () => {
		const supplier = await insertSupplier("Acme");
		const id = await insertPart("BOLT", "buy", { costCents: 500, supplierId: supplier });
		const operator = await as("operator");
		const page = await html(`/parts/${id}/prices`, operator);
		expect(page).toContain('id="suppliers"');
		expect(page).toContain("Acme");
		expect(page).not.toContain('id="price-history"');
		expect(page).not.toContain("€5.00");
		await letLowerRolesSeeCosts();
		expect(await html(`/parts/${id}/prices`, operator)).toContain('id="price-history"');
	});
});

describe("figure cards (D181)", () => {
	const count = (page: string) => (page.match(/data-slot="stat"/g) ?? []).length;

	it("shares the row between however many cards there are", async () => {
		const bolt = await insertPart("BOLT", "buy", { costCents: 100 });
		const fee = await insertPart("SHIP", "fee", { costCents: 100 });
		const boltPage = await html(`/parts/${bolt}`);
		expect(count(boltPage)).toBe(2);
		expect(count(await html(`/parts/${fee}`))).toBe(1);
		// Each card grows to fill the row: no fixed three-column grid with an empty slot.
		expect(boltPage).toMatch(/class="[^"]*\*:flex-1[^"]*" data-slot="figures"/);
		expect(boltPage).not.toContain("lg:grid-cols-3");
		// A fee without costs shown has nothing to put there: no empty row.
		expect(await html(`/parts/${fee}`, await as("viewer"))).not.toContain('data-slot="figures"');
	});
});

describe("product image in the header (D181)", () => {
	const header = (page: string) => page.slice(0, page.indexOf("</h1>"));

	it("shows a dashed button that opens the upload dialog when there is no image yet", async () => {
		const id = await insertPart("BOLT", "buy");
		const page = await html(`/parts/${id}`);
		// Beside the title, 64 px, and no Image card any more.
		expect(header(page)).toMatch(/<button[^>]*popovertarget="image-upload"[^>]*border-dashed/);
		expect(header(page)).toContain("size-16");
		expect(page).toContain('id="image-upload"');
		expect(page).toContain('enctype="multipart/form-data"');
		expect(page).not.toContain("No image yet");
		expect(page).not.toMatch(/<h2[^>]*>Image</);
		// The same button and dialog on the other tabs, so an image can be added from anywhere.
		expect(await html(`/parts/${id}/stock`)).toContain('popovertarget="image-upload"');
	});

	it("shows the image as a link to the full-size one, and keeps replacing and removing in the menu", async () => {
		const id = await insertPart("BOLT", "buy");
		expect((await upload(id)).status).toBe(303);
		const page = await html(`/parts/${id}`);
		expect(header(page)).toMatch(/<a id="image" href="\/parts\/\d+\/image\?v=[0-9a-f]+"[^>]*>\s*<img src=/);
		expect(page).not.toContain("border-dashed");
		const menu = page.slice(page.indexOf('data-slot="dropdown-menu-content"'));
		expect(menu).toMatch(/<button type="button" popovertarget="image-upload"[^>]*>[\s\S]*Replace the image/);
		expect(menu).toContain(`action="/parts/${id}/image/delete"`);
		expect(menu.indexOf("Replace the image")).toBeLessThan(menu.indexOf("/image/delete"));
		// A planner may replace the image but not remove it; an operator does neither but still sees it.
		const planner = await html(`/parts/${id}`, await as("planner"));
		expect(planner).toContain("Replace the image");
		expect(planner).not.toContain("/image/delete");
		const operator = await html(`/parts/${id}`, await as("operator"));
		expect(operator).toContain("<img src=");
		expect(operator).not.toContain("image-upload");
		expect(operator).not.toContain('aria-label="More actions"');
	});

	it("shows no placeholder to who cannot upload", async () => {
		const id = await insertPart("BOLT", "buy");
		const operator = await html(`/parts/${id}`, await as("operator"));
		expect(operator).not.toContain("image-upload");
		expect(operator).not.toContain("border-dashed");
		expect(operator).not.toContain("<img ");
	});
});

describe("details and prices (D181)", () => {
	it("sit in one row of two equal columns from lg, and the details take the width without costs", async () => {
		const id = await insertPart("BOLT", "buy", { costCents: 100 });
		expect(await html(`/parts/${id}`)).toContain('class="grid gap-4 lg:grid-cols-2"');
		const viewer = await html(`/parts/${id}`, await as("viewer"));
		expect(viewer).not.toContain("lg:grid-cols-2");
	});
});

describe("kinds", () => {
	it.each<[PartKind, string[]]>([
		["buy", ["Suppliers & prices", "Stock"]],
		["make", ["Suppliers & prices", "Stock"]],
		["kit", ["Prices"]],
		["fee", ["Prices"]],
	])("%s has the tabs %j besides Overview and History", async (kind, extra) => {
		const id = await insertPart("P1", kind);
		expect(labels(await html(`/parts/${id}`))).toEqual(["Overview", ...extra, "History"]);
	});
});
