DROP INDEX `face_label_skips_owner_id_person_id_unique`;--> statement-breakpoint
DROP INDEX `face_label_skips_owner_idx`;--> statement-breakpoint
ALTER TABLE `face_label_skips` ADD `kind` text DEFAULT 'cluster' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `face_label_skips_owner_id_kind_person_id_unique` ON `face_label_skips` (`owner_id`,`kind`,`person_id`);--> statement-breakpoint
CREATE INDEX `face_label_skips_owner_idx` ON `face_label_skips` (`owner_id`,`kind`);