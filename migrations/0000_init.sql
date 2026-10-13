CREATE TABLE `assembly_lines` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`assembly_id` integer NOT NULL,
	`component_part_id` integer NOT NULL,
	`qty_milli` integer NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	FOREIGN KEY (`assembly_id`) REFERENCES `assemblies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`component_part_id`) REFERENCES `parts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "assembly_lines_qty_check" CHECK("assembly_lines"."qty_milli" > 0)
);
--> statement-breakpoint
CREATE INDEX `assembly_lines_assembly_idx` ON `assembly_lines` (`assembly_id`,`position`);--> statement-breakpoint
CREATE INDEX `assembly_lines_component_idx` ON `assembly_lines` (`component_part_id`);--> statement-breakpoint
CREATE TABLE `assemblies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`parent_part_id` integer NOT NULL,
	`code` text DEFAULT 'std' NOT NULL,
	`revision` text DEFAULT 'Rev1' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	FOREIGN KEY (`parent_part_id`) REFERENCES `parts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "assemblies_status_check" CHECK(status IN ('draft', 'active', 'archived'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `assemblies_parent_code_revision_unique` ON `assemblies` (`parent_part_id`,`code`,`revision`);--> statement-breakpoint
CREATE UNIQUE INDEX `assemblies_one_active_per_code` ON `assemblies` (`parent_part_id`,`code`) WHERE status = 'active';--> statement-breakpoint
CREATE TABLE `build_lines` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`build_id` integer NOT NULL,
	`part_id` integer NOT NULL,
	`qty_milli` integer NOT NULL,
	`serial` text,
	`unit_cost_cents` integer,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	FOREIGN KEY (`build_id`) REFERENCES `builds`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`part_id`) REFERENCES `parts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `build_lines_build_idx` ON `build_lines` (`build_id`);--> statement-breakpoint
CREATE INDEX `build_lines_part_serial_idx` ON `build_lines` (`part_id`,`serial`);--> statement-breakpoint
CREATE TABLE `builds` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`number` text NOT NULL,
	`part_id` integer NOT NULL,
	`assembly_id` integer NOT NULL,
	`qty_milli` integer DEFAULT 1000 NOT NULL,
	`serial` text,
	`status` text DEFAULT 'planned' NOT NULL,
	`planned_for` text,
	`done_at` text,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	FOREIGN KEY (`part_id`) REFERENCES `parts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`assembly_id`) REFERENCES `assemblies`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "builds_status_check" CHECK(status IN ('planned', 'in_progress', 'done', 'cancelled')),
	CONSTRAINT "builds_qty_check" CHECK("builds"."qty_milli" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `builds_number_unique` ON `builds` (`number`);--> statement-breakpoint
CREATE UNIQUE INDEX `builds_part_serial_unique` ON `builds` (`part_id`,`serial`) WHERE serial IS NOT NULL;--> statement-breakpoint
CREATE INDEX `builds_status_idx` ON `builds` (`status`);--> statement-breakpoint
CREATE TABLE `parts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ref` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`unit` text DEFAULT 'pcs' NOT NULL,
	`cost_cents` integer,
	`supplier_id` integer,
	`supplier_ref` text DEFAULT '' NOT NULL,
	`moq_milli` integer DEFAULT 0 NOT NULL,
	`pack_size_milli` integer DEFAULT 0 NOT NULL,
	`lead_days` integer DEFAULT 0 NOT NULL,
	`track_serial` integer DEFAULT false NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "parts_kind_check" CHECK(kind IN ('buy', 'make', 'kit', 'fee')),
	CONSTRAINT "parts_cost_check" CHECK("parts"."cost_cents" IS NULL OR "parts"."cost_cents" >= 0),
	CONSTRAINT "parts_moq_check" CHECK("parts"."moq_milli" >= 0 AND "parts"."pack_size_milli" >= 0 AND "parts"."lead_days" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `parts_ref_unique` ON `parts` (`ref`);--> statement-breakpoint
CREATE INDEX `parts_supplier_idx` ON `parts` (`supplier_id`);--> statement-breakpoint
CREATE TABLE `po_lines` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`po_id` integer NOT NULL,
	`part_id` integer NOT NULL,
	`qty_milli` integer NOT NULL,
	`unit_price_cents` integer DEFAULT 0 NOT NULL,
	`received_qty_milli` integer DEFAULT 0 NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	FOREIGN KEY (`po_id`) REFERENCES `purchase_orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`part_id`) REFERENCES `parts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "po_lines_qty_check" CHECK("po_lines"."qty_milli" > 0 AND "po_lines"."received_qty_milli" >= 0 AND "po_lines"."unit_price_cents" >= 0)
);
--> statement-breakpoint
CREATE INDEX `po_lines_po_idx` ON `po_lines` (`po_id`);--> statement-breakpoint
CREATE INDEX `po_lines_part_idx` ON `po_lines` (`part_id`);--> statement-breakpoint
CREATE TABLE `purchase_orders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`number` text NOT NULL,
	`supplier_id` integer NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`expected_at` text,
	`sent_at` text,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "purchase_orders_status_check" CHECK(status IN ('draft', 'sent', 'partial', 'received', 'cancelled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `purchase_orders_number_unique` ON `purchase_orders` (`number`);--> statement-breakpoint
CREATE INDEX `purchase_orders_status_idx` ON `purchase_orders` (`status`);--> statement-breakpoint
CREATE TABLE `stock_moves` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`part_id` integer NOT NULL,
	`qty_milli` integer NOT NULL,
	`reason` text NOT NULL,
	`ref_type` text,
	`ref_id` integer,
	`serial` text,
	`unit_cost_cents` integer,
	`at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`by` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	FOREIGN KEY (`part_id`) REFERENCES `parts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "stock_moves_reason_check" CHECK(reason IN ('receipt', 'build_consume', 'build_output', 'adjust', 'count'))
);
--> statement-breakpoint
CREATE INDEX `stock_moves_part_idx` ON `stock_moves` (`part_id`,`at`);--> statement-breakpoint
CREATE INDEX `stock_moves_ref_idx` ON `stock_moves` (`ref_type`,`ref_id`);--> statement-breakpoint
CREATE INDEX `stock_moves_serial_idx` ON `stock_moves` (`serial`);--> statement-breakpoint
CREATE UNIQUE INDEX `stock_moves_build_output_once` ON `stock_moves` (`ref_type`,`ref_id`) WHERE reason = 'build_output';--> statement-breakpoint
CREATE TABLE `suppliers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`email` text DEFAULT '' NOT NULL,
	`phone` text DEFAULT '' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `suppliers_name_unique` ON `suppliers` (`name`);