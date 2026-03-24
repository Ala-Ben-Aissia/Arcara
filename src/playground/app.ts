/**
 * Arcara Test Server
 *
 * Drop this next to your src/ and run:
 *   npx tsx test-server.ts
 *
 * Covers:
 *   - Global middleware (request ID injection)
 *   - Prefixed middleware (/api only)
 *   - CRUD routes with dynamic params + query
 *   - Mounted Router with its own onError
 *   - Chained handlers (auth → handler)
 *   - Body parsing: JSON + form-urlencoded
 *   - Forced 4xx/5xx error paths
 *   - Double-next() detection
 *   - HEAD / OPTIONS introspection
 */

import { Arcara, Middleware, Router } from '../index';

// ── Fake DB ──────────────────────────────────────────────────────────────────

const users = new Map([
  ['1', { id: '1', name: 'Alice', role: 'admin' }],
  ['2', { id: '2', name: 'Bob', role: 'user' }],
]);

// ── Auth middleware (simulated) ──────────────────────────────────────────────

const requireAuth: Middleware = (req, res, next) => {
  const token = req.headers['x-api-key'];
  if (!token || token !== 'secret') {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// ── Root app ─────────────────────────────────────────────────────────────────

const app = new Arcara();

// Global middleware — stamps every request with a correlation ID
// app.use((req, _res, next) => {
//   (req as any).requestId = Math.random().toString(36).slice(2, 10);
//   console.log(`[${(req as any).requestId}] ${req.method} ${req.url}`);
//   next();
// });

// Prefixed middleware — only runs under /api
app.use('/api', (_req, res, next) => {
  res.setHeader('x-powered-by', 'Arcara');
  next();
});

// ── Health ───────────────────────────────────────────────────────────────────

app.get('/', (_req, res) => {
  res.json({ status: 'ok', framework: 'Arcara' });
});

// ── Users router ─────────────────────────────────────────────────────────────

const usersRouter = new Router();

// Router-level error handler (overrides default for this sub-tree)
usersRouter.onError((err, _req, res) => {
  res.statusCode = err.status ?? 500;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ error: err.message, source: 'usersRouter' }));
});

// GET /api/users?role=admin
usersRouter.get('/users', (req, res) => {
  const role = req.query?.role;
  const result = role
    ? [...users.values()].filter((u) => u.role === role)
    : [...users.values()];
  res.json(result);
});

// GET /api/users/:id
usersRouter.get('/users/:id', (req, res) => {
  const user = users.get(req.params.id);
  if (!user) res.status(404).json({ error: 'User not found' });
  else res.json(user);
});

// POST /api/users  (requires auth, reads JSON body)
usersRouter.post('/users', requireAuth, (req, res) => {
  const { name, role } = req.body as { name: string; role: string };
  if (!name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  const id = String(users.size + 1);
  const user = { id, name, role: role ?? 'user' };
  users.set(id, user);
  res.status(201).json(user);
});

// PUT /api/users/:id
usersRouter.put('/users/:id', requireAuth, (req, res) => {
  const user = users.get(req.params.id);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  const updated = { ...user, ...(req.body as object) };
  users.set(req.params.id, updated);
  res.json(updated);
});

// DELETE /api/users/:id
usersRouter.delete('/users/:id', requireAuth, (req, res) => {
  if (!users.delete(req.params.id)) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  res.status(204).json(null);
});

// Mount router
app.use('/api', usersRouter);

// ── Error-trigger routes (for manual testing) ─────────────────────────────────

// Force a 500 via thrown error
app.get('/debug/crash', (_req, _res) => {
  throw new Error('Intentional crash — testing 500 path');
});

// Force a 400 via ArcaraError
app.get('/debug/bad-request', (_req, res) => {
  res.status(400).json({ error: 'Intentional 400' });
});

// Double next() — should surface as 500 with framework message
app.get('/debug/double-next', (_req, _res, next) => {
  next();
  next(); // second call — should trigger ArcaraError 500
});

// ── Form body test ────────────────────────────────────────────────────────────

app.post('/form', (req, res) => {
  res.send({ received: req.body });
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(3000, 'localhost');
