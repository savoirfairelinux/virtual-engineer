# Requirements

What the host needs before you install.

## Host requirements

- Git, curl, and OpenSSL on the host.
- Docker 24 or later, with a running daemon. The default OpenShell compute driver is Docker; Kubernetes is experimental.
- Node.js 20 LTS for a packaged run, Node.js 22+ and npm 10+ for local development.
- OpenShell CLI 0.0.83 and a reachable gateway when you run the orchestrator outside `start.sh`.

## What you also need

One agent-engine credential, and access to whichever ticket tracker, source-control, and review systems the project should use. Everything else is configured later from the Admin UI.
