# Choose an agent engine

Pick by credential and model catalog.

Eight engines can execute a cycle. The choice affects authentication and model catalog, not the workflow.

- Pick by the credential you already have: an API key, a subscription OAuth flow, or a pasted access token.
- Aider, Goose, and OpenCode each wrap many LLM backends, so one integration can serve several models.
- The selected model lives on the `agents` table, not on the integration config.
- Copilot defaults to model `auto`; other CLIs pick their own default when no model is set.

Per-engine authentication and skill conventions are in the [engines hub](../hubs/engines.md).
