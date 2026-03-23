# Changelog

All notable changes to Arcara will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Arcara uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `Logger` with colored terminal output (request, start, error with recursive
  cause chain and ArcaraError status display)
- `compilePath` converts a path pattern string into a RegExp and an
  ordered list of param names. Trailing slashes are matched optionally,
  and regex special characters are escaped.
- `matchRoute` iterates the route table and returns a discriminated union:
  - success: true → matched route + extracted params object
  - success: false → code 404 (path not found) or 405 (path matched,
    method did not) so callers can return the correct HTTP status
- `detectContentType` with magic byte sniffing for images (JPEG, PNG, GIF,
  WEBP, BMP, TIFF, AVIF, HEIC, HEIF), HTML/SVG/CSS pattern detection for
  strings, and JSON detection for objects. Falls back to request
  Content-Type for binary data when available.

## [0.1.0] — 2026-03-23

### Added

- Core type definitions: BodyPayload, HttpMethod, ExtractParams,
  RouteHandler, Route, Middleware, StoredMiddleware, StoredChild,
  ErrorHandler, ArcaraError
- Dispatchable interface to break the Layer → types circular dependency
- node:http module augmentation for params, query, body, and
  res.status / res.json / res.send
- Repository structure, license, and tooling configuration
