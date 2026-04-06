import type { HttpMethod, Route } from '../types.js';

// ── Path compiler ─────────────────────────────────────────────────────────────

/**
 * Compiles a path pattern string into a regex and ordered param name list.
 *
 * Supports:
 * - Static segments:  `/users/profile`
 * - Named params:     `/users/:id`
 * - Wildcard:         `/files/*`
 *
 * @param pattern   - The route path pattern (e.g. `/users/:id/posts/:postId`)
 * @param isPrefix  - When true, allows trailing path segments (used for mounted sub-routers)
 *
 * @example
 * compilePath('/users/:id')
 * // { regex: /^\/users\/([^/]+)$/, paramNames: ['id'] }
 *
 * compilePath('/api', true)
 * // { regex: /^\/api(?:\/|$)/, paramNames: [] }
 */
export function compilePath(
  pattern: string,
  isPrefix = false,
): { regex: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];

  // Escape special regex characters except : and *
  const regexStr = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_match, name: string) => {
      paramNames.push(name);
      return '([^/]+)';
    })
    .replace(/\*/g, '(.*)');

  const suffix = isPrefix ? '(?:/|$)' : '$';
  const regex = new RegExp(`^${regexStr}${suffix}`);

  return { regex, paramNames };
}

// ── Lookup result types ───────────────────────────────────────────────────────

type LookupHit = {
  success: true;
  params: Record<string, string>;
  route: Route;
};

type LookupMiss = {
  success: false;
  /** 404 = path not found, 405 = path exists but method not registered */
  code: 404 | 405;
};

type LookupResult = LookupHit | LookupMiss;

// ── Radix tree node ───────────────────────────────────────────────────────────

interface RadixNode {
  // Static children keyed by their path segment (e.g. 'users', 'posts')
  children: Map<string, RadixNode>;

  // Param child (e.g. :id) — at most one per node level
  paramChild: RadixNode | null;
  paramName: string | null;

  // Wildcard child (*) — at most one per node level
  wildcardChild: RadixNode | null;

  // Routes stored at this node, keyed by HTTP method
  routes: Map<HttpMethod, Route>;
}

function createNode(): RadixNode {
  return {
    children: new Map(),
    paramChild: null,
    paramName: null,
    wildcardChild: null,
    routes: new Map(),
  };
}

// ── RadixTree ─────────────────────────────────────────────────────────────────

/**
 * Radix tree router for O(k) route lookup where k = path segment count.
 *
 * Segment priority (highest to lowest):
 * 1. Static segments  (`/users/profile`)
 * 2. Named params     (`/users/:id`)
 * 3. Wildcards        (`/files/*`)
 *
 * This ensures `/users/profile` always wins over `/users/:id` when both
 * are registered, regardless of registration order.
 *
 * @example
 * const tree = new RadixTree();
 * tree.insert({ method: 'GET', pattern: '/users/:id', handlers: [...] });
 * const result = tree.lookup('/users/42', 'GET');
 * // result.success === true, result.params === { id: '42' }
 */
export class RadixTree {
  private root: RadixNode = createNode();

  // ── Insert ──────────────────────────────────────────────────────────────────

  /**
   * Inserts a route into the tree.
   * Throws if the same method+pattern is registered twice.
   */
  insert(route: Route): void {
    const segments = this.splitPath(route.pattern);
    let node = this.root;

    for (const segment of segments) {
      if (segment.startsWith(':')) {
        // Param segment
        const name = segment.slice(1);
        if (!node.paramChild) {
          node.paramChild = createNode();
          node.paramName = name;
        }
        node = node.paramChild;
      } else if (segment === '*') {
        // Wildcard segment
        if (!node.wildcardChild) {
          node.wildcardChild = createNode();
        }
        node = node.wildcardChild;
      } else {
        // Static segment
        if (!node.children.has(segment)) {
          node.children.set(segment, createNode());
        }
        node = node.children.get(segment)!;
      }
    }

    if (node.routes.has(route.method)) {
      throw new Error(
        `Route already registered: ${route.method} ${route.pattern}`,
      );
    }

    node.routes.set(route.method, route);
  }

  // ── Lookup ──────────────────────────────────────────────────────────────────

  /**
   * Looks up a route for the given pathname and method.
   *
   * Returns a hit with extracted params on success, or a miss with a
   * 404 (path not found) or 405 (method not allowed) code.
   */
  lookup(pathname: string, method: HttpMethod): LookupResult {
    const segments = this.splitPath(pathname);
    const params: Record<string, string> = {};

    const hit = this.traverse(this.root, segments, 0, params);

    if (!hit) return { success: false, code: 404 };

    const route = hit.routes.get(method);
    if (!route) {
      return { success: false, code: 405 };
    }

    return { success: true, params, route };
  }

  // ── collectAllowedMethods ───────────────────────────────────────────────────

  /**
   * Returns all HTTP methods registered for `pathname`.
   * Used by OPTIONS handling to build the `Allow` response header.
   * Returns an empty set if the path is not registered at all.
   */
  collectAllowedMethods(pathname: string): Set<HttpMethod> {
    const segments = this.splitPath(pathname);
    const node = this.traverse(this.root, segments, 0, {});

    if (!node) return new Set();
    return new Set(node.routes.keys());
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Recursive depth-first traversal with static-first priority.
   * Returns the matching node (with its routes map) or null.
   */
  private traverse(
    node: RadixNode,
    segments: string[],
    index: number,
    params: Record<string, string>,
  ): RadixNode | null {
    // Base case: consumed all segments → this node is the match
    if (index === segments.length) return node;

    const segment = segments[index]!;

    // 1. Static match (highest priority)
    const staticChild = node.children.get(segment);
    if (staticChild) {
      const result = this.traverse(staticChild, segments, index + 1, params);
      if (result) return result;
    }

    // 2. Param match
    if (node.paramChild && node.paramName) {
      const savedValue = params[node.paramName];
      params[node.paramName] = decodeURIComponent(segment);

      const result = this.traverse(
        node.paramChild,
        segments,
        index + 1,
        params,
      );
      if (result) return result;

      // Backtrack — restore param state if this branch didn't match
      if (savedValue === undefined) {
        delete params[node.paramName];
      } else {
        params[node.paramName] = savedValue;
      }
    }

    // 3. Wildcard match (lowest priority) — consumes remaining segments
    if (node.wildcardChild) {
      params['*'] = segments.slice(index).join('/');
      return node.wildcardChild;
    }

    return null;
  }

  /**
   * Splits a pathname into non-empty segments.
   * '/users/42/' → ['users', '42']
   * '/'          → []
   */
  private splitPath(pathname: string): string[] {
    return pathname.split('/').filter(Boolean);
  }
}
