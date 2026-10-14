// Integer fixed-point helpers. Quantities are thousandths (`*_milli`), money is cents.
// Never use floats for stored values: parse and format through these functions only.

export const MILLI = 1000;

const SPACES = /[\s\u00a0\u202f]/g;

/**
 * Parses a decimal string into an integer scaled by 10^scale.
 * Accepts "." or "," as the decimal separator and spaces as thousands separators
 * ("1 234,5"). Returns null when the input is not a number or has more significant
 * decimals than `scale`.
 */
export function parseScaled(input: string, scale: number): number | null {
	const s = input.replace(SPACES, "");
	const m = /^([+-]?)(\d*)(?:[.,](\d*))?$/.exec(s);
	if (!m) return null;
	const sign = m[1] ?? "";
	const whole = m[2] ?? "";
	const frac = m[3] ?? "";
	if (whole === "" && frac === "") return null;
	if (frac.length > scale && /[^0]/.test(frac.slice(scale))) return null;
	const digits = `${whole || "0"}${frac.slice(0, scale).padEnd(scale, "0")}`;
	const n = Number(digits);
	if (!Number.isSafeInteger(n)) return null;
	return sign === "-" && n !== 0 ? -n : n;
}

export const parseMilli = (input: string): number | null => parseScaled(input, 3);
export const parseCents = (input: string): number | null => parseScaled(input, 2);

export type NumberLocale = "en" | "fr";

const SEPARATORS: Record<NumberLocale, { decimal: string; group: string }> = {
	en: { decimal: ".", group: "," },
	fr: { decimal: ",", group: "\u202f" },
};

function groupThousands(whole: string, sep: string): string {
	return whole.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
}

/** Formats a scaled integer. Trailing zeros beyond `minDecimals` are dropped. */
export function formatScaled(
	value: number,
	scale: number,
	opts: { locale?: NumberLocale; minDecimals?: number; group?: boolean } = {},
): string {
	const { decimal, group } = SEPARATORS[opts.locale ?? "en"];
	const minDecimals = opts.minDecimals ?? 0;
	const neg = value < 0;
	const digits = Math.abs(Math.trunc(value))
		.toString()
		.padStart(scale + 1, "0");
	const whole = digits.slice(0, digits.length - scale);
	let frac = digits.slice(digits.length - scale);
	while (frac.length > minDecimals && frac.endsWith("0")) frac = frac.slice(0, -1);
	const w = opts.group === false ? whole : groupThousands(whole, group);
	return `${neg ? "-" : ""}${w}${frac ? decimal + frac : ""}`;
}

/** 1500 -> "1.5" (en) / "1,5" (fr). */
export const formatQty = (milli: number, locale: NumberLocale = "en"): string =>
	formatScaled(milli, 3, { locale, group: true });

/** Plain machine-friendly quantity for form inputs and CSV ("1.5" or "1,5", no grouping). */
export const formatQtyInput = (milli: number, locale: NumberLocale = "en"): string =>
	formatScaled(milli, 3, { locale, group: false });

/** 123456 -> "1,234.56" (en) / "1 234,56" (fr). */
export const formatCents = (cents: number, locale: NumberLocale = "en"): string =>
	formatScaled(cents, 2, { locale, minDecimals: 2, group: true });

export const formatCentsInput = (cents: number, locale: NumberLocale = "en"): string =>
	formatScaled(cents, 2, { locale, minDecimals: 2, group: false });

const CURRENCY_SYMBOLS: Record<string, string> = { EUR: "€", USD: "$", GBP: "£", CHF: "CHF" };

/** Money with currency: "€1,234.56" (en) / "1 234,56 €" (fr). */
export function formatMoney(cents: number, locale: NumberLocale = "en", currency = "EUR"): string {
	const symbol = CURRENCY_SYMBOLS[currency] ?? currency;
	const amount = formatCents(Math.abs(cents), locale);
	const sign = cents < 0 ? "-" : "";
	return locale === "fr" ? `${sign}${amount}\u00a0${symbol}` : `${sign}${symbol}${amount}`;
}

/**
 * Cost of `qtyMilli` units at `unitCents` per unit, in cents, rounded half away from zero.
 * qty_milli * cents is an exact integer number of millicents.
 */
export function lineCostCents(qtyMilli: number, unitCents: number): number {
	return roundDiv(qtyMilli * unitCents, MILLI);
}

/** Integer division rounded half away from zero. */
export function roundDiv(numerator: number, denominator: number): number {
	const q = Math.trunc(numerator / denominator);
	const r = numerator - q * denominator;
	if (Math.abs(r) * 2 >= Math.abs(denominator)) return q + Math.sign(numerator) * Math.sign(denominator);
	return q;
}

/** Integer division rounded up (for quantities: never under-order or under-pick). */
export function ceilDiv(numerator: number, denominator: number): number {
	return -Math.floor(-numerator / denominator);
}

/** Scales a per-unit quantity by a number of units: (qtyMilli/1000) * (unitsMilli/1000), in milli, rounded up. */
export function mulMilli(qtyMilli: number, unitsMilli: number): number {
	return ceilDiv(qtyMilli * unitsMilli, MILLI);
}

/** Rounds a requirement up to the minimum order quantity and pack size (all milli). */
export function roundOrderQty(needMilli: number, moqMilli: number, packSizeMilli: number): number {
	if (needMilli <= 0) return 0;
	let qty = Math.max(needMilli, moqMilli);
	if (packSizeMilli > 0) qty = ceilDiv(qty, packSizeMilli) * packSizeMilli;
	return qty;
}

/** Parses booleans from forms and CSV: yes/no, true/false, 1/0, oui/non, x. Empty -> false. */
export function parseBool(input: string): boolean | null {
	const v = input.trim().toLowerCase();
	if (["", "0", "no", "n", "false", "non", "f"].includes(v)) return false;
	if (["1", "yes", "y", "true", "oui", "o", "x", "on", "t"].includes(v)) return true;
	return null;
}

/** round(a × b / c) half away from zero, exact for large values (BigInt intermediate). */
export function mulDivRound(a: number, b: number, c: number): number {
	const n = BigInt(a) * BigInt(b);
	const d = BigInt(c);
	const q = n / d;
	const r = n - q * d;
	const abs = (x: bigint) => (x < 0n ? -x : x);
	if (abs(r) * 2n >= abs(d)) return Number(q + (n < 0n !== d < 0n ? -1n : 1n));
	return Number(q);
}

/** ceil(a × b / c) for positive c, exact for large values (BigInt intermediate): quantities never round down. */
export function mulDivCeil(a: number, b: number, c: number): number {
	const n = BigInt(a) * BigInt(b);
	const d = BigInt(c);
	const q = n / d;
	return Number(n % d !== 0n && n > 0n === d > 0n ? q + 1n : q);
}

/** A ratio in basis points (1 % = 100): numerator / denominator × 10 000, rounded; null when undefined. */
export function basisPoints(numerator: number, denominator: number): number | null {
	return denominator === 0 ? null : mulDivRound(numerator, 10_000, denominator);
}

/** 3825 -> "38.3 %" (en) / "38,3 %" (fr). */
export function formatPercent(bp: number, locale: NumberLocale = "en"): string {
	return `${formatScaled(roundDiv(bp, 10), 1, { locale, minDecimals: 1, group: true })} %`;
}
