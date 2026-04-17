# Arcara

[![npm version](https://img.shields.io/npm/v/arcara)](https://npmjs.com/package/arcara)
[![npm downloads](https://img.shields.io/npm/dm/arcara)](https://npmjs.com/package/arcara)
[![license](https://img.shields.io/npm/l/arcara)](./LICENSE)

A TypeScript-first, zero-runtime-dependency HTTP framework for Node.js.

Radix-tree routing. Compile-time param inference. Minimal, composable middleware.

---

## Why Arcara?

- ⚡ **Fast routing** — Radix tree, O(k) path matching
- 🧠 **Type-safe by default** — route params inferred from path string literals, no generics needed
- 🪶 **Zero runtime dependencies** — no runtime deps, just Node.js
- 🔌 **Familiar API** — Express-like middleware model, easier to reason about
- 📦 **Batteries included** — body parsing, static files, error handling, redirects

> If you like Express but want compile-time safety and less overhead, Arcara is a natural upgrade.

---

> **Early development notice**  
> Arcara is currently `0.x.x`. The API is stable enough for real use but may evolve between minor versions.

---

## Install

```bash
npm install arcara
```

Arcara requires `@types/node` for TypeScript support and declares it as a peer dependency.

Arcara's own exported types may work without it, but for a normal Node.js
TypeScript project, you should install Node's type definitions in your app —
especially if you use built-in modules like `node:buffer` or `node:os`, or
augment Node request/response types:

```bash
npm install -D @types/node
```

---

## Quick Start

```ts
import { Arcara, HttpError } from 'arcara';

const app = new Arcara();

app.use((req, _res, next) => {
  console.log(req.method, req.url);
  next();
});

// Params are inferred from the path string — no annotation needed
app.get('/users/:id', (req, res) => {
  res.json({ id: req.params.id });
});

app.post('/users', (req, res) => {
  res.status(201).json(req.body);
});

app.onError((err, _req, res) => {
  res.status(err.status).json({ error: err.message });
});

app.listen(3000);
```

---

## Configuration

```ts
const app = new Arcara({
  bodyLimit: 5_000_000, // Max request body in bytes. Default: 1MB
  timeout: 60_000, // Request timeout in ms. Default: 30s
  startupLog: false, // Suppress the startup message. Default: true
});
```

---

## Routing

All standard HTTP methods are supported. Path parameters are typed automatically
from the registered path string — no generics, no casting.

```ts
app.get('/users/:id', (req, res) => {
  res.json({ id: req.params.id }); // id: string ✓
});

app.get('/orgs/:orgId/repos/:repoId', (req, res) => {
  const { orgId, repoId } = req.params; // both typed as string ✓
  res.json({ orgId, repoId });
});
```

Multiple handlers per route for inline middleware composition:

```ts
const validateId: Middleware = (req, _res, next) => {
  if (!/^\d+$/.test(req.params.id)) throw new HttpError(400, 'Invalid ID');
  next();
};

app.delete('/users/:id', requireAuth, validateId, (req, res) => {
  return res.status(204);
});
```

---

## Middleware

```ts
// Global — runs on every request
app.use((req, res, next) => {
  console.log(req.method, req.url);
  next();
});

// Prefix-scoped — runs only when the path starts with /api
app.use('/api', (req, res, next) => {
  if (!req.headers.authorization) throw new HttpError(401, 'Unauthorized');
  next();
});
```

Middleware contract:

- Call `next()` exactly once.
- Either call `next()` synchronously, or `await` your async work first and then call `next()`.
- Callback-style deferred continuation like `setTimeout(next, 0)` or event-listener-based `next()` is not supported.
- If a middleware does not call `next()`, Arcara treats it as terminal and stops the chain.

> Prefixes are stripped from `req.url` before handlers run.  
> A middleware mounted at `/api` receives `/users`, not `/api/users`.

---

## Sub-Routers

Organize routes into self-contained, mountable modules:

```ts
import { Router } from 'arcara';

const users = new Router();

users.get('/:id', (req, res) => res.json({ id: req.params.id }));
users.post('/', (req, res) => res.status(201).json(req.body));
users.delete('/:id', (req, res) => res.status(204);

app.use('/users', users);
// GET /users/42 → users.get('/:id')
```

Routers nest arbitrarily:

```ts
const v1 = new Router();
v1.get('/health', (_req, res) => res.json({ ok: true }));

const api = new Router();
api.use('/v1', v1);

app.use('/api', api);
// GET /api/v1/health ✓
```

Routers can declare their own error handlers, scoped to their routes:

```ts
api.onError((err, _req, res) => {
  res.status(err.status).json({ error: err.message, code: err.status });
});
```

---

## Request

| Property      | Type                     | Description                                          |
| ------------- | ------------------------ | ---------------------------------------------------- |
| `req.params`  | `Record<string, string>` | Named route params, inferred from the path literal   |
| `req.query`   | `Record<string, string>` | Parsed query string                                  |
| `req.body`    | `unknown`                | Parsed body (POST/PUT/PATCH). `undefined` otherwise  |
| `req.cookies` | `Record<string, string>` | Parsed cookies. Requires `arcara/cookies` middleware |

**Body parsing** is automatic for `POST`, `PUT`, `PATCH` based on `Content-Type`:

| Content-Type                        | Parsed as                |
| ----------------------------------- | ------------------------ |
| `application/json`                  | `object`                 |
| `application/x-www-form-urlencoded` | `Record<string, string>` |
| `text/*`                            | `string`                 |
| anything else                       | `Buffer`                 |

Requests exceeding `bodyLimit` receive `413 Payload Too Large`.  
Requests exceeding `timeout` receive `408 Request Timeout`.  
`HEAD` requests are handled automatically via the matching `GET` route.

---

## Response

**Fluent helpers:**

```ts
res.status(201).json({ created: true });

res.send('plain text'); // → text/plain
res.send('<h1>Hello</h1>'); // → text/html (auto-detected)
res.send(buffer); // → application/octet-stream or sniffed MIME
res.send({ key: 'value' }); // → application/json

res.status(204);
```

**Redirects:**

```ts
res.redirect('/dashboard'); // 302
res.redirect(301, '/new-location'); // permanent
res.redirect(303, '/success'); // post-redirect-get

// Redirects to Referer if same-origin, otherwise to the fallback
res.redirect.back(req, res, '/home');
```

Redirect targets must be absolute paths (`/path`). External URLs are rejected
to prevent open redirect vulnerabilities.

---

## Error Handling

Throw `HttpError` anywhere in a handler or middleware — Arcara catches and forwards it:

```ts
app.get('/admin', (req, res) => {
  if (!req.headers.authorization) throw new HttpError(401, 'Unauthorized');
  res.json({ ok: true });
});
```

Pass errors to `next()` from async middleware:

```ts
app.use(async (req, res, next) => {
  try {
    req.user = await verifyToken(req.headers.authorization);
    next();
  } catch (e) {
    next(new HttpError(401, 'Invalid token'));
  }
});
```

This is supported because the middleware's own Promise does not resolve until
after `await verifyToken(...)` completes. What is not supported is calling
`next()` later from an unrelated callback after the middleware has already
returned.

Attach structured details for validation errors:

```ts
throw new HttpError(422, 'Validation failed', {
  field: 'email',
  reason: 'Invalid format',
});

app.onError((err, _req, res) => {
  res.status(err.status).json({
    error: err.message,
    details: err.details, // { field: 'email', reason: '...' }
  });
});
```

Any thrown value (including plain `Error`) is normalized to `HttpError`.

---

## Static Files

```ts
import { serveStatic } from 'arcara/static';

app.use(serveStatic('./public'));
// GET /logo.png → ./public/logo.png

app.use('/assets', serveStatic('./dist'));
// GET /assets/app.js → ./dist/app.js
```

**Cache control:**

```ts
// Long-lived immutable assets (hashed filenames)
app.use(
  '/assets',
  serveStatic('./dist', {
    cache: { maxAge: 31_536_000, immutable: true },
  }),
);

// Disable caching (development, dynamic content)
app.use(serveStatic('./public', { cache: false }));
```

**Custom index file:**

```ts
app.use(serveStatic('./public', { index: 'app.html' }));
```

Features: directory traversal protection, `ETag` + `Last-Modified`, `304 Not Modified`,
streaming with backpressure, magic-byte MIME detection.

---

## Graceful Shutdown

```ts
app.listen(3000);

async function shutdown(signal: string) {
  console.log(`${signal} — shutting down`);
  await app.close(); // stops accepting connections, waits for in-flight requests
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
```

---

## Ecosystem

Arcara ships a minimal core. Optional utilities are available as subpath imports —
zero cost if unused.

| Utility      | Import              | Description                                    |
| ------------ | ------------------- | ---------------------------------------------- |
| CORS         | `arcara/cors`       | Origin policy, preflight handling              |
| Cookies      | `arcara/cookies`    | `req.cookies`, `res.setCookie/clearCookie`     |
| Rate limiter | `arcara/rate-limit` | Fixed-window, `X-RateLimit-*` headers          |
| Logger       | `arcara/logger`     | ANSI request logs, configurable skip predicate |

```ts
import { cors } from 'arcara/cors';
import { cookies } from 'arcara/cookies';
import { rateLimit } from 'arcara/rate-limit';
import { logger } from 'arcara/logger';

app.use(cors({ origin: 'https://myapp.com', credentials: true }));
app.use(cookies());
app.use(rateLimit({ window: 60_000, limit: 100 }));
app.use(logger({ skip: (req) => req.url === '/health' }));
```

---

## Migrating from Express

| Express                                 | Arcara                                     | Notes                         |
| --------------------------------------- | ------------------------------------------ | ----------------------------- |
| `app.use(express.json())`               | Built-in                                   | Automatic for POST/PUT/PATCH  |
| `req.params.id`                         | `req.params.id`                            | Compile-time typed            |
| `res.status(200).json(...)`             | `res.status(200).json(...)`                | Same API                      |
| `res.redirect('/path')`                 | `res.redirect('/path')`                    | Same API, open-redirect safe  |
| `app.use((err, req, res, next) => ...)` | `app.onError((err, req, res) => ...)`      | Scoped per router             |
| `app.use(cors())`                       | `import { cors } from 'arcara/cors'`       | Subpath import                |
| `app.use(cookieParser())`               | `import { cookies } from 'arcara/cookies'` | Subpath import                |
| `app.set()` / `app.locals`              | —                                          | Use closures or DI            |
| `res.render()`                          | —                                          | Bring your own template layer |

---

## TypeScript Setup

Arcara works best with strict mode and `NodeNext` module resolution:

For the best editor experience, use Arcara inside a configured TypeScript
project with a `tsconfig.json`. Without one, some editors may treat files as an
inferred project and resolve Node ambient types inconsistently.

```json
{
  "compilerOptions": {
    "strict": true,
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "target": "ES2022"
  }
}
```

Param inference, `req.body`, `req.query`, `res.json()` and all response helpers
work without extra imports. Installing `@types/node` also enables Node built-in
modules and ambient types throughout your project.

To attach custom properties to `req` from middleware, extend `IncomingMessage`
in your project:

```ts
declare module 'node:http' {
  interface IncomingMessage {
    user: JWTPayload;
  }
}
```

---

## Requirements

- Node.js 18+
- TypeScript 5.0+ (recommended)

---

## Known Limitations

- **Global prototype augmentation** — Arcara extends `ServerResponse.prototype`
  once at import time (`res.json`, `res.send`, `res.status`, `res.redirect`).
  This affects all HTTP servers in the same process. Avoid running Arcara
  alongside other frameworks that augment the same methods in a shared process.

---

## Contributing

1. Open an issue for bugs or feature requests
2. Fork → branch → commit → PR
3. `pnpm test`

---

## License

MIT © [Ala Ben Aissia](https://github.com/Ala-Ben-Aissia)
