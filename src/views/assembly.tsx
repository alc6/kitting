import type { AssemblyStatus } from "../db/schema";
import { type Cost, centsOf } from "../domain/assembly-graph";
import { fmt } from "../i18n";
import { useApp } from "./context";
import { Money } from "./ui";

export function StatusBadge(props: { status: AssemblyStatus }) {
	const { t } = useApp();
	return <span class={`status status-${props.status}`}>{t.assemblies.statuses[props.status]}</span>;
}

/** Cost with an "incomplete" marker listing the parts without cost. */
export function CostView(props: { cost: Cost; refs: Map<number, string>; long?: boolean }) {
	const { t, seeCosts } = useApp();
	if (!seeCosts) return <Money cents={null} />;
	const missing = props.cost.missing.map((id) => props.refs.get(id) ?? String(id));
	return (
		<span class={props.cost.incomplete ? "cost incomplete" : "cost"}>
			<Money cents={centsOf(props.cost.millicents)} />
			{props.cost.incomplete ? (
				props.long ? (
					<small class="font-medium text-warning"> {fmt(t.assemblies.incomplete, { refs: missing.join(", ") })}</small>
				) : (
					<abbr
						class="cursor-help font-medium text-warning no-underline"
						title={fmt(t.assemblies.incomplete, { refs: missing.join(", ") })}
					>
						{" "}
						*
					</abbr>
				)
			) : null}
		</span>
	);
}
