# Troubleshooting

Symptom, cause, fix.

| Symptom | Fix |
| --- | --- |
| Admin UI does not answer on 127.0.0.1:3100 | Check the orchestrator process and ADMIN_API_HOST. A non-loopback bind needs a reverse proxy in front of it. |
| Startup fails complaining about credentials | ADMIN_AUTH_SECRET is missing or changed while encrypted credentials exist. Restore the original secret; it cannot be recovered from the database. |
| No task is created from an assigned ticket | Confirm the project is enabled, the issue_tracking binding is scoped to the right ticket project key, and the ticket is assigned to the agent identity. |
| Tasks fail immediately in AGENT_RUNNING | Usually a sandbox policy denial or a missing engine credential. Read the harvested denials for that sandbox and re-test the integration connection. |
| A ticket stopped being picked up | Its failed and abandoned attempts reached MAX_RETRY_ATTEMPTS. Reset or raise the limit in System Settings. |
| Review comments flood a change | Raise REVIEW_MIN_SEVERITY before touching MAX_REVIEW_COMMENTS. |
