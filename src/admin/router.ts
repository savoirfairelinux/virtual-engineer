import type { IncomingMessage, ServerResponse } from "node:http";
import type { Permission, ResourceType, UserRole } from "../interfaces.js";
import { writeJson } from "./adminRouteUtils.js";

export type RouteParams = Record<string, string>;
export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: RouteParams
) => Promise<void>;

/**
 * Per-route authorization metadata.
 *
 * A route is authorized by **either** a PBAC `permission` (preferred) or a
 * legacy minimum `role` (transitional fallback). When `permission` is set and
 * the request has resolved PBAC permissions, the gate enforces it — scoping to a
 * concrete resource id when `resourceParam` names a path parameter. When PBAC
 * permissions are unavailable (mocks/older embedders) or no `permission` is
 * declared, the gate falls back to the `role` check (default
 * {@link defaultRoleForMethod}).
 */
export interface RouteMeta {
  role?: UserRole;
  /** PBAC permission required to reach the route. */
  permission?: Permission;
  /** Resource type the permission scopes to (informational; derived from `permission` when omitted). */
  resourceType?: ResourceType;
  /** Path-parameter name holding the scoped resource id (e.g. `"id"`). Omit for global permissions. */
  resourceParam?: string;
  /**
   * Marks a collection/list route: authorize when the caller holds the
   * `permission` on **any** resource (scoped or global). The handler is then
   * responsible for filtering the response to the caller's accessible ids.
   */
  collection?: boolean;
}

/**
 * Minimum role for a route that declares no explicit `role` meta.
 *
 * Fail-closed: unannotated routes require `operator`, regardless of HTTP
 * method. Viewer access is opt-in — a route must explicitly declare
 * `{ role: "viewer" }` to be reachable by viewers (see the overview/tasks
 * read routes). This keeps any newly added route inaccessible to viewers
 * until someone deliberately widens it.
 */
export function defaultRoleForMethod(_method: string): UserRole {
  return "operator";
}

const ROLE_RANK: Record<UserRole, number> = { viewer: 0, operator: 1, admin: 2 };

/** True when `actual` meets or exceeds `required` (admin > operator > viewer). */
export function roleSatisfies(actual: UserRole, required: UserRole): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

interface CompiledRoute {
  method: string;
  regex: RegExp;
  keys: readonly string[];
  handler: RouteHandler;
  meta: RouteMeta;
}

/** Compile a `:param`-style path pattern to a capturing regex. */
function compilePattern(pattern: string): { regex: RegExp; keys: string[] } {
  const keys: string[] = [];
  const regexStr = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")  // escape regex metacharacters in literal segments
    .replace(/:([^/]+)/g, (_m, key: string) => {
      keys.push(key);
      return "([^/]+)";
    });
  return { regex: new RegExp(`^${regexStr}$`), keys };
}

/**
 * Lightweight declarative micro-router for the admin HTTP server.
 *
 * Routes are matched in registration order; first matching method + path wins.
 * When a path matches a registered pattern but no registered method does,
 * the router sends 405 Method Not Allowed automatically.
 *
 * Named parameters (`:id`, `:projectId`, …) are extracted, URL-decoded,
 * and passed as the `params` argument to the handler.
 */
export class Router {
  private readonly routes: CompiledRoute[] = [];

  /** Register a handler for the given HTTP method and path pattern. */
  add(method: string, pattern: string, handler: RouteHandler, meta: RouteMeta = {}): this {
    const { regex, keys } = compilePattern(pattern);
    this.routes.push({ method: method.toUpperCase(), regex, keys, handler, meta });
    return this;
  }

  /**
   * Peek at the route that would handle a method + path (without dispatching).
   * Returns the route's metadata and extracted path params, or null when no
   * route matches. Malformed URL-encoded params are returned as empty strings.
   */
  match(method: string, path: string): { meta: RouteMeta; params: RouteParams } | null {
    const upperMethod = method.toUpperCase();
    for (const route of this.routes) {
      if (route.method !== upperMethod) continue;
      const m = route.regex.exec(path);
      if (!m) continue;
      const params: RouteParams = {};
      for (let i = 0; i < route.keys.length; i++) {
        const key = route.keys[i];
        if (key === undefined) continue;
        try {
          params[key] = decodeURIComponent(m[i + 1] ?? "");
        } catch {
          params[key] = "";
        }
      }
      return { meta: route.meta, params };
    }
    return null;
  }

  /**
   * Dispatch a request to the first matching route.
   * Returns true if the request was handled (response sent), false if no route matched.
   */
  async dispatch(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    method: string
  ): Promise<boolean> {
    const upperMethod = method.toUpperCase();
    let pathMatched = false;

    for (const route of this.routes) {
      const match = route.regex.exec(path);
      if (!match) continue;
      pathMatched = true;
      if (route.method !== upperMethod) continue;

      const params: RouteParams = {};
      for (let i = 0; i < route.keys.length; i++) {
        const key = route.keys[i];
        if (key === undefined) continue;
        try {
          params[key] = decodeURIComponent(match[i + 1] ?? "");
        } catch {
          writeJson(res, 400, { error: "Bad request: malformed URL encoding" });
          return true;
        }
      }
      await route.handler(req, res, params);
      return true;
    }

    if (pathMatched) {
      writeJson(res, 405, { error: "Method not allowed" });
      return true;
    }
    return false;
  }
}
