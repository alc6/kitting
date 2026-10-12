import { and, asc, eq, inArray, ne } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import type { Child } from "hono/jsx";
import { BUILD_STATUSES, type BuildStatus, boms, builds, type Part, parts, stockMoves } from "../db/schema";
import type { ExplodedNode } from "../domain/bom-graph";
import { loadGraph } from "../domain/boms";
import {
	buildEditInput,
	buildInput,
	buildPickList,
	choiceField,
	completionStatements,
	getBuild,
	getBuildLines,
	listBuilds,
	makeNodes,
	nextBuildNumber,
	OPEN_STATUSES,
	type PickList,
	serialCount,
	serialField,
} from "../domain/builds";
import { buildActualCost, marginOf, salePriceOf } from "../domain/margins";
import { onHandAt, serialsInStock } from "../domain/stock";
import { errorText, fmt } from "../i18n";
import { cn } from "../lib/cn";
import { runBatch } from "../lib/db";
import { isConstraintError } from "../lib/sql";
import { formatMoney, formatPercent, formatQtyInput, lineCostCents, MILLI } from "../lib/units";
import { type FieldErrors, validate } from "../lib/validation";
import type { AppEnv } from "../types";
import { useApp } from "../views/context";
import { Icon, icons } from "../views/icons";
import { idParam, notFound, nowIso, page, redirectOk, translateErrors } from "../views/render";
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
					<TableHead>{t.builds.bom}</TableHead>
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
							{b.bomCode} · {b.bomRevision}
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

buildRoutes.get("/", async (c) => {
	const t = c.var.t;
	const q = c.req.query("q") ?? "";
	const status = c.req.query("status") ?? "open";
	const rows = await listBuilds(c.var.db, { q, status });
	return page(
		c,
		t.builds.title,
		<>
			<PageHeader
				title={t.builds.title}
				subtitle={t.builds.intro}
				actions={<LinkButton href="/builds/new" label={t.builds.new} icon={icons.plus} />}
			/>
			<Flash ok={c.req.query("ok")} message={c.req.query("ok") === "cancelled" ? t.builds.cancelled : undefined} />
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
			<div id="results">
				{rows.length ? (
					<Card class="gap-0 overflow-hidden py-0">
						<BuildsTable rows={rows} />
					</Card>
				) : (
					<EmptyState icon={icons.hammer} title={t.builds.noBuilds} description={t.builds.emptyHint}>
						<LinkButton href="/builds/new" label={t.builds.new} icon={icons.plus} variant="outline" />
					</EmptyState>
				)}
			</div>
		</>,
	);
});

// ---------------------------------------------------------------------------
// New build

type BomOption = { id: number; code: string; revision: string };

function NewBuildForm(props: {
	values: FormValues;
	errors: FormErrors;
	products: { id: number; ref: string; name: string }[];
	product: Part | undefined;
	bomOptions: BomOption[];
}) {
	const { t } = useApp();
	const p = { values: props.values, errors: props.errors };
	const reload = {
		"hx-get": "/builds/new",
		"hx-include": "closest form",
		"hx-target": "#build-form",
		"hx-select": "#build-form",
		"hx-swap": "outerHTML",
	};
	const partError = props.errors.part_id;
	const ready = props.product !== undefined && props.bomOptions.length > 0;
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
								<Button variant="outline" formmethod="get" formaction="/builds/new">
									{t.builds.choosePart}
								</Button>
							</div>
							<FieldDescription>{t.builds.partHint}</FieldDescription>
							<FieldError id="e-part_id">{partError}</FieldError>
						</div>
						{props.product ? (
							props.bomOptions.length === 0 ? (
								<Alert variant="warning" class="mb-0">
									<p>
										{t.builds.noActiveBom} <a href={`/boms/new?part=${props.product.id}`}>{t.boms.new}</a>
									</p>
								</Alert>
							) : (
								<>
									<div class="grid gap-4 md:grid-cols-2">
										<SelectField
											name="bom_id"
											label={t.builds.variant}
											required
											options={props.bomOptions.map((b) => ({
												value: String(b.id),
												label: `${b.code} (${b.revision})`,
											}))}
											{...p}
										/>
										<TextField name="qty" label={t.builds.qty} inputmode="decimal" required {...p} />
										<TextField
											name="serial"
											label={t.builds.serial}
											hint={props.product.trackSerial ? t.builds.serialHint : undefined}
											required={props.product.trackSerial}
											{...p}
										/>
										<TextField name="planned_for" label={t.builds.plannedFor} type="date" {...p} />
									</div>
									<TextArea name="notes" label={t.common.notes} {...p} />
								</>
							)
						) : null}
					</FieldGroup>
					{ready ? (
						<div class="flex flex-wrap items-center gap-2">
							<Button icon={icons.plus}>{t.common.create}</Button>
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

async function newBuildData(c: Context<AppEnv>, partId: number | null) {
	const db = c.var.db;
	const products = await db
		.select({ id: parts.id, ref: parts.ref, name: parts.name })
		.from(parts)
		.where(and(eq(parts.kind, "make"), eq(parts.archived, false)))
		.orderBy(asc(parts.ref));
	const product = partId ? (await db.select().from(parts).where(eq(parts.id, partId)).limit(1))[0] : undefined;
	const bomOptions = product
		? await db
				.select({ id: boms.id, code: boms.code, revision: boms.revision })
				.from(boms)
				.where(and(eq(boms.parentPartId, product.id), eq(boms.status, "active")))
				.orderBy(asc(boms.code))
		: [];
	return { products, product: product?.kind === "make" ? product : undefined, bomOptions };
}

buildRoutes.get("/new", async (c) => {
	const t = c.var.t;
	const q = c.req.query();
	const partId = /^\d+$/.test(q.part_id ?? q.part ?? "") ? Number(q.part_id ?? q.part) : null;
	const data = await newBuildData(c, partId);
	const std = data.bomOptions.find((b) => b.code === "std") ?? data.bomOptions[0];
	const values: FormValues = {
		qty: "1",
		...q,
		part_id: partId ? String(partId) : "",
		bom_id: q.bom_id && data.bomOptions.some((b) => String(b.id) === q.bom_id) ? q.bom_id : std ? String(std.id) : "",
	};
	return page(
		c,
		t.builds.new,
		<>
			<PageHeader title={t.builds.new} subtitle={t.builds.newIntro} />
			<NewBuildForm values={values} errors={{}} {...data} />
		</>,
	);
});

buildRoutes.post("/", async (c) => {
	const t = c.var.t;
	const db = c.var.db;
	const body = await c.req.parseBody();
	const v = validate(buildInput, body);
	const errors: FieldErrors = v.ok ? {} : { ...v.errors };
	const partId = v.ok ? v.data.part_id : null;
	const data = await newBuildData(c, partId);
	if (v.ok) {
		const d = v.data;
		if (!data.product) errors.part_id = d.part_id ? "build_part_kind" : "required";
		else {
			if (!d.bom_id || !data.bomOptions.some((b) => b.id === d.bom_id)) errors.bom_id = "build_bom_mismatch";
			if (data.product.trackSerial) {
				if (d.qty !== MILLI) errors.qty = "build_serial_qty";
				if (!d.serial) errors.serial = "build_serial_required";
			}
			if (d.serial) {
				const taken = await db
					.select({ id: builds.id })
					.from(builds)
					.where(and(eq(builds.partId, data.product.id), eq(builds.serial, d.serial), ne(builds.status, "cancelled")))
					.limit(1);
				if (taken.length) errors.serial = "build_serial_taken";
			}
		}
	}
	if (!v.ok || Object.keys(errors).length > 0 || !data.product) {
		return page(
			c,
			t.builds.new,
			<>
				<PageHeader title={t.builds.new} subtitle={t.builds.newIntro} />
				<NewBuildForm values={body as FormValues} errors={translateErrors(c, errors)} {...data} />
			</>,
			422,
		);
	}
	const d = v.data;
	const user = c.var.user;
	// Numbers are sequential; retry once if another user took the same number meanwhile.
	for (let attempt = 0; ; attempt++) {
		try {
			const [row] = await db
				.insert(builds)
				.values({
					number: await nextBuildNumber(db),
					partId: data.product.id,
					bomId: d.bom_id as number,
					qtyMilli: d.qty,
					serial: d.serial || null,
					plannedFor: d.planned_for,
					notes: d.notes,
					createdBy: user,
					updatedBy: user,
				})
				.returning({ id: builds.id });
			return redirectOk(c, `/builds/${row?.id}`, "created");
		} catch (err) {
			if (attempt > 0 || !isConstraintError(err, "UNIQUE")) throw err;
		}
	}
});

// ---------------------------------------------------------------------------
// Detail, pick list, completion

function BuildHeader(props: { data: BuildData }) {
	const { t } = useApp();
	const { build, part, bom } = props.data;
	const open = OPEN_STATUSES.includes(build.status);
	return (
		<PageHeader
			title={`${build.number} · ${part.ref}`}
			subtitle={
				<span class="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
					<BuildStatusBadge status={build.status} />
					<a href={`/parts/${part.id}`}>{part.name}</a>
					<span aria-hidden="true">·</span>
					<span>
						{t.builds.bom}:{" "}
						<a href={`/boms/${bom.id}`}>
							{bom.code} ({bom.revision})
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
			{option("", `${t.builds.auto} (${t.boms.modes[props.node.mode]})`)}
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
	const { t, locale } = useApp();
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
			<div class="sticky bottom-0 z-10 flex flex-wrap items-center justify-end gap-3 border-t bg-background/90 py-4 backdrop-blur print:hidden">
				<Button size="lg" icon={icons.packageCheck} class="w-full sm:w-auto">
					{t.builds.complete}
				</Button>
			</div>
		</form>
	);
}

function AsBuilt(props: {
	lines: Awaited<ReturnType<typeof getBuildLines>>;
	outputCost: number | null;
	qtyMilli: number;
}) {
	const { t } = useApp();
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
							<TableHead class="text-right">{t.builds.unitCost}</TableHead>
							<TableHead class="text-right">{t.builds.lineCost}</TableHead>
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
								<TableCell class="text-right">
									<Money cents={line.unitCostCents} />
								</TableCell>
								<TableCell class="text-right">
									{line.unitCostCents === null ? null : (
										<Money cents={lineCostCents(line.qtyMilli, line.unitCostCents)} />
									)}
								</TableCell>
							</TableRow>
						))}
					</TableBody>
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
				</Table>
			</CardContent>
			{incomplete ? (
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
			: ok === "started"
				? t.builds.started
				: ok === "cancelled"
					? t.builds.cancelled
					: ok === "created"
						? t.builds.created
						: undefined;
	const open = OPEN_STATUSES.includes(build.status);
	const qtyStat = (
		<StatCard label={t.builds.qty} value={<Qty milli={build.qtyMilli} unit={part.unit} />} icon={icons.package} />
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
				<PickListForm data={data} pick={pick} values={form} serialHints={hints} />
			</>
		);
	} else {
		const done = build.status === "done";
		const [lines, output, actual] = await Promise.all([
			getBuildLines(db, build.id),
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
		const incomplete = lines.some((l) => l.line.unitCostCents === null);
		// Two different costs: the one frozen at completion (standard costs) and the actual one (weighted average).
		const priceCents = salePriceOf(part, data.bom);
		const margin = marginOf(priceCents, actual?.unitCents ?? null);
		const low = !margin || actual?.incomplete || (margin.rateBp !== null && margin.rateBp < LOW_MARGIN_BP);
		const marginStatTone = margin && margin.marginCents < 0 ? "destructive" : low ? "warning" : "default";
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
				{done ? (
					<StatCard
						label={t.builds.recordedCost}
						value={<Money cents={outputCost === null ? null : lineCostCents(build.qtyMilli, outputCost)} />}
						hint={incomplete ? t.builds.costIncomplete : t.builds.recordedCostHint}
						icon={icons.coins}
						tone={incomplete ? "warning" : "default"}
					/>
				) : null}
				{done && actual ? (
					<StatCard
						label={t.builds.actualUnitCost}
						value={<Money cents={actual.unitCents} />}
						hint={actual.incomplete ? t.builds.actualIncomplete : t.builds.actualUnitCostHint}
						icon={icons.scale}
						tone={actual.incomplete ? "warning" : "default"}
					/>
				) : null}
				{done && priceCents !== null ? (
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
			</>
		);
	}
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
			<div class="flex flex-col gap-6">{body}</div>
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

buildRoutes.post("/:id", async (c) => {
	const data = await loadBuildData(c);
	if (!data) return notFound(c);
	const { build, part } = data;
	if (!OPEN_STATUSES.includes(build.status)) return c.redirect(`/builds/${build.id}?err=build_not_open`, 303);
	const body = await c.req.parseBody();
	const v = validate(buildEditInput, body);
	const errors: FieldErrors = v.ok ? {} : { ...v.errors };
	if (v.ok) {
		if (part.trackSerial && !v.data.serial) errors.serial = "build_serial_required";
		if (v.data.serial) {
			const taken = await c.var.db
				.select({ id: builds.id })
				.from(builds)
				.where(
					and(
						eq(builds.partId, part.id),
						eq(builds.serial, v.data.serial),
						ne(builds.status, "cancelled"),
						ne(builds.id, build.id),
					),
				)
				.limit(1);
			if (taken.length) errors.serial = "build_serial_taken";
		}
	}
	if (!v.ok || Object.keys(errors).length > 0) {
		return renderBuild(c, data, {}, { editErrors: errors, editValues: body as FormValues, status: 422 });
	}
	await c.var.db
		.update(builds)
		.set({
			serial: v.data.serial || null,
			plannedFor: v.data.planned_for,
			notes: v.data.notes,
			updatedAt: nowIso(),
			updatedBy: c.var.user,
		})
		.where(eq(builds.id, build.id));
	return redirectOk(c, `/builds/${build.id}`);
});

buildRoutes.post("/:id/start", async (c) => {
	const data = await loadBuildData(c);
	if (!data) return notFound(c);
	await c.var.db
		.update(builds)
		.set({ status: "in_progress", updatedAt: nowIso(), updatedBy: c.var.user })
		.where(and(eq(builds.id, data.build.id), eq(builds.status, "planned")));
	return redirectOk(c, `/builds/${data.build.id}`, "started");
});

buildRoutes.post("/:id/cancel", async (c) => {
	const data = await loadBuildData(c);
	if (!data) return notFound(c);
	await c.var.db
		.update(builds)
		.set({ status: "cancelled", updatedAt: nowIso(), updatedBy: c.var.user })
		.where(and(eq(builds.id, data.build.id), inArray(builds.status, OPEN_STATUSES)));
	return redirectOk(c, `/builds/${data.build.id}`, "cancelled");
});

buildRoutes.post("/:id/complete", async (c) => {
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
		await runBatch(db, completionStatements(db, graph, { ...build }, pick, c.var.user, nowIso()));
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
