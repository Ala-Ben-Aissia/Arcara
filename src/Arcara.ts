import http from 'node:http';
import { Layer } from './Layer.js';
import type { ArcaraOptions, HttpMethod } from './types.js';
import { HttpError } from './types.js';
import { detectContentType } from './utils/content.js';
import { logger } from './utils/logger.js';
import { safeWrite } from './utils/stream.js';
import { validateJson, validateStatus } from './utils/validation.js';

// ── Response proto augmentation ─────────────────────────────────────────────
//
// Augmented once at module load — not per-request, zero overhead.
// Scoped to this module: only Arcara consumers are affected, not arbitrary
// http.Server instances. Proto methods must never be used from the default
// errorHandler path since status() throws on invalid codes — the last-resort
// catch in handleRequest bypasses all proto methods and writes raw statusCode.

const proto = http.ServerResponse.prototype;

/**
 * Serializes an error to a plain JSON string for error response bodies.
 * Must never throw — used when validateJson itself fails inside proto.json.
 */
function stringifyError(error: Error): string {
  try {
    return JSON.stringify({ error: error.message });
  } catch {
    return '{"error":"Internal Server Error"}';
  }
}

/**
 * Sets the HTTP status code on the response. Throws on invalid code ranges —
 * this is a programmer error and should surface immediately at the call site.
 * Returns `this` for chaining: `res.status(201).json({ ... })`
 *
 * @throws {HttpError} 500 if `code` is outside 100–599
 */
proto.status = function (code: number) {
  const { error } = validateStatus(code);
  if (error) throw error;
  this.statusCode = code;
  return this;
};

/**
 * Serializes `data` to JSON, sets `Content-Type: application/json`, writes
 * the body via `safeWrite`, and ends the response.
 *
 * Does NOT call `proto.status` on the error path to avoid a throw cascade
 * if the error handler itself calls `res.json()` with a bad status code.
 */
proto.json = function (data: unknown) {
  if (this.writableEnded) return this;
  this.setHeader('content-type', 'application/json; charset=utf-8');

  if (data === undefined) return this.end();

  const { data: serialized, error } = validateJson(data);
  if (error) {
    logger.error(error);
    safeWrite(this.req, this, stringifyError(error));
    return this.end();
  }

  safeWrite(this.req, this, serialized);
  return this.end();
};

/**
 * Sends a response body with automatic `Content-Type` detection.
 * Handles: string, Buffer, Uint8Array, ArrayBuffer, and plain objects.
 *
 * - Always sets `Content-Length` (even for HEAD) so headers are accurate.
 * - Respects HEAD — sends headers only, writes no body.
 * - Only sets `Content-Type` if not already set, allowing caller override.
 */
proto.send = function (data: unknown) {
  if (data === undefined || this.writableEnded) return this;

  if (!this.getHeader('content-type')) {
    this.setHeader('content-type', detectContentType(data, this.req));
  }

  // Normalize to a writable chunk unconditionally — Content-Length must
  // be accurate even for HEAD requests where the body is not sent.
  const body =
    data instanceof ArrayBuffer
      ? Buffer.from(data)
      : data instanceof Uint8Array
        ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
        : typeof data === 'string' || Buffer.isBuffer(data)
          ? data
          : JSON.stringify(data);

  this.setHeader('content-length', Buffer.byteLength(body));

  if (this.req.method === 'HEAD') return this.end();

  safeWrite(this.req, this, body);
  return this.end();
};

// ── Application ─────────────────────────────────────────────────────────────

/**
 * Core Arcara application class. Extends `Layer` with an HTTP server,
 * request lifecycle management, body parsing, and timeout handling.
 *
 * @example
 * ```ts
 * const app = new Arcara();
 *
 * app.use(corsMiddleware());
 * app.get('/health', (_req, res) => res.json({ ok: true }));
 * app.post('/users', (req, res) => res.status(201).json(req.body));
 *
 * app.onError((err, _req, res) => {
 *   res.status(err.status).json({ error: err.message });
 * });
 *
 * app.listen(3000);
 * ```
 */
export class Arcara extends Layer {
  private readonly server: http.Server;
  private readonly bodyLimit: number;
  private readonly timeoutMs: number;
  private readonly openSockets = new Set<import('node:net').Socket>();

  constructor(options: ArcaraOptions = {}) {
    super();
    this.bodyLimit = options.bodyLimit ?? 1_048_576;
    this.timeoutMs = options.timeout ?? 30_000;
    this.server = http.createServer(this.handleRequest.bind(this));
    this.server.on('connection', (socket) => {
      this.openSockets.add(socket);
      socket.once('close', () => this.openSockets.delete(socket));
    });
  }

  // ── Body parsing ──────────────────────────────────────────────────────────

  /**
   * Streams and buffers the request body up to `bodyLimit` bytes.
   *
   * The `resolved` guard + `cleanup()` prevent double-resolve/reject if
   * multiple events fire in quick succession (e.g. `error` fires after
   * `close` on an aborted connection).
   *
   * Client disconnect (`close` before `end`) rejects with
   * `ClientDisconnectedError` — `handleRequest` catches this and returns
   * early without attempting a response on a dead socket.
   *
   * Body limit is enforced by pausing the stream on overflow, preventing
   * memory growth before the full oversize body arrives.
   */
  private parseBody(req: http.IncomingMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let resolved = false;

      const cleanup = () => {
        req.removeListener('data', onData);
        req.removeListener('end', onEnd);
        req.removeListener('error', onError);
        req.removeListener('close', onClose);
      };

      const onData = (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > this.bodyLimit) {
          resolved = true;
          req.pause(); // Prevent memory growth — reject before full body arrives
          cleanup();
          return reject(new HttpError(413, 'Payload Too Large'));
        }
        chunks.push(chunk);
      };

      const onEnd = () => {
        if (resolved) return;
        resolved = true;
        cleanup();

        const raw = Buffer.concat(chunks);
        const contentType = req.headers['content-type'] ?? '';

        try {
          if (contentType.includes('application/json')) {
            req.body = JSON.parse(raw.toString('utf-8'));
          } else if (
            contentType.includes('application/x-www-form-urlencoded')
          ) {
            // URLSearchParams handles '+' as space, encoded '=' in values,
            // and all other edge cases that manual splitting misses.
            req.body = Object.fromEntries(
              new URLSearchParams(raw.toString('utf-8')),
            );
          } else if (contentType.startsWith('text/')) {
            req.body = raw.toString('utf-8');
          } else {
            req.body = raw;
          }
        } catch {
          return reject(new HttpError(400, 'Invalid Request Body'));
        }

        resolve();
      };

      const onError = (err: Error) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        reject(new HttpError(400, 'Request Error', err));
      };

      const onClose = () => {
        if (resolved) return;
        resolved = true;
        cleanup();
        // Client disconnected mid-stream — reject so handleRequest can
        // short-circuit instead of dispatching to route handlers on a dead socket.
        reject(new ClientDisconnectedError());
      };

      req.on('data', onData);
      req.on('end', onEnd);
      req.on('error', onError);
      req.on('close', onClose);
    });
  }

  // ── Request info ──────────────────────────────────────────────────────────

  /**
   * Extracts method, pathname, and query string from `IncomingMessage`.
   * Uses the `URL` constructor for correct parsing of encoded paths.
   * Falls back to `'/'` if `req.url` is missing or unparseable.
   */
  private extractRequestInfo(req: http.IncomingMessage): {
    method: HttpMethod;
    pathname: string;
    query: Record<string, string>;
  } {
    const url = new URL(
      req.url ?? '/',
      `http://${req.headers.host ?? 'localhost'}`,
    );
    return {
      method: (req.method ?? 'GET').toUpperCase() as HttpMethod,
      pathname: url.pathname,
      query: Object.fromEntries(url.searchParams),
    };
  }

  // ── Request lifecycle ─────────────────────────────────────────────────────

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const startTime = Date.now();
    const { method, pathname, query } = this.extractRequestInfo(req);

    // Initialize augmented fields — never undefined downstream
    req.params = {};
    req.query = query;

    const timeout = setTimeout(() => {
      if (!res.writableEnded) {
        res.statusCode = 408;
        res.end(JSON.stringify({ error: 'Request Timeout' }));
      }
    }, this.timeoutMs);

    // Single finish listener covers every exit path uniformly:
    // success, error, timeout, early return. No per-branch cleanup needed.
    res.once('finish', () => {
      // Do NOT call req.destroy() here — it tears down the TCP socket
      // immediately, racing with the client reading the response body and
      // causing ECONNRESET on the client side. Node's HTTP keep-alive
      // connection management handles socket reuse and teardown correctly.
      // req.destroy() is only appropriate on client disconnect (dead socket),
      // which is already handled via ClientDisconnectedError in parseBody.
      clearTimeout(timeout);
      logger.request(method, pathname, res.statusCode, Date.now() - startTime);
    });

    try {
      // OPTIONS: walk the full route tree for CORS preflight, then fall back
      // to an automatic 204 + Allow header if no explicit handler responded.
      if (method === 'OPTIONS') {
        // await this.dispatch(pathname, req, res);
        if (!res.writableEnded) {
          const allowed = this.collectAllowedMethods(pathname);
          allowed.add('OPTIONS');
          res.writeHead(204, { Allow: [...allowed].join(', ') });
          res.end();
        }
        return;
      }

      // Parse body for methods that carry one — before dispatch so handlers
      // always receive a fully populated req.body.
      if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
        await this.parseBody(req);
      }

      await this.dispatch(pathname, req, res);
    } catch (e) {
      // ClientDisconnectedError: socket is gone, nothing to respond to.
      if (e instanceof ClientDisconnectedError) return;

      // Last-resort catch — only reachable if the user's errorHandler itself
      // threw. Bypass all proto methods to avoid a second throw cascade.
      if (!res.writableEnded) {
        res.statusCode = e instanceof HttpError ? e.status : 500;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: 'Internal Server Error' }));
      }
    }
  }

  // ── Server ────────────────────────────────────────────────────────────────

  /**
   * Starts listening on the given port, binding to all interfaces (`0.0.0.0`).
   *
   * @example
   * app.listen(3000);
   * app.listen(3000, () => console.log('ready'));
   */
  listen(port: number, callback?: () => void): this;

  /**
   * Starts listening on the given port and host.
   *
   * @example
   * app.listen(3000, 'localhost');
   * app.listen(3000, 'localhost', () => console.log('ready'));
   */
  listen(port: number, host: string, callback?: () => void): this;

  listen(
    port: number,
    hostOrCallback?: string | (() => void),
    maybeCallback?: () => void,
  ): this {
    let host = '0.0.0.0';
    let callback: (() => void) | undefined;

    if (typeof hostOrCallback === 'string') {
      host = hostOrCallback;
      callback = maybeCallback;
    } else if (typeof hostOrCallback === 'function') {
      callback = hostOrCallback;
    }

    this.server.listen(port, host, () => {
      logger.start(host, port);
      callback?.();
    });

    return this;
  }

  /**
   * Gracefully stops the server. Stops accepting new connections and
   * waits for in-flight requests to complete before resolving.
   *
   * @example
   * process.on('SIGTERM', () => app.close());
   */
  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Destroy all tracked open sockets immediately.
      // server.close() alone only stops accepting new connections — it does
      // not close existing keep-alive sockets, causing close() to hang
      // indefinitely until those connections time out on their own.
      for (const socket of this.openSockets) {
        socket.destroy();
      }
      this.openSockets.clear();
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

// ── Internal ──────────────────────────────────────────────────────────────

/**
 * Thrown internally by `parseBody` when the client disconnects mid-stream.
 * Caught in `handleRequest` to short-circuit dispatch silently — the socket
 * is gone and there is nothing to respond to.
 *
 * Not exported: this is an internal flow-control signal, not an API error.
 */
class ClientDisconnectedError extends Error {
  constructor() {
    super('Client disconnected');
    this.name = 'ClientDisconnectedError';
  }
}
