// Part options over MCP (D193): `options` is an option name → value name record, `{"Colour": "white"}`, in the
// tools' inputs and results. The domain works with value ids and a text key (src/domain/option-keys.ts); this module
// turns the record into ids with refusals the model can act on (the option or value that is wrong, the values that
// exist), and back. Names match ignoring case and surrounding spaces, as everywhere (D185).
import { z } from "zod";
import type { LineOptions } from "../domain/assemblies";
import type { AssemblyGraph } from "../domain/assembly-graph";
import { buildValueProblems, chosenComponents, optionField, pickField, readBuildValues } from "../domain/builds";
import {
	defaultValue,
	idsFromPairs,
	idsOf,
	keyLabel,
	keyOf,
	keyRecord,
	missingValueIssue,
	type OptionDef,
	type OptionIssue,
	type OptionKey,
	sameName,
	valueIn,
} from "../domain/option-keys";
import { errorMessage, ToolError } from "./kit";

/** Option name → value name, as tools take it. */
export type OptionsArg = Record<string, string> | undefined;

/** The `options` input of a tool: what it is the values of, and what happens when it is left out. */
export const optionsInput = (
	what: string,
	rule = "Required, with a value for every option, when the part has options; leave out when it has none.",
) =>
	z
		.record(z.string().max(100), z.string().max(100))
		.optional()
		.describe(`Option name → value name of ${what}, e.g. {"Colour": "white"} (names are case-insensitive). ${rule}`);

/** A recipe line's rule for some options of its component (D186). */
export const fixedInput = z
	.record(z.string().max(100), z.string().max(100))
	.optional()
	.describe(
		'Option name → value name the line always takes, e.g. {"Colour": "black"}. An option named in neither fixed nor choose follows the build (the value of the same option name higher up).',
	);

export const chooseInput = z
	.array(z.string().max(100))
	.optional()
	.describe("Options of the component whose value is chosen when a build is planned (the build must give one).");

/** A choice of the values of a component whose recipe lines leave options to the build. */
export const choicesInput = z
	.array(
		z.object({
			ref: z.string().trim().min(1).max(64).describe("A component whose recipe lines leave options to the build."),
			options: z.record(z.string().max(100), z.string().max(100)).describe('e.g. {"Colour": "black"}'),
		}),
	)
	.max(100)
	.default([])
	.describe(
		"The values to make the components with, for the options a recipe line leaves to the build (get_assembly shows them as `choose`). One entry per component; every option it leaves to the build needs a value.",
	);

/** The record of a key, or undefined when the part has no options (so the field is left out). */
export function optionsView(defs: OptionDef[], key: OptionKey | undefined): Record<string, string> | undefined {
	const record = keyRecord(defs, key);
	return Object.keys(record).length ? record : undefined;
}

const valuesOf = (option: OptionDef) => option.values.map((v) => v.name).join(", ");

/** An option issue as a sentence naming what is wrong and, for a value, the values that exist. */
function issueText(defs: OptionDef[], issue: OptionIssue): string {
	const base = errorMessage(issue.key, issue.vars);
	const option = defs.find((o) => sameName(o.name, issue.vars?.option ?? ""));
	if (!option) return defs.length ? `${base} Options: ${defs.map((o) => o.name).join(", ")}.` : base;
	if (issue.key === "option_value_unknown") return `${base} Values: ${valuesOf(option)}.`;
	if (issue.key === "option_value_required") {
		const def = defaultValue(option);
		return `${base} Values: ${valuesOf(option)}${def ? ` (default ${def.name})` : ""}.`;
	}
	return base;
}

/** The value ids a record gives among a part's options. Refuses an unknown option or value; may be incomplete. */
export function valueIdsOf(defs: OptionDef[], given: OptionsArg, label: string): number[] {
	const pairs = Object.entries(given ?? {});
	if (pairs.length === 0) return [];
	if (defs.length === 0) throw new ToolError(`${label}: ${errorMessage("options_none")}`);
	const found = idsFromPairs(defs, pairs);
	if (found.issue) throw new ToolError(`${label}: ${issueText(defs, found.issue)}`);
	return found.ids;
}

/** The key of ids that must hold a value of every option (a record in some values). */
export function completeKey(defs: OptionDef[], ids: number[], label: string): OptionKey {
	const issue = missingValueIssue(defs, ids);
	if (issue) throw new ToolError(`${label}: ${issueText(defs, issue)}`);
	return keyOf(ids);
}

/** The key a tool's `options` stands for; with `require`, a value for every option (a part without options: null). */
export function resolveKey(defs: OptionDef[], given: OptionsArg, label: string, opts: { require: boolean }): OptionKey {
	const ids = valueIdsOf(defs, given, label);
	return opts.require ? completeKey(defs, ids, label) : keyOf(ids);
}

/**
 * The one record among `items` that `given` points at: those whose values include every value given. None: undefined.
 * Several (options left out or partial on a part that has records in several values): refused, naming them.
 */
export function selectByOptions<T>(
	items: T[],
	defs: OptionDef[],
	given: OptionsArg,
	keyOfItem: (item: T) => OptionKey,
	label: string,
): { item: T | undefined; ids: number[] } {
	const ids = valueIdsOf(defs, given, label);
	const matches = items.filter((i) => {
		const has = idsOf(keyOfItem(i));
		return ids.every((id) => has.includes(id));
	});
	if (matches.length > 1)
		throw new ToolError(
			`${label}: there are several, with options ${matches.map((m) => `(${keyLabel(defs, keyOfItem(m))})`).join(" or ")}. Give options to say which.`,
		);
	return { item: matches[0], ids };
}

// ---------------------------------------------------------------------------
// Builds

/**
 * The values of a build to plan, from the tool's inputs, through the build form's own reading (`option:<id>`,
 * `pick:<part>:<option>`) and checks (D185, D187). Every option of the product, and every option a recipe line
 * leaves to the build, needs a value. Refused with the reasons otherwise.
 */
export function readToolBuildValues(
	graph: AssemblyGraph,
	product: { id: number; ref: string },
	assemblyId: number,
	qtyMilli: number,
	given: { options?: OptionsArg; choices: { ref: string; options: Record<string, string> }[] },
) {
	const form: Record<string, string> = {};
	const defs = graph.parts.get(product.id)?.options ?? [];
	const ids = valueIdsOf(defs, given.options, `${product.ref} options`);
	completeKey(defs, ids, `${product.ref} options`);
	for (const o of defs) {
		const v = valueIn(o, ids);
		if (v) form[optionField(o.id)] = String(v.id);
	}
	const chosen = chosenComponents(graph, assemblyId);
	const used = new Set<number>();
	for (const choice of given.choices) {
		const label = `choices ${choice.ref}`;
		const c = chosen.find((x) => sameName(x.part.ref, choice.ref));
		if (!c)
			throw new ToolError(
				`${label}: no recipe line of this assembly leaves options of ${choice.ref} to the build. get_assembly shows the options a line chooses when planned (choose).`,
			);
		if (used.has(c.part.id)) throw new ToolError(`${label}: listed twice.`);
		used.add(c.part.id);
		const valueIds = valueIdsOf(c.part.options, choice.options, label);
		for (const id of valueIds) {
			const option = c.part.options.find((o) => o.values.some((v) => v.id === id));
			if (option && !c.options.some((o) => o.id === option.id))
				throw new ToolError(
					`${label}: ${option.name} is not left to the build in this assembly (a recipe line fixes it or follows the build). Options left to the build: ${c.options.map((o) => o.name).join(", ")}.`,
				);
		}
		completeKey(c.options, valueIds, label);
		for (const o of c.options) {
			const v = valueIn(o, valueIds);
			if (v) form[pickField(c.part.id, o.id)] = String(v.id);
		}
	}
	for (const c of chosen)
		if (!used.has(c.part.id))
			throw new ToolError(
				`choices: ${c.part.ref} needs a value for ${c.options.map((o) => o.name).join(", ")}: a recipe line leaves ${c.options.length > 1 ? "them" : "it"} to the build. Add {"ref": "${c.part.ref}", "options": {...}}.`,
			);
	const values = readBuildValues(graph, product, assemblyId, form);
	const problems = buildValueProblems(graph, assemblyId, qtyMilli, { ...values, missing: null });
	if (problems.length)
		throw new ToolError(`Refused, nothing was changed. ${problems.map((p) => errorMessage(p.key, p.vars)).join(" ")}`);
	return values;
}

/** The values chosen for a build, per component: `[{ref, options}]`, left out when there are none. */
export function choicesView(
	parts: Map<number, { ref: string; options: OptionDef[] }>,
	picks: Map<number, number[]>,
): { ref: string; options: Record<string, string> }[] | undefined {
	const list = [...picks].flatMap(([partId, ids]) => {
		const part = parts.get(partId);
		const options = part ? optionsView(part.options, keyOf(ids)) : undefined;
		return part && options ? [{ ref: part.ref, options }] : [];
	});
	return list.length ? list : undefined;
}

// ---------------------------------------------------------------------------
// Recipe lines

/** A line's rules from `fixed` (option → value) and `choose` (options chosen when planned); the rest follows. */
export function lineRules(
	defs: OptionDef[],
	fixed: OptionsArg,
	choose: string[] | undefined,
	label: string,
): LineOptions {
	const fixedValueIds = valueIdsOf(defs, fixed, `${label} fixed`);
	const chosenOptionIds: number[] = [];
	for (const name of choose ?? []) {
		if (defs.length === 0) throw new ToolError(`${label} choose: ${errorMessage("options_none")}`);
		const option = defs.find((o) => sameName(o.name, name));
		if (!option)
			throw new ToolError(`${label} choose: ${issueText(defs, { key: "option_unknown", vars: { option: name } })}`);
		if (valueIn(option, fixedValueIds))
			throw new ToolError(`${label}: ${option.name} cannot be both fixed and chosen when planned.`);
		if (!chosenOptionIds.includes(option.id)) chosenOptionIds.push(option.id);
	}
	return { fixedValueIds, chosenOptionIds };
}

/** A line's rules for the results: `fixed` and `choose`, each left out when empty (the option follows the build). */
export function rulesView(defs: OptionDef[], fixedIds: number[], chosenIds: number[]) {
	const fixed = optionsView(defs, keyOf(fixedIds));
	const choose = defs.filter((o) => chosenIds.includes(o.id)).map((o) => o.name);
	return { fixed, choose: choose.length ? choose : undefined };
}

/** The stock of a part per option values, for the results (zero balances left out). */
export function stockByOptionsView(defs: OptionDef[], rows: { optionValues: OptionKey; qty: number }[]) {
	return rows
		.filter((r) => r.qty !== 0)
		.sort((a, b) => (a.optionValues ?? "").localeCompare(b.optionValues ?? "", undefined, { numeric: true }))
		.map((r) => ({ options: keyRecord(defs, r.optionValues), onHandMilli: r.qty }));
}
