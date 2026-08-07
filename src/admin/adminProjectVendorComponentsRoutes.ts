import { writeJson, readBody, zodErrorBody, requireStore } from "./adminRouteUtils.js";
import { makeProjectId } from "../interfaces.js";
import type { Router } from "./router.js";
import {
  recordAudit,
  toVendorComponentInputs,
  vendorComponentsSchema,
  type ProjectsRouteDeps,
} from "./adminProjectsShared.js";

/** Register project vendor-component routes (workspace-scanned third-party dependencies). */
export function registerProjectVendorComponentsRoutes(router: Router, deps: ProjectsRouteDeps): void {
  router.add("GET", "/api/admin/projects/:id/vendor-components", async (_req, res, params) => {
    if (!requireStore(deps.projectStore, res, "Project store not available")) return;
    const store = deps.projectStore;
    const id = makeProjectId(params["id"] ?? "");
    if (!await store.getProjectById(id)) { writeJson(res, 404, { error: "Project not found" }); return; }
    writeJson(res, 200, { components: await store.listProjectVendorComponents(id) });
  }, { permission: "project.read", resourceParam: "id" });

  router.add("PUT", "/api/admin/projects/:id/vendor-components", async (req, res, params) => {
    if (!requireStore(deps.projectStore, res, "Project store not available")) return;
    const store = deps.projectStore;
    const id = makeProjectId(params["id"] ?? "");
    const existing = await store.getProjectById(id);
    if (!existing) { writeJson(res, 404, { error: "Project not found" }); return; }
    const body = await readBody(req);
    if (!body) { writeJson(res, 400, { error: "Request body required" }); return; }
    const parsed = vendorComponentsSchema.safeParse(body);
    if (!parsed.success) {
      writeJson(res, 400, zodErrorBody(parsed.error, "Invalid vendor components payload"));
      return;
    }
    const inputs = toVendorComponentInputs(parsed.data.components);
    const components = await store.replaceProjectVendorComponents(id, inputs);
    recordAudit(deps.auditStore, req, {
      action: "project.vendor_components_update",
      targetType: "project",
      targetId: id,
      details: { name: existing.name, componentCount: components.length },
    });
    writeJson(res, 200, { components });
  }, { permission: "project.write", resourceParam: "id" });
}
