import { Layer } from './Layer.js';

/**
 * A mountable sub-router that extends Layer with no additional logic.
 *
 * Router exists as a named export so mounted sub-trees are semantically
 * distinct from the root Arcara instance at the call site — both are Layers,
 * but the intent is explicit.
 *
 * @example
 * const api = new Router();
 *
 * api.onError((err, req, res) => { ... });
 *
 * api.get('/users/:id', (req, res) => {
 *   res.json({ id: req.params.id });
 * });
 *
 * app.use('/api', api);
 */
export class Router extends Layer {}
