# Add an integration

Credentials, validation, and hot refresh.

Add the integration first, test its connection, and only then bind it to a project. An integration that fails its validator will fail the same way inside a cycle.

- Credentials are encrypted on write and masked on every read. You cannot retrieve one after saving it.
- Webhook secrets cannot be read back after creation. Rotation is per integration.
- Multiple active integrations of the same provider run in parallel, each addressable by its `integrationId`.
- Runtime dependencies hot-refresh after a change, so no restart is needed.

Provider-specific notes are in the [providers hub](../hubs/providers.md).
