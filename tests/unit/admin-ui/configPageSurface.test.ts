/** @vitest-environment jsdom */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConfigPageSurface } from "../../../src/admin/ui/views/ConfigView/ConfigPageSurface.js";
import { IntegrationFormModal } from "../../../src/admin/ui/views/ConfigView/IntegrationFormModal.js";
import { PromptFormModal } from "../../../src/admin/ui/views/ConfigView/PromptFormModal.js";
import { Field, FieldInput, Modal } from "../../../src/admin/ui/components/Modal.js";
import { Drawer } from "../../../src/admin/ui/components/Drawer.js";
import { RowCard } from "../../../src/admin/ui/components/RowCard.js";
import { Toggle } from "../../../src/admin/ui/components/Toggle.js";

const GENERATED_PUBLIC_KEY = "ssh-ed25519 AAAATEST virtual-engineer-gerrit";

function renderGeneratedSshIntegration(): void {
  render(createElement(IntegrationFormModal, {
    integration: {
      id: "gerrit-1",
      provider: "gerrit",
      name: "Primary Gerrit",
      enabled: true,
      capabilities: ["source_control"],
      domainCapabilities: ["source_control"],
      config: {
        sshPrivateKeyEnc: "********",
        sshPublicKey: GENERATED_PUBLIC_KEY,
      },
    },
    plugins: [{
      provider: "gerrit",
      name: "Gerrit",
      capabilities: ["source_control"],
      domainCapabilities: ["source_control"],
      requiredFields: [],
      agentConfigFields: [],
      supportsSshAuth: true,
    }],
    onClose: vi.fn(),
    onSaved: vi.fn(),
    onDirtyChange: vi.fn(),
  }));
}

function replaceProperty(target: object, propertyKey: PropertyKey, value: unknown): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(target, propertyKey);
  Object.defineProperty(target, propertyKey, { configurable: true, value });
  return () => {
    if (descriptor) {
      Object.defineProperty(target, propertyKey, descriptor);
    } else {
      Reflect.deleteProperty(target, propertyKey);
    }
  };
}

describe("ConfigPageSurface", () => {
  it("renders modal content as an inline form page", () => {
    const html = renderToStaticMarkup(createElement(
      ConfigPageSurface,
      null,
      createElement(Modal, {
        title: "New integration",
        sub: "Connect a provider",
        onClose: vi.fn(),
        footer: createElement("button", null, "Save"),
        children: createElement("label", null, "Provider name"),
      }),
    ));

    expect(html).toContain('class="config-entity-page config-form-page"');
    expect(html).toContain("New integration");
    expect(html).toContain("Provider name");
    expect(html).toContain("Save");
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain("modal-scrim");
  });

  it("renders drawer content as an inline detail page", () => {
    const html = renderToStaticMarkup(createElement(
      ConfigPageSurface,
      null,
      createElement(Drawer, {
        eyebrow: "Integration",
        title: "Primary GitHub",
        onClose: vi.fn(),
        footer: createElement("button", null, "Edit"),
        children: createElement("p", null, "Enabled"),
      }),
    ));

    expect(html).toContain('class="config-entity-page config-detail-page"');
    expect(html).toContain("Primary GitHub");
    expect(html).toContain("Enabled");
    expect(html).toContain("Edit");
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain("drawer-scrim");
  });

  it("marks the provider picker as a responsive grid", () => {
    const html = renderToStaticMarkup(createElement(
      ConfigPageSurface,
      null,
      createElement(IntegrationFormModal, {
        plugins: [{
          provider: "github",
          name: "GitHub",
          capabilities: [],
          domainCapabilities: ["issue_tracking"],
          requiredFields: [],
          agentConfigFields: [],
        }],
        onClose: vi.fn(),
        onSaved: vi.fn(),
        onDirtyChange: vi.fn(),
      }),
    ));

    expect(html).toContain('class="config-provider-grid"');
  });

  it("filters integration providers and clears the search", async () => {
    const user = userEvent.setup();
    render(createElement(IntegrationFormModal, {
      plugins: [
        {
          provider: "github",
          name: "GitHub",
          capabilities: [],
          domainCapabilities: ["issue_tracking", "code_review"],
          requiredFields: [],
          agentConfigFields: [],
        },
        {
          provider: "redmine",
          name: "Redmine",
          capabilities: [],
          domainCapabilities: ["issue_tracking"],
          requiredFields: [],
          agentConfigFields: [],
        },
      ],
      onClose: vi.fn(),
      onSaved: vi.fn(),
      onDirtyChange: vi.fn(),
    }));

    const search = screen.getByRole("searchbox", { name: "Search integrations" });
    await user.type(search, "git");

    expect(screen.getByRole("button", { name: /GitHub/ })).toBeDefined();
    expect(screen.queryByRole("button", { name: /Redmine/ })).toBeNull();

    await user.clear(search);
    await user.type(search, "missing");
    expect(screen.getByText('No integrations match "missing".')).toBeDefined();

    await user.click(within(screen.getByRole("status")).getByRole("button", { name: "Clear search" }));
    expect(screen.getByRole("button", { name: /GitHub/ })).toBeDefined();
    expect(screen.getByRole("button", { name: /Redmine/ })).toBeDefined();
  });

  it("copies a generated SSH key without the Clipboard API", async () => {
    const execCommand = vi.fn(() => true);
    const restoreClipboard = replaceProperty(navigator, "clipboard", undefined);
    const restoreExecCommand = replaceProperty(document, "execCommand", execCommand);

    try {
      renderGeneratedSshIntegration();

      const copyButton = screen.getByRole("button", { name: "Copy" });
      const focus = vi.spyOn(copyButton, "focus");
      copyButton.focus();
      fireEvent.click(copyButton);

      expect(execCommand).toHaveBeenCalledWith("copy");
      expect(await screen.findByRole("button", { name: "Copied!" })).toBeDefined();
      expect(focus).toHaveBeenCalledTimes(2);
    } finally {
      restoreClipboard();
      restoreExecCommand();
    }
  });

  it("falls back when the Clipboard API rejects the SSH key copy", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("Clipboard denied"));
    const execCommand = vi.fn(() => true);
    const restoreClipboard = replaceProperty(navigator, "clipboard", { writeText });
    const restoreExecCommand = replaceProperty(document, "execCommand", execCommand);

    try {
      renderGeneratedSshIntegration();

      fireEvent.click(screen.getByRole("button", { name: "Copy" }));

      expect(await screen.findByRole("button", { name: "Copied!" })).toBeDefined();
      expect(writeText).toHaveBeenCalledWith(GENERATED_PUBLIC_KEY);
      expect(execCommand).toHaveBeenCalledWith("copy");
    } finally {
      restoreClipboard();
      restoreExecCommand();
    }
  });

  it("replaces SSH copy success with an error when a retry fails", async () => {
    const writeText = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Clipboard denied"));
    const execCommand = vi.fn(() => false);
    const restoreClipboard = replaceProperty(navigator, "clipboard", { writeText });
    const restoreExecCommand = replaceProperty(document, "execCommand", execCommand);

    try {
      renderGeneratedSshIntegration();

      fireEvent.click(screen.getByRole("button", { name: "Copy" }));
      fireEvent.click(await screen.findByRole("button", { name: "Copied!" }));

      expect((await screen.findByRole("alert")).textContent).toContain("Copy failed");
      expect(screen.getByRole("button", { name: "Copy" })).toBeDefined();
      expect(screen.queryByRole("button", { name: "Copied!" })).toBeNull();
    } finally {
      restoreClipboard();
      restoreExecCommand();
    }
  });

  it("clears a stale SSH copy error after regenerating the key", async () => {
    const restoreClipboard = replaceProperty(navigator, "clipboard", undefined);
    const restoreExecCommand = replaceProperty(document, "execCommand", vi.fn(() => false));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      sshPrivateKeyEnc: "encrypted-new-key",
      sshPublicKey: "ssh-ed25519 AAAANEW virtual-engineer-gerrit",
    }), { status: 200 })));

    try {
      renderGeneratedSshIntegration();

      fireEvent.click(screen.getByRole("button", { name: "Copy" }));
      expect((await screen.findByRole("alert")).textContent).toContain("Copy failed");

      fireEvent.click(screen.getByRole("button", { name: "Regenerate key" }));

      expect(await screen.findByDisplayValue("ssh-ed25519 AAAANEW virtual-engineer-gerrit")).toBeDefined();
      expect(screen.queryByRole("alert")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
      restoreClipboard();
      restoreExecCommand();
    }
  });

  it("copies an OAuth device code without the Clipboard API", async () => {
    const execCommand = vi.fn(() => true);
    const restoreClipboard = replaceProperty(navigator, "clipboard", undefined);
    const restoreExecCommand = replaceProperty(document, "execCommand", execCommand);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      userCode: "ABCD-EFGH",
      verificationUri: "https://github.com/login/device",
      deviceCode: "device-code",
    }), { status: 200 })));

    try {
      render(createElement(IntegrationFormModal, {
        integration: {
          id: "copilot-1",
          provider: "copilot",
          name: "GitHub Copilot",
          enabled: true,
          capabilities: ["agent_execution"],
          domainCapabilities: ["agent_execution"],
        },
        plugins: [{
          provider: "copilot",
          name: "GitHub Copilot",
          capabilities: ["agent_execution"],
          domainCapabilities: ["agent_execution"],
          requiredFields: [],
          agentConfigFields: [],
          oauth: {
            mode: "device",
            tokenField: "token",
            providerName: "GitHub",
            heading: "GitHub device authorization",
            connectLabel: "Connect GitHub",
            reconnectLabel: "Reconnect GitHub",
            pendingLabel: "Authorization pending",
            startPath: "/api/admin/oauth/start",
            completePath: "/api/admin/oauth/complete",
          },
        }],
        onClose: vi.fn(),
        onSaved: vi.fn(),
        onDirtyChange: vi.fn(),
      }));

      fireEvent.click(screen.getByRole("button", { name: "Connect GitHub" }));
      expect(await screen.findByText("ABCD-EFGH")).toBeDefined();
      fireEvent.click(screen.getByRole("button", { name: "Copy" }));

      expect(execCommand).toHaveBeenCalledWith("copy");
      expect(await screen.findByRole("button", { name: "Copied" })).toBeDefined();
    } finally {
      vi.unstubAllGlobals();
      restoreClipboard();
      restoreExecCommand();
    }
  });

  it("keeps row actions beside an explicitly labelled open button", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const onDelete = vi.fn();
    render(createElement(
      RowCard,
      {
        onClick: onOpen,
        ariaLabel: "Open Primary GitHub",
        children: [
          createElement("span", { key: "name" }, "Primary GitHub"),
          createElement("button", { key: "delete", onClick: onDelete }, "Delete"),
        ],
      },
    ));

    const openButton = screen.getByRole("button", { name: "Open Primary GitHub" });
    await user.click(openButton);
    openButton.focus();
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(onOpen).toHaveBeenCalledTimes(2);
    expect(onDelete).toHaveBeenCalledOnce();

    const html = renderToStaticMarkup(createElement(
      RowCard,
      {
        onClick: vi.fn(),
        ariaLabel: "Open Primary GitHub",
        children: [
          createElement("span", { key: "name" }, "Primary GitHub"),
          createElement("button", { key: "delete" }, "Delete"),
        ],
      },
    ));

    expect(html).toContain('class="row-card-open"');
    expect(html).toContain('aria-label="Open Primary GitHub"');
    expect(html).not.toContain('role="button"');
  });

  it("gives switches an accessible name", () => {
    const html = renderToStaticMarkup(createElement(Toggle, {
      on: true,
      label: "Enable Primary GitHub",
    }));

    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-label="Enable Primary GitHub"');
  });

  it("associates a Field label and hint with a custom control id", () => {
    render(createElement(
      Field,
      {
        label: "Repository",
        hint: "Choose the source repository",
        children: createElement(FieldInput, {
          id: "repository-input",
          "aria-describedby": "external-description",
        }),
      },
    ));

    const input = screen.getByLabelText("Repository");
    const hint = screen.getByText("Choose the source repository");
    expect(input.id).toBe("repository-input");
    expect(input.getAttribute("aria-describedby")).toBe(`external-description ${hint.id}`);
  });

  it("labels prompt roles and shows role-specific content guidance", async () => {
    const user = userEvent.setup();

    render(createElement(PromptFormModal, {
      onClose: vi.fn(),
      onSaved: vi.fn(),
    }));

    const promptType = screen.getByRole("combobox", { name: /Prompt type/ });
    expect(screen.getByRole("option", { name: "System Prompt" })).toBeDefined();
    expect(screen.getByRole("option", { name: "Instructions Prompt" })).toBeDefined();
    expect(screen.getByText("Task-specific guidance that is merged into each generated request.")).toBeDefined();
    expect(screen.getByPlaceholderText("Example: Prefer small patches, explain trade-offs, and mention the files you changed.")).toBeDefined();

    await user.selectOptions(promptType, "system");

    expect(screen.getByText("Permanent instructions that shape the agent's base behavior.")).toBeDefined();
    expect(screen.getByPlaceholderText("Example: You are a careful coding agent. Follow repository conventions and never commit secrets.")).toBeDefined();
  });
});
