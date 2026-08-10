CREATE TABLE `managed_openshell_providers` (
	`provider_name` text PRIMARY KEY NOT NULL,
	`sandbox_name` text NOT NULL,
	`task_hash` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_managed_openshell_providers_created` ON `managed_openshell_providers` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_managed_openshell_providers_sandbox` ON `managed_openshell_providers` (`sandbox_name`);--> statement-breakpoint
CREATE TABLE `policy_denial_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` text,
	`project_id` text,
	`runtime` text DEFAULT '' NOT NULL,
	`category` text DEFAULT '' NOT NULL,
	`host` text DEFAULT '' NOT NULL,
	`method` text DEFAULT '' NOT NULL,
	`path` text DEFAULT '' NOT NULL,
	`decision` text DEFAULT 'deny' NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`task_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_policy_denials_task` ON `policy_denial_events` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_policy_denials_project` ON `policy_denial_events` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_policy_denials_created` ON `policy_denial_events` (`created_at`);--> statement-breakpoint
CREATE TABLE `runtime_policies` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`yaml` text DEFAULT '' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_runtime_policies_name` ON `runtime_policies` (`name`);--> statement-breakpoint
CREATE INDEX `idx_runtime_policies_kind` ON `runtime_policies` (`kind`);--> statement-breakpoint
CREATE TABLE `runtime_policy_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`policy_id` text NOT NULL,
	`kind` text NOT NULL,
	`project_id` text,
	`agent_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`policy_id`) REFERENCES `runtime_policies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chk_runtime_policy_binding_target" CHECK(("runtime_policy_bindings"."project_id" IS NOT NULL AND "runtime_policy_bindings"."agent_id" IS NULL) OR ("runtime_policy_bindings"."project_id" IS NULL AND "runtime_policy_bindings"."agent_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `idx_runtime_policy_bindings_policy` ON `runtime_policy_bindings` (`policy_id`);--> statement-breakpoint
CREATE INDEX `idx_runtime_policy_bindings_project` ON `runtime_policy_bindings` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_runtime_policy_bindings_agent` ON `runtime_policy_bindings` (`agent_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_runtime_policy_binding_project` ON `runtime_policy_bindings` (`policy_id`,`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_runtime_policy_binding_agent` ON `runtime_policy_bindings` (`policy_id`,`agent_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_runtime_policy_binding_project_kind` ON `runtime_policy_bindings` (`project_id`,`kind`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_runtime_policy_binding_agent_kind` ON `runtime_policy_bindings` (`agent_id`,`kind`);--> statement-breakpoint
-- Pre-ledger databases may hold several rows for one logical cycle (a running
-- row plus its final payload). Collapse them onto the first row so the cycle
-- keeps its original start time while carrying the latest payload, then drop
-- the surplus rows before the uniqueness rule is enforced.
UPDATE `agent_cycles` SET
  `agent_result` = (
    SELECT `latest`.`agent_result` FROM `agent_cycles` AS `latest`
    WHERE `latest`.`task_id` = `agent_cycles`.`task_id`
      AND `latest`.`cycle_number` = `agent_cycles`.`cycle_number`
    ORDER BY `latest`.`id` DESC LIMIT 1
  ),
  `validation_result` = (
    SELECT `latest`.`validation_result` FROM `agent_cycles` AS `latest`
    WHERE `latest`.`task_id` = `agent_cycles`.`task_id`
      AND `latest`.`cycle_number` = `agent_cycles`.`cycle_number`
    ORDER BY `latest`.`id` DESC LIMIT 1
  ),
  `agent_events` = (
    SELECT `latest`.`agent_events` FROM `agent_cycles` AS `latest`
    WHERE `latest`.`task_id` = `agent_cycles`.`task_id`
      AND `latest`.`cycle_number` = `agent_cycles`.`cycle_number`
    ORDER BY `latest`.`id` DESC LIMIT 1
  ),
  `cost_ai_credits` = (
    SELECT `latest`.`cost_ai_credits` FROM `agent_cycles` AS `latest`
    WHERE `latest`.`task_id` = `agent_cycles`.`task_id`
      AND `latest`.`cycle_number` = `agent_cycles`.`cycle_number`
    ORDER BY `latest`.`id` DESC LIMIT 1
  ),
  `cost_usd` = (
    SELECT `latest`.`cost_usd` FROM `agent_cycles` AS `latest`
    WHERE `latest`.`task_id` = `agent_cycles`.`task_id`
      AND `latest`.`cycle_number` = `agent_cycles`.`cycle_number`
    ORDER BY `latest`.`id` DESC LIMIT 1
  ),
  `premium_requests` = (
    SELECT `latest`.`premium_requests` FROM `agent_cycles` AS `latest`
    WHERE `latest`.`task_id` = `agent_cycles`.`task_id`
      AND `latest`.`cycle_number` = `agent_cycles`.`cycle_number`
    ORDER BY `latest`.`id` DESC LIMIT 1
  ),
  `cost_input_tokens` = (
    SELECT `latest`.`cost_input_tokens` FROM `agent_cycles` AS `latest`
    WHERE `latest`.`task_id` = `agent_cycles`.`task_id`
      AND `latest`.`cycle_number` = `agent_cycles`.`cycle_number`
    ORDER BY `latest`.`id` DESC LIMIT 1
  ),
  `cost_output_tokens` = (
    SELECT `latest`.`cost_output_tokens` FROM `agent_cycles` AS `latest`
    WHERE `latest`.`task_id` = `agent_cycles`.`task_id`
      AND `latest`.`cycle_number` = `agent_cycles`.`cycle_number`
    ORDER BY `latest`.`id` DESC LIMIT 1
  ),
  `cost_cached_tokens` = (
    SELECT `latest`.`cost_cached_tokens` FROM `agent_cycles` AS `latest`
    WHERE `latest`.`task_id` = `agent_cycles`.`task_id`
      AND `latest`.`cycle_number` = `agent_cycles`.`cycle_number`
    ORDER BY `latest`.`id` DESC LIMIT 1
  ),
  `cost_cache_write_tokens` = (
    SELECT `latest`.`cost_cache_write_tokens` FROM `agent_cycles` AS `latest`
    WHERE `latest`.`task_id` = `agent_cycles`.`task_id`
      AND `latest`.`cycle_number` = `agent_cycles`.`cycle_number`
    ORDER BY `latest`.`id` DESC LIMIT 1
  ),
  `cost_model_id` = (
    SELECT `latest`.`cost_model_id` FROM `agent_cycles` AS `latest`
    WHERE `latest`.`task_id` = `agent_cycles`.`task_id`
      AND `latest`.`cycle_number` = `agent_cycles`.`cycle_number`
    ORDER BY `latest`.`id` DESC LIMIT 1
  )
WHERE `id` IN (
  SELECT MIN(`id`) FROM `agent_cycles` GROUP BY `task_id`, `cycle_number`
);--> statement-breakpoint
DELETE FROM `agent_cycles` WHERE `id` NOT IN (
  SELECT MIN(`id`) FROM `agent_cycles` GROUP BY `task_id`, `cycle_number`
);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_agent_cycles_task_cycle` ON `agent_cycles` (`task_id`,`cycle_number`);