import assert from 'node:assert/strict';
import type { IncomingHttpHeaders } from 'node:http';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { Arcara, HttpError } from '../index.js';

// ── Test server harness ───────────────────────────────────────────────────────

interface TestServer {
  app: Arcara;
  port: number;
  close: () => void;
}

async function createTestServer(
  setup: (app: Arcara) => void,
): Promise<TestServer> {
  const app = new Arcara({ timeout: 5_000, startupLog: false });
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
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8');
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
            json() {
              return JSON.parse(body);
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

  it('handles HEAD request via the matching GET handler', async () => {
    const res = await request(server.port, 'HEAD', '/health');
    assert.equal(res.status, 200);
    // HEAD must return no body
    assert.equal(res.body, '');
  });
});

describe('Arcara — response helpers', () => {
  let server: TestServer;

  before(async () => {
    server = await createTestServer((app) => {
      app.get('/json', (_req, res) => res.json({ ok: true }));
      app.get('/text', (_req, res) => res.send('hello'));
      app.get('/html', (_req, res) => res.send('<h1>hi</h1>'));
      app.get('/buffer', (_req, res) => res.send(Buffer.from('bytes')));
      app.get('/object', (_req, res) => res.send({ key: 'value' }));
      app.get('/status', (_req, res) =>
        res.status(201).json({ created: true }),
      );
      app.get('/no-content', (_req, res) => res.status(204));
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

  it('res.send() detects text/html for HTML string', async () => {
    const res = await request(server.port, 'GET', '/html');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'] ?? '', /text\/html/);
  });

  it('res.send() handles Buffer body', async () => {
    const res = await request(server.port, 'GET', '/buffer');
    assert.equal(res.status, 200);
    assert.equal(res.body, 'bytes');
  });

  it('res.send() serializes a plain object as JSON', async () => {
    const res = await request(server.port, 'GET', '/object');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'] ?? '', /application\/json/);
    assert.deepEqual(res.json(), { key: 'value' });
  });

  it('res.status() sets the correct status code', async () => {
    const res = await request(server.port, 'GET', '/status');
    assert.equal(res.status, 201);
    assert.deepEqual(res.json(), { created: true });
  });

  it('res.status(204) ends the response with no body', async () => {
    const res = await request(server.port, 'GET', '/no-content');
    assert.equal(res.status, 204);
    assert.equal(res.body, '');
  });
});

describe('Arcara — body parsing', () => {
  let server: TestServer;

  before(async () => {
    server = await createTestServer((app) => {
      app.post('/echo', (req, res) => res.json(req.body));
      app.put('/echo', (req, res) => res.json(req.body));
      app.patch('/echo', (req, res) => res.json(req.body));
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

  it('parses a JSON body on PUT', async () => {
    const res = await request(server.port, 'PUT', '/echo', {
      body: { updated: true },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json(), { updated: true });
  });

  it('parses a JSON body on PATCH', async () => {
    const res = await request(server.port, 'PATCH', '/echo', {
      body: { patched: true },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json(), { patched: true });
  });

  it('responds 413 when body exceeds the limit', async () => {
    const app = new Arcara({ bodyLimit: 10, startupLog: false });
    app.post('/upload', (req, res) => res.json(req.body));

    await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
    const port = (app['server'].address() as { port: number }).port;

    const res = await request(port, 'POST', '/upload', {
      body: { data: 'this is definitely more than ten bytes' },
    });

    assert.equal(res.status, 413);
    await app.close();
  });

  // it('responds 400 for malformed JSON body', async () => {
  //   const app = new Arcara({ startupLog: false });
  //   app.post('/parse', (req, res) => res.json(req.body));

  //   await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
  //   const port = (app['server'].address() as { port: number }).port;

  //   const req = await request(port, 'POST', '/parse', {
  //     body: undefined,
  //   });

  //   assert.equal(req.headers, {
  //     'content-type': 'application/json',
  //     'content-length': '9',
  //   });
  // Send raw malformed JSON manually
  // await new Promise<void>((resolve, reject) => {
  //   const raw = 'not-json';
  //   const r = http.request(
  //     {
  //       hostname: '127.0.0.1',
  //       port,
  //       method: 'POST',
  //       path: '/parse',
  //       headers: {
  //         'content-type': 'application/json',
  //         'content-length': Buffer.byteLength(raw).toString(),
  //       },
  //     },
  //     (response) => {
  //       response.resume();
  //       resolve();
  //     },
  //   );
  //   r.on('error', reject);
  //   r.write(raw);
  //   r.end();
  // });

  //     await app.close();
  //   });
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

  it('returns empty object when no query string is present', async () => {
    const res = await request(server.port, 'GET', '/search');
    assert.deepEqual(res.json(), {});
  });

  it('handles a key with empty value', async () => {
    const res = await request(server.port, 'GET', '/search?q=');
    assert.deepEqual(res.json(), { q: '' });
  });

  it('handles percent-encoded query values', async () => {
    const res = await request(server.port, 'GET', '/search?q=hello%20world');
    assert.deepEqual(res.json(), { q: 'hello world' });
  });
});

describe('Arcara — redirect', () => {
  let server: TestServer;

  before(async () => {
    server = await createTestServer((app) => {
      app.get('/old', (_req, res) => res.redirect('/new'));
      app.get('/permanent', (_req, res) => res.redirect(301, '/new-permanent'));
      app.get('/new', (_req, res) => res.json({ arrived: true }));
      app.get('/new-permanent', (_req, res) => res.json({ arrived: true }));
    });
  });

  after(async () => server.close());

  it('res.redirect() issues a 302 by default', async () => {
    // Use a raw request — don't follow the redirect
    const res = await new Promise<{ status: number; location: string }>(
      (resolve, reject) => {
        const req = http.get(
          { hostname: '127.0.0.1', port: server.port, path: '/old' },
          (r) => {
            r.resume();
            resolve({
              status: r.statusCode ?? 0,
              location: (r.headers['location'] as string) ?? '',
            });
          },
        );
        req.on('error', reject);
      },
    );
    assert.equal(res.status, 302);
    assert.equal(res.location, '/new');
  });

  it('res.redirect(301, path) issues a 301', async () => {
    const res = await new Promise<{ status: number; location: string }>(
      (resolve, reject) => {
        const req = http.get(
          { hostname: '127.0.0.1', port: server.port, path: '/permanent' },
          (r) => {
            r.resume();
            resolve({
              status: r.statusCode ?? 0,
              location: (r.headers['location'] as string) ?? '',
            });
          },
        );
        req.on('error', reject);
      },
    );
    assert.equal(res.status, 301);
    assert.equal(res.location, '/new-permanent');
  });
});

describe('Arcara — graceful shutdown', () => {
  it('close() resolves after server stops accepting connections', async () => {
    const app = new Arcara({ startupLog: false });
    app.get('/ping', (_req, res) => res.end('pong'));
    await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
    await assert.doesNotReject(() => app.close());
  });
});
