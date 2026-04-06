import { HttpError } from '../types.js';

// ── Result types ──────────────────────────────────────────────────────────────

/**
 * Result type for operations that may fail without throwing.
 * Callers decide how to handle the error — no hidden control flow.
 */
type Result<T> =
  | { data: T; error: undefined }
  | { data: undefined; error: HttpError };

// ── validateStatus ────────────────────────────────────────────────────────────

/**
 * Validates that `code` is a legal HTTP status code (100–599).
 *
 * Returns a result object rather than throwing — `proto.status` throws
 * on the returned error so the throw site is explicit and visible.
 *
 * @example
 * const { error } = validateStatus(999);
 * if (error) throw error; // throws HttpError(500, ...)
 */
export function validateStatus(code: number): { error?: HttpError } {
  if (!Number.isInteger(code) || code < 100 || code > 599) {
    return {
      error: new HttpError(
        500,
        `Invalid status code: ${code}. Must be an integer between 100 and 599.`,
      ),
    };
  }
  return {};
}

// ── validateJson ──────────────────────────────────────────────────────────────

/**
 * Safely serializes `input` to a JSON string.
 *
 * Handles two failure cases:
 * 1. `input` contains circular references → JSON.stringify throws TypeError
 * 2. `input` contains a BigInt value → JSON.stringify throws TypeError
 *
 * Returns a Result — callers log the error and fall back to a safe
 * serialized error body without re-throwing.
 *
 * @example
 * const { data, error } = validateJson({ id: 1 });
 * if (error) { ... } // serialization failed
 * res.write(data);
 */
export function validateJson(input: unknown): Result<string> {
  try {
    const data = JSON.stringify(input);
    // JSON.stringify returns undefined for functions, symbols, undefined values
    if (data === undefined) {
      return {
        data: undefined,
        error: new HttpError(500, 'Value is not JSON-serializable'),
      };
    }
    return { data, error: undefined };
  } catch (e) {
    const message =
      e instanceof Error ? e.message : 'JSON serialization failed';
    return {
      data: undefined,
      error: new HttpError(500, message, e),
    };
  }
}
