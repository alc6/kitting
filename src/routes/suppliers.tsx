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
import { idParam, notFound, nowIso, page, redirectOk, translateErrors } from "../views/render";
import {
	Empty,
	ErrorBanner,
	Flash,
	type FormErrors,
	type FormValues,
	KindBadge,
	LinkButton,
	PageHeader,
	PostButton,
	SearchBar,
	TextArea,
	TextField,
} from "../views/ui";

export const supplierRoutes = new Hono<AppEnv>();

type SupplierRow = Awaited<ReturnType<typeof listSuppliers>>[number];

function SupplierList(props: { rows: SupplierRow[]; q: string; ok?: string | undefined }) {
	const { t } = useApp();
	return (
		<>
			<PageHeader title={t.suppliers.title} actions={<LinkButton href="/suppliers/new" label={t.suppliers.new} />} />
			<Flash ok={props.ok} />
			<SearchBar action="/suppliers" q={props.q} />
			<div id="results">
				{props.rows.length === 0 ? (
					<Empty />
				) : (
					<table class="table">
						<thead>
							<tr>
								<th>{t.suppliers.name}</th>
								<th>{t.suppliers.email}</th>
								<th>{t.suppliers.phone}</th>
								<th class="num">{t.parts.title}</th>
							</tr>
						</thead>
						<tbody>
							{props.rows.map((s) => (
								<tr>
									<td>
										<a href={`/suppliers/${s.id}`}>{s.name}</a>
									</td>
									<td>{s.email}</td>
									<td>{s.phone}</td>
									<td class="num">{s.partCount}</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</div>
		</>
	);
}

function SupplierForm(props: { action: string; values: FormValues; errors: FormErrors; submit: string }) {
	const { t } = useApp();
	const p = { values: props.values, errors: props.errors };
	return (
		<form method="post" action={props.action} class="card form">
			<ErrorBanner show={Object.keys(props.errors).length > 0} />
			<TextField name="name" label={t.suppliers.name} required autofocus {...p} />
			<div class="grid-2">
				<TextField name="email" label={t.suppliers.email} type="email" {...p} />
				<TextField name="phone" label={t.suppliers.phone} type="tel" {...p} />
			</div>
			<TextArea name="notes" label={t.common.notes} {...p} />
			<div class="form-actions">
				<button type="submit" class="button primary">
					{props.submit}
				</button>
				<a class="button secondary" href="/suppliers">
					{t.common.cancel}
				</a>
			</div>
		</form>
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
							variant="danger"
						/>
					) : null
				}
			/>
			<Flash ok={c.req.query("ok")} />
			{c.req.query("err") === "in_use" ? <p class="flash error">{t.errors.in_use}</p> : null}
			<SupplierForm
				action={`/suppliers/${supplier.id}`}
				values={supplierToForm(supplier)}
				errors={{}}
				submit={t.common.save}
			/>
			<section class="card">
				<h2>{t.suppliers.parts}</h2>
				{supplied.length === 0 ? (
					<Empty />
				) : (
					<table class="table">
						<tbody>
							{supplied.map((p) => (
								<tr>
									<td>
										<a href={`/parts/${p.id}`}>{p.ref}</a>
									</td>
									<td>{p.name}</td>
									<td>
										<KindBadge kind={p.kind} />
									</td>
									<td>{p.supplierRef}</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</section>
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
