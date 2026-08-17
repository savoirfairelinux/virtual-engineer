/** @vitest-environment jsdom */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GuidedTour, type TourStep } from "../../../src/admin/ui/tour/GuidedTour.js";
import {
  CONFIG_SECTION_TOURS,
  CONFIG_SECTIONS,
  CONFIG_WORKFLOW_TOUR,
  MAIN_NAV_TOUR,
  selectTutorial,
} from "../../../src/admin/ui/tour/tourSteps.js";

const steps: TourStep[] = [{
  target: "#tour-target",
  title: "Tour step",
  body: "Follow this step.",
}];

describe("GuidedTour", () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = "";
  });

  it("restarts after dismissal when its restart token changes", async () => {
    const user = userEvent.setup();
    const onActiveChange = vi.fn();
    const { rerender } = render(
      <>
        <button id="tour-target">Target</button>
        <GuidedTour tourKey="test" steps={steps} enabled restartToken={0} onActiveChange={onActiveChange} />
      </>,
    );

    await waitFor(() => expect(screen.getByText("Tour step")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
    expect(onActiveChange).toHaveBeenLastCalledWith(true);
    expect(screen.queryByText(/click the highlighted area to continue/i)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Skip tour" }));
    expect(screen.queryByText("Tour step")).toBeNull();
    expect(onActiveChange).toHaveBeenLastCalledWith(false);

    rerender(
      <>
        <button id="tour-target">Target</button>
        <GuidedTour tourKey="test" steps={steps} enabled restartToken={1} />
      </>,
    );

    await waitFor(() => expect(screen.getByText("Tour step")).toBeTruthy());
  });

  it("advances explanatory steps with Continue", async () => {
    const user = userEvent.setup();
    const continueSteps: TourStep[] = [
      {
        target: "#tour-target",
        title: "Read this field",
        body: "This field controls the value.",
        advance: "continue",
      },
      {
        target: "#next-target",
        title: "Next field",
        body: "This is the next field.",
        advance: "continue",
      },
    ];

    render(
      <>
        <div id="tour-target">Field</div>
        <div id="next-target">Next field input</div>
        <GuidedTour tourKey="continue-test" steps={continueSteps} enabled />
      </>,
    );

    await waitFor(() => expect(screen.getByText("Read this field")).toBeTruthy());
    const continueButton = screen.getByRole("button", { name: "Continue" });
    expect(continueButton.className).toContain("btn primary");
    expect((continueButton as HTMLButtonElement).style.alignSelf).toBe("flex-end");

    await user.click(screen.getByText("Field"));
    expect(screen.getByText("Read this field")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(screen.getByText("Next field")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
  });

  it("keeps an explanatory spotlight aligned with its target while scrolling", async () => {
    const target = document.createElement("div");
    target.id = "scroll-target";
    target.textContent = "Scrollable field";
    document.body.append(target);

    let targetRect = {
      top: 40,
      left: 20,
      right: 120,
      bottom: 80,
      width: 100,
      height: 40,
    } as DOMRect;
    vi.spyOn(target, "getBoundingClientRect").mockImplementation(() => targetRect);

    render(
      <GuidedTour
        tourKey="scroll-test"
        steps={[{
          target: "#scroll-target",
          title: "Scrollable field",
          body: "This explanation follows the field.",
          advance: "continue",
        }]}
        enabled
      />,
    );

    await waitFor(() => expect(screen.getByText("This explanation follows the field.")).toBeTruthy());
    const bubble = document.querySelector<HTMLElement>(".ve-tour-bubble");
    expect(bubble?.style.top).toBe("94px");

    targetRect = {
      top: 180,
      left: 20,
      right: 120,
      bottom: 220,
      width: 100,
      height: 40,
    } as DOMRect;
    window.dispatchEvent(new Event("scroll"));

    await waitFor(() => expect(bubble?.style.top).toBe("234px"));
  });

  it("waits for a route-backed action instead of advancing after a rejected navigation", async () => {
    const user = userEvent.setup();
    const routeSteps: TourStep[] = [
      {
        target: "#route-action",
        title: "Open the form",
        body: "This action is guarded by the current form.",
        advance: "click",
        completion: "route-changes",
      },
      {
        target: "#route-next",
        title: "Form field",
        body: "The next route is ready.",
        advance: "continue",
      },
    ];

    render(
      <>
        <button id="route-action" onClick={(event) => event.preventDefault()}>Open</button>
        <div id="route-next">Next route</div>
        <GuidedTour tourKey="route-test" steps={routeSteps} enabled />
      </>,
    );

    await waitFor(() => expect(screen.getByText("Open the form")).toBeTruthy());
  expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(screen.getByText("Open the form")).toBeTruthy();
  });

  it("can continue past a route-backed step without changing the route", async () => {
    const user = userEvent.setup();
    render(
      <>
        <button id="workflow-integrations">Integrations</button>
        <div id="workflow-agents">Agents library</div>
        <GuidedTour
          tourKey="workflow-continue-test"
          steps={[
            {
              target: "#workflow-integrations",
              title: "Integrations first",
              body: "Start with your provider connections.",
              advance: "click",
              completion: "route-changes",
            },
            {
              target: "#workflow-agents",
              title: "Agents library",
              body: "Then configure a reusable agent.",
              advance: "continue",
            },
          ]}
          enabled
        />
      </>,
    );

    await waitFor(() => expect(screen.getByText("Integrations first")).toBeTruthy());
    const initialHash = window.location.hash;
    await user.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(screen.getByText("Then configure a reusable agent.")).toBeTruthy());
    expect(window.location.hash).toBe(initialHash);
  });

  it("keeps a continued tour alive until a later-page target appears", async () => {
    const user = userEvent.setup();
    const onActiveChange = vi.fn();
    render(
      <>
        <button id="integration-add">Add integration</button>
        <GuidedTour
          tourKey="cross-page-test"
          steps={[
            {
              target: "#integration-add",
              title: "Add an integration",
              body: "Open the integration form.",
              completion: "route-changes",
            },
            {
              target: "#integration-form-name",
              title: "Name the connection",
              body: "This field appears on the next page.",
              optional: true,
              advance: "continue",
            },
          ]}
          enabled
          onActiveChange={onActiveChange}
        />
      </>,
    );

    await waitFor(() => expect(screen.getByText("Add an integration")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(onActiveChange).toHaveBeenLastCalledWith(true);

    const formName = document.createElement("input");
    formName.id = "integration-form-name";
    document.body.append(formName);
    window.dispatchEvent(new Event("hashchange"));

    await waitFor(() => expect(screen.getByText("This field appears on the next page.")).toBeTruthy());
  });

  it("guides configuration in integration, agent, and project order", () => {
    expect(CONFIG_WORKFLOW_TOUR.map((step) => step.target)).toEqual([
      '[data-tour="config-nav-integrations"]',
      '[data-tour="config-nav-agents"]',
      '[data-tour="config-nav-projects"]',
      '[data-tour="tutorial-launcher"]',
    ]);
    expect(MAIN_NAV_TOUR.find((step) => step.target === '[data-tour="nav-config"]')?.optional).toBe(true);
    expect(CONFIG_SECTION_TOURS.prompts.at(-1)?.optional).toBe(true);
    expect(CONFIG_WORKFLOW_TOUR.at(-1)?.placement).toBe("left");
    expect([...MAIN_NAV_TOUR, ...CONFIG_WORKFLOW_TOUR, ...Object.values(CONFIG_SECTION_TOURS).flat()]
      .every((step) => !/\bclick\b/i.test(step.body))).toBe(true);
  });

  it("defines one contextual tour and real action target for every configuration section", () => {
    const actionTargets = {
      integrations: '[data-tour="integrations-add"]',
      oauth: '[data-tour="oauth-register"]',
      agents: '[data-tour="agents-new"]',
      projects: '[data-tour="projects-new-button"]',
      prompts: '[data-tour="prompts-new"]',
      "runtime-policies": '[data-tour="runtime-policies-new"]',
      denials: '[data-tour="denials-refresh"]',
      users: '[data-tour="users-new"]',
      groups: '[data-tour="groups-new"]',
      policies: '[data-tour="policies-new"]',
      audit: '[data-tour="audit-refresh"]',
      system: '[data-tour="system-settings"]',
    } as const;
    const deepTargets = {
      integrations: '[data-tour="integration-provider-picker"]',
      oauth: '[data-tour="oauth-form-provider"]',
      agents: '[data-tour="agent-form-basics"]',
      projects: '[data-tour="project-form-name"]',
      prompts: '[data-tour="prompt-form-label"]',
      "runtime-policies": '[data-tour="runtime-policy-form-name"]',
      denials: '[data-tour="denials-table"]',
      users: '[data-tour="user-form-username"]',
      groups: '[data-tour="group-form-name"]',
      policies: '[data-tour="policy-form-name"]',
      audit: '[data-tour="audit-filters"]',
      system: '[data-tour="system-settings-form"]',
    } as const;

    expect(Object.keys(CONFIG_SECTION_TOURS).sort()).toEqual([...CONFIG_SECTIONS].sort());
    expect(CONFIG_SECTION_TOURS.overview).toBe(CONFIG_WORKFLOW_TOUR);

    for (const section of CONFIG_SECTIONS) {
      const sectionTour = CONFIG_SECTION_TOURS[section];
      if (section === "overview") {
        expect(sectionTour).toBe(CONFIG_WORKFLOW_TOUR);
        continue;
      }
      expect(sectionTour[0]?.target).toBe(actionTargets[section]);
      expect(sectionTour.length).toBeGreaterThan(1);
      expect(sectionTour[1]?.target).toBe(deepTargets[section]);
      expect(sectionTour.slice(1).some((step) => step.advance === "continue")).toBe(true);
    }
  });

  it("selects distinct manual keys for configuration sections", () => {
    expect(selectTutorial("overview", "overview")).toEqual({ key: "main-nav", steps: MAIN_NAV_TOUR });
    expect(selectTutorial("tasks", "overview")).toEqual({ key: "main-nav", steps: MAIN_NAV_TOUR });
    expect(selectTutorial("config", "overview")).toEqual({ key: "config-workflow", steps: CONFIG_WORKFLOW_TOUR });
    expect(selectTutorial("config", "integrations")).toEqual({
      key: "config-integrations-v2",
      steps: CONFIG_SECTION_TOURS.integrations,
    });
    expect(selectTutorial("config", "system")).toEqual({
      key: "config-system-v2",
      steps: CONFIG_SECTION_TOURS.system,
    });
  });
});