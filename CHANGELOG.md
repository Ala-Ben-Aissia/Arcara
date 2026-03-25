# Changelog

All notable changes to Arcara will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Arcara uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — 2026-03-23

### Added

- Core type definitions, `HttpMethod`, `ExtractParams`,
  `RouteHandler`, `Route`, `Middleware`, `StoredMiddleware`, `StoredChild`,
  `ErrorHandler`, `ArcaraError`
- `Dispatchable` interface to break the `Layer` → `types` circular dependency
- `node:http` module augmentation for `params`, `query`, `body` on
  `IncomingMessage` and `res.status` / `res.json` / `res.send` on
  `ServerResponse`
- `logger` with colored terminal output: per-method colors for requests,
  server start message, and recursive cause chain display for errors
  (including `ArcaraError` status code in the error name)
- `compilePath` converts a path pattern string into a `RegExp` and an
  ordered list of param names. Trailing slashes are matched optionally
  and regex special characters are escaped. Accepts a `prefix` flag that
  switches the terminator from `\/?$` to `(?:\/.*)?$`, enabling correct
  sub-path matching when compiling child router mount points
- `matchRoute` iterates the route table and returns a discriminated union:
  - `success: true` → matched route + extracted params object
  - `success: false` → code `404` (path not found) or `405` (path matched,
    method did not), so callers can return the correct HTTP status
- `detectContentType` inspects response values without relying on caller
  hints: magic byte sniffing for binary data (JPEG, PNG, GIF, WEBP, BMP,
  TIFF, AVIF, HEIC, HEIF), HTML/SVG/CSS pattern matching for strings,
  `application/json` for objects, and request `Content-Type` fallback for
  unrecognized binary
- `validateStatus` rejects non-integer and out-of-range (`< 100` or `> 999`)
  status codes, returning `{ error }` so callers decide whether to throw
- `validateJson` catches functions, BigInts, symbols, and circular references
  before they reach `JSON.stringify`, returning `{ data }` on success or
  `{ error }` on failure — never throws
- `safeWrite` respects Node.js stream backpressure: pauses the readable if
  the writable buffer is full and resumes on drain. Readable is nullable
  for contexts without a paired incoming stream
- `abstract Layer`: shared base for `Router` and `Arcara` providing:
  - type-safe route registration (`get`, `post`, `put`, `patch`, `delete`)
    with `ExtractParams` inference and method-narrowed `body` typing
  - middleware mounting (`use(handler)` / `use(prefix, handler)`)
  - child router mounting (`use(prefix, router)`) with prefix param extraction
  - recursive `dispatch`: runs middlewares, matches own routes, recurses into
    children, throws `404`/`405` with correct distinction
  - `runStack` with double-`next()` detection
  - `onError` for scoped error handlers — innermost layer that defines one
    handles errors in its subtree
  - `collectAllowedMethods` for full recursive `OPTIONS` support
  - default error handler writes raw `statusCode` + JSON without using proto
    methods, safe as a last line of defense
- `Router`: concrete `Layer` subclass with no additional logic, used to
  create mountable sub-applications
- `Arcara`: extends `Layer` with:
  - `ServerResponse` prototype augmentation: `res.status` (throws on invalid
    code), `res.json` (validates serializability, writes via `safeWrite`),
    `res.send` (auto-detects content type, sets `Content-Length`, respects
    `HEAD`)
  - stream-based body parsing with 1MB limit enforced via `req.pause()` on
    overflow; listener cleanup via explicit `removeListener` prevents leaks;
    client disconnect resolves silently
  - `OPTIONS` handling via `collectAllowedMethods` — responds `204` with
    `Allow` header
  - single `res.once('finish')` listener for socket cleanup and request
    logging across all exit paths
  - last-resort catch bypasses all proto methods to avoid throw cascade
  - `listen(port, host, callback)` — defaults to `0.0.0.0`
  - Request timeout (30s default) with proper cleanup to prevent hanging connections
- `src/index.ts`: single entry point re-exporting Arcara (default),
  Router, ArcaraError, and all public types. No logic lives here.
- `src/playground/app.ts`: local sandbox exercising the full feature
  set — root routes, mounted routers, nested params, middleware,
  body parsing, and scoped error handlers. Excluded from tsconfig
  build output. Run with: npm run play

### Repository structure, license, and tooling configuration

- Repository structure, `LICENSE` (MIT), and tooling configuration
  (`tsconfig.json`, `.gitignore`, `package.json`)
