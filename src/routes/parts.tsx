import { asc, desc, eq } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { PART_KINDS, type Part, type PartKind, parts, stockMoves, suppliers } from "../db/schema";
import { type Cost, centsOf } from "../domain/bom-graph";
import { partBomSummary, type WhereUsedRow, whereUsed } from "../domain/boms";
import { listBuilds } from "../domain/builds";
import { type AverageCost, averageUnitCents } from "../domain/costing";
import { imagesBucket, imageUrl } from "../domain/images";
import { marginOf } from "../domain/margins";
import {
	deleteOfferStatements,
	getOffer,
	offerInput,
	offerTerms,
	offerToForm,
	type PartOffer,
	partOffers,
	poUnitPrice,
	saveOfferStatements,
	setPreferredStatement,
} from "../domain/offers";
import {
	findRefClash,
	getPart,
	hasBoms,
	hasStockMoves,
	listParts,
	onHandOf,
	partInput,
	partRuleErrors,
	partToForm,
	savePartStatements,
	setStandardCostStatements,
} from "../domain/parts";
import { can } from "../domain/permissions";
import { lastPaidBySupplier, paidPrices, partPriceHistory } from "../domain/prices";
import { averageCosts } from "../domain/stock";
import { getSupplier } from "../domain/suppliers";
import { errorText, fmt } from "../i18n";
import { cn } from "../lib/cn";
import { runBatch, type Statement } from "../lib/db";
import { isConstraintError } from "../lib/sql";
import { formatMoney, formatPercent, lineCostCents } from "../lib/units";
import { type FieldErrors, validate } from "../lib/validation";
import { requirePermission } from "../middleware/roles";
import type { AppEnv } from "../types";
import { CostView, StatusBadge } from "../views/bom";
import { StepChart } from "../views/chart";
import { useApp } from "../views/context";
import { Icon, type IconNode, icons } from "../views/icons";
import { idParam, notFound, nowIso, page, redirectOk, translateErrors } from "../views/render";
import {
	Alert,
	Badge,
	Button,
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardEmpty,
	CardFooter,
	CardHeader,
	CardTitle,
	CheckboxField,
	DecimalField,
	DetailList,
	EmptyState,
	ErrorBanner,
	FieldDescription,
	FieldGroup,
	FieldSet,
	Flash,
	type FormErrors,
	type FormValues,
	KindBadge,
	Money,
	PageHeader,
	PostButton,
	Qty,
	SearchBar,
	SelectField,
	Separator,
	StatCard,
	shortDateTime,
	Table,
	TableBody,
	TableCard,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
	TextArea,
	TextField,
} from "../views/ui";

import { BuildsTable } from "./builds";
import { MoveReference } from "./stock";

export const partRoutes = new Hono<AppEnv>();

type PartRow = Awaited<ReturnType<typeof listParts>>[number];
type SupplierOption = { id: number; name: string };
type HistoryRow = Awaited<ReturnType<typeof partPriceHistory>>[number];
type PaidRow = Awaited<ReturnType<typeof paidPrices>>[number];
type LastPaid = Awaited<ReturnType<typeof lastPaidBySupplier>>;

/** Only stocked parts (buy, make) are purchased, so only they have supplier offers. */
const isStocked = (kind: PartKind) => kind === "buy" || kind === "make";

async function supplierOptions(c: Context<AppEnv>): Promise<SupplierOption[]> {
	return c.var.db.select({ id: suppliers.id, name: suppliers.name }).from(suppliers).orderBy(asc(suppliers.name));
}

function PartsTable(props: { rows: PartRow[]; filtered: boolean; images: boolean }) {
	const view = useApp();
	const { t, seeCosts } = view;
	// A thumbnail column only when images are set up and some listed part has one.
	const thumbs = props.images && props.rows.some((p) => p.imageKey);
	if (props.rows.length === 0) {
		return (
			<EmptyState
				icon={icons.package}
				title={t.parts.empty}
				description={props.filtered ? t.parts.emptyFiltered : t.parts.emptyHint}
			>
				{props.filtered || !can(view, "parts.edit") ? null : (
					<Button href="/parts/new" icon={icons.plus}>
						{t.parts.new}
					</Button>
				)}
			</EmptyState>
		);
	}
	return (
		<Card class="py-0">
			<Table>
				<TableHeader>
					<TableRow>
						{thumbs ? (
							<TableHead class="w-0">
								<span class="sr-only">{t.parts.image}</span>
							</TableHead>
						) : null}
						<TableHead>{t.parts.ref}</TableHead>
						<TableHead>{t.parts.name}</TableHead>
						<TableHead>{t.parts.kind}</TableHead>
						<TableHead>{t.parts.supplier}</TableHead>
						{seeCosts ? <TableHead class="text-right">{t.parts.cost}</TableHead> : null}
						<TableHead class="text-right">{t.parts.onHand}</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{props.rows.map((p) => (
						<TableRow class={cn(p.archived && "opacity-60")}>
							{thumbs ? (
								<TableCell class="py-1.5">
									{p.imageKey ? (
										<img
											src={imageUrl(p) ?? ""}
											alt=""
											loading="lazy"
											class="size-9 max-w-none rounded-md border bg-muted object-cover"
										/>
									) : null}
								</TableCell>
							) : null}
							<TableCell class="font-medium whitespace-nowrap">
								<a href={`/parts/${p.id}`}>{p.ref}</a>
							</TableCell>
							<TableCell>
								<span class="inline-flex flex-wrap items-center gap-1.5">
									{p.name}
									{p.trackSerial ? (
										<Badge variant="outline" title={t.parts.trackSerial}>
											{t.parts.serialTag}
										</Badge>
									) : null}
									{p.archived ? <Badge variant="muted">{t.common.archivedLabel}</Badge> : null}
								</span>
							</TableCell>
							<TableCell>
								<KindBadge kind={p.kind} />
							</TableCell>
							<TableCell class="text-muted-foreground">{p.supplierName ?? ""}</TableCell>
							{seeCosts ? (
								<TableCell class="text-right">
									<Money cents={p.costCents} />
								</TableCell>
							) : null}
							<TableCell class="text-right">
								{p.kind === "buy" || p.kind === "make" ? <Qty milli={p.onHandMilli} unit={p.unit} /> : null}
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</Card>
	);
}

function PartForm(props: {
	action: string;
	values: FormValues;
	errors: FormErrors;
	suppliers: SupplierOption[];
	submit: string;
	cancel: string;
}) {
	const { t } = useApp();
	const p = { values: props.values, errors: props.errors };
	return (
		<>
			<ErrorBanner show={Object.keys(props.errors).length > 0} />
			<Card>
				<CardContent>
					<form method="post" action={props.action} class="flex flex-col gap-6">
						<FieldGroup>
							<div class="grid gap-4 md:grid-cols-2">
								<TextField name="ref" label={t.parts.ref} required autofocus {...p} />
								<SelectField
									name="kind"
									label={t.parts.kind}
									required
									options={PART_KINDS.map((k) => ({ value: k, label: `${t.kinds[k]} (${k}): ${t.kindHelp[k]}` }))}
									{...p}
								/>
							</div>
							<TextField name="name" label={t.parts.name} required {...p} />
							<div class="grid gap-4 md:grid-cols-3">
								<TextField name="unit" label={t.parts.unit} placeholder="pcs" list="units" {...p} />
								<DecimalField name="cost" label={t.parts.cost} hint={t.parts.costHint} {...p} />
								<DecimalField name="sale_price" label={t.parts.salePrice} hint={t.parts.salePriceHint} {...p} />
							</div>
							<CheckboxField name="track_serial" label={t.parts.trackSerial} {...p} />
						</FieldGroup>
						<datalist id="units">
							{["pcs", "m", "kg", "g", "l", "m2", "set"].map((u) => (
								<option value={u} />
							))}
						</datalist>
						<Separator />
						<FieldSet legend={t.parts.purchasing}>
							<FieldDescription>{t.parts.preferredHint}</FieldDescription>
							<FieldGroup>
								<div class="grid gap-4 md:grid-cols-2">
									<SelectField
										name="supplier_id"
										label={t.parts.supplier}
										options={[
											{ value: "", label: t.parts.noSupplier },
											...props.suppliers.map((s) => ({ value: String(s.id), label: s.name })),
										]}
										{...p}
									/>
									<TextField name="supplier_ref" label={t.parts.supplierRef} {...p} />
								</div>
								<div class="grid gap-4 md:grid-cols-3">
									<DecimalField name="moq" label={t.parts.moq} {...p} />
									<DecimalField name="pack_size" label={t.parts.packSize} {...p} />
									<TextField name="lead_days" label={t.parts.leadDays} inputmode="numeric" {...p} />
								</div>
							</FieldGroup>
						</FieldSet>
						<Separator />
						<TextArea name="notes" label={t.common.notes} {...p} />
						<div class="flex flex-wrap items-center gap-2">
							<Button>{props.submit}</Button>
							<Button variant="outline" href={props.cancel}>
								{t.common.cancel}
							</Button>
						</div>
					</form>
				</CardContent>
			</Card>
		</>
	);
}

/** Validates a part form, including uniqueness and kind/serial rules. */
async function validatePart(c: Context<AppEnv>, body: Record<string, unknown>, existing?: Part) {
	const result = validate(partInput, body);
	if (!result.ok) return { ok: false as const, errors: result.errors };
	const d = result.data;
	const errors: FieldErrors = {};
	const clash = await findRefClash(c.var.db, d.ref, existing?.id);
	if (clash) {
		if (clash.ref === d.ref) errors.ref = "duplicate_ref";
		else errors.ref = "ref_case";
	}
	const hasMoves = existing ? await hasStockMoves(c.var.db, existing.id) : false;
	const ownsBoms = existing ? await hasBoms(c.var.db, existing.id) : false;
	Object.assign(errors, partRuleErrors({ kind: d.kind, trackSerial: d.track_serial }, { hasMoves, hasBoms: ownsBoms }));
	if (Object.keys(errors).length > 0) return { ok: false as const, errors, clashRef: clash?.ref };
	return { ok: true as const, data: d };
}

partRoutes.get("/", async (c) => {
	const t = c.var.t;
	const q = c.req.query("q") ?? "";
	const kind = c.req.query("kind") ?? "";
	const supplierParam = c.req.query("supplier") ?? "";
	const supplierId = /^\d+$/.test(supplierParam) ? Number(supplierParam) : null;
	const archived = c.req.query("archived") === "on";
	const [rows, sups] = await Promise.all([listParts(c.var.db, { q, kind, supplierId, archived }), supplierOptions(c)]);
	return page(
		c,
		t.parts.title,
		<>
			<PageHeader
				title={t.parts.title}
				actions={
					can(c.var, "parts.edit") ? (
						<Button href="/parts/new" icon={icons.plus}>
							{t.parts.new}
						</Button>
					) : undefined
				}
			/>
			<Flash ok={c.req.query("ok")} />
			<SearchBar action="/parts" q={q}>
				<select name="kind" aria-label={t.parts.kind}>
					<option value="">
						{t.parts.kind}: {t.common.all}
					</option>
					{PART_KINDS.map((k) => (
						<option value={k} selected={k === kind}>
							{t.kinds[k]}
						</option>
					))}
				</select>
				<select name="supplier" aria-label={t.parts.supplier}>
					<option value="">
						{t.parts.supplier}: {t.common.all}
					</option>
					{sups.map((s) => (
						<option value={String(s.id)} selected={s.id === supplierId}>
							{s.name}
						</option>
					))}
				</select>
				<label class="flex min-h-(--control-h) cursor-pointer items-center gap-2 text-sm font-medium whitespace-nowrap">
					<input type="checkbox" data-slot="checkbox" name="archived" value="on" checked={archived} />
					<span>{t.parts.showArchived}</span>
				</label>
			</SearchBar>
			<div id="results">
				{rows.length > 0 ? (
					<p class="mb-2 text-sm text-muted-foreground">{fmt(t.common.results, { n: rows.length })}</p>
				) : null}
				<PartsTable
					rows={rows}
					filtered={q !== "" || kind !== "" || supplierId !== null}
					images={imagesBucket(c.env) !== null}
				/>
			</div>
		</>,
	);
});

partRoutes.get("/new", requirePermission("parts.edit"), async (c) => {
	const t = c.var.t;
	return page(
		c,
		t.parts.new,
		<>
			<PageHeader title={t.parts.new} />
			<PartForm
				action="/parts"
				values={{ kind: "buy", unit: "pcs" }}
				errors={{}}
				suppliers={await supplierOptions(c)}
				submit={t.common.create}
				cancel="/parts"
			/>
		</>,
	);
});

partRoutes.post("/", requirePermission("parts.edit"), async (c) => {
	const t = c.var.t;
	const body = await c.req.parseBody();
	const v = await validatePart(c, body);
	if (!v.ok) {
		return page(
			c,
			t.parts.new,
			<>
				<PageHeader title={t.parts.new} />
				<PartForm
					action="/parts"
					values={body as FormValues}
					errors={translateErrors(c, v.errors, { ref: v.clashRef ?? "" })}
					suppliers={await supplierOptions(c)}
					submit={t.common.create}
					cancel="/parts"
				/>
			</>,
			422,
		);
	}
	await runBatch(c.var.db, savePartStatements(c.var.db, v.data, undefined, "form", c.var.user, nowIso()));
	const [row] = await c.var.db.select({ id: parts.id }).from(parts).where(eq(parts.ref, v.data.ref));
	return redirectOk(c, `/parts/${row?.id}`);
});

function PartDetail(props: {
	part: Part;
	supplier: { id: number; name: string; email: string; phone: string } | undefined;
	offers: PartOffer[];
	lastPaid: LastPaid;
	average: AverageCost | undefined;
	history: HistoryRow[];
	paid: PaidRow[];
	today: string;
	onHand: number;
	moves: (typeof stockMoves.$inferSelect)[];
	bomSummary: Awaited<ReturnType<typeof partBomSummary>>;
	usedIn: WhereUsedRow[];
	builds: Awaited<ReturnType<typeof listBuilds>>;
	imagesEnabled: boolean;
	ok?: string | undefined;
	err?: string | undefined;
}) {
	const view = useApp();
	const { t, seeCosts } = view;
	const canEdit = can(view, "parts.edit");
	const canDelete = can(view, "parts.delete");
	const p = props.part;
	const stocked = isStocked(p.kind);
	const { rollup, refs } = props.bomSummary;
	return (
		<>
			<PageHeader
				title={`${p.ref} · ${p.name}`}
				subtitle={
					<span class="inline-flex flex-wrap items-center gap-2">
						<KindBadge kind={p.kind} />
						<span>{t.kindHelp[p.kind]}</span>
						{p.archived ? <Badge variant="muted">{t.common.archivedLabel}</Badge> : null}
					</span>
				}
				actions={
					<>
						{canEdit ? (
							<Button href={`/parts/${p.id}/edit`} variant="outline" icon={icons.pencil}>
								{t.common.edit}
							</Button>
						) : null}
						{stocked && can(view, "stock.adjust") ? (
							<Button href={`/stock/adjust?part=${p.id}`} variant="outline" icon={icons.arrowUpDown}>
								{t.parts.adjustStock}
							</Button>
						) : null}
						{canDelete ? (
							p.archived ? (
								<PostButton
									action={`/parts/${p.id}/unarchive`}
									label={t.common.unarchive}
									icon={icons.archiveRestore}
								/>
							) : (
								<PostButton
									action={`/parts/${p.id}/archive`}
									label={t.common.archive}
									confirm={t.common.confirmArchive}
									icon={icons.archive}
								/>
							)
						) : null}
						{canDelete ? (
							<PostButton
								action={`/parts/${p.id}/delete`}
								label={t.common.delete}
								confirm={t.common.confirmDelete}
								variant="destructive"
								icon={icons.trash}
							/>
						) : null}
					</>
				}
			/>
			<Flash ok={props.ok} message={props.ok === "adjusted" ? t.stock.adjusted : undefined} />
			{props.err && PART_ERRORS.has(props.err) ? <Alert variant="destructive">{errorText(t, props.err)}</Alert> : null}
			<div class="flex flex-col gap-4">
				<div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
					{stocked ? (
						<StatCard
							label={t.parts.onHand}
							value={<Qty milli={props.onHand} unit={p.unit} />}
							icon={icons.warehouse}
							tone={props.onHand < 0 ? "destructive" : "default"}
							hint={
								seeCosts && p.costCents !== null ? (
									<>
										{t.parts.stockValue}: <Money cents={lineCostCents(props.onHand, p.costCents)} />
									</>
								) : undefined
							}
						/>
					) : null}
					{seeCosts ? (
						<StatCard
							label={t.parts.cost}
							value={<Money cents={p.costCents} />}
							icon={icons.coins}
							tone={p.costCents === null && !rollup ? "warning" : "default"}
						/>
					) : null}
					{seeCosts && rollup ? (
						<StatCard
							label={t.parts.rollupCost}
							value={<CostView cost={rollup} refs={refs} />}
							icon={icons.listTree}
							tone={rollup.incomplete ? "warning" : "default"}
						/>
					) : null}
				</div>
				<div class="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
					{props.imagesEnabled || p.imageKey ? (
						<ImageCard part={p} enabled={props.imagesEnabled} />
					) : canEdit ? (
						<Card>
							<CardHeader>
								<CardTitle icon={icons.image}>{t.parts.image}</CardTitle>
								<CardDescription>{t.parts.imagesDisabled}</CardDescription>
							</CardHeader>
						</Card>
					) : null}
					<Card>
						<CardHeader>
							<CardTitle>{t.parts.info}</CardTitle>
						</CardHeader>
						<CardContent>
							<DetailList
								items={[
									{ label: t.parts.unit, value: p.unit },
									{ label: t.parts.trackSerial, value: p.trackSerial ? t.common.yes : t.common.no },
									...(stocked || props.supplier
										? [
												{
													label: t.parts.preferredSupplier,
													value: props.supplier ? (
														<a href={`/suppliers/${props.supplier.id}`}>{props.supplier.name}</a>
													) : (
														t.common.none
													),
												},
											]
										: []),
									...(props.supplier?.email
										? [
												{
													label: t.suppliers.email,
													value: <a href={`mailto:${props.supplier.email}`}>{props.supplier.email}</a>,
												},
											]
										: []),
									...(props.supplier?.phone ? [{ label: t.suppliers.phone, value: props.supplier.phone }] : []),
									...(p.notes
										? [{ label: t.common.notes, value: <span class="whitespace-pre-wrap">{p.notes}</span> }]
										: []),
								]}
							/>
						</CardContent>
					</Card>
					{seeCosts ? (
						<PricesCard
							part={p}
							rollup={rollup}
							refs={refs}
							average={props.average}
							preferredOffer={props.offers.find((o) => o.preferred)}
						/>
					) : null}
				</div>
				{stocked || props.offers.length > 0 ? (
					<OffersCard part={p} offers={props.offers} lastPaid={props.lastPaid} />
				) : null}
				{p.kind === "make" || p.kind === "kit" ? <PartBoms part={p} summary={props.bomSummary} /> : null}
				{p.kind === "make" ? (
					<Card>
						<CardHeader>
							<CardTitle>{t.builds.recent}</CardTitle>
							{can(view, "builds.plan") ? (
								<CardAction>
									<Button href={`/builds/new?part=${p.id}`} variant="outline" size="sm" icon={icons.plus}>
										{t.builds.new}
									</Button>
								</CardAction>
							) : null}
						</CardHeader>
						<CardContent class="px-2">
							<BuildsTable rows={props.builds} />
						</CardContent>
					</Card>
				) : null}
				<WhereUsed rows={props.usedIn} />
				{seeCosts ? <PriceHistoryCard part={p} history={props.history} paid={props.paid} today={props.today} /> : null}
				{stocked ? (
					<Card>
						<CardHeader>
							<CardTitle>{t.parts.history}</CardTitle>
						</CardHeader>
						<CardContent class="px-2">
							<MovesTable moves={props.moves} unit={p.unit} />
						</CardContent>
					</Card>
				) : null}
				<p class="text-xs text-muted-foreground">
					{fmt(t.common.createdBy, { by: p.createdBy, at: shortDateTime(p.createdAt) })} ·{" "}
					{fmt(t.common.updatedBy, { by: p.updatedBy, at: shortDateTime(p.updatedAt) })}
				</p>
			</div>
		</>
	);
}

/** Error keys a redirect may show on the part page (?err=…). */
const PART_ERRORS = new Set(["in_use", "image_missing", "image_too_large", "image_type", "images_disabled"]);

/** The product image (D100): shown, uploaded (resized in the browser when JavaScript runs), removed by admins. */
function ImageCard(props: { part: Part; enabled: boolean }) {
	const view = useApp();
	const { t } = view;
	const p = props.part;
	const src = imageUrl(p);
	return (
		<Card id="image">
			<CardHeader>
				<CardTitle icon={icons.image}>{t.parts.image}</CardTitle>
				{can(view, "parts.delete") && src && props.enabled ? (
					<CardAction>
						<PostButton
							action={`/parts/${p.id}/image/delete`}
							label={t.parts.removeImage}
							confirm={t.parts.confirmRemoveImage}
							variant="ghost"
							size="sm"
							icon={icons.trash}
						/>
					</CardAction>
				) : null}
			</CardHeader>
			<CardContent class="flex flex-col gap-4">
				{src ? (
					<a href={src} class="block overflow-hidden rounded-lg border bg-muted" title={t.parts.openImage}>
						<img src={src} alt={p.name} class="aspect-4/3 max-h-80 w-full object-contain" />
					</a>
				) : (
					<div class="flex aspect-4/3 max-h-80 w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed bg-muted/40 text-sm text-muted-foreground">
						<Icon icon={icons.imageOff} class="size-8" />
						{t.parts.noImage}
					</div>
				)}
				{!can(view, "parts.edit") ? null : props.enabled ? (
					<form
						method="post"
						action={`/parts/${p.id}/image`}
						enctype="multipart/form-data"
						class="flex flex-col gap-2"
						data-image-form=""
					>
						<label for="image-file" class="text-sm font-medium">
							{t.parts.imageFile}
						</label>
						<div class="flex flex-wrap items-center gap-2">
							<input
								id="image-file"
								type="file"
								name="image"
								accept="image/jpeg,image/png,image/webp"
								required
								data-image-input=""
								class="flex-1"
							/>
							<Button variant="outline" icon={icons.imageUp}>
								{src ? t.parts.replaceImage : t.parts.uploadImage}
							</Button>
						</div>
						<p class="text-xs text-muted-foreground">{t.parts.imageHint}</p>
					</form>
				) : (
					<p class="text-xs text-muted-foreground">{t.parts.imagesDisabled}</p>
				)}
			</CardContent>
		</Card>
	);
}

/**
 * Standard cost, weighted average, selling price and planned margin (D93: on the BoM roll-up for a part
 * with a BoM, else on the standard cost), with shortcuts that copy a known price into the standard cost.
 */
function PricesCard(props: {
	part: Part;
	rollup: Cost | null;
	refs: Map<number, string>;
	average: AverageCost | undefined;
	preferredOffer: PartOffer | undefined;
}) {
	const { t, locale } = useApp();
	const p = props.part;
	const stocked = isStocked(p.kind);
	const averageCents = props.average ? averageUnitCents(props.average) : null;
	const averageIncomplete = props.average?.incomplete ?? false;
	const plannedCents = props.rollup ? centsOf(props.rollup.millicents) : p.costCents;
	const margin = marginOf(p.salePriceCents, plannedCents);
	const offerCents = props.preferredOffer?.priceCents ?? null;
	const canUseAverage = stocked && averageCents !== null && !averageIncomplete && averageCents !== p.costCents;
	const canUseOffer = stocked && offerCents !== null && offerCents !== p.costCents;
	const items = [
		{ label: t.parts.cost, value: <Money cents={p.costCents} /> },
		...(props.rollup || p.salePriceCents !== null
			? [
					{
						label: t.parts.plannedCost,
						value: (
							<span class="inline-flex flex-wrap items-baseline gap-x-2">
								{props.rollup ? <CostView cost={props.rollup} refs={props.refs} /> : <Money cents={p.costCents} />}
								<span class="text-xs text-muted-foreground">
									{props.rollup ? t.parts.fromBom : t.parts.fromStandard}
								</span>
							</span>
						),
					},
				]
			: []),
		...(stocked
			? [
					{
						label: t.parts.averageCost,
						value:
							averageCents === null ? (
								<span class="text-muted-foreground">{t.common.none}</span>
							) : (
								<span class="flex flex-col items-start gap-0.5">
									<Money cents={averageCents} />
									{averageIncomplete ? (
										<span class="text-xs font-medium text-warning">{t.parts.averageIncomplete}</span>
									) : null}
								</span>
							),
					},
				]
			: []),
		{
			label: t.parts.salePrice,
			value:
				p.salePriceCents === null ? (
					<span class="text-muted-foreground">{t.common.none}</span>
				) : (
					<Money cents={p.salePriceCents} />
				),
		},
		...(p.salePriceCents !== null
			? [
					{
						label: t.parts.plannedMargin,
						value: margin ? (
							<span class="flex flex-col items-start gap-0.5">
								<span class="inline-flex flex-wrap items-baseline gap-x-2">
									<span class={cn("font-medium", margin.marginCents < 0 && "text-destructive")}>
										<Money cents={margin.marginCents} />
									</span>
									<a href={`/margins/parts/${p.id}`} class="inline-flex items-center gap-1 text-xs font-medium">
										<Icon icon={icons.chartLine} class="size-3.5" />
										{t.margins.history}
									</a>
								</span>
								<span class="text-xs text-muted-foreground tabular-nums">
									{margin.rateBp === null
										? null
										: fmt(t.parts.marginRate, { rate: formatPercent(margin.rateBp, locale) })}
									{margin.rateBp !== null && margin.markupBp !== null ? " · " : null}
									{margin.markupBp === null
										? null
										: fmt(t.parts.markup, { rate: formatPercent(margin.markupBp, locale) })}
								</span>
							</span>
						) : (
							<span class="text-muted-foreground">{t.parts.marginUnknown}</span>
						),
					},
				]
			: []),
	];
	return (
		<Card>
			<CardHeader>
				<CardTitle icon={icons.circleDollarSign}>{t.parts.prices}</CardTitle>
			</CardHeader>
			<CardContent>
				<DetailList items={items} />
			</CardContent>
			{canUseAverage || canUseOffer ? (
				<CardFooter class="flex-wrap border-t">
					{canUseAverage ? (
						<CostShortcut action={`/parts/${p.id}/cost/average`} label={t.parts.useAverage} icon={icons.scale} />
					) : null}
					{canUseOffer ? (
						<CostShortcut action={`/parts/${p.id}/cost/offer`} label={t.parts.useOfferPrice} icon={icons.tag} />
					) : null}
				</CardFooter>
			) : null}
		</Card>
	);
}

/** A small POST button whose (long, translated) label may wrap inside a narrow card. */
function CostShortcut(props: { action: string; label: string; icon: IconNode }) {
	return (
		<form method="post" action={props.action} class="max-w-full">
			<Button
				variant="outline"
				size="sm"
				icon={props.icon}
				class="h-auto min-h-(--control-h-sm) max-w-full py-1.5 text-left whitespace-normal"
			>
				{props.label}
			</Button>
		</form>
	);
}

/** The part's supplier offers: terms, the price a PO would use, and the last price paid to each supplier. */
function OffersCard(props: { part: Part; offers: PartOffer[]; lastPaid: LastPaid }) {
	const view = useApp();
	const { t, seeCosts } = view;
	const p = props.part;
	const stocked = isStocked(p.kind);
	// Offers stay visible without costs (who supplies it, MOQ, lead time); editing them is a price change.
	const canEdit = stocked && can(view, "prices.edit");
	return (
		<TableCard
			id="suppliers"
			title={
				<span class="flex items-center gap-2">
					{t.parts.suppliers}
					{props.offers.length > 0 ? <Badge variant="secondary">{props.offers.length}</Badge> : null}
				</span>
			}
			action={
				canEdit ? (
					<Button href={`/parts/${p.id}/offers/new`} variant="outline" size="sm" icon={icons.plus}>
						{t.parts.addSupplier}
					</Button>
				) : null
			}
		>
			{props.offers.length === 0 ? (
				<CardEmpty icon={icons.truck}>{t.parts.noOffers}</CardEmpty>
			) : (
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>{t.parts.supplier}</TableHead>
							{seeCosts ? <TableHead class="text-right">{t.parts.offerPrice}</TableHead> : null}
							<TableHead class="text-right">{t.parts.moq}</TableHead>
							<TableHead class="text-right">{t.parts.packSize}</TableHead>
							<TableHead class="text-right">{t.parts.leadTime}</TableHead>
							{seeCosts ? <TableHead class="text-right">{t.parts.lastPaid}</TableHead> : null}
							<TableHead class="w-px">
								<span class="sr-only">{t.common.actions}</span>
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{props.offers.map((o) => {
							const last = props.lastPaid.get(o.supplierId);
							return (
								<TableRow>
									<TableCell>
										<span class="flex flex-col items-start gap-1">
											<span class="inline-flex flex-wrap items-center gap-1.5">
												<a href={`/suppliers/${o.supplierId}`} class="font-medium">
													{o.supplierName}
												</a>
												{o.preferred ? (
													<Badge variant="secondary">
														<Icon icon={icons.check} />
														{t.parts.preferred}
													</Badge>
												) : null}
											</span>
											{o.supplierRef ? <span class="text-xs text-muted-foreground">{o.supplierRef}</span> : null}
										</span>
									</TableCell>
									{seeCosts ? (
										<TableCell class="text-right whitespace-nowrap">
											{o.priceCents === null && p.costCents !== null ? (
												<span class="flex flex-col items-end gap-0.5">
													<Money cents={poUnitPrice(o.priceCents, p.costCents)} />
													<span class="text-xs text-muted-foreground">{t.parts.standardCostUsed}</span>
												</span>
											) : (
												<Money cents={o.priceCents} />
											)}
										</TableCell>
									) : null}
									<TableCell class="text-right">
										{o.moqMilli ? <Qty milli={o.moqMilli} unit={p.unit} /> : t.common.none}
									</TableCell>
									<TableCell class="text-right">
										{o.packSizeMilli ? <Qty milli={o.packSizeMilli} unit={p.unit} /> : t.common.none}
									</TableCell>
									<TableCell class="text-right whitespace-nowrap tabular-nums">
										{o.leadDays ? fmt(t.parts.leadDaysValue, { n: o.leadDays }) : t.common.none}
									</TableCell>
									{seeCosts ? (
										<TableCell class="text-right whitespace-nowrap">
											{last ? (
												<span class="flex flex-col items-end gap-0.5">
													<Money cents={last.unitCostCents} />
													<span class="text-xs text-muted-foreground tabular-nums">{last.at.slice(0, 10)}</span>
												</span>
											) : (
												<span class="text-muted-foreground">{t.common.none}</span>
											)}
										</TableCell>
									) : null}
									<TableCell class="py-1 text-right">
										<div class="flex items-center justify-end gap-1">
											{canEdit && !o.preferred ? (
												<form method="post" action={`/parts/${p.id}/offers/${o.supplierId}/prefer`} class="inline">
													<Button
														variant="ghost"
														size="icon-sm"
														icon={icons.circleCheck}
														aria-label={`${t.parts.makePreferred}: ${o.supplierName}`}
														title={t.parts.makePreferred}
													/>
												</form>
											) : null}
											{canEdit ? (
												<Button
													href={`/parts/${p.id}/offers/${o.supplierId}`}
													variant="ghost"
													size="icon-sm"
													icon={icons.pencil}
													aria-label={`${t.parts.editOffer}: ${o.supplierName}`}
													title={t.parts.editOffer}
												/>
											) : null}
											{can(view, "parts.delete") ? (
												<form
													method="post"
													action={`/parts/${p.id}/offers/${o.supplierId}/delete`}
													class="inline"
													data-confirm={t.parts.confirmRemoveOffer}
												>
													<Button
														variant="ghost"
														size="icon-sm"
														icon={icons.trash}
														aria-label={`${t.parts.removeOffer}: ${o.supplierName}`}
														title={t.parts.removeOffer}
													/>
												</form>
											) : null}
										</div>
									</TableCell>
								</TableRow>
							);
						})}
					</TableBody>
				</Table>
			)}
		</TableCard>
	);
}

// ---------------------------------------------------------------------------
// Price history chart

/** Standard cost as a step line (a gap where it was unknown), prices paid as dots. */
function PriceChart(props: { history: HistoryRow[]; paid: PaidRow[]; today: string }) {
	const { t, locale, currency } = useApp();
	const money = (cents: number) => formatMoney(cents, locale, currency);
	// History rows come newest first; the step line needs them in date order.
	const steps = props.history
		.filter((h) => h.kind === "standard")
		.reverse()
		.map((h) => ({
			date: h.validFrom,
			value: h.priceCents,
			title: h.priceCents === null ? "" : `${h.validFrom} · ${t.parts.priceKinds.standard} · ${money(h.priceCents)}`,
		}));
	const dots = props.paid.flatMap((r) =>
		r.unitCostCents === null
			? []
			: [
					{
						date: r.at.slice(0, 10),
						value: r.unitCostCents,
						title: `${r.at.slice(0, 10)} · ${r.poNumber} · ${r.supplierName} · ${money(r.unitCostCents)}`,
					},
				],
	);
	return (
		<StepChart
			id="price-chart"
			label={t.parts.chartLabel}
			steps={steps}
			dots={dots}
			stepLabel={t.parts.priceKinds.standard}
			dotLabel={t.parts.pricePaid}
			format={money}
			today={props.today}
		/>
	);
}

function PriceHistoryCard(props: { part: Part; history: HistoryRow[]; paid: PaidRow[]; today: string }) {
	const { t } = useApp();
	const { history, paid } = props;
	// The chart plots known standard costs and paid prices only (not offer or selling prices).
	const plottable =
		history.some((h) => h.kind === "standard" && h.priceCents !== null) || paid.some((r) => r.unitCostCents !== null);
	return (
		<Card>
			<CardHeader>
				<CardTitle icon={icons.history}>{t.parts.priceHistory}</CardTitle>
				<CardDescription>{t.parts.priceHistoryHint}</CardDescription>
			</CardHeader>
			{history.length === 0 && paid.length === 0 ? (
				<CardContent class="px-2">
					<CardEmpty icon={icons.chartColumn}>{t.parts.noPriceHistory}</CardEmpty>
				</CardContent>
			) : (
				<>
					{plottable ? (
						<CardContent>
							<PriceChart history={history} paid={paid} today={props.today} />
						</CardContent>
					) : null}
					<CardContent class="flex flex-col gap-2 px-2">
						<h3 class="px-2 text-sm font-medium">{t.parts.priceChanges}</h3>
						{history.length === 0 ? (
							<CardEmpty icon={icons.history}>{t.parts.noPriceHistory}</CardEmpty>
						) : (
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>{t.parts.date}</TableHead>
										<TableHead>{t.parts.priceKind}</TableHead>
										<TableHead>{t.parts.priceFor}</TableHead>
										<TableHead class="text-right">{t.parts.price}</TableHead>
										<TableHead>{t.parts.source}</TableHead>
										<TableHead>{t.parts.by}</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{history.map((h) => (
										<TableRow>
											<TableCell class="whitespace-nowrap text-muted-foreground tabular-nums">{h.validFrom}</TableCell>
											<TableCell class="whitespace-nowrap">{t.parts.priceKinds[h.kind]}</TableCell>
											<TableCell>
												{h.supplierId !== null ? (
													<a href={`/suppliers/${h.supplierId}`}>{h.supplierName ?? h.supplierId}</a>
												) : h.bomId !== null ? (
													<a href={`/boms/${h.bomId}`}>{h.bomCode ?? h.bomId}</a>
												) : (
													<span class="text-muted-foreground">{t.common.none}</span>
												)}
											</TableCell>
											<TableCell class="text-right">
												<Money cents={h.priceCents} />
											</TableCell>
											<TableCell>
												<span class="flex flex-col gap-0.5">
													<span>{t.parts.priceSources[h.source]}</span>
													{h.note ? <span class="text-xs text-muted-foreground">{h.note}</span> : null}
												</span>
											</TableCell>
											<TableCell class="text-muted-foreground">{h.createdBy}</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						)}
					</CardContent>
					<CardContent class="flex flex-col gap-2 px-2">
						<h3 class="px-2 text-sm font-medium">{t.parts.paidPrices}</h3>
						{paid.length === 0 ? (
							<CardEmpty icon={icons.receipt}>{t.parts.noReceipts}</CardEmpty>
						) : (
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>{t.parts.date}</TableHead>
										<TableHead>{t.parts.po}</TableHead>
										<TableHead>{t.parts.supplier}</TableHead>
										<TableHead class="text-right">{t.parts.qty}</TableHead>
										<TableHead class="text-right">{t.parts.unitPrice}</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{paid.map((r) => (
										<TableRow>
											<TableCell class="whitespace-nowrap text-muted-foreground tabular-nums">
												{r.at.slice(0, 10)}
											</TableCell>
											<TableCell class="font-medium whitespace-nowrap">
												<a href={`/purchasing/po/${r.poId}`}>{r.poNumber}</a>
											</TableCell>
											<TableCell>
												<a href={`/suppliers/${r.supplierId}`}>{r.supplierName}</a>
											</TableCell>
											<TableCell class="text-right">
												<Qty milli={r.qtyMilli} unit={props.part.unit} />
											</TableCell>
											<TableCell class="text-right">
												<Money cents={r.unitCostCents} />
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						)}
					</CardContent>
				</>
			)}
		</Card>
	);
}

function PartBoms(props: { part: Part; summary: Awaited<ReturnType<typeof partBomSummary>> }) {
	const view = useApp();
	const { t, seeCosts } = view;
	const { summary } = props;
	const only = summary.boms.length === 1 ? summary.boms[0] : undefined;
	return (
		<Card>
			<CardHeader>
				<CardTitle>{t.parts.boms}</CardTitle>
				{seeCosts && summary.rollup ? (
					<CardDescription>
						{t.boms.totalCost}: <CostView cost={summary.rollup} refs={summary.refs} long />
					</CardDescription>
				) : null}
				<CardAction>
					{only ? (
						<Button href={`/boms/${only.id}/diagram`} variant="outline" size="sm" icon={icons.diagram}>
							{t.parts.openDiagram}
						</Button>
					) : null}
					{can(view, "boms.edit") ? (
						<Button href={`/boms/new?part=${props.part.id}`} variant="outline" size="sm" icon={icons.plus}>
							{t.boms.new}
						</Button>
					) : null}
				</CardAction>
			</CardHeader>
			<CardContent class="px-2">
				{summary.boms.length === 0 ? (
					<CardEmpty icon={icons.listTree}>{t.boms.noBoms}</CardEmpty>
				) : (
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>{t.boms.code}</TableHead>
								<TableHead>{t.boms.revision}</TableHead>
								<TableHead>{t.boms.status}</TableHead>
								{seeCosts ? <TableHead class="text-right">{t.boms.totalCost}</TableHead> : null}
								<TableHead class="w-px">
									<span class="sr-only">{t.common.actions}</span>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{summary.boms.map((b) => (
								<TableRow>
									<TableCell class="font-medium">
										<a href={`/boms/${b.id}`}>{b.code}</a>
									</TableCell>
									<TableCell>{b.revision}</TableCell>
									<TableCell>
										<StatusBadge status={b.status} />
									</TableCell>
									{seeCosts ? (
										<TableCell class="text-right">
											<CostView cost={b.cost} refs={summary.refs} />
										</TableCell>
									) : null}
									<TableCell class="py-1 text-right">
										<Button
											href={`/boms/${b.id}/diagram`}
											variant="ghost"
											size="icon-sm"
											icon={icons.diagram}
											aria-label={`${t.parts.openDiagram}: ${b.code} ${b.revision}`}
											title={t.parts.openDiagram}
										/>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
			</CardContent>
		</Card>
	);
}

function WhereUsed(props: { rows: WhereUsedRow[] }) {
	const { t } = useApp();
	return (
		<Card>
			<CardHeader>
				<CardTitle class="flex items-center gap-2">
					{t.parts.whereUsed}
					{props.rows.length > 0 ? <Badge variant="secondary">{props.rows.length}</Badge> : null}
				</CardTitle>
			</CardHeader>
			<CardContent class="px-2">
				{props.rows.length === 0 ? (
					<CardEmpty icon={icons.layers}>{t.common.noResults}</CardEmpty>
				) : (
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>{t.boms.parent}</TableHead>
								<TableHead>{t.boms.code}</TableHead>
								<TableHead>{t.boms.revision}</TableHead>
								<TableHead>{t.boms.status}</TableHead>
								<TableHead>{t.boms.level}</TableHead>
								<TableHead class="text-right">{t.boms.qty}</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{props.rows.map((r) => (
								<TableRow>
									<TableCell>
										<span class="font-medium">
											<a href={`/boms/${r.bomId}`}>{r.parentRef}</a>
										</span>{" "}
										<span class="text-muted-foreground">{r.parentName}</span>
									</TableCell>
									<TableCell>{r.code}</TableCell>
									<TableCell>{r.revision}</TableCell>
									<TableCell>
										<StatusBadge status={r.status} />
									</TableCell>
									<TableCell>
										{r.depth === 1 ? (
											<Badge variant="secondary">{t.boms.direct}</Badge>
										) : (
											<Badge variant="outline">{fmt(t.boms.via, { ref: r.viaRef })}</Badge>
										)}
									</TableCell>
									<TableCell class="text-right">{r.depth === 1 ? <Qty milli={r.qtyMilli} /> : null}</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
			</CardContent>
		</Card>
	);
}

export function MovesTable(props: { moves: (typeof stockMoves.$inferSelect)[]; unit: string }) {
	const { t } = useApp();
	if (props.moves.length === 0) return <CardEmpty icon={icons.history}>{t.common.noResults}</CardEmpty>;
	return (
		<Table>
			<TableHeader>
				<TableRow>
					<TableHead>{t.stock.at}</TableHead>
					<TableHead>{t.stock.reason}</TableHead>
					<TableHead class="text-right">{t.stock.qty}</TableHead>
					<TableHead>{t.stock.serial}</TableHead>
					<TableHead>{t.stock.by}</TableHead>
					<TableHead>{t.common.notes}</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{props.moves.map((m) => (
					<TableRow>
						<TableCell class="whitespace-nowrap text-muted-foreground tabular-nums">{shortDateTime(m.at)}</TableCell>
						<TableCell>
							<MoveReference reason={m.reason} refType={m.refType} refId={m.refId} />
						</TableCell>
						<TableCell class="text-right">
							<Qty milli={m.qtyMilli} unit={props.unit} />
						</TableCell>
						<TableCell>{m.serial ?? ""}</TableCell>
						<TableCell class="text-muted-foreground">{m.by}</TableCell>
						<TableCell>{m.note}</TableCell>
					</TableRow>
				))}
			</TableBody>
		</Table>
	);
}

partRoutes.get("/:id", async (c) => {
	const id = idParam(c);
	const part = id ? await getPart(c.var.db, id) : undefined;
	if (!part) return notFound(c);
	const db = c.var.db;
	const [supplierRows, onHand, moves, bomSummary, usedIn, recent, offers, lastPaid, average, history, paid] =
		await Promise.all([
			part.supplierId
				? db
						.select({ id: suppliers.id, name: suppliers.name, email: suppliers.email, phone: suppliers.phone })
						.from(suppliers)
						.where(eq(suppliers.id, part.supplierId))
				: Promise.resolve([]),
			onHandOf(db, part.id),
			db
				.select()
				.from(stockMoves)
				.where(eq(stockMoves.partId, part.id))
				.orderBy(desc(stockMoves.at), desc(stockMoves.id))
				.limit(100),
			partBomSummary(db, part.id),
			whereUsed(db, part.id),
			part.kind === "make" ? listBuilds(db, { status: "all", partId: part.id, limit: 10 }) : Promise.resolve([]),
			partOffers(db, part.id),
			lastPaidBySupplier(db, part.id),
			isStocked(part.kind) ? averageCosts(db).then((a) => a.costs.get(part.id)) : Promise.resolve(undefined),
			partPriceHistory(db, part.id),
			paidPrices(db, part.id),
		]);
	return page(
		c,
		part.ref,
		<PartDetail
			part={part}
			supplier={supplierRows[0]}
			offers={offers}
			lastPaid={lastPaid}
			average={average}
			history={history}
			paid={paid}
			today={nowIso().slice(0, 10)}
			onHand={onHand}
			moves={moves}
			bomSummary={bomSummary}
			usedIn={usedIn}
			builds={recent}
			imagesEnabled={imagesBucket(c.env) !== null}
			ok={c.req.query("ok")}
			err={c.req.query("err")}
		/>,
	);
});

partRoutes.get("/:id/edit", requirePermission("parts.edit"), async (c) => {
	const t = c.var.t;
	const id = idParam(c);
	const part = id ? await getPart(c.var.db, id) : undefined;
	if (!part) return notFound(c);
	return page(
		c,
		t.parts.edit,
		<>
			<PageHeader title={`${t.parts.edit}: ${part.ref}`} />
			<PartForm
				action={`/parts/${part.id}`}
				values={partToForm(
					part,
					c.var.locale,
					part.supplierId ? await getOffer(c.var.db, part.id, part.supplierId) : undefined,
				)}
				errors={{}}
				suppliers={await supplierOptions(c)}
				submit={t.common.save}
				cancel={`/parts/${part.id}`}
			/>
		</>,
	);
});

partRoutes.post("/:id", requirePermission("parts.edit"), async (c) => {
	const t = c.var.t;
	const id = idParam(c);
	const part = id ? await getPart(c.var.db, id) : undefined;
	if (!part) return notFound(c);
	const body = await c.req.parseBody();
	const v = await validatePart(c, body, part);
	if (!v.ok) {
		return page(
			c,
			t.parts.edit,
			<>
				<PageHeader title={`${t.parts.edit}: ${part.ref}`} />
				<PartForm
					action={`/parts/${part.id}`}
					values={body as FormValues}
					errors={translateErrors(c, v.errors, { ref: v.clashRef ?? "" })}
					suppliers={await supplierOptions(c)}
					submit={t.common.save}
					cancel={`/parts/${part.id}`}
				/>
			</>,
			422,
		);
	}
	const offer = part.supplierId ? await getOffer(c.var.db, part.id, part.supplierId) : undefined;
	await runBatch(c.var.db, savePartStatements(c.var.db, v.data, { part, offer }, "form", c.var.user, nowIso()));
	return redirectOk(c, `/parts/${part.id}`);
});

// ---------------------------------------------------------------------------
// Standard cost shortcuts (logged in the price history with a note saying where the value came from).

partRoutes.post("/:id/cost/average", requirePermission("prices.edit"), async (c) => {
	const id = idParam(c);
	const part = id ? await getPart(c.var.db, id) : undefined;
	if (!part) return notFound(c);
	const average = isStocked(part.kind) ? (await averageCosts(c.var.db)).costs.get(part.id) : undefined;
	const cents = average && !average.incomplete ? averageUnitCents(average) : null;
	if (cents === null) return c.redirect(`/parts/${part.id}`, 303);
	const stmts = setStandardCostStatements(
		c.var.db,
		part,
		cents,
		"form",
		c.var.user,
		nowIso(),
		c.var.t.parts.noteAverage,
	);
	await runBatch(c.var.db, stmts);
	return redirectOk(c, `/parts/${part.id}`);
});

partRoutes.post("/:id/cost/offer", requirePermission("prices.edit"), async (c) => {
	const id = idParam(c);
	const part = id ? await getPart(c.var.db, id) : undefined;
	if (!part) return notFound(c);
	const offer = part.supplierId ? await getOffer(c.var.db, part.id, part.supplierId) : undefined;
	if (!offer || offer.priceCents === null || !isStocked(part.kind)) return c.redirect(`/parts/${part.id}`, 303);
	const supplier = await getSupplier(c.var.db, offer.supplierId);
	const note = fmt(c.var.t.parts.noteOffer, { supplier: supplier?.name ?? String(offer.supplierId) });
	await runBatch(
		c.var.db,
		setStandardCostStatements(c.var.db, part, offer.priceCents, "form", c.var.user, nowIso(), note),
	);
	return redirectOk(c, `/parts/${part.id}`);
});

// ---------------------------------------------------------------------------
// Supplier offers (D90): one per part and supplier; the preferred one is parts.supplier_id.

function OfferForm(props: {
	part: Part;
	action: string;
	values: FormValues;
	errors: FormErrors;
	/** Supplier choices when adding an offer; undefined when editing (the supplier is fixed). */
	suppliers?: SupplierOption[] | undefined;
	supplier?: SupplierOption | undefined;
	alreadyPreferred: boolean;
	submit: string;
}) {
	const { t, locale, currency } = useApp();
	const p = { values: props.values, errors: props.errors };
	const cost = props.part.costCents;
	return (
		<>
			<ErrorBanner show={Object.keys(props.errors).length > 0} />
			<Card>
				{props.supplier ? (
					<CardHeader>
						<CardTitle icon={icons.truck}>
							<a href={`/suppliers/${props.supplier.id}`}>{props.supplier.name}</a>
						</CardTitle>
						<CardDescription>
							{props.part.ref} · {props.part.name}
						</CardDescription>
					</CardHeader>
				) : null}
				<CardContent>
					<form method="post" action={props.action} class="flex flex-col gap-6">
						<FieldGroup>
							{props.suppliers ? (
								<SelectField
									name="supplier_id"
									label={t.parts.supplier}
									required
									options={[
										{ value: "", label: t.common.none },
										...props.suppliers.map((s) => ({ value: String(s.id), label: s.name })),
									]}
									{...p}
								/>
							) : null}
							<div class="grid gap-4 md:grid-cols-2">
								<TextField name="supplier_ref" label={t.parts.supplierRef} autofocus={!props.suppliers} {...p} />
								<DecimalField name="price" label={t.parts.offerPrice} hint={t.parts.offerPriceHint} {...p} />
							</div>
							<div class="grid gap-4 md:grid-cols-3">
								<DecimalField name="moq" label={t.parts.moq} {...p} />
								<DecimalField name="pack_size" label={t.parts.packSize} {...p} />
								<TextField name="lead_days" label={t.parts.leadDays} inputmode="numeric" {...p} />
							</div>
							<TextArea name="notes" label={t.common.notes} {...p} />
							{props.alreadyPreferred ? (
								<p class="flex items-center gap-2 text-sm text-muted-foreground">
									<Icon icon={icons.circleCheck} class="size-4" />
									{t.parts.isPreferred}
								</p>
							) : (
								<CheckboxField name="preferred" label={t.parts.preferredCheckbox} {...p} />
							)}
							<CheckboxField
								name="set_standard_cost"
								label={t.parts.setStandardCheckbox}
								hint={fmt(t.parts.setStandardHint, {
									cost: cost === null ? t.parts.costUnknown : formatMoney(cost, locale, currency),
								})}
								{...p}
							/>
						</FieldGroup>
						<div class="flex flex-wrap items-center gap-2">
							<Button icon={icons.save}>{props.submit}</Button>
							<Button variant="outline" href={`/parts/${props.part.id}`}>
								{t.common.cancel}
							</Button>
						</div>
					</form>
				</CardContent>
			</Card>
		</>
	);
}

/** Page for adding an offer (a supplier picker) or editing one (`supplier` given). */
function offerPage(
	c: Context<AppEnv>,
	part: Part,
	opts: {
		values: FormValues;
		errors?: FormErrors;
		suppliers?: SupplierOption[];
		supplier?: SupplierOption;
		alreadyPreferred?: boolean;
	},
	status: 200 | 422 = 200,
) {
	const t = c.var.t;
	const title = opts.supplier ? t.parts.editOffer : t.parts.newOffer;
	const noSuppliers = !opts.supplier && (opts.suppliers ?? []).length === 0;
	return page(
		c,
		`${title}: ${part.ref}`,
		<>
			<PageHeader title={`${title}: ${part.ref}`} subtitle={part.name} />
			{noSuppliers ? (
				<EmptyState icon={icons.factory} title={t.suppliers.empty} description={t.parts.noSuppliersYet}>
					<Button href="/suppliers/new" icon={icons.plus}>
						{t.suppliers.new}
					</Button>
				</EmptyState>
			) : (
				<OfferForm
					part={part}
					action={opts.supplier ? `/parts/${part.id}/offers/${opts.supplier.id}` : `/parts/${part.id}/offers`}
					values={opts.values}
					errors={opts.errors ?? {}}
					suppliers={opts.supplier ? undefined : opts.suppliers}
					supplier={opts.supplier}
					alreadyPreferred={opts.alreadyPreferred ?? false}
					submit={opts.supplier ? t.common.save : t.common.create}
				/>
			)}
		</>,
		status,
	);
}

/** Kits and fees are never purchased: no offers for them. */
function offerKindRefused(c: Context<AppEnv>, part: Part) {
	const t = c.var.t;
	return page(
		c,
		`${t.parts.newOffer}: ${part.ref}`,
		<>
			<PageHeader title={`${t.parts.newOffer}: ${part.ref}`} subtitle={part.name} />
			<Alert variant="destructive">{t.parts.offerKind}</Alert>
			<Button href={`/parts/${part.id}`} variant="outline" icon={icons.arrowLeft}>
				{t.common.back}
			</Button>
		</>,
		422,
	);
}

async function partFromParam(c: Context<AppEnv>) {
	const id = idParam(c);
	return id ? await getPart(c.var.db, id) : undefined;
}

/** The offer named by the :supplierId parameter, with its supplier. */
async function offerFromParam(c: Context<AppEnv>, part: Part) {
	const supplierId = idParam(c, "supplierId");
	if (!supplierId) return undefined;
	const [offer, supplier] = await Promise.all([
		getOffer(c.var.db, part.id, supplierId),
		getSupplier(c.var.db, supplierId),
	]);
	return offer && supplier ? { offer, supplier: { id: supplier.id, name: supplier.name } } : undefined;
}

partRoutes.get("/:id/offers", async (c) => {
	const id = idParam(c);
	return id ? c.redirect(`/parts/${id}#suppliers`, 303) : notFound(c);
});

partRoutes.get("/:id/offers/new", requirePermission("prices.edit"), async (c) => {
	const part = await partFromParam(c);
	if (!part) return notFound(c);
	if (!isStocked(part.kind)) return offerKindRefused(c, part);
	// The first offer of a part becomes its preferred one unless unticked.
	return offerPage(c, part, {
		values: { preferred: part.supplierId === null ? "on" : "" },
		suppliers: await supplierOptions(c),
	});
});

async function createOffer(c: Context<AppEnv>) {
	const part = await partFromParam(c);
	if (!part) return notFound(c);
	if (!isStocked(part.kind)) return offerKindRefused(c, part);
	const t = c.var.t;
	const body = await c.req.parseBody();
	const result = validate(offerInput, body);
	let errors: FormErrors = result.ok ? {} : translateErrors(c, result.errors);
	if (result.ok) {
		const supplierId = result.data.supplier_id;
		if (supplierId === null) errors = translateErrors(c, { supplier_id: "required" });
		else if (!(await getSupplier(c.var.db, supplierId))) errors = translateErrors(c, { supplier_id: "invalid" });
		else if (await getOffer(c.var.db, part.id, supplierId)) errors = { supplier_id: t.parts.offerExists };
		if (result.data.set_standard_cost && result.data.price === null)
			errors = { ...errors, ...translateErrors(c, { set_standard_cost: "standard_needs_price" }) };
	}
	if (!result.ok || result.data.supplier_id === null || Object.keys(errors).length > 0) {
		return offerPage(c, part, { values: body as FormValues, errors, suppliers: await supplierOptions(c) }, 422);
	}
	const d = result.data;
	const supplierId = result.data.supplier_id;
	const user = c.var.user;
	const now = nowIso();
	const stmts: Statement[] = [
		...saveOfferStatements(c.var.db, { partId: part.id }, supplierId, offerTerms(d), undefined, "form", user, now),
	];
	if (d.preferred) stmts.push(setPreferredStatement(c.var.db, part.id, supplierId, user, now));
	stmts.push(...(await offerStandardStatements(c, part, supplierId, d)));
	await runBatch(c.var.db, stmts);
	return redirectOk(c, `/parts/${part.id}`);
}

/** "Also use this price as the standard cost" (D99): the part's standard cost, with its history row. */
async function offerStandardStatements(
	c: Context<AppEnv>,
	part: Part,
	supplierId: number,
	d: { price: number | null; set_standard_cost: boolean },
): Promise<Statement[]> {
	if (!d.set_standard_cost || d.price === null) return [];
	const supplier = await getSupplier(c.var.db, supplierId);
	const note = fmt(c.var.t.parts.noteOffer, { supplier: supplier?.name ?? String(supplierId) });
	return setStandardCostStatements(c.var.db, part, d.price, "form", c.var.user, nowIso(), note);
}

partRoutes.post("/:id/offers", requirePermission("prices.edit"), createOffer);
partRoutes.post("/:id/offers/new", requirePermission("prices.edit"), createOffer);

partRoutes.get("/:id/offers/:supplierId", requirePermission("prices.edit"), async (c) => {
	const part = await partFromParam(c);
	if (!part) return notFound(c);
	const found = await offerFromParam(c, part);
	if (!found) return notFound(c);
	if (!isStocked(part.kind)) return offerKindRefused(c, part);
	const preferred = part.supplierId === found.supplier.id;
	return offerPage(c, part, {
		values: offerToForm(found.offer, preferred, c.var.locale),
		supplier: found.supplier,
		alreadyPreferred: preferred,
	});
});

partRoutes.post("/:id/offers/:supplierId", requirePermission("prices.edit"), async (c) => {
	const part = await partFromParam(c);
	if (!part) return notFound(c);
	const found = await offerFromParam(c, part);
	if (!found) return notFound(c);
	if (!isStocked(part.kind)) return offerKindRefused(c, part);
	const body = await c.req.parseBody();
	// The supplier comes from the URL: an offer cannot move to another supplier.
	const result = validate(offerInput, { ...body, supplier_id: String(found.supplier.id) });
	const preferred = part.supplierId === found.supplier.id;
	if (!result.ok || (result.data.set_standard_cost && result.data.price === null)) {
		return offerPage(
			c,
			part,
			{
				values: body as FormValues,
				errors: translateErrors(c, result.ok ? { set_standard_cost: "standard_needs_price" } : result.errors),
				supplier: found.supplier,
				alreadyPreferred: preferred,
			},
			422,
		);
	}
	const d = result.data;
	const user = c.var.user;
	const now = nowIso();
	const stmts: Statement[] = [
		...saveOfferStatements(
			c.var.db,
			{ partId: part.id },
			found.supplier.id,
			offerTerms(d),
			found.offer,
			"form",
			user,
			now,
		),
	];
	// Unticking never clears the preferred supplier: another offer is made preferred instead.
	if (d.preferred && !preferred) stmts.push(setPreferredStatement(c.var.db, part.id, found.supplier.id, user, now));
	stmts.push(...(await offerStandardStatements(c, part, found.supplier.id, d)));
	await runBatch(c.var.db, stmts);
	return redirectOk(c, `/parts/${part.id}`);
});

partRoutes.post("/:id/offers/:supplierId/prefer", requirePermission("prices.edit"), async (c) => {
	const part = await partFromParam(c);
	if (!part) return notFound(c);
	const found = await offerFromParam(c, part);
	if (!found) return notFound(c);
	if (!isStocked(part.kind)) return offerKindRefused(c, part);
	if (part.supplierId !== found.supplier.id) {
		await runBatch(c.var.db, [setPreferredStatement(c.var.db, part.id, found.supplier.id, c.var.user, nowIso())]);
	}
	return redirectOk(c, `/parts/${part.id}`);
});

partRoutes.post("/:id/offers/:supplierId/delete", requirePermission("parts.delete"), async (c) => {
	const part = await partFromParam(c);
	if (!part) return notFound(c);
	const found = await offerFromParam(c, part);
	if (!found) return notFound(c);
	await runBatch(c.var.db, deleteOfferStatements(c.var.db, part.id, found.supplier.id, c.var.user, nowIso()));
	return redirectOk(c, `/parts/${part.id}`, "deleted");
});

// ---------------------------------------------------------------------------

for (const [action, archived] of [
	["archive", true],
	["unarchive", false],
] as const) {
	partRoutes.post(`/:id/${action}`, requirePermission("parts.delete"), async (c) => {
		const id = idParam(c);
		if (!id) return notFound(c);
		await c.var.db.update(parts).set({ archived, updatedAt: nowIso(), updatedBy: c.var.user }).where(eq(parts.id, id));
		return redirectOk(c, `/parts/${id}`, archived ? "archived" : "unarchived");
	});
}

partRoutes.post("/:id/delete", requirePermission("parts.delete"), async (c) => {
	const id = idParam(c);
	if (!id) return notFound(c);
	const part = await getPart(c.var.db, id);
	try {
		await c.var.db.delete(parts).where(eq(parts.id, id));
	} catch (err) {
		if (isConstraintError(err, "FOREIGN KEY")) return c.redirect(`/parts/${id}?err=in_use`, 303);
		throw err;
	}
	const bucket = imagesBucket(c.env);
	if (bucket && part?.imageKey) await bucket.delete(part.imageKey);
	return redirectOk(c, "/parts", "deleted");
});
