import { type Context, Hono } from "hono";
import { z } from "zod";
import { ROLES, type Role } from "../db/schema";
import { type Action, can, PERMISSION_GROUPS } from "../domain/permissions";
import {
	canSeeCosts,
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
import { Icon, icons } from "../views/icons";
import { idParam, nowIso, page, redirectOk, saveChanges, translateErrors } from "../views/render";
import {
	Avatar,
	Badge,
	Button,
	Card,
	CardContent,
	CardFooter,
	CardHeader,
	CardTitle,
	CheckboxField,
	ErrorBanner,
	FieldGroup,
	Flash,
	type FormErrors,
	type FormValues,
	InlineEdit,
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
	const { t } = useApp();
	// ADMIN_EMAILS win over the table (resolveAccess), so a row for one of them is not shown twice.
	const listed = props.rows.filter((u) => !props.configAdmins.includes(u.email));
	const counts = Object.fromEntries(ROLES.map((r) => [r, listed.filter((u) => u.role === r).length])) as Record<
		Role,
		number
	>;
	counts.admin += props.configAdmins.length;
	return (
		<>
			<PageHeader title={t.users.title} subtitle={t.users.intro} />
			<Flash ok={props.ok} />
			<ErrorBanner show={Object.keys(props.errors).length > 0} />
			<div class="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
				<UserList configAdmins={props.configAdmins} listed={listed} values={props.values} errors={props.errors} />
				<RoleSummary counts={counts} />
			</div>
			<RoleMatrix lowerRolesSeeCosts={props.seeCosts} />
		</>
	);
}

/**
 * Everyone with a role: the ADMIN_EMAILS (fixed), the listed users (their role changed in place), then everyone else,
 * who is a viewer. Adding someone is a form folded above the list.
 */
function UserList(props: { configAdmins: string[]; listed: UserRow[]; values: FormValues; errors: FormErrors }) {
	const { t, user } = useApp();
	const p = { values: props.values, errors: props.errors };
	const roleOptions = ROLES.map((r) => ({ value: r, label: t.roles.names[r] }));
	const who = (email: string) => (
		<div class="flex items-center gap-3">
			<Avatar name={email} />
			<span class="font-medium whitespace-nowrap">{email}</span>
			{email === user ? <Badge variant="secondary">{t.users.you}</Badge> : null}
		</div>
	);
	return (
		<TableCard id="users" title={t.users.list}>
			<InlineEdit
				class="border-b px-4 py-3"
				label={t.users.add}
				icon={icons.userPlus}
				open={Object.keys(props.errors).length > 0}
				summary={<span class="text-sm text-muted-foreground">{t.users.addSummary}</span>}
			>
				<form method="post" action="/users" class="flex flex-col gap-4">
					<FieldGroup>
						<div class="grid gap-4 md:grid-cols-[minmax(0,1fr)_12rem]">
							<TextField name="email" label={t.users.email} type="email" hint={t.users.addHint} required {...p} />
							<SelectField name="role" label={t.users.role} required options={roleOptions} {...p} />
						</div>
					</FieldGroup>
					<div>
						<Button icon={icons.userPlus}>{t.users.addSave}</Button>
					</div>
				</form>
			</InlineEdit>
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>{t.users.email}</TableHead>
						<TableHead>{t.users.role}</TableHead>
						<TableHead>
							<span class="sr-only">{t.common.actions}</span>
						</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{props.configAdmins.map((email) => (
						<TableRow>
							<TableCell>{who(email)}</TableCell>
							<TableCell colspan={2}>
								<div class="flex items-center gap-2">
									<Icon icon={icons.lock} class="size-4 text-muted-foreground" />
									{t.roles.names.admin}
								</div>
								<div class="text-xs text-muted-foreground">{t.users.fromConfig}</div>
							</TableCell>
						</TableRow>
					))}
					{props.listed.map((u) => (
						<TableRow>
							<TableCell>{who(u.email)}</TableCell>
							<TableCell>
								{/* The same upsert as the add form; app.js shows Save once another role is picked. */}
								<form method="post" action="/users" data-save-when-changed="" class="flex items-center gap-2">
									<input type="hidden" name="email" value={u.email} />
									<select name="role" aria-label={fmt(t.users.roleOf, { email: u.email })} class="w-40">
										{ROLES.map((r) => (
											<option value={r} selected={r === u.role}>
												{t.roles.names[r]}
											</option>
										))}
									</select>
									<Button size="sm" icon={icons.check}>
										{t.common.save}
									</Button>
								</form>
							</TableCell>
							<TableCell class="text-right">
								<PostButton
									action={`/users/${u.id}/delete`}
									label={t.users.remove}
									confirm={fmt(t.users.confirmRemove, { email: u.email })}
									variant="ghost"
									size="sm"
									icon={icons.trash}
								/>
							</TableCell>
						</TableRow>
					))}
					<TableRow class="hover:bg-transparent">
						<TableCell>
							<div class="flex items-center gap-3 text-muted-foreground">
								<Avatar icon={icons.users} />
								{t.users.everyoneElse}
							</div>
						</TableCell>
						<TableCell colspan={2}>
							<div>{t.roles.names.viewer}</div>
							<div class="text-xs text-muted-foreground">{t.users.everyoneElseHint}</div>
						</TableCell>
					</TableRow>
				</TableBody>
			</Table>
		</TableCard>
	);
}

/** The four roles in a word each, and how many people have them: what to pick in the list beside it. */
function RoleSummary(props: { counts: Record<Role, number> }) {
	const { t } = useApp();
	return (
		<Card>
			<CardHeader>
				<CardTitle tag="h2">{t.users.roles}</CardTitle>
			</CardHeader>
			<CardContent>
				<dl class="m-0 flex flex-col gap-4">
					{ROLES.map((role) => (
						<div class="flex flex-col gap-1">
							<dt class="flex items-center justify-between gap-2 text-sm font-medium">
								{t.roles.names[role]}
								<Badge variant="secondary" title={t.users.roleCount}>
									{props.counts[role]}
									<span class="sr-only"> {t.users.roleCount}</span>
								</Badge>
							</dt>
							<dd class="m-0 text-sm text-muted-foreground">{t.roles.help[role]}</dd>
						</div>
					))}
				</dl>
			</CardContent>
			<CardFooter>
				<Button href="#role-matrix" variant="outline" size="sm" icon={icons.arrowDown}>
					{t.users.rolesTitle}
				</Button>
			</CardFooter>
		</Card>
	);
}

/** Whether each role may do each action, computed with can() from PERMISSIONS (it cannot drift from the rules). */
function RoleMatrix(props: { lowerRolesSeeCosts: boolean }) {
	const { t } = useApp();
	const hints: Partial<Record<Action, string>> = t.roles.hints;
	const access = (role: Role) => ({ role, seeCosts: canSeeCosts(role, props.lowerRolesSeeCosts) });
	const cell = (allowed: boolean) => (
		<TableCell class="text-center">
			{allowed ? (
				<span class="inline-flex size-6 items-center justify-center rounded-full bg-primary/10 text-primary">
					<Icon icon={icons.check} class="size-4" />
					<span class="sr-only">{t.roles.allowed}</span>
				</span>
			) : (
				<span class="text-muted-foreground">
					<span aria-hidden="true">–</span>
					<span class="sr-only">{t.roles.forbidden}</span>
				</span>
			)}
		</TableCell>
	);
	return (
		<TableCard id="role-matrix" title={t.users.rolesTitle} class="mt-6">
			<form
				method="post"
				action="/users/settings"
				class="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b px-4 py-3"
			>
				<div class="min-w-0 flex-1">
					<CheckboxField
						name="lower_roles_see_costs"
						label={t.users.costsLabel}
						hint={t.users.costsHint}
						values={{ lower_roles_see_costs: props.lowerRolesSeeCosts ? "on" : "" }}
						errors={{}}
					/>
				</div>
				<Button variant="outline" size="sm">
					{t.users.costsSave}
				</Button>
			</form>
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead scope="col">{t.roles.action}</TableHead>
						{ROLES.map((role) => (
							<TableHead scope="col" class="text-center">
								<span title={t.roles.help[role]}>{t.roles.names[role]}</span>
							</TableHead>
						))}
					</TableRow>
				</TableHeader>
				<TableBody>
					<TableRow>
						<TableCell class="font-medium">{t.roles.seeEverything}</TableCell>
						{ROLES.map(() => cell(true))}
					</TableRow>
					{PERMISSION_GROUPS.flatMap((group) => [
						<TableRow class="bg-muted/50 hover:bg-muted/50">
							<TableHead scope="rowgroup" colspan={ROLES.length + 1} class="h-9 text-foreground">
								{t.roles.groups[group.key]}
							</TableHead>
						</TableRow>,
						...group.actions.map((action: Action) => (
							<TableRow>
								<TableCell class="min-w-64">
									<div class="font-medium">{t.roles.actions[action]}</div>
									{hints[action] ? <div class="text-xs text-muted-foreground">{hints[action]}</div> : null}
								</TableCell>
								{ROLES.map((role) => cell(can(access(role), action)))}
							</TableRow>
						)),
					])}
				</TableBody>
			</Table>
		</TableCard>
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

userRoutes.get("/", (c) => renderUsers(c, { role: "viewer" }));

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
