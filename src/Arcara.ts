import {
  createServer,
  ServerResponse,
  type IncomingMessage,
  type Server,
} from 'node:http';
import { Layer } from './Layer.js';
import type {
  ArcaraOptions,
  ContentType,
  HttpMethod,
  Redirect,
  RedirectStatus,
} from './types.js';
import { HttpError } from './types.js';
import { detectContentType } from './utils/content.js';
import { internalLogger } from './utils/logger.js';
import { applyRedirect, redirectBack } from './utils/redirect.js';
import { safeWrite } from './utils/stream.js';
import { validateJson, validateStatus } from './utils/validation.js';

const proto = ServerResponse.prototype;

proto.status = function (code: number) {
  const { error } = validateStatus(code);
  if (error) throw error;
  this.statusCode = code;
  return this;
};

proto.json = function (data: unknown) {
  if (this.writableEnded) return this;
  this.setHeader('content-type', 'application/json; charset=utf-8');
  if (data === undefined) return this.end();
  const { data: serialized, error } = validateJson(data);
  if (error) {
    internalLogger.error(error);
    safeWrite(this.req, this, stringifyError(error));
    return this.end();
  }
  safeWrite(this.req, this, serialized);
  return this.end();
};

proto.send = function (data: unknown, contentType?: ContentType) {
  if (data === undefined || this.writableEnded) return this;
  if (!this.getHeader('content-type')) {
    this.setHeader(
      'content-type',
      contentType ?? detectContentType(data, this.req),
    );
  }
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

proto.redirect = Object.assign(
  function (
    this: ServerResponse,
    statusOrTarget: RedirectStatus | string,
    maybeTarget?: string,
  ) {
    return applyRedirect(this, statusOrTarget, maybeTarget);
  },
  { back: redirectBack },
) satisfies Redirect;

function stringifyError(error: Error): string {
  try {
    return JSON.stringify({ error: error.message });
  } catch {
    return '{"error":"Internal Server Error"}';
  }
}

export class Arcara extends Layer {
  private readonly server: Server;
  private readonly bodyLimit: number;
  private readonly timeoutMs: number;
  private readonly openSockets = new Set<import('node:net').Socket>();
  startupLog: boolean;
  readonly PORT: number = 3000;
  readonly HOST: string = 'localhost';

  constructor(options: ArcaraOptions = {}) {
    super();
    this.bodyLimit = options.bodyLimit ?? 1_048_576;
    this.timeoutMs = options.timeout ?? 30_000;
    this.startupLog = options.startupLog ?? true;
    this.server = createServer(this.handleRequest.bind(this));
    this.server.on('connection', (socket) => {
      this.openSockets.add(socket);
      socket.once('close', () => this.openSockets.delete(socket));
    });
  }

  private parseBody(req: IncomingMessage): Promise<void> {
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
          req.pause();
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
            req.body = Object.fromEntries(
              new URLSearchParams(raw.toString('utf-8')),
            );
          } else if (contentType.startsWith('text/')) {
            req.body = raw.toString('utf-8');
          } else {
            req.body = raw;
          }
        } catch {
          const error = new HttpError(400, 'Invalid Request Body');
          internalLogger.error(error);
          return reject(error);
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
        reject(new ClientDisconnectedError());
      };

      req.on('data', onData);
      req.on('end', onEnd);
      req.on('error', onError);
      req.on('close', onClose);
    });
  }

  /**
   * Extracts method, pathname, and query from the raw request URL.
   *
   * Uses manual string parsing instead of `new URL()` — benchmarked ~50x
   * faster for requests without a query string (the majority of requests in
   * most APIs), and ~1.5x faster with one. `new URL()` allocates a full
   * object, validates the host, resolves the origin — none of which is needed
   * for routing where `req.url` is always a valid relative path string.
   *
   * Fast path: no `?` → no allocation beyond the method string.
   * Slow path: `?` present → slice + URLSearchParams (correct encoding handling).
   */
  private extractRequestInfo(req: IncomingMessage): {
    method: HttpMethod;
    pathname: string;
    query: Record<string, string>;
  } {
    const method = (req.method ?? 'GET').toUpperCase() as HttpMethod;
    const raw = req.url ?? '/';
    const qi = raw.indexOf('?');

    if (qi === -1) {
      return { method, pathname: raw, query: {} };
    }

    return {
      method,
      pathname: raw.slice(0, qi),
      query: Object.fromEntries(new URLSearchParams(raw.slice(qi + 1))),
    };
  }

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const { method, pathname, query } = this.extractRequestInfo(req);

    req.params = {};
    req.query = query;
    req.body = undefined;

    const timeout = setTimeout(() => {
      if (!res.writableEnded) {
        res.statusCode = 408;
        res.end(JSON.stringify({ error: 'Request Timeout' }));
      }
    }, this.timeoutMs);

    // res.once('finish', () => clearTimeout(timeout));
    const clearTimer = () => clearTimeout(timeout);
    res.once('finish', clearTimer);
    res.once('close', clearTimer);

    try {
      if (method === 'OPTIONS') {
        await this.dispatch(pathname, req, res);
        if (!res.writableEnded) {
          const allowed = this.collectAllowedMethods(pathname);
          allowed.add('OPTIONS');
          res.writeHead(204, { Allow: [...allowed].join(', ') });
          res.end();
        }
        return;
      }

      if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
        await this.parseBody(req);
      }

      await this.dispatch(pathname, req, res);
    } catch (e) {
      if (e instanceof ClientDisconnectedError) return;
      if (!res.writableEnded) {
        res.statusCode = e instanceof HttpError ? e.status : 500;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(
          JSON.stringify({
            error: e instanceof Error ? e.message : 'Internal Server Error',
          }),
        );
      }
    }
  }

  listen(port: number, callback?: () => void): this;
  listen(port: number, host: string, callback?: () => void): this;
  listen(
    port: number,
    hostOrCallback?: string | (() => void),
    maybeCallback?: () => void,
  ): this {
    const host =
      typeof hostOrCallback === 'string' ? hostOrCallback : this.HOST;
    const callback =
      typeof hostOrCallback === 'function' ? hostOrCallback : maybeCallback;
    (this as { PORT: number }).PORT = port;
    (this as { HOST: string }).HOST = host;
    this.server.listen(port, host, () => {
      if (this.startupLog) internalLogger.start(host, port);
      callback?.();
    });
    return this;
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      for (const socket of this.openSockets) socket.destroy();
      this.openSockets.clear();
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

class ClientDisconnectedError extends Error {
  constructor() {
    super('Client disconnected');
    this.name = 'ClientDisconnectedError';
  }
}
