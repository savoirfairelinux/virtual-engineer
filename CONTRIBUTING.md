# Contributing to Virtual Engineer

Thank you for your interest in contributing! This document covers how to set up your environment, follow project conventions, and submit changes.

## Table of Contents

- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Development Workflow](#development-workflow)
- [Code Conventions](#code-conventions)
- [Commit Messages](#commit-messages)
- [Adding a New Integration](#adding-a-new-integration)
- [Pull Request Guidelines](#pull-request-guidelines)

---

## Getting Started

1. **Fork** the repository on GitHub
2. **Clone** your fork: `git clone git@github.com:<your-user>/virtual-engineer.git`
3. **Create a branch**: `git checkout -b feature/my-change`
4. Make your changes following the conventions below
5. Open a **Pull Request** against `main`

---

## Development Setup

### Prerequisites

| Tool | Minimum | Notes |
|------|---------|-------|
| Node.js | 20 LTS | Orchestrator runtime |
| Docker | 24 | Agent container execution |
| GitHub Copilot | — | Required for code-gen/review tasks (Copilot subscription) |
| Claude | — | Alternative agent engine — Anthropic API key or Claude Pro/Max subscription (optional) |

```bash
npm install
cp .env.example .env
printf 'ADMIN_AUTH_SECRET=%s\n' "$(openssl rand -hex 32)" >> .env
npm run db:migrate
docker build -f Dockerfile.agent -t virtual-engineer-workspace:latest .
npm run dev                  # starts orchestrator at http://127.0.0.1:3100/admin
npm run build:ui             # build the admin React SPA (required for production)
```

---

## Development Workflow

This project follows **TDD practices** — add or update tests for every change.

```bash
npm test                     # Vitest unit + integration tests — must pass
npm run typecheck            # zero TypeScript errors (runs both tsconfig.json + tsconfig.agent.json)
npm run lint                 # zero ESLint errors
npm run dev                  # start orchestrator locally
npm run build:ui             # build admin React SPA (Vite)
npm run typecheck:ui         # TypeScript check for the admin UI (tsconfig.admin-ui.json)
npm run db:migrate           # apply Drizzle migrations after schema changes
```

All three gates (`npm test`, `npm run typecheck`, `npm run lint`) must pass before opening a PR.

---

## Code Conventions

### TypeScript

- **ESM with NodeNext** — imports require the `.js` suffix (`from "./foo.js"`)
- **Strict mode**: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`
- **No `any`** in `src/` — use `unknown` + type guards
- **Optional props**: declare `T | undefined` explicitly; use conditional spreading (`...(x !== undefined ? { x } : {})`) rather than `x: x ?? undefined`
- **Unused locals/params** must be `_`-prefixed

### General

- Do not add env-var-driven provider settings — extend the relevant integration descriptor or the `agents`/`projects` tables instead
- Provider config lives exclusively in the database; do not hardcode credentials
- All external I/O (fetch, fs, Docker, SDK) must be mocked in unit tests via `vi.mock`/`vi.spyOn`
- Avoid over-engineering — only make changes that are directly required

---

## Commit Messages

This project uses **Conventional Commits** (Gerrit-friendly format):

```
<type>(<scope>): <subject ≤50 chars>

<body lines ≤72 chars>
```

**Types**: `feat`, `fix`, `test`, `refactor`, `perf`, `docs`, `chore`, `ci`

**Scopes**: `orchestrator`, `polling-loop`, `state`, `gerrit`, `redmine`, `gitlab`, `agent`, `copilot-cli`, `vcs`, `plugins`, `admin`, `dashboard`, `prompts`, `config`, `workspace`, `db`

---

## Adding a New Integration

1. Create a **descriptor** in `src/plugins/descriptors/<name>.ts`  
2. Register it in `src/plugins/registry.ts`  
3. Add a **connector** in `src/connectors/<name>Connector.ts`  
4. Update `.github/context/modules/connectors.md` and `plugins.md`  
5. Add unit tests covering the connector and descriptor  

See existing descriptors (e.g. `src/plugins/descriptors/gitlab.ts`) for the expected shape.

---

## Pull Request Guidelines

- Keep PRs **focused** — one logical change per PR
- Reference any related issue in the PR description
- Ensure the CI gates pass (typecheck, lint, tests)
- Update relevant docs in `.github/context/` in the same commit as code changes
- Security-sensitive changes should be discussed via private advisory first (see [SECURITY.md](SECURITY.md))
