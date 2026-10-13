// Product images (D100): serve, upload (multipart form), remove. Mounted under /parts.
import { Hono } from "hono";
import { imagesBucket, readUpload, removeImage, replaceImage } from "../domain/images";
import { getPart } from "../domain/parts";
import { requireAdmin } from "../middleware/auth";
import type { AppEnv } from "../types";
import { idParam, notFound, nowIso, redirectOk } from "../views/render";

export const imageRoutes = new Hono<AppEnv>();

imageRoutes.get("/:id/image", async (c) => {
	const bucket = imagesBucket(c.env);
	const id = idParam(c);
	const part = bucket && id ? await getPart(c.var.db, id) : undefined;
	if (!bucket || !part?.imageKey) return notFound(c);
	const etag = `"${part.imageKey}"`;
	// The key changes with the content, and URLs carry it (?v=): a versioned URL can be cached for good.
	const versioned = c.req.query("v") !== undefined && part.imageKey.includes(`/${c.req.query("v")}.`);
	const headers = {
		ETag: etag,
		"Cache-Control": versioned ? "private, max-age=31536000, immutable" : "private, no-cache",
	};
	if (c.req.header("If-None-Match") === etag) return c.body(null, 304, headers);
	const object = await bucket.get(part.imageKey);
	if (!object) return notFound(c);
	return c.body(object.body, 200, {
		...headers,
		"Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
		"Content-Disposition": "inline",
	});
});

imageRoutes.post("/:id/image", async (c) => {
	const id = idParam(c);
	const part = id ? await getPart(c.var.db, id) : undefined;
	if (!part) return notFound(c);
	const bucket = imagesBucket(c.env);
	if (!bucket) return c.redirect(`/parts/${part.id}?err=images_disabled`, 303);
	const body = await c.req.parseBody();
	const upload = await readUpload(body.image);
	if (!upload.ok) return c.redirect(`/parts/${part.id}?err=${upload.error}#image`, 303);
	await replaceImage(c.var.db, bucket, part, upload, c.var.user, nowIso());
	return redirectOk(c, `/parts/${part.id}`);
});

imageRoutes.post("/:id/image/delete", requireAdmin, async (c) => {
	const id = idParam(c);
	const part = id ? await getPart(c.var.db, id) : undefined;
	if (!part) return notFound(c);
	const bucket = imagesBucket(c.env);
	if (bucket) await removeImage(c.var.db, bucket, part, c.var.user, nowIso());
	return redirectOk(c, `/parts/${part.id}`, "deleted");
});
