// Machine time in pages (D148, D150): durations, machine statuses, and tables of time per machine type.
import type { MachineStatus } from "../db/schema";
import type { MachineLoad } from "../domain/purchasing";
import { fmt } from "../i18n";
import { formatMinutes, mulDivCeil } from "../lib/units";
import { useApp } from "./context";
import { icons } from "./icons";
import {
	Badge,
	type BadgeVariant,
	CardEmpty,
	Money,
	Table,
	TableBody,
	TableCard,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "./ui";

/** Minutes (milli) as "3 h 10", rounded up to the minute. */
export function Duration(props: { minutesMilli: number }) {
	return <span class="num">{formatMinutes(props.minutesMilli)}</span>;
}

const STATUS_VARIANTS: Record<MachineStatus, BadgeVariant> = {
	active: "success",
	maintenance: "warning",
	retired: "muted",
};

export function MachineStatusBadge(props: { status: MachineStatus }) {
	const { t } = useApp();
	return <Badge variant={STATUS_VARIANTS[props.status]}>{t.machines.statuses[props.status]}</Badge>;
}

export type MachineTimeRow = {
	machineTypeId: number;
	name: string;
	minutesMilli: number;
	/** Hourly rate used (null: unknown). */
	rateCents: number | null;
	/** Cost of this time in cents (null: unknown rate). */
	costCents: number | null;
};

/** Machine time per machine type, with its rate and cost when costs are visible. */
export function MachineTimeCard(props: { title: string; rows: MachineTimeRow[]; empty?: string; id?: string }) {
	const { t, seeCosts } = useApp();
	return (
		<TableCard id={props.id} title={props.title}>
			{props.rows.length === 0 ? (
				<CardEmpty icon={icons.timer}>{props.empty ?? t.machines.nothingPlanned}</CardEmpty>
			) : (
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>{t.machines.machineType}</TableHead>
							<TableHead class="text-right">{t.machines.time}</TableHead>
							{seeCosts ? (
								<>
									<TableHead class="text-right">{t.machines.rate}</TableHead>
									<TableHead class="text-right">{t.machines.cost}</TableHead>
								</>
							) : null}
						</TableRow>
					</TableHeader>
					<TableBody>
						{props.rows.map((r) => (
							<TableRow>
								<TableCell class="font-medium">
									<a href={`/machines/types/${r.machineTypeId}`}>{r.name}</a>
								</TableCell>
								<TableCell class="text-right">
									<Duration minutesMilli={r.minutesMilli} />
								</TableCell>
								{seeCosts ? (
									<>
										<TableCell class="text-right whitespace-nowrap">
											<Money cents={r.rateCents} />
											{r.rateCents === null ? null : t.machines.perHour}
										</TableCell>
										<TableCell class="text-right">
											<Money cents={r.costCents} />
										</TableCell>
									</>
								) : null}
							</TableRow>
						))}
					</TableBody>
				</Table>
			)}
		</TableCard>
	);
}

/** Machine time the open builds need, per machine type, and per machine in service (D150). */
export function MachineLoadCard(props: { rows: MachineLoad[] }) {
	const { t } = useApp();
	return (
		<TableCard id="machine-load" title={t.machines.needed}>
			<p class="px-6 text-sm text-muted-foreground">{t.machines.neededIntro}</p>
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>{t.machines.machineType}</TableHead>
						<TableHead class="text-right">{t.machines.time}</TableHead>
						<TableHead class="text-right">{t.machines.activeMachines}</TableHead>
						<TableHead class="text-right">{t.machines.perMachineHead}</TableHead>
						<TableHead>{t.nav.builds}</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{props.rows.map((r) => (
						<TableRow>
							<TableCell class="font-medium">
								<a href={`/machines/types/${r.machineType.id}`}>{r.machineType.name}</a>
							</TableCell>
							<TableCell class="text-right font-semibold">
								<Duration minutesMilli={r.minutesMilli} />
							</TableCell>
							<TableCell class="text-right tabular-nums">{r.activeMachines}</TableCell>
							<TableCell class="text-right">
								{r.activeMachines > 0 ? (
									fmt(t.machines.perMachine, {
										time: formatMinutes(mulDivCeil(r.minutesMilli, 1, r.activeMachines)),
									})
								) : (
									<span class="text-warning">{t.machines.noMachineInService}</span>
								)}
							</TableCell>
							<TableCell class="text-muted-foreground">{r.builds.join(", ")}</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</TableCard>
	);
}
