import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { IncomingMessage } from 'node:http';
import { Layer } from '../Layer.js';
import { HttpError } from '../types.js';
import type { ArcaraRequest, ArcaraResponse, NextFn } from '../types.js';

// ── Concrete Layer subclass for testing ───────────────────────────────────────

class TestLayer extends Layer {
  public run(
    pathname: string,
    req: ArcaraRequest,
    res: ArcaraResponse,
  ): Promise<void> {
    return this.dispatch(pathname, req, res);
  }
}

// ── Request / Response mocks ──────────────────────────────────────────────────

function mockReq(method = 'GET', url = '/'): ArcaraRequest {
  const req = new IncomingMessage(null as any);
  req.method = method;
  req.url = url;
  (req as ArcaraRequest).params = {};
  (req as ArcaraRequest).query = {};
  (req as ArcaraRequest).body = undefined;
  return req as ArcaraRequest;
}

function mockRes(): ArcaraResponse & {
  _body: string;
  _status: number;
  _ended: boolean;
} {
  const chunks: string[] = [];
  const res = {
    _body: '',
    _status: 200,
    _ended: false,
    writableEnded: false,
    destroyed: false,
    statusCode: 200,

    setHeader: mock.fn(),
    getHeader: mock.fn(() => undefined),
    writeHead: mock.fn(),
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
    end(chunk?: string) {
      if (chunk) chunks.push(chunk);
      // @ts-expect-error
      this._body = chunks.join('');
      // @ts-expect-error
      this._ended = true;
      // @ts-expect-error
      this.writableEnded = true;
    },
    once: mock.fn(),
  } as unknown as ArcaraResponse & {
    _body: string;
    _status: number;
    _ended: boolean;
  };

  return res;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Layer — routing', () => {
  it('matches a GET route and calls the handler', async () => {
    const layer = new TestLayer();
    let called = false;

    layer.get('/hello', (_req, res) => {
      called = true;
      res.end();
    });

    await layer.run('/hello', mockReq('GET', '/hello'), mockRes());
    assert.equal(called, true);
  });

  it('returns 404 for an unregistered path', async () => {
    const layer = new TestLayer();
    const res = mockRes();

    layer.onError((err, _req, r) => {
      r.statusCode = err.status;
      r.end();
    });

    await layer.run('/missing', mockReq('GET', '/missing'), res);
    assert.equal(res.statusCode, 404);
  });

  it('returns 405 for a registered path with wrong method', async () => {
    const layer = new TestLayer();
    const res = mockRes();

    layer.get('/users', (_req, r) => r.end());
    layer.onError((err, _req, r) => {
      r.statusCode = err.status;
      r.end();
    });

    await layer.run('/users', mockReq('DELETE', '/users'), res);
    assert.equal(res.statusCode, 405);
  });

  it('extracts route params into req.params', async () => {
    const layer = new TestLayer();
    let capturedParams: Record<string, string> = {};

    layer.get('/users/:id', (req, res) => {
      capturedParams = req.params as Record<string, string>;
      res.end();
    });

    await layer.run('/users/42', mockReq('GET', '/users/42'), mockRes());
    assert.deepEqual(capturedParams, { id: '42' });
  });

  it('HEAD falls back to GET handler', async () => {
    const layer = new TestLayer();
    let called = false;

    layer.get('/ping', (_req, res) => {
      called = true;
      res.end();
    });

    await layer.run('/ping', mockReq('HEAD', '/ping'), mockRes());
    assert.equal(called, true);
  });

  it('matches multiple HTTP methods on the same path independently', async () => {
    const layer = new TestLayer();
    const seen: string[] = [];

    layer.get('/resource', (_req, res) => {
      seen.push('GET');
      res.end();
    });
    layer.post('/resource', (_req, res) => {
      seen.push('POST');
      res.end();
    });
    layer.delete('/resource', (_req, res) => {
      seen.push('DELETE');
      res.end();
    });

    await layer.run('/resource', mockReq('GET'), mockRes());
    await layer.run('/resource', mockReq('POST'), mockRes());
    await layer.run('/resource', mockReq('DELETE'), mockRes());

    assert.deepEqual(seen, ['GET', 'POST', 'DELETE']);
  });

  it('OPTIONS short-circuits without calling route handlers', async () => {
    const layer = new TestLayer();
    let handlerCalled = false;

    layer.get('/resource', (_req, res) => {
      handlerCalled = true;
      res.end();
    });

    // OPTIONS should return without reaching the GET handler
    await layer.run('/resource', mockReq('OPTIONS'), mockRes());
    assert.equal(handlerCalled, false);
  });
});

describe('Layer — middleware', () => {
  it('runs global middleware before route handler', async () => {
    const layer = new TestLayer();
    const order: string[] = [];

    layer.use((_req, _res, next) => {
      order.push('mw');
      next();
    });
    layer.get('/path', (_req, res) => {
      order.push('handler');
      res.end();
    });

    await layer.run('/path', mockReq('GET', '/path'), mockRes());
    assert.deepEqual(order, ['mw', 'handler']);
  });

  it('prefix-scoped middleware only runs for matching paths', async () => {
    const layer = new TestLayer();
    const ran: string[] = [];

    layer.use('/api', (_req, _res, next) => {
      ran.push('api-mw');
      next();
    });
    layer.get('/api/users', (_req, res) => res.end());
    layer.get('/other', (_req, res) => res.end());

    await layer.run('/api/users', mockReq('GET', '/api/users'), mockRes());
    assert.deepEqual(ran, ['api-mw']);

    ran.length = 0;
    await layer.run('/other', mockReq('GET', '/other'), mockRes());
    assert.deepEqual(ran, []);
  });

  it('prefix-scoped middleware strips the prefix from req.url', async () => {
    const layer = new TestLayer();
    let seenUrl = '';

    layer.use('/api', (req, _res, next) => {
      seenUrl = req.url ?? '';
      next();
    });
    layer.get('/api/users', (_req, res) => res.end());

    await layer.run('/api/users', mockReq('GET', '/api/users'), mockRes());
    assert.equal(seenUrl, '/users');
  });

  it('restores req.url after prefix-scoped middleware completes', async () => {
    const layer = new TestLayer();

    layer.use('/api', (_req, _res, next) => next());
    layer.get('/api/users', (_req, res) => {
      res.end();
    });

    const req = mockReq('GET', '/api/users');
    await layer.run('/api/users', req, mockRes());
    // After dispatch, req.url should be restored to the original
    assert.equal(req.url, '/api/users');
  });

  it('short-circuits when middleware ends the response', async () => {
    const layer = new TestLayer();
    let handlerCalled = false;

    layer.use((_req, res, _next) => {
      res.end();
    });
    layer.get('/path', (_req, res) => {
      handlerCalled = true;
      res.end();
    });

    await layer.run('/path', mockReq('GET', '/path'), mockRes());
    assert.equal(handlerCalled, false);
  });

  it('supports multiple stacked handlers per route', async () => {
    const layer = new TestLayer();
    const order: number[] = [];

    layer.get(
      '/path',
      (_req, _res, next) => {
        order.push(1);
        next();
      },
      (_req, _res, next) => {
        order.push(2);
        next();
      },
      (_req, res) => {
        order.push(3);
        res.end();
      },
    );

    await layer.run('/path', mockReq('GET', '/path'), mockRes());
    assert.deepEqual(order, [1, 2, 3]);
  });

  it('supports async middleware that awaits before calling next', async () => {
    const layer = new TestLayer();
    const order: string[] = [];

    layer.use(async (_req, _res, next) => {
      await Promise.resolve(); // simulate async work
      order.push('async-mw');
      next();
    });
    layer.get('/path', (_req, res) => {
      order.push('handler');
      res.end();
    });

    await layer.run('/path', mockReq('GET', '/path'), mockRes());
    assert.deepEqual(order, ['async-mw', 'handler']);
  });

  it('multiple global middlewares all run in registration order', async () => {
    const layer = new TestLayer();
    const order: number[] = [];

    layer.use((_req, _res, next) => {
      order.push(1);
      next();
    });
    layer.use((_req, _res, next) => {
      order.push(2);
      next();
    });
    layer.use((_req, _res, next) => {
      order.push(3);
      next();
    });
    layer.get('/path', (_req, res) => res.end());

    await layer.run('/path', mockReq('GET', '/path'), mockRes());
    assert.deepEqual(order, [1, 2, 3]);
  });

  it('prefix middleware does not run for a path that is just the prefix with no trailing segment', async () => {
    // /api should NOT match /apiusers — only /api or /api/*
    const layer = new TestLayer();
    const ran: string[] = [];

    layer.use('/api', (_req, _res, next) => {
      ran.push('ran');
      next();
    });
    layer.get('/apiusers', (_req, res) => res.end());

    await layer.run('/apiusers', mockReq('GET', '/apiusers'), mockRes());
    assert.deepEqual(ran, []);
  });
});

describe('Layer — error handling', () => {
  it('routes thrown HttpError to the error handler', async () => {
    const layer = new TestLayer();
    const res = mockRes();

    layer.get('/boom', () => {
      throw new HttpError(422, 'Unprocessable');
    });
    layer.onError((err, _req, r) => {
      r.statusCode = err.status;
      r.end(err.message);
    });

    await layer.run('/boom', mockReq('GET', '/boom'), res);
    assert.equal(res.statusCode, 422);
    assert.equal(res._body, 'Unprocessable');
  });

  it('normalizes unknown thrown values to 500 HttpError', async () => {
    const layer = new TestLayer();
    const res = mockRes();

    layer.get('/boom', () => {
      throw 'something weird';
    });
    layer.onError((err, _req, r) => {
      r.statusCode = err.status;
      r.end();
    });

    await layer.run('/boom', mockReq('GET', '/boom'), res);
    assert.equal(res.statusCode, 500);
  });

  it('propagates errors passed to next(err)', async () => {
    const layer = new TestLayer();
    const res = mockRes();

    layer.use((_req, _res, next) => {
      next(new HttpError(403, 'Forbidden'));
    });
    layer.get('/path', (_req, r) => r.end());
    layer.onError((err, _req, r) => {
      r.statusCode = err.status;
      r.end();
    });

    await layer.run('/path', mockReq('GET', '/path'), res);
    assert.equal(res.statusCode, 403);
  });

  it('normalizes a plain Error passed to next(err) to 500', async () => {
    const layer = new TestLayer();
    const res = mockRes();

    layer.use((_req, _res, next) => {
      next(new Error('plain error'));
    });
    layer.get('/path', (_req, r) => r.end());
    layer.onError((err, _req, r) => {
      r.statusCode = err.status;
      r.end(err.message);
    });

    await layer.run('/path', mockReq('GET', '/path'), res);
    assert.equal(res.statusCode, 500);
    assert.equal(res._body, 'plain error');
  });

  it('detects double next() and reports 500', async () => {
    const layer = new TestLayer();
    const res = mockRes();

    layer.get('/double', (_req, _res, next: NextFn) => {
      next();
      next();
    });
    layer.onError((err, _req, r) => {
      r.statusCode = err.status;
      r.end();
    });

    await layer.run('/double', mockReq('GET', '/double'), res);
    assert.equal(res.statusCode, 500);
  });

  // it('scoped onError does not bleed into parent layer', async () => {
  //   const parent = new TestLayer();
  //   const child = new TestLayer();
  //   const parentErrors: number[] = [];
  //   const childErrors: number[] = [];

  //   child.get('/boom', () => {
  //     throw new HttpError(422, 'child error');
  //   });
  //   child.onError((err, _req, r) => {
  //     childErrors.push(err.status);
  //     r.statusCode = err.status;
  //     r.end();
  //   });

  //   parent.use('/api', child);
  //   parent.onError((err, _req, r) => {
  //     parentErrors.push(err.status);
  //     r.statusCode = err.status;
  //     r.end();
  //   });

  //   await parent.run('/api/boom', mockReq('GET', '/api/boom'), mockRes());

  //   // Child error handler caught it — parent should not have fired
  //   assert.deepEqual(childErrors, [422]);
  //   assert.deepEqual(parentErrors, []);
  // });
});

describe('Layer — child layer mounting', () => {
  it('dispatches to a mounted child layer', async () => {
    const parent = new TestLayer();
    const child = new TestLayer();
    let called = false;

    child.get('/profile', (_req, res) => {
      called = true;
      res.end();
    });
    parent.use('/users', child);

    await parent.run(
      '/users/profile',
      mockReq('GET', '/users/profile'),
      mockRes(),
    );
    assert.equal(called, true);
  });

  it('strips the prefix before dispatching to the child', async () => {
    const parent = new TestLayer();
    const child = new TestLayer();
    let seenId = '';

    child.get('/:id', (req, res) => {
      seenId = (req.params as Record<string, string>)['id'] ?? '';
      res.end();
    });
    parent.use('/items', child);

    await parent.run('/items/99', mockReq('GET', '/items/99'), mockRes());
    assert.equal(seenId, '99');
  });

  it('returns 404 if child does not match', async () => {
    const parent = new TestLayer();
    const child = new TestLayer();
    const res = mockRes();

    child.get('/a', (_req, r) => r.end());
    parent.use('/api', child);
    parent.onError((err, _req, r) => {
      r.statusCode = err.status;
      r.end();
    });

    await parent.run('/api/b', mockReq('GET', '/api/b'), res);
    assert.equal(res.statusCode, 404);
  });

  it('bubbles 405 from child to parent error handler', async () => {
    const parent = new TestLayer();
    const child = new TestLayer();
    const res = mockRes();

    child.get('/resource', (_req, r) => r.end()); // only GET registered
    parent.use('/api', child);
    parent.onError((err, _req, r) => {
      r.statusCode = err.status;
      r.end();
    });

    await parent.run('/api/resource', mockReq('POST', '/api/resource'), res);
    assert.equal(res.statusCode, 405);
  });

  it('supports three levels of nesting', async () => {
    const app = new TestLayer();
    const api = new TestLayer();
    const users = new TestLayer();
    let capturedId = '';

    users.get('/:id', (req, res) => {
      capturedId = (req.params as Record<string, string>)['id'] ?? '';
      res.end();
    });
    api.use('/users', users);
    app.use('/api/v1', api);

    await app.run(
      '/api/v1/users/42',
      mockReq('GET', '/api/v1/users/42'),
      mockRes(),
    );
    assert.equal(capturedId, '42');
  });

  it('does not dispatch to child if prefix does not match', async () => {
    const parent = new TestLayer();
    const child = new TestLayer();
    let childCalled = false;

    child.get('/x', (_req, res) => {
      childCalled = true;
      res.end();
    });
    parent.use('/api', child);
    parent.get('/other/x', (_req, res) => res.end());

    await parent.run('/other/x', mockReq('GET', '/other/x'), mockRes());
    assert.equal(childCalled, false);
  });
});

describe('Layer — collectAllowedMethods', () => {
  it('returns methods registered on own routes', () => {
    const layer = new TestLayer();
    layer.get('/users', (_req, res) => res.end());
    layer.post('/users', (_req, res) => res.end());
    layer.delete('/users', (_req, res) => res.end());

    const allowed = layer.collectAllowedMethods('/users');
    assert.deepEqual(allowed, new Set(['GET', 'POST', 'DELETE']));
  });

  it('includes methods from child layers', () => {
    const parent = new TestLayer();
    const child = new TestLayer();

    child.get('/profile', (_req, res) => res.end());
    child.patch('/profile', (_req, res) => res.end());
    parent.use('/users', child);

    const allowed = parent.collectAllowedMethods('/users/profile');
    assert.ok(allowed.has('GET'));
    assert.ok(allowed.has('PATCH'));
  });

  it('returns empty set for a path that does not exist anywhere', () => {
    const layer = new TestLayer();
    layer.get('/users', (_req, res) => res.end());

    const allowed = layer.collectAllowedMethods('/posts');
    assert.equal(allowed.size, 0);
  });
});
