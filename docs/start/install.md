# Install

The one-line installer and its pinning options.

```
curl -fsSL https://virtual-engineer.dev/install.sh | bash
```

The script clones the repository, writes `.env`, generates `ADMIN_AUTH_SECRET`, builds the agent and orchestrator images, starts local Keycloak when needed, starts the pinned OpenShell gateway, and launches the orchestrator.

## Pinned and reviewable installs

| Name | Description |
| --- | --- |
| `VE_INSTALL_DIR` | Target directory for the checkout. |
| `VE_REF` | Branch or tag to install. |
| `VE_EXPECTED_COMMIT` | Refuses to continue unless the checkout resolves to this commit. |

## You should end up with

An Admin UI on `http://127.0.0.1:3100/admin` asking you to create the first admin account. If it does not answer, go to [Troubleshooting](../operations/troubleshooting.md).

Next: [Run your first project](first-project.md).
