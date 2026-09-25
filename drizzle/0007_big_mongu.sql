CREATE TABLE `user_identities` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`auth_source_id` text NOT NULL,
	`external_subject` text NOT NULL,
	`external_username` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_login_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`auth_source_id`) REFERENCES `auth_sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_identities_user_id_unique` ON `user_identities` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_user_identities_source_subject` ON `user_identities` (`auth_source_id`,`external_subject`);