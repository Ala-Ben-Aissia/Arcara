import Fastify from 'fastify';

const PORT = Number(process.argv[2]) || 3012;
const SCENARIO = process.argv[3] || 'hello';

const app = Fastify({ logger: false });

if (SCENARIO === 'hello') {
  app.get('/', async () => ({ message: 'hello' }));
}

if (SCENARIO === 'param') {
  app.get('/users/:id', async (req) => ({ id: req.params.id }));
}

if (SCENARIO === 'middleware') {
  app.addHook('onRequest', async (req) => { req.startedAt = Date.now(); });
  app.addHook('onRequest', async (req) => { req.requestId = Math.random().toString(36).slice(2); });
  app.addHook('onRequest', async (req) => { req.user = { id: 'u1' }; });
  app.get('/', async () => ({ message: 'hello' }));
}

if (SCENARIO === 'body') {
  app.post('/users', async (req) => {
    const body = req.body;
    return { id: '42', name: body?.name ?? 'unknown' };
  });
}

if (SCENARIO === 'deep-param') {
  app.get('/orgs/:orgId/repos/:repoId/issues/:issueId', async (req) => {
    const { orgId, repoId, issueId } = req.params;
    return { orgId, repoId, issueId };
  });
}

if (SCENARIO === 'query') {
  app.get('/search', async (req) => {
    const { q = '', limit = '10', offset = '0' } = req.query;
    return { q, limit: Number(limit), offset: Number(offset), results: [] };
  });
}

if (SCENARIO === 'router') {
  // Fastify uses plugins for sub-routers
  app.register(async (instance) => {
    instance.get('/:id', async (req) => ({ id: req.params.id }));
    instance.post('/', async (req) => ({ id: '42', ...req.body }));
  }, { prefix: '/api/v1/users' });
}

if (SCENARIO === 'error') {
  app.get('/protected', async () => {
    const err = new Error('Unauthorized');
    err.statusCode = 401;
    throw err;
  });
}

await app.listen({ port: PORT, host: '127.0.0.1' });
