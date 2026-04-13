# Changelog

All notable changes to Arcara will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Arcara uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] - 2026-04-14

### Added

- Added redirect api: `res.redirect` and `res.redirect.back`
- Added fully configurable `cache` option to `serveStatic` with safe defaults
  - Supports `maxAge`, `immutable`, and `public` directives
  - Allows disabling caching via `cache: false`
- Introduced smart caching defaults:
  - HTML files → `no-cache, must-revalidate`
  - Static assets → `public, max-age=31536000, immutable`

## [0.3.0] - 2026-04-12

### Added

- **Subpath exports** — optional utilities are now available as named subpath
  imports. Each is tree-shakeable and zero-dependency.
  - `arcara/cors` — CORS middleware with dynamic origin, preflight handling,
    and `Vary` header management.
  - `arcara/cookies` — Cookie parser with `req.cookies`, `res.setCookie()`,
    and `res.clearCookie()`.
  - `arcara/rate-limit` — Fixed-window rate limiter with `X-RateLimit-*`
    headers, configurable key extraction, and automatic store cleanup.
  - `arcara/logger` — Request logger with ANSI colors, configurable `write`
    function, `timestamp` toggle, and `skip` predicate.
- `startupLog` option on `ArcaraOptions` — set to `false` to suppress the
  server startup message. Defaults to `true`.

### Changed

- `ArcaraRequest` is now an intersection type (`IncomingMessage & { ... }`)
  rather than an interface extension — eliminates index signature compatibility
  noise and makes the `[k: string]: any` escape hatch explicit and documented.
- `ArcaraResponse` is now a pure type alias for `ServerResponse`. All helper
  methods (`status`, `json`, `send`, `setCookie`, `clearCookie`) live on the
  `ServerResponse` augmentation and are visible to raw Node middleware without
  any imports.
- `req.body` is now typed as `unknown` instead of `any` for POST/PUT/PATCH —
  consumers must narrow before use (e.g. with zod or valibot).
- Internal request logging removed from the core dispatch path. Use
  `arcara/logger` middleware for request logging.

### Fixed

- Removed hardcoded `/.well-known/appspecific/com.chrome.devtools.json` filter
  from internal logger. Use the `skip` option on `arcara/logger` instead.

## [0.2.0] - 2026-04-10

### Fixed

- **Critical:** Moved `@types/node` from `dependencies` to `peerDependencies` to prevent type conflicts in consumer projects. Install `@types/node` matching your Node.js version.
- Declared `sideEffects` for core entry points to prevent bundlers from tree-shaking the `ServerResponse` prototype augmentation — fixes runtime errors where `res.json()` and `res.send()` would be undefined in aggressively optimized builds.
- Added missing `tsx` to `devDependencies`, fixing test execution in clean environments and CI.

### Changed

- Removed redundant `typesVersions` field from `package.json` — type resolution is fully handled by the `exports` map.
- Added `packageManager: "pnpm@10.x.x"` to enforce consistent package manager usage across environments.

## [0.1.9] - 2026-04-07

### Changed

- `serveStatic` no longer accepts a `prefix` option. Use `app.use('/prefix', serveStatic('./dir'))` instead — prefix stripping is now handled consistently by the router.

## [0.1.8] - 2026-04-07

### Added

- `serveStatic(root, options)` middleware for serving static assets: safe path resolution, `index.html` fallback, `HEAD` support, streaming with backpressure handling, and extension + magic-byte MIME detection.

### Fixed

- Streaming lifecycle bugs that could produce `HPE_INVALID_CONSTANT` parser errors or header-after-end races — resolved by awaiting `pipeline()` and handling errors synchronously.
- Improved content-type detection for unknown extensions and text snippets (HTML/SVG/CSS) to avoid incorrect `text/plain` responses.

## [0.1.1] - 2026-04-06

### Fixed

- Improved HTML detection to support partial HTML fragments, not just full documents.

## [0.1.0] - 2026-03-23

### Added

- Initial release of Arcara — a TypeScript-first, zero-runtime-dependency Node.js HTTP framework.
- Radix-tree router with compile-time param inference from path strings.
- Middleware system with global and prefix-scoped handlers.
- Automatic body parsing for JSON, URL-encoded, text, and binary payloads.
- Centralized error handling via `app.onError()`, scoped per router.
- `HttpError` with optional structured `details` payload.
- `serveStatic` middleware with ETag, `Last-Modified`, and `304` support.
- `Router` class for modular, mountable route definitions.
- Graceful shutdown via `app.close()`.
