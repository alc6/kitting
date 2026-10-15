// CSV and part options (D192): part_options.csv, and the options column of assemblies.csv.
import { describe, expect, it } from "vitest";
import demoAssemblies from "../examples/full/assemblies.csv?raw";
import demoMachineTypes from "../examples/full/machine_types.csv?raw";
import demoMachines from "../examples/full/machines.csv?raw";
import demoPartOptions from "../examples/full/part_options.csv?raw";
import demoOffers from "../examples/full/part_suppliers.csv?raw";
import demoParts from "../examples/full/parts.csv?raw";
import demoStock from "../examples/full/stock.csv?raw";
import demoSuppliers from "../examples/full/suppliers.csv?raw";
import { type ImportPlan, importerFor, planImport } from "../src/domain/import";
import { toCsv } from "../src/lib/csv";
import { importCsv, insertMove, one, postForm, request, rows, seedSql, stmt, testDb } from "./helpers";

const plan = (type: Parameters<typeof planImport>[1], csv: string): Promise<ImportPlan> =>
	planImport({ db: testDb(), locale: "en" }, type, csv) as Promise<ImportPlan>;

const keys = (p: ImportPlan) => p.errors.map((e) => `${e.line}:${e.column ?? ""}:${e.key}`);
const actions = (p: ImportPlan) => p.rows.map((r) => r.action);

/** Options of a part as "Colour: black*, white; Size: S" (default starred), values and options in stored order. */
async function optionsOf(ref: string): Promise<string> {
	const list = await rows<{ o: string; v: string; d: number }>(
		`SELECT o.name AS o, v.name AS v, v.is_default AS d FROM part_options o
		 JOIN part_option_values v ON v.option_id = o.id JOIN parts p ON p.id = o.part_id
		 WHERE p.ref = ? ORDER BY o.position, o.id, v.position, v.id`,
		ref,
	);
	const byOption = new Map<string, string[]>();
	for (const r of list) byOption.set(r.o, [...(byOption.get(r.o) ?? []), r.d ? `${r.v}*` : r.v]);
	return [...byOption].map(([o, v]) => `${o}: ${v.join(", ")}`).join("; ");
}

const valueIds = async (ref: string, option: string) =>
	Object.fromEntries(
		(
			await rows<{ name: string; id: number }>(
				`SELECT v.name, v.id FROM part_option_values v JOIN part_options o ON o.id = v.option_id
				 JOIN parts p ON p.id = o.part_id WHERE p.ref = ? AND o.name = ?`,
				ref,
				option,
			)
		).map((r) => [r.name, r.id]),
	) as Record<string, number>;

async function roundTrip(type: "part_options" | "assemblies" | "stock") {
	const importer = importerFor(type);
	if (!importer) throw new Error(type);
	const exported = await importer.exportRows({ db: testDb(), locale: "en" });
	const header = importer.columns ?? [...importer.required, ...importer.optional];
	return { exported, plan: await plan(type, toCsv([header, ...exported])) };
}

const HEADER = "ref,option,value,default\n";

async function parts() {
	await importCsv("parts", "ref,name,kind\nCOV,Cover,make\nSCR,Screw,buy\nKIT,Kit,kit\nPRD,Product,make\n");
}

describe("part_options.csv", () => {
	it("creates options with their values in order, the default marked", async () => {
		await parts();
		const csv = `${HEADER}COV,Colour,black,\nCOV,Colour,white,yes\nCOV,Size,S,\nCOV,Size,L,\nSCR,Finish,zinc,\n`;
		const p = await plan("part_options", csv);
		expect(p.errors).toEqual([]);
		expect(actions(p)).toEqual(["create", "create", "create"]);
		expect(p.rows[0]?.cells).toEqual(["COV", "Colour", "black, white", "white"]);
		expect(p.revertible).toBeUndefined();

		await importCsv("part_options", csv);
		expect(await optionsOf("COV")).toBe("Colour: black, white*; Size: S*, L");
		expect(await optionsOf("SCR")).toBe("Finish: zinc*");
	});

	it("keeps the records of values that stay, reorders, adds and removes the others", async () => {
		await parts();
		await importCsv("part_options", `${HEADER}COV,Colour,black,yes\nCOV,Colour,white,\nCOV,Colour,grey,\n`);
		const before = await valueIds("COV", "Colour");

		// white first, a new red in the middle, grey removed; case of the option name follows the file.
		const csv = `${HEADER}COV,colour,white,\nCOV,colour,red,\nCOV,colour,black,\n`;
		const p = await plan("part_options", csv);
		expect(p.errors).toEqual([]);
		expect(actions(p)).toEqual(["update"]);
		expect(p.rows[0]?.changes).toEqual([
			"name: Colour → colour",
			"+ red",
			"− grey",
			"order: black, white → white, black",
		]);
		await importCsv("part_options", csv);

		expect(await optionsOf("COV")).toBe("colour: white, red, black*");
		const after = await valueIds("COV", "colour");
		expect(after.black).toBe(before.black);
		expect(after.white).toBe(before.white);
		expect(after.grey).toBeUndefined();
	});

	it("renames a value by removing the old one and adding the new one", async () => {
		await parts();
		await importCsv("part_options", `${HEADER}COV,Colour,black,\nCOV,Colour,white,\n`);
		const csv = `${HEADER}COV,Colour,noir,yes\nCOV,Colour,white,\n`;
		const p = await plan("part_options", csv);
		expect(p.rows[0]?.changes).toEqual(["+ noir", "− black", "default: black → noir"]);
		await importCsv("part_options", csv);
		expect(await optionsOf("COV")).toBe("Colour: noir*, white");
	});

	it("reorders options and values without touching what is unchanged", async () => {
		await parts();
		await importCsv("part_options", `${HEADER}COV,Colour,black,\nCOV,Colour,white,\nCOV,Size,S,\nCOV,Size,L,\n`);
		const same = await plan(
			"part_options",
			`${HEADER}COV,Colour,black,\nCOV,Colour,white,\nCOV,Size,S,\nCOV,Size,L,\n`,
		);
		expect(actions(same)).toEqual(["unchanged", "unchanged"]);
		expect(same.statements("t@example.com", "2026-01-01T00:00:00Z")).toEqual([]);

		await importCsv("part_options", `${HEADER}COV,Size,L,\nCOV,Size,S,\nCOV,Colour,white,\nCOV,Colour,black,\n`);
		expect(await optionsOf("COV")).toBe("Size: L, S*; Colour: white, black*");
	});

	it("puts the default on the row marked yes, else keeps the current one, else the first", async () => {
		await parts();
		await importCsv("part_options", `${HEADER}COV,Colour,black,\nCOV,Colour,white,\n`);
		expect(await optionsOf("COV")).toBe("Colour: black*, white");

		await importCsv("part_options", `${HEADER}COV,Colour,black,\nCOV,Colour,white,yes\n`);
		expect(await optionsOf("COV")).toBe("Colour: black, white*");

		// Nothing marked: white stays the default, wherever it is listed.
		await importCsv("part_options", `${HEADER}COV,Colour,black,\nCOV,Colour,red,\nCOV,Colour,white,\n`);
		expect(await optionsOf("COV")).toBe("Colour: black, red, white*");

		// The default is no longer listed: the first value takes over.
		await importCsv("part_options", `${HEADER}COV,Colour,red,\nCOV,Colour,black,\n`);
		expect(await optionsOf("COV")).toBe("Colour: red*, black");

		// A new value marked yes while the file otherwise moves around.
		await importCsv("part_options", `${HEADER}COV,Colour,blue,yes\nCOV,Colour,red,\nCOV,Colour,black,\n`);
		expect(await optionsOf("COV")).toBe("Colour: blue*, red, black");
	});

	it("accepts a file without the default column", async () => {
		await parts();
		await importCsv("part_options", "ref,option,value\nCOV,Colour,black\nCOV,Colour,white\n");
		expect(await optionsOf("COV")).toBe("Colour: black*, white");
	});

	it("refuses two defaults, bad names, unknown or unsuitable parts and repeated values", async () => {
		await parts();
		const p = await plan(
			"part_options",
			`${HEADER}COV,Colour,black,yes\nCOV,Colour,white,yes\nCOV,Colour,black,\nCOV,Size,a=b,\nCOV,Si|ze,S,\nNOPE,Colour,x,\nKIT,Colour,x,\nSCR,Colour,x,maybe\nSCR,,x,\n`,
		);
		expect(keys(p)).toEqual([
			"3:default:option_default_twice",
			"4:value:duplicate_name",
			"5:value:option_name_invalid",
			"6:option:option_name_invalid",
			"7:ref:unknown_part",
			"8:ref:options_kind",
			"9:default:invalid_bool",
			"10:option:required",
		]);
	});

	it("refuses removing a value or an option that stock names, and allows an unused one", async () => {
		await parts();
		await importCsv("part_options", `${HEADER}COV,Colour,black,\nCOV,Colour,white,\nCOV,Size,S,\nCOV,Size,L,\n`);
		const colour = await valueIds("COV", "Colour");
		const size = await valueIds("COV", "Size");
		const cover = (await one<{ id: number }>("SELECT id FROM parts WHERE ref = 'COV'")).id;
		await seedSql(
			stmt(
				"INSERT INTO stock_moves (part_id, qty_milli, reason, option_values, by, created_by, updated_by) VALUES (?, 5000, 'adjust', ?, 'seed', 'seed', 'seed')",
				cover,
				[colour.black, size.S].sort((a, b) => (a ?? 0) - (b ?? 0)).join(","),
			),
		);

		// black is named by a stock move: it cannot go. L is free: it can.
		const refused = await plan("part_options", `${HEADER}COV,Colour,white,\nCOV,Size,S,\n`);
		expect(keys(refused)).toEqual(["2:value:option_value_in_use"]);

		// Dropping the Size option altogether is refused too (S is in use).
		const optionGone = await plan("part_options", `${HEADER}COV,Colour,black,\nCOV,Colour,white,\n`);
		expect(keys(optionGone)).toEqual(["2:option:option_in_use"]);

		const fine = await plan("part_options", `${HEADER}COV,Colour,black,\nCOV,Colour,white,\nCOV,Size,S,\n`);
		expect(fine.errors).toEqual([]);
		await importCsv("part_options", `${HEADER}COV,Colour,black,\nCOV,Colour,white,\nCOV,Size,S,\n`);
		expect(await optionsOf("COV")).toBe("Colour: black*, white; Size: S*");
		// And the refusal goes through the page as an error, writing nothing.
		const res = await postForm("/import/part_options/commit", { csv: `${HEADER}COV,Colour,white,\nCOV,Size,S,\n` });
		expect(res.status).toBe(422);
		expect(await optionsOf("COV")).toBe("Colour: black*, white; Size: S*");
	});

	it("removes the options of a part only when the part is named", async () => {
		await parts();
		await importCsv("part_options", `${HEADER}COV,Colour,black,\nSCR,Finish,zinc,\n`);
		await importCsv("part_options", `${HEADER}COV,Size,S,\n`);
		expect(await optionsOf("COV")).toBe("Size: S*");
		expect(await optionsOf("SCR")).toBe("Finish: zinc*");
	});

	it("adds an option to a part with stock onto its default value, and cannot be undone", async () => {
		await parts();
		const cover = (await one<{ id: number }>("SELECT id FROM parts WHERE ref = 'COV'")).id;
		await insertMove(cover, 7000);

		const csv = `${HEADER}COV,Colour,black,\nCOV,Colour,white,yes\n`;
		const p = await plan("part_options", csv);
		expect(p.errors).toEqual([]);
		expect(p.revertible).toBe(false);
		await importCsv("part_options", csv);

		const white = (await valueIds("COV", "Colour")).white;
		expect(
			await rows(
				"SELECT option_values, SUM(qty_milli) AS q FROM stock_moves GROUP BY option_values HAVING SUM(qty_milli) <> 0",
			),
		).toEqual([{ option_values: String(white), q: 7000 }]);
		expect(await optionsOf("COV")).toBe("Colour: black, white*");
	});

	it("adds an option to a part without stock as a revertible change, keeping the file's order", async () => {
		await parts();
		const csv = `${HEADER}COV,Colour,black,\nCOV,Colour,white,\nCOV,Colour,red,yes\n`;
		const p = await plan("part_options", csv);
		expect(p.revertible).toBeUndefined();
		await importCsv("part_options", csv);
		expect(await optionsOf("COV")).toBe("Colour: black, white, red*");
	});

	it("keeps the order of options when new ones come first or in the middle", async () => {
		await parts();
		await importCsv("part_options", `${HEADER}COV,Colour,black,\nCOV,Size,S,\n`);
		await importCsv("part_options", `${HEADER}COV,Finish,matt,\nCOV,Colour,black,\nCOV,Shape,round,\nCOV,Size,S,\n`);
		expect(await optionsOf("COV")).toBe("Finish: matt*; Colour: black*; Shape: round*; Size: S*");
	});

	it("round-trips through the export as unchanged", async () => {
		await parts();
		await importCsv(
			"part_options",
			`${HEADER}COV,Colour,black,\nCOV,Colour,white,yes\nCOV,Size,S,\nCOV,Size,L,\nSCR,Finish,zinc,\n`,
		);
		const { exported, plan: again } = await roundTrip("part_options");
		expect(exported).toEqual([
			["COV", "Colour", "black", "no"],
			["COV", "Colour", "white", "yes"],
			["COV", "Size", "S", "yes"],
			["COV", "Size", "L", "no"],
			["SCR", "Finish", "zinc", "yes"],
		]);
		expect(again.errors).toEqual([]);
		expect(actions(again)).toEqual(["unchanged", "unchanged", "unchanged"]);
	});

	it("is previewed, committed and exported through the import page", async () => {
		await parts();
		const csv = `${HEADER}COV,Colour,black,\nCOV,Colour,white,\n`;
		const preview = await postForm("/import/part_options/preview", { csv });
		expect(preview.status).toBe(200);
		expect(await preview.text()).toContain("black, white");
		const commit = await postForm("/import/part_options/commit", { csv });
		expect(commit.headers.get("Location")).toBe("/import?done=part_options&create=1&update=0");
		const exported = await (await request("/import/part_options/export.csv")).text();
		expect(exported).toContain("COV,Colour,black,yes");
		const page = await (await request("/import")).text();
		expect(page).toContain("Part options");
		const template = await (await request("/import/part_options/template.csv")).text();
		expect(template.split(/\r?\n/)[0]).toBe("ref,option,value,default");
	});
});

describe("assemblies.csv options column", () => {
	async function setup() {
		await parts();
		await importCsv(
			"part_options",
			`${HEADER}COV,Colour,black,yes\nCOV,Colour,white,\nCOV,Size,S,\nCOV,Size,M,yes\nCOV,Size,L,\n`,
		);
	}
	const lines = () =>
		rows<{ ref: string; qty_milli: number; fixed: string | null; chosen: string | null }>(
			`SELECT c.ref, l.qty_milli, l.fixed_option_values AS fixed, l.chosen_option_ids AS chosen
			 FROM assembly_lines l JOIN parts c ON c.id = l.component_part_id JOIN assemblies a ON a.id = l.assembly_id
			 JOIN parts p ON p.id = a.parent_part_id WHERE p.ref = 'PRD' ORDER BY l.position`,
		);
	const HEAD = "parent_ref,component_ref,qty,options\n";

	it("fixes a value, marks an option chosen when planned, and lets the others follow", async () => {
		await setup();
		const colour = await valueIds("COV", "Colour");
		const sizeOption = (await one<{ id: number }>("SELECT id FROM part_options WHERE name = 'Size'")).id;
		const csv = `${HEAD}PRD,COV,1,Colour=black|Size=*\nPRD,COV,2,colour = WHITE\nPRD,COV,3,\nPRD,SCR,4,\n`;
		const p = await plan("assemblies", csv);
		expect(p.errors).toEqual([]);
		await importCsv("assemblies", csv);

		expect(await lines()).toEqual([
			{ ref: "COV", qty_milli: 1000, fixed: String(colour.black), chosen: String(sizeOption) },
			{ ref: "COV", qty_milli: 2000, fixed: String(colour.white), chosen: null },
			{ ref: "COV", qty_milli: 3000, fixed: null, chosen: null },
			{ ref: "SCR", qty_milli: 4000, fixed: null, chosen: null },
		]);
	});

	it("reports what is wrong with a line's options as errors on that column", async () => {
		await setup();
		const p = await plan(
			"assemblies",
			`${HEAD}PRD,COV,1,Shape=round\nPRD,COV,1,Colour=pink\nPRD,COV,1,Colour=black|Colour=white\nPRD,SCR,1,Colour=black\nPRD,COV,1,black\nPRD,COV,1,Size=*|Colour\n`,
		);
		expect(keys(p)).toEqual([
			"2:options:option_unknown",
			"3:options:option_value_unknown",
			"4:options:option_twice",
			"5:options:options_none",
			"6:options:options_syntax",
			"7:options:options_syntax",
		]);
	});

	it("round-trips through the export as unchanged, and a changed rule is an update", async () => {
		await setup();
		const csv = `${HEAD}PRD,COV,1,Colour=black|Size=*\nPRD,COV,2,Size=L\nPRD,SCR,4,\n`;
		await importCsv("assemblies", csv);

		const { exported, plan: again } = await roundTrip("assemblies");
		expect(exported.map((r) => r[11])).toEqual(["Colour=black|Size=*", "Size=L", ""]);
		expect(again.errors).toEqual([]);
		expect(actions(again)).toEqual(["unchanged"]);

		const changed = await plan("assemblies", `${HEAD}PRD,COV,1,Colour=white|Size=*\nPRD,COV,2,Size=L\nPRD,SCR,4,\n`);
		expect(actions(changed)).toEqual(["update"]);
		expect(changed.rows[0]?.changes).toEqual(["COV options: Colour=black|Size=* → Colour=white|Size=*"]);

		// An empty cell makes every option follow the build again.
		await importCsv("assemblies", `${HEAD}PRD,COV,1,\nPRD,COV,2,\nPRD,SCR,4,\n`);
		expect((await lines()).map((l) => [l.fixed, l.chosen])).toEqual([
			[null, null],
			[null, null],
			[null, null],
		]);
	});

	it("keeps the rules of existing lines when the file has no options column", async () => {
		await setup();
		await importCsv("assemblies", `${HEAD}PRD,COV,1,Colour=black\nPRD,COV,2,Size=*\nPRD,SCR,4,\n`);
		const before = await lines();

		// Quantities change, a line is added: the first two COV lines keep their rules, the new one follows.
		const csv = "parent_ref,component_ref,qty\nPRD,COV,5\nPRD,COV,6\nPRD,COV,7\nPRD,SCR,4\n";
		const p = await plan("assemblies", csv);
		expect(p.errors).toEqual([]);
		expect(p.rows[0]?.changes).toEqual(["COV: 3 → 18"]);
		await importCsv("assemblies", csv);
		const after = await lines();
		expect(after.map((l) => [l.ref, l.qty_milli])).toEqual([
			["COV", 5000],
			["COV", 6000],
			["COV", 7000],
			["SCR", 4000],
		]);
		expect(after.map((l) => [l.fixed, l.chosen])).toEqual([
			[before[0]?.fixed, null],
			[null, before[1]?.chosen],
			[null, null],
			[null, null],
		]);

		// Same lines again, no column: nothing changes.
		const same = await plan("assemblies", "parent_ref,component_ref,qty\nPRD,COV,5\nPRD,COV,6\nPRD,COV,7\nPRD,SCR,4\n");
		expect(actions(same)).toEqual(["unchanged"]);
	});

	it("puts the column last in the template, so existing positions stay", async () => {
		await setup();
		const template = await (await request("/import/assemblies/template.csv")).text();
		expect(template.split(/\r?\n/)[0]).toBe(
			"parent_ref,code,revision,status,sale_price,batch_qty,machine,machine_minutes,component_ref,qty,notes,options",
		);
	});
});

describe("the full example dataset", () => {
	it("exports what it imported, as unchanged rows, for every file with options", async () => {
		await importCsv("suppliers", demoSuppliers);
		await importCsv("parts", demoParts);
		await importCsv("part_options", demoPartOptions);
		await importCsv("part_suppliers", demoOffers);
		await importCsv("machine_types", demoMachineTypes);
		await importCsv("machines", demoMachines);
		await importCsv("assemblies", demoAssemblies);
		await importCsv("stock", demoStock);
		for (const type of ["part_options", "assemblies", "stock"] as const) {
			const { plan: again } = await roundTrip(type);
			expect(again.errors, type).toEqual([]);
			expect(
				again.rows.filter((r) => r.action !== "unchanged"),
				type,
			).toEqual([]);
		}
	});
});
