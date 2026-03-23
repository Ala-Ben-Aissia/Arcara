# Changelog

All notable changes to Arcara will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Arcara uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- logger with colored terminal output (request, start, error with recursive
  cause chain and ArcaraError status display)

## [0.1.0] — 2026-03-23

### Added

- Core type definitions: BodyPayload, HttpMethod, ExtractParams,
  RouteHandler, Route, Middleware, StoredMiddleware, StoredChild,
  ErrorHandler, ArcaraError
- Dispatchable interface to break the Layer → types circular dependency
- node:http module augmentation for params, query, body, and
  res.status / res.json / res.send
- Repository structure, license, and tooling configuration
