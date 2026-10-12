import { and, asc, eq, inArray } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { PO_STATUSES, type PoStatus, parts, poLines, purchaseOrders, suppliers } from "../db/schema";
import { getOffer, poUnitPrice } from "../domain/offers";
import {
	computeShortages,
	draftPoStatements,
	getPo,
	getPoLines,
	listPos,
	nextPoNumbers,
	OPEN_PO_STATUSES,
	planDraftOrders,
	poEditInput,
	poInput,
	poLineInput,
	RECEIVABLE_PO_STATUSES,
	type Receipt,
	receiptStatements,
	type ShortageLine,
	type ShortageOffer,
	type Shortages,
	type SupplierGroup,
} from "../domain/purchasing";
import { errorText, fmt } from "../i18n";
import { cn } from "../lib/cn";
import { runBatch } from "../lib/db";
import { isConstraintError } from "../lib/sql";
import {
	formatCentsInput,
	formatMoney,
	formatQty,
	formatQtyInput,
	lineCostCents,
	MILLI,
	parseCents,
	parseMilli,
} from "../lib/units";
import { type FieldErrors, validate } from "../lib/validation";
import { requireAdmin } from "../middleware/auth";
import type { AppEnv } from "../types";
import { type AppView, useApp } from "../views/context";
import { Icon, icons } from "../views/icons";
import { idParam, notFound, nowIso, page, redirectOk, translateErrors } from "../views/render";
import {
	Alert,
	Badge,
	Button,
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
	CollapsibleCard,
	Empty,
	EmptyState,
	ErrorBanner,
	FieldGroup,
	Flash,
	type FormErrors,
	type FormValues,
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
} from "../views/ui";

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
function PartCell(props: { id: number; ref: string; name: string; supplierRef?: string | null }) {
	return (
		<TableCell class="min-w-44">
			<span class="whitespace-nowrap">
				<a href={`/parts/${props.id}`}>{props.ref}</a>
			</span>{" "}
			<span class="text-muted-foreground">{props.name}</span>
			{props.supplierRef ? <div class="text-xs text-muted-foreground">{props.supplierRef}</div> : null}
		</TableCell>
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
			name={`order_from_${l.part.id}`}
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
	const { t } = useApp();
	const { shortages } = props;
	return (
		<>
			{shortages.missingBoms.length ? (
				<Alert variant="warning" title={t.purchasing.missingBoms} class="mb-0">
					<ul class="m-0 flex list-disc flex-col gap-1 pl-4">
						{shortages.missingBoms.map((m) => (
							<li>
								<span class="font-medium">{m.ref}</span> {m.name} × <Qty milli={m.qtyMilli} /> ({m.builds.join(", ")})
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
								{fmt(t.purchasing.partCount, { n: g.lines.length })} · {t.purchasing.estimated}:{" "}
								<Money cents={g.totalCents} />
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
										<TableHead class="text-right">{t.purchasing.price}</TableHead>
										<TableHead class="text-right">{t.purchasing.lineTotal}</TableHead>
										{choosing ? <TableHead>{t.purchasing.orderFrom}</TableHead> : null}
										<TableHead>{t.purchasing.builds}</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{g.lines.map((l) => (
										<TableRow>
											<PartCell id={l.part.id} ref={l.part.ref} name={l.part.name} supplierRef={l.part.supplierRef} />
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
											<TableCell class="text-right">
												<Money cents={l.unitPriceCents} />
											</TableCell>
											<TableCell class="text-right">
												<Money cents={lineCostCents(l.orderMilli, l.unitPriceCents)} />
											</TableCell>
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
	const orderable = shortages.groups.some((g) => g.supplierId !== null || g.lines.some((l) => canChoose(g, l)));
	const choosing = shortages.groups.some((g) => g.lines.some((l) => canChoose(g, l)));
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
				{choosing ? <p>{t.purchasing.orderFromHint}</p> : null}
			</div>
			{shortages.groups.length === 0 && shortages.missingBoms.length === 0 ? (
				<EmptyState icon={icons.circleCheck} description={t.purchasing.noShortages} />
			) : (
				<form id="draft-pos" method="post" action="/purchasing/draft-pos" class="flex flex-col gap-4">
					<ShortageTables shortages={shortages} selectable />
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

purchasingRoutes.post("/draft-pos", async (c) => {
	const db = c.var.db;
	const body = await c.req.parseBody();
	const shortages = await computeShortages(db);
	const orders = planDraftOrders(
		shortages.groups,
		(supplierId) => body[`supplier_${supplierId}`] === "on",
		(partId) => {
			const v = body[`order_from_${partId}`];
			return typeof v === "string" && /^\d+$/.test(v) ? Number(v) : undefined;
		},
	);
	if (orders.length === 0) return c.redirect("/purchasing", 303);
	for (let attempt = 0; ; attempt++) {
		const numbers = await nextPoNumbers(db, orders.length);
		try {
			await runBatch(db, draftPoStatements(db, orders, numbers, c.var.user, nowIso()));
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
	return page(
		c,
		t.purchasing.pos,
		<>
			<PageHeader
				title={t.purchasing.title}
				actions={
					<Button href="/purchasing/po/new" icon={icons.plus}>
						{t.purchasing.newPo}
					</Button>
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
						<Button href="/purchasing/po/new" variant="outline" icon={icons.plus}>
							{t.purchasing.newPo}
						</Button>
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
	const { t } = useApp();
	if (props.rows.length === 0) return <Empty>{t.purchasing.noPos}</Empty>;
	return (
		<Table>
			<TableHeader>
				<TableRow>
					<TableHead>{t.purchasing.number}</TableHead>
					<TableHead>{t.purchasing.supplier}</TableHead>
					<TableHead>{t.purchasing.status}</TableHead>
					<TableHead>{t.purchasing.expectedAt}</TableHead>
					<TableHead class="text-right">{t.purchasing.lines}</TableHead>
					<TableHead class="text-right">{t.purchasing.total}</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{props.rows.map((po) => {
					const overdue = isOverdue(po.expectedAt, po.status, props.today);
					return (
						<TableRow>
							<TableCell class="font-medium">
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
							<TableCell class="text-right tabular-nums">{po.lineCount}</TableCell>
							<TableCell class="text-right">
								<Money cents={po.totalCents} />
							</TableCell>
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

purchasingRoutes.get("/po/new", async (c) => {
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

purchasingRoutes.post("/po", async (c) => {
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
			const [row] = await db
				.insert(purchaseOrders)
				.values({
					number: number as string,
					supplierId: v.data.supplier_id as number,
					expectedAt: v.data.expected_at,
					notes: v.data.notes,
					createdBy: user,
					updatedBy: user,
				})
				.returning({ id: purchaseOrders.id });
			return redirectOk(c, `/purchasing/po/${row?.id}`, "created");
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
	const { t } = useApp();
	const { po, lines } = props;
	const ordered = lines.reduce((s, l) => s + l.line.qtyMilli, 0);
	const received = lines.reduce((s, l) => s + Math.min(l.line.receivedQtyMilli, l.line.qtyMilli), 0);
	// Integer floor division, so a nearly complete PO never reads 100 %.
	const pct = ordered > 0 ? (received * 100 - ((received * 100) % ordered)) / ordered : 0;
	const complete = lines.filter((l) => l.line.receivedQtyMilli >= l.line.qtyMilli).length;
	const overdue = isOverdue(po.expectedAt, po.status, props.today);
	return (
		<div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
			<StatCard label={t.purchasing.lines} value={lines.length} icon={icons.list} />
			<StatCard label={t.purchasing.total} value={<Money cents={linesTotal(lines)} />} icon={icons.coins} />
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
						<EmptyState icon={icons.list} description={t.purchasing.noLines} class="mx-4" />
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
										<PartCell id={l.line.partId} ref={l.ref} name={l.name} supplierRef={l.supplierRef} />
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
													aria-label={t.boms.remove}
													title={t.boms.remove}
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
							<TextField
								name="part"
								label={t.purchasing.part}
								list="po-parts"
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
						</div>
						<datalist id="po-parts">
							{props.options.map((o) => (
								<option value={o.ref}>{o.name}</option>
							))}
						</datalist>
					</form>
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
								const qtyName = `recv_${l.line.id}`;
								const serialName = `serials_${l.line.id}`;
								const qtyError = props.errors[qtyName];
								const serialError = props.errors[serialName];
								return (
									<TableRow>
										<PartCell id={l.line.partId} ref={l.ref} name={l.name} />
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
	const { t } = useApp();
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
							<TableHead class="text-right">{t.purchasing.price}</TableHead>
							<TableHead class="text-right">{t.purchasing.lineTotal}</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{props.lines.map((l) => (
							<TableRow>
								<PartCell id={l.line.partId} ref={l.ref} name={l.name} supplierRef={l.supplierRef} />
								<TableCell class="text-right">
									<Qty milli={l.line.qtyMilli} unit={l.unit} />
								</TableCell>
								<TableCell
									class={cn("text-right", l.line.receivedQtyMilli >= l.line.qtyMilli && "font-medium text-success")}
								>
									<Qty milli={l.line.receivedQtyMilli} unit={l.unit} />
								</TableCell>
								<TableCell class="text-right">
									<Money cents={l.line.unitPriceCents} />
								</TableCell>
								<TableCell class="text-right">
									<Money cents={lineCostCents(l.line.qtyMilli, l.line.unitPriceCents)} />
								</TableCell>
							</TableRow>
						))}
					</TableBody>
					<TableFooter>
						<TableRow>
							<TableCell colspan={4}>{t.purchasing.total}</TableCell>
							<TableCell class="text-right">
								<Money cents={linesTotal(props.lines)} />
							</TableCell>
						</TableRow>
					</TableFooter>
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

async function renderPo(
	c: Context<AppEnv>,
	data: PoData,
	form: {
		lineValues?: FormValues;
		lineErrors?: FieldErrors;
		lineVars?: Record<string, string>;
		receiveValues?: FormValues;
		receiveErrors?: FieldErrors;
	} = {},
	status: 200 | 422 = 200,
) {
	const t = c.var.t;
	const db = c.var.db;
	const { po, supplier } = data;
	const [lines, options] = await Promise.all([
		getPoLines(db, po.id),
		db
			.select({ ref: parts.ref, name: parts.name })
			.from(parts)
			.where(and(eq(parts.archived, false), inArray(parts.kind, ["buy", "make"])))
			.orderBy(asc(parts.ref)),
	]);
	const ok = c.req.query("ok");
	const flash = ok
		? (
				{
					received: t.purchasing.receivedOk,
					sent: t.purchasing.sentOk,
					cancelled: t.purchasing.cancelledOk,
					created: t.purchasing.createdOk,
					closed: t.purchasing.closedOk,
				} as Record<string, string>
			)[ok]
		: undefined;
	const err = c.req.query("err");
	const today = nowIso().slice(0, 10);
	const isDraft = po.status === "draft";
	const canReceive = RECEIVABLE_PO_STATUSES.includes(po.status) && lines.length > 0;
	const anyReceived = lines.some((l) => l.line.receivedQtyMilli > 0);
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
						<Button
							href={`/purchasing/po/${po.id}/export.csv`}
							variant="outline"
							icon={icons.fileSpreadsheet}
							title={t.purchasing.downloadCsv}
						>
							{t.purchasing.exportCsv}
						</Button>
						{(po.status === "draft" || po.status === "sent") && !anyReceived ? (
							<PostButton
								action={`/purchasing/po/${po.id}/cancel`}
								label={t.purchasing.cancelPo}
								confirm={t.purchasing.confirmCancel}
								icon={icons.ban}
							/>
						) : null}
						{po.status === "sent" || po.status === "partial" ? (
							<PostButton
								action={`/purchasing/po/${po.id}/close`}
								label={t.purchasing.closePo}
								confirm={t.purchasing.confirmClose}
								icon={icons.circleCheck}
							/>
						) : null}
						{c.var.isAdmin && isDraft ? (
							<PostButton
								action={`/purchasing/po/${po.id}/delete`}
								label={t.common.delete}
								confirm={t.common.confirmDelete}
								variant="destructive"
								icon={icons.trash}
							/>
						) : null}
						{canReceive ? (
							<Button href="#receive" variant={isDraft ? "outline" : "default"} icon={icons.truck}>
								{t.purchasing.receive}
							</Button>
						) : null}
						{isDraft ? (
							<PostButton
								action={`/purchasing/po/${po.id}/send`}
								label={t.purchasing.markSent}
								variant="default"
								icon={icons.send}
							/>
						) : null}
					</>
				}
			/>
			<PurchasingTabs active="pos" />
			<Flash ok={ok} message={flash} />
			{err ? <Alert variant="destructive">{errorText(t, err)}</Alert> : null}
			<div class="flex flex-col gap-4">
				{isDraft ? (
					<DraftLines
						po={po}
						lines={lines}
						options={options}
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
				{po.status !== "cancelled" ? <EditPo po={po} /> : null}
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

purchasingRoutes.post("/po/:id", async (c) => {
	const data = await loadPo(c);
	if (!data) return notFound(c);
	const v = validate(poEditInput, await c.req.parseBody());
	if (v.ok) {
		await c.var.db
			.update(purchaseOrders)
			.set({ expectedAt: v.data.expected_at, notes: v.data.notes, updatedAt: nowIso(), updatedBy: c.var.user })
			.where(eq(purchaseOrders.id, data.po.id));
	}
	return redirectOk(c, `/purchasing/po/${data.po.id}`);
});

purchasingRoutes.post("/po/:id/lines", async (c) => {
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
	if (!v.ok || !part || Object.keys(errors).length) {
		return renderPo(c, data, { lineValues: body as FormValues, lineErrors: errors, lineVars: vars }, 422);
	}
	const user = c.var.user;
	await db.insert(poLines).values({
		poId: data.po.id,
		partId: part.id,
		qtyMilli: v.data.qty,
		unitPriceCents:
			v.data.price ?? poUnitPrice((await getOffer(db, part.id, data.po.supplierId))?.priceCents, part.costCents),
		createdBy: user,
		updatedBy: user,
	});
	return c.redirect(`/purchasing/po/${data.po.id}`, 303);
});

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

purchasingRoutes.post("/po/:id/lines/:lineId", async (c) => {
	const data = await draftLine(c);
	if (!data) return notFound(c);
	if (data.po.status !== "draft") return c.redirect(`/purchasing/po/${data.po.id}?err=po_not_draft`, 303);
	const body = await c.req.parseBody();
	const qty = parseMilli(typeof body.qty === "string" ? body.qty : "");
	const price = parseCents(typeof body.price === "string" ? body.price : "");
	if (qty === null || qty <= 0) return c.redirect(`/purchasing/po/${data.po.id}?err=invalid_quantity`, 303);
	if (price === null || price < 0) return c.redirect(`/purchasing/po/${data.po.id}?err=invalid_money`, 303);
	await c.var.db
		.update(poLines)
		.set({ qtyMilli: qty, unitPriceCents: price, updatedAt: nowIso(), updatedBy: c.var.user })
		.where(eq(poLines.id, data.line.id));
	return c.redirect(`/purchasing/po/${data.po.id}`, 303);
});

purchasingRoutes.post("/po/:id/lines/:lineId/delete", async (c) => {
	const data = await draftLine(c);
	if (!data) return notFound(c);
	if (data.po.status !== "draft") return c.redirect(`/purchasing/po/${data.po.id}?err=po_not_draft`, 303);
	await c.var.db.delete(poLines).where(eq(poLines.id, data.line.id));
	return c.redirect(`/purchasing/po/${data.po.id}`, 303);
});

purchasingRoutes.post("/po/:id/send", async (c) => {
	const data = await loadPo(c);
	if (!data) return notFound(c);
	const lines = await getPoLines(c.var.db, data.po.id);
	if (lines.length === 0) return c.redirect(`/purchasing/po/${data.po.id}?err=po_empty`, 303);
	const now = nowIso();
	await c.var.db
		.update(purchaseOrders)
		.set({ status: "sent", sentAt: now, updatedAt: now, updatedBy: c.var.user })
		.where(and(eq(purchaseOrders.id, data.po.id), eq(purchaseOrders.status, "draft")));
	return redirectOk(c, `/purchasing/po/${data.po.id}`, "sent");
});

purchasingRoutes.post("/po/:id/cancel", async (c) => {
	const data = await loadPo(c);
	if (!data) return notFound(c);
	const lines = await getPoLines(c.var.db, data.po.id);
	if (lines.some((l) => l.line.receivedQtyMilli > 0)) {
		return c.redirect(`/purchasing/po/${data.po.id}?err=po_has_receipts`, 303);
	}
	await c.var.db
		.update(purchaseOrders)
		.set({ status: "cancelled", updatedAt: nowIso(), updatedBy: c.var.user })
		.where(and(eq(purchaseOrders.id, data.po.id), inArray(purchaseOrders.status, ["draft", "sent"])));
	return redirectOk(c, `/purchasing/po/${data.po.id}`, "cancelled");
});

/** Closes a short-shipped PO: the remaining quantities are no longer expected (no stock move). */
purchasingRoutes.post("/po/:id/close", async (c) => {
	const data = await loadPo(c);
	if (!data) return notFound(c);
	await c.var.db
		.update(purchaseOrders)
		.set({ status: "received", updatedAt: nowIso(), updatedBy: c.var.user })
		.where(and(eq(purchaseOrders.id, data.po.id), inArray(purchaseOrders.status, ["sent", "partial"])));
	return redirectOk(c, `/purchasing/po/${data.po.id}`, "closed");
});

purchasingRoutes.post("/po/:id/delete", requireAdmin, async (c) => {
	const data = await loadPo(c);
	if (!data) return notFound(c);
	if (data.po.status !== "draft") return c.redirect(`/purchasing/po/${data.po.id}?err=po_not_draft`, 303);
	await c.var.db.delete(purchaseOrders).where(eq(purchaseOrders.id, data.po.id));
	return c.redirect("/purchasing/po?ok=deleted", 303);
});

purchasingRoutes.post("/po/:id/receive", async (c) => {
	const data = await loadPo(c);
	if (!data) return notFound(c);
	const db = c.var.db;
	if (!RECEIVABLE_PO_STATUSES.includes(data.po.status)) {
		return c.redirect(`/purchasing/po/${data.po.id}?err=po_not_receivable`, 303);
	}
	const body = await c.req.parseBody();
	const values: FormValues = {};
	for (const [k, v] of Object.entries(body)) if (typeof v === "string") values[k] = v;
	const lines = await getPoLines(db, data.po.id);
	const errors: FieldErrors = {};
	const receipts: Receipt[] = [];
	for (const l of lines) {
		const qtyName = `recv_${l.line.id}`;
		const serialName = `serials_${l.line.id}`;
		const raw = (values[qtyName] ?? "").trim();
		if (raw === "") continue;
		const qty = parseMilli(raw);
		if (qty === null) {
			errors[qtyName] = "invalid_quantity";
			continue;
		}
		if (qty < 0) {
			errors[qtyName] = "negative";
			continue;
		}
		if (qty === 0) continue;
		const serials = (values[serialName] ?? "")
			.split(/[\r\n,;]+/)
			.map((s) => s.trim())
			.filter(Boolean);
		if (serials.length > 0) {
			if (qty % MILLI !== 0 || serials.length !== qty / MILLI) errors[serialName] = "serial_count";
			else if (new Set(serials).size !== serials.length) errors[serialName] = "serial_duplicate";
		}
		receipts.push({
			lineId: l.line.id,
			partId: l.line.partId,
			qtyMilli: qty,
			unitPriceCents: l.line.unitPriceCents,
			serials,
		});
	}
	if (Object.keys(errors).length === 0 && receipts.length === 0) errors._ = "nothing_received";
	if (Object.keys(errors).length > 0) {
		return renderPo(c, data, { receiveValues: values, receiveErrors: errors }, 422);
	}
	await runBatch(db, receiptStatements(db, data.po, receipts, c.var.user, nowIso()));
	return redirectOk(c, `/purchasing/po/${data.po.id}`, "received");
});

purchasingRoutes.get("/po/:id/export.csv", async (c) => {
	const data = await loadPo(c);
	if (!data) return notFound(c);
	const locale = c.var.locale;
	const lines = await getPoLines(c.var.db, data.po.id);
	return csvResponse(c, `${data.po.number}.csv`, [
		["supplier_ref", "ref", "name", "qty", "unit", "unit_price", "line_total"],
		...lines.map((l) => [
			l.supplierRef,
			l.ref,
			l.name,
			formatQtyInput(l.line.qtyMilli, locale),
			l.unit,
			formatCentsInput(l.line.unitPriceCents, locale),
			formatCentsInput(lineCostCents(l.line.qtyMilli, l.line.unitPriceCents), locale),
		]),
	]);
});
