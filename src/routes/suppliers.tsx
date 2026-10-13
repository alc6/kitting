import { and, ne, sql } from "drizzle-orm";
import { Hono } from "hono";
import { type Supplier, suppliers } from "../db/schema";
import { poUnitPrice, supplierOffers } from "../domain/offers";
import { can } from "../domain/permissions";
import {
	createSupplierStatement,
	deleteSupplierStatement,
	findSupplierByName,
	getSupplier,
	listSuppliers,
	supplierInput,
	supplierToForm,
	updateSupplierStatement,
} from "../domain/suppliers";
import { fmt } from "../i18n";
import { isConstraintError } from "../lib/sql";
import { type FieldErrors, validate } from "../lib/validation";
import { requirePermission } from "../middleware/roles";
import type { AppEnv } from "../types";
import { useApp } from "../views/context";
import { RecordTabs } from "../views/history";
import { Icon, icons } from "../views/icons";
import { idParam, notFound, nowIso, page, redirectOk, saveChanges, translateErrors } from "../views/render";
import {
	Alert,
	Badge,
	Button,
	Card,
	CardContent,
	CardEmpty,
	CardFooter,
	CardHeader,
	CardTitle,
	DetailList,
	EmptyState,
	ErrorBanner,
	FieldGroup,
	Flash,
	type FormErrors,
	type FormValues,
	Money,
	PageHeader,
	PostButton,
	Qty,
	SearchBar,
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
import { recordHistoryPage } from "./history";

export const supplierRoutes = new Hono<AppEnv>();

type SupplierRow = Awaited<ReturnType<typeof listSuppliers>>[number];

function SupplierList(props: { rows: SupplierRow[]; q: string; ok?: string | undefined }) {
	const view = useApp();
	const { t } = view;
	const canEdit = can(view, "suppliers.edit");
	return (
		<>
			<PageHeader
				title={t.suppliers.title}
				actions={
					canEdit ? (
						<Button href="/suppliers/new" icon={icons.plus}>
							{t.suppliers.new}
						</Button>
					) : undefined
				}
			/>
			<Flash ok={props.ok} />
			<SearchBar action="/suppliers" q={props.q} />
			<div id="results">
				{props.rows.length === 0 ? (
					<EmptyState
						icon={icons.factory}
						title={t.suppliers.empty}
						description={props.q ? t.suppliers.emptyFiltered : t.suppliers.emptyHint}
					>
						{props.q || !canEdit ? null : (
							<Button href="/suppliers/new" icon={icons.plus}>
								{t.suppliers.new}
							</Button>
						)}
					</EmptyState>
				) : (
					<Card class="py-0">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>{t.suppliers.name}</TableHead>
									<TableHead>{t.suppliers.email}</TableHead>
									<TableHead>{t.suppliers.phone}</TableHead>
									<TableHead class="text-right">{t.parts.title}</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{props.rows.map((s) => (
									<TableRow>
										<TableCell class="font-medium">
											<a href={`/suppliers/${s.id}`}>{s.name}</a>
										</TableCell>
										<TableCell class="text-muted-foreground">{s.email}</TableCell>
										<TableCell class="whitespace-nowrap text-muted-foreground">{s.phone}</TableCell>
										<TableCell class="text-right tabular-nums">{s.partCount}</TableCell>
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

function SupplierForm(props: {
	action: string;
	values: FormValues;
	errors: FormErrors;
	submit: string;
	title?: string;
}) {
	const { t } = useApp();
	const p = { values: props.values, errors: props.errors };
	return (
		<>
			<ErrorBanner show={Object.keys(props.errors).length > 0} />
			<Card>
				{props.title ? (
					<CardHeader>
						<CardTitle>{props.title}</CardTitle>
					</CardHeader>
				) : null}
				<CardContent>
					<form method="post" action={props.action} class="flex flex-col gap-6">
						<FieldGroup>
							<TextField name="name" label={t.suppliers.name} required autofocus {...p} />
							<div class="grid gap-4 md:grid-cols-2">
								<TextField name="email" label={t.suppliers.email} type="email" {...p} />
								<TextField name="phone" label={t.suppliers.phone} type="tel" {...p} />
							</div>
							<TextArea name="notes" label={t.common.notes} {...p} />
						</FieldGroup>
						<div class="flex flex-wrap items-center gap-2">
							<Button>{props.submit}</Button>
							<Button variant="outline" href="/suppliers">
								{t.common.cancel}
							</Button>
						</div>
					</form>
				</CardContent>
			</Card>
		</>
	);
}

/** Read-only contact details, for roles that may not edit suppliers. */
function SupplierDetails(props: { supplier: Supplier }) {
	const { t } = useApp();
	const s = props.supplier;
	return (
		<Card>
			<CardContent>
				<DetailList
					items={[
						{ label: t.suppliers.email, value: s.email ? <a href={`mailto:${s.email}`}>{s.email}</a> : t.common.none },
						{ label: t.suppliers.phone, value: s.phone || t.common.none },
						...(s.notes ? [{ label: t.common.notes, value: <span class="whitespace-pre-wrap">{s.notes}</span> }] : []),
					]}
				/>
			</CardContent>
		</Card>
	);
}

type OfferRow = Awaited<ReturnType<typeof supplierOffers>>[number];

/** What this supplier offers: one row per part, with the price a PO would use (D90). */
function SupplierOffers(props: { offers: OfferRow[] }) {
	const { t, seeCosts } = useApp();
	return (
		<TableCard
			id="offers"
			title={
				<span class="flex items-center gap-2">
					{t.suppliers.parts}
					<Badge variant="secondary">{props.offers.length}</Badge>
				</span>
			}
		>
			{props.offers.length === 0 ? (
				<CardEmpty icon={icons.package}>{t.suppliers.noParts}</CardEmpty>
			) : (
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>{t.parts.ref}</TableHead>
							<TableHead>{t.parts.supplierRef}</TableHead>
							{seeCosts ? <TableHead class="text-right">{t.parts.offerPrice}</TableHead> : null}
							<TableHead class="text-right">{t.parts.moq}</TableHead>
							<TableHead class="text-right">{t.parts.leadTime}</TableHead>
							<TableHead>
								<span class="sr-only">{t.parts.preferred}</span>
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{props.offers.map((o) => (
							<TableRow>
								<TableCell>
									<span class="flex flex-col items-start gap-0.5">
										<a href={`/parts/${o.partId}`} class="font-medium whitespace-nowrap">
											{o.ref}
										</a>
										<span class="text-xs text-muted-foreground">{o.name}</span>
									</span>
								</TableCell>
								<TableCell class="text-muted-foreground">{o.offer.supplierRef || t.common.none}</TableCell>
								{seeCosts ? (
									<TableCell class="text-right whitespace-nowrap">
										{o.offer.priceCents === null && o.costCents !== null ? (
											<span class="flex flex-col items-end gap-0.5">
												<Money cents={poUnitPrice(o.offer.priceCents, o.costCents)} />
												<span class="text-xs text-muted-foreground">{t.parts.standardCostUsed}</span>
											</span>
										) : (
											<Money cents={o.offer.priceCents} />
										)}
									</TableCell>
								) : null}
								<TableCell class="text-right">
									{o.offer.moqMilli ? <Qty milli={o.offer.moqMilli} unit={o.unit} /> : t.common.none}
								</TableCell>
								<TableCell class="text-right whitespace-nowrap tabular-nums">
									{o.offer.leadDays ? fmt(t.parts.leadDaysValue, { n: o.offer.leadDays }) : t.common.none}
								</TableCell>
								<TableCell>
									{o.preferred ? (
										<Badge variant="secondary">
											<Icon icon={icons.check} />
											{t.parts.preferred}
										</Badge>
									) : null}
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			)}
			<CardFooter class="border-t px-4 py-3 text-xs text-muted-foreground [.border-t]:pt-3">
				{t.suppliers.offersHint}
			</CardFooter>
		</TableCard>
	);
}

supplierRoutes.get("/", async (c) => {
	const q = c.req.query("q") ?? "";
	const rows = await listSuppliers(c.var.db, q);
	return page(c, c.var.t.suppliers.title, <SupplierList rows={rows} q={q} ok={c.req.query("ok")} />);
});

supplierRoutes.get("/new", requirePermission("suppliers.edit"), (c) => {
	const t = c.var.t;
	return page(
		c,
		t.suppliers.new,
		<>
			<PageHeader title={t.suppliers.new} />
			<SupplierForm action="/suppliers" values={{}} errors={{}} submit={t.common.create} />
		</>,
	);
});

supplierRoutes.post("/", requirePermission("suppliers.edit"), async (c) => {
	const t = c.var.t;
	const body = await c.req.parseBody();
	const result = validate(supplierInput, body);
	let errors: FieldErrors = result.ok ? {} : result.errors;
	if (result.ok && (await findSupplierByName(c.var.db, result.data.name))) errors = { name: "duplicate_name" };
	if (!result.ok || Object.keys(errors).length > 0) {
		return page(
			c,
			t.suppliers.new,
			<>
				<PageHeader title={t.suppliers.new} />
				<SupplierForm
					action="/suppliers"
					values={body as FormValues}
					errors={translateErrors(c, errors)}
					submit={t.common.create}
				/>
			</>,
			422,
		);
	}
	const { results } = await saveChanges(c, fmt(t.history.summaries.supplierCreate, { name: result.data.name }), [
		createSupplierStatement(c.var.db, result.data, c.var.user, nowIso()),
	]);
	return redirectOk(c, `/suppliers/${results[0][0]?.id}`);
});

supplierRoutes.get("/:id", async (c) => {
	const t = c.var.t;
	const id = idParam(c);
	const supplier = id ? await getSupplier(c.var.db, id) : undefined;
	if (!supplier) return notFound(c);
	const offers = (await supplierOffers(c.var.db, supplier.id)).filter((o) => !o.archived);
	return page(
		c,
		supplier.name,
		<>
			<PageHeader
				title={supplier.name}
				subtitle={fmt(t.common.updatedBy, { by: supplier.updatedBy, at: supplier.updatedAt.slice(0, 10) })}
				actions={
					can(c.var, "suppliers.delete") ? (
						<PostButton
							action={`/suppliers/${supplier.id}/delete`}
							label={t.common.delete}
							confirm={t.common.confirmDelete}
							variant="destructive"
							icon={icons.trash}
						/>
					) : null
				}
			/>
			<RecordTabs base={`/suppliers/${supplier.id}`} active="overview" />
			<Flash ok={c.req.query("ok")} />
			{c.req.query("err") === "in_use" ? <Alert variant="destructive">{t.errors.in_use}</Alert> : null}
			<div class="flex flex-col gap-4">
				{can(c.var, "suppliers.edit") ? (
					<SupplierForm
						action={`/suppliers/${supplier.id}`}
						values={supplierToForm(supplier)}
						errors={{}}
						submit={t.common.save}
						title={t.suppliers.edit}
					/>
				) : (
					<SupplierDetails supplier={supplier} />
				)}
				<SupplierOffers offers={offers} />
			</div>
		</>,
	);
});

supplierRoutes.get("/:id/history", async (c) => {
	const id = idParam(c);
	const supplier = id ? await getSupplier(c.var.db, id) : undefined;
	if (!supplier) return notFound(c);
	const header = (
		<>
			<PageHeader title={supplier.name} />
			<RecordTabs base={`/suppliers/${supplier.id}`} active="history" />
		</>
	);
	return recordHistoryPage(c, supplier.name, header, { kind: "supplier", id: supplier.id });
});

supplierRoutes.post("/:id", requirePermission("suppliers.edit"), async (c) => {
	const t = c.var.t;
	const id = idParam(c);
	const supplier = id ? await getSupplier(c.var.db, id) : undefined;
	if (!supplier) return notFound(c);
	const body = await c.req.parseBody();
	const result = validate(supplierInput, body);
	let errors: FieldErrors = result.ok ? {} : result.errors;
	if (result.ok) {
		const clash = await c.var.db
			.select({ id: suppliers.id })
			.from(suppliers)
			.where(and(sql`lower(${suppliers.name}) = lower(${result.data.name})`, ne(suppliers.id, supplier.id)))
			.limit(1);
		if (clash.length > 0) errors = { name: "duplicate_name" };
	}
	if (!result.ok || Object.keys(errors).length > 0) {
		return page(
			c,
			t.suppliers.edit,
			<>
				<PageHeader title={supplier.name} />
				<SupplierForm
					action={`/suppliers/${supplier.id}`}
					values={body as FormValues}
					errors={translateErrors(c, errors)}
					submit={t.common.save}
					title={t.suppliers.edit}
				/>
			</>,
			422,
		);
	}
	await saveChanges(c, fmt(t.history.summaries.supplierEdit, { name: result.data.name }), [
		updateSupplierStatement(c.var.db, supplier.id, result.data, c.var.user, nowIso()),
	]);
	return redirectOk(c, `/suppliers/${supplier.id}`);
});

supplierRoutes.post("/:id/delete", requirePermission("suppliers.delete"), async (c) => {
	const id = idParam(c);
	const supplier = id ? await getSupplier(c.var.db, id) : undefined;
	if (!supplier) return notFound(c);
	try {
		await saveChanges(c, fmt(c.var.t.history.summaries.supplierDelete, { name: supplier.name }), [
			deleteSupplierStatement(c.var.db, supplier.id),
		]);
	} catch (err) {
		if (isConstraintError(err, "FOREIGN KEY")) return c.redirect(`/suppliers/${supplier.id}?err=in_use`, 303);
		throw err;
	}
	return redirectOk(c, "/suppliers", "deleted");
});
