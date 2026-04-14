import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CookieOptions } from './middlewares/cookies.js';

// ── HTTP Method ─────────────────────────────────────────────────────────────

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
 * Statically extracts route parameter names from a path string literal.
 *
 * This is the type-level engine behind Arcara's param inference —
 * you never need to call or reference it directly.
 *
 * @example
 * type P = ExtractParams<'/orgs/:orgId/repos/:repoId'>
 * // => 'orgId' | 'repoId'
 */
export type ExtractParams<Path extends string> =
  Path extends `${string}/:${infer Param}/${infer Rest}`
    ? Param | ExtractParams<`/${Rest}`>
    : Path extends `${string}/:${infer Param}`
      ? Param
      : never;

export type RedirectStatus = 301 | 302 | 303 | 307 | 308;

// ── Node built-in augmentation ──────────────────────────────────────────────
//
// Arcara augments Node's IncomingMessage and ServerResponse directly so that:
//
//   1. Consumers get IDE autocompletion on req/res without importing anything.
//   2. Third-party middleware written against raw Node types still sees
//      Arcara's additions (params, body, cookies, res.json, etc.).
//
// This block is a no-op when @types/node is absent — nothing to augment —
// but ArcaraRequest / ArcaraResponse below still compile correctly via their
// fallback intersection types.

export type Redirect = {
  (target: `/${string}`): void;
  (status: RedirectStatus, target: `/${string}`): void;
  /**
   * Redirects to the Referer header if same-origin, otherwise to `fallback`.
   * Safe against open redirect via manipulated Referer headers.
   *
   * @example
   * res.redirect.back(req, '/home')
   */
  back(req: IncomingMessage, res: ServerResponse, fallback: string): void;
};

declare module 'node:http' {
  interface IncomingMessage {
    /**
     * Named route parameters, populated before any handler runs.
     *
     * Prefer using `ArcaraRequest<ExtractParams<'/your/:path'>>` in handler
     * signatures for fully narrowed param keys. This declaration provides
     * the runtime slot and a safe fallback type.
     *
     * @example
     * app.get('/users/:id', (req, res) => {
     *   req.params.id // string
     * })
     */
    params: {};

    /**
     * Parsed query string as a flat key-value map.
     * Multi-value keys are not supported — last value wins.
     *
     * @example
     * // GET /search?page=2&limit=10
     * req.query.page   // '2'
     * req.query.limit  // '10'
     */
    query: Record<string, string>;

    /**
     * Parsed request body. Automatically populated for POST, PUT, PATCH.
     *
     * Parsed according to Content-Type:
     * - `application/json`                  → object (via JSON.parse)
     * - `application/x-www-form-urlencoded` → Record<string, string>
     * - `text/*`                            → string
     * - anything else                       → Buffer
     *
     * Always `undefined` for GET, DELETE, HEAD, OPTIONS.
     * Narrow this with a validation library (zod, valibot) before use.
     *
     * @example
     * app.post('/users', (req, res) => {
     *   const { name } = req.body as { name: string }
     *   // or: const { name } = UserSchema.parse(req.body)
     * })
     */
    body: unknown;

    /**
     * Parsed cookies from the `Cookie` request header.
     * Populated by `arcara/cookies` middleware — empty object otherwise.
     *
     * @example
     * import { cookies } from 'arcara/cookies'
     * app.use(cookies())
     *
     * app.get('/me', (req, res) => {
     *   req.cookies.session // string | undefined
     * })
     */
    cookies: Record<string, string>;

    /**
     * Escape hatch for middleware-attached properties.
     *
     * This index signature is intentional — middleware commonly attaches
     * arbitrary context to req (e.g. req.user, req.tenant). TypeScript
     * cannot track these statically without a full context-builder pattern.
     *
     * For typed access, cast at the handler level or extend this interface
     * in your project:
     *
     * @example
     * declare module 'node:http' {
     *   interface IncomingMessage {
     *     user: JWTPayload
     *   }
     * }
     */
    [k: string]: unknown;
  }

  interface ServerResponse {
    /**
     * Sets the HTTP response status code. Returns `this` for chaining.
     *
     * @example
     * res.status(201).json({ created: true })
     * res.status(404).send('Not found')
     */
    status(code: number): this;

    /**
     * Serializes `data` to JSON, sets `Content-Type: application/json`,
     * sets `Content-Length`, and ends the response.
     *
     * @example
     * res.json({ id: 1, name: 'Ala' })
     * res.status(422).json({ error: 'Validation failed', fields: [...] })
     */
    json(data: unknown): this;

    /**
     * Sends a response with automatic Content-Type detection.
     *
     * Accepted types:
     * - `string`      → text/plain (or text/html if HTML is detected)
     * - `Buffer`      → application/octet-stream (or sniffed MIME type)
     * - `object`      → application/json (serialized)
     * - `ArrayBuffer` / `Uint8Array` → binary
     *
     * Sets `Content-Length` automatically.
     * Respects HEAD requests — sends headers only, no body.
     *
     * @example
     * res.send('Hello')
     * res.send(Buffer.from([0xff, 0xd8])) // JPEG
     * res.send({ key: 'value' })          // JSON
     */
    send(data: unknown): this;

    /**
     * Sets a `Set-Cookie` header on the response.
     * Requires `arcara/cookies` middleware to parse incoming cookies.
     *
     * @example
     * res.setCookie('session', token, {
     *   httpOnly: true,
     *   secure: true,
     *   sameSite: 'Strict',
     *   maxAge: 60 * 60 * 24,
     * })
     */
    setCookie(name: string, value: string, options?: CookieOptions): this;

    /**
     * Clears a cookie by setting its `Max-Age` to 0.
     *
     * @example
     * res.clearCookie('session')
     */
    clearCookie(name: string, options?: CookieOptions): this;
    /**
     * Redirects the client to `target` with an optional status code.
     * Only absolute paths are accepted — external URLs are rejected
     * to prevent open redirect vulnerabilities.
     *
     * Defaults to 302. Use 301 for permanent, 303 for post-redirect-get,
     * 307/308 to preserve the request method.
     *
     * @example
     * res.redirect('/dashboard')
     * res.redirect(301, '/new-location')
     * res.redirect.back(req, '/fallback')
     */
    redirect: Redirect;
  }
}

// ── ArcaraRequest ───────────────────────────────────────────────────────────

/**
 * The typed request object received by all route handlers and middleware.
 *
 * Extends Node's `IncomingMessage` (augmented above) with two generics:
 *
 * - `Params` — narrows `req.params` to the exact keys in your path string.
 *   Inferred automatically from the registered path — no annotation needed.
 * - `Method` — narrows `req.body` to `unknown` for mutation methods,
 *   `undefined` for read-only methods.
 *
 * Both generics default to their widest type so `ArcaraRequest` is always
 * safe to use without explicit type arguments.
 *
 * @example
 * // Params inferred automatically — no generics needed at the call site
 * app.get('/users/:id/posts/:postId', (req, res) => {
 *   req.params.id     // ✅ string
 *   req.params.postId // ✅ string
 *   req.params.nope   // ❌ Property 'nope' does not exist on type 'Record<"id" | "postId", string>'
 * })
 *
 * // Explicit typing for reusable middleware or utility functions
 * function requireOwner(req: ArcaraRequest<'id'>) {
 *   if (req.user.id !== req.params.id) throw new HttpError(403, 'Forbidden')
 * }
 */
export type ArcaraRequest<
  Params extends string = never,
  Method extends HttpMethod = HttpMethod,
> = IncomingMessage & {
  /**
   * Route params narrowed to the keys extracted from the path literal.
   * Falls back to {} when Params = never (default).
   */
  params: Record<Params, string>;

  /**
   * Narrowed body type:
   * - POST / PUT / PATCH → `unknown` (needs runtime validation)
   * - GET / DELETE / HEAD / OPTIONS → `undefined`
   */
  body: Method extends 'POST' | 'PUT' | 'PATCH' ? unknown : undefined;
};

// ── ArcaraResponse ──────────────────────────────────────────────────────────

/**
 * The typed response object received by all route handlers and middleware.
 *
 * A thin alias for Node's `ServerResponse`, augmented above with
 * `status()`, `json()`, `send()`, `setCookie()`, and `clearCookie()`.
 *
 * No additional members — everything lives on the augmented `ServerResponse`
 * so raw Node middleware sees the same helpers without any imports.
 *
 * @example
 * app.get('/health', (_req, res) => {
 *   res.status(200).json({ ok: true })
 * })
 */
export type ArcaraResponse = ServerResponse;

// ── Middleware & Handlers ───────────────────────────────────────────────────

/**
 * Advances the middleware chain to the next handler.
 * Pass an error to short-circuit directly to the error handler.
 *
 * @example
 * next()                              // continue
 * next(new HttpError(401, 'No auth')) // jump to onError
 */
export type NextFn = (err?: unknown) => void | Promise<void>;

/**
 * Standard middleware signature used by `app.use()` and inline handlers.
 *
 * @example
 * const logger: Middleware = (req, _res, next) => {
 *   console.log(req.method, req.url)
 *   next()
 * }
 * app.use(logger)
 */
export type Middleware<
  Params extends string = never,
  Method extends HttpMethod = HttpMethod,
> = (
  req: ArcaraRequest<Params, Method>,
  res: ArcaraResponse,
  next: NextFn,
) => void | ArcaraResponse | Promise<void | ArcaraResponse>;

/**
 * Route handler — semantically identical to `Middleware`, typed to a
 * specific path and HTTP method via the Params and Method generics.
 *
 * You rarely need to reference this directly — Arcara infers the correct
 * types from the registered path string at the call site.
 *
 * @example
 * const getUser: RouteHandler<'id', 'GET'> = (req, res) => {
 *   res.json({ id: req.params.id })
 * }
 * app.get('/users/:id', getUser)
 */
export type RouteHandler<
  Params extends string = never,
  Method extends HttpMethod = HttpMethod,
> = Middleware<Params, Method>;

/**
 * Error handler registered via `app.onError()` or `router.onError()`.
 *
 * Always receives a normalized `HttpError` — Arcara converts any thrown
 * value via `HttpError.from()` before passing it here.
 *
 * Scoped per layer: a router's `onError` only catches errors from that
 * router's handlers, not from parent or sibling routers.
 *
 * @example
 * app.onError((err, _req, res) => {
 *   res.status(err.status).json({
 *     error: err.message,
 *     ...(err.details ? { details: err.details } : {}),
 *   })
 * })
 */
export type ErrorHandler = (
  err: HttpError,
  req: ArcaraRequest,
  res: ArcaraResponse,
  next: NextFn,
) => void | ArcaraResponse | Promise<void | ArcaraResponse>;

// ── Routing internals ───────────────────────────────────────────────────────

/** A compiled route entry stored in the routing layer. */
export interface Route {
  method: HttpMethod;
  pattern: string;
  handlers: RouteHandler<any>[];
}

/** A middleware entry with its mount prefix. */
export interface StoredMiddleware {
  prefix: string;
  handler: Middleware;
}

/** A mounted child router with its compiled prefix pattern. */
export interface StoredChild {
  prefix: string;
  regex: RegExp;
  paramNames: string[];
  layer: Dispatchable;
}

/**
 * Implemented by both `Layer` and `Router` — anything that can be mounted
 * as a child and dispatched to.
 */
export interface Dispatchable {
  dispatch(
    pathname: string,
    req: ArcaraRequest,
    res: ArcaraResponse,
  ): Promise<void>;
  collectAllowedMethods(pathname: string): Set<HttpMethod>;
}

// ── HttpError ───────────────────────────────────────────────────────────────

/**
 * Structured HTTP error. Throw this anywhere in a handler or middleware
 * to produce a typed, status-coded error response.
 *
 * Arcara catches all thrown values and normalizes them via `HttpError.from()`
 * before forwarding to `onError` — so you can safely throw plain `Error`s too,
 * but `HttpError` gives you control over the status code and response shape.
 *
 * @example
 * throw new HttpError(404, 'User not found')
 * throw new HttpError(422, 'Validation failed', { field: 'email' })
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
   *
   * - `HttpError`  → returned as-is
   * - `Error`      → wrapped as 500, message preserved
   * - anything else → stringified as 500
   *
   * Used internally by Arcara's dispatch loop — you rarely need this directly
   * unless you're building custom error-handling middleware.
   */
  static from(e: unknown): HttpError {
    if (e instanceof HttpError) return e;
    if (e instanceof Error) return new HttpError(500, e.message, e);
    return new HttpError(500, String(e));
  }
}

// ── ArcaraOptions ───────────────────────────────────────────────────────────

/**
 * Configuration options passed to `new Arcara(options)`.
 *
 * @example
 * const app = new Arcara({
 *   bodyLimit: 5_000_000, // 5MB
 *   timeout: 10_000,      // 10s
 * })
 */
export interface ArcaraOptions {
  /**
   * Maximum request body size in bytes.
   * Requests exceeding this limit receive `413 Payload Too Large`.
   * @default 1_048_576 (1MB)
   */
  bodyLimit?: number;

  /**
   * Request timeout in milliseconds.
   * Requests exceeding this limit receive `408 Request Timeout`.
   * @default 30_000 (30s)
   */
  timeout?: number;

  startupLog?: boolean;
}
