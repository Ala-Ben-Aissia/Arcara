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

  /**
   * Default error handler — intentionally avoids `res.status()` / `res.json()`
   * since this is the last line of defense and those can throw on invalid state.
   * Raw `statusCode` + `end()` only.
   */
  protected errorHandler: ErrorHandler = (err, _req, res, _next) => {
    if (!res.writableEnded) {
      res.statusCode = err.status ?? 500;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: err.message }));
    }
  };

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Registers a custom error handler for this layer.
   * Receives a normalized `HttpError` — always has `status` and `message`.
   * Called when any handler in the chain throws or passes an error to `next()`.
   *
   * @example
   * app.onError((err, req, res, next) => {
   *   res.status(err.status).json({ error: err.message, details: err.details });
   * });
   */
  onError(handler: ErrorHandler): this {
    this.errorHandler = handler;
    return this;
  }

  /**
   * Registers a global middleware (no prefix).
   * Runs for every request in registration order.
   *
   * @example
   * app.use(corsMiddleware());
   */
  use(handler: Middleware): this;

  /**
   * Registers a middleware scoped to a path prefix.
   * Runs for any request whose pathname starts with `prefix`.
   *
   * @example
   * app.use('/api', authMiddleware);
   */
  use(prefix: string, handler: Middleware): this;

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
    // 1. Prefix-matching middlewares
    const mwStack = this.middlewares
      .filter((mw) => this.matchesPrefix(pathname, mw.prefix))
      .map((mw): Middleware => {
        if (mw.prefix === '/') return mw.handler;

        return async (req, res, next) => {
          const original = req.url ?? '/';
          req.url = original.slice(mw.prefix.length) || '/';
          return Promise.resolve(mw.handler(req, res, next)).finally(() => {
            req.url = original;
          });
        };
      });

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
      const prefixMatch = pathname.match(child.regex);
      if (!prefixMatch) continue;

      // Snapshot params so a failed child branch doesn't pollute the next sibling.
      const savedParams = { ...req.params };

      const prefixParams = Object.fromEntries(
        child.paramNames.map((name, i) => [name, prefixMatch[i + 1] ?? '']),
      );
      req.params = { ...req.params, ...prefixParams };

      const stripped = pathname.slice(prefixMatch[0]!.length) || '/';

      try {
        // Call dispatchInner on the child directly so routing errors (404/405)
        // propagate as thrown HttpErrors rather than being written to `res`.
        // This lets us try the next sibling instead of committing to an error.
        await child.layer.tryDispatch(stripped, req, res);
        if (res.writableEnded) return;
      } catch (e) {
        const err = HttpError.from(e);
        // Routing misses from the child (404/405) are expected — save and continue.
        // Any other error (5xx thrown by a handler) is a real failure; stop here
        // so the parent's error handler deals with it, not the next sibling.
        if (err.status === 404 || err.status === 405) {
          lastChildError = err;
          req.params = savedParams; // restore before trying next sibling
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

  // ── Protected helpers ───────────────────────────────────────────────────────

  /**
   * Runs an ordered handler stack sequentially.
   *
   * Each handler receives a `next()` function that advances to the chain.
   * `next(err)` short-circuits to the error handler.
   *
   * Error propagation contract:
   * - Handler throws synchronously  → caught by `await handler(...)` try/catch
   * - Handler throws asynchronously → caught by `await handler(...)` (Promise rejection)
   * - Handler calls `next(err)`     → stored in `nextError`, re-thrown after the
   *   handler's own Promise settles. This is the critical fix: we cannot throw
   *   synchronously inside the `next` callback and expect it to surface reliably,
   *   because the handler may not `await next()` — it may fire-and-forget it.
   *   Storing the error and re-throwing after `await handler(...)` guarantees
   *   it always reaches `dispatch`'s catch block.
   *
   * Double-next detection: `callCount` per slot ensures the error path is entered
   * exactly once even if the outer async frame continues after the second call.
   */
  protected async runStack(
    req: ArcaraRequest,
    res: ArcaraResponse,
    stack: RouteHandler<any>[],
  ): Promise<void> {
    const run = async (i: number): Promise<void> => {
      if (i === stack.length) return;

      // Per-slot call counter. Counting calls directly in next() is the only
      // reliable way to detect double-next regardless of whether the handler
      // awaits next() or fire-and-forgets it.
      //
      // The previous approach used `i <= index` inside run() — that only fired
      // when run() was called recursively from inside next(). In this design
      // next() is a plain flag-setter that never calls run() directly, so that
      // guard never triggered. Per-slot counting closes the hole.
      let callCount = 0;
      let nextError: HttpError | undefined;
      let nextCalled = false;

      const next = (err?: unknown): void => {
        callCount++;

        if (callCount > 1) {
          // Store as nextError — do NOT throw synchronously here.
          // If the handler doesn't await next(), a synchronous throw becomes
          // an unhandled rejection that bypasses dispatch()'s catch block.
          // Storing and re-throwing after `await handler()` guarantees it
          // always reaches the error handler.
          nextError = new HttpError(
            500,
            `next() called ${callCount} times in handler at position ${i}`,
          );
          return;
        }

        nextCalled = true;
        if (err !== undefined) {
          nextError =
            err instanceof HttpError
              ? err
              : err instanceof Error
                ? new HttpError(500, err.message, err)
                : new HttpError(500, String(err));
        }
      };

      await stack[i]?.(req, res, next);

      // Re-throw any stored error (next(err) or double-next) now that the
      // handler's async frame has fully settled.
      if (nextError !== undefined) throw nextError;

      // Advance only if next() was called exactly once without error.
      if (nextCalled) await run(i + 1);
      // next() never called -> handler ended the response itself.
    };

    await run(0);
  }

  /**
   * Normalizes any thrown value to `HttpError`, logs 5xx errors,
   * and delegates to the registered `errorHandler`.
   *
   * 404 and 405 are intentionally not logged — they are normal routing
   * outcomes. 5xx errors log the full error including cause chain.
   */
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

  // ── Private helpers ─────────────────────────────────────────────────────────

  private pushRoute<Params extends string>(
    path: string,
    method: HttpMethod,
    handlers: RouteHandler<Params>[],
  ): this {
    const route: Route = { method, pattern: path, handlers };
    this.routeTree.insert(route);
    return this;
  }

  /**
   * Returns true if `pathname` falls under `prefix`.
   * - `'/'`     → matches everything (global middlewares)
   * - `'/api'`  → matches `/api` and `/api/users` but not `/api-v2`
   */
  private matchesPrefix(pathname: string, prefix: string): boolean {
    if (prefix === '/') return true;
    return pathname === prefix || pathname.startsWith(prefix + '/');
  }

  /**
   * Strips trailing slashes. Preserves `'/'` for global middleware prefix.
   * - `'/api/v1/'` → `'/api/v1'`
   * - `'/'`        → `'/'`
   */
  private normalizePrefix(prefix: string): string {
    return prefix === '/' ? '/' : prefix.replace(/\/+$/, '');
  }
}
