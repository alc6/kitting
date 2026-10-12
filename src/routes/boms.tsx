import { and, asc, eq, sql } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import type { Child } from "hono/jsx";
import { z } from "zod";
import { BOM_STATUSES, type Bom, bomLines, boms, type Part, parts } from "../db/schema";
import {
	type Cost,
	CostCalculator,
	centsOf,
	type ExplodedNode,
	type Explosion,
	explode,
	walkTree,
} from "../domain/bom-graph";
import {
	activateStatements,
	bomInput,
	bomLineInput,
	bomSalePriceStatements,
	createBomStatements,
	DEFAULT_CODE,
	DEFAULT_REVISION,
	findBom,
	getBom,
	getBomLines,
	listBoms,
	loadGraph,
	nextRevision,
	wouldCreateCycle,
} from "../domain/boms";
import { type Margin, marginOf, salePriceOf } from "../domain/margins";
import { onHandMap, partOptions } from "../domain/parts";
import { errorText, fmt } from "../i18n";
import { cn } from "../lib/cn";
import { runBatch } from "../lib/db";
import { isConstraintError } from "../lib/sql";
import {
	formatCentsInput,
	formatMoney,
	formatPercent,
	formatQtyInput,
	MILLI,
	parseMilli,
	roundDiv,
} from "../lib/units";
import { type FieldErrors, field, validate } from "../lib/validation";
import { requireAdmin } from "../middleware/auth";
import type { AppEnv } from "../types";
import { CostView, StatusBadge } from "../views/bom";
import { BomDiagram, type DiagramView, diagramTree, treeDepth } from "../views/bom-diagram";
import { useApp } from "../views/context";
import { Icon, type IconNode, icons } from "../views/icons";
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
	DecimalField,
	DetailList,
	Empty,
	EmptyState,
	ErrorBanner,
	FieldGroup,
	Flash,
	type FormErrors,
	type FormValues,
	KindBadge,
	LinkButton,
	LinkTabs,
	Money,
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
import { csvResponse } from "./import";
import { marginTone } from "./margins";

export const bomRoutes = new Hono<AppEnv>();

type BomRow = Awaited<ReturnType<typeof listBoms>>[number];
type LineRow = Awaited<ReturnType<typeof getBomLines>>[number];

function qtyParam(c: Context<AppEnv>): number {
	const n = parseMilli(c.req.query("qty") ?? "1");
	return n !== null && n > 0 ? n : MILLI;
}

type BomTab = "editor" | "tree" | "diagram" | "explode";

function BomTabs(props: { bom: Bom; active: BomTab }) {
	const { t } = useApp();
	const id = props.bom.id;
	const tabs: { key: BomTab; href: string; label: string; icon: IconNode }[] = [
		{ key: "editor", href: `/boms/${id}`, label: t.boms.editor, icon: icons.pencil },
		{ key: "tree", href: `/boms/${id}/tree`, label: t.boms.tree, icon: icons.listTree },
		{ key: "diagram", href: `/boms/${id}/diagram`, label: t.boms.diagram, icon: icons.diagram },
		{ key: "explode", href: `/boms/${id}/explode`, label: t.boms.explode, icon: icons.list },
	];
	return <LinkTabs items={tabs.map((tab) => ({ ...tab, active: tab.key === props.active }))} />;
}

/** Effective selling price of a BoM variant and its planned margin (standard cost roll-up). */
type BomPricing = { priceCents: number; ownPrice: boolean; margin: Margin | null; incomplete: boolean };

function bomPricing(part: Part, bom: Bom, calc: CostCalculator): BomPricing | null {
	const priceCents = salePriceOf(part, bom);
	if (priceCents === null) return null;
	const cost = calc.bom(bom.id);
	return {
		priceCents,
		ownPrice: bom.salePriceCents !== null,
		margin: marginOf(priceCents, centsOf(cost.millicents)),
		incomplete: cost.incomplete,
	};
}

/** Selling price and planned margin, shown in the BoM header when the variant has a price. */
function PricingSummary(props: { pricing: BomPricing }) {
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
					<span class="text-xs">({t.boms.salePriceInherited})</span>
				)}
			</span>
			{m ? (
				<span>
					{t.boms.plannedMargin}:{" "}
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
		</>
	);
}

function BomHeader(props: { bom: Bom; part: Part; tab: BomTab; pricing?: BomPricing | null }) {
	const { t, isAdmin } = useApp();
	const { bom, part } = props;
	return (
		<>
			<PageHeader
				title={`${part.ref} · ${part.name}`}
				subtitle={
					<span class="flex flex-wrap items-center gap-x-3 gap-y-1">
						<KindBadge kind={part.kind} />
						<span>
							{t.boms.code}: <strong class="font-medium text-foreground">{bom.code}</strong>
						</span>
						<span>
							{t.boms.revision}: <strong class="font-medium text-foreground">{bom.revision}</strong>
						</span>
						<StatusBadge status={bom.status} />
						{props.pricing ? <PricingSummary pricing={props.pricing} /> : null}
					</span>
				}
				actions={
					<>
						{bom.status !== "active" ? (
							<PostButton
								action={`/boms/${bom.id}/activate`}
								label={t.boms.activate}
								variant="default"
								icon={icons.check}
							/>
						) : null}
						{bom.status === "archived" ? (
							<PostButton action={`/boms/${bom.id}/draft`} label={t.boms.toDraft} icon={icons.archiveRestore} />
						) : null}
						<PostButton action={`/boms/${bom.id}/revision`} label={t.boms.newRevision} icon={icons.copy} />
						<LinkButton
							href={`/boms/new?part=${part.id}&copy_from=${bom.id}`}
							label={t.boms.newVariant}
							variant="outline"
							icon={icons.layers}
						/>
						{isAdmin && bom.status !== "archived" ? (
							<PostButton
								action={`/boms/${bom.id}/archive`}
								label={t.boms.archive}
								confirm={t.common.confirmArchive}
								icon={icons.archive}
							/>
						) : null}
						{isAdmin ? (
							<PostButton
								action={`/boms/${bom.id}/delete`}
								label={t.common.delete}
								confirm={t.common.confirmDelete}
								variant="destructive"
								icon={icons.trash}
							/>
						) : null}
					</>
				}
			/>
			<BomTabs bom={bom} active={props.tab} />
		</>
	);
}

// ---------------------------------------------------------------------------
// List

function BomList(props: { rows: BomRow[]; q: string; status: string }) {
	const { t } = useApp();
	return (
		<>
			<PageHeader title={t.boms.title} actions={<LinkButton href="/boms/new" label={t.boms.new} icon={icons.plus} />} />
			<SearchBar action="/boms" q={props.q}>
				<select name="status" aria-label={t.boms.status} data-slot="native-select" class="w-auto min-w-44">
					<option value="">{t.boms.statusFilter.open}</option>
					{BOM_STATUSES.map((s) => (
						<option value={s} selected={s === props.status}>
							{t.boms.statuses[s]}
						</option>
					))}
					<option value="all" selected={props.status === "all"}>
						{t.boms.statusFilter.all}
					</option>
				</select>
			</SearchBar>
			<div id="results">
				{props.rows.length === 0 ? (
					<EmptyState icon={icons.listTree} description={t.boms.noBoms} />
				) : (
					<Card class="gap-0 overflow-hidden py-0">
						<Table>
							<TableHeader class="bg-muted/50">
								<TableRow>
									<TableHead>{t.boms.parent}</TableHead>
									<TableHead>{t.parts.kind}</TableHead>
									<TableHead>{t.boms.code}</TableHead>
									<TableHead>{t.boms.revision}</TableHead>
									<TableHead>{t.boms.status}</TableHead>
									<TableHead class="text-right">{t.boms.lines}</TableHead>
									<TableHead class="w-px">
										<span class="sr-only">{t.boms.diagram}</span>
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{props.rows.map((b) => (
									<TableRow>
										<TableCell>
											<a href={`/boms/${b.id}`}>{b.partRef}</a> <span class="text-muted-foreground">{b.partName}</span>
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
												href={`/boms/${b.id}/diagram`}
												variant="ghost"
												size="icon-sm"
												icon={icons.diagram}
												aria-label={fmt(t.boms.openDiagram, { ref: b.partRef })}
												title={fmt(t.boms.openDiagram, { ref: b.partRef })}
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

bomRoutes.get("/", async (c) => {
	const q = c.req.query("q") ?? "";
	const status = c.req.query("status") ?? "";
	const rows = await listBoms(c.var.db, { q, status });
	return page(c, c.var.t.boms.title, <BomList rows={rows} q={q} status={status} />);
});

// ---------------------------------------------------------------------------
// Create

type ParentOption = { id: number; ref: string; name: string };
type SourceOption = { id: number; label: string };

function NewBomForm(props: {
	values: FormValues;
	errors: FormErrors;
	parents: ParentOption[];
	sources: SourceOption[];
}) {
	const { t } = useApp();
	const p = { values: props.values, errors: props.errors };
	return (
		<Card class="max-w-3xl">
			<form method="post" action="/boms" class="flex flex-col gap-6">
				<CardContent>
					<ErrorBanner show={Object.keys(props.errors).length > 0} />
					<FieldGroup>
						<SelectField
							name="parent_part_id"
							label={t.boms.parent}
							hint={t.boms.parentHint}
							required
							options={[
								{ value: "", label: "—" },
								...props.parents.map((o) => ({ value: String(o.id), label: `${o.ref} · ${o.name}` })),
							]}
							{...p}
						/>
						<div class="grid gap-4 md:grid-cols-2">
							<TextField name="code" label={t.boms.code} hint={t.boms.codeHint} required {...p} />
							<TextField name="revision" label={t.boms.revision} required {...p} />
						</div>
						<SelectField
							name="copy_from"
							label={t.boms.copyFrom}
							options={[
								{ value: "", label: t.boms.copyNone },
								...props.sources.map((s) => ({ value: String(s.id), label: s.label })),
							]}
							{...p}
						/>
						<TextArea name="notes" label={t.common.notes} {...p} />
					</FieldGroup>
				</CardContent>
				<CardFooter class="border-t">
					<Button icon={icons.plus}>{t.common.create}</Button>
					<Button href="/boms" variant="outline">
						{t.common.cancel}
					</Button>
				</CardFooter>
			</form>
		</Card>
	);
}

async function newBomOptions(c: Context<AppEnv>) {
	const [parents, all] = await Promise.all([
		partOptions(c.var.db, ["make", "kit"]),
		listBoms(c.var.db, { status: "all" }),
	]);
	const sources = all.map((b) => ({ id: b.id, label: `${b.partRef} · ${b.code} · ${b.revision}` }));
	return { parents, sources };
}

bomRoutes.get("/new", async (c) => {
	const t = c.var.t;
	const { parents, sources } = await newBomOptions(c);
	const values: FormValues = {
		parent_part_id: c.req.query("part") ?? "",
		code: DEFAULT_CODE,
		revision: DEFAULT_REVISION,
		copy_from: c.req.query("copy_from") ?? "",
	};
	if (values.copy_from) values.code = "";
	return page(
		c,
		t.boms.new,
		<>
			<PageHeader title={t.boms.new} />
			<NewBomForm values={values} errors={{}} parents={parents} sources={sources} />
		</>,
	);
});

bomRoutes.post("/", async (c) => {
	const t = c.var.t;
	const db = c.var.db;
	const body = await c.req.parseBody();
	const v = validate(bomInput, body);
	const errors: FieldErrors = v.ok ? {} : { ...v.errors };
	if (v.ok) {
		const parentId = v.data.parent_part_id;
		const parent = parentId ? (await db.select().from(parts).where(eq(parts.id, parentId)).limit(1))[0] : undefined;
		if (!parent) errors.parent_part_id = "required";
		else if (parent.kind !== "make" && parent.kind !== "kit") errors.parent_part_id = "bom_parent_kind";
		else if (await findBom(db, parent.id, v.data.code, v.data.revision)) errors.revision = "duplicate_bom";
		if (v.data.copy_from && parent) {
			// Copying lines from another parent's BoM must not create a cycle.
			const src = await getBomLines(db, v.data.copy_from);
			for (const line of src) {
				if (await wouldCreateCycle(db, parent.id, line.partId)) {
					errors.copy_from = "bom_cycle";
					break;
				}
			}
		}
	}
	if (!v.ok || Object.keys(errors).length > 0) {
		const { parents, sources } = await newBomOptions(c);
		return page(
			c,
			t.boms.new,
			<>
				<PageHeader title={t.boms.new} />
				<NewBomForm
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
	await runBatch(
		db,
		createBomStatements(
			db,
			{ parentPartId: d.parent_part_id as number, code: d.code, revision: d.revision, notes: d.notes },
			d.copy_from,
			user,
			now,
		),
	);
	const created = await findBom(db, d.parent_part_id as number, d.code, d.revision);
	return redirectOk(c, `/boms/${created?.id}`);
});

// ---------------------------------------------------------------------------
// Editor

async function loadBom(c: Context<AppEnv>) {
	const id = idParam(c);
	return id ? getBom(c.var.db, id) : undefined;
}

function LinesEditor(props: {
	bom: Bom;
	part: Part;
	lines: LineRow[];
	costs: Map<number, Cost>;
	total: Cost;
	refs: Map<number, string>;
	options: { ref: string; name: string }[];
	values: FormValues;
	errors: FormErrors;
}) {
	const { t, locale } = useApp();
	const { bom } = props;
	const editable = bom.status !== "archived";
	const hx = {
		"hx-target": "#bom-lines",
		"hx-select": "#bom-lines",
		"hx-swap": "outerHTML",
	};
	return (
		<>
			{bom.status === "active" ? <Alert variant="warning">{t.boms.activeWarning}</Alert> : null}
			{bom.status === "archived" ? <Alert>{t.boms.archivedNote}</Alert> : null}
			<Card id="bom-lines" class="gap-4">
				<CardHeader>
					<CardTitle>{t.boms.editor}</CardTitle>
					<CardDescription>{fmt(t.boms.linesCount, { n: props.lines.length })}</CardDescription>
				</CardHeader>
				{props.lines.length === 0 ? (
					<CardContent>
						<Empty />
					</CardContent>
				) : (
					<Table class={cn("border-t", FLUSH_TABLE)}>
						<TableHeader class="bg-muted/50">
							<TableRow>
								{editable ? <TableHead class="w-px" /> : null}
								<TableHead>{t.boms.component}</TableHead>
								<TableHead>{t.parts.kind}</TableHead>
								<TableHead class="text-right">{t.boms.qty}</TableHead>
								<TableHead class="text-right">{t.boms.unitCost}</TableHead>
								<TableHead class="text-right">{t.boms.lineCost}</TableHead>
								{editable ? <TableHead class="w-px" /> : null}
							</TableRow>
						</TableHeader>
						<TableBody>
							{props.lines.map((l, i) => {
								const cost = props.costs.get(l.partId);
								const lineUrl = `/boms/${bom.id}/lines/${l.id}`;
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
														label={t.boms.moveUp}
														disabled={i === 0}
													/>
													<LineActionForm
														action={`${lineUrl}/move`}
														hx={hx}
														hidden={{ dir: "down" }}
														icon={icons.arrowDown}
														label={t.boms.moveDown}
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
														aria-label={`${t.boms.qty} ${l.ref}`}
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
										<TableCell class="text-right">{cost ? <CostView cost={cost} refs={props.refs} /> : null}</TableCell>
										<TableCell class="text-right">
											{cost ? <Money cents={centsOf(roundDiv(l.qtyMilli * cost.millicents, MILLI))} /> : null}
										</TableCell>
										{editable ? (
											<TableCell class="w-px py-1">
												<LineActionForm action={`${lineUrl}/delete`} hx={hx} icon={icons.trash} label={t.boms.remove} />
											</TableCell>
										) : null}
									</TableRow>
								);
							})}
						</TableBody>
						<TableFooter>
							<TableRow class="hover:bg-transparent">
								<TableCell colspan={editable ? 5 : 4}>{t.boms.totalCost}</TableCell>
								<TableCell class="text-right font-semibold">
									<CostView cost={props.total} refs={props.refs} />
								</TableCell>
								{editable ? <TableCell /> : null}
							</TableRow>
						</TableFooter>
					</Table>
				)}
				{props.total.incomplete ? (
					<CardContent>
						<IncompleteNote refs={props.total.missing.map((id) => props.refs.get(id) ?? id).join(", ")} />
					</CardContent>
				) : null}
				{editable ? (
					<CardFooter class="flex-col items-stretch border-t">
						<form
							method="post"
							action={`/boms/${bom.id}/lines`}
							class="flex w-full flex-col gap-3"
							hx-post={`/boms/${bom.id}/lines`}
							{...hx}
						>
							<ErrorBanner show={Object.keys(props.errors).length > 0} />
							<div class="grid gap-3 md:grid-cols-[2fr_1fr_2fr_auto] md:items-end">
								<TextField
									name="component"
									label={t.boms.component}
									placeholder={t.boms.componentHint}
									list="part-refs"
									required
									values={props.values}
									errors={props.errors}
								/>
								<TextField
									name="qty"
									label={t.boms.qty}
									inputmode="decimal"
									required
									values={props.values}
									errors={props.errors}
								/>
								<TextField name="notes" label={t.common.notes} values={props.values} errors={props.errors} />
								<Button icon={icons.plus}>{t.boms.addLine}</Button>
							</div>
							<datalist id="part-refs">
								{props.options.map((o) => (
									<option value={o.ref}>{o.name}</option>
								))}
							</datalist>
						</form>
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
			{fmt(t.boms.incomplete, { refs: props.refs })}
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

const salePriceInput = z.object({ sale_price: field.money() });

/** The variant's own selling price (empty = the part's), editable unless the BoM is archived. */
function SalePriceCard(props: { bom: Bom; part: Part; values: FormValues; errors: FormErrors }) {
	const { t, locale, currency } = useApp();
	const { bom, part } = props;
	const partPrice = part.salePriceCents;
	if (bom.status === "archived") {
		const effective = salePriceOf(part, bom);
		return (
			<SideCard title={t.boms.salePriceTitle} icon={icons.tag}>
				<DetailList
					items={[
						{
							label: t.boms.salePrice,
							value: (
								<span class="inline-flex flex-wrap items-center gap-1.5">
									{effective === null ? t.common.none : <Money cents={effective} />}
									{bom.salePriceCents === null && effective !== null ? (
										<span class="text-xs text-muted-foreground">({t.boms.salePriceInherited})</span>
									) : null}
								</span>
							),
						},
					]}
				/>
			</SideCard>
		);
	}
	return (
		<Card id="sale-price" class="gap-4">
			<CardHeader>
				<CardTitle icon={icons.tag}>{t.boms.salePriceTitle}</CardTitle>
			</CardHeader>
			<form method="post" action={`/boms/${bom.id}/sale-price`} class="flex flex-col gap-4">
				<CardContent>
					<DecimalField
						name="sale_price"
						label={t.boms.salePrice}
						hint={
							partPrice === null
								? t.boms.salePriceHintNone
								: fmt(t.boms.salePriceHint, { price: formatMoney(partPrice, locale, currency) })
						}
						values={props.values}
						errors={props.errors}
					/>
				</CardContent>
				<CardFooter>
					<Button variant="outline" icon={icons.save}>
						{t.common.save}
					</Button>
				</CardFooter>
			</form>
		</Card>
	);
}

async function renderEditor(
	c: Context<AppEnv>,
	data: { bom: Bom; part: Part },
	form: { values: FormValues; errors: FieldErrors; vars?: Record<string, string> } = {
		values: { qty: "1" },
		errors: {},
	},
	status: 200 | 422 = 200,
	/** The selling price form, when re-rendered with errors. */
	price?: { values: FormValues; errors: FieldErrors },
) {
	const db = c.var.db;
	const { bom, part } = data;
	const [lines, graph, options, siblings] = await Promise.all([
		getBomLines(db, bom.id),
		loadGraph(db),
		partOptions(db),
		db
			.select({ id: boms.id, code: boms.code, revision: boms.revision, status: boms.status })
			.from(boms)
			.where(eq(boms.parentPartId, part.id))
			.orderBy(asc(boms.code), asc(boms.revision)),
	]);
	const calc = new CostCalculator(graph);
	const costs = new Map(lines.map((l) => [l.partId, calc.part(l.partId)]));
	const total = calc.bom(bom.id);
	const refs = new Map([...graph.parts.values()].map((p) => [p.id, p.ref]));
	const t = c.var.t;
	const priceValues = price?.values ?? {
		sale_price: bom.salePriceCents === null ? "" : formatCentsInput(bom.salePriceCents, c.var.locale),
	};
	return page(
		c,
		`${part.ref} ${bom.code} ${bom.revision}`,
		<>
			<BomHeader bom={bom} part={part} tab="editor" pricing={bomPricing(part, bom, calc)} />
			<Flash ok={c.req.query("ok")} message={c.req.query("ok") === "activated" ? t.boms.activated : undefined} />
			{c.req.query("err") ? <Alert variant="destructive">{errorText(t, c.req.query("err") ?? "")}</Alert> : null}
			<LinesEditor
				bom={bom}
				part={part}
				lines={lines}
				costs={costs}
				total={total}
				refs={refs}
				options={options.filter((o) => o.id !== part.id)}
				values={form.values}
				errors={translateErrors(c, form.errors, form.vars)}
			/>
			<div class="mt-6 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
				<SalePriceCard bom={bom} part={part} values={priceValues} errors={translateErrors(c, price?.errors ?? {})} />
				<SideCard title={t.boms.revisions} icon={icons.history}>
					<ul class="m-0 flex list-none flex-col gap-2 p-0 text-sm">
						{siblings
							.filter((s) => s.code === bom.code)
							.map((s) => (
								<li class="flex items-center justify-between gap-3">
									{s.id === bom.id ? (
										<span class="font-semibold" aria-current="page">
											{s.revision}
										</span>
									) : (
										<a href={`/boms/${s.id}`}>{s.revision}</a>
									)}
									<StatusBadge status={s.status} />
								</li>
							))}
					</ul>
				</SideCard>
				<SideCard title={t.boms.variants} icon={icons.layers}>
					<ul class="m-0 flex list-none flex-col gap-2 p-0 text-sm">
						{siblings
							.filter((s) => s.status === "active")
							.map((s) => (
								<li class="flex items-center justify-between gap-3">
									{s.id === bom.id ? (
										<span class="font-semibold" aria-current="page">
											{s.code}
										</span>
									) : (
										<a href={`/boms/${s.id}`}>{s.code}</a>
									)}
									<span class="text-muted-foreground">{s.revision}</span>
								</li>
							))}
					</ul>
				</SideCard>
				{bom.notes ? (
					<SideCard title={t.common.notes} icon={icons.clipboardList}>
						<p class="text-sm whitespace-pre-wrap">{bom.notes}</p>
					</SideCard>
				) : null}
			</div>
		</>,
		status,
	);
}

bomRoutes.get("/:id", async (c) => {
	const data = await loadBom(c);
	if (!data) return notFound(c);
	return renderEditor(c, data);
});

bomRoutes.post("/:id/lines", async (c) => {
	const data = await loadBom(c);
	if (!data) return notFound(c);
	const db = c.var.db;
	const { bom, part } = data;
	const body = await c.req.parseBody();
	const values = body as FormValues;
	if (bom.status === "archived") return renderEditor(c, data, { values, errors: { component: "bom_archived" } }, 422);
	const v = validate(bomLineInput, body);
	const errors: FieldErrors = v.ok ? {} : { ...v.errors };
	const vars: Record<string, string> = {};
	let componentId: number | undefined;
	if (v.ok) {
		const ref = v.data.component.split(/\s+[—·-]\s+/)[0]?.trim() ?? "";
		const comp = (await db.select().from(parts).where(eq(parts.ref, ref)).limit(1))[0];
		if (!comp) {
			errors.component = "unknown_part";
			vars.ref = ref;
		} else if (comp.archived) errors.component = "archived_part";
		else if (comp.trackSerial && v.data.qty % MILLI !== 0) errors.qty = "serial_whole_qty";
		else if (await wouldCreateCycle(db, part.id, comp.id)) {
			errors.component = "bom_cycle";
			vars.ref = comp.ref;
			vars.parent = part.ref;
		} else componentId = comp.id;
	}
	if (!v.ok || componentId === undefined) return renderEditor(c, data, { values, errors, vars }, 422);
	const user = c.var.user;
	await db.insert(bomLines).values({
		bomId: bom.id,
		componentPartId: componentId,
		qtyMilli: v.data.qty,
		notes: v.data.notes,
		position: sql`(SELECT COALESCE(MAX(position), 0) + 1 FROM bom_lines WHERE bom_id = ${bom.id})`,
		createdBy: user,
		updatedBy: user,
	});
	await touchBom(c, bom.id);
	return c.redirect(`/boms/${bom.id}`, 303);
});

async function touchBom(c: Context<AppEnv>, bomId: number) {
	await c.var.db.update(boms).set({ updatedAt: nowIso(), updatedBy: c.var.user }).where(eq(boms.id, bomId));
}

async function editableLine(c: Context<AppEnv>) {
	const data = await loadBom(c);
	const lineId = idParam(c, "lineId");
	if (!data || !lineId) return undefined;
	const line = (
		await c.var.db
			.select()
			.from(bomLines)
			.where(and(eq(bomLines.id, lineId), eq(bomLines.bomId, data.bom.id)))
			.limit(1)
	)[0];
	return line ? { ...data, line } : undefined;
}

bomRoutes.post("/:id/lines/:lineId", async (c) => {
	const data = await editableLine(c);
	if (!data) return notFound(c);
	if (data.bom.status === "archived") return c.redirect(`/boms/${data.bom.id}?err=bom_archived`, 303);
	const body = await c.req.parseBody();
	const qty = parseMilli(typeof body.qty === "string" ? body.qty : "");
	if (qty === null || qty <= 0) return c.redirect(`/boms/${data.bom.id}?err=invalid_quantity`, 303);
	const comp = (await c.var.db.select().from(parts).where(eq(parts.id, data.line.componentPartId)).limit(1))[0];
	if (comp?.trackSerial && qty % MILLI !== 0) return c.redirect(`/boms/${data.bom.id}?err=serial_whole_qty`, 303);
	await c.var.db
		.update(bomLines)
		.set({ qtyMilli: qty, updatedAt: nowIso(), updatedBy: c.var.user })
		.where(eq(bomLines.id, data.line.id));
	await touchBom(c, data.bom.id);
	return c.redirect(`/boms/${data.bom.id}`, 303);
});

bomRoutes.post("/:id/lines/:lineId/delete", async (c) => {
	const data = await editableLine(c);
	if (!data) return notFound(c);
	if (data.bom.status === "archived") return c.redirect(`/boms/${data.bom.id}?err=bom_archived`, 303);
	await c.var.db.delete(bomLines).where(eq(bomLines.id, data.line.id));
	await touchBom(c, data.bom.id);
	return c.redirect(`/boms/${data.bom.id}`, 303);
});

bomRoutes.post("/:id/lines/:lineId/move", async (c) => {
	const data = await editableLine(c);
	if (!data) return notFound(c);
	if (data.bom.status === "archived") return c.redirect(`/boms/${data.bom.id}?err=bom_archived`, 303);
	const body = await c.req.parseBody();
	const dir = body.dir === "up" ? -1 : 1;
	const lines = await getBomLines(c.var.db, data.bom.id);
	const idx = lines.findIndex((l) => l.id === data.line.id);
	const other = lines[idx + dir];
	if (idx >= 0 && other) {
		// Renumber 1..n with the two lines swapped, in one batch.
		const order = lines.map((l) => l.id);
		[order[idx], order[idx + dir]] = [other.id, data.line.id];
		const now = nowIso();
		await runBatch(
			c.var.db,
			order.map((id, i) =>
				c.var.db
					.update(bomLines)
					.set({ position: i + 1, updatedAt: now, updatedBy: c.var.user })
					.where(eq(bomLines.id, id)),
			),
		);
	}
	return c.redirect(`/boms/${data.bom.id}`, 303);
});

// Variant selling price: empty = use the part's. Logged in the price history (same batch).
bomRoutes.post("/:id/sale-price", async (c) => {
	const data = await loadBom(c);
	if (!data) return notFound(c);
	const { bom } = data;
	if (bom.status === "archived") return c.redirect(`/boms/${bom.id}?err=bom_archived`, 303);
	const body = await c.req.parseBody();
	const v = validate(salePriceInput, body);
	if (!v.ok) return renderEditor(c, data, undefined, 422, { values: body as FormValues, errors: v.errors });
	await runBatch(c.var.db, bomSalePriceStatements(c.var.db, bom, v.data.sale_price, c.var.user, nowIso()));
	return redirectOk(c, `/boms/${bom.id}`);
});

// ---------------------------------------------------------------------------
// Status changes, revisions, delete

bomRoutes.post("/:id/activate", async (c) => {
	const data = await loadBom(c);
	if (!data) return notFound(c);
	const { bom, part } = data;
	if (part.kind !== "make" && part.kind !== "kit") return c.redirect(`/boms/${bom.id}?err=bom_parent_kind`, 303);
	// An archived BoM may predate newer BoMs: re-check cycles before it counts again.
	if (bom.status === "archived") {
		for (const line of await getBomLines(c.var.db, bom.id)) {
			if (await wouldCreateCycle(c.var.db, part.id, line.partId))
				return c.redirect(`/boms/${bom.id}?err=bom_cycle`, 303);
		}
	}
	await runBatch(c.var.db, activateStatements(c.var.db, bom, c.var.user, nowIso()));
	return redirectOk(c, `/boms/${bom.id}`, "activated");
});

bomRoutes.post("/:id/draft", async (c) => {
	const data = await loadBom(c);
	if (!data) return notFound(c);
	const { bom, part } = data;
	if (bom.status === "archived") {
		for (const line of await getBomLines(c.var.db, bom.id)) {
			if (await wouldCreateCycle(c.var.db, part.id, line.partId))
				return c.redirect(`/boms/${bom.id}?err=bom_cycle`, 303);
		}
	}
	await c.var.db
		.update(boms)
		.set({ status: "draft", updatedAt: nowIso(), updatedBy: c.var.user })
		.where(eq(boms.id, bom.id));
	return redirectOk(c, `/boms/${bom.id}`);
});

bomRoutes.post("/:id/archive", requireAdmin, async (c) => {
	const data = await loadBom(c);
	if (!data) return notFound(c);
	await c.var.db
		.update(boms)
		.set({ status: "archived", updatedAt: nowIso(), updatedBy: c.var.user })
		.where(eq(boms.id, data.bom.id));
	return redirectOk(c, `/boms/${data.bom.id}`, "archived");
});

bomRoutes.post("/:id/revision", async (c) => {
	const data = await loadBom(c);
	if (!data) return notFound(c);
	const { bom } = data;
	const db = c.var.db;
	const taken = await db
		.select({ revision: boms.revision })
		.from(boms)
		.where(and(eq(boms.parentPartId, bom.parentPartId), eq(boms.code, bom.code)));
	const revision = nextRevision(
		bom.revision,
		taken.map((r) => r.revision),
	);
	await runBatch(
		db,
		createBomStatements(
			db,
			{ parentPartId: bom.parentPartId, code: bom.code, revision, notes: bom.notes },
			bom.id,
			c.var.user,
			nowIso(),
		),
	);
	const created = await findBom(db, bom.parentPartId, bom.code, revision);
	return redirectOk(c, `/boms/${created?.id}`);
});

bomRoutes.post("/:id/delete", requireAdmin, async (c) => {
	const data = await loadBom(c);
	if (!data) return notFound(c);
	try {
		await c.var.db.delete(boms).where(eq(boms.id, data.bom.id));
	} catch (err) {
		if (isConstraintError(err, "FOREIGN KEY")) return c.redirect(`/boms/${data.bom.id}?err=in_use`, 303);
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
				<span>{t.boms.forQty}</span>
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
					<span>{t.boms.useStock}</span>
				</label>
			) : null}
			<Button variant="outline">{t.boms.update}</Button>
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

function TreeNode(props: { node: ExplodedNode; calc: CostCalculator; refs: Map<number, string> }) {
	const { t } = useApp();
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
					{n.mode === "missing_bom" ? <Badge variant="warning">{t.boms.modes.missing_bom}</Badge> : null}
				</span>
			</span>
			<span class="text-right text-muted-foreground tabular-nums">
				×<Qty milli={n.perParentMilli} unit={n.part.unit} />
			</span>
			<span class="text-right font-semibold tabular-nums">
				<Qty milli={n.qtyMilli} unit={n.part.unit} />
			</span>
			<span class="hidden text-right md:block">
				<CostView cost={cost} refs={props.refs} />
			</span>
			<span class="hidden text-right md:block">
				<Money cents={centsOf(props.calc.extended(n.part.id, n.qtyMilli))} />
			</span>
		</>
	);
	if (!branch) {
		return (
			<li>
				<div class={cn(TREE_ROW, "transition-colors hover:bg-muted/50")}>{cells}</div>
			</li>
		);
	}
	return (
		<li>
			<details open class="group">
				<summary
					class={cn(TREE_ROW, "list-none transition-colors hover:bg-muted/50 [&::-webkit-details-marker]:hidden")}
				>
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

bomRoutes.get("/:id/tree", async (c) => {
	const data = await loadBom(c);
	if (!data) return notFound(c);
	const t = c.var.t;
	const qty = qtyParam(c);
	const graph = await loadGraph(c.var.db);
	const calc = new CostCalculator(graph);
	const refs = new Map([...graph.parts.values()].map((p) => [p.id, p.ref]));
	let explosion: Explosion | null = null;
	let error = "";
	try {
		explosion = explode(graph, data.bom.id, qty);
	} catch (err) {
		error = err instanceof Error ? err.message : String(err);
	}
	const unit = calc.bom(data.bom.id);
	return page(
		c,
		`${data.part.ref} · ${t.boms.tree}`,
		<>
			<BomHeader bom={data.bom} part={data.part} tab="tree" pricing={bomPricing(data.part, data.bom, calc)} />
			<QtyForm action={`/boms/${data.bom.id}/tree`} qty={qty} />
			{error ? <Alert variant="destructive">{error}</Alert> : null}
			<Card class="gap-0 overflow-hidden py-0">
				<div
					class={cn(
						TREE_ROW,
						"min-h-10 bg-muted/50 py-0 text-xs font-medium tracking-wide text-muted-foreground uppercase",
					)}
				>
					<span class="pl-6">{t.boms.component}</span>
					<span class="text-right">{t.boms.perParent}</span>
					<span class="text-right">{t.boms.cumulative}</span>
					<span class="hidden text-right md:block">{t.boms.unitCost}</span>
					<span class="hidden text-right md:block">{t.boms.lineCost}</span>
				</div>
				<ul class="m-0 list-none p-0">
					{explosion?.tree.map((n) => (
						<TreeNode node={n} calc={calc} refs={refs} />
					))}
				</ul>
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
				{unit.incomplete ? (
					<IncompleteNote refs={unit.missing.map((id) => refs.get(id) ?? id).join(", ")} class="border-t px-4 py-3" />
				) : null}
			</Card>
		</>,
	);
});

bomRoutes.get("/:id/diagram", async (c) => {
	const data = await loadBom(c);
	if (!data) return notFound(c);
	const t = c.var.t;
	const qty = qtyParam(c);
	const depthParam = Number(c.req.query("depth"));
	const depth = Number.isInteger(depthParam) && depthParam > 0 ? depthParam : undefined;
	const assembliesOnly = c.req.query("only") === "assemblies";
	const graph = await loadGraph(c.var.db);
	const calc = new CostCalculator(graph);
	const refs = new Map([...graph.parts.values()].map((p) => [p.id, p.ref]));
	let explosion: Explosion | null = null;
	let error = "";
	try {
		explosion = explode(graph, data.bom.id, qty);
	} catch (err) {
		error = err instanceof Error ? err.message : String(err);
	}
	const base = `/boms/${data.bom.id}/diagram`;
	const href = (o: { depth?: number | undefined; assembliesOnly?: boolean }) => {
		const params = new URLSearchParams();
		if (qty !== MILLI) params.set("qty", formatQtyInput(qty, c.var.locale));
		const d = "depth" in o ? o.depth : depth;
		if (d) params.set("depth", String(d));
		if (o.assembliesOnly ?? assembliesOnly) params.set("only", "assemblies");
		const qs = params.toString();
		return qs ? `${base}?${qs}` : base;
	};
	const view: DiagramView = { depth, assembliesOnly, href };
	const rootPart = graph.parts.get(data.part.id);
	const tree = explosion && rootPart ? diagramTree(rootPart, data.bom.id, qty, explosion.tree, calc) : null;
	const fullDepth = tree ? treeDepth(tree) : 0;
	const nodes = explosion ? [...walkTree(explosion.tree)] : [];
	const unit = calc.bom(data.bom.id);
	const title = fmt(t.boms.diagramTitle, { ref: data.part.ref });
	return page(
		c,
		`${data.part.ref} · ${t.boms.diagram}`,
		<>
			<BomHeader bom={data.bom} part={data.part} tab="diagram" pricing={bomPricing(data.part, data.bom, calc)} />
			{error ? <Alert variant="destructive">{error}</Alert> : null}
			{tree ? (
				<>
					<div class="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
						<StatCard label={t.boms.stats.levels} value={fullDepth} icon={icons.listTree} />
						<StatCard
							label={t.boms.stats.components}
							value={new Set(nodes.map((n) => n.part.id)).size}
							icon={icons.package}
						/>
						<StatCard
							label={`${t.boms.stats.assemblies} · ${t.boms.stats.kits}`}
							value={`${new Set(nodes.filter((n) => n.part.kind === "make").map((n) => n.part.id)).size} · ${new Set(nodes.filter((n) => n.part.kind === "kit").map((n) => n.part.id)).size}`}
							icon={icons.boxes}
						/>
						<StatCard
							label={t.boms.totalCost}
							value={<CostView cost={unit} refs={refs} />}
							icon={icons.clipboardList}
							tone={unit.incomplete ? "warning" : "default"}
						/>
					</div>
					<div class="mb-4 flex flex-wrap items-center gap-3">
						<QtyForm
							action={base}
							qty={qty}
							class=""
							hidden={{ depth: depth ? String(depth) : "", only: assembliesOnly ? "assemblies" : "" }}
						/>
						<ToggleLinks
							label={t.boms.levels}
							items={[
								...Array.from({ length: Math.min(fullDepth, 4) }, (_, i) => ({
									href: href({ depth: i + 1 }),
									label: String(i + 1),
									active: depth === i + 1,
									title: `${t.boms.levels}: ${i + 1}`,
								})),
								{
									href: href({ depth: undefined }),
									label: t.boms.allLevels,
									active: depth === undefined,
									title: undefined,
								},
							]}
						/>
						<ToggleLinks
							label={t.boms.show}
							items={[
								{ href: href({ assembliesOnly: false }), label: t.boms.showAll, active: !assembliesOnly },
								{ href: href({ assembliesOnly: true }), label: t.boms.showAssemblies, active: assembliesOnly },
							]}
						/>
					</div>
					<BomDiagram tree={tree} view={view} title={title} />
				</>
			) : null}
		</>,
	);
});

bomRoutes.get("/:id/explode", async (c) => {
	const data = await loadBom(c);
	if (!data) return notFound(c);
	const t = c.var.t;
	const qty = qtyParam(c);
	const useStock = c.req.query("stock") === "on";
	const [graph, stock] = await Promise.all([loadGraph(c.var.db), onHandMap(c.var.db)]);
	const calc = new CostCalculator(graph);
	const refs = new Map([...graph.parts.values()].map((p) => [p.id, p.ref]));
	const ex = explode(graph, data.bom.id, qty, useStock ? { stock } : {});
	const rows = ex.requirements.map((r) => {
		const onHand = stock.get(r.part.id) ?? 0;
		return { ...r, onHand, short: Math.max(0, r.qtyMilli - Math.max(0, onHand)), cost: calc.part(r.part.id) };
	});
	if (c.req.query("format") === "csv") {
		const locale = c.var.locale;
		return csvResponse(c, `${data.part.ref}-${data.bom.code}-${data.bom.revision}-x${formatQtyInput(qty)}.csv`, [
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
		]);
	}
	const totalMillicents = [...ex.requirements, ...ex.fees].reduce(
		(s, r) => s + calc.extended(r.part.id, r.qtyMilli),
		0,
	);
	const total = calc.bom(data.bom.id);
	const query = `qty=${encodeURIComponent(formatQtyInput(qty))}${useStock ? "&stock=on" : ""}`;
	return page(
		c,
		`${data.part.ref} · ${t.boms.explode}`,
		<>
			<BomHeader bom={data.bom} part={data.part} tab="explode" pricing={bomPricing(data.part, data.bom, calc)} />
			<div class="mb-4 flex flex-wrap items-center justify-between gap-3">
				<QtyForm action={`/boms/${data.bom.id}/explode`} qty={qty} stock={useStock} showStock class="" />
				<Button href={`/boms/${data.bom.id}/explode?${query}&format=csv`} variant="outline" icon={icons.download}>
					{t.boms.downloadCsv}
				</Button>
			</div>
			{rows
				.filter((r) => r.missingBom)
				.map((r) => (
					<Alert variant="warning">{fmt(t.boms.missingBom, { ref: r.part.ref })}</Alert>
				))}
			<Card class="gap-0 overflow-hidden py-0">
				<Table>
					<TableHeader class="bg-muted/50">
						<TableRow>
							<TableHead>{t.parts.ref}</TableHead>
							<TableHead>{t.parts.name}</TableHead>
							<TableHead>{t.parts.kind}</TableHead>
							<TableHead class="text-right">{t.boms.qty}</TableHead>
							<TableHead class="text-right">{t.boms.onHand}</TableHead>
							<TableHead class="text-right">{t.boms.short}</TableHead>
							<TableHead class="text-right">{t.boms.unitCost}</TableHead>
							<TableHead class="text-right">{t.boms.lineCost}</TableHead>
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
											{t.boms.fromStock}
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
								<TableCell class="text-right">
									<CostView cost={r.cost} refs={refs} />
								</TableCell>
								<TableCell class="text-right">
									<Money cents={centsOf(calc.extended(r.part.id, r.qtyMilli))} />
								</TableCell>
							</TableRow>
						))}
					</TableBody>
					{ex.fees.length ? (
						<TableBody class="border-t">
							<TableRow class="bg-muted/30 hover:bg-muted/30">
								<TableHead colspan={8} scope="rowgroup">
									{t.boms.fees}
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
									<TableCell class="text-right">
										<CostView cost={calc.part(f.part.id)} refs={refs} />
									</TableCell>
									<TableCell class="text-right">
										<Money cents={centsOf(calc.extended(f.part.id, f.qtyMilli))} />
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					) : null}
					<TableFooter>
						<TableRow class="hover:bg-transparent">
							<TableCell colspan={7}>{t.common.total}</TableCell>
							<TableCell class="text-right font-semibold">
								<Money cents={centsOf(totalMillicents)} />
								{total.incomplete ? <span class="font-medium text-warning"> *</span> : null}
							</TableCell>
						</TableRow>
					</TableFooter>
				</Table>
				{total.incomplete ? (
					<IncompleteNote refs={total.missing.map((id) => refs.get(id) ?? id).join(", ")} class="border-t px-4 py-3" />
				) : null}
			</Card>
		</>,
	);
});
