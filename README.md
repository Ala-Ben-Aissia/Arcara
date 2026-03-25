# Arcara

A zero-dependency Node.js HTTP framework with full TypeScript inference — route params extracted from path strings at the type level, request bodies narrowed by HTTP method, and scoped error handling at every layer of the router tree.

```ts
import { Arcara, Router, ArcaraError } from 'arcara';

const app = new Arcara();

const api = new Router();

api.get('/users/:id', (req, res) => {
  res.json({ id: req.params.id }); // req.params.id — inferred, not cast
});

app.use('/api', api);
app.listen(3000);
```

---

## Requirements

- Node.js `>= 22`
- TypeScript `>= 5.0` (for template literal type inference)

---

## Installation

```bash
npm install arcara
```

---

## At a Glance

| Feature        | Detail                                             |
| -------------- | -------------------------------------------------- |
| Dependencies   | Zero — `node:http` only                            |
| Module system  | ESM (`"type": "module"`)                           |
| Type safety    | Path params inferred via `ExtractParams<Path>`     |
| Body typing    | Narrowed to `never` for `GET`, `HEAD`, `DELETE`    |
| Error handling | Scoped per router — innermost handler wins         |
| Routing        | Nested routers, prefix params, 404/405 distinction |
| Body parsing   | JSON, form-urlencoded, text, binary — 1MB limit    |

---

## Architecture

```
Arcara (extends Layer)
│
│  handleRequest()       ← HTTP server entry point
│  parseBody()           ← stream-based, 1MB limit
│  res.status/json/send  ← ServerResponse prototype augmentation
│
└── Layer (abstract)
    │
    ├── routes[]         ← compiled route entries
    ├── middlewares[]    ← prefix-scoped middleware entries
    ├── children[]       ← mounted Router instances
    │
    ├── dispatch()       ← recursive tree walk
    ├── runStack()       ← sequential handler chain
    ├── handleError()    ← normalizes to ArcaraError, delegates to onError
    └── collectAllowedMethods()  ← OPTIONS support

Router (extends Layer)   ← zero additional logic, mountable sub-tree
```

Every `Router` and `Arcara` instance is a `Layer`. Mounting a router wires its `dispatch` into the parent's `children` array — no magic, no middleware stacks shared across instances.

---

## Routing

### Basic routes

```ts
app.get('/health', (_req, res) => res.json({ ok: true }));
app.post('/users', (req, res) => res.status(201).json({ body: req.body }));
app.put('/users/:id', (req, res) => res.json({ id: req.params.id }));
app.patch('/users/:id', (req, res) => res.json({ id: req.params.id }));
app.delete('/users/:id', (_req, res) => res.status(204).end());
```

### Path parameters

Parameters are extracted from the path string at the **type level** — no casting required.

```ts
app.get('/orgs/:orgId/users/:userId', (req, res) => {
  // TypeScript knows req.params.orgId and req.params.userId exist
  res.json({ org: req.params.orgId, user: req.params.userId });
});
```

Accessing `req.params` on a paramless route is a **compile-time error**:

```ts
app.get('/health', (req, res) => {
  req.params.anything; // TS error — params is `never` here
});
```

### Body typing

`req.body` is narrowed to `never` for `GET`, `HEAD`, and `DELETE`:

```ts
app.get('/users', (req, res) => {
  req.body; // TS error — body is `never` for GET
});

app.post('/users', (req, res) => {
  req.body; // any
});
```

### HEAD

`HEAD` requests are automatically routed to the matching `GET` handler. `res.send` suppresses the body and sends headers only — no separate handler needed.

### OPTIONS

`OPTIONS` is handled automatically. Arcara walks the full route tree, collects all registered methods for the requested path, and responds `204` with an `Allow` header.

---

## Middleware

```ts
// Global — runs for every request
app.use((req, _res, next) => {
  console.log(`${req.method} ${req.url}`);
  next();
});

// Prefix-scoped — runs for /api/* only
app.use('/api', (req, _res, next) => {
  console.log('api middleware');
  next();
});
```

Middlewares run in registration order before route handlers. A middleware that does not call `next()` short-circuits the chain — the request stops there.

Calling `next()` twice from the same handler throws a `500 ArcaraError`.

---

## Routers

```ts
const api = new Router();

api.get('/users', (_req, res) => res.json({ users: [] }));
api.get('/users/:id', (req, res) => res.json({ id: req.params.id }));

app.use('/api', api);
// GET /api/users     → api router
// GET /api/users/42  → api router, req.params.id = '42'
```

### Nested routers with prefix params

Params from mount prefixes are merged into `req.params` alongside route-level params:

```ts
const resources = new Router();

resources.get('/:resourceId', (req, res) => {
  res.json({
    org: req.params.orgId, // from mount prefix
    resource: req.params.resourceId, // from route pattern
  });
});

api.use('/orgs/:orgId/resources', resources);
app.use('/api', api);
// GET /api/orgs/acme/resources/doc-1
// → { org: 'acme', resource: 'doc-1' }
```

---

## Error Handling

### ArcaraError

The framework's first-class error type. Carries an HTTP status code alongside the message so error handlers make HTTP-aware decisions without parsing strings.

```ts
import { ArcaraError } from 'arcara';

app.get('/secret', () => {
  throw new ArcaraError(403, 'Forbidden');
});

app.get('/data', async () => {
  try {
    await db.query();
  } catch (cause) {
    throw new ArcaraError(503, 'Database unavailable', cause);
  }
});
```

Plain `Error` instances thrown from handlers are wrapped in `ArcaraError(500, ...)` automatically. The original error is preserved as `cause` and surfaced in the terminal log.

### Scoped handlers via `onError`

Each `Router` (and `Arcara`) has its own error handler. The innermost layer that defines `onError` handles errors in its subtree — errors do not propagate up.

```ts
const api = new Router();

api.onError((err, _req, res) => {
  res.statusCode = err.status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ apiError: err.message }));
});

app.onError((err, _req, res) => {
  // Root-level fallback — handles anything not caught by a child router
  res.statusCode = err.status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ error: err.message }));
});
```

The default error handler (used when `onError` is not called) writes a JSON response using raw `res.statusCode` and `res.end()` — it never calls `res.status()` or `res.json()`, so it cannot throw.

### Logging

`5xx` errors are logged to `stderr` with the full cause chain. `4xx` routing errors (404, 405) are not logged — they are normal control flow, not failures.

---

## Response API

All methods return `this` for chaining.

### `res.status(code)`

Sets `statusCode`. **Throws** on invalid codes (non-integer, outside 100–999) — this is a programmer error that should surface immediately.

```ts
res.status(201).json({ created: true });
res.status(204).end();
```

### `res.json(input)`

Validates serializability (catches functions, BigInts, circular references), sets `Content-Type: application/json; charset=utf-8`, and ends the response.

```ts
res.json({ users: [] });
res.status(422).json({ error: 'Validation failed' });
```

### `res.send(input)`

Auto-detects `Content-Type` from the value — no caller hint needed. Sets `Content-Length`. Respects `HEAD` (headers only, no body).

| Input type                                        | Content-Type                                                       |
| ------------------------------------------------- | ------------------------------------------------------------------ |
| `Buffer` / `Uint8Array` / `ArrayBuffer`           | Sniffed from magic bytes, falls back to `application/octet-stream` |
| `string` starting with `<!doctype html` / `<html` | `text/html; charset=utf-8`                                         |
| `string` starting with `<svg`                     | `image/svg+xml`                                                    |
| `string` matching CSS patterns                    | `text/css; charset=utf-8`                                          |
| `string` (other)                                  | `text/plain; charset=utf-8`                                        |
| `object`                                          | `application/json`                                                 |

```ts
res.send('Hello'); // text/plain
res.send('<h1>Hello</h1>'); // text/html
res.send({ ok: true }); // application/json
res.send(Buffer.from([0xff, 0xd8, 0xff])); // image/jpeg
```

---

## Body Parsing

Bodies are parsed automatically for `POST`, `PUT`, and `PATCH` requests before handlers run. The limit is **1MB** — requests exceeding it receive `413 Payload Too Large`.

| `Content-Type`                      | `req.body` type           |
| ----------------------------------- | ------------------------- |
| `application/json`                  | `Record<string, unknown>` |
| `application/x-www-form-urlencoded` | `Record<string, string>`  |
| `text/*`                            | `string`                  |
| anything else                       | `Buffer`                  |

---

## Design Decisions

**Zero dependencies.** The framework uses `node:http` exclusively. No third-party parsers, no router libraries, no utility packages. The entire implementation is auditable in a single read.

**`res.status()` throws on invalid codes.** Invalid status codes are programmer errors — surfacing them immediately at the call site is more useful than silently sending a malformed response.

**Default error handler never uses proto methods.** `res.status()` throws, so the default `errorHandler` writes raw `res.statusCode` and `res.end()`. This guarantees a response is always sent even if the error handler is reached from an already-broken state.

**`HEAD` handled automatically.** Registering a `HEAD` route explicitly is never required. The router falls back to `GET` and `res.send` suppresses the body. This matches RFC 9110.

**404 vs 405 are distinct.** `matchRoute` distinguishes "path not found" from "path found, method wrong." A `405` response is semantically different from a `404` — conflating them is an HTTP spec violation that misleads clients and API consumers.

**Prefix params are inherited.** When a router is mounted at `/orgs/:orgId`, the `orgId` param is extracted at dispatch time and merged into `req.params` before the child router runs. Nested routers see all params from all ancestor prefixes.

**`compilePath` uses a `prefix` flag.** Child routers are compiled with `prefix: true`, which changes the regex terminator from `\/?$` (exact match) to `(?:\/.*)?$` (prefix match). This is the minimal change that makes sub-path routing correct — one flag, one place, no call-site hackery.

**Stream backpressure in responses.** `res.json` and `res.send` write via `safeWrite`, which pauses `req` if the response writable buffer is full and resumes on drain. Rare in practice for single-chunk responses, but prevents unbounded memory growth under slow clients at zero API cost.

---

## License

MIT © 2026 Ala Ben Aissia
