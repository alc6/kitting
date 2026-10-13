// Database schema. Conventions (see CLAUDE.md):
// - money in integer cents (`*_cents`), quantities in integer thousandths (`*_milli`);
// - timestamps are ISO-8601 UTC text, dates are `YYYY-MM-DD` text;
// - every table carries created_at / updated_at / created_by / updated_by (emails).
// After editing this file run `npm run db:generate` to create a migration.
import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const nowSql = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

const audit = () => ({
	createdAt: text("created_at").notNull().default(nowSql),
	updatedAt: text("updated_at").notNull().default(nowSql),
	createdBy: text("created_by").notNull(),
	updatedBy: text("updated_by").notNull(),
});

export const PART_KINDS = ["buy", "make", "kit", "fee"] as const;
export type PartKind = (typeof PART_KINDS)[number];

export const BOM_STATUSES = ["draft", "active", "archived"] as const;
export type BomStatus = (typeof BOM_STATUSES)[number];

export const MOVE_REASONS = ["receipt", "build_consume", "build_output", "adjust", "count"] as const;
export type MoveReason = (typeof MOVE_REASONS)[number];

export const PO_STATUSES = ["draft", "sent", "partial", "received", "cancelled"] as const;
export type PoStatus = (typeof PO_STATUSES)[number];

export const BUILD_STATUSES = ["planned", "in_progress", "done", "cancelled"] as const;
export type BuildStatus = (typeof BUILD_STATUSES)[number];

/** What a price_history row prices: the standard cost, a supplier's offer, or the selling price. */
export const PRICE_KINDS = ["standard", "purchase", "sale"] as const;
export type PriceKind = (typeof PRICE_KINDS)[number];

/** Where a price change came from. */
export const PRICE_SOURCES = ["form", "import", "po", "migration"] as const;
export type PriceSource = (typeof PRICE_SOURCES)[number];

const inList = (column: string, values: readonly string[]) =>
	sql.raw(`${column} IN (${values.map((v) => `'${v}'`).join(", ")})`);

export const suppliers = sqliteTable(
	"suppliers",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		name: text("name").notNull(),
		email: text("email").notNull().default(""),
		phone: text("phone").notNull().default(""),
		notes: text("notes").notNull().default(""),
		...audit(),
	},
	(t) => [uniqueIndex("suppliers_name_unique").on(t.name)],
);

export const parts = sqliteTable(
	"parts",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		ref: text("ref").notNull(),
		name: text("name").notNull(),
		kind: text("kind", { enum: PART_KINDS }).notNull(),
		unit: text("unit").notNull().default("pcs"),
		// Standard unit cost. NULL means "unknown" and makes cost roll-ups incomplete.
		costCents: integer("cost_cents"),
		// Selling price excluding VAT (products); a BoM variant can override it. NULL = not sold / unknown.
		salePriceCents: integer("sale_price_cents"),
		// Preferred supplier: its offer in part_suppliers drives shortages and draft POs.
		supplierId: integer("supplier_id").references(() => suppliers.id),
		// Deprecated since migration 0002 (moved to part_suppliers, per supplier). Kept because dropping
		// them would rebuild this table (CHECK constraint) under four child tables; never read or written.
		supplierRef: text("supplier_ref").notNull().default(""),
		moqMilli: integer("moq_milli").notNull().default(0),
		packSizeMilli: integer("pack_size_milli").notNull().default(0),
		leadDays: integer("lead_days").notNull().default(0),
		trackSerial: integer("track_serial", { mode: "boolean" }).notNull().default(false),
		archived: integer("archived", { mode: "boolean" }).notNull().default(false),
		notes: text("notes").notNull().default(""),
		...audit(),
		// Product image: key of an object in the IMAGES R2 bucket, "parts/<id>/<sha256 prefix>.<ext>" (D100).
		imageKey: text("image_key"),
	},
	(t) => [
		uniqueIndex("parts_ref_unique").on(t.ref),
		index("parts_supplier_idx").on(t.supplierId),
		check("parts_kind_check", inList("kind", PART_KINDS)),
		check("parts_cost_check", sql`${t.costCents} IS NULL OR ${t.costCents} >= 0`),
		check("parts_moq_check", sql`${t.moqMilli} >= 0 AND ${t.packSizeMilli} >= 0 AND ${t.leadDays} >= 0`),
	],
);

export const boms = sqliteTable(
	"boms",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		parentPartId: integer("parent_part_id")
			.notNull()
			.references(() => parts.id),
		code: text("code").notNull().default("std"),
		revision: text("revision").notNull().default("Rev1"),
		status: text("status", { enum: BOM_STATUSES }).notNull().default("draft"),
		// Selling price of this variant, overriding the part's sale price. NULL = use the part's.
		salePriceCents: integer("sale_price_cents"),
		notes: text("notes").notNull().default(""),
		...audit(),
	},
	(t) => [
		uniqueIndex("boms_parent_code_revision_unique").on(t.parentPartId, t.code, t.revision),
		// At most one active BoM per (parent, variant code).
		uniqueIndex("boms_one_active_per_code").on(t.parentPartId, t.code).where(sql`status = 'active'`),
		check("boms_status_check", inList("status", BOM_STATUSES)),
	],
);

export const bomLines = sqliteTable(
	"bom_lines",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		bomId: integer("bom_id")
			.notNull()
			.references(() => boms.id, { onDelete: "cascade" }),
		componentPartId: integer("component_part_id")
			.notNull()
			.references(() => parts.id),
		qtyMilli: integer("qty_milli").notNull(),
		position: integer("position").notNull().default(0),
		notes: text("notes").notNull().default(""),
		...audit(),
	},
	(t) => [
		index("bom_lines_bom_idx").on(t.bomId, t.position),
		index("bom_lines_component_idx").on(t.componentPartId),
		check("bom_lines_qty_check", sql`${t.qtyMilli} > 0`),
	],
);

// Append-only ledger. Never UPDATE or DELETE rows: corrections are new moves.
export const stockMoves = sqliteTable(
	"stock_moves",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		partId: integer("part_id")
			.notNull()
			.references(() => parts.id),
		qtyMilli: integer("qty_milli").notNull(),
		reason: text("reason", { enum: MOVE_REASONS }).notNull(),
		refType: text("ref_type"),
		refId: integer("ref_id"),
		serial: text("serial"),
		unitCostCents: integer("unit_cost_cents"),
		at: text("at").notNull().default(nowSql),
		by: text("by").notNull(),
		note: text("note").notNull().default(""),
		...audit(),
	},
	(t) => [
		index("stock_moves_part_idx").on(t.partId, t.at),
		index("stock_moves_ref_idx").on(t.refType, t.refId),
		index("stock_moves_serial_idx").on(t.serial),
		// A build posts its output exactly once: a second completion aborts the whole batch.
		uniqueIndex("stock_moves_build_output_once").on(t.refType, t.refId).where(sql`reason = 'build_output'`),
		check("stock_moves_reason_check", inList("reason", MOVE_REASONS)),
	],
);

export const purchaseOrders = sqliteTable(
	"purchase_orders",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		number: text("number").notNull(),
		supplierId: integer("supplier_id")
			.notNull()
			.references(() => suppliers.id),
		status: text("status", { enum: PO_STATUSES }).notNull().default("draft"),
		expectedAt: text("expected_at"),
		sentAt: text("sent_at"),
		notes: text("notes").notNull().default(""),
		...audit(),
	},
	(t) => [
		uniqueIndex("purchase_orders_number_unique").on(t.number),
		index("purchase_orders_status_idx").on(t.status),
		check("purchase_orders_status_check", inList("status", PO_STATUSES)),
	],
);

export const poLines = sqliteTable(
	"po_lines",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		poId: integer("po_id")
			.notNull()
			.references(() => purchaseOrders.id, { onDelete: "cascade" }),
		partId: integer("part_id")
			.notNull()
			.references(() => parts.id),
		qtyMilli: integer("qty_milli").notNull(),
		unitPriceCents: integer("unit_price_cents").notNull().default(0),
		receivedQtyMilli: integer("received_qty_milli").notNull().default(0),
		notes: text("notes").notNull().default(""),
		...audit(),
	},
	(t) => [
		index("po_lines_po_idx").on(t.poId),
		index("po_lines_part_idx").on(t.partId),
		check("po_lines_qty_check", sql`${t.qtyMilli} > 0 AND ${t.receivedQtyMilli} >= 0 AND ${t.unitPriceCents} >= 0`),
	],
);

export const builds = sqliteTable(
	"builds",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		number: text("number").notNull(),
		partId: integer("part_id")
			.notNull()
			.references(() => parts.id),
		bomId: integer("bom_id")
			.notNull()
			.references(() => boms.id),
		qtyMilli: integer("qty_milli").notNull().default(1000),
		serial: text("serial"),
		status: text("status", { enum: BUILD_STATUSES }).notNull().default("planned"),
		plannedFor: text("planned_for"),
		doneAt: text("done_at"),
		notes: text("notes").notNull().default(""),
		...audit(),
	},
	(t) => [
		uniqueIndex("builds_number_unique").on(t.number),
		// A serial identifies one unit of a product; cancelled builds free their serial.
		uniqueIndex("builds_part_serial_unique")
			.on(t.partId, t.serial)
			.where(sql`serial IS NOT NULL AND status != 'cancelled'`),
		index("builds_status_idx").on(t.status),
		check("builds_status_check", inList("status", BUILD_STATUSES)),
		check("builds_qty_check", sql`${t.qtyMilli} > 0`),
	],
);

// As-built record: one row per consumed component (per serial for tracked parts).
export const buildLines = sqliteTable(
	"build_lines",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		buildId: integer("build_id")
			.notNull()
			.references(() => builds.id),
		partId: integer("part_id")
			.notNull()
			.references(() => parts.id),
		qtyMilli: integer("qty_milli").notNull(),
		serial: text("serial"),
		unitCostCents: integer("unit_cost_cents"),
		notes: text("notes").notNull().default(""),
		...audit(),
	},
	(t) => [index("build_lines_build_idx").on(t.buildId), index("build_lines_part_serial_idx").on(t.partId, t.serial)],
);

// A supplier's offer for a part: its reference, price and ordering terms. One row per (part, supplier);
// the preferred one is the part's supplier_id.
export const partSuppliers = sqliteTable(
	"part_suppliers",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		partId: integer("part_id")
			.notNull()
			.references(() => parts.id, { onDelete: "cascade" }),
		supplierId: integer("supplier_id")
			.notNull()
			.references(() => suppliers.id),
		supplierRef: text("supplier_ref").notNull().default(""),
		// Current unit price from this supplier. NULL = unknown.
		priceCents: integer("price_cents"),
		moqMilli: integer("moq_milli").notNull().default(0),
		packSizeMilli: integer("pack_size_milli").notNull().default(0),
		leadDays: integer("lead_days").notNull().default(0),
		notes: text("notes").notNull().default(""),
		...audit(),
	},
	(t) => [
		uniqueIndex("part_suppliers_part_supplier_unique").on(t.partId, t.supplierId),
		index("part_suppliers_supplier_idx").on(t.supplierId),
		check(
			"part_suppliers_terms_check",
			sql`(${t.priceCents} IS NULL OR ${t.priceCents} >= 0) AND ${t.moqMilli} >= 0 AND ${t.packSizeMilli} >= 0 AND ${t.leadDays} >= 0`,
		),
	],
);

// Append-only log of price changes (standard cost, supplier offers, selling prices). Never UPDATE or
// DELETE: a change is a new row. Prices actually paid are in the ledger (receipt moves at the PO price).
export const priceHistory = sqliteTable(
	"price_history",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		partId: integer("part_id")
			.notNull()
			.references(() => parts.id, { onDelete: "cascade" }),
		kind: text("kind", { enum: PRICE_KINDS }).notNull(),
		// Set for kind = 'purchase' (whose offer) and for a BoM variant's sale price.
		supplierId: integer("supplier_id").references(() => suppliers.id),
		bomId: integer("bom_id").references(() => boms.id, { onDelete: "cascade" }),
		// The new price. NULL = cleared / unknown.
		priceCents: integer("price_cents"),
		validFrom: text("valid_from").notNull(),
		source: text("source", { enum: PRICE_SOURCES }).notNull(),
		note: text("note").notNull().default(""),
		...audit(),
	},
	(t) => [
		index("price_history_part_idx").on(t.partId, t.kind, t.validFrom),
		check("price_history_kind_check", inList("kind", PRICE_KINDS)),
		check("price_history_source_check", inList("source", PRICE_SOURCES)),
		check("price_history_price_check", sql`${t.priceCents} IS NULL OR ${t.priceCents} >= 0`),
	],
);

export type Supplier = typeof suppliers.$inferSelect;
export type Part = typeof parts.$inferSelect;
export type Bom = typeof boms.$inferSelect;
export type BomLine = typeof bomLines.$inferSelect;
export type StockMove = typeof stockMoves.$inferSelect;
export type PurchaseOrder = typeof purchaseOrders.$inferSelect;
export type PoLine = typeof poLines.$inferSelect;
export type Build = typeof builds.$inferSelect;
export type BuildLine = typeof buildLines.$inferSelect;
export type PartSupplier = typeof partSuppliers.$inferSelect;
export type PriceHistoryRow = typeof priceHistory.$inferSelect;
