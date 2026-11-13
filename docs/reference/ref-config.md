# Environment variables

Every variable, its default and its effect.

Environment variables carry system and infrastructure settings only. All provider configuration lives in the `integrations` table. Configuration is Zod-validated once at boot and throws listing every offending field; empty strings are preprocessed to `undefined`, so `FIELD=""` does not poison an optional setting.

| Name | Default | Description |
| --- | --- | --- |
| `DATABASE_PATH` | ./data/virtual-engineer.db | SQLite file path. WAL mode. |
| `ADMIN_API_HOST` | 127.0.0.1 | Bind host. Keep the Admin UI on loopback unless it sits behind a trusted reverse proxy. |
| `ADMIN_API_PORT` | 3100 | Admin server port. |
| `ADMIN_AUTH_SECRET` | required | Encrypts provider credentials at rest. Minimum 32 characters; generate with openssl rand -hex 32. |
| `ADMIN_TRUST_PROXY` | false | Derive the client IP from X-Forwarded-For. Only behind a proxy that overwrites inbound forwarding headers. |
| `AGENT_CONTAINER_IMAGE` | virtual-engineer-workspace:latest | Image the sandbox is created from. Must contain a sandbox user whose home is /sandbox. |
| `WORKSPACE_BASE_DIR` | /tmp/virtual-engineer/workspaces | Host scratch directory for the per-task workspace. No named volumes or bind mounts. |
| `OPENSHELL_COMPUTE_DRIVER` | docker | Sandbox compute driver. kubernetes is experimental. |
| `MAX_COMMITS_PER_CYCLE` | 10 | Upper bound on commits the agent may create in one cycle. |
