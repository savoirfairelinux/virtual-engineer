ALTER TABLE `agents` ADD `owner_user_id` text REFERENCES users(id);--> statement-breakpoint
CREATE INDEX `idx_agents_owner_user_id` ON `agents` (`owner_user_id`);--> statement-breakpoint
ALTER TABLE `integrations` ADD `owner_user_id` text REFERENCES users(id);--> statement-breakpoint
CREATE INDEX `idx_integrations_owner_user_id` ON `integrations` (`owner_user_id`);--> statement-breakpoint
ALTER TABLE `oauth_apps` ADD `owner_user_id` text REFERENCES users(id);--> statement-breakpoint
CREATE INDEX `idx_oauth_apps_owner_user_id` ON `oauth_apps` (`owner_user_id`);--> statement-breakpoint
ALTER TABLE `projects` ADD `owner_user_id` text REFERENCES users(id);--> statement-breakpoint
CREATE INDEX `idx_projects_owner_user_id` ON `projects` (`owner_user_id`);--> statement-breakpoint
ALTER TABLE `prompts` ADD `owner_user_id` text REFERENCES users(id);--> statement-breakpoint
CREATE INDEX `idx_prompts_owner_user_id` ON `prompts` (`owner_user_id`);