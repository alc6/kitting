// Storage locations (D194–D200): the Locations tab of Stock (the workshop plan), the page of a storage unit with its front
// view, the plan editor, and the form that sets where a part is kept.
import type { Context } from "hono";
import { Hono } from "hono";
import { STORAGE_FRONTS, type StorageUnit } from "../db/schema";
import { getPart, partOptions } from "../domain/parts";
import { can } from "../domain/permissions";
import {
	binCode,
	binCodes,
	chainOf,
	checkUnit,
	createUnitStatement,
	deleteUnitStatement,
	drawnOnly,
	findOnPlan,
	fullCode,
	getUnit,
	hasBins,
	holdsParts,
	indexUnits,
	KIND_ORDER,
	type Location,
	listUnits,
	locate,
	locationCode,
	locationInput,
	locationOf,
	locationSortKey,
	nestable,
	nestedIn,
	type PlanSearch,
	parseBin,
	partByRef,
	partsInUnits,
	planSize,
	resolveBin,
	type StoredPart,
	setLocationStatements,
	storageUnitInput,
	unitContents,
	unitInUse,
	unitsInRoom,
	unitToForm,
	unitTree,
	unlocatedParts,
	updateUnitStatement,
	withNested,
} from "../domain/storage";
import { errorText, fmt } from "../i18n";
import { cn } from "../lib/cn";
import { type FieldErrors, validate } from "../lib/validation";
import { requirePermission } from "../middleware/roles";
import type { AppEnv } from "../types";
import { useApp } from "../views/context";
import { Icon, icons } from "../views/icons";
import { PartPicker, PartPickerDialog } from "../views/part-picker";
import { idParam, notFound, nowIso, page, redirectOk, saveChanges, translateErrors } from "../views/render";
import {
	BinsPreview,
	binHref,
	FrontSvg,
	KIND_ICONS,
	LocationBadge,
	LocationLabel,
	type PlanEditing,
	PlanSvg,
	planHighlight,
	UnitCode,
	unitTitle,
	whereText,
} from "../views/storage";
import {
	Alert,
	Badge,
	Button,
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
	ChoiceCards,
	EmptyState,
	ErrorBanner,
	FieldGroup,
	FieldSet,
	Flash,
	type FormErrors,
	type FormValues,
	KindBadge,
	MoreMenu,
	PageHeader,
	Qty,
	SegmentedField,
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
	TextArea,
	TextField,
} from "../views/ui";

export const locationRoutes = new Hono<AppEnv>();

const REF_LINK = "font-mono text-[0.8125rem] font-medium";

/** A `back` parameter: a path of this app only (no other host). */
const safeBack = (v: string | undefined): string | null => (v && /^\/(?!\/)[^\s\\]*$/.test(v) ? v : null);

const allUnits = async (c: Context<AppEnv>) => (await listUnits(c.var.db)).map((r) => r.unit);

// ---------------------------------------------------------------------------
// The plan (Stock › Locations)

function SearchResult(props: { found: PlanSearch; q: string; binParts: StoredPart[] }) {
	const view = useApp();
	const { t } = view;
	const f = props.found;
	if (f.kind === "none")
		return <p class="text-sm text-muted-foreground">{fmt(t.locations.findNone, { q: props.q })}</p>;
	if (f.kind === "bin") {
		const l = f.location;
		return (
			<div class="flex flex-wrap items-center gap-2 text-sm">
				<a href={binHref(l)} class="font-medium">
					{fmt(t.locations.findBin, { bin: fullCode(l) })}
				</a>
				<span class="text-muted-foreground">{whereText(t, l)}</span>
				{props.binParts.length === 0 ? (
					<span class="text-muted-foreground">· {t.locations.emptyBin}</span>
				) : (
					props.binParts.map((p) => (
						<a href={`/parts/${p.partId}`} class={REF_LINK}>
							{p.ref}
						</a>
					))
				)}
			</div>
		);
	}
	const { part, location } = f;
	return (
		<div class="flex flex-wrap items-center gap-2 text-sm">
			<a href={`/parts/${part.id}`} class={REF_LINK}>
				{part.ref}
			</a>
			<span class="text-muted-foreground">{part.name}</span>
			{location ? (
				<>
					<span>·</span>
					<LocationBadge location={location} />
					<span class="text-muted-foreground">{whereText(t, location)}</span>
				</>
			) : (
				<>
					<span class="text-muted-foreground">· {fmt(t.locations.findPartNone, { ref: part.ref })}</span>
					{can(view, "storage.assign") ? (
						<Button href={`/locations/parts/${part.id}?back=/locations`} variant="outline" size="sm">
							{t.locations.setLocation}
						</Button>
					) : null}
				</>
			)}
		</div>
	);
}

/** One row of the units list, indented under the unit it stands in. */
function UnitRow(props: { unit: StorageUnit; depth: number; partCount: number; units: Map<number, StorageUnit> }) {
	const view = useApp();
	const { t } = view;
	const u = props.unit;
	const parent = u.parentUnitId === null ? undefined : props.units.get(u.parentUnitId);
	// Doors and landmarks have no page of their own: planners open their editor.
	const pageless = u.kind === "door" || u.kind === "landmark";
	const href = pageless ? (can(view, "storage.plan") ? `/locations/${u.id}/edit` : undefined) : `/locations/${u.id}`;
	return (
		<li>
			<a
				href={href}
				class={cn(
					"flex min-h-(--control-h) items-center gap-3 rounded-md px-2 py-1.5 text-sm no-underline hover:bg-accent hover:text-accent-foreground",
					props.depth === 1 && "ml-5",
					props.depth === 2 && "ml-10",
					props.depth >= 3 && "ml-14",
				)}
			>
				<UnitCode unit={u} />
				<span class="flex min-w-0 flex-1 flex-col">
					<span class="truncate font-medium">{u.name || t.locations.kinds[u.kind]}</span>
					<span class="truncate text-xs text-muted-foreground">
						{t.locations.kinds[u.kind]}
						{hasBins(u.kind) ? ` · ${u.levels} × ${u.positions}` : ""}
						{parent
							? ` · ${fmt(t.locations.inBin, { bin: binCode(parent.code, u.parentLevel, u.parentPosition) })}`
							: ""}
					</span>
				</span>
				{holdsParts(u.kind) ? (
					<span class="text-xs whitespace-nowrap text-muted-foreground">
						{fmt(t.locations.partsCount, { n: props.partCount })}
					</span>
				) : null}
			</a>
		</li>
	);
}

locationRoutes.get("/", async (c) => {
	const t = c.var.t;
	const db = c.var.db;
	const q = (c.req.query("q") ?? "").trim();
	const [rows, unlocated, found] = await Promise.all([
		listUnits(db),
		unlocatedParts(db),
		q ? findOnPlan(db, q) : Promise.resolve(null),
	]);
	const units = rows.map((r) => r.unit);
	const idx = indexUnits(units);
	const counts = new Map(rows.map((r) => [r.unit.id, r.partCount]));
	const located = found?.kind === "part" ? found.location : found?.kind === "bin" ? found.location : undefined;
	const binParts =
		found?.kind === "bin"
			? (await unitContents(db, found.location.unit.id)).filter(
					(p) =>
						(found.location.level === null || p.level === found.location.level) &&
						(found.location.position === null || p.position === found.location.position),
				)
			: [];
	const canPlan = can(c.var, "storage.plan");
	const canAssign = can(c.var, "storage.assign");
	const tree = unitTree(units);
	const storing = tree.filter((r) => holdsParts(r.unit.kind));
	const drawn = tree.filter((r) => drawnOnly(r.unit.kind));
	return page(
		c,
		t.locations.title,
		<>
			<PageHeader
				title={t.locations.title}
				actions={
					canPlan && units.length > 0 ? (
						<Button href="/locations/new" icon={icons.plus}>
							{t.locations.addUnit}
						</Button>
					) : undefined
				}
			/>
			<Flash ok={c.req.query("ok")} />
			{units.length === 0 ? (
				<EmptyState icon={icons.map} title={t.locations.empty} description={t.locations.emptyHint}>
					{canPlan ? (
						<Button href="/locations/new" icon={icons.plus}>
							{t.locations.addUnit}
						</Button>
					) : null}
				</EmptyState>
			) : (
				<div class="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
					<Card>
						<CardHeader>
							<CardTitle icon={icons.map}>{t.locations.plan}</CardTitle>
							<CardDescription>{t.locations.intro}</CardDescription>
						</CardHeader>
						<CardContent class="flex flex-col gap-3">
							<search>
								<form method="get" action="/locations" class="flex max-w-xl gap-2">
									<input
										type="search"
										name="q"
										value={q}
										placeholder={t.locations.findPlaceholder}
										aria-label={t.locations.find}
										class="font-mono"
									/>
									<Button variant="outline" icon={icons.search}>
										{t.common.search}
									</Button>
								</form>
							</search>
							{found ? <SearchResult found={found} q={q} binParts={binParts} /> : null}
							<div class="overflow-x-auto rounded-lg border bg-background">
								<PlanSvg
									units={units}
									size={planSize(units)}
									highlight={located ? planHighlight(located) : undefined}
									links="view"
									editDrawn={canPlan}
								/>
							</div>
							<p class="text-xs text-muted-foreground">{t.locations.planHint}</p>
						</CardContent>
					</Card>
					<div class="flex flex-col gap-4">
						<Card>
							<CardHeader>
								<CardTitle>
									{t.locations.units}
									<Badge variant="secondary">{storing.length}</Badge>
								</CardTitle>
							</CardHeader>
							<CardContent class="flex flex-col gap-3 px-2">
								<ul class="m-0 flex list-none flex-col p-0">
									{storing.map((r) => (
										<UnitRow unit={r.unit} depth={r.depth} partCount={counts.get(r.unit.id) ?? 0} units={idx} />
									))}
								</ul>
								{drawn.length > 0 ? (
									<>
										<p class="m-0 px-2 text-xs font-medium text-muted-foreground">{t.locations.drawnOnly}</p>
										<ul class="m-0 flex list-none flex-col p-0">
											{drawn.map((r) => (
												<UnitRow unit={r.unit} depth={0} partCount={0} units={idx} />
											))}
										</ul>
									</>
								) : null}
							</CardContent>
						</Card>
						<Card>
							<CardHeader>
								<CardTitle icon={icons.mapPin}>
									{unlocated.length === 0
										? t.locations.unlocatedNone
										: fmt(t.locations.unlocated, { n: unlocated.length })}
								</CardTitle>
							</CardHeader>
							{unlocated.length > 0 ? (
								<CardContent class="px-2">
									<ul class="m-0 flex max-h-80 list-none flex-col overflow-y-auto p-0">
										{unlocated.map((p) => (
											<li class="flex min-h-(--control-h) items-center gap-2 px-2 py-1 text-sm">
												<a href={`/parts/${p.id}`} class={REF_LINK}>
													{p.ref}
												</a>
												<span class="min-w-0 flex-1 truncate text-muted-foreground">{p.name}</span>
												{canAssign ? (
													<Button href={`/locations/parts/${p.id}?back=/locations`} variant="ghost" size="sm">
														{t.locations.setLocation}
													</Button>
												) : null}
											</li>
										))}
									</ul>
								</CardContent>
							) : null}
						</Card>
					</div>
				</div>
			)}
		</>,
	);
});

// ---------------------------------------------------------------------------
// The plan editor (new unit, edit unit)

/** Shown only while the form's `kind` (or `placement`) has one of these values; app.js toggles it (D198). */
const WITH_BINS = "kind:rack,cabinet";

function UnitForm(props: {
	action: string;
	values: FormValues;
	errors: FormErrors;
	units: StorageUnit[];
	unitId: number | null;
	cancel: string;
	submit: string;
}) {
	const { t } = useApp();
	const p = { values: props.values, errors: props.errors };
	const v = props.values;
	const int = (k: string, d: number) => {
		const n = Number(v[k]);
		return v[k] !== undefined && v[k] !== "" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : d;
	};
	const front = (STORAGE_FRONTS as readonly string[]).includes(v.front ?? "")
		? (v.front as PlanEditing["front"])
		: "south";
	const editing: PlanEditing = {
		formId: "unit-form",
		unitId: props.unitId,
		code: (v.code ?? "").toUpperCase(),
		col: int("col", 1),
		row: int("row", 1),
		width: Math.max(1, int("width", 4)),
		depth: Math.max(1, int("depth", 2)),
		front,
	};
	const idx = indexUnits(props.units);
	// A unit cannot stand in itself or in a unit standing in it.
	const below = props.unitId ? withNested(idx, props.unitId) : new Set<number>();
	const hosts = props.units.filter((u) => hasBins(u.kind) && !below.has(u.id));
	const others = props.units.filter((u) => u.id !== props.unitId);
	return (
		<Card>
			<CardContent>
				<form id="unit-form" method="post" action={props.action} class="flex flex-col gap-8">
					<ErrorBanner show={Object.keys(props.errors).length > 0} />
					<FieldSet legend={t.locations.sectionUnit}>
						<ChoiceCards
							name="kind"
							label={t.locations.kind}
							options={KIND_ORDER.map((k) => ({
								value: k,
								label: t.locations.kinds[k],
								icon: KIND_ICONS[k],
								description: t.locations.kindsHelp[k],
							}))}
							{...p}
						/>
						<div class="grid gap-4 sm:grid-cols-[12rem_minmax(0,1fr)]">
							<TextField name="code" label={t.locations.code} hint={t.locations.codeHint} {...p} />
							<TextField name="name" label={t.locations.name} {...p} />
						</div>
					</FieldSet>
					<FieldSet legend={t.locations.sectionPlace}>
						<div data-show-if={WITH_BINS}>
							<SegmentedField
								name="placement"
								label={t.locations.placement}
								options={[
									{ value: "plan", label: t.locations.placements.plan, icon: icons.map },
									{ value: "bin", label: t.locations.placements.bin, icon: icons.rows3 },
								]}
								{...p}
							/>
						</div>
						<div data-show-if="placement:plan|kind:floor,room,door,landmark" class="flex flex-col gap-4">
							<div class="overflow-x-auto rounded-lg border bg-background touch-none">
								<PlanSvg units={props.units} size={planSize([...others, editing])} editing={editing} links="edit" />
							</div>
							<p class="-mt-2 text-sm text-muted-foreground">{t.locations.placeHint}</p>
							<div class="grid grid-cols-2 gap-4 sm:grid-cols-4">
								<TextField name="col" label={t.locations.col} inputmode="numeric" {...p} />
								<TextField name="row" label={t.locations.row} inputmode="numeric" {...p} />
								<TextField name="width" label={t.locations.width} inputmode="numeric" {...p} />
								<TextField name="depth" label={t.locations.depth} inputmode="numeric" {...p} />
							</div>
							<div data-show-if="kind:rack,cabinet,door">
								<SegmentedField
									name="front"
									label={t.locations.front}
									hint={t.locations.frontHint}
									options={STORAGE_FRONTS.map((f) => ({ value: f, label: t.locations.fronts[f] }))}
									{...p}
								/>
							</div>
						</div>
						<div data-show-if="placement:bin" class="flex flex-col gap-4">
							<TextField
								name="parent_bin"
								label={t.locations.parentBin}
								hint={t.locations.parentBinHint}
								list="host-bins"
								{...p}
							/>
							<datalist id="host-bins">
								{binCodes(hosts)
									.filter((b) => b.includes("-"))
									.map((b) => (
										<option value={b} />
									))}
							</datalist>
						</div>
					</FieldSet>
					<div data-show-if={WITH_BINS}>
						<FieldSet legend={t.locations.sectionBins}>
							<div class="grid items-start gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,2fr)]">
								<TextField name="levels" label={t.locations.levels} inputmode="numeric" {...p} />
								<TextField name="positions" label={t.locations.positions} inputmode="numeric" {...p} />
								<BinsPreview
									formId="unit-form"
									code={editing.code}
									levels={int("levels", 4)}
									positions={int("positions", 4)}
								/>
							</div>
							<p class="-mt-2 text-sm text-muted-foreground">{t.locations.binsHint}</p>
						</FieldSet>
					</div>
					<TextArea name="notes" label={t.common.notes} rows={2} {...p} />
					<div class="flex flex-wrap items-center gap-2 border-t pt-6">
						<Button icon={icons.save}>{props.submit}</Button>
						<Button href={props.cancel} variant="outline">
							{t.common.cancel}
						</Button>
					</div>
				</form>
			</CardContent>
		</Card>
	);
}

/** A new unit: in the bin given by `in`, else a 4 × 2 rack facing south on the first free spot of the top row. */
function newUnitValues(units: StorageUnit[], inBin: string | undefined): FormValues {
	const base = { notes: "", name: "", code: "" };
	if (inBin && parseBin(inBin)?.level) {
		return {
			...base,
			kind: "cabinet",
			placement: "bin",
			parent_bin: inBin.toUpperCase(),
			front: "south",
			col: "1",
			row: "1",
			width: "2",
			depth: "1",
			levels: "4",
			positions: "3",
		};
	}
	const drawn = units.filter((u) => u.parentUnitId === null && holdsParts(u.kind));
	const col = Math.max(1, ...drawn.filter((u) => u.row <= 3).map((u) => u.col + u.width + 1));
	return {
		...base,
		kind: "rack",
		placement: "plan",
		front: "south",
		col: String(col),
		row: "1",
		width: "4",
		depth: "2",
		levels: "4",
		positions: "4",
	};
}

async function renderUnitForm(
	c: Context<AppEnv>,
	unit: StorageUnit | null,
	values: FormValues,
	errors: FieldErrors,
	status: 200 | 422 = 200,
) {
	const t = c.var.t;
	const units = await allUnits(c);
	const title = unit ? unitTitle(t, unit) : t.locations.newUnit;
	return page(
		c,
		title,
		<>
			<PageHeader title={title} subtitle={unit ? t.locations.editUnit : undefined} />
			<UnitForm
				action={unit ? `/locations/${unit.id}` : "/locations"}
				values={values}
				errors={translateErrors(c, errors)}
				units={units}
				unitId={unit?.id ?? null}
				cancel={unit ? `/locations/${unit.id}` : "/locations"}
				submit={unit ? t.common.save : t.common.create}
			/>
		</>,
		status,
	);
}

locationRoutes.get("/new", requirePermission("storage.plan"), async (c) => {
	return renderUnitForm(c, null, newUnitValues(await allUnits(c), c.req.query("in")), {});
});

async function saveUnit(c: Context<AppEnv>, unit: StorageUnit | null) {
	const t = c.var.t;
	const body = (await c.req.parseBody()) as FormValues;
	const v = validate(storageUnitInput, body);
	if (!v.ok) return renderUnitForm(c, unit, body, v.errors, 422);
	// Only racks and drawer cabinets can stand in a bin; the others are always on the plan.
	const data = nestable(v.data.kind) ? v.data : { ...v.data, placement: "plan" as const };
	const checked = await checkUnit(c.var.db, data, unit?.id);
	if (!checked.ok) return renderUnitForm(c, unit, body, checked.errors, 422);
	const code = checked.values.code;
	if (!unit) {
		const { results } = await saveChanges(c, fmt(t.history.summaries.storageUnitCreate, { code }), [
			createUnitStatement(c.var.db, checked.values, c.var.user, nowIso()),
		]);
		return redirectOk(c, `/locations/${results[0][0]?.id}`);
	}
	await saveChanges(c, fmt(t.history.summaries.storageUnitEdit, { code }), [
		updateUnitStatement(c.var.db, unit.id, checked.values, c.var.user, nowIso()),
	]);
	return redirectOk(c, `/locations/${unit.id}`);
}

locationRoutes.post("/", requirePermission("storage.plan"), (c) => saveUnit(c, null));

// ---------------------------------------------------------------------------
// Where a part is kept

async function renderPartLocation(
	c: Context<AppEnv>,
	part: { id: number; ref: string; name: string },
	values: FormValues,
	errors: FieldErrors,
	status: 200 | 422 = 200,
) {
	const t = c.var.t;
	const db = c.var.db;
	const [current, units] = await Promise.all([locationOf(db, part.id), allUnits(c)]);
	const back = safeBack(c.req.query("back")) ?? `/parts/${part.id}`;
	const title = fmt(t.locations.locationOf, { ref: part.ref });
	const e = translateErrors(c, errors);
	return page(
		c,
		title,
		<>
			<PageHeader title={title} subtitle={part.name} />
			<div class="grid items-start gap-4 xl:grid-cols-[22rem_minmax(0,1fr)]">
				<Card>
					<CardContent>
						<form
							method="post"
							action={`/locations/parts/${part.id}?back=${encodeURIComponent(back)}`}
							class="flex flex-col gap-6"
						>
							<ErrorBanner show={Object.keys(errors).length > 0} />
							{current ? <LocationLabel location={current} /> : <LocationBadge location={undefined} />}
							<FieldGroup>
								<TextField
									name="bin"
									label={t.locations.binField}
									hint={t.locations.binHint}
									list="bin-codes"
									autofocus
									values={values}
									errors={e}
								/>
								<datalist id="bin-codes">
									{binCodes(units).map((b) => (
										<option value={b} />
									))}
								</datalist>
								<TextField
									name="note"
									label={t.locations.note}
									placeholder={t.locations.noteHint}
									values={values}
									errors={e}
								/>
							</FieldGroup>
							<div class="flex flex-wrap items-center gap-2">
								<Button icon={icons.save}>{t.common.save}</Button>
								<Button href={back} variant="outline">
									{t.common.cancel}
								</Button>
							</div>
						</form>
					</CardContent>
				</Card>
				{units.length > 0 ? (
					<Card>
						<CardContent>
							<div class="overflow-x-auto rounded-lg border bg-background">
								<PlanSvg
									units={units}
									size={planSize(units)}
									highlight={current ? planHighlight(current) : undefined}
									links="view"
								/>
							</div>
						</CardContent>
					</Card>
				) : (
					<EmptyState icon={icons.map} title={t.locations.empty} description={t.locations.emptyHint} />
				)}
			</div>
		</>,
		status,
	);
}

locationRoutes.get("/parts/:partId", requirePermission("storage.assign"), async (c) => {
	const id = idParam(c, "partId");
	const part = id ? await getPart(c.var.db, id) : undefined;
	if (!part) return notFound(c);
	const current = await locationOf(c.var.db, part.id);
	return renderPartLocation(c, part, { bin: current ? locationCode(current) : "", note: current?.note ?? "" }, {});
});

/** Validates a bin and a note for a part and saves them, or returns the field errors. */
async function savePartLocation(
	c: Context<AppEnv>,
	part: { id: number; ref: string },
	body: FormValues,
): Promise<FieldErrors | null> {
	const t = c.var.t;
	const v = validate(locationInput, body);
	if (!v.ok) return v.errors;
	const resolved = await resolveBin(c.var.db, v.data.bin);
	if (!resolved.ok) return { bin: resolved.error };
	const statements = await setLocationStatements(c.var.db, part.id, resolved.bin, v.data.note, c.var.user, nowIso());
	const summary = resolved.bin
		? fmt(t.history.summaries.partLocationSet, {
				ref: part.ref,
				bin: binCode(resolved.bin.unit.code, resolved.bin.level, resolved.bin.position),
			})
		: fmt(t.history.summaries.partLocationClear, { ref: part.ref });
	await saveChanges(c, summary, statements);
	return null;
}

locationRoutes.post("/parts/:partId", requirePermission("storage.assign"), async (c) => {
	const id = idParam(c, "partId");
	const part = id ? await getPart(c.var.db, id) : undefined;
	if (!part) return notFound(c);
	const body = (await c.req.parseBody()) as FormValues;
	const errors = await savePartLocation(c, part, body);
	if (errors) return renderPartLocation(c, part, body, errors, 422);
	return redirectOk(c, safeBack(c.req.query("back")) ?? `/parts/${part.id}`);
});

// ---------------------------------------------------------------------------
// A storage unit

async function renderUnit(
	c: Context<AppEnv>,
	unit: StorageUnit,
	assign: { values: FormValues; errors: FieldErrors },
	status: 200 | 422 = 200,
) {
	const t = c.var.t;
	const db = c.var.db;
	const view = c.var;
	const [contents, units, refs] = await Promise.all([
		unitContents(db, unit.id),
		allUnits(c),
		can(view, "storage.assign") ? partOptions(db, ["buy", "make"]) : Promise.resolve([]),
	]);
	const idx = indexUnits(units);
	const self: Location = locate(idx, unit, null, null);
	const chain = chainOf(idx, unit.id);
	const outer = chain[chain.length - 1];
	const nested = nestedIn(idx, unit.id);
	const raw = parseBin(c.req.query("bin") ?? "");
	const selected = raw && raw.code === unit.code && hasBins(unit.kind) && raw.level !== null ? raw : null;
	const inBin = selected
		? contents.filter(
				(p) => p.level === selected.level && (selected.position === null || p.position === selected.position),
			)
		: [];
	const unitsInBin = selected
		? nested.filter(
				(n) =>
					n.parentLevel === selected.level && (selected.position === null || n.parentPosition === selected.position),
			)
		: [];
	const selectedCode = selected ? binCode(unit.code, selected.level, selected.position) : null;
	const err = c.req.query("err");
	const assignErrors = translateErrors(c, assign.errors);
	const canPlan = can(view, "storage.plan");
	const onPlanCode = chain[0] ? binCode(chain[0].unit.code, chain[0].level, chain[0].position) : unit.code;
	return page(
		c,
		unitTitle(t, unit),
		<>
			<PageHeader
				lead={<UnitCode unit={unit} large />}
				title={unitTitle(t, unit)}
				subtitle={
					<span class="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
						{outer ? (
							<a href={binHref(outer)}>
								{fmt(t.locations.inBin, { bin: binCode(outer.unit.code, outer.level, outer.position) })}
							</a>
						) : null}
						{self.room ? <span>{self.room}</span> : null}
						{hasBins(unit.kind)
							? fmt(outer ? t.locations.unitSummaryNested : t.locations.unitSummary, {
									levels: unit.levels,
									positions: unit.positions,
									front: t.locations.frontShort[unit.front],
								})
							: null}
						{holdsParts(unit.kind) ? <span>{fmt(t.locations.partsCount, { n: contents.length })}</span> : null}
						<a href={`/locations?q=${encodeURIComponent(unit.code)}`}>{t.locations.showOnPlan}</a>
					</span>
				}
				actions={
					<>
						{canPlan ? (
							<Button href={`/locations/${unit.id}/edit`} variant="outline" icon={icons.pencil}>
								{t.common.edit}
							</Button>
						) : null}
						<MoreMenu
							items={[
								can(view, "storage.delete") && {
									label: t.locations.deleteUnit,
									icon: icons.trash,
									action: `/locations/${unit.id}/delete`,
									confirm: t.locations.confirmDelete,
									destructive: true,
								},
							]}
						/>
					</>
				}
			/>
			<Flash ok={c.req.query("ok")} />
			{err ? <Alert variant="destructive">{errorText(t, err)}</Alert> : null}
			<div class="mb-4 grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
				<div class="flex min-w-0 flex-col gap-4">
					{holdsParts(unit.kind) ? (
						<Card>
							<CardHeader>
								<CardTitle>{t.locations.frontView}</CardTitle>
								{hasBins(unit.kind) ? <CardDescription>{t.locations.binsHint}</CardDescription> : null}
							</CardHeader>
							<CardContent>
								<div class="overflow-x-auto">
									<FrontSvg
										unit={unit}
										contents={contents}
										nested={nested}
										selected={selected ?? undefined}
										href={(level, position) => `/locations/${unit.id}?bin=${unit.code}-${level}-${position}#bin`}
									/>
								</div>
							</CardContent>
						</Card>
					) : null}
				</div>
				<div class="flex flex-col gap-4">
					{selected && selectedCode ? (
						<Card id="bin">
							<CardHeader>
								<CardTitle class="flex flex-wrap items-center gap-2">
									<LocationBadge
										location={{ ...self, level: selected.level, position: selected.position }}
										link={false}
									/>
									<span class="text-sm font-normal text-muted-foreground">
										{whereText(t, { unit, level: selected.level, position: selected.position })}
									</span>
								</CardTitle>
								{canPlan ? (
									<CardAction>
										<Button
											href={`/locations/new?in=${encodeURIComponent(selectedCode)}`}
											variant="outline"
											size="sm"
											icon={icons.plus}
										>
											{t.locations.addHere}
										</Button>
									</CardAction>
								) : null}
							</CardHeader>
							<CardContent class="flex flex-col gap-3 text-sm">
								{inBin.length === 0 && unitsInBin.length === 0 ? (
									<p class="text-muted-foreground">{t.locations.emptyBin}</p>
								) : null}
								{unitsInBin.map((n) => (
									<a href={`/locations/${n.id}`} class="flex items-center gap-2 no-underline">
										<UnitCode unit={n} />
										<span class="flex flex-col">
											<span class="font-medium">{n.name || t.locations.kinds[n.kind]}</span>
											<span class="text-xs text-muted-foreground">
												{t.locations.kinds[n.kind]} · {n.levels} × {n.positions}
											</span>
										</span>
									</a>
								))}
								{inBin.map((p) => (
									<div class="flex flex-col gap-0.5">
										<a href={`/parts/${p.partId}`} class={REF_LINK}>
											{p.ref}
										</a>
										<span>{p.name}</span>
										<span class="text-muted-foreground">
											{t.stock.onHand}: <Qty milli={p.onHandMilli} unit={p.unit} />
											{p.note ? ` · ${p.note}` : ""}
										</span>
									</div>
								))}
							</CardContent>
						</Card>
					) : null}
					{holdsParts(unit.kind) && can(view, "storage.assign") ? (
						<Card>
							<CardHeader>
								<CardTitle icon={icons.mapPin}>{t.locations.assign}</CardTitle>
								<CardDescription>{t.locations.assignHint}</CardDescription>
							</CardHeader>
							<CardContent>
								<form method="post" action={`/locations/${unit.id}/assign`} class="flex flex-col gap-4">
									<FieldGroup>
										<PartPicker
											name="part"
											label={t.locations.part}
											listId="assign-parts"
											options={refs}
											required
											values={assign.values}
											errors={assignErrors}
										/>
										<TextField
											name="bin"
											label={t.locations.binField}
											list="unit-bins"
											values={{ bin: selectedCode ?? unit.code, ...assign.values }}
											errors={assignErrors}
										/>
										<datalist id="unit-bins">
											{binCodes([unit]).map((b) => (
												<option value={b} />
											))}
										</datalist>
										<TextField
											name="note"
											label={t.locations.note}
											placeholder={t.locations.noteHint}
											values={assign.values}
											errors={assignErrors}
										/>
									</FieldGroup>
									<div>
										<Button icon={icons.save}>{t.common.save}</Button>
									</div>
								</form>
								<PartPickerDialog name="part" scope={{ kinds: ["buy", "make"] }} />
							</CardContent>
						</Card>
					) : null}
					<Card>
						<CardContent class="flex flex-col gap-2">
							<a href={`/locations?q=${encodeURIComponent(unit.code)}`} class="block">
								<PlanSvg
									units={units}
									size={planSize(units)}
									compact
									highlight={{
										unitId: chain[0]?.unit.id ?? unit.id,
										level: chain[0]?.level ?? null,
										position: chain[0]?.position ?? null,
										label: onPlanCode,
									}}
								/>
							</a>
						</CardContent>
					</Card>
				</div>
			</div>
			{nested.length > 0 ? (
				<Card class="mb-4">
					<CardHeader>
						<CardTitle>
							{t.locations.nestedUnits}
							<Badge variant="secondary">{nested.length}</Badge>
						</CardTitle>
					</CardHeader>
					<CardContent class="px-2">
						<ul class="m-0 flex list-none flex-col p-0">
							{nested.map((n) => (
								<UnitRow unit={n} depth={0} partCount={0} units={idx} />
							))}
						</ul>
					</CardContent>
				</Card>
			) : null}
			{holdsParts(unit.kind) ? (
				<Card class="py-0">
					<CardContent class="px-0">
						{contents.length === 0 ? (
							<p class="p-6 text-sm text-muted-foreground">{t.locations.emptyUnit}</p>
						) : (
							<Table>
								<TableHeader class="bg-muted/50">
									<TableRow>
										<TableHead>{t.locations.bin}</TableHead>
										<TableHead>{t.locations.part}</TableHead>
										<TableHead class="text-right">{t.stock.onHand}</TableHead>
										<TableHead>{t.locations.note}</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{contents.map((p) => {
										const loc: Location = { ...self, level: p.level, position: p.position, note: p.note };
										return (
											<TableRow class={cn(selectedCode === locationCode(loc) && "bg-location/15")}>
												<TableCell>
													<LocationBadge location={loc} />
												</TableCell>
												<TableCell>
													<div class="flex flex-wrap items-center gap-x-2 gap-y-1">
														<a href={`/parts/${p.partId}`} class={REF_LINK}>
															{p.ref}
														</a>
														<span>{p.name}</span>
														<KindBadge kind={p.kind} />
													</div>
												</TableCell>
												<TableCell class="text-right">
													<Qty milli={p.onHandMilli} unit={p.unit} />
												</TableCell>
												<TableCell class="text-muted-foreground">{p.note}</TableCell>
											</TableRow>
										);
									})}
								</TableBody>
							</Table>
						)}
					</CardContent>
				</Card>
			) : null}
			{unit.notes ? (
				<Card class="mt-4">
					<CardContent class="text-sm whitespace-pre-wrap">{unit.notes}</CardContent>
				</Card>
			) : null}
			{drawnOnly(unit.kind) ? (
				<p class="flex items-center gap-2 text-sm text-muted-foreground">
					<Icon icon={KIND_ICONS[unit.kind]} class="size-4" />
					{t.locations.kindsHelp[unit.kind]}
				</p>
			) : null}
		</>,
		status,
	);
}

locationRoutes.get("/:id", async (c) => {
	const id = idParam(c);
	const unit = id ? await getUnit(c.var.db, id) : undefined;
	if (!unit) return notFound(c);
	if (unit.kind === "room") return renderRoom(c, unit);
	// Doors and landmarks hold nothing: their page is their editor, or the plan for those who may not edit it.
	if (unit.kind === "door" || unit.kind === "landmark")
		return c.redirect(can(c.var, "storage.plan") ? `/locations/${unit.id}/edit` : "/locations", 303);
	return renderUnit(c, unit, { values: {}, errors: {} });
});

/** A room: its part of the plan, the units in it, and every part kept there in walking order. */
async function renderRoom(c: Context<AppEnv>, room: StorageUnit) {
	const t = c.var.t;
	const units = await allUnits(c);
	const idx = indexUnits(units);
	const inside = unitsInRoom(idx, room.id);
	const stored = (await partsInUnits(c.var.db, [...inside]))
		.map((p) => {
			const unit = idx.get(p.unitId);
			return { part: p, location: unit ? locate(idx, unit, p.level, p.position, p.note) : undefined };
		})
		.sort((a, b) => {
			const ka = locationSortKey(a.location);
			const kb = locationSortKey(b.location);
			return ka < kb ? -1 : ka > kb ? 1 : a.part.ref < b.part.ref ? -1 : 1;
		});
	const tree = unitTree(units).filter((r) => inside.has(r.unit.id));
	const counts = new Map<number, number>();
	for (const s of stored) counts.set(s.part.unitId, (counts.get(s.part.unitId) ?? 0) + 1);
	const canPlan = can(c.var, "storage.plan");
	return page(
		c,
		unitTitle(t, room),
		<>
			<PageHeader
				lead={<UnitCode unit={room} large />}
				title={unitTitle(t, room)}
				subtitle={
					<span class="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
						<span>{fmt(t.locations.unitsCount, { n: tree.length })}</span>
						<span>{fmt(t.locations.partsCount, { n: stored.length })}</span>
					</span>
				}
				actions={
					<>
						{can(c.var, "stock.count") && stored.length > 0 ? (
							<Button href={`/stock/count?unit=${room.id}`} variant="outline" icon={icons.clipboardCheck}>
								{t.locations.countRoom}
							</Button>
						) : null}
						{canPlan ? (
							<Button href={`/locations/${room.id}/edit`} variant="outline" icon={icons.pencil}>
								{t.common.edit}
							</Button>
						) : null}
						<MoreMenu
							items={[
								can(c.var, "storage.delete") && {
									label: t.locations.deleteUnit,
									icon: icons.trash,
									action: `/locations/${room.id}/delete`,
									confirm: t.locations.confirmDelete,
									destructive: true,
								},
							]}
						/>
					</>
				}
			/>
			<Flash ok={c.req.query("ok")} />
			<div class="mb-4 grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
				<Card>
					<CardContent>
						<div class="overflow-x-auto rounded-lg border bg-background">
							<PlanSvg units={units} size={planSize(units)} links="view" editDrawn={canPlan} crop={room} />
						</div>
					</CardContent>
				</Card>
				<Card>
					<CardHeader>
						<CardTitle>
							{t.locations.units}
							<Badge variant="secondary">{tree.length}</Badge>
						</CardTitle>
					</CardHeader>
					<CardContent class="px-2">
						{tree.length === 0 ? (
							<p class="px-2 text-sm text-muted-foreground">{t.locations.emptyRoom}</p>
						) : (
							<ul class="m-0 flex list-none flex-col p-0">
								{tree.map((r) => (
									<UnitRow unit={r.unit} depth={r.depth} partCount={counts.get(r.unit.id) ?? 0} units={idx} />
								))}
							</ul>
						)}
					</CardContent>
				</Card>
			</div>
			{stored.length > 0 ? (
				<Card class="py-0">
					<CardContent class="px-0">
						<Table>
							<TableHeader class="bg-muted/50">
								<TableRow>
									<TableHead>{t.locations.location}</TableHead>
									<TableHead>{t.locations.part}</TableHead>
									<TableHead class="text-right">{t.stock.onHand}</TableHead>
									<TableHead>{t.locations.note}</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{stored.map(({ part: p, location }) => (
									<TableRow>
										<TableCell>
											<LocationBadge location={location} />
										</TableCell>
										<TableCell>
											<div class="flex flex-wrap items-center gap-x-2 gap-y-1">
												<a href={`/parts/${p.partId}`} class={REF_LINK}>
													{p.ref}
												</a>
												<span>{p.name}</span>
												<KindBadge kind={p.kind} />
											</div>
										</TableCell>
										<TableCell class="text-right">
											<Qty milli={p.onHandMilli} unit={p.unit} />
										</TableCell>
										<TableCell class="text-muted-foreground">{p.note}</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</CardContent>
				</Card>
			) : null}
			{room.notes ? (
				<Card class="mt-4">
					<CardContent class="text-sm whitespace-pre-wrap">{room.notes}</CardContent>
				</Card>
			) : null}
		</>,
	);
}

locationRoutes.post("/:id/assign", requirePermission("storage.assign"), async (c) => {
	const id = idParam(c);
	const unit = id ? await getUnit(c.var.db, id) : undefined;
	if (!unit) return notFound(c);
	const body = (await c.req.parseBody()) as FormValues;
	const ref = String(body.part ?? "").trim();
	const part = ref ? await partByRef(c.var.db, ref) : undefined;
	if (!part) return renderUnit(c, unit, { values: body, errors: { part: ref ? "unknown_part" : "required" } }, 422);
	const errors = await savePartLocation(c, part, body);
	if (errors) return renderUnit(c, unit, { values: body, errors }, 422);
	const bin = parseBin(String(body.bin ?? ""));
	return redirectOk(c, `/locations/${unit.id}${bin ? `?bin=${encodeURIComponent(String(body.bin).trim())}` : ""}`);
});

locationRoutes.get("/:id/edit", requirePermission("storage.plan"), async (c) => {
	const id = idParam(c);
	const unit = id ? await getUnit(c.var.db, id) : undefined;
	if (!unit) return notFound(c);
	return renderUnitForm(c, unit, unitToForm(unit, indexUnits(await allUnits(c))), {});
});

locationRoutes.post("/:id", requirePermission("storage.plan"), async (c) => {
	const id = idParam(c);
	const unit = id ? await getUnit(c.var.db, id) : undefined;
	if (!unit) return notFound(c);
	return saveUnit(c, unit);
});

locationRoutes.post("/:id/delete", requirePermission("storage.delete"), async (c) => {
	const id = idParam(c);
	const unit = id ? await getUnit(c.var.db, id) : undefined;
	if (!unit) return notFound(c);
	if (await unitInUse(c.var.db, unit.id)) return c.redirect(`/locations/${unit.id}?err=storage_unit_in_use`, 303);
	await saveChanges(c, fmt(c.var.t.history.summaries.storageUnitDelete, { code: unit.code }), [
		deleteUnitStatement(c.var.db, unit.id),
	]);
	return redirectOk(c, "/locations", "deleted");
});
