import { describe, expect, it } from "vitest";
import { apportion, netChargesCents, type PoCharges, spreadCharges, spreadsCharges } from "../src/domain/landed-cost";

const po = (c: Partial<PoCharges>): PoCharges => ({
	shippingCents: 0,
	dutiesCents: 0,
	discountCents: 0,
	chargesSpread: "value",
	...c,
});

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

describe("apportion (largest remainder)", () => {
	it("splits in proportion, in whole cents that add up exactly to the total", () => {
		expect(apportion(100, [1n, 1n, 1n])).toEqual([34, 33, 33]);
		expect(apportion(1000, [1n, 2n, 3n, 4n])).toEqual([100, 200, 300, 400]);
		for (const total of [1, 7, 99, 73588, 1_000_003])
			for (const weights of [[3n, 5n, 7n], [1n], [10n, 0n, 1n], [999n, 1n, 1n, 1n]])
				expect(sum(apportion(total, weights)), `${total} over ${weights}`).toBe(total);
	});

	it("gives the cents left to the largest remainders, ties to the earlier weight", () => {
		// 10 × 1/3 = 3.33 each: one cent left, to the first.
		expect(apportion(10, [1n, 1n, 1n])).toEqual([4, 3, 3]);
		// 10 × (1/6, 2/6, 3/6) = 1.67, 3.33, 5: the cent goes to the largest remainder (0.67), not to the first line.
		expect(apportion(10, [1n, 2n, 3n])).toEqual([2, 3, 5]);
	});

	it("splits a negative total (a discount larger than the charges) as its absolute value", () => {
		expect(apportion(-10, [1n, 1n, 1n])).toEqual([-4, -3, -3]);
		expect(sum(apportion(-630, [96570n, 1n]))).toBe(-630);
	});

	it("gives nothing without weights or without a total", () => {
		expect(apportion(100, [0n, 0n])).toEqual([0, 0]);
		expect(apportion(0, [1n, 2n])).toEqual([0, 0]);
		expect(apportion(100, [])).toEqual([]);
	});

	it("stays exact on amounts whose products exceed 2^53", () => {
		// 10 000 000 units at 9 999 999.99: weights near 10^17, products near 10^26.
		const big = 10_000_000_000n * 999_999_999n;
		const parts = apportion(999_999_999, [big, big, 1n]);
		expect(sum(parts)).toBe(999_999_999);
		expect(parts).toEqual([500_000_000, 499_999_999, 0]);
	});
});

describe("spreadCharges (landed cost, D202)", () => {
	// A sheet-metal order: parts 965.70 on two lines, shipping 742.18 (nearly as much), a discount of 6.30.
	const lines = [
		{ id: 1, qtyMilli: 4_000, unitPriceCents: 18_000 }, // 4 chassis at 180.00 = 720.00
		{ id: 2, qtyMilli: 7_000, unitPriceCents: 3_510 }, // 7 doors at 35.10 = 245.70
	];
	const order = po({ shippingCents: 74_218, discountCents: 630 });

	it("spreads the net charges over the lines by value, shares adding up exactly", () => {
		expect(netChargesCents(order)).toBe(73_588);
		const spread = spreadCharges(order, lines);
		const shares = [...spread.values()].map((l) => l.shareCents);
		expect(sum(shares)).toBe(73_588);
		// 73 588 × 720.00 / 965.70 = 54 865.2… and × 245.70 / 965.70 = 18 722.8…: the cent left to the second.
		expect(spread.get(1)).toEqual({ shareCents: 54_865, landedUnitCents: 18_000 + 13_716 });
		expect(spread.get(2)).toEqual({ shareCents: 18_723, landedUnitCents: 3_510 + 2_675 });
	});

	it("spreads by quantity on request, and when every line is worth nothing", () => {
		const byQty = spreadCharges({ ...order, chargesSpread: "qty" }, lines);
		// 73 588 × 4/11 = 26 759.3…, × 7/11 = 46 828.7…
		expect(byQty.get(1)?.shareCents).toBe(26_759);
		expect(byQty.get(2)?.shareCents).toBe(46_829);
		const free = spreadCharges(
			po({ shippingCents: 1_000 }),
			lines.map((l) => ({ ...l, unitPriceCents: 0 })),
		);
		expect([...free.values()].map((l) => l.shareCents)).toEqual([364, 636]);
	});

	it("leaves the line prices alone when not spreading or without charges", () => {
		for (const p of [po({ ...order, chargesSpread: "none" }), po({}), po({ shippingCents: 500, discountCents: 500 })]) {
			expect(spreadsCharges(p)).toBe(false);
			expect(spreadCharges(p, lines).get(1)).toEqual({ shareCents: 0, landedUnitCents: 18_000 });
		}
	});

	it("rounds the share per unit to the cent and never goes below zero", () => {
		// 1.00 over 7 units: 14.29 ¢ a unit, rounded to 14 ¢.
		expect(spreadCharges(po({ shippingCents: 100 }), [{ id: 1, qtyMilli: 7_000, unitPriceCents: 50 }]).get(1)).toEqual({
			shareCents: 100,
			landedUnitCents: 64,
		});
		// Fractional quantities: 2.5 m of cable taking 1.00 adds 0.40 a metre.
		expect(
			spreadCharges(po({ shippingCents: 100 }), [{ id: 1, qtyMilli: 2_500, unitPriceCents: 200 }]).get(1)
				?.landedUnitCents,
		).toBe(240);
		// A discount larger than a cheap line's value would make its cost negative: it stops at zero.
		const discounted = spreadCharges(po({ discountCents: 300, chargesSpread: "qty" }), [
			{ id: 1, qtyMilli: 1_000, unitPriceCents: 100 },
			{ id: 2, qtyMilli: 1_000, unitPriceCents: 1_000 },
		]);
		expect(discounted.get(1)).toEqual({ shareCents: -150, landedUnitCents: 0 });
		expect(discounted.get(2)).toEqual({ shareCents: -150, landedUnitCents: 850 });
	});

	it("gives the same result whatever the order the lines come in", () => {
		const reversed = spreadCharges(order, [...lines].reverse());
		expect([...reversed.entries()].sort(([a], [b]) => a - b)).toEqual([...spreadCharges(order, lines).entries()]);
		expect(
			spreadCharges(
				po({ shippingCents: 10 }),
				[3, 1, 2].map((id) => ({ id, qtyMilli: 1_000, unitPriceCents: 100 })),
			).get(1)?.shareCents,
		).toBe(4);
	});
});
