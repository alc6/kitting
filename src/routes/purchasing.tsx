import { and, asc, eq, inArray } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { PO_STATUSES, type PoShipment, type PoStatus, parts, poLines, suppliers } from "../db/schema";
import { getOffer, poUnitPrice } from "../domain/offers";
import { keyLabel, keyText, type OptionDef } from "../domain/option-keys";
import { keyFromForm, optionsOf } from "../domain/options";
import { can } from "../domain/permissions";
import {
	addPoLineStatement,
	addShipmentStatement,
	cancelPoStatement,
	closePoStatement,
	computeShortages,
	createPoStatement,
	deletePoLineStatement,
	deletePoStatement,
	deleteShipmentStatement,
	draftPoStatements,
	getPo,
	getPoLines,
	getPoShipments,
	knownCarriers,
	listPos,
	nextPoNumbers,
	OPEN_PO_STATUSES,
	planDraftOrders,
	planReceipts,
	poEditInput,
	poInput,
	poLineInput,
	RECEIVABLE_PO_STATUSES,
	receiptStatements,
	receiveQtyField,
	receiveSerialsField,
	SHIPPING_PO_STATUSES,
	type ShortageLine,
	type ShortageOffer,
	type Shortages,
	type SupplierGroup,
	sendPoStatement,
	shipmentFormValues,
	shipmentInput,
	shipmentRuleErrors,
	shipmentValues,
	updatePoLineStatement,
	updatePoStatement,
	updateShipmentStatement,
} from "../domain/purchasing";
import { errorText, fmt } from "../i18n";
import { cn } from "../lib/cn";
import { isConstraintError } from "../lib/sql";
import {
	formatCentsInput,
	formatMoney,
	formatQty,
	formatQtyInput,
	lineCostCents,
	parseCents,
	parseMilli,
} from "../lib/units";
import { type FieldErrors, validate } from "../lib/validation";
import { requirePermission } from "../middleware/roles";
import type { AppEnv } from "../types";
import { type AppView, useApp } from "../views/context";
import { RecordTabs } from "../views/history";
import { Icon, icons } from "../views/icons";
import { OptionSelects } from "../views/options";
import { PartPicker, PartPickerDialog } from "../views/part-picker";
import { fragment, idParam, notFound, nowIso, page, redirectOk, saveChanges, translateErrors } from "../views/render";
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
	CollapsibleCard,
	EmptyState,
	ErrorBanner,
	FieldGroup,
	Flash,
	type FormErrors,
	type FormValues,
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
} from "../views/ui";
import { recordHistoryPage } from "./history";
import { csvResponse } from "./import";

export const purchasingRoutes = new Hono<AppEnv>();

type Tab = "shortages" | "pos";

function PurchasingTabs(props: { active: Tab }) {
	const { t } = useApp();
	return (
		<LinkTabs
			items={[
				{
					href: "/purchasing",
					label: t.purchasing.tabs.shortages,
					active: props.active === "shortages",
					icon: icons.trendingDown,
				},
				{ href: "/purchasing/po", label: t.purchasing.tabs.pos, active: props.active === "pos", icon: icons.receipt },
			]}
		/>
	);
}

export function PoStatusBadge(props: { status: PoStatus }) {
	const { t } = useApp();
	return <span class={`status status-${props.status}`}>{t.purchasing.statuses[props.status]}</span>;
}

/** An open PO whose expected date is in the past. */
function isOverdue(expectedAt: string | null, status: PoStatus, today: string): boolean {
	return expectedAt !== null && expectedAt < today && OPEN_PO_STATUSES.includes(status);
}

/** Part reference (linked), name and optional supplier reference, for the first cell of a line. */
function PartCell(props: {
	id: number;
	ref: string;
	name: string;
	supplierRef?: string | null;
	/** The option values ordered (D191), as text. */
	values?: string;
}) {
	return (
		<TableCell class="min-w-44">
			<span class="whitespace-nowrap">
				<a href={`/parts/${props.id}`}>{props.ref}</a>
			</span>{" "}
			<span class="text-muted-foreground">{props.name}</span>
			{props.values ? <div class="text-sm font-medium">{props.values}</div> : null}
			{props.supplierRef ? <div class="text-xs text-muted-foreground">{props.supplierRef}</div> : null}
		</TableCell>
	);
}

/** The selects of a part's options on the add-line form, refreshed when the part changes (htmx). */
function LineOptions(props: { poId: number; options: OptionDef[]; values: FormValues; errors: FormErrors }) {
	return (
		<div
			id="po-line-options"
			class="grid gap-4 empty:hidden md:col-span-4 md:grid-cols-3"
			hx-get={`/purchasing/po/${props.poId}/line-options`}
			hx-trigger="change from:#f-part"
			hx-include="#f-part"
			hx-swap="outerHTML"
		>
			<OptionSelects
				options={props.options}
				name={(o) => `option:${o.id}`}
				values={props.values}
				errors={props.errors}
			/>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Shortages

/**
 * Whether a shortage line can be ordered from another supplier (D94): a line of a supplier group when
 * several suppliers offer the part, a line without preferred supplier as soon as one offers it.
 */
const canChoose = (g: SupplierGroup, l: ShortageLine) => l.offers.length > (g.supplierId === null ? 0 : 1);

/** "Supplier (preferred) · €6.60 · MOQ 5 · 21 d lead time", for an option of the order-from select. */
function offerLabel(o: ShortageOffer, preferred: boolean, view: Pick<AppView, "t" | "locale" | "currency">) {
	const { t, locale, currency } = view;
	return [
		preferred ? `${o.supplierName} (${t.purchasing.preferred})` : o.supplierName,
		o.priceCents === null ? t.purchasing.standardCost : formatMoney(o.priceCents, locale, currency),
		o.moqMilli > 0 ? fmt(t.purchasing.moqShort, { n: formatQty(o.moqMilli, locale) }) : null,
		o.leadDays > 0 ? fmt(t.purchasing.leadShort, { n: o.leadDays }) : null,
	]
		.filter((s) => s !== null)
		.join(" · ");
}

/**
 * Native select of the supplier to order a line from, read by POST /purchasing/draft-pos. The preferred
 * supplier is selected; a line without one starts on an empty "choose" option and is skipped until chosen.
 */
function OrderFromSelect(props: { line: ShortageLine }) {
	const view = useApp();
	const l = props.line;
	return (
		<select
			name={`order_from_${l.key}`}
			aria-label={`${view.t.purchasing.orderFrom} ${l.part.ref}`}
			class="w-auto max-w-72 min-w-44"
		>
			{l.part.supplierId === null ? <option value="">{view.t.purchasing.chooseSupplier}</option> : null}
			{l.offers.map((o) => (
				<option value={String(o.supplierId)} selected={o.supplierId === l.part.supplierId}>
					{offerLabel(o, o.supplierId === l.part.supplierId, view)}
				</option>
			))}
		</select>
	);
}

export function ShortageTables(props: { shortages: Shortages; selectable?: boolean }) {
	const { t, seeCosts } = useApp();
	const { shortages } = props;
	return (
		<>
			{shortages.missingAssemblies.length ? (
				<Alert variant="warning" title={t.purchasing.missingAssemblies} class="mb-0">
					<ul class="m-0 flex list-disc flex-col gap-1 pl-4">
						{shortages.missingAssemblies.map((m) => (
							<li>
								<span class="font-medium">{m.ref}</span> {m.name}
								{m.values ? ` (${m.values})` : ""} × <Qty milli={m.qtyMilli} /> ({m.builds.join(", ")})
							</li>
						))}
					</ul>
				</Alert>
			) : null}
			{shortages.missingValues.length ? (
				<Alert variant="warning" title={t.purchasing.missingValues} class="mb-0">
					<ul class="m-0 flex list-disc flex-col gap-1 pl-4">
						{shortages.missingValues.map((m) => (
							<li>
								{fmt(t.errors.option_value_missing, { ref: m.ref, option: m.option, value: m.value })} (
								{m.builds.join(", ")})
							</li>
						))}
					</ul>
				</Alert>
			) : null}
			{shortages.groups.map((g) => {
				const choosing = props.selectable === true && (g.supplierId === null || g.lines.some((l) => canChoose(g, l)));
				return (
					<Card class={cn("gap-4", g.supplierId === null && "border-warning/40")}>
						<CardHeader>
							{g.supplierId === null ? (
								<CardTitle class="flex items-center gap-2 text-warning">
									<Icon icon={icons.triangleAlert} class="size-4" />
									{t.purchasing.unassigned}
								</CardTitle>
							) : (
								<CardTitle class="flex items-center gap-2">
									<Icon icon={icons.factory} class="size-4 text-muted-foreground" />
									<a href={`/suppliers/${g.supplierId}`}>{g.supplierName}</a>
								</CardTitle>
							)}
							<CardDescription>
								{fmt(t.purchasing.partCount, { n: g.lines.length })}
								{seeCosts ? (
									<>
										{" "}
										· {t.purchasing.estimated}: <Money cents={g.totalCents} />
									</>
								) : null}
							</CardDescription>
							{props.selectable && g.supplierId !== null ? (
								<CardAction>
									<label class="flex min-h-(--control-h) cursor-pointer items-center gap-3 text-sm font-medium">
										<input type="checkbox" data-slot="checkbox" name={`supplier_${g.supplierId}`} value="on" checked />
										<span>
											{t.purchasing.include}
											<span class="sr-only"> {g.supplierName}</span>
										</span>
									</label>
								</CardAction>
							) : null}
						</CardHeader>
						<CardContent class="px-2">
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>{t.purchasing.part}</TableHead>
										<TableHead class="text-right">{t.purchasing.need}</TableHead>
										<TableHead class="text-right">{t.purchasing.onHand}</TableHead>
										<TableHead class="text-right">{t.purchasing.onOrder}</TableHead>
										<TableHead class="text-right">{t.purchasing.net}</TableHead>
										<TableHead class="text-right">{t.purchasing.order}</TableHead>
										{seeCosts ? (
											<>
												<TableHead class="text-right">{t.purchasing.price}</TableHead>
												<TableHead class="text-right">{t.purchasing.lineTotal}</TableHead>
											</>
										) : null}
										{choosing ? <TableHead>{t.purchasing.orderFrom}</TableHead> : null}
										<TableHead>{t.purchasing.builds}</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{g.lines.map((l) => (
										<TableRow>
											<PartCell
												id={l.part.id}
												ref={l.part.ref}
												name={l.part.name}
												supplierRef={l.part.supplierRef}
												values={keyLabel(l.part.options, l.optionValues)}
											/>
											<TableCell class="text-right">
												<Qty milli={l.needMilli} unit={l.part.unit} />
											</TableCell>
											<TableCell class="text-right">
												<Qty milli={l.onHandMilli} unit={l.part.unit} />
											</TableCell>
											<TableCell class="text-right">
												{l.onOrderMilli ? <Qty milli={l.onOrderMilli} unit={l.part.unit} /> : ""}
											</TableCell>
											<TableCell class="text-right font-medium text-warning">
												<Qty milli={l.netMilli} unit={l.part.unit} />
											</TableCell>
											<TableCell class="text-right font-semibold">
												<Qty milli={l.orderMilli} unit={l.part.unit} />
											</TableCell>
											{seeCosts ? (
												<>
													<TableCell class="text-right">
														<Money cents={l.unitPriceCents} />
													</TableCell>
													<TableCell class="text-right">
														<Money cents={lineCostCents(l.orderMilli, l.unitPriceCents)} />
													</TableCell>
												</>
											) : null}
											{choosing ? (
												<TableCell>
													{canChoose(g, l) ? (
														<OrderFromSelect line={l} />
													) : g.supplierId === null ? (
														<span class="text-sm text-muted-foreground">{t.purchasing.noOffer}</span>
													) : null}
												</TableCell>
											) : null}
											<TableCell class="min-w-48 text-xs text-muted-foreground">{l.builds.join(", ")}</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						</CardContent>
					</Card>
				);
			})}
		</>
	);
}

purchasingRoutes.get("/", async (c) => {
	const t = c.var.t;
	const shortages = await computeShortages(c.var.db);
	// Lines without a preferred supplier can be ordered too, once a supplier offering them is chosen.
	const canOrder = can(c.var, "purchasing.order");
	const orderable =
		canOrder && shortages.groups.some((g) => g.supplierId !== null || g.lines.some((l) => canChoose(g, l)));
	const choosing = canOrder && shortages.groups.some((g) => g.lines.some((l) => canChoose(g, l)));
	return page(
		c,
		t.purchasing.title,
		<>
			<PageHeader
				title={t.purchasing.title}
				actions={
					orderable ? (
						<Button form="draft-pos" icon={icons.shoppingCart}>
							{t.purchasing.createDrafts}
						</Button>
					) : undefined
				}
			/>
			<PurchasingTabs active="shortages" />
			<div class="mb-4 flex max-w-3xl flex-col gap-1 text-sm text-muted-foreground">
				<p>{fmt(t.purchasing.shortagesIntro, { n: shortages.buildCount })}</p>
				{shortages.toMake.length > 0 ? (
					<p>
						<a href="/builds#to-make">{fmt(t.purchasing.toMakeLink, { n: shortages.toMake.length })}</a>
					</p>
				) : null}
				{choosing ? <p>{t.purchasing.orderFromHint}</p> : null}
			</div>
			{shortages.groups.length === 0 && shortages.missingAssemblies.length === 0 ? (
				<EmptyState icon={icons.circleCheck} description={t.purchasing.noShortages} />
			) : (
				<form id="draft-pos" method="post" action="/purchasing/draft-pos" class="flex flex-col gap-4">
					<ShortageTables shortages={shortages} selectable={canOrder} />
					{orderable ? (
						<div class="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-muted/50 px-6 py-4">
							<p class="text-sm text-muted-foreground">{t.purchasing.createDraftsHint}</p>
							<Button icon={icons.shoppingCart}>{t.purchasing.createDrafts}</Button>
						</div>
					) : null}
				</form>
			)}
		</>,
	);
});

purchasingRoutes.post("/draft-pos", requirePermission("purchasing.order"), async (c) => {
	const db = c.var.db;
	const body = await c.req.parseBody();
	const shortages = await computeShortages(db);
	const orders = planDraftOrders(
		shortages.groups,
		(supplierId) => body[`supplier_${supplierId}`] === "on",
		(key) => {
			const v = body[`order_from_${key}`];
			return typeof v === "string" && /^\d+$/.test(v) ? Number(v) : undefined;
		},
	);
	if (orders.length === 0) return c.redirect("/purchasing", 303);
	for (let attempt = 0; ; attempt++) {
		const numbers = await nextPoNumbers(db, orders.length);
		try {
			await saveChanges(
				c,
				fmt(c.var.t.history.summaries.draftPos, { n: orders.length }),
				draftPoStatements(db, orders, numbers, c.var.user, nowIso()),
			);
			break;
		} catch (err) {
			if (attempt > 0 || !isConstraintError(err, "UNIQUE")) throw err;
		}
	}
	return c.redirect(`/purchasing/po?created=${orders.length}`, 303);
});

// ---------------------------------------------------------------------------
// Purchase order list and creation

purchasingRoutes.get("/po", async (c) => {
	const t = c.var.t;
	const q = c.req.query("q") ?? "";
	const status = c.req.query("status") ?? "open";
	const rows = await listPos(c.var.db, { q, status });
	const today = nowIso().slice(0, 10);
	const created = c.req.query("created");
	const canOrder = can(c.var, "purchasing.order");
	return page(
		c,
		t.purchasing.pos,
		<>
			<PageHeader
				title={t.purchasing.title}
				actions={
					canOrder ? (
						<Button href="/purchasing/po/new" icon={icons.plus}>
							{t.purchasing.newPo}
						</Button>
					) : undefined
				}
			/>
			<PurchasingTabs active="pos" />
			<Flash ok={c.req.query("ok")} message={created ? fmt(t.purchasing.draftsCreated, { n: created }) : undefined} />
			<SearchBar action="/purchasing/po" q={q}>
				<select name="status" aria-label={t.purchasing.status}>
					<option value="open">{t.purchasing.statusFilter.open}</option>
					{PO_STATUSES.map((s) => (
						<option value={s} selected={s === status}>
							{t.purchasing.statuses[s]}
						</option>
					))}
					<option value="all" selected={status === "all"}>
						{t.purchasing.statusFilter.all}
					</option>
				</select>
			</SearchBar>
			<div id="results">
				{rows.length === 0 ? (
					<EmptyState icon={icons.receipt} description={t.purchasing.noPos}>
						{canOrder ? (
							<Button href="/purchasing/po/new" variant="outline" icon={icons.plus}>
								{t.purchasing.newPo}
							</Button>
						) : null}
					</EmptyState>
				) : (
					<Card class="gap-0 overflow-hidden py-0">
						<PoTable rows={rows} today={today} />
					</Card>
				)}
			</div>
		</>,
	);
});

/** The PO list as a bare table (or an empty state); callers put it in a card. */
export function PoTable(props: { rows: Awaited<ReturnType<typeof listPos>>; today: string }) {
	const { t, seeCosts } = useApp();
	if (props.rows.length === 0) {
		return (
			<CardEmpty icon={icons.receipt} class="px-0 py-1">
				{t.purchasing.noPos}
			</CardEmpty>
		);
	}
	// The tracking column only when some PO has a shipment.
	const tracking = props.rows.some((po) => po.shipmentCount > 0);
	return (
		<Table>
			<TableHeader>
				<TableRow>
					<TableHead>{t.purchasing.number}</TableHead>
					<TableHead>{t.purchasing.supplier}</TableHead>
					<TableHead>{t.purchasing.status}</TableHead>
					<TableHead>{t.purchasing.expectedAt}</TableHead>
					{tracking ? <TableHead>{t.purchasing.shipments.tracking}</TableHead> : null}
					<TableHead class="text-right">{t.purchasing.lines}</TableHead>
					{seeCosts ? <TableHead class="text-right">{t.purchasing.total}</TableHead> : null}
				</TableRow>
			</TableHeader>
			<TableBody>
				{props.rows.map((po) => {
					const overdue = isOverdue(po.expectedAt, po.status, props.today);
					return (
						<TableRow>
							<TableCell class="font-medium whitespace-nowrap">
								<a href={`/purchasing/po/${po.id}`}>{po.number}</a>
							</TableCell>
							<TableCell>{po.supplierName}</TableCell>
							<TableCell>
								<PoStatusBadge status={po.status} />
							</TableCell>
							<TableCell class="whitespace-nowrap">
								<span class={cn("tabular-nums", overdue && "text-destructive")}>{po.expectedAt ?? ""}</span>
								{overdue ? (
									<Badge variant="destructive" class="ml-2">
										{t.purchasing.overdue}
									</Badge>
								) : null}
							</TableCell>
							{tracking ? (
								<TableCell class="whitespace-nowrap">
									{po.trackingNumber !== null ? (
										<span class="inline-flex items-center gap-2">
											<span class="text-muted-foreground">{po.carrier}</span>
											<TrackingLink number={po.trackingNumber} url={po.trackingUrl ?? ""} />
											{po.shipmentCount > 1 ? (
												<Badge variant="secondary">
													{fmt(t.purchasing.shipments.more, { n: po.shipmentCount - 1 })}
												</Badge>
											) : null}
										</span>
									) : null}
								</TableCell>
							) : null}
							<TableCell class="text-right tabular-nums">{po.lineCount}</TableCell>
							{seeCosts ? (
								<TableCell class="text-right">
									<Money cents={po.totalCents} />
								</TableCell>
							) : null}
						</TableRow>
					);
				})}
			</TableBody>
		</Table>
	);
}

async function supplierOptions(c: Context<AppEnv>) {
	return c.var.db.select({ id: suppliers.id, name: suppliers.name }).from(suppliers).orderBy(asc(suppliers.name));
}

function NewPoForm(props: { values: FormValues; errors: FormErrors; suppliers: { id: number; name: string }[] }) {
	const { t } = useApp();
	const p = { values: props.values, errors: props.errors };
	return (
		<Card class="max-w-3xl">
			<form method="post" action="/purchasing/po" class="flex flex-col gap-6">
				<CardContent>
					<ErrorBanner show={Object.keys(props.errors).length > 0} />
					<FieldGroup>
						<div class="grid gap-4 md:grid-cols-2">
							<SelectField
								name="supplier_id"
								label={t.purchasing.supplier}
								required
								options={[
									{ value: "", label: "—" },
									...props.suppliers.map((s) => ({ value: String(s.id), label: s.name })),
								]}
								{...p}
							/>
							<TextField name="expected_at" label={t.purchasing.expectedAt} type="date" {...p} />
						</div>
						<TextArea name="notes" label={t.common.notes} {...p} />
					</FieldGroup>
				</CardContent>
				<CardFooter class="border-t">
					<Button icon={icons.plus}>{t.common.create}</Button>
					<Button href="/purchasing/po" variant="outline">
						{t.common.cancel}
					</Button>
				</CardFooter>
			</form>
		</Card>
	);
}

purchasingRoutes.get("/po/new", requirePermission("purchasing.order"), async (c) => {
	const t = c.var.t;
	return page(
		c,
		t.purchasing.newPo,
		<>
			<PageHeader title={t.purchasing.newPo} />
			<NewPoForm
				values={{ supplier_id: c.req.query("supplier") ?? "" }}
				errors={{}}
				suppliers={await supplierOptions(c)}
			/>
		</>,
	);
});

purchasingRoutes.post("/po", requirePermission("purchasing.order"), async (c) => {
	const t = c.var.t;
	const db = c.var.db;
	const body = await c.req.parseBody();
	const v = validate(poInput, body);
	const errors: FieldErrors = v.ok ? {} : { ...v.errors };
	const sups = await supplierOptions(c);
	if (v.ok && !sups.some((s) => s.id === v.data.supplier_id)) errors.supplier_id = "required";
	if (!v.ok || Object.keys(errors).length > 0) {
		return page(
			c,
			t.purchasing.newPo,
			<>
				<PageHeader title={t.purchasing.newPo} />
				<NewPoForm values={body as FormValues} errors={translateErrors(c, errors)} suppliers={sups} />
			</>,
			422,
		);
	}
	const user = c.var.user;
	for (let attempt = 0; ; attempt++) {
		try {
			const [number] = await nextPoNumbers(db, 1);
			const { results } = await saveChanges(c, fmt(t.history.summaries.poCreate, { number: number as string }), [
				createPoStatement(
					db,
					{
						number: number as string,
						supplierId: v.data.supplier_id as number,
						expectedAt: v.data.expected_at,
						notes: v.data.notes,
					},
					user,
					nowIso(),
				),
			]);
			return redirectOk(c, `/purchasing/po/${results[0][0]?.id}`, "created");
		} catch (err) {
			if (attempt > 0 || !isConstraintError(err, "UNIQUE")) throw err;
		}
	}
});

// ---------------------------------------------------------------------------
// Purchase order detail

type PoData = NonNullable<Awaited<ReturnType<typeof getPo>>>;
type PoLineRow = Awaited<ReturnType<typeof getPoLines>>[number];

async function loadPo(c: Context<AppEnv>) {
	const id = idParam(c);
	return id ? getPo(c.var.db, id) : undefined;
}

const linesTotal = (lines: PoLineRow[]) =>
	lines.reduce((s, l) => s + lineCostCents(l.line.qtyMilli, l.line.unitPriceCents), 0);

/** Key figures of a PO: line count, total, expected date and how much has arrived. */
function PoStats(props: { po: PoData["po"]; lines: PoLineRow[]; today: string }) {
	const { t, seeCosts } = useApp();
	const { po, lines } = props;
	const ordered = lines.reduce((s, l) => s + l.line.qtyMilli, 0);
	const received = lines.reduce((s, l) => s + Math.min(l.line.receivedQtyMilli, l.line.qtyMilli), 0);
	// Integer floor division, so a nearly complete PO never reads 100 %.
	const pct = ordered > 0 ? (received * 100 - ((received * 100) % ordered)) / ordered : 0;
	const complete = lines.filter((l) => l.line.receivedQtyMilli >= l.line.qtyMilli).length;
	const overdue = isOverdue(po.expectedAt, po.status, props.today);
	return (
		<div class={cn("grid gap-4 sm:grid-cols-2", seeCosts ? "xl:grid-cols-4" : "xl:grid-cols-3")}>
			<StatCard label={t.purchasing.lines} value={lines.length} icon={icons.list} />
			{seeCosts ? (
				<StatCard label={t.purchasing.total} value={<Money cents={linesTotal(lines)} />} icon={icons.coins} />
			) : null}
			<StatCard
				label={t.purchasing.expectedAt}
				value={<span class="whitespace-nowrap">{po.expectedAt ?? t.common.none}</span>}
				icon={icons.calendarClock}
				tone={overdue ? "destructive" : "default"}
				hint={overdue ? <Badge variant="destructive">{t.purchasing.overdue}</Badge> : undefined}
			/>
			<StatCard
				label={t.purchasing.received}
				value={fmt(t.purchasing.percent, { n: pct })}
				icon={icons.packageCheck}
				tone={lines.length > 0 && complete === lines.length ? "success" : "default"}
				hint={fmt(t.purchasing.linesComplete, { done: complete, n: lines.length })}
			/>
		</div>
	);
}

/**
 * Editable lines of a draft PO. Everything inside #po-lines (figures, lines, add-line form) is
 * swapped by htmx after each change, so the totals never go stale.
 */
function DraftLines(props: {
	po: PoData["po"];
	lines: PoLineRow[];
	options: { ref: string; name: string }[];
	/** The options of the part typed on the add-line form, once known. */
	addOptions: OptionDef[];
	values: FormValues;
	errors: FormErrors;
	today: string;
}) {
	const { t, locale } = useApp();
	const { po } = props;
	const hx = { "hx-target": "#po-lines", "hx-select": "#po-lines", "hx-swap": "outerHTML" };
	return (
		<div id="po-lines" class="flex flex-col gap-4">
			<PoStats po={po} lines={props.lines} today={props.today} />
			<Card class="gap-4">
				<CardHeader>
					<CardTitle>{t.purchasing.lines}</CardTitle>
				</CardHeader>
				<CardContent class="px-2">
					{props.lines.length === 0 ? (
						<CardEmpty icon={icons.list} class="px-4">
							{t.purchasing.noLines}
						</CardEmpty>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>{t.purchasing.part}</TableHead>
									<TableHead>
										{/* Same widths as the inputs below, so the labels sit over their fields. */}
										<div class="flex items-center justify-end gap-2">
											<span class="w-24 text-right">{t.purchasing.qty}</span>
											<span class="w-10" />
											<span class="w-28 text-right">{t.purchasing.price}</span>
											<span class="w-(--control-h-sm)" />
										</div>
									</TableHead>
									<TableHead class="text-right">{t.purchasing.lineTotal}</TableHead>
									<TableHead class="w-px">
										<span class="sr-only">{t.common.actions}</span>
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{props.lines.map((l) => (
									<TableRow>
										<PartCell
											id={l.line.partId}
											ref={l.ref}
											name={l.name}
											supplierRef={l.supplierRef}
											values={l.values}
										/>
										<TableCell>
											<form
												method="post"
												action={`/purchasing/po/${po.id}/lines/${l.line.id}`}
												class="flex items-center justify-end gap-2"
												hx-post={`/purchasing/po/${po.id}/lines/${l.line.id}`}
												hx-trigger="change"
												{...hx}
											>
												<input
													type="text"
													name="qty"
													inputmode="decimal"
													class="w-24 text-right tabular-nums"
													value={formatQtyInput(l.line.qtyMilli, locale)}
													aria-label={`${t.purchasing.qty} ${l.ref}`}
													data-select-on-focus
												/>
												<span class="w-10 truncate text-sm text-muted-foreground">
													{l.unit !== "pcs" ? l.unit : ""}
												</span>
												<input
													type="text"
													name="price"
													inputmode="decimal"
													class="w-28 text-right tabular-nums"
													value={formatCentsInput(l.line.unitPriceCents, locale)}
													aria-label={`${t.purchasing.price} ${l.ref}`}
													data-select-on-focus
												/>
												<Button
													variant="outline"
													size="icon-sm"
													icon={icons.check}
													aria-label={t.common.save}
													title={t.common.save}
												/>
												{l.options.length ? (
													<span class="flex basis-full flex-wrap justify-end gap-2">
														{l.options.map((o) => (
															<select
																name={`option:${o.id}`}
																data-slot="native-select"
																class="h-(--control-h-sm) w-auto py-0 text-sm"
																aria-label={`${o.name} ${l.ref}`}
															>
																{o.values.map((v) => (
																	<option
																		value={String(v.id)}
																		selected={(l.line.optionValues ?? "").split(",").includes(String(v.id))}
																	>
																		{`${o.name}: ${v.name}`}
																	</option>
																))}
															</select>
														))}
													</span>
												) : null}
											</form>
										</TableCell>
										<TableCell class="text-right">
											<Money cents={lineCostCents(l.line.qtyMilli, l.line.unitPriceCents)} />
										</TableCell>
										<TableCell class="w-px">
											<form
												method="post"
												action={`/purchasing/po/${po.id}/lines/${l.line.id}/delete`}
												class="inline"
												hx-post={`/purchasing/po/${po.id}/lines/${l.line.id}/delete`}
												{...hx}
											>
												<Button
													variant="destructive"
													size="icon-sm"
													icon={icons.trash}
													aria-label={t.assemblies.remove}
													title={t.assemblies.remove}
												/>
											</form>
										</TableCell>
									</TableRow>
								))}
							</TableBody>
							<TableFooter>
								<TableRow>
									<TableCell colspan={2}>{t.purchasing.total}</TableCell>
									<TableCell class="text-right">
										<Money cents={linesTotal(props.lines)} />
									</TableCell>
									<TableCell />
								</TableRow>
							</TableFooter>
						</Table>
					)}
				</CardContent>
				<CardFooter class="border-t">
					<form
						method="post"
						action={`/purchasing/po/${po.id}/lines`}
						class="w-full"
						hx-post={`/purchasing/po/${po.id}/lines`}
						{...hx}
					>
						<ErrorBanner show={Object.keys(props.errors).length > 0} />
						<div class="grid gap-4 md:grid-cols-[2fr_1fr_1fr_auto] md:items-start">
							<PartPicker
								name="part"
								label={t.purchasing.part}
								listId="po-parts"
								options={props.options}
								required
								values={props.values}
								errors={props.errors}
							/>
							<TextField
								name="qty"
								label={t.purchasing.qty}
								inputmode="decimal"
								required
								values={props.values}
								errors={props.errors}
							/>
							<TextField
								name="price"
								label={t.purchasing.price}
								hint={t.purchasing.priceHint}
								inputmode="decimal"
								values={props.values}
								errors={props.errors}
							/>
							<div class="flex flex-col gap-2">
								{/* Takes the height of a field label, so the button lines up with the inputs. */}
								<span aria-hidden="true" class="hidden text-sm leading-snug select-none md:block">
									{" "}
								</span>
								<Button icon={icons.plus}>{t.purchasing.addLine}</Button>
							</div>
							<LineOptions poId={po.id} options={props.addOptions} values={props.values} errors={props.errors} />
						</div>
					</form>
					<PartPickerDialog name="part" scope={{ kinds: ["buy", "make"] }} />
				</CardFooter>
			</Card>
		</div>
	);
}

function ReceiveForm(props: { po: PoData["po"]; lines: PoLineRow[]; values: FormValues; errors: FieldErrors }) {
	const { t, locale } = useApp();
	const { po } = props;
	const hasErrors = Object.keys(props.errors).length > 0;
	return (
		<Card>
			<form method="post" action={`/purchasing/po/${po.id}/receive`} class="flex flex-col gap-6" id="receive">
				<CardHeader>
					<CardTitle class="flex items-center gap-2">
						<Icon icon={icons.truck} class="size-4 text-muted-foreground" />
						{t.purchasing.receiveTitle}
					</CardTitle>
					<CardDescription>{t.purchasing.receiveIntro}</CardDescription>
				</CardHeader>
				<CardContent class="px-2">
					{hasErrors ? (
						<div class="px-4">
							<ErrorBanner show />
							{props.errors._ ? <Alert variant="destructive">{errorText(t, props.errors._)}</Alert> : null}
						</div>
					) : null}
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>{t.purchasing.part}</TableHead>
								<TableHead class="text-right">{t.purchasing.qty}</TableHead>
								<TableHead class="text-right">{t.purchasing.received}</TableHead>
								<TableHead class="text-right">{t.purchasing.receiveNow}</TableHead>
								<TableHead>{t.purchasing.serials}</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{props.lines.map((l) => {
								const remaining = Math.max(0, l.line.qtyMilli - l.line.receivedQtyMilli);
								const qtyName = receiveQtyField(l.line.id);
								const serialName = receiveSerialsField(l.line.id);
								const qtyError = props.errors[qtyName];
								const serialError = props.errors[serialName];
								return (
									<TableRow>
										<PartCell id={l.line.partId} ref={l.ref} name={l.name} values={l.values} />
										<TableCell class="text-right">
											<Qty milli={l.line.qtyMilli} unit={l.unit} />
										</TableCell>
										<TableCell class="text-right">
											<Qty milli={l.line.receivedQtyMilli} unit={l.unit} />
										</TableCell>
										<TableCell>
											<div class="flex flex-col items-end gap-1">
												<input
													type="text"
													name={qtyName}
													inputmode="decimal"
													class="w-28 text-right tabular-nums"
													value={props.values[qtyName] ?? (remaining ? formatQtyInput(remaining, locale) : "")}
													aria-label={`${t.purchasing.receiveNow} ${l.ref}`}
													aria-invalid={qtyError ? "true" : undefined}
													aria-describedby={qtyError ? `e-${qtyName}` : undefined}
													data-select-on-focus
												/>
												{qtyError ? (
													<p id={`e-${qtyName}`} class="text-sm text-destructive">
														{errorText(t, qtyError)}
													</p>
												) : null}
											</div>
										</TableCell>
										<TableCell>
											{l.trackSerial ? (
												<div class="flex flex-col gap-1">
													<textarea
														name={serialName}
														rows={2}
														class="min-h-16 min-w-48"
														aria-label={`${t.purchasing.serials} ${l.ref}`}
														aria-invalid={serialError ? "true" : undefined}
														aria-describedby={serialError ? `e-${serialName}` : undefined}
													>
														{props.values[serialName] ?? ""}
													</textarea>
													{serialError ? (
														<p id={`e-${serialName}`} class="text-sm text-destructive">
															{errorText(t, serialError, { n: props.values[qtyName] ?? "" })}
														</p>
													) : null}
												</div>
											) : null}
										</TableCell>
									</TableRow>
								);
							})}
						</TableBody>
					</Table>
				</CardContent>
				<CardFooter class="border-t">
					<Button size="lg" icon={icons.packageCheck}>
						{t.purchasing.postReceipt}
					</Button>
				</CardFooter>
			</form>
		</Card>
	);
}

function ReadOnlyLines(props: { lines: PoLineRow[] }) {
	const { t, seeCosts } = useApp();
	return (
		<Card class="gap-4">
			<CardHeader>
				<CardTitle>{t.purchasing.lines}</CardTitle>
				<CardDescription>{t.purchasing.draftOnly}</CardDescription>
			</CardHeader>
			<CardContent class="px-2">
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>{t.purchasing.part}</TableHead>
							<TableHead class="text-right">{t.purchasing.qty}</TableHead>
							<TableHead class="text-right">{t.purchasing.received}</TableHead>
							{seeCosts ? (
								<>
									<TableHead class="text-right">{t.purchasing.price}</TableHead>
									<TableHead class="text-right">{t.purchasing.lineTotal}</TableHead>
								</>
							) : null}
						</TableRow>
					</TableHeader>
					<TableBody>
						{props.lines.map((l) => (
							<TableRow>
								<PartCell id={l.line.partId} ref={l.ref} name={l.name} supplierRef={l.supplierRef} values={l.values} />
								<TableCell class="text-right">
									<Qty milli={l.line.qtyMilli} unit={l.unit} />
								</TableCell>
								<TableCell
									class={cn("text-right", l.line.receivedQtyMilli >= l.line.qtyMilli && "font-medium text-success")}
								>
									<Qty milli={l.line.receivedQtyMilli} unit={l.unit} />
								</TableCell>
								{seeCosts ? (
									<>
										<TableCell class="text-right">
											<Money cents={l.line.unitPriceCents} />
										</TableCell>
										<TableCell class="text-right">
											<Money cents={lineCostCents(l.line.qtyMilli, l.line.unitPriceCents)} />
										</TableCell>
									</>
								) : null}
							</TableRow>
						))}
					</TableBody>
					{seeCosts ? (
						<TableFooter>
							<TableRow>
								<TableCell colspan={4}>{t.purchasing.total}</TableCell>
								<TableCell class="text-right">
									<Money cents={linesTotal(props.lines)} />
								</TableCell>
							</TableRow>
						</TableFooter>
					) : null}
				</Table>
			</CardContent>
		</Card>
	);
}

/** Expected date and notes, folded away (a <details> styled as a card) until needed. */
function EditPo(props: { po: PoData["po"] }) {
	const { t } = useApp();
	const { po } = props;
	return (
		<CollapsibleCard title={t.purchasing.editDetails} icon={icons.pencil}>
			<form method="post" action={`/purchasing/po/${po.id}`} class="flex flex-col gap-6">
				<FieldGroup>
					<div class="grid gap-4 md:grid-cols-2">
						<TextField
							name="expected_at"
							label={t.purchasing.expectedAt}
							type="date"
							values={{ expected_at: po.expectedAt ?? "" }}
							errors={{}}
						/>
					</div>
					<TextArea name="notes" label={t.common.notes} values={{ notes: po.notes }} errors={{}} />
				</FieldGroup>
				<div class="flex flex-wrap items-center gap-2">
					<Button icon={icons.save}>{t.common.save}</Button>
				</div>
			</form>
		</CollapsibleCard>
	);
}

/** A tracking number, linked to the carrier's page when the shipment has one (opened in a new tab). */
function TrackingLink(props: { number: string; url: string }) {
	const { t } = useApp();
	if (!props.url) return <span class="font-medium">{props.number}</span>;
	return (
		<a
			href={props.url}
			target="_blank"
			rel="noopener noreferrer"
			title={t.purchasing.shipments.openTracking}
			class="inline-flex items-center gap-1.5 font-medium underline-offset-4 hover:underline"
		>
			{props.number}
			<Icon icon={icons.externalLink} class="size-3.5 text-muted-foreground" />
		</a>
	);
}

/**
 * The parcels of a PO and, for planners on a sent or received PO, the form to add one or to edit the one chosen
 * with ?shipment=<id> (D168).
 */
function ShipmentsCard(props: {
	po: PoData["po"];
	shipments: PoShipment[];
	canEdit: boolean;
	editing: PoShipment | undefined;
	carriers: string[];
	values: FormValues;
	errors: FormErrors;
}) {
	const { t } = useApp();
	const ts = t.purchasing.shipments;
	const { po, editing } = props;
	const base = `/purchasing/po/${po.id}`;
	return (
		<Card id="shipments" class="gap-4">
			<CardHeader>
				<CardTitle>{ts.title}</CardTitle>
				<CardDescription>{ts.intro}</CardDescription>
			</CardHeader>
			<CardContent class="px-2">
				{props.shipments.length === 0 ? (
					<p class="px-4 text-sm text-muted-foreground">{ts.none}</p>
				) : (
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>{ts.carrier}</TableHead>
								<TableHead>{ts.trackingNumber}</TableHead>
								<TableHead>{ts.shippedAt}</TableHead>
								<TableHead>{t.common.notes}</TableHead>
								{props.canEdit ? (
									<TableHead class="w-px">
										<span class="sr-only">{t.common.actions}</span>
									</TableHead>
								) : null}
							</TableRow>
						</TableHeader>
						<TableBody>
							{props.shipments.map((s) => (
								<TableRow data-state={editing?.id === s.id ? "selected" : undefined}>
									<TableCell>{s.carrier}</TableCell>
									<TableCell class="whitespace-nowrap">
										<TrackingLink number={s.trackingNumber} url={s.trackingUrl} />
									</TableCell>
									<TableCell class="whitespace-nowrap tabular-nums">{s.shippedAt ?? ""}</TableCell>
									<TableCell class="text-muted-foreground">{s.notes}</TableCell>
									{props.canEdit ? (
										<TableCell class="w-px">
											<div class="flex items-center justify-end gap-1">
												<Button
													href={`${base}?shipment=${s.id}#shipments`}
													variant="ghost"
													size="icon-sm"
													icon={icons.pencil}
													aria-label={`${t.common.edit} ${s.trackingNumber}`}
													title={t.common.edit}
												/>
												<form
													method="post"
													action={`${base}/shipments/${s.id}/delete`}
													class="inline"
													data-confirm={fmt(ts.confirmRemove, { tracking: s.trackingNumber })}
												>
													<Button
														variant="ghost"
														size="icon-sm"
														icon={icons.trash}
														aria-label={`${ts.remove} ${s.trackingNumber}`}
														title={ts.remove}
													/>
												</form>
											</div>
										</TableCell>
									) : null}
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
			</CardContent>
			{props.canEdit ? (
				<CardFooter class="border-t">
					<form
						method="post"
						action={editing ? `${base}/shipments/${editing.id}` : `${base}/shipments`}
						class="flex w-full flex-col gap-4"
					>
						{editing ? (
							<h3 class="text-sm font-medium">{fmt(ts.editTitle, { tracking: editing.trackingNumber })}</h3>
						) : null}
						<ErrorBanner show={Object.keys(props.errors).length > 0} />
						<div class="grid gap-4 md:grid-cols-2">
							<TextField
								name="carrier"
								label={ts.carrier}
								list="carriers"
								required
								values={props.values}
								errors={props.errors}
							/>
							<TextField
								name="tracking_number"
								label={ts.trackingNumber}
								required
								values={props.values}
								errors={props.errors}
							/>
							<TextField
								name="tracking_url"
								label={ts.trackingUrl}
								type="url"
								hint={ts.trackingUrlHint}
								values={props.values}
								errors={props.errors}
							/>
							<TextField
								name="shipped_at"
								label={ts.shippedAt}
								type="date"
								values={props.values}
								errors={props.errors}
							/>
							<div class="md:col-span-2">
								<TextField name="shipment_notes" label={t.common.notes} values={props.values} errors={props.errors} />
							</div>
						</div>
						<datalist id="carriers">
							{props.carriers.map((name) => (
								<option value={name} />
							))}
						</datalist>
						<div class="flex flex-wrap items-center gap-2">
							{editing ? (
								<>
									<Button icon={icons.save}>{t.common.save}</Button>
									<Button href={`${base}#shipments`} variant="outline">
										{t.common.cancel}
									</Button>
								</>
							) : (
								<Button icon={icons.plus}>{ts.add}</Button>
							)}
						</div>
					</form>
				</CardFooter>
			) : null}
		</Card>
	);
}

async function renderPo(
	c: Context<AppEnv>,
	data: PoData,
	form: {
		lineValues?: FormValues;
		lineErrors?: FieldErrors;
		lineVars?: Record<string, string>;
		receiveValues?: FormValues;
		receiveErrors?: FieldErrors;
		/** The shipment form as posted, with its errors; `shipmentId` when it edited one. */
		shipmentValues?: FormValues;
		shipmentErrors?: FieldErrors;
		shipmentId?: number;
	} = {},
	status: 200 | 422 = 200,
) {
	const t = c.var.t;
	const db = c.var.db;
	const { po, supplier } = data;
	const typed = (form.lineValues?.part ?? "").trim();
	const [lines, shipments, carriers, options, addPart] = await Promise.all([
		getPoLines(db, po.id),
		getPoShipments(db, po.id),
		knownCarriers(db),
		db
			.select({ ref: parts.ref, name: parts.name })
			.from(parts)
			.where(and(eq(parts.archived, false), inArray(parts.kind, ["buy", "make"])))
			.orderBy(asc(parts.ref)),
		typed ? db.select({ id: parts.id }).from(parts).where(eq(parts.ref, typed)).limit(1) : Promise.resolve([]),
	]);
	const addOptions = addPart[0] ? await optionsOf(db, addPart[0].id) : [];
	const ok = c.req.query("ok");
	const flash = ok
		? (
				{
					received: t.purchasing.receivedOk,
					sent: t.purchasing.sentOk,
					cancelled: t.purchasing.cancelledOk,
					created: t.purchasing.createdOk,
					closed: t.purchasing.closedOk,
					shipment_saved: t.purchasing.shipments.savedOk,
					shipment_removed: t.purchasing.shipments.removedOk,
				} as Record<string, string>
			)[ok]
		: undefined;
	const err = c.req.query("err");
	const today = nowIso().slice(0, 10);
	const isDraft = po.status === "draft";
	// Planners edit, send, cancel and close orders; operators only receive them.
	const canEdit = can(c.var, "purchasing.order");
	const canReceive = can(c.var, "purchasing.receive") && RECEIVABLE_PO_STATUSES.includes(po.status) && lines.length > 0;
	const anyReceived = lines.some((l) => l.line.receivedQtyMilli > 0);
	const canShip = canEdit && SHIPPING_PO_STATUSES.includes(po.status);
	const editingId = form.shipmentId ?? Number(c.req.query("shipment") ?? Number.NaN);
	const editing = canShip ? shipments.find((s) => s.id === editingId) : undefined;
	return page(
		c,
		`${po.number} · ${supplier.name}`,
		<>
			<PageHeader
				title={`${po.number} · ${supplier.name}`}
				subtitle={
					<span class="flex flex-wrap items-center gap-x-3 gap-y-1">
						<PoStatusBadge status={po.status} />
						{po.sentAt ? (
							<span>
								{t.purchasing.sentAt}: {po.sentAt.slice(0, 10)}
							</span>
						) : null}
						{supplier.email ? (
							<a
								href={`mailto:${supplier.email}`}
								class="inline-flex items-center gap-1.5 underline-offset-4 hover:underline"
							>
								<Icon icon={icons.mail} class="size-3.5" />
								{supplier.email}
							</a>
						) : null}
					</span>
				}
				actions={
					<>
						{can(c.var, "costs.view") ? (
							<Button
								href={`/purchasing/po/${po.id}/export.csv`}
								variant="outline"
								icon={icons.fileSpreadsheet}
								title={t.purchasing.downloadCsv}
							>
								{t.purchasing.exportCsv}
							</Button>
						) : null}
						{canReceive ? (
							<Button href="#receive" variant={isDraft ? "outline" : "default"} icon={icons.truck}>
								{t.purchasing.receive}
							</Button>
						) : null}
						{canEdit && isDraft ? (
							<PostButton
								action={`/purchasing/po/${po.id}/send`}
								label={t.purchasing.markSent}
								variant="default"
								icon={icons.send}
							/>
						) : null}
						<MoreMenu
							items={[
								canEdit &&
									(po.status === "draft" || po.status === "sent") &&
									!anyReceived && {
										label: t.purchasing.cancelPo,
										icon: icons.ban,
										action: `/purchasing/po/${po.id}/cancel`,
										confirm: t.purchasing.confirmCancel,
										destructive: true,
									},
								canEdit &&
									(po.status === "sent" || po.status === "partial") && {
										label: t.purchasing.closePo,
										icon: icons.circleCheck,
										action: `/purchasing/po/${po.id}/close`,
										confirm: t.purchasing.confirmClose,
									},
								can(c.var, "purchasing.delete") &&
									isDraft && {
										label: t.common.delete,
										icon: icons.trash,
										action: `/purchasing/po/${po.id}/delete`,
										confirm: t.common.confirmDelete,
										destructive: true,
									},
							]}
						/>
					</>
				}
			/>
			<PurchasingTabs active="pos" />
			<RecordTabs base={`/purchasing/po/${po.id}`} active="overview" />
			<Flash ok={ok} message={flash} />
			{err ? <Alert variant="destructive">{errorText(t, err)}</Alert> : null}
			<div class="flex flex-col gap-4">
				{isDraft && canEdit ? (
					<DraftLines
						po={po}
						lines={lines}
						options={options}
						addOptions={addOptions}
						values={form.lineValues ?? {}}
						errors={translateErrors(c, form.lineErrors ?? {}, form.lineVars)}
						today={today}
					/>
				) : (
					<>
						<PoStats po={po} lines={lines} today={today} />
						<ReadOnlyLines lines={lines} />
					</>
				)}
				{canShip || shipments.length > 0 ? (
					<ShipmentsCard
						po={po}
						shipments={shipments}
						canEdit={canShip}
						editing={editing}
						carriers={carriers}
						values={form.shipmentValues ?? (editing ? shipmentFormValues(editing) : {})}
						errors={translateErrors(c, form.shipmentErrors ?? {})}
					/>
				) : null}
				{canReceive ? (
					<ReceiveForm po={po} lines={lines} values={form.receiveValues ?? {}} errors={form.receiveErrors ?? {}} />
				) : null}
				{po.notes ? (
					<Card class="gap-3">
						<CardHeader>
							<CardTitle>{t.common.notes}</CardTitle>
						</CardHeader>
						<CardContent>
							<p class="text-sm whitespace-pre-wrap">{po.notes}</p>
						</CardContent>
					</Card>
				) : null}
				{canEdit && po.status !== "cancelled" ? <EditPo po={po} /> : null}
			</div>
		</>,
		status,
	);
}

purchasingRoutes.get("/po/:id", async (c) => {
	const data = await loadPo(c);
	if (!data) return notFound(c);
	return renderPo(c, data);
});

purchasingRoutes.get("/po/:id/history", async (c) => {
	const data = await loadPo(c);
	if (!data) return notFound(c);
	const title = `${data.po.number} · ${data.supplier.name}`;
	const header = (
		<>
			<PageHeader title={title} subtitle={<PoStatusBadge status={data.po.status} />} />
			<PurchasingTabs active="pos" />
			<RecordTabs base={`/purchasing/po/${data.po.id}`} active="history" />
		</>
	);
	return recordHistoryPage(c, title, header, { kind: "po", id: data.po.id });
});

purchasingRoutes.post("/po/:id", requirePermission("purchasing.order"), async (c) => {
	const data = await loadPo(c);
	if (!data) return notFound(c);
	const v = validate(poEditInput, await c.req.parseBody());
	if (v.ok) {
		await saveChanges(c, fmt(c.var.t.history.summaries.poEdit, { number: data.po.number }), [
			updatePoStatement(
				c.var.db,
				data.po.id,
				{ expectedAt: v.data.expected_at, notes: v.data.notes },
				c.var.user,
				nowIso(),
			),
		]);
	}
	return redirectOk(c, `/purchasing/po/${data.po.id}`);
});

/** The shipment of the PO named by :shipmentId, with the PO and its other shipments. */
async function loadShipment(c: Context<AppEnv>) {
	const data = await loadPo(c);
	const shipmentId = idParam(c, "shipmentId");
	if (!data || !shipmentId) return undefined;
	const shipments = await getPoShipments(c.var.db, data.po.id);
	const shipment = shipments.find((s) => s.id === shipmentId);
	return shipment ? { ...data, shipments, shipment } : undefined;
}

/** Validates a posted shipment form against the PO's rules; `selfId` when it edits that shipment. */
async function shipmentForm(c: Context<AppEnv>, data: PoData, shipments: PoShipment[], selfId?: number) {
	const body = await c.req.parseBody();
	const v = validate(shipmentInput, body);
	const errors: FieldErrors = v.ok ? shipmentRuleErrors(data.po, shipments, v.data.tracking_number, selfId) : v.errors;
	return { body: body as FormValues, values: v.ok ? shipmentValues(v.data) : undefined, errors };
}

const shipmentsHref = (poId: number, ok: string) => `/purchasing/po/${poId}?ok=${ok}#shipments`;

purchasingRoutes.post("/po/:id/shipments", requirePermission("purchasing.order"), async (c) => {
	const data = await loadPo(c);
	if (!data) return notFound(c);
	if (!SHIPPING_PO_STATUSES.includes(data.po.status))
		return c.redirect(`/purchasing/po/${data.po.id}?err=po_no_shipments`, 303);
	const f = await shipmentForm(c, data, await getPoShipments(c.var.db, data.po.id));
	if (!f.values || Object.keys(f.errors).length)
		return renderPo(c, data, { shipmentValues: f.body, shipmentErrors: f.errors }, 422);
	await saveChanges(
		c,
		fmt(c.var.t.history.summaries.poShipmentAdd, { tracking: f.values.trackingNumber, number: data.po.number }),
		[addShipmentStatement(c.var.db, data.po.id, f.values, c.var.user, nowIso())],
	);
	return c.redirect(shipmentsHref(data.po.id, "shipment_saved"), 303);
});

purchasingRoutes.post("/po/:id/shipments/:shipmentId", requirePermission("purchasing.order"), async (c) => {
	const data = await loadShipment(c);
	if (!data) return notFound(c);
	if (!SHIPPING_PO_STATUSES.includes(data.po.status))
		return c.redirect(`/purchasing/po/${data.po.id}?err=po_no_shipments`, 303);
	const f = await shipmentForm(c, data, data.shipments, data.shipment.id);
	if (!f.values || Object.keys(f.errors).length)
		return renderPo(c, data, { shipmentValues: f.body, shipmentErrors: f.errors, shipmentId: data.shipment.id }, 422);
	await saveChanges(
		c,
		fmt(c.var.t.history.summaries.poShipmentEdit, { tracking: f.values.trackingNumber, number: data.po.number }),
		[updateShipmentStatement(c.var.db, data.po.id, data.shipment.id, f.values, c.var.user, nowIso())],
	);
	return c.redirect(shipmentsHref(data.po.id, "shipment_saved"), 303);
});

purchasingRoutes.post("/po/:id/shipments/:shipmentId/delete", requirePermission("purchasing.order"), async (c) => {
	const data = await loadShipment(c);
	if (!data) return notFound(c);
	if (!SHIPPING_PO_STATUSES.includes(data.po.status))
		return c.redirect(`/purchasing/po/${data.po.id}?err=po_no_shipments`, 303);
	await saveChanges(
		c,
		fmt(c.var.t.history.summaries.poShipmentRemove, {
			tracking: data.shipment.trackingNumber,
			number: data.po.number,
		}),
		[deleteShipmentStatement(c.var.db, data.po.id, data.shipment.id)],
	);
	return c.redirect(shipmentsHref(data.po.id, "shipment_removed"), 303);
});

purchasingRoutes.post("/po/:id/lines", requirePermission("purchasing.order"), async (c) => {
	const data = await loadPo(c);
	if (!data) return notFound(c);
	const db = c.var.db;
	const body = await c.req.parseBody();
	if (data.po.status !== "draft") return c.redirect(`/purchasing/po/${data.po.id}?err=po_not_draft`, 303);
	const v = validate(poLineInput, body);
	const errors: FieldErrors = v.ok ? {} : { ...v.errors };
	const vars: Record<string, string> = {};
	let part: typeof parts.$inferSelect | undefined;
	if (v.ok) {
		part = (await db.select().from(parts).where(eq(parts.ref, v.data.part)).limit(1))[0];
		if (!part) {
			errors.part = "unknown_part";
			vars.ref = v.data.part;
		} else if (part.kind !== "buy" && part.kind !== "make") {
			errors.part = "not_stocked";
			vars.kind = part.kind;
		}
	}
	// A part with options is ordered in one value of each (D191).
	const partOptionDefs = part ? await optionsOf(db, part.id) : [];
	const chosen = keyFromForm(partOptionDefs, body);
	if (part && chosen.missing) {
		errors[`option:${chosen.missing.id}`] = "option_value_required";
		vars.option = chosen.missing.name;
	}
	if (!v.ok || !part || Object.keys(errors).length) {
		return renderPo(c, data, { lineValues: body as FormValues, lineErrors: errors, lineVars: vars }, 422);
	}
	const unitPriceCents =
		v.data.price ?? poUnitPrice((await getOffer(db, part.id, data.po.supplierId))?.priceCents, part.costCents);
	await saveChanges(c, fmt(c.var.t.history.summaries.poLineAdd, { ref: part.ref, number: data.po.number }), [
		addPoLineStatement(
			db,
			data.po.id,
			{ partId: part.id, qtyMilli: v.data.qty, unitPriceCents, optionValues: chosen.key },
			c.var.user,
			nowIso(),
		),
	]);
	return c.redirect(`/purchasing/po/${data.po.id}`, 303);
});

/** The option selects for the part typed on the add-line form (htmx; without it, a refused submit shows them). */
purchasingRoutes.get("/po/:id/line-options", requirePermission("purchasing.order"), async (c) => {
	const id = idParam(c);
	const ref = (c.req.query("part") ?? "").trim();
	const part = ref ? (await c.var.db.select().from(parts).where(eq(parts.ref, ref)).limit(1))[0] : undefined;
	return fragment(
		c,
		<LineOptions poId={id ?? 0} options={part ? await optionsOf(c.var.db, part.id) : []} values={{}} errors={{}} />,
	);
});

async function partRef(c: Context<AppEnv>, partId: number): Promise<string> {
	const rows = await c.var.db.select({ ref: parts.ref }).from(parts).where(eq(parts.id, partId)).limit(1);
	return rows[0]?.ref ?? `#${partId}`;
}

async function draftLine(c: Context<AppEnv>) {
	const data = await loadPo(c);
	const lineId = idParam(c, "lineId");
	if (!data || !lineId) return undefined;
	const line = (
		await c.var.db
			.select()
			.from(poLines)
			.where(and(eq(poLines.id, lineId), eq(poLines.poId, data.po.id)))
			.limit(1)
	)[0];
	return line ? { ...data, line } : undefined;
}

purchasingRoutes.post("/po/:id/lines/:lineId", requirePermission("purchasing.order"), async (c) => {
	const data = await draftLine(c);
	if (!data) return notFound(c);
	if (data.po.status !== "draft") return c.redirect(`/purchasing/po/${data.po.id}?err=po_not_draft`, 303);
	const body = await c.req.parseBody();
	const qty = parseMilli(typeof body.qty === "string" ? body.qty : "");
	const price = parseCents(typeof body.price === "string" ? body.price : "");
	if (qty === null || qty <= 0) return c.redirect(`/purchasing/po/${data.po.id}?err=invalid_quantity`, 303);
	if (price === null || price < 0) return c.redirect(`/purchasing/po/${data.po.id}?err=invalid_money`, 303);
	// Its values can change while it is a draft; a part with options keeps one value of each (D191).
	const partOptionDefs = await optionsOf(c.var.db, data.line.partId);
	const chosen = keyFromForm(partOptionDefs, body);
	const optionValues = partOptionDefs.length && !chosen.missing ? chosen.key : data.line.optionValues;
	await saveChanges(
		c,
		fmt(c.var.t.history.summaries.poLineEdit, { ref: await partRef(c, data.line.partId), number: data.po.number }),
		[
			updatePoLineStatement(
				c.var.db,
				data.po.id,
				data.line.id,
				{ qtyMilli: qty, unitPriceCents: price, optionValues },
				c.var.user,
				nowIso(),
			),
		],
	);
	return c.redirect(`/purchasing/po/${data.po.id}`, 303);
});

purchasingRoutes.post("/po/:id/lines/:lineId/delete", requirePermission("purchasing.order"), async (c) => {
	const data = await draftLine(c);
	if (!data) return notFound(c);
	if (data.po.status !== "draft") return c.redirect(`/purchasing/po/${data.po.id}?err=po_not_draft`, 303);
	await saveChanges(
		c,
		fmt(c.var.t.history.summaries.poLineDelete, { ref: await partRef(c, data.line.partId), number: data.po.number }),
		[deletePoLineStatement(c.var.db, data.po.id, data.line.id)],
	);
	return c.redirect(`/purchasing/po/${data.po.id}`, 303);
});

purchasingRoutes.post("/po/:id/send", requirePermission("purchasing.order"), async (c) => {
	const data = await loadPo(c);
	if (!data) return notFound(c);
	const lines = await getPoLines(c.var.db, data.po.id);
	if (lines.length === 0) return c.redirect(`/purchasing/po/${data.po.id}?err=po_empty`, 303);
	await saveChanges(c, fmt(c.var.t.history.summaries.poSend, { number: data.po.number }), [
		sendPoStatement(c.var.db, data.po.id, c.var.user, nowIso()),
	]);
	return redirectOk(c, `/purchasing/po/${data.po.id}`, "sent");
});

purchasingRoutes.post("/po/:id/cancel", requirePermission("purchasing.order"), async (c) => {
	const data = await loadPo(c);
	if (!data) return notFound(c);
	const lines = await getPoLines(c.var.db, data.po.id);
	if (lines.some((l) => l.line.receivedQtyMilli > 0)) {
		return c.redirect(`/purchasing/po/${data.po.id}?err=po_has_receipts`, 303);
	}
	await saveChanges(c, fmt(c.var.t.history.summaries.poCancel, { number: data.po.number }), [
		cancelPoStatement(c.var.db, data.po.id, c.var.user, nowIso()),
	]);
	return redirectOk(c, `/purchasing/po/${data.po.id}`, "cancelled");
});

/** Closes a short-shipped PO: the remaining quantities are no longer expected (no stock move). */
purchasingRoutes.post("/po/:id/close", requirePermission("purchasing.order"), async (c) => {
	const data = await loadPo(c);
	if (!data) return notFound(c);
	await saveChanges(c, fmt(c.var.t.history.summaries.poClose, { number: data.po.number }), [
		closePoStatement(c.var.db, data.po.id, c.var.user, nowIso()),
	]);
	return redirectOk(c, `/purchasing/po/${data.po.id}`, "closed");
});

purchasingRoutes.post("/po/:id/delete", requirePermission("purchasing.delete"), async (c) => {
	const data = await loadPo(c);
	if (!data) return notFound(c);
	if (data.po.status !== "draft") return c.redirect(`/purchasing/po/${data.po.id}?err=po_not_draft`, 303);
	await saveChanges(c, fmt(c.var.t.history.summaries.poDelete, { number: data.po.number }), [
		deletePoStatement(c.var.db, data.po.id),
	]);
	return c.redirect("/purchasing/po?ok=deleted", 303);
});

purchasingRoutes.post("/po/:id/receive", requirePermission("purchasing.receive"), async (c) => {
	const data = await loadPo(c);
	if (!data) return notFound(c);
	const db = c.var.db;
	if (!RECEIVABLE_PO_STATUSES.includes(data.po.status)) {
		return c.redirect(`/purchasing/po/${data.po.id}?err=po_not_receivable`, 303);
	}
	const body = await c.req.parseBody();
	const values: FormValues = {};
	for (const [k, v] of Object.entries(body)) if (typeof v === "string") values[k] = v;
	const { receipts, errors } = planReceipts(await getPoLines(db, data.po.id), values);
	if (Object.keys(errors).length > 0) {
		return renderPo(c, data, { receiveValues: values, receiveErrors: errors }, 422);
	}
	await saveChanges(
		c,
		fmt(c.var.t.history.summaries.poReceive, { number: data.po.number }),
		receiptStatements(db, data.po, receipts, c.var.user, nowIso()),
	);
	return redirectOk(c, `/purchasing/po/${data.po.id}`, "received");
});

purchasingRoutes.get("/po/:id/export.csv", requirePermission("costs.view"), async (c) => {
	const data = await loadPo(c);
	if (!data) return notFound(c);
	const locale = c.var.locale;
	const lines = await getPoLines(c.var.db, data.po.id);
	return csvResponse(c, `${data.po.number}.csv`, [
		["supplier_ref", "ref", "name", "qty", "unit", "unit_price", "line_total", "options"],
		...lines.map((l) => [
			l.supplierRef,
			l.ref,
			l.name,
			formatQtyInput(l.line.qtyMilli, locale),
			l.unit,
			formatCentsInput(l.line.unitPriceCents, locale),
			formatCentsInput(lineCostCents(l.line.qtyMilli, l.line.unitPriceCents), locale),
			keyText(l.options, l.line.optionValues),
		]),
	]);
});
