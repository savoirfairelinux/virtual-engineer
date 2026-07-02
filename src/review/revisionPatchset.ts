/**
 * Derive a stable numeric patchset identifier from a git revision SHA.
 *
 * GitHub pull requests and GitLab merge requests have no Gerrit-style monotonic
 * patchset counter. The review dedup in `reviewOrchestrator` compares
 * `task.reviewedPatchset === details.currentPatchset` (equality only — ordering
 * is never used), so a provider must return a `currentPatchset` that changes
 * whenever the reviewed revision changes. Returning a constant (the old
 * placeholder `1`) means a once-reviewed change is never re-reviewed again, even
 * after the author pushes new commits.
 *
 * The head commit SHA is the natural per-revision identifier. We fold its first
 * 13 hex digits (52 bits) into a positive integer that fits inside
 * `Number.MAX_SAFE_INTEGER`. Distinct revisions therefore yield distinct
 * patchset numbers — SHA-prefix collisions are astronomically unlikely within a
 * single change's lifetime — while the same revision always yields the same
 * number.
 *
 * Falls back to `1` when no usable SHA is available, matching the previous
 * placeholder behaviour for changes whose head SHA cannot be resolved.
 */
export function patchsetFromRevisionSha(sha: string | null | undefined): number {
  if (typeof sha !== "string") return 1;
  const hex = sha.trim().toLowerCase().replace(/[^0-9a-f]/g, "").slice(0, 13);
  if (hex.length === 0) return 1;
  const n = parseInt(hex, 16);
  return Number.isSafeInteger(n) && n > 0 ? n : 1;
}
