// Machines (D147): machine types with their hourly rate, and the machines the workshop owns.
import type { Context } from "hono";
import { Hono } from "hono";
import { MACHINE_STATUSES, type MachineType } from "../db/schema";
import {
	createMachineStatement,
	getMachine,
	getMachineType,
	listMachines,
	listMachineTypes,
	machineErrors,
	machineInput,
	machineToForm,
	machineTypeInput,
	machineTypeNameTaken,
	machineTypeOptions,
	machineTypeToForm,
	rateHistoryOf,
	recipesOfType,
	saveMachineTypeStatements,
	setMachineStatusStatement,
	updateMachineStatement,
} from "../domain/machines";
import { can } from "../domain/permissions";
import { computeShortages, type MachineLoad } from "../domain/purchasing";
import { fmt } from "../i18n";
import { formatMinutes, MILLI, mulDivCeil } from "../lib/units";
import { type FieldErrors, validate } from "../lib/validation";
import { requirePermission } from "../middleware/roles";
import type { AppEnv } from "../types";
import { StatusBadge } from "../views/assembly";
import { useApp } from "../views/context";
import { icons } from "../views/icons";
import { Duration, MachineStatusBadge } from "../views/machines";
import { idParam, notFound, nowIso, page, redirectOk, saveChanges, translateErrors } from "../views/render";
import {
	Button,
	Card,
	CardContent,
	CardEmpty,
	CardHeader,
	CardTitle,
	DecimalField,
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
	SelectField,
	Table,
	TableBody,
	TableCard,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
	TextArea,
	TextField,
	ToggleLinks,
} from "../views/ui";

export const machineRoutes = new Hono<AppEnv>();

type TypeRow = Awaited<ReturnType<typeof listMachineTypes>>[number];
type MachineRow = Awaited<ReturnType<typeof listMachines>>[number];

/** Planned time of a type, and per machine in service (D150). */
function LoadCell(props: { load: MachineLoad | undefined; active: number }) {
	const { t } = useApp();
	if (!props.load) return <span class="text-muted-foreground">{t.common.none}</span>;
	return (
		<span class="flex flex-col items-end gap-0.5">
			<Duration minutesMilli={props.load.minutesMilli} />
			<span class="text-xs text-muted-foreground">
				{props.active > 0
					? fmt(t.machines.perMachine, {
							time: formatMinutes(mulDivCeil(props.load.minutesMilli, 1, props.active)),
						})
					: t.machines.noMachineInService}
			</span>
		</span>
	);
}

function TypesTable(props: { rows: TypeRow[]; load: Map<number, MachineLoad> }) {
	const { t, seeCosts } = useApp();
	return (
		<Table>
			<TableHeader>
				<TableRow>
					<TableHead>{t.machines.name}</TableHead>
					{seeCosts ? <TableHead class="text-right">{t.machines.hourlyRate}</TableHead> : null}
					<TableHead class="text-right">{t.machines.activeMachines}</TableHead>
					<TableHead class="text-right">{t.machines.recipes}</TableHead>
					<TableHead class="text-right">{t.machines.load}</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{props.rows.map((r) => (
					<TableRow>
						<TableCell class="font-medium">
							<a href={`/machines/types/${r.id}`}>{r.name}</a>
						</TableCell>
						{seeCosts ? (
							<TableCell class="text-right whitespace-nowrap">
								<Money cents={r.hourlyRateCents} />
								{r.hourlyRateCents === null ? null : t.machines.perHour}
							</TableCell>
						) : null}
						<TableCell class="text-right tabular-nums">
							{r.activeMachines} / {r.machineCount}
						</TableCell>
						<TableCell class="text-right tabular-nums">{r.recipeCount}</TableCell>
						<TableCell class="text-right">
							<LoadCell load={props.load.get(r.id)} active={r.activeMachines} />
						</TableCell>
					</TableRow>
				))}
			</TableBody>
		</Table>
	);
}

function MachinesTable(props: { rows: MachineRow[]; showType?: boolean }) {
	const { t, seeCosts } = useApp();
	const showType = props.showType ?? true;
	return (
		<Table>
			<TableHeader>
				<TableRow>
					<TableHead>{t.machines.name}</TableHead>
					{showType ? <TableHead>{t.machines.type}</TableHead> : null}
					{showType && seeCosts ? <TableHead class="text-right">{t.machines.hourlyRate}</TableHead> : null}
					<TableHead>{t.machines.status}</TableHead>
					<TableHead>{t.common.notes}</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{props.rows.map((m) => (
					<TableRow>
						<TableCell class="font-medium whitespace-nowrap">
							<a href={`/machines/${m.id}`}>{m.name}</a>
						</TableCell>
						{showType ? (
							<TableCell class="whitespace-nowrap">
								<a href={`/machines/types/${m.typeId}`}>{m.typeName}</a>
							</TableCell>
						) : null}
						{showType && seeCosts ? (
							<TableCell class="text-right whitespace-nowrap">
								<Money cents={m.hourlyRateCents} />
								{m.hourlyRateCents === null ? null : t.machines.perHour}
							</TableCell>
						) : null}
						<TableCell>
							<MachineStatusBadge status={m.status} />
						</TableCell>
						<TableCell class="max-w-80 truncate text-muted-foreground">{m.notes}</TableCell>
					</TableRow>
				))}
			</TableBody>
		</Table>
	);
}

machineRoutes.get("/", async (c) => {
	const t = c.var.t;
	const db = c.var.db;
	const retired = c.req.query("retired") === "1";
	const [types, list, shortages] = await Promise.all([
		listMachineTypes(db),
		listMachines(db, { retired }),
		computeShortages(db),
	]);
	const load = new Map(shortages.machines.map((m) => [m.machineType.id, m]));
	const canEdit = can(c.var, "machines.edit");
	return page(
		c,
		t.machines.title,
		<>
			<PageHeader
				title={t.machines.title}
				subtitle={t.machines.intro}
				actions={
					canEdit ? (
						<>
							<Button href="/machines/types/new" variant="outline" icon={icons.plus}>
								{t.machines.newType}
							</Button>
							{types.length ? (
								<Button href="/machines/new" icon={icons.plus}>
									{t.machines.newMachine}
								</Button>
							) : null}
						</>
					) : undefined
				}
			/>
			<Flash ok={c.req.query("ok")} />
			{types.length === 0 ? (
				<EmptyState icon={icons.cog} title={t.machines.noTypes} description={t.machines.noTypesHint}>
					{canEdit ? (
						<Button href="/machines/types/new" icon={icons.plus}>
							{t.machines.newType}
						</Button>
					) : null}
				</EmptyState>
			) : (
				<div class="flex flex-col gap-6">
					<TableCard title={t.machines.types}>
						<TypesTable rows={types} load={load} />
					</TableCard>
					<TableCard
						title={t.machines.machines}
						action={
							<ToggleLinks
								label={t.machines.show}
								items={[
									{ href: "/machines", label: t.machines.hideRetired, active: !retired },
									{ href: "/machines?retired=1", label: t.machines.showRetired, active: retired },
								]}
							/>
						}
					>
						{list.length ? (
							<MachinesTable rows={list} />
						) : (
							<CardEmpty icon={icons.cog}>{t.machines.noMachines}</CardEmpty>
						)}
					</TableCard>
				</div>
			)}
		</>,
	);
});

// ---------------------------------------------------------------------------
// Machine types

function MachineTypeForm(props: { action: string; values: FormValues; errors: FormErrors; submit: string }) {
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
								<TextField name="name" label={t.machines.name} required autofocus {...p} />
								<DecimalField
									name="hourly_rate"
									label={t.machines.hourlyRate}
									hint={t.machines.hourlyRateHint}
									{...p}
								/>
							</div>
							<TextArea name="notes" label={t.common.notes} {...p} />
						</FieldGroup>
						<div class="flex flex-wrap items-center gap-2">
							<Button>{props.submit}</Button>
							<Button variant="outline" href="/machines">
								{t.common.cancel}
							</Button>
						</div>
					</form>
				</CardContent>
			</Card>
		</>
	);
}

machineRoutes.get("/types/new", requirePermission("machines.edit"), (c) => {
	const t = c.var.t;
	return page(
		c,
		t.machines.newType,
		<>
			<PageHeader title={t.machines.newType} subtitle={t.machines.typesIntro} />
			<MachineTypeForm action="/machines/types" values={{}} errors={{}} submit={t.common.create} />
		</>,
	);
});

machineRoutes.post("/types", requirePermission("machines.edit"), async (c) => {
	const t = c.var.t;
	const body = await c.req.parseBody();
	const v = validate(machineTypeInput, body);
	let errors: FieldErrors = v.ok ? {} : v.errors;
	if (v.ok && (await machineTypeNameTaken(c.var.db, v.data.name))) errors = { name: "duplicate_name" };
	if (!v.ok || Object.keys(errors).length) {
		return page(
			c,
			t.machines.newType,
			<>
				<PageHeader title={t.machines.newType} />
				<MachineTypeForm
					action="/machines/types"
					values={body as FormValues}
					errors={translateErrors(c, errors)}
					submit={t.common.create}
				/>
			</>,
			422,
		);
	}
	await saveChanges(
		c,
		fmt(t.history.summaries.machineTypeCreate, { name: v.data.name }),
		saveMachineTypeStatements(c.var.db, v.data, undefined, "form", c.var.user, nowIso()),
	);
	const created = (await listMachineTypes(c.var.db)).find((r) => r.name === v.data.name);
	return redirectOk(c, created ? `/machines/types/${created.id}` : "/machines");
});

async function renderType(
	c: Context<AppEnv>,
	type: MachineType,
	form?: { values: FormValues; errors: FieldErrors },
	status: 200 | 422 = 200,
) {
	const t = c.var.t;
	const db = c.var.db;
	const [list, recipes, rates] = await Promise.all([
		listMachines(db, { retired: true, typeId: type.id }),
		recipesOfType(db, type.id),
		c.var.seeCosts ? rateHistoryOf(db, type.id) : Promise.resolve([]),
	]);
	const canEdit = can(c.var, "machines.edit");
	return page(
		c,
		type.name,
		<>
			<PageHeader
				title={type.name}
				subtitle={fmt(t.common.updatedBy, { by: type.updatedBy, at: type.updatedAt.slice(0, 10) })}
				actions={
					canEdit ? (
						<Button href={`/machines/new?type=${type.id}`} variant="outline" icon={icons.plus}>
							{t.machines.newMachine}
						</Button>
					) : undefined
				}
			/>
			<Flash ok={c.req.query("ok")} />
			<div class="flex flex-col gap-6">
				{canEdit ? (
					<MachineTypeForm
						action={`/machines/types/${type.id}`}
						values={form?.values ?? machineTypeToForm(type, c.var.locale)}
						errors={translateErrors(c, form?.errors ?? {})}
						submit={t.common.save}
					/>
				) : (
					<Card>
						<CardContent>
							<DetailList
								items={[
									...(c.var.seeCosts
										? [
												{
													label: t.machines.hourlyRate,
													value: <Money cents={type.hourlyRateCents} />,
												},
											]
										: []),
									...(type.notes
										? [{ label: t.common.notes, value: <span class="whitespace-pre-wrap">{type.notes}</span> }]
										: []),
								]}
							/>
						</CardContent>
					</Card>
				)}
				<TableCard title={t.machines.machinesOfType}>
					{list.length ? (
						<MachinesTable rows={list} showType={false} />
					) : (
						<CardEmpty icon={icons.cog}>{t.machines.noMachines}</CardEmpty>
					)}
				</TableCard>
				<TableCard title={t.machines.recipesOfType}>
					{recipes.length ? (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>{t.assemblies.parent}</TableHead>
									<TableHead>{t.assemblies.code}</TableHead>
									<TableHead>{t.assemblies.status}</TableHead>
									<TableHead class="text-right">{t.assemblies.batchQty}</TableHead>
									<TableHead class="text-right">{t.machines.timePerBatch}</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{recipes.map((r) => (
									<TableRow>
										<TableCell>
											<a href={`/assemblies/${r.id}`} class="font-medium">
												{r.partRef}
											</a>{" "}
											<span class="text-muted-foreground">{r.partName}</span>
										</TableCell>
										<TableCell class="whitespace-nowrap">
											{r.code} · {r.revision}
										</TableCell>
										<TableCell>
											<StatusBadge status={r.status} />
										</TableCell>
										<TableCell class="text-right">
											<Qty milli={r.batchMilli} unit={r.unit} />
										</TableCell>
										<TableCell class="text-right">
											<Duration minutesMilli={r.machineMinutes * MILLI} />
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					) : (
						<CardEmpty icon={icons.layers}>{t.common.noResults}</CardEmpty>
					)}
				</TableCard>
				{c.var.seeCosts ? (
					<TableCard title={t.machines.rateHistory}>
						{rates.length ? (
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>{t.machines.validFrom}</TableHead>
										<TableHead class="text-right">{t.machines.hourlyRate}</TableHead>
										<TableHead>{t.machines.source}</TableHead>
										<TableHead>{t.common.notes}</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{rates.map((r) => (
										<TableRow>
											<TableCell class="whitespace-nowrap tabular-nums">{r.validFrom}</TableCell>
											<TableCell class="text-right">
												<Money cents={r.rateCents} />
											</TableCell>
											<TableCell>{t.parts.priceSources[r.source]}</TableCell>
											<TableCell class="text-muted-foreground">
												{[r.createdBy, r.note].filter(Boolean).join(" · ")}
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						) : (
							<CardEmpty icon={icons.history}>{t.common.noResults}</CardEmpty>
						)}
					</TableCard>
				) : null}
			</div>
		</>,
		status,
	);
}

machineRoutes.get("/types/:id", async (c) => {
	const id = idParam(c);
	const type = id ? await getMachineType(c.var.db, id) : undefined;
	if (!type) return notFound(c);
	return renderType(c, type);
});

machineRoutes.post("/types/:id", requirePermission("machines.edit"), async (c) => {
	const id = idParam(c);
	const type = id ? await getMachineType(c.var.db, id) : undefined;
	if (!type) return notFound(c);
	const body = await c.req.parseBody();
	const v = validate(machineTypeInput, body);
	let errors: FieldErrors = v.ok ? {} : v.errors;
	if (v.ok && (await machineTypeNameTaken(c.var.db, v.data.name, type.id))) errors = { name: "duplicate_name" };
	if (!v.ok || Object.keys(errors).length) return renderType(c, type, { values: body as FormValues, errors }, 422);
	await saveChanges(
		c,
		fmt(c.var.t.history.summaries.machineTypeEdit, { name: v.data.name }),
		saveMachineTypeStatements(c.var.db, v.data, type, "form", c.var.user, nowIso()),
	);
	return redirectOk(c, `/machines/types/${type.id}`);
});

// ---------------------------------------------------------------------------
// Machines

function MachineForm(props: {
	action: string;
	values: FormValues;
	errors: FormErrors;
	submit: string;
	types: { id: number; name: string }[];
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
							<div class="grid gap-4 md:grid-cols-3">
								<TextField name="name" label={t.machines.name} required autofocus {...p} />
								<SelectField
									name="machine_type_id"
									label={t.machines.type}
									required
									options={props.types.map((m) => ({ value: String(m.id), label: m.name }))}
									{...p}
								/>
								<SelectField
									name="status"
									label={t.machines.status}
									required
									options={MACHINE_STATUSES.map((s) => ({ value: s, label: t.machines.statuses[s] }))}
									{...p}
								/>
							</div>
							<TextArea name="notes" label={t.common.notes} {...p} />
						</FieldGroup>
						<div class="flex flex-wrap items-center gap-2">
							<Button>{props.submit}</Button>
							<Button variant="outline" href="/machines">
								{t.common.cancel}
							</Button>
						</div>
					</form>
				</CardContent>
			</Card>
		</>
	);
}

machineRoutes.get("/new", requirePermission("machines.edit"), async (c) => {
	const t = c.var.t;
	const types = await machineTypeOptions(c.var.db);
	const type = c.req.query("type") ?? String(types[0]?.id ?? "");
	return page(
		c,
		t.machines.newMachine,
		<>
			<PageHeader title={t.machines.newMachine} />
			<MachineForm
				action="/machines"
				values={{ machine_type_id: type, status: "active" }}
				errors={{}}
				submit={t.common.create}
				types={types}
			/>
		</>,
	);
});

machineRoutes.post("/", requirePermission("machines.edit"), async (c) => {
	const t = c.var.t;
	const body = await c.req.parseBody();
	const v = validate(machineInput, body);
	const errors: FieldErrors = v.ok ? await machineErrors(c.var.db, v.data) : v.errors;
	if (!v.ok || Object.keys(errors).length) {
		return page(
			c,
			t.machines.newMachine,
			<>
				<PageHeader title={t.machines.newMachine} />
				<MachineForm
					action="/machines"
					values={body as FormValues}
					errors={translateErrors(c, errors)}
					submit={t.common.create}
					types={await machineTypeOptions(c.var.db)}
				/>
			</>,
			422,
		);
	}
	const { results } = await saveChanges(c, fmt(t.history.summaries.machineCreate, { name: v.data.name }), [
		createMachineStatement(c.var.db, v.data, c.var.user, nowIso()),
	]);
	return redirectOk(c, `/machines/${results[0][0]?.id}`);
});

machineRoutes.get("/:id", async (c) => {
	const t = c.var.t;
	const id = idParam(c);
	const machine = id ? await getMachine(c.var.db, id) : undefined;
	if (!machine) return notFound(c);
	const [type, types] = await Promise.all([
		getMachineType(c.var.db, machine.machineTypeId),
		machineTypeOptions(c.var.db),
	]);
	const canEdit = can(c.var, "machines.edit");
	const ok = c.req.query("ok");
	return page(
		c,
		machine.name,
		<>
			<PageHeader
				title={machine.name}
				subtitle={
					<span class="flex flex-wrap items-center gap-x-3 gap-y-1">
						<a href={`/machines/types/${machine.machineTypeId}`}>{type?.name}</a>
						<MachineStatusBadge status={machine.status} />
					</span>
				}
				actions={
					canEdit && machine.status !== "retired" ? (
						<PostButton
							action={`/machines/${machine.id}/retire`}
							label={t.machines.retire}
							confirm={t.machines.confirmRetire}
							icon={icons.archive}
						/>
					) : undefined
				}
			/>
			<Flash ok={ok} message={ok === "retired" ? t.machines.retired : undefined} />
			{canEdit ? (
				<MachineForm
					action={`/machines/${machine.id}`}
					values={machineToForm(machine)}
					errors={{}}
					submit={t.common.save}
					types={types}
				/>
			) : (
				<Card>
					<CardHeader>
						<CardTitle>{t.machines.machines}</CardTitle>
					</CardHeader>
					<CardContent>
						<DetailList
							items={[
								{ label: t.machines.type, value: type?.name ?? "" },
								...(machine.notes
									? [{ label: t.common.notes, value: <span class="whitespace-pre-wrap">{machine.notes}</span> }]
									: []),
							]}
						/>
					</CardContent>
				</Card>
			)}
		</>,
	);
});

machineRoutes.post("/:id", requirePermission("machines.edit"), async (c) => {
	const t = c.var.t;
	const id = idParam(c);
	const machine = id ? await getMachine(c.var.db, id) : undefined;
	if (!machine) return notFound(c);
	const body = await c.req.parseBody();
	const v = validate(machineInput, body);
	const errors: FieldErrors = v.ok ? await machineErrors(c.var.db, v.data, machine.id) : v.errors;
	if (!v.ok || Object.keys(errors).length) {
		return page(
			c,
			machine.name,
			<>
				<PageHeader title={machine.name} />
				<MachineForm
					action={`/machines/${machine.id}`}
					values={body as FormValues}
					errors={translateErrors(c, errors)}
					submit={t.common.save}
					types={await machineTypeOptions(c.var.db)}
				/>
			</>,
			422,
		);
	}
	await saveChanges(c, fmt(t.history.summaries.machineEdit, { name: v.data.name }), [
		updateMachineStatement(c.var.db, machine.id, v.data, c.var.user, nowIso()),
	]);
	return redirectOk(c, `/machines/${machine.id}`);
});

machineRoutes.post("/:id/retire", requirePermission("machines.edit"), async (c) => {
	const id = idParam(c);
	const machine = id ? await getMachine(c.var.db, id) : undefined;
	if (!machine) return notFound(c);
	await saveChanges(c, fmt(c.var.t.history.summaries.machineRetire, { name: machine.name }), [
		setMachineStatusStatement(c.var.db, machine.id, "retired", c.var.user, nowIso()),
	]);
	return redirectOk(c, `/machines/${machine.id}`, "retired");
});
