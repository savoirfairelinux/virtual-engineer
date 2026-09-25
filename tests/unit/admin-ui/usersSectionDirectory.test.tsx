/** @vitest-environment jsdom */
import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { UsersSection } from "../../../src/admin/ui/views/ConfigView/UsersSection.js";
import { EMPTY_LIST_FILTER } from "../../../src/admin/ui/views/ConfigView/listFilters.js";
import type { ConfigRoute } from "../../../src/admin/ui/views/ConfigView/configRouting.js";
import type { ConfigViewData } from "../../../src/admin/ui/views/ConfigView/index.js";
import { SqliteStateStore } from "../../../src/state/stateStore.js";
import { tempDatabasePath } from "../helpers/tempDatabase.js";
import { requestJson, setupAdmin, startAdminHttpServer, type AdminHttpServer } from "../helpers/adminHttp.js";
import { ldapAvailable, startLdapDirectoryServer, type LdapDirectoryServer } from "../helpers/ldapDirectoryServer.js";

const EMPTY_CONFIG_DATA: ConfigViewData = {
  integrations: [],
  plugins: [],
  agents: [],
  projects: [],
  prompts: [],
  oauthApps: [],
  config: null,
  status: null,
  onRefresh: () => undefined,
};

function UsersHarness({ initial }: { initial: ConfigRoute }) {
  const [route, setRoute] = useState<ConfigRoute>(initial);
  const [filter, setFilter] = useState(EMPTY_LIST_FILTER);
  return (
    <UsersSection
      {...EMPTY_CONFIG_DATA}
      route={route}
      navigate={setRoute}
      markClean={() => undefined}
      setDirty={() => undefined}
      listFilter={filter}
      onListFilterChange={setFilter}
    />
  );
}

describe.skipIf(!ldapAvailable)("UsersSection directory accounts against the admin API and slapd", () => {
  let directory: LdapDirectoryServer;
  let store: SqliteStateStore;
  let admin: AdminHttpServer;
  let token: string;
  const nodeFetch = globalThis.fetch;

  beforeAll(async () => {
    directory = await startLdapDirectoryServer();
    await directory.addUser("alice", "alice-Pass-1");
    await directory.addUser("bob", "bob-Pass-1");
  });

  afterAll(async () => {
    await directory.stop();
  });

  beforeEach(async () => {
    store = await SqliteStateStore.create(tempDatabasePath("ve-users-ui"));
    admin = await startAdminHttpServer(store);
    token = await setupAdmin(admin.baseUrl);
    sessionStorage.setItem("ve-admin-token", token);
    const created = await requestJson(admin.baseUrl, "POST", "/api/admin/auth-sources", {
      token,
      body: { name: "Corp LDAP", kind: "ldap", config: directory.config() },
    });
    expect(created.status).toBe(201);
    // The SPA issues same-origin relative requests; route them to the live admin server.
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) =>
      nodeFetch(new URL(typeof input === "string" ? input : input.toString(), admin.baseUrl), init));
  });

  afterEach(async () => {
    cleanup();
    vi.unstubAllGlobals();
    await admin.close();
    store.close();
  });

  it("creates a directory user without a password", async () => {
    const user = userEvent.setup();
    render(<UsersHarness initial={{ section: "users", mode: "create" }} />);

    const dialog = await screen.findByRole("dialog");
    const method = await within(dialog).findByLabelText(/^Sign-in method/);
    expect(within(dialog).getByRole("option", { name: "Corp LDAP" })).toBeDefined();
    fireEvent.change(method, { target: { value: (await store.listAuthSources())[0]?.id } });
    expect(within(dialog).queryByLabelText(/^Password/)).toBeNull();
    fireEvent.change(within(dialog).getByLabelText(/^Directory username/), { target: { value: "alice" } });
    await user.click(within(dialog).getByRole("button", { name: "Create user" }));

    const open = await screen.findByRole("button", { name: "Open user alice" });
    const row = open.parentElement as HTMLElement;
    expect(within(row).getByText("Corp LDAP")).toBeDefined();
    expect(within(row).queryByTitle("Reset password")).toBeNull();
    expect((await store.getUserByUsername("alice"))?.passwordHash).toBe("!external");
  });

  it("links a local user to the directory and converts it back to a local password", async () => {
    const user = userEvent.setup();
    const created = await requestJson(admin.baseUrl, "POST", "/api/admin/users", {
      token,
      body: { username: "carol", password: "carol-Pass-1", role: "viewer" },
    });
    const userId = (created.body["user"] as Record<string, unknown>)["id"] as string;
    render(<UsersHarness initial={{ section: "users", mode: "detail", id: userId }} />);

    expect(await screen.findByText("Local password")).toBeDefined();
    await user.click(await screen.findByRole("button", { name: "Link to directory" }));
    const linkDialog = await screen.findByRole("dialog");
    fireEvent.change(within(linkDialog).getByLabelText(/^Directory username/), { target: { value: "bob" } });
    await user.click(within(linkDialog).getByRole("button", { name: "Link account" }));

    expect(await screen.findByText("Corp LDAP (directory)")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Reset password" })).toBeNull();
    await expect(store.getUserIdentityByUserId(userId)).resolves.toMatchObject({ externalUsername: "bob" });

    await user.click(screen.getByRole("button", { name: "Convert to local password" }));
    const convertDialog = await screen.findByRole("dialog");
    fireEvent.change(within(convertDialog).getByLabelText(/^New password/), { target: { value: "carol-Pass-2" } });
    fireEvent.change(within(convertDialog).getByLabelText(/^Confirm password/), { target: { value: "carol-Pass-2" } });
    await user.click(within(convertDialog).getByRole("button", { name: "Convert account" }));

    expect(await screen.findByText("Local password")).toBeDefined();
    await expect(store.getUserIdentityByUserId(userId)).resolves.toBeNull();
    const login = await requestJson(admin.baseUrl, "POST", "/api/admin/auth/login", { body: { username: "carol", password: "carol-Pass-2" } });
    expect(login.status).toBe(200);
  });

  it("selects a source that loads after the link dialog opened from its URL", async () => {
    const user = userEvent.setup();
    const created = await requestJson(admin.baseUrl, "POST", "/api/admin/users", {
      token,
      body: { username: "carol", password: "carol-Pass-1", role: "viewer" },
    });
    const userId = (created.body["user"] as Record<string, unknown>)["id"] as string;
    let releaseSources = (): void => undefined;
    const sourcesHeld = new Promise<void>((resolve) => { releaseSources = resolve; });
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input.toString(), admin.baseUrl);
      if (url.pathname === "/api/admin/auth-sources") await sourcesHeld;
      return nodeFetch(url, init);
    });
    render(<UsersHarness initial={{ section: "users", mode: "link", id: userId }} />);

    const linkDialog = await screen.findByRole("dialog");
    releaseSources();
    expect(await within(linkDialog).findByRole("option", { name: "Corp LDAP" })).toBeDefined();
    fireEvent.change(within(linkDialog).getByLabelText(/^Directory username/), { target: { value: "bob" } });
    await user.click(within(linkDialog).getByRole("button", { name: "Link account" }));

    expect(await screen.findByText("Corp LDAP (directory)")).toBeDefined();
    await expect(store.getUserIdentityByUserId(userId)).resolves.toMatchObject({ externalUsername: "bob" });
  });
});
