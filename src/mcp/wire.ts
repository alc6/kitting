// MCP results on the wire (D120): tools shape their data with the app's integer fields (`*Milli` quantities,
// `*Cents` amounts), cost redaction runs on that shape (redactCosts matches those names), and only then is it
// turned into decimals with snake_case keys: `onHandMilli: 1500` → `on_hand: "1.5"`, `unitCostCents: 1230` →
// `unit_cost: "12.30"`. When the user may not see costs, amounts are dropped (not shown as null, which means
// "unknown cost") and the result says `costs_hidden: true`.
import { centsOf } from "../domain/assembly-graph";
import { type Access, redactCosts } from "../domain/permissions";
import { formatCentsInput, formatQtyInput } from "../lib/units";

const snake = (key: string) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/**
 * Keys whose value is an option name → value name record (D193): `options: {"Colour": "white"}`, and a line's
 * `fixed: {"Colour": "white"}`. The names are the workshop's own words, so they are copied as they are (snake-casing
 * would turn `Colour` into `_colour`). Arrays under the same key (a part's option definitions) still convert.
 */
const NAME_RECORDS = new Set(["options", "fixed"]);
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Integer field suffixes, most specific first: the decimal key, whether it is money, and how to format it. */
const SUFFIXES: { suffix: string; money: boolean; format: (n: number) => string }[] = [
	{ suffix: "Millicents", money: true, format: (n) => formatCentsInput(centsOf(n)) },
	{ suffix: "Cents", money: true, format: (n) => formatCentsInput(n) },
	{ suffix: "Milli", money: false, format: (n) => formatQtyInput(n) },
];

/** `rateBp` (basis points) → `rate_pct` ("38.25"). */
const RATE = { key: "rateBp", wire: "rate_pct", format: (n: number) => formatCentsInput(n) };

function convert(value: unknown, hideCosts: boolean): unknown {
	if (Array.isArray(value)) return value.map((v) => convert(v, hideCosts));
	if (value === null || typeof value !== "object") return value;
	const out: Record<string, unknown> = {};
	for (const [key, v] of Object.entries(value)) {
		const field = SUFFIXES.find((s) => key.length > s.suffix.length && key.endsWith(s.suffix));
		if (field) {
			if (field.money && hideCosts) continue;
			out[snake(key.slice(0, -field.suffix.length))] = typeof v === "number" ? field.format(v) : v;
		} else if (key === RATE.key) {
			if (!hideCosts) out[RATE.wire] = typeof v === "number" ? RATE.format(v) : v;
		} else if (NAME_RECORDS.has(key) && isRecord(v)) out[key] = v;
		else out[snake(key)] = convert(v, hideCosts);
	}
	return out;
}

/** A tool's data, redacted for this user, as decimals with snake_case keys. */
export function toWire(access: Access, data: Record<string, unknown>): Record<string, unknown> {
	const redacted = redactCosts(access, data);
	const wire = convert(redacted, !access.seeCosts) as Record<string, unknown>;
	return access.seeCosts ? wire : { ...wire, costs_hidden: true };
}
