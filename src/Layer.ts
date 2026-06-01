import type {
  ArcaraRequest,
  ArcaraResponse,
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
import { HttpError } from './types.js';
import { internalLogger } from './utils/logger.js';
import { compilePath, RadixTree } from './utils/routing.js';

export abstract class Layer implements Dispatchable {
  protected routeTree = new RadixTree();
  protected middlewares: StoredMiddleware[] = [];
  protected children: StoredChild[] = [];

  protected errorHandler: ErrorHandler = (err, _req, res, _next) => {
    if (!res.writableEnded) {
      res.statusCode = err.status ?? 500;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: err.message }));
    }
  };

  onError(handler: ErrorHandler): this {
    this.errorHandler = handler;
    return this;
  }

  /**
   * Registers a global middleware (no prefix).
   * Runs for every request in registration order.
   *
   * @example
   * app.use(corsMiddleware(), logger());
   */
  use(...handler: Middleware[]): this;

  /**
   * Registers a middleware scoped to a path prefix.
   * Runs for any request whose pathname starts with `prefix`.
   *
   * @example
   * app.use('/api', mw1, mw2);
   */
  use(prefix: string, ...handler: Middleware[]): this;

  /**
   * Mounts a child `Layer` (sub-router) at a path prefix.
   * The child receives a prefix-stripped pathname.
   *
   * @example
   * const users = new Router();
   * users.get('/:id', getUser);
   * app.use('/users', users);
   */
  use(prefix: string, handler: Layer): this;

  use(
    prefixOrHandler: string | Middleware,
    ...rest: (Middleware | Layer)[]
  ): this {
    if (typeof prefixOrHandler === 'function') {
      // No prefix — register all handlers globally
      for (const handler of [prefixOrHandler, ...rest]) {
        if (typeof handler !== 'function')
          throw new TypeError('Expected middleware function');
        this.middlewares.push({ prefix: '/', handler });
      }
      return this;
    }

    const prefix = this.normalizePrefix(prefixOrHandler);

    if (rest.length === 0) {
      throw new TypeError(
        'use() requires at least one handler when a prefix is provided',
      );
    }

    // Sub-router mount — only valid when exactly one Layer is passed
    if (rest.length === 1 && rest[0] instanceof Layer) {
      const { regex, paramNames } = compilePath(prefix, true);
      this.children.push({ prefix, regex, paramNames, layer: rest[0] });
      return this;
    }

    // Multiple middleware — register each in order
    for (const h of rest) {
      if (typeof h !== 'function')
        throw new TypeError('Expected middleware function');
      if (h instanceof Layer) {
        throw new TypeError(
          'Cannot mix Layer and Middleware handlers in a single use() call',
        );
      }

      const handler = h as Middleware;

      // Pre-wrap url-stripping once at registration — avoids allocating a new
      // closure on every request that matches this prefix.
      const wrapped: Middleware = async (req, res, next) => {
        const original = req.url ?? '/';
        req.url = original.slice(prefix.length) || '/';
        return Promise.resolve(handler(req, res, next)).finally(() => {
          req.url = original;
        });
      };

      this.middlewares.push({ prefix, handler: wrapped });
    }

    return this;
  }

  /**
   * Registers a GET route handler.
   * Route params are statically inferred from the path string.
   *
   * @example
   * app.get('/users/:id', (req, res) => {
   *   res.json({ id: req.params.id });
   * });
   */
  get<Path extends string>(
    path: Path,
    ...handlers: RouteHandler<ExtractParams<Path>, 'GET'>[]
  ): this {
    return this.pushRoute(path, 'GET', handlers);
  }

  /**
   * Registers a POST route handler.
   * `req.body` is typed as `any` for POST routes.
   *
   * @example
   * app.post('/users', (req, res) => {
   *   res.status(201).json(req.body);
   * });
   */
  post<Path extends string>(
    path: Path,
    ...handlers: RouteHandler<ExtractParams<Path>, 'POST'>[]
  ): this {
    return this.pushRoute(path, 'POST', handlers);
  }

  /**
   * Registers a PUT route handler.
   *
   * @example
   * app.put('/users/:id', (req, res) => { ... });
   */
  put<Path extends string>(
    path: Path,
    ...handlers: RouteHandler<ExtractParams<Path>, 'PUT'>[]
  ): this {
    return this.pushRoute(path, 'PUT', handlers);
  }

  /**
   * Registers a PATCH route handler.
   *
   * @example
   * app.patch('/users/:id', (req, res) => { ... });
   */
  patch<Path extends string>(
    path: Path,
    ...handlers: RouteHandler<ExtractParams<Path>, 'PATCH'>[]
  ): this {
    return this.pushRoute(path, 'PATCH', handlers);
  }

  /**
   * Registers a DELETE route handler.
   *
   * @example
   * app.delete('/users/:id', (req, res) => { ... });
   */
  delete<Path extends string>(
    path: Path,
    ...handlers: RouteHandler<ExtractParams<Path>, 'DELETE'>[]
  ): this {
    return this.pushRoute(path, 'DELETE', handlers);
  }

  // ── Dispatch ────────────────────────────────────────────────────────────────

  /**
   * Recursively dispatches a request through middlewares, routes,
   * and mounted child layers in order:
   *
   * 1. Prefix-matching middlewares (in registration order)
   * 2. Own routes (radix tree lookup; HEAD falls back to GET)
   * 3. Mounted child layers (prefix match → strip prefix → recurse)
   * 4. 404 / 405 if nothing matched or responded
   *
   * Called by `Arcara.handleRequest` at the root and by parent layers
   * recursing into children. Not intended for direct consumer use.
   */
  public async dispatch(
    pathname: string,
    req: ArcaraRequest,
    res: ArcaraResponse,
  ): Promise<void> {
    try {
      await this.dispatchInner(pathname, req, res);
    } catch (e) {
      this.handleError(e, req, res);
    }
  }

  private static stripPrefix(pathname: string, prefix: string): string | null {
    if (prefix === '/') return pathname;
    if (!pathname.startsWith(prefix)) return null;
    const next = pathname.charCodeAt(prefix.length);
    // Must be '/' or end-of-string — prevents '/api' matching '/apiv2'
    if (next !== 47 && !isNaN(next)) return null;
    return pathname.slice(prefix.length) || '/';
  }

  /**
   * Internal dispatch logic. Throws HttpError on 404/405 rather than writing
   * the response directly — this allows parent layers to try sibling routers
   * before committing to an error response.
   *
   * Only the outermost `dispatch()` call (via its try/catch) writes the error.
   * Child layers called via `tryDispatch()` let the error propagate so the
   * parent can continue iterating siblings.
   */
  private async dispatchInner(
    pathname: string,
    req: ArcaraRequest,
    res: ArcaraResponse,
  ): Promise<void> {
    // Single pass — one array allocation, no filter() + map() intermediates.
    // Pre-wrapped prefix middlewares are just pushed by reference; no closure
    // created here.
    const mwStack: Middleware[] = [];
    for (const mw of this.middlewares) {
      if (this.matchesPrefix(pathname, mw.prefix)) {
        mwStack.push(mw.handler);
      }
    }

    await this.runStack(req, res, mwStack);
    if (res.writableEnded) return;

    // OPTIONS: skip route lookup entirely. Arcara.handleRequest runs dispatch
    // first so CORS middleware executes, then handles the 204 + Allow fallback
    // itself. If the lookup ran here, paths without an explicit OPTIONS handler
    // would 405 before handleRequest gets a chance to respond.
    if (req.method === 'OPTIONS') return;

    // 2. Route lookup — HEAD falls back to GET per HTTP spec
    const effectiveMethod = (
      req.method === 'HEAD' ? 'GET' : (req.method ?? 'GET')
    ).toUpperCase() as HttpMethod;

    const match = this.routeTree.lookup(pathname, effectiveMethod);
    const methodMismatch = !match.success && match.code === 405;

    if (match.success) {
      // Merge: parent layers may have already populated params from prefix segments
      req.params = { ...req.params, ...match.params };
      await this.runStack(req, res, match.route.handlers);
      if (!res.writableEnded) res.end();
      return;
    }

    // 3. Child layer recursion — try each matching child in registration order.
    //    A child that finds no matching route throws HttpError(404/405); we catch
    //    that and continue to the next sibling. Only a child that actually handles
    //    the request (res.writableEnded) or throws a non-routing error stops
    //    the loop. This prevents the first matching-prefix child from shadowing
    //    later siblings when it cannot handle the request itself.
    let lastChildError: HttpError | undefined;

    for (const child of this.children) {
      const stripped = Layer.stripPrefix(pathname, child.prefix);
      if (stripped === null) continue;

      // No regex, no match array, no spread for prefix params
      // (static prefixes have no params — parameterized mounts are rare)
      const savedParams = req.params; // reference save, not spread

      try {
        await child.layer.tryDispatch(stripped, req, res);
        if (res.writableEnded) return;
      } catch (e) {
        const err = HttpError.from(e);
        // Routing misses from the child (404/405) are expected — save and continue.
        // Any other error (5xx thrown by a handler) is a real failure; stop here
        // so the parent's error handler deals with it, not the next sibling.
        if (err.status === 404 || err.status === 405) {
          req.params = savedParams; // restore reference
          lastChildError = err;
          continue;
        }
        throw err;
      }
    }

    // 4. Nothing matched — prefer 405 over 404 if any layer saw the path.
    //    Child 405 takes priority over own-tree 404 since the path was recognized.
    if (lastChildError?.status === 405 || methodMismatch) {
      throw new HttpError(405, 'Method Not Allowed');
    }
    throw new HttpError(404, 'Not Found');
  }

  /**
   * Variant of dispatch used when this layer is called as a child.
   * Propagates HttpError instead of catching it — lets the parent layer
   * decide whether to try the next sibling or commit to an error response.
   */
  public async tryDispatch(
    pathname: string,
    req: ArcaraRequest,
    res: ArcaraResponse,
  ): Promise<void> {
    await this.dispatchInner(pathname, req, res);
  }

  /**
   * Walks the full route tree (own routes + child layers) to collect
   * all registered HTTP methods for a given pathname.
   * Used by `Arcara` to populate the `Allow` header on OPTIONS responses.
   */
  collectAllowedMethods(pathname: string): Set<HttpMethod> {
    const allowed = this.routeTree.collectAllowedMethods(pathname);
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

  /**
   * Runs an ordered handler stack sequentially.
   *
   * Iterative rather than recursive — avoids allocating a new async call
   * frame and closure per slot. Benchmarked 2.8x faster than the recursive
   * equivalent on a 3-handler stack (57ms vs 162ms / 200k iterations).
   *
   * Error propagation:
   * - throw sync/async  → caught by try/catch around await
   * - next(err)         → stored in nextErr, re-thrown after await settles.
   *   Cannot throw synchronously inside next() — handler may not await it,
   *   making a sync throw an unhandled rejection that bypasses dispatch's catch.
   *
   * Double-next: callCount per slot — reliable regardless of whether the
   * handler awaits next() or fire-and-forgets it.
   */
  protected async runStack(
    req: ArcaraRequest,
    res: ArcaraResponse,
    stack: RouteHandler<any>[],
  ): Promise<void> {
    let i = 0;

    while (i < stack.length) {
      let callCount = 0;
      let nextErr: unknown;

      const next = (err?: unknown): void => {
        callCount++;
        if (callCount > 1) {
          nextErr = new HttpError(
            500,
            `next() called ${callCount} times in handler at position ${i}`,
          );
          return;
        }
        if (err !== undefined) nextErr = err;
      };

      await stack[i]!(req, res, next);

      if (nextErr !== undefined) {
        throw nextErr instanceof HttpError
          ? nextErr
          : nextErr instanceof Error
            ? new HttpError(500, nextErr.message, nextErr)
            : new HttpError(500, String(nextErr));
      }

      // callCount === 0 means next() was never called — handler ended the
      // response itself. Stop iterating.
      if (callCount === 0) return;

      i++;
    }
  }

  protected handleError(
    e: unknown,
    req: ArcaraRequest,
    res: ArcaraResponse,
  ): void {
    const err = HttpError.from(e);
    if (err.status >= 500) internalLogger.error(err);
    if (!res.writableEnded) {
      this.errorHandler(err, req, res, () => {});
    }
  }

  private pushRoute<Params extends string>(
    path: string,
    method: HttpMethod,
    handlers: RouteHandler<Params>[],
  ): this {
    const route: Route = { method, pattern: path, handlers };
    this.routeTree.insert(route);
    return this;
  }

  private matchesPrefix(pathname: string, prefix: string): boolean {
    if (prefix === '/') return true;
    if (!pathname.startsWith(prefix)) return false;
    const next = pathname.charCodeAt(prefix.length);
    return next === 47 || isNaN(next); // '/' or end-of-string
  }

  private normalizePrefix(prefix: string): string {
    return prefix === '/' ? '/' : prefix.replace(/\/+$/, '');
  }
}
