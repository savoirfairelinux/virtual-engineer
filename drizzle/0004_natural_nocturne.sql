CREATE TABLE `auth_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`priority` integer DEFAULT 100 NOT NULL,
	`config_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "chk_auth_sources_kind" CHECK("auth_sources"."kind" IN ('ldap'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_sources_name_unique` ON `auth_sources` (`name`);