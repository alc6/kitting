// Part options (D168–D177): options on a part, stock per value, builds whose values flow down the explosion,
// purchasing per value, costs per part, undo.
import { describe, expect, it } from "vitest";
import { loadGraph } from "../src/domain/assemblies";
import { CostCalculator } from "../src/domain/assembly-graph";
import { planImport } from "../src/domain/import";
import type { Access } from "../src/domain/permissions";
import { computeShortages } from "../src/domain/purchasing";
import { revertChangeSet } from "../src/domain/revert";
import { valuation } from "../src/domain/stock";
import {
	importCsv,
	insertPart,
	insertSupplier,
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

const ADMIN: Access = { role: "admin", seeCosts: true };

async function ok(res: Response) {
	expect(res.status, await res.clone().text()).toBe(303);
	return res;
}

async function addOption(partId: number, name: string, values: string[]) {
	return ok(await postForm(`/parts/${partId}/options`, { name, values: values.join("\n") }));
}

const optionId = async (ref: string, name = "Colour") =>
	(
		await one<{ id: number }>(
			"SELECT o.id FROM part_options o JOIN parts p ON p.id = o.part_id WHERE p.ref = ? AND o.name = ?",
			ref,
			name,
		)
	).id;

const valueId = async (ref: string, value: string) =>
	(
		await one<{ id: number }>(
			`SELECT v.id FROM part_option_values v JOIN part_options o ON o.id = v.option_id JOIN parts p ON p.id = o.part_id
			 WHERE p.ref = ? AND v.name = ?`,
			ref,
			value,
		)
	).id;

/** On-hand of a part in one value (its id as the key: one option), or in total. */
async function stockOf(ref: string, value?: string): Promise<number> {
	const key = value === undefined ? undefined : String(await valueId(ref, value));
	const r = await one<{ q: number | null }>(
		`SELECT SUM(m.qty_milli) AS q FROM stock_moves m JOIN parts p ON p.id = m.part_id
		 WHERE p.ref = ? AND (? IS NULL OR m.option_values = ?)`,
		ref,
		key ?? null,
		key ?? null,
	);
	return r.q ?? 0;
}

async function insertAssembly(parentId: number, lines: [number, number][]) {
	const [a] = await seedSql(
		stmt(
			"INSERT INTO assemblies (parent_part_id, status, created_by, updated_by) VALUES (?, 'active', 'seed', 'seed') RETURNING id",
			parentId,
		),
	);
	const id = returnedId(a);
	await seedSql(
		...lines.map(([component, qty], i) =>
			stmt(
				"INSERT INTO assembly_lines (assembly_id, component_part_id, qty_milli, position, created_by, updated_by) VALUES (?, ?, ?, ?, 'seed', 'seed')",
				id,
				component,
				qty,
				i + 1,
			),
		),
	);
	return id;
}

/**
 * A night light in two colours: NL-LIGHT (make) is NL-HEAD (make) and a screw; the head is a front cover (buy, from
 * Cover Works, MOQ 5) and two screws. Light, head and cover come in Colour white (default) or black.
 */
async function nightLight() {
	const supplier = await insertSupplier("Cover Works");
	const cover = await insertPart("NL-COVER", "buy", {
		costCents: 150,
		supplierId: supplier,
		offerPriceCents: 150,
		moqMilli: 5000,
	});
	const screw = await insertPart("NL-SCREW", "buy", { costCents: 2 });
	const head = await insertPart("NL-HEAD", "make");
	const light = await insertPart("NL-LIGHT", "make");
	const headAssembly = await insertAssembly(head, [
		[cover, 1000],
		[screw, 2000],
	]);
	const lightAssembly = await insertAssembly(light, [
		[head, 1000],
		[screw, 1000],
	]);
	for (const id of [cover, head, light]) await addOption(id, "Colour", ["white", "black"]);
	return { supplier, cover, screw, head, light, headAssembly, lightAssembly };
}

async function adjust(ref: string, qty: string, value?: [string, string]) {
	const form: Record<string, string> = { part: ref, qty, serial: "", note: "test" };
	if (value) form[`option:${await optionId(ref, value[0])}`] = String(await valueId(ref, value[1]));
	return postForm("/stock/adjust", form);
}

async function planLight(
	n: Awaited<ReturnType<typeof nightLight>>,
	colour: string,
	opts: { qty?: string; when?: "done"; extra?: Record<string, string> } = {},
) {
	const res = await postForm("/builds", {
		part_id: String(n.light),
		assembly_id: String(n.lightAssembly),
		qty: opts.qty ?? "1",
		serial: "",
		planned_for: opts.when ? "" : "2026-11-02",
		notes: "",
		...(opts.when ? { when: opts.when } : {}),
		[`option:${await optionId("NL-LIGHT")}`]: String(await valueId("NL-LIGHT", colour)),
		...opts.extra,
	});
	return res;
}

const buildIdOf = (res: Response) => Number(/\/builds\/(\d+)/.exec(res.headers.get("Location") ?? "")?.[1]);

/** The path of the light's head line, for a "use stock / build now" choice. */
const headPath = async (n: Awaited<ReturnType<typeof nightLight>>) =>
	String(
		(
			await one<{ id: number }>(
				"SELECT id FROM assembly_lines WHERE assembly_id = ? AND component_part_id = ?",
				n.lightAssembly,
				n.head,
			)
		).id,
	);

describe("options on a part", () => {
	it("adds an option with its values in order, the first one the default", async () => {
		const n = await nightLight();
		const values = await rows<{ name: string; position: number; is_default: number }>(
			`SELECT v.name, v.position, v.is_default FROM part_option_values v JOIN part_options o ON o.id = v.option_id
			 WHERE o.part_id = ? ORDER BY v.position`,
			n.cover,
		);
		expect(values).toEqual([
			{ name: "white", position: 1, is_default: 1 },
			{ name: "black", position: 2, is_default: 0 },
		]);
		const html = await (await request(`/parts/${n.cover}`)).text();
		expect(html).toContain('id="options"');
		expect(html).toContain("Stock by value");
		const set = await one<{ summary: string; revertible: number }>(
			"SELECT summary, revertible FROM change_sets ORDER BY id DESC LIMIT 1",
		);
		expect(set).toEqual({ summary: "Add option Colour to NL-LIGHT", revertible: 1 });
		// Only stocked parts have options.
		const kit = await insertPart("NL-KIT", "kit");
		expect((await request(`/parts/${kit}/options`)).status).toBe(404);
	});

	it("renames values, changes the default, adds and removes unused values", async () => {
		const n = await nightLight();
		const option = await optionId("NL-COVER");
		const [white, black] = [await valueId("NL-COVER", "white"), await valueId("NL-COVER", "black")];
		await ok(
			await postForm(`/parts/${n.cover}/options/${option}`, {
				name: "Colour",
				[`value_${white}`]: "ivory",
				[`value_${black}`]: "black",
				default: String(black),
				add: "red\nblue",
			}),
		);
		const values = async () =>
			rows<{ name: string; is_default: number }>(
				"SELECT name, is_default FROM part_option_values WHERE option_id = ? ORDER BY position",
				option,
			);
		expect(await values()).toEqual([
			{ name: "ivory", is_default: 0 },
			{ name: "black", is_default: 1 },
			{ name: "red", is_default: 0 },
			{ name: "blue", is_default: 0 },
		]);
		const blue = await valueId("NL-COVER", "blue");
		await ok(
			await postForm(`/parts/${n.cover}/options/${option}`, {
				name: "Colour",
				default: String(black),
				[`remove_${blue}`]: "on",
			}),
		);
		expect((await values()).map((v) => v.name)).toEqual(["ivory", "black", "red"]);
		// Names stay free of the CSV syntax, and unique on the part.
		const bad = await postForm(`/parts/${n.cover}/options`, { name: "Colour", values: "a" });
		expect(bad.status).toBe(422);
		expect(await bad.text()).toContain("This name is already used.");
		expect((await postForm(`/parts/${n.cover}/options`, { name: "Size|Fit", values: "S" })).status).toBe(422);
	});

	it("refuses to remove a value or delete an option in use, or to make the part a kit", async () => {
		const n = await nightLight();
		await ok(await adjust("NL-COVER", "3", ["Colour", "black"]));
		const option = await optionId("NL-COVER");
		const black = await valueId("NL-COVER", "black");
		const remove = await postForm(`/parts/${n.cover}/options/${option}`, {
			name: "Colour",
			[`remove_${black}`]: "on",
		});
		expect(remove.status).toBe(422);
		expect(await remove.text()).toContain("This value is used by stock, orders or builds");
		const del = await postForm(`/parts/${n.cover}/options/${option}/delete`, {});
		expect(del.headers.get("Location")).toContain("err=option_in_use");
		expect(await rows("SELECT id FROM part_options WHERE id = ?", option)).toHaveLength(1);
		const kit = await postForm(`/parts/${n.head}`, { ref: "NL-HEAD", name: "Head", kind: "kit", unit: "pcs" });
		expect(kit.status).toBe(422);
		expect(await kit.text()).toContain("This part has options: it must stay a buy or make part.");
	});

	it("puts existing stock and open records on the default value when an option is added", async () => {
		const n = await nightLight();
		const bracket = await insertPart("NL-BRACKET", "buy", { costCents: 40, supplierId: n.supplier });
		await ok(await adjust("NL-BRACKET", "7"));
		const po = await ok(
			await postForm("/purchasing/po", { supplier_id: String(n.supplier), expected_at: "", notes: "" }),
		);
		const poId = Number(/\/po\/(\d+)/.exec(po.headers.get("Location") ?? "")?.[1]);
		await ok(await postForm(`/purchasing/po/${poId}/lines`, { part: "NL-BRACKET", qty: "4", price: "" }));
		await addOption(bracket, "Finish", ["matte", "glossy"]);
		const matte = await valueId("NL-BRACKET", "matte");
		const moves = await rows<{ qty_milli: number; option_values: string | null; ref_type: string }>(
			"SELECT qty_milli, option_values, ref_type FROM stock_moves WHERE part_id = ? AND ref_type = 'part_options' ORDER BY id",
			bracket,
		);
		expect(moves).toEqual([
			{ qty_milli: 7000, option_values: String(matte), ref_type: "part_options" },
			{ qty_milli: -7000, option_values: null, ref_type: "part_options" },
		]);
		expect(await stockOf("NL-BRACKET", "matte")).toBe(7000);
		expect((await one("SELECT option_values FROM po_lines WHERE po_id = ?", poId)).option_values).toBe(String(matte));
		// It moved stock: corrected with new moves, never undone.
		expect((await one("SELECT revertible FROM change_sets ORDER BY id DESC LIMIT 1")).revertible).toBe(0);
	});
});

describe("stock per value", () => {
	it("adjusts and counts per value, and values the stock per value", async () => {
		await nightLight();
		await ok(await adjust("NL-COVER", "5", ["Colour", "white"]));
		await ok(await adjust("NL-COVER", "3", ["Colour", "black"]));
		const missing = await adjust("NL-COVER", "1");
		expect(missing.status).toBe(422);
		expect(await missing.text()).toContain("Choose a value for Colour.");
		expect([await stockOf("NL-COVER", "white"), await stockOf("NL-COVER", "black")]).toEqual([5000, 3000]);

		const cover = (await one<{ id: number }>("SELECT id FROM parts WHERE ref = 'NL-COVER'")).id;
		const white = await valueId("NL-COVER", "white");
		const count = await request("/stock/count");
		expect(await count.text()).toContain(`name="count_${cover}_${white}"`);
		await postForm("/stock/count", { [`count_${cover}_${white}`]: "4", note: "" });
		expect(await stockOf("NL-COVER", "white")).toBe(4000);
		expect(await stockOf("NL-COVER", "black")).toBe(3000);

		const v = await valuation(testDb());
		const rowsOf = v.rows.filter((r) => r.part.ref === "NL-COVER");
		expect(rowsOf.map((r) => [r.onHandMilli, r.valueCents])).toEqual([
			[4000, 600],
			[3000, 450],
		]);
		const csv = await (await request("/stock/valuation?format=csv")).text();
		expect(csv).toContain("Colour=white");
		const list = await (await request("/stock")).text();
		expect(list).toContain("Colour: black");
	});

	it("counts per value in stock.csv and exports one row per values", async () => {
		await nightLight();
		await importCsv("stock", "ref,qty,options\nNL-COVER,6,Colour=black\nNL-COVER,2,white\nNL-SCREW,100,\n");
		expect([await stockOf("NL-COVER", "white"), await stockOf("NL-COVER", "black")]).toEqual([2000, 6000]);
		const exported = await (await request("/import/stock/export.csv")).text();
		expect(exported).toContain("NL-COVER,6,,1.50,Colour=black");
		// Exporting and importing again changes nothing.
		const plan = await planImport({ db: testDb(), locale: "en" }, "stock", exported);
		expect(plan?.errors).toEqual([]);
		expect(plan?.rows.every((r) => r.action === "unchanged")).toBe(true);
	});
});

describe("builds in values", () => {
	it("plans a build in a value: follow lines take it through a sub-assembly built now", async () => {
		const n = await nightLight();
		await ok(await adjust("NL-COVER", "2", ["Colour", "black"]));
		await ok(await adjust("NL-SCREW", "10"));
		const res = await planLight(n, "black");
		await ok(res);
		const id = buildIdOf(res);
		const black = await valueId("NL-LIGHT", "black");
		expect((await one("SELECT option_values FROM builds WHERE id = ?", id)).option_values).toBe(String(black));
		const page = await (await request(`/builds/${id}`)).text();
		expect(page).toContain("Colour: black");
		await ok(await postForm(`/builds/${id}/complete`, {}));
		expect(await stockOf("NL-COVER", "black")).toBe(1000);
		expect(await stockOf("NL-COVER", "white")).toBe(0);
		expect(await stockOf("NL-LIGHT", "black")).toBe(1000);
		const asBuilt = await rows<{ ref: string; option_values: string | null }>(
			"SELECT p.ref, l.option_values FROM build_lines l JOIN parts p ON p.id = l.part_id WHERE l.build_id = ? ORDER BY p.ref",
			id,
		);
		expect(asBuilt).toEqual([
			{ ref: "NL-COVER", option_values: String(await valueId("NL-COVER", "black")) },
			{ ref: "NL-SCREW", option_values: null },
		]);
	});

	it("takes a sub-assembly from stock in its value only", async () => {
		const n = await nightLight();
		await ok(await adjust("NL-HEAD", "1", ["Colour", "white"]));
		await ok(await adjust("NL-HEAD", "1", ["Colour", "black"]));
		await ok(await adjust("NL-COVER", "5", ["Colour", "white"]));
		await ok(await adjust("NL-SCREW", "10"));
		const id = buildIdOf(await ok(await planLight(n, "white", { qty: "2" })));
		await ok(await postForm(`/builds/${id}/complete`, {}));
		// One white head from stock, one built now from a white cover; the black head stays.
		expect(await stockOf("NL-HEAD", "white")).toBe(0);
		expect(await stockOf("NL-HEAD", "black")).toBe(1000);
		expect(await stockOf("NL-COVER", "white")).toBe(4000);
		expect(await stockOf("NL-LIGHT", "white")).toBe(2000);
	});

	it("refuses to take a sub-assembly from stock in a value it is short of", async () => {
		const n = await nightLight();
		await ok(await adjust("NL-HEAD", "1", ["Colour", "black"]));
		await ok(await adjust("NL-COVER", "5", ["Colour", "white"]));
		const id = buildIdOf(await ok(await planLight(n, "white")));
		const forced = await postForm(`/builds/${id}/complete`, { [`choice:${await headPath(n)}`]: "stock" });
		expect(forced.status).toBe(422);
		expect(await forced.text()).toContain("NL-HEAD (white) is short in stock");
		expect(await stockOf("NL-HEAD", "black")).toBe(1000);
		// Built now instead (the default), it uses a white cover.
		await ok(await postForm(`/builds/${id}/complete`, {}));
		expect(await stockOf("NL-COVER", "white")).toBe(4000);
	});

	it("refuses a value a component does not come in", async () => {
		const n = await nightLight();
		const option = await optionId("NL-LIGHT");
		await ok(await postForm(`/parts/${n.light}/options/${option}`, { name: "Colour", add: "red" }));
		const res = await planLight(n, "red");
		expect(res.status).toBe(422);
		expect(await res.text()).toContain("NL-HEAD does not come in Colour red.");
		expect(await rows("SELECT id FROM builds")).toHaveLength(0);
	});

	it("follows fixed values and the values chosen when planning", async () => {
		const n = await nightLight();
		const coverLine = (
			await one<{ id: number }>(
				"SELECT id FROM assembly_lines WHERE assembly_id = ? AND component_part_id = ?",
				n.headAssembly,
				n.cover,
			)
		).id;
		const rule = `rule:${await optionId("NL-COVER")}`;
		// Always black: a white light takes a black cover.
		await ok(
			await postForm(`/assemblies/${n.headAssembly}/lines/${coverLine}/options`, {
				[rule]: String(await valueId("NL-COVER", "black")),
			}),
		);
		let s = await computeShortages(testDb());
		const id = buildIdOf(await ok(await planLight(n, "white")));
		s = await computeShortages(testDb());
		const coverLines = () => s.groups.flatMap((g) => g.lines).filter((l) => l.part.ref === "NL-COVER");
		expect(coverLines().map((l) => [l.optionValues, l.needMilli])).toEqual([
			[String(await valueId("NL-COVER", "black")), 1000],
		]);
		await ok(await postForm(`/builds/${id}/cancel`, {}));
		// Chosen when planning: the form asks for it, the build keeps it, the shortages follow it.
		await ok(await postForm(`/assemblies/${n.headAssembly}/lines/${coverLine}/options`, { [rule]: "*" }));
		const form = await (await request(`/builds/new?part=${n.light}`)).text();
		const pick = `pick:${n.cover}:${await optionId("NL-COVER")}`;
		expect(form).toContain(`name="${pick}"`);
		const chosen = buildIdOf(
			await ok(await planLight(n, "white", { extra: { [pick]: String(await valueId("NL-COVER", "black")) } })),
		);
		expect(
			(await one("SELECT option_values FROM build_option_choices WHERE build_id = ? AND part_id = ?", chosen, n.cover))
				.option_values,
		).toBe(String(await valueId("NL-COVER", "black")));
		s = await computeShortages(testDb());
		expect(coverLines().map((l) => l.optionValues)).toEqual([String(await valueId("NL-COVER", "black"))]);
	});

	it("records a finished build in one step in its values", async () => {
		const n = await nightLight();
		await ok(await adjust("NL-COVER", "1", ["Colour", "black"]));
		await ok(await planLight(n, "black", { when: "done" }));
		expect(await stockOf("NL-LIGHT", "black")).toBe(1000);
		expect(await stockOf("NL-COVER", "black")).toBe(0);
	});

	it("keeps costs per part: the roll-up and the as-built cost do not depend on values", async () => {
		const n = await nightLight();
		const calc = new CostCalculator(await loadGraph(testDb()));
		// 1.50 cover + 2 × 0.02 screws, + 1 × 0.02 screw.
		expect(calc.part(n.light).millicents).toBe(156_000);
		const white = buildIdOf(await ok(await planLight(n, "white", { when: "done" })));
		const black = buildIdOf(await ok(await planLight(n, "black", { when: "done" })));
		const cost = async (id: number) =>
			(
				await one<{ c: number }>(
					"SELECT unit_cost_cents AS c FROM stock_moves WHERE ref_type = 'build' AND ref_id = ? AND reason = 'build_output'",
					id,
				)
			).c;
		expect([await cost(white), await cost(black)]).toEqual([156, 156]);
	});
});

describe("purchasing per value", () => {
	it("orders and receives per value, each line rounded to the MOQ", async () => {
		const n = await nightLight();
		await planLight(n, "white", { qty: "2" });
		await planLight(n, "black");
		let s = await computeShortages(testDb());
		const [white, black] = [await valueId("NL-COVER", "white"), await valueId("NL-COVER", "black")];
		const lines = s.groups.flatMap((g) => g.lines).filter((l) => l.part.ref === "NL-COVER");
		expect(lines.map((l) => [l.optionValues, l.needMilli, l.orderMilli])).toEqual([
			[String(white), 2000, 5000],
			[String(black), 1000, 5000],
		]);
		await ok(await postForm("/purchasing/draft-pos", { [`supplier_${n.supplier}`]: "on" }));
		const poLines = await rows<{ id: number; po_id: number; qty_milli: number; option_values: string }>(
			"SELECT id, po_id, qty_milli, option_values FROM po_lines WHERE part_id = ? ORDER BY option_values",
			n.cover,
		);
		expect(poLines.map((l) => [l.option_values, l.qty_milli])).toEqual(
			[
				[String(white), 5000],
				[String(black), 5000],
			].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
		);
		// On order per value: nothing left to order.
		s = await computeShortages(testDb());
		expect(s.groups.flatMap((g) => g.lines).filter((l) => l.part.ref === "NL-COVER")).toEqual([]);
		const blackLine = poLines.find((l) => l.option_values === String(black))!;
		await ok(await postForm(`/purchasing/po/${blackLine.po_id}/receive`, { [`recv_${blackLine.id}`]: "5" }));
		expect([await stockOf("NL-COVER", "white"), await stockOf("NL-COVER", "black")]).toEqual([0, 5000]);
		const po = await (await request(`/purchasing/po/${blackLine.po_id}/export.csv`)).text();
		expect(po).toContain("Colour=black");
	});
});

describe("renaming values", () => {
	it("swaps two names in one edit, and logs only the swap's temporary step", async () => {
		const n = await nightLight();
		const option = await optionId("NL-COVER");
		const [white, black] = [await valueId("NL-COVER", "white"), await valueId("NL-COVER", "black")];
		await ok(
			await postForm(`/parts/${n.cover}/options/${option}`, {
				name: "Colour",
				[`value_${white}`]: "black",
				[`value_${black}`]: "white",
				default: String(white),
			}),
		);
		expect(await rows("SELECT id, name FROM part_option_values WHERE option_id = ? ORDER BY id", option)).toEqual([
			{ id: white, name: "black" },
			{ id: black, name: "white" },
		]);
		// A plain rename is one update.
		await ok(await postForm(`/parts/${n.cover}/options/${option}`, { name: "Colour", [`value_${white}`]: "ivory" }));
		const last = await rows<{ new_row: string }>(
			"SELECT new_row FROM change_log WHERE change_set_id = (SELECT max(id) FROM change_sets) AND table_name = 'part_option_values'",
		);
		expect(last.map((r) => JSON.parse(r.new_row).name)).toEqual(["ivory"]);
	});
});

describe("dashboard", () => {
	it("flags a part below zero in one value even when its total is positive", async () => {
		await nightLight();
		await ok(await adjust("NL-COVER", "5", ["Colour", "white"]));
		// Nothing else puts the cover on the dashboard: no build, no PO.
		expect(await (await request("/")).text()).not.toContain("NL-COVER");
		await ok(await adjust("NL-COVER", "-1", ["Colour", "black"]));
		expect(await (await request("/")).text()).toContain("NL-COVER");
	});
});

describe("undo with option values", () => {
	const lastSet = async () => (await one<{ id: number }>("SELECT max(id) AS id FROM change_sets")).id;
	const undo = (id: number) =>
		revertChangeSet(testDb(), ADMIN, id, { user: TESTER, summary: (s) => `Undo #${s.id}: ${s.summary}` });

	it("undoes an unused option, and refuses while a record names one of its values", async () => {
		const n = await nightLight();
		await addOption(n.screw, "Length", ["8", "10"]);
		const added = await lastSet();
		const po = await ok(
			await postForm("/purchasing/po", { supplier_id: String(n.supplier), expected_at: "", notes: "" }),
		);
		const poId = Number(/\/po\/(\d+)/.exec(po.headers.get("Location") ?? "")?.[1]);
		await ok(
			await postForm(`/purchasing/po/${poId}/lines`, {
				part: "NL-SCREW",
				qty: "100",
				price: "",
				[`option:${await optionId("NL-SCREW", "Length")}`]: String(await valueId("NL-SCREW", "10")),
			}),
		);
		const refused = await undo(added);
		expect(refused).toMatchObject({ ok: false, reason: "conflict" });
		expect(
			refused.ok ? [] : "conflicts" in refused ? refused.conflicts.map((c) => [c.reason, c.other]) : [],
		).toContainEqual(["in_use", "po_lines"]);
		// Once the line is gone, the option can be undone.
		const line = (await one<{ id: number }>("SELECT id FROM po_lines WHERE po_id = ?", poId)).id;
		await ok(await postForm(`/purchasing/po/${poId}/lines/${line}/delete`, {}));
		const removed = await lastSet();
		expect(await undo(added)).toMatchObject({ ok: true });
		expect(await rows("SELECT id FROM part_options WHERE part_id = ?", n.screw)).toHaveLength(0);
		// And the deleted line cannot come back: its value no longer exists.
		const back = await undo(removed);
		expect(back).toMatchObject({ ok: false, reason: "conflict" });
		expect(back.ok ? [] : "conflicts" in back ? back.conflicts.map((c) => [c.reason, c.other]) : []).toContainEqual([
			"parent_missing",
			"part_option_values",
		]);
	});
});
