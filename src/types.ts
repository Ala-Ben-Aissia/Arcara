import type { IncomingMessage, ServerResponse } from 'node:http';

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
// Declares Arcara's additions on Node's built-in types so they are visible
// in the consumer's IDE without any extra imports.
//
// This augmentation is only active when @types/node is present — if it is not,
// the `declare module 'node:http'` block is a no-op (there is nothing to augment)
// and consumers still get typed access via ArcaraRequest / ArcaraResponse below.

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
     * Type depends on Content-Type:
     * - `application/json`                  → parsed object
     * - `application/x-www-form-urlencoded` → Record<string, string>
     * - `text/*`                            → string
     * - anything else                       → Buffer
     *
     * `undefined` for GET, DELETE, HEAD, OPTIONS.
     */
    body: any;
  }

  interface ServerResponse {
    /**
     * Sets the HTTP status code. Returns `this` for chaining.
     * @throws {HttpError} if `code` is outside 100–599
     * @example res.status(201).json({ created: true })
     */
    status(code: number): this;

    /**
     * Serializes `data` to JSON, sets Content-Type: application/json,
     * and ends the response.
     * @example res.json({ id: req.params.id })
     */
    json(data: unknown): this;

    /**
     * Sends a response body with automatic Content-Type detection.
     * Handles string, Buffer, Uint8Array, ArrayBuffer, and plain objects.
     * Sets Content-Length. Respects HEAD — sends headers only, no body.
     * @example res.send('hello')
     */
    send(data: unknown): this;
  }
}

// ── ArcaraRequest / ArcaraResponse ───────────────────────────────────────────
//
// These are the types handlers actually receive. They extend the conditional
// bridge types above — so:
//
//   WITH @types/node:    full IncomingMessage / ServerResponse inference
//   WITHOUT @types/node: Arcara-specific members + the minimal fallback set
//
// The Params and Method generics are only meaningful when @types/node is
// present (they narrow params and body). In fallback mode they still compile
// correctly — the base interface just has fewer members.

/**
 * Typed request object received by route handlers and middleware.
 *
 * Route params are statically inferred from the path string literal —
 * no manual type annotation needed.
 *
 * @example
 * app.get('/users/:id', (req, res) => {
 *   req.params.id    // string, inferred from the path
 *   req.query.page   // string | undefined
 *   req.headers      // IncomingHttpHeaders (with @types/node)
 * });
 */
export interface ArcaraRequest<
  Params extends string = string,
  Method extends HttpMethod = HttpMethod,
> extends IncomingMessage {
  /**
   * Named route params extracted from the matched path pattern.
   * Keys are inferred statically from the registered path string.
   */
  params: Record<Params, string>;

  /**
   * Parsed query string as a flat string map.
   */
  query: Record<string, string>;

  /**
   * Parsed request body.
   * `unknown` for POST/PUT/PATCH, `undefined` for all other methods.
   */
  body: Method extends 'POST' | 'PUT' | 'PATCH' ? any : undefined;
}

/**
 * Typed response object received by route handlers and middleware.
 *
 * Extends Node's `ServerResponse` (when `@types/node` is available)
 * with Arcara's fluent helper methods.
 *
 * @example
 * app.get('/health', (_req, res) => {
 *   res.status(200).json({ ok: true });
 * });
 */
export interface ArcaraResponse extends ServerResponse {
  /**
   * Sets the HTTP status code. Returns `this` for chaining.
   * @throws {HttpError} if `code` is outside 100–599
   */
  status(code: number): this;

  /**
   * Serializes `data` to JSON, sets Content-Type: application/json,
   * and ends the response.
   */
  json(data: unknown): this;

  /**
   * Sends a response body with automatic Content-Type detection.
   * Handles string, Buffer, Uint8Array, ArrayBuffer, and plain objects.
   */
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
) => void | ArcaraResponse | Promise<void | ArcaraResponse>;

/**
 * Route handler — alias of Middleware, typed to a specific path and method.
 */
export type RouteHandler<
  Params extends string = string,
  Method extends HttpMethod = HttpMethod,
> = Middleware<Params, Method>;

/**
 * Error handler registered via `app.onError()`.
 * Receives a normalized `HttpError` — always has `status` and `message`.
 *
 * @example
 * app.onError((err, _req, res) => {
 *   res.status(err.status).json({ error: err.message });
 * });
 */
export type ErrorHandler = (
  err: HttpError,
  req: ArcaraRequest,
  res: ArcaraResponse,
  next: NextFn,
) => void | ArcaraResponse | Promise<void | ArcaraResponse>;

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
