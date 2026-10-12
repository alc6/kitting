DROP INDEX `builds_part_serial_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `builds_part_serial_unique` ON `builds` (`part_id`,`serial`) WHERE serial IS NOT NULL AND status != 'cancelled';