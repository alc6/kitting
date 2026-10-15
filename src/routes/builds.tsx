import { and, asc, eq } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import type { Child } from "hono/jsx";
import { BUILD_STATUSES, type BuildStatus, type Part, parts, stockMoves } from "../db/schema";
import { loadGraph } from "../domain/assemblies";
import { AssemblyCycleError, CostCalculator, centsOf, type ExplodedNode } from "../domain/assembly-graph";
import {
	buildableProduct,
	buildEditInput,
	buildInput,
	buildPickList,
	buildPlanErrors,
	buildSerialTaken,
	cancelBuildStatement,
	choiceField,
	completionStatements,
	createBuildStatement,
	getBuild,
	getBuildLines,
	getBuildMachineTimes,
	listBuilds,
	makeNodes,
	nextBuildNumber,
	OPEN_STATUSES,
	type PickList,
	recordProblems,
	recordStatements,
	serialCount,
	serialField,
	startBuildStatement,
	unitsToBuild,
	updateBuildStatement,
} from "../domain/builds";
import { assemblyFiles, filesBucket, partFiles } from "../domain/files";
import { buildActualCost, marginOf, salePriceOf } from "../domain/margins";
import { can } from "../domain/permissions";
import { computeShortages, type ToMakeLine } from "../domain/purchasing";
import { onHandAt, serialsInStock } from "../domain/stock";
import { errorText, fmt } from "../i18n";
import { cn } from "../lib/cn";
import { isConstraintError } from "../lib/sql";
import {
	formatMoney,
	formatPercent,
	formatQty,
	formatQtyInput,
	lineCostCents,
	MILLI,
	machineMillicents,
	mulDivRound,
	type NumberLocale,
} from "../lib/units";
import { type FieldErrors, validate } from "../lib/validation";
import { forbidden, requirePermission } from "../middleware/roles";
import type { AppEnv } from "../types";
import { useApp } from "../views/context";
import { BuildFilesCard } from "../views/files";
import { Icon, icons } from "../views/icons";
import { Duration, MachineLoadCard, MachineTimeCard } from "../views/machines";
import { idParam, notFound, nowIso, page, redirectOk, saveChanges, translateErrors } from "../views/render";
import {
	Alert,
	Badge,
	Button,
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
	CollapsibleCard,
	EmptyState,
	FieldDescription,
	FieldError,
	FieldGroup,
	FieldLabel,
	FieldWrap,
	Flash,
	type FormErrors,
	type FormValues,
	KindBadge,
	LinkButton,
	Money,
	PageHeader,
	PostButton,
	Qty,
	SearchBar,
	SelectField,
	StatCard,
	shortDateTime,
	Table,
	TableBody,
	TableCard,
	TableCell,
	TableFooter,
	TableHead,
	TableHeader,
	TableRow,
	TextArea,
	TextField,
} from "../views/ui";
import { LOW_MARGIN_BP, marginTone } from "./margins";

export const buildRoutes = new Hono<AppEnv>();

type BuildRow = Awaited<ReturnType<typeof listBuilds>>[number];
type BuildData = NonNullable<Awaited<ReturnType<typeof getBuild>>>;

/** Part references and serials: monospace, like codes. */
const CODE = "font-mono text-[0.8125rem]";
/** A part reference link inside a table or list. */
const REF_LINK = "font-mono text-[0.8125rem] font-medium underline-offset-4 hover:underline";
/** Indentation of nested sub-assemblies (full class names: Tailwind scans the source). */
const DEPTH_INDENT = ["", "pl-6", "pl-12", "pl-18", "pl-24"] as const;

export function BuildStatusBadge(props: { status: BuildStatus }) {
	const { t } = useApp();
	return <span class={`status status-${props.status}`}>{t.builds.statuses[props.status]}</span>;
}

/** Bare table of builds (no card), also embedded by the dashboard and the part page. */
export function BuildsTable(props: { rows: BuildRow[] }) {
	const { t } = useApp();
	if (props.rows.length === 0) return <EmptyState icon={icons.hammer} description={t.builds.noBuilds} />;
	return (
		<Table>
			<TableHeader>
				<TableRow>
					<TableHead>{t.builds.number}</TableHead>
					<TableHead>{t.builds.part}</TableHead>
					<TableHead>{t.builds.assembly}</TableHead>
					<TableHead class="text-right">{t.builds.qty}</TableHead>
					<TableHead>{t.builds.serial}</TableHead>
					<TableHead>{t.builds.status}</TableHead>
					<TableHead>{t.builds.plannedFor}</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{props.rows.map((b) => (
					<TableRow>
						<TableCell>
							<a href={`/builds/${b.id}`} class="font-medium whitespace-nowrap underline-offset-4 hover:underline">
								{b.number}
							</a>
						</TableCell>
						<TableCell>
							<span class={cn(CODE, "font-medium")}>{b.partRef}</span>{" "}
							<span class="text-muted-foreground">{b.partName}</span>
						</TableCell>
						<TableCell class="whitespace-nowrap text-muted-foreground">
							{b.assemblyCode} · {b.assemblyRevision}
						</TableCell>
						<TableCell class="text-right">
							<Qty milli={b.qtyMilli} unit={b.unit} />
						</TableCell>
						<TableCell class={CODE}>{b.serial ?? ""}</TableCell>
						<TableCell>
							<BuildStatusBadge status={b.status} />
						</TableCell>
						<TableCell class="whitespace-nowrap tabular-nums">
							{b.status === "done" ? shortDateTime(b.doneAt).slice(0, 10) : (b.plannedFor ?? "")}
						</TableCell>
					</TableRow>
				))}
			</TableBody>
		</Table>
	);
}

/** A link to the new build form, prefilled with a part to make (D156). */
function toMakeHref(l: ToMakeLine, when: "done" | "planned", locale: NumberLocale): string {
	const q = new URLSearchParams({
		part: String(l.part.id),
		assembly_id: String(l.assembly.id),
		qty: formatQtyInput(l.toMakeMilli, locale),
		when,
	});
	return `/builds/new?${q}`;
}

/**
 * What to make for the open builds (D156): made parts neither in stock nor planned, deepest first, rounded up to whole
 * runs, with their machine time; each can be planned or recorded from here. What to buy stays on Purchasing.
 */
function ToMakeCard(props: { lines: ToMakeLine[]; toBuy: number }) {
	const view = useApp();
	const { t, locale } = view;
	const canPlan = can(view, "builds.plan");
	const canRecord = canPlan && can(view, "builds.complete");
	return (
		<TableCard
			id="to-make"
			title={
				<span class="inline-flex items-center gap-2">
					<Icon icon={icons.factory} class="size-4" />
					{t.builds.toMake}
				</span>
			}
			action={
				props.toBuy > 0 ? (
					<a href="/purchasing" class="text-sm">
						{fmt(t.builds.toBuyLink, { n: props.toBuy })}
					</a>
				) : undefined
			}
		>
			<p class="px-4 pt-3 text-sm text-muted-foreground">{t.builds.toMakeIntro}</p>
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>{t.builds.part}</TableHead>
						<TableHead class="text-right">{t.builds.toMakeQty}</TableHead>
						<TableHead>{t.builds.covered}</TableHead>
						<TableHead class="text-right">{t.machines.time}</TableHead>
						<TableHead>{t.builds.forBuilds}</TableHead>
						{canPlan ? (
							<TableHead class="w-px">
								<span class="sr-only">{t.common.actions}</span>
							</TableHead>
						) : null}
					</TableRow>
				</TableHeader>
				<TableBody>
					{props.lines.map((l) => (
						<TableRow>
							<TableCell>
								<a href={`/parts/${l.part.id}#how-its-made`} class="whitespace-nowrap">
									{l.part.ref}
								</a>
								<div class="text-xs text-muted-foreground">{l.part.name}</div>
							</TableCell>
							<TableCell class="text-right whitespace-nowrap">
								<div class="font-semibold">
									<Qty milli={l.toMakeMilli} unit={l.part.unit} />
								</div>
								<div class="text-xs text-muted-foreground">
									{fmt(t.builds.shortBy, { qty: formatQty(l.shortMilli, locale) })}
									{l.assembly.batchMilli !== MILLI ? ` · ${fmt(t.builds.batches, { n: l.runs })}` : ""}
								</div>
							</TableCell>
							<TableCell class="text-xs text-muted-foreground">
								{l.onHandMilli > 0 ? (
									<div class="whitespace-nowrap">
										{fmt(t.builds.inStock, { qty: formatQty(l.onHandMilli, locale) })}
									</div>
								) : null}
								{l.plannedMilli > 0 ? (
									<div class="whitespace-nowrap">
										{fmt(t.builds.alreadyPlanned, { qty: formatQty(l.plannedMilli, locale) })}
									</div>
								) : null}
								{l.onHandMilli <= 0 && l.plannedMilli <= 0 ? "—" : null}
							</TableCell>
							<TableCell class="text-right whitespace-nowrap">
								{l.machine ? (
									<>
										<Duration minutesMilli={l.machine.minutesMilli} />
										<div class="text-xs text-muted-foreground">{l.machine.machineType.name}</div>
									</>
								) : null}
							</TableCell>
							<TableCell class="text-xs text-muted-foreground">
								<span class="flex flex-wrap gap-x-1.5">
									{l.builds.map((n) => (
										<span class="whitespace-nowrap">{n}</span>
									))}
								</span>
							</TableCell>
							{canPlan ? (
								<TableCell class="py-1">
									<div class="flex justify-end gap-1.5">
										<Button href={toMakeHref(l, "planned", locale)} variant="outline" size="sm">
											{t.parts.planBuild}
										</Button>
										{canRecord ? (
											<Button href={toMakeHref(l, "done", locale)} variant="ghost" size="sm" icon={icons.check}>
												{t.builds.recordShort}
											</Button>
										) : null}
									</div>
								</TableCell>
							) : null}
						</TableRow>
					))}
				</TableBody>
			</Table>
		</TableCard>
	);
}

buildRoutes.get("/", async (c) => {
	const t = c.var.t;
	const q = c.req.query("q") ?? "";
	const status = c.req.query("status") ?? "open";
	// Live search swaps the results only (hx-select): no need to plan for each keystroke. A cycle in the recipes
	// (refused on save, but possible in old data) hides the plan rather than the page.
	const plan =
		c.req.header("HX-Request") === "true"
			? null
			: await computeShortages(c.var.db).catch((err) => {
					if (err instanceof AssemblyCycleError) return null;
					throw err;
				});
	const rows = await listBuilds(c.var.db, { q, status });
	const shortages = plan ?? { toMake: [], machines: [], groups: [] };
	const toBuy = shortages.groups.reduce((n, g) => n + g.lines.length, 0);
	const canBuild = can(c.var, "builds.plan");
	return page(
		c,
		t.builds.title,
		<>
			<PageHeader
				title={t.builds.title}
				subtitle={t.builds.intro}
				actions={canBuild ? <LinkButton href="/builds/new" label={t.builds.new} icon={icons.plus} /> : undefined}
			/>
			<Flash ok={c.req.query("ok")} message={c.req.query("ok") === "cancelled" ? t.builds.cancelled : undefined} />
			{shortages.toMake.length > 0 || shortages.machines.length > 0 ? (
				<div class="mb-6 flex flex-col gap-4">
					{shortages.toMake.length > 0 ? <ToMakeCard lines={shortages.toMake} toBuy={toBuy} /> : null}
					{shortages.machines.length > 0 ? <MachineLoadCard rows={shortages.machines} /> : null}
				</div>
			) : null}
			<TableCard
				id="production-orders"
				title={
					<span class="inline-flex items-center gap-2">
						<Icon icon={icons.hammer} class="size-4" />
						{t.builds.orders}
					</span>
				}
			>
				<div class="px-4 pt-4">
					<SearchBar action="/builds" q={q}>
						<select name="status" aria-label={t.builds.status} class="w-auto flex-[0_1_220px]">
							<option value="open">{t.builds.statusFilter.open}</option>
							{BUILD_STATUSES.map((s) => (
								<option value={s} selected={s === status}>
									{t.builds.statuses[s]}
								</option>
							))}
							<option value="all" selected={status === "all"}>
								{t.builds.statusFilter.all}
							</option>
						</select>
					</SearchBar>
				</div>
				<div id="results" class="border-t">
					{rows.length ? (
						<BuildsTable rows={rows} />
					) : (
						<EmptyState icon={icons.hammer} title={t.builds.noBuilds} description={t.builds.emptyHint}>
							{canBuild ? (
								<LinkButton href="/builds/new" label={t.builds.new} icon={icons.plus} variant="outline" />
							) : null}
						</EmptyState>
					)}
				</div>
			</TableCard>
		</>,
	);
});

// ---------------------------------------------------------------------------
// New build

type AssemblyOption = { id: number; code: string; revision: string; batchMilli: number };

/** Quantity of a build: in units, or in batches when a variant makes batches (D145). */
export function BuildQtyField(props: {
	unit: string;
	assemblyOptions: AssemblyOption[];
	values: FormValues;
	errors: FormErrors;
}) {
	const { t, locale } = useApp();
	const batched = props.assemblyOptions.filter((b) => b.batchMilli !== MILLI);
	const p = { values: props.values, errors: props.errors };
	if (batched.length === 0) return <TextField name="qty" label={t.builds.qty} inputmode="decimal" required {...p} />;
	const error = props.errors.qty;
	const inBatches = props.values.qty_in === "batches";
	return (
		<FieldWrap
			name="qty"
			label={t.builds.qty}
			required
			hint={batched
				.map((b) => fmt(t.builds.batchInfo, { code: b.code, qty: `${formatQty(b.batchMilli, locale)} ${props.unit}` }))
				.join(" · ")}
			{...p}
		>
			<div class="flex items-center gap-2">
				<input
					id="f-qty"
					data-slot="input"
					name="qty"
					inputmode="decimal"
					required
					value={props.values.qty ?? ""}
					class="min-w-0 flex-1"
					aria-invalid={error ? "true" : undefined}
					aria-describedby={error ? "e-qty" : undefined}
				/>
				<select name="qty_in" aria-label={t.builds.qtyIn} class="w-auto">
					<option value="units" selected={!inBatches}>
						{fmt(t.builds.qtyUnits, { unit: props.unit })}
					</option>
					<option value="batches" selected={inBatches}>
						{t.builds.qtyBatches}
					</option>
				</select>
			</div>
		</FieldWrap>
	);
}

/** When a new build happens (D155): already made, recorded now (D152), or to make, planned. */
type When = "done" | "planned";

/**
 * The when of a requested form: planned unless the link asks to record (Record a build, Made), and only for those who
 * may complete builds. A stock write that cannot be undone is never the default of a plain New build.
 */
function whenOf(value: unknown, canRecord: boolean): When {
	return value === "done" && canRecord ? "done" : "planned";
}

/**
 * The one build form (D155): a product, its variant and quantity, and whether it is already made (recorded now, in one
 * step) or to make (planned for a date). The product select reloads the form (htmx, or the Choose button without it).
 */
function NewBuildForm(props: {
	values: FormValues;
	errors: FormErrors;
	products: { id: number; ref: string; name: string }[];
	product: Part | undefined;
	assemblyOptions: AssemblyOption[];
}) {
	const view = useApp();
	const { t } = view;
	const p = { values: props.values, errors: props.errors };
	const base = "/builds/new";
	const reload = {
		"hx-get": base,
		"hx-include": "closest form",
		"hx-target": "#build-form",
		"hx-select": "#build-form",
		"hx-swap": "outerHTML",
	};
	const canRecord = can(view, "builds.complete");
	const when = whenOf(props.values.when, canRecord);
	const partError = props.errors.part_id;
	const ready = props.product !== undefined && props.assemblyOptions.length > 0;
	return (
		<Card class="max-w-3xl">
			<CardContent>
				<form method="post" action="/builds" class="flex flex-col gap-6" id="build-form">
					{Object.keys(props.errors).length > 0 ? (
						<Alert variant="destructive" class="mb-0">
							{t.common.fixErrors}
						</Alert>
					) : null}
					<FieldGroup>
						<div
							data-slot="field"
							data-invalid={partError ? "true" : undefined}
							class="group/field flex w-full min-w-0 flex-col gap-2 data-[invalid=true]:text-destructive"
						>
							<FieldLabel for="f-part_id" required>
								{t.builds.part}
							</FieldLabel>
							<div class="flex items-center gap-2">
								<select
									id="f-part_id"
									name="part_id"
									required
									class="flex-1"
									aria-invalid={partError ? "true" : undefined}
									aria-describedby={partError ? "e-part_id" : undefined}
									{...reload}
									hx-trigger="change"
								>
									<option value="">—</option>
									{props.products.map((o) => (
										<option value={String(o.id)} selected={String(o.id) === props.values.part_id}>
											{o.ref} · {o.name}
										</option>
									))}
								</select>
								<Button variant="outline" formmethod="get" formaction={base}>
									{t.builds.choosePart}
								</Button>
							</div>
							<FieldDescription>{t.builds.partHint}</FieldDescription>
							<FieldError id="e-part_id">{partError}</FieldError>
						</div>
						{props.product ? (
							props.assemblyOptions.length === 0 ? (
								<Alert variant="warning" class="mb-0">
									<p>
										{t.builds.noActiveAssembly}{" "}
										<a href={`/parts/${props.product.id}#how-its-made`}>{t.parts.howItsMade}</a>
									</p>
								</Alert>
							) : (
								<>
									<fieldset class="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
										<legend class="mb-2 text-sm font-medium">{t.builds.when}</legend>
										<div class="grid gap-3 md:grid-cols-2">
											<label
												class={cn(
													"flex cursor-pointer items-start gap-3 rounded-lg border p-4 has-[:checked]:border-primary has-[:checked]:bg-primary/5",
													!canRecord && "cursor-not-allowed opacity-60",
												)}
											>
												<input
													type="radio"
													name="when"
													value="done"
													checked={when === "done"}
													disabled={!canRecord}
													class="mt-1"
												/>
												<span class="flex flex-col gap-1">
													<span class="font-medium">{t.builds.whenDone}</span>
													<span class="text-sm text-muted-foreground">{t.builds.whenDoneHint}</span>
												</span>
											</label>
											<label class="flex cursor-pointer items-start gap-3 rounded-lg border p-4 has-[:checked]:border-primary has-[:checked]:bg-primary/5">
												<input
													type="radio"
													id="when-planned"
													name="when"
													value="planned"
													checked={when === "planned"}
													class="mt-1"
												/>
												<span class="flex min-w-0 flex-1 flex-col gap-2">
													<span class="font-medium">{t.builds.whenPlanned}</span>
													<span class="text-sm text-muted-foreground">{t.builds.whenPlannedHint}</span>
													<input
														id="f-planned_for"
														data-slot="input"
														type="date"
														name="planned_for"
														data-checks="when-planned"
														value={props.values.planned_for ?? ""}
														aria-label={t.builds.plannedFor}
														aria-invalid={props.errors.planned_for ? "true" : undefined}
													/>
													<FieldError id="e-planned_for">{props.errors.planned_for}</FieldError>
												</span>
											</label>
										</div>
									</fieldset>
									<div class="grid gap-4 md:grid-cols-2">
										<SelectField
											name="assembly_id"
											label={t.builds.variant}
											required
											options={props.assemblyOptions.map((b) => ({
												value: String(b.id),
												label: `${b.code} (${b.revision})`,
											}))}
											{...p}
										/>
										<BuildQtyField unit={props.product.unit} assemblyOptions={props.assemblyOptions} {...p} />
										<TextField
											name="serial"
											label={t.builds.serial}
											hint={props.product.trackSerial ? t.builds.serialHint : undefined}
											required={props.product.trackSerial}
											{...p}
										/>
									</div>
									<TextArea name="notes" label={t.common.notes} {...p} />
								</>
							)
						) : null}
					</FieldGroup>
					{ready ? (
						<div class="flex flex-wrap items-center gap-2">
							<Button icon={icons.check}>{t.common.save}</Button>
							<Button href="/builds" variant="outline">
								{t.common.cancel}
							</Button>
						</div>
					) : null}
				</form>
			</CardContent>
		</Card>
	);
}

/** The new build page: the form, and why a build already made could not be recorded in one step (D152). */
function NewBuildPage(props: {
	values: FormValues;
	errors: FormErrors;
	problems?: string[];
	data: Awaited<ReturnType<typeof newBuildData>>;
}) {
	const { t } = useApp();
	return (
		<>
			<PageHeader title={t.builds.new} subtitle={t.builds.newIntro} />
			{props.problems?.length ? (
				<Alert variant="destructive" title={t.builds.recordRefused}>
					<ul class="m-0 flex list-disc flex-col gap-1 pl-4">
						{props.problems.map((p) => (
							<li>{p}</li>
						))}
					</ul>
				</Alert>
			) : null}
			<NewBuildForm values={props.values} errors={props.errors} {...props.data} />
		</>
	);
}

async function newBuildData(c: Context<AppEnv>, partId: number | null) {
	const products = await c.var.db
		.select({ id: parts.id, ref: parts.ref, name: parts.name })
		.from(parts)
		.where(and(eq(parts.kind, "make"), eq(parts.archived, false)))
		.orderBy(asc(parts.ref));
	return { products, ...(await buildableProduct(c.var.db, partId)) };
}

/** The form's first values: quantity 1 and the std variant (else the first active one), unless the query says. */
function newBuildValues(q: Record<string, string>, partId: number | null, options: AssemblyOption[]): FormValues {
	const std = options.find((b) => b.code === "std") ?? options[0];
	return {
		qty: "1",
		...q,
		part_id: partId ? String(partId) : "",
		assembly_id:
			q.assembly_id && options.some((b) => String(b.id) === q.assembly_id) ? q.assembly_id : std ? String(std.id) : "",
	};
}

buildRoutes.get("/new", requirePermission("builds.plan"), async (c) => {
	const q = c.req.query();
	const partId = /^\d+$/.test(q.part_id ?? q.part ?? "") ? Number(q.part_id ?? q.part) : null;
	const data = await newBuildData(c, partId);
	const values = newBuildValues(q, partId, data.assemblyOptions);
	values.when = whenOf(q.when, can(c.var, "builds.complete"));
	return page(c, c.var.t.builds.new, <NewBuildPage values={values} errors={{}} data={data} />);
});

// One form for a new build (D155): already made (recorded now) or to make (planned).
buildRoutes.post("/", requirePermission("builds.plan"), async (c) => {
	const body = await c.req.parseBody();
	if (body.when === "done") {
		if (!can(c.var, "builds.complete")) return forbidden(c);
		// A date means a plan: never record (a write that cannot be undone) and drop it silently.
		if (typeof body.planned_for === "string" && body.planned_for.trim()) {
			const data = await newBuildData(c, /^\d+$/.test(String(body.part_id)) ? Number(body.part_id) : null);
			return page(
				c,
				c.var.t.builds.new,
				<NewBuildPage
					values={body as FormValues}
					errors={translateErrors(c, { planned_for: "record_with_date" })}
					data={data}
				/>,
				422,
			);
		}
		return recordBuild(c, body);
	}
	const t = c.var.t;
	const db = c.var.db;
	const v = validate(buildInput, body);
	const errors: FieldErrors = v.ok ? {} : { ...v.errors };
	const partId = v.ok ? v.data.part_id : null;
	const data = await newBuildData(c, partId);
	const d = v.ok ? { ...v.data, qty: unitsToBuild(v.data, data.assemblyOptions) } : undefined;
	if (d) Object.assign(errors, await buildPlanErrors(db, d, data.product, data.assemblyOptions));
	if (!d || Object.keys(errors).length > 0 || !data.product) {
		return page(
			c,
			t.builds.new,
			<NewBuildPage
				values={{ ...(body as FormValues), when: "planned" }}
				errors={translateErrors(c, errors)}
				data={data}
			/>,
			422,
		);
	}
	const user = c.var.user;
	// Numbers are sequential; retry once if another user took the same number meanwhile.
	for (let attempt = 0; ; attempt++) {
		try {
			const number = await nextBuildNumber(db);
			const summary = fmt(t.history.summaries.buildCreate, { number, ref: data.product.ref });
			const { results } = await saveChanges(c, summary, [
				createBuildStatement(
					db,
					{
						number,
						partId: data.product.id,
						assemblyId: d.assembly_id as number,
						qtyMilli: d.qty,
						serial: d.serial || null,
						plannedFor: d.planned_for,
						notes: d.notes,
					},
					user,
					nowIso(),
				),
			]);
			return redirectOk(c, `/builds/${results[0][0]?.id}`, "created");
		} catch (err) {
			if (attempt > 0 || !isConstraintError(err, "UNIQUE")) throw err;
		}
	}
});

// ---------------------------------------------------------------------------
// Record a finished build in one step (D152): planned and completed in one change set, which needs both rights.

async function recordBuild(c: Context<AppEnv>, body: Record<string, unknown>) {
	const t = c.var.t;
	const db = c.var.db;
	const v = validate(buildInput, { ...body, planned_for: "" });
	const errors: FieldErrors = v.ok ? {} : { ...v.errors };
	const data = await newBuildData(c, v.ok ? v.data.part_id : null);
	const d = v.ok ? { ...v.data, qty: unitsToBuild(v.data, data.assemblyOptions) } : undefined;
	if (d) Object.assign(errors, await buildPlanErrors(db, d, data.product, data.assemblyOptions));
	const refuse = (problems: string[] = []) =>
		page(
			c,
			t.builds.new,
			<NewBuildPage
				values={{ ...(body as FormValues), when: "done" }}
				errors={translateErrors(c, errors)}
				problems={problems}
				data={data}
			/>,
			422,
		);
	if (!d || Object.keys(errors).length > 0 || !data.product) return refuse();
	const product = data.product;
	const assemblyId = d.assembly_id as number;
	const [graph, onHand] = await Promise.all([loadGraph(db), onHandAt(db)]);
	const pick = buildPickList(
		graph,
		onHand,
		{ assemblyId, qtyMilli: d.qty, serial: d.serial || null },
		product,
		{},
		true,
	);
	const problems = recordProblems(pick);
	if (problems.length) return refuse(problems.map((p) => errorText(t, p.key, p.vars)));
	// Numbers are sequential; retry once if another user took the same number meanwhile.
	for (let attempt = 0; ; attempt++) {
		try {
			const number = await nextBuildNumber(db);
			const { results } = await saveChanges(
				c,
				fmt(t.history.summaries.buildRecord, { number, ref: product.ref }),
				recordStatements(
					db,
					graph,
					{
						number,
						partId: product.id,
						assemblyId,
						qtyMilli: d.qty,
						serial: d.serial || null,
						notes: d.notes,
					},
					pick,
					c.var.user,
					nowIso(),
				),
			);
			return redirectOk(c, `/builds/${(results[0] as { id: number }[])[0]?.id}`, "recorded");
		} catch (err) {
			if (attempt > 0 || !isConstraintError(err, "UNIQUE")) throw err;
		}
	}
}

// The former record page is the new build form, already made (D155).
buildRoutes.get("/record", requirePermission("builds.complete"), (c) => {
	const q = new URLSearchParams(c.req.query());
	q.set("when", "done");
	return c.redirect(`/builds/new?${q}`, 302);
});

buildRoutes.post("/record", requirePermission("builds.complete"), async (c) => {
	if (!can(c.var, "builds.plan")) return forbidden(c);
	return recordBuild(c, await c.req.parseBody());
});

// ---------------------------------------------------------------------------
// Detail, pick list, completion

function BuildHeader(props: { data: BuildData }) {
	const view = useApp();
	const { t } = view;
	const { build, part, assembly } = props.data;
	const open = OPEN_STATUSES.includes(build.status) && can(view, "builds.plan");
	return (
		<PageHeader
			title={`${build.number} · ${part.ref}`}
			subtitle={
				<span class="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
					<BuildStatusBadge status={build.status} />
					<a href={`/parts/${part.id}`}>{part.name}</a>
					<span aria-hidden="true">·</span>
					<span>
						{t.builds.assembly}:{" "}
						<a href={`/assemblies/${assembly.id}`}>
							{assembly.code} ({assembly.revision})
						</a>
					</span>
				</span>
			}
			actions={
				open ? (
					<>
						{build.status === "planned" ? (
							<PostButton action={`/builds/${build.id}/start`} label={t.builds.start} icon={icons.play} />
						) : null}
						<PostButton
							action={`/builds/${build.id}/cancel`}
							label={t.builds.cancel}
							confirm={t.builds.confirmCancel}
							variant="destructive"
							icon={icons.ban}
						/>
					</>
				) : null
			}
		/>
	);
}

/** Collapsible edit form (a <details> card, so it needs no JavaScript). */
function EditCard(props: { data: BuildData; values: FormValues; errors: FormErrors }) {
	const { t } = useApp();
	const p = { values: props.values, errors: props.errors };
	return (
		<CollapsibleCard title={t.common.edit} icon={icons.pencil} open={Object.keys(props.errors).length > 0}>
			<form method="post" action={`/builds/${props.data.build.id}`} class="flex flex-col gap-6">
				<FieldGroup>
					<div class="grid gap-4 md:grid-cols-2">
						<TextField name="serial" label={t.builds.serial} required={props.data.part.trackSerial} {...p} />
						<TextField name="planned_for" label={t.builds.plannedFor} type="date" {...p} />
					</div>
					<TextArea name="notes" label={t.common.notes} {...p} />
				</FieldGroup>
				<div class="flex flex-wrap items-center gap-2">
					<Button variant="outline" icon={icons.save}>
						{t.builds.edit}
					</Button>
				</div>
			</form>
		</CollapsibleCard>
	);
}

/** "Auto / use stock / build now" as a segmented control (shadcn ToggleGroup look) over radio inputs. */
function ChoiceRadios(props: { buildId: number; node: ExplodedNode; current: string }) {
	const { t } = useApp();
	const name = choiceField(props.node.path);
	const recalc = {
		"hx-get": `/builds/${props.buildId}`,
		"hx-include": "closest form",
		"hx-target": "#picklist",
		"hx-select": "#picklist",
		"hx-swap": "outerHTML",
		"hx-trigger": "change",
	};
	const option = (value: string, label: string) => (
		<label
			data-slot="toggle-group-item"
			class="inline-flex min-h-(--control-h) cursor-pointer items-center justify-center border-r px-3 py-1 text-center text-sm leading-tight font-medium transition-colors select-none first:rounded-l-md last:rounded-r-md last:border-r-0 not-has-checked:hover:bg-muted has-checked:bg-primary has-checked:text-primary-foreground has-focus-visible:z-10 has-focus-visible:ring-[3px] has-focus-visible:ring-ring/50 dark:border-input"
		>
			<input type="radio" class="sr-only" name={name} value={value} checked={props.current === value} {...recalc} />
			<span>{label}</span>
		</label>
	);
	return (
		<div
			role="radiogroup"
			aria-label={`${t.builds.source} ${props.node.part.ref}`}
			data-slot="toggle-group"
			class="grid w-full grid-cols-3 rounded-md border bg-background shadow-xs sm:inline-grid sm:w-auto dark:border-input dark:bg-input/30"
		>
			{option("", `${t.builds.auto} (${t.assemblies.modes[props.node.mode]})`)}
			{option("stock", t.builds.useStock)}
			{option("build", t.builds.buildNow)}
		</div>
	);
}

/** Pick lines that need more than the stock on hand. */
function shortLines(pick: PickList) {
	return pick.explosion.requirements.filter((r) => r.qtyMilli > Math.max(0, pick.onHand.get(r.part.id) ?? 0));
}

function SubAssemblies(props: { buildId: number; pick: PickList; values: Record<string, string> }) {
	const { t, locale } = useApp();
	const nodes = makeNodes(props.pick.explosion);
	return (
		<Card id="sub-assemblies">
			<CardHeader>
				<CardTitle icon={icons.layers}>{t.builds.subAssemblies}</CardTitle>
				<CardDescription>{t.builds.subIntro}</CardDescription>
			</CardHeader>
			<CardContent class="flex flex-col gap-4">
				<ul class="m-0 flex list-none flex-col p-0">
					{nodes.map((n) => (
						<li
							class={cn(
								"flex flex-wrap items-center gap-x-6 gap-y-3 border-b py-3 first:pt-0 last:border-b-0 last:pb-0",
								DEPTH_INDENT[Math.min(n.depth, 4)],
							)}
						>
							<div class="flex min-w-0 flex-1 basis-56 flex-col gap-1">
								<div class="flex min-w-0 flex-wrap items-baseline gap-x-2">
									<a href={`/parts/${n.part.id}`} class={REF_LINK}>
										{n.part.ref}
									</a>
									<span class="text-muted-foreground">{n.part.name}</span>
								</div>
								<div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
									<span>
										{t.builds.need}:{" "}
										<span class="font-medium text-foreground">
											<Qty milli={n.qtyMilli} unit={n.part.unit} />
										</span>
									</span>
									<span>
										{fmt(t.builds.available, {
											n: formatQtyInput(Math.max(0, props.pick.onHand.get(n.part.id) ?? 0), locale),
										})}
									</span>
								</div>
							</div>
							<ChoiceRadios buildId={props.buildId} node={n} current={props.values[choiceField(n.path)] ?? ""} />
						</li>
					))}
				</ul>
				<noscript>
					<Button variant="outline" formmethod="get" formaction={`/builds/${props.buildId}`} icon={icons.rotateCcw}>
						{t.builds.recalculate}
					</Button>
				</noscript>
			</CardContent>
		</Card>
	);
}

function SerialInputs(props: {
	partId: number;
	partRef: string;
	count: number;
	values: Record<string, string>;
	errors: Record<string, string>;
	hints: string[];
}) {
	const { t } = useApp();
	const listId = `serials-${props.partId}`;
	return (
		<div class="flex flex-wrap gap-2">
			{Array.from({ length: props.count }, (_, i) => {
				const name = serialField(props.partId, i);
				const error = props.errors[name];
				const errorId = `e-serial-${props.partId}-${i}`;
				return (
					<div data-slot="field" data-invalid={error ? "true" : undefined} class="flex flex-col gap-1">
						<input
							type="text"
							name={name}
							value={props.values[name] ?? ""}
							list={listId}
							placeholder={`#${i + 1}`}
							aria-label={`${t.builds.serial} ${props.partRef} ${i + 1}`}
							aria-invalid={error ? "true" : undefined}
							aria-describedby={error ? errorId : undefined}
							autocomplete="off"
							class="w-44 font-mono"
						/>
						<FieldError id={errorId}>{error ? errorText(t, error) : undefined}</FieldError>
					</div>
				);
			})}
			<datalist id={listId}>
				{props.hints.map((s) => (
					<option value={s} />
				))}
			</datalist>
		</div>
	);
}

function PickListForm(props: {
	data: BuildData;
	pick: PickList;
	values: Record<string, string>;
	serialHints: Map<number, string[]>;
}) {
	const view = useApp();
	const { t, locale } = view;
	const { build } = props.data;
	const { pick } = props;
	const requirements = pick.explosion.requirements;
	const goesNegative = shortLines(pick).length > 0;
	const hasErrors = Object.keys(pick.errors).length > 0 || pick.problems.length > 0;
	return (
		<form
			method="post"
			action={`/builds/${build.id}/complete`}
			id="picklist"
			class="flex flex-col gap-6"
			data-confirm={t.builds.completeConfirm}
		>
			{hasErrors ? (
				<Alert variant="destructive" class="mb-0">
					{t.common.fixErrors}
				</Alert>
			) : null}
			{pick.problems.map((p) => (
				<Alert variant="destructive" class="mb-0">
					{errorText(t, p.key, p.vars)}
				</Alert>
			))}
			{makeNodes(pick.explosion).length ? <SubAssemblies buildId={build.id} pick={pick} values={props.values} /> : null}
			<Card id="pick-lines">
				<CardHeader>
					<CardTitle icon={icons.listChecks}>
						{t.builds.pickList}
						<Badge variant="secondary">{requirements.length}</Badge>
					</CardTitle>
					<CardDescription>{t.builds.pickIntro}</CardDescription>
				</CardHeader>
				{goesNegative ? (
					<CardContent>
						<Alert variant="warning" class="mb-0">
							{t.builds.negativeWarning}
						</Alert>
					</CardContent>
				) : null}
				<CardContent class="px-0">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead class="w-px">{t.builds.picked}</TableHead>
								<TableHead>{t.builds.component}</TableHead>
								<TableHead class="text-right">{t.builds.need}</TableHead>
								<TableHead class="text-right">{t.builds.onHand}</TableHead>
								<TableHead>{t.builds.serials}</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{requirements.map((r) => {
								const onHand = pick.onHand.get(r.part.id) ?? 0;
								const short = r.qtyMilli - Math.max(0, onHand);
								return (
									<TableRow class="has-checked:bg-success/10 has-checked:hover:bg-success/15">
										<TableCell class="w-px py-1 pr-0">
											<label class="flex size-12 cursor-pointer items-center justify-center rounded-md hover:bg-muted">
												<input
													type="checkbox"
													name={`picked:${r.part.id}`}
													aria-label={`${t.builds.picked} ${r.part.ref}`}
													class="size-6"
												/>
											</label>
										</TableCell>
										<TableCell>
											<div class="flex flex-wrap items-center gap-x-2 gap-y-1">
												<a href={`/parts/${r.part.id}`} class={REF_LINK}>
													{r.part.ref}
												</a>
												<span>{r.part.name}</span>
												<KindBadge kind={r.part.kind} />
											</div>
										</TableCell>
										<TableCell class="text-right text-base font-semibold">
											<Qty milli={r.qtyMilli} unit={r.part.unit} />
										</TableCell>
										<TableCell class="text-right">
											<div class="flex flex-col items-end gap-1">
												<Qty milli={onHand} unit={r.part.unit} />
												{short > 0 ? (
													<Badge variant="warning">{fmt(t.builds.short, { n: formatQtyInput(short, locale) })}</Badge>
												) : null}
											</div>
										</TableCell>
										<TableCell>
											{r.part.trackSerial ? (
												<SerialInputs
													partId={r.part.id}
													partRef={r.part.ref}
													count={serialCount(r)}
													values={props.values}
													errors={pick.errors}
													hints={props.serialHints.get(r.part.id) ?? []}
												/>
											) : null}
										</TableCell>
									</TableRow>
								);
							})}
						</TableBody>
					</Table>
				</CardContent>
				{pick.explosion.fees.length ? (
					<CardFooter class="border-t text-sm text-muted-foreground">
						<Icon icon={icons.receipt} class="size-4" />
						<span>
							{t.builds.fees}:{" "}
							{pick.explosion.fees.map((f) => `${f.part.ref} × ${formatQtyInput(f.qtyMilli, locale)}`).join(", ")}
						</span>
					</CardFooter>
				) : null}
			</Card>
			{can(view, "builds.complete") ? (
				<div class="sticky bottom-0 z-10 flex flex-wrap items-center justify-end gap-3 border-t bg-background/90 py-4 backdrop-blur print:hidden">
					<Button size="lg" icon={icons.packageCheck} class="w-full sm:w-auto">
						{t.builds.complete}
					</Button>
				</div>
			) : null}
		</form>
	);
}

function AsBuilt(props: {
	lines: Awaited<ReturnType<typeof getBuildLines>>;
	outputCost: number | null;
	qtyMilli: number;
}) {
	const { t, seeCosts } = useApp();
	const incomplete = props.lines.some((l) => l.line.unitCostCents === null);
	const materials = props.lines.reduce(
		(s, l) => s + (l.line.unitCostCents === null ? 0 : lineCostCents(l.line.qtyMilli, l.line.unitCostCents)),
		0,
	);
	return (
		<Card>
			<CardHeader>
				<CardTitle icon={icons.clipboardCheck}>{t.builds.asBuilt}</CardTitle>
				<CardDescription>{t.builds.asBuiltIntro}</CardDescription>
			</CardHeader>
			<CardContent class="px-0">
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>{t.builds.component}</TableHead>
							<TableHead>{t.builds.serial}</TableHead>
							<TableHead class="text-right">{t.builds.qty}</TableHead>
							{seeCosts ? (
								<>
									<TableHead class="text-right">{t.builds.unitCost}</TableHead>
									<TableHead class="text-right">{t.builds.lineCost}</TableHead>
								</>
							) : null}
						</TableRow>
					</TableHeader>
					<TableBody>
						{props.lines.map(({ line, ref, name, kind, unit, sourceBuildId, sourceBuildNumber }) => (
							<TableRow>
								<TableCell>
									<div class="flex flex-wrap items-center gap-x-2 gap-y-1">
										<a href={`/parts/${line.partId}`} class={REF_LINK}>
											{ref}
										</a>
										<span>{name}</span>
										<KindBadge kind={kind} />
									</div>
								</TableCell>
								<TableCell>
									<div class="flex flex-wrap items-center gap-x-2 gap-y-1">
										{line.serial ? <span class={CODE}>{line.serial}</span> : null}
										{sourceBuildId ? (
											<a
												href={`/builds/${sourceBuildId}`}
												class="inline-flex items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
											>
												<Icon icon={icons.hammer} class="size-3.5" />
												{fmt(t.builds.builtIn, { number: sourceBuildNumber ?? "" })}
											</a>
										) : null}
									</div>
								</TableCell>
								<TableCell class="text-right">
									<Qty milli={line.qtyMilli} unit={unit} />
								</TableCell>
								{seeCosts ? (
									<>
										<TableCell class="text-right">
											<Money cents={line.unitCostCents} />
										</TableCell>
										<TableCell class="text-right">
											{line.unitCostCents === null ? null : (
												<Money cents={lineCostCents(line.qtyMilli, line.unitCostCents)} />
											)}
										</TableCell>
									</>
								) : null}
							</TableRow>
						))}
					</TableBody>
					{seeCosts ? (
						<TableFooter>
							<TableRow>
								<TableCell colspan={4}>{t.common.total}</TableCell>
								<TableCell class="text-right">
									<Money cents={materials} />
								</TableCell>
							</TableRow>
							{props.outputCost !== null ? (
								<TableRow>
									<TableCell colspan={4}>{t.builds.totalCost}</TableCell>
									<TableCell class="text-right font-semibold">
										<Money cents={lineCostCents(props.qtyMilli, props.outputCost)} />
										{incomplete ? <span class="text-warning"> *</span> : null}
									</TableCell>
								</TableRow>
							) : null}
						</TableFooter>
					) : null}
				</Table>
			</CardContent>
			{seeCosts && incomplete ? (
				<CardFooter>
					<Alert variant="warning" class="mb-0">
						{t.builds.costIncomplete}
					</Alert>
				</CardFooter>
			) : null}
		</Card>
	);
}

async function renderBuild(
	c: Context<AppEnv>,
	data: BuildData,
	form: Record<string, string>,
	opts: { validate?: boolean; editErrors?: FieldErrors; editValues?: FormValues; status?: 200 | 422 } = {},
) {
	const t = c.var.t;
	const db = c.var.db;
	const { build, part } = data;
	const ok = c.req.query("ok");
	const flash =
		ok === "completed"
			? t.builds.completed
			: ok === "recorded"
				? t.builds.recorded
				: ok === "started"
					? t.builds.started
					: ok === "cancelled"
						? t.builds.cancelled
						: ok === "created"
							? t.builds.created
							: undefined;
	const open = OPEN_STATUSES.includes(build.status);
	const batch = data.assembly.batchQtyMilli;
	const qtyStat = (
		<StatCard
			label={t.builds.qty}
			value={<Qty milli={build.qtyMilli} unit={part.unit} />}
			hint={
				batch !== MILLI
					? fmt(t.builds.batches, { n: formatQty(mulDivRound(build.qtyMilli, MILLI, batch), c.var.locale) })
					: undefined
			}
			icon={icons.package}
		/>
	);
	const serialStat = <StatCard label={t.builds.serial} value={build.serial ?? t.common.none} icon={icons.barcode} />;
	const plannedStat = (
		<StatCard label={t.builds.plannedFor} value={build.plannedFor ?? t.common.none} icon={icons.calendar} />
	);
	let stats: Child;
	let body: Child;
	if (open) {
		const [graph, onHand] = await Promise.all([loadGraph(db), onHandAt(db)]);
		const pick = buildPickList(graph, onHand, build, part, form, opts.validate ?? false);
		const calc = new CostCalculator(graph);
		const tracked = pick.explosion.requirements.filter((r) => r.part.trackSerial);
		const hints = new Map(
			await Promise.all(tracked.map(async (r) => [r.part.id, await serialsInStock(db, r.part.id)] as const)),
		);
		const short = shortLines(pick).length;
		stats = (
			<>
				{qtyStat}
				{serialStat}
				{plannedStat}
				<StatCard
					label={t.builds.toPick}
					value={pick.explosion.requirements.length}
					icon={icons.listChecks}
					hint={short > 0 ? fmt(t.builds.shortLines, { n: short }) : t.builds.allAvailable}
					tone={short > 0 ? "warning" : "default"}
				/>
			</>
		);
		body = (
			<>
				{can(c.var, "builds.plan") ? (
					<EditCard
						data={data}
						values={
							opts.editValues ?? {
								serial: build.serial ?? "",
								planned_for: build.plannedFor ?? "",
								notes: build.notes,
							}
						}
						errors={translateErrors(c, opts.editErrors ?? {})}
					/>
				) : null}
				<PickListForm data={data} pick={pick} values={form} serialHints={hints} />
				{pick.explosion.machines.length ? (
					<MachineTimeCard
						id="machine-time"
						title={t.machines.time}
						rows={pick.explosion.machines.map((m) => {
							const cost = calc.machine(m.machineType.id, m.minutesMilli);
							return {
								machineTypeId: m.machineType.id,
								name: m.machineType.name,
								minutesMilli: m.minutesMilli,
								rateCents: m.machineType.rateCents,
								costCents: cost.incomplete ? null : centsOf(cost.millicents),
							};
						})}
					/>
				) : null}
			</>
		);
	} else {
		const done = build.status === "done";
		const [lines, machineTimes, output, actual] = await Promise.all([
			getBuildLines(db, build.id),
			getBuildMachineTimes(db, build.id),
			db
				.select({ unitCostCents: stockMoves.unitCostCents })
				.from(stockMoves)
				.where(
					and(eq(stockMoves.refType, "build"), eq(stockMoves.refId, build.id), eq(stockMoves.reason, "build_output")),
				)
				.limit(1),
			done ? buildActualCost(db, build.id) : null,
		]);
		const outputCost = output[0]?.unitCostCents ?? null;
		const doneAt = shortDateTime(build.doneAt);
		const incomplete =
			lines.some((l) => l.line.unitCostCents === null) || machineTimes.some((m) => m.rateCents === null);
		// Two different costs: the one frozen at completion (standard costs) and the actual one (weighted average).
		const priceCents = salePriceOf(part, data.assembly);
		const margin = marginOf(priceCents, actual?.unitCents ?? null);
		const low = !margin || actual?.incomplete || (margin.rateBp !== null && margin.rateBp < LOW_MARGIN_BP);
		const marginStatTone = margin && margin.marginCents < 0 ? "destructive" : low ? "warning" : "default";
		const costs = done && c.var.seeCosts;
		stats = (
			<>
				{qtyStat}
				{serialStat}
				{done ? (
					<StatCard
						label={t.builds.doneAt}
						value={doneAt.slice(0, 10)}
						hint={`${doneAt.slice(11)} · ${build.updatedBy}`}
						icon={icons.calendarClock}
					/>
				) : (
					plannedStat
				)}
				{costs ? (
					<StatCard
						label={t.builds.recordedCost}
						value={<Money cents={outputCost === null ? null : lineCostCents(build.qtyMilli, outputCost)} />}
						hint={incomplete ? t.builds.costIncomplete : t.builds.recordedCostHint}
						icon={icons.coins}
						tone={incomplete ? "warning" : "default"}
					/>
				) : null}
				{costs && actual ? (
					<StatCard
						label={t.builds.actualUnitCost}
						value={<Money cents={actual.unitCents} />}
						hint={actual.incomplete ? t.builds.actualIncomplete : t.builds.actualUnitCostHint}
						icon={icons.scale}
						tone={actual.incomplete ? "warning" : "default"}
					/>
				) : null}
				{costs && priceCents !== null ? (
					<StatCard
						label={t.builds.margin}
						value={
							margin ? (
								<span class={marginTone(margin)}>
									<Money cents={margin.marginCents} />
								</span>
							) : (
								t.common.none
							)
						}
						hint={fmt(t.builds.marginHint, {
							rate: margin?.rateBp == null ? t.common.none : formatPercent(margin.rateBp, c.var.locale),
							price: formatMoney(priceCents, c.var.locale, c.env.CURRENCY || "EUR"),
						})}
						icon={icons.tag}
						tone={marginStatTone}
					/>
				) : null}
			</>
		);
		body = (
			<>
				{build.notes ? (
					<Card>
						<CardHeader>
							<CardTitle>{t.common.notes}</CardTitle>
						</CardHeader>
						<CardContent>
							<p class="text-sm whitespace-pre-wrap">{build.notes}</p>
						</CardContent>
					</Card>
				) : null}
				{done ? <AsBuilt lines={lines} outputCost={outputCost} qtyMilli={build.qtyMilli} /> : null}
				{machineTimes.length ? (
					<MachineTimeCard
						id="machine-time"
						title={t.machines.recorded}
						rows={machineTimes.map((m) => ({
							machineTypeId: m.machineTypeId,
							name: m.name,
							minutesMilli: m.minutesMilli,
							rateCents: m.rateCents,
							costCents: m.rateCents === null ? null : centsOf(machineMillicents(m.rateCents, m.minutesMilli)),
						}))}
					/>
				) : null}
			</>
		);
	}
	// What the person building needs to open: the revision's files, then the part's own (D159).
	const [revisionFiles, ownFiles] = await Promise.all([assemblyFiles(db, data.assembly.id), partFiles(db, part.id)]);
	return page(
		c,
		`${build.number} · ${part.ref}`,
		<>
			<BuildHeader data={data} />
			<Flash message={flash} />
			{c.req.query("err") ? <Alert variant="destructive">{errorText(t, c.req.query("err") ?? "")}</Alert> : null}
			{/* A done build has up to six cards (costs and margin): three per row instead of four. */}
			<div class={cn("mb-6 grid grid-cols-2 gap-3 md:grid-cols-4", build.status === "done" && "md:grid-cols-3")}>
				{stats}
			</div>
			<div class="flex flex-col gap-6">
				<BuildFilesCard
					revision={`${data.assembly.code} ${data.assembly.revision}`}
					assemblyFiles={revisionFiles}
					partFiles={ownFiles}
					enabled={filesBucket(c.env) !== null}
				/>
				{body}
			</div>
		</>,
		opts.status ?? 200,
	);
}

async function loadBuildData(c: Context<AppEnv>) {
	const id = idParam(c);
	return id ? getBuild(c.var.db, id) : undefined;
}

buildRoutes.get("/:id", async (c) => {
	const data = await loadBuildData(c);
	if (!data) return notFound(c);
	// Choices and serials typed so far travel in the query string when recalculating.
	return renderBuild(c, data, c.req.query());
});

buildRoutes.post("/:id", requirePermission("builds.plan"), async (c) => {
	const data = await loadBuildData(c);
	if (!data) return notFound(c);
	const { build, part } = data;
	if (!OPEN_STATUSES.includes(build.status)) return c.redirect(`/builds/${build.id}?err=build_not_open`, 303);
	const body = await c.req.parseBody();
	const v = validate(buildEditInput, body);
	const errors: FieldErrors = v.ok ? {} : { ...v.errors };
	if (v.ok) {
		if (part.trackSerial && !v.data.serial) errors.serial = "build_serial_required";
		if (v.data.serial && (await buildSerialTaken(c.var.db, part.id, v.data.serial, build.id)))
			errors.serial = "build_serial_taken";
	}
	if (!v.ok || Object.keys(errors).length > 0) {
		return renderBuild(c, data, {}, { editErrors: errors, editValues: body as FormValues, status: 422 });
	}
	await saveChanges(c, fmt(c.var.t.history.summaries.buildEdit, { number: build.number }), [
		updateBuildStatement(
			c.var.db,
			build.id,
			{ serial: v.data.serial || null, plannedFor: v.data.planned_for, notes: v.data.notes },
			c.var.user,
			nowIso(),
		),
	]);
	return redirectOk(c, `/builds/${build.id}`);
});

buildRoutes.post("/:id/start", requirePermission("builds.plan"), async (c) => {
	const data = await loadBuildData(c);
	if (!data) return notFound(c);
	await saveChanges(c, fmt(c.var.t.history.summaries.buildStart, { number: data.build.number }), [
		startBuildStatement(c.var.db, data.build.id, c.var.user, nowIso()),
	]);
	return redirectOk(c, `/builds/${data.build.id}`, "started");
});

buildRoutes.post("/:id/cancel", requirePermission("builds.plan"), async (c) => {
	const data = await loadBuildData(c);
	if (!data) return notFound(c);
	await saveChanges(c, fmt(c.var.t.history.summaries.buildCancel, { number: data.build.number }), [
		cancelBuildStatement(c.var.db, data.build.id, c.var.user, nowIso()),
	]);
	return redirectOk(c, `/builds/${data.build.id}`, "cancelled");
});

buildRoutes.post("/:id/complete", requirePermission("builds.complete"), async (c) => {
	const data = await loadBuildData(c);
	if (!data) return notFound(c);
	const db = c.var.db;
	const { build, part } = data;
	if (!OPEN_STATUSES.includes(build.status)) return c.redirect(`/builds/${build.id}?err=build_not_open`, 303);
	const body = await c.req.parseBody();
	const form: Record<string, string> = {};
	for (const [k, v] of Object.entries(body)) if (typeof v === "string") form[k] = v;
	// Never trust client quantities: re-explode with current stock and the submitted choices.
	const [graph, onHand] = await Promise.all([loadGraph(db), onHandAt(db)]);
	const pick = buildPickList(graph, onHand, build, part, form, true);
	if (Object.keys(pick.errors).length > 0 || pick.problems.length > 0) {
		return renderBuild(c, data, form, { validate: true, status: 422 });
	}
	try {
		await saveChanges(
			c,
			fmt(c.var.t.history.summaries.buildComplete, { number: build.number }),
			completionStatements(db, graph, { ...build }, pick, c.var.user, nowIso()),
		);
	} catch (err) {
		// The unique build_output index aborts a second completion of the same build.
		if (isConstraintError(err, "UNIQUE")) return c.redirect(`/builds/${build.id}?err=build_not_open`, 303);
		throw err;
	}
	return redirectOk(c, `/builds/${build.id}`, "completed");
});

/** Recent builds of a part, for the part page. */
export async function recentBuildsOf(c: Context<AppEnv>, partId: number) {
	return listBuilds(c.var.db, { status: "all", partId, limit: 10 });
}
