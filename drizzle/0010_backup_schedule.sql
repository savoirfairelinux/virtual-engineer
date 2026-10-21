ALTER TABLE `app_settings` ADD `backup_enabled` integer;--> statement-breakpoint
ALTER TABLE `app_settings` ADD `backup_interval_days` integer;--> statement-breakpoint
ALTER TABLE `app_settings` ADD `backup_time_of_day` text;--> statement-breakpoint
ALTER TABLE `app_settings` ADD `backup_retention_count` integer;