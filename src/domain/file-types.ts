// Formats of attached files (D162), recognised from their content, never from a name or the browser's claim. The
// upload is streamed (D161), so detection works on the first bytes (head), the last bytes (tail) and the size.
// Anything not recognised is refused: SVG, HTML, scripts and unknown binaries never reach the bucket.
import type { FileFormat, FileKind } from "../db/schema";
import { sniffImage } from "./images";

/** Bytes kept from the start and from the end of an upload for detection. */
export const HEAD_BYTES = 64 * 1024;
export const TAIL_BYTES = 66 * 1024;

export const FORMAT_INFO: Record<FileFormat, { contentType: string; ext: string; exts: string[]; inline: boolean }> = {
	step: { contentType: "model/step", ext: "step", exts: ["step", "stp"], inline: false },
	"3mf": { contentType: "model/3mf", ext: "3mf", exts: ["3mf"], inline: false },
	stl: { contentType: "model/stl", ext: "stl", exts: ["stl"], inline: false },
	pdf: { contentType: "application/pdf", ext: "pdf", exts: ["pdf"], inline: true },
	dxf: { contentType: "image/vnd.dxf", ext: "dxf", exts: ["dxf"], inline: false },
	jpeg: { contentType: "image/jpeg", ext: "jpg", exts: ["jpg", "jpeg"], inline: true },
	png: { contentType: "image/png", ext: "png", exts: ["png"], inline: true },
	webp: { contentType: "image/webp", ext: "webp", exts: ["webp"], inline: true },
};

/** The kind an upload gets when the form leaves it on "Automatic" (D159). */
export const DEFAULT_KIND: Record<FileFormat, FileKind> = {
	step: "cad",
	"3mf": "print",
	stl: "print",
	pdf: "drawing",
	dxf: "drawing",
	jpeg: "other",
	png: "other",
	webp: "other",
};

const latin1 = new TextDecoder("latin1");

function startsWith(bytes: Uint8Array, text: string, at = 0): boolean {
	if (bytes.length < at + text.length) return false;
	for (let i = 0; i < text.length; i++) if (bytes[at + i] !== text.charCodeAt(i)) return false;
	return true;
}

/** Index of the first byte that is not a UTF-8 BOM or ASCII whitespace. */
function skipBlank(bytes: Uint8Array): number {
	let i = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
	while (i < bytes.length && (bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x0a || bytes[i] === 0x0d)) i++;
	return i;
}

function isPdf(head: Uint8Array): boolean {
	// The header may follow a few junk bytes; readers accept it within the first 1024.
	return latin1.decode(head.subarray(0, 1024)).includes("%PDF-");
}

function isStep(head: Uint8Array): boolean {
	return startsWith(head, "ISO-10303-21;", skipBlank(head));
}

const byte = (b: Uint8Array, at: number) => b[at] ?? 0;
const u16 = (b: Uint8Array, at: number) => byte(b, at) | (byte(b, at + 1) << 8);
const u32 = (b: Uint8Array, at: number) =>
	(byte(b, at) | (byte(b, at + 1) << 8) | (byte(b, at + 2) << 16) | (byte(b, at + 3) << 24)) >>> 0;
const u64 = (b: Uint8Array, at: number) => u32(b, at) + u32(b, at + 4) * 2 ** 32;

/** Names in a ZIP's central directory, when the directory lies within the tail; null when it cannot be read. */
export function zipEntryNames(tail: Uint8Array, size: number): string[] | null {
	const tailStart = size - tail.length;
	// End of central directory: 22 bytes plus a comment of at most 65535 bytes, searched backwards.
	let eocd = -1;
	for (let i = tail.length - 22; i >= Math.max(0, tail.length - 22 - 65535); i--) {
		if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) return null;
	let count = u16(tail, eocd + 10);
	let cdSize = u32(tail, eocd + 12);
	let cdOffset = u32(tail, eocd + 16);
	if (cdOffset === 0xffffffff || cdSize === 0xffffffff || count === 0xffff) {
		// ZIP64: the locator (20 bytes) just before the record points at the ZIP64 end of central directory.
		const locator = eocd - 20;
		if (locator < 0 || !startsWith(tail, "PK\x06\x07", locator)) return null;
		const record = u64(tail, locator + 8) - tailStart;
		if (record < 0 || record + 56 > tail.length || !startsWith(tail, "PK\x06\x06", record)) return null;
		count = u64(tail, record + 32);
		cdSize = u64(tail, record + 40);
		cdOffset = u64(tail, record + 48);
	}
	let at = cdOffset - tailStart;
	if (at < 0 || at + cdSize > tail.length) return null;
	const names: string[] = [];
	for (let n = 0; n < count; n++) {
		if (at + 46 > tail.length || !startsWith(tail, "PK\x01\x02", at)) return null;
		const nameLength = u16(tail, at + 28);
		const extra = u16(tail, at + 30);
		const comment = u16(tail, at + 32);
		if (at + 46 + nameLength > tail.length) return null;
		names.push(new TextDecoder().decode(tail.subarray(at + 46, at + 46 + nameLength)));
		at += 46 + nameLength + extra + comment;
	}
	return names;
}

function is3mf(head: Uint8Array, tail: Uint8Array, size: number): boolean {
	if (!startsWith(head, "PK\x03\x04")) return false;
	const names = zipEntryNames(tail, size);
	return names?.some((n) => n.replace(/^\//, "").toLowerCase() === "3d/3dmodel.model") ?? false;
}

function isBinaryStl(head: Uint8Array, size: number): boolean {
	return size >= 84 && head.length >= 84 && 84 + 50 * u32(head, 80) === size;
}

function isAsciiStl(head: Uint8Array): boolean {
	const start = skipBlank(head);
	if (!/^solid[ \t\r\n]/.test(latin1.decode(head.subarray(start, start + 6)))) return false;
	if (head.includes(0)) return false;
	const text = latin1.decode(head);
	return /\bfacet\b/.test(text) || /\bendsolid\b/.test(text);
}

function isDxf(head: Uint8Array): boolean {
	if (startsWith(head, "AutoCAD Binary DXF\r\n\x1a\x00")) return true;
	if (head.includes(0)) return false;
	// Group code / value pairs, one per line: optional 999 comments, then 0 / SECTION.
	const lines = latin1.decode(head.subarray(0, 4096)).split(/\r?\n/);
	let i = 0;
	while (lines[i]?.trim() === "999") i += 2;
	return lines[i]?.trim() === "0" && lines[i + 1]?.trim() === "SECTION";
}

/**
 * The format of an upload, from its first bytes (`head`, at least the first HEAD_BYTES or the whole file), its last
 * bytes (`tail`, at most TAIL_BYTES) and its size; null when it is none of the accepted formats.
 */
export function detectFormat(head: Uint8Array, tail: Uint8Array, size: number): FileFormat | null {
	if (size === 0) return null;
	const image = sniffImage(head);
	if (image) return image.ext === "jpg" ? "jpeg" : image.ext;
	if (isStep(head)) return "step";
	if (is3mf(head, tail, size)) return "3mf";
	// Binary first: some exporters write "solid" at the start of a binary header.
	if (isBinaryStl(head, size) || isAsciiStl(head)) return "stl";
	if (isDxf(head)) return "dxf";
	// Last: its marker may follow a few bytes, so a text format quoting "%PDF-" near its start stays what it is.
	if (isPdf(head)) return "pdf";
	return null;
}

/** The download name: the file's name, plus the format's extension when it has none of the format's. */
export function downloadName(name: string, format: FileFormat): string {
	const info = FORMAT_INFO[format];
	const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
	return info.exts.includes(ext) ? name : `${name}.${info.ext}`;
}
