ALTER TABLE `auth_sources` ADD `session_max_age_hours` integer DEFAULT 24 NOT NULL;--> statement-breakpoint
ALTER TABLE `auth_sources` ADD `revalidate_interval_minutes` integer DEFAULT 15 NOT NULL;--> statement-breakpoint
ALTER TABLE `user_sessions` ADD `validated_at` integer;