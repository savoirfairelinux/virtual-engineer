# System settings

Runtime-editable limits in app_settings.

Workflow limits are seeded from the environment but live in `app_settings`, editable at runtime under Configuration → System Settings with no restart.

| Name | Default | Description |
| --- | --- | --- |
| `POLLING_INTERVAL_MS` | 30 000 | Tick interval for the polling loop. |
| `MAX_AGENT_CYCLES` | 3 | Per-task cap for coding tasks. Exceeding it moves the task to FAILED. |
| `MAX_RETRY_ATTEMPTS` | 5 | Per-ticket cap. Polling skips a ticket once its failed and abandoned attempts reach it. |
| `AGENT_TIMEOUT_MS` | 3 600 000 | Host-side agent timeout, passed to the sandbox exec. |
| `TICKET_CLOSE_MAX_RETRIES` | 5 | Retry count for closing the ticket after MERGED. |
| `TICKET_CLOSE_RETRY_MIN_TIMEOUT_MS` | 5 000 | Minimum backoff between ticket-close retries. |
