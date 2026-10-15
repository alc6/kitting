// Option values on pages (D168–D172): labels of a record's values, and the selects that choose them.
import { defaultValue, keyLabel, keyValues, type OptionDef, type OptionKey } from "../domain/option-keys";
import { cn } from "../lib/cn";
import { type FormErrors, type FormValues, SelectField } from "./ui";

/** A record's values, "Colour: white · Size: L" (nothing for a part without options). */
export function OptionValues(props: { options: OptionDef[]; values: OptionKey | undefined; class?: string }) {
	const label = keyLabel(props.options, props.values);
	return label ? <span class={cn("text-xs text-muted-foreground", props.class)}>{label}</span> : null;
}

/** The values only, "white · L", for tight cells. */
export function ValuesText(props: { options: OptionDef[]; values: OptionKey | undefined }) {
	const text = keyValues(props.options, props.values);
	return text ? <span>{text}</span> : null;
}

/** A part reference followed by its values on a second line, as lists show a component. */
export function RefWithValues(props: {
	href?: string;
	ref: string;
	options: OptionDef[];
	values: OptionKey | undefined;
}) {
	return (
		<span class="flex flex-col">
			{props.href ? <a href={props.href}>{props.ref}</a> : <span>{props.ref}</span>}
			<OptionValues options={props.options} values={props.values} />
		</span>
	);
}

/**
 * One select per option, its values in order, the default value preselected. `name` gives each select's field name
 * (`option:<id>` on most forms).
 */
export function OptionSelects(props: {
	options: OptionDef[];
	name: (o: OptionDef) => string;
	values: FormValues;
	errors: FormErrors;
	label?: (o: OptionDef) => string;
}) {
	return (
		<>
			{props.options.map((o) => {
				const name = props.name(o);
				const values = { [name]: props.values[name] ?? String(defaultValue(o)?.id ?? "") };
				return (
					<SelectField
						name={name}
						label={props.label ? props.label(o) : o.name}
						values={values}
						errors={props.errors}
						options={o.values.map((v) => ({ value: String(v.id), label: v.name }))}
					/>
				);
			})}
		</>
	);
}
