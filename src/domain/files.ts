// Files attached to parts and to assembly revisions (D159–D164). The bytes live in the optional IMAGES R2 bucket under
// `files/<uuid>`; the database holds one row per attachment. New revisions copy the rows and share the objects, and
// removing a file deletes its row only: the app never deletes a file object, so an undo can always re-attach it.
import { and, asc, eq, isNull, or, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { assemblies, FILE_KINDS, type FileFormat, type FileKind, type FileRow, files, parts } from "../db/schema";
import type { Statement } from "../lib/db";
import { boundaryOf, MultipartError, MultipartReader } from "../lib/multipart";
import { field } from "../lib/validation";
import type { Db } from "../types";
import { DEFAULT_KIND, detectFormat, HEAD_BYTES, TAIL_BYTES } from "./file-types";
import { imagesBucket } from "./images";

/** Largest file accepted (D161): 100 MB, Cloudflare's request limit on the Free and Pro plans. */
export const MAX_FILE_BYTES = 100 * 1000 * 1000;
/** Room for the form's other fields and the multipart framing around the file. */
export const FORM_OVERHEAD_BYTES = 64 * 1024;
/**
 * Size of the parts sent to an R2 multipart upload: R2's minimum (equal parts of at least 5 MiB, but the last), so an
 * upload holds as little as it can (D161).
 */
export const PART_BYTES = 5 * 1024 * 1024;
/** Longest file name kept, in characters. */
export const MAX_NAME_LENGTH = 200;

/** The bucket that holds files: the images bucket (D160), or null when the deployment has none. */
export function filesBucket(env: Env): R2Bucket | null {
	return imagesBucket(env);
}

export type UploadError = "file_missing" | "file_too_large" | "file_type" | "file_upload";

export type StoredFile = { key: string; format: FileFormat; sizeBytes: number; sha256: string };

const hex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

function concat(chunks: Uint8Array[]): Uint8Array {
	if (chunks.length === 1) return chunks[0] as Uint8Array;
	const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
	let at = 0;
	for (const c of chunks) {
		out.set(c, at);
		at += c.length;
	}
	return out;
}

class TooLarge extends Error {}

/** Splits off the first `n` bytes of `chunks` (views, no copy): [those, the rest]. */
function take(chunks: Uint8Array[], n: number): [Uint8Array[], Uint8Array[]] {
	const first: Uint8Array[] = [];
	const rest: Uint8Array[] = [];
	let left = n;
	for (const c of chunks) {
		if (left >= c.length) first.push(c);
		else {
			if (left > 0) first.push(c.subarray(0, left));
			rest.push(c.subarray(left));
		}
		left = Math.max(0, left - c.length);
	}
	return [first, rest];
}

/**
 * Sends chunks as one body of known length (what R2 needs for a stream), without joining them first: memory holds the
 * chunks already received, never a second copy.
 */
async function send<T>(chunks: Uint8Array[], size: number, to: (body: ReadableStream) => Promise<T>): Promise<T> {
	const { readable, writable } = new FixedLengthStream(size);
	const sending = to(readable);
	const writer = writable.getWriter();
	const writing = (async () => {
		for (const c of chunks) await writer.write(c);
		await writer.close();
	})();
	const [result] = await Promise.all([sending, writing]);
	return result;
}

/**
 * Stores a streamed file (D161): hashes it, keeps its first and last bytes for detection, and sends it to R2 in parts
 * as it arrives. A file smaller than one part is written only once recognised; a larger one goes to a multipart
 * upload, which is not an object until completed and is aborted when the file is refused. Identical content already
 * stored (same SHA-256, an object of the same size) is reused instead of written twice.
 */
export async function storeFile(
	bucket: R2Bucket,
	chunks: AsyncIterable<Uint8Array>,
	existingKey: (sha256: string) => Promise<string | null>,
	opts: { maxBytes?: number; partBytes?: number } = {},
): Promise<{ ok: true; file: StoredFile } | { ok: false; error: UploadError }> {
	const maxBytes = opts.maxBytes ?? MAX_FILE_BYTES;
	const partBytes = opts.partBytes ?? PART_BYTES;
	const key = `files/${crypto.randomUUID()}`;
	const digest = new crypto.DigestStream("SHA-256");
	const writer = digest.getWriter();
	const head: Uint8Array[] = [];
	const tail: Uint8Array[] = [];
	let headSize = 0;
	let tailSize = 0;
	let size = 0;
	// Bytes not yet sent, as received: at most one part plus one chunk.
	let pending: Uint8Array[] = [];
	let pendingSize = 0;
	let upload: R2MultipartUpload | null = null;
	const parts: R2UploadedPart[] = [];
	/** Gives up the multipart upload, if any (an incomplete upload is never an object). */
	const abort = async () => {
		const started = upload;
		upload = null;
		await started?.abort().catch(() => {});
	};
	try {
		for await (const chunk of chunks) {
			size += chunk.length;
			if (size > maxBytes) throw new TooLarge();
			await writer.write(chunk);
			if (headSize < HEAD_BYTES) {
				head.push(chunk);
				headSize += chunk.length;
			}
			tail.push(chunk);
			tailSize += chunk.length;
			while (tail.length > 1 && tailSize - (tail[0]?.length ?? 0) >= TAIL_BYTES) tailSize -= tail.shift()?.length ?? 0;
			pending.push(chunk);
			pendingSize += chunk.length;
			while (pendingSize >= partBytes) {
				const [part, rest] = take(pending, partBytes);
				pending = rest;
				pendingSize -= partBytes;
				upload ??= await bucket.createMultipartUpload(key);
				const to = upload;
				parts.push(await send(part, partBytes, (body) => to.uploadPart(parts.length + 1, body)));
			}
		}
		await writer.close();
		if (size === 0) return { ok: false, error: "file_missing" };
		const tailBytes = concat(tail);
		const format = detectFormat(concat(head), tailBytes.subarray(Math.max(0, tailBytes.length - TAIL_BYTES)), size);
		if (!format) {
			await abort();
			return { ok: false, error: "file_type" };
		}
		const sha256 = hex(await digest.digest);
		const existing = await existingKey(sha256);
		if (existing && (await bucket.head(existing))?.size === size) {
			await abort();
			return { ok: true, file: { key: existing, format, sizeBytes: size, sha256 } };
		}
		if (upload) {
			const to: R2MultipartUpload = upload;
			if (pendingSize > 0)
				parts.push(await send(pending, pendingSize, (body) => to.uploadPart(parts.length + 1, body)));
			await to.complete(parts);
		} else await send(pending, pendingSize, (body) => bucket.put(key, body));
		return { ok: true, file: { key, format, sizeBytes: size, sha256 } };
	} catch (err) {
		await abort();
		if (err instanceof TooLarge) return { ok: false, error: "file_too_large" };
		throw err;
	}
}

/** Text fields of an upload form, read before or after the file. */
const MAX_FIELD_BYTES = 16 * 1024;

/**
 * Reads an upload form (multipart, field `file`) as a stream and stores its file. The size is checked on the
 * Content-Length before anything is read, then again while reading (a body without one is cut off at the limit).
 */
export async function readFileForm(
	request: Request,
	bucket: R2Bucket,
	existingKey: (sha256: string) => Promise<string | null>,
	opts: { maxBytes?: number; partBytes?: number } = {},
): Promise<
	{ ok: true; fields: Record<string, string>; filename: string; file: StoredFile } | { ok: false; error: UploadError }
> {
	const maxBytes = opts.maxBytes ?? MAX_FILE_BYTES;
	const boundary = boundaryOf(request.headers.get("content-type"));
	if (!boundary || !request.body) return { ok: false, error: "file_upload" };
	const length = Number(request.headers.get("content-length") ?? "");
	if (length > maxBytes + FORM_OVERHEAD_BYTES) return { ok: false, error: "file_too_large" };
	const reader = new MultipartReader(request.body, boundary, { maxBytes: maxBytes + FORM_OVERHEAD_BYTES });
	const fields: Record<string, string> = {};
	let stored: { filename: string; file: StoredFile } | null = null;
	try {
		for (let part = await reader.next(); part; part = await reader.next()) {
			if (part.filename === null) fields[part.name] = await reader.text(MAX_FIELD_BYTES);
			else if (part.name === "file" && part.filename !== "" && !stored) {
				const result = await storeFile(bucket, reader.body(), existingKey, opts);
				if (!result.ok) return result;
				stored = { filename: part.filename, file: result.file };
			}
			// Any other file part (an empty file input, a second file) is skipped by next().
		}
	} catch (err) {
		if (err instanceof MultipartError)
			return { ok: false, error: err.code === "too_large" ? "file_too_large" : "file_upload" };
		throw err;
	}
	return stored ? { ok: true, fields, ...stored } : { ok: false, error: "file_missing" };
}

/** The object of an already stored file with this content, if any (identical uploads share one object). */
export async function objectKeyForHash(db: Db, sha256: string): Promise<string | null> {
	const rows = await db.select({ key: files.objectKey }).from(files).where(eq(files.sha256, sha256)).limit(1);
	return rows[0]?.key ?? null;
}

/** A file name as stored: no path, no control characters, at most MAX_NAME_LENGTH characters (extension kept). */
export function cleanFileName(raw: string): string {
	const visible = [...raw].map((ch) =>
		ch.charCodeAt(0) < 0x20 || ch === "\u007f" || ch === "/" || ch === "\\" ? " " : ch,
	);
	const name = visible.join("").replace(/\s+/g, " ").trim();
	if (name.length <= MAX_NAME_LENGTH) return name || "file";
	const dot = name.lastIndexOf(".");
	const ext = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : "";
	return `${name.slice(0, MAX_NAME_LENGTH - ext.length).trimEnd()}${ext}`;
}

/** The kind chosen on the upload form, or the format's default when left on "Automatic" (empty). */
export function uploadKind(value: string | undefined, format: FileFormat): FileKind {
	return (FILE_KINDS as readonly string[]).includes(value ?? "") ? (value as FileKind) : DEFAULT_KIND[format];
}

export const fileUploadInput = z.object({
	kind: z.union([z.literal(""), field.oneOf(FILE_KINDS)]),
	note: field.text(500),
});

export const fileEditInput = z.object({
	name: field.required(MAX_NAME_LENGTH),
	kind: field.oneOf(FILE_KINDS),
	note: field.text(500),
});

// ---------------------------------------------------------------------------
// Queries

/** A file with what it is attached to: its part, or its assembly and the assembly's part. */
export type FileWithOwner = {
	file: FileRow;
	part: { id: number; ref: string; name: string };
	assembly: { id: number; code: string; revision: string; status: string } | null;
};

export async function getFile(db: Db, id: number): Promise<FileWithOwner | undefined> {
	const rows = await db
		.select({
			file: files,
			part: { id: parts.id, ref: parts.ref, name: parts.name },
			assemblyId: assemblies.id,
			code: assemblies.code,
			revision: assemblies.revision,
			status: assemblies.status,
		})
		.from(files)
		.leftJoin(assemblies, eq(files.assemblyId, assemblies.id))
		.innerJoin(parts, eq(parts.id, sql`coalesce(${files.partId}, ${assemblies.parentPartId})`))
		.where(eq(files.id, id))
		.limit(1);
	const r = rows[0];
	if (!r) return undefined;
	return {
		file: r.file,
		part: r.part,
		assembly:
			r.assemblyId !== null && r.code !== null && r.revision !== null && r.status !== null
				? { id: r.assemblyId, code: r.code, revision: r.revision, status: r.status }
				: null,
	};
}

/** Files in display order: by kind (CAD, print, drawing…), then name. */
function sorted(rows: FileRow[]): FileRow[] {
	const rank = (k: FileKind) => FILE_KINDS.indexOf(k);
	return rows.sort((a, b) => rank(a.kind) - rank(b.kind) || a.name.localeCompare(b.name) || a.id - b.id);
}

export async function partFiles(db: Db, partId: number): Promise<FileRow[]> {
	return sorted(await db.select().from(files).where(eq(files.partId, partId)).orderBy(asc(files.id)));
}

export async function assemblyFiles(db: Db, assemblyId: number): Promise<FileRow[]> {
	return sorted(await db.select().from(files).where(eq(files.assemblyId, assemblyId)).orderBy(asc(files.id)));
}

// ---------------------------------------------------------------------------
// Statements

/** Files of an archived assembly are read-only, like its lines: repeated in SQL so a race cannot slip through. */
const notOnArchived: SQL = or(
	isNull(files.assemblyId),
	sql`${files.assemblyId} NOT IN (SELECT id FROM assemblies WHERE status = 'archived')`,
) as SQL;

export type FileOwner = { partId: number } | { assemblyId: number };

/** Attaches a stored file to a part, or to an assembly that is not archived. */
export function attachFileStatement(
	db: Db,
	owner: FileOwner,
	f: { name: string; kind: FileKind; note: string; stored: StoredFile },
	user: string,
	now: string,
): Statement {
	const s = f.stored;
	if ("partId" in owner) {
		return db.insert(files).values({
			partId: owner.partId,
			name: f.name,
			kind: f.kind,
			format: s.format,
			sizeBytes: s.sizeBytes,
			sha256: s.sha256,
			objectKey: s.key,
			note: f.note,
			uploadedAt: now,
			uploadedBy: user,
			createdAt: now,
			updatedAt: now,
			createdBy: user,
			updatedBy: user,
		});
	}
	// INSERT ... SELECT over every column of files, in table order (id is assigned): nothing when archived.
	return db.insert(files).select(sql`
		SELECT NULL, NULL, id, ${f.name}, ${f.kind}, ${s.format}, ${s.sizeBytes}, ${s.sha256}, ${s.key}, ${f.note},
			${now}, ${user}, ${now}, ${now}, ${user}, ${user}
		FROM assemblies WHERE id = ${owner.assemblyId} AND status <> 'archived'`);
}

export function editFileStatement(
	db: Db,
	id: number,
	f: { name: string; kind: FileKind; note: string },
	user: string,
	now: string,
): Statement {
	return db
		.update(files)
		.set({ name: f.name, kind: f.kind, note: f.note, updatedAt: now, updatedBy: user })
		.where(and(eq(files.id, id), notOnArchived));
}

/** Points a file at new content, keeping its name, kind and note: the previous object stays for an undo. */
export function replaceFileStatement(db: Db, id: number, stored: StoredFile, user: string, now: string): Statement {
	return db
		.update(files)
		.set({
			format: stored.format,
			sizeBytes: stored.sizeBytes,
			sha256: stored.sha256,
			objectKey: stored.key,
			uploadedAt: now,
			uploadedBy: user,
			updatedAt: now,
			updatedBy: user,
		})
		.where(and(eq(files.id, id), notOnArchived));
}

/** Detaches a file: its row goes, its object stays (D160). */
export function removeFileStatement(db: Db, id: number): Statement {
	return db.delete(files).where(and(eq(files.id, id), notOnArchived));
}

/**
 * Copies the files of `sourceAssemblyId` onto the assembly identified by (part, code, revision), created earlier in
 * the same batch (D164): same objects, same upload date and author; the copier attaches them. Only between revisions
 * and variants of one part: an assembly copied from another part's takes its lines, not that part's files.
 */
export function copyFilesStatement(
	db: Db,
	target: { parentPartId: number; code: string; revision: string },
	sourceAssemblyId: number,
	user: string,
	now: string,
): Statement {
	// INSERT ... SELECT over every column of files, in table order (id is assigned).
	return db.insert(files).select(sql`
		SELECT NULL, NULL,
			(SELECT id FROM assemblies WHERE parent_part_id = ${target.parentPartId} AND code = ${target.code} AND revision = ${target.revision}),
			name, kind, format, size_bytes, sha256, object_key, note, uploaded_at, uploaded_by, ${now}, ${now}, ${user}, ${user}
		FROM files WHERE assembly_id = ${sourceAssemblyId}
			AND (SELECT parent_part_id FROM assemblies WHERE id = ${sourceAssemblyId}) = ${target.parentPartId}
		ORDER BY id`);
}
