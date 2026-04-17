import type { Middleware } from '../types.js';

export interface CorsOptions {
  origin?: string | string[] | ((origin: string) => boolean);
  methods?: string[];
  allowedHeaders?: string[];
  exposedHeaders?: string[];
  credentials?: boolean;
  maxAge?: number;
}

const DEFAULT_METHODS = ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE'];

function resolveOrigin(
  allowed: CorsOptions['origin'],
  requestOrigin: string,
): string | null {
  if (!allowed || allowed === '*') return '*';
  if (typeof allowed === 'string')
    return allowed === requestOrigin ? allowed : null;
  if (Array.isArray(allowed))
    return allowed.includes(requestOrigin) ? requestOrigin : null;
  if (typeof allowed === 'function')
    return allowed(requestOrigin) ? requestOrigin : null;
  return null;
}

export function cors(options: CorsOptions = {}): Middleware {
  const {
    origin = '*',
    methods = DEFAULT_METHODS,
    allowedHeaders = ['Content-Type', 'Authorization'],
    exposedHeaders = [],
    credentials = false,
    maxAge,
  } = options;

  // Fail fast: credentials:true with a wildcard origin is rejected by browsers
  // per the Fetch spec — Access-Control-Allow-Credentials cannot be "true" when
  // Access-Control-Allow-Origin is "*". Catching this at setup time prevents a
  // silent misconfiguration that only surfaces as a browser CORS error at runtime.
  if (credentials && (origin === '*' || origin == null)) {
    throw new Error(
      'Invalid configuration: credentials:true requires an explicit origin, not "*". ' +
        'Set origin to a specific URL, array, or predicate function.',
    );
  }

  return (req, res, next) => {
    const requestOrigin = req.headers.origin ?? '';
    const resolvedOrigin = resolveOrigin(origin, requestOrigin);

    if (!resolvedOrigin) return next();

    res.setHeader('Access-Control-Allow-Origin', resolvedOrigin);
    res.setHeader('Access-Control-Allow-Methods', methods.join(', '));
    res.setHeader('Access-Control-Allow-Headers', allowedHeaders.join(', '));

    if (exposedHeaders.length) {
      res.setHeader('Access-Control-Expose-Headers', exposedHeaders.join(', '));
    }
    if (credentials) {
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    if (maxAge !== undefined) {
      res.setHeader('Access-Control-Max-Age', String(maxAge));
    }

    // Vary: Origin must be set whenever the response differs by origin —
    // i.e. any non-wildcard config, and always when credentials are used.
    // Without this, a shared cache can serve the wrong ACAO header to a
    // different origin, breaking CORS for subsequent requestors.
    if (resolvedOrigin !== '*') {
      res.setHeader('Vary', 'Origin');
    }

    // OPTIONS termination and Allow header is handled by Arcara.handleRequest
    if (req.method === 'OPTIONS') return;

    next();
  };
}
