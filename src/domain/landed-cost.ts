// Landed cost (D201–D203): the charges of a purchase order (shipping, customs and duties, less a discount) spread over
// its lines, so that receipts enter stock at the line price plus the line's share. Pure: the caller passes the PO and
// its lines; amounts are integer cents, quantities integer thousandths, intermediate products BigInt (exact).
import type { ChargeSpread } from "../db/schema";
import { MILLI, mulDivRound } from "../lib/units";

export type PoCharges = {
	shippingCents: number;
	dutiesCents: number;
	discountCents: number;
	chargesSpread: ChargeSpread;
};

export type SpreadLine = { id: number; qtyMilli: number; unitPriceCents: number };

/** A line's part of the charges: its share in cents and the unit cost its receipts enter stock at. */
export type LineCharge = { shareCents: number; landedUnitCents: number };

/** Net charges of a PO in cents: shipping + duties − discount (negative when the discount is the larger). */
export const netChargesCents = (po: PoCharges): number => po.shippingCents + po.dutiesCents - po.discountCents;

/** Whether receipts of this PO enter stock at a landed cost that differs from the line prices. */
export const spreadsCharges = (po: PoCharges): boolean => po.chargesSpread !== "none" && netChargesCents(po) !== 0;

/**
 * Splits `totalCents` in proportion to `weights` (≥ 0), in whole cents that add up exactly to the total: each part
 * is rounded down, then the cents left go one each to the largest remainders, ties to the earlier weight (largest
 * remainder method). A negative total is split as its absolute value. All weights zero: all parts zero.
 */
export function apportion(totalCents: number, weights: readonly bigint[]): number[] {
	const sum = weights.reduce((s, w) => s + w, 0n);
	if (sum <= 0n || totalCents === 0) return weights.map(() => 0);
	const sign = totalCents < 0 ? -1 : 1;
	const total = BigInt(Math.abs(totalCents));
	const parts = weights.map((w, i) => ({ i, floor: (total * w) / sum, rest: (total * w) % sum }));
	let left = total - parts.reduce((s, p) => s + p.floor, 0n);
	const byRest = [...parts].sort((a, b) => (a.rest === b.rest ? a.i - b.i : a.rest > b.rest ? -1 : 1));
	const out = parts.map((p) => p.floor);
	for (const p of byRest) {
		if (left <= 0n) break;
		out[p.i] = (out[p.i] ?? 0n) + 1n;
		left -= 1n;
	}
	return out.map((c) => sign * Number(c));
}

/**
 * The share of the PO's net charges each line takes, and its landed unit cost (D202): in proportion to the ordered
 * line value (quantity × price) by default, to the ordered quantity with `qty` (also when every line is worth 0), and
 * nothing with `none`. The shares add up exactly to the net charges; the unit cost is the price plus the share per
 * ordered unit, rounded to the cent and never below zero. Lines are taken in id order, so the same PO always gives
 * the same costs.
 */
export function spreadCharges(po: PoCharges, lines: readonly SpreadLine[]): Map<number, LineCharge> {
	const sorted = [...lines].sort((a, b) => a.id - b.id);
	const net = netChargesCents(po);
	const result = new Map<number, LineCharge>();
	if (!spreadsCharges(po) || sorted.length === 0) {
		for (const l of sorted) result.set(l.id, { shareCents: 0, landedUnitCents: l.unitPriceCents });
		return result;
	}
	const byValue = sorted.map((l) => BigInt(l.qtyMilli) * BigInt(l.unitPriceCents));
	const byQty = sorted.map((l) => BigInt(l.qtyMilli));
	const weights = po.chargesSpread === "value" && byValue.some((w) => w > 0n) ? byValue : byQty;
	const shares = apportion(net, weights);
	sorted.forEach((l, i) => {
		const share = shares[i] ?? 0;
		const perUnit = l.qtyMilli > 0 ? mulDivRound(share, MILLI, l.qtyMilli) : 0;
		result.set(l.id, { shareCents: share, landedUnitCents: Math.max(0, l.unitPriceCents + perUnit) });
	});
	return result;
}
