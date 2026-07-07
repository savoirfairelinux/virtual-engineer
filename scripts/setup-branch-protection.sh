#!/usr/bin/env bash
#
# setup-branch-protection.sh
# ---------------------------
# Idempotent setup of GitHub branch protection for `main` on this repository.
#
# What it enforces on `main`:
#   * At least 1 approving review from a CODEOWNER (see .github/CODEOWNERS).
#   * Stale approvals are dismissed when new commits are pushed (re-approval
#     required after every push).
#   * All review conversations must be resolved.
#   * The CI status check "Build & Test" must pass, and the branch must be
#     up to date before merging.
#   * Force-pushes and branch deletion are blocked.
#   * Repository admins (and organization admins) can bypass everything.
#
# "Only maintainers can approve" is achieved by the CODEOWNER review
# requirement plus the fact that an approval only counts if its author has
# write access. Manage the allowed reviewers in .github/CODEOWNERS and by
# granting/revoking write access to the repository.
#
# Requirements:
#   * GitHub CLI (`gh`) authenticated as a repo admin (scope: repo):
#       gh auth status
#   * `jq` installed.
#
# Usage:
#   scripts/setup-branch-protection.sh
#   REPO=savoirfairelinux/virtual-engineer scripts/setup-branch-protection.sh
#
set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration (override via environment variables).
# ---------------------------------------------------------------------------
REPO="${REPO:-savoirfairelinux/virtual-engineer}"
BRANCH="${BRANCH:-main}"
RULESET_NAME="${RULESET_NAME:-protect-main}"
CI_CHECK_CONTEXT="${CI_CHECK_CONTEXT:-Build & Test}"

log() { printf '\033[1;34m[setup]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

command -v gh >/dev/null 2>&1 || die "GitHub CLI (gh) is not installed."
command -v jq >/dev/null 2>&1 || die "jq is not installed."
gh auth status >/dev/null 2>&1 || die "gh is not authenticated. Run: gh auth login"

# ---------------------------------------------------------------------------
# Branch ruleset on `main`.
# ---------------------------------------------------------------------------
log "Building ruleset payload for branch '${BRANCH}'..."
RULESET_PAYLOAD="$(jq -n \
  --arg name "${RULESET_NAME}" \
  --arg ref "refs/heads/${BRANCH}" \
  --arg check "${CI_CHECK_CONTEXT}" \
  '{
    name: $name,
    target: "branch",
    enforcement: "active",
    bypass_actors: [
      { actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" },
      { actor_id: 1, actor_type: "OrganizationAdmin", bypass_mode: "always" }
    ],
    conditions: {
      ref_name: { include: [$ref], exclude: [] }
    },
    rules: [
      { type: "deletion" },
      { type: "non_fast_forward" },
      {
        type: "pull_request",
        parameters: {
          required_approving_review_count: 1,
          dismiss_stale_reviews_on_push: true,
          require_code_owner_review: true,
          require_last_push_approval: false,
          required_review_thread_resolution: true,
          allowed_merge_methods: ["squash"]
        }
      },
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: true,
          do_not_enforce_on_create: false,
          required_status_checks: [ { context: $check } ]
        }
      }
    ]
  }')"

# Look up an existing ruleset with the same name. `gh api` exits non-zero on
# HTTP errors (e.g. 403 when rulesets are unavailable on the current plan), so
# guard against that and only treat a purely numeric value as a valid id.
RULESETS_JSON="$(gh api "repos/${REPO}/rulesets" 2>/dev/null)" || \
  die "Cannot read rulesets for ${REPO}. Branch rulesets require a PUBLIC repository (or a paid plan for private repos). Make the repository public, then re-run this script."

EXISTING_ID="$(printf '%s' "${RULESETS_JSON}" | jq -r \
  ".[]? | select(.name == \"${RULESET_NAME}\") | .id" 2>/dev/null | head -n1 || true)"
[[ "${EXISTING_ID}" =~ ^[0-9]+$ ]] || EXISTING_ID=""

if [[ -n "${EXISTING_ID}" ]]; then
  log "Updating existing ruleset (id=${EXISTING_ID})..."
  printf '%s' "${RULESET_PAYLOAD}" | \
    gh api -X PUT "repos/${REPO}/rulesets/${EXISTING_ID}" --input - >/dev/null
else
  log "Creating new ruleset '${RULESET_NAME}'..."
  printf '%s' "${RULESET_PAYLOAD}" | \
    gh api -X POST "repos/${REPO}/rulesets" --input - >/dev/null
fi

# ---------------------------------------------------------------------------
# Repository merge settings.
# ---------------------------------------------------------------------------
log "Applying repository merge settings..."
gh api -X PATCH "repos/${REPO}" \
  -F "allow_merge_commit=false" \
  -F "allow_squash_merge=true" \
  -F "delete_branch_on_merge=true" >/dev/null

log "Done. Verify with: gh api repos/${REPO}/rulesets"
