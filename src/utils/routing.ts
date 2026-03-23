import type { HttpMethod, Route } from '../types.js';

/**
 * Escapes regex special characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compiles a path pattern string into a regex and an ordered list of
 * param names. Called once at route or child registration time.
 *
 * @param path    - The path pattern, e.g. '/users/:id'
 * @param prefix  - When true, the regex matches the pattern as a prefix
 *                  rather than an exact path. Used for mounted child routers
 *                  so that '/api' matches '/api/users/42', not just '/api'.
 *
 * Exact mode  (prefix: false) — default, used for routes:
 *   compilePath('/users/:id')
 *   → { regex: /^\/users\/([^/]+)\/?$/, paramNames: ['id'] }
 *
 * Prefix mode (prefix: true)  — used for mounted child routers:
 *   compilePath('/api', true)
 *   → { regex: /^\/api(?:\/.*)?$/, paramNames: [] }
 *
 *   compilePath('/orgs/:orgId', true)
 *   → { regex: /^\/orgs\/([^/]+)(?:\/.*)?$/, paramNames: ['orgId'] }
 *
 * The difference is only in the terminator:
 *   exact  → \/?$          (optional trailing slash, then end)
 *   prefix → (?:\/.*)?$    (optional slash + anything, then end)
 */
export function compilePath<Params extends string = never>(
  path: string,
  prefix = false,
): {
  regex: RegExp;
  paramNames: Params[];
} {
  const paramNames: Params[] = [];

  const regexStr = escapeRegex(path)
    .replace(/:([^/]+)/g, (_, name: Params) => {
      paramNames.push(name);
      return '([^/]+)';
    })
    .replace(/\//g, '\\/');

  const terminator = prefix ? '(?:\\/.*)?$' : '\\/?$';

  return {
    regex: new RegExp(`^${regexStr}${terminator}`),
    paramNames,
  };
}

type MatchSuccess = {
  success: true;
  route: Route;
  params: Record<string, string>;
};

type MatchFailure = {
  success: false;
  code: 404 | 405;
  error: string;
};

export type MatchResult = MatchSuccess | MatchFailure;

/**
 * Attempts to match an incoming pathname and HTTP method against a list
 * of compiled routes. Returns a discriminated union result.
 *
 * Distinguishes between two failure cases:
 * - 404 Not Found — no route matches the pathname at all
 * - 405 Method Not Allowed — pathname matched but no route accepts this method
 *
 * This distinction matters: a 405 tells the client their method is wrong,
 * a 404 tells them the resource does not exist. Conflating them is an HTTP
 * spec violation.
 *
 * Routes are tested in registration order — first match wins.
 *
 * @example
 * matchRoute('/users/42', routes, 'GET')
 * // success → { success: true, route, params: { id: '42' } }
 *
 * matchRoute('/users/42', routes, 'PATCH')
 * // method mismatch → { success: false, code: 405, error: 'Method Not Allowed' }
 *
 * matchRoute('/unknown', routes, 'GET')
 * // no match → { success: false, code: 404, error: 'Not Found' }
 */
export function matchRoute(
  pathname: string,
  routes: Route[],
  method: HttpMethod,
): MatchResult {
  let methodMismatch = false;

  for (const route of routes) {
    const match = pathname.match(route.regex);

    // pathname does not match this route's pattern — try next
    if (!match) continue;

    // pathname matched but method did not — flag it and keep looking
    // (a later route might match both)
    if (route.method !== method) {
      methodMismatch = true;
      continue;
    }

    // both pathname and method matched — extract params in order
    const params = Object.fromEntries(
      route.paramNames.map((name, i) => [name, match[i + 1] ?? '']),
    );

    return { success: true, route, params };
  }

  // no full match found — return the most accurate failure code
  return methodMismatch
    ? { success: false, code: 405, error: 'Method Not Allowed' }
    : { success: false, code: 404, error: 'Not Found' };
}
