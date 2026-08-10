/** @vitest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CurrentUserProvider, makeCan } from "../../../src/admin/ui/authContext.js";
import type { ConfigSectionProps } from "../../../src/admin/ui/views/ConfigView/index.js";
import type { ApiMe } from "../../../src/admin/ui/types.js";

vi.mock("../../../src/admin/ui/views/ConfigView/ProjectsSection.js", () => ({
  ProjectsSection: ({ navigate }: ConfigSectionProps) => (
    <button
      data-config-dirty
      onClick={() => navigate({ section: "projects", mode: "list" })}
    >
      Mutate and leave
    </button>
  ),
}));

import { ConfigView } from "../../../src/admin/ui/views/ConfigView/index.js";

const admin: ApiMe = {
  id: "admin-1",
  username: "admin",
  role: "admin",
  capabilities: { superuser: true, grants: {} },
};

describe("Configuration dirty event ordering", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "#config/projects/new");
  });

  it("guards navigation triggered by the same dirty click", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(
      <CurrentUserProvider value={{
        user: admin,
        isAdmin: true,
        canOperate: true,
        can: makeCan(admin),
      }}>
        <ConfigView
          integrations={[]}
          plugins={[]}
          agents={[]}
          projects={[]}
          prompts={[]}
          oauthApps={[]}
          config={null}
          status={null}
          onRefresh={vi.fn()}
        />
      </CurrentUserProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Mutate and leave" }));

    expect(confirm).toHaveBeenCalledWith("Discard unsaved changes?");
    expect(window.location.hash).toBe("#config/projects/new");
  });
});