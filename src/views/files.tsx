// The Files card of a part or an assembly revision, and the read-only list on build pages (D159).
import { FILE_KINDS, type FileKind, type FileRow } from "../db/schema";
import { FORMAT_INFO } from "../domain/file-types";
import { MAX_FILE_BYTES } from "../domain/files";
import { can } from "../domain/permissions";
import { type Dict, errorText, fmt } from "../i18n";
import { type AppView, useApp } from "./context";
import { Icon, type IconNode, icons } from "./icons";
import {
	Alert,
	Badge,
	Button,
	buttonClass,
	CardEmpty,
	Dialog,
	DialogFooter,
	shortDateTime,
	Table,
	TableBody,
	TableCard,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "./ui";

const KIND_ICONS: Record<FileKind, IconNode> = {
	cad: icons.box,
	print: icons.printer,
	drawing: icons.draftingCompass,
	instructions: icons.bookOpen,
	datasheet: icons.fileText,
	other: icons.file,
};

/** "512 B", "8.4 KB", "2.4 MB" in decimal units, as file browsers show them. Display only. */
export function formatBytes(n: number, view: Pick<AppView, "t" | "locale">): string {
	const b = view.t.files.bytes;
	const tenths = (unit: number) =>
		new Intl.NumberFormat(view.locale, { maximumFractionDigits: 1 }).format(Math.round(n / (unit / 10)) / 10);
	if (n < 1000) return fmt(b.b, { n: String(n) });
	if (n < 1000 * 1000) return fmt(b.kb, { n: tenths(1000) });
	return fmt(b.mb, { n: tenths(1000 * 1000) });
}

/** Name (a download link when the bucket is there), note, and what kind of file it is. */
function FileName(props: { file: FileRow; enabled: boolean }) {
	const { t } = useApp();
	const f = props.file;
	return (
		<span class="flex items-start gap-2">
			<Icon icon={KIND_ICONS[f.kind]} class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
			<span class="flex min-w-0 flex-col items-start gap-0.5">
				{props.enabled ? (
					<a
						href={`/files/${f.id}/download`}
						class="font-medium break-words"
						title={fmt(t.files.download, { name: f.name })}
					>
						{f.name}
					</a>
				) : (
					<span class="font-medium break-words">{f.name}</span>
				)}
				{f.note ? <span class="text-xs text-muted-foreground">{f.note}</span> : null}
			</span>
		</span>
	);
}

function FileFacts(props: { file: FileRow }) {
	const view = useApp();
	const f = props.file;
	return (
		<span class="flex flex-col gap-0.5 text-xs whitespace-nowrap text-muted-foreground">
			<span>
				{view.t.files.formats[f.format]} · <span class="tabular-nums">{formatBytes(f.sizeBytes, view)}</span>
			</span>
			<span class="tabular-nums">
				{fmt(view.t.files.uploadedBy, { by: f.uploadedBy, at: shortDateTime(f.uploadedAt) })}
			</span>
		</span>
	);
}

/** Open (PDFs and images, in a new tab) and download links. */
function OpenLinks(props: { file: FileRow }) {
	const { t } = useApp();
	const f = props.file;
	return (
		<>
			{FORMAT_INFO[f.format].inline ? (
				<a
					href={`/files/${f.id}/open`}
					target="_blank"
					rel="noopener"
					class={buttonClass("ghost", "icon-sm")}
					aria-label={`${t.files.open}: ${f.name}`}
					title={t.files.open}
					data-slot="button"
				>
					<Icon icon={icons.eye} />
				</a>
			) : null}
			<Button
				href={`/files/${f.id}/download`}
				variant="ghost"
				size="icon-sm"
				icon={icons.download}
				aria-label={fmt(t.files.download, { name: f.name })}
				title={fmt(t.files.download, { name: f.name })}
			/>
		</>
	);
}

/**
 * The message for an upload dialog when the page comes back from a refused upload (`?err=file_…` for files,
 * `image_…` for the product image), else undefined (the dialog stays closed). Unknown keys get the generic message.
 */
export function uploadErrorText(t: Dict, err: string | undefined, prefix: "file" | "image"): string | undefined {
	return err?.startsWith(prefix) ? errorText(t, err) : undefined;
}

/** The id of the upload dialog of the Files card (one per page). */
const UPLOAD_DIALOG = "files-upload";

/**
 * The upload dialog: kind and note first, the file last (the server reads the body as a stream, D161). No `accept`
 * attribute: iPadOS greys out extensions it does not know (.step, .3mf), and the server checks the content anyway.
 * `error` (a refused upload) opens it on load, with the reason.
 */
function UploadDialog(props: { action: string; error?: string | undefined }) {
	const { t } = useApp();
	return (
		<Dialog id={UPLOAD_DIALOG} title={t.files.addTitle} open={props.error !== undefined}>
			{props.error !== undefined ? (
				<Alert variant="destructive" class="mb-0">
					{props.error}
				</Alert>
			) : null}
			<form
				method="post"
				action={props.action}
				enctype="multipart/form-data"
				class="flex flex-col gap-4"
				data-upload-form=""
				data-busy={t.files.uploading}
			>
				<div data-slot="field" class="flex min-w-0 flex-col gap-2">
					<label for="file-kind" class="text-sm font-medium">
						{t.files.kind}
					</label>
					<select id="file-kind" name="kind" data-slot="native-select">
						<option value="" selected>
							{t.files.automatic}
						</option>
						{FILE_KINDS.map((k) => (
							<option value={k}>{t.files.kinds[k]}</option>
						))}
					</select>
				</div>
				<div data-slot="field" class="flex min-w-0 flex-col gap-2">
					<label for="file-note" class="text-sm font-medium">
						{t.files.note}
					</label>
					<input id="file-note" name="note" type="text" maxlength={500} autocomplete="off" data-slot="input" />
				</div>
				<FileField />
				<DialogFooter dialog={UPLOAD_DIALOG}>
					<Button icon={icons.upload}>{t.files.upload}</Button>
				</DialogFooter>
			</form>
		</Dialog>
	);
}

/**
 * The file input of an upload form (the last field) and the accepted formats, with its submit button when `button` is
 * given. app.js checks the size before sending (data-max-bytes), so a too large file never starts a long upload.
 */
export function FileField(props: { button?: string }) {
	const { t } = useApp();
	return (
		<div data-slot="field" class="flex min-w-0 flex-col gap-2">
			<label for="file-input" class="text-sm font-medium">
				{t.files.file}
			</label>
			<div class="flex flex-wrap items-center gap-2">
				<input
					id="file-input"
					type="file"
					name="file"
					required
					class="min-w-0 flex-1"
					data-max-bytes={String(MAX_FILE_BYTES)}
					data-too-large={t.errors.file_too_large}
				/>
				{props.button !== undefined ? (
					<Button variant="outline" icon={icons.upload}>
						{props.button}
					</Button>
				) : null}
			</div>
			<p class="text-xs text-muted-foreground">{t.files.hint}</p>
		</div>
	);
}

/**
 * The Files card of a part or an assembly revision. `enabled` says the deployment has a bucket (else no control and
 * no link); `editable` is false on an archived assembly. "Add file" in the header opens the upload dialog;
 * `uploadError` (the page comes back from a refused upload) opens it on load.
 */
export function FilesCard(props: {
	files: FileRow[];
	uploadAction: string;
	enabled: boolean;
	editable: boolean;
	uploadError?: string | undefined;
}) {
	const view = useApp();
	const { t } = view;
	const edit = props.enabled && props.editable && can(view, "files.edit");
	return (
		<TableCard
			id="files"
			title={
				<span class="flex items-center gap-2">
					<Icon icon={icons.paperclip} class="size-4 text-muted-foreground" />
					{t.files.title}
					{props.files.length > 0 ? <Badge variant="secondary">{props.files.length}</Badge> : null}
				</span>
			}
			action={
				edit ? (
					<Button type="button" variant="outline" size="sm" icon={icons.plus} popovertarget={UPLOAD_DIALOG}>
						{t.files.add}
					</Button>
				) : undefined
			}
		>
			{props.files.length === 0 ? (
				<CardEmpty icon={icons.paperclip}>{t.files.none}</CardEmpty>
			) : (
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>{t.files.name}</TableHead>
							<TableHead>{t.files.kind}</TableHead>
							<TableHead>{t.files.uploaded}</TableHead>
							<TableHead class="w-px">
								<span class="sr-only">{t.common.actions}</span>
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{props.files.map((f) => (
							<TableRow>
								<TableCell>
									<FileName file={f} enabled={props.enabled} />
								</TableCell>
								<TableCell>
									<Badge variant="outline">{t.files.kinds[f.kind]}</Badge>
								</TableCell>
								<TableCell>
									<FileFacts file={f} />
								</TableCell>
								<TableCell class="py-1 text-right">
									<div class="flex items-center justify-end gap-1">
										{props.enabled ? <OpenLinks file={f} /> : null}
										{edit ? (
											<>
												<Button
													href={`/files/${f.id}/edit`}
													variant="ghost"
													size="icon-sm"
													icon={icons.pencil}
													aria-label={`${t.files.edit}: ${f.name}`}
													title={t.files.edit}
												/>
												<form
													method="post"
													action={`/files/${f.id}/remove`}
													class="inline"
													data-confirm={t.files.confirmRemove}
												>
													<Button
														variant="ghost"
														size="icon-sm"
														icon={icons.trash}
														aria-label={`${t.files.remove}: ${f.name}`}
														title={t.files.remove}
													/>
												</form>
											</>
										) : null}
									</div>
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			)}
			{edit ? <UploadDialog action={props.uploadAction} error={props.uploadError} /> : null}
			{!props.enabled && can(view, "files.edit") ? (
				<p class="border-t px-4 py-3 text-xs text-muted-foreground">{t.files.disabled}</p>
			) : null}
			{props.enabled && !props.editable && can(view, "files.edit") ? (
				<p class="border-t px-4 py-3 text-xs text-muted-foreground">{t.files.archived}</p>
			) : null}
		</TableCard>
	);
}

/** The files a build needs: those of the revision being built, then the part's own (read-only). */
export function BuildFilesCard(props: {
	revision: string;
	assemblyFiles: FileRow[];
	partFiles: FileRow[];
	enabled: boolean;
}) {
	const view = useApp();
	const { t } = view;
	const rows = [
		...props.assemblyFiles.map((f) => ({ f, from: fmt(t.files.ofAssembly, { revision: props.revision }) })),
		...props.partFiles.map((f) => ({ f, from: t.files.ofPart })),
	];
	if (rows.length === 0) return null;
	return (
		<TableCard
			id="files"
			title={
				<span class="flex items-center gap-2">
					<Icon icon={icons.paperclip} class="size-4 text-muted-foreground" />
					{t.files.title}
					<Badge variant="secondary">{rows.length}</Badge>
				</span>
			}
		>
			<p class="border-b px-4 py-2 text-xs text-muted-foreground">{t.files.buildIntro}</p>
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>{t.files.name}</TableHead>
						<TableHead>{t.files.kind}</TableHead>
						<TableHead>{t.files.attachedTo}</TableHead>
						<TableHead>{t.files.uploaded}</TableHead>
						<TableHead class="w-px">
							<span class="sr-only">{t.common.actions}</span>
						</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{rows.map(({ f, from }) => (
						<TableRow>
							<TableCell>
								<FileName file={f} enabled={props.enabled} />
							</TableCell>
							<TableCell>
								<Badge variant="outline">{t.files.kinds[f.kind]}</Badge>
							</TableCell>
							<TableCell class="text-xs whitespace-nowrap text-muted-foreground">{from}</TableCell>
							<TableCell>
								<FileFacts file={f} />
							</TableCell>
							<TableCell class="py-1 text-right">
								<div class="flex items-center justify-end gap-1">{props.enabled ? <OpenLinks file={f} /> : null}</div>
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</TableCard>
	);
}
