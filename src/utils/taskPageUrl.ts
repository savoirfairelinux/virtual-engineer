/**
 * Helpers for building shareable deep links to a task's dedicated admin page.
 *
 * The admin dashboard is a single-page app that uses hash-based routing, so a
 * task page is reachable at `<base>/#/tasks/<taskId>`. Because the route lives
 * in the URL fragment, no server-side route is required — the base HTML served
 * at `/` (or `/admin`) loads the SPA, which then resolves the task from the hash.
 */

/** Build a shareable deep link to a task's dedicated admin dashboard page. */
export function buildTaskPageUrl(baseUrl: string, taskId: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return `${trimmed}/#/tasks/${encodeURIComponent(taskId)}`;
}
