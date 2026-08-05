import { describe, expect, it } from "vitest";
import {
  checkedSourcesAfterError,
  emptyPushTarget,
  firstTargetBranch,
  legacyRoleForPushTarget,
  manualLocalPath,
  normalizeRepository,
  normalizeTicketProject,
  repositoryLabel,
  saveCheckSourcesFromSkillSources,
  saveCheckStatusLabel,
  vendorComponentKey,
  vendorComponentName,
  workspaceMemberSearchText,
  type PushTarget,
  type SaveCheckSource,
  type WorkspaceScanMember,
} from "../../../src/admin/ui/views/ConfigView/projectFormTypes.js";

describe("vendorComponentKey / vendorComponentName", () => {
  it("keys by the sourcePath + localPath pair, not localPath alone", () => {
    const a = { sourcePath: "a/package.json", localPath: "fmt" };
    const b = { sourcePath: "b/package.json", localPath: "fmt" };
    expect(vendorComponentKey(a)).not.toBe(vendorComponentKey(b));
  });

  it("falls back to sourcePath for the display name when localPath is null", () => {
    expect(vendorComponentName({ sourcePath: "daemon/contrib/fmt", localPath: null })).toBe("daemon/contrib/fmt");
    expect(vendorComponentName({ sourcePath: "daemon/contrib/fmt", localPath: "fmt" })).toBe("fmt");
  });
});

describe("workspaceMemberSearchText", () => {
  const base: WorkspaceScanMember = {
    cloneUrl: "https://example.com/fmt.git",
    localPath: "fmt",
    revision: "main",
    relation: "gitlink",
    sourcePath: "contrib/fmt",
    origin: "internal",
    resolution: null,
  };

  it("includes localPath, sourcePath, relation, cloneUrl, revision and falls back to 'in-repo layer'", () => {
    const text = workspaceMemberSearchText(base);
    expect(text).toContain("fmt");
    expect(text).toContain("contrib/fmt");
    expect(text).toContain("gitlink");
    expect(text).toContain("example.com");
    expect(text).toContain("in-repo layer");
  });

  it("includes the matched integration name when resolved", () => {
    const text = workspaceMemberSearchText({
      ...base,
      resolution: {
        status: "matched",
        cloneUrl: base.cloneUrl ?? "",
        match: { integrationId: "int-1", integrationName: "MyGerrit", provider: "gerrit", repoKey: "fmt", enabled: true },
        candidates: [],
      },
    });
    expect(text).toContain("mygerrit");
  });
});

describe("emptyPushTarget / manualLocalPath", () => {
  it("produces a manual/fixed push target with a '.' local path", () => {
    expect(emptyPushTarget()).toMatchObject({ localPath: ".", localPathMode: "fixed", origin: "manual" });
  });

  it("derives a local path from the repo key, sanitizing unsafe characters", () => {
    expect(manualLocalPath("org/My Repo.git", "fallback", [], 0)).toBe("My-Repo");
  });

  it("falls back when the repo key has no usable segment", () => {
    expect(manualLocalPath("", "fallback", [], 0)).toBe("fallback");
  });

  it("avoids collisions with other targets by appending a numeric suffix", () => {
    const targets: PushTarget[] = [
      { ...emptyPushTarget(), localPath: "fmt" },
      { ...emptyPushTarget(), localPath: "fmt-2" },
    ];
    expect(manualLocalPath("fmt", "fallback", targets, 2)).toBe("fmt-3");
  });
});

describe("legacyRoleForPushTarget", () => {
  it("classifies '.' as primary regardless of relation", () => {
    expect(legacyRoleForPushTarget({ ...emptyPushTarget(), localPath: "." })).toBe("primary");
  });

  it("classifies a gitlink relation as submodule", () => {
    expect(legacyRoleForPushTarget({ ...emptyPushTarget(), localPath: "sub", relation: "gitlink" })).toBe("submodule");
  });

  it("classifies a contains relation as related", () => {
    expect(legacyRoleForPushTarget({ ...emptyPushTarget(), localPath: "sub", relation: "contains" })).toBe("related");
  });

  it("defaults to dependency otherwise", () => {
    expect(legacyRoleForPushTarget({ ...emptyPushTarget(), localPath: "sub", relation: "fetched" })).toBe("dependency");
  });
});

describe("firstTargetBranch", () => {
  it("falls back to the default branch for HEAD/refs/commit-sha revisions", () => {
    expect(firstTargetBranch("HEAD", "develop")).toBe("develop");
    expect(firstTargetBranch("refs/tags/v1", "develop")).toBe("develop");
    expect(firstTargetBranch("abc1234", "develop")).toBe("develop");
  });

  it("falls back to 'main' when there is no default branch", () => {
    expect(firstTargetBranch(null, undefined)).toBe("main");
  });

  it("strips a refs/heads/ prefix from a real branch revision", () => {
    expect(firstTargetBranch("refs/heads/feature-x", "main")).toBe("feature-x");
  });

  it("passes through a plain branch name", () => {
    expect(firstTargetBranch("feature-x", "main")).toBe("feature-x");
  });
});

describe("saveCheckSourcesFromSkillSources / checkedSourcesAfterError", () => {
  it("maps skill sources to save-check entries carrying the given status", () => {
    const result = saveCheckSourcesFromSkillSources([{ source: "ssh://x/y", skills: [], sshUser: "git", sshPort: 29419 }], "checking");
    expect(result).toEqual([{ source: "ssh://x/y", status: "checking", sshUser: "git", sshPort: 29419 }]);
  });

  it("marks all sources checked on a non-skill-source failure message", () => {
    const sources: SaveCheckSource[] = [{ source: "a", status: "checking" }, { source: "b", status: "checking" }];
    expect(checkedSourcesAfterError(sources, "Ticket project key is required")).toEqual([
      { source: "a", status: "checked" }, { source: "b", status: "checked" },
    ]);
  });

  it("marks all sources failed on a generic validation-check failure message", () => {
    const sources: SaveCheckSource[] = [{ source: "a", status: "checking" }];
    expect(checkedSourcesAfterError(sources, "Failed to validate skill sources")).toEqual([{ source: "a", status: "failed" }]);
  });

  it("marks the indexed source failed and later sources not_checked on a 'Skill source #N' message", () => {
    const sources: SaveCheckSource[] = [
      { source: "a", status: "checking" }, { source: "b", status: "checking" }, { source: "c", status: "checking" },
    ];
    expect(checkedSourcesAfterError(sources, "Skill source #2: SSH connection check failed")).toEqual([
      { source: "a", status: "checked" }, { source: "b", status: "failed" }, { source: "c", status: "not_checked" },
    ]);
  });
});

describe("saveCheckStatusLabel", () => {
  it("renders a human label for every status", () => {
    expect(saveCheckStatusLabel("checking")).toBe("checking");
    expect(saveCheckStatusLabel("checked")).toBe("checked");
    expect(saveCheckStatusLabel("failed")).toBe("failed");
    expect(saveCheckStatusLabel("cancelled")).toBe("cancelled");
    expect(saveCheckStatusLabel("not_checked")).toBe("not checked");
  });
});

describe("normalizeRepository / repositoryLabel", () => {
  it("wraps a bare string into a RepositoryOption", () => {
    expect(normalizeRepository("repo-a")).toEqual({ key: "repo-a", name: "repo-a" });
  });

  it("passes through a valid RepositoryOption object", () => {
    const option = { key: "repo-a", name: "Repo A" };
    expect(normalizeRepository(option)).toBe(option);
  });

  it("rejects malformed or empty entries", () => {
    expect(normalizeRepository(null)).toBeNull();
    expect(normalizeRepository({ key: "", name: "x" })).toBeNull();
    expect(normalizeRepository({ key: "x", name: "" })).toBeNull();
  });

  it("appends the default branch or web URL to the label when present", () => {
    expect(repositoryLabel({ key: "a", name: "Repo A" })).toBe("Repo A");
    expect(repositoryLabel({ key: "a", name: "Repo A", defaultBranch: "main" })).toBe("Repo A · main");
    expect(repositoryLabel({ key: "a", name: "Repo A", webUrl: "https://x/a" })).toBe("Repo A · https://x/a");
  });
});

describe("normalizeTicketProject", () => {
  it("wraps a bare string into a TicketProjectOption", () => {
    expect(normalizeTicketProject("PROJ")).toEqual({ key: "PROJ", name: "PROJ" });
  });

  it("uses the key as the name fallback and preserves an optional url", () => {
    expect(normalizeTicketProject({ key: "PROJ", name: "", url: "https://x/proj" })).toEqual({
      key: "PROJ", name: "PROJ", url: "https://x/proj",
    });
  });

  it("rejects malformed or empty entries", () => {
    expect(normalizeTicketProject(null)).toBeNull();
    expect(normalizeTicketProject({ key: "", name: "x" })).toBeNull();
  });
});
