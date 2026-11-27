# Update

Move a `start.sh` deployment to a new release, from the host or from System settings.

Every release publishes ready-built images to Docker Hub (`savoirfairelinux/virtual-engineer`, `-workspace`, and `-workspace-<engine>`), so an update pulls images instead of rebuilding them.

## From the host

```
./scripts/update.sh            # latest release
./scripts/update.sh 0.4.0      # a specific release
./scripts/update.sh --check    # running and latest versions
```

The update runs these steps:

1. It fetches the release tag and pulls its images while the current version keeps running. If they are not published yet, nothing changes.
2. It snapshots `.env`, the Git checkout, and the current images.
3. It stops the orchestrator gracefully. No new work starts, and running agent cycles finish first, for up to `SHUTDOWN_DRAIN_TIMEOUT_MS` (15 minutes by default). The Admin UI stays up meanwhile.
4. It copies the database to `data/backups/update-<time>/`.
5. It checks out the release tag, sets `VE_IMAGE_TAG` in `.env`, and runs `start.sh`.
6. It waits for `/health` and the new version.

If anything fails after the orchestrator stops, the script restores the database, `.env`, checkout, and images, then restarts the previous version. Downgrades and checkouts with local changes are refused. Progress goes to `data/update.status` and `data/update.log`; the last three backups are kept.

After an update the checkout is on the release tag. To return to building from a branch, remove `VE_IMAGE_TAG` from `.env`, check out the branch, and run `./scripts/start.sh`.

## From System settings

Configuration → System settings → **Updates** shows the running version and the latest release. To enable the **Update** button, install the host updater once:

```
./scripts/update.sh --install-service    # needs sudo; --uninstall-service removes it
```

This installs a systemd path unit that runs `update.sh` as your user when an admin requests an update. The orchestrator itself never gets access to Docker. The panel follows the update through the restart and offers to reload the page once the new version answers.

The service has no login session. If the running orchestrator was started with an SSH agent, the updater reuses that socket while it still exists; otherwise prefer integration-managed SSH keys. `start.sh` steps that need `sudo` (for example the experimental Kubernetes driver) cannot run unattended.

## Restarts without updating

`./scripts/start.sh` also lets running agent cycles finish before it replaces the orchestrator. Set `SHUTDOWN_DRAIN_TIMEOUT_MS=0` to restart immediately; cycles cut short are retried after the restart.
