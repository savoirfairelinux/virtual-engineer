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