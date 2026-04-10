# Arcara

[![Website](https://img.shields.io/badge/website-live-blue)](https://arcara.netlify.app)
[![npm version](https://img.shields.io/npm/v/arcara)](https://npmjs.com/package/arcara)
[![npm downloads](https://img.shields.io/npm/dm/arcara)](https://npmjs.com/package/arcara)
[![license](https://img.shields.io/npm/l/arcara)](./LICENSE)

A TypeScript-first, zero-runtime-dependency Node.js HTTP framework.

Radix-tree routing. Full type inference. Minimal, composable middleware.

---

## Why Arcara?

- ⚡ **Fast routing** — Radix tree for O(k) path matching (k = segment count)
- 🧠 **Type safety** — Route params inferred from path strings, no generics
- 🪶 **Zero runtime dependencies** — Only `@types/node` for development
- 🔌 **Familiar API** — Express-like middleware model, easier to learn
- 📦 **Batteries included** — Body parsing, static files, error handling built-in

If you like Express but want compile-time safety and less overhead, Arcara is a natural upgrade.

---

## Requirements

- **Node.js 18+**
- **TypeScript 5.0+** (recommended)

---

## Install

```bash
npm install arcara
```

For TypeScript users, install Node.js type definitions:

```bash
npm install --save-dev @types/node
```

> **Note:** Match `@types/node` to your Node.js version:  
> Node 18 → `@types/node@18`  
> Node 20 → `@types/node@20`  
> Node 22 → `@types/node@22`

---

## Quick Start

```ts
import { Arcara, HttpError } from 'arcara';

const app = new Arcara();

// Middleware runs on every request
app.use((req, _res, next) => {
  console.log(req.method, req.url);
  next();
});

// Route params are typed automatically
app.get('/users/:id', (req, res) => {
  res.json({ id: req.params.id }); // id is string, no casting
});

// Body parsing is automatic for POST/PUT/PATCH
app.post('/users', (req, res) => {
  res.status(201).json(req.body);
});

// Centralized error handling
app.onError((err, _req, res) => {
  res.status(err.status).json({ error: err.message });
  // err is always normalized to HttpError
});

app.listen(3000, () => console.log('Server running on :3000'));
```

**Run it:**

```bash
npx tsx server.ts
# or: node --loader ts-node/esm server.ts
```

---

## TypeScript Setup

Arcara works best with strict mode:

```json
// tsconfig.json
{
  "compilerOptions": {
    "strict": true,
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "esModuleInterop": true,
    "target": "ES2022"
  }
}
```

Type augmentations for `req.params`, `req.body`, `res.json()` work automatically when `@types/node` is installed.

---

## Core Concepts

### Application

```ts
import { Arcara } from 'arcara';

const app = new Arcara({
  bodyLimit: 2_000_000, // 2MB max request body (default: 1MB)
  timeout: 60_000, // 60s request timeout (default: 30s)
});

app.listen(3000);
// Binds to localhost:3000

app.listen(3000, '0.0.0.0');
// Binds to all interfaces

app.listen(3000, 'localhost', () => {
  console.log('Ready');
});
```

### Graceful Shutdown

```ts
const app = new Arcara();
// ... routes

app.listen(3000);

process.on('SIGTERM', async () => {
  console.log('Shutting down...');
  await app.close(); // Waits for in-flight requests
  process.exit(0);
});
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

**Path params are fully typed:**

```ts
app.get('/orgs/:orgId/repos/:repoId', (req, res) => {
  const { orgId, repoId } = req.params; // Both typed as string
  res.json({ orgId, repoId });
});
```

**Multiple handlers per route:**

```ts
const validateId = (req, res, next) => {
  if (!/^\d+$/.test(req.params.id)) {
    throw new HttpError(400, 'Invalid ID');
  }
  next();
};

app.get('/users/:id', validateId, (req, res) => {
  res.json({ id: req.params.id });
});
```

---

### Middleware

```ts
// Global middleware (runs on every request)
app.use((req, res, next) => {
  console.log(req.method, req.url);
  next();
});

// Prefix-scoped middleware
app.use('/api', (req, res, next) => {
  if (!req.headers.authorization) {
    throw new HttpError(401, 'Unauthorized');
  }
  next();
});
```

> **Important:** Prefixes are stripped from `req.url` before handlers see it.  
> A middleware at `/api` receives `/users`, not `/api/users`.

---

### Sub-Routers

Organize routes into mountable modules:

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

// Mount at /users
app.use('/users', users);
// GET /users/42 → routed to users.get('/:id')
```

**Nested routers:**

```ts
const api = new Router();
const v1 = new Router();

v1.get('/health', (req, res) => res.json({ ok: true }));

api.use('/v1', v1);
app.use('/api', api);
// GET /api/v1/health → works
```

**Router-specific error handlers:**

```ts
const api = new Router();

api.onError((err, _req, res) => {
  res.status(err.status).json({
    error: err.message,
    code: err.status,
  });
});

api.get('/test', () => {
  throw new HttpError(500, 'API error');
});

app.use('/api', api);
// Errors in /api/* use api.onError, not app.onError
```

---

### Response Helpers

```ts
res.status(201).json({ created: true });
// Sets status, Content-Type, and ends response

res.send('plain text');
// Auto-detects Content-Type and sets Content-Length

res.send(buffer);
// Supports Buffer, Uint8Array, ArrayBuffer

res.send({ key: 'value' });
// Objects are serialized to JSON automatically

res.status(204).end();
// No body
```

**HEAD requests:**

Automatically handled via GET routes. Headers are sent, body is omitted.

```ts
app.get('/data', (req, res) => {
  res.send('large payload');
});
// HEAD /data → returns headers only, no body
```

---

### Error Handling

**Throwing errors:**

```ts
app.get('/admin', (req, res) => {
  if (!req.headers.authorization) {
    throw new HttpError(401, 'Unauthorized');
  }
  res.json({ admin: true });
});
```

**Passing to `next()`:**

```ts
app.use((req, res, next) => {
  const err = validateToken(req.headers.authorization);
  if (err) return next(new HttpError(401, 'Invalid token'));
  next();
});
```

**Bypassing error handler:**

```ts
app.get('/login', (req, res) => {
  return res.status(401).json({ error: 'Bad credentials' });
  // Error handler is NOT called
});
```

**Error details:**

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

---

### Request Body Parsing

Automatic for `POST`, `PUT`, `PATCH` based on `Content-Type`:

| Content-Type                        | Parsed As                   |
| ----------------------------------- | --------------------------- |
| `application/json`                  | `object` (via `JSON.parse`) |
| `application/x-www-form-urlencoded` | `Record<string, string>`    |
| `text/*`                            | `string`                    |
| Other                               | `Buffer`                    |

**Body size limit:**

Default is **1MB**. Configure via:

```ts
const app = new Arcara({ bodyLimit: 5_000_000 }); // 5MB
```

Requests exceeding the limit receive `413 Payload Too Large`.

**Body parsing errors:**

Invalid JSON or malformed form data results in `400 Bad Request`.

---

### Static Files

```ts
import { serveStatic } from 'arcara';

// Serve at root
app.use(serveStatic('./public'));
// GET /logo.png → ./public/logo.png

// Mount at prefix
app.use('/static', serveStatic('./assets'));
// GET /static/logo.png → ./assets/logo.png

// Custom index file
app.use(serveStatic('./public', { index: 'app.html' }));
// GET / → ./public/app.html
```

**Features:**

- Directory traversal protection
- Automatic `index.html` fallback
- `ETag` / `Last-Modified` headers
- `304 Not Modified` support
- Streaming with backpressure handling
- Magic byte + extension-based MIME detection

---

### Request Behavior

| Feature      | Behavior                                                    |
| ------------ | ----------------------------------------------------------- |
| `req.body`   | Auto-parsed for POST/PUT/PATCH. **1MB limit by default.**   |
| `req.params` | Fully typed from route string                               |
| `req.query`  | Flat `Record<string, string>` from URL search params        |
| `HEAD`       | Automatically handled via matching GET route                |
| `405`        | Returned when path exists but method doesn't match          |
| Timeout      | **30s default.** Returns `408 Request Timeout` if exceeded. |

---

## Migrating from Express

| Express                                 | Arcara                                | Notes                        |
| --------------------------------------- | ------------------------------------- | ---------------------------- |
| `app.use(express.json())`               | Built-in                              | Automatic for POST/PUT/PATCH |
| `req.params.id`                         | `req.params.id`                       | Now compile-time typed       |
| `res.status(200).json(...)`             | `res.status(200).json(...)`           | Same API                     |
| `app.use((err, req, res, next) => ...)` | `app.onError((err, req, res) => ...)` | Scoped to layer              |
| `app.set()` / `app.locals`              | ❌ Not supported                      | Use closures or DI           |
| `res.render()` / `res.redirect()`       | ❌ Not supported                      | Manual implementation        |
| `req.cookies`                           | ❌ Not supported                      | Use middleware               |

**What you lose:**

- Template engine integration
- Cookie/session helpers (bring your own middleware)
- `res.redirect()`, `res.download()`, `res.sendFile()`

**What you gain:**

- Full TypeScript inference
- 30% smaller bundle (no runtime deps)
- Radix-tree routing performance

---

## Examples

### Authentication Middleware

```ts
const requireAuth = (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    throw new HttpError(401, 'Missing token');
  }

  try {
    req.user = verifyJWT(token);
    next();
  } catch {
    throw new HttpError(401, 'Invalid token');
  }
};

app.use('/api', requireAuth);

app.get('/api/profile', (req, res) => {
  res.json({ user: req.user });
});
```

### CORS Middleware

```ts
const cors = (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  next();
};

app.use(cors);
```

### Rate Limiting

```ts
const rateLimit = new Map<string, number[]>();

const limiter = (req, res, next) => {
  const ip = req.socket.remoteAddress ?? 'unknown';
  const now = Date.now();
  const window = 60_000; // 1 minute
  const limit = 100;

  const timestamps = rateLimit.get(ip) ?? [];
  const recent = timestamps.filter((t) => now - t < window);

  if (recent.length >= limit) {
    throw new HttpError(429, 'Too many requests');
  }

  recent.push(now);
  rateLimit.set(ip, recent);
  next();
};

app.use(limiter);
```

### File Upload (with busboy)

```ts
import Busboy from 'busboy';

app.post('/upload', (req, res) => {
  const busboy = Busboy({ headers: req.headers });
  const files: string[] = [];

  busboy.on('file', (fieldname, file, info) => {
    const savePath = `./uploads/${info.filename}`;
    file.pipe(fs.createWriteStream(savePath));
    files.push(info.filename);
  });

  busboy.on('finish', () => {
    res.json({ uploaded: files });
  });

  req.pipe(busboy);
});
```

---

## API Reference

### `Arcara`

```ts
class Arcara {
  constructor(options?: ArcaraOptions);

  use(handler: Middleware): this;
  use(prefix: string, handler: Middleware | Router): this;

  get(path: string, ...handlers: RouteHandler[]): this;
  post(path: string, ...handlers: RouteHandler[]): this;
  put(path: string, ...handlers: RouteHandler[]): this;
  patch(path: string, ...handlers: RouteHandler[]): this;
  delete(path: string, ...handlers: RouteHandler[]): this;

  onError(handler: ErrorHandler): this;

  listen(port: number, callback?: () => void): this;
  listen(port: number, host: string, callback?: () => void): this;

  close(): Promise<void>;
}
```

### `ArcaraOptions`

```ts
interface ArcaraOptions {
  bodyLimit?: number; // Max request body size in bytes (default: 1MB)
  timeout?: number; // Request timeout in milliseconds (default: 30s)
}
```

### `Router`

```ts
class Router {
  // Same API as Arcara (minus listen/close)
  use(handler: Middleware): this;
  use(prefix: string, handler: Middleware | Router): this;
  get(path: string, ...handlers: RouteHandler[]): this;
  // ... post, put, patch, delete
  onError(handler: ErrorHandler): this;
}
```

### `HttpError`

```ts
class HttpError extends Error {
  status: number;
  details?: unknown;

  constructor(status: number, message: string, details?: unknown);

  static from(error: unknown): HttpError;
}
```

### `serveStatic`

```ts
function serveStatic(root: string, options?: { index?: string }): Middleware;
```

---

## FAQ

**Q: Why is `@types/node` a peer dependency?**  
A: To prevent type conflicts. Your project's Node version (18, 20, 22) should match your `@types/node` version.

**Q: Does Arcara work with JavaScript?**  
A: Absolutely, type inference works perfectly.

**Q: Can I use Express middleware?**  
A: Most Express middleware works, but not all (e.g., body-parser is redundant, session middleware may need adapters).

**Q: How do I handle file uploads?**  
A: `req.body` is a `Buffer` for non-JSON/form data. Use a library like `busboy` or `formidable` to parse multipart uploads.

**Q: Why no `res.redirect()`?**  
A: Keeping the API minimal. Implement it yourself:

```ts
res.setHeader('Location', '/new-path');
res.status(302).end();
```

**Q: Can I deploy this to serverless (Lambda, Vercel, etc.)?**  
A: Not directly. Arcara uses Node's `http.Server`. For serverless, use adapters or consider edge-first frameworks (Hono, Nitro).

---

## Contributing

Contributions welcome!

1. **Open an issue** for bugs or feature requests
2. **Fork** → **branch** → **commit** → **PR**
3. Run tests: `pnpm test`
4. Follow existing code style (strict TypeScript, no unused vars)

See [CONTRIBUTING.md](./CONTRIBUTING.md) for details.

---

## License

MIT © 2026 [Ala Ben Aissia](https://github.com/Ala-Ben-Aissia)

---

## Acknowledgments

Inspired by Express, Fastify, and Hono. Built with ❤️ for the TypeScript community.
