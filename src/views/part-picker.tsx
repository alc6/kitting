// Part picker (D138): a field that takes a part, plus the dialog opened by its "Browse" button.
//
// Without JavaScript the field is what it always was: a text input with a <datalist> (or a <select>). With
// JavaScript (public/static/app.js) the Browse button appears, the datalist is dropped, and the button opens the
// dialog: a search box and kind filter whose results come from GET /parts/pick through htmx. Picking a result
// writes its reference (or id, for a select) into the field.
//
// Put <PartPickerDialog> next to the form, never inside it: its controls must not belong to the form (Enter in
// the search box would submit it). One picker per page: the results container has a fixed id.
import { PART_KINDS, type PartKind } from "../db/schema";
import { imageUrl } from "../domain/images";
import { PICKER_PAGE_SIZE, type PickerPage, type PickerQuery, type PickerRow } from "../domain/part-picker";
import { isStocked } from "../domain/stock";
import { fmt } from "../i18n";
import { useApp } from "./context";
import { Icon, type IconNode, icons } from "./icons";
import { Button, buttonClass, FieldWrap, type FormErrors, type FormValues, KindBadge, Qty } from "./ui";

/** What the form accepts: the picker offers exactly this (the kinds, minus one part). */
export type PickerScope = { kinds?: readonly PartKind[]; exclude?: number };

const dialogId = (name: string) => `picker-${name}`;

const KIND_ICONS: Record<PartKind, IconNode> = {
	buy: icons.package,
	make: icons.factory,
	kit: icons.boxes,
	fee: icons.coins,
};

type FieldBase = {
	name: string;
	label: string;
	values: FormValues;
	errors: FormErrors;
	hint?: string;
	required?: boolean;
};

/** A part reference typed in a text input (datalist baseline) with the Browse button next to it. */
export function PartPicker(
	props: FieldBase & {
		listId: string;
		options: { ref: string; name: string }[];
		placeholder?: string;
		autofocus?: boolean;
	},
) {
	const { t } = useApp();
	const error = props.errors[props.name];
	return (
		<FieldWrap {...props}>
			<div class="flex items-center gap-2">
				<input
					id={`f-${props.name}`}
					data-slot="input"
					name={props.name}
					type="text"
					value={props.values[props.name] ?? ""}
					required={props.required}
					autofocus={props.autofocus}
					list={props.listId}
					placeholder={props.placeholder}
					aria-invalid={error ? "true" : undefined}
					aria-describedby={error ? `e-${props.name}` : undefined}
				/>
				<BrowseButton name={props.name} label={t.picker.browse} />
			</div>
			<datalist id={props.listId}>
				{props.options.map((o) => (
					<option value={o.ref}>{o.name}</option>
				))}
			</datalist>
		</FieldWrap>
	);
}

/** A part chosen in a <select> whose values are part ids (the new assembly form), with the Browse button next to it. */
export function PartSelectPicker(props: FieldBase & { options: { id: number; ref: string; name: string }[] }) {
	const { t } = useApp();
	const current = props.values[props.name] ?? "";
	const error = props.errors[props.name];
	return (
		<FieldWrap {...props}>
			<div class="flex items-center gap-2">
				<select
					id={`f-${props.name}`}
					data-slot="native-select"
					name={props.name}
					required={props.required}
					aria-invalid={error ? "true" : undefined}
				>
					<option value="">—</option>
					{props.options.map((o) => (
						<option value={String(o.id)} selected={String(o.id) === current}>
							{o.ref} · {o.name}
						</option>
					))}
				</select>
				<BrowseButton name={props.name} label={t.picker.browse} />
			</div>
		</FieldWrap>
	);
}

/** Hidden until app.js finds the dialog works; then it opens it. */
function BrowseButton(props: { name: string; label: string }) {
	return (
		<Button type="button" variant="outline" icon={icons.search} hidden data-picker-open={dialogId(props.name)}>
			{props.label}
		</Button>
	);
}

const TARGET = {
	"hx-get": "/parts/pick",
	"hx-include": "closest dialog",
	"hx-target": "#picker-results",
	"hx-select": "#picker-results",
	"hx-swap": "outerHTML ignoreTitle:true",
	// The latest search wins: a slower earlier response never overwrites it.
	"hx-sync": "closest dialog:replace",
};

/** The dialog for the field `name`. `scope` is what the form accepts. */
export function PartPickerDialog(props: { name: string; scope?: PickerScope }) {
	const { t } = useApp();
	const id = dialogId(props.name);
	const scope = props.scope ?? {};
	const kinds = scope.kinds && scope.kinds.length > 0 ? scope.kinds : PART_KINDS;
	return (
		<dialog
			id={id}
			data-part-picker
			data-target={`f-${props.name}`}
			aria-labelledby={`${id}-title`}
			class="m-auto h-[calc(100dvh-1rem)] max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-xl border bg-popover p-0 text-popover-foreground shadow-lg backdrop:bg-black/50 open:flex sm:h-auto sm:max-h-[min(44rem,calc(100dvh-4rem))] sm:w-full sm:max-w-2xl"
		>
			<div class="flex items-center justify-between gap-2 border-b py-3 pr-3 pl-4">
				<h2 id={`${id}-title`} class="m-0 text-base font-semibold">
					{t.picker.title}
				</h2>
				<Button type="button" variant="ghost" size="icon-sm" data-picker-close aria-label={t.picker.close}>
					<Icon icon={icons.x} />
				</Button>
			</div>
			<div class="flex flex-col gap-3 border-b p-4">
				{scope.kinds && scope.kinds.length > 0 ? (
					<input type="hidden" name="kinds" value={scope.kinds.join(",")} />
				) : null}
				{scope.exclude !== undefined ? <input type="hidden" name="exclude" value={String(scope.exclude)} /> : null}
				<div class="relative">
					<Icon
						icon={icons.search}
						class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
					/>
					<input
						type="search"
						name="q"
						autofocus
						autocomplete="off"
						aria-label={t.picker.search}
						placeholder={t.picker.search}
						class="pl-9"
						{...TARGET}
						hx-trigger="input changed delay:200ms, search"
					/>
				</div>
				{kinds.length > 1 ? (
					<div
						role="radiogroup"
						aria-label={t.picker.kind}
						class="flex flex-wrap gap-2"
						{...TARGET}
						hx-trigger="change"
					>
						<KindChoice value="" label={t.picker.allKinds} checked />
						{kinds.map((k) => (
							<KindChoice value={k} label={t.kinds[k]} />
						))}
					</div>
				) : null}
			</div>
			<div class="min-h-0 flex-1 overflow-y-auto p-4">
				<div id="picker-results" />
			</div>
		</dialog>
	);
}

function KindChoice(props: { value: string; label: string; checked?: boolean }) {
	return (
		<label class="cursor-pointer">
			<input type="radio" name="kind" value={props.value} checked={props.checked} class="peer sr-only" />
			<span class="inline-flex min-h-8 items-center rounded-full border px-3 text-sm font-medium transition-colors peer-checked:border-primary peer-checked:bg-primary peer-checked:text-primary-foreground peer-focus-visible:ring-[3px] peer-focus-visible:ring-ring/50 hover:bg-accent peer-checked:hover:bg-primary/90 coarse:min-h-12 coarse:px-4">
				{props.label}
			</span>
		</label>
	);
}

// ---------------------------------------------------------------------------
// Results (the body of GET /parts/pick; the dialog swaps #picker-results)

export function pickerUrl(query: PickerQuery, page: number): string {
	const params = new URLSearchParams();
	if (query.q.trim()) params.set("q", query.q.trim());
	if (query.kinds.length > 0) params.set("kinds", query.kinds.join(","));
	if (query.kind) params.set("kind", query.kind);
	if (query.exclude !== null) params.set("exclude", String(query.exclude));
	if (page > 1) params.set("page", String(page));
	const qs = params.toString();
	return qs ? `/parts/pick?${qs}` : "/parts/pick";
}

export function PickerResults(props: { data: PickerPage; query: PickerQuery; images: boolean }) {
	const { t } = useApp();
	const { rows, total, page, pages } = props.data;
	if (total === 0) {
		return (
			<div id="picker-results">
				<p class="m-0 py-10 text-center text-sm text-muted-foreground">{t.picker.empty}</p>
			</div>
		);
	}
	const from = (page - 1) * PICKER_PAGE_SIZE + 1;
	const to = from + rows.length - 1;
	return (
		<div id="picker-results" class="flex flex-col gap-3">
			<ul class="m-0 flex list-none flex-col gap-1.5 p-0">
				{rows.map((row) => (
					<li>
						<ResultRow row={row} images={props.images} />
					</li>
				))}
			</ul>
			<nav class="flex items-center justify-between gap-2">
				<span class="text-sm text-muted-foreground">{fmt(t.picker.range, { from, to, total })}</span>
				<div class="flex gap-2">
					<PagerButton
						label={t.picker.previous}
						icon={icons.chevronLeft}
						url={page > 1 ? pickerUrl(props.query, page - 1) : null}
					/>
					<PagerButton
						label={t.picker.next}
						icon={icons.chevronRight}
						url={page < pages ? pickerUrl(props.query, page + 1) : null}
					/>
				</div>
			</nav>
		</div>
	);
}

function PagerButton(props: { label: string; icon: IconNode; url: string | null }) {
	const attrs = props.url
		? {
				"hx-get": props.url,
				"hx-target": "#picker-results",
				"hx-select": "#picker-results",
				"hx-swap": "outerHTML ignoreTitle:true",
				"hx-sync": "closest dialog:replace",
			}
		: {};
	return (
		<button
			type="button"
			class={buttonClass("outline", "icon-sm")}
			data-slot="button"
			aria-label={props.label}
			title={props.label}
			disabled={props.url === null}
			{...attrs}
		>
			<Icon icon={props.icon} />
		</button>
	);
}

function ResultRow(props: { row: PickerRow; images: boolean }) {
	const { t } = useApp();
	const { row } = props;
	const src = props.images ? imageUrl(row) : null;
	return (
		<button
			type="button"
			data-pick={row.ref}
			data-pick-id={String(row.id)}
			class="flex w-full items-center gap-3 rounded-lg border bg-card p-2 text-left text-card-foreground transition-colors outline-none hover:bg-accent hover:text-accent-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 coarse:min-h-12"
		>
			{src ? (
				<img
					src={src}
					alt={row.name}
					loading="lazy"
					class="size-10 max-w-none shrink-0 rounded-md border bg-muted object-cover"
				/>
			) : (
				<span class="flex size-10 shrink-0 items-center justify-center rounded-md border bg-muted text-muted-foreground">
					<Icon icon={KIND_ICONS[row.kind]} class="size-5" />
				</span>
			)}
			<span class="flex min-w-0 flex-1 flex-col">
				<span class="flex items-center gap-2">
					<span class="truncate font-mono text-[0.8125rem] font-medium">{row.ref}</span>
					<KindBadge kind={row.kind} />
				</span>
				<span class="truncate text-sm text-muted-foreground">{row.name}</span>
			</span>
			{isStocked(row.kind) || row.supplierName ? (
				<span class="flex max-w-[40%] shrink-0 flex-col items-end text-sm">
					{isStocked(row.kind) ? (
						<>
							<span class="sr-only">{t.picker.onHand}</span>
							<Qty milli={row.onHandMilli} unit={row.unit} />
						</>
					) : null}
					{row.supplierName ? (
						<span class="max-w-full truncate text-xs text-muted-foreground">{row.supplierName}</span>
					) : null}
				</span>
			) : null}
		</button>
	);
}
