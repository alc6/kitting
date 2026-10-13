// Product images (D100): one image per part, stored in the optional IMAGES R2 bucket. The database keeps the
// object key on the part; keys are content-addressed, so an image URL never changes meaning and can be cached
// for good. The type is read from the file's first bytes, never from its name or the browser's claim.
import { eq } from "drizzle-orm";
import { parts } from "../db/schema";
import type { Db } from "../types";

/** Server-side limit. Browsers with JavaScript shrink photos before upload (public/static/app.js). */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export type ImageType = { contentType: "image/jpeg" | "image/png" | "image/webp"; ext: "jpg" | "png" | "webp" };

/** JPEG, PNG or WebP from the magic bytes; anything else (SVG, HEIC, GIF, PDF…) is refused. */
export function sniffImage(bytes: Uint8Array): ImageType | null {
	const at = (i: number) => bytes[i];
	const ascii = (from: number, text: string) => [...text].every((ch, i) => at(from + i) === ch.charCodeAt(0));
	if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return { contentType: "image/jpeg", ext: "jpg" };
	if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => at(i) === b))
		return { contentType: "image/png", ext: "png" };
	if (ascii(0, "RIFF") && ascii(8, "WEBP")) return { contentType: "image/webp", ext: "webp" };
	return null;
}

/** First 16 hex digits of the SHA-256 of the bytes: enough to tell a part's images apart. */
export async function contentHash(bytes: Uint8Array): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	return [...digest.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const imageKeyFor = (partId: number, hash: string, ext: string) => `parts/${partId}/${hash}.${ext}`;

/** URL of a part's image; the version (the content hash) makes it safe to cache forever. */
export function imageUrl(part: { id: number; imageKey: string | null }): string | null {
	if (!part.imageKey) return null;
	const version = part.imageKey.slice(part.imageKey.lastIndexOf("/") + 1, part.imageKey.lastIndexOf("."));
	return `/parts/${part.id}/image?v=${version}`;
}

export type UploadError = "image_missing" | "image_too_large" | "image_type";

/** Checks an uploaded file and returns its bytes and type. */
export async function readUpload(
	file: unknown,
): Promise<{ ok: true; bytes: Uint8Array; type: ImageType } | { ok: false; error: UploadError }> {
	if (!(file instanceof File) || file.size === 0) return { ok: false, error: "image_missing" };
	if (file.size > MAX_IMAGE_BYTES) return { ok: false, error: "image_too_large" };
	const bytes = new Uint8Array(await file.arrayBuffer());
	const type = sniffImage(bytes);
	return type ? { ok: true, bytes, type } : { ok: false, error: "image_type" };
}

/** Points a part at an image object (or at none). */
export function imageKeyStatement(db: Db, partId: number, key: string | null, user: string, now: string) {
	return db.update(parts).set({ imageKey: key, updatedAt: now, updatedBy: user }).where(eq(parts.id, partId));
}

/**
 * Stores a part's new image, points the part at it with `setKey` (the database write, e.g. imageKeyStatement),
 * then deletes the previous object. The object is written first: a failure leaves at worst an unreferenced
 * object, never a part pointing at nothing.
 */
export async function replaceImage(
	bucket: R2Bucket,
	part: { id: number; imageKey: string | null },
	upload: { bytes: Uint8Array; type: ImageType },
	setKey: (key: string) => Promise<unknown>,
): Promise<string> {
	const key = imageKeyFor(part.id, await contentHash(upload.bytes), upload.type.ext);
	await bucket.put(key, upload.bytes, { httpMetadata: { contentType: upload.type.contentType } });
	await setKey(key);
	if (part.imageKey && part.imageKey !== key) await bucket.delete(part.imageKey);
	return key;
}

/** Removes a part's image: the pointer first (`clearKey`, the database write), then the object. */
export async function removeImage(
	bucket: R2Bucket,
	part: { id: number; imageKey: string | null },
	clearKey: () => Promise<unknown>,
): Promise<void> {
	if (!part.imageKey) return;
	await clearKey();
	await bucket.delete(part.imageKey);
}

/** The IMAGES bucket, or null when this deployment has none (images are optional). */
export function imagesBucket(env: Env): R2Bucket | null {
	return (env as Partial<Env>).IMAGES ?? null;
}
