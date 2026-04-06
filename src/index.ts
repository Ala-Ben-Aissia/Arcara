/**
 * Arcara — A TypeScript-native, zero-dependency Node.js HTTP framework.
 *
 * @example
 * ```ts
 * import { Arcara, HttpError } from 'arcara';
 *
 * const app = new Arcara();
 *
 * app.use((req, _res, next) => {
 *   console.log(req.method, req.url);
 *   next();
 * });
 *
 * app.get('/users/:id', (req, res) => {
 *   res.json({ id: req.params.id });
 * });
 *
 * app.onError((err, _req, res) => {
 *   res.status(err.status).json({ error: err.message });
 * });
 *
 * app.listen(3000);
 * ```
 *
 * @module arcara
 */

// ── Core ──────────────────────────────────────────────────────────────────────

export { Arcara } from './Arcara.js';
export { Layer } from './Layer.js';
export { Router } from './Router.js';

// ── Types (public API surface) + Errors ────────────────────────────────────────────────

export {
  // HTTP
  type HttpMethod,

  // Request / Response context
  type ArcaraRequest,
  type ArcaraResponse,

  // Middleware
  type NextFn,
  type Middleware,
  type RouteHandler,
  type ErrorHandler,

  // Configuration
  type ArcaraOptions,
  // Error
  HttpError,
} from './types.js';

// ── Not exported (intentionally internal) ─────────────────────────────────────
// Route, StoredMiddleware, StoredChild, Dispatchable,
// ExtractParams — used internally only; not part of the public contract.
