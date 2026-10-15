// Database schema. Conventions (see CLAUDE.md):
// - money in integer cents (`*_cents`), quantities in integer thousandths (`*_milli`);
// - timestamps are ISO-8601 UTC text, dates are `YYYY-MM-DD` text;
// - every table carries created_at / updated_at / created_by / updated_by (emails).
// After editing this file run `npm run db:generate` to create a migration.
import { sql } from "drizzle-orm";
import {
	type AnySQLiteColumn,
	check,
	index,
	integer,
	type SQLiteTable,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

const nowSql = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

const audit = () => ({
	createdAt: text("created_at").notNull().default(nowSql),
	updatedAt: text("updated_at").notNull().default(nowSql),
	createdBy: text("created_by").notNull(),
	updatedBy: text("updated_by").notNull(),
});

export const PART_KINDS = ["buy", "make", "kit", "fee"] as const;
export type PartKind = (typeof PART_KINDS)[number];

export const ASSEMBLY_STATUSES = ["draft", "active", "archived"] as const;
export type AssemblyStatus = (typeof ASSEMBLY_STATUSES)[number];

export const MOVE_REASONS = ["receipt", "build_consume", "build_output", "adjust", "count"] as const;
export type MoveReason = (typeof MOVE_REASONS)[number];

export const PO_STATUSES = ["draft", "sent", "partial", "received", "cancelled"] as const;
export type PoStatus = (typeof PO_STATUSES)[number];

export const BUILD_STATUSES = ["planned", "in_progress", "done", "cancelled"] as const;
export type BuildStatus = (typeof BUILD_STATUSES)[number];

/** What a price_history row prices: the standard cost, a supplier's offer, or the selling price. */
export const PRICE_KINDS = ["standard", "purchase", "sale"] as const;
export type PriceKind = (typeof PRICE_KINDS)[number];

/** Where a price change came from (`revert`: an undone change restored it, see change_sets). */
export const PRICE_SOURCES = ["form", "import", "po", "migration", "revert"] as const;
export type PriceSource = (typeof PRICE_SOURCES)[number];

/** Where a change set came from: a page, a CSV import or restore, an MCP client, an undo, a data migration. */
export const CHANGE_SOURCES = ["ui", "import", "mcp", "revert", "migration"] as const;
export type ChangeSource = (typeof CHANGE_SOURCES)[number];

export const CHANGE_OPS = ["insert", "update", "delete"] as const;
export type ChangeOp = (typeof CHANGE_OPS)[number];

/** A machine is in service, out of service for a while, or retired (kept for the record). */
export const MACHINE_STATUSES = ["active", "maintenance", "retired"] as const;
export type MachineStatus = (typeof MACHINE_STATUSES)[number];

/** What an attached file is for (D159): chosen by people, separate from its format. */
export const FILE_KINDS = ["cad", "print", "drawing", "instructions", "datasheet", "other"] as const;
export type FileKind = (typeof FILE_KINDS)[number];

/** What an attached file is, recognised from its content (D162). */
export const FILE_FORMATS = ["step", "3mf", "stl", "pdf", "dxf", "jpeg", "png", "webp"] as const;
export type FileFormat = (typeof FILE_FORMATS)[number];

/** What a signed-in user may do, from least to most. Each role can do everything the previous one can. */
export const ROLES = ["viewer", "operator", "planner", "admin"] as const;
export type Role = (typeof ROLES)[number];

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
		// Selling price excluding VAT (products); an assembly variant can override it. NULL = not sold / unknown.
		salePriceCents: integer("sale_price_cents"),
		// Preferred supplier: its offer in part_suppliers drives shortages and draft POs.
		supplierId: integer("supplier_id").references(() => suppliers.id),
		// Deprecated since migration 0002 (moved to part_suppliers, per supplier). Kept because dropping
		// them would rebuild this table (CHECK constraint) under four child tables; never read or written.
		supplierRef: text("supplier_ref").notNull().default(""),
		moqMilli: integer("moq_milli").notNull().default(0),
		packSizeMilli: integer("pack_size_milli").notNull().default(0),
		leadDays: integer("lead_days").notNull().default(0),
		// Minimum stock (D173): the on-hand level under which the part raises a stock alert. NULL = no alert.
		minStockMilli: integer("min_stock_milli"),
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

// An option a part comes in (D183), e.g. "Colour", with its ordered values below. Stock, receipts and builds of the
// part are counted per value; the part stays one part in the catalogue and in recipes. Parts match each other's
// options by name, ignoring case (D185).
export const partOptions = sqliteTable(
	"part_options",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		partId: integer("part_id")
			.notNull()
			.references(() => parts.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		position: integer("position").notNull().default(0),
		...audit(),
	},
	(t) => [uniqueIndex("part_options_part_name_unique").on(t.partId, t.name)],
);

// A value of a part's option ("white"), one of them the default. Records name values by id in their `option_values`
// key (D184), so a value is renamed freely but deleted only while nothing uses it (checked in src/domain/options.ts).
export const partOptionValues = sqliteTable(
	"part_option_values",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		optionId: integer("option_id")
			.notNull()
			.references(() => partOptions.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		position: integer("position").notNull().default(0),
		isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
		...audit(),
	},
	(t) => [
		uniqueIndex("part_option_values_option_name_unique").on(t.optionId, t.name),
		uniqueIndex("part_option_values_one_default").on(t.optionId).where(sql`is_default = 1`),
	],
);

// A kind of machine (e.g. "FDM printer"): what recipes name and what carries the hourly rate (D147).
export const machineTypes = sqliteTable(
	"machine_types",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		name: text("name").notNull(),
		// Cost of one hour on a machine of this type. NULL = unknown, which makes roll-ups incomplete.
		hourlyRateCents: integer("hourly_rate_cents"),
		notes: text("notes").notNull().default(""),
		...audit(),
	},
	(t) => [
		uniqueIndex("machine_types_name_unique").on(t.name),
		check("machine_types_rate_check", sql`${t.hourlyRateCents} IS NULL OR ${t.hourlyRateCents} >= 0`),
	],
);

// The machines the workshop owns, each of a type (D147).
export const machines = sqliteTable(
	"machines",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		name: text("name").notNull(),
		machineTypeId: integer("machine_type_id")
			.notNull()
			.references(() => machineTypes.id),
		status: text("status", { enum: MACHINE_STATUSES }).notNull().default("active"),
		notes: text("notes").notNull().default(""),
		...audit(),
	},
	(t) => [
		uniqueIndex("machines_name_unique").on(t.name),
		index("machines_type_idx").on(t.machineTypeId),
		check("machines_status_check", inList("status", MACHINE_STATUSES)),
	],
);

// Append-only log of hourly rates, like price_history for prices (D149): every change of a rate adds a row in the
// same batch. Never UPDATE or DELETE.
export const machineRateHistory = sqliteTable(
	"machine_rate_history",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		machineTypeId: integer("machine_type_id")
			.notNull()
			.references(() => machineTypes.id, { onDelete: "cascade" }),
		// The new rate. NULL = cleared / unknown.
		rateCents: integer("rate_cents"),
		validFrom: text("valid_from").notNull(),
		source: text("source", { enum: PRICE_SOURCES }).notNull(),
		note: text("note").notNull().default(""),
		...audit(),
	},
	(t) => [
		index("machine_rate_history_type_idx").on(t.machineTypeId, t.validFrom),
		check("machine_rate_history_source_check", inList("source", PRICE_SOURCES)),
		check("machine_rate_history_rate_check", sql`${t.rateCents} IS NULL OR ${t.rateCents} >= 0`),
	],
);

export const assemblies = sqliteTable(
	"assemblies",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		parentPartId: integer("parent_part_id")
			.notNull()
			.references(() => parts.id),
		code: text("code").notNull().default("std"),
		revision: text("revision").notNull().default("Rev1"),
		status: text("status", { enum: ASSEMBLY_STATUSES }).notNull().default("draft"),
		// Selling price of this variant, overriding the part's sale price. NULL = use the part's.
		salePriceCents: integer("sale_price_cents"),
		notes: text("notes").notNull().default(""),
		...audit(),
		// Units of the parent one batch makes (milli, D145): the lines are the quantities for the whole batch. Checked
		// in src/domain (> 0) rather than by a CHECK, which SQLite cannot add without rebuilding the table.
		batchQtyMilli: integer("batch_qty_milli").notNull().default(1000),
		// Machine time per batch (D148): one step on a machine of this type, in whole minutes (0 = none).
		machineTypeId: integer("machine_type_id").references(() => machineTypes.id),
		machineMinutes: integer("machine_minutes").notNull().default(0),
	},
	(t) => [
		uniqueIndex("assemblies_parent_code_revision_unique").on(t.parentPartId, t.code, t.revision),
		// At most one active assembly per (parent, variant code).
		uniqueIndex("assemblies_one_active_per_code").on(t.parentPartId, t.code).where(sql`status = 'active'`),
		check("assemblies_status_check", inList("status", ASSEMBLY_STATUSES)),
	],
);

export const assemblyLines = sqliteTable(
	"assembly_lines",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		assemblyId: integer("assembly_id")
			.notNull()
			.references(() => assemblies.id, { onDelete: "cascade" }),
		componentPartId: integer("component_part_id")
			.notNull()
			.references(() => parts.id),
		qtyMilli: integer("qty_milli").notNull(),
		position: integer("position").notNull().default(0),
		notes: text("notes").notNull().default(""),
		...audit(),
		// The line's rule for each option of its component (D186): the values it always takes (a key, D184), and the
		// options chosen when a build is planned (option ids, comma-separated). Every other option follows the build.
		fixedOptionValues: text("fixed_option_values"),
		chosenOptionIds: text("chosen_option_ids"),
	},
	(t) => [
		index("assembly_lines_assembly_idx").on(t.assemblyId, t.position),
		index("assembly_lines_component_idx").on(t.componentPartId),
		check("assembly_lines_qty_check", sql`${t.qtyMilli} > 0`),
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
		// The option values of the moved units (D184): value ids in ascending order, comma-separated; NULL for a part
		// without options. On-hand is SUM(qty_milli) per part and key.
		optionValues: text("option_values"),
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
		// The option values ordered (D184): its receipts are moves with this key.
		optionValues: text("option_values"),
	},
	(t) => [
		index("po_lines_po_idx").on(t.poId),
		index("po_lines_part_idx").on(t.partId),
		check("po_lines_qty_check", sql`${t.qtyMilli} > 0 AND ${t.receivedQtyMilli} >= 0 AND ${t.unitPriceCents} >= 0`),
	],
);

// Parcels a supplier sent for a PO (D168): who carries them and how to follow them. Kitting stores what the
// supplier gives (a tracking number, maybe a link) and never calls a carrier.
export const poShipments = sqliteTable(
	"po_shipments",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		poId: integer("po_id")
			.notNull()
			.references(() => purchaseOrders.id, { onDelete: "cascade" }),
		carrier: text("carrier").notNull(),
		trackingNumber: text("tracking_number").notNull(),
		trackingUrl: text("tracking_url").notNull().default(""),
		shippedAt: text("shipped_at"),
		notes: text("notes").notNull().default(""),
		...audit(),
	},
	// One shipment per tracking number on a PO, ignoring case (an undo or a restore cannot bring back "pc1" next to "PC1").
	(t) => [uniqueIndex("po_shipments_tracking_unique").on(t.poId, sql`lower(${t.trackingNumber})`)],
);

export const builds = sqliteTable(
	"builds",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		number: text("number").notNull(),
		partId: integer("part_id")
			.notNull()
			.references(() => parts.id),
		assemblyId: integer("assembly_id")
			.notNull()
			.references(() => assemblies.id),
		qtyMilli: integer("qty_milli").notNull().default(1000),
		serial: text("serial"),
		status: text("status", { enum: BUILD_STATUSES }).notNull().default("planned"),
		plannedFor: text("planned_for"),
		doneAt: text("done_at"),
		notes: text("notes").notNull().default(""),
		...audit(),
		// The option values the build makes (D184): the key of its output move; follow lines take them (D185).
		optionValues: text("option_values"),
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
		// The option values consumed (D184).
		optionValues: text("option_values"),
	},
	(t) => [index("build_lines_build_idx").on(t.buildId), index("build_lines_part_serial_idx").on(t.partId, t.serial)],
);

// The values chosen when a build is planned for the options its recipe lines leave to it (D187): one row per
// component part, its key holding only the chosen options' values. Edited while the build is open.
export const buildOptionChoices = sqliteTable(
	"build_option_choices",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		buildId: integer("build_id")
			.notNull()
			.references(() => builds.id, { onDelete: "cascade" }),
		partId: integer("part_id")
			.notNull()
			.references(() => parts.id),
		optionValues: text("option_values").notNull(),
		...audit(),
	},
	(t) => [uniqueIndex("build_option_choices_build_part_unique").on(t.buildId, t.partId)],
);

// As-built record of machine time (D148): one row per machine type a completed build used, with the minutes (milli)
// and the hourly rate frozen at completion. Written with the build's ledger moves, never changed.
export const buildMachineTimes = sqliteTable(
	"build_machine_times",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		buildId: integer("build_id")
			.notNull()
			.references(() => builds.id),
		machineTypeId: integer("machine_type_id")
			.notNull()
			.references(() => machineTypes.id),
		minutesMilli: integer("minutes_milli").notNull(),
		rateCents: integer("rate_cents"),
		...audit(),
	},
	(t) => [index("build_machine_times_build_idx").on(t.buildId)],
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

// A file attached to a part (whatever its recipe) or to one assembly revision (D159). The bytes are an object in the
// IMAGES R2 bucket that the app never deletes (D160): new revisions copy the row and share the object, and removing a
// file deletes the row only, so an undo can bring it back.
export const files = sqliteTable(
	"files",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		partId: integer("part_id").references(() => parts.id, { onDelete: "cascade" }),
		assemblyId: integer("assembly_id").references(() => assemblies.id, { onDelete: "cascade" }),
		// Shown and used as the download name (the format's extension is added when it has none).
		name: text("name").notNull(),
		kind: text("kind", { enum: FILE_KINDS }).notNull(),
		format: text("format", { enum: FILE_FORMATS }).notNull(),
		sizeBytes: integer("size_bytes").notNull(),
		// Hex SHA-256 of the content: identical uploads share one object.
		sha256: text("sha256").notNull(),
		// "files/<uuid>" in the bucket: immutable, never reused for other content.
		objectKey: text("object_key").notNull(),
		note: text("note").notNull().default(""),
		// The upload itself, kept when a new revision copies the row (the audit columns say who attached it here).
		uploadedAt: text("uploaded_at").notNull(),
		uploadedBy: text("uploaded_by").notNull(),
		...audit(),
	},
	(t) => [
		index("files_part_idx").on(t.partId),
		index("files_assembly_idx").on(t.assemblyId),
		index("files_sha256_idx").on(t.sha256),
		check("files_owner_check", sql`(${t.partId} IS NULL) <> (${t.assemblyId} IS NULL)`),
		check("files_kind_check", inList("kind", FILE_KINDS)),
		check("files_format_check", inList("format", FILE_FORMATS)),
		check("files_size_check", sql`${t.sizeBytes} > 0`),
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
		// Set for kind = 'purchase' (whose offer) and for an assembly variant's sale price.
		supplierId: integer("supplier_id").references(() => suppliers.id),
		assemblyId: integer("assembly_id").references(() => assemblies.id, { onDelete: "cascade" }),
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

// Roles given by admins. Cloudflare Access decides who can sign in; this table decides what they may do.
// An email without a row is a viewer, and ADMIN_EMAILS are always admins whatever their row says.
export const users = sqliteTable(
	"users",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		// Lower-cased, as in the Access JWT.
		email: text("email").notNull(),
		role: text("role", { enum: ROLES }).notNull(),
		...audit(),
	},
	(t) => [uniqueIndex("users_email_unique").on(t.email), check("users_role_check", inList("role", ROLES))],
);

// Instance-wide options set by admins, one row per key (see SETTINGS in src/domain/users.ts).
export const settings = sqliteTable(
	"settings",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		key: text("key").notNull(),
		value: text("value").notNull(),
		...audit(),
	},
	(t) => [uniqueIndex("settings_key_unique").on(t.key)],
);

// ---------------------------------------------------------------------------
// Change history (D106–D114). Every write to a tracked table runs inside a change set (runChangeSet in
// src/domain/history.ts); SQLite triggers copy each row change into change_log, with the full row before
// and after as JSON. Both tables are append-only once committed.

export const changeSets = sqliteTable(
	"change_sets",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		at: text("at").notNull().default(nowSql),
		userEmail: text("user_email").notNull(),
		source: text("source", { enum: CHANGE_SOURCES }).notNull(),
		// The MCP client (or other API caller) that made the change, when there is one.
		clientName: text("client_name"),
		// Human-readable, in the author's language; never contains an amount (shown to every role).
		summary: text("summary").notNull(),
		// False when the change wrote ledger rows (stock moves, as-built lines) or anything else an undo
		// could not restore consistently: such changes are corrected with new moves instead.
		revertible: integer("revertible", { mode: "boolean" }).notNull().default(true),
		// Set on an undo: the change set it reverted.
		revertsChangeSetId: integer("reverts_change_set_id").references((): AnySQLiteColumn => changeSets.id),
	},
	(t) => [
		index("change_sets_at_idx").on(t.at),
		index("change_sets_user_idx").on(t.userEmail, t.at),
		index("change_sets_reverts_idx").on(t.revertsChangeSetId),
		check("change_sets_source_check", inList("source", CHANGE_SOURCES)),
	],
);

export const changeLog = sqliteTable(
	"change_log",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		changeSetId: integer("change_set_id")
			.notNull()
			.references(() => changeSets.id),
		tableName: text("table_name").notNull(),
		rowId: integer("row_id").notNull(),
		op: text("op", { enum: CHANGE_OPS }).notNull(),
		// The full row as JSON (snake_case column names): before the change (NULL on insert) and after it
		// (NULL on delete).
		oldRow: text("old_row"),
		newRow: text("new_row"),
	},
	(t) => [
		index("change_log_set_idx").on(t.changeSetId),
		index("change_log_row_idx").on(t.tableName, t.rowId),
		check("change_log_op_check", inList("op", CHANGE_OPS)),
	],
);

// At most one row, only while a batch runs: its first statements insert it (the change set being written,
// or `suppress` for a backup restore) and its last statement deletes it. The history triggers read it, and
// abort a write to a tracked table when there is no row. `conflict` is the undo's guard: setting it to 1
// fails the CHECK and rolls the whole batch back.
export const changeContext = sqliteTable(
	"change_context",
	{
		id: integer("id").primaryKey(),
		changeSetId: integer("change_set_id"),
		suppress: integer("suppress", { mode: "boolean" }).notNull().default(false),
		conflict: integer("conflict").notNull().default(0),
	},
	(t) => [check("change_context_single_row", sql`${t.id} = 1`), check("revert_conflict", sql`${t.conflict} = 0`)],
);

/**
 * Tables whose every row change is recorded in change_log (by triggers generated from this list, see
 * scripts/history-triggers.mjs). Not tracked: the append-only ledgers (stock_moves, build_lines, build_machine_times,
 * price_history, machine_rate_history) and the history tables themselves.
 */
export const HISTORY_TABLES: SQLiteTable[] = [
	parts,
	suppliers,
	assemblies,
	assemblyLines,
	partSuppliers,
	purchaseOrders,
	poLines,
	poShipments,
	builds,
	users,
	settings,
	machineTypes,
	machines,
	files,
	partOptions,
	partOptionValues,
	buildOptionChoices,
];

/**
 * Append-only ledgers: corrected with reverse movements, never undone. A change set that writes to them is
 * marked non-revertible by a trigger.
 */
export const LEDGER_TABLES: SQLiteTable[] = [stockMoves, buildLines, buildMachineTimes];

/** Tables deliberately left out of the history (a test checks every table is in one list or the other). */
export const UNTRACKED_TABLES: SQLiteTable[] = [
	...LEDGER_TABLES,
	priceHistory,
	machineRateHistory,
	changeSets,
	changeLog,
	changeContext,
];

export type ChangeSet = typeof changeSets.$inferSelect;
export type ChangeLogRow = typeof changeLog.$inferSelect;

export type Supplier = typeof suppliers.$inferSelect;
export type Part = typeof parts.$inferSelect;
export type Assembly = typeof assemblies.$inferSelect;
export type AssemblyLine = typeof assemblyLines.$inferSelect;
export type StockMove = typeof stockMoves.$inferSelect;
export type PurchaseOrder = typeof purchaseOrders.$inferSelect;
export type PoLine = typeof poLines.$inferSelect;
export type PoShipment = typeof poShipments.$inferSelect;
export type Build = typeof builds.$inferSelect;
export type BuildLine = typeof buildLines.$inferSelect;
export type PartSupplier = typeof partSuppliers.$inferSelect;
export type PriceHistoryRow = typeof priceHistory.$inferSelect;
export type MachineType = typeof machineTypes.$inferSelect;
export type Machine = typeof machines.$inferSelect;
export type BuildMachineTime = typeof buildMachineTimes.$inferSelect;
export type FileRow = typeof files.$inferSelect;
export type PartOption = typeof partOptions.$inferSelect;
export type PartOptionValue = typeof partOptionValues.$inferSelect;
export type BuildOptionChoice = typeof buildOptionChoices.$inferSelect;
