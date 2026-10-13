// Time charts: server-rendered SVG (strict CSP: attributes and classes only, no style=).

const CHART = { w: 720, h: 220, left: 76, right: 16, top: 14, bottom: 30, pad: 12 } as const;
const DAY_MS = 86_400_000;

const dayOf = (iso: string) => Math.floor(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / DAY_MS);
const dateOfDay = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10);

/** A value holding from `date` until the next step (null: unknown, drawn as a gap). */
export type ChartStep = { date: string; value: number | null; title: string };
export type ChartDot = { date: string; value: number; title: string };

/**
 * A step line in chart colour 1 and dots in chart colour 2, over time up to `today`, with min/max value
 * labels and the first/last dates. Renders nothing when there is no value to plot.
 */
export function StepChart(props: {
	/** Unique on the page: ids the SVG title. */
	id: string;
	label: string;
	steps: ChartStep[];
	dots: ChartDot[];
	stepLabel: string;
	dotLabel: string;
	format: (value: number) => string;
	today: string;
}) {
	const steps = props.steps.map((s) => ({ ...s, day: dayOf(s.date) }));
	const dots = props.dots.map((d) => ({ ...d, day: dayOf(d.date) }));
	const values = [...steps.flatMap((s) => (s.value === null ? [] : [s.value])), ...dots.map((d) => d.value)];
	if (values.length === 0) return null;
	const days = [...steps.map((s) => s.day), ...dots.map((d) => d.day)];
	const d0 = Math.min(...days);
	const d1 = Math.max(dayOf(props.today), ...days);
	const v0 = Math.min(...values);
	const v1 = Math.max(...values);
	const innerW = CHART.w - CHART.left - CHART.right;
	const innerH = CHART.h - CHART.top - CHART.bottom;
	const baseline = CHART.top + innerH;
	const x = (day: number) =>
		d1 === d0 ? CHART.left + Math.round(innerW / 2) : CHART.left + Math.round(((day - d0) * innerW) / (d1 - d0));
	const y = (value: number) =>
		v1 === v0
			? CHART.top + Math.round(innerH / 2)
			: CHART.top + CHART.pad + Math.round(((v1 - value) * (innerH - 2 * CHART.pad)) / (v1 - v0));

	let path = "";
	steps.forEach((s, i) => {
		if (s.value === null) return;
		const next = steps[i + 1];
		const end = next ? x(next.day) : x(d1);
		const prev = steps[i - 1];
		path += prev && prev.value !== null ? ` V ${y(s.value)} H ${end}` : ` M ${x(s.day)} ${y(s.value)} H ${end}`;
	});
	const known = steps.filter((s) => s.value !== null) as (ChartStep & { day: number; value: number })[];
	const titleId = `${props.id}-title`;

	return (
		<div class="flex flex-col gap-3">
			<div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
				{known.length > 0 ? (
					<span class="inline-flex items-center gap-1.5">
						<span class="h-0.5 w-4 rounded-full bg-chart-1" aria-hidden="true" />
						{props.stepLabel}
					</span>
				) : null}
				{dots.length > 0 ? (
					<span class="inline-flex items-center gap-1.5">
						<span class="size-2.5 rounded-full bg-chart-2" aria-hidden="true" />
						{props.dotLabel}
					</span>
				) : null}
			</div>
			<svg viewBox={`0 0 ${CHART.w} ${CHART.h}`} role="img" aria-labelledby={titleId} class="h-auto w-full max-w-4xl">
				<title id={titleId}>{props.label}</title>
				<line
					x1={CHART.left}
					x2={CHART.w - CHART.right}
					y1={baseline}
					y2={baseline}
					stroke-width="1"
					class="stroke-border"
				/>
				{[...new Set([v1, v0])].map((v) => (
					<>
						<line
							x1={CHART.left}
							x2={CHART.w - CHART.right}
							y1={y(v)}
							y2={y(v)}
							stroke-width="1"
							class="stroke-border"
						/>
						<text
							x={CHART.left - 8}
							y={y(v)}
							text-anchor="end"
							dominant-baseline="middle"
							class="fill-muted-foreground text-[12px] tabular-nums"
						>
							{props.format(v)}
						</text>
					</>
				))}
				{d1 === d0 ? (
					<text x={x(d0)} y={CHART.h - 8} text-anchor="middle" class="fill-muted-foreground text-[12px] tabular-nums">
						{dateOfDay(d0)}
					</text>
				) : (
					<>
						<text
							x={CHART.left}
							y={CHART.h - 8}
							text-anchor="start"
							class="fill-muted-foreground text-[12px] tabular-nums"
						>
							{dateOfDay(d0)}
						</text>
						<text
							x={CHART.w - CHART.right}
							y={CHART.h - 8}
							text-anchor="end"
							class="fill-muted-foreground text-[12px] tabular-nums"
						>
							{dateOfDay(d1)}
						</text>
					</>
				)}
				{path ? (
					<path
						d={path.trim()}
						fill="none"
						stroke-width="2"
						stroke-linejoin="round"
						stroke-linecap="round"
						class="stroke-chart-1"
					/>
				) : null}
				{known.map((s) => (
					<g>
						<title>{s.title}</title>
						<circle cx={x(s.day)} cy={y(s.value)} r="10" class="fill-transparent" />
						<circle cx={x(s.day)} cy={y(s.value)} r="3" stroke-width="2" class="fill-chart-1 stroke-card" />
					</g>
				))}
				{dots.map((d) => (
					<g>
						<title>{d.title}</title>
						<circle cx={x(d.day)} cy={y(d.value)} r="10" class="fill-transparent" />
						<circle cx={x(d.day)} cy={y(d.value)} r="4" stroke-width="2" class="fill-chart-2 stroke-card" />
					</g>
				))}
			</svg>
		</div>
	);
}
