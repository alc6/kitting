import { and, asc, eq } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import type { Child } from "hono/jsx";
import { z } from "zod";
import { ASSEMBLY_STATUSES, type Assembly, assemblies, assemblyLines, type Part, parts } from "../db/schema";
import {
	activateStatements,
	addAssemblyLineStatements,
	archivedAssemblyCycles,
	assemblyInput,
	assemblyLabel,
	assemblyLineInput,
	assemblySalePriceStatements,
	checkProduction,
	componentError,
	createAssemblyStatements,
	DEFAULT_CODE,
	DEFAULT_REVISION,
	deleteAssemblyLineStatements,
	deleteAssemblyStatement,
	findAssembly,
	getAssembly,
	getAssemblyLines,
	keptSalePrice,
	listAssemblies,
	loadGraph,
	newAssemblyErrors,
	nextRevision,
	productionError,
	productionInput,
	reorderAssemblyLinesStatements,
	setAssemblyStatusStatement,
	setProductionStatement,
	updateAssemblyLineQtyStatements,
} from "../domain/assemblies";
import {
	type Cost,
	CostCalculator,
	centsOf,
	type ExplodedNode,
	type Explosion,
	explode,
	walkTree,
} from "../domain/assembly-graph";
import { assemblyFiles, filesBucket } from "../domain/files";
import { type Margin, marginOf, salePriceOf } from "../domain/margins";
import { onHandMap, partOptions } from "../domain/parts";
import { can } from "../domain/permissions";
import { errorText, fmt } from "../i18n";
import { cn } from "../lib/cn";
import { isConstraintError } from "../lib/sql";
import {
	ceilDiv,
	formatCentsInput,
	formatMinutesInput,
	formatMoney,
	formatPercent,
	formatQty,
	formatQtyInput,
	MILLI,
	type NumberLocale,
	parseMilli,
	roundDiv,
} from "../lib/units";
import { type FieldErrors, field, validate } from "../lib/validation";
import { requirePermission } from "../middleware/roles";
import type { AppEnv } from "../types";
import { CostView, missingNames, StatusBadge } from "../views/assembly";
import { AssemblyDiagram, type DiagramView, diagramTree, treeDepth } from "../views/assembly-diagram";
import { useApp } from "../views/context";
import { FilesCard, uploadErrorText } from "../views/files";
import { Icon, type IconNode, icons } from "../views/icons";
import { Duration, MachineTimeCard, type MachineTimeRow } from "../views/machines";
import { PartPicker, PartPickerDialog, PartSelectPicker } from "../views/part-picker";
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
	DecimalField,
	DetailList,
	Empty,
	EmptyState,
	ErrorBanner,
	FieldGroup,
	Flash,
	type FormErrors,
	type FormValues,
	InlineEdit,
	KindBadge,
	LinkButton,
	LinkTabs,
	Money,
	MoreMenu,
	PageHeader,
	PostButton,
	Qty,
	SearchBar,
	SelectField,
	StatCard,
	Table,
	TableBody,
	TableCell,
	TableFooter,
	TableHead,
	TableHeader,
	TableRow,
	TextArea,
	TextField,
	ToggleLinks,
} from "../views/ui";
import { recordHistoryPage } from "./history";
import { csvResponse } from "./import";
import { marginTone } from "./margins";

export const assemblyRoutes = new Hono<AppEnv>();

type AssemblyRow = Awaited<ReturnType<typeof listAssemblies>>[number];
type LineRow = Awaited<ReturnType<typeof getAssemblyLines>>[number];

/** The `qty` query parameter, else `fallback` (an assembly's batch: its views show what one batch takes). */
function qtyParam(c: Context<AppEnv>, fallback = MILLI): number {
	const q = c.req.query("qty");
	const n = q === undefined ? null : parseMilli(q);
	return n !== null && n > 0 ? n : fallback;
}

type AssemblyTab = "editor" | "tree" | "diagram" | "explode" | "history";

function AssemblyTabs(props: { assembly: Assembly; active: AssemblyTab }) {
	const { t } = useApp();
	const id = props.assembly.id;
	const tabs: { key: AssemblyTab; href: string; label: string; icon: IconNode }[] = [
		{ key: "editor", href: `/assemblies/${id}`, label: t.assemblies.editor, icon: icons.pencil },
		{ key: "tree", href: `/assemblies/${id}/tree`, label: t.assemblies.tree, icon: icons.listTree },
		{ key: "diagram", href: `/assemblies/${id}/diagram`, label: t.assemblies.diagram, icon: icons.diagram },
		{ key: "explode", href: `/assemblies/${id}/explode`, label: t.assemblies.explode, icon: icons.list },
		{ key: "history", href: `/assemblies/${id}/history`, label: t.history.tab, icon: icons.history },
	];
	return <LinkTabs items={tabs.map((tab) => ({ ...tab, active: tab.key === props.active }))} />;
}

/** Effective selling price of an assembly variant and its planned margin (standard cost roll-up). */
type AssemblyPricing = { priceCents: number; ownPrice: boolean; margin: Margin | null; incomplete: boolean };

function assemblyPricing(part: Part, assembly: Assembly, calc: CostCalculator): AssemblyPricing | null {
	const priceCents = salePriceOf(part, assembly);
	if (priceCents === null) return null;
	const cost = calc.assembly(assembly.id);
	return {
		priceCents,
		ownPrice: assembly.salePriceCents !== null,
		margin: marginOf(priceCents, centsOf(cost.millicents)),
		incomplete: cost.incomplete,
	};
}

/** Selling price and planned margin, shown in the assembly header when the variant has a price. */
function PricingSummary(props: { pricing: AssemblyPricing; assemblyId: number }) {
	const { t, locale } = useApp();
	const { pricing } = props;
	const m = pricing.margin;
	return (
		<>
			<span class="inline-flex items-center gap-1.5">
				{t.margins.price}:{" "}
				<strong class="font-medium text-foreground">
					<Money cents={pricing.priceCents} />
				</strong>
				{pricing.ownPrice ? (
					<Badge variant="info" title={t.margins.ownPriceTitle}>
						{t.margins.ownPrice}
					</Badge>
				) : (
					<span class="text-xs">({t.assemblies.salePriceInherited})</span>
				)}
			</span>
			{m ? (
				<span>
					{t.assemblies.plannedMargin}:{" "}
					<strong class={cn("font-medium text-foreground", marginTone(m))}>
						<Money cents={m.marginCents} />
						{m.rateBp !== null ? ` · ${formatPercent(m.rateBp, locale)}` : null}
					</strong>
					{pricing.incomplete ? (
						<abbr class="ml-0.5 cursor-help font-medium text-warning no-underline" title={t.margins.incompleteMark}>
							*
						</abbr>
					) : null}
				</span>
			) : null}
			<a href={`/margins/assemblies/${props.assemblyId}`} class="inline-flex items-center gap-1 font-medium">
				<Icon icon={icons.chartLine} class="size-3.5" />
				{t.margins.historyTitle}
			</a>
		</>
	);
}

function AssemblyHeader(props: { assembly: Assembly; part: Part; tab: AssemblyTab; pricing?: AssemblyPricing | null }) {
	const view = useApp();
	const { t, seeCosts } = view;
	const canEdit = can(view, "assemblies.edit");
	const canArchive = can(view, "assemblies.archive");
	const canDelete = can(view, "assemblies.delete");
	const { assembly, part } = props;
	return (
		<>
			<PageHeader
				title={`${part.ref} · ${part.name}`}
				subtitle={
					<span class="flex flex-wrap items-center gap-x-3 gap-y-1">
						<KindBadge kind={part.kind} />
						<span>
							{t.assemblies.code}: <strong class="font-medium text-foreground">{assembly.code}</strong>
						</span>
						<span>
							{t.assemblies.revision}: <strong class="font-medium text-foreground">{assembly.revision}</strong>
						</span>
						<StatusBadge status={assembly.status} />
						{assembly.batchQtyMilli !== MILLI ? (
							<span>
								{t.assemblies.batch}:{" "}
								<strong class="font-medium text-foreground">
									<Qty milli={assembly.batchQtyMilli} unit={part.unit} />
								</strong>
							</span>
						) : null}
						{seeCosts && props.pricing ? <PricingSummary pricing={props.pricing} assemblyId={assembly.id} /> : null}
					</span>
				}
				actions={
					<>
						{canEdit && assembly.status !== "active" ? (
							<PostButton
								action={`/assemblies/${assembly.id}/activate`}
								label={t.assemblies.activate}
								variant="default"
								icon={icons.check}
							/>
						) : null}
						{canEdit && assembly.status === "archived" ? (
							<PostButton
								action={`/assemblies/${assembly.id}/draft`}
								label={t.assemblies.toDraft}
								icon={icons.archiveRestore}
							/>
						) : null}
						{canEdit ? (
							<>
								<PostButton
									action={`/assemblies/${assembly.id}/revision`}
									label={t.assemblies.newRevision}
									icon={icons.copy}
								/>
								<LinkButton
									href={`/assemblies/new?part=${part.id}&copy_from=${assembly.id}`}
									label={t.assemblies.newVariant}
									variant="outline"
									icon={icons.layers}
								/>
							</>
						) : null}
						<MoreMenu
							items={[
								canArchive &&
									assembly.status !== "archived" && {
										label: t.assemblies.archive,
										icon: icons.archive,
										action: `/assemblies/${assembly.id}/archive`,
										confirm: t.common.confirmArchive,
									},
								canDelete && {
									label: t.common.delete,
									icon: icons.trash,
									action: `/assemblies/${assembly.id}/delete`,
									confirm: t.common.confirmDelete,
									destructive: true,
								},
							]}
						/>
					</>
				}
			/>
			<AssemblyTabs assembly={assembly} active={props.tab} />
		</>
	);
}

// ---------------------------------------------------------------------------
// List

function AssemblyList(props: { rows: AssemblyRow[]; q: string; status: string }) {
	const view = useApp();
	const { t } = view;
	return (
		<>
			<PageHeader
				title={t.assemblies.title}
				actions={
					can(view, "assemblies.edit") ? (
						<LinkButton href="/assemblies/new" label={t.assemblies.new} icon={icons.plus} />
					) : undefined
				}
			/>
			<SearchBar action="/assemblies" q={props.q}>
				<select name="status" aria-label={t.assemblies.status} data-slot="native-select" class="w-auto min-w-44">
					<option value="">{t.assemblies.statusFilter.open}</option>
					{ASSEMBLY_STATUSES.map((s) => (
						<option value={s} selected={s === props.status}>
							{t.assemblies.statuses[s]}
						</option>
					))}
					<option value="all" selected={props.status === "all"}>
						{t.assemblies.statusFilter.all}
					</option>
				</select>
			</SearchBar>
			<div id="results">
				{props.rows.length === 0 ? (
					<EmptyState icon={icons.listTree} description={t.assemblies.noAssemblies} />
				) : (
					<Card class="gap-0 overflow-hidden py-0">
						<Table>
							<TableHeader class="bg-muted/50">
								<TableRow>
									<TableHead>{t.assemblies.parent}</TableHead>
									<TableHead>{t.parts.kind}</TableHead>
									<TableHead>{t.assemblies.code}</TableHead>
									<TableHead>{t.assemblies.revision}</TableHead>
									<TableHead>{t.assemblies.status}</TableHead>
									<TableHead class="text-right">{t.assemblies.lines}</TableHead>
									<TableHead class="w-px">
										<span class="sr-only">{t.assemblies.diagram}</span>
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{props.rows.map((b) => (
									<TableRow>
										<TableCell>
											<a href={`/assemblies/${b.id}`}>{b.partRef}</a>{" "}
											<span class="text-muted-foreground">{b.partName}</span>
										</TableCell>
										<TableCell>
											<KindBadge kind={b.partKind} />
										</TableCell>
										<TableCell>{b.code}</TableCell>
										<TableCell>{b.revision}</TableCell>
										<TableCell>
											<StatusBadge status={b.status} />
										</TableCell>
										<TableCell class="text-right tabular-nums">{b.lineCount}</TableCell>
										<TableCell class="w-px py-1">
											<Button
												href={`/assemblies/${b.id}/diagram`}
												variant="ghost"
												size="icon-sm"
												icon={icons.diagram}
												aria-label={fmt(t.assemblies.openDiagram, { ref: b.partRef })}
												title={fmt(t.assemblies.openDiagram, { ref: b.partRef })}
											/>
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</Card>
				)}
			</div>
		</>
	);
}

assemblyRoutes.get("/", async (c) => {
	const q = c.req.query("q") ?? "";
	const status = c.req.query("status") ?? "";
	const rows = await listAssemblies(c.var.db, { q, status });
	return page(c, c.var.t.assemblies.title, <AssemblyList rows={rows} q={q} status={status} />);
});

// ---------------------------------------------------------------------------
// Create

type ParentOption = { id: number; ref: string; name: string };
type SourceOption = { id: number; label: string };

function NewAssemblyForm(props: {
	values: FormValues;
	errors: FormErrors;
	parents: ParentOption[];
	sources: SourceOption[];
}) {
	const { t } = useApp();
	const p = { values: props.values, errors: props.errors };
	return (
		<Card class="max-w-3xl">
			<form method="post" action="/assemblies" class="flex flex-col gap-6">
				<CardContent>
					<ErrorBanner show={Object.keys(props.errors).length > 0} />
					<FieldGroup>
						<PartSelectPicker
							name="parent_part_id"
							label={t.assemblies.parent}
							hint={t.assemblies.parentHint}
							required
							options={props.parents}
							{...p}
						/>
						<div class="grid gap-4 md:grid-cols-2">
							<TextField name="code" label={t.assemblies.code} hint={t.assemblies.codeHint} required {...p} />
							<TextField name="revision" label={t.assemblies.revision} required {...p} />
						</div>
						<SelectField
							name="copy_from"
							label={t.assemblies.copyFrom}
							options={[
								{ value: "", label: t.assemblies.copyNone },
								...props.sources.map((s) => ({ value: String(s.id), label: s.label })),
							]}
							{...p}
						/>
						<TextArea name="notes" label={t.common.notes} {...p} />
					</FieldGroup>
				</CardContent>
				<CardFooter class="border-t">
					<Button icon={icons.plus}>{t.common.create}</Button>
					<Button href="/assemblies" variant="outline">
						{t.common.cancel}
					</Button>
				</CardFooter>
			</form>
			<PartPickerDialog name="parent_part_id" scope={{ kinds: ["make", "kit"] }} />
		</Card>
	);
}

async function newAssemblyOptions(c: Context<AppEnv>) {
	const [parents, all] = await Promise.all([
		partOptions(c.var.db, ["make", "kit"]),
		listAssemblies(c.var.db, { status: "all" }),
	]);
	const sources = all.map((b) => ({ id: b.id, label: `${b.partRef} · ${b.code} · ${b.revision}` }));
	return { parents, sources };
}

assemblyRoutes.get("/new", requirePermission("assemblies.edit"), async (c) => {
	const t = c.var.t;
	const { parents, sources } = await newAssemblyOptions(c);
	const values: FormValues = {
		parent_part_id: c.req.query("part") ?? "",
		code: DEFAULT_CODE,
		revision: DEFAULT_REVISION,
		copy_from: c.req.query("copy_from") ?? "",
	};
	if (values.copy_from) values.code = "";
	return page(
		c,
		t.assemblies.new,
		<>
			<PageHeader title={t.assemblies.new} />
			<NewAssemblyForm values={values} errors={{}} parents={parents} sources={sources} />
		</>,
	);
});

assemblyRoutes.post("/", requirePermission("assemblies.edit"), async (c) => {
	const t = c.var.t;
	const db = c.var.db;
	const body = await c.req.parseBody();
	const v = validate(assemblyInput, body);
	const errors: FieldErrors = v.ok ? {} : { ...v.errors };
	if (v.ok) {
		const d = v.data;
		Object.assign(
			errors,
			await newAssemblyErrors(db, {
				parentPartId: d.parent_part_id,
				code: d.code,
				revision: d.revision,
				copyFrom: d.copy_from,
			}),
		);
	}
	if (!v.ok || Object.keys(errors).length > 0) {
		const { parents, sources } = await newAssemblyOptions(c);
		return page(
			c,
			t.assemblies.new,
			<>
				<PageHeader title={t.assemblies.new} />
				<NewAssemblyForm
					values={body as FormValues}
					errors={translateErrors(c, errors, { ref: "", parent: "" })}
					parents={parents}
					sources={sources}
				/>
			</>,
			422,
		);
	}
	const d = v.data;
	const user = c.var.user;
	const now = nowIso();
	const parentPartId = d.parent_part_id as number;
	const parentRef = (await db.select({ ref: parts.ref }).from(parts).where(eq(parts.id, parentPartId)))[0]?.ref;
	const source = d.copy_from ? (await getAssembly(db, d.copy_from))?.assembly : undefined;
	await saveChanges(
		c,
		fmt(t.history.summaries.assemblyCreate, { assembly: assemblyLabel(parentRef ?? "", d) }),
		createAssemblyStatements(
			db,
			{
				parentPartId,
				code: d.code,
				revision: d.revision,
				notes: d.notes,
				salePriceCents: keptSalePrice(source, { parentPartId, code: d.code }),
			},
			d.copy_from,
			user,
			now,
		),
	);
	const created = await findAssembly(db, d.parent_part_id as number, d.code, d.revision);
	return redirectOk(c, `/assemblies/${created?.id}`);
});

// ---------------------------------------------------------------------------
// Editor

async function loadAssembly(c: Context<AppEnv>) {
	const id = idParam(c);
	return id ? getAssembly(c.var.db, id) : undefined;
}

function LinesEditor(props: {
	assembly: Assembly;
	part: Part;
	lines: LineRow[];
	costs: Map<number, Cost>;
	/** Cost of one batch (the lines as written, plus machine time) and of one unit. */
	batch: Cost;
	total: Cost;
	/** Machine time of one batch and its cost (D148). */
	machine: { typeId: number; name: string; minutesMilli: number; cost: Cost } | null;
	refs: Map<number, string>;
	machines: Map<number, string>;
	/** Machine types to choose from in the production bar. */
	machineTypes: { id: number; name: string }[];
	/** The production bar's values and errors. */
	production: { values: FormValues; errors: FormErrors };
	options: { ref: string; name: string }[];
	values: FormValues;
	errors: FormErrors;
}) {
	const view = useApp();
	const { t, locale, seeCosts } = view;
	const { assembly } = props;
	const editable = assembly.status !== "archived" && can(view, "assemblies.edit");
	const hx = {
		"hx-target": "#assembly-lines",
		"hx-select": "#assembly-lines",
		"hx-swap": "outerHTML",
	};
	return (
		<>
			{assembly.status === "active" ? <Alert variant="warning">{t.assemblies.activeWarning}</Alert> : null}
			{assembly.status === "archived" ? <Alert>{t.assemblies.archivedNote}</Alert> : null}
			<Card id="assembly-lines" class="gap-4">
				<CardHeader>
					<CardTitle>{t.assemblies.editor}</CardTitle>
					<CardDescription>{fmt(t.assemblies.linesCount, { n: props.lines.length })}</CardDescription>
				</CardHeader>
				<ProductionBar
					assembly={assembly}
					part={props.part}
					machineTypes={props.machineTypes}
					editable={editable}
					values={props.production.values}
					errors={props.production.errors}
				/>
				{props.lines.length === 0 ? (
					<CardContent>
						<Empty />
					</CardContent>
				) : (
					<Table class={cn("border-t", FLUSH_TABLE)}>
						<TableHeader class="bg-muted/50">
							<TableRow>
								{editable ? <TableHead class="w-px" /> : null}
								<TableHead>{t.assemblies.component}</TableHead>
								<TableHead>{t.parts.kind}</TableHead>
								<TableHead class="text-right">{t.assemblies.qty}</TableHead>
								{seeCosts ? (
									<>
										<TableHead class="text-right">{t.assemblies.unitCost}</TableHead>
										<TableHead class="text-right">{t.assemblies.lineCost}</TableHead>
									</>
								) : null}
								{editable ? <TableHead class="w-px" /> : null}
							</TableRow>
						</TableHeader>
						<TableBody>
							{props.lines.map((l, i) => {
								const cost = props.costs.get(l.partId);
								const lineUrl = `/assemblies/${assembly.id}/lines/${l.id}`;
								return (
									<TableRow>
										{editable ? (
											<TableCell class="w-px py-1">
												<div class="flex items-center gap-0.5">
													<LineActionForm
														action={`${lineUrl}/move`}
														hx={hx}
														hidden={{ dir: "up" }}
														icon={icons.arrowUp}
														label={t.assemblies.moveUp}
														disabled={i === 0}
													/>
													<LineActionForm
														action={`${lineUrl}/move`}
														hx={hx}
														hidden={{ dir: "down" }}
														icon={icons.arrowDown}
														label={t.assemblies.moveDown}
														disabled={i === props.lines.length - 1}
													/>
												</div>
											</TableCell>
										) : null}
										<TableCell class="min-w-48">
											<div class="flex flex-wrap items-center gap-x-2 gap-y-1">
												<a href={`/parts/${l.partId}`}>{l.ref}</a>
												<span class="text-muted-foreground">{l.name}</span>
												{l.archived ? <Badge variant="muted">{t.common.archivedLabel}</Badge> : null}
											</div>
											{l.notes ? <div class="mt-0.5 text-xs text-muted-foreground">{l.notes}</div> : null}
										</TableCell>
										<TableCell>
											<KindBadge kind={l.kind} />
										</TableCell>
										<TableCell class="text-right">
											{editable ? (
												<form
													method="post"
													action={lineUrl}
													class="flex items-center justify-end gap-1.5"
													hx-post={lineUrl}
													hx-trigger="change"
													{...hx}
												>
													<input
														type="text"
														name="qty"
														inputmode="decimal"
														value={formatQtyInput(l.qtyMilli, locale)}
														aria-label={`${t.assemblies.qty} ${l.ref}`}
														data-select-on-focus
														class="w-20 text-right tabular-nums"
													/>
													<span class="w-8 text-left text-xs text-muted-foreground">
														{l.unit !== "pcs" ? l.unit : ""}
													</span>
													<Button
														variant="ghost"
														size="icon-sm"
														icon={icons.save}
														aria-label={t.common.save}
														title={t.common.save}
													/>
												</form>
											) : (
												<Qty milli={l.qtyMilli} unit={l.unit} />
											)}
										</TableCell>
										{seeCosts ? (
											<>
												<TableCell class="text-right">
													{cost ? <CostView cost={cost} refs={props.refs} /> : null}
												</TableCell>
												<TableCell class="text-right">
													{cost ? <Money cents={centsOf(roundDiv(l.qtyMilli * cost.millicents, MILLI))} /> : null}
												</TableCell>
											</>
										) : null}
										{editable ? (
											<TableCell class="w-px py-1">
												<LineActionForm
													action={`${lineUrl}/delete`}
													hx={hx}
													icon={icons.trash}
													label={t.assemblies.remove}
												/>
											</TableCell>
										) : null}
									</TableRow>
								);
							})}
						</TableBody>
						{seeCosts ? (
							<TableFooter>
								{props.machine ? (
									<TableRow class="hover:bg-transparent">
										<TableCell colspan={editable ? 5 : 4}>
											<span class="inline-flex flex-wrap items-center gap-x-2">
												<Icon icon={icons.timer} class="size-4 text-muted-foreground" />
												{t.machines.time}: <a href={`/machines/types/${props.machine.typeId}`}>{props.machine.name}</a>{" "}
												· <Duration minutesMilli={props.machine.minutesMilli} />
											</span>
										</TableCell>
										<TableCell class="text-right">
											<CostView cost={props.machine.cost} refs={props.refs} machines={props.machines} />
										</TableCell>
										{editable ? <TableCell /> : null}
									</TableRow>
								) : null}
								{assembly.batchQtyMilli !== MILLI ? (
									<TableRow class="hover:bg-transparent">
										<TableCell colspan={editable ? 5 : 4}>
											{fmt(t.assemblies.batchCost, {
												qty: formatQty(assembly.batchQtyMilli, locale),
												unit: props.part.unit,
											})}
										</TableCell>
										<TableCell class="text-right">
											<CostView cost={props.batch} refs={props.refs} machines={props.machines} />
										</TableCell>
										{editable ? <TableCell /> : null}
									</TableRow>
								) : null}
								<TableRow class="hover:bg-transparent">
									<TableCell colspan={editable ? 5 : 4}>{t.assemblies.totalCost}</TableCell>
									<TableCell class="text-right font-semibold">
										<CostView cost={props.total} refs={props.refs} machines={props.machines} />
									</TableCell>
									{editable ? <TableCell /> : null}
								</TableRow>
							</TableFooter>
						) : null}
					</Table>
				)}
				{seeCosts && props.total.incomplete ? (
					<CardContent>
						<IncompleteNote refs={missingNames(props.total, props.refs, props.machines).join(", ")} />
					</CardContent>
				) : null}
				{editable ? (
					<CardFooter class="flex-col items-stretch border-t">
						<form
							method="post"
							action={`/assemblies/${assembly.id}/lines`}
							class="flex w-full flex-col gap-3"
							hx-post={`/assemblies/${assembly.id}/lines`}
							{...hx}
						>
							<ErrorBanner show={Object.keys(props.errors).length > 0} />
							<div class="grid gap-3 md:grid-cols-[2fr_1fr_2fr_auto] md:items-end">
								<PartPicker
									name="component"
									label={t.assemblies.component}
									placeholder={t.assemblies.componentHint}
									listId="part-refs"
									options={props.options}
									required
									values={props.values}
									errors={props.errors}
								/>
								<TextField
									name="qty"
									label={t.assemblies.qty}
									inputmode="decimal"
									required
									values={props.values}
									errors={props.errors}
								/>
								<TextField name="notes" label={t.common.notes} values={props.values} errors={props.errors} />
								<Button icon={icons.plus}>{t.assemblies.addLine}</Button>
							</div>
						</form>
						<PartPickerDialog name="component" scope={{ exclude: props.part.id }} />
					</CardFooter>
				) : null}
			</Card>
		</>
	);
}

/** Table flush with its card: first and last columns line up with the card header padding. */
const FLUSH_TABLE = "[&_td:first-child]:pl-6 [&_td:last-child]:pr-6 [&_th:first-child]:pl-6 [&_th:last-child]:pr-6";

/** An icon-only POST button in its own form, swapped in place by htmx (reorder, remove). */
function LineActionForm(props: {
	action: string;
	hx: Record<string, string>;
	hidden?: Record<string, string>;
	icon: IconNode;
	label: string;
	disabled?: boolean;
}) {
	return (
		<form method="post" action={props.action} class="inline-flex" hx-post={props.action} {...props.hx}>
			{Object.entries(props.hidden ?? {}).map(([k, v]) => (
				<input type="hidden" name={k} value={v} />
			))}
			<Button
				variant="ghost"
				size="icon-sm"
				icon={props.icon}
				disabled={props.disabled}
				aria-label={props.label}
				title={props.label}
			/>
		</form>
	);
}

/** "Incomplete: no cost for …" under a cost roll-up. */
function IncompleteNote(props: { refs: string; class?: string }) {
	const { t } = useApp();
	return (
		<p class={cn("flex items-start gap-2 text-sm font-medium text-warning", props.class)}>
			<Icon icon={icons.triangleAlert} class="mt-0.5 size-4" />
			{fmt(t.assemblies.incomplete, { refs: props.refs })}
		</p>
	);
}

/** Small card under the editor (revisions, variants, notes): icon + title, then content. */
function SideCard(props: { title: string; icon: IconNode; children: Child }) {
	return (
		<Card class="gap-4">
			<CardHeader>
				<CardTitle icon={props.icon}>{props.title}</CardTitle>
			</CardHeader>
			<CardContent>{props.children}</CardContent>
		</Card>
	);
}

/**
 * How the assembly is produced, at the top of its lines (D153): how many units one run makes (D145) and the machine time
 * per run (D148). Edited with the lines and under the same rule: never on an archived assembly.
 */
function ProductionBar(props: {
	assembly: Assembly;
	part: Part;
	machineTypes: { id: number; name: string }[];
	editable: boolean;
	values: FormValues;
	errors: FormErrors;
}) {
	const view = useApp();
	const { t } = view;
	const { assembly, part } = props;
	const machine = props.machineTypes.find((m) => m.id === assembly.machineTypeId);
	if (!props.editable) {
		return (
			<CardContent>
				<p class="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
					<span class="inline-flex items-center gap-1.5">
						<Icon icon={icons.factory} class="size-4 text-muted-foreground" />
						{t.assemblies.batchQty}: <Qty milli={assembly.batchQtyMilli} unit={part.unit} />
					</span>
					{machine && assembly.machineMinutes > 0 ? (
						<span class="inline-flex items-center gap-1.5">
							<Icon icon={icons.timer} class="size-4 text-muted-foreground" />
							{t.machines.timePerBatch}: <a href={`/machines/types/${machine.id}`}>{machine.name}</a> ·{" "}
							<Duration minutesMilli={assembly.machineMinutes * MILLI} />
						</span>
					) : null}
				</p>
			</CardContent>
		);
	}
	const p = { values: props.values, errors: props.errors };
	return (
		<CardContent>
			<InlineEdit
				open={Object.keys(props.errors).length > 0}
				class="rounded-lg border bg-muted/40 p-4"
				summary={
					<p class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
						<span>
							{t.assemblies.batch} <Qty milli={assembly.batchQtyMilli} unit={part.unit} />
						</span>
						<span aria-hidden="true">·</span>
						<span>
							{t.assemblies.productionMachine} {machine ? machine.name : t.machines.none.toLowerCase()}
						</span>
						<span aria-hidden="true">·</span>
						<span>
							{t.assemblies.productionTime}{" "}
							{assembly.machineMinutes > 0 ? (
								<Duration minutesMilli={assembly.machineMinutes * MILLI} />
							) : (
								t.common.none
							)}
						</span>
					</p>
				}
			>
				<form
					method="post"
					action={`/assemblies/${assembly.id}/production`}
					id="production"
					class="flex flex-col gap-3"
				>
					<div class="grid gap-3 md:grid-cols-[minmax(0,11rem)_minmax(0,1fr)_minmax(0,10rem)_auto] md:items-start">
						<DecimalField name="batch_qty" label={fmt(t.assemblies.batchSize, { unit: part.unit })} {...p} />
						<SelectField
							name="machine_type_id"
							label={t.machines.machineType}
							options={[
								{ value: "", label: t.machines.none },
								...props.machineTypes.map((m) => ({ value: String(m.id), label: m.name })),
							]}
							{...p}
						/>
						<TextField name="machine_time" label={t.machines.timePerBatch} placeholder="3:10" {...p} />
						<Button variant="outline" icon={icons.save} class="md:mt-[1.375rem]">
							{t.common.save}
						</Button>
					</div>
					<p class="text-xs text-muted-foreground">
						{fmt(t.assemblies.batchHint, { ref: part.ref })} {t.machines.timeHint}
						{props.machineTypes.length === 0 && can(view, "machines.edit") ? (
							<>
								{" "}
								<a href="/machines/types/new">{t.machines.newType}</a>
							</>
						) : null}
					</p>
				</form>
			</InlineEdit>
		</CardContent>
	);
}

/** Machine time of an explosion with its cost, for MachineTimeCard. */
function machineTimeRows(explosion: Explosion, calc: CostCalculator): MachineTimeRow[] {
	return explosion.machines.map((m) => {
		const cost = calc.machine(m.machineType.id, m.minutesMilli);
		return {
			machineTypeId: m.machineType.id,
			name: m.machineType.name,
			minutesMilli: m.minutesMilli,
			rateCents: m.machineType.rateCents,
			costCents: cost.incomplete ? null : centsOf(cost.millicents),
		};
	});
}

/** The production form's values for an assembly. */
function productionValues(assembly: Assembly, locale: NumberLocale): FormValues {
	return {
		batch_qty: formatQtyInput(assembly.batchQtyMilli, locale),
		machine_type_id: assembly.machineTypeId === null ? "" : String(assembly.machineTypeId),
		machine_time: formatMinutesInput(assembly.machineMinutes),
	};
}

const salePriceInput = z.object({ sale_price: field.money() });

/** The variant's own selling price (empty = the part's), editable unless the assembly is archived. */
function SalePriceCard(props: { assembly: Assembly; part: Part; values: FormValues; errors: FormErrors }) {
	const view = useApp();
	const { t, locale, currency, seeCosts } = view;
	const { assembly, part } = props;
	const partPrice = part.salePriceCents;
	if (!seeCosts) return null;
	if (assembly.status === "archived" || !can(view, "prices.edit")) {
		const effective = salePriceOf(part, assembly);
		return (
			<SideCard title={t.assemblies.salePriceTitle} icon={icons.tag}>
				<DetailList
					items={[
						{
							label: t.assemblies.salePrice,
							value: (
								<span class="inline-flex flex-wrap items-center gap-1.5">
									{effective === null ? t.common.none : <Money cents={effective} />}
									{assembly.salePriceCents === null && effective !== null ? (
										<span class="text-xs text-muted-foreground">({t.assemblies.salePriceInherited})</span>
									) : null}
								</span>
							),
						},
					]}
				/>
			</SideCard>
		);
	}
	const effective = salePriceOf(part, assembly);
	return (
		<Card id="sale-price" class="gap-4">
			<CardHeader>
				<CardTitle icon={icons.tag}>{t.assemblies.salePriceTitle}</CardTitle>
			</CardHeader>
			<CardContent>
				<InlineEdit
					open={Object.keys(props.errors).length > 0}
					summary={
						<span class="inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
							{effective === null ? (
								t.common.none
							) : (
								<strong class="font-semibold">
									<Money cents={effective} />
								</strong>
							)}
							{assembly.salePriceCents !== null ? (
								<Badge variant="info" title={t.margins.ownPriceTitle}>
									{t.margins.ownPrice}
								</Badge>
							) : effective !== null ? (
								<span class="text-xs text-muted-foreground">({t.assemblies.salePriceInherited})</span>
							) : null}
						</span>
					}
				>
					<form method="post" action={`/assemblies/${assembly.id}/sale-price`} class="flex flex-col gap-4">
						<DecimalField
							name="sale_price"
							label={t.assemblies.salePrice}
							hint={
								partPrice === null
									? t.assemblies.salePriceHintNone
									: fmt(t.assemblies.salePriceHint, { price: formatMoney(partPrice, locale, currency) })
							}
							values={props.values}
							errors={props.errors}
						/>
						<div>
							<Button variant="outline" icon={icons.save}>
								{t.common.save}
							</Button>
						</div>
					</form>
				</InlineEdit>
			</CardContent>
		</Card>
	);
}

async function renderEditor(
	c: Context<AppEnv>,
	data: { assembly: Assembly; part: Part },
	form: { values: FormValues; errors: FieldErrors; vars?: Record<string, string> } = {
		values: { qty: "1" },
		errors: {},
	},
	status: 200 | 422 = 200,
	/** The selling price or production form, when re-rendered with errors. */
	side: {
		price?: { values: FormValues; errors: FieldErrors };
		production?: { values: FormValues; errors: FieldErrors };
	} = {},
) {
	const { price, production } = side;
	const db = c.var.db;
	const { assembly, part } = data;
	const [lines, graph, options, siblings, files] = await Promise.all([
		getAssemblyLines(db, assembly.id),
		loadGraph(db),
		partOptions(db),
		db
			.select({ id: assemblies.id, code: assemblies.code, revision: assemblies.revision, status: assemblies.status })
			.from(assemblies)
			.where(eq(assemblies.parentPartId, part.id))
			.orderBy(asc(assemblies.code), asc(assemblies.revision)),
		assemblyFiles(db, assembly.id),
	]);
	const calc = new CostCalculator(graph);
	const costs = new Map(lines.map((l) => [l.partId, calc.part(l.partId)]));
	const total = calc.assembly(assembly.id);
	const batch = calc.batch(assembly.id);
	const refs = new Map([...graph.parts.values()].map((p) => [p.id, p.ref]));
	const machines = new Map([...graph.machineTypes.values()].map((m) => [m.id, m.name]));
	const machineCost = calc.machineBatch(assembly);
	const machine =
		machineCost && assembly.machineTypeId !== null
			? {
					typeId: assembly.machineTypeId,
					name: machines.get(assembly.machineTypeId) ?? "",
					minutesMilli: assembly.machineMinutes * MILLI,
					cost: machineCost,
				}
			: null;
	const t = c.var.t;
	const priceValues = price?.values ?? {
		sale_price: assembly.salePriceCents === null ? "" : formatCentsInput(assembly.salePriceCents, c.var.locale),
	};
	return page(
		c,
		`${part.ref} ${assembly.code} ${assembly.revision}`,
		<>
			<AssemblyHeader assembly={assembly} part={part} tab="editor" pricing={assemblyPricing(part, assembly, calc)} />
			<Flash ok={c.req.query("ok")} message={c.req.query("ok") === "activated" ? t.assemblies.activated : undefined} />
			{c.req.query("err") ? <Alert variant="destructive">{errorText(t, c.req.query("err") ?? "")}</Alert> : null}
			<LinesEditor
				assembly={assembly}
				part={part}
				lines={lines}
				costs={costs}
				batch={batch}
				total={total}
				machine={machine}
				refs={refs}
				machines={machines}
				machineTypes={[...graph.machineTypes.values()].sort((a, b) => a.name.localeCompare(b.name))}
				production={{
					values: production?.values ?? productionValues(assembly, c.var.locale),
					errors: translateErrors(c, production?.errors ?? {}),
				}}
				options={options.filter((o) => o.id !== part.id)}
				values={form.values}
				errors={translateErrors(c, form.errors, form.vars)}
			/>
			{files.length > 0 || can(c.var, "files.edit") ? (
				<div class="mt-6">
					<FilesCard
						files={files}
						uploadAction={`/assemblies/${assembly.id}/files`}
						enabled={filesBucket(c.env) !== null}
						editable={assembly.status !== "archived"}
						uploadError={uploadErrorText(t, c.req.query("err"), "file")}
					/>
				</div>
			) : null}
			<div class="mt-6 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
				<SalePriceCard
					assembly={assembly}
					part={part}
					values={priceValues}
					errors={translateErrors(c, price?.errors ?? {})}
				/>
				<SideCard title={t.assemblies.revisions} icon={icons.history}>
					<ul class="m-0 flex list-none flex-col gap-2 p-0 text-sm">
						{siblings
							.filter((s) => s.code === assembly.code)
							.map((s) => (
								<li class="flex items-center justify-between gap-3">
									{s.id === assembly.id ? (
										<span class="font-semibold" aria-current="page">
											{s.revision}
										</span>
									) : (
										<a href={`/assemblies/${s.id}`}>{s.revision}</a>
									)}
									<StatusBadge status={s.status} />
								</li>
							))}
					</ul>
				</SideCard>
				<SideCard title={t.assemblies.variants} icon={icons.layers}>
					<ul class="m-0 flex list-none flex-col gap-2 p-0 text-sm">
						{siblings
							.filter((s) => s.status === "active")
							.map((s) => (
								<li class="flex items-center justify-between gap-3">
									{s.id === assembly.id ? (
										<span class="font-semibold" aria-current="page">
											{s.code}
										</span>
									) : (
										<a href={`/assemblies/${s.id}`}>{s.code}</a>
									)}
									<span class="text-muted-foreground">{s.revision}</span>
								</li>
							))}
					</ul>
				</SideCard>
				{assembly.notes ? (
					<SideCard title={t.common.notes} icon={icons.clipboardList}>
						<p class="text-sm whitespace-pre-wrap">{assembly.notes}</p>
					</SideCard>
				) : null}
			</div>
		</>,
		status,
	);
}

assemblyRoutes.get("/:id", async (c) => {
	const data = await loadAssembly(c);
	if (!data) return notFound(c);
	return renderEditor(c, data);
});

assemblyRoutes.post("/:id/lines", requirePermission("assemblies.edit"), async (c) => {
	const data = await loadAssembly(c);
	if (!data) return notFound(c);
	const db = c.var.db;
	const { assembly, part } = data;
	const body = await c.req.parseBody();
	const values = body as FormValues;
	if (assembly.status === "archived")
		return renderEditor(c, data, { values, errors: { component: "assembly_archived" } }, 422);
	const v = validate(assemblyLineInput, body);
	const errors: FieldErrors = v.ok ? {} : { ...v.errors };
	const vars: Record<string, string> = {};
	let componentId: number | undefined;
	let componentRef = "";
	if (v.ok) {
		const ref = v.data.component.split(/\s+[—·-]\s+/)[0]?.trim() ?? "";
		const comp = (await db.select().from(parts).where(eq(parts.ref, ref)).limit(1))[0];
		const problem = await componentError(db, part, comp, ref, v.data.qty);
		if (problem) {
			errors[problem.field] = problem.key;
			Object.assign(vars, problem.vars);
		} else if (comp) {
			componentId = comp.id;
			componentRef = comp.ref;
		}
	}
	if (!v.ok || componentId === undefined) return renderEditor(c, data, { values, errors, vars }, 422);
	await saveChanges(
		c,
		fmt(c.var.t.history.summaries.assemblyLineAdd, { ref: componentRef, assembly: assemblyLabel(part.ref, assembly) }),
		addAssemblyLineStatements(
			db,
			assembly.id,
			{ componentPartId: componentId, qtyMilli: v.data.qty, notes: v.data.notes },
			c.var.user,
			nowIso(),
		),
	);
	return c.redirect(`/assemblies/${assembly.id}`, 303);
});

async function editableLine(c: Context<AppEnv>) {
	const data = await loadAssembly(c);
	const lineId = idParam(c, "lineId");
	if (!data || !lineId) return undefined;
	const line = (
		await c.var.db
			.select()
			.from(assemblyLines)
			.where(and(eq(assemblyLines.id, lineId), eq(assemblyLines.assemblyId, data.assembly.id)))
			.limit(1)
	)[0];
	return line ? { ...data, line } : undefined;
}

assemblyRoutes.post("/:id/lines/:lineId", requirePermission("assemblies.edit"), async (c) => {
	const data = await editableLine(c);
	if (!data) return notFound(c);
	if (data.assembly.status === "archived")
		return c.redirect(`/assemblies/${data.assembly.id}?err=assembly_archived`, 303);
	const body = await c.req.parseBody();
	const qty = parseMilli(typeof body.qty === "string" ? body.qty : "");
	if (qty === null || qty <= 0) return c.redirect(`/assemblies/${data.assembly.id}?err=invalid_quantity`, 303);
	const comp = (await c.var.db.select().from(parts).where(eq(parts.id, data.line.componentPartId)).limit(1))[0];
	if (comp?.trackSerial && qty % MILLI !== 0)
		return c.redirect(`/assemblies/${data.assembly.id}?err=serial_whole_qty`, 303);
	await saveChanges(
		c,
		fmt(c.var.t.history.summaries.assemblyLineQty, {
			ref: comp?.ref ?? "",
			assembly: assemblyLabel(data.part.ref, data.assembly),
		}),
		updateAssemblyLineQtyStatements(c.var.db, data.assembly.id, data.line.id, qty, c.var.user, nowIso()),
	);
	return c.redirect(`/assemblies/${data.assembly.id}`, 303);
});

assemblyRoutes.post("/:id/lines/:lineId/delete", requirePermission("assemblies.edit"), async (c) => {
	const data = await editableLine(c);
	if (!data) return notFound(c);
	if (data.assembly.status === "archived")
		return c.redirect(`/assemblies/${data.assembly.id}?err=assembly_archived`, 303);
	const comp = (await c.var.db.select().from(parts).where(eq(parts.id, data.line.componentPartId)).limit(1))[0];
	await saveChanges(
		c,
		fmt(c.var.t.history.summaries.assemblyLineDelete, {
			ref: comp?.ref ?? "",
			assembly: assemblyLabel(data.part.ref, data.assembly),
		}),
		deleteAssemblyLineStatements(c.var.db, data.assembly.id, data.line.id, c.var.user, nowIso()),
	);
	return c.redirect(`/assemblies/${data.assembly.id}`, 303);
});

assemblyRoutes.post("/:id/lines/:lineId/move", requirePermission("assemblies.edit"), async (c) => {
	const data = await editableLine(c);
	if (!data) return notFound(c);
	if (data.assembly.status === "archived")
		return c.redirect(`/assemblies/${data.assembly.id}?err=assembly_archived`, 303);
	const body = await c.req.parseBody();
	const dir = body.dir === "up" ? -1 : 1;
	const lines = await getAssemblyLines(c.var.db, data.assembly.id);
	const idx = lines.findIndex((l) => l.id === data.line.id);
	const other = lines[idx + dir];
	if (idx >= 0 && other) {
		// Renumber 1..n with the two lines swapped, in one batch.
		const order = lines.map((l) => l.id);
		[order[idx], order[idx + dir]] = [other.id, data.line.id];
		await saveChanges(
			c,
			fmt(c.var.t.history.summaries.assemblyLineMove, { assembly: assemblyLabel(data.part.ref, data.assembly) }),
			reorderAssemblyLinesStatements(c.var.db, data.assembly.id, order, c.var.user, nowIso()),
		);
	}
	return c.redirect(`/assemblies/${data.assembly.id}`, 303);
});

// Variant selling price: empty = use the part's. Logged in the price history (same batch).
assemblyRoutes.post("/:id/sale-price", requirePermission("prices.edit"), async (c) => {
	const data = await loadAssembly(c);
	if (!data) return notFound(c);
	const { assembly } = data;
	if (assembly.status === "archived") return c.redirect(`/assemblies/${assembly.id}?err=assembly_archived`, 303);
	const body = await c.req.parseBody();
	const v = validate(salePriceInput, body);
	if (!v.ok) return renderEditor(c, data, undefined, 422, { price: { values: body as FormValues, errors: v.errors } });
	await saveChanges(
		c,
		fmt(c.var.t.history.summaries.assemblySalePrice, { assembly: assemblyLabel(data.part.ref, assembly) }),
		assemblySalePriceStatements(c.var.db, assembly, v.data.sale_price, c.var.user, nowIso()),
	);
	return redirectOk(c, `/assemblies/${assembly.id}`);
});

// Units per run and machine time: edited like the lines, never on an archived assembly (D153).
assemblyRoutes.post("/:id/production", requirePermission("assemblies.edit"), async (c) => {
	const data = await loadAssembly(c);
	if (!data) return notFound(c);
	const { assembly, part } = data;
	const refused = productionError(assembly);
	if (refused) return c.redirect(`/assemblies/${assembly.id}?err=${refused}`, 303);
	const body = await c.req.parseBody();
	const v = validate(productionInput, body);
	const checked = v.ok ? await checkProduction(c.var.db, v.data) : null;
	const errors = v.ok ? (checked?.errors ?? {}) : v.errors;
	if (!checked || Object.keys(errors).length)
		return renderEditor(c, data, undefined, 422, { production: { values: body as FormValues, errors } });
	await saveChanges(
		c,
		fmt(c.var.t.history.summaries.assemblyProduction, { assembly: assemblyLabel(part.ref, assembly) }),
		[setProductionStatement(c.var.db, assembly.id, checked.production, c.var.user, nowIso())],
	);
	return redirectOk(c, `/assemblies/${assembly.id}`);
});

// ---------------------------------------------------------------------------
// Status changes, revisions, delete

assemblyRoutes.post("/:id/activate", requirePermission("assemblies.edit"), async (c) => {
	const data = await loadAssembly(c);
	if (!data) return notFound(c);
	const { assembly, part } = data;
	if (part.kind !== "make" && part.kind !== "kit")
		return c.redirect(`/assemblies/${assembly.id}?err=assembly_parent_kind`, 303);
	if (await archivedAssemblyCycles(c.var.db, assembly))
		return c.redirect(`/assemblies/${assembly.id}?err=assembly_cycle`, 303);
	await saveChanges(
		c,
		fmt(c.var.t.history.summaries.assemblyActivate, { assembly: assemblyLabel(part.ref, assembly) }),
		activateStatements(c.var.db, assembly, c.var.user, nowIso()),
	);
	return redirectOk(c, `/assemblies/${assembly.id}`, "activated");
});

assemblyRoutes.post("/:id/draft", requirePermission("assemblies.edit"), async (c) => {
	const data = await loadAssembly(c);
	if (!data) return notFound(c);
	const { assembly, part } = data;
	if (await archivedAssemblyCycles(c.var.db, assembly))
		return c.redirect(`/assemblies/${assembly.id}?err=assembly_cycle`, 303);
	await saveChanges(c, fmt(c.var.t.history.summaries.assemblyDraft, { assembly: assemblyLabel(part.ref, assembly) }), [
		setAssemblyStatusStatement(c.var.db, assembly.id, "draft", c.var.user, nowIso()),
	]);
	return redirectOk(c, `/assemblies/${assembly.id}`);
});

assemblyRoutes.post("/:id/archive", requirePermission("assemblies.archive"), async (c) => {
	const data = await loadAssembly(c);
	if (!data) return notFound(c);
	await saveChanges(
		c,
		fmt(c.var.t.history.summaries.assemblyArchive, { assembly: assemblyLabel(data.part.ref, data.assembly) }),
		[setAssemblyStatusStatement(c.var.db, data.assembly.id, "archived", c.var.user, nowIso())],
	);
	return redirectOk(c, `/assemblies/${data.assembly.id}`, "archived");
});

assemblyRoutes.post("/:id/revision", requirePermission("assemblies.edit"), async (c) => {
	const data = await loadAssembly(c);
	if (!data) return notFound(c);
	const { assembly, part } = data;
	const db = c.var.db;
	const taken = await db
		.select({ revision: assemblies.revision })
		.from(assemblies)
		.where(and(eq(assemblies.parentPartId, assembly.parentPartId), eq(assemblies.code, assembly.code)));
	const revision = nextRevision(
		assembly.revision,
		taken.map((r) => r.revision),
	);
	await saveChanges(
		c,
		fmt(c.var.t.history.summaries.assemblyRevision, {
			assembly: assemblyLabel(part.ref, { code: assembly.code, revision }),
			from: assembly.revision,
		}),
		createAssemblyStatements(
			db,
			{
				parentPartId: assembly.parentPartId,
				code: assembly.code,
				revision,
				notes: assembly.notes,
				salePriceCents: assembly.salePriceCents,
			},
			assembly.id,
			c.var.user,
			nowIso(),
		),
	);
	const created = await findAssembly(db, assembly.parentPartId, assembly.code, revision);
	return redirectOk(c, `/assemblies/${created?.id}`);
});

assemblyRoutes.post("/:id/delete", requirePermission("assemblies.delete"), async (c) => {
	const data = await loadAssembly(c);
	if (!data) return notFound(c);
	try {
		await saveChanges(
			c,
			fmt(c.var.t.history.summaries.assemblyDelete, { assembly: assemblyLabel(data.part.ref, data.assembly) }),
			[deleteAssemblyStatement(c.var.db, data.assembly.id)],
		);
	} catch (err) {
		if (isConstraintError(err, "FOREIGN KEY")) return c.redirect(`/assemblies/${data.assembly.id}?err=in_use`, 303);
		throw err;
	}
	return redirectOk(c, `/parts/${data.part.id}`, "deleted");
});

// ---------------------------------------------------------------------------
// Tree view and exploded list

function QtyForm(props: {
	action: string;
	qty: number;
	stock?: boolean | undefined;
	showStock?: boolean;
	/** Other view options to keep (empty values are left out). */
	hidden?: Record<string, string>;
	class?: string;
}) {
	const { t, locale } = useApp();
	return (
		<form method="get" action={props.action} class={cn("flex flex-wrap items-center gap-3", props.class ?? "mb-4")}>
			{Object.entries(props.hidden ?? {})
				.filter(([, v]) => v)
				.map(([k, v]) => (
					<input type="hidden" name={k} value={v} />
				))}
			<label class="inline-flex items-center gap-2 text-sm font-medium">
				<span>{t.assemblies.forQty}</span>
				<input
					type="text"
					name="qty"
					inputmode="decimal"
					value={formatQtyInput(props.qty, locale)}
					class="w-24 text-right tabular-nums"
				/>
			</label>
			{props.showStock ? (
				<label class="inline-flex min-h-(--control-h) cursor-pointer items-center gap-2 text-sm font-medium">
					<input type="checkbox" name="stock" value="on" checked={props.stock} />
					<span>{t.assemblies.useStock}</span>
				</label>
			) : null}
			<Button variant="outline">{t.assemblies.update}</Button>
		</form>
	);
}

/**
 * One row of the tree: name, per-parent and cumulative quantities, then the two cost columns
 * (hidden on phones). Nested levels are indented by their <ul>; the fixed-width numeric columns
 * keep the same right edge, so they line up at every depth.
 */
const TREE_ROW =
	"grid min-h-(--control-h) grid-cols-[minmax(0,1fr)_4.5rem_5.5rem] items-center gap-3 border-b px-4 py-1.5 text-sm md:grid-cols-[minmax(12rem,1fr)_6rem_7rem_7rem_7rem]";
/** The same row without the cost columns, for users who may not see costs. */
const TREE_ROW_QTY =
	"grid min-h-(--control-h) grid-cols-[minmax(0,1fr)_4.5rem_5.5rem] items-center gap-3 border-b px-4 py-1.5 text-sm md:grid-cols-[minmax(12rem,1fr)_6rem_7rem]";

function TreeNode(props: { node: ExplodedNode; calc: CostCalculator; refs: Map<number, string> }) {
	const { t, seeCosts } = useApp();
	const row = seeCosts ? TREE_ROW : TREE_ROW_QTY;
	const n = props.node;
	const cost = props.calc.part(n.part.id);
	const branch = n.children.length > 0;
	const cells = (
		<>
			<span class="flex min-w-0 items-center gap-2">
				{branch ? (
					// Rotates when its own <details> is open (a group-open: variant would also match open ancestors).
					<Icon
						icon={icons.chevronRight}
						class="size-4 text-muted-foreground transition-transform [details[open]>summary_&]:rotate-90"
					/>
				) : (
					<span class="size-4 shrink-0" />
				)}
				{/* Wraps between items on narrow screens; a reference never breaks at its hyphens. */}
				<span class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 whitespace-nowrap">
					<a href={`/parts/${n.part.id}`}>{n.part.ref}</a>
					<span class="min-w-0 truncate text-muted-foreground">{n.part.name}</span>
					<KindBadge kind={n.part.kind} />
					{n.mode === "missing_assembly" ? (
						<Badge variant="warning">{t.assemblies.modes.missing_assembly}</Badge>
					) : null}
				</span>
			</span>
			<span class="text-right text-muted-foreground tabular-nums">
				×<Qty milli={n.perParentMilli} unit={n.part.unit} />
				{n.parentBatchMilli !== MILLI ? (
					<span class="text-xs">
						{" "}
						/ <Qty milli={n.parentBatchMilli} />
					</span>
				) : null}
			</span>
			<span class="text-right font-semibold tabular-nums">
				<Qty milli={n.qtyMilli} unit={n.part.unit} />
			</span>
			{seeCosts ? (
				<>
					<span class="hidden text-right md:block">
						<CostView cost={cost} refs={props.refs} />
					</span>
					<span class="hidden text-right md:block">
						<Money cents={centsOf(props.calc.extended(n.part.id, n.qtyMilli))} />
					</span>
				</>
			) : null}
		</>
	);
	if (!branch) {
		return (
			<li>
				<div class={cn(row, "transition-colors hover:bg-muted/50")}>{cells}</div>
			</li>
		);
	}
	return (
		<li>
			<details open class="group">
				<summary class={cn(row, "list-none transition-colors hover:bg-muted/50 [&::-webkit-details-marker]:hidden")}>
					{cells}
				</summary>
				<ul class="m-0 ml-6 list-none border-l p-0">
					{n.children.map((child) => (
						<TreeNode node={child} calc={props.calc} refs={props.refs} />
					))}
				</ul>
			</details>
		</li>
	);
}

assemblyRoutes.get("/:id/history", async (c) => {
	const data = await loadAssembly(c);
	if (!data) return notFound(c);
	return recordHistoryPage(
		c,
		assemblyLabel(data.part.ref, data.assembly),
		<AssemblyHeader assembly={data.assembly} part={data.part} tab="history" />,
		{ kind: "assembly", id: data.assembly.id },
	);
});

assemblyRoutes.get("/:id/tree", async (c) => {
	const data = await loadAssembly(c);
	if (!data) return notFound(c);
	const t = c.var.t;
	const qty = qtyParam(c, data.assembly.batchQtyMilli);
	const graph = await loadGraph(c.var.db);
	const calc = new CostCalculator(graph);
	const refs = new Map([...graph.parts.values()].map((p) => [p.id, p.ref]));
	let explosion: Explosion | null = null;
	let error = "";
	try {
		explosion = explode(graph, data.assembly.id, qty);
	} catch (err) {
		error = err instanceof Error ? err.message : String(err);
	}
	const machines = new Map([...graph.machineTypes.values()].map((m) => [m.id, m.name]));
	const unit = calc.assembly(data.assembly.id);
	const seeCosts = c.var.seeCosts;
	return page(
		c,
		`${data.part.ref} · ${t.assemblies.tree}`,
		<>
			<AssemblyHeader
				assembly={data.assembly}
				part={data.part}
				tab="tree"
				pricing={assemblyPricing(data.part, data.assembly, calc)}
			/>
			<QtyForm action={`/assemblies/${data.assembly.id}/tree`} qty={qty} />
			{error ? <Alert variant="destructive">{error}</Alert> : null}
			<Card class="gap-0 overflow-hidden py-0">
				<div
					class={cn(
						seeCosts ? TREE_ROW : TREE_ROW_QTY,
						"min-h-10 bg-muted/50 py-0 text-xs font-medium tracking-wide text-muted-foreground uppercase",
					)}
				>
					<span class="pl-6">{t.assemblies.component}</span>
					<span class="text-right">{t.assemblies.perParent}</span>
					<span class="text-right">{t.assemblies.cumulative}</span>
					{seeCosts ? (
						<>
							<span class="hidden text-right md:block">{t.assemblies.unitCost}</span>
							<span class="hidden text-right md:block">{t.assemblies.lineCost}</span>
						</>
					) : null}
				</div>
				<ul class="m-0 list-none p-0">
					{explosion?.tree.map((n) => (
						<TreeNode node={n} calc={calc} refs={refs} />
					))}
				</ul>
				{seeCosts ? (
					<div class={cn(TREE_ROW, "border-b-0 bg-muted/50 font-semibold")}>
						<span class="pl-6">
							{t.common.total} ({formatQtyInput(qty, c.var.locale)} × {data.part.ref})
						</span>
						<span class="hidden md:block" />
						<span class="hidden md:block" />
						<span class="hidden text-right md:block">
							<CostView cost={unit} refs={refs} />
						</span>
						<span class="col-span-2 text-right md:col-span-1">
							<Money cents={centsOf(roundDiv(unit.millicents * qty, MILLI))} />
						</span>
					</div>
				) : null}
				{seeCosts && unit.incomplete ? (
					<IncompleteNote refs={missingNames(unit, refs, machines).join(", ")} class="border-t px-4 py-3" />
				) : null}
			</Card>
			{explosion?.machines.length ? (
				<div class="mt-6">
					<MachineTimeCard title={t.machines.time} rows={machineTimeRows(explosion, calc)} />
				</div>
			) : null}
		</>,
	);
});

assemblyRoutes.get("/:id/diagram", async (c) => {
	const data = await loadAssembly(c);
	if (!data) return notFound(c);
	const t = c.var.t;
	const qty = qtyParam(c, data.assembly.batchQtyMilli);
	const depthParam = Number(c.req.query("depth"));
	const depth = Number.isInteger(depthParam) && depthParam > 0 ? depthParam : undefined;
	const assembliesOnly = c.req.query("only") === "assemblies";
	const graph = await loadGraph(c.var.db);
	const calc = new CostCalculator(graph);
	const refs = new Map([...graph.parts.values()].map((p) => [p.id, p.ref]));
	let explosion: Explosion | null = null;
	let error = "";
	try {
		explosion = explode(graph, data.assembly.id, qty);
	} catch (err) {
		error = err instanceof Error ? err.message : String(err);
	}
	const base = `/assemblies/${data.assembly.id}/diagram`;
	const href = (o: { depth?: number | undefined; assembliesOnly?: boolean }) => {
		const params = new URLSearchParams();
		if (qty !== data.assembly.batchQtyMilli) params.set("qty", formatQtyInput(qty, c.var.locale));
		const d = "depth" in o ? o.depth : depth;
		if (d) params.set("depth", String(d));
		if (o.assembliesOnly ?? assembliesOnly) params.set("only", "assemblies");
		const qs = params.toString();
		return qs ? `${base}?${qs}` : base;
	};
	const view: DiagramView = { depth, assembliesOnly, href };
	const rootPart = graph.parts.get(data.part.id);
	const tree = explosion && rootPart ? diagramTree(rootPart, data.assembly.id, qty, explosion.tree, calc) : null;
	const fullDepth = tree ? treeDepth(tree) : 0;
	const nodes = explosion ? [...walkTree(explosion.tree)] : [];
	const unit = calc.assembly(data.assembly.id);
	const title = fmt(t.assemblies.diagramTitle, { ref: data.part.ref });
	return page(
		c,
		`${data.part.ref} · ${t.assemblies.diagram}`,
		<>
			<AssemblyHeader
				assembly={data.assembly}
				part={data.part}
				tab="diagram"
				pricing={assemblyPricing(data.part, data.assembly, calc)}
			/>
			{error ? <Alert variant="destructive">{error}</Alert> : null}
			{tree ? (
				<>
					<div class={cn("mb-4 grid grid-cols-2 gap-3", c.var.seeCosts ? "md:grid-cols-4" : "md:grid-cols-3")}>
						<StatCard label={t.assemblies.stats.levels} value={fullDepth} icon={icons.listTree} />
						<StatCard
							label={t.assemblies.stats.components}
							value={new Set(nodes.map((n) => n.part.id)).size}
							icon={icons.package}
						/>
						<StatCard
							label={`${t.assemblies.stats.assemblies} · ${t.assemblies.stats.kits}`}
							value={`${new Set(nodes.filter((n) => n.part.kind === "make").map((n) => n.part.id)).size} · ${new Set(nodes.filter((n) => n.part.kind === "kit").map((n) => n.part.id)).size}`}
							icon={icons.boxes}
						/>
						{c.var.seeCosts ? (
							<StatCard
								label={t.assemblies.totalCost}
								value={<CostView cost={unit} refs={refs} />}
								icon={icons.clipboardList}
								tone={unit.incomplete ? "warning" : "default"}
							/>
						) : null}
					</div>
					<div class="mb-4 flex flex-wrap items-center gap-3">
						<QtyForm
							action={base}
							qty={qty}
							class=""
							hidden={{ depth: depth ? String(depth) : "", only: assembliesOnly ? "assemblies" : "" }}
						/>
						<ToggleLinks
							label={t.assemblies.levels}
							items={[
								...Array.from({ length: Math.min(fullDepth, 4) }, (_, i) => ({
									href: href({ depth: i + 1 }),
									label: String(i + 1),
									active: depth === i + 1,
									title: `${t.assemblies.levels}: ${i + 1}`,
								})),
								{
									href: href({ depth: undefined }),
									label: t.assemblies.allLevels,
									active: depth === undefined,
									title: undefined,
								},
							]}
						/>
						<ToggleLinks
							label={t.assemblies.show}
							items={[
								{ href: href({ assembliesOnly: false }), label: t.assemblies.showAll, active: !assembliesOnly },
								{ href: href({ assembliesOnly: true }), label: t.assemblies.showAssemblies, active: assembliesOnly },
							]}
						/>
					</div>
					<AssemblyDiagram tree={tree} view={view} title={title} />
				</>
			) : null}
		</>,
	);
});

assemblyRoutes.get("/:id/explode", async (c) => {
	const data = await loadAssembly(c);
	if (!data) return notFound(c);
	const t = c.var.t;
	const qty = qtyParam(c, data.assembly.batchQtyMilli);
	const useStock = c.req.query("stock") === "on";
	const [graph, stock] = await Promise.all([loadGraph(c.var.db), onHandMap(c.var.db)]);
	const calc = new CostCalculator(graph);
	const refs = new Map([...graph.parts.values()].map((p) => [p.id, p.ref]));
	const ex = explode(graph, data.assembly.id, qty, useStock ? { stock } : {});
	const rows = ex.requirements.map((r) => {
		const onHand = stock.get(r.part.id) ?? 0;
		return { ...r, onHand, short: Math.max(0, r.qtyMilli - Math.max(0, onHand)), cost: calc.part(r.part.id) };
	});
	const machineRows = ex.machines.map((m) => ({ ...m, cost: calc.machine(m.machineType.id, m.minutesMilli) }));
	const machines = new Map([...graph.machineTypes.values()].map((m) => [m.id, m.name]));
	const seeCosts = c.var.seeCosts;
	if (c.req.query("format") === "csv") {
		const locale = c.var.locale;
		return csvResponse(
			c,
			`${data.part.ref}-${data.assembly.code}-${data.assembly.revision}-x${formatQtyInput(qty)}.csv`,
			[
				["ref", "name", "kind", "unit", "qty", "on_hand", "short", "unit_cost", "extended_cost"],
				...[...rows, ...ex.fees.map((f) => ({ ...f, onHand: 0, short: 0, cost: calc.part(f.part.id) }))].map((r) => [
					r.part.ref,
					r.part.name,
					r.part.kind,
					r.part.unit,
					formatQtyInput(r.qtyMilli, locale),
					r.part.kind === "fee" ? "" : formatQtyInput(r.onHand, locale),
					r.part.kind === "fee" ? "" : formatQtyInput(r.short, locale),
					r.cost.incomplete ? "" : formatCentsInput(centsOf(r.cost.millicents), locale),
					r.cost.incomplete ? "" : formatCentsInput(centsOf(calc.extended(r.part.id, r.qtyMilli)), locale),
				]),
				// Machine time (D148): in hours, at the type's hourly rate.
				...machineRows.map((m) => [
					m.machineType.name,
					t.machines.time,
					"machine",
					"h",
					formatQtyInput(ceilDiv(m.minutesMilli, 60), locale),
					"",
					"",
					m.machineType.rateCents === null ? "" : formatCentsInput(m.machineType.rateCents, locale),
					m.cost.incomplete ? "" : formatCentsInput(centsOf(m.cost.millicents), locale),
				]),
			],
		);
	}
	const totalMillicents =
		[...ex.requirements, ...ex.fees].reduce((s, r) => s + calc.extended(r.part.id, r.qtyMilli), 0) +
		machineRows.reduce((s, m) => s + m.cost.millicents, 0);
	const total = calc.assembly(data.assembly.id);
	const query = `qty=${encodeURIComponent(formatQtyInput(qty))}${useStock ? "&stock=on" : ""}`;
	return page(
		c,
		`${data.part.ref} · ${t.assemblies.explode}`,
		<>
			<AssemblyHeader
				assembly={data.assembly}
				part={data.part}
				tab="explode"
				pricing={assemblyPricing(data.part, data.assembly, calc)}
			/>
			<div class="mb-4 flex flex-wrap items-center justify-between gap-3">
				<QtyForm action={`/assemblies/${data.assembly.id}/explode`} qty={qty} stock={useStock} showStock class="" />
				<Button
					href={`/assemblies/${data.assembly.id}/explode?${query}&format=csv`}
					variant="outline"
					icon={icons.download}
				>
					{t.assemblies.downloadCsv}
				</Button>
			</div>
			{rows
				.filter((r) => r.missingAssembly)
				.map((r) => (
					<Alert variant="warning">{fmt(t.assemblies.missingAssembly, { ref: r.part.ref })}</Alert>
				))}
			<Card class="gap-0 overflow-hidden py-0">
				<Table>
					<TableHeader class="bg-muted/50">
						<TableRow>
							<TableHead>{t.parts.ref}</TableHead>
							<TableHead>{t.parts.name}</TableHead>
							<TableHead>{t.parts.kind}</TableHead>
							<TableHead class="text-right">{t.assemblies.qty}</TableHead>
							<TableHead class="text-right">{t.assemblies.onHand}</TableHead>
							<TableHead class="text-right">{t.assemblies.short}</TableHead>
							{seeCosts ? (
								<>
									<TableHead class="text-right">{t.assemblies.unitCost}</TableHead>
									<TableHead class="text-right">{t.assemblies.lineCost}</TableHead>
								</>
							) : null}
						</TableRow>
					</TableHeader>
					<TableBody>
						{rows.map((r) => (
							<TableRow>
								<TableCell>
									<a href={`/parts/${r.part.id}`}>{r.part.ref}</a>
								</TableCell>
								<TableCell>
									{r.part.name}
									{r.part.kind === "make" ? (
										<Badge variant="info" class="ml-1.5">
											{t.assemblies.fromStock}
										</Badge>
									) : null}
								</TableCell>
								<TableCell>
									<KindBadge kind={r.part.kind} />
								</TableCell>
								<TableCell class="text-right">
									<Qty milli={r.qtyMilli} unit={r.part.unit} />
								</TableCell>
								<TableCell class="text-right">
									<Qty milli={r.onHand} unit={r.part.unit} />
								</TableCell>
								<TableCell class="text-right">
									{r.short > 0 ? (
										<span class="font-semibold text-destructive tabular-nums">
											{formatQtyInput(r.short, c.var.locale)}
										</span>
									) : (
										""
									)}
								</TableCell>
								{seeCosts ? (
									<>
										<TableCell class="text-right">
											<CostView cost={r.cost} refs={refs} />
										</TableCell>
										<TableCell class="text-right">
											<Money cents={centsOf(calc.extended(r.part.id, r.qtyMilli))} />
										</TableCell>
									</>
								) : null}
							</TableRow>
						))}
					</TableBody>
					{ex.fees.length ? (
						<TableBody class="border-t">
							<TableRow class="bg-muted/30 hover:bg-muted/30">
								<TableHead colspan={seeCosts ? 8 : 6} scope="rowgroup">
									{t.assemblies.fees}
								</TableHead>
							</TableRow>
							{ex.fees.map((f) => (
								<TableRow>
									<TableCell>
										<a href={`/parts/${f.part.id}`}>{f.part.ref}</a>
									</TableCell>
									<TableCell>{f.part.name}</TableCell>
									<TableCell>
										<KindBadge kind={f.part.kind} />
									</TableCell>
									<TableCell class="text-right">
										<Qty milli={f.qtyMilli} unit={f.part.unit} />
									</TableCell>
									<TableCell />
									<TableCell />
									{seeCosts ? (
										<>
											<TableCell class="text-right">
												<CostView cost={calc.part(f.part.id)} refs={refs} />
											</TableCell>
											<TableCell class="text-right">
												<Money cents={centsOf(calc.extended(f.part.id, f.qtyMilli))} />
											</TableCell>
										</>
									) : null}
								</TableRow>
							))}
						</TableBody>
					) : null}
					{machineRows.length ? (
						<TableBody class="border-t">
							<TableRow class="bg-muted/30 hover:bg-muted/30">
								<TableHead colspan={seeCosts ? 8 : 6} scope="rowgroup">
									{t.machines.time}
								</TableHead>
							</TableRow>
							{machineRows.map((m) => (
								<TableRow>
									<TableCell>
										<a href={`/machines/types/${m.machineType.id}`}>{m.machineType.name}</a>
									</TableCell>
									<TableCell>{t.machines.time}</TableCell>
									<TableCell />
									<TableCell class="text-right">
										<Duration minutesMilli={m.minutesMilli} />
									</TableCell>
									<TableCell />
									<TableCell />
									{seeCosts ? (
										<>
											<TableCell class="text-right whitespace-nowrap">
												<Money cents={m.machineType.rateCents} />
												{m.machineType.rateCents === null ? null : t.machines.perHour}
											</TableCell>
											<TableCell class="text-right">
												<CostView cost={m.cost} refs={refs} machines={machines} />
											</TableCell>
										</>
									) : null}
								</TableRow>
							))}
						</TableBody>
					) : null}
					{seeCosts ? (
						<TableFooter>
							<TableRow class="hover:bg-transparent">
								<TableCell colspan={7}>{t.common.total}</TableCell>
								<TableCell class="text-right font-semibold">
									<Money cents={centsOf(totalMillicents)} />
									{total.incomplete ? <span class="font-medium text-warning"> *</span> : null}
								</TableCell>
							</TableRow>
						</TableFooter>
					) : null}
				</Table>
				{seeCosts && total.incomplete ? (
					<IncompleteNote refs={missingNames(total, refs, machines).join(", ")} class="border-t px-4 py-3" />
				) : null}
			</Card>
		</>,
	);
});
