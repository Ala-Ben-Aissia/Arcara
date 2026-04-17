import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Middleware } from '../types.js';
import { detectContentType } from '../utils/content.js';

/**
 * Cache policy for static assets.
 *
 * - `false` — disables all caching (`Cache-Control: no-store`)
 * - `object` — fine-grained `Cache-Control` directive control
 *
 * @example
 * // Disable caching entirely
 * cache: false
 *
 * @example
 * // Long-lived immutable asset (e.g. content-hashed bundles)
 * cache: { maxAge: 31_536_000, immutable: true }
 *
 * @example
 * // Private, short-lived response
 * cache: { maxAge: 60, public: false }
 */
type CacheOption =
  | false
  | {
      /**
       * `max-age` directive in seconds.
       * - `0` emits `no-cache, must-revalidate` instead of `max-age=0`
       * - Defaults to `31_536_000` (1 year) for non-HTML assets, `0` for HTML
       */
      maxAge?: number;
      /**
       * Appends the `immutable` directive.
       * Signals to clients that the asset will never change at this URL —
       * ideal for content-hashed filenames. Has no effect when `maxAge` is 0.
       */
      immutable?: boolean;
      /**
       * Whether the response may be stored by shared caches (CDNs, proxies).
       * - `true` (default for non-HTML) → `public`
       * - `false` (default for HTML) → `private`
       */
      public?: boolean;
    };

/**
 * Configuration options for {@link serveStatic}.
 */
export interface ServeStaticOptions {
  /**
   * Filename to serve when the resolved path is a directory.
   * @default "index.html"
   */
  index?: string;
  /**
   * `Cache-Control` policy applied to served responses.
   *
   * Defaults to environment-appropriate heuristics when omitted:
   * - HTML files → `no-cache, must-revalidate` (always revalidated)
   * - All other assets → `public, max-age=31536000, immutable` (long-lived)
   *
   * Pass `false` to opt out of all caching (`no-store`).
   */
  cache?: CacheOption;
}

/**
 * MIME type map for common static asset extensions.
 * Used as the primary content-type resolution strategy before
 * falling back to magic-byte sniffing via {@link detectContentType}.
 */
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.pdf': 'application/pdf',
};

/** Maximum number of content-sniff results to retain in the LRU cache. */
const SNIFF_CACHE_MAX = 500;

/**
 * LRU cache mapping `"<absPath>:<mtimeMs>:<size>"` keys to resolved MIME types.
 *
 * The compound key ensures stale entries are never served after a file
 * is modified in-place (mtime or size change invalidates the key).
 *
 * Eviction uses Map insertion-order: the oldest entry is removed when
 * the cache reaches {@link SNIFF_CACHE_MAX}.
 */
const sniffCache = new Map<string, string>();

/**
 * Inserts a value into {@link sniffCache}, evicting the oldest entry
 * when the cache is at capacity (O(1) insertion-order eviction via Map).
 */
function sniffCacheSet(key: string, value: string): void {
  if (sniffCache.size >= SNIFF_CACHE_MAX) {
    const oldest = sniffCache.keys().next().value;
    if (oldest !== undefined) sniffCache.delete(oldest);
  }
  sniffCache.set(key, value);
}

/**
 * Middleware that efficiently serves static files from a local directory.
 *
 * ---
 *
 * ### Security
 * - Path traversal is prevented by resolving the absolute path and asserting
 *   it starts with the root prefix before any file I/O occurs.
 * - The index filename ({@link ServeStaticOptions.index}) is also validated
 *   against the root boundary.
 * - Only `GET` and `HEAD` requests are handled; all others are forwarded.
 *
 * ### Content-Type resolution (in priority order)
 * 1. Extension lookup against the built-in MIME map
 * 2. Magic-byte sniffing of the first 1 KB via `detectContentType`
 * 3. Fallback to `application/octet-stream`
 *
 * Sniff results are memoised in a 500-entry LRU cache keyed by
 * `path + mtime + size` to avoid repeated I/O on unchanged files.
 *
 * ### Conditional GET / caching
 * Every response includes `ETag` and `Last-Modified` headers.
 * The ETag is an mtime+size fingerprint (weak validator — not a content hash).
 * Conditional requests (`If-None-Match`, `If-Modified-Since`) are evaluated
 * and return `304 Not Modified` when the asset is unchanged, saving
 * bandwidth on repeat visits.
 *
 * ### Cache-Control defaults
 * | Asset type | Default policy |
 * |---|---|
 * | HTML | `no-cache, must-revalidate` |
 * | Everything else | `public, max-age=31536000, immutable` |
 *
 * Override via the `cache` option — see {@link ServeStaticOptions}.
 *
 * ### Streaming
 * File contents are piped to the response via `stream/promises.pipeline`,
 * which guarantees cleanup of the read stream on both success and error.
 * If the response has already started when an error occurs, the socket is
 * destroyed to avoid sending a corrupt partial response.
 *
 * ---
 *
 * @param root - Absolute or relative path to the directory to serve.
 *   Resolved against `process.cwd()` if relative.
 * @param opts - Optional cache and index configuration.
 * @returns An Arcara middleware function.
 *
 * @example
 * // Serve the `public/` directory with default settings
 * app.use(serveStatic('public'));
 *
 * @example
 * // SPA fallback: serve `dist/` with custom index
 * app.use(serveStatic('dist', { index: 'index.html' }));
 *
 * @example
 * // Disable caching during development
 * app.use(serveStatic('public', { cache: false }));
 *
 * @example
 * // Conservative policy: revalidate everything, keep private
 * app.use(serveStatic('public', {
 *   cache: { maxAge: 0, public: false },
 * }));
 */
export function serveStatic(
  root: string,
  opts: ServeStaticOptions = {},
): Middleware {
  const absRoot = resolve(root);
  const indexName = opts.index ?? 'index.html';

  return async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();

    const rawPath = decodeURIComponent(req.url?.split('?')[0] ?? '/');

    // Defense-in-depth: normalize collapses `..` sequences; the regex then
    // strips any residual leading `../` patterns before path joining.
    const safePath = normalize(rawPath).replace(/^(\.\.(\/|\\|$))+/, '');
    let absPath = join(absRoot, safePath);

    // Traversal guard: resolved path must be within the root boundary.
    const resolved = resolve(absPath);
    if (!(resolved === absRoot || resolved.startsWith(absRoot + sep))) {
      return next();
    }

    let st: Awaited<ReturnType<typeof fsp.stat>>;
    try {
      st = await fsp.stat(resolved);
      if (st.isDirectory()) {
        const idx = join(resolved, indexName);
        // Re-validate the index path — `opts.index` is caller-controlled.
        const resolvedIdx = resolve(idx);
        if (!resolvedIdx.startsWith(absRoot + sep)) return next();
        st = await fsp.stat(resolvedIdx);
        absPath = resolvedIdx;
      } else {
        absPath = resolved;
      }
      if (!st.isFile()) return next();
    } catch {
      return next();
    }

    // --- Content-Type ---

    const ext = extname(absPath).toLowerCase();
    let contentType = MIME_TYPES[ext];

    if (!contentType) {
      const cacheKey = `${absPath}:${st.mtimeMs}:${st.size}`;
      const cached = sniffCache.get(cacheKey);
      if (cached) {
        contentType = cached;
      } else {
        const fd = await fsp.open(absPath, 'r');
        try {
          const len = Math.min(1024, Number(st.size) || 1024);
          const buf = Buffer.alloc(len);
          const { bytesRead } = await fd.read(buf, 0, len, 0);
          contentType =
            detectContentType(buf.subarray(0, bytesRead), req) ??
            'application/octet-stream';
          sniffCacheSet(cacheKey, contentType);
        } finally {
          await fd.close();
        }
      }
    }

    // --- Conditional GET ---

    // ETag is an mtime+size fingerprint (weak validator, not a content hash).
    // RFC 7232 §2.3: sufficient for cache validation;
    const etag = `"${st.mtimeMs.toString(16)}-${st.size.toString(16)}"`;
    const lastModified = new Date(st.mtimeMs).toUTCString();

    res.setHeader('ETag', etag);
    res.setHeader('Last-Modified', lastModified);

    const ifNoneMatch = req.headers['if-none-match'];
    const ifModifiedSince = req.headers['if-modified-since'];

    // Floor mtime to 1-second resolution before comparing against the
    // HTTP-date in If-Modified-Since (HTTP-date has second granularity).
    const mtimeSec = Math.floor(st.mtimeMs / 1000) * 1000;

    if (
      (ifNoneMatch && ifNoneMatch === etag) ||
      (!ifNoneMatch &&
        ifModifiedSince &&
        new Date(ifModifiedSince) >= new Date(mtimeSec))
    ) {
      res.statusCode = 304;
      res.end();
      return;
    }

    // --- Cache-Control ---

    const isHtml =
      (contentType ?? '').startsWith('text/html') || ext === '.html';

    let cacheControl: string;

    if (opts.cache === false) {
      cacheControl = 'no-store';
    } else {
      const defaults = isHtml
        ? { maxAge: 0, public: false }
        : { maxAge: 31_536_000, immutable: true, public: true };

      const cfg =
        typeof opts.cache === 'object'
          ? { ...defaults, ...opts.cache }
          : defaults;

      if (cfg.maxAge === 0) {
        cacheControl = 'no-cache, must-revalidate';
      } else {
        cacheControl = [
          cfg.public === false ? 'private' : 'public',
          `max-age=${cfg.maxAge}`,
          cfg.immutable ? 'immutable' : '',
        ]
          .filter(Boolean)
          .join(', ');
      }
    }

    // --- Response headers ---

    res.setHeader('Cache-Control', cacheControl);
    res.setHeader('Content-Type', contentType ?? 'application/octet-stream');
    res.setHeader('Content-Length', String(st.size));

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    // --- Stream body ---

    const stream = fs.createReadStream(absPath);

    try {
      await pipeline(stream, res);
    } catch (err) {
      if (res.headersSent) {
        // Headers already flushed — can't send an error response.
        // Destroy the socket to avoid delivering a corrupt partial body.
        res.destroy(err as Error);
        return;
      }
      return next(err);
    }
  };
}
