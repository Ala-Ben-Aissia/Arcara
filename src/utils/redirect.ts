import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RedirectStatus } from '../types.js';

export const VALID_STATUS = new Set([
  301, 302, 303, 307, 308,
]) satisfies Set<RedirectStatus>;

export function isSafeTarget(target: string) {
  // Allow absolute paths only — blocks open redirect to external URLs
  if (target.startsWith('/') && !target.startsWith('//')) return true;
  return false;
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
    return res.json({
      error: `Invalid redirect status, Expected one of`,
    });
  }

  if (!isSafeTarget(target)) {
    return res.json({
      error: 'Unsafe redirect target, only absolute paths allowed',
      target,
    });
  }

  res.setHeader('Location', target);
  res.statusCode = status;
  res.end();
}

export function redirectBack(
  req: IncomingMessage,
  res: ServerResponse,
  fallback: string,
) {
  const referer = req.headers.referer ?? '';
  const host = req.headers.host ?? '';

  // Only follow referer if it's same-origin — blocks open redirect via Referer header
  const isSameOrigin =
    referer.startsWith(`http://${host}`) ||
    referer.startsWith(`https://${host}`);

  const target = isSameOrigin ? new URL(referer).pathname : fallback;
  applyRedirect(res, 302, target);
}
