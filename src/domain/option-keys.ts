// Option keys (D184): which values of a part's options a record holds. Pure functions, no database.
// A key lists value ids in ascending order, comma-separated ("12,31"); null is a part without options (or a record
// from before its options). Value ids are global, so a key also says which options it covers.

export type OptionValueDef = { id: number; name: string; isDefault: boolean };
/** An option of a part with its values, in order. */
export type OptionDef = { id: number; name: string; values: OptionValueDef[] };
export type OptionKey = string | null;

/** The key of a set of value ids (null when empty). */
export function keyOf(ids: Iterable<number>): OptionKey {
	const sorted = [...new Set(ids)].sort((a, b) => a - b);
	return sorted.length ? sorted.join(",") : null;
}

/** The value ids of a key. */
export function idsOf(key: OptionKey | undefined): number[] {
	if (!key) return [];
	return key
		.split(",")
		.map(Number)
		.filter((n) => Number.isInteger(n) && n > 0);
}

/** Map key of a part's stock in some values: "7" without options, "7:12,31" with. */
export function stockKey(partId: number, key: OptionKey | undefined): string {
	return key ? `${partId}:${key}` : String(partId);
}

export function splitStockKey(s: string): { partId: number; key: OptionKey } {
	const i = s.indexOf(":");
	return i < 0 ? { partId: Number(s), key: null } : { partId: Number(s.slice(0, i)), key: s.slice(i + 1) || null };
}

/** Options and values match across parts by name, ignoring case and surrounding spaces (D185). */
export const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
export const nameKey = (s: string) => s.trim().toLowerCase();

/** The default value of an option (its first value when none is marked, which the forms prevent). */
export const defaultValue = (option: OptionDef): OptionValueDef | undefined =>
	option.values.find((v) => v.isDefault) ?? option.values[0];

/** The default values of every option. */
export function defaultIds(options: OptionDef[]): number[] {
	return options.flatMap((o) => {
		const v = defaultValue(o);
		return v ? [v.id] : [];
	});
}

export const defaultKey = (options: OptionDef[]): OptionKey => keyOf(defaultIds(options));

/** The value an option takes in a set of value ids. */
export const valueIn = (option: OptionDef, ids: number[]): OptionValueDef | undefined =>
	option.values.find((v) => ids.includes(v.id));

/** True when the ids hold exactly one value of each option and nothing else. */
export function isCompleteKey(options: OptionDef[], ids: number[]): boolean {
	const known = new Set(options.flatMap((o) => o.values.map((v) => v.id)));
	return (
		ids.every((id) => known.has(id)) && options.every((o) => o.values.filter((v) => ids.includes(v.id)).length === 1)
	);
}

/** The option and value names of a key, in the options' order. Unknown ids show as "#id". */
export function keyPairs(options: OptionDef[], key: OptionKey | undefined): { option: string; value: string }[] {
	const ids = idsOf(key);
	const pairs: { option: string; value: string }[] = [];
	const seen = new Set<number>();
	for (const o of options) {
		const v = valueIn(o, ids);
		if (v) {
			pairs.push({ option: o.name, value: v.name });
			seen.add(v.id);
		}
	}
	for (const id of ids) if (!seen.has(id)) pairs.push({ option: "", value: `#${id}` });
	return pairs;
}

/** "Colour: white · Size: L" (empty without options). */
export function keyLabel(options: OptionDef[], key: OptionKey | undefined): string {
	return keyPairs(options, key)
		.map((p) => (p.option ? `${p.option}: ${p.value}` : p.value))
		.join(" · ");
}

/** The values only: "white · L". */
export function keyValues(options: OptionDef[], key: OptionKey | undefined): string {
	return keyPairs(options, key)
		.map((p) => p.value)
		.join(" · ");
}

/** Option name → value name, the form MCP tools return and take (D193). */
export function keyRecord(options: OptionDef[], key: OptionKey | undefined): Record<string, string> {
	return Object.fromEntries(keyPairs(options, key).map((p) => [p.option, p.value]));
}

// ---------------------------------------------------------------------------
// Text form, for CSV files (D192): "Colour=white|Size=L"; "white" alone when the part has one option. "*" is a value
// chosen per build in a recipe line (assemblies.csv).

export const OPTIONS_SEPARATOR = "|";
export const CHOSEN_MARK = "*";
/** Characters an option or value name may not contain: the text form's syntax. */
export const RESERVED_NAME = /[=|*]/;

export function keyText(options: OptionDef[], key: OptionKey | undefined): string {
	return keyPairs(options, key)
		.map((p) => `${p.option}=${p.value}`)
		.join(OPTIONS_SEPARATOR);
}

export type OptionIssue = { key: string; vars?: Record<string, string> };

/**
 * Value ids from option name → value name pairs (the text form or an MCP record). Errors name what is wrong: an option
 * the part does not have, a value its option does not have, the same option twice. Completeness is the caller's rule.
 */
export function idsFromPairs(
	options: OptionDef[],
	pairs: [string, string][],
	opts: { chosen?: boolean } = {},
): { ids: number[]; chosen: number[]; issue?: OptionIssue } {
	const ids: number[] = [];
	const chosen: number[] = [];
	const seen = new Set<number>();
	for (const [optionName, valueName] of pairs) {
		const option = options.find((o) => sameName(o.name, optionName));
		if (!option) return { ids, chosen, issue: { key: "option_unknown", vars: { option: optionName } } };
		if (seen.has(option.id)) return { ids, chosen, issue: { key: "option_twice", vars: { option: option.name } } };
		seen.add(option.id);
		if (opts.chosen && valueName.trim() === CHOSEN_MARK) {
			chosen.push(option.id);
			continue;
		}
		const value = option.values.find((v) => sameName(v.name, valueName));
		if (!value)
			return { ids, chosen, issue: { key: "option_value_unknown", vars: { option: option.name, value: valueName } } };
		ids.push(value.id);
	}
	return { ids, chosen };
}

/** Parses the text form. A bare value is allowed for a part with exactly one option. */
export function parseKeyText(
	options: OptionDef[],
	text: string,
	opts: { chosen?: boolean } = {},
): { ids: number[]; chosen: number[]; issue?: OptionIssue } {
	const parts = text
		.split(OPTIONS_SEPARATOR)
		.map((s) => s.trim())
		.filter(Boolean);
	if (parts.length === 0) return { ids: [], chosen: [] };
	if (options.length === 0) return { ids: [], chosen: [], issue: { key: "options_none" } };
	const pairs: [string, string][] = [];
	for (const p of parts) {
		const eq = p.indexOf("=");
		if (eq >= 0) pairs.push([p.slice(0, eq).trim(), p.slice(eq + 1).trim()]);
		else if (options.length === 1 && parts.length === 1 && options[0]) pairs.push([options[0].name, p]);
		else return { ids: [], chosen: [], issue: { key: "options_syntax" } };
	}
	return idsFromPairs(options, pairs, opts);
}

/** The first option without a value in `ids`, as an issue (null when every option has one). */
export function missingValueIssue(options: OptionDef[], ids: number[]): OptionIssue | null {
	const missing = options.find((o) => !valueIn(o, ids));
	return missing ? { key: "option_value_required", vars: { option: missing.name } } : null;
}

/** Every combination of one value per option, in the options' and values' order (an inventory sheet's rows). */
export function combinations(options: OptionDef[]): number[][] {
	let out: number[][] = [[]];
	for (const o of options) out = out.flatMap((ids) => o.values.map((v) => [...ids, v.id]));
	return options.length ? out : [];
}
