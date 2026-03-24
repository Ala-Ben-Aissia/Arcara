import type http from 'node:http';
import type {
  Dispatchable,
  ErrorHandler,
  ExtractParams,
  HttpMethod,
  Middleware,
  Route,
  RouteHandler,
  StoredChild,
  StoredMiddleware,
} from './types.js';
import { ArcaraError } from './types.js';
import { logger } from './utils/logger.js';
import { compilePath, matchRoute } from './utils/routing.js';

export abstract class Layer implements Dispatchable {
  protected routes: Route[] = [];
  protected middlewares: StoredMiddleware[] = [];
  protected children: StoredChild[] = [];

  // Default error handler must never use proto methods (res.status, res.json) —
  // those can throw on invalid state, and this is the last line of defense.
  protected errorHandler: ErrorHandler = (err, _req, res) => {
    if (!res.writableEnded) {
      res.statusCode = err.status ?? 500;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: err.message }));
    }
  };

  // ── Public API ──────────────────────────────────────────────────────────────

  onError(handler: ErrorHandler): this {
    this.errorHandler = handler;
    return this;
  }

  use(handler: Middleware): this;
  use(prefix: `/${string}`, handler: Middleware | Layer): this;
  use(
    prefixOrHandler: `/${string}` | Middleware,
    handler?: Middleware | Layer,
  ): this {
    if (typeof prefixOrHandler === 'function') {
      this.middlewares.push({ prefix: '/', handler: prefixOrHandler });
      return this;
    }

    const prefix = this.normalizePrefix(prefixOrHandler);

    if (handler === undefined) {
      throw new TypeError('use() requires a handler when a prefix is provided');
    }

    if (handler instanceof Layer) {
      const { regex, paramNames } = compilePath(prefix, true);
      this.children.push({ prefix, regex, paramNames, layer: handler });
    } else {
      this.middlewares.push({ prefix, handler });
    }

    return this;
  }

  get<Path extends string>(
    path: Path,
    ...handlers: RouteHandler<ExtractParams<Path>, 'GET'>[]
  ): this {
    return this.pushRoute(path, 'GET', handlers);
  }

  post<Path extends string>(
    path: Path,
    ...handlers: RouteHandler<ExtractParams<Path>, 'POST'>[]
  ): this {
    return this.pushRoute(path, 'POST', handlers);
  }

  put<Path extends string>(
    path: Path,
    ...handlers: RouteHandler<ExtractParams<Path>, 'PUT'>[]
  ): this {
    return this.pushRoute(path, 'PUT', handlers);
  }

  patch<Path extends string>(
    path: Path,
    ...handlers: RouteHandler<ExtractParams<Path>, 'PATCH'>[]
  ): this {
    return this.pushRoute(path, 'PATCH', handlers);
  }

  delete<Path extends string>(
    path: Path,
    ...handlers: RouteHandler<ExtractParams<Path>, 'DELETE'>[]
  ): this {
    return this.pushRoute(path, 'DELETE', handlers);
  }

  // ── Dispatch ────────────────────────────────────────────────────────────────

  /**
   * Recursively dispatches a request through this layer's middlewares,
   * routes, and mounted child layers.
   *
   * Called by Arcara.handleRequest at the root and by parent layers
   * on children during tree traversal.
   */
  public async dispatch(
    pathname: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      // 1. Run prefix-matching middlewares
      const mwStack = this.middlewares
        .filter((mw) => this.matchesPrefix(pathname, mw.prefix))
        .map((mw) => mw.handler);

      await this.runStack(req, res, mwStack);
      if (res.writableEnded) return;

      // 2. Try own routes — HEAD falls back to GET
      const effectiveMethod = (
        req.method === 'HEAD' ? 'GET' : (req.method ?? 'GET')
      ).toUpperCase() as HttpMethod;

      const match = matchRoute(pathname, this.routes, effectiveMethod);
      const methodMismatch = !match.success && match.code === 405;

      if (match.success) {
        // Merge — parent layers may have already populated params from prefix segments
        req.params = { ...req.params, ...match.params };
        await this.runStack(req, res, match.route.handlers);
        if (!res.writableEnded) res.end();
        return;
      }

      // 3. Recurse into mounted child layers
      for (const child of this.children) {
        const prefixMatch = pathname.match(child.regex);
        if (!prefixMatch) continue;

        const prefixParams = Object.fromEntries(
          child.paramNames.map((name, i) => [name, prefixMatch[i + 1] ?? '']),
        );
        req.params = { ...req.params, ...prefixParams };

        // Strip matched prefix — child sees a root-relative pathname
        const stripped = pathname.slice(prefixMatch[0]!.length) || '/';
        await child.layer.dispatch(stripped, req, res);
        if (res.writableEnded) return;
      }

      // 4. Nothing matched — 405 if path existed with wrong method, else 404
      throw new ArcaraError(
        methodMismatch ? 405 : 404,
        methodMismatch ? 'Method Not Allowed' : 'Not Found',
      );
    } catch (e) {
      this.handleError(e, req, res);
    }
  }

  /**
   * Walks the full route tree to collect all HTTP methods registered for
   * a given pathname. Used by OPTIONS handling in Arcara.
   */
  collectAllowedMethods(pathname: string): Set<HttpMethod> {
    const allowed = new Set<HttpMethod>();

    for (const route of this.routes) {
      if (route.regex.test(pathname)) {
        allowed.add(route.method);
        // HEAD is implicitly allowed whenever GET is registered
        if (route.method === 'GET') allowed.add('HEAD');
      }
    }

    for (const child of this.children) {
      const prefixMatch = pathname.match(child.regex);
      if (!prefixMatch) continue;
      const stripped = pathname.slice(prefixMatch[0]!.length) || '/';
      for (const method of child.layer.collectAllowedMethods(stripped)) {
        allowed.add(method);
      }
    }

    return allowed;
  }

  // ── Protected helpers ───────────────────────────────────────────────────────

  /**
   * Runs an ordered handler stack sequentially via a shared next() dispatcher.
   *
   * Double-next detection: `index` tracks the last handler position that
   * started executing. If next() is called with i <= index, the same handler
   * called next() twice — route to handleError instead of silently re-running.
   */
  protected async runStack(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    stack: RouteHandler<any>[],
  ): Promise<void> {
    let index = -1;

    const dispatch = async (i: number): Promise<void> => {
      if (i <= index) {
        this.handleError(
          new ArcaraError(
            500,
            `next() called multiple times in handler at position ${index}`,
          ),
          req,
          res,
        );
        return;
      }
      index = i;
      if (i === stack.length) return;
      await stack[i]?.(req, res, () => dispatch(i + 1));
    };

    await dispatch(0);
  }

  /**
   * Normalizes any thrown value to ArcaraError, logs it, and delegates
   * to the active errorHandler.
   *
   * 404/405 are not logged — they are normal routing outcomes, not failures.
   * For 500s, logs the full ArcaraError (not just the cause) so status and
   * message are always visible alongside the cause chain.
   */
  protected handleError(
    e: unknown,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const err =
      e instanceof ArcaraError
        ? e
        : new ArcaraError(500, e instanceof Error ? e.message : String(e), e);

    if (err.status >= 500) logger.error(err);

    if (!res.writableEnded) this.errorHandler(err, req, res);
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private pushRoute<Params extends string>(
    path: string,
    method: HttpMethod,
    handlers: RouteHandler<Params>[],
  ): this {
    const { regex, paramNames } = compilePath<Params>(path);
    this.routes.push({ method, pattern: path, regex, paramNames, handlers });
    return this;
  }

  /**
   * Returns true if pathname falls under the given prefix.
   * '/'      → matches everything (global middlewares)
   * '/api'   → matches '/api' and '/api/users' but not '/api-v2'
   */
  private matchesPrefix(pathname: string, prefix: string): boolean {
    if (prefix === '/') return true;
    return pathname === prefix || pathname.startsWith(prefix + '/');
  }

  /**
   * Strips trailing slashes. Preserves '/' for global middleware prefix.
   * '/api/v1/' → '/api/v1'
   * '/'        → '/'
   */
  private normalizePrefix(prefix: string): string {
    return prefix === '/' ? '/' : prefix.replace(/\/+$/, '');
  }
}
