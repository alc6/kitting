// Weighted average cost (PMP, "prix moyen pondéré"), computed by replaying the stock ledger. Pure: the
// caller loads the moves, in ledger order (at, then id: a build's consume moves come before its output
// move in the same batch, D62).
//
// Each part keeps a running quantity and a running value in millicents (qty_milli × cents), so nothing
// is rounded until a value leaves the stock. Rules (D91):
// - a receipt enters at its PO price; into empty or negative stock it resets the average;
// - a build output enters at the average value of what the build consumed, plus its fees;
// - other entries (counts, adjustments, initial stock) enter at the current average; with no stock to
//   average, at the move's recorded unit cost, else at the part's standard cost (roll-up for make parts,
//   passed in by the caller), else the part is flagged incomplete;
// - every exit (consumption, negative adjustment or count) leaves at the current average.
import type { MoveReason } from "../db/schema";
import { MILLI, mulDivRound, roundDiv } from "../lib/units";

export type LedgerMove = {
	partId: number;
	qtyMilli: number;
	reason: MoveReason;
	refType: string | null;
	refId: number | null;
	/** Unit cost recorded on the move (PO price for receipts, standard cost otherwise). */
	unitCostCents: number | null;
};

export type AverageCost = {
	qtyMilli: number;
	/** Value of the on-hand quantity, in millicents (qty_milli × cents). */
	valueMillicents: number;
	/** Some entry had no known cost: the value is understated. */
	incomplete: boolean;
};

export type BuildCost = { qtyMilli: number; valueMillicents: number; incomplete: boolean };

/** Average unit cost in cents (null without stock). */
export function averageUnitCents(a: AverageCost): number | null {
	return a.qtyMilli > 0 ? roundDiv(a.valueMillicents, a.qtyMilli) : null;
}

/**
 * @param standardMillicents per part, unit standard cost in millicents (make parts at their roll-up), for
 *   entries into empty stock that recorded no cost; parts whose standard cost is incomplete are omitted.
 */
export function replayAverageCosts(moves: LedgerMove[], standardMillicents: Map<number, number> = new Map()) {
	// `incomplete` = the value on hand includes units of unknown cost; `last*` = the last positive stock,
	// used to value exits from empty or negative stock.
	type PartState = AverageCost & { lastQty: number; lastValue: number; lastIncomplete: boolean };
	const parts = new Map<number, PartState>();
	// Per build: value of its consumption at average cost, and at the costs recorded on the moves.
	const consumed = new Map<number, { average: number; recorded: number; incomplete: boolean }>();
	const builds = new Map<number, BuildCost>();

	const state = (partId: number) => {
		let s = parts.get(partId);
		if (!s) {
			s = { qtyMilli: 0, valueMillicents: 0, incomplete: false, lastQty: 0, lastValue: 0, lastIncomplete: false };
			parts.set(partId, s);
		}
		return s;
	};
	/** Value of `qty` units at the current average (or the last known one when out of stock). */
	const atAverage = (s: PartState, qty: number): number | null => {
		if (s.qtyMilli > 0) return mulDivRound(s.valueMillicents, qty, s.qtyMilli);
		if (s.lastQty > 0) return mulDivRound(s.lastValue, qty, s.lastQty);
		return null;
	};
	const recordedValue = (m: LedgerMove, qty: number) => (m.unitCostCents === null ? null : qty * m.unitCostCents);

	for (const m of moves) {
		const s = state(m.partId);
		const qty = m.qtyMilli;
		if (qty > 0) {
			let value: number | null;
			if (m.reason === "receipt") {
				value = recordedValue(m, qty);
			} else if (m.reason === "build_output" && m.refType === "build" && m.refId !== null) {
				const c = consumed.get(m.refId) ?? { average: 0, recorded: 0, incomplete: false };
				// Fees are not stocked: they are what the recorded output value adds to the recorded consumption.
				const fees = Math.max(0, (recordedValue(m, qty) ?? c.recorded) - c.recorded);
				value = c.average + fees;
				if (c.incomplete) s.incomplete = true;
				builds.set(m.refId, { qtyMilli: qty, valueMillicents: value, incomplete: c.incomplete });
			} else if (s.qtyMilli > 0) {
				value = atAverage(s, qty);
			} else {
				const standard = standardMillicents.get(m.partId);
				value = recordedValue(m, qty) ?? (standard === undefined ? null : mulDivRound(qty, standard, MILLI));
			}
			const unknown = value === null;
			const known = value ?? 0;
			const resets = m.reason === "receipt" && s.qtyMilli <= 0;
			s.qtyMilli += qty;
			// A receipt into empty or negative stock values everything on hand at its price.
			s.valueMillicents = resets ? mulDivRound(known, s.qtyMilli, qty) : s.valueMillicents + known;
			s.incomplete = resets ? unknown : s.incomplete || unknown;
		} else if (qty < 0) {
			const out = atAverage(s, -qty);
			// What leaves is understated if the average it leaves at includes units of unknown cost.
			const tainted = out === null || (s.qtyMilli > 0 ? s.incomplete : s.lastIncomplete);
			if (out === null) s.incomplete = true;
			const value = out ?? 0;
			s.qtyMilli += qty;
			s.valueMillicents -= value;
			if (m.reason === "build_consume" && m.refType === "build" && m.refId !== null) {
				const c = consumed.get(m.refId) ?? { average: 0, recorded: 0, incomplete: false };
				c.average += value;
				c.recorded += recordedValue(m, -qty) ?? value;
				if (tainted) c.incomplete = true;
				consumed.set(m.refId, c);
			}
		}
		if (s.qtyMilli > 0) {
			s.lastQty = s.qtyMilli;
			s.lastValue = s.valueMillicents;
			s.lastIncomplete = s.incomplete;
		} else if (s.qtyMilli === 0) {
			// Nothing left: a zero value is exact.
			s.valueMillicents = 0;
			s.incomplete = false;
		}
	}

	const costs = new Map<number, AverageCost>();
	for (const [partId, s] of parts)
		costs.set(partId, { qtyMilli: s.qtyMilli, valueMillicents: s.valueMillicents, incomplete: s.incomplete });
	return { costs, builds };
}

/** Unit cost of a build's output at average cost, in cents (null when unknown). */
export function buildUnitCents(b: BuildCost | undefined): number | null {
	return b && b.qtyMilli > 0 ? roundDiv(b.valueMillicents, b.qtyMilli) : null;
}

/** Value in cents of a millicent amount. */
export const centsOfMillicents = (v: number): number => roundDiv(v, MILLI);
