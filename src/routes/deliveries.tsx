// Customer deliveries (D216): the list, the delivery form, and a delivery's page with its edit card and cancel.
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { DELIVERY_STATUSES, type DeliveryStatus, parts } from "../db/schema";
import { getBuild } from "../domain/builds";
import {
	cancelDeliveryStatements,
	type DeliveryLine,
	type DeliveryLineRequest,
	deliveryFormValues,
	deliveryHeader,
	deliveryInput,
	deliveryStatements,
	getDelivery,
	isGuardError,
	knownCustomers,
	listDeliveries,
	nextDeliveryNumber,
	planDelivery,
	serialsBackInStock,
	splitSerials,
	updateDeliveryStatement,
} from "../domain/deliveries";
import { idsOf, keyText, type OptionDef } from "../domain/option-keys";
import { keyFromForm, loadOptions, optionsOf } from "../domain/options";
import { partOptions } from "../domain/parts";
import { can } from "../domain/permissions";
import { isStocked } from "../domain/stock";
import { errorText, fmt } from "../i18n";
import { isConstraintError } from "../lib/sql";
import { formatQtyInput } from "../lib/units";
import { type FieldErrors, validate } from "../lib/validation";
import { requirePermission } from "../middleware/roles";
import type { AppEnv } from "../types";
import { useApp } from "../views/context";
import { Icon, icons } from "../views/icons";
import { OptionSelects } from "../views/options";
import { PartPicker, PartPickerDialog } from "../views/part-picker";
import { fragment, idParam, notFound, nowIso, page, redirectOk, saveChanges, translateErrors } from "../views/render";
import {
	Alert,
	Badge,
	Button,
	buttonClass,
	Card,
	CardContent,
	CardEmpty,
	CardHeader,
	CardTitle,
	CollapsibleCard,
	DetailList,
	FieldGroup,
	Flash,
	type FormErrors,
	type FormValues,
	LinkButton,
	PageHeader,
	PostButton,
	Qty,
	SearchBar,
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
import { csvResponse } from "./import";

export const deliveryRoutes = new Hono<AppEnv>();

/** At most this many lines on the form (a pallet of parts is a CSV job, not a form). */
const MAX_LINES = 50;

export function DeliveryStatusBadge(props: { status: DeliveryStatus }) {
	const { t } = useApp();
	return (
		<Badge variant={props.status === "shipped" ? "success" : "muted"}>{t.deliveries.statuses[props.status]}</Badge>
	);
}

/** "2 × CABLE-1", "LAMP-DESK · L-0042": what a line shipped, in one short phrase. */
function LineSummary(props: { line: DeliveryLine }) {
	const l = props.line;
	return (
		<span class="block">
			{l.serial ? null : (
				<>
					<Qty milli={l.qtyMilli} unit={l.unit} /> ×{" "}
				</>
			)}
			<a href={`/parts/${l.partId}`}>{l.ref}</a>
			{l.values ? <span class="text-muted-foreground"> ({l.values})</span> : null}
			{l.serial ? <span class="font-mono text-xs"> · {l.serial}</span> : null}
		</span>
	);
}

// ---------------------------------------------------------------------------
// List

deliveryRoutes.get("/", async (c) => {
	const t = c.var.t;
	const db = c.var.db;
	const q = c.req.query("q") ?? "";
	const statusParam = c.req.query("status") ?? "";
	const status = (DELIVERY_STATUSES as readonly string[]).includes(statusParam) ? statusParam : "";
	const csv = c.req.query("format") === "csv";
	const limit = csv ? 100_000 : 300;
	const rows = await listDeliveries(db, { q, status, limit });
	if (csv) {
		const options = await loadOptions(db);
		return csvResponse(c, `deliveries-${nowIso().slice(0, 10)}.csv`, [
			[
				"number",
				"shipped_on",
				"customer",
				"customer_ref",
				"status",
				"ref",
				"name",
				"qty",
				"unit",
				"serial",
				"options",
				"carrier",
				"tracking_number",
				"notes",
			],
			...rows.flatMap(({ delivery: d, lines }) =>
				lines.map((l) => [
					d.number,
					d.shippedOn,
					d.customer,
					d.customerRef,
					d.status,
					l.ref,
					l.name,
					formatQtyInput(l.qtyMilli, c.var.locale),
					l.unit,
					l.serial ?? "",
					keyText(options.get(l.partId) ?? [], l.optionValues),
					d.carrier,
					d.trackingNumber,
					d.notes,
				]),
			),
		]);
	}
	const csvHref = `/deliveries?${new URLSearchParams({ q, status, format: "csv" }).toString()}`;
	return page(
		c,
		t.deliveries.title,
		<>
			<PageHeader
				title={t.deliveries.title}
				subtitle={t.deliveries.intro}
				actions={
					can(c.var, "deliveries.ship") ? (
						<LinkButton href="/deliveries/new" label={t.deliveries.new} icon={icons.plus} />
					) : undefined
				}
			/>
			<SearchBar action="/deliveries" q={q}>
				<select name="status" aria-label={t.deliveries.status} class="w-auto flex-[0_1_220px]">
					<option value="">{t.deliveries.statusAll}</option>
					{DELIVERY_STATUSES.map((s) => (
						<option value={s} selected={s === status}>
							{t.deliveries.statuses[s]}
						</option>
					))}
				</select>
			</SearchBar>
			<div id="results">
				<TableCard
					title={fmt(t.common.results, { n: rows.length })}
					action={
						<Button href={csvHref} variant="outline" size="sm" icon={icons.download}>
							{t.stock.downloadCsv}
						</Button>
					}
				>
					{rows.length === 0 ? (
						<CardEmpty large icon={icons.truck}>
							{q || status ? undefined : t.deliveries.none}
						</CardEmpty>
					) : (
						<Table>
							<TableHeader class="bg-muted/50">
								<TableRow>
									<TableHead>{t.deliveries.number}</TableHead>
									<TableHead>{t.deliveries.shippedOn}</TableHead>
									<TableHead>{t.deliveries.customer}</TableHead>
									<TableHead>{t.deliveries.contents}</TableHead>
									<TableHead>{t.deliveries.status}</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{rows.map(({ delivery: d, lines }) => (
									<TableRow>
										<TableCell class="font-medium whitespace-nowrap">
											<a href={`/deliveries/${d.id}`}>{d.number}</a>
										</TableCell>
										<TableCell class="whitespace-nowrap tabular-nums">{d.shippedOn}</TableCell>
										<TableCell>
											{d.customer}
											{d.customerRef ? <span class="block text-xs text-muted-foreground">{d.customerRef}</span> : null}
										</TableCell>
										<TableCell class="min-w-48">
											{lines.map((l) => (
												<LineSummary line={l} />
											))}
										</TableCell>
										<TableCell>
											<DeliveryStatusBadge status={d.status} />
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					)}
				</TableCard>
				{rows.length === limit ? (
					<p class="mt-3 text-sm text-muted-foreground">{fmt(t.deliveries.limitNote, { n: limit })}</p>
				) : null}
			</div>
		</>,
	);
});

// ---------------------------------------------------------------------------
// The delivery form: a header, then lines (a part, a quantity or serials, values for a part with options).

const lineFields = (i: number) => ({
	part: `part_${i}`,
	qty: `qty_${i}`,
	serials: `serials_${i}`,
	option: (o: OptionDef) => `opt_${i}:${o.id}`,
});

const formStrings = (body: Record<string, unknown>): Record<string, string> =>
	Object.fromEntries(Object.entries(body).filter((e): e is [string, string] => typeof e[1] === "string"));

const lineCount = (form: Record<string, string>) => Math.min(MAX_LINES, Math.max(1, Number(form.lines) || 1));

/** The part a line names (exact reference, as on the adjustment form) and the options it is chosen in, if any. */
async function linePart(c: Context<AppEnv>, ref: string) {
	const part = ref ? (await c.var.db.select().from(parts).where(eq(parts.ref, ref)).limit(1))[0] : undefined;
	// A serial carries its own values (D216): only a part without serials gets the selects.
	const options = part && isStocked(part.kind) && !part.trackSerial ? await optionsOf(c.var.db, part.id) : [];
	return { part, options };
}

/** The lines filled in on the form (blank rows are skipped), and the option selects of each row. */
async function readLines(c: Context<AppEnv>, form: Record<string, string>) {
	const requests: DeliveryLineRequest[] = [];
	const lineOptions = new Map<number, OptionDef[]>();
	for (let i = 1; i <= lineCount(form); i++) {
		const fields = lineFields(i);
		const ref = (form[fields.part] ?? "").trim();
		const qty = form[fields.qty] ?? "";
		const serials = splitSerials(form[fields.serials] ?? "");
		if (!ref && !qty.trim() && serials.length === 0) continue;
		const { part, options } = await linePart(c, ref);
		lineOptions.set(i, options);
		requests.push({ fields, ref, part, options, qty, serials, chosen: keyFromForm(options, form, `opt_${i}:`) });
	}
	return { requests, lineOptions };
}

/** The selects of a line's options, refreshed when its part changes (htmx; the form works without it). */
function LineOptions(props: { row: number; options: OptionDef[]; values: FormValues; errors: FormErrors }) {
	const fields = lineFields(props.row);
	return (
		<div
			id={`line-options-${props.row}`}
			class="grid gap-4 empty:hidden md:grid-cols-2"
			hx-get={`/deliveries/new/options?row=${props.row}`}
			hx-trigger={`change from:#f-${fields.part}`}
			hx-include={`#f-${fields.part}`}
			hx-swap="outerHTML"
		>
			<OptionSelects options={props.options} name={fields.option} values={props.values} errors={props.errors} />
		</div>
	);
}

function DeliveryForm(props: {
	values: FormValues;
	errors: FormErrors;
	lines: number;
	parts: { ref: string; name: string }[];
	lineOptions: Map<number, OptionDef[]>;
	customers: string[];
}) {
	const { t } = useApp();
	const p = { values: props.values, errors: props.errors };
	const rows = Array.from({ length: props.lines }, (_, i) => i + 1);
	const hasErrors = Object.keys(props.errors).length > 0;
	return (
		<Card class="max-w-3xl">
			<CardContent>
				<form method="post" action="/deliveries" class="flex flex-col gap-6" data-confirm={t.deliveries.shipConfirm}>
					{hasErrors ? (
						<Alert variant="destructive" class="mb-0">
							{props.errors._ ?? t.common.fixErrors}
						</Alert>
					) : null}
					<input type="hidden" name="lines" value={String(props.lines)} />
					<FieldGroup>
						<div class="grid gap-4 md:grid-cols-2">
							<TextField
								name="customer"
								label={t.deliveries.customer}
								list="delivery-customers"
								required
								autofocus
								{...p}
							/>
							<TextField
								name="customer_ref"
								label={t.deliveries.customerRef}
								hint={t.deliveries.customerRefHint}
								{...p}
							/>
						</div>
						<datalist id="delivery-customers">
							{props.customers.map((name) => (
								<option value={name} />
							))}
						</datalist>
						<div class="grid gap-4 md:grid-cols-3">
							<TextField
								name="shipped_on"
								label={t.deliveries.shippedOn}
								type="date"
								hint={t.deliveries.shippedOnHint}
								{...p}
							/>
							<TextField name="carrier" label={t.deliveries.carrier} {...p} />
							<TextField name="tracking_number" label={t.deliveries.trackingNumber} {...p} />
						</div>
						<TextArea name="notes" label={t.common.notes} rows={2} {...p} />
					</FieldGroup>
					<section class="flex flex-col gap-4">
						<h2 class="text-base font-medium">{t.deliveries.lines}</h2>
						{rows.map((i) => {
							const f = lineFields(i);
							return (
								<fieldset id={`line-${i}`} class="m-0 flex min-w-0 flex-col gap-4 rounded-lg border p-4">
									<legend class="px-1 text-sm text-muted-foreground">{fmt(t.deliveries.line, { n: i })}</legend>
									<PartPicker
										name={f.part}
										label={t.deliveries.part}
										listId={`delivery-parts-${i}`}
										options={props.parts}
										{...p}
									/>
									<LineOptions row={i} options={props.lineOptions.get(i) ?? []} {...p} />
									<div class="grid gap-4 md:grid-cols-2">
										<TextField
											name={f.qty}
											label={t.deliveries.qty}
											hint={t.deliveries.qtyHint}
											inputmode="decimal"
											{...p}
										/>
										<TextArea
											name={f.serials}
											label={t.deliveries.serials}
											hint={t.deliveries.serialsHint}
											rows={1}
											{...p}
										/>
									</div>
								</fieldset>
							);
						})}
						{props.lines < MAX_LINES ? (
							<div>
								<button
									type="submit"
									name="add_line"
									value="1"
									formaction={`/deliveries/new#line-${props.lines + 1}`}
									formnovalidate
									data-no-confirm
									class={buttonClass("outline", "sm")}
									data-slot="button"
								>
									<Icon icon={icons.plus} data-icon="inline-start" />
									{t.deliveries.addLine}
								</button>
							</div>
						) : null}
					</section>
					<div class="flex flex-wrap items-center gap-2">
						<Button icon={icons.truck}>{t.deliveries.ship}</Button>
						<Button href="/deliveries" variant="outline">
							{t.common.cancel}
						</Button>
					</div>
				</form>
				{rows.map((i) => (
					<PartPickerDialog name={lineFields(i).part} scope={{ kinds: ["buy", "make"] }} />
				))}
			</CardContent>
		</Card>
	);
}

async function renderForm(
	c: Context<AppEnv>,
	values: FormValues,
	errors: FormErrors,
	lines: number,
	lineOptions: Map<number, OptionDef[]>,
	status: 200 | 422 = 200,
) {
	const t = c.var.t;
	const [stocked, customers] = await Promise.all([partOptions(c.var.db, ["buy", "make"]), knownCustomers(c.var.db)]);
	return page(
		c,
		t.deliveries.newTitle,
		<>
			<PageHeader title={t.deliveries.newTitle} subtitle={t.deliveries.newIntro} />
			<DeliveryForm
				values={values}
				errors={errors}
				lines={lines}
				parts={stocked}
				lineOptions={lineOptions}
				customers={customers}
			/>
		</>,
		status,
	);
}

/** The first line filled from a completed build (its "Deliver" button): its product, serial or quantity, values. */
async function valuesFromBuild(c: Context<AppEnv>, buildId: number) {
	const values: FormValues = {};
	const lineOptions = new Map<number, OptionDef[]>();
	const found = await getBuild(c.var.db, buildId);
	if (found?.build.status !== "done") return { values, lineOptions };
	const { build, part } = found;
	const f = lineFields(1);
	values[f.part] = part.ref;
	if (part.trackSerial && build.serial) values[f.serials] = build.serial;
	else {
		values[f.qty] = formatQtyInput(build.qtyMilli, c.var.locale);
		const options = await optionsOf(c.var.db, part.id);
		lineOptions.set(1, options);
		const ids = idsOf(build.optionValues);
		for (const o of options) {
			const value = o.values.find((v) => ids.includes(v.id));
			if (value) values[f.option(o)] = String(value.id);
		}
	}
	return { values, lineOptions };
}

deliveryRoutes.get("/new", requirePermission("deliveries.ship"), async (c) => {
	const buildParam = c.req.query("build") ?? "";
	const { values, lineOptions } = /^\d+$/.test(buildParam)
		? await valuesFromBuild(c, Number(buildParam))
		: { values: {}, lineOptions: new Map<number, OptionDef[]>() };
	return renderForm(c, values, {}, 1, lineOptions);
});

/** "Add a line": the same form with one more row, nothing checked or saved. */
deliveryRoutes.post("/new", requirePermission("deliveries.ship"), async (c) => {
	const form = formStrings(await c.req.parseBody());
	const lines = Math.min(MAX_LINES, lineCount(form) + 1);
	const { lineOptions } = await readLines(c, form);
	return renderForm(c, form, {}, lines, lineOptions);
});

/** The option selects of a line whose part was just typed (htmx). */
deliveryRoutes.get("/new/options", requirePermission("deliveries.ship"), async (c) => {
	const row = Number(c.req.query("row"));
	if (!Number.isInteger(row) || row < 1 || row > MAX_LINES) return c.body(null, 400);
	const { options } = await linePart(c, (c.req.query(lineFields(row).part) ?? "").trim());
	return fragment(c, <LineOptions row={row} options={options} values={{}} errors={{}} />);
});

deliveryRoutes.post("/", requirePermission("deliveries.ship"), async (c) => {
	const t = c.var.t;
	const db = c.var.db;
	const form = formStrings(await c.req.parseBody());
	const v = validate(deliveryInput, form);
	const { requests, lineOptions } = await readLines(c, form);
	const now = nowIso();
	// Planned again when the batch is refused: another user took the number (D66), or a serial since (its guard).
	for (let attempt = 0; ; attempt++) {
		const plan = await planDelivery(db, requests);
		const errors: FieldErrors = { ...(v.ok ? {} : translateErrors(c, v.errors)), ...lineErrors(c, plan) };
		if (!v.ok || Object.keys(errors).length > 0) {
			return renderForm(c, form, errors, lineCount(form), lineOptions, 422);
		}
		const header = deliveryHeader(v.data, now);
		try {
			const number = await nextDeliveryNumber(db);
			const { results } = await saveChanges(
				c,
				fmt(t.history.summaries.deliveryCreate, { number, customer: header.customer }),
				deliveryStatements(db, number, header, plan.moves, c.var.user, now),
			);
			return redirectOk(c, `/deliveries/${(results[0] as { id: number }[])[0]?.id}`, "shipped");
		} catch (err) {
			if (attempt > 1 || !(isConstraintError(err, "UNIQUE") || isGuardError(err))) throw err;
		}
	}
});

/** The errors of the lines, each with its own words (two lines can name two parts). */
function lineErrors(c: Context<AppEnv>, plan: { errors: FieldErrors; vars: Record<string, Record<string, string>> }) {
	return Object.fromEntries(
		Object.entries(plan.errors).map(([name, key]) => [name, errorText(c.var.t, key, plan.vars[name] ?? {})]),
	);
}

// ---------------------------------------------------------------------------
// A delivery: what left, its header (editable while shipped), cancel.

function EditCard(props: { id: number; values: FormValues; errors: FormErrors }) {
	const { t } = useApp();
	const p = { values: props.values, errors: props.errors };
	return (
		<CollapsibleCard title={t.deliveries.edit} icon={icons.pencil} open={Object.keys(props.errors).length > 0}>
			<form method="post" action={`/deliveries/${props.id}`} class="flex flex-col gap-6">
				<p class="text-sm text-muted-foreground">{t.deliveries.editHint}</p>
				<FieldGroup>
					<div class="grid gap-4 md:grid-cols-2">
						<TextField name="customer" label={t.deliveries.customer} required {...p} />
						<TextField name="customer_ref" label={t.deliveries.customerRef} {...p} />
					</div>
					<div class="grid gap-4 md:grid-cols-3">
						<TextField name="shipped_on" label={t.deliveries.shippedOn} type="date" required {...p} />
						<TextField name="carrier" label={t.deliveries.carrier} {...p} />
						<TextField name="tracking_number" label={t.deliveries.trackingNumber} {...p} />
					</div>
					<TextArea name="notes" label={t.common.notes} {...p} />
				</FieldGroup>
				<div class="flex flex-wrap items-center gap-2">
					<Button variant="outline" icon={icons.save}>
						{t.common.save}
					</Button>
				</div>
			</form>
		</CollapsibleCard>
	);
}

async function renderDelivery(
	c: Context<AppEnv>,
	found: NonNullable<Awaited<ReturnType<typeof getDelivery>>>,
	edit: { values: FormValues; errors: FormErrors } | null = null,
) {
	const t = c.var.t;
	const { delivery: d, lines } = found;
	const ok = c.req.query("ok");
	const flash = ok
		? (
				{ shipped: t.deliveries.shippedOk, cancelled: t.deliveries.cancelledOk, saved: t.deliveries.savedOk } as Record<
					string,
					string
				>
			)[ok]
		: undefined;
	const shipped = d.status === "shipped";
	const canCancel = shipped && can(c.var, "deliveries.cancel");
	const canEdit = shipped && can(c.var, "deliveries.ship");
	return page(
		c,
		`${d.number} · ${d.customer}`,
		<>
			<PageHeader
				title={`${d.number} · ${d.customer}`}
				subtitle={
					<span class="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
						<DeliveryStatusBadge status={d.status} />
						<span>{d.shippedOn}</span>
						{d.customerRef ? (
							<>
								<span aria-hidden="true">·</span>
								<span>{d.customerRef}</span>
							</>
						) : null}
					</span>
				}
				actions={
					canCancel ? (
						<PostButton
							action={`/deliveries/${d.id}/cancel`}
							label={t.deliveries.cancel}
							confirm={t.deliveries.cancelConfirm}
							icon={icons.ban}
						/>
					) : undefined
				}
			/>
			<Flash message={flash} />
			{c.req.query("err") ? <Alert variant="destructive">{errorText(t, c.req.query("err") ?? "")}</Alert> : null}
			{d.status === "cancelled" ? (
				<Alert variant="warning">
					{fmt(t.deliveries.cancelledOn, { date: shortDateTime(d.cancelledAt), user: d.updatedBy })}
				</Alert>
			) : null}
			<div class="flex flex-col gap-6">
				<Card>
					<CardHeader>
						<CardTitle icon={icons.truck}>{t.deliveries.details}</CardTitle>
					</CardHeader>
					<CardContent>
						<DetailList
							items={[
								{ label: t.deliveries.customer, value: d.customer },
								{ label: t.deliveries.customerRef, value: d.customerRef || t.common.none },
								{ label: t.deliveries.shippedOn, value: d.shippedOn },
								{ label: t.deliveries.carrier, value: d.carrier || t.common.none },
								{ label: t.deliveries.trackingNumber, value: d.trackingNumber || t.common.none },
								{ label: t.stock.by, value: `${d.createdBy} · ${shortDateTime(d.createdAt)}` },
							]}
						/>
						{d.notes ? <p class="mt-4 text-sm whitespace-pre-wrap">{d.notes}</p> : null}
					</CardContent>
				</Card>
				<TableCard title={t.deliveries.lines}>
					{lines.length === 0 ? (
						<CardEmpty />
					) : (
						<Table>
							<TableHeader class="bg-muted/50">
								<TableRow>
									<TableHead>{t.parts.ref}</TableHead>
									<TableHead>{t.parts.name}</TableHead>
									<TableHead class="text-right">{t.deliveries.qty}</TableHead>
									<TableHead>{t.stock.serial}</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{lines.map((l) => (
									<TableRow>
										<TableCell class="font-medium">
											<a href={`/parts/${l.partId}`}>{l.ref}</a>
											{l.values ? (
												<span class="block text-xs font-normal text-muted-foreground">{l.values}</span>
											) : null}
										</TableCell>
										<TableCell>{l.name}</TableCell>
										<TableCell class="text-right">
											<Qty milli={l.qtyMilli} unit={l.unit} />
										</TableCell>
										<TableCell>
											{l.serial ? <span class="font-mono text-xs">{l.serial}</span> : null}
											{l.buildId ? (
												<a href={`/builds/${l.buildId}`} class="block text-xs">
													{fmt(t.deliveries.builtIn, { number: l.buildNumber ?? "" })}
												</a>
											) : null}
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					)}
				</TableCard>
				{canEdit ? (
					<EditCard id={d.id} values={edit?.values ?? deliveryFormValues(d)} errors={edit?.errors ?? {}} />
				) : null}
				{canCancel ? <p class="text-sm text-muted-foreground">{t.deliveries.cancelHint}</p> : null}
			</div>
		</>,
		edit && Object.keys(edit.errors).length > 0 ? 422 : 200,
	);
}

deliveryRoutes.get("/:id", async (c) => {
	const id = idParam(c);
	const found = id ? await getDelivery(c.var.db, id) : undefined;
	return found ? renderDelivery(c, found) : notFound(c);
});

deliveryRoutes.post("/:id", requirePermission("deliveries.ship"), async (c) => {
	const t = c.var.t;
	const id = idParam(c);
	const found = id ? await getDelivery(c.var.db, id) : undefined;
	if (!found) return notFound(c);
	if (found.delivery.status !== "shipped") return c.redirect(`/deliveries/${found.delivery.id}`, 303);
	const form = formStrings(await c.req.parseBody());
	const v = validate(deliveryInput, form);
	if (!v.ok) return renderDelivery(c, found, { values: form, errors: translateErrors(c, v.errors) });
	const now = nowIso();
	// The date stays what it was when the field is emptied (the new form's "today" is for a new delivery).
	const header = deliveryHeader({ ...v.data, shipped_on: v.data.shipped_on ?? found.delivery.shippedOn }, now);
	const saved = await saveChanges(c, fmt(t.history.summaries.deliveryEdit, { number: found.delivery.number }), [
		updateDeliveryStatement(c.var.db, found.delivery.id, header, c.var.user, now),
	]);
	// Nothing saved: nothing changed, or the delivery was cancelled meanwhile (the update leaves a cancelled one alone).
	if (saved.id === null && (await getDelivery(c.var.db, found.delivery.id))?.delivery.status !== "shipped")
		return c.redirect(`/deliveries/${found.delivery.id}`, 303);
	return redirectOk(c, `/deliveries/${found.delivery.id}`, "saved");
});

deliveryRoutes.post("/:id/cancel", requirePermission("deliveries.cancel"), async (c) => {
	const t = c.var.t;
	const id = idParam(c);
	const found = id ? await getDelivery(c.var.db, id) : undefined;
	if (!found) return notFound(c);
	const d = found.delivery;
	if (d.status === "shipped") {
		// A serial in stock again (taken back, maybe delivered again) would be counted twice (D218).
		const back = await serialsBackInStock(c.var.db, d.id);
		if (back.length > 0) return c.redirect(`/deliveries/${d.id}?err=delivery_serial_back_in_stock`, 303);
		try {
			await saveChanges(
				c,
				fmt(t.history.summaries.deliveryCancel, { number: d.number }),
				cancelDeliveryStatements(c.var.db, d, fmt(t.deliveries.cancelNote, { number: d.number }), c.var.user, nowIso()),
			);
		} catch (err) {
			if (!isGuardError(err)) throw err;
			return c.redirect(`/deliveries/${d.id}?err=delivery_serial_back_in_stock`, 303);
		}
	}
	return redirectOk(c, `/deliveries/${d.id}`, "cancelled");
});
