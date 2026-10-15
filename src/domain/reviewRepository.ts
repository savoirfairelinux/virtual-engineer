import type { ExternalChangeId } from "./identifiers.js";

export interface ReviewRepositorySelection {
  repoKey: string | undefined;
  hasQualifiedRepository: boolean;
}

export function selectReviewRepository(
  externalChangeId: ExternalChangeId | null | undefined,
  repositories: readonly string[],
): ReviewRepositorySelection {
  const rawChangeId = externalChangeId === null || externalChangeId === undefined
    ? ""
    : String(externalChangeId).trim();
  const hashIndex = rawChangeId.indexOf("#");

  if (hashIndex > 0) {
    const requestedRepoKey = rawChangeId.slice(0, hashIndex);
    return {
      repoKey: repositories.includes(requestedRepoKey) ? requestedRepoKey : undefined,
      hasQualifiedRepository: true,
    };
  }

  return {
    repoKey: repositories.length === 1 ? repositories[0] : undefined,
    hasQualifiedRepository: false,
  };
}

const BRANCH_REF_PREFIX = "refs/heads/";

/** Trim names, drop `refs/heads/`, blanks, and duplicates while keeping the configured order. */
export function normalizeReviewBranches(branches: readonly string[]): string[] {
  const normalized: string[] = [];
  for (const branch of branches) {
    const name = shortBranchName(branch);
    if (name.length > 0 && !normalized.includes(name)) normalized.push(name);
  }
  return normalized;
}

/** An empty or absent branch list selects every branch; otherwise names must match exactly. */
export function isReviewBranchSelected(branches: readonly string[] | undefined, targetBranch: string): boolean {
  if (branches === undefined || branches.length === 0) return true;
  const target = shortBranchName(targetBranch);
  return branches.some((branch) => shortBranchName(branch) === target);
}

function shortBranchName(branch: string): string {
  const trimmed = branch.trim();
  return trimmed.startsWith(BRANCH_REF_PREFIX) ? trimmed.slice(BRANCH_REF_PREFIX.length) : trimmed;
}