// Files of parts and assembly revisions (D159–D165): attach (streamed multipart upload), download, open, edit,
// replace, remove. `attachRoutes` is mounted at the root (/parts/:id/files, /assemblies/:id/files), `fileRoutes` at
// /files.
import type { Context } from "hono";
import { Hono } from "hono";
import { FILE_KINDS } from "../db/schema";
import { assemblyLabel, getAssembly } from "../domain/assemblies";
import { downloadName, FORMAT_INFO } from "../domain/file-types";
import {
	attachFileStatement,
	cleanFileName,
	editFileStatement,
	type FileOwner,
	type FileWithOwner,
	fileEditInput,
	filesBucket,
	fileUploadInput,
	getFile,
	objectKeyForHash,
	readFileForm,
	removeFileStatement,
	replaceFileStatement,
	uploadKind,
} from "../domain/files";
import { getPart } from "../domain/parts";
import { fmt } from "../i18n";
import { validate } from "../lib/validation";
import { requirePermission } from "../middleware/roles";
import type { AppEnv } from "../types";
import { FileField } from "../views/files";
import { icons } from "../views/icons";
import { idParam, notFound, nowIso, page, saveChanges, translateErrors } from "../views/render";
import {
	Alert,
	Button,
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
	type FormErrors,
	type FormValues,
	PageHeader,
	PostButton,
	SelectField,
	TextField,
} from "../views/ui";

export const attachRoutes = new Hono<AppEnv>();
export const fileRoutes = new Hono<AppEnv>();

/** Back to the owner's Files card, with a flash (`ok`) or an error key (`err`). */
const ownerPage = (owner: FileOwner) =>
	"partId" in owner ? `/parts/${owner.partId}` : `/assemblies/${owner.assemblyId}`;
const back = (c: Context<AppEnv>, owner: FileOwner, flash: { ok: string } | { err: string }) =>
	c.redirect(`${ownerPage(owner)}?${"ok" in flash ? `ok=${flash.ok}` : `err=${flash.err}`}#files`, 303);

/** Whether a statement changed a row: the SQL guard of archived assemblies (or a removal meanwhile) can leave none. */
const applied = (result: unknown) => ((result as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 0) > 0;

/** The answer when a statement changed nothing: the file's assembly was archived meanwhile, or the file is gone. */
async function notApplied(c: Context<AppEnv>, found: FileWithOwner) {
	const owner = ownerOf(found);
	if (!(await getFile(c.var.db, found.file.id))) return c.redirect(`${ownerPage(owner)}#files`, 303);
	return back(c, owner, { err: "assembly_archived" });
}

const ownerOf = (f: FileWithOwner): FileOwner => (f.assembly ? { assemblyId: f.assembly.id } : { partId: f.part.id });
/** How summaries and pages name what a file is attached to: "LAMP-DESK" or "LAMP-DESK std Rev3". */
const ownerLabel = (f: Pick<FileWithOwner, "part" | "assembly">) =>
	f.assembly ? assemblyLabel(f.part.ref, f.assembly) : f.part.ref;

/** Reads the upload form as a stream, stores the file, then attaches it in one change set. */
async function attach(c: Context<AppEnv>, owner: FileOwner, label: string) {
	const bucket = filesBucket(c.env);
	if (!bucket) return back(c, owner, { err: "files_disabled" });
	const form = await readFileForm(c.req.raw, bucket, (sha) => objectKeyForHash(c.var.db, sha));
	if (!form.ok) return back(c, owner, { err: form.error });
	// The browser enforces the note's length: a refusal here leaves at worst an unreferenced object.
	const fields = validate(fileUploadInput, form.fields);
	if (!fields.ok) return back(c, owner, { err: "invalid" });
	const name = cleanFileName(form.filename);
	const { results } = await saveChanges(c, fmt(c.var.t.history.summaries.fileAttach, { name, owner: label }), [
		attachFileStatement(
			c.var.db,
			owner,
			{ name, kind: uploadKind(fields.data.kind, form.file.format), note: fields.data.note, stored: form.file },
			c.var.user,
			nowIso(),
		),
	]);
	// The assembly was archived while the file was uploading: nothing was attached.
	if (!applied(results[0])) return back(c, owner, { err: "assembly_archived" });
	return back(c, owner, { ok: "saved" });
}

attachRoutes.post("/parts/:id/files", requirePermission("files.edit"), async (c) => {
	const id = idParam(c);
	const part = id ? await getPart(c.var.db, id) : undefined;
	if (!part) return notFound(c);
	return attach(c, { partId: part.id }, part.ref);
});

attachRoutes.post("/assemblies/:id/files", requirePermission("files.edit"), async (c) => {
	const id = idParam(c);
	const found = id ? await getAssembly(c.var.db, id) : undefined;
	if (!found) return notFound(c);
	const owner = { assemblyId: found.assembly.id };
	if (found.assembly.status === "archived") return back(c, owner, { err: "assembly_archived" });
	return attach(c, owner, assemblyLabel(found.part.ref, found.assembly));
});

// ---------------------------------------------------------------------------
// Download and open

/** `attachment` or `inline`, with an ASCII fallback name and the real one (RFC 6266 / 5987). */
export function contentDisposition(type: "attachment" | "inline", name: string): string {
	const ascii =
		name
			.normalize("NFKD")
			.replace(/[^\x20-\x7e]/g, "")
			.replace(/["\\]/g, "_")
			.trim() || "file";
	const encoded = encodeURIComponent(name).replace(
		/['()*]/g,
		(ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
	);
	return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * Downloads are attachments, never rendered by the browser, with no right to run anything (sandbox). Only PDFs and
 * images open inline (`/open`); they keep a policy without scripts or connections, and may not be framed.
 */
const ATTACHMENT_POLICY = "default-src 'none'; sandbox";
const INLINE_POLICY = "default-src 'none'; img-src 'self'; object-src 'self'; frame-ancestors 'none'; base-uri 'none'";

async function serve(c: Context<AppEnv>, inline: boolean) {
	const bucket = filesBucket(c.env);
	const id = idParam(c);
	const found = bucket && id ? await getFile(c.var.db, id) : undefined;
	if (!bucket || !found) return notFound(c);
	const f = found.file;
	const info = FORMAT_INFO[f.format];
	if (inline && !info.inline) return c.redirect(`/files/${f.id}/download`, 303);
	// The object (replaced with the content) and the row's last change (a rename changes the download name).
	const etag = `"${f.objectKey.slice(f.objectKey.lastIndexOf("/") + 1)}-${f.updatedAt.replace(/\D/g, "")}"`;
	const headers = {
		ETag: etag,
		"Cache-Control": "private, no-cache",
		"Content-Security-Policy": inline ? INLINE_POLICY : ATTACHMENT_POLICY,
	};
	if (c.req.header("If-None-Match") === etag) return c.body(null, 304, headers);
	const object = await bucket.get(f.objectKey);
	if (!object) {
		const t = c.var.t;
		return page(
			c,
			t.files.missing,
			<>
				<PageHeader title={f.name} />
				<Alert variant="destructive">{t.files.missing}</Alert>
			</>,
			404,
		);
	}
	return c.body(object.body, 200, {
		...headers,
		"Content-Type": info.contentType,
		"Content-Length": String(object.size),
		"Content-Disposition": contentDisposition(inline ? "inline" : "attachment", downloadName(f.name, f.format)),
	});
}

fileRoutes.get("/:id/download", (c) => serve(c, false));
fileRoutes.get("/:id/open", (c) => serve(c, true));

// ---------------------------------------------------------------------------
// Edit, replace, remove

/** The file in the URL, when it may be changed: not on an archived assembly, and the deployment has a bucket. */
async function changeableFile(c: Context<AppEnv>) {
	const id = idParam(c);
	const found = id ? await getFile(c.var.db, id) : undefined;
	if (!found) return { found: undefined, error: undefined };
	if (!filesBucket(c.env)) return { found, error: "files_disabled" };
	if (found.assembly?.status === "archived") return { found, error: "assembly_archived" };
	return { found, error: undefined };
}

function editPage(
	c: Context<AppEnv>,
	found: FileWithOwner,
	form: { values?: FormValues; errors?: FormErrors } = {},
	status: 200 | 422 = 200,
) {
	const t = c.var.t;
	const f = found.file;
	const values = form.values ?? { name: f.name, kind: f.kind, note: f.note };
	const errors = form.errors ?? {};
	const owner = ownerLabel(found);
	return page(
		c,
		fmt(t.files.editTitle, { name: f.name }),
		<>
			<PageHeader
				title={fmt(t.files.editTitle, { name: f.name })}
				subtitle={<a href={`${ownerPage(ownerOf(found))}#files`}>{fmt(t.files.backTo, { owner })}</a>}
				actions={
					<PostButton
						action={`/files/${f.id}/remove`}
						label={t.files.remove}
						confirm={t.files.confirmRemove}
						variant="destructive"
						icon={icons.trash}
					/>
				}
			/>
			<div class="grid gap-4 lg:grid-cols-2">
				<Card>
					<CardHeader>
						<CardTitle icon={icons.pencil}>{t.files.edit}</CardTitle>
					</CardHeader>
					<CardContent>
						<form method="post" action={`/files/${f.id}`} class="flex flex-col gap-4">
							<TextField name="name" label={t.files.name} values={values} errors={errors} required />
							<SelectField
								name="kind"
								label={t.files.kind}
								values={values}
								errors={errors}
								options={FILE_KINDS.map((k) => ({ value: k, label: t.files.kinds[k] }))}
							/>
							<TextField name="note" label={t.files.note} values={values} errors={errors} />
							<div>
								<Button icon={icons.save}>{t.common.save}</Button>
							</div>
						</form>
					</CardContent>
				</Card>
				<Card>
					<CardHeader>
						<CardTitle icon={icons.upload}>{t.files.replace}</CardTitle>
						<CardDescription>{t.files.replaceHint}</CardDescription>
					</CardHeader>
					<CardContent>
						<form
							method="post"
							action={`/files/${f.id}/replace`}
							enctype="multipart/form-data"
							class="flex flex-col gap-3"
							data-upload-form=""
							data-busy={t.files.uploading}
						>
							<FileField button={t.files.replaceButton} />
						</form>
					</CardContent>
				</Card>
			</div>
		</>,
		status,
	);
}

fileRoutes.get("/:id/edit", requirePermission("files.edit"), async (c) => {
	const { found, error } = await changeableFile(c);
	if (!found) return notFound(c);
	if (error) return back(c, ownerOf(found), { err: error });
	return editPage(c, found);
});

fileRoutes.post("/:id", requirePermission("files.edit"), async (c) => {
	const { found, error } = await changeableFile(c);
	if (!found) return notFound(c);
	if (error) return back(c, ownerOf(found), { err: error });
	const body = await c.req.parseBody();
	const result = validate(fileEditInput, body);
	if (!result.ok)
		return editPage(c, found, { values: body as FormValues, errors: translateErrors(c, result.errors) }, 422);
	const name = cleanFileName(result.data.name);
	const { results } = await saveChanges(
		c,
		fmt(c.var.t.history.summaries.fileEdit, { name, owner: ownerLabel(found) }),
		[editFileStatement(c.var.db, found.file.id, { ...result.data, name }, c.var.user, nowIso())],
	);
	if (!applied(results[0])) return notApplied(c, found);
	return back(c, ownerOf(found), { ok: "saved" });
});

fileRoutes.post("/:id/replace", requirePermission("files.edit"), async (c) => {
	const { found, error } = await changeableFile(c);
	if (!found) return notFound(c);
	const owner = ownerOf(found);
	const bucket = filesBucket(c.env);
	if (error || !bucket) return back(c, owner, { err: error ?? "files_disabled" });
	const form = await readFileForm(c.req.raw, bucket, (sha) => objectKeyForHash(c.var.db, sha));
	if (!form.ok) return back(c, owner, { err: form.error });
	// The previous object stays: undoing the replacement points the file at it again (D160).
	const { results } = await saveChanges(
		c,
		fmt(c.var.t.history.summaries.fileReplace, { name: found.file.name, owner: ownerLabel(found) }),
		[replaceFileStatement(c.var.db, found.file.id, form.file, c.var.user, nowIso())],
	);
	if (!applied(results[0])) return notApplied(c, found);
	return back(c, owner, { ok: "saved" });
});

fileRoutes.post("/:id/remove", requirePermission("files.edit"), async (c) => {
	const { found, error } = await changeableFile(c);
	if (!found) return notFound(c);
	const owner = ownerOf(found);
	if (error) return back(c, owner, { err: error });
	// Detach only: the object stays, so Recent changes can bring the file back (D160).
	const { results } = await saveChanges(
		c,
		fmt(c.var.t.history.summaries.fileRemove, { name: found.file.name, owner: ownerLabel(found) }),
		[removeFileStatement(c.var.db, found.file.id)],
	);
	if (!applied(results[0])) return notApplied(c, found);
	return back(c, owner, { ok: "deleted" });
});
