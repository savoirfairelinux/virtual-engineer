CREATE TABLE `agent_cycles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` text NOT NULL,
	`cycle_number` integer NOT NULL,
	`agent_result` text NOT NULL,
	`validation_result` text,
	`agent_events` text,
	`cost_ai_credits` real,
	`cost_usd` real,
	`premium_requests` real,
	`cost_input_tokens` integer,
	`cost_output_tokens` integer,
	`cost_cached_tokens` integer,
	`cost_cache_write_tokens` integer,
	`cost_model_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`task_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_agent_cycles_task_id` ON `agent_cycles` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_cycles_created_at` ON `agent_cycles` (`created_at`);--> statement-breakpoint
CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`model_config_json` text DEFAULT '{}' NOT NULL,
	`integration_id` text,
	`system_prompt_id` text,
	`instructions_prompt_id` text,
	`feedback_instructions_prompt_id` text,
	`max_concurrent` integer DEFAULT 1 NOT NULL,
	`enabled` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`integration_id`) REFERENCES `integrations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`system_prompt_id`) REFERENCES `prompts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`instructions_prompt_id`) REFERENCES `prompts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`feedback_instructions_prompt_id`) REFERENCES `prompts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_agents_name` ON `agents` (`name`);--> statement-breakpoint
CREATE INDEX `idx_agents_enabled` ON `agents` (`enabled`);--> statement-breakpoint
CREATE TABLE `app_concurrency` (
	`id` text PRIMARY KEY NOT NULL,
	`max_concurrent` integer,
	`updated_at` integer NOT NULL,
	CONSTRAINT "chk_app_concurrency_singleton" CHECK("app_concurrency"."id" = 'global')
);
--> statement-breakpoint
CREATE TABLE `app_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`polling_interval_ms` integer,
	`max_agent_cycles` integer,
	`max_retry_attempts` integer,
	`agent_timeout_ms` integer,
	`updated_at` integer NOT NULL,
	CONSTRAINT "chk_app_settings_singleton" CHECK("app_settings"."id" = 'global')
);
--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`actor_user_id` text,
	`actor_name` text NOT NULL,
	`action` text NOT NULL,
	`target_type` text,
	`target_id` text,
	`details_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_audit_log_created_at` ON `audit_log` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_audit_log_action_created_at` ON `audit_log` (`action`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_audit_log_actor_created_at` ON `audit_log` (`actor_name`,`created_at`);--> statement-breakpoint
CREATE TABLE `change_per_repository` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`repo_key` text NOT NULL,
	`change_id` text NOT NULL,
	`review_url` text,
	`status` text DEFAULT 'OPEN' NOT NULL,
	`integration_id` text DEFAULT '' NOT NULL,
	`review_system` text DEFAULT '' NOT NULL,
	`commit_index` integer DEFAULT 0 NOT NULL,
	`subject_hash` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`task_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_change_per_repo_task_id` ON `change_per_repository` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_change_per_repo_task_repo` ON `change_per_repository` (`task_id`,`repo_key`);--> statement-breakpoint
CREATE TABLE `gitlab_oauth_apps` (
	`base_url` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `group_members` (
	`group_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`group_id`, `user_id`),
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_group_members_user_id` ON `group_members` (`user_id`);--> statement-breakpoint
CREATE TABLE `groups` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `groups_name_unique` ON `groups` (`name`);--> statement-breakpoint
CREATE TABLE `integrations` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`name` text NOT NULL,
	`config_json` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`discovered_resources_json` text,
	`discovered_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `oauth_apps` (
	`provider` text NOT NULL,
	`base_url` text NOT NULL,
	`client_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`provider`, `base_url`)
);
--> statement-breakpoint
CREATE TABLE `policies` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`builtin` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `policies_name_unique` ON `policies` (`name`);--> statement-breakpoint
CREATE TABLE `policy_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`policy_id` text NOT NULL,
	`principal_type` text NOT NULL,
	`principal_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`policy_id`) REFERENCES `policies`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_policy_bindings_principal` ON `policy_bindings` (`principal_type`,`principal_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_policy_bindings` ON `policy_bindings` (`policy_id`,`principal_type`,`principal_id`);--> statement-breakpoint
CREATE TABLE `policy_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`policy_id` text NOT NULL,
	`permission` text NOT NULL,
	`resource_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`policy_id`) REFERENCES `policies`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_policy_rules_policy_id` ON `policy_rules` (`policy_id`);--> statement-breakpoint
CREATE INDEX `idx_policy_rules_permission` ON `policy_rules` (`permission`);--> statement-breakpoint
CREATE TABLE `posted_review_comments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` text NOT NULL,
	`change_id` text NOT NULL,
	`comment_hash` text NOT NULL,
	`file` text NOT NULL,
	`line` integer DEFAULT 0 NOT NULL,
	`message` text DEFAULT '' NOT NULL,
	`severity` text DEFAULT '' NOT NULL,
	`provider_thread_id` text,
	`resolved` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`task_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_posted_review_comments_task_id` ON `posted_review_comments` (`task_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_posted_review_comments_task_hash` ON `posted_review_comments` (`task_id`,`comment_hash`);--> statement-breakpoint
CREATE TABLE `processed_comments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` text NOT NULL,
	`gerrit_comment_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`task_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_processed_comments_task_id` ON `processed_comments` (`task_id`);--> statement-breakpoint
CREATE TABLE `project_integration_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`integration_id` text NOT NULL,
	`capability` text NOT NULL,
	`config_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`integration_id`) REFERENCES `integrations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_pib_project_id` ON `project_integration_bindings` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_pib_capability` ON `project_integration_bindings` (`capability`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_pib_project_capability` ON `project_integration_bindings` (`project_id`,`capability`);--> statement-breakpoint
CREATE TABLE `project_push_targets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` text NOT NULL,
	`integration_id` text NOT NULL,
	`repo_key` text NOT NULL,
	`clone_url` text NOT NULL,
	`target_branch` text NOT NULL,
	`role` text NOT NULL,
	`commit_order` integer NOT NULL,
	`local_path` text NOT NULL,
	`ssh_key_path` text,
	`reviewer_emails` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`integration_id`) REFERENCES `integrations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_ppt_project_id` ON `project_push_targets` (`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_ppt_project_repo` ON `project_push_targets` (`project_id`,`repo_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_ppt_project_order` ON `project_push_targets` (`project_id`,`commit_order`);--> statement-breakpoint
CREATE TABLE `project_vendor_components` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` text NOT NULL,
	`source_path` text NOT NULL,
	`local_path` text,
	`clone_url` text,
	`revision` text,
	`origin` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_pvc_project_source_local` ON `project_vendor_components` (`project_id`,`source_path`,case when "local_path" is null then '' else "local_path" end);--> statement-breakpoint
CREATE INDEX `idx_pvc_project_id` ON `project_vendor_components` (`project_id`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`agent_id` text NOT NULL,
	`agent_override_json` text,
	`post_clone_script` text DEFAULT '' NOT NULL,
	`skill_sources_json` text DEFAULT '[]' NOT NULL,
	`gerrit_topic_override` text,
	`use_full_ticket_url_in_commits` integer DEFAULT 0 NOT NULL,
	`post_review_link_to_ticket` integer DEFAULT 0 NOT NULL,
	`react_to_ci_failures` integer DEFAULT 0 NOT NULL,
	`enabled` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_projects_name` ON `projects` (`name`);--> statement-breakpoint
CREATE INDEX `idx_projects_enabled` ON `projects` (`enabled`);--> statement-breakpoint
CREATE TABLE `prompts` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`content` text NOT NULL,
	`prompt_type` text DEFAULT 'instructions' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `review_thread_replies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` text NOT NULL,
	`change_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`handled_comment_hash` text NOT NULL,
	`reply_message` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`task_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_review_thread_replies_task_id` ON `review_thread_replies` (`task_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_review_thread_replies_task_thread_hash` ON `review_thread_replies` (`task_id`,`thread_id`,`handled_comment_hash`);--> statement-breakpoint
CREATE TABLE `state_transitions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` text NOT NULL,
	`from_state` text NOT NULL,
	`to_state` text NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`task_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_state_transitions_task_id` ON `state_transitions` (`task_id`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`task_id` text PRIMARY KEY NOT NULL,
	`ticket_id` text NOT NULL,
	`ticket_source_label` text DEFAULT 'redmine' NOT NULL,
	`ticket_title` text DEFAULT '' NOT NULL,
	`ticket_description` text DEFAULT '' NOT NULL,
	`state` text DEFAULT 'DETECTED' NOT NULL,
	`task_type` text DEFAULT 'code-gen' NOT NULL,
	`gerrit_change_id` text,
	`current_patchset` integer DEFAULT 0 NOT NULL,
	`reviewed_patchset` integer,
	`cycle_count` integer DEFAULT 0 NOT NULL,
	`failure_reason` text,
	`ticket_url` text,
	`review_url` text,
	`project_id` text,
	`ticket_source_integration_id` text,
	`ticket_source_project_key` text,
	`display_id` text,
	`push_ref` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_tasks_ticket_id` ON `tasks` (`ticket_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_tasks_active_ticket_id` ON `tasks` (`project_id`,`ticket_id`) WHERE "tasks"."state" NOT IN ('DONE', 'FAILED', 'ABANDONED', 'REVIEW_DONE', 'REVIEW_FAILED');--> statement-breakpoint
CREATE UNIQUE INDEX `idx_tasks_active_ticket_id_noproject` ON `tasks` (`ticket_id`) WHERE "tasks"."project_id" IS NULL AND "tasks"."state" NOT IN ('DONE', 'FAILED', 'ABANDONED', 'REVIEW_DONE', 'REVIEW_FAILED');--> statement-breakpoint
CREATE TABLE `user_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`token_hash` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_sessions_token_hash_unique` ON `user_sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_user_sessions_user_id` ON `user_sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`role` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);