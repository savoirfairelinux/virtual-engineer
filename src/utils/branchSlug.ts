/**
 * Branch-name slug utilities.
 *
 * Virtual Engineer historically derived push-branch / Gerrit-topic names
 * from the opaque task UUID (e.g. `feature-9f2c3a...`), which made it
 * impossible to recognise a branch at a glance.
 *
 * These helpers turn a ticket subject into a short, git-safe slug
 * (lower-case, ASCII, dash-separated, max 5 words) so that the resulting
 * branch / topic names are human-readable. The slug is deterministic for a
 * given subject so that retry cycles continue to push to the same
 * branch (allowing GitLab MRs to be updated via force-push and Gerrit
 * topics to keep grouping the related changes).
 */

const DEFAULT_MAX_WORDS = 5;
const DEFAULT_MAX_LENGTH = 50;

/**
 * Convert a free-form ticket subject into a git-ref-safe slug.
 *
 * Returns an empty string if the subject is missing or contains no
 * usable characters after normalisation; callers are expected to fall
 * back to another identifier (typically the task ID) in that case.
 */
export function slugifyTicketSubject(
  subject: string | null | undefined,
  options: { maxWords?: number; maxLength?: number } = {}
): string {
  if (!subject) return "";
  const maxWords = options.maxWords ?? DEFAULT_MAX_WORDS;
  const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;

  const normalized = subject
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

  if (!normalized) return "";

  const words = normalized.split(/\s+/).filter(Boolean).slice(0, maxWords);
  let slug = words.join("-");
  if (slug.length > maxLength) {
    slug = slug.slice(0, maxLength).replace(/-+$/, "");
  }
  return slug;
}

/**
 * Build the descriptive portion of a push branch / topic name from a
 * task ID and an (optional) ticket subject. Always returns a non-empty,
 * git-ref-safe string: the slug when a usable subject is provided,
 * otherwise the raw task ID for uniqueness.
 */
export function buildBranchSlug(
  taskId: string,
  ticketSubject?: string | null,
  options: { maxWords?: number; maxLength?: number } = {}
): string {
  const slug = slugifyTicketSubject(ticketSubject, options);
  return slug || taskId;
}
