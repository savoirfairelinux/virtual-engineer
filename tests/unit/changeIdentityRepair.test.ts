import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { promisify } from "node:util";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { makeTaskId } from "../../src/interfaces.js";
import { runDatabaseMigrations } from "../../src/state/databaseMigrations.js";
import {
  agents, changePerRepository, integrations, projects, projectPushTargets, tasks,
} from "../../src/state/schema.js";
import { SqliteStateStore } from "../../src/state/stateStore.js";
import type { VcsConnector, VcsPushResult } from "../../src/vcs/vcsConnector.js";
import { GitHubVcsConnector } from "../../src/vcs/githubVcsConnector.js";
import { repairHostedChangeIdentities } from "../../src/vcs/changeIdentityRepair.js";
import { jsonResponse } from "./helpers/fixtures.js";
import { RecordingGitRunner } from "./helpers/recordingGitRunner.js";
import { tempDatabasePath } from "./helpers/tempDatabase.js";

const FIRST_CHANGE_ID = `I${"1".repeat(40)}`;
const SECOND_CHANGE_ID = `I${"2".repeat(40)}`;

function makeConnector(result: VcsPushResult, useChangeIdContinuity = false): VcsConnector {
  return {
    clone: vi.fn().mockResolvedValue(undefined),
    pushDirect: vi.fn().mockResolvedValue(result),
    getChangeStatus: vi.fn().mockResolvedValue(result.status),
    // Mirrors buildFeatureBranchRef() for the untitled tasks seeded below.
    buildPushSpec: (_baseBranch: string, taskId: string) => ({ ref: `feature-${taskId}` }),
    findExistingReview: vi.fn().mockResolvedValue({ ...result, targetBranch: "main" }),
    reviewSystemLabel: "github",
    useChangeIdContinuity,
  };
}

describe("repairHostedChangeIdentities", () => {
  let raw: Database.Database;
  let store: SqliteStateStore;

  beforeEach(() => {
    raw = new Database(":memory:");
    raw.pragma("foreign_keys = ON");
    runDatabaseMigrations(raw);
    store = new SqliteStateStore(raw);
    const now = new Date(0);
    drizzle(raw).insert(agents).values({
      id: "agent-1", name: "Agent", type: "coding", createdAt: now, updatedAt: now,
    }).run();
    drizzle(raw).insert(projects).values({
      id: "project-1", name: "Project", type: "coding", agentId: "agent-1",
      createdAt: now, updatedAt: now,
    }).run();
  });

  afterEach(() => {
    store.close();
  });

  async function seed(
    provider: "github" | "gitlab" | "gerrit" = "github",
    commitCount = 2,
    taskId = "task-1",
    repoKey = "team42/repo",
  ): Promise<VcsPushResult> {
    const now = new Date(0);
    const result = {
      changeId: "42",
      url: `https://review.example.test/${repoKey}/${provider === "gitlab" ? "-/merge_requests" : "pull"}/42`,
      status: "OPEN",
    };
    const wrongUrl = result.url.replace("42", FIRST_CHANGE_ID);
    const db = drizzle(raw);
    db.insert(integrations).values({
      id: `${provider}-1`, provider, name: provider, configJson: "{}", createdAt: now, updatedAt: now,
    }).onConflictDoNothing().run();
    const targetExists = db.select().from(projectPushTargets).where(eq(projectPushTargets.repoKey, repoKey)).get();
    if (!targetExists) {
      db.insert(projectPushTargets).values({
        projectId: "project-1", integrationId: `${provider}-1`, repoKey,
        cloneUrl: `https://review.example.test/${repoKey}.git`, targetBranch: "main",
        role: "primary", commitOrder: db.select().from(projectPushTargets).all().length + 1,
        localPath: ".", createdAt: now, updatedAt: now,
      }).run();
    }
    db.insert(tasks).values({
      taskId, ticketId: taskId, state: "IN_REVIEW", taskType: "code-gen",
      projectId: "project-1", pushRef: `feature-${taskId}`,
      gerritChangeId: FIRST_CHANGE_ID, reviewUrl: wrongUrl, createdAt: now, updatedAt: now,
    }).onConflictDoNothing().run();
    for (let index = 0; index < commitCount; index++) {
      await store.saveChangePerRepository(
        makeTaskId(taskId), repoKey, index === 0 ? FIRST_CHANGE_ID : SECOND_CHANGE_ID,
        index === 0 ? wrongUrl : "", "OPEN", `${provider}-1`, provider, index, "subject-hash",
      );
    }
    return result;
  }

  function snapshot(): string {
    const db = drizzle(raw);
    return JSON.stringify({
      tasks: db.select().from(tasks).all(),
      changes: db.select().from(changePerRepository).all(),
    });
  }

  describe.each(["github", "gitlab"] as const)("%s legacy rows", (provider) => {
    it.each([1, 2])("defaults to a non-mutating dry run for %i commit(s)", async (commitCount) => {
      const result = await seed(provider, commitCount);
      const connector = { ...makeConnector(result), reviewSystemLabel: provider };
      const before = snapshot();
      const createConnector = vi.fn(() => connector);

      const report = await repairHostedChangeIdentities({ database: raw, createConnector });

      expect(report).toMatchObject({ apply: false, repairable: 1, applied: 0, blocked: 0 });
      expect(report.targets).toEqual([expect.objectContaining({
        taskId: "task-1", repoKey: "team42/repo", status: "repairable", resolvedChangeId: "42",
      })]);
      expect(createConnector).toHaveBeenCalledWith(
        expect.objectContaining({ id: `${provider}-1` }),
        { repoKey: "team42/repo", targetBranch: "main" },
      );
      expect(connector.findExistingReview).toHaveBeenCalledWith("feature-task-1");
      expect(connector.pushDirect).not.toHaveBeenCalled();
      expect(snapshot()).toBe(before);
    });

    it.each([1, 2])("repairs %i commit(s) atomically, preserving history", async (commitCount) => {
      const result = await seed(provider, commitCount);
      const connector = { ...makeConnector(result), reviewSystemLabel: provider };
      const before = await store.getChangesForTask(makeTaskId("task-1"));

      const report = await repairHostedChangeIdentities({
        database: raw, createConnector: () => connector, apply: true,
      });

      expect(report).toMatchObject({ apply: true, repairable: 1, applied: 1, blocked: 0 });
      const rows = await store.getChangesForTask(makeTaskId("task-1"));
      expect(rows).toHaveLength(commitCount);
      expect(rows.filter((row) => row.status !== "ORPHANED")).toEqual([
        expect.objectContaining({ changeId: "42", reviewUrl: result.url, commitIndex: 0 }),
      ]);
      expect(rows[0]).toMatchObject({ id: before[0]?.id, createdAt: before[0]?.createdAt });
      if (commitCount === 2) {
        expect(rows[1]).toMatchObject({
          changeId: SECOND_CHANGE_ID, status: "ORPHANED", subjectHash: "subject-hash",
        });
      }
      expect(await store.getTask(makeTaskId("task-1"))).toMatchObject({
        externalChangeId: "42", reviewUrl: result.url, state: "IN_REVIEW", pushRef: "feature-task-1",
      });
      const after = snapshot();
      const second = await repairHostedChangeIdentities({
        database: raw, createConnector: () => connector, apply: true,
      });
      expect(second).toMatchObject({ repairable: 0, applied: 0, blocked: 0 });
      expect(snapshot()).toBe(after);
    });
  });

  it("leaves Gerrit changes untouched based on capability, not label", async () => {
    const result = await seed("github");
    const connector = makeConnector(result, true);
    const before = snapshot();

    const report = await repairHostedChangeIdentities({
      database: raw, createConnector: () => connector, apply: true,
    });

    expect(report).toMatchObject({ repairable: 0, applied: 0, blocked: 0 });
    expect(report.targets[0]?.status).toBe("skipped");
    expect(connector.findExistingReview).not.toHaveBeenCalled();
    expect(snapshot()).toBe(before);
  });

  it("never deletes or orphans legitimate Gerrit changes alongside hosted repairs", async () => {
    const result = await seed();
    await seed("gerrit", 2, "gerrit-task", "gerrit/repo");
    const hosted = makeConnector(result);
    const gerrit: VcsConnector = { ...makeConnector(result, true), reviewSystemLabel: "gerrit" };
    const before = await store.getChangesForTask(makeTaskId("gerrit-task"));

    await repairHostedChangeIdentities({
      database: raw,
      createConnector: (integration) => integration.id === "gerrit-1" ? gerrit : hosted,
      apply: true,
    });

    expect(await store.getChangesForTask(makeTaskId("gerrit-task"))).toEqual(before);
    expect(gerrit.findExistingReview).not.toHaveBeenCalled();
  });

  it.each([
    { name: "missing branch", detail: "branch", change: (db: ReturnType<typeof drizzle>) =>
      db.update(tasks).set({ pushRef: null }).run() },
    { name: "changed binding", detail: "binding", change: (db: ReturnType<typeof drizzle>) =>
      db.update(projectPushTargets).set({ repoKey: "other/repo" }).run() },
    { name: "mixed review systems", detail: "Mixed", change: (db: ReturnType<typeof drizzle>) =>
      db.update(changePerRepository).set({ reviewSystem: "gerrit" }).where(eq(changePerRepository.commitIndex, 1)).run() },
    { name: "conflicting native id", detail: "Conflicting", change: (db: ReturnType<typeof drizzle>) =>
      db.update(changePerRepository).set({ changeId: "99" }).where(eq(changePerRepository.commitIndex, 1)).run() },
    { name: "unrelated URL", detail: "URL", change: (db: ReturnType<typeof drizzle>) =>
      db.update(changePerRepository).set({ reviewUrl: "https://other.example.test/pull/42" })
        .where(eq(changePerRepository.commitIndex, 0)).run() },
    { name: "terminal status conflict", detail: "terminal", change: (db: ReturnType<typeof drizzle>) =>
      db.update(changePerRepository).set({ status: "MERGED" }).where(eq(changePerRepository.commitIndex, 1)).run() },
  ])("blocks $name without any writes", async ({ detail, change }) => {
    const result = await seed();
    change(drizzle(raw));
    const before = snapshot();

    const report = await repairHostedChangeIdentities({
      database: raw, createConnector: () => makeConnector(result), apply: true,
    });

    expect(report).toMatchObject({ applied: 0, blocked: 1 });
    expect(report.targets[0]?.detail).toContain(detail);
    expect(snapshot()).toBe(before);
  });

  it.each([
    { name: "a Gerrit target's ref", pushRef: "refs/for/main" },
    { name: "another task's branch", pushRef: "feature-task-2" },
    { name: "a branch derived from a different title", pushRef: "feature/task-1-other-title" },
  ])("blocks a recorded push ref that is $name, before any lookup or write", async ({ pushRef }) => {
    // One push ref is shared by every target of a task; only this repository's
    // derived branch proves which review it opened.
    const result = await seed();
    drizzle(raw).update(tasks).set({ pushRef }).run();
    const connector = makeConnector(result);
    const before = snapshot();

    const report = await repairHostedChangeIdentities({
      database: raw, createConnector: () => connector, apply: true,
    });

    expect(report).toMatchObject({ repairable: 0, applied: 0, blocked: 1 });
    expect(report.targets[0]?.detail).toContain("branch");
    expect(connector.findExistingReview).not.toHaveBeenCalled();
    expect(snapshot()).toBe(before);
  });

  it.each([null, new Error("Ambiguous reviews"), new Error("API unavailable")])(
    "blocks missing or failed provider lookup", async (failure) => {
      const result = await seed();
      const connector = makeConnector(result);
      connector.findExistingReview = failure instanceof Error
        ? vi.fn().mockRejectedValue(failure)
        : vi.fn().mockResolvedValue(null);
      const before = snapshot();

      const report = await repairHostedChangeIdentities({
        database: raw, createConnector: () => connector, apply: true,
      });

      expect(report).toMatchObject({ applied: 0, blocked: 1 });
      expect(snapshot()).toBe(before);
    },
  );

  it.each([
    { name: "a different review", url: (result: VcsPushResult) => result.url.replace("/pull/42", "/pull/99") },
    { name: "another repository", url: (result: VcsPushResult) => result.url.replace("/repo/", "/other/") },
  ])("blocks an active secondary row whose URL points to $name, without writes", async ({ url }) => {
    const result = await seed();
    drizzle(raw).update(changePerRepository).set({ reviewUrl: url(result) })
      .where(eq(changePerRepository.commitIndex, 1)).run();
    const before = snapshot();

    const report = await repairHostedChangeIdentities({
      database: raw, createConnector: () => makeConnector(result), apply: true,
    });

    expect(report).toMatchObject({ applied: 0, blocked: 1 });
    expect(report.targets[0]?.detail).toContain("URL");
    expect(snapshot()).toBe(before);
  });

  it.each([
    { name: "the recovered URL", url: (result: VcsPushResult) => result.url },
    { name: "its own exact legacy replacement", url: (result: VcsPushResult) => result.url.replace("42", SECOND_CHANGE_ID) },
  ])("accepts an active secondary row whose URL is $name", async ({ url }) => {
    const result = await seed();
    drizzle(raw).update(changePerRepository).set({ reviewUrl: url(result) })
      .where(eq(changePerRepository.commitIndex, 1)).run();

    const report = await repairHostedChangeIdentities({
      database: raw, createConnector: () => makeConnector(result), apply: true,
    });

    expect(report).toMatchObject({ applied: 1, blocked: 0 });
  });

  it("refuses to invent a numeric provider id", async () => {
    const result = await seed();
    const before = snapshot();
    const report = await repairHostedChangeIdentities({
      database: raw, createConnector: () => makeConnector({ ...result, changeId: FIRST_CHANGE_ID }),
      apply: true,
    });

    expect(report).toMatchObject({ applied: 0, blocked: 1 });
    expect(snapshot()).toBe(before);
  });

  it("repairs a correct primary with leftover duplicate Change-Id rows", async () => {
    const result = await seed();
    drizzle(raw).update(changePerRepository).set({ changeId: "42", reviewUrl: result.url })
      .where(eq(changePerRepository.commitIndex, 0)).run();

    const report = await repairHostedChangeIdentities({
      database: raw, createConnector: () => makeConnector(result), apply: true,
    });

    expect(report).toMatchObject({ applied: 1, blocked: 0 });
    expect((await store.getChangesForTask(makeTaskId("task-1"))).filter((row) => row.status !== "ORPHANED"))
      .toHaveLength(1);
  });

  it("does not apply any target if another target is blocked", async () => {
    const result = await seed();
    await seed("gitlab", 1, "task-2", "other/repo");
    const blocked: VcsConnector = { ...makeConnector(result), reviewSystemLabel: "gitlab",
      findExistingReview: vi.fn().mockResolvedValue(null) };
    const before = snapshot();

    const report = await repairHostedChangeIdentities({
      database: raw,
      createConnector: (integration) => integration.id === "gitlab-1" ? blocked : makeConnector(result),
      apply: true,
    });

    expect(report).toMatchObject({ repairable: 1, applied: 0, blocked: 1 });
    expect(snapshot()).toBe(before);
  });

  it("applies multiple repository repairs for one task without invalidating its own snapshots", async () => {
    const githubResult = await seed("github", 2, "task-1", "a/repo");
    const gitlabResult = await seed("gitlab", 2, "task-1", "z/repo");
    const github = makeConnector(githubResult);
    const gitlab: VcsConnector = { ...makeConnector(gitlabResult), reviewSystemLabel: "gitlab" };

    const report = await repairHostedChangeIdentities({
      database: raw,
      createConnector: (integration) => integration.id === "gitlab-1" ? gitlab : github,
      apply: true,
    });

    expect(report).toMatchObject({ applied: 2, blocked: 0 });
    const active = (await store.getChangesForTask(makeTaskId("task-1"))).filter((row) => row.status !== "ORPHANED");
    expect(active).toHaveLength(2);
    expect(active.map((row) => row.changeId)).toEqual(["42", "42"]);
  });

  it.each(["change", "task", "target", "integration"])(
    "rejects a stale %s snapshot before applying", async (entity) => {
      const result = await seed();
      const connector = makeConnector(result);
      connector.findExistingReview = vi.fn().mockImplementation(() => {
        const db = drizzle(raw);
        if (entity === "change") db.update(changePerRepository).set({ subjectHash: "new" }).run();
        if (entity === "task") db.update(tasks).set({ pushRef: "feature-other" }).run();
        if (entity === "target") db.update(projectPushTargets).set({ targetBranch: "release" }).run();
        if (entity === "integration") db.update(integrations).set({ configJson: '{"changed":true}' }).run();
        return Promise.resolve(result);
      });

      await expect(repairHostedChangeIdentities({
        database: raw, createConnector: () => connector, apply: true,
      })).rejects.toThrow("changed");
      expect((await store.getChangesForTask(makeTaskId("task-1"))).map((row) => row.changeId))
        .toEqual([FIRST_CHANGE_ID, SECOND_CHANGE_ID]);
    },
  );

  it("rolls back primary and task updates if orphaning fails", async () => {
    const result = await seed();
    raw.exec(`CREATE TRIGGER reject_orphan BEFORE UPDATE ON change_per_repository
      WHEN NEW.status = 'ORPHANED' BEGIN SELECT RAISE(ABORT, 'simulated failure'); END`);
    const before = snapshot();

    await expect(repairHostedChangeIdentities({
      database: raw, createConnector: () => makeConnector(result), apply: true,
    })).rejects.toThrow("simulated failure");
    expect(snapshot()).toBe(before);
  });

  describe("with the real GitHub connector after a target-branch change", () => {
    const PR_URL = "https://github.com/octocat/hello-world/pull";
    const pullRequest = (number: number, base: string) => ({
      number, html_url: `${PR_URL}/${number}`, state: "open", merged_at: null,
      head: { ref: "feature-task-1", repo: { full_name: "octocat/hello-world" } },
      base: { ref: base, repo: { full_name: "octocat/hello-world" } },
    });

    async function seedDriftedTarget(): Promise<void> {
      await seed("github", 1, "task-1", "octocat/hello-world");
      // Corrupted from PR 42 (feature-task-1 -> main): the trailer replaced the URL's only "42".
      const erasedUrl = `${PR_URL}/${FIRST_CHANGE_ID}`;
      const db = drizzle(raw);
      db.update(changePerRepository).set({ reviewUrl: erasedUrl }).run();
      db.update(tasks).set({ reviewUrl: erasedUrl }).run();
      db.update(projectPushTargets).set({ targetBranch: "release" }).run();
    }

    function githubConnector(pulls: Array<ReturnType<typeof pullRequest>>): VcsConnector {
      // Mirrors GitHub's server-side filtering of the optional base parameter.
      vi.stubGlobal("fetch", vi.fn((input: string) => {
        const base = new URL(input).searchParams.get("base");
        return Promise.resolve(jsonResponse(pulls.filter((pr) => base === null || pr.base.ref === base)));
      }));
      onTestFinished(() => {
        vi.unstubAllGlobals();
      });
      return new GitHubVcsConnector({
        apiBaseUrl: "https://api.github.com", host: "github.com", owner: "octocat", repo: "hello-world",
        token: "test-token", gitAuthorName: "VE", gitAuthorEmail: "ve@example.test", targetBranch: "release",
      }, new RecordingGitRunner());
    }

    it("blocks when the branch has reviews on several target branches, without writes", async () => {
      await seedDriftedTarget();
      const before = snapshot();
      const connector = githubConnector([pullRequest(43, "release"), pullRequest(42, "main")]);

      const report = await repairHostedChangeIdentities({
        database: raw, createConnector: () => connector, apply: true,
      });

      expect(report).toMatchObject({ repairable: 0, applied: 0, blocked: 1 });
      expect(report.targets[0]?.detail).toContain("Ambiguous");
      expect(snapshot()).toBe(before);
    });

    it("recovers the only review from the branch even when it targets a former branch", async () => {
      await seedDriftedTarget();
      const connector = githubConnector([pullRequest(42, "main")]);

      const report = await repairHostedChangeIdentities({
        database: raw, createConnector: () => connector, apply: true,
      });

      expect(report).toMatchObject({ applied: 1, blocked: 0 });
      expect(report.targets[0]).toMatchObject({ resolvedChangeId: "42", resolvedTargetBranch: "main" });
      expect(report.targets[0]?.detail).toContain("release");
      expect((await store.getChangesForTask(makeTaskId("task-1")))[0]).toMatchObject({
        changeId: "42", reviewUrl: `${PR_URL}/42`,
      });
    });
  });

  describe("with the real GitHub connector in a mixed Gerrit/GitHub project", () => {
    it("blocks a shared Gerrit push ref even when a PR exists from that branch, without writes", async () => {
      await seed("github", 1, "task-1", "octocat/hello-world");
      await seed("gerrit", 1, "task-1", "gerrit/root");
      const db = drizzle(raw);
      // The first mixed cycle persisted the last target's ref; the corrupted URL lost its number.
      db.update(tasks).set({ pushRef: "refs/for/main" }).run();
      db.update(changePerRepository)
        .set({ reviewUrl: `https://github.com/octocat/hello-world/pull/${FIRST_CHANGE_ID}` })
        .where(eq(changePerRepository.repoKey, "octocat/hello-world")).run();
      const before = snapshot();
      // A later push from another task opened PR 77 from the same non-unique ref.
      const fetchMock = vi.fn(() => Promise.resolve(jsonResponse([{
        number: 77, html_url: "https://github.com/octocat/hello-world/pull/77", state: "open", merged_at: null,
        head: { ref: "refs/for/main", repo: { full_name: "octocat/hello-world" } },
        base: { ref: "main", repo: { full_name: "octocat/hello-world" } },
      }])));
      vi.stubGlobal("fetch", fetchMock);
      onTestFinished(() => {
        vi.unstubAllGlobals();
      });
      const github = new GitHubVcsConnector({
        apiBaseUrl: "https://api.github.com", host: "github.com", owner: "octocat", repo: "hello-world",
        token: "test-token", gitAuthorName: "VE", gitAuthorEmail: "ve@example.test",
      }, new RecordingGitRunner());
      const gerrit: VcsConnector = {
        ...makeConnector({ changeId: FIRST_CHANGE_ID, url: "", status: "OPEN" }, true), reviewSystemLabel: "gerrit",
      };

      const report = await repairHostedChangeIdentities({
        database: raw,
        createConnector: (integration) => integration.id === "gerrit-1" ? gerrit : github,
        apply: true,
      });

      expect(report).toMatchObject({ repairable: 0, applied: 0, blocked: 1 });
      expect(report.targets).toEqual([
        expect.objectContaining({ repoKey: "gerrit/root", status: "skipped" }),
        expect.objectContaining({
          repoKey: "octocat/hello-world", status: "blocked", detail: expect.stringContaining("branch"),
        }),
      ]);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(snapshot()).toBe(before);
    });
  });

  it("can restrict a dry run to one selected task", async () => {
    const result = await seed();
    await seed("github", 1, "task-2");
    const before = snapshot();
    const connector = makeConnector(result);

    const report = await repairHostedChangeIdentities({
      database: raw, createConnector: () => connector, taskId: "task-2",
    });

    expect(report.targets).toHaveLength(1);
    expect(report.targets[0]?.taskId).toBe("task-2");
    expect(connector.findExistingReview).toHaveBeenCalledExactlyOnceWith("feature-task-2");
    expect(snapshot()).toBe(before);
  });

  describe("CLI", { timeout: 15_000 }, () => {
    function execute(dbPath: string, args: string[] = [], nodeEnv = "test") {
      return promisify(execFile)(process.execPath, [
        "--import", "tsx", "src/vcs/repairChangeIdentities.ts", ...args,
      ], {
        env: { ...process.env, DATABASE_PATH: dbPath, ADMIN_AUTH_SECRET: "", NODE_ENV: nodeEnv, LOG_LEVEL: "warn" },
        timeout: 10_000,
      });
    }

    it.each([{ args: [] }, { args: ["--apply"] }])(
      "reports a clean existing database for $args without migrations or seeds", async ({ args }) => {
        const dbPath = tempDatabasePath("ve-identity-cli");
        const database = new Database(dbPath);
        runDatabaseMigrations(database);
        database.close();
        const before = readFileSync(dbPath);

        const { stdout } = await execute(dbPath, args);

        expect(JSON.parse(stdout)).toEqual({
          apply: args.includes("--apply"), repairable: 0, applied: 0, blocked: 0, targets: [],
        });
        expect(readFileSync(dbPath)).toEqual(before);
      },
    );

    it("does not create a missing database during a dry run", async () => {
      const dbPath = tempDatabasePath("ve-identity-missing");

      await expect(execute(dbPath)).rejects.toMatchObject({ code: 1 });
      expect(existsSync(dbPath)).toBe(false);
    });

    it("rejects a nonexistent selected task instead of reporting a successful empty repair", async () => {
      const dbPath = tempDatabasePath("ve-identity-task");
      const database = new Database(dbPath);
      runDatabaseMigrations(database);
      database.close();
      const before = readFileSync(dbPath);

      await expect(execute(dbPath, ["--task", "missing-task"])).rejects.toMatchObject({
        code: 1, stderr: expect.stringContaining("Selected task does not exist"),
      });
      expect(readFileSync(dbPath)).toEqual(before);
    });

    it.each([
      { args: ["--unknown"] }, { args: ["--task"] }, { args: ["--task", "--apply"] },
      { args: ["--task", "one", "--task", "two"] },
    ])("rejects invalid arguments $args before opening a database", async ({ args }) => {
      const dbPath = tempDatabasePath("ve-identity-arguments");

      await expect(execute(dbPath, args)).rejects.toMatchObject({ code: 1 });
      expect(existsSync(dbPath)).toBe(false);
    });

    it("reports blocked repairs with exit code 2 and never mutates the database", async () => {
      const dbPath = tempDatabasePath("ve-identity-blocked");
      const database = new Database(dbPath);
      runDatabaseMigrations(database);
      database.exec(`INSERT INTO tasks (task_id, ticket_id, created_at, updated_at)
        VALUES ('bad-task', 'bad-ticket', 0, 0);
        INSERT INTO change_per_repository
          (id, task_id, repo_key, change_id, created_at, updated_at)
        VALUES ('bad-row', 'bad-task', 'repo', '${FIRST_CHANGE_ID}', 0, 0);`);
      database.close();
      const before = readFileSync(dbPath);

      await expect(execute(dbPath, [], "development")).rejects.toMatchObject({
        code: 2, stdout: expect.stringMatching(/^\{\n  "apply": false,[\s\S]*"blocked": 1,[\s\S]*\n\}\n$/),
      });
      expect(readFileSync(dbPath)).toEqual(before);
    });
  });
});
