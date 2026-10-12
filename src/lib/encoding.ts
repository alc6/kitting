// Spreadsheet apps (notably Excel on Windows, French locale) often save CSV as
// Windows-1252 instead of UTF-8. Decode as UTF-8 when valid, else as Windows-1252.

const CP1252_HIGH = [
	0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8d, 0x017d,
	0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x9d,
	0x017e, 0x0178,
];

export function decodeText(bytes: Uint8Array): string {
	try {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
	} catch {
		let out = "";
		for (const b of bytes) out += String.fromCharCode(b >= 0x80 && b <= 0x9f ? (CP1252_HIGH[b - 0x80] ?? b) : b);
		return out;
	}
}
