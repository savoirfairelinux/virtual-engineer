# First project

From an assigned ticket to a change under review.

Everything below happens in the authenticated Admin UI. Nothing is configured through files.

1Add an agent integration and test its connection.

2Add an issue-tracker integration and a source-control integration.

3Create an agent, then select its model and its system and instructions prompts.

4Create a project, bind its repository, branch, integrations, and agent.

5Enable the project, then assign a ticket to the agent.

## You should end up with

A task appearing on the polling tick, walking from `DETECTED` to `IN_REVIEW`, and a change opened on your review system. If it stops earlier, open the task and read its transitions — see [Debug a task](../operations/debug.md).
