// A part's options and their values (D168, D173): the edit page and its actions. Mounted under /parts.
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { builds, type Part, poLines, purchaseOrders } from "../db/schema";
import { OPEN_STATUSES } from "../domain/builds";
import type { OptionDef } from "../domain/option-keys";
import {
	addOptionStatements,
	deleteOptionStatement,
	editOptionStatements,
	moveOptionStatements,
	newOptionErrors,
	newOptionInput,
	optionEditErrors,
	optionsKindError,
	optionsOf,
	readOptionEdit,
	valueLines,
	valuesInUse,
} from "../domain/options";
import { getPart } from "../domain/parts";
import { can } from "../domain/permissions";
import { OPEN_PO_STATUSES } from "../domain/purchasing";
import { stockByKey } from "../domain/stock";
import { errorText, fmt } from "../i18n";
import { validate } from "../lib/validation";
import { requirePermission } from "../middleware/roles";
import type { AppEnv } from "../types";
import { useApp } from "../views/context";
import { icons } from "../views/icons";
import { idParam, notFound, nowIso, page, redirectOk, saveChanges, translateErrors } from "../views/render";
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
	ErrorBanner,
	FieldGroup,
	Flash,
	type FormErrors,
	type FormValues,
	PageHeader,
	PostButton,
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
	TextArea,
	TextField,
} from "../views/ui";

export const partOptionRoutes = new Hono<AppEnv>();

/** Whether adding an option would move stock or rename open records (D173): the page warns, and it needs stock.adjust. */
async function hasOpenRecords(c: Context<AppEnv>, partId: number): Promise<boolean> {
	const db = c.var.db;
	const [stock, lines, open] = await Promise.all([
		stockByKey(db, null, partId),
		db
			.select({ id: poLines.id })
			.from(poLines)
			.innerJoin(purchaseOrders, eq(poLines.poId, purchaseOrders.id))
			.where(
				and(
					eq(poLines.partId, partId),
					inArray(purchaseOrders.status, OPEN_PO_STATUSES),
					sql`${poLines.receivedQtyMilli} < ${poLines.qtyMilli}`,
				),
			)
			.limit(1),
		db
			.select({ id: builds.id })
			.from(builds)
			.where(and(eq(builds.partId, partId), inArray(builds.status, OPEN_STATUSES)))
			.limit(1),
	]);
	return stock.some((r) => r.qty !== 0) || lines.length > 0 || open.length > 0;
}

type EditState = { optionId: number; values: FormValues; errors: FormErrors };

function OptionEditCard(props: { part: Part; option: OptionDef; inUse: Set<number>; state?: EditState }) {
	const { t } = useApp();
	const o = props.option;
	const values = props.state?.values ?? {};
	const errors = props.state?.errors ?? {};
	const optionInUse = o.values.some((v) => props.inUse.has(v.id));
	const action = `/parts/${props.part.id}/options/${o.id}`;
	return (
		<Card id={`option-${o.id}`}>
			<CardHeader>
				<CardTitle icon={icons.options}>{o.name}</CardTitle>
				<CardAction>
					<div class="flex flex-wrap gap-2">
						<PostButton action={`${action}/move?dir=up`} label={t.options.moveUp} icon={icons.arrowUp} size="sm" />
						<PostButton
							action={`${action}/move?dir=down`}
							label={t.options.moveDown}
							icon={icons.arrowDown}
							size="sm"
						/>
						{optionInUse ? null : (
							<PostButton
								action={`${action}/delete`}
								label={t.options.delete}
								confirm={t.options.confirmDelete}
								variant="destructive"
								icon={icons.trash}
								size="sm"
							/>
						)}
					</div>
				</CardAction>
			</CardHeader>
			<form method="post" action={action}>
				<CardContent>
					<FieldGroup>
						<TextField
							name="name"
							label={t.options.name}
							values={{ name: values.name ?? o.name }}
							errors={errors}
							hint={t.options.renameHint}
							required
						/>
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>{t.options.value}</TableHead>
									<TableHead>{t.options.default}</TableHead>
									<TableHead>{t.options.remove}</TableHead>
									<TableHead class="text-right">{t.common.actions}</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{o.values.map((v, i) => {
									const name = `value_${v.id}`;
									const checkedDefault = values.default ? values.default === String(v.id) : v.isDefault;
									return (
										<TableRow>
											<TableCell>
												<input
													data-slot="input"
													name={name}
													value={values[name] ?? v.name}
													aria-label={t.options.value}
													aria-invalid={errors[name] ? "true" : undefined}
												/>
												{errors[name] ? <p class="text-sm text-destructive">{errors[name]}</p> : null}
											</TableCell>
											<TableCell>
												<input
													type="radio"
													name="default"
													value={String(v.id)}
													checked={checkedDefault}
													aria-label={`${t.options.default} ${v.name}`}
												/>
											</TableCell>
											<TableCell>
												{props.inUse.has(v.id) ? (
													<Badge variant="muted">{t.options.inUse}</Badge>
												) : (
													<input
														type="checkbox"
														data-slot="checkbox"
														name={`remove_${v.id}`}
														value="on"
														checked={values[`remove_${v.id}`] === "on"}
														aria-label={`${t.options.remove} ${v.name}`}
													/>
												)}
											</TableCell>
											<TableCell class="text-right whitespace-nowrap">
												<Button
													name="move"
													value={`${v.id}:up`}
													variant="ghost"
													size="icon"
													icon={icons.arrowUp}
													disabled={i === 0}
													aria-label={`${t.options.moveUp} ${v.name}`}
												/>
												<Button
													name="move"
													value={`${v.id}:down`}
													variant="ghost"
													size="icon"
													icon={icons.arrowDown}
													disabled={i === o.values.length - 1}
													aria-label={`${t.options.moveDown} ${v.name}`}
												/>
											</TableCell>
										</TableRow>
									);
								})}
							</TableBody>
						</Table>
						{errors.default ? <p class="text-sm text-destructive">{errors.default}</p> : null}
						<TextArea
							name="add"
							label={t.options.newValues}
							hint={t.options.newValuesHint}
							values={{ add: values.add ?? "" }}
							errors={errors}
							rows={2}
						/>
					</FieldGroup>
				</CardContent>
				<CardFooter>
					<Button icon={icons.save}>{t.common.save}</Button>
				</CardFooter>
			</form>
		</Card>
	);
}

function NewOptionCard(props: { part: Part; values: FormValues; errors: FormErrors; transfer: boolean }) {
	const { t } = useApp();
	return (
		<Card id="new-option">
			<CardHeader>
				<CardTitle icon={icons.plus}>{t.options.add}</CardTitle>
			</CardHeader>
			<form method="post" action={`/parts/${props.part.id}/options`}>
				<CardContent>
					<FieldGroup>
						{props.transfer ? <Alert variant="warning">{t.options.transferWarning}</Alert> : null}
						<TextField name="name" label={t.options.name} values={props.values} errors={props.errors} required />
						<TextArea
							name="values"
							label={t.options.values}
							hint={t.options.valuesHint}
							values={props.values}
							errors={props.errors}
							rows={4}
							required
						/>
					</FieldGroup>
				</CardContent>
				<CardFooter>
					<Button icon={icons.plus}>{t.options.add}</Button>
				</CardFooter>
			</form>
		</Card>
	);
}

async function optionsPage(
	c: Context<AppEnv>,
	part: Part,
	state: { add?: { values: FormValues; errors: FormErrors }; edit?: EditState } = {},
	status: 200 | 422 = 200,
) {
	const t = c.var.t;
	const options = await optionsOf(c.var.db, part.id);
	const [inUse, transfer] = await Promise.all([
		valuesInUse(
			c.var.db,
			part.id,
			options.flatMap((o) => o.values.map((v) => v.id)),
		),
		hasOpenRecords(c, part.id),
	]);
	const title = fmt(t.options.editTitle, { ref: part.ref });
	const err = c.req.query("err");
	return page(
		c,
		title,
		<>
			<PageHeader
				title={title}
				subtitle={t.options.intro}
				actions={
					<Button href={`/parts/${part.id}`} variant="outline" icon={icons.arrowLeft}>
						{t.common.back}
					</Button>
				}
			/>
			<Flash ok={c.req.query("ok")} message={c.req.query("ok") === "added" ? t.options.added : undefined} />
			{err === "option_in_use" ? <Alert variant="destructive">{errorText(t, err)}</Alert> : null}
			<ErrorBanner show={status === 422} />
			<div class="flex flex-col gap-4">
				{options.map((o) => (
					<OptionEditCard
						part={part}
						option={o}
						inUse={inUse}
						state={state.edit?.optionId === o.id ? state.edit : undefined}
					/>
				))}
				<NewOptionCard
					part={part}
					values={state.add?.values ?? {}}
					errors={state.add?.errors ?? {}}
					transfer={transfer}
				/>
			</div>
		</>,
		status,
	);
}

/** The part of the route, when it may have options (buy, make). */
async function optionPart(c: Context<AppEnv>): Promise<Part | undefined> {
	const id = idParam(c);
	const part = id ? await getPart(c.var.db, id) : undefined;
	return part && optionsKindError(part.kind) === null ? part : undefined;
}

partOptionRoutes.get("/:id/options", requirePermission("parts.edit"), async (c) => {
	const part = await optionPart(c);
	return part ? optionsPage(c, part) : notFound(c);
});

partOptionRoutes.post("/:id/options", requirePermission("parts.edit"), async (c) => {
	const t = c.var.t;
	const part = await optionPart(c);
	if (!part) return notFound(c);
	const body = (await c.req.parseBody()) as Record<string, string>;
	const v = validate(newOptionInput, body);
	const options = await optionsOf(c.var.db, part.id);
	const values = v.ok ? valueLines(v.data.values) : [];
	const errors = v.ok ? newOptionErrors(options, v.data.name, values) : v.errors;
	// Moving existing stock onto the new values is a stock adjustment (D173).
	if (Object.keys(errors).length === 0 && (await hasOpenRecords(c, part.id)) && !can(c.var, "stock.adjust"))
		return c.text(t.errors.forbidden, 403);
	if (!v.ok || Object.keys(errors).length > 0)
		return optionsPage(c, part, { add: { values: body, errors: translateErrors(c, errors) } }, 422);
	const note = fmt(t.options.transferNote, { option: v.data.name, value: values[0] ?? "" });
	await saveChanges(
		c,
		fmt(t.history.summaries.optionAdd, { option: v.data.name, ref: part.ref }),
		addOptionStatements(c.var.db, part, { name: v.data.name, values }, note, c.var.user, nowIso()),
	);
	return redirectOk(c, `/parts/${part.id}/options`, "added");
});

partOptionRoutes.post("/:id/options/:optionId", requirePermission("parts.edit"), async (c) => {
	const t = c.var.t;
	const part = await optionPart(c);
	const optionId = idParam(c, "optionId");
	if (!part || !optionId) return notFound(c);
	const options = await optionsOf(c.var.db, part.id);
	const option = options.find((o) => o.id === optionId);
	if (!option) return notFound(c);
	const body = (await c.req.parseBody()) as Record<string, string>;
	const edit = readOptionEdit(option, body);
	const inUse = await valuesInUse(
		c.var.db,
		part.id,
		option.values.map((v) => v.id),
	);
	const { errors } = optionEditErrors(
		options.filter((o) => o.id !== option.id),
		edit,
		inUse,
	);
	if (Object.keys(errors).length > 0)
		return optionsPage(c, part, { edit: { optionId, values: body, errors: translateErrors(c, errors) } }, 422);
	const stmts = editOptionStatements(c.var.db, option, edit, c.var.user, nowIso());
	if (stmts.length)
		await saveChanges(c, fmt(t.history.summaries.optionEdit, { option: edit.name, ref: part.ref }), stmts);
	return redirectOk(c, `/parts/${part.id}/options#option-${option.id}`);
});

partOptionRoutes.post("/:id/options/:optionId/delete", requirePermission("parts.edit"), async (c) => {
	const t = c.var.t;
	const part = await optionPart(c);
	const optionId = idParam(c, "optionId");
	if (!part || !optionId) return notFound(c);
	const option = (await optionsOf(c.var.db, part.id)).find((o) => o.id === optionId);
	if (!option) return notFound(c);
	const inUse = await valuesInUse(
		c.var.db,
		part.id,
		option.values.map((v) => v.id),
	);
	if (inUse.size > 0) return c.redirect(`/parts/${part.id}/options?err=option_in_use`, 303);
	await saveChanges(c, fmt(t.history.summaries.optionDelete, { option: option.name, ref: part.ref }), [
		deleteOptionStatement(c.var.db, option.id),
	]);
	return redirectOk(c, `/parts/${part.id}/options`, "deleted");
});

partOptionRoutes.post("/:id/options/:optionId/move", requirePermission("parts.edit"), async (c) => {
	const t = c.var.t;
	const part = await optionPart(c);
	const optionId = idParam(c, "optionId");
	if (!part || !optionId) return notFound(c);
	const dir = c.req.query("dir") === "down" ? "down" : "up";
	const stmts = moveOptionStatements(c.var.db, await optionsOf(c.var.db, part.id), optionId, dir, c.var.user, nowIso());
	if (stmts.length) await saveChanges(c, fmt(t.history.summaries.optionMove, { ref: part.ref }), stmts);
	return redirectOk(c, `/parts/${part.id}/options`);
});
