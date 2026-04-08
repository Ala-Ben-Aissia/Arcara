# Arcara

[![npm version](https://img.shields.io/npm/v/arcara)](https://npmjs.com/package/arcara)
[![npm downloads](https://img.shields.io/npm/dm/arcara)](https://npmjs.com/package/arcara)
[![license](https://img.shields.io/npm/l/arcara)](./LICENSE)

A TypeScript-first, zero-runtime-dependency Node.js HTTP framework — radix-tree routing, full type inference on path params, and a minimal but complete middleware model.

No code generation. No config files. Just import and go.

## Install

```bash
npm install arcara
```

Node types ship with the package. No additional setup — no `@types/node` install, no `tsconfig` changes required.

## Quick Start

```ts
import { Arcara, HttpError } from 'arcara';

const app = new Arcara();

app.use((req, _res, next) => {
  console.log(req.method, req.url);
  next();
});

app.get('/users/:id', (req, res) => {
  res.json({ id: req.params.id }); // req.params.id is string, not any
});

app.post('/users', (req, res) => {
  res.status(201).json(req.body);
});

app.onError((err, _req, res) => {
  res.status(err.status).json({ error: err.message });
});

app.listen(3000, () => console.log('Listening on :3000'));
```

## API

### Application

```ts
import { Arcara } from 'arcara';
const app = new Arcara();

app.listen(3000); // start server
app.listen(3000, '0.0.0.0', cb); // with host + callback
await app.close(); // graceful shutdown
```

### Routing

```ts
app.get(path, ...handlers);
app.post(path, ...handlers);
app.put(path, ...handlers);
app.patch(path, ...handlers);
app.delete(path, ...handlers);
```

Path params are statically inferred from the route string — no casting, no `any`:

```ts
app.get('/orgs/:orgId/repos/:repoId', (req, res) => {
  const { orgId, repoId } = req.params; // both typed as string
});
```

Handler signature:

```ts
type Handler = (
  req,
  res,
  next?,
) => void | ArcaraResponse | Promise<void | ArcaraResponse>;
```

Returning `res.json()` or `res.send()` works in both sync and async handlers:

```ts
app.get('/ping', (req, res) => res.json({ ok: true }));

app.get('/data', async (req, res) => {
  const data = await fetchSomething();
  return res.json(data);
});
```

### Middleware

```ts
app.use(handler); // global — runs on every request
app.use('/prefix', handler); // prefix-scoped — runs when URL starts with /prefix
app.use('/prefix', router); // mount a sub-router
```

The prefix is stripped from `req.url` before your handler sees it. A middleware mounted at `/static` receives `/logo.png`, not `/static/logo.png`.

### Sub-Routers

```ts
import { Router } from 'arcara';

const users = new Router();

users.get('/:id', (req, res) => res.json({ id: req.params.id }));
users.post('/', (req, res) => res.status(201).json(req.body));
users.delete('/:id', (req, res) => res.status(204).end());

app.use('/users', users);
```

Routers compose infinitely — a router can mount other routers.

### Response Helpers

```ts
res.status(201).json({ created: true }); // sets Content-Type, ends response
res.send('plain text'); // auto Content-Type + Content-Length
res.send(buffer); // Buffer / Uint8Array / ArrayBuffer
res.send({ key: 'value' }); // object → JSON
```

### Error Handling

Arcara normalizes every thrown value or `next(err)` call into an `HttpError` before reaching your error handler:

```ts
app.onError((err, req, res) => {
  res.status(err.status).json({ error: err.message });
});
```

Ways to trigger the error handler from inside a handler:

```ts
// 1. Throw an HttpError — full control over status + message
throw new HttpError(400, 'Bad request');

// 2. Pass any error to next()
next(new HttpError(400, 'Bad request'));

// 3. Respond directly and bypass the error handler entirely
return res.status(400).json({ error: 'Bad request' });
```

`HttpError` always carries `status: number` and `message: string`. Pass a third argument for additional details:

```ts
throw new HttpError(422, 'Validation failed', {
  field: 'email',
  reason: 'invalid format',
});
```

Scoped error handling per router:

```ts
const api = new Router();

api.onError((err, _req, res) => {
  res.status(err.status).json({ error: err.message, code: err.status });
});

app.use('/api', api);
```

### Static Files

```ts
import { serveStatic } from 'arcara';

app.use(serveStatic('./public')); // serve at /
app.use('/static', serveStatic('./assets')); // serve at /static
app.use(serveStatic('./assets', { prefix: '/static' })); // same as 👆
app.use(serveStatic('public', { index: 'app.html' })); // use app.html as the default file instead of index.html when accessing the root
```

The middleware handles safe path resolution, directory index fallback (`/about/` → `about/index.html`), extension-based MIME types with magic-byte sniffing for unknown extensions, `ETag` / `Last-Modified` headers with `304 Not Modified` support, `HEAD` requests, and streaming via `pipeline`.

### Behavior Reference

| Behavior            | Detail                                                                        |
| ------------------- | ----------------------------------------------------------------------------- |
| `HEAD` requests     | Automatically handled by the `GET` handler — no duplication needed            |
| `req.body`          | Populated for `POST`, `PUT`, `PATCH` — `undefined` for other methods          |
| `req.params`        | Typed from the route string literal at compile time                           |
| Method mismatch     | Returns `405 Method Not Allowed` when the path exists but the method doesn't  |
| Error normalization | Any thrown value or `next(err)` call reaches `onError` as a typed `HttpError` |

## Examples

**Auth middleware:**

```ts
const requireAuth: Middleware = (req, res, next) => {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  if (!token) throw new HttpError(401, 'Unauthorized');
  req.user = verifyToken(token);
  next();
};

app.use('/api', requireAuth);
```

**Multiple handlers on a route:**

```ts
app.post('/admin/users', requireAuth, requireAdmin, createUser);
```

## Contributing

Open an issue before submitting large changes. Keep PRs focused, include tests for new behavior, and follow the existing style: TypeScript, zero runtime dependencies.

## License

[MIT](./LICENSE) © 2026 Ala Ben Aissia
