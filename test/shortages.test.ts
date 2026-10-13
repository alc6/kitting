import { describe, expect, it } from "vitest";
import { computeShortages } from "../src/domain/purchasing";
import { assemblyId, insertMove, insertPart, insertSupplier, loadDemo, one, partId, postForm, testDb } from "./helpers";

async function planBuild(ref: string, opts: { serial?: string; qty?: string; code?: string; date?: string } = {}) {
	const res = await postForm("/builds", {
		part_id: String(await partId(ref)),
		assembly_id: String(await assemblyId(ref, opts.code ?? "std")),
		qty: opts.qty ?? "1",
		serial: opts.serial ?? "",
		planned_for: opts.date ?? "",
		notes: "",
	});
	expect(res.status).toBe(303);
	return Number(/\/builds\/(\d+)/.exec(res.headers.get("Location") ?? "")?.[1]);
}

const lineOf = (s: Awaited<ReturnType<typeof computeShortages>>, ref: string) =>
	s.groups.flatMap((g) => g.lines).find((l) => l.part.ref === ref);

describe("shortage engine", () => {
	it("is empty without open builds", async () => {
		await loadDemo();
		const s = await computeShortages(testDb());
		expect(s.groups).toEqual([]);
		expect(s.buildCount).toBe(0);
	});

	it("nets exploded needs against on-hand and rounds to MOQ and pack size", async () => {
		await loadDemo();
		// 5 lamps: base plates needed 5, on hand 3 -> net 2, MOQ 10 -> order 10.
		for (let i = 1; i <= 5; i++) await planBuild("LAMP-DESK", { serial: `L-${i}` });
		const s = await computeShortages(testDb());
		const plate = lineOf(s, "BASE-PLATE")!;
		expect([plate.needMilli, plate.onHandMilli, plate.netMilli, plate.orderMilli]).toEqual([5000, 3000, 2000, 10_000]);
		expect(plate.builds).toEqual(["B-0001", "B-0002", "B-0003", "B-0004", "B-0005"]);
		// LEDs: 5 needed, 6 on hand -> no shortage.
		expect(lineOf(s, "LED-5W-CW")).toBeUndefined();
		// Drivers: 5 needed, 5 on hand -> none. PSU: 5 needed, 6 on hand -> none.
		expect(lineOf(s, "DRV-12V")).toBeUndefined();
		// Grouped by supplier, fees and make parts never appear.
		expect(s.groups.map((g) => g.supplierName)).toContain("Ironleaf Metalworks");
		expect(lineOf(s, "FEE-WEEE")).toBeUndefined();
		expect(lineOf(s, "ARM-ASSY")).toBeUndefined();
	});

	it("shares sub-assembly stock across builds instead of double counting it", async () => {
		await loadDemo();
		// 2 arms in stock: the first lamp takes them, the second must build its arms.
		await planBuild("LAMP-DESK", { serial: "L-1", date: "2026-11-01" });
		await planBuild("LAMP-DESK", { serial: "L-2", date: "2026-11-02" });
		const s = await computeShortages(testDb());
		// Arm tubes: 2 needed (second lamp only), 10 on hand -> no shortage.
		expect(lineOf(s, "ARM-TUBE-300")).toBeUndefined();
		// 6 lamps: 2 arms from stock, 10 to build -> 10 tubes needed, 10 on hand -> still none;
		// 7 lamps -> 12 tubes needed -> net 2 -> MOQ 20.
		for (let i = 3; i <= 7; i++) await planBuild("LAMP-DESK", { serial: `L-${i}` });
		const tube = lineOf(await computeShortages(testDb()), "ARM-TUBE-300")!;
		expect([tube.needMilli, tube.netMilli, tube.orderMilli]).toEqual([12_000, 2_000, 20_000]);
	});

	it("subtracts quantities still to receive on open POs (drafts included)", async () => {
		await loadDemo();
		for (let i = 1; i <= 5; i++) await planBuild("LAMP-DESK", { serial: `L-${i}` });
		const supplier = (await one<{ supplier_id: number }>("SELECT supplier_id FROM parts WHERE ref = 'BASE-PLATE'"))
			.supplier_id;
		const res = await postForm("/purchasing/po", { supplier_id: String(supplier), expected_at: "", notes: "" });
		const po = Number(/\/po\/(\d+)/.exec(res.headers.get("Location") ?? "")?.[1]);
		await postForm(`/purchasing/po/${po}/lines`, { part: "BASE-PLATE", qty: "1", price: "5.50" });
		expect(lineOf(await computeShortages(testDb()), "BASE-PLATE")?.netMilli).toBe(1000);
		await postForm(`/purchasing/po/${po}/lines`, { part: "BASE-PLATE", qty: "5", price: "5.50" });
		expect(lineOf(await computeShortages(testDb()), "BASE-PLATE")).toBeUndefined();
		await postForm(`/purchasing/po/${po}/cancel`, {});
		expect(lineOf(await computeShortages(testDb()), "BASE-PLATE")?.netMilli).toBe(2000);
	});

	it("reports parts below zero, parts without supplier and sub-assemblies without assembly", async () => {
		const top = await insertPart("TOP", "make");
		await insertPart("NOASSEMBLY", "make");
		await insertPart("LOOSE", "buy", { costCents: 100 });
		const neg = await insertPart("NEG", "buy", { supplierId: await insertSupplier("Acme") });
		await insertMove(neg, -3000);
		await postForm("/assemblies", {
			parent_part_id: String(top),
			code: "std",
			revision: "Rev1",
			notes: "",
			copy_from: "",
		});
		const b = (await one<{ id: number }>("SELECT id FROM assemblies")).id;
		await postForm(`/assemblies/${b}/lines`, { component: "NOASSEMBLY", qty: "1", notes: "" });
		await postForm(`/assemblies/${b}/lines`, { component: "LOOSE", qty: "2", notes: "" });
		await postForm(`/assemblies/${b}/activate`, {});
		await planBuild("TOP", { qty: "2" });
		const s = await computeShortages(testDb());
		expect(s.missingAssemblies).toEqual([
			{ ref: "NOASSEMBLY", name: "Part NOASSEMBLY", qtyMilli: 2000, builds: ["B-0001"] },
		]);
		const unassigned = s.groups.find((g) => g.supplierId === null)!;
		expect(unassigned.lines.map((l) => [l.part.ref, l.orderMilli])).toEqual([["LOOSE", 4000]]);
		expect(lineOf(s, "NEG")?.netMilli).toBe(3000);
	});
});
