import type { IncomingMessage, ServerResponse } from "node:http";
import type { Permission, ResourceType } from "../interfaces.js";
import { writeJson } from "./adminRouteUtils.js";

export type RouteParams = Record<string, string>;
export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: RouteParams
) => Promise<void>;

/**
 * Per-route authorization metadata (pure PBAC — no role fallback).
 *
 * Every non-public route MUST declare exactly one authorization mode:
 * - `permission`: the PBAC permission required. When `resourceParam` names a path
 *   parameter, the check is scoped to that resource id; `collection` marks a list
 *   route (authorize on any grant, then the handler filters the response).
 * - `authenticated`: any logged-in user may reach the route regardless of policy
 *   (used for auth-self routes: `me`, `logout`, own password change).
 *
 * A route with neither is reachable only by the superuser (the `admin` role /
 * bootstrap) — a fail-closed safety net for unannotated routes.
 */
export interface RouteMeta {
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
  /** Any authenticated user may reach the route (auth-self routes). */
  authenticated?: boolean;
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
