import { describe, expect, it } from "vitest";
import type { MoveReason } from "../src/db/schema";
import { averageUnitCents, buildUnitCents, type LedgerMove, replayAverageCosts } from "../src/domain/costing";
import { resolveCostsAt } from "../src/domain/prices";
import { basisPoints, formatPercent, mulDivRound } from "../src/lib/units";

const A = 1;
const B = 2;
const OUT = 3;

const mv = (
	partId: number,
	qty: number,
	reason: MoveReason,
	unitCostCents: number | null = null,
	ref: { type: string; id: number } | null = null,
): LedgerMove => ({
	partId,
	qtyMilli: qty * 1000,
	reason,
	refType: ref?.type ?? null,
	refId: ref?.id ?? null,
	unitCostCents,
});

const avg = (moves: LedgerMove[], partId = A) => {
	const c = replayAverageCosts(moves).costs.get(partId)!;
	return {
		qty: c.qtyMilli / 1000,
		value: c.valueMillicents / 1000,
		unit: averageUnitCents(c),
		incomplete: c.incomplete,
	};
};

describe("weighted average cost (PMP)", () => {
	it("values a first receipt at its PO price", () => {
		expect(avg([mv(A, 10, "receipt", 200)])).toEqual({ qty: 10, value: 2000, unit: 200, incomplete: false });
	});

	it("averages a second receipt at another price", () => {
		// 10 at 2.00 + 30 at 3.00 = 110.00 for 40 → 2.75
		expect(avg([mv(A, 10, "receipt", 200), mv(A, 30, "receipt", 300)])).toMatchObject({
			qty: 40,
			value: 11000,
			unit: 275,
		});
	});

	it("takes exits at the average, which does not change it", () => {
		const r = avg([mv(A, 10, "receipt", 200), mv(A, 30, "receipt", 300), mv(A, -8, "build_consume", 250)]);
		expect(r).toMatchObject({ qty: 32, value: 8800, unit: 275 });
	});

	it("values a positive count into empty stock at the cost recorded on the move", () => {
		expect(avg([mv(A, 5, "count", 120)])).toMatchObject({ qty: 5, value: 600, unit: 120 });
	});

	it("values found stock at the current average, not at the recorded standard cost", () => {
		const r = avg([mv(A, 10, "receipt", 200), mv(A, 2, "adjust", 999)]);
		expect(r).toMatchObject({ qty: 12, value: 2400, unit: 200 });
	});

	it("resets the average when a receipt lands on negative stock", () => {
		// −3 on hand (consumed before any receipt, at the last known average), then 10 at 4.00:
		// the 7 left are all worth 4.00.
		const r = avg([mv(A, 4, "receipt", 100), mv(A, -7, "build_consume", 100), mv(A, 10, "receipt", 400)]);
		expect(r).toMatchObject({ qty: 7, value: 2800, unit: 400 });
	});

	it("falls back to the standard cost for entries into empty stock without a recorded cost", () => {
		const c = replayAverageCosts([mv(A, 5, "count", null)], new Map([[A, 454_000]])).costs.get(A)!;
		expect(averageUnitCents(c)).toBe(454);
		expect(c.incomplete).toBe(false);
	});

	it("flags parts whose entries have no known cost at all", () => {
		const r = avg([mv(A, 5, "count", null)]);
		expect(r).toMatchObject({ qty: 5, value: 0, incomplete: true });
	});

	it("values a build output from what it consumed at average cost, plus its fees", () => {
		const build = { type: "build", id: 7 };
		const moves = [
			mv(A, 10, "receipt", 100), // A averages 1.00…
			mv(A, 10, "receipt", 300), // …then 2.00
			mv(B, 4, "receipt", 50),
			// The build records standard costs (A at 1.50, B at 0.50) and 0.30 of fees: output recorded at 4.30.
			mv(A, -2, "build_consume", 150, build),
			mv(B, -2, "build_consume", 50, build),
			mv(OUT, 1, "build_output", 430, build),
		];
		const { costs, builds } = replayAverageCosts(moves);
		// Actual: 2 × 2.00 + 2 × 0.50 + 0.30 fees = 5.30 (the recorded 4.30 used standard costs).
		expect(buildUnitCents(builds.get(7))).toBe(530);
		expect(averageUnitCents(costs.get(OUT)!)).toBe(530);
		expect(costs.get(A)).toMatchObject({ qtyMilli: 18_000, valueMillicents: 3_600_000 }); // 18 × 2.00
	});

	it("flags a build that consumed units of unknown cost, until a priced receipt resets the average", () => {
		const b1 = { type: "build", id: 1 };
		const b2 = { type: "build", id: 2 };
		const moves = [
			mv(A, 2, "count", null), // 2 units of unknown cost
			mv(A, -1, "build_consume", null, b1),
			mv(OUT, 1, "build_output", 0, b1),
			mv(A, -1, "build_consume", null, b2), // stock back to 0: nothing unknown left…
			mv(OUT, 1, "build_output", 0, b2),
			mv(A, 5, "receipt", 100), // …and a priced receipt starts clean
			mv(A, -1, "build_consume", 100, { type: "build", id: 3 }),
			mv(OUT, 1, "build_output", 100, { type: "build", id: 3 }),
		];
		const { builds, costs } = replayAverageCosts(moves);
		expect(builds.get(1)?.incomplete).toBe(true);
		expect(builds.get(2)?.incomplete).toBe(true);
		expect(builds.get(3)?.incomplete).toBe(false);
		expect(costs.get(A)?.incomplete).toBe(false);
	});

	it("keeps exact values over many fractional moves (no drift)", () => {
		// 1/3 of a unit at a time: values stay integers and add back up exactly.
		const moves: LedgerMove[] = [{ ...mv(A, 0, "receipt", 100), qtyMilli: 3000 }];
		for (let i = 0; i < 9; i++) moves.push({ ...mv(A, 0, "build_consume", 100), qtyMilli: -333 });
		const c = replayAverageCosts(moves).costs.get(A)!;
		expect(c.qtyMilli).toBe(3);
		expect(Number.isInteger(c.valueMillicents)).toBe(true);
		expect(c.valueMillicents).toBe(300);
	});
});

describe("standard cost on a date", () => {
	const history = [
		{ partId: 1, priceCents: 100, validFrom: "2026-01-10" },
		{ partId: 1, priceCents: 120, validFrom: "2026-03-01" },
		{ partId: 2, priceCents: 50, validFrom: "2026-05-01" },
	];
	const current = [
		{ id: 1, costCents: 120 },
		{ id: 2, costCents: 50 },
		{ id: 3, costCents: null },
	];

	it("uses the latest change on or before the date", () => {
		expect(resolveCostsAt(history, current, "2026-02-15").costs.get(1)).toBe(100);
		expect(resolveCostsAt(history, current, "2026-03-01").costs.get(1)).toBe(120);
	});

	it("falls back to the first known cost before the history starts, and says so", () => {
		const r = resolveCostsAt(history, current, "2026-02-15");
		expect(r.costs.get(2)).toBe(50);
		expect(r.fallback.has(2)).toBe(true);
		expect(r.fallback.has(1)).toBe(false);
		// No history at all: the current (unknown) cost, not flagged.
		expect(r.costs.get(3)).toBeNull();
		expect(r.fallback.has(3)).toBe(false);
	});
});

describe("exact ratios", () => {
	it("multiplies and divides big integers exactly, rounding half away from zero", () => {
		expect(mulDivRound(9_007_199_254, 1_000_000, 3)).toBe(3_002_399_751_333_333);
		expect(mulDivRound(5, 1, 2)).toBe(3);
		expect(mulDivRound(-5, 1, 2)).toBe(-3);
	});

	it("expresses margins in basis points and formats them", () => {
		expect(basisPoints(5117, 8900)).toBe(5749);
		expect(basisPoints(1, 0)).toBeNull();
		expect(formatPercent(5749)).toBe("57.5 %");
		expect(formatPercent(5749, "fr")).toBe("57,5 %");
	});
});
