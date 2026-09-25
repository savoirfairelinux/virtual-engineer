CREATE TABLE `auth_source_group_mappings` (
	`id` text PRIMARY KEY NOT NULL,
	`auth_source_id` text NOT NULL,
	`external_group` text NOT NULL,
	`group_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`auth_source_id`) REFERENCES `auth_sources`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_auth_source_group_mappings_group_id` ON `auth_source_group_mappings` (`group_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_auth_source_group_mappings` ON `auth_source_group_mappings` (`auth_source_id`,`external_group`,`group_id`);--> statement-breakpoint
CREATE TABLE `user_identity_groups` (
	`identity_id` text NOT NULL,
	`external_group` text NOT NULL,
	`synced_at` integer NOT NULL,
	PRIMARY KEY(`identity_id`, `external_group`),
	FOREIGN KEY (`identity_id`) REFERENCES `user_identities`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_user_identity_groups_external_group` ON `user_identity_groups` (`external_group`);--> statement-breakpoint
ALTER TABLE `auth_sources` ADD `auto_provision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `auth_sources` ADD `default_role` text DEFAULT 'viewer' NOT NULL;