# Security

Credentials at rest, exposure, audit, disclosure.

The agent runs with the least access it needs: an ephemeral sandbox per cycle, no push or review credentials inside it, and a record of everything it did.

## Credentials at rest

- Provider credentials are AES-256-GCM encrypted in SQLite under `ADMIN_AUTH_SECRET` and masked on every admin read.
- Plaintext credential writes are rejected.
- Webhook secrets are not readable after creation; rotation is per integration.
- Startup fails closed when encrypted credentials exist without the secret.

## Exposure

The Admin UI binds to `127.0.0.1` by default. Put it behind a trusted reverse proxy before exposing it, and only enable `ADMIN_TRUST_PROXY` when that proxy overwrites inbound forwarding headers.

## Audit

Every state transition, including pause and resume, is an appended `state_transitions` row. Nothing in the task lifecycle is edited in place.

## Reporting a vulnerability

Report privately to `contact@savoirfairelinux.com` rather than a public issue. Reports are acknowledged within 48 hours and assessed within 7 days.
