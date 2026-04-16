import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RedirectStatus } from '../types.js';

export const VALID_STATUS = new Set([
  301, 302, 303, 307, 308,
]) satisfies Set<RedirectStatus>;

export function isSafeTarget(target: string) {
  // Allow absolute paths only — blocks open redirect to external URLs.
  // Also rejects protocol-relative URLs like //evil.com.
  return target.startsWith('/') && !target.startsWith('//');
}

export function applyRedirect(
  res: ServerResponse,
  statusOrTarget: RedirectStatus | string,
  maybeTarget?: string,
) {
  const [status, target] =
    typeof statusOrTarget === 'number'
      ? [statusOrTarget, maybeTarget!]
      : [302, statusOrTarget];
  if (!VALID_STATUS.has(status as RedirectStatus)) {
    res.statusCode = 400;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(
      JSON.stringify({
        error: `Invalid redirect status: ${status}. Expected one of: ${[...VALID_STATUS].join(', ')}.`,
      }),
    );
    return;
  }

  if (!isSafeTarget(target)) {
    res.statusCode = 400;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(
      JSON.stringify({
        error: 'Unsafe redirect target: only absolute paths are allowed.',
        target,
      }),
    );
    return;
  }

  res.setHeader('Location', target);
  res.statusCode = status;
  res.end();
}

export function redirectBack(
  req: IncomingMessage,
  res: ServerResponse,
  fallback: string,
): void {
  // Validate the fallback up front — it's caller-controlled and must be safe
  // regardless of what the Referer resolves to.
  if (!isSafeTarget(fallback)) {
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(
      JSON.stringify({
        error:
          'Invalid fallback for redirect.back: only absolute paths are allowed.',
        fallback,
      }),
    );
    return;
  }

  const referer = req.headers.referer ?? '';
  const host = req.headers.host ?? '';

  // Only follow the Referer if it's same-origin — blocks open redirect via a
  // manipulated Referer header. An empty host falls through to fallback.
  // Match with a trailing slash or exact host to prevent prefix attacks:
  // e.g. host=example.com must NOT match referer=https://example.com.evil.com/
  const isSameOrigin =
    host.length > 0 &&
    (referer.startsWith(`http://${host}/`) ||
      referer.startsWith(`https://${host}/`) ||
      referer === `http://${host}` ||
      referer === `https://${host}`);

  // Extract only the pathname — never forward query/hash into Location,
  // and never emit a full URL even for same-origin Referers.
  let target = fallback;
  if (isSameOrigin) {
    try {
      target = new URL(referer).pathname;
    } catch {
      target = fallback;
    }
  }

  applyRedirect(res, 302, target);
}
