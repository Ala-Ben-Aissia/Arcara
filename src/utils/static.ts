import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Middleware } from '../types.js';
import { detectContentType } from './content.js';

export interface ServeStaticOptions {
  // prefix?: string;
  index?: string;
}

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

// LRU-capped sniff cache keyed by path+mtime+size
const SNIFF_CACHE_MAX = 500;
const sniffCache = new Map<string, string>();

function sniffCacheSet(key: string, value: string): void {
  if (sniffCache.size >= SNIFF_CACHE_MAX) {
    // Map preserves insertion order — evict oldest entry
    const oldest = sniffCache.keys().next().value;
    if (oldest !== undefined) sniffCache.delete(oldest);
  }
  sniffCache.set(key, value);
}

export function serveStatic(
  root: string,
  opts: ServeStaticOptions = {},
): Middleware {
  const absRoot = resolve(root);
  const indexName = opts.index ?? 'index.html';

  return async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();

    const rawPath = decodeURIComponent(req.url?.split('?')[0] ?? '/');
    let pathname = rawPath;

    // if (opts.prefix) {
    //   if (!pathname.startsWith(opts.prefix)) return next();
    //   pathname = pathname.slice(opts.prefix.length);
    //   if (!pathname.startsWith('/')) pathname = '/' + pathname;
    // }

    const safePath = normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, '');
    let absPath = join(absRoot, safePath);

    // Prevent directory traversal
    const resolved = resolve(absPath);
    if (!(resolved === absRoot || resolved.startsWith(absRoot + sep))) {
      return next();
    }

    // Resolve file (handle directories → index.html)
    let st: fsp.FileHandle extends never
      ? never
      : Awaited<ReturnType<typeof fsp.stat>>;
    try {
      st = await fsp.stat(resolved);
      if (st.isDirectory()) {
        const idx = join(resolved, indexName);
        st = await fsp.stat(idx);
        absPath = idx;
      } else {
        absPath = resolved;
      }
      if (!st.isFile()) return next();
    } catch {
      return next();
    }

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
          const slice = buf.subarray(0, bytesRead);
          contentType =
            detectContentType(slice, req) ?? 'application/octet-stream';
          sniffCacheSet(cacheKey, contentType);
        } finally {
          await fd.close();
        }
      }
    }

    // ETag and conditional GET support
    const etag = `"${st.mtimeMs.toString(16)}-${st.size.toString(16)}"`;
    const lastModified = new Date(st.mtimeMs).toUTCString();

    res.setHeader('ETag', etag);
    res.setHeader('Last-Modified', lastModified);

    const ifNoneMatch = req.headers['if-none-match'];
    const ifModifiedSince = req.headers['if-modified-since'];

    if (
      (ifNoneMatch && ifNoneMatch === etag) ||
      (!ifNoneMatch &&
        ifModifiedSince &&
        new Date(ifModifiedSince) >= new Date(st.mtimeMs))
    ) {
      res.statusCode = 304;
      res.end();
      return;
    }

    const isHtml =
      (contentType ?? '').startsWith('text/html') || ext === '.html';

    res.setHeader('Content-Type', contentType ?? 'application/octet-stream');
    res.setHeader('Content-Length', String(st.size));
    res.setHeader(
      'Cache-Control',
      isHtml
        ? 'no-cache, must-revalidate'
        : 'public, max-age=31536000, immutable',
    );

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    const stream = fs.createReadStream(absPath);
    try {
      await pipeline(stream, res);
    } catch (err) {
      // Headers already flushed — partial body written, can't send a 500.
      // Destroy the socket to signal the client something went wrong.
      if (res.headersSent) {
        res.destroy(err as Error);
        return;
      }
      return next(err);
    }
  };
}
