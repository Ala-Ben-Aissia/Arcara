import http from 'node:http';

const PORT = Number(process.argv[2]) || 3011;
const SCENARIO = process.argv[3] || 'hello';

// Pre-serialized static responses — avoids per-request JSON.stringify
const helloBody = JSON.stringify({ message: 'hello' });
const helloLen = Buffer.byteLength(helloBody);

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

// NOTE: Raw Node.js routing is hardcoded per-scenario — no radix tree,
// no middleware abstraction. This is a throughput ceiling, not a fair
// comparison for routing or middleware scenarios.

let handler;

if (SCENARIO === 'hello') {
  handler = (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': helloLen });
    res.end(helloBody);
  };
}

if (SCENARIO === 'param') {
  // Hardcoded positional split — no radix lookup
  handler = (req, res) => {
    const id = req.url.split('/')[2] ?? '';
    json(res, 200, { id });
  };
}

if (SCENARIO === 'middleware') {
  handler = (_req, res) => {
    // Inline — no middleware chain overhead
    const _startedAt = Date.now();
    const _requestId = Math.random().toString(36).slice(2);
    const _user = { id: 'u1' };
    void _startedAt; void _requestId; void _user;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': helloLen });
    res.end(helloBody);
  };
}

if (SCENARIO === 'body') {
  handler = async (req, res) => {
    const body = await readBody(req);
    json(res, 201, { id: '42', name: body?.name ?? 'unknown' });
  };
}

if (SCENARIO === 'deep-param') {
  // Hardcoded split — no real routing
  handler = (req, res) => {
    const parts = req.url.split('/');
    json(res, 200, { orgId: parts[2] ?? '', repoId: parts[4] ?? '', issueId: parts[6] ?? '' });
  };
}

if (SCENARIO === 'query') {
  handler = (req, res) => {
    const u = new URL(req.url, 'http://x');
    const q = u.searchParams.get('q') ?? '';
    const limit = u.searchParams.get('limit') ?? '10';
    const offset = u.searchParams.get('offset') ?? '0';
    json(res, 200, { q, limit: Number(limit), offset: Number(offset), results: [] });
  };
}

if (SCENARIO === 'router') {
  // Hardcoded path dispatch — no router abstraction
  handler = async (req, res) => {
    if (req.method === 'GET' && req.url.startsWith('/api/v1/users/')) {
      const id = req.url.split('/')[5] ?? '';
      json(res, 200, { id });
    } else if (req.method === 'POST' && req.url === '/api/v1/users') {
      const body = await readBody(req);
      json(res, 201, { id: '42', ...body });
    } else {
      json(res, 404, { error: 'Not Found' });
    }
  };
}

if (SCENARIO === 'error') {
  handler = (_req, res) => {
    json(res, 401, { error: 'Unauthorized' });
  };
}

http.createServer(handler).listen(PORT, '127.0.0.1');
