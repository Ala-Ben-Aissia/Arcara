import type http from 'node:http';

// ── Body ──────────────────────────────────────────────────────────────────────

/**
 * The union of all possible parsed request body shapes.
 *
 * - Record<string, unknown>  → application/json
 * - Record<string, string>   → application/x-www-form-urlencoded
 * - string                   → text/*
 * - Buffer                   → binary / unknown content-type
 */
export type BodyPayload =
  | Record<string, unknown>
  | Record<string, string>
  | string
  | Buffer;

// ── HTTP method ───────────────────────────────────────────────────────────────

/**
 * Supported HTTP methods as a literal union.
 * Using a literal union (not string) means method comparisons
 * are checked by TypeScript at compile time.
 */
export type HttpMethod =
  | 'GET'
  | 'POST'
  | 'PUT'
  | 'PATCH'
  | 'DELETE'
  | 'HEAD'
  | 'OPTIONS';

// ── Path param extraction ─────────────────────────────────────────────────────

/**
 * Recursively extracts named parameter segments from a path string
 * at the type level.
 *
 * @example
 * ExtractParams<'/orgs/:orgId/users/:userId'>
 * // → 'orgId' | 'userId'
 *
 * ExtractParams<'/users'>
 * // → never
 */
export type ExtractParams<Path extends string> =
  Path extends `${string}:${infer Param}/${infer Rest}`
    ? Param | ExtractParams<`/${Rest}`>
    : Path extends `${string}:${infer Param}`
      ? Param
      : never;

// ── Route handler ─────────────────────────────────────────────────────────────

/**
 * The signature for route handlers and middleware.
 *
 * Two type-level constraints are enforced:
 *
 * 1. Params — if the route pattern has no params (Params = never),
 *    req.params is typed as never, preventing accidental access.
 *    Otherwise it is Record<Params, string>.
 *
 * 2. Method — GET and DELETE handlers receive body: never,
 *    preventing accidental body access on bodyless methods.
 *    All other methods receive body: BodyPayload.
 */
export type RouteHandler<
  Params extends string = never,
  Method extends HttpMethod = HttpMethod,
> = (
  req: http.IncomingMessage &
    ([Params] extends [never]
      ? { params: never }
      : { params: Record<Params, string> }) &
    ([Method] extends ['GET' | 'HEAD' | 'DELETE']
      ? { body: never }
      : { body: BodyPayload }),
  res: http.ServerResponse,
  next: () => void | Promise<void>,
) => void | Promise<void> | http.ServerResponse;

// ── Route ─────────────────────────────────────────────────────────────────────

/**
 * The internal shape of a compiled route entry stored in Layer.routes.
 *
 * - pattern    the original path string e.g. '/users/:id'
 * - regex      compiled from pattern e.g. /^\/users\/([^/]+)\/?$/
 * - paramNames ordered list of param names extracted from pattern e.g. ['id']
 * - handlers   the handler chain registered for this route
 */
export type Route = {
  method: HttpMethod;
  pattern: string;
  regex: RegExp;
  paramNames: string[];
  handlers: RouteHandler<any>[];
};

// ── Middleware ────────────────────────────────────────────────────────────────

/**
 * A plain middleware function — no param or method constraints.
 * Used for cross-cutting concerns: logging, auth, CORS, etc.
 */
export type Middleware = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  next: () => void | Promise<void>,
) => void | Promise<void>;

/**
 * Internal shape of an entry in Layer.middlewares.
 * Prefix is normalized at registration time (trailing slashes stripped).
 */
export type StoredMiddleware = {
  prefix: string;
  handler: Middleware;
};

// ── Children ──────────────────────────────────────────────────────────────────

// Forward reference — Layer is defined in Layer.ts which imports from here.
// Using an interface with only the public dispatch surface avoids a circular
// module dependency while keeping StoredChild fully typed.
export interface Dispatchable {
  dispatch(
    pathname: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void>;
  collectAllowedMethods(pathname: string): Set<HttpMethod>;
}

/**
 * Internal shape of a mounted child layer (Router instance).
 * Stored in Layer.children when app.use('/prefix', router) is called.
 *
 * - prefix     normalized mount prefix e.g. '/api'
 * - regex      compiled from prefix to support param segments e.g. /orgs/:orgId
 * - paramNames params extracted from the prefix pattern
 * - layer      the mounted Layer instance
 */
export type StoredChild = {
  prefix: string;
  regex: RegExp;
  paramNames: string[];
  layer: Dispatchable;
};

// ── Error handler ─────────────────────────────────────────────────────────────

/**
 * The signature for scoped error handlers registered via onError().
 * Receives a fully normalized ArcaraError — never a raw unknown.
 */
export type ErrorHandler = (
  err: ArcaraError,
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => void;

// ── ArcaraError ───────────────────────────────────────────────────────────────

/**
 * The framework's first-class error type.
 *
 * Carries an HTTP status code alongside the message, so error handlers
 * can make HTTP-aware decisions without inspecting message strings.
 *
 * The original cause is preserved for logging — when wrapping an unknown
 * thrown value, pass it as the third argument so logger.error can surface
 * the full chain.
 *
 * @example
 * throw new ArcaraError(404, 'User not found');
 * throw new ArcaraError(500, 'Database unreachable', originalError);
 */
export class ArcaraError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ArcaraError';
  }
}

// ── node:http module augmentation ────────────────────────────────────────────
//
// Extends the native IncomingMessage and ServerResponse interfaces so that
// TypeScript recognizes the custom fields Arcara attaches at request time
// and the methods Arcara adds to the ServerResponse prototype.
//
// These augmentations are global — any file that imports from 'node:http'
// after this module is loaded will see these fields.

declare module 'node:http' {
  interface IncomingMessage {
    /** Parsed URL path parameters — populated by the router before handlers run. */
    params: Record<string, string>;
    /**
     * Parsed URL query string — populated from url.searchParams.
     *
     * **Repeated keys are not supported.** `?tag=a&tag=b` produces
     * `{ tag: 'b' }` — only the last value for a given key is kept.
     * This is a deliberate simplification for v0.x. If your API requires
     * multi-value query params, read `new URL(req.url).searchParams`
     * directly in your handler.
     */
    query: Record<string, string>;
    /** Parsed request body — populated by parseBody before handlers run. */
    body: BodyPayload;
  }

  interface ServerResponse {
    /**
     * Sets the HTTP status code. Throws on invalid codes.
     * Returns `this` for chaining: res.status(201).json({ ... })
     */
    status(code: number): this;

    /**
     * Serializes input to JSON, sets Content-Type: application/json,
     * and ends the response.
     */
    json(input: unknown): this;

    /**
     * Sends any supported value with automatic Content-Type detection.
     * Handles strings, Buffers, Uint8Arrays, ArrayBuffers, and objects.
     */
    send(input: unknown): this;
  }
}
