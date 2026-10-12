import { describe, expect, it } from "vitest";
import { detectDelimiter, parseCsv, parseRows, toCsv } from "../src/lib/csv";
import { decodeText } from "../src/lib/encoding";

describe("parseCsv", () => {
	it("parses a simple comma file with a BOM and CRLF", () => {
		const t = parseCsv("\uFEFFRef,Name , Qty\r\nA,Alpha,1\r\nB,Beta,2\r\n");
		expect(t.header).toEqual(["ref", "name", "qty"]);
		expect(t.records).toEqual([
			{ line: 2, values: { ref: "A", name: "Alpha", qty: "1" } },
			{ line: 3, values: { ref: "B", name: "Beta", qty: "2" } },
		]);
	});

	it("detects semicolons and keeps decimal commas intact", () => {
		const t = parseCsv("ref;qty\nA;1,5\n");
		expect(t.delimiter).toBe(";");
		expect(t.records[0]?.values.qty).toBe("1,5");
	});

	it("handles quotes, escaped quotes and newlines inside fields", () => {
		const rows = parseRows('a,"b, c","say ""hi"""\n"multi\nline",x,y\n', ",");
		expect(rows).toEqual([
			{ line: 1, fields: ["a", "b, c", 'say "hi"'] },
			{ line: 2, fields: ["multi\nline", "x", "y"] },
		]);
	});

	it("skips blank lines and reports physical line numbers", () => {
		const t = parseCsv("ref\n\nA\n,\nB");
		expect(t.records.map((r) => [r.line, r.values.ref])).toEqual([
			[3, "A"],
			[5, "B"],
		]);
	});

	it("detects tabs", () => {
		expect(detectDelimiter("a\tb\tc\n")).toBe("\t");
	});
});

describe("toCsv", () => {
	it("quotes when needed and neutralises formulas", () => {
		const out = toCsv([
			["ref", "note"],
			["A", 'has "quotes", commas'],
			["B", "=HYPERLINK(1)"],
			["C", "-5"],
			["D", "-x"],
		]);
		expect(out).toBe('\uFEFFref,note\r\nA,"has ""quotes"", commas"\r\nB,\'=HYPERLINK(1)\r\nC,-5\r\nD,\'-x\r\n');
	});

	it("round-trips through the parser with semicolons", () => {
		const out = toCsv(
			[
				["ref", "qty"],
				["A;1", "1,5"],
			],
			";",
		);
		const t = parseCsv(out);
		expect(t.records[0]?.values).toEqual({ ref: "A;1", qty: "1,5" });
	});
});

describe("decodeText", () => {
	it("decodes UTF-8 and falls back to Windows-1252", () => {
		expect(decodeText(new TextEncoder().encode("Désignation"))).toBe("Désignation");
		// "Désignation €" in Windows-1252
		const cp1252 = new Uint8Array([0x44, 0xe9, 0x73, 0x69, 0x67, 0x6e, 0x61, 0x74, 0x69, 0x6f, 0x6e, 0x20, 0x80]);
		expect(decodeText(cp1252)).toBe("Désignation €");
	});
});
