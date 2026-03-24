import { Arcara, ArcaraError, Router } from '../index.js';

const app = new Arcara();

// ── Global middleware ─────────────────────────────────────────────────────────

app.use((req, _res, next) => {
  console.log(`→ ${req.method} ${req.url}`);
  next();
});

// ── Root routes ───────────────────────────────────────────────────────────────

app.get('/', (_req, res) => {
  res.json({ name: 'arcara', status: 'ok' });
});

app.get('/health', (_req, res) => {
  res.status(200).json({ healthy: true });
});

// ── Body parsing ──────────────────────────────────────────────────────────────

app.post('/echo', (req, res) => {
  res.status(201).json({ received: req.body });
});

// ── Error throwing ────────────────────────────────────────────────────────────

app.get('/boom', () => {
  throw new ArcaraError(503, 'Service temporarily unavailable');
});

app.get('/crash', () => {
  throw new Error('Something unexpected happened');
});

// ── Mounted router with nested params and scoped error handler ────────────────

const api = new Router();

api.onError((err, _req, res) => {
  // Scoped — only handles errors thrown inside this router
  res.statusCode = err.status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ apiError: err.message, status: err.status }));
});

// Prefix-scoped middleware — runs for all /api/* routes
api.use('/users', (_req, _res, next) => {
  console.log('  users middleware');
  next();
});

api.get('/users', (_req, res) => {
  res.json({
    users: [
      { id: '1', name: 'Alice' },
      { id: '2', name: 'Bob' },
    ],
  });
});

api.get('/users/:userId', (req, res) => {
  // req.params.userId is inferred as string — TypeScript knows it exists
  res.json({ userId: req.params.userId });
});

api.post('/users/:userId/posts', (req, res) => {
  res.status(201).json({
    userId: req.params.userId,
    post: req.body,
  });
});

// Nested params — orgId comes from the mount prefix, resourceId from the route
const nested = new Router();

nested.get('/:resourceId', (req, res) => {
  res.json({
    orgId: req.params.orgId,
    resourceId: req.params.resourceId,
  });
});

app.use('/api', api);

api.use('/orgs/:orgId/resources', nested);

// Scoped error inside api router
api.get('/secret', () => {
  throw new ArcaraError(403, 'Forbidden');
});

// ── Send variants ─────────────────────────────────────────────────────────────

app.get('/text', (_req, res) => {
  res.send('Hello, world!');
});

app.get('/html', (_req, res) => {
  res.send('<html><body><h1>Hello</h1></body></html>');
});

app.get('/buffer', (_req, res) => {
  res.send(Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG magic bytes
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(3000, 'localhost');

/*
Try it:
  curl http://localhost:3000/
  curl http://localhost:3000/health
  curl -X POST http://localhost:3000/echo -H 'content-type: application/json' -d '{"hello":"world"}'
  curl http://localhost:3000/boom
  curl http://localhost:3000/crash
  curl http://localhost:3000/api/users
  curl http://localhost:3000/api/users/42
  curl -X POST http://localhost:3000/api/users/42/posts -H 'content-type: application/json' -d '{"title":"hello"}'
  curl http://localhost:3000/api/orgs/org-1/resources/res-99
  curl http://localhost:3000/api/secret
  curl http://localhost:3000/text
  curl http://localhost:3000/html
  curl -X OPTIONS http://localhost:3000/api/users
*/
