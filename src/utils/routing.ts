import type { HttpMethod, Route } from '../types.js';

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

class RadixNode {
  public children = new Map<string, RadixNode>();
  public paramChild: RadixNode | null = null;
  public paramName: string | null = null;
  public routes: Partial<Record<HttpMethod, Route>> = {};
}

export class RadixTree {
  private root = new RadixNode();

  /**
   * Inserts a route into the prefix tree.
   * Compiles the path into segments and builds the necessary nodes.
   */
  public insert(route: Route): void {
    // Strip leading/trailing slashes and split
    const segments = route.pattern.split('/').filter(Boolean);
    let current = this.root;

    for (const segment of segments) {
      if (segment.startsWith(':')) {
        const paramName = segment.slice(1);
        if (!current.paramChild) {
          const paramNode = new RadixNode();
          paramNode.paramName = paramName; // ← on the node that represents the param
          current.paramChild = paramNode;
        }
        current = current.paramChild;
      } else {
        if (!current.children.has(segment)) {
          current.children.set(segment, new RadixNode());
        }
        current = current.children.get(segment)!;
      }
    }

    current.routes[route.method] = route;
  }

  /**
   * Traverses the tree to find a matching route.
   */
  public lookup(pathname: string, method: HttpMethod): MatchResult {
    const segments = pathname.split('/').filter(Boolean);
    const params: Record<string, string> = {};

    const matchedNode = this.search(this.root, segments, 0, params);

    if (!matchedNode) {
      return { success: false, code: 404, error: 'Not Found' };
    }

    const route = matchedNode.routes[method];

    if (route) {
      return { success: true, route, params };
    }

    // The node exists, but not for this method -> 405
    const hasOtherMethods = Object.keys(matchedNode.routes).length > 0;
    if (hasOtherMethods) {
      return { success: false, code: 405, error: 'Method Not Allowed' };
    }

    return { success: false, code: 404, error: 'Not Found' };
  }

  /**
   * Recursive search to support backtracking.
   * Tries static segments first, falls back to param segments if static hits a dead end.
   */
  private search(
    node: RadixNode,
    segments: string[],
    index: number,
    params: Record<string, string>,
  ): RadixNode | null {
    if (index === segments.length) return node;

    const segment = segments[index]!;

    // Static first
    const staticChild = node.children.get(segment);
    if (staticChild) {
      const result = this.search(staticChild, segments, index + 1, params);
      if (result) return result;
    }

    // Param fallback with snapshot/restore
    if (node.paramChild) {
      const snapshot = { ...params }; // snapshot before mutation
      params[node.paramChild.paramName!] = segment;
      const result = this.search(node.paramChild, segments, index + 1, params);
      if (result) return result;
      // Restore — wipe any params set in this branch
      Object.keys(params).forEach((k) => delete params[k]);
      Object.assign(params, snapshot);
    }

    return null;
  }

  /**
   * Walks the tree to collect all registered methods for a path (used for OPTIONS).
   */
  public collectAllowedMethods(pathname: string): Set<HttpMethod> {
    const segments = pathname.split('/').filter(Boolean);
    const matchedNode = this.search(this.root, segments, 0, {});
    const allowed = new Set<HttpMethod>();

    if (matchedNode) {
      for (const method of Object.keys(matchedNode.routes) as HttpMethod[]) {
        allowed.add(method);
        if (method === 'GET') allowed.add('HEAD');
      }
    }

    return allowed;
  }
}

/**
 * We keep compilePath for child router prefixes, as they still need regex
 * to easily slice off the mount path during recursive dispatch.
 */
export function compilePath<Params extends string = never>(
  path: string,
  prefix = false,
): { regex: RegExp; paramNames: Params[] } {
  const paramNames: Params[] = [];
  const regexStr = path
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&') // escape regex
    .replace(/:([^/]+)/g, (_, name: Params) => {
      paramNames.push(name);
      return '([^/]+)';
    })
    .replace(/\//g, '\\/');

  const terminator = prefix ? '(?=\\/|$)' : '\\/?$';
  return { regex: new RegExp(`^${regexStr}${terminator}`), paramNames };
}
