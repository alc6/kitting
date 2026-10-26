// The plan editor (D214): the whole workshop plan on one page. The form holds one section per unit drawn on the plan
// (its code, name, front, bins and place, named `u<id>_…`, or `n<k>_…` for a unit added on the page). Without
// JavaScript the sections are the form, under a drawing of the plan; public/static/app.js turns the drawing into a board
// where units are added, selected, dragged and resized, and shows only the section of the selected unit.
import type { StorageKind } from "../db/schema";
import { STORAGE_FRONTS } from "../db/schema";
import { MAX_NEW_UNITS, newPrefix } from "../domain/plan-editor";
import {
	binCode,
	hasBins,
	holdsParts,
	KIND_ORDER,
	outlineOf,
	outlineText,
	type PlanSettings,
	planLimit,
	planSize,
	type Rect,
	rectsOf,
	type ShapedUnit,
} from "../domain/storage";
import { fmt } from "../i18n";
import { formatMetres } from "../lib/units";
import { useApp } from "./context";
import { Icon, icons } from "./icons";
import { KIND_ICONS, PlanSvg, PX_PER_M, UnitCode } from "./storage";
import {
	Alert,
	Button,
	buttonClass,
	Card,
	CardContent,
	type FormErrors,
	type FormValues,
	SegmentedField,
	TextField,
} from "./ui";

/** The prefix of the sections a template carries; app.js renames it to the next `n<k>_`. */
export const TEMPLATE_PREFIX = "nX_";

const PLACE = ["col", "row", "width", "depth", "outline"] as const;

/** A unit of the editor: one drawn on the plan (`id`), or one added on the page and posted back (`id` null). */
export type EditorItem = { prefix: string; id: number | null; kind: StorageKind; rects: Rect[] };

/** The sections' fields of the units as they are: what the page shows before any change. */
export function itemValues(prefix: string, u: ShapedUnit): FormValues {
	return {
		[`${prefix}code`]: u.code,
		[`${prefix}name`]: u.name,
		[`${prefix}col`]: String(u.col),
		[`${prefix}row`]: String(u.row),
		[`${prefix}width`]: String(u.width),
		[`${prefix}depth`]: String(u.depth),
		[`${prefix}front`]: u.front,
		[`${prefix}levels`]: String(u.levels),
		[`${prefix}positions`]: String(u.positions),
		[`${prefix}outline`]: "",
	};
}

/** The units added on the page that a refused save posted back (n1_kind…), to show them again. */
export function postedNewItems(body: FormValues): EditorItem[] {
	const out: EditorItem[] = [];
	for (let k = 1; k <= MAX_NEW_UNITS; k++) {
		const kind = body[`${newPrefix(k)}kind`] as StorageKind | undefined;
		if (kind && (KIND_ORDER as readonly string[]).includes(kind))
			out.push({ prefix: newPrefix(k), id: null, kind, rects: [] });
	}
	return out;
}

export function PlanEditor(props: {
	units: ShapedUnit[];
	/** The units drawn on the plan, then those added on the page. */
	items: EditorItem[];
	plan: PlanSettings;
	values: FormValues;
	errors: FormErrors;
}) {
	const { t, locale } = useApp();
	const { plan } = props;
	const size = planSize(props.units, plan);
	const limit = planLimit(plan);
	const invalid = props.items.filter((i) => Object.keys(props.errors).some((k) => k.startsWith(i.prefix)));
	const label = (i: EditorItem) => {
		const code = props.values[`${i.prefix}code`] ?? "";
		const name = props.values[`${i.prefix}name`] ?? "";
		return code || name || t.locations.kinds[i.kind];
	};
	return (
		<form id="plan-form" method="post" action="/locations/plan" class="flex flex-col gap-4" data-plan-form>
			{invalid.length ? (
				<Alert variant="destructive">{fmt(t.locations.planErrors, { units: invalid.map(label).join(", ") })}</Alert>
			) : null}
			<div class="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_20rem] xl:grid-cols-[minmax(0,1fr)_22rem]">
				<Card class="gap-3 py-3">
					<CardContent class="flex flex-col gap-3 px-3">
						{/* The tools need JavaScript: app.js shows them. */}
						<div data-plan-tools hidden class="flex flex-wrap items-center gap-1.5">
							<span class="mr-1 text-sm text-muted-foreground">{t.locations.add}</span>
							{KIND_ORDER.map((k) => (
								<Button type="button" variant="outline" size="sm" icon={KIND_ICONS[k]} data-plan-add={k}>
									{t.locations.kinds[k]}
								</Button>
							))}
							<span class="flex-1" />
							<Button type="button" variant="ghost" size="sm" icon={icons.undo} data-plan-undo disabled>
								{t.history.undo}
							</Button>
							<div class="flex items-center gap-1">
								<button
									type="button"
									data-plan-zoom="out"
									class={buttonClass("outline", "icon-sm")}
									title={t.assemblies.zoomOut}
								>
									<Icon icon={icons.zoomOut} label={t.assemblies.zoomOut} />
								</button>
								<button
									type="button"
									data-plan-zoom="fit"
									class={buttonClass("outline", "icon-sm")}
									title={t.assemblies.zoomFit}
								>
									<Icon icon={icons.maximize} label={t.assemblies.zoomFit} />
								</button>
								<button
									type="button"
									data-plan-zoom="in"
									class={buttonClass("outline", "icon-sm")}
									title={t.assemblies.zoomIn}
								>
									<Icon icon={icons.zoomIn} label={t.assemblies.zoomIn} />
								</button>
							</div>
						</div>
						<div
							data-plan-board
							data-form="plan-form"
							data-square={Math.round(plan.squareCm * PX_PER_M) / 100}
							data-square-cm={plan.squareCm}
							data-width={size.width}
							data-depth={size.depth}
							data-limit-width={limit.width}
							data-limit-depth={limit.depth}
							data-fixed={plan.area ? "1" : undefined}
							data-step={Math.max(1, Math.round(100 / plan.squareCm))}
							data-locale={locale}
							data-overlap={t.errors.storage_overlap}
							data-codes={props.units.map((u) => u.code).join(",")}
							data-max-new={MAX_NEW_UNITS}
							class="max-h-[75vh] min-h-80 touch-none overflow-auto overscroll-contain rounded-lg border bg-background"
						>
							<PlanSvg units={props.units} size={size} squareCm={plan.squareCm} />
						</div>
						<p data-plan-hint hidden class="m-0 px-1 text-xs text-muted-foreground">
							{t.locations.planEditorHint}
						</p>
						<p data-plan-nojs class="m-0 px-1 text-sm text-muted-foreground">
							{fmt(t.locations.placeHint, { size: formatMetres(plan.squareCm, locale) })}{" "}
							<a href="/locations/new">{t.locations.addUnit}</a>
						</p>
					</CardContent>
				</Card>
				<Card class="gap-0 py-0 lg:sticky lg:top-4">
					<div class="flex items-center gap-2 border-b px-4 py-3">
						<h2 class="m-0 flex-1 text-sm font-semibold">{t.locations.units}</h2>
						<span data-plan-dirty hidden class="text-xs font-medium text-plan-accent">
							{t.locations.unsaved}
						</span>
					</div>
					<p data-plan-empty hidden class="m-0 px-4 pt-3 text-sm text-muted-foreground">
						{t.locations.selectHint}
					</p>
					<div data-plan-items class="flex max-h-[75vh] flex-col gap-2 overflow-y-auto p-3">
						{props.items.map((i) => (
							<ItemSection item={i} values={props.values} errors={props.errors} squareCm={plan.squareCm} />
						))}
					</div>
					<div class="flex flex-wrap items-center gap-2 border-t px-4 py-3">
						<Button icon={icons.save}>{t.common.save}</Button>
						<Button href="/locations" variant="outline">
							{t.common.cancel}
						</Button>
					</div>
				</Card>
			</div>
			{KIND_ORDER.map((k) => (
				<template data-plan-template={k}>
					<ItemSection
						item={{ prefix: TEMPLATE_PREFIX, id: null, kind: k, rects: [] }}
						values={newItemDefaults(TEMPLATE_PREFIX, k)}
						errors={{}}
						squareCm={plan.squareCm}
					/>
				</template>
			))}
		</form>
	);
}

/** The fields of a unit added on the page, before app.js places it and gives it a code. */
function newItemDefaults(prefix: string, kind: StorageKind): FormValues {
	return {
		[`${prefix}kind`]: kind,
		[`${prefix}code`]: "",
		[`${prefix}name`]: "",
		[`${prefix}col`]: "0",
		[`${prefix}row`]: "0",
		[`${prefix}width`]: "1",
		[`${prefix}depth`]: "1",
		[`${prefix}front`]: "south",
		[`${prefix}levels`]: "4",
		[`${prefix}positions`]: kind === "cabinet" ? "3" : "4",
		[`${prefix}outline`]: "",
	};
}

/**
 * One unit's section: a header that selects it, then its fields. app.js keeps the header (code, size) in step and shows
 * only the selected unit's fields; without JavaScript every section is open.
 */
function ItemSection(props: { item: EditorItem; values: FormValues; errors: FormErrors; squareCm: number }) {
	const { t, locale } = useApp();
	const { item, values } = props;
	const p = item.prefix;
	const v = (f: string) => values[p + f] ?? "";
	const kind = item.kind;
	const errors = props.errors;
	// Place errors are shown once, above the fields: with JavaScript the place fields are hidden.
	const placeError = PLACE.map((f) => errors[p + f]).find(Boolean);
	const fieldErrors = Object.fromEntries(
		Object.entries(errors).filter(([k]) => !PLACE.some((f) => k === p + f)),
	) as FormErrors;
	const f = { values, errors: fieldErrors };
	const code = v("code").toUpperCase();
	const loops = kind === "room" && item.rects.length ? outlineOf(item.rects) : [];
	const outline = loops.length === 1 && loops[0] ? outlineText(loops[0]) : "";
	const title = v("name") || t.locations.kinds[kind];
	const metres = (n: string) => formatMetres(Math.max(1, Number(n) || 1) * props.squareCm, locale);
	const bins = hasBins(kind);
	const levels = Number(v("levels")) || 1;
	const positions = Number(v("positions")) || 1;
	return (
		<section
			data-plan-item={p}
			data-kind={kind}
			data-kind-label={t.locations.kinds[kind]}
			data-unit-id={item.id ?? undefined}
			data-outline={outline || undefined}
			data-rects={
				item.rects.length ? item.rects.map((r) => `${r.col},${r.row},${r.width},${r.depth}`).join(";") : undefined
			}
			data-invalid={placeError || Object.keys(fieldErrors).some((k) => k.startsWith(p)) ? "true" : undefined}
			class="flex flex-col gap-3 rounded-lg border p-2 data-[invalid=true]:border-destructive/60 data-[selected=true]:border-plan-accent data-[selected=true]:ring-[3px] data-[selected=true]:ring-plan-accent/15"
		>
			<button
				type="button"
				data-plan-select
				class="flex min-h-(--control-h) w-full min-w-0 items-center gap-2.5 rounded-md p-1 text-left hover:bg-muted/60"
			>
				<span data-plan-badge>
					<UnitCode unit={{ code: code || "?", kind }} />
				</span>
				<span class="flex min-w-0 flex-1 flex-col">
					<span data-plan-title class="truncate text-sm font-medium">
						{title}
					</span>
					<span data-plan-size class="truncate text-xs text-muted-foreground tabular-nums">
						{`${t.locations.kinds[kind]} · ${metres(v("width"))} × ${metres(v("depth"))} m`}
					</span>
				</span>
				<Icon icon={icons.chevronRight} class="size-4 text-muted-foreground" />
			</button>
			<div data-plan-body class="flex flex-col gap-4 px-1 pb-1">
				{item.id === null ? <input type="hidden" name={`${p}kind`} value={kind} /> : null}
				{placeError ? (
					<p data-plan-error class="m-0 text-sm text-destructive">
						{placeError}
					</p>
				) : null}
				<div class="grid grid-cols-[6rem_minmax(0,1fr)] gap-3">
					<TextField
						name={`${p}code`}
						label={t.locations.code}
						required={holdsParts(kind)}
						{...f}
						values={{ ...values, [`${p}code`]: code }}
					/>
					<TextField name={`${p}name`} label={t.locations.name} {...f} />
				</div>
				{kind === "rack" || kind === "cabinet" || kind === "door" ? (
					<SegmentedField
						name={`${p}front`}
						label={t.locations.front}
						options={STORAGE_FRONTS.map((s) => ({ value: s, label: t.locations.fronts[s] }))}
						{...f}
					/>
				) : (
					<input type="hidden" name={`${p}front`} value={v("front") || "south"} />
				)}
				{bins ? (
					<div class="flex flex-col gap-2">
						<div class="grid grid-cols-2 gap-3">
							<TextField name={`${p}levels`} label={t.locations.levels} inputmode="numeric" {...f} />
							<TextField name={`${p}positions`} label={t.locations.positions} inputmode="numeric" {...f} />
						</div>
						<p data-plan-bins data-range={t.locations.binsRange} class="m-0 font-mono text-xs text-muted-foreground">
							{fmt(t.locations.binsRange, {
								from: binCode(code || "?", 1, 1),
								to: binCode(code || "?", levels, positions),
							})}
						</p>
					</div>
				) : null}
				{kind === "room" ? (
					<div data-plan-room-tools hidden class="flex flex-col gap-2">
						<span class="text-sm font-medium">{t.locations.shape}</span>
						<div class="flex flex-wrap items-center gap-1.5">
							{(["rect", "L", "T", "U"] as const).map((s) => (
								<Button type="button" variant="outline" size="sm" data-shape-preset={s}>
									{t.locations.shapes[s]}
								</Button>
							))}
							<Button type="button" variant="outline" size="sm" data-cut-step>
								{t.locations.cutStep}
							</Button>
						</div>
						<p
							data-shape-hint
							data-hint={t.locations.shapeHint}
							data-selected={t.locations.wallSelected}
							data-short={t.locations.wallShort}
							data-pick={t.locations.pickWall}
							data-cut={t.locations.stepCut}
							class="m-0 text-xs text-muted-foreground"
						>
							{t.locations.shapeHint}
						</p>
					</div>
				) : null}
				<input type="hidden" name={`${p}outline`} value={v("outline")} />
				{/* The place in squares: the form without JavaScript; app.js hides it and fills it while dragging. */}
				<div data-plan-numbers class="grid grid-cols-4 gap-2">
					<TextField name={`${p}col`} label={t.locations.col} inputmode="numeric" {...f} />
					<TextField name={`${p}row`} label={t.locations.row} inputmode="numeric" {...f} />
					<TextField name={`${p}width`} label={t.locations.width} inputmode="numeric" {...f} />
					<TextField name={`${p}depth`} label={t.locations.depth} inputmode="numeric" {...f} />
				</div>
				<div class="flex flex-wrap items-center gap-2">
					{kind === "room" ? null : (
						<Button type="button" variant="outline" size="sm" icon={icons.rotateCcw} data-plan-rotate hidden>
							{t.locations.rotate}
						</Button>
					)}
					{item.id === null ? (
						<Button type="button" variant="ghost" size="sm" icon={icons.trash} data-plan-remove hidden>
							{t.locations.removeUnit}
						</Button>
					) : (
						<a href={`/locations/${item.id}/edit`} data-plan-details class={buttonClass("ghost", "sm")}>
							{t.locations.unitDetails}
						</a>
					)}
				</div>
			</div>
		</section>
	);
}

/** The editor's units: those drawn on the plan in code order (rooms last, they are the largest), then the new ones. */
export function editorItems(units: ShapedUnit[], posted: EditorItem[] = []): EditorItem[] {
	const drawn = units.filter((u) => u.parentUnitId === null);
	const order = (u: ShapedUnit) => (holdsParts(u.kind) ? 0 : u.kind === "room" ? 2 : 1);
	return [
		...drawn
			.sort((a, b) => order(a) - order(b) || a.code.localeCompare(b.code))
			.map((u) => ({ prefix: `u${u.id}_`, id: u.id, kind: u.kind, rects: rectsOf(u) })),
		...posted,
	];
}
