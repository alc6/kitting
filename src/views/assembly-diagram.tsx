// Assembly structure diagram: the exploded tree of an assembly drawn as boxes and links, server-rendered
// as inline SVG (strict CSP: classes and SVG attributes only, no style=). Layout comes from
// src/domain/tree-layout.ts; zoom and drag-to-pan are added by public/static/app.js.
import type { Child } from "hono/jsx";
import {
	type CostCalculator,
	centsOf,
	type ExplodedNode,
	type GraphPart,
	type NodeMode,
} from "../domain/assembly-graph";
import { layoutTree, type PlacedNode, type TreeInput } from "../domain/tree-layout";
import { type Dict, fmt, type Locale } from "../i18n";
import { cn } from "../lib/cn";
import { formatMoney, formatQty, MILLI, roundDiv } from "../lib/units";
import { useApp } from "./context";
import { Icon, IconGlyph, icons } from "./icons";
import { buttonClass } from "./ui";

const NODE_W = 240;
const NODE_H = 68;
const OPTS = { nodeWidth: NODE_W, nodeHeight: NODE_H, colGap: 64, rowGap: 14, padding: 24 };

export type DiagramDatum = {
	part: GraphPart;
	/** Quantity per batch of the parent (null for the root). */
	perParentMilli: number | null;
	/** Units one batch of the parent makes (milli). */
	parentBatchMilli: number;
	/** Total for the requested quantity of the root. */
	qtyMilli: number;
	mode: NodeMode | "root";
	/** Assembly used for this node (its own diagram), if any. */
	assemblyId: number | null;
	/** Extended cost in millicents and whether it is complete. */
	costMillicents: number;
	incomplete: boolean;
};

export type DiagramView = {
	/** Shown depth; undefined = everything. */
	depth: number | undefined;
	assembliesOnly: boolean;
	/** Builds a URL to this page with other view options. */
	href: (opts: { depth?: number | undefined; assembliesOnly?: boolean }) => string;
};

/** Converts an explosion (structure, no stock) into the diagram's tree, root = the assembly's parent. */
export function diagramTree(
	root: GraphPart,
	rootAssemblyId: number,
	qtyMilli: number,
	tree: ExplodedNode[],
	calc: CostCalculator,
): TreeInput<DiagramDatum> {
	const convert = (n: ExplodedNode): TreeInput<DiagramDatum> => {
		const cost = calc.part(n.part.id);
		return {
			data: {
				part: n.part,
				perParentMilli: n.perParentMilli,
				parentBatchMilli: n.parentBatchMilli,
				qtyMilli: n.qtyMilli,
				mode: n.mode,
				assemblyId: n.assemblyId,
				costMillicents: calc.extended(n.part.id, n.qtyMilli),
				incomplete: cost.incomplete,
			},
			children: n.children.map(convert),
		};
	};
	const unit = calc.assembly(rootAssemblyId);
	return {
		data: {
			part: root,
			perParentMilli: null,
			parentBatchMilli: MILLI,
			qtyMilli,
			mode: "root",
			assemblyId: rootAssemblyId,
			costMillicents: roundDiv(unit.millicents * qtyMilli, MILLI),
			incomplete: unit.incomplete,
		},
		children: tree.map(convert),
	};
}

/** Depth of the deepest node (root = 0). */
export function treeDepth<T>(t: TreeInput<T>): number {
	return t.children.reduce((max, c) => Math.max(max, 1 + treeDepth(c)), 0);
}

const isAssembly = (d: DiagramDatum) => d.part.kind === "make" || d.part.kind === "kit";

type Look = { box: string; bar: string; dashed: boolean; label: (t: Dict) => string };

const LOOKS = {
	root: {
		box: "fill-primary stroke-primary",
		bar: "fill-primary-foreground/40",
		dashed: false,
		label: (t) => t.kinds.make,
	},
	missing: {
		box: "fill-card stroke-destructive",
		bar: "fill-destructive",
		dashed: true,
		label: (t) => t.assemblies.modes.missing_assembly,
	},
	make: { box: "fill-card stroke-success/50", bar: "fill-success", dashed: false, label: (t) => t.kinds.make },
	kit: { box: "fill-card stroke-warning/60", bar: "fill-warning", dashed: true, label: (t) => t.kinds.kit },
	fee: { box: "fill-muted stroke-border", bar: "fill-muted-foreground", dashed: false, label: (t) => t.kinds.fee },
	buy: { box: "fill-card stroke-border", bar: "fill-info", dashed: false, label: (t) => t.kinds.buy },
} satisfies Record<string, Look>;

function lookOf(d: DiagramDatum): Look {
	if (d.mode === "root") return LOOKS.root;
	if (d.mode === "missing_assembly") return LOOKS.missing;
	return LOOKS[d.part.kind];
}

function ellipsis(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function qtyText(milli: number, unit: string, locale: Locale): string {
	return `${formatQty(milli, locale)} ${unit}`;
}

function DiagramNode(props: { node: PlacedNode<DiagramDatum>; view: DiagramView; hasChildren: boolean }) {
	const { t, locale, currency, seeCosts } = useApp();
	const { node } = props;
	const d = node.data;
	const look = lookOf(d);
	const root = d.mode === "root";
	const text = root ? "fill-primary-foreground" : "fill-foreground";
	const muted = root ? "fill-primary-foreground/70" : "fill-muted-foreground";
	const cost = `${formatMoney(centsOf(d.costMillicents), locale, currency)}${d.incomplete ? " *" : ""}`;
	const opensDiagram = !root && d.assemblyId !== null && isAssembly(d);
	return (
		<g transform={`translate(${node.x} ${node.y})`} data-kind={d.part.kind} data-mode={d.mode}>
			<a href={`/parts/${d.part.id}`} class="group outline-none">
				<title>{`${d.part.ref} · ${d.part.name}`}</title>
				<rect
					width={NODE_W}
					height={NODE_H}
					rx="10"
					stroke-width="1.25"
					stroke-dasharray={look.dashed ? "5 4" : undefined}
					class={cn(
						look.box,
						"transition-[stroke] group-hover:stroke-ring group-focus-visible:stroke-ring group-focus-visible:stroke-[3px]",
					)}
				/>
				<rect x="8" y="12" width="3" height={NODE_H - 24} rx="1.5" class={look.bar} />
				<text x="20" y="23" class={cn(text, "font-mono text-[12.5px] font-semibold")}>
					{ellipsis(d.part.ref, 22)}
				</text>
				<text
					x={NODE_W - 12}
					y="22"
					text-anchor="end"
					class={cn(muted, "text-[10px] font-medium tracking-wide uppercase")}
				>
					{look.label(t)}
				</text>
				<text x="20" y="41" class={cn(muted, "text-[11.5px]")}>
					{ellipsis(d.part.name, 34)}
				</text>
				<text x="20" y="58" class={cn(text, "text-[11.5px] font-medium tabular-nums")}>
					{root ? `× ${formatQty(d.qtyMilli, locale)}` : qtyText(d.qtyMilli, d.part.unit, locale)}
				</text>
				{seeCosts ? (
					<text x={NODE_W - 12} y="58" text-anchor="end" class={cn(text, "text-[11.5px] tabular-nums")}>
						{cost}
					</text>
				) : null}
			</a>
			{opensDiagram ? (
				<a href={`/assemblies/${d.assemblyId}/diagram`} class="group outline-none">
					<title>{fmt(t.assemblies.openDiagram, { ref: d.part.ref })}</title>
					<circle
						cx={NODE_W - 2}
						cy="2"
						r="11"
						class="fill-background stroke-border group-hover:stroke-ring group-focus-visible:stroke-ring"
					/>
					<IconGlyph
						icon={icons.diagram}
						x={NODE_W - 9}
						y={-5}
						size={14}
						class="text-muted-foreground group-hover:text-foreground"
					/>
				</a>
			) : null}
			{node.hidden > 0 ? (
				<a
					href={
						props.view.assembliesOnly
							? props.view.href({ assembliesOnly: false })
							: props.view.href({ depth: node.depth + 1 })
					}
					class="group outline-none"
				>
					<title>{fmt(t.assemblies.hiddenTitle, { n: node.hidden })}</title>
					{/* Right of a leaf; on the bottom edge when links already leave from the right side. */}
					<rect
						x={props.hasChildren ? NODE_W - 52 : NODE_W + 8}
						y={props.hasChildren ? NODE_H - 11 : NODE_H / 2 - 11}
						width="40"
						height="22"
						rx="11"
						class="fill-muted stroke-border group-hover:stroke-ring"
					/>
					<text
						x={props.hasChildren ? NODE_W - 32 : NODE_W + 28}
						y={props.hasChildren ? NODE_H + 4 : NODE_H / 2 + 4}
						text-anchor="middle"
						class="fill-muted-foreground text-[11px] font-medium tabular-nums group-hover:fill-foreground"
					>
						{`+${node.hidden}`}
					</text>
				</a>
			) : null}
		</g>
	);
}

function LegendItem(props: { look: Look; children: Child }) {
	return (
		<span class="inline-flex items-center gap-1.5">
			<svg width="22" height="14" viewBox="0 0 22 14" aria-hidden="true" class="shrink-0">
				<rect
					x="0.5"
					y="0.5"
					width="21"
					height="13"
					rx="3"
					stroke-dasharray={props.look.dashed ? "3 2" : undefined}
					class={props.look.box}
				/>
				<rect x="3" y="3" width="2" height="8" rx="1" class={props.look.bar} />
			</svg>
			{props.children}
		</span>
	);
}

/** The diagram with its legend and zoom controls (shown by app.js). */
export function AssemblyDiagram(props: { tree: TreeInput<DiagramDatum>; view: DiagramView; title: string }) {
	const { t, locale } = useApp();
	const layout = layoutTree([props.tree], {
		...OPTS,
		maxDepth: props.view.depth,
		keep: props.view.assembliesOnly ? isAssembly : undefined,
	});
	const parents = new Set(layout.edges.map((e) => e.from));
	// Room for the "+N" pills and the corner buttons.
	const width = layout.width + 56;
	const height = layout.height + 8;
	const zoom = "size-(--control-h-sm)";
	return (
		<div data-diagram class="flex flex-col gap-3">
			<div class="flex flex-wrap items-center justify-between gap-3">
				<div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
					<LegendItem look={LOOKS.buy}>{t.assemblies.legend.buy}</LegendItem>
					<LegendItem look={LOOKS.make}>{t.assemblies.legend.make}</LegendItem>
					<LegendItem look={LOOKS.kit}>{t.assemblies.legend.kit}</LegendItem>
					<LegendItem look={LOOKS.fee}>{t.assemblies.legend.fee}</LegendItem>
					<LegendItem look={LOOKS.missing}>{t.assemblies.legend.missing}</LegendItem>
				</div>
				<div data-diagram-controls hidden class="flex items-center gap-1">
					<button
						type="button"
						data-zoom="out"
						class={buttonClass("outline", "icon-sm", zoom)}
						title={t.assemblies.zoomOut}
					>
						<Icon icon={icons.zoomOut} label={t.assemblies.zoomOut} />
					</button>
					<button
						type="button"
						data-zoom="reset"
						class={buttonClass("outline", "sm", "tabular-nums")}
						title={t.assemblies.zoomReset}
					>
						<span data-zoom-level>100%</span>
					</button>
					<button
						type="button"
						data-zoom="in"
						class={buttonClass("outline", "icon-sm", zoom)}
						title={t.assemblies.zoomIn}
					>
						<Icon icon={icons.zoomIn} label={t.assemblies.zoomIn} />
					</button>
					<button
						type="button"
						data-zoom="fit"
						class={buttonClass("outline", "icon-sm", zoom)}
						title={t.assemblies.zoomFit}
					>
						<Icon icon={icons.maximize} label={t.assemblies.zoomFit} />
					</button>
				</div>
			</div>
			<div
				data-diagram-viewport
				class="max-h-[75vh] overflow-auto overscroll-contain rounded-xl border bg-muted/30 bg-[radial-gradient(var(--border)_1px,transparent_1px)] bg-size-[18px_18px] select-none data-[dragging=true]:cursor-grabbing"
			>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					width={width}
					height={height}
					viewBox={`0 0 ${width} ${height}`}
					aria-labelledby="assembly-diagram-title"
					class="block font-sans"
					data-width={width}
					data-height={height}
				>
					<title id="assembly-diagram-title">{props.title}</title>
					<g class="fill-none stroke-muted-foreground/45" stroke-width="1.5">
						{layout.edges.map((e) => (
							<path d={e.d} />
						))}
					</g>
					<g>
						{layout.edges.map((e) => {
							const child = layout.nodes[e.to]!.data;
							return child.perParentMilli === null ? null : (
								<text
									x={e.x2 - 6}
									y={e.y2 - 5}
									text-anchor="end"
									class="fill-muted-foreground stroke-background text-[10.5px] font-medium tabular-nums [paint-order:stroke]"
									stroke-width="3"
									stroke-linejoin="round"
								>
									{child.parentBatchMilli === MILLI
										? `×${formatQty(child.perParentMilli, locale)}`
										: `×${formatQty(child.perParentMilli, locale)} / ${formatQty(child.parentBatchMilli, locale)}`}
								</text>
							);
						})}
					</g>
					{layout.nodes.map((n) => (
						<DiagramNode node={n} view={props.view} hasChildren={parents.has(n.id)} />
					))}
				</svg>
			</div>
			<p class="text-sm text-muted-foreground">{t.assemblies.diagramHint}</p>
		</div>
	);
}
