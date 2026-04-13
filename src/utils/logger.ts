import { type HttpMethod, HttpError } from '../types.js';

const color = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  gray: (s: string) => `\x1b[90m${s}\x1b[0m`,
  blue: (s: string) => `\x1b[34m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
} as const;

function getCauseChain(cause: unknown) {
  if (!cause) return '';
  let chain = '';
  let current: unknown = cause;
  let depth = 0;
  while (current && depth < 10) {
    const isErr = current instanceof Error;
    const msg = isErr
      ? `${(current as Error).name}: ${(current as Error).message}`
      : String(current);
    chain += color.gray('\nCaused by: ') + msg;
    if (!isErr || !(current as Error).cause) break;
    current = (current as Error).cause;
    depth++;
  }
  return chain;
}

export const internalLogger = {
  request(
    method: HttpMethod,
    pathname: string,
    status: number,
    durationMs: number,
  ) {
    const methodCol =
      {
        GET: color.green,
        POST: color.blue,
        PUT: color.yellow,
        PATCH: color.magenta,
        DELETE: color.red,
        HEAD: color.cyan,
        OPTIONS: color.gray,
      }[method] || color.cyan;

    const meth = methodCol(method);

    const statCol =
      status < 300
        ? color.green
        : status < 400
          ? color.cyan
          : status < 500
            ? color.yellow
            : color.red;

    const stat = statCol(status.toString());

    const dur = color.dim(`${durationMs}ms`);

    console.log(`${meth} ${pathname} ${stat} ${dur}`);
  },

  start(host: string, port: number) {
    const url = `http://${host}:${port}`;
    console.log(`${color.green('✓')} Server listening on ${color.cyan(url)}`);
  },

  error(e: unknown) {
    const isError = e instanceof Error;
    let name = isError ? e.name : 'Error';
    const message = isError ? e.message : String(e);

    if (e instanceof HttpError) {
      name = `${name} (${e.status})`;
    }

    const stack =
      isError && e.stack
        ? color.gray('\n' + e.stack.split('\n').slice(1).join('\n'))
        : '';

    const cause = isError ? getCauseChain(e.cause) : '';

    console.error(
      color.red(color.bold(`✗ ${name}`)) + ' ' + message + cause + stack,
    );
  },
};
