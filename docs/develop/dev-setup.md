# Local setup

Run the orchestrator from a checkout.

Requires Node.js 22+, npm 10+, Docker 24+, OpenShell CLI 0.0.83, and a reachable OpenShell gateway.

```
npm install
cp .env.example .env
printf '\nADMIN_AUTH_SECRET=%s\n' "$(openssl rand -hex 32)" >> .env
npm run db:migrate
npm run build:ui
docker build -f Dockerfile.agent -t virtual-engineer-workspace:latest .
npm run dev
```

`npm run dev` starts the host orchestrator only. Set `OPENSHELL_GATEWAY` to an existing CLI profile, or `OPENSHELL_GATEWAY_ENDPOINT` to a reachable endpoint, before running it. Use `./scripts/start.sh` for the complete Docker/OpenShell path.
