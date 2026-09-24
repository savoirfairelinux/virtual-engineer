/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthSourcesSection } from "../../../src/admin/ui/views/ConfigView/AuthSourcesSection.js";
import { SqliteStateStore } from "../../../src/state/stateStore.js";
import { tempDatabasePath } from "../helpers/tempDatabase.js";
import { setupAdmin, startAdminHttpServer, type AdminHttpServer } from "../helpers/adminHttp.js";
import { ldapAvailable, startLdapDirectoryServer, type LdapDirectoryServer } from "../helpers/ldapDirectoryServer.js";

describe.skipIf(!ldapAvailable)("AuthSourcesSection against the admin API and slapd", () => {
  let directory: LdapDirectoryServer;
  let store: SqliteStateStore;
  let admin: AdminHttpServer;
  const nodeFetch = globalThis.fetch;

  beforeAll(async () => {
    directory = await startLdapDirectoryServer();
  });

  afterAll(async () => {
    await directory.stop();
  });

  beforeEach(async () => {
    store = await SqliteStateStore.create(tempDatabasePath("ve-auth-sources-ui"));
    admin = await startAdminHttpServer(store);
    sessionStorage.setItem("ve-admin-token", await setupAdmin(admin.baseUrl));
    // The SPA issues same-origin relative requests; route them to the live admin server.
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) =>
      nodeFetch(new URL(typeof input === "string" ? input : input.toString(), admin.baseUrl), init));
  });

  afterEach(async () => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await admin.close();
    store.close();
  });

  it("creates a source after a successful connection test, then tests and deletes it", async () => {
    const user = userEvent.setup();
    render(<AuthSourcesSection />);
    expect(await screen.findByText("No authentication sources yet.")).toBeDefined();

    await user.click(screen.getByRole("button", { name: /New LDAP source/ }));
    const dialog = await screen.findByRole("dialog");
    const config = directory.config();
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: "QA directory" } });
    fireEvent.change(within(dialog).getByLabelText(/^URL/), { target: { value: config["url"] } });
    fireEvent.change(within(dialog).getByLabelText(/^CA certificate/), { target: { value: config["tlsCaCert"] } });
    fireEvent.change(within(dialog).getByLabelText(/^Bind DN/), { target: { value: config["bindDn"] } });
    fireEvent.change(within(dialog).getByLabelText(/^Bind password/), { target: { value: config["bindPassword"] } });
    fireEvent.change(within(dialog).getByLabelText(/^User search base DN/), { target: { value: config["userSearchBaseDn"] } });

    await user.click(within(dialog).getByRole("button", { name: "Test connection" }));
    expect(await within(dialog).findByText("Connection succeeded")).toBeDefined();

    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("QA directory")).toBeDefined();
    const [stored] = await store.listAuthSources();
    expect(stored?.configJson).toMatch(/"bindPassword":"veenc:v1:/);

    await user.click(screen.getByRole("button", { name: "Test QA directory" }));
    expect(await screen.findByText("Connection succeeded")).toBeDefined();

    vi.spyOn(window, "confirm").mockReturnValue(true);
    await user.click(screen.getByRole("button", { name: "Delete QA directory" }));
    expect(await screen.findByText("No authentication sources yet.")).toBeDefined();
    await expect(store.listAuthSources()).resolves.toEqual([]);
  });

  it("keeps the stored bind password when an edit leaves it masked", async () => {
    const response = await nodeFetch(`${admin.baseUrl}/api/admin/auth-sources`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${sessionStorage.getItem("ve-admin-token") ?? ""}` },
      body: JSON.stringify({ name: "Existing", kind: "ldap", config: directory.config() }),
    });
    expect(response.status).toBe(201);

    const user = userEvent.setup();
    render(<AuthSourcesSection />);
    await user.click(await screen.findByRole("button", { name: "Edit Existing" }));
    const dialog = await screen.findByRole("dialog");
    expect((within(dialog).getByLabelText(/^Bind password/) as HTMLInputElement).value).toBe("********");
    fireEvent.change(within(dialog).getByLabelText(/^Timeout/), { target: { value: "3000" } });
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await user.click(screen.getByRole("button", { name: "Test Existing" }));
    expect(await screen.findByText("Connection succeeded")).toBeDefined();
    const [stored] = await store.listAuthSources();
    expect(JSON.parse(stored?.configJson ?? "{}")).toMatchObject({ timeoutMs: 3000 });
  });
});
