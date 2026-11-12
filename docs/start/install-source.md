# Install from source

Existing checkout, .env, and start.sh.

```
cp .env.example .env
printf '\nADMIN_AUTH_SECRET=%s\n' "$(openssl rand -hex 32)" >> .env
./scripts/start.sh
```

`start.sh` owns the complete self-hosted path: it builds both images, brings up the OpenShell gateway with its compute driver, and starts the orchestrator wired to it.

## Keep the secret stable

`ADMIN_AUTH_SECRET` encrypts provider credentials at rest with AES-256-GCM. It must be at least 32 characters, and startup fails closed if encrypted credentials exist and the secret is missing. Rotating it invalidates every stored credential.

For a development loop instead of a deployment, see [Local setup](../develop/dev-setup.md).
