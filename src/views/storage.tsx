// Storage locations (D194–D200): the shelf label of a part's location, the workshop plan and the front view of a unit,
// server-rendered as inline SVG styled with classes (strict CSP: no style=). public/static/app.js adds dragging and the
// live bins preview to the plan editor ([data-plan-editor], [data-bins-preview]); every page works without it.
import type { Child } from "hono/jsx";
import type { StorageKind, StorageUnit } from "../db/schema";
import {
	type BinRef,
	binCode,
	frontEdge,
	fullCode,
	hasBins,
	holdsParts,
	type Location,
	locationCode,
	onPlan,
	type PlanUnit,
	positionRect,
	rootBin,
	type StoredPart,
} from "../domain/storage";
import { type Dict, fmt } from "../i18n";
import { cn } from "../lib/cn";
import { useApp } from "./context";
import { Icon, type IconNode, icons } from "./icons";

/** One square of the plan, in SVG units (its real size is a setting, D209). */
export const SQ = 24;

export const KIND_ICONS: Record<StorageKind, IconNode> = {
	rack: icons.rows3,
	cabinet: icons.archive,
	floor: icons.squareDashed,
	room: icons.brickWall,
	door: icons.doorOpen,
	landmark: icons.flag,
};

const LABEL =
	"inline-flex w-fit items-center rounded-sm border border-location-border bg-location px-1.5 py-1 font-mono text-xs leading-none font-bold whitespace-nowrap text-location-foreground no-underline";

/** The unit page with this location's bin selected. */
export function binHref(l: BinRef): string {
	return `/locations/${l.unit.id}?bin=${encodeURIComponent(locationCode(l))}`;
}

/** One bin in words: "Rack A · level 2 · position 3". */
function stepText(t: Dict, b: BinRef): string {
	const unit = `${t.locations.kinds[b.unit.kind]} ${b.unit.code}`;
	if (b.level === null) return b.unit.kind === "floor" ? unit : `${unit} · ${t.locations.anywhere.toLowerCase()}`;
	return b.position === null
		? `${unit} · ${fmt(t.locations.levelOnly, { level: b.level }).toLowerCase()}`
		: `${unit} · ${fmt(t.locations.levelPosition, { level: b.level, position: b.position }).toLowerCase()}`;
}

/** Where a location is, in words, from the room inwards: "Stockroom · Rack A · level 3 · position 3 › Drawer cabinet S1 …". */
export function whereText(t: Dict, l: BinRef & { via?: BinRef[]; room?: string | null }): string {
	const steps = [...(l.via ?? []), l].map((b) => stepText(t, b)).join(" › ");
	return l.room ? `${l.room} · ${steps}` : steps;
}

/** whereText as a line that wraps only between its pieces ("Rack D", "level 2"), never inside one. */
export function WhereLine(props: { location: BinRef & { via?: BinRef[]; room?: string | null }; class?: string }) {
	const { t } = useApp();
	const parts = whereText(t, props.location).split(/( · | › )/);
	return (
		<span class={props.class}>
			{parts.map((p, i) => (i % 2 === 1 ? p : <span class="whitespace-nowrap">{p}</span>))}
		</span>
	);
}

/** The plan marks the bin on the plan that holds the location, labelled with the whole way to it. */
export function planHighlight(l: Location): PlanHighlight {
	const root = rootBin(l);
	return { unitId: root.unit.id, level: root.level, position: root.position, label: fullCode(l) };
}

/** A part's location as its shelf label, linked to the unit's front view; "No location" without one. */
export function LocationBadge(props: { location: Location | undefined; link?: boolean; class?: string }) {
	const { t } = useApp();
	const l = props.location;
	if (!l)
		return (
			<span
				class={cn(
					"inline-flex w-fit items-center rounded-sm border border-dashed border-muted-foreground/40 px-1.5 py-0.5 text-xs whitespace-nowrap text-muted-foreground",
					props.class,
				)}
			>
				{t.locations.noLocation}
			</span>
		);
	const chip =
		props.link === false ? (
			<span class={cn(LABEL, props.class)} title={whereText(t, l)}>
				{locationCode(l)}
			</span>
		) : (
			<a
				href={binHref(l)}
				title={whereText(t, l)}
				class={cn(LABEL, "hover:ring-2 hover:ring-location-border/40", props.class)}
			>
				{locationCode(l)}
			</a>
		);
	const outer = l.via[l.via.length - 1];
	if (!outer) return chip;
	return (
		<span class="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
			{chip}
			<span class="text-xs whitespace-nowrap text-muted-foreground">
				{fmt(t.locations.inBin, { bin: binCode(outer.unit.code, outer.level, outer.position) })}
			</span>
		</span>
	);
}

/** The large label of the part page: the code, and where it is in words. */
export function LocationLabel(props: { location: Location }) {
	const l = props.location;
	return (
		<div class="flex w-fit max-w-full min-w-44 flex-col gap-1.5 rounded-md border-[1.5px] border-location-border bg-location px-4 py-3 text-location-foreground">
			<span class="font-mono text-3xl leading-none font-bold tracking-wide">{locationCode(l)}</span>
			<WhereLine location={l} class="text-xs font-semibold" />
		</div>
	);
}

/** A unit's title: "Rack A · Electronics"; a room, door or landmark by its name ("Room · Assembly"). */
export function unitTitle(t: Dict, u: Pick<StorageUnit, "code" | "name" | "kind">): string {
	const kind = t.locations.kinds[u.kind];
	if (!holdsParts(u.kind) && u.name) return `${kind} · ${u.name}`;
	return `${kind} ${u.code}${u.name ? ` · ${u.name}` : ""}`;
}

/**
 * A unit's code in a frame, as drawn on the plan (dashed for what has no bins): a square that widens for a longer code.
 * Rooms, doors and landmarks show their type's icon, their code being made up.
 */
export function UnitCode(props: { unit: Pick<StorageUnit, "code" | "kind">; large?: boolean }) {
	const u = props.unit;
	return (
		<span
			class={cn(
				"inline-flex shrink-0 items-center justify-center rounded-md border-[1.5px] border-foreground font-mono font-bold whitespace-nowrap",
				props.large ? "h-10 min-w-10 px-1.5 text-sm [&_svg]:size-5" : "h-8 min-w-8 px-1 text-xs [&_svg]:size-4",
				!hasBins(u.kind) && "border-dashed",
				!holdsParts(u.kind) && "border-muted-foreground text-muted-foreground",
			)}
		>
			{holdsParts(u.kind) ? u.code : <Icon icon={KIND_ICONS[u.kind]} />}
		</span>
	);
}

// ---------------------------------------------------------------------------
// The workshop plan, seen from above

export type PlanHighlight = { unitId: number; level: number | null; position: number | null; label: string };

/** The unit of the editor: placed from the form, kept in step with its fields by app.js, dragged to move or resize. */
export type PlanEditing = {
	formId: string;
	unitId: number | null;
	code: string;
	col: number;
	row: number;
	width: number;
	depth: number;
	front: PlanUnit["front"];
};

const r1 = (n: number) => Math.round(n * 10) / 10;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s);

export function PlanSvg(props: {
	units: StorageUnit[];
	size: { width: number; depth: number };
	highlight?: PlanHighlight | undefined;
	/** Units link to their page ("view") or to their editor ("edit"). */
	links?: "view" | "edit";
	/** A small drawing (the part page): no grid, no names. */
	compact?: boolean;
	editing?: PlanEditing;
	/** Doors and landmarks have no page: in "view" mode they open their editor when this is set, else nothing. */
	editDrawn?: boolean;
	/** Draw only this area (a room), one square of margin around it. */
	crop?: { col: number; row: number; width: number; depth: number } | undefined;
}) {
	const { t } = useApp();
	const { size, editing } = props;
	const W = size.width * SQ;
	const H = size.depth * SQ;
	const pad = 16;
	const foot = props.compact ? 6 : 30;
	const drawn = props.units.filter((u) => onPlan(u) && u.id !== editing?.unitId);
	const rooms = drawn.filter((u) => u.kind === "room");
	const doors = drawn.filter((u) => u.kind === "door");
	const landmarks = drawn.filter((u) => u.kind === "landmark");
	const storing = drawn.filter((u) => holdsParts(u.kind));
	const lines = [];
	if (!props.compact) {
		const strong = (i: number) => editing !== undefined && i % 2 === 0;
		for (let i = 1; i < size.width; i++)
			lines.push(
				<line
					x1={i * SQ}
					y1={0}
					x2={i * SQ}
					y2={H}
					class={strong(i) ? "stroke-foreground/15" : "stroke-foreground/7"}
				/>,
			);
		for (let j = 1; j < size.depth; j++)
			lines.push(
				<line
					x1={0}
					y1={j * SQ}
					x2={W}
					y2={j * SQ}
					class={strong(j) ? "stroke-foreground/15" : "stroke-foreground/7"}
				/>,
			);
	}
	const link = (u: StorageUnit) => {
		if (props.links === "edit") return `/locations/${u.id}/edit`;
		if (props.links !== "view") return null;
		if (u.kind === "door" || u.kind === "landmark") return props.editDrawn ? `/locations/${u.id}/edit` : null;
		return `/locations/${u.id}`;
	};
	const crop = props.crop;
	const viewBox = crop
		? `${(crop.col - 1) * SQ} ${(crop.row - 1) * SQ} ${(crop.width + 2) * SQ} ${(crop.depth + 2) * SQ}`
		: `${-pad} ${-pad} ${W + pad * 2} ${H + pad + foot}`;
	return (
		<svg
			viewBox={viewBox}
			class={cn("block h-auto w-full font-sans select-none", props.compact ? "min-w-0" : "min-w-[34rem]")}
			role="img"
			aria-label={t.locations.plan}
			data-plan-editor={editing ? "" : undefined}
			data-form={editing?.formId}
			data-square={editing ? SQ : undefined}
		>
			<rect x={0} y={0} width={W} height={H} rx={4} class="fill-muted/60" />
			{rooms.map((r) => (
				<rect x={r.col * SQ} y={r.row * SQ} width={r.width * SQ} height={r.depth * SQ} class="fill-background" />
			))}
			<g stroke-width="1">{lines}</g>
			{rooms.length ? null : (
				<rect x={0} y={0} width={W} height={H} class="fill-none stroke-foreground" stroke-width="4" />
			)}
			{rooms.map((r) => (
				<Room room={r} compact={props.compact ?? false} href={link(r)} />
			))}
			{doors.map((d) => (
				<Door door={d} href={link(d)} />
			))}
			{landmarks.map((u) => (
				<Landmark unit={u} href={link(u)} />
			))}
			{storing.map((u) => (
				<UnitShape
					unit={u}
					highlight={props.highlight?.unitId === u.id ? props.highlight : undefined}
					compact={props.compact ?? false}
					href={link(u)}
				/>
			))}
			{editing ? <EditingShape editing={editing} /> : null}
			{props.highlight ? <HighlightTag units={storing} highlight={props.highlight} /> : null}
			{props.compact || crop ? null : (
				<g class="fill-muted-foreground text-[10.5px]">
					<path d={`M0 ${H + 14} V${H + 18} H${2 * SQ} V${H + 14}`} class="fill-none stroke-muted-foreground" />
					<text x={2 * SQ + 6} y={H + 21}>
						1 m
					</text>
				</g>
			)}
		</svg>
	);
}

/** Wraps a drawn element in a link when it has one. */
function Linked(props: { href: string | null; children?: Child }) {
	return props.href ? (
		<a href={props.href} class="group outline-none">
			{props.children}
		</a>
	) : (
		<g>{props.children}</g>
	);
}

/** A room: its walls and its name in the top left corner. */
function Room(props: { room: StorageUnit; compact: boolean; href: string | null }) {
	const r = props.room;
	return (
		<Linked href={props.href}>
			<rect
				x={r.col * SQ}
				y={r.row * SQ}
				width={r.width * SQ}
				height={r.depth * SQ}
				stroke-width="5"
				stroke-linejoin="round"
				class="fill-none stroke-foreground group-hover:stroke-ring"
			/>
			{props.compact ? null : (
				<text
					x={r.col * SQ + 10}
					y={r.row * SQ + 19}
					class="fill-muted-foreground text-[10.5px] font-semibold tracking-wider uppercase"
				>
					{clip(r.name || r.code, Math.floor((r.width * SQ - 16) / 7.5))}
				</text>
			)}
			<title>{r.name || r.code}</title>
		</Linked>
	);
}

/**
 * A door: a rectangle straddling a wall. The wall runs along its longer side through its middle; the door cuts it and
 * swings towards its front.
 */
function Door(props: { door: StorageUnit; href: string | null }) {
	const d = props.door;
	const x = d.col * SQ;
	const y = d.row * SQ;
	const w = d.width * SQ;
	const h = d.depth * SQ;
	let cut: [number, number, number, number];
	let leaf: string;
	let arc: string;
	if (d.width >= d.depth) {
		const wy = y + h / 2;
		const down = d.front !== "north";
		cut = [x, wy, x + w, wy];
		leaf = `M${x} ${wy} V${down ? wy + w : wy - w}`;
		arc = `M${x + w} ${wy} A${w} ${w} 0 0 ${down ? 1 : 0} ${x} ${down ? wy + w : wy - w}`;
	} else {
		const wx = x + w / 2;
		const right = d.front !== "west";
		cut = [wx, y, wx, y + h];
		leaf = `M${wx} ${y} H${right ? wx + h : wx - h}`;
		arc = `M${wx} ${y + h} A${h} ${h} 0 0 ${right ? 0 : 1} ${right ? wx + h : wx - h} ${y}`;
	}
	return (
		<Linked href={props.href}>
			<line x1={cut[0]} y1={cut[1]} x2={cut[2]} y2={cut[3]} stroke-width="7" class="stroke-background" />
			<path d={arc} stroke-width="1.2" stroke-dasharray="3 3" class="fill-none stroke-muted-foreground" />
			<path d={leaf} stroke-width="2" class="fill-none stroke-foreground group-hover:stroke-ring" />
			<title>{d.name || d.code}</title>
		</Linked>
	);
}

function Landmark(props: { unit: StorageUnit; href: string | null }) {
	const u = props.unit;
	const w = u.width * SQ;
	return (
		<Linked href={props.href}>
			<rect
				x={u.col * SQ}
				y={u.row * SQ}
				width={w}
				height={u.depth * SQ}
				rx={3}
				stroke-width="1.2"
				stroke-dasharray="4 4"
				class="fill-muted stroke-muted-foreground/60 group-hover:stroke-ring"
			/>
			<text
				x={u.col * SQ + w / 2}
				y={(u.row + u.depth / 2) * SQ + 4}
				text-anchor="middle"
				class="fill-muted-foreground text-[11px] font-medium italic"
			>
				{clip(u.name || u.code, Math.max(3, Math.floor(w / 6.5)))}
			</text>
		</Linked>
	);
}

function UnitShape(props: {
	unit: StorageUnit;
	highlight: PlanHighlight | undefined;
	compact: boolean;
	href: string | null;
}) {
	const { t } = useApp();
	const u = props.unit;
	const x = u.col * SQ;
	const y = u.row * SQ;
	const w = u.width * SQ;
	const h = u.depth * SQ;
	const hl = props.highlight;
	const cx = x + w / 2;
	const cy = y + h / 2;
	const showName = !props.compact && u.name !== "" && w >= 5 * SQ && h >= 2 * SQ;
	const dividers = [];
	if (hasBins(u.kind) && u.positions > 1) {
		const along = u.front === "south" || u.front === "north";
		for (let i = 1; i < u.positions; i++) {
			const d = along ? x + (i * w) / u.positions : y + (i * h) / u.positions;
			dividers.push(
				along ? (
					<line x1={r1(d)} y1={y + 3} x2={r1(d)} y2={y + h - 3} />
				) : (
					<line x1={x + 3} y1={r1(d)} x2={x + w - 3} y2={r1(d)} />
				),
			);
		}
	}
	const seg = hl && hl.position !== null && hasBins(u.kind) ? positionRect(u, hl.position) : null;
	const [fx1, fy1, fx2, fy2] = frontEdge(u);
	return (
		<Linked href={props.href}>
			<rect
				x={x}
				y={y}
				width={w}
				height={h}
				rx={2}
				stroke-width={hl ? 2.4 : 1.4}
				stroke-dasharray={u.kind === "floor" ? "7 4" : undefined}
				class={cn(
					hl
						? "fill-location/35 stroke-location-border"
						: u.kind === "floor"
							? "fill-muted stroke-foreground"
							: "fill-card stroke-foreground",
					"group-hover:stroke-ring",
				)}
			/>
			{seg ? (
				<rect
					x={r1(seg.x * SQ + 2)}
					y={r1(seg.y * SQ + 2)}
					width={r1(seg.w * SQ - 4)}
					height={r1(seg.h * SQ - 4)}
					rx={2}
					class="fill-location"
				/>
			) : null}
			<g class="stroke-muted-foreground/40" stroke-width="1">
				{dividers}
			</g>
			{u.kind === "floor" ? null : (
				<line
					x1={fx1 * SQ}
					y1={fy1 * SQ}
					x2={fx2 * SQ}
					y2={fy2 * SQ}
					stroke-width="3.4"
					stroke-linecap="round"
					class={hl ? "stroke-location-border" : "stroke-foreground"}
				/>
			)}
			<text
				x={cx}
				y={cy + (showName ? 0 : 5)}
				text-anchor="middle"
				class={cn("text-[15px] font-bold", hl ? "fill-location-foreground" : "fill-foreground")}
			>
				{u.code}
			</text>
			{showName ? (
				<text
					x={cx}
					y={cy + 14}
					text-anchor="middle"
					class={cn("text-[10.5px]", hl ? "fill-location-foreground" : "fill-muted-foreground")}
				>
					{clip(u.name, Math.floor(w / 6))}
				</text>
			) : null}
			<title>
				{u.name ? `${t.locations.kinds[u.kind]} ${u.code} · ${u.name}` : `${t.locations.kinds[u.kind]} ${u.code}`}
			</title>
		</Linked>
	);
}

/** The location's code as a label on the aisle side of the highlighted unit, pointing at its bin. */
function HighlightTag(props: { units: StorageUnit[]; highlight: PlanHighlight }) {
	const u = props.units.find((x) => x.id === props.highlight.unitId);
	if (!u) return null;
	const hl = props.highlight;
	const seg =
		hl.position !== null && hasBins(u.kind)
			? positionRect(u, hl.position)
			: { x: u.col, y: u.row, w: u.width, h: u.depth };
	const sx = (seg.x + seg.w / 2) * SQ;
	const sy = (seg.y + seg.h / 2) * SQ;
	const tw = 14 + hl.label.length * 7.4;
	const th = 20;
	const gap = 12;
	let cx = sx;
	let cy = sy;
	let ptr = "";
	if (u.kind === "floor" || u.front === "north") {
		cy = u.row * SQ - gap - th / 2;
		ptr = `M${cx - 5} ${cy + th / 2 - 0.5} L${cx} ${cy + th / 2 + 6} L${cx + 5} ${cy + th / 2 - 0.5}`;
	} else if (u.front === "south") {
		cy = (u.row + u.depth) * SQ + gap + th / 2;
		ptr = `M${cx - 5} ${cy - th / 2 + 0.5} L${cx} ${cy - th / 2 - 6} L${cx + 5} ${cy - th / 2 + 0.5}`;
	} else if (u.front === "west") {
		cx = u.col * SQ - gap - tw / 2;
		ptr = `M${cx + tw / 2 - 0.5} ${cy - 5} L${cx + tw / 2 + 6} ${cy} L${cx + tw / 2 - 0.5} ${cy + 5}`;
	} else {
		cx = (u.col + u.width) * SQ + gap + tw / 2;
		ptr = `M${cx - tw / 2 + 0.5} ${cy - 5} L${cx - tw / 2 - 6} ${cy} L${cx - tw / 2 + 0.5} ${cy + 5}`;
	}
	return (
		<g class="fill-location stroke-location-border" stroke-width="1.2">
			<rect x={r1(cx - tw / 2)} y={r1(cy - th / 2)} width={r1(tw)} height={th} rx={4} />
			<path d={ptr} />
			<text
				x={r1(cx)}
				y={r1(cy + 4.2)}
				text-anchor="middle"
				stroke="none"
				class="fill-location-foreground font-mono text-[12px] font-bold"
			>
				{hl.label}
			</text>
		</g>
	);
}

/** The unit of the editor, placed from the form; app.js keeps it in step with the fields and lets people drag it. */
function EditingShape(props: { editing: PlanEditing }) {
	const e = props.editing;
	const x = e.col * SQ;
	const y = e.row * SQ;
	const w = Math.max(1, e.width) * SQ;
	const h = Math.max(1, e.depth) * SQ;
	const [fx1, fy1, fx2, fy2] = frontEdge({ ...e, positions: 1, kind: "rack" });
	return (
		<g data-editing>
			<rect
				data-shape
				x={x}
				y={y}
				width={w}
				height={h}
				rx={2}
				stroke-width="2"
				class="cursor-move fill-primary/10 stroke-primary"
			/>
			<line
				data-front
				x1={fx1 * SQ}
				y1={fy1 * SQ}
				x2={fx2 * SQ}
				y2={fy2 * SQ}
				stroke-width="4"
				stroke-linecap="round"
				class="pointer-events-none stroke-primary"
			/>
			<text
				data-code
				x={x + w / 2}
				y={y + h / 2 + 5}
				text-anchor="middle"
				class="pointer-events-none fill-primary text-[15px] font-bold"
			>
				{e.code || "?"}
			</text>
			<text
				data-size
				x={x + w / 2}
				y={y - 7}
				text-anchor="middle"
				class="pointer-events-none fill-muted-foreground text-[10px] tabular-nums"
			>
				{`${Math.max(1, e.width) / 2} × ${Math.max(1, e.depth) / 2} m`}
			</text>
			<rect
				data-handle
				x={x + w - 7}
				y={y + h - 7}
				width={14}
				height={14}
				rx={3}
				stroke-width="1.6"
				class="cursor-nwse-resize fill-background stroke-primary"
			/>
		</g>
	);
}

// ---------------------------------------------------------------------------
// The front of a unit, as seen standing in the aisle

export function FrontSvg(props: {
	unit: StorageUnit;
	contents: StoredPart[];
	/** Units standing in its bins (a drawer cabinet on a shelf), drawn in their bin and linked to their page. */
	nested?: StorageUnit[];
	/** The bin shown in detail on the page. */
	selected?: { level: number | null; position: number | null } | undefined;
	/** Link of a bin (the unit page with that bin selected). */
	href?: (level: number, position: number) => string;
}) {
	const { t } = useApp();
	const u = props.unit;
	if (!holdsParts(u.kind)) return null;
	if (!hasBins(u.kind)) return <FloorFront unit={u} contents={props.contents} />;
	const cabinet = u.kind === "cabinet";
	const cw = cabinet ? 80 : 98;
	const ch = cabinet ? 34 : 50;
	const L = u.levels;
	const N = u.positions;
	const left = 30;
	const top = 22;
	const W = left + N * cw + 14;
	const H = top + L * ch + 18;
	const chars = Math.floor((cw - 10) / 6.1);
	const nested = props.nested ?? [];
	const cells = [];
	for (let level = 1; level <= L; level++) {
		for (let position = 1; position <= N; position++) {
			const x = left + (position - 1) * cw;
			const y = top + (L - level) * ch;
			const here = props.contents.filter((p) => p.level === level && p.position === position);
			const inner = nested.filter((n) => n.parentLevel === level && n.parentPosition === position);
			const sel = props.selected?.level === level && props.selected.position === position;
			const first = inner[0];
			const extra = here.length + inner.length - 1;
			const name = first ? first.code : here[0] ? clip(here[0].ref, extra > 0 ? chars - 3 : chars) : "";
			const text = extra > 0 ? `${name} +${extra}` : name;
			const textClass = cn("font-mono text-[10px] font-semibold", sel ? "fill-location-foreground" : "fill-foreground");
			const cell = cabinet ? (
				<>
					<rect
						x={x + 3}
						y={y + 3}
						width={cw - 6}
						height={ch - 6}
						rx={2}
						stroke-width={sel ? 1.8 : 1.1}
						class={cn(
							sel ? "fill-location stroke-location-border" : "fill-card stroke-foreground",
							"group-hover:stroke-ring",
						)}
					/>
					<line
						x1={x + cw / 2 - 9}
						y1={y + 9}
						x2={x + cw / 2 + 9}
						y2={y + 9}
						stroke-width="2"
						stroke-linecap="round"
						class="stroke-muted-foreground"
					/>
					<text x={x + cw / 2} y={y + ch / 2 + 8} text-anchor="middle" class={textClass}>
						{text}
					</text>
				</>
			) : (
				<>
					<rect
						x={x + 2}
						y={y + 2}
						width={cw - 4}
						height={ch - 7}
						rx={2}
						stroke-width={sel ? 1.8 : 1}
						class={cn(
							sel
								? "fill-location stroke-location-border"
								: here.length || inner.length
									? "fill-card stroke-border"
									: "fill-muted/40 stroke-border",
							"group-hover:stroke-ring",
						)}
					/>
					{first ? <NestedGlyph x={x + cw / 2} y={y + 7} h={ch - 25} cabinet={first.kind === "cabinet"} /> : null}
					<text x={x + cw / 2} y={first ? y + ch - 11 : y + ch / 2 + 1} text-anchor="middle" class={textClass}>
						{text}
					</text>
				</>
			);
			const names = [...inner.map((n) => n.code), ...here.map((p) => p.ref)];
			const label = `${u.code}-${level}-${position}${names.map((s) => ` · ${s}`).join("")}`;
			// A bin holding a unit opens that unit; other bins select themselves.
			const target = first ? `/locations/${first.id}` : props.href?.(level, position);
			cells.push(
				target ? (
					<a href={target} class="group outline-none">
						{cell}
						<title>{label}</title>
					</a>
				) : (
					<g>
						{cell}
						<title>{label}</title>
					</g>
				),
			);
		}
	}
	const axis = "fill-muted-foreground text-[10.5px] font-semibold";
	return (
		<svg
			viewBox={`0 0 ${W} ${H}`}
			width={W}
			class="block h-auto max-w-none font-sans"
			role="img"
			aria-label={`${t.locations.frontView} ${u.code}`}
		>
			{Array.from({ length: N }, (_, i) => (
				<text x={left + (i + 0.5) * cw} y={13} text-anchor="middle" class={axis}>
					{i + 1}
				</text>
			))}
			{Array.from({ length: L }, (_, i) => (
				<text x={13} y={top + (L - i - 0.5) * ch + 4} text-anchor="middle" class={axis}>
					{i + 1}
				</text>
			))}
			{cabinet ? (
				<rect
					x={left - 4}
					y={top - 4}
					width={N * cw + 8}
					height={L * ch + 8}
					rx={3}
					stroke-width="1.6"
					class="fill-muted stroke-foreground"
				/>
			) : null}
			{cells}
			{cabinet ? null : (
				<g class="stroke-foreground">
					{Array.from({ length: L }, (_, i) => (
						<line
							x1={left - 4}
							y1={top + (i + 1) * ch - 2}
							x2={left + N * cw + 4}
							y2={top + (i + 1) * ch - 2}
							stroke-width="3"
						/>
					))}
					<line x1={left - 4} y1={top - 6} x2={left - 4} y2={top + L * ch + 8} stroke-width="3.5" />
					<line x1={left + N * cw + 4} y1={top - 6} x2={left + N * cw + 4} y2={top + L * ch + 8} stroke-width="3.5" />
				</g>
			)}
			<line
				x1={0}
				y1={top + L * ch + 8}
				x2={W}
				y2={top + L * ch + 8}
				stroke-width="1.5"
				class="stroke-muted-foreground"
			/>
		</svg>
	);
}

/** A small drawer cabinet (or shelf unit) standing in a bin, centred on x. */
function NestedGlyph(props: { x: number; y: number; h: number; cabinet: boolean }) {
	const { x, y, h } = props;
	const rows = 3;
	const half = 13;
	return (
		<g stroke-width="1" class="stroke-foreground">
			<rect x={x - half} y={y} width={half * 2} height={h} rx={1.5} class="fill-muted" />
			{Array.from({ length: rows - 1 }, (_, i) => (
				<line x1={x - half} y1={y + ((i + 1) * h) / rows} x2={x + half} y2={y + ((i + 1) * h) / rows} />
			))}
			{props.cabinet
				? Array.from({ length: rows }, (_, i) => (
						<line
							x1={x - 3}
							y1={y + ((i + 0.5) * h) / rows}
							x2={x + 3}
							y2={y + ((i + 0.5) * h) / rows}
							stroke-width="1.5"
							class="stroke-muted-foreground"
						/>
					))
				: null}
		</g>
	);
}

/** A floor area: one box per part standing on it. */
function FloorFront(props: { unit: StorageUnit; contents: StoredPart[] }) {
	const { t } = useApp();
	const shown = props.contents.slice(0, 8);
	const bw = 120;
	const W = Math.max(1, shown.length) * (bw + 24) + 24;
	const H = 120;
	return (
		<svg
			viewBox={`0 0 ${W} ${H}`}
			width={W}
			class="block h-auto max-w-none font-sans"
			role="img"
			aria-label={`${t.locations.frontView} ${props.unit.code}`}
		>
			{shown.map((p, i) => {
				const x = 24 + i * (bw + 24);
				return (
					<a href={`/parts/${p.partId}`} class="group outline-none">
						<rect
							x={x + 6}
							y={24}
							width={bw - 12}
							height={66}
							rx={2}
							stroke-width="1.2"
							class="fill-card stroke-foreground group-hover:stroke-ring"
						/>
						<text
							x={x + bw / 2}
							y={62}
							text-anchor="middle"
							class="fill-foreground font-mono text-[10px] font-semibold"
						>
							{clip(p.ref, 16)}
						</text>
						<rect x={x} y={90} width={bw} height={10} rx={1} stroke-width="1.2" class="fill-muted stroke-foreground" />
					</a>
				);
			})}
			<line x1={0} y1={104} x2={W} y2={104} stroke-width="1.5" class="stroke-muted-foreground" />
		</svg>
	);
}

// ---------------------------------------------------------------------------
// The editor's bins preview: levels × positions as the front will look, redrawn by app.js as the fields change.

export function BinsPreview(props: { formId: string; code: string; levels: number; positions: number }) {
	const { t } = useApp();
	const L = Math.min(Math.max(1, props.levels), 20);
	const N = Math.min(Math.max(1, props.positions), 30);
	const code = props.code || "?";
	return (
		<div
			data-bins-preview
			data-form={props.formId}
			data-range={t.locations.binsRange}
			class="flex min-w-0 flex-col gap-2 rounded-lg border bg-muted/30 p-3"
		>
			<svg
				data-bins-svg
				viewBox={`0 0 ${N * 22 + 2} ${L * 14 + 2}`}
				class="block h-auto max-h-40 w-full max-w-xs"
				preserveAspectRatio="xMinYMin meet"
				aria-hidden="true"
			>
				{Array.from({ length: L * N }, (_, i) => (
					<rect
						x={(i % N) * 22 + 1}
						y={Math.floor(i / N) * 14 + 1}
						width={20}
						height={12}
						rx={2}
						class="fill-card stroke-foreground/40"
					/>
				))}
			</svg>
			<p data-bins-text class="m-0 font-mono text-xs text-muted-foreground">
				{fmt(t.locations.binsRange, { from: binCode(code, 1, 1), to: binCode(code, L, N) })}
			</p>
		</div>
	);
}
