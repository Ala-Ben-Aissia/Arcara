// src/Arcara.ts
import http from "http";

// src/types.ts
var ArcaraError = class extends Error {
  constructor(status, message, cause) {
    super(message);
    this.status = status;
    this.cause = cause;
    this.name = "ArcaraError";
  }
  status;
  cause;
};

// src/utils/logger.ts
var color = {
  bold: (s) => `\x1B[1m${s}\x1B[0m`,
  dim: (s) => `\x1B[2m${s}\x1B[0m`,
  green: (s) => `\x1B[32m${s}\x1B[0m`,
  yellow: (s) => `\x1B[33m${s}\x1B[0m`,
  red: (s) => `\x1B[31m${s}\x1B[0m`,
  gray: (s) => `\x1B[90m${s}\x1B[0m`,
  blue: (s) => `\x1B[34m${s}\x1B[0m`,
  magenta: (s) => `\x1B[35m${s}\x1B[0m`,
  cyan: (s) => `\x1B[36m${s}\x1B[0m`
};
function getCauseChain(cause) {
  if (!cause) return "";
  let chain = "";
  let current = cause;
  let depth = 0;
  while (current && depth < 10) {
    const isErr = current instanceof Error;
    const msg = isErr ? `${current.name}: ${current.message}` : String(current);
    chain += color.gray("\nCaused by: ") + msg;
    if (!isErr || !current.cause) break;
    current = current.cause;
    depth++;
  }
  return chain;
}
var logger = {
  request(method, pathname, status, durationMs) {
    const methodCol = {
      GET: color.green,
      POST: color.blue,
      PUT: color.yellow,
      PATCH: color.magenta,
      DELETE: color.red,
      HEAD: color.cyan,
      OPTIONS: color.gray
    }[method] || color.cyan;
    const meth = methodCol(method);
    const statCol = status < 300 ? color.green : status < 400 ? color.yellow : color.red;
    const stat = statCol(status.toString());
    const dur = color.dim(`${durationMs}ms`);
    console.log(`${meth} ${pathname} ${stat} ${dur}`);
  },
  start(host, port) {
    const url = `http://${host}:${port}`;
    console.log(`${color.green("\u2713")} Server listening on ${color.cyan(url)}`);
  },
  error(e) {
    const isError = e instanceof Error;
    let name = isError ? e.name : "Error";
    const message = isError ? e.message : String(e);
    if (e instanceof ArcaraError) {
      name = `${name} (${e.status})`;
    }
    const stack = isError && e.stack ? color.gray("\n" + e.stack.split("\n").slice(1).join("\n")) : "";
    const cause = isError ? getCauseChain(e.cause) : "";
    console.error(
      color.red(color.bold(`\u2717 ${name}`)) + " " + message + cause + stack
    );
  }
};

// src/utils/routing.ts
var RadixNode = class {
  children = /* @__PURE__ */ new Map();
  paramChild = null;
  paramName = null;
  routes = {};
};
var RadixTree = class {
  root = new RadixNode();
  /**
   * Inserts a route into the prefix tree.
   * Compiles the path into segments and builds the necessary nodes.
   */
  insert(route) {
    const segments = route.pattern.split("/").filter(Boolean);
    let current = this.root;
    for (const segment of segments) {
      if (segment.startsWith(":")) {
        const paramName = segment.slice(1);
        if (!current.paramChild) {
          const paramNode = new RadixNode();
          paramNode.paramName = paramName;
          current.paramChild = paramNode;
        }
        current = current.paramChild;
      } else {
        if (!current.children.has(segment)) {
          current.children.set(segment, new RadixNode());
        }
        current = current.children.get(segment);
      }
    }
    current.routes[route.method] = route;
  }
  /**
   * Traverses the tree to find a matching route.
   */
  lookup(pathname, method) {
    const segments = pathname.split("/").filter(Boolean);
    const params = {};
    const matchedNode = this.search(this.root, segments, 0, params);
    if (!matchedNode) {
      return { success: false, code: 404, error: "Not Found" };
    }
    const route = matchedNode.routes[method];
    if (route) {
      return { success: true, route, params };
    }
    const hasOtherMethods = Object.keys(matchedNode.routes).length > 0;
    if (hasOtherMethods) {
      return { success: false, code: 405, error: "Method Not Allowed" };
    }
    return { success: false, code: 404, error: "Not Found" };
  }
  /**
   * Recursive search to support backtracking.
   * Tries static segments first, falls back to param segments if static hits a dead end.
   */
  search(node, segments, index, params) {
    if (index === segments.length) return node;
    const segment = segments[index];
    const staticChild = node.children.get(segment);
    if (staticChild) {
      const result = this.search(staticChild, segments, index + 1, params);
      if (result) return result;
    }
    if (node.paramChild) {
      const snapshot = { ...params };
      params[node.paramChild.paramName] = segment;
      const result = this.search(node.paramChild, segments, index + 1, params);
      if (result) return result;
      Object.keys(params).forEach((k) => delete params[k]);
      Object.assign(params, snapshot);
    }
    return null;
  }
  /**
   * Walks the tree to collect all registered methods for a path (used for OPTIONS).
   */
  collectAllowedMethods(pathname) {
    const segments = pathname.split("/").filter(Boolean);
    const matchedNode = this.search(this.root, segments, 0, {});
    const allowed = /* @__PURE__ */ new Set();
    if (matchedNode) {
      for (const method of Object.keys(matchedNode.routes)) {
        allowed.add(method);
        if (method === "GET") allowed.add("HEAD");
      }
    }
    return allowed;
  }
};
function compilePath(path, prefix = false) {
  const paramNames = [];
  const regexStr = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:([^/]+)/g, (_, name) => {
    paramNames.push(name);
    return "([^/]+)";
  }).replace(/\//g, "\\/");
  const terminator = prefix ? "(?=\\/|$)" : "\\/?$";
  return { regex: new RegExp(`^${regexStr}${terminator}`), paramNames };
}

// src/Layer.ts
var Layer = class _Layer {
  routeTree = new RadixTree();
  middlewares = [];
  children = [];
  // Default error handler must never use proto methods (res.status, res.json) —
  // those can throw on invalid state, and this is the last line of defense.
  errorHandler = (err, _req, res) => {
    if (!res.writableEnded) {
      res.statusCode = err.status ?? 500;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: err.message }));
    }
  };
  // ── Public API ──────────────────────────────────────────────────────────────
  onError(handler) {
    this.errorHandler = handler;
    return this;
  }
  use(prefixOrHandler, handler) {
    if (typeof prefixOrHandler === "function") {
      this.middlewares.push({ prefix: "/", handler: prefixOrHandler });
      return this;
    }
    const prefix = this.normalizePrefix(prefixOrHandler);
    if (handler === void 0) {
      throw new TypeError("use() requires a handler when a prefix is provided");
    }
    if (handler instanceof _Layer) {
      const { regex, paramNames } = compilePath(prefix, true);
      this.children.push({ prefix, regex, paramNames, layer: handler });
    } else {
      this.middlewares.push({ prefix, handler });
    }
    return this;
  }
  get(path, ...handlers) {
    return this.pushRoute(path, "GET", handlers);
  }
  post(path, ...handlers) {
    return this.pushRoute(path, "POST", handlers);
  }
  put(path, ...handlers) {
    return this.pushRoute(path, "PUT", handlers);
  }
  patch(path, ...handlers) {
    return this.pushRoute(path, "PATCH", handlers);
  }
  delete(path, ...handlers) {
    return this.pushRoute(path, "DELETE", handlers);
  }
  // ── Dispatch ────────────────────────────────────────────────────────────────
  /**
   * Recursively dispatches a request through this layer's middlewares,
   * routes, and mounted child layers.
   *
   * Called by Arcara.handleRequest at the root and by parent layers
   * on children during tree traversal.
   */
  async dispatch(pathname, req, res) {
    try {
      const mwStack = this.middlewares.filter((mw) => this.matchesPrefix(pathname, mw.prefix)).map((mw) => mw.handler);
      await this.runStack(req, res, mwStack);
      if (res.writableEnded) return;
      const effectiveMethod = (req.method === "HEAD" ? "GET" : req.method ?? "GET").toUpperCase();
      const match = this.routeTree.lookup(pathname, effectiveMethod);
      const methodMismatch = !match.success && match.code === 405;
      if (match.success) {
        req.params = { ...req.params, ...match.params };
        await this.runStack(req, res, match.route.handlers);
        if (!res.writableEnded) res.end();
        return;
      }
      let childMatched = false;
      for (const child of this.children) {
        const prefixMatch = pathname.match(child.regex);
        if (!prefixMatch) continue;
        childMatched = true;
        const prefixParams = Object.fromEntries(
          child.paramNames.map((name, i) => [name, prefixMatch[i + 1] ?? ""])
        );
        req.params = { ...req.params, ...prefixParams };
        const stripped = pathname.slice(prefixMatch[0].length) || "/";
        await child.layer.dispatch(stripped, req, res);
        if (res.writableEnded) return;
      }
      throw new ArcaraError(
        methodMismatch && !childMatched ? 405 : 404,
        methodMismatch && !childMatched ? "Method Not Allowed" : "Not Found"
      );
    } catch (e) {
      this.handleError(e, req, res);
    }
  }
  /**
   * Walks the full route tree to collect all HTTP methods registered for
   * a given pathname. Used by OPTIONS handling in Arcara.
   */
  collectAllowedMethods(pathname) {
    const allowed = this.routeTree.collectAllowedMethods(pathname);
    for (const child of this.children) {
      const prefixMatch = pathname.match(child.regex);
      if (!prefixMatch) continue;
      const stripped = pathname.slice(prefixMatch[0].length) || "/";
      for (const method of child.layer.collectAllowedMethods(stripped)) {
        allowed.add(method);
      }
    }
    return allowed;
  }
  // ── Protected helpers ───────────────────────────────────────────────────────
  /**
   * Runs an ordered handler stack sequentially via a shared next() dispatcher.
   *
   * Double-next detection: `index` tracks the last handler position that
   * started executing. If next() is called with i <= index, the same handler
   * called next() twice.
   *
   * `poisoned` is set to true on detection before handleError is called.
   * All subsequent dispatch(i) calls become no-ops immediately — this is
   * necessary because `return` inside the inner closure only exits that
   * closure, not the still-executing async handler that made the second
   * next() call. Without the flag, that handler continues running after the
   * error response has already been sent.
   */
  async runStack(req, res, stack) {
    let index = -1;
    let poisoned = false;
    const dispatch = async (i) => {
      if (poisoned) return;
      if (i <= index) {
        poisoned = true;
        this.handleError(
          new ArcaraError(
            500,
            `next() called multiple times in handler at position ${index}`
          ),
          req,
          res
        );
        return;
      }
      index = i;
      if (i === stack.length) return;
      await stack[i]?.(req, res, () => dispatch(i + 1));
    };
    await dispatch(0);
  }
  /**
   * Normalizes any thrown value to ArcaraError, logs it, and delegates
   * to the active errorHandler.
   *
   * 404/405 are not logged — they are normal routing outcomes, not failures.
   * For 500s, logs the full ArcaraError (not just the cause) so status and
   * message are always visible alongside the cause chain.
   */
  handleError(e, req, res) {
    const err = e instanceof ArcaraError ? e : new ArcaraError(500, e instanceof Error ? e.message : String(e), e);
    if (err.status >= 500) logger.error(err);
    if (!res.writableEnded) this.errorHandler(err, req, res);
  }
  // ── Private helpers ─────────────────────────────────────────────────────────
  pushRoute(path, method, handlers) {
    const route = { method, pattern: path, handlers };
    this.routeTree.insert(route);
    return this;
  }
  /**
   * Returns true if pathname falls under the given prefix.
   * '/'      → matches everything (global middlewares)
   * '/api'   → matches '/api' and '/api/users' but not '/api-v2'
   */
  matchesPrefix(pathname, prefix) {
    if (prefix === "/") return true;
    return pathname === prefix || pathname.startsWith(prefix + "/");
  }
  /**
   * Strips trailing slashes. Preserves '/' for global middleware prefix.
   * '/api/v1/' → '/api/v1'
   * '/'        → '/'
   */
  normalizePrefix(prefix) {
    return prefix === "/" ? "/" : prefix.replace(/\/+$/, "");
  }
};

// src/utils/content.ts
function sniffImageMagicBytes(bytes) {
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
    return "image/jpeg";
  }
  if (bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71 && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10) {
    return "image/png";
  }
  if (bytes[0] === 71 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 56) {
    return "image/gif";
  }
  if (bytes[0] === 82 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 70 && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80) {
    return "image/webp";
  }
  if (bytes[0] === 66 && bytes[1] === 77) {
    return "image/bmp";
  }
  if (bytes[0] === 73 && bytes[1] === 73 && bytes[2] === 42 && bytes[3] === 0) {
    return "image/tiff";
  }
  if (bytes[0] === 77 && bytes[1] === 77 && bytes[2] === 0 && bytes[3] === 42) {
    return "image/tiff";
  }
  if (bytes[4] === 102 && // f
  bytes[5] === 116 && // t
  bytes[6] === 121 && // y
  bytes[7] === 112) {
    const brand = String.fromCharCode(
      bytes[8],
      bytes[9],
      bytes[10],
      bytes[11]
    );
    if (brand === "avif" || brand === "avis") return "image/avif";
    if (brand === "heic" || brand === "heix") return "image/heic";
    if (brand === "mif1" || brand === "msf1") return "image/heif";
  }
  return null;
}
var HTML_PATTERN = /^\s*(<!doctype\s+html|<html[\s>]|<[a-z][\w-]*[^>]*>)/i;
var SVG_PATTERN = /^\s*<svg[\s>]/i;
var CSS_PATTERN = /^\s*(@charset|@import|@media|@keyframes|[.#][\w-]+\s*\{)/;
function sniffString(s) {
  if (HTML_PATTERN.test(s)) return "text/html; charset=utf-8";
  if (SVG_PATTERN.test(s)) return "image/svg+xml";
  if (CSS_PATTERN.test(s)) return "text/css; charset=utf-8";
  return "text/plain; charset=utf-8";
}
function detectContentType(input, req) {
  if (Buffer.isBuffer(input)) {
    return sniffImageMagicBytes(input) ?? resolveOctetFallback(req);
  }
  if (input instanceof Uint8Array) {
    return sniffImageMagicBytes(input) ?? resolveOctetFallback(req);
  }
  if (input instanceof ArrayBuffer) {
    return sniffImageMagicBytes(new Uint8Array(input)) ?? resolveOctetFallback(req);
  }
  if (typeof input === "string") {
    return sniffString(input);
  }
  if (input !== null && typeof input === "object") {
    return "application/json";
  }
  return resolveOctetFallback(req);
}
function resolveOctetFallback(req) {
  if (req) {
    const ct = req.headers["content-type"];
    if (ct) return ct;
  }
  return "application/octet-stream";
}

// src/utils/stream.ts
function safeWrite(readable, writable, chunk) {
  if (!writable.write(chunk)) {
    readable?.pause();
    writable.once("drain", () => readable?.resume());
  }
}

// src/utils/validation.ts
function validateStatus(code) {
  if (!Number.isInteger(code) || !Number.isFinite(code)) {
    return {
      error: new TypeError(
        `Status code must be a finite integer, got: ${code}`
      )
    };
  }
  if (code < 100 || code > 999) {
    return {
      error: new RangeError(
        `Status code must be between 100 and 999, got: ${code}`
      )
    };
  }
  return {};
}
function validateJson(input) {
  if (typeof input === "function" || typeof input === "undefined") {
    return {
      error: new TypeError(
        `Value of type "${typeof input}" is not JSON serializable`
      )
    };
  }
  try {
    const data = JSON.stringify(input);
    if (data === void 0) {
      return {
        error: new TypeError(
          `Value of type "${typeof input}" is not JSON serializable`
        )
      };
    }
    return { data };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { error: new TypeError(`JSON serialization failed: ${message}`) };
  }
}

// src/Arcara.ts
var TIMEOUT_MS = 3e4;
var proto = http.ServerResponse.prototype;
function stringifyError(error) {
  try {
    return JSON.stringify({ error: error.message });
  } catch {
    return '{"error":"Internal Server Error"}';
  }
}
proto.status = function(code) {
  const { error } = validateStatus(code);
  if (error) throw error;
  this.statusCode = code;
  return this;
};
proto.json = function(input) {
  if (this.writableEnded) return this;
  this.setHeader("content-type", "application/json; charset=utf-8");
  if (input === void 0) return this.end();
  const { data, error } = validateJson(input);
  if (error) {
    logger.error(error);
    safeWrite(this.req, this, stringifyError(error));
    return this.end();
  }
  safeWrite(this.req, this, data);
  return this.end();
};
proto.send = function(input) {
  if (input === void 0 || this.writableEnded) return this;
  if (!this.getHeader("content-type")) {
    this.setHeader("content-type", detectContentType(input, this.req));
  }
  const body = input instanceof ArrayBuffer ? Buffer.from(input) : input instanceof Uint8Array ? Buffer.from(input.buffer, input.byteOffset, input.byteLength) : typeof input === "string" || Buffer.isBuffer(input) ? input : JSON.stringify(input);
  this.setHeader("content-length", Buffer.byteLength(body));
  if (this.req.method === "HEAD") return this.end();
  safeWrite(this.req, this, body);
  return this.end();
};
var Arcara = class extends Layer {
  server;
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
  parseBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      const LIMIT = 1024 * 1024;
      let resolved = false;
      const cleanup = () => {
        req.removeListener("data", onData);
        req.removeListener("end", onEnd);
        req.removeListener("error", onError);
        req.removeListener("close", onClose);
      };
      const onData = (chunk) => {
        size += chunk.byteLength;
        if (size > LIMIT) {
          resolved = true;
          req.pause();
          cleanup();
          return reject(new ArcaraError(413, "Payload Too Large"));
        }
        chunks.push(chunk);
      };
      const onEnd = () => {
        if (resolved) return;
        resolved = true;
        cleanup();
        const raw = Buffer.concat(chunks);
        const contentType = req.headers["content-type"] ?? "";
        try {
          if (contentType.includes("application/json")) {
            req.body = JSON.parse(raw.toString("utf-8"));
          } else if (contentType.includes("application/x-www-form-urlencoded")) {
            req.body = Object.fromEntries(
              new URLSearchParams(raw.toString("utf-8"))
            );
          } else if (contentType.startsWith("text/")) {
            req.body = raw.toString("utf-8");
          } else {
            req.body = raw;
          }
        } catch {
          return reject(new ArcaraError(400, "Invalid Request Body"));
        }
        resolve();
      };
      const onError = (err) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        reject(new ArcaraError(400, "Request Error", err));
      };
      const onClose = () => {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve();
      };
      req.on("data", onData);
      req.on("end", onEnd);
      req.on("error", onError);
      req.on("close", onClose);
    });
  }
  // ── Request info extraction ─────────────────────────────────────────────────
  /**
   * Extracts method, pathname, and query from the raw IncomingMessage.
   * Uses the URL constructor for correct parsing of encoded paths and
   * query strings. Falls back to '/' if req.url is missing or malformed.
   */
  extractRequestInfo(req) {
    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`
    );
    return {
      method: (req.method ?? "GET").toUpperCase(),
      pathname: url.pathname,
      query: Object.fromEntries(url.searchParams)
    };
  }
  // ── Request lifecycle ───────────────────────────────────────────────────────
  async handleRequest(req, res) {
    const startTime = Date.now();
    const { method, pathname, query } = this.extractRequestInfo(req);
    req.params = {};
    req.query = query;
    const timeout = setTimeout(() => {
      if (!res.writableEnded) {
        res.statusCode = 408;
        res.end(JSON.stringify({ error: "Request Timeout" }));
      }
    }, TIMEOUT_MS);
    res.once("finish", () => {
      req.destroy();
      clearTimeout(timeout);
      logger.request(method, pathname, res.statusCode, Date.now() - startTime);
    });
    try {
      if (method === "OPTIONS") {
        await this.dispatch(pathname, req, res);
        if (!res.writableEnded) {
          const allowed = this.collectAllowedMethods(pathname);
          allowed.add("OPTIONS");
          res.writeHead(204, { Allow: [...allowed].join(", ") });
          res.end();
        }
        return;
      }
      if (method === "POST" || method === "PUT" || method === "PATCH") {
        await this.parseBody(req);
      }
      await this.dispatch(pathname, req, res);
    } catch (e) {
      if (!res.writableEnded) {
        res.statusCode = e instanceof ArcaraError ? e.status : 500;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "Internal Server Error" }));
      }
    }
  }
  listen(port, hostOrCallback, maybeCallback) {
    let host = "0.0.0.0";
    let callback;
    if (typeof hostOrCallback === "string") {
      host = hostOrCallback;
      callback = maybeCallback;
    } else if (typeof hostOrCallback === "function") {
      callback = hostOrCallback;
    }
    this.server.listen(port, host, () => {
      logger.start(host, port);
      callback?.();
    });
    return this;
  }
};

// src/Router.ts
var Router = class extends Layer {
};
export {
  Arcara,
  ArcaraError,
  Router
};
