# Virtual Engineer

A self-hosted orchestrator that turns assigned tickets into changes under review, and reviews incoming changes on its own.

```
curl -fsSL https://virtual-engineer.dev/install.sh | bash
```

The installer creates `.env`, generates `ADMIN_AUTH_SECRET`, builds the images, starts the OpenShell gateway, and launches the orchestrator. Then open `http://127.0.0.1:3100/admin` and create the first admin account.

## Read the docs by audience

- [Get started](start/index.md) and [Guides](guides/index.md) are for people running Virtual Engineer.
- [Concepts](concepts/index.md) and [Reference](reference/index.md) explain the system and list every value it accepts.
- [Develop](develop/index.md) is for contributors working on the codebase itself.
