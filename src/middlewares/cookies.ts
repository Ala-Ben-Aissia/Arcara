import type { Middleware } from '../types.js';

export type SameSite = 'Strict' | 'Lax' | 'None';

export interface CookieOptions {
  maxAge?: number;
  expires?: Date;
  path?: string;
  domain?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: SameSite;
}

function parseCookieHeader(header: string): Record<string, string> {
  return Object.fromEntries(
    header.split(';').flatMap((pair) => {
      const eq = pair.indexOf('=');
      if (eq === -1) return [];
      const key = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      return key ? [[key, decodeURIComponent(value)]] : [];
    }),
  );
}

function serializeCookie(
  name: string,
  value: string,
  options: CookieOptions = {},
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];

  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  if (options.path ?? true) parts.push(`Path=${options.path ?? '/'}`);
  if (options.domain) parts.push(`Domain=${options.domain}`);
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);

  return parts.join('; ');
}

/**
 * Parses Cookie header into req.cookies.
 * Attaches res.setCookie() and res.clearCookie() helpers.
 */
export function cookies(): Middleware {
  return (req, res, next) => {
    const header = req.headers.cookie ?? '';
    req.cookies = header ? parseCookieHeader(header) : {};

    res.setCookie = (name, value, options = {}) => {
      const existing =
        (res.getHeader('Set-Cookie') as string[] | string | undefined) ?? [];
      const prev = Array.isArray(existing) ? existing : [existing];
      res.setHeader('Set-Cookie', [
        ...prev,
        serializeCookie(name, value, options),
      ]);
      return res;
    };

    res.clearCookie = (name, options = {}) => {
      return res.setCookie(name, '', { ...options, maxAge: 0 });
    };

    next();
  };
}
