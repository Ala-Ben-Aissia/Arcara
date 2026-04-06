import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Writes `body` to `res` only if the socket is still writable.
 *
 * Guards against three failure modes:
 * 1. `writableEnded` — response already ended (e.g. double-send bug)
 * 2. `destroyed`     — socket was destroyed (client disconnect mid-response)
 * 3. `!socket`       — no underlying socket (e.g. unit test mock without socket)
 *
 * Failures are silent — if the socket is gone there is nothing to respond
 * to, and logging here would duplicate the error already captured upstream.
 *
 * @param req  - The originating request (used to check socket liveness)
 * @param res  - The server response to write to
 * @param body - The serialized body chunk (string or Buffer)
 */
export function safeWrite(
  req: IncomingMessage,
  res: ServerResponse,
  body: string | Buffer,
): void {
  if (res.writableEnded) return;
  if (res.destroyed) return;
  if (!req.socket || req.socket.destroyed) return;

  res.write(body);
}
