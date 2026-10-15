// A streaming reader of multipart/form-data bodies (D161). `request.formData()` holds the whole body in memory, and a
// Worker isolate has 128 MB for every request it serves, so file uploads of up to 100 MB are read part by part
// instead: text fields as small strings, a file as chunks handed on as they arrive. No dependency.

export class MultipartError extends Error {
	constructor(readonly code: "too_large" | "malformed") {
		super(`multipart: ${code}`);
	}
}

export type PartHeaders = {
	/** The form field's name. */
	name: string;
	/** The file's name as the browser sent it (path removed); null for a text field, "" when no file was chosen. */
	filename: string | null;
	contentType: string;
};

export type MultipartLimits = {
	/** The whole body, every part included: past this the reader throws `too_large`. */
	maxBytes: number;
	maxHeaderBytes?: number;
	maxParts?: number;
};

/** The boundary of a `multipart/form-data` Content-Type, or null (RFC 2046: 1 to 70 characters). */
export function boundaryOf(contentType: string | undefined | null): string | null {
	if (!contentType || !/^multipart\/form-data\s*;/i.test(contentType)) return null;
	const match = /;\s*boundary\s*=\s*(?:"([^"]{1,70})"|([^\s;]{1,70}))/i.exec(contentType);
	return match ? (match[1] ?? match[2] ?? null) : null;
}

const encoder = new TextEncoder();
const utf8 = new TextDecoder();

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
	if (a.length === 0) return b;
	const out = new Uint8Array(a.length + b.length);
	out.set(a);
	out.set(b, a.length);
	return out;
}

/** Browsers escape `"`, CR and LF in names as %22, %0D, %0A (HTML's form encoding); older ones used `\"`. */
const unescapeName = (value: string) =>
	value
		.replace(/\\(["\\])/g, "$1")
		.replace(/%22/g, '"')
		.replace(/%0D/gi, "\r")
		.replace(/%0A/gi, "\n");

function parseHeaders(block: string): PartHeaders {
	let disposition = "";
	let contentType = "text/plain";
	for (const line of block.split("\r\n")) {
		const colon = line.indexOf(":");
		if (colon < 0) continue;
		const key = line.slice(0, colon).trim().toLowerCase();
		const value = line.slice(colon + 1).trim();
		if (key === "content-disposition") disposition = value;
		else if (key === "content-type") contentType = value;
	}
	if (!/^form-data\s*(;|$)/i.test(disposition)) throw new MultipartError("malformed");
	const params = new Map<string, string>();
	for (const m of disposition.matchAll(/;\s*([^=;\s]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]*))/g)) {
		params.set((m[1] ?? "").toLowerCase(), m[2] !== undefined ? unescapeName(m[2]) : (m[3] ?? "").trim());
	}
	const name = params.get("name");
	if (name === undefined) throw new MultipartError("malformed");
	let filename = params.get("filename") ?? null;
	const extended = params.get("filename*");
	if (extended !== undefined) {
		// RFC 5987: charset'language'percent-encoded
		const encoded = /^utf-8'[^']*'(.*)$/i.exec(extended)?.[1];
		if (encoded !== undefined) {
			try {
				filename = decodeURIComponent(encoded);
			} catch {
				throw new MultipartError("malformed");
			}
		}
	}
	// A browser on Windows may send a full path.
	if (filename !== null) filename = filename.slice(Math.max(filename.lastIndexOf("/"), filename.lastIndexOf("\\")) + 1);
	return { name, filename, contentType };
}

/**
 * Reads a multipart body part by part. `next()` moves to the next part (skipping what was not read of the current
 * one) and returns its headers, or null after the last; `text()` reads the current part as a string; `body()` yields
 * it as chunks, without holding more than one chunk plus the length of the delimiter.
 */
export class MultipartReader {
	private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
	private readonly delimiter: Uint8Array;
	private readonly limits: Required<MultipartLimits>;
	// Bytes read and not yet consumed. The body is read as if it began with CRLF, so the first boundary is a
	// delimiter like the others and anything before it (the preamble) is skipped.
	private buf: Uint8Array = encoder.encode("\r\n");
	private ended = false;
	private total = 0;
	private parts = 0;
	private state: "preamble" | "body" | "boundary" | "end" = "preamble";

	constructor(stream: ReadableStream<Uint8Array>, boundary: string, limits: MultipartLimits) {
		this.reader = stream.getReader();
		this.delimiter = encoder.encode(`\r\n--${boundary}`);
		this.limits = { maxHeaderBytes: 8 * 1024, maxParts: 20, ...limits };
	}

	/** Reads one more chunk; false at the end of the stream. */
	private async fill(): Promise<boolean> {
		if (this.ended) return false;
		const { value, done } = await this.reader.read();
		if (done) {
			this.ended = true;
			return false;
		}
		this.total += value.length;
		if (this.total > this.limits.maxBytes) {
			await this.reader.cancel().catch(() => {});
			throw new MultipartError("too_large");
		}
		this.buf = concat(this.buf, value);
		return true;
	}

	/** Position of the delimiter in the buffer, or -1. */
	private findDelimiter(): number {
		const d = this.delimiter;
		const last = this.buf.length - d.length;
		for (let i = this.buf.indexOf(0x0d); i >= 0 && i <= last; i = this.buf.indexOf(0x0d, i + 1)) {
			let k = 1;
			while (k < d.length && this.buf[i + k] === d[k]) k++;
			if (k === d.length) return i;
		}
		return -1;
	}

	/** Yields the current part's bytes up to the next delimiter, then stands just after it. */
	private async *untilDelimiter(): AsyncGenerator<Uint8Array> {
		const keep = this.delimiter.length - 1;
		for (;;) {
			const at = this.findDelimiter();
			if (at >= 0) {
				const chunk = this.buf.subarray(0, at);
				this.buf = this.buf.subarray(at + this.delimiter.length);
				this.state = "boundary";
				if (chunk.length) yield chunk;
				return;
			}
			// The end of the buffer may be the start of a delimiter: keep it for the next round.
			if (this.buf.length > keep) {
				const chunk = this.buf.subarray(0, this.buf.length - keep);
				this.buf = this.buf.subarray(this.buf.length - keep);
				yield chunk;
			}
			if (!(await this.fill())) throw new MultipartError("malformed");
		}
	}

	/** Moves to the next part and returns its headers; null when the body is over. */
	async next(): Promise<PartHeaders | null> {
		if (this.state === "end") return null;
		if (this.state === "preamble" || this.state === "body") {
			for await (const _skipped of this.untilDelimiter()) {
				// The preamble, or what the caller did not read of the previous part.
			}
		}
		// After a delimiter: "--" closes the body, CRLF (after optional padding) opens a part.
		for (;;) {
			const text = utf8.decode(this.buf.subarray(0, 74));
			if (text.startsWith("--")) {
				this.state = "end";
				await this.reader.cancel().catch(() => {});
				return null;
			}
			const crlf = /^[ \t]*\r\n/.exec(text);
			if (crlf) {
				this.buf = this.buf.subarray(crlf[0].length);
				break;
			}
			if (this.buf.length >= 72 || !(await this.fill())) throw new MultipartError("malformed");
		}
		if (++this.parts > this.limits.maxParts) throw new MultipartError("malformed");
		for (;;) {
			const end = indexOfBytes(this.buf, HEADER_END);
			if (end > this.limits.maxHeaderBytes) throw new MultipartError("malformed");
			if (end >= 0) {
				const headers = parseHeaders(utf8.decode(this.buf.subarray(0, end)));
				this.buf = this.buf.subarray(end + HEADER_END.length);
				this.state = "body";
				return headers;
			}
			if (this.buf.length > this.limits.maxHeaderBytes || !(await this.fill())) throw new MultipartError("malformed");
		}
	}

	/** The current part's bytes, as they arrive. */
	body(): AsyncGenerator<Uint8Array> {
		if (this.state !== "body") throw new Error("no part to read");
		return this.untilDelimiter();
	}

	/** The current part as text (UTF-8), refused past `max` bytes (no form of the app sends a longer field). */
	async text(max: number): Promise<string> {
		let out: Uint8Array = new Uint8Array(0);
		for await (const chunk of this.body()) {
			if (out.length + chunk.length > max) throw new MultipartError("malformed");
			out = concat(out, chunk);
		}
		return utf8.decode(out);
	}
}

const HEADER_END = encoder.encode("\r\n\r\n");

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
	for (let i = haystack.indexOf(needle[0] ?? 0); i >= 0; i = haystack.indexOf(needle[0] ?? 0, i + 1)) {
		if (i + needle.length > haystack.length) return -1;
		let k = 1;
		while (k < needle.length && haystack[i + k] === needle[k]) k++;
		if (k === needle.length) return i;
	}
	return -1;
}
