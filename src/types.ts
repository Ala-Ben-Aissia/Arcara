import type http from 'node:http';

// ── HTTP ────────────────────────────────────────────────────────────────────

export type HttpMethod =
  | 'GET'
  | 'POST'
  | 'PUT'
  | 'PATCH'
  | 'DELETE'
  | 'OPTIONS'
  | 'HEAD';

// ── Path param extraction ───────────────────────────────────────────────────

/**
 * Statically extracts route param names from a path string literal.
 *
 * @example
 * ExtractParams<'/users/:id/posts/:postId'>
 * // => 'id' | 'postId'
 */
export type ExtractParams<Path extends string> =
  Path extends `${string}/:${infer Param}/${infer Rest}`
    ? Param | ExtractParams<`/${Rest}`>
    : Path extends `${string}/:${infer Param}`
      ? Param
      : never;

// ── Global module augmentation ───────────────────────────────────────────────
//
// This is the critical piece for consumer autocompletion.
//
// The proto augmentation in Application.ts patches Node's ServerResponse at
// runtime, but TypeScript in the consumer's project has no way to know that
// unless we also declare those additions on the actual Node types via
// `declare module`. Without this block, `res.json` / `res.status` / `res.send`
// are invisible to the consumer's IDE even though they exist at runtime.
//
// Similarly, `IncomingMessage` needs `params`, `query`, and `body` declared
// so that `req.params.id` resolves instead of erroring with "Property 'params'
// does not exist on type 'IncomingMessage'".
//
// This file is imported (transitively via index.ts) by every consumer, so
// the augmentation is always in scope when Arcara types are in use.

declare module 'node:http' {
  interface IncomingMessage {
    /**
     * Named route params extracted from the matched path pattern.
     * Populated before any handler is called.
     * @example req.params.id  // route: '/users/:id'
     */
    params: Record<string, string>;

    /**
     * Parsed query string as a flat key-value map.
     * @example req.query.page  // url: '/search?page=2'
     */
    query: Record<string, string>;

    /**
     * Parsed request body. Populated automatically for POST, PUT, PATCH.
     *
     * Type depends on `Content-Type`:
     * - `application/json`                  → parsed object
     * - `application/x-www-form-urlencoded` → `Record<string, string>`
     * - `text/*`                            → `string`
     * - anything else                       → `Buffer`
     *
     * `undefined` for GET, DELETE, HEAD, OPTIONS.
     */
    body: unknown;
  }

  interface ServerResponse {
    /**
     * Sets the HTTP status code. Returns `this` for chaining.
     * @throws {HttpError} if `code` is outside 100–599
     * @example res.status(201).json({ created: true })
     */
    status(code: number): this;

    /**
     * Serializes `data` to JSON, sets `Content-Type: application/json`,
     * and ends the response.
     * @example res.json({ id: req.params.id })
     */
    json(data: unknown): this;

    /**
     * Sends a response body with automatic `Content-Type` detection.
     * Handles string, Buffer, Uint8Array, ArrayBuffer, and plain objects.
     * Sets `Content-Length`. Respects HEAD — sends headers only, no body.
     * @example res.send('hello')
     * @example res.send(Buffer.from([0x89, 0x50]))
     */
    send(data: unknown): this;
  }
}

// ── Arcara-typed aliases ─────────────────────────────────────────────────────
//
// These are used internally for typed dispatch and by consumers who want
// explicit param types inferred from path strings. They re-export the
// augmented Node types under Arcara names — no duplication of the method
// declarations, since those live in the module augmentation above.

/**
 * Arcara-typed request. Params are inferred from the route path literal.
 *
 * @example
 * app.get('/users/:id', (req: ArcaraRequest<'id'>, res) => {
 *   req.params.id // string — fully typed
 * })
 */
export interface ArcaraRequest<
  Params extends string = string,
  Method extends HttpMethod = HttpMethod,
>
  extends http.IncomingMessage {
  params: Record<Params, string>;
  query: Record<string, string>;
  // Body is unknown for mutating methods, undefined for read-only ones.
  // The `Method` generic lets route-specific handlers narrow this at the type level.
  body: Method extends 'POST' | 'PUT' | 'PATCH' ? unknown : undefined;
}

/**
 * Arcara-typed response. Includes `status`, `json`, and `send` helpers
 * declared via module augmentation and available on every `ServerResponse`.
 */
export interface ArcaraResponse extends http.ServerResponse {
  status(code: number): this;
  json(data: unknown): this;
  send(data: unknown): this;
}

// ── Middleware & Handlers ───────────────────────────────────────────────────

/**
 * Signals the middleware chain to advance to the next handler.
 * Pass an error to short-circuit to the error handler:
 * @example next(new HttpError(403, 'Forbidden'))
 */
export type NextFn = (err?: unknown) => void | Promise<void>;

/**
 * Standard middleware signature.
 */
export type Middleware<
  Params extends string = string,
  Method extends HttpMethod = HttpMethod,
> = (
  req: ArcaraRequest<Params, Method>,
  res: ArcaraResponse,
  next: NextFn,
) => void | Promise<void> | ArcaraResponse;

/**
 * Route handler — alias of Middleware, typed to a specific path and method.
 */
export type RouteHandler<
  Params extends string = string,
  Method extends HttpMethod = HttpMethod,
> = Middleware<Params, Method>;

/**
 * 4-argument error middleware. Registered via `app.onError()`.
 * Receives a normalized `HttpError` — always has a `status` and `message`.
 *
 * @example
 * app.onError((err, req, res, next) => {
 *   res.status(err.status).json({ error: err.message });
 * });
 */
export type ErrorHandler = (
  err: HttpError,
  req: ArcaraRequest,
  res: ArcaraResponse,
  next: NextFn,
) => void | Promise<void>;

// ── Routing internals ───────────────────────────────────────────────────────

/** A compiled route stored in the radix tree. */
export interface Route {
  method: HttpMethod;
  pattern: string;
  handlers: RouteHandler<any>[];
}

/** A middleware entry with its prefix scope. */
export interface StoredMiddleware {
  prefix: string;
  handler: Middleware;
}

/** A mounted child Layer with its compiled prefix regex. */
export interface StoredChild {
  prefix: string;
  regex: RegExp;
  paramNames: string[];
  layer: Dispatchable;
}

/** Implemented by both Layer and any future sub-router. */
export interface Dispatchable {
  dispatch(
    pathname: string,
    req: ArcaraRequest,
    res: ArcaraResponse,
  ): Promise<void>;
  collectAllowedMethods(pathname: string): Set<HttpMethod>;
}

// ── Errors ──────────────────────────────────────────────────────────────────

/**
 * Structured HTTP error. Use this anywhere in a handler or middleware
 * to produce a typed error response.
 *
 * @example
 * throw new HttpError(404, 'User not found');
 * throw new HttpError(422, 'Validation failed', validationErrors);
 */
export class HttpError extends Error {
  readonly status: number;
  readonly details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.details = details;
  }

  /**
   * Normalizes any thrown value to an `HttpError`.
   * - `HttpError` instances pass through unchanged.
   * - `Error` instances become 500s preserving the message.
   * - Anything else is stringified as a 500.
   */
  static from(e: unknown): HttpError {
    if (e instanceof HttpError) return e;
    if (e instanceof Error) return new HttpError(500, e.message, e);
    return new HttpError(500, String(e));
  }
}

// ── App options ─────────────────────────────────────────────────────────────

export interface ArcaraOptions {
  /**
   * Maximum request body size in bytes.
   * @default 1_048_576 (1MB)
   */
  bodyLimit?: number;

  /**
   * Request timeout in milliseconds. Responds 408 on breach.
   * @default 30_000
   */
  timeout?: number;
}
