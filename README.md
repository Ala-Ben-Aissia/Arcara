# Arcara

[![npm version](https://img.shields.io/npm/v/arcara)](https://npmjs.com/package/arcara)
[![npm downloads](https://img.shields.io/npm/dm/arcara)](https://npmjs.com/package/arcara)
[![license](https://img.shields.io/npm/l/arcara)](./LICENSE)
[![CI](https://github.com/alabenaissia/arcara/actions/workflows/ci.yml/badge.svg)](https://github.com/alabenaissia/arcara/actions/workflows/ci.yml)

A TypeScript-native, zero-dependency Node.js HTTP framework built on raw `node:http`.

- **Zero dependencies** — nothing in `node_modules` at runtime
- **TypeScript-first** — route params statically inferred from path strings
- **Composable** — sub-routers via `Layer`, mounted with `app.use()`
- **Dual CJS/ESM** — works in any modern Node.js project

---

## Install

```bash
pnpm add arcara
# or
npm install arcara
```

**Requirements:** Node.js >= 18.0.0

---

## Quickstart

```ts
import { Arcara, HttpError } from 'arcara';

const app = new Arcara();

// Global middleware
app.use((req, _res, next) => {
  console.log(`${req.method} ${req.url}`);
  next();
});

// Typed route params — req.params.id is string, inferred from '/users/:id'
app.get('/users/:id', (req, res) => {
  res.json({ id: req.params.id });
});

// POST with body
app.post('/users', (req, res) => {
  res.status(201).json(req.body);
});

// Error handler
app.onError((err, _req, res) => {
  res.status(err.status).json({ error: err.message });
});

app.listen(3000);
```

---

## API Reference

### `new Arcara(options?)`

Creates a new application instance.

| Option      | Type     | Default     | Description                          |
| ----------- | -------- | ----------- | ------------------------------------ |
| `bodyLimit` | `number` | `1_048_576` | Max request body size in bytes (1MB) |
| `timeout`   | `number` | `30_000`    | Request timeout in ms (30s)          |

```ts
const app = new Arcara({ bodyLimit: 5 * 1024 * 1024, timeout: 10_000 });
```

---

### Routing

All route methods accept multiple stacked handlers (middleware chain per route):

```ts
app.get(path, ...handlers);
app.post(path, ...handlers);
app.put(path, ...handlers);
app.patch(path, ...handlers);
app.delete(path, ...handlers);
```

Route params are statically typed:

```ts
// req.params.id and req.params.postId are inferred as string
app.get('/users/:id/posts/:postId', (req, res) => {
  const { id, postId } = req.params; // ✅ typed
});
```

---

### Middleware

```ts
// Global — runs for all requests
app.use(myMiddleware);

// Prefix-scoped — runs for /api and /api/*
app.use('/api', authMiddleware);

// Mounted sub-router
import { Layer } from 'arcara';

class UserRouter extends Layer {
  constructor() {
    super();
    this.get('/:id', (req, res) => res.json({ id: req.params.id }));
  }
}

app.use('/users', new UserRouter());
```

---

### Request

| Property     | Type                     | Description                       |
| ------------ | ------------------------ | --------------------------------- |
| `req.params` | `Record<string, string>` | Named route params                |
| `req.query`  | `Record<string, string>` | Parsed query string               |
| `req.body`   | `unknown`                | Parsed body (POST/PUT/PATCH only) |

Body parsing is automatic for `POST`, `PUT`, `PATCH`:

| `Content-Type`                      | `req.body` type          |
| ----------------------------------- | ------------------------ |
| `application/json`                  | `object`                 |
| `application/x-www-form-urlencoded` | `Record<string, string>` |
| `text/*`                            | `string`                 |
| anything else                       | `Buffer`                 |

---

### Response

```ts
res.status(201); // set status code, chainable
res.json({ id: 1 }); // serialize to JSON, end response
res.send('hello'); // auto content-type, end response
res.send(buffer); // application/octet-stream
res.status(201).json({ created: true }); // chained
```

---

### Error Handling

Throw `HttpError` anywhere in a handler — Arcara catches and routes it to your error handler:

```ts
import { HttpError } from 'arcara';

app.get('/users/:id', (req, res) => {
  const user = db.find(req.params.id);
  if (!user) throw new HttpError(404, 'User not found');
  res.json(user);
});

app.onError((err, _req, res) => {
  res.status(err.status).json({
    error: err.message,
    ...(err.details ? { details: err.details } : {}),
  });
});
```

Pass errors through `next()`:

```ts
app.use((req, res, next) => {
  verifyToken(req).catch(next); // next(err) → error handler
});
```

---

### Graceful Shutdown

```ts
process.on('SIGTERM', async () => {
  await app.close();
  process.exit(0);
});
```

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

---

## License

[MIT](./LICENSE) © 2025 Aloulou
