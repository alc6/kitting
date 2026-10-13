import { describe, expect, it } from "vitest";
import { buildActualCost, marginOf } from "../src/domain/margins";
import { formatMoney, formatPercent } from "../src/lib/units";
import { bomId, changeSql, insertPart, loadDemo, one, partId, postForm, request, rows, stmt, testDb } from "./helpers";

const html = async (path: string, headers: Record<string, string> = {}) => {
	const res = await request(path, { headers });
	expect(res.status, path).toBe(200);
	return res.text();
};

/** The table row (<tr>…</tr>) holding this link. */
function rowWith(page: string, href: string): string {
	const at = page.indexOf(`href="${href}"`);
	expect(at, `no link to ${href}`).toBeGreaterThan(-1);
	const start = page.lastIndexOf("<tr", at);
	return page.slice(start, page.indexOf("</tr>", at));
}

const saleHistory = (bom: number) =>
	rows<{ kind: string; part_id: number; bom_id: number; price_cents: number | null; source: string }>(
		"SELECT kind, part_id, bom_id, price_cents, source FROM price_history WHERE bom_id = ? ORDER BY id",
		bom,
	);

/** Plans and completes one LAMP-DESK std build (serial-tracked product and components). */
async function completeLampBuild(): Promise<number> {
	const res = await postForm("/builds", {
		part_id: String(await partId("LAMP-DESK")),
		bom_id: String(await bomId("LAMP-DESK")),
		qty: "1",
		serial: "L-1",
		planned_for: "",
		notes: "",
	});
	const id = Number(/\/builds\/(\d+)/.exec(res.headers.get("Location") ?? "")?.[1]);
	const pick = await html(`/builds/${id}`);
	const fields: Record<string, string> = {};
	for (const m of pick.matchAll(/name="(serial:\d+:\d+)"/g)) fields[m[1] as string] = `S-${m[1]}`;
	expect((await postForm(`/builds/${id}/complete`, fields)).status).toBe(303);
	return id;
}

describe("margins page", () => {
	it("lists each sellable variant with its planned margin, rate and markup", async () => {
		await loadDemo({ stock: false });
		const std = await bomId("LAMP-DESK");
		const warm = await bomId("LAMP-DESK", "warm");
		const page = await html("/margins");
		expect(page).not.toMatch(/\sstyle=/);
		const stdRow = rowWith(page, `/boms/${std}`);
		expect(stdRow).toContain(`href="/parts/${await partId("LAMP-DESK")}"`);
		for (const value of ["€89.00", "€37.83", "€51.17", "57.5\u00a0%", "135.3\u00a0%"]) expect(stdRow).toContain(value);
		expect(stdRow).toContain('title="Incomplete cost: some components have no known cost."'); // MANUAL
		expect(stdRow).not.toContain("own price");
		const warmRow = rowWith(page, `/boms/${warm}`);
		expect(warmRow).toContain("€94.00");
		expect(warmRow).toContain("own price");
		// Parts without a selling price are not listed; the legend explains both percentages.
		expect(page).not.toContain(">ARM-ASSY</a>");
		expect(page).toContain("Rate = margin ÷ selling price. Markup = margin ÷ cost.");
		expect(page).toContain("Planned rate below the 30.0\u00a0% threshold.");
		expect(page).toMatch(/Sellable items<\/span>[\s\S]*?>2<\/div>/);
		expect(page).toMatch(/Incomplete cost<\/span>[\s\S]*?>2<\/div>/);
		expect(page).toMatch(/Low margin<\/span>[\s\S]*?>0<\/div>/);
	});

	it("speaks French: taux de marque and taux de marge", async () => {
		await loadDemo({ stock: false });
		const page = await html("/margins", { Cookie: "kitting_lang=fr" });
		expect(page).toContain("Taux de marque = marge ÷ prix de vente. Taux de marge = marge ÷ coût.");
		expect(page).toContain("57,5\u00a0%");
		expect(page).toContain("89,00 €");
	});

	it("filters by completed builds and exports the table as CSV", async () => {
		await loadDemo({ stock: false });
		const std = await bomId("LAMP-DESK");
		const warm = await bomId("LAMP-DESK", "warm");
		const planned = await html("/margins?show=planned");
		expect(planned).toContain(`href="/boms/${std}"`);
		expect(planned).toContain(`href="/boms/${warm}"`);
		expect(planned).toMatch(/href="\/margins\?show=planned"[^>]*data-state="on"/);
		expect(planned).toContain('href="/margins?show=planned&amp;format=csv"');
		const built = await html("/margins?show=built");
		expect(built).not.toContain(`href="/boms/${std}"`);
		expect(built).toContain("Nothing here yet.");

		const res = await request("/margins?format=csv");
		expect(res.headers.get("Content-Type")).toContain("text/csv");
		const csv = await res.text();
		expect(csv.split("\n")[0]?.trim()).toBe(
			"part_ref,part_name,variant,revision,own_price,sale_price,planned_cost,planned_incomplete,planned_margin,planned_rate_pct,planned_markup_pct,done_builds,actual_cost,actual_incomplete,actual_margin,actual_rate_pct",
		);
		expect(csv).toContain("LAMP-DESK,Modular desk lamp,std,Rev2,,89.00,37.83,yes,51.17,57.5,135.3,0,,,,");
		expect(csv).toContain("LAMP-DESK,Modular desk lamp,warm,Rev1,yes,94.00,");
		expect(await (await request("/margins?show=built&format=csv")).text()).not.toContain("LAMP-DESK");
	});

	it("points to the parts list when nothing has a selling price", async () => {
		const page = await html("/margins");
		expect(page).toContain("No selling price yet");
		expect(page).toMatch(/<a href="\/parts"[^>]*>(?:<svg[\s\S]*?<\/svg>)?Go to parts<\/a>/);
	});
});

describe("variant selling price on the BoM page", () => {
	it("shows the effective price and planned margin, saves an own price and logs it", async () => {
		await loadDemo({ stock: false });
		const lamp = await partId("LAMP-DESK");
		const std = await bomId("LAMP-DESK");
		const editor = await html(`/boms/${std}`);
		expect(editor).not.toMatch(/\sstyle=/);
		expect(editor).toContain(`action="/boms/${std}/sale-price"`);
		expect(editor).toContain("(€89.00)"); // the part's price, as the hint of the empty field
		expect(editor).toMatch(/€51\.17<\/span> · 57\.5\u00a0%/); // planned margin in the header
		// The other tabs carry the same summary.
		expect(await html(`/boms/${std}/tree`)).toMatch(/€51\.17<\/span> · 57\.5\u00a0%/);

		const res = await postForm(`/boms/${std}/sale-price`, { sale_price: "99,50" });
		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toBe(`/boms/${std}?ok=saved`);
		expect(await one("SELECT sale_price_cents FROM boms WHERE id = ?", std)).toEqual({ sale_price_cents: 9950 });
		expect(await saleHistory(std)).toEqual([
			{ kind: "sale", part_id: lamp, bom_id: std, price_cents: 9950, source: "form" },
		]);
		const saved = await html(`/boms/${std}?ok=saved`);
		expect(saved).toContain('value="99.50"');
		expect(saved).toMatch(/€61\.67<\/span> · 62\.0\u00a0%/); // 99.50 − 37.83
		expect(rowWith(await html("/margins"), `/boms/${std}`)).toContain("own price");

		// Saving the same price again logs nothing.
		await postForm(`/boms/${std}/sale-price`, { sale_price: "99.50" });
		expect(await saleHistory(std)).toHaveLength(1);

		// An invalid amount is refused and changes nothing.
		const bad = await postForm(`/boms/${std}/sale-price`, { sale_price: "abc" });
		expect(bad.status).toBe(422);
		expect(await bad.text()).toContain("Not a valid amount (up to 2 decimals).");
		expect(await one("SELECT sale_price_cents FROM boms WHERE id = ?", std)).toEqual({ sale_price_cents: 9950 });
	});

	it("falls back to the part's price when cleared", async () => {
		await loadDemo({ stock: false });
		const warm = await bomId("LAMP-DESK", "warm");
		const before = (await saleHistory(warm)).length;
		expect((await postForm(`/boms/${warm}/sale-price`, { sale_price: "" })).status).toBe(303);
		expect(await one("SELECT sale_price_cents FROM boms WHERE id = ?", warm)).toEqual({ sale_price_cents: null });
		const history = await saleHistory(warm);
		expect(history).toHaveLength(before + 1);
		expect(history.at(-1)).toMatchObject({ kind: "sale", bom_id: warm, price_cents: null });
		const editor = await html(`/boms/${warm}`);
		expect(editor).toContain('name="sale_price" type="text" value=""');
		const row = rowWith(await html("/margins"), `/boms/${warm}`);
		expect(row).toContain("€89.00");
		expect(row).not.toContain("own price");
	});

	it("refuses to change the price of an archived BoM", async () => {
		await loadDemo({ stock: false });
		const rev1 = await bomId("LAMP-DESK", "std", "Rev1");
		const res = await postForm(`/boms/${rev1}/sale-price`, { sale_price: "10" });
		expect(res.headers.get("Location")).toBe(`/boms/${rev1}?err=bom_archived`);
		expect(await one("SELECT sale_price_cents FROM boms WHERE id = ?", rev1)).toEqual({ sale_price_cents: null });
		expect(await saleHistory(rev1)).toEqual([]);
		const page = await html(`/boms/${rev1}?err=bom_archived`);
		expect(page).toContain("Archived BoMs are read-only.");
		expect(page).not.toContain(`action="/boms/${rev1}/sale-price"`);
	});
});

describe("actual cost and margin of a completed build", () => {
	it("shows both costs, clearly labelled, and the margin at the variant's price", async () => {
		await loadDemo();
		const id = await completeLampBuild();
		const actual = await buildActualCost(testDb(), id);
		expect(actual?.unitCents).toBeGreaterThan(0);
		const margin = marginOf(8900, actual?.unitCents ?? null);
		const page = await html(`/builds/${id}`);
		expect(page).not.toMatch(/\sstyle=/);
		expect(page).toContain("Recorded cost (standard)");
		expect(page).toContain("€37.83"); // frozen at completion, at standard cost
		expect(page).toContain("Actual unit cost (average)");
		expect(page).toContain(formatMoney(actual?.unitCents ?? 0));
		expect(page).toContain("Margin per unit");
		expect(page).toContain(formatMoney(margin?.marginCents ?? 0));
		expect(page).toContain(`Rate ${formatPercent(margin?.rateBp ?? 0)} on a selling price of €89.00.`);
		// The hint follows the costing replay (whether MANUAL, counted without a cost, flags the build).
		expect(page).toContain(
			actual?.incomplete
				? "Some consumed parts had no known cost: understated."
				: "Per unit, at the weighted average cost of what was consumed.",
		);

		// The margins page now counts the build for the std variant only.
		const std = await bomId("LAMP-DESK");
		const warm = await bomId("LAMP-DESK", "warm");
		const built = await html("/margins?show=built");
		expect(built).toContain(`href="/boms/${std}"`);
		expect(built).not.toContain(`href="/boms/${warm}"`);
		expect(rowWith(built, `/boms/${std}`)).toContain(formatMoney(actual?.unitCents ?? 0));
		const planned = await html("/margins?show=planned");
		expect(planned).toContain(`href="/boms/${warm}"`);
		expect(planned).not.toContain(`href="/boms/${std}"`);
	});

	it("shows no margin card when the product has no selling price", async () => {
		await loadDemo();
		const res = await postForm("/builds", {
			part_id: String(await partId("ARM-ASSY")),
			bom_id: String(await bomId("ARM-ASSY")),
			qty: "2",
			serial: "",
			planned_for: "",
			notes: "",
		});
		const id = Number(/\/builds\/(\d+)/.exec(res.headers.get("Location") ?? "")?.[1]);
		expect((await postForm(`/builds/${id}/complete`, {})).status).toBe(303);
		const page = await html(`/builds/${id}`);
		expect(page).toContain("Actual unit cost (average)");
		expect(page).not.toContain("Margin per unit");
	});

	it("flags an actual cost built from parts of unknown cost", async () => {
		const top = await insertPart("TOP", "make");
		await insertPart("CELL", "buy"); // no cost and no stock: consumed at an unknown cost
		await changeSql("Price TOP", stmt("UPDATE parts SET sale_price_cents = 1500 WHERE id = ?", top));
		await postForm("/boms", { parent_part_id: String(top), code: "std", revision: "Rev1", notes: "", copy_from: "" });
		const bom = (await one<{ id: number }>("SELECT id FROM boms WHERE parent_part_id = ?", top)).id;
		await postForm(`/boms/${bom}/lines`, { component: "CELL", qty: "1", notes: "" });
		await postForm(`/boms/${bom}/activate`, {});
		const res = await postForm("/builds", {
			part_id: String(top),
			bom_id: String(bom),
			qty: "1",
			serial: "",
			planned_for: "",
			notes: "",
		});
		const id = Number(/\/builds\/(\d+)/.exec(res.headers.get("Location") ?? "")?.[1]);
		expect((await postForm(`/builds/${id}/complete`, {})).status).toBe(303);
		expect(await buildActualCost(testDb(), id)).toEqual({ unitCents: 0, incomplete: true });
		const page = await html(`/builds/${id}`);
		const card = (label: string) =>
			new RegExp(`border-warning/40" data-slot="stat"><div[^>]*><span[^>]*>${label.replace(/[()]/g, "\\$&")}</span>`);
		expect(page).toMatch(card("Actual unit cost (average)"));
		expect(page).toContain("Some consumed parts had no known cost: understated.");
		// 15.00 − 0.00: a 100 % rate, still in warning because the cost is understated.
		expect(page).toMatch(card("Margin per unit"));
		expect(page).toContain("Rate 100.0\u00a0% on a selling price of €15.00.");
	});
});
