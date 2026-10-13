import { type Context, Hono } from "hono";
import { z } from "zod";
import { ROLES } from "../db/schema";
import {
	deleteUserStatement,
	getUser,
	listUsers,
	lowerRolesSeeCosts,
	saveUserStatement,
	setLowerRolesSeeCostsStatement,
	userInput,
} from "../domain/users";
import { fmt } from "../i18n";
import { type FieldErrors, field, validate } from "../lib/validation";
import { revokeUserGrants } from "../mcp/oauth";
import { parseAdminEmails } from "../middleware/auth";
import { requirePermission } from "../middleware/roles";
import type { AppEnv } from "../types";
import { useApp } from "../views/context";
import { icons } from "../views/icons";
import { idParam, nowIso, page, redirectOk, saveChanges, translateErrors } from "../views/render";
import {
	Badge,
	Button,
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
	CheckboxField,
	DetailList,
	EmptyState,
	ErrorBanner,
	FieldGroup,
	Flash,
	type FormErrors,
	type FormValues,
	PageHeader,
	PostButton,
	SelectField,
	Table,
	TableBody,
	TableCard,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
	TextField,
} from "../views/ui";

export const userRoutes = new Hono<AppEnv>();
userRoutes.use("*", requirePermission("users.manage"));

type UserRow = Awaited<ReturnType<typeof listUsers>>[number];

function UsersPage(props: {
	rows: UserRow[];
	configAdmins: string[];
	seeCosts: boolean;
	values: FormValues;
	errors: FormErrors;
	ok?: string | undefined;
}) {
	const { t, user } = useApp();
	const p = { values: props.values, errors: props.errors };
	const you = (email: string) =>
		email === user ? (
			<Badge variant="secondary" class="ml-2">
				{t.users.you}
			</Badge>
		) : null;
	return (
		<>
			<PageHeader title={t.users.title} subtitle={t.users.intro} />
			<Flash ok={props.ok} />
			<ErrorBanner show={Object.keys(props.errors).length > 0} />
			<div class="grid gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
				<div class="flex min-w-0 flex-col gap-6">
					<Card id="give-role">
						<CardHeader>
							<CardTitle tag="h2">{t.users.add}</CardTitle>
							<CardDescription>{t.users.addHint}</CardDescription>
						</CardHeader>
						<CardContent>
							<form method="post" action="/users" class="flex flex-col gap-6">
								<FieldGroup>
									<div class="grid gap-4 md:grid-cols-[minmax(0,1fr)_14rem]">
										<TextField name="email" label={t.users.email} type="email" required {...p} />
										<SelectField
											name="role"
											label={t.users.role}
											required
											options={ROLES.map((r) => ({ value: r, label: t.roles.names[r] }))}
											{...p}
										/>
									</div>
								</FieldGroup>
								<div>
									<Button icon={icons.save}>{t.users.save}</Button>
								</div>
							</form>
						</CardContent>
					</Card>
					<TableCard title={t.users.listed}>
						{props.rows.length === 0 && props.configAdmins.length === 0 ? (
							<EmptyState icon={icons.users} title={t.users.empty} class="m-4 border-0" />
						) : (
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>{t.users.email}</TableHead>
										<TableHead>{t.users.role}</TableHead>
										<TableHead class="text-right">{t.common.actions}</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{props.configAdmins.map((email) => (
										<TableRow>
											<TableCell class="font-medium">
												{email}
												{you(email)}
											</TableCell>
											<TableCell>
												{t.roles.names.admin}{" "}
												<Badge variant="outline" title={t.users.fromConfigHint}>
													{t.users.fromConfig}
												</Badge>
											</TableCell>
											<TableCell class="text-right text-sm text-muted-foreground">{t.users.fromConfigHint}</TableCell>
										</TableRow>
									))}
									{props.rows
										.filter((u) => !props.configAdmins.includes(u.email))
										.map((u) => (
											<TableRow>
												<TableCell class="font-medium">
													{u.email}
													{you(u.email)}
												</TableCell>
												<TableCell>{t.roles.names[u.role]}</TableCell>
												<TableCell class="text-right">
													<div class="flex flex-wrap justify-end gap-2">
														<Button
															href={`/users?edit=${u.id}#give-role`}
															variant="outline"
															size="sm"
															icon={icons.pencil}
														>
															{t.common.edit}
														</Button>
														<PostButton
															action={`/users/${u.id}/delete`}
															label={t.users.remove}
															confirm={t.users.confirmRemove}
															variant="outline"
															size="sm"
															icon={icons.trash}
														/>
													</div>
												</TableCell>
											</TableRow>
										))}
								</TableBody>
							</Table>
						)}
					</TableCard>
				</div>
				<div class="flex min-w-0 flex-col gap-6">
					<Card>
						<CardHeader>
							<CardTitle tag="h2">{t.users.costsTitle}</CardTitle>
						</CardHeader>
						<CardContent>
							<form method="post" action="/users/settings" class="flex flex-col gap-4">
								<CheckboxField
									name="lower_roles_see_costs"
									label={t.users.costsLabel}
									hint={t.users.costsHint}
									values={{ lower_roles_see_costs: props.seeCosts ? "on" : "" }}
									errors={{}}
								/>
								<div>
									<Button variant="outline">{t.users.costsSave}</Button>
								</div>
							</form>
						</CardContent>
					</Card>
					<Card>
						<CardHeader>
							<CardTitle tag="h2">{t.users.rolesTitle}</CardTitle>
						</CardHeader>
						<CardContent>
							<DetailList items={ROLES.map((r) => ({ label: t.roles.names[r], value: t.roles.help[r] }))} />
						</CardContent>
					</Card>
				</div>
			</div>
		</>
	);
}

async function renderUsers(c: Context<AppEnv>, values: FormValues, errors: FieldErrors = {}, status: 200 | 422 = 200) {
	const [rows, seeCosts] = await Promise.all([listUsers(c.var.db), lowerRolesSeeCosts(c.var.db)]);
	return page(
		c,
		c.var.t.users.title,
		<UsersPage
			rows={rows}
			configAdmins={parseAdminEmails(c.env.ADMIN_EMAILS)}
			seeCosts={seeCosts}
			values={values}
			errors={translateErrors(c, errors)}
			ok={c.req.query("ok")}
		/>,
		status,
	);
}

userRoutes.get("/", async (c) => {
	const edit = c.req.query("edit");
	const editing = edit && /^\d+$/.test(edit) ? await getUser(c.var.db, Number(edit)) : undefined;
	return renderUsers(c, editing ? { email: editing.email, role: editing.role } : { role: "viewer" });
});

userRoutes.post("/", async (c) => {
	const form = await c.req.parseBody();
	const v = validate(userInput, form);
	if (!v.ok) return renderUsers(c, form as FormValues, v.errors, 422);
	if (parseAdminEmails(c.env.ADMIN_EMAILS).includes(v.data.email))
		return renderUsers(c, form as FormValues, { email: "user_from_config" }, 422);
	const summary = fmt(c.var.t.history.summaries.userSave, {
		email: v.data.email,
		role: c.var.t.roles.names[v.data.role],
	});
	await saveChanges(c, summary, [saveUserStatement(c.var.db, v.data, c.var.user, nowIso())]);
	return redirectOk(c, "/users");
});

userRoutes.post("/settings", async (c) => {
	const v = validate(z.object({ lower_roles_see_costs: field.bool() }), await c.req.parseBody());
	const on = v.ok && v.data.lower_roles_see_costs;
	const summaries = c.var.t.history.summaries;
	await saveChanges(c, on ? summaries.costsOn : summaries.costsOff, [
		setLowerRolesSeeCostsStatement(c.var.db, on, c.var.user, nowIso()),
	]);
	return redirectOk(c, "/users");
});

userRoutes.post("/:id/delete", async (c) => {
	const id = idParam(c);
	const user = id !== null ? await getUser(c.var.db, id) : undefined;
	if (user) {
		await saveChanges(c, fmt(c.var.t.history.summaries.userDelete, { email: user.email }), [
			deleteUserStatement(c.var.db, user.id),
		]);
		// Offboarding (D130): their AI assistants are disconnected at once, not only refused on their next call.
		// Should KV fail, the removal stands: /mcp refuses unlisted users anyway.
		try {
			await revokeUserGrants(c.env, new URL(c.req.url).origin, user.email);
		} catch (err) {
			console.error(err);
		}
	}
	return redirectOk(c, "/users", "deleted");
});
