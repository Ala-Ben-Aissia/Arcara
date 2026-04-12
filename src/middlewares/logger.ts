import type { ArcaraRequest, Middleware } from '../types.js';

export interface LoggerOptions {
  /**
   * Custom log function. Defaults to process.stdout.write.
   * Useful for piping to a log aggregator or test spy.
   */
  write?: (line: string) => void;
  /**
   * Whether to include timestamps. Default: true.
   */
  timestamp?: boolean;
  /**
   * Skip logging for matching requests.
   * Useful for filtering health checks, browser probes, or static assets.
   *
   * @example
   * logger({ skip: (req) => req.url === '/health' })
   */
  skip?: (req: ArcaraRequest) => boolean;
}

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
  white: '\x1b[37m',
} as const;

const METHOD_COLORS: Record<string, string> = {
  GET: ANSI.green,
  POST: ANSI.cyan,
  PUT: ANSI.yellow,
  PATCH: ANSI.magenta,
  DELETE: ANSI.red,
  HEAD: ANSI.blue,
  OPTIONS: ANSI.white,
};

function statusColor(status: number): string {
  if (status < 300) return ANSI.green;
  if (status < 400) return ANSI.cyan;
  if (status < 500) return ANSI.yellow;
  return ANSI.red;
}

function formatMethod(method: string): string {
  const color = METHOD_COLORS[method] ?? ANSI.white;
  return `${color}${method}${ANSI.reset}`;
}

function formatStatus(status: number): string {
  return `${statusColor(status)}${status}${ANSI.reset}`;
}

export function logger(options: LoggerOptions = {}): Middleware {
  const {
    write = (line) => process.stdout.write(line + '\n'),
    timestamp = true,
    skip,
  } = options;

  return (req, res, next) => {
    if (skip?.(req)) {
      return next();
    }
    const start = Date.now();
    const ts = timestamp
      ? `${ANSI.dim}${new Date().toISOString()}${ANSI.reset} `
      : '';

    res.on('finish', () => {
      const duration = Date.now() - start;
      const status = res.statusCode;
      const url = req.url ?? '/';

      write(
        `${ts}${formatMethod(req.method ?? 'GET')} ${url} ${formatStatus(status)} ${ANSI.dim}${duration}ms${ANSI.reset}`,
      );
    });

    next();
  };
}
