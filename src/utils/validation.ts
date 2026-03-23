/**
 * Validates an HTTP status code.
 *
 * Returns { error: RangeError }  if code is outside 100–999.
 * Returns { error: TypeError }   if code is not a finite integer.
 * Returns {}                     if code is valid.
 *
 * Returns { error } rather than throwing — callers decide behavior.
 * proto.status throws on invalid codes (programmer error).
 * The default errorHandler writes raw statusCode without validation.
 */
export function validateStatus(code: number): {
  error?: RangeError | TypeError;
} {
  if (!Number.isInteger(code) || !Number.isFinite(code)) {
    return {
      error: new TypeError(
        `Status code must be a finite integer, got: ${code}`,
      ),
    };
  }
  if (code < 100 || code > 999) {
    return {
      error: new RangeError(
        `Status code must be between 100 and 999, got: ${code}`,
      ),
    };
  }
  return {};
}

/**
 * Safely serializes a value to a JSON string.
 *
 * Catches values that JSON.stringify cannot handle:
 * - functions        → stringify silently drops them in objects, returns
 *                      undefined at top level
 * - BigInt           → throws TypeError at runtime
 * - circular refs    → throws TypeError at runtime
 *
 * Returns { data: string } on success.
 * Returns { error: TypeError } on failure.
 *
 * Never throws — callers decide how to handle the error.
 */
export function validateJson(input: unknown): {
  data?: string;
  error?: TypeError;
} {
  // Top-level functions and undefined serialize to nothing — treat as error
  // so callers can make an explicit decision rather than sending an empty body.
  if (typeof input === 'function' || typeof input === 'undefined') {
    return {
      error: new TypeError(
        `Value of type "${typeof input}" is not JSON serializable`,
      ),
    };
  }

  try {
    const data = JSON.stringify(input);

    // JSON.stringify returns undefined (not string) for top-level symbols.
    // TypeScript types it as string but the runtime can produce undefined.
    if (data === undefined) {
      return {
        error: new TypeError(
          `Value of type "${typeof input}" is not JSON serializable`,
        ),
      };
    }

    return { data };
  } catch (e) {
    // BigInt → "Do not know how to serialize a BigInt"
    // Circular → "Converting circular structure to JSON"
    const message = e instanceof Error ? e.message : String(e);
    return { error: new TypeError(`JSON serialization failed: ${message}`) };
  }
}
