// Shared UI building blocks: shadcn/ui components ported to server-rendered Hono JSX.
// Same anatomy (data-slot), variants and Tailwind class recipes as shadcn's new-york-v4
// registry (`npx shadcn@latest view @shadcn/<name>`), minus React: interactive parts use
// plain HTML (links, forms, <details>, popover) and public/static/app.js.
// Strict CSP: no inline styles or scripts. Class names must appear literally in this file
// (Tailwind scans the sources); compose them with cn().
// Bare <input>, <select> and <textarea> get the shadcn Input/NativeSelect/Textarea recipe from
// the base layer of src/styles/app.css, so the control components below only add slots.
import type { Child } from "hono/jsx";
import { cn } from "../lib/cn";
import { formatMoney, formatQty } from "../lib/units";
import { useApp } from "./context";
import { Icon, type IconNode, icons } from "./icons";

export type FormValues = Record<string, string>;
export type FormErrors = Record<string, string>;

// ---------------------------------------------------------------------------
// Button

const BUTTON_BASE =
	"inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap no-underline transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";

const BUTTON_VARIANTS = {
	default: "bg-primary text-primary-foreground shadow-xs hover:bg-primary/90",
	destructive:
		"bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40",
	outline:
		"border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
	secondary: "bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80",
	ghost: "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
	link: "text-primary underline-offset-4 hover:underline",
} as const;

const BUTTON_SIZES = {
	default: "h-(--control-h) px-4 has-[>svg]:px-3",
	sm: "h-(--control-h-sm) gap-1.5 px-3 has-[>svg]:px-2.5",
	lg: "h-10 px-6 text-base has-[>svg]:px-4 coarse:h-12",
	icon: "size-(--control-h)",
	"icon-sm": "size-(--control-h-sm)",
} as const;

export type ButtonVariant = keyof typeof BUTTON_VARIANTS;
export type ButtonSize = keyof typeof BUTTON_SIZES;
/** Older variant names still used by some pages: primary = default, secondary = outline, danger = destructive. */
type LegacyVariant = "primary" | "secondary" | "danger";

function resolveVariant(v: ButtonVariant | LegacyVariant | string | undefined): ButtonVariant {
	if (v === "primary") return "default";
	if (v === "secondary") return "outline";
	if (v === "danger") return "destructive";
	return v && v in BUTTON_VARIANTS ? (v as ButtonVariant) : "default";
}

export function buttonClass(variant?: ButtonVariant | LegacyVariant, size: ButtonSize = "default", extra?: string) {
	return cn(BUTTON_BASE, BUTTON_VARIANTS[resolveVariant(variant)], BUTTON_SIZES[size], extra);
}

type ButtonProps = {
	variant?: ButtonVariant | LegacyVariant;
	size?: ButtonSize;
	class?: string;
	icon?: IconNode;
	children?: Child;
};

/** shadcn Button. Renders a link when `href` is given, otherwise a <button>. */
export function Button(
	props: ButtonProps & {
		href?: string;
		type?: "submit" | "button" | "reset";
		name?: string;
		value?: string;
		disabled?: boolean;
		title?: string;
		"aria-label"?: string;
		form?: string;
		formaction?: string;
		formmethod?: "get" | "post";
		"data-confirm"?: string;
		[key: `data-${string}`]: string | undefined;
	},
) {
	const { variant, size, icon, href, children, type, ...rest } = props;
	const cls = buttonClass(variant, size, props.class);
	const content = (
		<>
			{icon ? <Icon icon={icon} data-icon={children ? "inline-start" : undefined} /> : null}
			{children}
		</>
	);
	if (href !== undefined) {
		return (
			<a {...rest} href={href} class={cls} data-slot="button">
				{content}
			</a>
		);
	}
	return (
		<button {...rest} type={type ?? "submit"} class={cls} data-slot="button">
			{content}
		</button>
	);
}

/** A POST button in its own form, with an optional confirmation prompt (data-confirm). */
export function PostButton(props: {
	action: string;
	label: string;
	confirm?: string;
	variant?: ButtonVariant | LegacyVariant;
	size?: ButtonSize;
	icon?: IconNode;
}) {
	return (
		<form method="post" action={props.action} class="inline" data-confirm={props.confirm}>
			<Button variant={props.variant ?? "outline"} size={props.size} icon={props.icon}>
				{props.label}
			</Button>
		</form>
	);
}

export function LinkButton(props: {
	href: string;
	label: string;
	variant?: ButtonVariant | LegacyVariant;
	size?: ButtonSize;
	icon?: IconNode;
}) {
	return (
		<Button href={props.href} variant={props.variant ?? "default"} size={props.size} icon={props.icon}>
			{props.label}
		</Button>
	);
}

// ---------------------------------------------------------------------------
// Badge

const BADGE_VARIANTS = {
	default: "border-transparent bg-primary text-primary-foreground",
	secondary: "border-transparent bg-secondary text-secondary-foreground",
	destructive: "border-destructive/25 bg-destructive/10 text-destructive",
	outline: "text-foreground",
	success: "border-success/25 bg-success/10 text-success",
	warning: "border-warning/25 bg-warning/10 text-warning",
	info: "border-info/25 bg-info/10 text-info",
	muted: "border-transparent bg-muted text-muted-foreground",
} as const;

export type BadgeVariant = keyof typeof BADGE_VARIANTS;

export function Badge(props: { variant?: BadgeVariant; class?: string; title?: string; children?: Child }) {
	return (
		<span
			data-slot="badge"
			title={props.title}
			class={cn(
				"inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border px-2 py-0.5 align-middle text-xs font-medium whitespace-nowrap [&>svg]:pointer-events-none [&>svg]:size-3",
				BADGE_VARIANTS[props.variant ?? "default"],
				props.class,
			)}
		>
			{props.children}
		</span>
	);
}

// ---------------------------------------------------------------------------
// Card

type Slot = { class?: string; children?: Child; id?: string };

export function Card(props: Slot & { tag?: "div" | "section" | "article" }) {
	const Tag = props.tag ?? "section";
	return (
		<Tag
			id={props.id}
			data-slot="card"
			class={cn("flex flex-col gap-6 rounded-xl border bg-card py-6 text-card-foreground shadow-sm", props.class)}
		>
			{props.children}
		</Tag>
	);
}

export function CardHeader(props: Slot) {
	return (
		<div
			data-slot="card-header"
			class={cn(
				"@container/card-header grid auto-rows-min grid-rows-[auto_auto] items-start gap-1.5 px-6 has-data-[slot=card-action]:grid-cols-[1fr_auto] [.border-b]:pb-6",
				props.class,
			)}
		>
			{props.children}
		</div>
	);
}

/** Card title, optionally led by a muted icon. */
export function CardTitle(props: Slot & { tag?: "h2" | "h3" | "div"; icon?: IconNode }) {
	const Tag = props.tag ?? "h2";
	return (
		<Tag
			data-slot="card-title"
			class={cn(
				"m-0 text-base leading-none font-semibold tracking-normal",
				props.icon && "flex items-center gap-2",
				props.class,
			)}
		>
			{props.icon ? <Icon icon={props.icon} class="size-4 text-muted-foreground" /> : null}
			{props.children}
		</Tag>
	);
}

export function CardDescription(props: Slot) {
	return (
		<div data-slot="card-description" class={cn("text-sm text-muted-foreground", props.class)}>
			{props.children}
		</div>
	);
}

export function CardAction(props: Slot) {
	return (
		<div
			data-slot="card-action"
			class={cn("col-start-2 row-span-2 row-start-1 flex flex-wrap gap-2 self-start justify-self-end", props.class)}
		>
			{props.children}
		</div>
	);
}

export function CardContent(props: Slot) {
	return (
		<div data-slot="card-content" class={cn("px-6", props.class)}>
			{props.children}
		</div>
	);
}

export function CardFooter(props: Slot) {
	return (
		<div data-slot="card-footer" class={cn("flex items-center gap-2 px-6 [.border-t]:pt-6", props.class)}>
			{props.children}
		</div>
	);
}

/** A table on a card surface, with an optional header row (title on the left, actions on the right). */
export function TableCard(props: { title?: Child; action?: Child; class?: string; id?: string; children?: Child }) {
	return (
		<Card id={props.id} class={cn("gap-0 overflow-hidden py-0", props.class)}>
			{props.title || props.action ? (
				<CardHeader class="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3 [.border-b]:pb-3">
					{props.title ? (
						<CardTitle tag="h2" class="text-sm">
							{props.title}
						</CardTitle>
					) : null}
					{props.action ? <CardAction class="self-center">{props.action}</CardAction> : null}
				</CardHeader>
			) : null}
			{props.children}
		</Card>
	);
}

/** An empty state inside a card (the card already draws the border). */
export function CardEmpty(props: { icon?: IconNode; children?: Child }) {
	const { t } = useApp();
	return (
		<EmptyState
			icon={props.icon}
			description={props.children ?? t.common.noResults}
			class="rounded-none border-0 p-4 md:p-6"
		/>
	);
}

/**
 * A card that folds open (native <details>, no JavaScript), e.g. an "Edit" form below a detail page.
 * The chevron rotates only when its own <details> is open, not when an ancestor is.
 */
export function CollapsibleCard(props: { title: Child; icon?: IconNode; open?: boolean; children: Child }) {
	return (
		<details data-slot="card" open={props.open} class="rounded-xl border bg-card text-card-foreground shadow-sm">
			<summary class="flex min-h-(--control-h) list-none items-center gap-2 rounded-xl px-6 py-4 text-sm font-semibold outline-none hover:bg-accent/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
				{props.icon ? <Icon icon={props.icon} class="size-4 text-muted-foreground" /> : null}
				<span class="flex-1">{props.title}</span>
				<Icon
					icon={icons.chevronRight}
					class="size-4 text-muted-foreground transition-transform [details[open]>summary_&]:rotate-90"
				/>
			</summary>
			<div class="border-t p-6">{props.children}</div>
		</details>
	);
}

// ---------------------------------------------------------------------------
// Table

export function Table(props: Slot) {
	return (
		<div data-slot="table-container" class="relative w-full overflow-x-auto">
			<table data-slot="table" class={cn("w-full caption-bottom text-sm", props.class)}>
				{props.children}
			</table>
		</div>
	);
}

export function TableHeader(props: Slot) {
	return (
		<thead data-slot="table-header" class={cn("[&_tr]:border-b", props.class)}>
			{props.children}
		</thead>
	);
}

export function TableBody(props: Slot) {
	return (
		<tbody data-slot="table-body" class={cn("[&_tr:last-child]:border-0", props.class)}>
			{props.children}
		</tbody>
	);
}

export function TableFooter(props: Slot) {
	return (
		<tfoot data-slot="table-footer" class={cn("border-t bg-muted/50 font-medium [&>tr]:last:border-b-0", props.class)}>
			{props.children}
		</tfoot>
	);
}

export function TableRow(props: Slot) {
	return (
		<tr data-slot="table-row" class={cn("border-b transition-colors hover:bg-muted/50", props.class)}>
			{props.children}
		</tr>
	);
}

export function TableHead(props: Slot & { colspan?: number; scope?: string }) {
	return (
		<th
			data-slot="table-head"
			colspan={props.colspan}
			scope={props.scope}
			class={cn(
				"h-10 px-3 text-left align-middle text-xs font-medium tracking-wide whitespace-nowrap text-muted-foreground uppercase first:pl-4 last:pr-4",
				props.class,
			)}
		>
			{props.children}
		</th>
	);
}

export function TableCell(props: Slot & { colspan?: number }) {
	return (
		<td data-slot="table-cell" colspan={props.colspan} class={cn("p-3 align-middle first:pl-4 last:pr-4", props.class)}>
			{props.children}
		</td>
	);
}

// ---------------------------------------------------------------------------
// Alert, Empty, Separator, Kbd, Skeleton-free helpers

const ALERT_VARIANTS = {
	default: "bg-card text-card-foreground",
	destructive:
		"border-destructive/30 bg-destructive/5 text-destructive [&>[data-slot=alert-description]]:text-destructive/90",
	success: "border-success/30 bg-success/5 text-success [&>[data-slot=alert-description]]:text-success/90",
	warning: "border-warning/30 bg-warning/5 text-warning [&>[data-slot=alert-description]]:text-warning/90",
} as const;

const ALERT_ICONS: Record<keyof typeof ALERT_VARIANTS, IconNode> = {
	default: icons.info,
	destructive: icons.circleAlert,
	success: icons.circleCheck,
	warning: icons.triangleAlert,
};

export function Alert(props: {
	variant?: keyof typeof ALERT_VARIANTS;
	title?: Child;
	children?: Child;
	class?: string;
	role?: "status" | "alert";
}) {
	const variant = props.variant ?? "default";
	return (
		<div
			data-slot="alert"
			role={props.role ?? (variant === "destructive" ? "alert" : "status")}
			class={cn(
				"relative mb-4 grid w-full grid-cols-[calc(var(--spacing)*4)_1fr] items-start gap-x-3 gap-y-0.5 rounded-lg border px-4 py-3 text-sm [&>svg]:size-4 [&>svg]:translate-y-0.5 [&>svg]:text-current",
				ALERT_VARIANTS[variant],
				props.class,
			)}
		>
			<Icon icon={ALERT_ICONS[variant]} />
			{props.title ? (
				<div data-slot="alert-title" class="col-start-2 min-h-4 font-medium tracking-tight">
					{props.title}
				</div>
			) : null}
			{props.children ? (
				<div
					data-slot="alert-description"
					class={cn(
						"col-start-2 grid justify-items-start gap-1 text-sm [&_p]:leading-relaxed",
						props.title ? "text-muted-foreground" : "font-medium",
					)}
				>
					{props.children}
				</div>
			) : null}
		</div>
	);
}

export function EmptyState(props: {
	icon?: IconNode;
	title?: Child;
	description?: Child;
	children?: Child;
	class?: string;
}) {
	return (
		<div
			data-slot="empty"
			class={cn(
				"flex min-w-0 flex-1 flex-col items-center justify-center gap-4 rounded-lg border border-dashed p-6 text-center text-balance md:p-10",
				props.class,
			)}
		>
			<div data-slot="empty-header" class="flex max-w-sm flex-col items-center gap-2 text-center">
				<div
					data-slot="empty-icon"
					class="mb-2 flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground [&_svg:not([class*='size-'])]:size-6"
				>
					<Icon icon={props.icon ?? icons.inbox} />
				</div>
				{props.title ? (
					<div data-slot="empty-title" class="text-base font-medium tracking-tight">
						{props.title}
					</div>
				) : null}
				{props.description ? (
					<p data-slot="empty-description" class="text-sm/relaxed text-muted-foreground">
						{props.description}
					</p>
				) : null}
			</div>
			{props.children ? (
				<div data-slot="empty-content" class="flex w-full max-w-sm min-w-0 flex-col items-center gap-4 text-sm">
					{props.children}
				</div>
			) : null}
		</div>
	);
}

export function Separator(props: { orientation?: "horizontal" | "vertical"; class?: string }) {
	const o = props.orientation ?? "horizontal";
	return (
		<div
			data-slot="separator"
			role="none"
			data-orientation={o}
			class={cn(
				"shrink-0 bg-border data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px",
				props.class,
			)}
		/>
	);
}

export function Kbd(props: { children?: Child; class?: string }) {
	return (
		<kbd
			data-slot="kbd"
			class={cn(
				"pointer-events-none inline-flex h-5 w-fit min-w-5 items-center justify-center gap-1 rounded-sm border bg-muted px-1 font-sans text-xs font-medium text-muted-foreground select-none",
				props.class,
			)}
		>
			{props.children}
		</kbd>
	);
}

/** Tabs as links (shadcn TabsList / TabsTrigger look): each tab is its own page. */
export function LinkTabs(props: { items: { href: string; label: string; active: boolean; icon?: IconNode }[] }) {
	return (
		<nav
			data-slot="tabs-list"
			class="mb-6 inline-flex max-w-full items-center gap-1 overflow-x-auto rounded-lg bg-muted p-[3px] text-muted-foreground"
		>
			{props.items.map((item) => (
				<a
					href={item.href}
					data-slot="tabs-trigger"
					data-state={item.active ? "active" : "inactive"}
					aria-current={item.active ? "page" : undefined}
					class="inline-flex h-[calc(var(--control-h)-2px)] items-center gap-1.5 rounded-md border border-transparent px-3 text-sm font-medium whitespace-nowrap text-foreground/60 no-underline transition-all hover:text-foreground data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm dark:text-muted-foreground dark:hover:text-foreground dark:data-[state=active]:border-input dark:data-[state=active]:bg-input/30 dark:data-[state=active]:text-foreground [&_svg]:size-4"
				>
					{item.icon ? <Icon icon={item.icon} /> : null}
					{item.label}
				</a>
			))}
		</nav>
	);
}

/** Label/value pairs (a <dl>), e.g. the details of a part or a PO. */
export function DetailList(props: { items: { label: Child; value: Child }[]; class?: string }) {
	return (
		<dl class={cn("m-0 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2.5 text-sm", props.class)}>
			{props.items.map((i) => (
				<>
					<dt class="text-muted-foreground">{i.label}</dt>
					<dd class="m-0 min-w-0">{i.value}</dd>
				</>
			))}
		</dl>
	);
}

/** Links acting as a toggle group (shadcn ToggleGroup, outline), e.g. view options in a toolbar. */
export function ToggleLinks(props: {
	label: string;
	items: { href: string; label: string; active: boolean; title?: string; icon?: IconNode }[];
}) {
	return (
		<nav
			aria-label={props.label}
			data-slot="toggle-group"
			class="inline-flex w-fit items-center rounded-md border bg-background shadow-xs dark:bg-input/30"
		>
			{props.items.map((i) => (
				<a
					href={i.href}
					title={i.title}
					aria-current={i.active ? "true" : undefined}
					data-state={i.active ? "on" : "off"}
					data-slot="toggle-group-item"
					class="inline-flex h-[calc(var(--control-h)-2px)] min-w-9 items-center justify-center gap-1.5 border-r px-3 text-sm font-medium whitespace-nowrap text-foreground no-underline transition-colors first:rounded-l-md last:rounded-r-md last:border-r-0 hover:bg-muted hover:text-muted-foreground data-[state=on]:bg-accent data-[state=on]:text-accent-foreground dark:border-input [&_svg]:size-4"
				>
					{i.icon ? <Icon icon={i.icon} /> : null}
					{i.label}
				</a>
			))}
		</nav>
	);
}

/** Small stat tile for dashboards: label, big value, optional hint. */
export function StatCard(props: {
	label: string;
	value: Child;
	icon?: IconNode;
	hint?: Child;
	href?: string;
	tone?: "default" | "warning" | "destructive" | "success";
}) {
	const tone = props.tone ?? "default";
	const body = (
		<>
			<div class="flex items-center justify-between gap-2">
				<span class="text-sm font-medium text-muted-foreground">{props.label}</span>
				{props.icon ? (
					<Icon
						icon={props.icon}
						class={cn(
							"size-4",
							tone === "default" && "text-muted-foreground",
							tone === "warning" && "text-warning",
							tone === "destructive" && "text-destructive",
							tone === "success" && "text-success",
						)}
					/>
				) : null}
			</div>
			<div class="text-2xl font-semibold tracking-tight tabular-nums">{props.value}</div>
			{props.hint ? <div class="text-xs text-muted-foreground">{props.hint}</div> : null}
		</>
	);
	const cls = cn(
		"flex flex-col gap-2 rounded-xl border bg-card p-5 text-card-foreground shadow-sm",
		props.href && "no-underline transition-colors hover:bg-accent/50",
		tone === "warning" && "border-warning/40",
		tone === "destructive" && "border-destructive/40",
	);
	return props.href ? (
		<a href={props.href} class={cls} data-slot="stat">
			{body}
		</a>
	) : (
		<div class={cls} data-slot="stat">
			{body}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Page furniture

export function PageHeader(props: { title: string; subtitle?: Child; actions?: Child }) {
	return (
		<div class="mb-6 flex flex-wrap items-start justify-between gap-4">
			<div class="flex min-w-0 flex-col gap-1">
				<h1 class="text-2xl font-semibold tracking-tight">{props.title}</h1>
				{props.subtitle ? <p class="text-sm text-muted-foreground">{props.subtitle}</p> : null}
			</div>
			{props.actions ? <div class="page-actions flex flex-wrap items-center gap-2">{props.actions}</div> : null}
		</div>
	);
}

const FLASH_KEYS = ["saved", "deleted", "archived", "unarchived"] as const;

/** Success message driven by the `ok` query parameter set by POST-redirect-GET handlers. */
export function Flash(props: { ok?: string | undefined; message?: string | undefined }) {
	const { t } = useApp();
	const key = FLASH_KEYS.find((k) => k === props.ok);
	const text = props.message ?? (key ? t.common[key] : undefined);
	return text ? <Alert variant="success">{text}</Alert> : null;
}

export function ErrorBanner(props: { show: boolean; message?: string }) {
	const { t } = useApp();
	return props.show ? <Alert variant="destructive">{props.message ?? t.common.fixErrors}</Alert> : null;
}

/**
 * Live search: a plain GET form that also works without JavaScript. With htmx it
 * refreshes only #results (selected from the full page response) as you type.
 */
export function SearchBar(props: { action: string; q: string; children?: Child }) {
	const { t } = useApp();
	return (
		<search>
			<form
				class="searchbar mb-4 flex flex-wrap items-center gap-2 [&>select]:w-auto [&>select]:flex-[0_1_220px]"
				method="get"
				action={props.action}
				hx-get={props.action}
				hx-trigger="input delay:300ms, change, submit"
				hx-target="#results"
				hx-select="#results"
				hx-swap="outerHTML"
				hx-push-url="true"
			>
				<div class="relative flex-[1_1_260px]">
					<Icon
						icon={icons.search}
						class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
					/>
					<input
						type="search"
						name="q"
						value={props.q}
						placeholder={t.common.searchPlaceholder}
						aria-label={t.common.search}
						class="pl-9"
					/>
				</div>
				{props.children}
				<Button variant="outline">{t.common.search}</Button>
			</form>
		</search>
	);
}

// ---------------------------------------------------------------------------
// Form fields (shadcn Field: data-invalid on the field, aria-invalid on the control)

export function FieldGroup(props: Slot) {
	return (
		<div data-slot="field-group" class={cn("flex w-full flex-col gap-5", props.class)}>
			{props.children}
		</div>
	);
}

/** Groups related fields under a legend (shadcn FieldSet + FieldLegend). */
export function FieldSet(props: { legend: string; children: Child }) {
	return (
		<fieldset data-slot="field-set" class="m-0 flex min-w-0 flex-col gap-4 border-0 p-0">
			<legend data-slot="field-legend" class="mb-3 px-0 text-base font-medium">
				{props.legend}
			</legend>
			{props.children}
		</fieldset>
	);
}

export function FieldLabel(props: { for?: string; children?: Child; required?: boolean; class?: string }) {
	return (
		<label
			data-slot="field-label"
			for={props.for}
			class={cn("flex w-fit gap-1 text-sm leading-snug font-medium select-none", props.class)}
		>
			{props.children}
			{props.required ? <span class="text-destructive"> *</span> : null}
		</label>
	);
}

export function FieldDescription(props: { children?: Child; id?: string }) {
	return (
		<p data-slot="field-description" id={props.id} class="text-sm leading-normal font-normal text-muted-foreground">
			{props.children}
		</p>
	);
}

export function FieldError(props: { children?: Child; id?: string }) {
	return props.children ? (
		<p data-slot="field-error" id={props.id} role="alert" class="text-sm font-normal text-destructive">
			{props.children}
		</p>
	) : null;
}

type FieldProps = {
	name: string;
	label: string;
	values: FormValues;
	errors: FormErrors;
	hint?: string;
	required?: boolean;
};

function FieldWrap(props: FieldProps & { children: Child }) {
	const error = props.errors[props.name];
	return (
		<div
			data-slot="field"
			data-invalid={error ? "true" : undefined}
			class="group/field flex w-full min-w-0 flex-col gap-2 data-[invalid=true]:text-destructive"
		>
			<FieldLabel for={`f-${props.name}`} required={props.required}>
				{props.label}
			</FieldLabel>
			{props.children}
			{props.hint ? <FieldDescription>{props.hint}</FieldDescription> : null}
			<FieldError id={`e-${props.name}`}>{error}</FieldError>
		</div>
	);
}

export function TextField(
	props: FieldProps & {
		type?: string;
		inputmode?: "decimal" | "numeric" | "text" | "email" | "tel";
		autofocus?: boolean;
		list?: string;
		placeholder?: string;
	},
) {
	return (
		<FieldWrap {...props}>
			<input
				id={`f-${props.name}`}
				data-slot="input"
				name={props.name}
				type={props.type ?? "text"}
				value={props.values[props.name] ?? ""}
				inputmode={props.inputmode}
				required={props.required}
				autofocus={props.autofocus}
				list={props.list}
				placeholder={props.placeholder}
				aria-invalid={props.errors[props.name] ? "true" : undefined}
				aria-describedby={props.errors[props.name] ? `e-${props.name}` : undefined}
			/>
		</FieldWrap>
	);
}

/** Decimal input that accepts "1.5" and "1,5" (parsed server-side, never as floats). */
export function DecimalField(props: FieldProps) {
	return <TextField {...props} inputmode="decimal" />;
}

export function TextArea(props: FieldProps & { rows?: number }) {
	return (
		<FieldWrap {...props}>
			<textarea
				id={`f-${props.name}`}
				data-slot="textarea"
				name={props.name}
				rows={props.rows ?? 3}
				aria-invalid={props.errors[props.name] ? "true" : undefined}
			>
				{props.values[props.name] ?? ""}
			</textarea>
		</FieldWrap>
	);
}

export function SelectField(props: FieldProps & { options: { value: string; label: string }[] }) {
	const current = props.values[props.name] ?? "";
	return (
		<FieldWrap {...props}>
			<select
				id={`f-${props.name}`}
				data-slot="native-select"
				name={props.name}
				required={props.required}
				aria-invalid={props.errors[props.name] ? "true" : undefined}
			>
				{props.options.map((o) => (
					<option value={o.value} selected={o.value === current}>
						{o.label}
					</option>
				))}
			</select>
		</FieldWrap>
	);
}

export function CheckboxField(props: FieldProps) {
	const checked = ["on", "1", "true", "yes"].includes(props.values[props.name] ?? "");
	const error = props.errors[props.name];
	return (
		<div data-slot="field" data-invalid={error ? "true" : undefined} class="flex flex-col gap-1">
			<label class="flex min-h-(--control-h) w-fit cursor-pointer items-center gap-3 text-sm font-medium">
				<input type="checkbox" data-slot="checkbox" name={props.name} value="on" checked={checked} />
				<span>{props.label}</span>
			</label>
			{props.hint ? <FieldDescription>{props.hint}</FieldDescription> : null}
			<FieldError>{error}</FieldError>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Values

/** An amount, or "Hidden" for users who may not see costs (pages also drop whole cost sections for them). */
export function Money(props: { cents: number | null | undefined }) {
	const { locale, currency, t, seeCosts } = useApp();
	if (!seeCosts) return <span class="text-muted-foreground">{t.roles.hidden}</span>;
	if (props.cents === null || props.cents === undefined)
		return <span class="text-muted-foreground">{t.parts.costUnknown}</span>;
	return <span class="num">{formatMoney(props.cents, locale, currency)}</span>;
}

export function Qty(props: { milli: number; unit?: string | undefined }) {
	const { locale } = useApp();
	return (
		<span class={props.milli < 0 ? "num negative" : "num"}>
			{formatQty(props.milli, locale)}
			{props.unit && props.unit !== "pcs" ? ` ${props.unit}` : null}
		</span>
	);
}

export function KindBadge(props: { kind: string }) {
	const { t } = useApp();
	return <span class={`kind kind-${props.kind}`}>{t.kinds[props.kind as keyof typeof t.kinds] ?? props.kind}</span>;
}

export function Empty(props: { children?: Child }) {
	const { t } = useApp();
	return <EmptyState description={props.children ?? t.common.noResults} />;
}

/** Formats an ISO timestamp as "YYYY-MM-DD HH:MM" (UTC). */
export function shortDateTime(iso: string | null | undefined): string {
	if (!iso) return "";
	return iso.replace("T", " ").slice(0, 16);
}
