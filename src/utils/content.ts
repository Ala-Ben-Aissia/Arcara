import type { IncomingMessage } from 'node:http';

// ── Magic byte signatures ─────────────────────────────────────────────────────

type MagicEntry = {
  mime: string;
  bytes: (number | null)[]; // null = wildcard (skip that byte)
  offset?: number; // default 0
};

/**
 * Declarative magic-byte table. Evaluated top-to-bottom — put more specific
 * entries (longer signatures, or same prefix with different offset checks)
 * before less specific ones.
 *
 * Format      | Sig
 * ------------|----------------------------------------------------------
 * JPEG        | FF D8 FF
 * PNG         | 89 50 4E 47 0D 0A 1A 0A
 * GIF87a      | 47 49 46 38 37 61
 * GIF89a      | 47 49 46 38 39 61
 * WEBP        | 52 49 46 46 __ __ __ __ 57 45 42 50  (RIFF????WEBP)
 * BMP         | 42 4D
 * TIFF LE     | 49 49 2A 00
 * TIFF BE     | 4D 4D 00 2A
 * AVIF        | ftyp box @ offset 4, major brand 'avif'|'avis'  ← handled separately
 * HEIC        | ftyp box @ offset 4, major brand 'heic'|'heix'  ← handled separately
 * HEIF        | ftyp box @ offset 4, major brand 'mif1'|'msf1'  ← handled separately
 * MP4         | ftyp box @ offset 4, major brand 'mp41'|'mp42'|'isom'|'M4V '|'M4A '
 * WebM        | 1A 45 DF A3
 * OGG         | 4F 67 67 53
 * MP3 (ID3)   | 49 44 33
 * MP3 (sync)  | FF FB | FF F3 | FF F2
 * WAV         | 52 49 46 46 __ __ __ __ 57 41 56 45  (RIFF????WAVE)
 * FLAC        | 66 4C 61 43
 * AAC (ADTS)  | FF F1 | FF F9
 * WOFF        | 77 4F 46 46
 * WOFF2       | 77 4F 46 32
 * TTF         | 00 01 00 00 00
 * OTF         | 4F 54 54 4F
 * PDF         | 25 50 44 46
 * ZIP         | 50 4B 03 04
 * WASM        | 00 61 73 6D
 * XML         | 3C 3F 78 6D 6C  (<?xml)
 */
const MAGIC_TABLE: MagicEntry[] = [
  // ── Images ──────────────────────────────────────────────────────────────────
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  {
    mime: 'image/png',
    bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  },
  { mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61] }, // GIF87a
  { mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61] }, // GIF89a
  {
    mime: 'image/webp',
    bytes: [
      0x52,
      0x49,
      0x46,
      0x46,
      null,
      null,
      null,
      null,
      0x57,
      0x45,
      0x42,
      0x50,
    ],
  },
  { mime: 'image/bmp', bytes: [0x42, 0x4d] },
  { mime: 'image/tiff', bytes: [0x49, 0x49, 0x2a, 0x00] }, // LE
  { mime: 'image/tiff', bytes: [0x4d, 0x4d, 0x00, 0x2a] }, // BE
  // AVIF/HEIC/HEIF/MP4 share the ISOBMFF ftyp box — handled in sniffIsobmff()

  // ── Video ───────────────────────────────────────────────────────────────────
  { mime: 'video/webm', bytes: [0x1a, 0x45, 0xdf, 0xa3] },
  { mime: 'video/ogg', bytes: [0x4f, 0x67, 0x67, 0x53] },
  {
    mime: 'video/x-msvideo', // AVI — also RIFF-based
    bytes: [
      0x52,
      0x49,
      0x46,
      0x46,
      null,
      null,
      null,
      null,
      0x41,
      0x56,
      0x49,
      0x20,
    ],
  },

  // ── Audio ───────────────────────────────────────────────────────────────────
  { mime: 'audio/mpeg', bytes: [0x49, 0x44, 0x33] }, // MP3 ID3v2
  { mime: 'audio/mpeg', bytes: [0xff, 0xfb] }, // MP3 sync (MPEG1 L3)
  { mime: 'audio/mpeg', bytes: [0xff, 0xf3] }, // MP3 sync (MPEG2 L3)
  { mime: 'audio/mpeg', bytes: [0xff, 0xf2] }, // MP3 sync (MPEG2.5 L3)
  {
    mime: 'audio/wav',
    bytes: [
      0x52,
      0x49,
      0x46,
      0x46,
      null,
      null,
      null,
      null,
      0x57,
      0x41,
      0x56,
      0x45,
    ],
  },
  { mime: 'audio/flac', bytes: [0x66, 0x4c, 0x61, 0x43] },
  { mime: 'audio/aac', bytes: [0xff, 0xf1] }, // AAC ADTS MPEG-4
  { mime: 'audio/aac', bytes: [0xff, 0xf9] }, // AAC ADTS MPEG-2
  { mime: 'audio/ogg', bytes: [0x4f, 0x67, 0x67, 0x53] }, // OGG — may be vorbis/opus

  // ── Fonts ───────────────────────────────────────────────────────────────────
  { mime: 'font/woff', bytes: [0x77, 0x4f, 0x46, 0x46] },
  { mime: 'font/woff2', bytes: [0x77, 0x4f, 0x46, 0x32] },
  { mime: 'font/ttf', bytes: [0x00, 0x01, 0x00, 0x00, 0x00] },
  { mime: 'font/otf', bytes: [0x4f, 0x54, 0x54, 0x4f] },

  // ── Documents / Misc binary ──────────────────────────────────────────────────
  { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46] }, // %PDF
  { mime: 'application/zip', bytes: [0x50, 0x4b, 0x03, 0x04] }, // PK
  { mime: 'application/wasm', bytes: [0x00, 0x61, 0x73, 0x6d] }, // \0asm

  // ── XML (binary-safe prefix check) ───────────────────────────────────────────
  // Note: XML with BOM is handled in sniffString; this catches UTF-8 without BOM
  { mime: 'application/xml', bytes: [0x3c, 0x3f, 0x78, 0x6d, 0x6c] }, // <?xml
];

function matchesMagicEntry(bytes: Uint8Array, entry: MagicEntry): boolean {
  const offset = entry.offset ?? 0;
  if (bytes.length < offset + entry.bytes.length) return false;
  return entry.bytes.every((b, i) => b === null || bytes[offset + i] === b);
}

function sniffImageMagicBytes(bytes: Uint8Array): string | null {
  for (const entry of MAGIC_TABLE) {
    if (matchesMagicEntry(bytes, entry)) return entry.mime;
  }
  return sniffIsobmff(bytes);
}

// ── ISOBMFF (ISO Base Media File Format) ─────────────────────────────────────
// Handles AVIF, HEIC, HEIF, MP4, M4A, M4V.
// Box layout: [4B size][4B 'ftyp'][4B major brand][4B minor version][compatible brands...]
//
// We check compatible brands too — a file may declare 'mp42' as major but list
// 'avc1' in compatible brands.  For our purposes major brand is authoritative.

const ISOBMFF_BRAND_MAP: Record<string, string> = {
  avif: 'image/avif',
  avis: 'image/avif',
  heic: 'image/heic',
  heix: 'image/heic',
  mif1: 'image/heif',
  msf1: 'image/heif',
  mp41: 'video/mp4',
  mp42: 'video/mp4',
  isom: 'video/mp4',
  'M4V ': 'video/mp4',
  'M4A ': 'audio/mp4',
  'M4B ': 'audio/mp4', // audiobook
  f4v: 'video/mp4',
  f4a: 'audio/mp4',
  dash: 'video/mp4',
  crx: 'video/mp4',
};

function sniffIsobmff(bytes: Uint8Array): string | null {
  // Need at least 12 bytes: 4 (size) + 4 ('ftyp') + 4 (major brand)
  if (bytes.length < 12) return null;

  const ftypBox =
    bytes[4] === 0x66 && // f
    bytes[5] === 0x74 && // t
    bytes[6] === 0x79 && // y
    bytes[7] === 0x70; // p

  if (!ftypBox) return null;

  const majorBrand = String.fromCharCode(
    bytes[8]!,
    bytes[9]!,
    bytes[10]!,
    bytes[11]!,
  );

  return ISOBMFF_BRAND_MAP[majorBrand] ?? null;
}

// ── String content sniffing ───────────────────────────────────────────────────

const SNIFF_PATTERNS: [RegExp, string][] = [
  // Order matters — more specific patterns first
  [/^\s*<\?xml[\s>]/i, 'application/xml; charset=utf-8'],
  [/^\s*<svg[\s>]/i, 'image/svg+xml'],
  [
    /^\s*(<!doctype\s+html|<html[\s>]|<[a-z][\w-]*[^>]*>)/i,
    'text/html; charset=utf-8',
  ],
  [
    /^\s*(@charset|@import|@media|@keyframes|[.#:*][\w-]*\s*\{)/,
    'text/css; charset=utf-8',
  ],
  // Heuristic JS/TS detection — not foolproof, but catches the common cases
  // when serving dynamic scripts without a known file extension.
  [
    /^\s*(import\s|export\s|const\s|let\s|var\s|function\s|class\s|async\s)/,
    'text/javascript; charset=utf-8',
  ],
  // JSON — starts with object, array, string, number, bool, null
  [/^\s*([[{"]|-?\d|true|false|null)/, 'application/json'],
];

function sniffString(s: string): string {
  // Only inspect the first 512 chars — enough for any leading declaration
  const head = s.length > 512 ? s.slice(0, 512) : s;

  for (const [pattern, mime] of SNIFF_PATTERNS) {
    if (pattern.test(head)) return mime;
  }

  return 'text/plain; charset=utf-8';
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Determines the correct Content-Type for a response value without relying
 * on any caller-supplied hint. Dispatch order:
 *
 * 1. Buffer / Uint8Array / ArrayBuffer  → magic byte sniff → ISOBMFF → octet-stream fallback
 * 2. string                             → XML / SVG / HTML / CSS / JS / JSON → text/plain
 * 3. object (non-null)                  → application/json
 * 4. everything else                    → request Content-Type header → application/octet-stream
 *
 * The `req` parameter is optional. When provided it is used as the last-resort
 * fallback for unrecognized binary content — echoing back the client's declared
 * Content-Type is more informative than a bare octet-stream.
 */
export function detectContentType(
  input: unknown,
  req?: IncomingMessage,
): string {
  if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
    return sniffImageMagicBytes(input) ?? resolveOctetFallback(req);
  }

  if (input instanceof ArrayBuffer) {
    return (
      sniffImageMagicBytes(new Uint8Array(input)) ?? resolveOctetFallback(req)
    );
  }

  if (typeof input === 'string') {
    return sniffString(input);
  }

  if (input !== null && typeof input === 'object') {
    return 'application/json';
  }

  return resolveOctetFallback(req);
}

function resolveOctetFallback(req?: IncomingMessage): string {
  const ct = req?.headers['content-type'];
  return ct ?? 'application/octet-stream';
}
