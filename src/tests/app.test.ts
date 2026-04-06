import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Arcara, HttpError } from '../index.js';
import type { IncomingHttpHeaders } from 'node:http';

// ── Test server harness ───────────────────────────────────────────────────────
//
// Binds to port 0 — the OS assigns a free ephemeral port.
// No port conflicts between parallel test runs or CI matrix nodes.

interface TestServer {
  app: Arcara;
  port: number;
  close: () => void;
}

async function createTestServer(
  setup: (app: Arcara) => void,
): Promise<TestServer> {
  const app = new Arcara({ timeout: 5_000 });
  setup(app);

  await new Promise<void>((resolve) => {
    app.listen(0, '127.0.0.1', resolve);
  });

  const port = (app['server'].address() as { port: number }).port;

  return { app, port, close: () => app.close() };
}

// ── HTTP client helper ────────────────────────────────────────────────────────

interface Response {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
  json<T = unknown>(): T;
}

function request(
  port: number,
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const bodyStr =
      options.body !== undefined ? JSON.stringify(options.body) : undefined;

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          ...(bodyStr
            ? {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(bodyStr).toString(),
              }
            : {}),
          ...options.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8');
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
            json<T>(): T {
              return JSON.parse(body) as T;
            },
          });
        });
      },
    );

    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Arcara — basic routing', () => {
  let server: TestServer;

  before(async () => {
    server = await createTestServer((app) => {
      app.get('/health', (_req, res) => res.end('ok'));
      app.get('/users/:id', (req, res) => {
        res.end(JSON.stringify({ id: req.params.id }));
      });
    });
  });

  after(() => server.close());

  it('responds 200 to a registered GET route', async () => {
    const res = await request(server.port, 'GET', '/health');
    assert.equal(res.status, 200);
    assert.equal(res.body, 'ok');
  });

  it('extracts route params correctly', async () => {
    const res = await request(server.port, 'GET', '/users/42');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json(), { id: '42' });
  });

  it('responds 404 for an unknown route', async () => {
    const res = await request(server.port, 'GET', '/unknown');
    assert.equal(res.status, 404);
  });

  it('responds 405 for a registered path with wrong method', async () => {
    const res = await request(server.port, 'DELETE', '/health');
    assert.equal(res.status, 405);
  });
});

describe('Arcara — response helpers', () => {
  let server: TestServer;

  before(async () => {
    server = await createTestServer((app) => {
      app.get('/json', (_req, res) => res.json({ ok: true }));
      app.get('/text', (_req, res) => res.send('hello'));
      app.get('/status', (_req, res) =>
        res.status(201).json({ created: true }),
      );
    });
  });

  after(() => server.close());

  it('res.json() sets Content-Type and serializes body', async () => {
    const res = await request(server.port, 'GET', '/json');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'] ?? '', /application\/json/);
    assert.deepEqual(res.json(), { ok: true });
  });

  it('res.send() sets text/plain for string body', async () => {
    const res = await request(server.port, 'GET', '/text');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'] ?? '', /text\/plain/);
    assert.equal(res.body, 'hello');
  });

  it('res.status() sets the correct status code', async () => {
    const res = await request(server.port, 'GET', '/status');
    assert.equal(res.status, 201);
    assert.deepEqual(res.json(), { created: true });
  });
});

describe('Arcara — body parsing', () => {
  let server: TestServer;

  before(async () => {
    server = await createTestServer((app) => {
      app.post('/echo', (req, res) => res.json(req.body));
    });
  });

  after(() => server.close());

  it('parses a JSON body on POST', async () => {
    const res = await request(server.port, 'POST', '/echo', {
      body: { name: 'arcara' },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json(), { name: 'arcara' });
  });

  it('responds 413 when body exceeds the limit', async () => {
    const app = new Arcara({ bodyLimit: 10 }); // 10 bytes
    app.post('/upload', (req, res) => res.json(req.body));

    await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
    const port = (app['server'].address() as { port: number }).port;

    const res = await request(port, 'POST', '/upload', {
      body: { data: 'this is definitely more than ten bytes' },
    });

    assert.equal(res.status, 413);
    await app.close();
  });
});

describe('Arcara — error handling', () => {
  let server: TestServer;

  before(async () => {
    server = await createTestServer((app) => {
      app.get('/throw', () => {
        throw new HttpError(422, 'Validation failed');
      });

      app.get('/throw-generic', () => {
        throw new Error('Something broke');
      });

      app.onError((err, _req, res) => {
        res.status(err.status).json({ error: err.message });
      });
    });
  });

  after(() => server.close());

  it('routes HttpError to the error handler with correct status', async () => {
    const res = await request(server.port, 'GET', '/throw');
    assert.equal(res.status, 422);
    assert.deepEqual(res.json(), { error: 'Validation failed' });
  });

  it('normalizes a generic Error to 500', async () => {
    const res = await request(server.port, 'GET', '/throw-generic');
    assert.equal(res.status, 500);
    assert.deepEqual(res.json(), { error: 'Something broke' });
  });
});

describe('Arcara — middleware', () => {
  let server: TestServer;

  before(async () => {
    server = await createTestServer((app) => {
      app.use((req, _res, next) => {
        (req as any).tagged = true;
        next();
      });
      app.get('/check', (req, res) => {
        res.json({ tagged: (req as any).tagged });
      });
    });
  });

  after(() => server.close());

  it('runs global middleware for every request', async () => {
    const res = await request(server.port, 'GET', '/check');
    assert.deepEqual(res.json(), { tagged: true });
  });
});

describe('Arcara — OPTIONS', () => {
  let server: TestServer;

  before(async () => {
    server = await createTestServer((app) => {
      app.get('/resource', (_req, res) => res.end());
      app.post('/resource', (_req, res) => res.end());
    });
  });

  after(() => server.close());

  it('responds 204 with Allow header for OPTIONS', async () => {
    const res = await request(server.port, 'OPTIONS', '/resource');
    assert.equal(res.status, 204);

    const allow = res.headers['allow'] ?? '';
    assert.ok(allow.includes('GET'), `Allow missing GET: ${allow}`);
    assert.ok(allow.includes('POST'), `Allow missing POST: ${allow}`);
    assert.ok(allow.includes('OPTIONS'), `Allow missing OPTIONS: ${allow}`);
  });
});

describe('Arcara — query string', () => {
  let server: TestServer;

  before(async () => {
    server = await createTestServer((app) => {
      app.get('/search', (req, res) => res.json(req.query));
    });
  });

  after(() => server.close());

  it('parses query string into req.query', async () => {
    const res = await request(server.port, 'GET', '/search?q=arcara&page=2');
    assert.deepEqual(res.json(), { q: 'arcara', page: '2' });
  });
});

describe('Arcara — graceful shutdown', () => {
  it('close() resolves after server stops accepting connections', async () => {
    const app = new Arcara();
    app.get('/ping', (_req, res) => res.end('pong'));

    await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));

    // Should resolve cleanly — no timeout, no throw
    await assert.doesNotReject(async () => app.close());
  });
});
