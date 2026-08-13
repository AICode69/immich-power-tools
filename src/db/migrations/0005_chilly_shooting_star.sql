CREATE TABLE `face_label_index_meta` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`built_at` integer,
	`assets_scanned` integer DEFAULT 0 NOT NULL,
	`tokens_learned` integer DEFAULT 0 NOT NULL,
	`named_people_seen` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `face_label_index_meta_owner_id_unique` ON `face_label_index_meta` (`owner_id`);--> statement-breakpoint
CREATE TABLE `face_label_skips` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`person_id` text NOT NULL,
	`skipped_at` integer
);
--> statement-breakpoint
CREATE INDEX `face_label_skips_owner_idx` ON `face_label_skips` (`owner_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `face_label_skips_owner_id_person_id_unique` ON `face_label_skips` (`owner_id`,`person_id`);--> statement-breakpoint
CREATE TABLE `face_label_token_totals` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`source` text NOT NULL,
	`token` text NOT NULL,
	`total_assets` integer DEFAULT 0 NOT NULL,
	`library_share_pct` real DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `face_label_token_totals_lookup_idx` ON `face_label_token_totals` (`owner_id`,`source`,`token`);--> statement-breakpoint
CREATE UNIQUE INDEX `face_label_token_totals_owner_id_source_token_unique` ON `face_label_token_totals` (`owner_id`,`source`,`token`);--> statement-breakpoint
CREATE TABLE `face_label_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`source` text NOT NULL,
	`token` text NOT NULL,
	`person_id` text NOT NULL,
	`asset_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `face_label_tokens_lookup_idx` ON `face_label_tokens` (`owner_id`,`source`,`token`);--> statement-breakpoint
CREATE UNIQUE INDEX `face_label_tokens_owner_id_source_token_person_id_unique` ON `face_label_tokens` (`owner_id`,`source`,`token`,`person_id`);