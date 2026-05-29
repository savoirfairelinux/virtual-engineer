import type { IncomingMessage, ServerResponse } from "node:http";
import { writeJson } from "./adminRouteUtils.js";

export type RouteParams = Record<string, string>;
export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: RouteParams
) => Promise<void>;

interface CompiledRoute {
  method: string;
  regex: RegExp;
  keys: readonly string[];
  handler: RouteHandler;
}

/** Compile a `:param`-style path pattern to a capturing regex. */
function compilePattern(pattern: string): { regex: RegExp; keys: string[] } {
  const keys: string[] = [];
  const regexStr = pattern.replace(/:([^/]+)/g, (_m, key: string) => {
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
  add(method: string, pattern: string, handler: RouteHandler): this {
    const { regex, keys } = compilePattern(pattern);
    this.routes.push({ method: method.toUpperCase(), regex, keys, handler });
    return this;
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
        if (key !== undefined) params[key] = decodeURIComponent(match[i + 1] ?? "");
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
