import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import demoAssemblies from "../examples/full/assemblies.csv?raw";
import demoMachineTypes from "../examples/full/machine_types.csv?raw";
import demoMachines from "../examples/full/machines.csv?raw";
import demoPartOptions from "../examples/full/part_options.csv?raw";
import demoOffers from "../examples/full/part_suppliers.csv?raw";
import demoParts from "../examples/full/parts.csv?raw";
import demoStock from "../examples/full/stock.csv?raw";
import demoSuppliers from "../examples/full/suppliers.csv?raw";
import type { Role } from "../src/db/schema";
import * as schema from "../src/db/schema";
import { runChangeSet } from "../src/domain/history";
import { type ImportType, planImport } from "../src/domain/import";
import app from "../src/index";
import type { Db } from "../src/types";

export const ORIGIN = "https://kitting.example.com";
export const TESTER = "tester@example.com";

const TABLES = [
	"change_log",
	"change_sets",
	"users",
	"settings",
	"build_lines",
	"build_machine_times",
	"build_option_choices",
	"builds",
	"po_lines",
	"po_shipments",
	"purchase_orders",
	"stock_moves",
	"price_history",
	"files",
	"part_suppliers",
	"assembly_lines",
	"assemblies",
	"machines",
	"machine_rate_history",
	"machine_types",
	"part_option_values",
	"part_options",
	"parts",
	"suppliers",
];

export async function resetDb(): Promise<void> {
	await seedSql(...TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
}

/**
 * Runs SQL fixtures in one batch without recording them in the history (the triggers are suppressed, as during
 * a restore). Returns each statement's result.
 */
export async function seedSql(...stmts: D1PreparedStatement[]): Promise<D1Result[]> {
	const results = await env.DB.batch([
		env.DB.prepare("INSERT INTO change_context (id, suppress) VALUES (1, 1)"),
		...stmts,
		env.DB.prepare("DELETE FROM change_context"),
	]);
	return results.slice(1, 1 + stmts.length);
}

/** Runs SQL statements as one change set by `seed@example.com`, as a page would: they are in the history. */
export async function changeSql(summary: string, ...stmts: D1PreparedStatement[]): Promise<D1Result[]> {
	const results = await env.DB.batch([
		env.DB.prepare("INSERT INTO change_sets (user_email, source, summary) VALUES ('seed@example.com', 'ui', ?)").bind(
			summary,
		),
		env.DB.prepare("INSERT INTO change_context (id, change_set_id) VALUES (1, (SELECT max(id) FROM change_sets))"),
		...stmts,
		env.DB.prepare("DELETE FROM change_context"),
	]);
	return results.slice(2, 2 + stmts.length);
}

/** A prepared statement, for seedSql() and changeSql(). */
export function stmt(sql: string, ...params: unknown[]): D1PreparedStatement {
	return env.DB.prepare(sql).bind(...params);
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

/** The id returned by an INSERT … RETURNING id run with seedSql() or changeSql(). */
export function returnedId(result: D1Result | undefined): number {
	const id = (result?.results[0] as { id?: number } | undefined)?.id;
	if (typeof id !== "number") throw new Error("no id returned");
	return id;
}

export async function insertSupplier(name: string): Promise<number> {
	const [r] = await seedSql(
		stmt("INSERT INTO suppliers (name, created_by, updated_by) VALUES (?, 'seed', 'seed') RETURNING id", name),
	);
	return returnedId(r);
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
		minStockMilli?: number | null;
		unit?: string;
	} = {},
): Promise<number> {
	const needsOffer = opts.moqMilli !== undefined || opts.packSizeMilli !== undefined || opts.offerPriceCents != null;
	const supplierId = opts.supplierId ?? (needsOffer ? await insertSupplier(`Supplier of ${ref}`) : null);
	const [r] = await seedSql(
		stmt(
			`INSERT INTO parts (ref, name, kind, unit, cost_cents, supplier_id, track_serial, min_stock_milli, created_by, updated_by)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'seed', 'seed') RETURNING id`,
			ref,
			`Part ${ref}`,
			kind,
			opts.unit ?? "pcs",
			opts.costCents === undefined ? null : opts.costCents,
			supplierId,
			opts.trackSerial ? 1 : 0,
			opts.minStockMilli ?? null,
		),
	);
	const id = returnedId(r);
	if (supplierId !== null) {
		await seedSql(
			stmt(
				`INSERT INTO part_suppliers (part_id, supplier_id, price_cents, moq_milli, pack_size_milli, created_by, updated_by)
				 VALUES (?, ?, ?, ?, ?, 'seed', 'seed')`,
				id,
				supplierId,
				opts.offerPriceCents ?? null,
				opts.moqMilli ?? 0,
				opts.packSizeMilli ?? 0,
			),
		);
	}
	return id;
}

/** Lists `email` in the users table with this role (TESTER by default). */
export async function setRole(role: Role, email = TESTER): Promise<void> {
	await seedSql(
		stmt(
			`INSERT INTO users (email, role, created_by, updated_by) VALUES (?, ?, 'seed', 'seed')
			 ON CONFLICT (email) DO UPDATE SET role = excluded.role`,
			email,
			role,
		),
	);
}

/** Env override under which TESTER is not in ADMIN_EMAILS: their role then comes from the users table. */
export const NOT_ADMIN = { ADMIN_EMAILS: "someone-else@example.com" };

/** Lets viewers and operators see costs (the admin option on the users page). */
export async function letLowerRolesSeeCosts(): Promise<void> {
	await seedSql(
		stmt(
			"INSERT INTO settings (key, value, created_by, updated_by) VALUES ('lower_roles_see_costs', '1', 'seed', 'seed')",
		),
	);
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
	part_options: demoPartOptions,
	part_suppliers: demoOffers,
	machine_types: demoMachineTypes,
	machines: demoMachines,
	assemblies: demoAssemblies,
	stock: demoStock,
};

export function testDb(): Db {
	return drizzle(env.DB, { schema });
}

/** Imports CSV text through the real importer; throws on validation errors. */
export async function importCsv(type: ImportType, csv: string): Promise<void> {
	const db = testDb();
	const plan = await planImport({ db, locale: "en" }, type, csv);
	if (!plan) throw new Error(`no importer ${type}`);
	if (plan.errors.length) throw new Error(`${type} import errors: ${JSON.stringify(plan.errors)}`);
	await runChangeSet(
		db,
		{
			user: "seed@example.com",
			source: "import",
			summary: `Import ${type}.csv`,
			...(plan.revertible === false ? { revertible: false } : {}),
		},
		plan.statements("seed@example.com", new Date().toISOString()),
	);
}

/** Loads the fictional demo dataset. Pass `stock: false` to skip initial stock. */
export async function loadDemo(opts: { stock?: boolean } = {}): Promise<void> {
	await importCsv("suppliers", DEMO.suppliers);
	await importCsv("parts", DEMO.parts);
	await importCsv("part_options", DEMO.part_options);
	await importCsv("part_suppliers", DEMO.part_suppliers);
	await importCsv("machine_types", DEMO.machine_types);
	await importCsv("machines", DEMO.machines);
	await importCsv("assemblies", DEMO.assemblies);
	if (opts.stock !== false) await importCsv("stock", DEMO.stock);
}

export async function partId(ref: string): Promise<number> {
	return (await one<{ id: number }>("SELECT id FROM parts WHERE ref = ?", ref)).id;
}

export async function assemblyId(parentRef: string, code = "std", revision?: string): Promise<number> {
	const row = await one<{ id: number }>(
		`SELECT b.id FROM assemblies b JOIN parts p ON p.id = b.parent_part_id
		 WHERE p.ref = ? AND b.code = ? AND (? IS NULL AND b.status = 'active' OR b.revision = ?)`,
		parentRef,
		code,
		revision ?? null,
		revision ?? null,
	);
	return row.id;
}
