import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import app from "../src/index";

export const ORIGIN = "https://kitting.example.com";
export const TESTER = "tester@example.com";

const TABLES = [
	"build_lines",
	"builds",
	"po_lines",
	"purchase_orders",
	"stock_moves",
	"bom_lines",
	"boms",
	"parts",
	"suppliers",
];

export async function resetDb(): Promise<void> {
	await env.DB.batch(TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
}

export type EnvOverrides = Partial<Record<keyof Env, unknown>>;

/** Calls the app directly. Non-GET requests get a same-origin Origin header unless one is given. */
export async function request(path: string, init: RequestInit = {}, overrides: EnvOverrides = {}): Promise<Response> {
	const headers = new Headers(init.headers);
	const method = (init.method ?? "GET").toUpperCase();
	if (method !== "GET" && method !== "HEAD" && !headers.has("Origin")) headers.set("Origin", ORIGIN);
	const req = new Request(`${ORIGIN}${path}`, { ...init, headers, redirect: "manual" });
	return app.fetch(req, { ...env, ...overrides } as Env, createExecutionContext());
}

export function postForm(
	path: string,
	data: Record<string, string>,
	overrides: EnvOverrides = {},
	headers: Record<string, string> = {},
): Promise<Response> {
	return request(path, { method: "POST", body: new URLSearchParams(data), headers }, overrides);
}

/** Runs a query and returns all rows. */
export async function rows<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]> {
	const res = await env.DB.prepare(sql)
		.bind(...params)
		.all<T>();
	return res.results;
}

export async function one<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T> {
	const r = await rows<T>(sql, ...params);
	if (!r[0]) throw new Error(`No row for: ${sql}`);
	return r[0];
}

export async function insertSupplier(name: string): Promise<number> {
	const r = await env.DB.prepare(
		"INSERT INTO suppliers (name, created_by, updated_by) VALUES (?, 'seed', 'seed') RETURNING id",
	)
		.bind(name)
		.first<{ id: number }>();
	return r!.id;
}

export async function insertPart(
	ref: string,
	kind: "buy" | "make" | "kit" | "fee" = "buy",
	opts: {
		costCents?: number | null;
		supplierId?: number | null;
		trackSerial?: boolean;
		moqMilli?: number;
		packSizeMilli?: number;
		unit?: string;
	} = {},
): Promise<number> {
	const r = await env.DB.prepare(
		`INSERT INTO parts (ref, name, kind, unit, cost_cents, supplier_id, track_serial, moq_milli, pack_size_milli, created_by, updated_by)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'seed', 'seed') RETURNING id`,
	)
		.bind(
			ref,
			`Part ${ref}`,
			kind,
			opts.unit ?? "pcs",
			opts.costCents === undefined ? null : opts.costCents,
			opts.supplierId ?? null,
			opts.trackSerial ? 1 : 0,
			opts.moqMilli ?? 0,
			opts.packSizeMilli ?? 0,
		)
		.first<{ id: number }>();
	return r!.id;
}

export async function insertMove(partId: number, qtyMilli: number, reason = "adjust", serial: string | null = null) {
	await env.DB.prepare(
		"INSERT INTO stock_moves (part_id, qty_milli, reason, serial, by, created_by, updated_by) VALUES (?, ?, ?, ?, 'seed', 'seed', 'seed')",
	)
		.bind(partId, qtyMilli, reason, serial)
		.run();
}
