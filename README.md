# Arcara

[![npm version](https://img.shields.io/npm/v/arcara)](https://npmjs.com/package/arcara)
[![npm downloads](https://img.shields.io/npm/dm/arcara)](https://npmjs.com/package/arcara)
[![license](https://img.shields.io/npm/l/arcara)](./LICENSE)

A TypeScript-first, zero-runtime-dependency Node.js HTTP framework.

Radix-tree routing. Full type inference. Minimal, composable middleware.

**No setup. No config. Just import and go.**

---

## Why Arcara?

- ⚡ Radix-tree routing (fast path matching)
- 🧠 Full type inference for route params (no generics, no casting)
- 🪶 Zero runtime dependencies
- 🔌 Minimal, fully composable middleware model
- 📦 No config, no code generation

If you like Express but want stronger typing and less overhead, Arcara is a natural upgrade.

---

## Requirements

- Node.js 18+

---

## Install

```bash
npm install arcara
```

Node types are included — no `@types/node`, no `tsconfig` changes required.

---

## Quick Start

```ts
import { Arcara, HttpError } from 'arcara';

const app = new Arcara();

app.use((req, _res, next) => {
  console.log(req.method, req.url);
  next();
});

app.get('/users/:id', (req, res) => {
  res.json({ id: req.params.id });
  // req.params.id is inferred as string — no casting needed
});

app.post('/users', (req, res) => {
  res.status(201).json(req.body);
  // req.body is parsed JSON for POST/PUT/PATCH (application/json)
});

app.onError((err, _req, res) => {
  res.status(err.status).json({ error: err.message });
  // err is always normalized to HttpError internally
});

app.listen(3000, () => console.log('Listening on :3000'));
```

---

## API

### Application

```ts
import { Arcara } from 'arcara';

const app = new Arcara();

app.listen(3000);
// start server on port 3000

app.listen(3000, '0.0.0.0', () => {});
// with host + optional callback
```

---

### Routing

```ts
app.get(path, ...handlers);
app.post(path, ...handlers);
app.put(path, ...handlers);
app.patch(path, ...handlers);
app.delete(path, ...handlers);
```

Path params are inferred from the route string:

```ts
app.get('/orgs/:orgId/repos/:repoId', (req, res) => {
  const { orgId, repoId } = req.params;
  // both are typed as string
});
```

---

### Handlers

```ts
type Handler = (
  req,
  res,
  next?,
) => void | ArcaraResponse | Promise<void | ArcaraResponse>;
```

```ts
app.get('/ping', (req, res) => {
  return res.json({ ok: true });
  // returning is optional but supported
});

app.get('/data', async (req, res) => {
  const data = await fetchSomething();
  return res.json(data);
  // works the same in async handlers
});
```

---

### Middleware

```ts
app.use(handler);
// runs on every request

app.use('/prefix', handler);
// runs only when URL starts with /prefix

app.use('/prefix', router);
// mount a sub-router under /prefix
```

**The prefix is stripped from `req.url` before your handler sees it.**
// a middleware mounted at `/static` receives `/logo.png`, not `/static/logo.png`

---

### Sub-Routers

```ts
import { Router } from 'arcara';

const users = new Router();

users.get('/:id', (req, res) => {
  res.json({ id: req.params.id });
});

users.post('/', (req, res) => {
  res.status(201).json(req.body);
});

users.delete('/:id', (req, res) => {
  res.status(204).end();
});

app.use('/users', users);
// /users/:id → handled inside the router as /:id
```

Routers can be nested infinitely.

---

### Response Helpers

```ts
res.status(201).json({ created: true });
// sets status + JSON + ends response

res.send('plain text');
// auto Content-Type + Content-Length

res.send(buffer);
// Buffer / Uint8Array / ArrayBuffer supported

res.send({ key: 'value' });
// object → JSON automatically
```

---

### Error Handling

```ts
app.onError((err, req, res) => {
  res.status(err.status).json({ error: err.message });
});
```

Ways to trigger the error handler:

```ts
throw new HttpError(400, 'Bad request');
// explicit error with status + message

next(new HttpError(400, 'Bad request'));
// pass error to the pipeline

return res.status(400).json({ error: 'Bad request' });
// bypass error handler entirely
```

```ts
throw new HttpError(422, 'Validation failed', {
  field: 'email',
  reason: 'invalid format',
});
// optional third argument for extra details
```

Scoped error handling per router:

```ts
const api = new Router();

api.onError((err, _req, res) => {
  res.status(err.status).json({ error: err.message, code: err.status });
});

app.use('/api', api);
```

---

### Request Behavior

| Feature      | Behavior                                               |
| ------------ | ------------------------------------------------------ |
| `req.body`   | Parsed for JSON (`application/json`) on POST/PUT/PATCH |
| `req.params` | Fully typed from route string                          |
| `HEAD`       | Automatically handled via GET                          |
| 405          | Returned when path exists but method does not          |

---

### Static Files

```ts
import { serveStatic } from 'arcara';

app.use(serveStatic('./public'));
// serves at root → /logo.png maps to ./public/logo.png

app.use('/static', serveStatic('./assets'));
// mount via router → prefix stripped before serveStatic sees req.url

app.use(serveStatic('public', { index: 'app.html' }));
// use app.html instead of index.html when accessing a directory (e.g. / → app.html)
```

**Features:**

- Safe path resolution (prevents directory traversal)
- Directory index fallback (`/about/` → `about/index.html`)
- MIME type detection (with fallback for unknown extensions)
- `ETag` / `Last-Modified` headers (`304 Not Modified` support)
- `HEAD` request handling
- Streaming via `pipeline` (efficient file serving)

---

### Example

```ts
const requireAuth = (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    throw new HttpError(401, 'Unauthorized');
  }

  req.user = verifyToken(token);
  next();
};

app.use('/api', requireAuth);
// all /api routes require authentication

app.get('/api/profile', (req, res) => {
  res.json({ user: req.user });
});
```

---

## Contributing

Open an issue before submitting large changes.
Keep PRs focused, include tests, and follow the existing style.

---

## License

MIT © 2026 Ala Ben Aissia
