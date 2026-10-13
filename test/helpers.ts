import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import demoBoms from "../examples/demo/boms.csv?raw";
import demoOffers from "../examples/demo/part_suppliers.csv?raw";
import demoParts from "../examples/demo/parts.csv?raw";
import demoStock from "../examples/demo/stock.csv?raw";
import demoSuppliers from "../examples/demo/suppliers.csv?raw";
import type { Role } from "../src/db/schema";
import * as schema from "../src/db/schema";
import { planImport } from "../src/domain/import";
import app from "../src/index";
import { runBatch } from "../src/lib/db";
import type { Db } from "../src/types";

export const ORIGIN = "https://kitting.example.com";
export const TESTER = "tester@example.com";

const TABLES = [
	"users",
	"settings",
	"build_lines",
	"builds",
	"po_lines",
	"purchase_orders",
	"stock_moves",
	"price_history",
	"part_suppliers",
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

/**
 * Inserts a part. Ordering terms (MOQ, pack size, offer price) belong to a supplier's offer: with any of
 * them and no `supplierId`, a supplier "Supplier of <ref>" is created as the preferred supplier.
 */
export async function insertPart(
	ref: string,
	kind: "buy" | "make" | "kit" | "fee" = "buy",
	opts: {
		costCents?: number | null;
		supplierId?: number | null;
		trackSerial?: boolean;
		moqMilli?: number;
		packSizeMilli?: number;
		offerPriceCents?: number | null;
		unit?: string;
	} = {},
): Promise<number> {
	const needsOffer = opts.moqMilli !== undefined || opts.packSizeMilli !== undefined || opts.offerPriceCents != null;
	const supplierId = opts.supplierId ?? (needsOffer ? await insertSupplier(`Supplier of ${ref}`) : null);
	const r = await env.DB.prepare(
		`INSERT INTO parts (ref, name, kind, unit, cost_cents, supplier_id, track_serial, created_by, updated_by)
		 VALUES (?, ?, ?, ?, ?, ?, ?, 'seed', 'seed') RETURNING id`,
	)
		.bind(
			ref,
			`Part ${ref}`,
			kind,
			opts.unit ?? "pcs",
			opts.costCents === undefined ? null : opts.costCents,
			supplierId,
			opts.trackSerial ? 1 : 0,
		)
		.first<{ id: number }>();
	if (supplierId !== null) {
		await env.DB.prepare(
			`INSERT INTO part_suppliers (part_id, supplier_id, price_cents, moq_milli, pack_size_milli, created_by, updated_by)
			 VALUES (?, ?, ?, ?, ?, 'seed', 'seed')`,
		)
			.bind(r!.id, supplierId, opts.offerPriceCents ?? null, opts.moqMilli ?? 0, opts.packSizeMilli ?? 0)
			.run();
	}
	return r!.id;
}

/** Lists `email` in the users table with this role (TESTER by default). */
export async function setRole(role: Role, email = TESTER): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO users (email, role, created_by, updated_by) VALUES (?, ?, 'seed', 'seed')
		 ON CONFLICT (email) DO UPDATE SET role = excluded.role`,
	)
		.bind(email, role)
		.run();
}

/** Env override under which TESTER is not in ADMIN_EMAILS: their role then comes from the users table. */
export const NOT_ADMIN = { ADMIN_EMAILS: "someone-else@example.com" };

/** Lets viewers and operators see costs (the admin option on the users page). */
export async function letLowerRolesSeeCosts(): Promise<void> {
	await env.DB.prepare(
		"INSERT INTO settings (key, value, created_by, updated_by) VALUES ('lower_roles_see_costs', '1', 'seed', 'seed')",
	).run();
}

export async function insertMove(partId: number, qtyMilli: number, reason = "adjust", serial: string | null = null) {
	await env.DB.prepare(
		"INSERT INTO stock_moves (part_id, qty_milli, reason, serial, by, created_by, updated_by) VALUES (?, ?, ?, ?, 'seed', 'seed', 'seed')",
	)
		.bind(partId, qtyMilli, reason, serial)
		.run();
}

// ---------------------------------------------------------------------------
// Demo dataset fixture

export const DEMO = {
	suppliers: demoSuppliers,
	parts: demoParts,
	part_suppliers: demoOffers,
	boms: demoBoms,
	stock: demoStock,
};

export function testDb(): Db {
	return drizzle(env.DB, { schema });
}

/** Imports CSV text through the real importer; throws on validation errors. */
export async function importCsv(
	type: "suppliers" | "parts" | "part_suppliers" | "boms" | "stock",
	csv: string,
): Promise<void> {
	const db = testDb();
	const plan = await planImport({ db, locale: "en" }, type, csv);
	if (!plan) throw new Error(`no importer ${type}`);
	if (plan.errors.length) throw new Error(`${type} import errors: ${JSON.stringify(plan.errors)}`);
	await runBatch(db, plan.statements("seed@example.com", new Date().toISOString()));
}

/** Loads the fictional demo dataset. Pass `stock: false` to skip initial stock. */
export async function loadDemo(opts: { stock?: boolean } = {}): Promise<void> {
	await importCsv("suppliers", DEMO.suppliers);
	await importCsv("parts", DEMO.parts);
	await importCsv("part_suppliers", DEMO.part_suppliers);
	await importCsv("boms", DEMO.boms);
	if (opts.stock !== false) await importCsv("stock", DEMO.stock);
}

export async function partId(ref: string): Promise<number> {
	return (await one<{ id: number }>("SELECT id FROM parts WHERE ref = ?", ref)).id;
}

export async function bomId(parentRef: string, code = "std", revision?: string): Promise<number> {
	const row = await one<{ id: number }>(
		`SELECT b.id FROM boms b JOIN parts p ON p.id = b.parent_part_id
		 WHERE p.ref = ? AND b.code = ? AND (? IS NULL AND b.status = 'active' OR b.revision = ?)`,
		parentRef,
		code,
		revision ?? null,
		revision ?? null,
	);
	return row.id;
}
