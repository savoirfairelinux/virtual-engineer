/**
 * Recent repository history for the review prompt.
 *
 * Review agents cannot run Git, so the host reads the history of the target
 * branch from the review checkout and passes it in the prompt. It shows how
 * the repository writes commit messages and how earlier changes were made.
 */

/** Commits of target-branch history fetched by a review clone. */
export const REVIEW_HISTORY_DEPTH = 50;

const RECENT_COMMITS = 20;
const MAX_MESSAGE_CHARS = 1_200;
const MAX_FILES = 20;
const COMMITS_PER_FILE = 5;
const MAX_HISTORY_CHARS = 16_000;
const RECORD = "\x1e";
const FIELD = "\x1f";

export type HistoryGit = (args: string[]) => Promise<string>;

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function records(output: string): string[][] {
  return output
    .split(RECORD)
    .map((record) => record.trim())
    .filter((record) => record.length > 0)
    .map((record) => record.split(FIELD));
}

/**
 * Render recent commits of `branch` and the recent commits touching each
 * changed path, or `undefined` when the checkout has no readable history.
 */
export async function collectRepositoryHistory(
  git: HistoryGit,
  input: { branch: string; paths: readonly string[] },
): Promise<string | undefined> {
  const ref = `refs/heads/${input.branch.replace(/^refs\/heads\//, "")}`;
  const recent = records(await git([
    "log", `-n${RECENT_COMMITS}`, "--date=short", `--format=${RECORD}%h${FIELD}%ad${FIELD}%B`, ref, "--",
  ]));
  if (recent.length === 0) return undefined;

  const sections = [`### Recent commits on ${input.branch}`, ""];
  for (const [hash = "", date = "", message = ""] of recent) {
    sections.push(`commit ${hash} (${date})`, truncate(message.trim(), MAX_MESSAGE_CHARS), "");
  }

  const fileSections: string[] = [];
  for (const path of [...new Set(input.paths)].slice(0, MAX_FILES)) {
    const commits = records(await git([
      "log", `-n${COMMITS_PER_FILE}`, "--date=short", `--format=${RECORD}%h${FIELD}%ad${FIELD}%s`, ref, "--", path,
    ]));
    if (commits.length === 0) continue;
    fileSections.push(`\`${path}\`:`, ...commits.map(([hash = "", date = "", subject = ""]) => `- ${hash} ${date} ${subject}`), "");
  }
  if (fileSections.length > 0) {
    sections.push("### Recent commits touching the changed files", "", ...fileSections);
  }

  const history = sections.join("\n").trimEnd();
  return history.length <= MAX_HISTORY_CHARS
    ? history
    : `${history.slice(0, MAX_HISTORY_CHARS)}\n\n[... history truncated ...]`;
}
