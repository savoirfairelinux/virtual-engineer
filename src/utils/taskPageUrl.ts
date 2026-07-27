/** Build the public admin URL for a task using the SPA's hash route. */
export function buildTaskPageUrl(baseUrl: string, taskId: string): string {
  const url = new URL(baseUrl);
  if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;
  url.hash = `tasks/${encodeURIComponent(taskId)}`;
  return url.toString();
}