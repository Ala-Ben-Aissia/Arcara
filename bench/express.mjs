import express from 'express';

const PORT = Number(process.argv[2]) || 3015;
const SCENARIO = process.argv[3] || 'hello';

const app = express();

if (SCENARIO === 'hello') {
  app.get('/', (_req, res) => res.json({ message: 'hello' }));
}

if (SCENARIO === 'param') {
  app.get('/users/:id', (req, res) => res.json({ id: req.params.id }));
}

if (SCENARIO === 'middleware') {
  app.use(
    (_req, _res, next) => { _req.startedAt = Date.now(); next(); },
    (_req, _res, next) => { _req.requestId = Math.random().toString(36).slice(2); next(); },
    (_req, _res, next) => { _req.user = { id: 'u1' }; next(); },
  );
  app.get('/', (_req, res) => res.json({ message: 'hello' }));
}

if (SCENARIO === 'body') {
  app.use(express.json());
  app.post('/users', (req, res) => {
    res.status(201).json({ id: '42', name: req.body?.name ?? 'unknown' });
  });
}

if (SCENARIO === 'deep-param') {
  app.get('/orgs/:orgId/repos/:repoId/issues/:issueId', (req, res) => {
    const { orgId, repoId, issueId } = req.params;
    res.json({ orgId, repoId, issueId });
  });
}

if (SCENARIO === 'query') {
  app.get('/search', (req, res) => {
    const { q = '', limit = '10', offset = '0' } = req.query;
    res.json({ q, limit: Number(limit), offset: Number(offset), results: [] });
  });
}

if (SCENARIO === 'router') {
  const users = express.Router();
  users.get('/:id', (req, res) => res.json({ id: req.params.id }));
  users.post('/', express.json(), (req, res) => res.status(201).json({ id: '42', ...req.body }));
  app.use('/api/v1/users', users);
}

if (SCENARIO === 'error') {
  app.get('/protected', (_req, _res, next) => {
    const err = new Error('Unauthorized');
    err.status = 401;
    next(err);
  });
  app.use((err, _req, res, _next) => {
    res.status(err.status ?? 500).json({ error: err.message });
  });
}

app.listen(PORT, '127.0.0.1');
