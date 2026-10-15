// zod field builders shared by HTML forms and CSV import rows. Every value arrives as
// a string; issue messages are i18n keys from Dict.errors (translated by errorText()).
import { z } from "zod";
import { parseBool, parseCents, parseMilli, parseMinutes } from "./units";

const issue = (ctx: z.RefinementCtx, message: string) => {
	ctx.addIssue({ code: "custom", message });
	return z.NEVER;
};

export const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.\-/]*$/;

export const field = {
	text: (max = 2000) => z.string().trim().max(max, "too_long"),
	required: (max = 200) => z.string().trim().min(1, "required").max(max, "too_long"),
	ref: () =>
		z
			.string()
			.trim()
			.min(1, "required")
			.max(64, "too_long")
			.refine((v) => REF_PATTERN.test(v), "invalid_ref"),
	email: () =>
		z
			.string()
			.trim()
			.max(200, "too_long")
			.refine((v) => v === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), "invalid_email"),
	/** Quantity in milli. Empty -> `empty` (default 0). */
	qty: (opts: { positive?: boolean; empty?: number } = {}) =>
		z
			.string()
			.trim()
			.transform((v, ctx) => {
				if (v === "") return opts.empty ?? 0;
				const n = parseMilli(v);
				if (n === null) return issue(ctx, "invalid_quantity");
				if (opts.positive && n <= 0) return issue(ctx, "not_positive");
				if (!opts.positive && n < 0) return issue(ctx, "negative");
				return n;
			}),
	/** Optional quantity in milli, zero or more; empty -> null ("not set"). */
	optionalQty: () =>
		z
			.string()
			.trim()
			.transform((v, ctx): number | null => {
				if (v === "") return null;
				const n = parseMilli(v);
				if (n === null) return issue(ctx, "invalid_quantity");
				return n < 0 ? issue(ctx, "negative") : n;
			}),
	/** Signed quantity in milli (adjustments). Empty is an error. */
	signedQty: () =>
		z
			.string()
			.trim()
			.transform((v, ctx) => {
				if (v === "") return issue(ctx, "required");
				const n = parseMilli(v);
				return n === null ? issue(ctx, "invalid_quantity") : n;
			}),
	/** Money in cents; empty -> null ("unknown"). */
	money: () =>
		z
			.string()
			.trim()
			.transform((v, ctx): number | null => {
				if (v === "") return null;
				const n = parseCents(v);
				if (n === null) return issue(ctx, "invalid_money");
				if (n < 0) return issue(ctx, "negative");
				return n;
			}),
	/** Non-negative whole number; empty -> 0. */
	int: () =>
		z
			.string()
			.trim()
			.transform((v, ctx) => {
				if (v === "") return 0;
				if (!/^\d+$/.test(v)) return issue(ctx, "not_integer");
				const n = Number(v);
				return Number.isSafeInteger(n) ? n : issue(ctx, "invalid_number");
			}),
	bool: () =>
		z
			.string()
			.trim()
			.transform((v, ctx) => {
				const b = parseBool(v);
				return b === null ? issue(ctx, "invalid_bool") : b;
			}),
	/** Machine time in whole minutes ("3:10", "3h10", "190", see parseMinutes); empty -> 0. */
	duration: () =>
		z
			.string()
			.trim()
			.transform((v, ctx) => {
				if (v === "") return 0;
				const n = parseMinutes(v);
				return n === null ? issue(ctx, "invalid_duration") : n;
			}),
	/** Optional numeric id from a <select>; empty -> null. */
	id: () =>
		z
			.string()
			.trim()
			.transform((v, ctx): number | null => {
				if (v === "") return null;
				return /^\d+$/.test(v) ? Number(v) : issue(ctx, "invalid");
			}),
	/** Optional YYYY-MM-DD date; empty -> null. */
	date: () =>
		z
			.string()
			.trim()
			.transform((v, ctx): string | null => {
				if (v === "") return null;
				return /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) ? v : issue(ctx, "invalid_date");
			}),
	oneOf: <T extends string>(values: readonly T[], message = "invalid") =>
		z
			.string()
			.trim()
			.transform((v) => v.toLowerCase())
			.refine((v): v is T => (values as readonly string[]).includes(v), message)
			.transform((v) => v as T),
};

export type FieldErrors = Record<string, string>;
export type Validated<T> = { ok: true; data: T } | { ok: false; errors: FieldErrors };

/** Keeps only string values for the schema's keys; missing keys become "" (e.g. unchecked boxes). */
export function pickStrings(input: Record<string, unknown>, keys: string[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (const k of keys) {
		const v = input[k];
		out[k] = typeof v === "string" ? v : "";
	}
	return out;
}

/** Validates string input against an object schema; errors map field -> i18n key. */
export function validate<S extends z.ZodObject>(schema: S, input: Record<string, unknown>): Validated<z.output<S>> {
	const result = schema.safeParse(pickStrings(input, Object.keys(schema.shape)));
	if (result.success) return { ok: true, data: result.data };
	const errors: FieldErrors = {};
	for (const i of result.error.issues) {
		const key = String(i.path[0] ?? "_");
		if (!errors[key]) errors[key] = i.message;
	}
	return { ok: false, errors };
}
