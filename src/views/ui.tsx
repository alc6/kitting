// Shared UI building blocks. No inline styles or scripts (strict CSP): use classes
// from public/static/app.css and data-* hooks handled by public/static/app.js.
import type { Child } from "hono/jsx";
import { formatMoney, formatQty } from "../lib/units";
import { useApp } from "./context";

export type FormValues = Record<string, string>;
export type FormErrors = Record<string, string>;

export function PageHeader(props: { title: string; subtitle?: Child; actions?: Child }) {
	return (
		<div class="page-header">
			<div>
				<h1>{props.title}</h1>
				{props.subtitle ? <p class="muted">{props.subtitle}</p> : null}
			</div>
			{props.actions ? <div class="page-actions">{props.actions}</div> : null}
		</div>
	);
}

const FLASH_KEYS = ["saved", "deleted", "archived", "unarchived"] as const;

/** Success message driven by the `ok` query parameter set by POST-redirect-GET handlers. */
export function Flash(props: { ok?: string | undefined; message?: string | undefined }) {
	const { t } = useApp();
	const key = FLASH_KEYS.find((k) => k === props.ok);
	const text = props.message ?? (key ? t.common[key] : undefined);
	return text ? (
		<p class="flash ok" role="status">
			{text}
		</p>
	) : null;
}

export function ErrorBanner(props: { show: boolean; message?: string }) {
	const { t } = useApp();
	return props.show ? (
		<p class="flash error" role="alert">
			{props.message ?? t.common.fixErrors}
		</p>
	) : null;
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
				class="searchbar"
				method="get"
				action={props.action}
				hx-get={props.action}
				hx-trigger="input delay:300ms, change, submit"
				hx-target="#results"
				hx-select="#results"
				hx-swap="outerHTML"
				hx-push-url="true"
			>
				<input
					type="search"
					name="q"
					value={props.q}
					placeholder={t.common.searchPlaceholder}
					aria-label={t.common.search}
				/>
				{props.children}
				<button type="submit" class="button secondary">
					{t.common.search}
				</button>
			</form>
		</search>
	);
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
		<div class={error ? "field has-error" : "field"}>
			<label for={`f-${props.name}`}>
				{props.label}
				{props.required ? <span class="req"> *</span> : null}
			</label>
			{props.children}
			{props.hint ? <small class="hint">{props.hint}</small> : null}
			{error ? (
				<small class="error" id={`e-${props.name}`}>
					{error}
				</small>
			) : null}
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
			<textarea id={`f-${props.name}`} name={props.name} rows={props.rows ?? 3}>
				{props.values[props.name] ?? ""}
			</textarea>
		</FieldWrap>
	);
}

export function SelectField(props: FieldProps & { options: { value: string; label: string }[] }) {
	const current = props.values[props.name] ?? "";
	return (
		<FieldWrap {...props}>
			<select id={`f-${props.name}`} name={props.name} required={props.required}>
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
		<div class={error ? "field checkbox has-error" : "field checkbox"}>
			<label>
				<input type="checkbox" name={props.name} value="on" checked={checked} />
				<span>{props.label}</span>
			</label>
			{props.hint ? <small class="hint">{props.hint}</small> : null}
			{error ? <small class="error">{error}</small> : null}
		</div>
	);
}

/** A POST button in its own form, with an optional confirmation prompt (data-confirm). */
export function PostButton(props: { action: string; label: string; confirm?: string; variant?: string }) {
	return (
		<form method="post" action={props.action} class="inline" data-confirm={props.confirm}>
			<button type="submit" class={`button ${props.variant ?? "secondary"}`}>
				{props.label}
			</button>
		</form>
	);
}

export function LinkButton(props: { href: string; label: string; variant?: string }) {
	return (
		<a class={`button ${props.variant ?? "primary"}`} href={props.href}>
			{props.label}
		</a>
	);
}

export function Money(props: { cents: number | null | undefined }) {
	const { locale, currency, t } = useApp();
	if (props.cents === null || props.cents === undefined) return <span class="muted">{t.parts.costUnknown}</span>;
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
	return <p class="empty">{props.children ?? t.common.noResults}</p>;
}

/** Formats an ISO timestamp as "YYYY-MM-DD HH:MM" (UTC). */
export function shortDateTime(iso: string | null | undefined): string {
	if (!iso) return "";
	return iso.replace("T", " ").slice(0, 16);
}
