import { Arcara, HttpError, Router } from 'arcara';

const PORT = Number(process.argv[2]) || 3014;
const SCENARIO = process.argv[3] || 'hello';

const app = new Arcara({ startupLog: false });

// ── 1. Hello World ────────────────────────────────────────────────────────────
if (SCENARIO === 'hello') {
  app.get('/', (_req, res) => res.json({ message: 'hello' }));
}

// ── 2. Parameterized Route ────────────────────────────────────────────────────
if (SCENARIO === 'param') {
  app.get('/users/:id', (req, res) => res.json({ id: req.params.id }));
}

// ── 3. Middleware Chain ───────────────────────────────────────────────────────
if (SCENARIO === 'middleware') {
  app.use(
    (req, _res, next) => { req.startedAt = Date.now(); next(); },
    (req, _res, next) => { req.requestId = Math.random().toString(36).slice(2); next(); },
    (req, _res, next) => { req.user = { id: 'u1' }; next(); },
  );
  app.get('/', (_req, res) => res.json({ message: 'hello' }));
}

// ── 4. JSON Body Parsing ──────────────────────────────────────────────────────
// Real POST handler — exercises body parsing pipeline (Content-Type detection,
// stream read, JSON.parse). This is where Express pays heavy middleware cost
// (express.json()) and Arcara does it natively.
if (SCENARIO === 'body') {
  app.post('/users', (req, res) => {
    const body = req.body;
    res.status(201).json({ id: '42', name: body?.name ?? 'unknown' });
  });
}

// ── 5. Deep Param Route ───────────────────────────────────────────────────────
// Exercises multi-segment radix traversal + multi-param extraction.
// Maps closer to real REST APIs: /orgs/:orgId/repos/:repoId/issues/:issueId
if (SCENARIO === 'deep-param') {
  app.get('/orgs/:orgId/repos/:repoId/issues/:issueId', (req, res) => {
    const { orgId, repoId, issueId } = req.params;
    res.json({ orgId, repoId, issueId });
  });
}

// ── 6. Query String Parsing ───────────────────────────────────────────────────
// Exercises URL parsing + query object construction.
// GET /search?q=hello&limit=10&offset=0
if (SCENARIO === 'query') {
  app.get('/search', (req, res) => {
    const { q = '', limit = '10', offset = '0' } = req.query;
    res.json({ q, limit: Number(limit), offset: Number(offset), results: [] });
  });
}

// ── 7. Sub-Router ─────────────────────────────────────────────────────────────
// Real-world apps always use sub-routers. This exercises mount + prefix strip
// + nested radix lookup — not just a flat route match.
if (SCENARIO === 'router') {
  const users = new Router();
  users.get('/:id', (req, res) => res.json({ id: req.params.id }));
  users.post('/', (req, res) => res.status(201).json({ id: '42', ...req.body }));

  const api = new Router();
  api.use('/users', users);

  app.use('/api/v1', api);
}

// ── 8. Error Handling ─────────────────────────────────────────────────────────
// Measures cost of the error propagation path: throw → catch → onError → res.
// Important to benchmark — error handling in hot paths (auth, validation)
// is not free.
if (SCENARIO === 'error') {
  app.get('/protected', (_req) => {
    throw new HttpError(401, 'Unauthorized');
  });

  app.onError((err, _req, res) => {
    res.status(err.status ?? 500).json({ error: err.message });
  });
}

app.listen(PORT, '127.0.0.1');
