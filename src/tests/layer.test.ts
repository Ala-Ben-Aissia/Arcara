import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Layer } from '../Layer.js';
import { HttpError } from '../types.js';
import type { ArcaraRequest, ArcaraResponse, NextFn } from '../types.js';

// ── Concrete Layer subclass for testing ───────────────────────────────────────
// Layer is abstract — we need a concrete subclass to instantiate it.

class TestLayer extends Layer {
  // Expose dispatch publicly for direct testing
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
  const req = new http.IncomingMessage(null as any);
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

  it('short-circuits when middleware ends the response', async () => {
    const layer = new TestLayer();
    let handlerCalled = false;

    layer.use((_req, res, _next) => {
      res.end();
    }); // does not call next
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

  it('detects double next() and reports 500', async () => {
    const layer = new TestLayer();
    const res = mockRes();

    layer.get('/double', (_req, _res, next: NextFn) => {
      next();
      next(); // second call — should be detected
    });
    layer.onError((err, _req, r) => {
      r.statusCode = err.status;
      r.end();
    });

    await layer.run('/double', mockReq('GET', '/double'), res);
    assert.equal(res.statusCode, 500);
  });
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
    let seenPath = '';

    child.get('/:id', (req, res) => {
      seenPath = (req.params as Record<string, string>).id ?? '';
      res.end();
    });
    parent.use('/items', child);

    await parent.run('/items/99', mockReq('GET', '/items/99'), mockRes());
    assert.equal(seenPath, '99');
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
    parent.use('/users', child);

    const allowed = parent.collectAllowedMethods('/users/profile');
    assert.ok(allowed.has('GET'));
  });
});
