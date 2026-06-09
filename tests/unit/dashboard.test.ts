/**
 * Tests for the React/Vite-based admin dashboard shell renderer.
 *
 * These tests verify that `renderAdminDashboardHtml` generates a correct
 * HTML shell with:
 *  - the `#root` mount point
 *  - a nonce-gated inline bootstrap script
 *  - references to the Vite-built JS/CSS assets (or a fallback message)
 *  - correct XSS-escaped bootstrap JSON
 */
import { describe, expect, it } from "vitest";
import { renderAdminDashboardHtml } from "../../src/admin/dashboard.js";

describe("renderAdminDashboardHtml", () => {
  it("renders the #root mount point", () => {
    const html = renderAdminDashboardHtml();
    expect(html).toContain('<div id="root">');
  });

  it("renders bootstrap config without auth by default", () => {
    const html = renderAdminDashboardHtml();
    expect(html).toContain(
      'window.__VE_ADMIN_BOOTSTRAP__ = {"requiresAuth":false,"authMode":"none","gerritBaseUrl":null,"gitlabBaseUrl":null,"ticketLinkTemplates":{}}'
    );
  });

  it("renders bootstrap config for auth-protected mode", () => {
    const html = renderAdminDashboardHtml({ requiresAuth: true, authMode: "hmac" });
    expect(html).toContain('"requiresAuth":true,"authMode":"hmac"');
  });

  it("includes nonce on the bootstrap script tag when nonce is provided", () => {
    const html = renderAdminDashboardHtml({ nonce: "test-nonce-abc" });
    expect(html).toContain('nonce="test-nonce-abc"');
    expect(html).toContain("__VE_ADMIN_BOOTSTRAP__");
  });

  it("renders a script element (built asset or fallback)", () => {
    const html = renderAdminDashboardHtml();
    expect(html).toMatch(/<script/);
  });

  it("XSS-escapes < > & in bootstrap values", () => {
    const html = renderAdminDashboardHtml({
      gerritBaseUrl: "<script>alert(1)</script>",
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("\\u003cscript\\u003ealert(1)\\u003c/script\\u003e");
  });

  it("includes gitlabBaseUrl in the bootstrap config", () => {
    const html = renderAdminDashboardHtml({ gitlabBaseUrl: "https://gitlab.example.com" });
    expect(html).toContain('"gitlabBaseUrl":"https://gitlab.example.com"');
  });

  it("includes ticketLinkTemplates in the bootstrap config", () => {
    const html = renderAdminDashboardHtml({
      ticketLinkTemplates: { redmine: "https://rm.example.com/issues/{id}" },
    });
    expect(html).toContain('"redmine":"https://rm.example.com/issues/{id}"');
  });

  it("sets dark theme attribute on html element", () => {
    const html = renderAdminDashboardHtml();
    expect(html).toContain('data-theme="dark"');
  });

  it("has correct charset and viewport meta tags", () => {
    const html = renderAdminDashboardHtml();
    expect(html).toContain('charset="utf-8"');
    expect(html).toContain('name="viewport"');
  });

  it("has title containing Virtual Engineer", () => {
    const html = renderAdminDashboardHtml();
    expect(html).toContain("Virtual Engineer");
    expect(html).toContain("<title>");
  });

  it("does not inject inline script code (delegates to built JS)", () => {
    const html = renderAdminDashboardHtml();
    // The new shell must not contain the legacy inline JS functions
    expect(html).not.toContain("connectLogsStream");
    expect(html).not.toContain("renderCycles");
    expect(html).not.toContain("loadProviders");
  });
});


