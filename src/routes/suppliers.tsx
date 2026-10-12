import { and, asc, eq, ne, sql } from "drizzle-orm";
import { Hono } from "hono";
import { parts, suppliers } from "../db/schema";
import { findSupplierByName, getSupplier, listSuppliers, supplierInput, supplierToForm } from "../domain/suppliers";
import { fmt } from "../i18n";
import { isConstraintError } from "../lib/sql";
import { type FieldErrors, validate } from "../lib/validation";
import { requireAdmin } from "../middleware/auth";
import type { AppEnv } from "../types";
import { useApp } from "../views/context";
import { icons } from "../views/icons";
import { idParam, notFound, nowIso, page, redirectOk, translateErrors } from "../views/render";
import {
	Alert,
	Badge,
	Button,
	Card,
	CardContent,
	CardHeader,
	CardTitle,
	EmptyState,
	ErrorBanner,
	FieldGroup,
	Flash,
	type FormErrors,
	type FormValues,
	KindBadge,
	PageHeader,
	PostButton,
	SearchBar,
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
	TextArea,
	TextField,
} from "../views/ui";

export const supplierRoutes = new Hono<AppEnv>();

type SupplierRow = Awaited<ReturnType<typeof listSuppliers>>[number];

function SupplierList(props: { rows: SupplierRow[]; q: string; ok?: string | undefined }) {
	const { t } = useApp();
	return (
		<>
			<PageHeader
				title={t.suppliers.title}
				actions={
					<Button href="/suppliers/new" icon={icons.plus}>
						{t.suppliers.new}
					</Button>
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
						{props.q ? null : (
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

supplierRoutes.get("/", async (c) => {
	const q = c.req.query("q") ?? "";
	const rows = await listSuppliers(c.var.db, q);
	return page(c, c.var.t.suppliers.title, <SupplierList rows={rows} q={q} ok={c.req.query("ok")} />);
});

supplierRoutes.get("/new", (c) => {
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

supplierRoutes.post("/", async (c) => {
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
	const user = c.var.user;
	const [row] = await c.var.db
		.insert(suppliers)
		.values({ ...result.data, createdBy: user, updatedBy: user })
		.returning({ id: suppliers.id });
	return redirectOk(c, `/suppliers/${row?.id}`);
});

supplierRoutes.get("/:id", async (c) => {
	const t = c.var.t;
	const id = idParam(c);
	const supplier = id ? await getSupplier(c.var.db, id) : undefined;
	if (!supplier) return notFound(c);
	const supplied = await c.var.db
		.select({ id: parts.id, ref: parts.ref, name: parts.name, kind: parts.kind, supplierRef: parts.supplierRef })
		.from(parts)
		.where(and(eq(parts.supplierId, supplier.id), eq(parts.archived, false)))
		.orderBy(asc(parts.ref));
	return page(
		c,
		supplier.name,
		<>
			<PageHeader
				title={supplier.name}
				subtitle={fmt(t.common.updatedBy, { by: supplier.updatedBy, at: supplier.updatedAt.slice(0, 10) })}
				actions={
					c.var.isAdmin ? (
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
			<Flash ok={c.req.query("ok")} />
			{c.req.query("err") === "in_use" ? <Alert variant="destructive">{t.errors.in_use}</Alert> : null}
			<div class="flex flex-col gap-4">
				<SupplierForm
					action={`/suppliers/${supplier.id}`}
					values={supplierToForm(supplier)}
					errors={{}}
					submit={t.common.save}
					title={t.suppliers.edit}
				/>
				<Card>
					<CardHeader>
						<CardTitle class="flex items-center gap-2">
							{t.suppliers.parts}
							<Badge variant="secondary">{supplied.length}</Badge>
						</CardTitle>
					</CardHeader>
					<CardContent class="px-2">
						{supplied.length === 0 ? (
							<EmptyState icon={icons.package} description={t.suppliers.noParts} class="border-0 p-4 md:p-6" />
						) : (
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>{t.parts.ref}</TableHead>
										<TableHead>{t.parts.name}</TableHead>
										<TableHead>{t.parts.kind}</TableHead>
										<TableHead>{t.parts.supplierRef}</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{supplied.map((p) => (
										<TableRow>
											<TableCell class="font-medium whitespace-nowrap">
												<a href={`/parts/${p.id}`}>{p.ref}</a>
											</TableCell>
											<TableCell>{p.name}</TableCell>
											<TableCell>
												<KindBadge kind={p.kind} />
											</TableCell>
											<TableCell class="text-muted-foreground">{p.supplierRef}</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						)}
					</CardContent>
				</Card>
			</div>
		</>,
	);
});

supplierRoutes.post("/:id", async (c) => {
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
	await c.var.db
		.update(suppliers)
		.set({ ...result.data, updatedAt: nowIso(), updatedBy: c.var.user })
		.where(eq(suppliers.id, supplier.id));
	return redirectOk(c, `/suppliers/${supplier.id}`);
});

supplierRoutes.post("/:id/delete", requireAdmin, async (c) => {
	const id = idParam(c);
	if (!id) return notFound(c);
	try {
		await c.var.db.delete(suppliers).where(eq(suppliers.id, id));
	} catch (err) {
		if (isConstraintError(err, "FOREIGN KEY")) return c.redirect(`/suppliers/${id}?err=in_use`, 303);
		throw err;
	}
	return redirectOk(c, "/suppliers", "deleted");
});
