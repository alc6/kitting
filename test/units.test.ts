import { describe, expect, it } from "vitest";
import {
	ceilDiv,
	formatCents,
	formatMoney,
	formatQty,
	lineCostCents,
	mulMilli,
	parseBool,
	parseCents,
	parseMilli,
	roundDiv,
	roundOrderQty,
} from "../src/lib/units";

describe("parseMilli / parseCents", () => {
	it("parses both decimal separators without floats", () => {
		expect(parseMilli("1.5")).toBe(1500);
		expect(parseMilli("1,5")).toBe(1500);
		expect(parseMilli("0.001")).toBe(1);
		expect(parseMilli("12")).toBe(12000);
		expect(parseMilli(",5")).toBe(500);
		expect(parseMilli("-2.25")).toBe(-2250);
		expect(parseMilli("1 234,5")).toBe(1234500);
		expect(parseMilli("1\u202f234,5")).toBe(1234500);
		expect(parseCents("0.1")).toBe(10);
		expect(parseCents("12,34")).toBe(1234);
		expect(parseCents("0.30")).toBe(30);
	});

	it("rejects garbage and excess precision", () => {
		expect(parseMilli("")).toBeNull();
		expect(parseMilli("abc")).toBeNull();
		expect(parseMilli("1.2.3")).toBeNull();
		expect(parseMilli("1.0005")).toBeNull();
		expect(parseMilli("1.5000")).toBe(1500);
		expect(parseCents("1.234")).toBeNull();
		expect(parseMilli("1e3")).toBeNull();
		expect(parseMilli("99999999999999999999")).toBeNull();
	});
});

describe("formatting", () => {
	it("formats quantities, trimming zeros", () => {
		expect(formatQty(1500)).toBe("1.5");
		expect(formatQty(1500, "fr")).toBe("1,5");
		expect(formatQty(2000)).toBe("2");
		expect(formatQty(125)).toBe("0.125");
		expect(formatQty(-250)).toBe("-0.25");
		expect(formatQty(1234567000)).toBe("1,234,567");
		expect(formatQty(1234567000, "fr")).toBe("1\u202f234\u202f567");
	});

	it("formats money with two decimals", () => {
		expect(formatCents(5)).toBe("0.05");
		expect(formatCents(123456)).toBe("1,234.56");
		expect(formatCents(123456, "fr")).toBe("1\u202f234,56");
		expect(formatMoney(1050, "en", "EUR")).toBe("€10.50");
		expect(formatMoney(1050, "fr", "EUR")).toBe("10,50\u00a0€");
		expect(formatMoney(-1050, "en", "USD")).toBe("-$10.50");
	});
});

describe("integer arithmetic", () => {
	it("rounds half away from zero", () => {
		expect(roundDiv(1500, 1000)).toBe(2);
		expect(roundDiv(1499, 1000)).toBe(1);
		expect(roundDiv(-1500, 1000)).toBe(-2);
		expect(roundDiv(-1499, 1000)).toBe(-1);
	});

	it("computes line costs in cents", () => {
		expect(lineCostCents(1500, 123)).toBe(185); // 1.5 x 1.23 = 1.845
		expect(lineCostCents(250, 45)).toBe(11); // 0.25 x 0.45 = 0.1125
		expect(lineCostCents(3000, 1000)).toBe(3000);
	});

	it("scales quantities rounding up", () => {
		expect(mulMilli(3000, 2000)).toBe(6000);
		expect(mulMilli(333, 3000)).toBe(999);
		expect(mulMilli(1, 1500)).toBe(2); // 0.0015 -> 0.002
		expect(ceilDiv(7, 2)).toBe(4);
		expect(ceilDiv(-7, 2)).toBe(-3);
	});

	it("rounds orders to MOQ and pack size", () => {
		expect(roundOrderQty(0, 100_000, 0)).toBe(0);
		expect(roundOrderQty(-5000, 100_000, 0)).toBe(0);
		expect(roundOrderQty(30_000, 100_000, 0)).toBe(100_000);
		expect(roundOrderQty(130_000, 100_000, 50_000)).toBe(150_000);
		expect(roundOrderQty(7_000, 0, 5_000)).toBe(10_000);
		expect(roundOrderQty(2_500, 0, 0)).toBe(2_500);
	});
});

describe("parseBool", () => {
	it("accepts English and French spellings", () => {
		for (const v of ["yes", "Y", "true", "1", "oui", "x", "on"]) expect(parseBool(v)).toBe(true);
		for (const v of ["no", "", "false", "0", "non"]) expect(parseBool(v)).toBe(false);
		expect(parseBool("maybe")).toBeNull();
	});
});
