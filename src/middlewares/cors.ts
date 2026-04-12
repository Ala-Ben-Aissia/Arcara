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
    if (resolvedOrigin !== '*') {
      res.setHeader('Vary', 'Origin');
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    next();
  };
}
