import http from 'node:http';
import { Layer } from './Layer.js';
import type { HttpMethod } from './types.js';
import { ArcaraError } from './types.js';
import { detectContentType } from './utils/content.js';
import { logger } from './utils/logger.js';
import { safeWrite } from './utils/stream.js';
import { validateJson, validateStatus } from './utils/validation.js';

const TIMEOUT_MS = 30_000;

// Augmented once at module load time — not per-request, zero overhead.
// Proto methods must never be called from the default errorHandler path
// since status() throws on invalid codes. The last-resort catch in
// handleRequest bypasses all proto methods and writes raw statusCode + end().

const proto = http.ServerResponse.prototype;

/**
 * Serializes an error to a plain JSON string for error response bodies.
 * Used when validateJson fails inside proto.json — must never throw.
 */
function stringifyError(error: Error): string {
  try {
    return JSON.stringify({ error: error.message });
  } catch {
    return '{"error":"Internal Server Error"}';
  }
}

/**
 * Sets the HTTP status code. Throws on invalid codes — this is a programmer
 * error and should surface immediately at the call site.
 * Returns `this` for chaining: res.status(201).json({ ... })
 */
proto.status = function (code: number) {
  const { error } = validateStatus(code);
  if (error) throw error;
  this.statusCode = code;
  return this;
};

/**
 * Serializes input to JSON, sets Content-Type: application/json,
 * writes via safeWrite, and ends the response.
 *
 * Does NOT call proto.status on the error path — avoids a throw cascade
 * if the error handler itself calls res.json() with a bad status.
 */
proto.json = function (input: unknown) {
  if (this.writableEnded) return this;
  this.setHeader('content-type', 'application/json; charset=utf-8');

  if (input === undefined) return this.end();

  const { data, error } = validateJson(input);
  if (error) {
    logger.error(error);
    safeWrite(this.req, this, stringifyError(error));
    return this.end();
  }

  safeWrite(this.req, this, data);
  return this.end();
};

/**
 * Sends any supported value with automatic Content-Type detection.
 * Handles strings, Buffers, Uint8Arrays, ArrayBuffers, and objects.
 * Sets Content-Length. Respects HEAD — sends headers only, no body.
 */
proto.send = function (input: unknown) {
  if (input === undefined || this.writableEnded) return this;

  // Only set content-type if not already set — allows caller to override
  if (!this.getHeader('content-type')) {
    this.setHeader('content-type', detectContentType(input, this.req));
  }

  // Normalize input to a writable chunk — prepare unconditionally so
  // Content-Length is always accurate, even for HEAD requests
  const body =
    input instanceof ArrayBuffer
      ? Buffer.from(input)
      : input instanceof Uint8Array
        ? Buffer.from(input.buffer, input.byteOffset, input.byteLength)
        : typeof input === 'string' || Buffer.isBuffer(input)
          ? input
          : JSON.stringify(input);

  this.setHeader('content-length', Buffer.byteLength(body));

  // HEAD: headers are set above, skip the body write
  if (this.req.method === 'HEAD') return this.end();

  safeWrite(this.req, this, body);
  return this.end();
};

export class Arcara extends Layer {
  private readonly server: http.Server;

  constructor() {
    super();
    this.server = http.createServer(this.handleRequest.bind(this));
  }

  /**
   * Streams and buffers the request body up to 1MB.
   *
   * Enforces the limit by pausing the stream on overflow — prevents memory
   * growth before the full body arrives, not just rejection after the fact.
   *
   * The `resolved` guard and explicit listener cleanup via `cleanup()`
   * prevent double-resolve/reject if multiple events fire in quick succession
   * (e.g. 'error' fires after 'close' on an aborted connection).
   *
   * Client disconnect ('close' before 'end') resolves silently — the socket
   * is gone, there's nothing to respond to, and it's not a server error.
   */
  private parseBody(req: http.IncomingMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const LIMIT = 1024 * 1024; // 1MB
      let resolved = false;

      const cleanup = () => {
        req.removeListener('data', onData);
        req.removeListener('end', onEnd);
        req.removeListener('error', onError);
        req.removeListener('close', onClose);
      };

      const onData = (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > LIMIT) {
          resolved = true;
          req.pause();
          cleanup();
          return reject(new ArcaraError(413, 'Payload Too Large'));
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
            // and all other edge cases that manual splitting misses
            req.body = Object.fromEntries(
              new URLSearchParams(raw.toString('utf-8')),
            );
          } else if (contentType.startsWith('text/')) {
            req.body = raw.toString('utf-8');
          } else {
            req.body = raw;
          }
        } catch {
          return reject(new ArcaraError(400, 'Invalid Request Body'));
        }

        resolve();
      };

      const onError = (err: Error) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        reject(new ArcaraError(400, 'Request Error', err));
      };

      // Client disconnected mid-stream — not a server error, resolve silently.
      // The finish listener in handleRequest will destroy the socket after
      // the response flushes (or immediately if writableEnded is already true).
      const onClose = () => {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve();
      };

      req.on('data', onData);
      req.on('end', onEnd);
      req.on('error', onError);
      req.on('close', onClose);
    });
  }

  // ── Request info extraction ─────────────────────────────────────────────────

  /**
   * Extracts method, pathname, and query from the raw IncomingMessage.
   * Uses the URL constructor for correct parsing of encoded paths and
   * query strings. Falls back to '/' if req.url is missing or malformed.
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

  // ── Request lifecycle ───────────────────────────────────────────────────────

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const startTime = Date.now();

    // 1. Extract pathname, method, query
    const { method, pathname, query } = this.extractRequestInfo(req);

    // 2. Initialize req fields — never undefined downstream
    req.params = {};
    req.query = query;

    // Worth doing: timeout
    const timeout = setTimeout(() => {
      if (!res.writableEnded) {
        res.statusCode = 408;
        res.end(JSON.stringify({ error: 'Request Timeout' }));
      }
    }, TIMEOUT_MS);

    // 3. Single finish listener covers every exit path uniformly —
    //    success, error, timeout, early return. No per-branch cleanup needed.
    res.once('finish', () => {
      req.destroy();
      clearTimeout(timeout);
      logger.request(method, pathname, res.statusCode, Date.now() - startTime);
    });

    try {
      // 4. OPTIONS — walk the full route tree, respond immediately
      if (method === 'OPTIONS') {
        const allowed = this.collectAllowedMethods(pathname);
        allowed.add('OPTIONS');
        res.writeHead(204, { Allow: [...allowed].join(', ') });
        res.end();
        return;
      }

      // 5. Parse body for methods that carry one
      if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
        await this.parseBody(req);
      }

      // 6. Dispatch through the layer tree
      await this.dispatch(pathname, req, res);
    } catch (e) {
      // Last-resort catch — only reachable if Layer.handleError threw
      // (i.e. the user's errorHandler itself threw). Bypass all proto
      // methods entirely to avoid a second throw cascade.
      if (!res.writableEnded) {
        res.statusCode = e instanceof ArcaraError ? e.status : 500;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: 'Internal Server Error' }));
      }
    }
  }

  // ── Server ──────────────────────────────────────────────────────────────────

  /**
   * Starts listening on the given port and host.
   * Defaults to '0.0.0.0' — binds all interfaces, correct for containers
   * and servers where 'localhost' would only bind the loopback interface.
   * Returns `this` for chaining.
   *
   * @example
   * new Arcara()
   *   .get('/', (req, res) => res.json({ ok: true }))
   *   .listen(3000);
   */
  listen(port: number, host = '0.0.0.0', callback?: () => void): this {
    this.server.listen(port, host, () => {
      logger.start(host, port);
      callback?.();
    });
    return this;
  }
}
