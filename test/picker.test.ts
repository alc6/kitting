import { describe, expect, it } from "vitest";
import {
	assemblyId,
	insertMove,
	insertPart,
	insertSupplier,
	loadDemo,
	NOT_ADMIN,
	one,
	partId,
	postForm,
	request,
	seedSql,
	setRole,
	stmt,
} from "./helpers";

const pick = async (query = "", overrides = {}) => {
	const res = await request(`/parts/pick${query}`, {}, overrides);
	return { res, html: await res.text() };
};

/** The references offered, in order. */
const refs = (html: string) => [...html.matchAll(/data-pick="([^"]*)"/g)].map((m) => m[1]);

const rename = (ref: string, name: string) => seedSql(stmt("UPDATE parts SET name = ? WHERE ref = ?", name, ref));

/** `count` buy parts P01, P02… (or `prefix`-01…). */
const manyParts = (count: number, prefix = "P") =>
	seedSql(
		...Array.from({ length: count }, (_, i) =>
			stmt(
				"INSERT INTO parts (ref, name, kind, created_by, updated_by) VALUES (?, ?, 'buy', 'seed', 'seed')",
				`${prefix}${String(i + 1).padStart(2, "0")}`,
				`Part ${i + 1}`,
			),
		),
	);

describe("part picker results", () => {
	it("matches the reference and the name, ignoring case", async () => {
		await insertPart("BOLT-M4");
		await insertPart("NUT-M4");
		await rename("NUT-M4", "Hex nut for bolts");
		await insertPart("WASHER");
		expect(refs((await pick("?q=bolt")).html)).toEqual(["BOLT-M4", "NUT-M4"]);
		expect(refs((await pick("?q=WASH")).html)).toEqual(["WASHER"]);
		expect(refs((await pick("?q=HEX%20NUT")).html)).toEqual(["NUT-M4"]);
		expect(refs((await pick("")).html)).toEqual(["BOLT-M4", "NUT-M4", "WASHER"]);
		expect((await pick("?q=zzz")).html).toContain("No part matches.");
	});

	it("puts the exact reference first, then the prefix, then the rest by reference", async () => {
		await insertPart("ABOLT");
		await insertPart("BOLT-M4");
		await insertPart("BOLT");
		await insertPart("COVER");
		await rename("COVER", "Cover for the bolt");
		expect(refs((await pick("?q=bolt")).html)).toEqual(["BOLT", "BOLT-M4", "ABOLT", "COVER"]);
	});

	it("treats % and _ literally", async () => {
		await insertPart("A_B");
		await insertPart("AXB");
		await insertPart("RATE-5%");
		expect(refs((await pick("?q=A_B")).html)).toEqual(["A_B"]);
		expect(refs((await pick("?q=%25")).html)).toEqual(["RATE-5%"]);
		expect(refs((await pick("?q=_")).html)).toEqual(["A_B"]);
	});

	it("filters by the kinds the form accepts and by the kind chosen in the dialog", async () => {
		await insertPart("B1", "buy");
		await insertPart("M1", "make");
		await insertPart("K1", "kit");
		await insertPart("F1", "fee");
		expect(refs((await pick("")).html)).toEqual(["B1", "F1", "K1", "M1"]);
		expect(refs((await pick("?kinds=buy,make")).html)).toEqual(["B1", "M1"]);
		expect(refs((await pick("?kinds=make,kit")).html)).toEqual(["K1", "M1"]);
		expect(refs((await pick("?kinds=make,kit&kind=kit")).html)).toEqual(["K1"]);
		// A kind outside the form's set cannot widen it.
		expect(refs((await pick("?kinds=make,kit&kind=fee")).html)).toEqual(["K1", "M1"]);
		expect(refs((await pick("?kind=fee")).html)).toEqual(["F1"]);
	});

	it("leaves out the excluded part and archived parts", async () => {
		const own = await insertPart("OWN", "make");
		await insertPart("OTHER", "make");
		await insertPart("OLD", "make");
		await seedSql(stmt("UPDATE parts SET archived = 1 WHERE ref = 'OLD'"));
		expect(refs((await pick("")).html)).toEqual(["OTHER", "OWN"]);
		expect(refs((await pick(`?exclude=${own}`)).html)).toEqual(["OTHER"]);
	});

	it("pages by 20 and clamps a page past the end", async () => {
		await manyParts(45);
		const first = await pick("");
		expect(refs(first.html)).toHaveLength(20);
		expect(refs(first.html)[0]).toBe("P01");
		expect(first.html).toContain("1–20 of 45");
		expect(first.html).toContain('hx-get="/parts/pick?page=2"');
		expect(first.html).not.toContain('hx-get="/parts/pick"');

		const second = await pick("?page=2");
		expect(refs(second.html)[0]).toBe("P21");
		expect(second.html).toContain("21–40 of 45");
		expect(second.html).toContain('hx-get="/parts/pick"');
		expect(second.html).toContain('hx-get="/parts/pick?page=3"');

		for (const page of ["3", "99"]) {
			const last = await pick(`?page=${page}`);
			expect(refs(last.html)).toEqual(["P41", "P42", "P43", "P44", "P45"]);
			expect(last.html).toContain("41–45 of 45");
			expect(last.html).not.toContain('hx-get="/parts/pick?page=4"');
		}
	});

	it("keeps the search and the form's restriction in the pager links", async () => {
		await manyParts(25, "SCREW-");
		const { html } = await pick("?q=screw&kinds=buy,make&kind=buy&exclude=999");
		expect(html).toContain('hx-get="/parts/pick?q=screw&amp;kinds=buy%2Cmake&amp;kind=buy&amp;exclude=999&amp;page=2"');
	});

	it("refuses invalid parameters with a 422 and no results", async () => {
		await insertPart("BOLT");
		const bad = ["?page=0", "?page=abc", "?page=-1", "?kinds=bogus", "?kinds=buy,bogus", "?kind=bogus", "?exclude=x"];
		for (const query of bad) {
			const { res, html } = await pick(query);
			expect(res.status, query).toBe(422);
			expect(html, query).toContain("This search is not valid.");
			expect(html, query).not.toContain("data-pick=");
		}
		expect((await pick(`?q=${"x".repeat(101)}`)).res.status).toBe(422);
	});

	it("is open to a viewer and shows on hand, supplier and kind but no cost", async () => {
		const supplier = await insertSupplier("Acme Fixings");
		const bolt = await insertPart("BOLT", "buy", { supplierId: supplier, costCents: 123456 });
		await insertMove(bolt, 2500);
		await insertPart("ASSY", "kit", { costCents: 654321 });
		await setRole("viewer");
		const { res, html } = await pick("", NOT_ADMIN);
		expect(res.status).toBe(200);
		expect(html).toContain('data-pick="BOLT"');
		expect(html).toContain(`data-pick-id="${bolt}"`);
		expect(html).toContain("Acme Fixings");
		expect(html).toContain("2.5");
		expect(html).toContain("Buy");
		expect(html).toContain("Kit");
		for (const amount of ["1,234.56", "1234.56", "123456", "6,543.21", "6543.21", "654321"]) {
			expect(html).not.toContain(amount);
		}
		// Kits are not stocked: no quantity for them.
		const start = html.indexOf('data-pick="ASSY"');
		expect(html.slice(start, html.indexOf("</button>", start))).not.toContain("On hand");
	});

	it("shows a thumbnail only when the images bucket is there and the part has a picture", async () => {
		const id = await insertPart("LAMP", "make");
		await insertPart("PLAIN", "make");
		await seedSql(stmt("UPDATE parts SET image_key = ? WHERE id = ?", `parts/${id}/0123456789abcdef.png`, id));
		const withBucket = (await pick("")).html;
		expect(withBucket).toContain(`<img src="/parts/${id}/image?v=0123456789abcdef" alt="Part LAMP" loading="lazy"`);
		expect(withBucket.match(/<img /g)?.length ?? 0).toBe(1);
		// Without the IMAGES binding the part keeps its icon tile.
		const without = (await pick("", { IMAGES: undefined })).html;
		expect(without).not.toContain("<img");
		expect(without).toContain('data-pick="LAMP"');
	});
});

describe("forms with the part picker", () => {
	/** The markup of the form posting to `action`, up to its closing tag. */
	const formOf = (html: string, action: string) => {
		const start = html.indexOf(`action="${action}"`);
		expect(start, action).toBeGreaterThan(-1);
		return html.slice(start, html.indexOf("</form>", start));
	};
	const dialogOf = (html: string, id: string) => {
		const start = html.indexOf(`<dialog id="${id}"`);
		expect(start, id).toBeGreaterThan(-1);
		return html.slice(start, html.indexOf("</dialog>", start));
	};

	it("adds an assembly line: datalist baseline, Browse button, dialog outside the form, own product excluded", async () => {
		await loadDemo();
		const id = await assemblyId("LAMP-DESK");
		const lamp = await partId("LAMP-DESK");
		const html = await (await request(`/assemblies/${id}`)).text();
		const form = formOf(html, `/assemblies/${id}/lines`);
		expect(form).toContain('name="component"');
		expect(form).toContain('list="part-refs"');
		expect(form).toContain('<datalist id="part-refs">');
		expect(form).toContain('data-picker-open="picker-component"');
		expect(form).toMatch(/<button[^>]*\shidden(="")?[\s>]/);
		expect(form).not.toContain("<dialog");
		const dialog = dialogOf(html, "picker-component");
		expect(dialog).toContain('data-target="f-component"');
		expect(dialog).toContain(`name="exclude" value="${lamp}"`);
		expect(dialog).not.toContain('name="kinds"');
		expect(dialog).toContain('name="kind" value="fee"');
		// A typed reference still posts.
		const post = await postForm(`/assemblies/${id}/lines`, { component: "BOX-LAMP", qty: "1", notes: "" });
		expect(post.status).toBe(303);
	});

	it("creates an assembly: the product select stays, with a picker for make and kit parts", async () => {
		await insertPart("TOP", "make");
		const html = await (await request("/assemblies/new")).text();
		expect(html).toContain('<select id="f-parent_part_id"');
		expect(html).toContain('data-picker-open="picker-parent_part_id"');
		const dialog = dialogOf(html, "picker-parent_part_id");
		expect(dialog).toContain('data-target="f-parent_part_id"');
		expect(dialog).toContain('name="kinds" value="make,kit"');
		expect(dialog).not.toContain('name="kind" value="buy"');
		expect(dialog).toContain('name="kind" value="kit"');
	});

	it("adds a PO line: datalist baseline, Browse button, dialog for stocked parts outside the form", async () => {
		const supplier = await insertSupplier("Acme");
		await insertPart("BOLT", "buy", { supplierId: supplier });
		const created = await postForm("/purchasing/po", { supplier_id: String(supplier), expected_at: "", notes: "" });
		expect(created.status).toBe(303);
		const poId = (await one<{ id: number }>("SELECT max(id) AS id FROM purchase_orders")).id;
		const html = await (await request(`/purchasing/po/${poId}`)).text();
		const form = formOf(html, `/purchasing/po/${poId}/lines`);
		expect(form).toContain('list="po-parts"');
		expect(form).toContain('<datalist id="po-parts">');
		expect(form).toContain('data-picker-open="picker-part"');
		expect(form).not.toContain("<dialog");
		expect(dialogOf(html, "picker-part")).toContain('name="kinds" value="buy,make"');
		// A typed reference still posts.
		expect((await postForm(`/purchasing/po/${poId}/lines`, { part: "BOLT", qty: "2", price: "" })).status).toBe(303);
	});

	it("adjusts stock: datalist baseline, Browse button, dialog for stocked parts outside the form", async () => {
		await insertPart("BOLT", "buy");
		const html = await (await request("/stock/adjust")).text();
		const form = formOf(html, "/stock/adjust");
		expect(form).toContain('list="stock-parts"');
		expect(form).toContain('<datalist id="stock-parts">');
		expect(form).toContain('data-picker-open="picker-part"');
		expect(form).not.toContain("<dialog");
		expect(dialogOf(html, "picker-part")).toContain('name="kinds" value="buy,make"');
	});
});
