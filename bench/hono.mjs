import { serve } from '@hono/node-server';
import { Hono } from 'hono';

const PORT = Number(process.argv[2]) || 3013;
const SCENARIO = process.argv[3] || 'hello';

const app = new Hono();

if (SCENARIO === 'hello') {
  app.get('/', (c) => c.json({ message: 'hello' }));
}

if (SCENARIO === 'param') {
  app.get('/users/:id', (c) => c.json({ id: c.req.param('id') }));
}

if (SCENARIO === 'middleware') {
  app.use(async (c, next) => { c.set('startedAt', Date.now()); await next(); });
  app.use(async (c, next) => { c.set('requestId', Math.random().toString(36).slice(2)); await next(); });
  app.use(async (c, next) => { c.set('user', { id: 'u1' }); await next(); });
  app.get('/', (c) => c.json({ message: 'hello' }));
}

if (SCENARIO === 'body') {
  app.post('/users', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    return c.json({ id: '42', name: body?.name ?? 'unknown' }, 201);
  });
}

if (SCENARIO === 'deep-param') {
  app.get('/orgs/:orgId/repos/:repoId/issues/:issueId', (c) => {
    return c.json({
      orgId: c.req.param('orgId'),
      repoId: c.req.param('repoId'),
      issueId: c.req.param('issueId'),
    });
  });
}

if (SCENARIO === 'query') {
  app.get('/search', (c) => {
    const q = c.req.query('q') ?? '';
    const limit = c.req.query('limit') ?? '10';
    const offset = c.req.query('offset') ?? '0';
    return c.json({ q, limit: Number(limit), offset: Number(offset), results: [] });
  });
}

if (SCENARIO === 'router') {
  const users = new Hono();
  users.get('/:id', (c) => c.json({ id: c.req.param('id') }));
  users.post('/', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    return c.json({ id: '42', ...body }, 201);
  });
  app.route('/api/v1/users', users);
}

if (SCENARIO === 'error') {
  app.get('/protected', () => {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' });
