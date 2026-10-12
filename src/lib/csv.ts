// Minimal RFC 4180 CSV reader/writer. Accepts "," ";" or tab delimiters (French Excel
// exports use ";"), quoted fields with embedded delimiters/newlines, CRLF and a UTF-8 BOM.

export type CsvRecord = { line: number; values: Record<string, string> };
export type CsvTable = { delimiter: string; header: string[]; records: CsvRecord[] };

export function detectDelimiter(text: string): string {
	const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
	let best = ",";
	let bestCount = 0;
	for (const d of [",", ";", "\t"]) {
		let count = 0;
		let quoted = false;
		for (const ch of firstLine) {
			if (ch === '"') quoted = !quoted;
			else if (ch === d && !quoted) count++;
		}
		if (count > bestCount) {
			best = d;
			bestCount = count;
		}
	}
	return best;
}

/** Splits CSV text into rows of raw fields, each with the 1-based line where it starts. */
export function parseRows(text: string, delimiter: string): { line: number; fields: string[] }[] {
	const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
	const rows: { line: number; fields: string[] }[] = [];
	let fields: string[] = [];
	let field = "";
	let quoted = false;
	let line = 1;
	let rowLine = 1;
	let i = 0;
	const endRow = () => {
		fields.push(field);
		rows.push({ line: rowLine, fields });
		fields = [];
		field = "";
	};
	while (i < src.length) {
		const ch = src[i] as string;
		if (quoted) {
			if (ch === '"') {
				if (src[i + 1] === '"') {
					field += '"';
					i += 2;
					continue;
				}
				quoted = false;
				i++;
				continue;
			}
			if (ch === "\n") line++;
			field += ch;
			i++;
			continue;
		}
		if (ch === '"' && field === "") {
			quoted = true;
			i++;
		} else if (ch === delimiter) {
			fields.push(field);
			field = "";
			i++;
		} else if (ch === "\r" || ch === "\n") {
			endRow();
			if (ch === "\r" && src[i + 1] === "\n") i++;
			i++;
			line++;
			rowLine = line;
		} else {
			field += ch;
			i++;
		}
	}
	if (field !== "" || fields.length > 0) endRow();
	return rows.filter((r) => r.fields.some((f) => f.trim() !== ""));
}

export function normalizeHeader(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/[\s-]+/g, "_");
}

/** Parses CSV text with a header row. Header names are trimmed and lower-cased. */
export function parseCsv(text: string): CsvTable {
	const delimiter = detectDelimiter(text);
	const rows = parseRows(text, delimiter);
	const head = rows.shift();
	const header = head ? head.fields.map(normalizeHeader) : [];
	const records = rows.map((r) => {
		const values: Record<string, string> = {};
		header.forEach((h, idx) => {
			if (h) values[h] = (r.fields[idx] ?? "").trim();
		});
		return { line: r.line, values };
	});
	return { delimiter, header, records };
}

/** Prevents spreadsheet formula injection for text cells, keeping negative numbers intact. */
function neutralize(value: string): string {
	if (/^[=+@\t\r]/.test(value) || /^-[^0-9.,]/.test(value)) return `'${value}`;
	return value;
}

export function toCsv(rows: (string | number | null | undefined)[][], delimiter = ","): string {
	const out = rows.map((row) =>
		row
			.map((cell) => {
				const s = cell === null || cell === undefined ? "" : neutralize(String(cell));
				return /["\r\n]/.test(s) || s.includes(delimiter) ? `"${s.replace(/"/g, '""')}"` : s;
			})
			.join(delimiter),
	);
	return `\uFEFF${out.join("\r\n")}\r\n`;
}
