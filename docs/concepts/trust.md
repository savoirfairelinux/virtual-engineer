# Trust boundaries

What the host holds and what the sandbox sees.

One rule explains the architecture: the host owns credentials and Git, the sandbox owns the agent.

## Host side

- Clone, checkout, commit, and push. Push and review credentials never enter a sandbox.
- Provider credentials, AES-256-GCM encrypted in SQLite and masked on every admin read. Plaintext credential writes are rejected.
- Skill installation, which happens before upload.

## Sandbox side

- The workspace, including `.git`, uploaded rather than mounted.
- The generated user prompt at `/tmp/user-prompt.txt`.
- Exactly one model credential, attached as a short-lived OpenShell provider rather than passed on argv.

`splitManagedProviderEnv()` fails closed on an unmapped variable whose name contains `TOKEN`, `SECRET`, `API_KEY`, `PASSWORD`, or `CREDENTIAL`, so a new secret cannot leak into a sandbox by omission.

The internal MCP server exposes only `ve_submit_review` or `ve_submit_changes` — no network tools, no database, no Docker socket.
