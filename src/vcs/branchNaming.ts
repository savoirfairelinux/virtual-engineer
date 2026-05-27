const SHORT_ID_LENGTH = 8;
const SLUG_MAX_LENGTH = 40;

export function buildFeatureBranchRef(taskId: string, ticketTitle: string | undefined | null): string {
  const slug = slugify(ticketTitle ?? "");
  if (!slug) {
    return `feature-${taskId}`;
  }
  const shortId = taskId.slice(0, SHORT_ID_LENGTH);
  return `feature/${shortId}-${slug}`;
}

/**
 * Gerrit topic name derived from the ticket title; falls back to `VE-<taskId>`
 * when the title is empty so legacy retries keep their original topic.
 */
export function buildGerritTopic(taskId: string, ticketTitle: string | undefined | null): string {
  const slug = slugify(ticketTitle ?? "");
  if (!slug) {
    return `VE-${taskId}`;
  }
  const shortId = taskId.slice(0, SHORT_ID_LENGTH);
  return `VE-${shortId}-${slug}`;
}

function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/, "");
}
