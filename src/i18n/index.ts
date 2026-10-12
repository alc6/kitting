import { type Dict, en } from "./en";
import { fr } from "./fr";

export type { Dict };
export const LOCALES = ["en", "fr"] as const;
export type Locale = (typeof LOCALES)[number];

const DICTS: Record<Locale, Dict> = { en, fr };

export function isLocale(value: unknown): value is Locale {
	return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

export function dict(locale: Locale): Dict {
	return DICTS[locale];
}

/** Fills {placeholders}: fmt("{n} parts", { n: 3 }) -> "3 parts". */
export function fmt(template: string, vars: Record<string, string | number>): string {
	return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in vars ? String(vars[key]) : match));
}

/** Translates a validation error key (see Dict.errors), falling back to the generic message. */
export function errorText(t: Dict, key: string, vars: Record<string, string | number> = {}): string {
	const template = (t.errors as Record<string, string>)[key];
	return fmt(template ?? t.errors.invalid, vars);
}
