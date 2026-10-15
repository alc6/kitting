// Part options over MCP (D193): the night light fixture of test/options.test.ts, for the MCP tests. Options are
// defined through the part pages (a change set each), the rest is seeded.
import { expect } from "vitest";
import { insertPart, insertSupplier, one, postForm, returnedId, seedSql, stmt } from "./helpers";

export async function ok(res: Response) {
	expect(res.status, await res.clone().text()).toBe(303);
	return res;
}

export async function addOption(partId: number, name: string, values: string[]) {
	return ok(await postForm(`/parts/${partId}/options`, { name, values: values.join("\n") }));
}

export const optionId = async (ref: string, name = "Colour") =>
	(
		await one<{ id: number }>(
			"SELECT o.id FROM part_options o JOIN parts p ON p.id = o.part_id WHERE p.ref = ? AND o.name = ?",
			ref,
			name,
		)
	).id;

export const valueId = async (ref: string, value: string, option = "Colour") =>
	(
		await one<{ id: number }>(
			`SELECT v.id FROM part_option_values v JOIN part_options o ON o.id = v.option_id JOIN parts p ON p.id = o.part_id
			 WHERE p.ref = ? AND o.name = ? AND v.name = ?`,
			ref,
			option,
			value,
		)
	).id;

export async function insertAssembly(parentId: number, lines: [number, number][]) {
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
export async function nightLight() {
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

/** Stock through the adjustment page: in one value of the part's option, or none for a part without options. */
export async function adjustViaForm(ref: string, qty: string, value?: string, serial = "") {
	const form: Record<string, string> = { part: ref, qty, serial, note: "test" };
	if (value) form[`option:${await optionId(ref)}`] = String(await valueId(ref, value));
	return ok(await postForm("/stock/adjust", form));
}
