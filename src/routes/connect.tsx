// Connecting an AI assistant over MCP (D117): the OAuth consent page at /authorize and the connected apps page.
// Both stay behind Cloudflare Access like every page (accessAuth says who the user is), and both are not found
// without the OAUTH_KV binding. The OAuth protocol endpoints themselves are served by the provider (src/index.ts).
import {
	AuthorizationError,
	type AuthRequest,
	CimdFetchError,
	type ConsentDescription,
	type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { type Context, Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { knownScopes, MCP_SCOPES, type McpScope, offeredScopes, scopeAllowed } from "../domain/mcp-scopes";
import { can } from "../domain/permissions";
import { resolveAccess } from "../domain/users";
import { fmt } from "../i18n";
import { allGrants, type ConnectedApp, grantUserId, isGrantId, userGrants } from "../mcp/grants";
import { oauthApi, oauthKv, oauthOriginOk } from "../mcp/oauth";
import { MCP_PATH } from "../mcp/server";
import { parseAdminEmails } from "../middleware/auth";
import { forbidden, requirePermission } from "../middleware/roles";
import type { AppEnv } from "../types";
import { useApp } from "../views/context";
import { icons } from "../views/icons";
import { notFound, page, redirectOk } from "../views/render";
import {
	Alert,
	Badge,
	Button,
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
	EmptyState,
	FieldDescription,
	FieldError,
	Flash,
	PageHeader,
	PostButton,
	shortDateTime,
	Table,
	TableBody,
	TableCard,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "../views/ui";

/** Not found unless the deployment has the OAUTH_KV binding: the app is then exactly as without MCP. */
const mcpEnabled = createMiddleware<AppEnv>(async (c, next) => {
	if (!oauthKv(c.env) || !oauthOriginOk(new URL(c.req.url).origin)) return notFound(c);
	await next();
});

const api = (c: Context<AppEnv>): OAuthHelpers => oauthApi(c.env, new URL(c.req.url).origin);
const accessOf = (c: Context<AppEnv>) => ({ role: c.var.role, seeCosts: c.var.seeCosts });

// ---------------------------------------------------------------------------
// Consent

/**
 * Only listed people (Users page or ADMIN_EMAILS) may connect an assistant (D130): /mcp skips Access, so the Users
 * page is what offboarding removes. Others see why, before any consent transaction starts.
 */
const listedOnly = createMiddleware<AppEnv>(async (c, next) => {
	const { listed } = await resolveAccess(c.var.db, c.var.user, parseAdminEmails(c.env.ADMIN_EMAILS));
	if (listed) return next();
	const t = c.var.t;
	return page(
		c,
		t.mcp.notListedTitle,
		<EmptyState
			icon={icons.lock}
			title={t.mcp.notListedTitle}
			description={fmt(t.mcp.notListed, { email: c.var.user })}
			class="mt-12"
		>
			<Button href="/" variant="outline">
				{t.nav.dashboard}
			</Button>
		</EmptyState>,
		403,
	);
});

export const authorizeRoutes = new Hono<AppEnv>();
authorizeRoutes.use("*", mcpEnabled, requirePermission("apps.connect"), listedOnly);

function ConsentPage(props: {
	details: ConsentDescription;
	handle: string;
	action: string;
	offered: McpScope[];
	checked: McpScope[];
	notOffered: string[];
	error?: string | undefined;
}) {
	const { t, user, seeCosts } = useApp();
	const d = props.details;
	return (
		<div class="mx-auto flex w-full max-w-xl flex-col gap-6">
			<PageHeader title={fmt(t.mcp.consentTitle, { client: d.clientName })} />
			<Card>
				<CardHeader>
					<CardTitle tag="h2" icon={icons.shieldCheck}>
						{fmt(t.mcp.consentIntro, { client: d.clientName, email: user })}
					</CardTitle>
					<CardDescription>
						{d.clientDomain ? fmt(t.mcp.publishedBy, { domain: d.clientDomain }) : t.mcp.unverified}{" "}
						{fmt(t.mcp.sendsTo, { host: d.redirectHost })}
					</CardDescription>
				</CardHeader>
				<form method="post" action={props.action}>
					<CardContent class="flex flex-col gap-4">
						{d.redirectIsLoopback ? <Alert variant="warning">{t.mcp.loopback}</Alert> : null}
						<input type="hidden" name="handle" value={props.handle} />
						<fieldset data-slot="field-set" class="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
							<legend data-slot="field-legend" class="mb-2 px-0 text-base font-medium">
								{t.mcp.scopesLegend}
							</legend>
							{props.offered.map((scope) => (
								<label class="flex min-h-(--control-h) w-fit cursor-pointer items-center gap-3 text-sm font-medium">
									<input
										type="checkbox"
										data-slot="checkbox"
										name="scope"
										value={scope}
										checked={props.checked.includes(scope)}
									/>
									<span>{t.mcp.scopes[scope]}</span>
									<Badge variant={MCP_SCOPES[scope].kind === "write" ? "warning" : "muted"}>{scope}</Badge>
								</label>
							))}
							<FieldDescription>{t.mcp.scopesHint}</FieldDescription>
							<FieldError>{props.error}</FieldError>
						</fieldset>
						{props.notOffered.length ? (
							<p class="text-sm text-muted-foreground">
								{fmt(t.mcp.notOffered, { scopes: props.notOffered.join(", ") })}
							</p>
						) : null}
						{seeCosts ? null : <p class="text-sm text-muted-foreground">{t.mcp.costsHidden}</p>}
					</CardContent>
					<CardFooter class="flex flex-wrap gap-2">
						<Button name="decision" value="approve" icon={icons.check}>
							{t.mcp.allow}
						</Button>
						<Button name="decision" value="deny" variant="outline" icon={icons.x}>
							{t.mcp.deny}
						</Button>
					</CardFooter>
				</form>
			</Card>
			<p class="text-sm text-muted-foreground">{t.mcp.lifetimes}</p>
		</div>
	);
}

/** Renders the consent page for a validated request (a new consent transaction unless `handle` is given). */
async function renderConsent(
	c: Context<AppEnv>,
	oauth: OAuthHelpers,
	request: AuthRequest,
	opts: { handle?: string; error?: string } = {},
) {
	const details = await oauth.describeConsent(request);
	let handle = opts.handle;
	if (!handle) {
		const consent = await oauth.beginConsent(request);
		handle = consent.handle;
		// The cookie binding the handle to this browser; our own headers already forbid framing.
		for (const cookie of consent.headers.getSetCookie()) c.header("Set-Cookie", cookie, { append: true });
	}
	const access = accessOf(c);
	const offered = offeredScopes(access);
	const requested = knownScopes(request.scope);
	// What the client asked for, or (when it asked for nothing) the read scopes: never a write scope by default.
	const checked = offered.filter((s) => (requested.length ? requested.includes(s) : MCP_SCOPES[s].kind === "read"));
	const notOffered = request.scope.filter((s) => !(offered as string[]).includes(s));
	// The form posts here, then the browser is redirected to the client: allow that origin in form-action.
	c.set("formActionOrigin", new URL(details.redirectUri).origin);
	const url = new URL(c.req.url);
	return page(
		c,
		fmt(c.var.t.mcp.consentTitle, { client: details.clientName }),
		<ConsentPage
			details={details}
			handle={handle}
			action={url.pathname + url.search}
			offered={offered}
			checked={checked}
			notOffered={notOffered}
			error={opts.error}
		/>,
		opts.error ? 422 : 200,
	);
}

/** Errors from the OAuth helpers: redirect to the client only when the library says it is safe. */
function authorizeError(c: Context<AppEnv>, err: unknown) {
	if (err instanceof AuthorizationError && err.redirectTo) return c.redirect(err.redirectTo, 302);
	if (err instanceof AuthorizationError || err instanceof CimdFetchError) {
		const t = c.var.t;
		const reason = err instanceof AuthorizationError ? err.description : err.message;
		return page(
			c,
			t.mcp.invalidRequest,
			<EmptyState
				icon={icons.triangleAlert}
				title={t.mcp.invalidRequest}
				description={fmt(t.mcp.invalidRequestHint, { reason })}
				class="mt-12"
			/>,
			400,
		);
	}
	throw err;
}

authorizeRoutes.get("/", async (c) => {
	const oauth = api(c);
	try {
		return await renderConsent(c, oauth, await oauth.parseAuthRequest(c.req.raw));
	} catch (err) {
		return authorizeError(c, err);
	}
});

authorizeRoutes.post("/", async (c) => {
	const oauth = api(c);
	const form = await c.req.parseBody({ all: true });
	const handle = typeof form.handle === "string" ? form.handle : "";
	try {
		if (form.decision !== "approve") {
			const denied = await oauth.denyConsent(c.req.raw, handle);
			return new Response(null, { status: 302, headers: denied.headers });
		}
		const ticked = ([] as unknown[]).concat(form.scope ?? []);
		// Only what the user's role allows, whatever the form says.
		const scopes = knownScopes(ticked).filter((s) => scopeAllowed(accessOf(c), s));
		if (scopes.length === 0) {
			return await renderConsent(c, oauth, await oauth.parseAuthRequest(c.req.raw), {
				handle,
				error: c.var.t.mcp.noScope,
			});
		}
		const approved = await oauth.approveConsent(c.req.raw, handle, { scope: scopes });
		const details = await oauth.describeConsent(approved.request);
		const email = c.var.user;
		const { redirectTo } = await oauth.completeAuthorization({
			request: approved.request,
			userId: grantUserId(email),
			metadata: { email, clientName: details.clientName, redirectHost: details.redirectHost },
			scope: approved.request.scope,
			props: { email, scopes: approved.request.scope, clientName: details.clientName },
		});
		approved.headers.set("Location", redirectTo);
		return new Response(null, { status: 302, headers: approved.headers });
	} catch (err) {
		return authorizeError(c, err);
	}
});

// ---------------------------------------------------------------------------
// Connected apps

export const connectedAppRoutes = new Hono<AppEnv>();
connectedAppRoutes.use("*", mcpEnabled, requirePermission("apps.connect"));

function AppsPage(props: { apps: ConnectedApp[]; everyone: boolean; mcpUrl: string; ok?: string | undefined }) {
	const { t, user } = useApp();
	return (
		<>
			<PageHeader
				title={t.mcp.appsTitle}
				subtitle={props.everyone ? `${t.mcp.appsIntro} ${t.mcp.appsAllIntro}` : t.mcp.appsIntro}
			/>
			<Flash message={props.ok === "revoked" ? t.mcp.revoked : undefined} />
			<TableCard>
				{props.apps.length === 0 ? (
					<EmptyState
						icon={icons.shieldCheck}
						title={t.mcp.empty}
						description={fmt(t.mcp.emptyHint, { url: props.mcpUrl })}
						class="m-4 border-0"
					/>
				) : (
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>{t.mcp.app}</TableHead>
								{props.everyone ? <TableHead>{t.mcp.user}</TableHead> : null}
								<TableHead>{t.mcp.permissions}</TableHead>
								<TableHead>{t.mcp.connected}</TableHead>
								<TableHead>{t.mcp.expires}</TableHead>
								<TableHead class="text-right">{t.common.actions}</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{props.apps.map((a) => (
								<TableRow>
									<TableCell class="font-medium">
										{a.clientName}
										{a.redirectHost ? <div class="text-xs text-muted-foreground">{a.redirectHost}</div> : null}
									</TableCell>
									{props.everyone ? <TableCell>{a.email}</TableCell> : null}
									<TableCell>
										<div class="flex flex-wrap gap-1">
											{a.scopes.map((s) => (
												<Badge variant="secondary">{s}</Badge>
											))}
										</div>
									</TableCell>
									<TableCell class="text-sm">{shortDateTime(a.createdAt)}</TableCell>
									<TableCell class="text-sm">{a.expiresAt ? shortDateTime(a.expiresAt) : t.common.none}</TableCell>
									<TableCell class="text-right">
										<PostButton
											action={
												a.email === user
													? `/connected-apps/${encodeURIComponent(a.id)}/revoke`
													: `/connected-apps/all/${encodeURIComponent(a.id)}/revoke`
											}
											label={t.mcp.revoke}
											confirm={t.mcp.confirmRevoke}
											variant="outline"
											size="sm"
											icon={icons.ban}
										/>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
			</TableCard>
			<p class="mt-4 text-sm text-muted-foreground">{t.mcp.lifetimes}</p>
		</>
	);
}

connectedAppRoutes.get("/", async (c) => {
	const oauth = api(c);
	const kv = oauthKv(c.env);
	const everyone = kv !== null && can(accessOf(c), "apps.manage");
	const apps = everyone && kv ? await allGrants(oauth, kv) : await userGrants(oauth, grantUserId(c.var.user));
	return page(
		c,
		c.var.t.mcp.appsTitle,
		<AppsPage
			apps={apps}
			everyone={everyone}
			mcpUrl={`${new URL(c.req.url).origin}${MCP_PATH}`}
			ok={c.req.query("ok")}
		/>,
	);
});

/** Revokes one of the user's own grants: its tokens stop working at once. */
connectedAppRoutes.post("/:grant/revoke", async (c) => {
	const grant = c.req.param("grant");
	if (isGrantId(grant)) await api(c).revokeGrant(grant, grantUserId(c.var.user));
	return redirectOk(c, "/connected-apps", "revoked");
});

/** Revokes anyone's grant (administrators). */
connectedAppRoutes.post("/all/:grant/revoke", requirePermission("apps.manage"), async (c) => {
	const grant = c.req.param("grant");
	const kv = oauthKv(c.env);
	if (!kv || !can(accessOf(c), "apps.manage")) return forbidden(c);
	const oauth = api(c);
	const owner = isGrantId(grant) ? (await allGrants(oauth, kv)).find((a) => a.id === grant) : undefined;
	if (owner) await oauth.revokeGrant(owner.id, owner.userId);
	return redirectOk(c, "/connected-apps", "revoked");
});
