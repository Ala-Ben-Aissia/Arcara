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
 * Named segments starting with ':' are captured as groups.
 * A trailing slash is always optional in the generated regex.
 *
 * @example
 * compilePath('/users/:id')
 * // → { regex: /^\/users\/([^/]+)\/?$/, paramNames: ['id'] }
 *
 * compilePath('/orgs/:orgId/users/:userId')
 * // → { regex: /^\/orgs\/([^/]+)\/users\/([^/]+)\/?$/, paramNames: ['orgId', 'userId'] }
 *
 * compilePath('/health')
 * // → { regex: /^\/health\/?$/, paramNames: [] }
 */
export function compilePath<Params extends string = never>(
  path: string,
): {
  regex: RegExp;
  paramNames: Params[];
} {
  const paramNames: Params[] = [];

  // Escape regex special characters except ':' (which we need for param detection)
  const escapedPath = escapeRegex(path);

  const regexStr = escapedPath
    // Replace each :param segment with a capture group
    .replace(/:([^/]+)/g, (_, name: Params) => {
      paramNames.push(name);
      return '([^/]+)';
    })
    // Escape forward slashes for the regex
    .replace(/\//g, '\\/');

  return {
    regex: new RegExp(`^${regexStr}\\/?$`),
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
