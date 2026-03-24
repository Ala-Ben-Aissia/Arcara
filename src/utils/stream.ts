import type { Readable, Writable } from 'node:stream';

/**
 * Writes a single chunk to a writable stream with backpressure awareness.
 *
 * If writable.write() returns false, the writable's internal buffer is full —
 * typically because the client is consuming the response slower than we're
 * producing it. Pausing the readable (req) prevents further data from
 * accumulating in the Node.js process memory until the writable drains.
 *
 * For single-chunk responses this fires rarely, but under slow clients or
 * large response bodies it prevents unbounded memory growth across concurrent
 * connections.
 *
 * The readable is resumed exactly once via a one-time 'drain' listener —
 * no risk of double-resume or listener leak.
 *
 * ## Caller contract — end() responsibility
 *
 * `safeWrite` writes the chunk only. The caller is responsible for calling
 * `writable.end()` after `safeWrite` returns, regardless of whether
 * backpressure was triggered.
 *
 * This is safe for `http.ServerResponse` because Node's HTTP implementation
 * internally queues `end()` after any buffered writes flush — calling
 * `end()` synchronously after a write that returned `false` does not
 * truncate the response. The drain event fires, the buffer flushes, and the
 * already-queued `end()` closes the response in order.
 *
 * Do not move `end()` into the drain callback — that would prevent callers
 * from chaining further writes before closing, and would make the API
 * asymmetric between the backpressure and non-backpressure paths.
 */
export function safeWrite(
  readable: Readable | null,
  writable: Writable,
  chunk: unknown,
): void {
  if (!writable.write(chunk)) {
    readable?.pause();
    writable.once('drain', () => readable?.resume());
  }
}
