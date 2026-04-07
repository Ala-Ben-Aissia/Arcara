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

// ── Node.js type bridge ──────────────────────────────────────────────────────
//
// Arcara depends on @types/node as a peerDependency — consumers of a Node.js
// HTTP framework are expected to have it installed. However, if a consumer's
// project does not have @types/node resolvable at the time TypeScript checks
// our .d.ts, the `import type http from 'node:http'` above would fail and
// every Arcara type would collapse to `any` or produce a hard error.
//
// The conditional bridge below solves this:
//
//   - WITH @types/node    → `NodeIncomingMessage` = `http.IncomingMessage`
//                           `NodeServerResponse`   = `http.ServerResponse`
//                           Full Node member inference (headers, socket, etc.)
//
//   - WITHOUT @types/node → `NodeIncomingMessage` = `NodeFallbackRequest`
//                           `NodeServerResponse`   = `NodeFallbackResponse`
//                           Arcara-specific members still fully typed.
//                           No `any` index signature — consumers get clear
//                           errors on unknown members instead of silent `any`.
//
// This pattern is used by Hono, tRPC, and other framework packages that must
// work in environments where @types/node may not be present (e.g. Bun, Deno,
// or browser-targeted bundler configs).
//
// IMPORTANT: the fallback interfaces below are NOT duplicating Node types.
// They are a minimal, accurate subset of the members Arcara uses internally
// and that consumers legitimately need on req/res in handlers. Members not
// listed here are genuinely not part of Arcara's API surface.

/**
 * Minimal request shape used when `@types/node` is not available.
 * Covers all members accessed by Arcara internals and handler code.
 * @internal
 */
// export interface NodeFallbackRequest {
//   method?: string;
//   url?: string;
//   headers: Record<string, string | string[] | undefined>;
//   socket: { destroyed: boolean } | null;
//   on(event: string, listener: (...args: unknown[]) => void): this;
//   removeListener(event: string, listener: (...args: unknown[]) => void): this;
//   pause(): this;
//   destroy(error?: Error): this;
// }

/**
 * Minimal response shape used when `@types/node` is not available.
 * Covers all members accessed by Arcara internals and handler code.
 * @internal
 */
// export interface NodeFallbackResponse {
//   statusCode: number;
//   writableEnded: boolean;
//   destroyed: boolean;
//   req: NodeFallbackRequest;
//   setHeader(name: string, value: number | string | readonly string[]): this;
//   getHeader(name: string): number | string | string[] | undefined;
//   removeHeader(name: string): this;
//   writeHead(
//     statusCode: number,
//     headers?: Record<string, string | number | readonly string[]>,
//   ): this;
//   write(
//     chunk: string | Buffer,
//     callback?: (err?: Error | null) => void,
//   ): boolean;
//   end(chunk?: string | Buffer | (() => void), callback?: () => void): this;
//   once(event: string, listener: (...args: unknown[]) => void): this;
// }

// Conditional bridge: attempt to resolve `node:http` first, then `http`,
// and finally fall back to our minimal interfaces. We use `typeof import(...)`
// inside a type position so resolution is attempted by TS only when the
// consumer has the corresponding type package available; otherwise the
// conditional reduces to the fallback interfaces.
// Conditional bridge: resolve to real Node types when @types/node is present,
// fall back to the minimal interfaces above when it is not.
//
// `http.IncomingMessage` is used as the discriminant — if the `node:http`
// module resolves successfully, the conditional picks the real types.
// If not, TypeScript cannot resolve `http.IncomingMessage` and the
// conditional falls to the right-hand branch (the fallback interfaces).
//
// The `[http.IncomingMessage] extends [object]` form (tuple wrapping) avoids
// distributivity over unions — we want a single yes/no check, not per-member
// distribution.
// type NodeHttp = typeof http;
// type NodeIncomingMessage = [NodeHttp] extends [never]
//   ? NodeFallbackRequest
//   : http.IncomingMessage;
// type NodeServerResponse = [NodeHttp] extends [never]
//   ? NodeFallbackResponse
//   : http.ServerResponse;

// Module augmentations were moved to `src/types/augmentations.ts`.
// That file is imported for side-effects from `src/index.ts` so the
// generated `dist/index.d.ts` includes the `/// <reference types="node" />`
// and the `declare module` blocks consumers need without changing their config.

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
  body: Method extends 'POST' | 'PUT' | 'PATCH' ? unknown : undefined;
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
