import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { MAX_IMAGE_BYTES, sniffImage } from "../src/domain/images";
import { insertPart, NOT_ADMIN, one, postForm, request, setRole } from "./helpers";

// NOT_ADMIN requests run as a planner, so admin-only actions are refused by requireAdmin itself.
beforeEach(() => setRole("planner"));

const PNG = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2, 3,
]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 9, 9]);
const WEBP = new TextEncoder().encode("RIFF\u0000\u0000\u0000\u0000WEBPVP8 ");

function upload(partId: number, bytes: Uint8Array, name = "photo.png", overrides = {}) {
	const form = new FormData();
	form.set("image", new File([bytes], name, { type: "image/png" }));
	return request(`/parts/${partId}/image`, { method: "POST", body: form }, overrides);
}

const imageKey = async (id: number) =>
	(await one<{ image_key: string | null }>("SELECT image_key FROM parts WHERE id = ?", id)).image_key;

describe("product images", () => {
	it("recognises JPEG, PNG and WebP by their first bytes only", () => {
		expect(sniffImage(PNG)?.contentType).toBe("image/png");
		expect(sniffImage(JPEG)?.contentType).toBe("image/jpeg");
		expect(sniffImage(WEBP)?.contentType).toBe("image/webp");
		expect(sniffImage(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
		expect(sniffImage(new TextEncoder().encode("GIF89a"))).toBeNull();
		expect(sniffImage(new Uint8Array())).toBeNull();
	});

	it("uploads an image, shows it on the part and in the list, and serves it with long caching", async () => {
		const id = await insertPart("LAMP-X", "make");
		const res = await upload(id, PNG);
		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toBe(`/parts/${id}?ok=saved`);
		const key = await imageKey(id);
		expect(key).toMatch(new RegExp(`^parts/${id}/[0-9a-f]{16}\\.png$`));
		const version = key?.slice(key.lastIndexOf("/") + 1, -".png".length);

		const page = await request(`/parts/${id}`);
		expect(page.headers.get("Cache-Control")).toBe("no-store");
		const html = await page.text();
		expect(html).toContain(`<img src="/parts/${id}/image?v=${version}" alt="Part LAMP-X"`);
		expect(html).toContain('enctype="multipart/form-data"');
		expect(html).not.toMatch(/\sstyle=/);
		expect(await (await request("/parts")).text()).toContain(`src="/parts/${id}/image?v=${version}"`);

		const img = await request(`/parts/${id}/image?v=${version}`);
		expect(img.status).toBe(200);
		expect(img.headers.get("Content-Type")).toBe("image/png");
		expect(img.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable");
		expect(img.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(new Uint8Array(await img.arrayBuffer())).toEqual(PNG);
		// Unversioned URLs revalidate; a matching ETag answers 304.
		const plain = await request(`/parts/${id}/image`);
		expect(plain.headers.get("Cache-Control")).toBe("private, no-cache");
		const etag = plain.headers.get("ETag") ?? "";
		await plain.arrayBuffer();
		expect((await request(`/parts/${id}/image`, { headers: { "If-None-Match": etag } })).status).toBe(304);
	});

	it("refuses files that are not JPEG, PNG or WebP, empty files and files over the limit", async () => {
		const id = await insertPart("LAMP-X", "make");
		const svg = await upload(id, new TextEncoder().encode("<svg onload='alert(1)'/>"), "x.png");
		expect(svg.headers.get("Location")).toBe(`/parts/${id}?err=image_type#image`);
		expect((await upload(id, new Uint8Array())).headers.get("Location")).toContain("err=image_missing");
		const big = new Uint8Array(MAX_IMAGE_BYTES + 1);
		big.set(PNG);
		expect((await upload(id, big)).headers.get("Location")).toContain("err=image_too_large");
		expect(await imageKey(id)).toBeNull();
		const page = await (await request(`/parts/${id}?err=image_type`)).text();
		expect(page).toContain("Use a JPEG, PNG or WebP image.");
		// Only known error keys are shown.
		expect(await (await request(`/parts/${id}?err=assembly_cycle`)).text()).not.toContain("This would create a cycle");
	});

	it("replaces an image and deletes the previous file", async () => {
		const id = await insertPart("LAMP-X", "make");
		await upload(id, PNG);
		const first = await imageKey(id);
		await upload(id, JPEG, "photo.jpg");
		const second = await imageKey(id);
		expect(second).toMatch(/\.jpg$/);
		expect(await env.IMAGES.head(first ?? "")).toBeNull();
		expect(await env.IMAGES.head(second ?? "")).not.toBeNull();
	});

	it("lets only admins remove an image; deleting the part deletes its image too", async () => {
		const id = await insertPart("LAMP-X", "make");
		await upload(id, PNG);
		const key = (await imageKey(id)) ?? "";
		const denied = await postForm(`/parts/${id}/image/delete`, {}, NOT_ADMIN);
		expect(denied.status).toBe(403);
		expect(await (await request(`/parts/${id}`, {}, NOT_ADMIN)).text()).not.toContain(`/parts/${id}/image/delete`);
		expect((await postForm(`/parts/${id}/image/delete`, {})).status).toBe(303);
		expect(await imageKey(id)).toBeNull();
		expect(await env.IMAGES.head(key)).toBeNull();
		expect((await request(`/parts/${id}/image`)).status).toBe(404);

		await upload(id, JPEG, "photo.jpg");
		const again = (await imageKey(id)) ?? "";
		expect((await postForm(`/parts/${id}/delete`, {})).status).toBe(303);
		expect(await env.IMAGES.head(again)).toBeNull();
	});

	it("runs without images when the deployment has no bucket", async () => {
		const id = await insertPart("LAMP-X", "make");
		const none = { IMAGES: undefined };
		const html = await (await request(`/parts/${id}`, {}, none)).text();
		expect(html).not.toContain('enctype="multipart/form-data"');
		expect(html).toContain("Images are not set up");
		// The hint is for those who would upload (parts.edit), not for an operator.
		await setRole("operator");
		expect(await (await request(`/parts/${id}`, {}, { ...none, ...NOT_ADMIN })).text()).not.toContain(
			"Images are not set up",
		);
		expect((await upload(id, PNG, "photo.png", none)).headers.get("Location")).toBe(`/parts/${id}?err=images_disabled`);
		expect((await request(`/parts/${id}/image`, {}, none)).status).toBe(404);
	});
});
