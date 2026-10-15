import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { detectFormat, downloadName, HEAD_BYTES, TAIL_BYTES, zipEntryNames } from "../src/domain/file-types";
import { cleanFileName, MAX_FILE_BYTES, readFileForm, storeFile } from "../src/domain/files";
import { revertChangeSet } from "../src/domain/revert";
import { boundaryOf, MultipartError, MultipartReader } from "../src/lib/multipart";
import {
	assemblyId,
	changeSql,
	insertPart,
	loadDemo,
	NOT_ADMIN,
	one,
	partId,
	postForm,
	request,
	rows,
	setRole,
	stmt,
	testDb,
} from "./helpers";
import { callTool, connect, resetKv } from "./mcp-helpers";

// ---------------------------------------------------------------------------
// Tiny fictional fixtures

const text = (s: string) => new TextEncoder().encode(s);

const STEP = text(
	"ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('Lamp clip'),'2;1');\nFILE_NAME('clip.step','2026-01-01',(''),(''),'','','');\nENDSEC;\nDATA;\n#1=CARTESIAN_POINT('',(0.,0.,0.));\nENDSEC;\nEND-ISO-10303-21;\n",
);
const PDF = text("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n");
const ASCII_STL = text(
	"solid clip\n facet normal 0 0 1\n  outer loop\n   vertex 0 0 0\n   vertex 1 0 0\n   vertex 0 1 0\n  endloop\n endfacet\nendsolid clip\n",
);
const DXF = text("  0\r\nSECTION\r\n  2\r\nHEADER\r\n  0\r\nENDSEC\r\n  0\r\nEOF\r\n");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const SVG = text('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const HTML = text("<!doctype html><html><body><script>alert(1)</script></body></html>");
const SCRIPT = text("#!/bin/sh\necho hello\n");

/** A binary STL with `n` triangles, whose 80-byte header starts with "solid" as some exporters write it. */
function binaryStl(n: number): Uint8Array {
	const out = new Uint8Array(84 + 50 * n);
	out.set(text("solid exported by a slicer"));
	new DataView(out.buffer).setUint32(80, n, true);
	for (let i = 84; i < out.length; i++) out[i] = (i * 7) % 251;
	return out;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});
const crc32 = (b: Uint8Array) => {
	let c = 0xffffffff;
	for (const x of b) c = (CRC_TABLE[(c ^ x) & 0xff] ?? 0) ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
};

/** A ZIP of stored (uncompressed) entries, as a 3MF is. */
function zip(entries: [string, string][]): Uint8Array {
	const local: Uint8Array[] = [];
	const central: Uint8Array[] = [];
	let offset = 0;
	for (const [name, content] of entries) {
		const n = text(name);
		const data = text(content);
		const h = new DataView(new ArrayBuffer(30));
		h.setUint32(0, 0x04034b50, true);
		h.setUint16(4, 20, true);
		h.setUint32(14, crc32(data), true);
		h.setUint32(18, data.length, true);
		h.setUint32(22, data.length, true);
		h.setUint16(26, n.length, true);
		const c = new DataView(new ArrayBuffer(46));
		c.setUint32(0, 0x02014b50, true);
		c.setUint16(4, 20, true);
		c.setUint16(6, 20, true);
		c.setUint32(16, crc32(data), true);
		c.setUint32(20, data.length, true);
		c.setUint32(24, data.length, true);
		c.setUint16(28, n.length, true);
		c.setUint32(42, offset, true);
		local.push(new Uint8Array(h.buffer), n, data);
		central.push(new Uint8Array(c.buffer), n);
		offset += 30 + n.length + data.length;
	}
	const cdSize = central.reduce((s, b) => s + b.length, 0);
	const end = new DataView(new ArrayBuffer(22));
	end.setUint32(0, 0x06054b50, true);
	end.setUint16(8, entries.length, true);
	end.setUint16(10, entries.length, true);
	end.setUint32(12, cdSize, true);
	end.setUint32(16, offset, true);
	return join([...local, ...central, new Uint8Array(end.buffer)]);
}

function join(parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((s, b) => s + b.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}

const THREE_MF = zip([
	["[Content_Types].xml", '<?xml version="1.0"?><Types/>'],
	["_rels/.rels", '<?xml version="1.0"?><Relationships/>'],
	["3D/3dmodel.model", '<?xml version="1.0"?><model unit="millimeter"><resources/><build/></model>'],
]);
const PLAIN_ZIP = zip([["readme.txt", "not a print file"]]);

const detect = (bytes: Uint8Array) =>
	detectFormat(bytes.subarray(0, HEAD_BYTES), bytes.subarray(Math.max(0, bytes.length - TAIL_BYTES)), bytes.length);

// ---------------------------------------------------------------------------
// Requests

function upload(path: string, bytes: Uint8Array, name: string, fields: Record<string, string> = {}, overrides = {}) {
	const form = new FormData();
	for (const [k, v] of Object.entries(fields)) form.set(k, v);
	form.set("file", new File([bytes], name, { type: "application/octet-stream" }));
	return request(path, { method: "POST", body: form }, overrides);
}

type FileDb = {
	id: number;
	part_id: number | null;
	assembly_id: number | null;
	name: string;
	kind: string;
	format: string;
	size_bytes: number;
	sha256: string;
	object_key: string;
	note: string;
	uploaded_at: string;
	uploaded_by: string;
	created_by: string;
};
const fileRows = () => rows<FileDb>("SELECT * FROM files ORDER BY id");
const lastFile = () => one<FileDb>("SELECT * FROM files ORDER BY id DESC LIMIT 1");
const lastSet = async () => (await one<{ id: number }>("SELECT max(id) AS id FROM change_sets")).id;
const objectCount = async () => (await env.IMAGES.list({ prefix: "files/" })).objects.length;
const ADMIN = { role: "admin" as const, seeCosts: true };

beforeEach(async () => {
	// R2 is shared by the tests of a file: start each test with no file object.
	const listed = await env.IMAGES.list({ prefix: "files/" });
	if (listed.objects.length) await env.IMAGES.delete(listed.objects.map((o) => o.key));
});

describe("file types", () => {
	it("recognises STEP, 3MF, STL, PDF, DXF and images from their content", () => {
		expect(detect(STEP)).toBe("step");
		expect(detect(join([text("\ufeff\n"), STEP]))).toBe("step");
		expect(detect(THREE_MF)).toBe("3mf");
		expect(detect(binaryStl(3))).toBe("stl");
		expect(detect(ASCII_STL)).toBe("stl");
		expect(detect(PDF)).toBe("pdf");
		expect(detect(DXF)).toBe("dxf");
		expect(detect(text("999\nmade by hand\n0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n"))).toBe("dxf");
		expect(detect(PNG)).toBe("png");
		// A text format quoting the PDF marker near its start stays what it is.
		expect(detect(join([text("ISO-10303-21;\n/* exported from %PDF-1.7 */\n"), STEP]))).toBe("step");
	});

	it("refuses SVG, HTML, scripts, other ZIPs and anything unknown", () => {
		for (const bytes of [SVG, HTML, SCRIPT, PLAIN_ZIP, text("solid but not an STL"), new Uint8Array(0)])
			expect(detect(bytes)).toBeNull();
		// A binary STL whose size does not match its triangle count is not one.
		expect(detect(binaryStl(3).subarray(0, 84 + 50 * 3 - 1))).toBeNull();
	});

	it("reads the ZIP central directory from the tail only", () => {
		expect(zipEntryNames(THREE_MF, THREE_MF.length)).toContain("3D/3dmodel.model");
		// A 3MF whose model sits behind a large entry: the directory is still at the end.
		const big = zip([
			["Metadata/thumbnail.png", "x".repeat(200_000)],
			["3D/3dmodel.model", "<model/>"],
		]);
		expect(detect(big)).toBe("3mf");
	});

	it("keeps or adds the extension of the format in download names", () => {
		expect(downloadName("Bracket rev B.stp", "step")).toBe("Bracket rev B.stp");
		expect(downloadName("Bracket rev B", "step")).toBe("Bracket rev B.step");
		expect(downloadName("guide.PDF", "pdf")).toBe("guide.PDF");
		expect(downloadName("photo", "jpeg")).toBe("photo.jpg");
	});

	it("cleans file names", () => {
		expect(cleanFileName("C:\\\\plans\\clip.step")).toBe("C: plans clip.step");
		expect(cleanFileName("a\u0000b\r\nc.pdf")).toBe("a b c.pdf");
		expect(cleanFileName("   ")).toBe("file");
		const long = `${"x".repeat(300)}.3mf`;
		expect(cleanFileName(long)).toHaveLength(200);
		expect(cleanFileName(long).endsWith(".3mf")).toBe(true);
	});
});

describe("multipart reader", () => {
	const BOUNDARY = "----KittingBoundary7MA4YWxk";
	const body = (parts: string | Uint8Array[]) => (typeof parts === "string" ? text(parts) : join(parts));
	const formBody = (file: Uint8Array, filename = "clip.step") =>
		body([
			text(`preamble\r\n--${BOUNDARY}\r\nContent-Disposition: form-data; name="kind"\r\n\r\nprint\r\n`),
			text(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n`),
			text("Content-Type: application/octet-stream\r\n\r\n"),
			file,
			text(`\r\n--${BOUNDARY}\r\nContent-Disposition: form-data; name="note"\r\n\r\nafter the file\r\n`),
			text(`--${BOUNDARY}--\r\n`),
		]);

	/** A stream handing out `bytes` in chunks of the given sizes (cycled). */
	function stream(bytes: Uint8Array, sizes: number[]): ReadableStream<Uint8Array> {
		let at = 0;
		let i = 0;
		return new ReadableStream({
			pull(controller) {
				if (at >= bytes.length) return controller.close();
				const n = sizes[i++ % sizes.length] ?? 1;
				controller.enqueue(bytes.slice(at, at + n));
				at += n;
			},
		});
	}

	async function read(bytes: Uint8Array, sizes: number[], maxBytes = 1_000_000) {
		const reader = new MultipartReader(stream(bytes, sizes), BOUNDARY, { maxBytes });
		const fields: Record<string, string> = {};
		const files: { name: string; filename: string | null; bytes: Uint8Array }[] = [];
		for (let part = await reader.next(); part; part = await reader.next()) {
			if (part.filename === null) fields[part.name] = await reader.text(1000);
			else {
				const chunks: Uint8Array[] = [];
				for await (const c of reader.body()) chunks.push(c.slice());
				files.push({ name: part.name, filename: part.filename, bytes: join(chunks) });
			}
		}
		return { fields, files };
	}

	it("reads fields before and after a file, whatever the chunking", async () => {
		// The content holds what looks like the start of a delimiter, more than once.
		const content = join([STEP, text(`\r\n--${BOUNDARY.slice(0, 10)}x\r\n\r\n--`), binaryStl(2)]);
		for (const sizes of [[1], [3, 7, 64], [1024], [100_000]]) {
			const out = await read(formBody(content), sizes);
			expect(out.fields).toEqual({ kind: "print", note: "after the file" });
			expect(out.files).toHaveLength(1);
			expect(out.files[0]?.filename).toBe("clip.step");
			expect(out.files[0]?.bytes).toEqual(content);
		}
	});

	it("decodes UTF-8 and escaped file names, and drops paths", async () => {
		const out = await read(formBody(PDF, "Plan d’ensemble %22v2%22 é.pdf"), [5]);
		expect(out.files[0]?.filename).toBe('Plan d’ensemble "v2" é.pdf');
		const windows = await read(formBody(PDF, "C:\\Users\\me\\guide.pdf"), [1024]);
		expect(windows.files[0]?.filename).toBe("guide.pdf");
		const extended = body([
			text(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="plan.pdf"; `),
			text("filename*=UTF-8''Plan%20d%E2%80%99ensemble.pdf\r\n\r\n"),
			PDF,
			text(`\r\n--${BOUNDARY}--\r\n`),
		]);
		expect((await read(extended, [7])).files[0]?.filename).toBe("Plan d’ensemble.pdf");
	});

	it("limits the number of parts and the size of their headers", async () => {
		const field = (name: string) => `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\nx\r\n`;
		const many = body(`${Array.from({ length: 21 }, (_, i) => field(`f${i}`)).join("")}--${BOUNDARY}--\r\n`);
		await expect(read(many, [4096])).rejects.toMatchObject({ code: "malformed" });
		expect((await read(body(`${field("a")}--${BOUNDARY}--\r\n`), [4096])).fields).toEqual({ a: "x" });
		// A header block over 8 KB, even when it arrives in one chunk.
		const padded = body(
			`--${BOUNDARY}\r\nContent-Disposition: form-data; name="a"\r\nX-Pad: ${"p".repeat(9000)}\r\n\r\nx\r\n--${BOUNDARY}--\r\n`,
		);
		await expect(read(padded, [100_000])).rejects.toMatchObject({ code: "malformed" });
	});

	it("refuses a truncated body, a body over the limit and a field too long", async () => {
		const whole = formBody(STEP);
		await expect(read(whole.subarray(0, whole.length - 20), [64])).rejects.toThrow(MultipartError);
		await expect(read(whole, [64], 100)).rejects.toMatchObject({ code: "too_large" });
		const long = body(
			`--${BOUNDARY}\r\nContent-Disposition: form-data; name="note"\r\n\r\n${"x".repeat(2000)}\r\n--${BOUNDARY}--\r\n`,
		);
		await expect(read(long, [64])).rejects.toMatchObject({ code: "malformed" });
	});

	it("parses the boundary of the Content-Type", () => {
		expect(boundaryOf(`multipart/form-data; boundary=${BOUNDARY}`)).toBe(BOUNDARY);
		expect(boundaryOf('multipart/form-data; charset=utf-8; boundary="a b"')).toBe("a b");
		expect(boundaryOf("application/x-www-form-urlencoded")).toBeNull();
		expect(boundaryOf(null)).toBeNull();
	});
});

describe("storing uploads", () => {
	const chunks = async function* (bytes: Uint8Array, size = 65_536) {
		for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, at + size);
	};
	const none = async () => null;

	it("refuses a stream past the limit, and stores nothing", async () => {
		const out = await storeFile(env.IMAGES, chunks(binaryStl(100)), none, { maxBytes: 1000 });
		expect(out).toEqual({ ok: false, error: "file_too_large" });
		expect(await objectCount()).toBe(0);
	});

	it("checks the Content-Length before reading the body", async () => {
		const body = new ReadableStream({ pull: (controller) => controller.close() });
		const req = new Request("https://kitting.example.com/x", {
			method: "POST",
			body,
			headers: {
				"Content-Type": "multipart/form-data; boundary=x",
				"Content-Length": String(MAX_FILE_BYTES + 100_000),
			},
		});
		expect(await readFileForm(req, env.IMAGES, none)).toEqual({ ok: false, error: "file_too_large" });
		expect(req.bodyUsed, "the body was never read").toBe(false);
	});

	it("sends a large file in parts and aborts a refused one", async () => {
		// 12 MiB: two full 5 MiB parts, then the rest.
		const stl = binaryStl(251_659);
		const out = await storeFile(env.IMAGES, chunks(stl), none);
		expect(out.ok && out.file).toMatchObject({ format: "stl", sizeBytes: stl.length });
		if (!out.ok) return;
		const stored = new Uint8Array((await (await env.IMAGES.get(out.file.key))?.arrayBuffer()) ?? new ArrayBuffer(0));
		// Compared byte by byte: a deep equality of two 12 MiB arrays exhausts the test runner's memory.
		expect(stored.length).toBe(stl.length);
		expect(stored.every((b, i) => b === stl[i])).toBe(true);

		// The same size, but not an STL: the multipart upload is aborted, no object appears.
		const junk = stl.slice();
		junk[80] = 0;
		expect(await storeFile(env.IMAGES, chunks(junk), none)).toEqual({ ok: false, error: "file_type" });
		expect(await objectCount()).toBe(1);
	});

	it("aborts the upload when the stream fails after parts were sent", async () => {
		const stl = binaryStl(251_659);
		const failing = async function* () {
			yield* chunks(stl.subarray(0, 7 * 1024 * 1024));
			throw new MultipartError("malformed");
		};
		await expect(storeFile(env.IMAGES, failing(), none)).rejects.toThrow(MultipartError);
		expect(await objectCount()).toBe(0);
	});

	it("reuses an object with the same content, never one of another size", async () => {
		await env.IMAGES.put("files/same", STEP);
		const same = await storeFile(env.IMAGES, chunks(STEP), async () => "files/same");
		expect(same.ok && same.file.key).toBe("files/same");
		await env.IMAGES.put("files/other", text("ISO-10303-21;"));
		const other = await storeFile(env.IMAGES, chunks(STEP), async () => "files/other");
		expect(other.ok && other.file.key).not.toBe("files/other");
		expect(await objectCount()).toBe(3);
	});
});

describe("files on parts", () => {
	beforeEach(async () => {
		await loadDemo();
		await setRole("planner");
	});

	it("attaches a file, lists it, and serves it as an attachment", async () => {
		const clip = await partId("LAMP-CLIP");
		const res = await upload(
			`/parts/${clip}/files`,
			STEP,
			"clip.step",
			{ kind: "", note: "Rev B geometry" },
			NOT_ADMIN,
		);
		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toBe(`/parts/${clip}?ok=saved#files`);
		const f = await lastFile();
		expect(f).toMatchObject({
			part_id: clip,
			assembly_id: null,
			name: "clip.step",
			kind: "cad",
			format: "step",
			size_bytes: STEP.length,
			note: "Rev B geometry",
			uploaded_by: "tester@example.com",
		});
		expect(f.object_key).toMatch(/^files\/[0-9a-f-]{36}$/);
		expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
		const set = await one<{ summary: string; revertible: number }>(
			"SELECT summary, revertible FROM change_sets ORDER BY id DESC LIMIT 1",
		);
		expect(set).toEqual({ summary: "Attach file clip.step to LAMP-CLIP", revertible: 1 });

		const html = await (await request(`/parts/${clip}`, {}, NOT_ADMIN)).text();
		expect(html).toContain(`href="/files/${f.id}/download"`);
		expect(html).toContain("Rev B geometry");
		expect(html).toContain('enctype="multipart/form-data"');
		expect(html).not.toMatch(/\sstyle=/);

		const download = await request(`/files/${f.id}/download`);
		expect(download.status).toBe(200);
		expect(download.headers.get("Content-Type")).toBe("model/step");
		expect(download.headers.get("Content-Disposition")).toBe(
			`attachment; filename="clip.step"; filename*=UTF-8''clip.step`,
		);
		expect(download.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(download.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox");
		expect(download.headers.get("Cache-Control")).toBe("private, no-cache");
		expect(download.headers.get("Content-Length")).toBe(String(STEP.length));
		expect(new Uint8Array(await download.arrayBuffer())).toEqual(STEP);
		const etag = download.headers.get("ETag") ?? "";
		expect((await request(`/files/${f.id}/download`, { headers: { "If-None-Match": etag } })).status).toBe(304);
		// Not a PDF or an image: "open" downloads it.
		const open = await request(`/files/${f.id}/open`);
		expect(open.status).toBe(303);
		expect(open.headers.get("Location")).toBe(`/files/${f.id}/download`);
	});

	it("opens PDFs inline, and names downloads in UTF-8", async () => {
		const box = await partId("BOX-LAMP");
		await upload(`/parts/${box}/files`, PDF, "Fiche « technique ».pdf", { kind: "datasheet" }, NOT_ADMIN);
		const f = await lastFile();
		expect(f).toMatchObject({ kind: "datasheet", format: "pdf" });
		const open = await request(`/files/${f.id}/open`);
		expect(open.status).toBe(200);
		expect(open.headers.get("Content-Type")).toBe("application/pdf");
		expect(open.headers.get("Content-Disposition")).toBe(
			`inline; filename="Fiche  technique .pdf"; filename*=UTF-8''Fiche%20%C2%AB%20technique%20%C2%BB.pdf`,
		);
		expect(open.headers.get("Content-Security-Policy")).not.toContain("script");
		await open.arrayBuffer();
	});

	it("refuses SVG, HTML and scripts, whatever their name, and stores nothing", async () => {
		const clip = await partId("LAMP-CLIP");
		for (const [bytes, name] of [
			[SVG, "drawing.pdf"],
			[HTML, "clip.step"],
			[SCRIPT, "clip.stl"],
			[PLAIN_ZIP, "plate.3mf"],
		] as const) {
			const res = await upload(`/parts/${clip}/files`, bytes, name, {}, NOT_ADMIN);
			expect(res.headers.get("Location")).toBe(`/parts/${clip}?err=file_type#files`);
		}
		expect(await fileRows()).toEqual([]);
		expect(await objectCount()).toBe(0);
		const page = await (await request(`/parts/${clip}?err=file_type`)).text();
		expect(page).toContain("Use a STEP, 3MF, STL, PDF, DXF, JPEG, PNG or WebP file.");
		const empty = await upload(`/parts/${clip}/files`, new Uint8Array(0), "empty.step", {}, NOT_ADMIN);
		expect(empty.headers.get("Location")).toBe(`/parts/${clip}?err=file_missing#files`);
	});

	it("stores identical content once", async () => {
		await upload(`/parts/${await partId("LAMP-CLIP")}/files`, THREE_MF, "plate.3mf", {}, NOT_ADMIN);
		await upload(`/parts/${await partId("BOX-LAMP")}/files`, THREE_MF, "same plate.3mf", {}, NOT_ADMIN);
		const [a, b] = await fileRows();
		expect(a?.kind).toBe("print");
		expect(b?.object_key).toBe(a?.object_key);
		expect(await objectCount()).toBe(1);
	});

	it("renames, replaces and removes; each can be undone", async () => {
		const clip = await partId("LAMP-CLIP");
		await upload(`/parts/${clip}/files`, ASCII_STL, "clip.stl", {}, NOT_ADMIN);
		const f = await lastFile();
		const firstKey = f.object_key;

		// Rename and change the kind.
		const edit = await request(`/files/${f.id}/edit`, {}, NOT_ADMIN);
		expect(await edit.text()).toContain(`action="/files/${f.id}/replace"`);
		expect(
			(await postForm(`/files/${f.id}`, { name: "", kind: "print", note: "" }, NOT_ADMIN)).status,
			"a name is required",
		).toBe(422);
		await postForm(`/files/${f.id}`, { name: "Clip, 24 per plate", kind: "drawing", note: "PLA" }, NOT_ADMIN);
		expect(await lastFile()).toMatchObject({ name: "Clip, 24 per plate", kind: "drawing", note: "PLA" });
		const renamed = await lastSet();

		// Replace: same row, new content; the previous object stays.
		const res = await upload(`/files/${f.id}/replace`, binaryStl(4), "whatever.stl", {}, NOT_ADMIN);
		expect(res.headers.get("Location")).toBe(`/parts/${clip}?ok=saved#files`);
		const replaced = await lastFile();
		expect(replaced).toMatchObject({ id: f.id, name: "Clip, 24 per plate", size_bytes: 84 + 200 });
		expect(replaced.object_key).not.toBe(firstKey);
		expect(await env.IMAGES.head(firstKey)).not.toBeNull();
		const replacing = await lastSet();
		expect(
			(await revertChangeSet(testDb(), ADMIN, replacing, { user: "tester@example.com", summary: () => "undo" })).ok,
		).toBe(true);
		expect((await lastFile()).object_key).toBe(firstKey);
		const back = await request(`/files/${f.id}/download`);
		expect(new Uint8Array(await back.arrayBuffer())).toEqual(ASCII_STL);

		// Remove detaches: the row goes, the object stays, and the undo re-attaches it.
		const removed = await postForm(`/files/${f.id}/remove`, {}, NOT_ADMIN);
		expect(removed.headers.get("Location")).toBe(`/parts/${clip}?ok=deleted#files`);
		expect(await fileRows()).toEqual([]);
		expect(await env.IMAGES.head(firstKey)).not.toBeNull();
		const removal = await lastSet();
		expect(await one("SELECT summary, revertible FROM change_sets WHERE id = ?", removal)).toEqual({
			summary: "Remove file Clip, 24 per plate from LAMP-CLIP",
			revertible: 1,
		});
		const undo = await postForm(`/history/${removal}/revert`, {}, NOT_ADMIN);
		expect(undo.status).toBe(303);
		expect((await lastFile()).id).toBe(f.id);
		expect((await request(`/files/${f.id}/download`)).status).toBe(200);

		// The part's History tab lists the file's changes, named after the file and the part.
		const history = await (await request(`/parts/${clip}/history`)).text();
		expect(history).toContain("Clip, 24 per plate (LAMP-CLIP)");
		expect(history).toContain(`/history/${renamed}`);
	});

	it("undoes an attach by removing the row only", async () => {
		const clip = await partId("LAMP-CLIP");
		await upload(`/parts/${clip}/files`, PDF, "guide.pdf", {}, NOT_ADMIN);
		const key = (await lastFile()).object_key;
		expect((await postForm(`/history/${await lastSet()}/revert`, {}, NOT_ADMIN)).status).toBe(303);
		expect(await fileRows()).toEqual([]);
		expect(await env.IMAGES.head(key)).not.toBeNull();
	});

	it("lets planners change files, operators and viewers only read them", async () => {
		const clip = await partId("LAMP-CLIP");
		await upload(`/parts/${clip}/files`, PDF, "guide.pdf", {}, NOT_ADMIN);
		const f = await lastFile();
		for (const role of ["operator", "viewer"] as const) {
			await setRole(role);
			expect((await upload(`/parts/${clip}/files`, STEP, "clip.step", {}, NOT_ADMIN)).status).toBe(403);
			expect((await postForm(`/files/${f.id}/remove`, {}, NOT_ADMIN)).status).toBe(403);
			expect((await request(`/files/${f.id}/edit`, {}, NOT_ADMIN)).status).toBe(403);
			const html = await (await request(`/parts/${clip}`, {}, NOT_ADMIN)).text();
			expect(html).toContain(`href="/files/${f.id}/download"`);
			expect(html).not.toContain(`/parts/${clip}/files"`);
			expect(html).not.toContain(`/files/${f.id}/remove`);
			expect((await request(`/files/${f.id}/download`, {}, NOT_ADMIN)).status).toBe(200);
		}
		// Without a file, the card is not shown to those who cannot add one.
		const box = await partId("BOX-LAMP");
		expect(await (await request(`/parts/${box}`, {}, NOT_ADMIN)).text()).not.toContain('id="files"');
	});

	it("hides every file control without a bucket", async () => {
		const clip = await partId("LAMP-CLIP");
		await upload(`/parts/${clip}/files`, PDF, "guide.pdf", {}, NOT_ADMIN);
		const f = await lastFile();
		const none = { ...NOT_ADMIN, IMAGES: undefined };
		const html = await (await request(`/parts/${clip}`, {}, none)).text();
		expect(html).toContain("guide.pdf");
		expect(html).not.toContain(`/files/${f.id}/download`);
		expect(html).not.toContain(`/parts/${clip}/files"`);
		expect(html).toContain("Files are not set up");
		expect((await upload(`/parts/${clip}/files`, PDF, "x.pdf", {}, none)).headers.get("Location")).toBe(
			`/parts/${clip}?err=files_disabled#files`,
		);
		expect((await request(`/files/${f.id}/download`, {}, none)).status).toBe(404);
		expect((await postForm(`/files/${f.id}/remove`, {}, none)).headers.get("Location")).toContain("files_disabled");
	});

	it("says when a file's object is missing from storage", async () => {
		const clip = await partId("LAMP-CLIP");
		await upload(`/parts/${clip}/files`, PDF, "guide.pdf", {}, NOT_ADMIN);
		const f = await lastFile();
		await env.IMAGES.delete(f.object_key);
		const res = await request(`/files/${f.id}/download`);
		expect(res.status).toBe(404);
		expect(await res.text()).toContain("This file is missing from storage.");
	});

	it("keeps file rows in the backup", async () => {
		const clip = await partId("LAMP-CLIP");
		await upload(`/parts/${clip}/files`, PDF, "guide.pdf", {}, NOT_ADMIN);
		await setRole("admin");
		const backup = JSON.parse(await (await request("/import/backup.json")).text()) as {
			tables: Record<string, unknown[]>;
		};
		expect(backup.tables.files).toEqual([expect.objectContaining({ name: "guide.pdf", part_id: clip })]);
	});

	it("deletes a part's file rows with it, and its undo brings them back", async () => {
		await setRole("admin");
		const spare = await insertPart("SPARE-BRACKET", "buy");
		await upload(`/parts/${spare}/files`, STEP, "bracket.step");
		const f = await lastFile();
		expect((await postForm(`/parts/${spare}/delete`, {})).headers.get("Location")).toBe("/parts?ok=deleted");
		expect(await fileRows()).toEqual([]);
		expect(await env.IMAGES.head(f.object_key)).not.toBeNull();
		expect((await postForm(`/history/${await lastSet()}/revert`, {})).status).toBe(303);
		expect(await lastFile()).toEqual(f);
	});
});

describe("files on assembly revisions", () => {
	beforeEach(async () => {
		await loadDemo();
		await setRole("planner");
	});

	it("are copied by reference into a new revision and a new variant, and replaced there only", async () => {
		const rev1 = await assemblyId("LAMP-DESK");
		await upload(`/assemblies/${rev1}/files`, PDF, "assembly guide.pdf", { kind: "instructions" }, NOT_ADMIN);
		const original = await lastFile();
		expect(original).toMatchObject({ assembly_id: rev1, part_id: null, kind: "instructions" });
		const page = await (await request(`/assemblies/${rev1}`, {}, NOT_ADMIN)).text();
		expect(page).toContain(`href="/files/${original.id}/download"`);
		expect(page).toContain(`action="/assemblies/${rev1}/files"`);

		await setRole("admin");
		expect((await postForm(`/assemblies/${rev1}/revision`, {})).status).toBe(303);
		const rev2 = (await one<{ id: number }>("SELECT max(id) AS id FROM assemblies")).id;
		const copy = await lastFile();
		expect(copy).toMatchObject({
			assembly_id: rev2,
			name: original.name,
			kind: original.kind,
			format: original.format,
			size_bytes: original.size_bytes,
			sha256: original.sha256,
			object_key: original.object_key,
			note: original.note,
			uploaded_at: original.uploaded_at,
			uploaded_by: original.uploaded_by,
		});
		expect(copy.id).not.toBe(original.id);

		// A new guide for Rev2: Rev1 keeps its own.
		await setRole("planner");
		await upload(`/files/${copy.id}/replace`, join([PDF, text("% rev 2\n")]), "guide v2.pdf", {}, NOT_ADMIN);
		expect((await one<FileDb>("SELECT * FROM files WHERE id = ?", copy.id)).object_key).not.toBe(original.object_key);
		expect((await one<FileDb>("SELECT * FROM files WHERE id = ?", original.id)).object_key).toBe(original.object_key);

		// "Copy as new variant".
		await setRole("admin");
		const lamp = await partId("LAMP-DESK");
		const variant = await postForm("/assemblies", {
			parent_part_id: String(lamp),
			code: "wall",
			revision: "Rev1",
			notes: "",
			copy_from: String(rev1),
		});
		expect(variant.status).toBe(303);
		const wall = await assemblyId("LAMP-DESK", "wall", "Rev1");
		expect(await rows("SELECT name, object_key FROM files WHERE assembly_id = ?", wall)).toEqual([
			{ name: "assembly guide.pdf", object_key: original.object_key },
		]);
	});

	it("leave with an undone revision, and stay on the part they came from", async () => {
		const rev = await assemblyId("LAMP-DESK");
		await upload(`/assemblies/${rev}/files`, PDF, "assembly guide.pdf", {}, NOT_ADMIN);
		await setRole("admin");
		await postForm(`/assemblies/${rev}/revision`, {});
		expect(await fileRows()).toHaveLength(2);
		expect((await postForm(`/history/${await lastSet()}/revert`, {})).status).toBe(303);
		expect((await fileRows()).map((f) => f.assembly_id)).toEqual([rev]);

		// A new assembly of another part, copied from this one: the lines, not this part's files.
		const floor = await insertPart("LAMP-FLOOR", "make");
		const res = await postForm("/assemblies", {
			parent_part_id: String(floor),
			code: "std",
			revision: "Rev1",
			notes: "",
			copy_from: String(rev),
		});
		expect(res.status).toBe(303);
		const copied = await assemblyId("LAMP-FLOOR", "std", "Rev1");
		expect((await one<{ n: number }>("SELECT count(*) AS n FROM assembly_lines WHERE assembly_id = ?", copied)).n).toBe(
			(await one<{ n: number }>("SELECT count(*) AS n FROM assembly_lines WHERE assembly_id = ?", rev)).n,
		);
		expect(await rows("SELECT id FROM files WHERE assembly_id = ?", copied)).toEqual([]);
	});

	it("are not attached when the revision is archived during the upload", async () => {
		const rev = await assemblyId("LAMP-DESK");
		const boundary = "----KittingRace";
		const parts = [
			text(`--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\n\r\n`),
			join([
				text(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="guide.pdf"\r\n\r\n`),
				PDF,
				text(`\r\n--${boundary}--\r\n`),
			]),
		];
		let pulls = 0;
		// The route has checked the revision before it reads the body; it is archived while the file arrives.
		const body = new ReadableStream<Uint8Array>({
			async pull(controller) {
				if (pulls === 1)
					await changeSql("Archive", stmt("UPDATE assemblies SET status = 'archived' WHERE id = ?", rev));
				const next = parts[pulls++];
				if (next) controller.enqueue(next);
				else controller.close();
			},
		});
		const res = await request(
			`/assemblies/${rev}/files`,
			{ method: "POST", body, headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` } },
			NOT_ADMIN,
		);
		expect(res.headers.get("Location")).toBe(`/assemblies/${rev}?err=assembly_archived#files`);
		// The whole body was read: the route's own check passed, the statement's guard refused.
		expect(pulls).toBe(3);
		expect(await fileRows()).toEqual([]);
	});

	it("are read-only on an archived revision", async () => {
		const rev1 = await assemblyId("LAMP-DESK");
		await upload(`/assemblies/${rev1}/files`, PDF, "guide.pdf", {}, NOT_ADMIN);
		const f = await lastFile();
		await setRole("admin");
		await postForm(`/assemblies/${rev1}/archive`, {});
		await setRole("planner");
		expect((await upload(`/assemblies/${rev1}/files`, STEP, "x.step", {}, NOT_ADMIN)).headers.get("Location")).toBe(
			`/assemblies/${rev1}?err=assembly_archived#files`,
		);
		expect((await postForm(`/files/${f.id}/remove`, {}, NOT_ADMIN)).headers.get("Location")).toBe(
			`/assemblies/${rev1}?err=assembly_archived#files`,
		);
		const html = await (await request(`/assemblies/${rev1}`, {}, NOT_ADMIN)).text();
		expect(html).toContain(`href="/files/${f.id}/download"`);
		expect(html).not.toContain(`/files/${f.id}/remove`);
		expect(html).toContain("Files of an archived assembly are read-only.");
		expect(await fileRows()).toHaveLength(1);
	});

	it("are listed on the build page with the part's own files", async () => {
		const lamp = await partId("LAMP-DESK");
		const rev1 = await assemblyId("LAMP-DESK");
		await upload(`/assemblies/${rev1}/files`, PDF, "assembly guide.pdf", {}, NOT_ADMIN);
		const guide = await lastFile();
		await upload(`/parts/${lamp}/files`, DXF, "label.dxf", {}, NOT_ADMIN);
		const label = await lastFile();
		const planned = await postForm(
			"/builds",
			{ part_id: String(lamp), assembly_id: String(rev1), qty: "1", serial: "L-77", planned_for: "", notes: "" },
			NOT_ADMIN,
		);
		const build = await request(planned.headers.get("Location") ?? "");
		const html = await build.text();
		expect(html).toContain(`href="/files/${guide.id}/download"`);
		expect(html).toContain(`href="/files/${label.id}/download"`);
		const { revision } = await one<{ revision: string }>("SELECT revision FROM assemblies WHERE id = ?", rev1);
		expect(html).toContain(`Assembly std ${revision}`);
		expect(html.indexOf("assembly guide.pdf")).toBeLessThan(html.indexOf("label.dxf"));
		// Outside the pick list, which htmx swaps on its own.
		expect(html.indexOf('id="files"')).toBeLessThan(html.indexOf('id="picklist"'));
	});

	it("are listed on a recorded build", async () => {
		const clip = await partId("LAMP-CLIP");
		const plate = await assemblyId("LAMP-CLIP");
		await upload(`/assemblies/${plate}/files`, THREE_MF, "clip plate.3mf", {}, NOT_ADMIN);
		await setRole("operator");
		const res = await postForm(
			"/builds",
			{
				when: "done",
				part_id: String(clip),
				assembly_id: String(plate),
				qty: "1",
				qty_in: "batches",
				serial: "",
				notes: "",
			},
			NOT_ADMIN,
		);
		expect(res.headers.get("Location")).toMatch(/\/builds\/\d+\?ok=recorded$/);
		const html = await (await request(res.headers.get("Location") ?? "", {}, NOT_ADMIN)).text();
		expect(html).toContain("clip plate.3mf");
		expect(html).toContain("Print file");
	});
});

describe("revisions made over MCP", () => {
	beforeEach(async () => {
		await resetKv();
		await loadDemo();
	});

	it("copy the files too: new_assembly_revision, and set_assembly_lines on an active assembly", async () => {
		const active = await assemblyId("ARM-ASSY");
		await changeSql(
			"Attach a file",
			stmt(
				`INSERT INTO files (assembly_id, name, kind, format, size_bytes, sha256, object_key, uploaded_at, uploaded_by,
					created_by, updated_by) VALUES (?, 'arm guide.pdf', 'instructions', 'pdf', 10, 'ab', 'files/arm', '2026-01-01', 'd', 'u', 'u')`,
				active,
			),
		);
		const token = await connect(["catalog:read", "catalog:write"]);
		const tree = await callTool(token, "get_assembly", { assembly: "ARM-ASSY" });
		const lines = (tree.data.lines as { ref: string; per_parent: string }[]).map((l) => ({
			ref: l.ref,
			qty: l.per_parent,
		}));
		expect((await callTool(token, "set_assembly_lines", { assembly: "ARM-ASSY", lines })).isError).toBe(false);
		expect((await callTool(token, "new_assembly_revision", { assembly: active })).isError).toBe(false);
		const copies = await rows<{ revision: string; object_key: string; uploaded_by: string }>(
			`SELECT a.revision, f.object_key, f.uploaded_by FROM files f JOIN assemblies a ON a.id = f.assembly_id
				WHERE a.parent_part_id = ? ORDER BY f.id`,
			await partId("ARM-ASSY"),
		);
		expect(copies).toHaveLength(3);
		expect(new Set(copies.map((c) => c.object_key))).toEqual(new Set(["files/arm"]));
		expect(new Set(copies.map((c) => c.uploaded_by))).toEqual(new Set(["d"]));
		expect(new Set(copies.map((c) => c.revision)).size).toBe(3);

		// set_assembly_production on the active revision makes a draft with the same files.
		const before = (await one<{ n: number }>("SELECT count(*) AS n FROM files")).n;
		expect((await callTool(token, "set_assembly_production", { assembly: "ARM-ASSY", batch_qty: "2" })).isError).toBe(
			false,
		);
		expect((await one<{ n: number }>("SELECT count(*) AS n FROM files")).n).toBe(before + 1);
	});
});
