/// <reference types="node" />
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
export { Arcara } from './Arcara.js';
export { Router } from './Router.js';
export { HttpError, type ArcaraOptions, type ArcaraRequest, type ArcaraResponse, type ErrorHandler, type HttpMethod, type Middleware, type NextFn, type RouteHandler, } from './types.js';
