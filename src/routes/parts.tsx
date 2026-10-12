import { asc, desc, eq } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { PART_KINDS, type Part, parts, stockMoves, suppliers } from "../db/schema";
import { partBomSummary, type WhereUsedRow, whereUsed } from "../domain/boms";
import { listBuilds } from "../domain/builds";
import {
	findRefClash,
	getPart,
	hasBoms,
	hasStockMoves,
	listParts,
	onHandOf,
	partColumns,
	partInput,
	partRuleErrors,
	partToForm,
} from "../domain/parts";
import { fmt } from "../i18n";
import { cn } from "../lib/cn";
import { isConstraintError } from "../lib/sql";
import { lineCostCents } from "../lib/units";
import { type FieldErrors, validate } from "../lib/validation";
import { requireAdmin } from "../middleware/auth";
import type { AppEnv } from "../types";
import { CostView, StatusBadge } from "../views/bom";
import { useApp } from "../views/context";
import { icons } from "../views/icons";
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
	CardHeader,
	CardTitle,
	CheckboxField,
	DecimalField,
	DetailList,
	EmptyState,
	ErrorBanner,
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

async function supplierOptions(c: Context<AppEnv>): Promise<SupplierOption[]> {
	return c.var.db.select({ id: suppliers.id, name: suppliers.name }).from(suppliers).orderBy(asc(suppliers.name));
}

function PartsTable(props: { rows: PartRow[]; filtered: boolean }) {
	const { t } = useApp();
	if (props.rows.length === 0) {
		return (
			<EmptyState
				icon={icons.package}
				title={t.parts.empty}
				description={props.filtered ? t.parts.emptyFiltered : t.parts.emptyHint}
			>
				{props.filtered ? null : (
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
						<TableHead>{t.parts.ref}</TableHead>
						<TableHead>{t.parts.name}</TableHead>
						<TableHead>{t.parts.kind}</TableHead>
						<TableHead>{t.parts.supplier}</TableHead>
						<TableHead class="text-right">{t.parts.cost}</TableHead>
						<TableHead class="text-right">{t.parts.onHand}</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{props.rows.map((p) => (
						<TableRow class={cn(p.archived && "opacity-60")}>
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
							<TableCell class="text-right">
								<Money cents={p.costCents} />
							</TableCell>
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
							<div class="grid gap-4 md:grid-cols-2">
								<TextField name="unit" label={t.parts.unit} placeholder="pcs" list="units" {...p} />
								<DecimalField name="cost" label={t.parts.cost} hint={t.parts.costHint} {...p} />
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
					<Button href="/parts/new" icon={icons.plus}>
						{t.parts.new}
					</Button>
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
				<PartsTable rows={rows} filtered={q !== "" || kind !== "" || supplierId !== null} />
			</div>
		</>,
	);
});

partRoutes.get("/new", async (c) => {
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

partRoutes.post("/", async (c) => {
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
	const user = c.var.user;
	const [row] = await c.var.db
		.insert(parts)
		.values({ ...partColumns(v.data), createdBy: user, updatedBy: user })
		.returning({ id: parts.id });
	return redirectOk(c, `/parts/${row?.id}`);
});

function PartDetail(props: {
	part: Part;
	supplier: { id: number; name: string; email: string; phone: string } | undefined;
	onHand: number;
	moves: (typeof stockMoves.$inferSelect)[];
	bomSummary: Awaited<ReturnType<typeof partBomSummary>>;
	usedIn: WhereUsedRow[];
	builds: Awaited<ReturnType<typeof listBuilds>>;
	ok?: string | undefined;
	err?: string | undefined;
}) {
	const { t, isAdmin } = useApp();
	const p = props.part;
	const stocked = p.kind === "buy" || p.kind === "make";
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
						<Button href={`/parts/${p.id}/edit`} variant="outline" icon={icons.pencil}>
							{t.common.edit}
						</Button>
						{stocked ? (
							<Button href={`/stock/adjust?part=${p.id}`} variant="outline" icon={icons.arrowUpDown}>
								{t.parts.adjustStock}
							</Button>
						) : null}
						{isAdmin ? (
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
						{isAdmin ? (
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
			{props.err === "in_use" ? <Alert variant="destructive">{t.errors.in_use}</Alert> : null}
			<div class="flex flex-col gap-4">
				<div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
					{stocked ? (
						<StatCard
							label={t.parts.onHand}
							value={<Qty milli={props.onHand} unit={p.unit} />}
							icon={icons.warehouse}
							tone={props.onHand < 0 ? "destructive" : "default"}
							hint={
								p.costCents !== null ? (
									<>
										{t.parts.stockValue}: <Money cents={lineCostCents(props.onHand, p.costCents)} />
									</>
								) : undefined
							}
						/>
					) : null}
					<StatCard
						label={t.parts.cost}
						value={<Money cents={p.costCents} />}
						icon={icons.coins}
						tone={p.costCents === null && !rollup ? "warning" : "default"}
					/>
					{rollup ? (
						<StatCard
							label={t.parts.rollupCost}
							value={<CostView cost={rollup} refs={refs} />}
							icon={icons.listTree}
							tone={rollup.incomplete ? "warning" : "default"}
						/>
					) : null}
				</div>
				<div class="grid gap-4 lg:grid-cols-2">
					<Card>
						<CardHeader>
							<CardTitle>{t.parts.info}</CardTitle>
						</CardHeader>
						<CardContent>
							<DetailList
								items={[
									{ label: t.parts.unit, value: p.unit },
									{ label: t.parts.trackSerial, value: p.trackSerial ? t.common.yes : t.common.no },
									...(p.notes
										? [{ label: t.common.notes, value: <span class="whitespace-pre-wrap">{p.notes}</span> }]
										: []),
								]}
							/>
						</CardContent>
					</Card>
					<Card>
						<CardHeader>
							<CardTitle>{t.parts.purchasing}</CardTitle>
						</CardHeader>
						<CardContent>
							<DetailList
								items={[
									{
										label: t.parts.supplier,
										value: props.supplier ? (
											<a href={`/suppliers/${props.supplier.id}`}>{props.supplier.name}</a>
										) : (
											t.common.none
										),
									},
									...(props.supplier?.email
										? [
												{
													label: t.suppliers.email,
													value: <a href={`mailto:${props.supplier.email}`}>{props.supplier.email}</a>,
												},
											]
										: []),
									...(props.supplier?.phone ? [{ label: t.suppliers.phone, value: props.supplier.phone }] : []),
									{ label: t.parts.supplierRef, value: p.supplierRef || t.common.none },
									{ label: t.parts.moq, value: <Qty milli={p.moqMilli} unit={p.unit} /> },
									{
										label: t.parts.packSize,
										value: p.packSizeMilli ? <Qty milli={p.packSizeMilli} unit={p.unit} /> : t.common.none,
									},
									{ label: t.parts.leadDays, value: <span class="tabular-nums">{p.leadDays}</span> },
								]}
							/>
						</CardContent>
					</Card>
				</div>
				{p.kind === "make" || p.kind === "kit" ? <PartBoms part={p} summary={props.bomSummary} /> : null}
				{p.kind === "make" ? (
					<Card>
						<CardHeader>
							<CardTitle>{t.builds.recent}</CardTitle>
							<CardAction>
								<Button href={`/builds/new?part=${p.id}`} variant="outline" size="sm" icon={icons.plus}>
									{t.builds.new}
								</Button>
							</CardAction>
						</CardHeader>
						<CardContent class="px-2">
							<BuildsTable rows={props.builds} />
						</CardContent>
					</Card>
				) : null}
				<WhereUsed rows={props.usedIn} />
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

function PartBoms(props: { part: Part; summary: Awaited<ReturnType<typeof partBomSummary>> }) {
	const { t } = useApp();
	const { summary } = props;
	const only = summary.boms.length === 1 ? summary.boms[0] : undefined;
	return (
		<Card>
			<CardHeader>
				<CardTitle>{t.parts.boms}</CardTitle>
				{summary.rollup ? (
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
					<Button href={`/boms/new?part=${props.part.id}`} variant="outline" size="sm" icon={icons.plus}>
						{t.boms.new}
					</Button>
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
								<TableHead class="text-right">{t.boms.totalCost}</TableHead>
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
									<TableCell class="text-right">
										<CostView cost={b.cost} refs={summary.refs} />
									</TableCell>
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
	const [supplierRows, onHand, moves, bomSummary, usedIn, recent] = await Promise.all([
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
	]);
	return page(
		c,
		part.ref,
		<PartDetail
			part={part}
			supplier={supplierRows[0]}
			onHand={onHand}
			moves={moves}
			bomSummary={bomSummary}
			usedIn={usedIn}
			builds={recent}
			ok={c.req.query("ok")}
			err={c.req.query("err")}
		/>,
	);
});

partRoutes.get("/:id/edit", async (c) => {
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
				values={partToForm(part, c.var.locale)}
				errors={{}}
				suppliers={await supplierOptions(c)}
				submit={t.common.save}
				cancel={`/parts/${part.id}`}
			/>
		</>,
	);
});

partRoutes.post("/:id", async (c) => {
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
	await c.var.db
		.update(parts)
		.set({ ...partColumns(v.data), updatedAt: nowIso(), updatedBy: c.var.user })
		.where(eq(parts.id, part.id));
	return redirectOk(c, `/parts/${part.id}`);
});

for (const [action, archived] of [
	["archive", true],
	["unarchive", false],
] as const) {
	partRoutes.post(`/:id/${action}`, requireAdmin, async (c) => {
		const id = idParam(c);
		if (!id) return notFound(c);
		await c.var.db.update(parts).set({ archived, updatedAt: nowIso(), updatedBy: c.var.user }).where(eq(parts.id, id));
		return redirectOk(c, `/parts/${id}`, archived ? "archived" : "unarchived");
	});
}

partRoutes.post("/:id/delete", requireAdmin, async (c) => {
	const id = idParam(c);
	if (!id) return notFound(c);
	try {
		await c.var.db.delete(parts).where(eq(parts.id, id));
	} catch (err) {
		if (isConstraintError(err, "FOREIGN KEY")) return c.redirect(`/parts/${id}?err=in_use`, 303);
		throw err;
	}
	return redirectOk(c, "/parts", "deleted");
});
