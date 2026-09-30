# 🤖 Virtual Engineer

**Turn tickets and review events into isolated, traceable AI engineering workflows.**

Virtual Engineer is a self-hosted orchestrator that runs AI agents against real
repositories while keeping Git and code-review credentials on the host.

## 🔄 What It Does

| Workflow | Input | Result |
| --- | --- | --- |
| **Coding** | An assigned issue-tracker ticket | Agent commits pushed for review, with feedback cycles |
| **Review** | A new patchset, merge request, or pull request | Inline findings, discussion replies, and a review decision |

Every cycle runs in an ephemeral OpenShell sandbox. The host performs the Git
clone and push operations; the sandbox is destroyed after the cycle.

## 🔌 Supported Systems

| Capability | Providers |
| --- | --- |
| Agent execution | GitHub Copilot, Claude Code, Aider, Goose, Codex, Gemini CLI, OpenCode, Cursor |
| Issue tracking | Redmine, GitLab Issues, GitHub Issues |
| Source control and code review | Gerrit, GitLab Merge Requests, GitHub Pull Requests |

Provider configuration, projects, agents, prompts, permissions, runtime
settings, costs, and task history are managed from the authenticated Admin UI
and stored in SQLite. Provider credentials and other secret fields are
encrypted at rest.

## 🚀 Quick Start

The installer builds the agent and orchestrator images, starts local Keycloak
when needed, starts the pinned OpenShell gateway, and launches the orchestrator.

Requirements: Git, curl, OpenSSL, Node.js 22+, Docker 24+, and a running Docker daemon.

```bash
curl -fsSL https://virtual-engineer.dev/install.sh | bash
```

The installer clones the repository into `./virtual-engineer` (or reuses the
current directory when it already is a checkout), then delegates setup and
startup to `scripts/start.sh`. Setup generates only missing secrets for a fresh
instance, stores them with private permissions, and never prints their values.
Existing values are preserved. Use `bash scripts/start.sh --setup-only` to
provision without starting the services. Normal startup performs the same
idempotent setup and refuses to invent replacements if an initialized instance
is missing a key. The installer supports `VE_REF` and `VE_EXPECTED_COMMIT`; see
the [installer script](scripts/install.sh) for reviewable and pinned-install
flows.

Managed local Keycloak bootstrap state is stored outside the checkout by
default, under `$XDG_STATE_HOME/virtual-engineer/local-oidc/` or
`$HOME/.local/state/virtual-engineer/local-oidc/`. This keeps the OIDC secret
aligned with the persistent Docker realm when the repository is replaced.
Existing `data/local-oidc/` files are migrated automatically. Set
`OPENSHELL_STATE_DIR` to use a different persistent location; startup fails
when none of `OPENSHELL_STATE_DIR`, `XDG_STATE_HOME`, or `HOME` is set, rather
than falling back to the replaceable checkout.

Open the Admin UI at [http://127.0.0.1:3100/admin](http://127.0.0.1:3100/admin),
create the first admin account, and configure the integrations and projects.

For an existing checkout, use `--setup-only` to provision without starting the
services, or let the normal launcher do both. Setup seeds `.env` from
`.env.example` when missing, fills missing defaults in a partial file without
replacing configured values, and protects it with mode `0600`:

```bash
./scripts/start.sh --setup-only
./scripts/start.sh
```

After creating the first admin account, the Admin UI offers an explicit reveal
of newly generated secrets and any existing keyring found during the first
instance setup. Copy the pending values to protected recovery storage before
acknowledging the dialog. Setup and normal startup never print secret contents
to the terminal.

The default deployment uses Docker for OpenShell sandboxes. Kubernetes is an
experimental alternative; see the [Kubernetes deployment guide](deploy/k8s/README.md).

## 🧭 First Workflow

1. Add and test an agent integration.
2. Add an issue-tracker integration for coding, or a review integration for review tasks.
3. Create an agent and select its model and prompts.
4. Create a project, bind its repository, branch, integrations, and agent, then enable it.

Coding projects pick up assigned tickets. Review projects receive Gerrit
stream events or GitLab/GitHub webhook events and do not require an issue tracker.

## 🛠️ Local Development

Requirements: Node.js 22+, npm 10+, Docker 24+, OpenShell CLI 0.0.83, and a
reachable OpenShell gateway.

```bash
npm install
cp .env.example .env
printf '\nADMIN_AUTH_SECRET=%s\n' "$(openssl rand -hex 32)" >> .env
npm run db:migrate
npm run build:ui
docker build -f Dockerfile.agent -t virtual-engineer-workspace:latest .
npm run dev
```

The explicit secret command above is for direct `npm run dev` use; unlike the
Docker launcher, that development command does not create or persist secrets.
`npm run dev` starts the host orchestrator only. Configure
`OPENSHELL_GATEWAY` with an existing CLI profile or
`OPENSHELL_GATEWAY_ENDPOINT` with a reachable endpoint before running it.
Use `./scripts/start.sh` for the complete containerized path.

See [CONTRIBUTING.md](CONTRIBUTING.md) for tests, type-checking, linting, and
database workflow.

## Backups and recovery

Open **Configuration → Backups** to set a UTC schedule, run a backup now, and
list, download, or delete local archives. Scheduling is disabled by default;
the default schedule is daily at `03:00` UTC with seven retained archives.
`BACKUP_DIR` defaults to a `backups/` directory beside `DATABASE_PATH` (for the
Docker launcher, `/app/data/backups`). Local retention is not off-machine
recovery: download archives or copy them to independent storage.

New archives use the `.tar.gz.enc` suffix and are streamed through AES-256-GCM.
Set `BACKUP_KEYRING_FILE` to a protected JSON keyring outside `DATA_DIR` and
`BACKUP_DIR`; `scripts/start.sh` mounts it read-only. On a normal Docker
startup, the launcher creates a default keyring automatically if this variable
is unset. Keep the keyring separate from the archives and preserve old keys
until every archive using them has expired or been re-encrypted. Existing
plaintext `.tar.gz` archives remain restorable. See [SECURITY.md](SECURITY.md)
and the [configuration reference](.github/context/configuration.md) for key
handling.
On a normal Docker start, `ADMIN_AUTH_SECRET` is also generated and persisted in
`.env` when missing or empty; the same value is reused on later starts. It is
separate from the keyring, and a restore never invents a replacement for either
key. After first admin login, the UI can explicitly reveal setup values still
pending recovery: a newly generated `ADMIN_AUTH_SECRET` or keyring, and an
existing keyring found during first instance provisioning. Copy or download
each pending value separately before acknowledging. Direct `npm run dev` runs
and Kubernetes deployments must provide both values through their supported
configuration.
Archive encryption does not encrypt the active SQLite file or temporary
plaintext staging: put `DATA_DIR` on encrypted host storage (or use a verified
encrypted CSI StorageClass for Kubernetes).

### Docker: automatic keyring setup

No JSON editing is needed. Run `./scripts/start.sh --setup-only` after cloning,
or use the normal `./scripts/start.sh` launcher. When `BACKUP_KEYRING_FILE` is
unset, setup generates a random 32-byte key in
`${XDG_CONFIG_HOME:-$HOME/.config}/virtual-engineer/backup-keyring.json`. It
creates the directory with mode `0700`, the file with mode `0600`, reuses an
existing file without replacing it, persists the path in `.env`, and mounts it
read-only as `/app/backup-keyring.json`. The first creation prints only the file
path and reminds you to keep a protected recovery copy. If a keyring already
exists when a new instance is first provisioned, the launcher keeps it unchanged
and marks it for the same explicit first-admin reveal. The superuser-only UI
requires acknowledgement after every pending value is saved. The launcher uses
Node.js's built-in cryptographic random generator.

You can set `BACKUP_KEYRING_FILE` in `.env` to use an existing keyring at an
absolute path outside `DATA_DIR` and `BACKUP_DIR`; `.env` contains only the path,
never the JSON contents or raw key. Do not delete or replace the keyring while
encrypted archives still need to be restored. Losing it makes those archives
unrecoverable; preserve the original `ADMIN_AUTH_SECRET` separately as well.
Restore of a new archive requires both keys.

The launcher deliberately does not generate a replacement keyring for
`./scripts/start.sh --restore`: encrypted archives require their original
keyring. Legacy plaintext `.tar.gz` archives remain restorable without it; a
normal launcher start after the restore will create a default keyring if none
is configured. Confirm setup by running a backup from **Configuration →
Backups** and checking that its filename ends in `.tar.gz.enc`. Test restoration
on a disposable instance before relying on backups; do not use the live
`DATA_DIR` for a drill. Existing plaintext `.tar.gz` archives are not converted
automatically.

### Rotate the key

For a single-host install, do not rotate on a calendar; rotate after suspected
key exposure or when policy requires it. Generate the value without printing
it (`NEW_KEY="$(openssl rand -hex 32)"`), choose a new unique key ID, add the
new ID/value to the keyring's `keys` object, and make that ID the new
`activeKeyId`. Do not run `openssl rand -hex 32` by itself, because it prints
the key. Keep all old entries so retained archives remain restorable. After
replacing the keyring file, recreate the Docker container so the read-only file
mount sees the updated file:

```bash
docker rm -f ve-orchestrator
./scripts/start.sh
```

This briefly stops the orchestrator but leaves its bind-mounted `DATA_DIR` in
place. Remove an old key only after every archive encrypted with it has expired
or been re-encrypted and a restore drill has succeeded.

An archive contains an online SQLite snapshot, a verification manifest, and
allowed prompt override Markdown files. Active admin sessions are not retained.
It does **not** contain the backup keyring, `ADMIN_AUTH_SECRET`, OpenShell/managed
OIDC state, or ephemeral workspaces. Restoring an encrypted archive requires
both the matching keyring and original `ADMIN_AUTH_SECRET`; legacy plaintext
`.tar.gz` archives require the original admin secret only. Runtime/OIDC settings
must be separately preserved or reconfigured.

### Restore to a new Docker instance

1. Copy the archive and required recovery files to the new host. Keep the
	original `ADMIN_AUTH_SECRET`. For `.tar.gz.enc` archives, also copy the
	original keyring file with every old key needed by retained archives.
2. Before starting Virtual Engineer, prepare `.env`. If it does not exist, seed
	it from the example and protect it:

	```bash
	cp .env.example .env
	chmod 0600 .env
	```

	Set `ADMIN_AUTH_SECRET` to its exact value from the original instance. For an
	encrypted archive, set `BACKUP_KEYRING_FILE` to the absolute path of the
	copied keyring file. Keep the keyring outside `DATA_DIR` and `BACKUP_DIR`,
	and do not put its contents in `.env`. Replace existing assignments rather
	than adding duplicate lines. For a legacy `.tar.gz` archive, the keyring is
	not required.
3. Use a new, empty `DATA_DIR` for a separate restore target. Do not run the
	normal launcher or `--setup-only` first: they may create new secrets and
	database state that do not match the archive.
4. Run the restore directly. The script asks for confirmation, mounts the
	archive read-only, restores before opening SQLite, and starts the instance:

```bash
BACKUP_ARCHIVE=/secure/path/ve-backup-20260924T030000000Z-a1b2c3d4.tar.gz.enc
./scripts/start.sh --restore "$BACKUP_ARCHIVE"
```

Do not use `--force` when the new `DATA_DIR` is empty. If the target already
contains a database or prompt data, `--force` preserves those targets in a
`.pre-restore-*` directory before restoring:

```bash
./scripts/start.sh --restore "$BACKUP_ARCHIVE" --force
```

The launcher uses the fixed container name `ve-orchestrator`; restoring on a
host with an existing instance stops and replaces that container. Use a
different Docker host if both instances must keep running. After restore, log
in with the existing Admin account; active sessions were not included. Verify
the integrations, prompts, and runtime/OIDC setup before retiring the old host.

For non-interactive automation, add `--yes` only when that restore has already
been approved. Do not persist `VE_RESTORE_FROM` or `VE_RESTORE_FORCE` in `.env`;
clear them immediately after a successful one-shot restore. For the
manifests-based Kubernetes deployment, follow the [PVC restore procedure](deploy/k8s/README.md#restore-from-backup).

## 📚 Documentation

- [Architecture and data flow](docs/ARCHITECTURE.md)
- [Kubernetes deployment](deploy/k8s/README.md)
- [Security architecture and reporting](SECURITY.md)
- [Detailed agent reference](.github/context/modules/agents.md)
- [Configuration reference](.github/context/configuration.md)

## 📄 License

Virtual Engineer is licensed under the [GNU General Public License v3.0 only](LICENSE).
