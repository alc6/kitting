CREATE TABLE `part_suppliers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`part_id` integer NOT NULL,
	`supplier_id` integer NOT NULL,
	`supplier_ref` text DEFAULT '' NOT NULL,
	`price_cents` integer,
	`moq_milli` integer DEFAULT 0 NOT NULL,
	`pack_size_milli` integer DEFAULT 0 NOT NULL,
	`lead_days` integer DEFAULT 0 NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	FOREIGN KEY (`part_id`) REFERENCES `parts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "part_suppliers_terms_check" CHECK(("part_suppliers"."price_cents" IS NULL OR "part_suppliers"."price_cents" >= 0) AND "part_suppliers"."moq_milli" >= 0 AND "part_suppliers"."pack_size_milli" >= 0 AND "part_suppliers"."lead_days" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `part_suppliers_part_supplier_unique` ON `part_suppliers` (`part_id`,`supplier_id`);--> statement-breakpoint
CREATE INDEX `part_suppliers_supplier_idx` ON `part_suppliers` (`supplier_id`);--> statement-breakpoint
CREATE TABLE `price_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`part_id` integer NOT NULL,
	`kind` text NOT NULL,
	`supplier_id` integer,
	`bom_id` integer,
	`price_cents` integer,
	`valid_from` text NOT NULL,
	`source` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	FOREIGN KEY (`part_id`) REFERENCES `parts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`bom_id`) REFERENCES `boms`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "price_history_kind_check" CHECK(kind IN ('standard', 'purchase', 'sale')),
	CONSTRAINT "price_history_source_check" CHECK(source IN ('form', 'import', 'po', 'migration')),
	CONSTRAINT "price_history_price_check" CHECK("price_history"."price_cents" IS NULL OR "price_history"."price_cents" >= 0)
);
--> statement-breakpoint
CREATE INDEX `price_history_part_idx` ON `price_history` (`part_id`,`kind`,`valid_from`);--> statement-breakpoint
ALTER TABLE `boms` ADD `sale_price_cents` integer;--> statement-breakpoint
ALTER TABLE `parts` ADD `sale_price_cents` integer;--> statement-breakpoint
-- Data moves (hand-written): the preferred supplier's terms become its offer. The offer price starts
-- unknown, so draft POs keep using the standard cost until a supplier price is entered (D90).
INSERT INTO `part_suppliers` (`part_id`, `supplier_id`, `supplier_ref`, `price_cents`, `moq_milli`, `pack_size_milli`, `lead_days`, `created_by`, `updated_by`)
SELECT `id`, `supplier_id`, `supplier_ref`, NULL, `moq_milli`, `pack_size_milli`, `lead_days`, 'migration', 'migration'
FROM `parts` WHERE `supplier_id` IS NOT NULL;--> statement-breakpoint
-- The current standard costs open the price history, dated from the part's last update.
INSERT INTO `price_history` (`part_id`, `kind`, `price_cents`, `valid_from`, `source`, `created_by`, `updated_by`)
SELECT `id`, 'standard', `cost_cents`, substr(`updated_at`, 1, 10), 'migration', 'migration', 'migration'
FROM `parts` WHERE `cost_cents` IS NOT NULL;
