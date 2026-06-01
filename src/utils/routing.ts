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

// ── Isolated try/catch — keeps the hot path JIT-optimizable ──────────────────

function safeDecode(val: string): string {
  try {
    return decodeURIComponent(val);
  } catch {
    return val;
  }
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

  /**
   * Inserts a route into the tree.
   * Throws if the same method+pattern is registered twice.
   */
  insert(route: Route): void {
    const segments = route.pattern.split('/').filter(Boolean);
    let node = this.root;

    for (const segment of segments) {
      if (segment.startsWith(':')) {
        const name = segment.slice(1);
        if (!node.paramChild) {
          node.paramChild = createNode();
          node.paramName = name;
        }
        node = node.paramChild;
      } else if (segment === '*') {
        if (!node.wildcardChild) node.wildcardChild = createNode();
        node = node.wildcardChild;
      } else {
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

  /**
   * Looks up a route for the given pathname and method.
   *
   * Returns a hit with extracted params on success, or a miss with a
   * 404 (path not found) or 405 (method not allowed) code.
   */
  lookup(pathname: string, method: HttpMethod): LookupResult {
    // Inline segment scanning — zero array allocation
    const paramKeys: string[] = [];
    const paramVals: string[] = [];

    const node = this.traverse(pathname, paramKeys, paramVals);
    if (!node) return { success: false, code: 404 };

    const route = node.routes.get(method);
    if (!route) return { success: false, code: 405 };

    // Build params object — decode only on confirmed hit
    const params: Record<string, string> = {};
    for (let i = 0; i < paramKeys.length; i++) {
      params[paramKeys[i]!] = safeDecode(paramVals[i]!);
    }

    return { success: true, params, route };
  }

  /**
   * Returns all HTTP methods registered for `pathname`.
   * Used by OPTIONS handling to build the `Allow` response header.
   * Returns an empty set if the path is not registered at all.
   */
  collectAllowedMethods(pathname: string): Set<HttpMethod> {
    const node = this.traverse(pathname, [], []);
    if (!node) return new Set();
    return new Set(node.routes.keys());
  }

  /**
   * Iterative traversal — eliminates recursive call frames.
   * Scans pathname char-by-char to extract segments without allocating
   * an intermediate array.
   *
   * Backtracking for param vs static is handled via an explicit stack
   * of (node, segmentStart, paramCount) frames — only pushed when a
   * static child exists AND a param child also exists (ambiguous branch).
   */
  private traverse(
    pathname: string,
    paramKeys: string[],
    paramVals: string[],
  ): RadixNode | null {
    type Frame = { node: RadixNode; pos: number; paramCount: number };
    const stack: Frame[] = [];

    let node = this.root;
    let pos = 0;
    const len = pathname.length;

    // Skip leading slash
    if (pos < len && pathname.charCodeAt(pos) === 47) pos++;

    while (pos <= len) {
      // Find end of current segment
      let end = pos;
      while (end < len && pathname.charCodeAt(end) !== 47) end++;

      // const isLast = end >= len;

      if (pos === end) {
        // Trailing slash or empty — treat as done
        break;
      }

      const segment = pathname.slice(pos, end);

      // 1. Try static child first (highest priority)
      const staticChild = node.children.get(segment);

      // 2. Check if param child exists for potential backtrack
      if (staticChild && node.paramChild) {
        // Ambiguous: push param branch as backtrack candidate
        stack.push({ node, pos, paramCount: paramKeys.length });
      }

      if (staticChild) {
        node = staticChild;
      } else if (node.paramChild) {
        paramKeys.push(node.paramName!);
        paramVals.push(segment);
        node = node.paramChild;
      } else if (node.wildcardChild) {
        paramKeys.push('*');
        paramVals.push(pathname.slice(pos));
        return node.wildcardChild;
      } else {
        // Dead end — backtrack
        const frame = stack.pop();
        if (!frame) return null;
        // Restore state and take the param branch
        node = frame.node;
        pos = frame.pos;
        paramKeys.length = frame.paramCount;
        paramVals.length = frame.paramCount;

        const seg = pathname.slice(
          pos,
          (() => {
            let e = pos;
            while (e < len && pathname.charCodeAt(e) !== 47) e++;
            return e;
          })(),
        );
        paramKeys.push(node.paramName!);
        paramVals.push(seg);
        node = node.paramChild!;
      }

      pos = end + 1; // skip the '/'
    }

    // Confirm the node has routes (not just a structural node)
    return node.routes.size > 0
      ? node
      : this.backtrackToMatch(node, stack, pathname, len, paramKeys, paramVals);
  }

  /**
   * If the static traversal landed on a structureless node (no routes),
   * drain the backtrack stack to find the best matching param node.
   */
  private backtrackToMatch(
    node: RadixNode,
    stack: { node: RadixNode; pos: number; paramCount: number }[],
    pathname: string,
    len: number,
    paramKeys: string[],
    paramVals: string[],
  ): RadixNode | null {
    if (node.routes.size > 0) return node;

    while (stack.length > 0) {
      const frame = stack.pop()!;
      paramKeys.length = frame.paramCount;
      paramVals.length = frame.paramCount;

      // Re-extract segment at frame.pos
      let end = frame.pos;
      while (end < len && pathname.charCodeAt(end) !== 47) end++;
      const segment = pathname.slice(frame.pos, end);

      const candidate = frame.node.paramChild!;
      paramKeys.push(frame.node.paramName!);
      paramVals.push(segment);

      // Continue traversal from here iteratively
      // For simplicity delegate back — in practice most routes are shallow
      const subResult = this.traverseFrom(
        candidate,
        pathname,
        end + 1,
        len,
        paramKeys,
        paramVals,
      );
      if (subResult) return subResult;
    }

    return null;
  }

  private traverseFrom(
    node: RadixNode,
    pathname: string,
    pos: number,
    len: number,
    paramKeys: string[],
    paramVals: string[],
  ): RadixNode | null {
    while (pos <= len) {
      let end = pos;
      while (end < len && pathname.charCodeAt(end) !== 47) end++;
      if (pos === end) break;

      const segment = pathname.slice(pos, end);
      const staticChild = node.children.get(segment);

      if (staticChild) {
        node = staticChild;
      } else if (node.paramChild) {
        paramKeys.push(node.paramName!);
        paramVals.push(segment);
        node = node.paramChild;
      } else if (node.wildcardChild) {
        paramKeys.push('*');
        paramVals.push(pathname.slice(pos));
        return node.wildcardChild;
      } else {
        return null;
      }

      pos = end + 1;
    }

    return node.routes.size > 0 ? node : null;
  }
}
