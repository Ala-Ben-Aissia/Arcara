import http from 'node:http';

/**
 * Supported HTTP methods as a literal union.
 * Using a literal union (not string) means method comparisons
 * are checked by TypeScript at compile time.
 */
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
/**
 * Recursively extracts named parameter segments from a path string
 * at the type level.
 *
 * @example
 * ExtractParams<'/orgs/:orgId/users/:userId'>
 * // → 'orgId' | 'userId'
 *
 * ExtractParams<'/users'>
 * // → never
 */
type ExtractParams<Path extends string> = Path extends `${string}:${infer Param}/${infer Rest}` ? Param | ExtractParams<`/${Rest}`> : Path extends `${string}:${infer Param}` ? Param : never;
/**
 * The signature for route handlers and middleware.
 *
 * Two type-level constraints are enforced:
 *
 * 1. Params — if the route pattern has no params (Params = never),
 *    req.params is typed as never, preventing accidental access.
 *    Otherwise it is Record<Params, string>.
 *
 * 2. Method — GET and DELETE handlers receive body: never,
 *    preventing accidental body access on bodyless methods.
 *    All other methods receive body: any.
 */
type RouteHandler<Params extends string = never, Method extends HttpMethod = HttpMethod> = (req: http.IncomingMessage & ([Params] extends [never] ? {
    params: never;
} : {
    params: Record<Params, string>;
}) & ([Method] extends ['GET' | 'HEAD' | 'DELETE'] ? {
    body: never;
} : {
    body: any;
}), res: http.ServerResponse, next: () => void | Promise<void>) => void | Promise<void> | http.ServerResponse;
/**
 * The internal shape of a compiled route entry stored in Layer.routes.
 *
 * - pattern    the original path string e.g. '/users/:id'
 * - regex      compiled from pattern e.g. /^\/users\/([^/]+)\/?$/
 * - paramNames ordered list of param names extracted from pattern e.g. ['id']
 * - handlers   the handler chain registered for this route
 */
type Route = {
    method: HttpMethod;
    pattern: string;
    handlers: RouteHandler<any>[];
};
/**
 * A plain middleware function — no param or method constraints.
 * Used for cross-cutting concerns: logging, auth, CORS, etc.
 */
type Middleware = (req: http.IncomingMessage, res: http.ServerResponse, next: () => void | Promise<void>) => void | Promise<void> | http.ServerResponse;
/**
 * Internal shape of an entry in Layer.middlewares.
 * Prefix is normalized at registration time (trailing slashes stripped).
 */
type StoredMiddleware = {
    prefix: string;
    handler: Middleware;
};
interface Dispatchable {
    dispatch(pathname: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void>;
    collectAllowedMethods(pathname: string): Set<HttpMethod>;
}
/**
 * Internal shape of a mounted child layer (Router instance).
 * Stored in Layer.children when app.use('/prefix', router) is called.
 *
 * - prefix     normalized mount prefix e.g. '/api'
 * - regex      compiled from prefix to support param segments e.g. /orgs/:orgId
 * - paramNames params extracted from the prefix pattern
 * - layer      the mounted Layer instance
 */
type StoredChild = {
    prefix: string;
    regex: RegExp;
    paramNames: string[];
    layer: Dispatchable;
};
/**
 * The signature for scoped error handlers registered via onError().
 * Receives a fully normalized ArcaraError — never a raw unknown.
 */
type ErrorHandler = (err: ArcaraError, req: http.IncomingMessage, res: http.ServerResponse) => void;
/**
 * The framework's first-class error type.
 *
 * Carries an HTTP status code alongside the message, so error handlers
 * can make HTTP-aware decisions without inspecting message strings.
 *
 * The original cause is preserved for logging — when wrapping an unknown
 * thrown value, pass it as the third argument so logger.error can surface
 * the full chain.
 *
 * @example
 * throw new ArcaraError(404, 'User not found');
 * throw new ArcaraError(500, 'Database unreachable', originalError);
 */
declare class ArcaraError extends Error {
    readonly status: number;
    readonly cause?: unknown | undefined;
    constructor(status: number, message: string, cause?: unknown | undefined);
}
declare module 'node:http' {
    interface IncomingMessage {
        /** Parsed URL path parameters — populated by the router before handlers run. */
        params: Record<string, string>;
        /**
         * Parsed URL query string — populated from url.searchParams.
         *
         * **Repeated keys are not supported.** `?tag=a&tag=b` produces
         * `{ tag: 'b' }` — only the last value for a given key is kept.
         * This is a deliberate simplification for v0.x. If your API requires
         * multi-value query params, read `new URL(req.url).searchParams`
         * directly in your handler.
         */
        query: Record<string, string>;
        /** Parsed request body — populated by parseBody before handlers run. */
        body: any;
    }
    interface ServerResponse {
        /**
         * Sets the HTTP status code. Throws on invalid codes.
         * Returns `this` for chaining: res.status(201).json({ ... })
         */
        status(code: number): this;
        /**
         * Serializes input to JSON, sets Content-Type: application/json,
         * and ends the response.
         */
        json(input: unknown): this;
        /**
         * Sends any supported value with automatic Content-Type detection.
         * Handles strings, Buffers, Uint8Arrays, ArrayBuffers, and objects.
         */
        send(input: unknown): this;
    }
}

type MatchSuccess = {
    success: true;
    route: Route;
    params: Record<string, string>;
};
type MatchFailure = {
    success: false;
    code: 404 | 405;
    error: string;
};
type MatchResult = MatchSuccess | MatchFailure;
declare class RadixTree {
    private root;
    /**
     * Inserts a route into the prefix tree.
     * Compiles the path into segments and builds the necessary nodes.
     */
    insert(route: Route): void;
    /**
     * Traverses the tree to find a matching route.
     */
    lookup(pathname: string, method: HttpMethod): MatchResult;
    /**
     * Recursive search to support backtracking.
     * Tries static segments first, falls back to param segments if static hits a dead end.
     */
    private search;
    /**
     * Walks the tree to collect all registered methods for a path (used for OPTIONS).
     */
    collectAllowedMethods(pathname: string): Set<HttpMethod>;
}

declare abstract class Layer implements Dispatchable {
    protected routeTree: RadixTree;
    protected middlewares: StoredMiddleware[];
    protected children: StoredChild[];
    protected errorHandler: ErrorHandler;
    onError(handler: ErrorHandler): this;
    use(handler: Middleware): this;
    use(prefix: `/${string}`, handler: Middleware | Layer): this;
    get<Path extends string>(path: Path, ...handlers: RouteHandler<ExtractParams<Path>, 'GET'>[]): this;
    post<Path extends string>(path: Path, ...handlers: RouteHandler<ExtractParams<Path>, 'POST'>[]): this;
    put<Path extends string>(path: Path, ...handlers: RouteHandler<ExtractParams<Path>, 'PUT'>[]): this;
    patch<Path extends string>(path: Path, ...handlers: RouteHandler<ExtractParams<Path>, 'PATCH'>[]): this;
    delete<Path extends string>(path: Path, ...handlers: RouteHandler<ExtractParams<Path>, 'DELETE'>[]): this;
    /**
     * Recursively dispatches a request through this layer's middlewares,
     * routes, and mounted child layers.
     *
     * Called by Arcara.handleRequest at the root and by parent layers
     * on children during tree traversal.
     */
    dispatch(pathname: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void>;
    /**
     * Walks the full route tree to collect all HTTP methods registered for
     * a given pathname. Used by OPTIONS handling in Arcara.
     */
    collectAllowedMethods(pathname: string): Set<HttpMethod>;
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
    protected runStack(req: http.IncomingMessage, res: http.ServerResponse, stack: RouteHandler<any>[]): Promise<void>;
    /**
     * Normalizes any thrown value to ArcaraError, logs it, and delegates
     * to the active errorHandler.
     *
     * 404/405 are not logged — they are normal routing outcomes, not failures.
     * For 500s, logs the full ArcaraError (not just the cause) so status and
     * message are always visible alongside the cause chain.
     */
    protected handleError(e: unknown, req: http.IncomingMessage, res: http.ServerResponse): void;
    private pushRoute;
    /**
     * Returns true if pathname falls under the given prefix.
     * '/'      → matches everything (global middlewares)
     * '/api'   → matches '/api' and '/api/users' but not '/api-v2'
     */
    private matchesPrefix;
    /**
     * Strips trailing slashes. Preserves '/' for global middleware prefix.
     * '/api/v1/' → '/api/v1'
     * '/'        → '/'
     */
    private normalizePrefix;
}

declare class Arcara extends Layer {
    private readonly server;
    constructor();
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
    private parseBody;
    /**
     * Extracts method, pathname, and query from the raw IncomingMessage.
     * Uses the URL constructor for correct parsing of encoded paths and
     * query strings. Falls back to '/' if req.url is missing or malformed.
     */
    private extractRequestInfo;
    private handleRequest;
    /**
     * Starts listening on the given port.
     * Binds to all interfaces (`0.0.0.0`) by default.
     *
     * @example
     * app.listen(3000);
     */
    listen(port: number, callback?: () => void): this;
    /**
     * Starts listening on the given port and host.
     *
     * @example
     * app.listen(3000, 'localhost');
     */
    listen(port: number, host: string, callback?: () => void): this;
}

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
declare class Router extends Layer {
}

export { Arcara, ArcaraError, type ErrorHandler, type ExtractParams, type HttpMethod, type Middleware, type RouteHandler, Router };
