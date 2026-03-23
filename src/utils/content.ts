import type http from 'node:http';

// ── Magic byte signatures ─────────────────────────────────────────────────────

/**
 * Checks the leading bytes of a buffer against known image format signatures.
 * Returns the matching MIME type, or null if unrecognized.
 *
 * Byte signatures (all big-endian, first N bytes):
 *
 * Format  | Signature
 * --------|-----------------------------
 * JPEG    | FF D8 FF
 * PNG     | 89 50 4E 47 0D 0A 1A 0A
 * GIF     | 47 49 46 38 (GIF8)
 * WEBP    | 52 49 46 46 ... 57 45 42 50 (RIFF....WEBP)
 * BMP     | 42 4D
 * TIFF LE | 49 49 2A 00
 * TIFF BE | 4D 4D 00 2A
 * AVIF    | ftyp box at offset 4 with brand 'avif' or 'avis'
 * HEIC    | ftyp box at offset 4 with brand 'heic' or 'heix'
 * HEIF    | ftyp box at offset 4 with brand 'mif1' or 'msf1'
 */
function sniffImageMagicBytes(bytes: Uint8Array) {
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }

  // GIF: GIF87a or GIF89a
  if (
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    return 'image/gif';
  }

  // WEBP: RIFF????WEBP
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }

  // BMP: BM
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return 'image/bmp';
  }

  // TIFF little-endian: II 2A 00
  if (
    bytes[0] === 0x49 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x2a &&
    bytes[3] === 0x00
  ) {
    return 'image/tiff';
  }

  // TIFF big-endian: MM 00 2A
  if (
    bytes[0] === 0x4d &&
    bytes[1] === 0x4d &&
    bytes[2] === 0x00 &&
    bytes[3] === 0x2a
  ) {
    return 'image/tiff';
  }

  // ISO Base Media File Format (ISOBMFF) — ftyp box at offset 4.
  // AVIF, HEIC, HEIF all use this container.
  // Box layout: [4 bytes size][4 bytes 'ftyp'][4 bytes major brand]...
  if (
    bytes[4] === 0x66 && // f
    bytes[5] === 0x74 && // t
    bytes[6] === 0x79 && // y
    bytes[7] === 0x70 // p
  ) {
    // Read major brand as ASCII (4 bytes at offset 8)
    const brand = String.fromCharCode(
      bytes[8]!,
      bytes[9]!,
      bytes[10]!,
      bytes[11]!,
    );

    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    if (brand === 'heic' || brand === 'heix') return 'image/heic';
    if (brand === 'mif1' || brand === 'msf1') return 'image/heif';
  }

  return null;
}

// ── String content sniffing ───────────────────────────────────────────────────

// Intentionally loose patterns — we're doing content-type detection,
// not validation. The point is to avoid sending text/plain for markup.
const HTML_PATTERN = /^\s*<!doctype\s+html|^\s*<html[\s>]/i;
const SVG_PATTERN = /^\s*<svg[\s>]/i;
const CSS_PATTERN = /^\s*(@charset|@import|@media|@keyframes|[.#][\w-]+\s*\{)/;

function sniffString(s: string) {
  if (HTML_PATTERN.test(s)) return 'text/html; charset=utf-8';
  if (SVG_PATTERN.test(s)) return 'image/svg+xml';
  if (CSS_PATTERN.test(s)) return 'text/css; charset=utf-8';
  return 'text/plain; charset=utf-8';
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Determines the correct Content-Type for a response value without relying
 * on any caller-supplied hint. Dispatch order:
 *
 * 1. Buffer / Uint8Array / ArrayBuffer  → magic byte sniff → octet-stream fallback
 * 2. string                             → HTML / SVG / CSS pattern → text/plain fallback
 * 3. object (non-null)                  → application/json
 * 4. everything else                    → request Content-Type header → application/octet-stream
 *
 * The `req` parameter is optional. When provided it is used as the last-resort
 * fallback for unrecognized binary content — if the client sent a body with a
 * Content-Type, echoing it back is more informative than octet-stream.
 */
export function detectContentType(input: unknown, req?: http.IncomingMessage) {
  // ── Binary paths ────────────────────────────────────────────────────────────

  if (Buffer.isBuffer(input)) {
    return sniffImageMagicBytes(input) ?? resolveOctetFallback(req);
  }

  if (input instanceof Uint8Array) {
    return sniffImageMagicBytes(input) ?? resolveOctetFallback(req);
  }

  if (input instanceof ArrayBuffer) {
    return (
      sniffImageMagicBytes(new Uint8Array(input)) ?? resolveOctetFallback(req)
    );
  }

  // ── String ──────────────────────────────────────────────────────────────────

  if (typeof input === 'string') {
    return sniffString(input);
  }

  // ── Object (JSON-serializable) ───────────────────────────────────────────────

  if (input !== null && typeof input === 'object') {
    return 'application/json';
  }

  // ── Unknown scalar — fall back to request Content-Type or text/plain ─────────

  return resolveOctetFallback(req);
}

/**
 * Returns the incoming request's Content-Type if present, otherwise
 * falls back to application/octet-stream. Used for unrecognized binary or scalar values.
 */
function resolveOctetFallback(req?: http.IncomingMessage) {
  if (req) {
    const ct = req.headers['content-type'];
    if (ct) return ct;
  }
  return 'application/octet-stream';
}
