# Arcara

[![npm version](https://img.shields.io/npm/v/arcara)](https://npmjs.com/package/arcara)
[![npm downloads](https://img.shields.io/npm/dm/arcara)](https://npmjs.com/package/arcara)
[![license](https://img.shields.io/npm/l/arcara)](./LICENSE)

A TypeScript-first, zero-runtime-dependency Node.js HTTP framework — tiny, fast, and fully typed for everyday APIs.

## Install

```bash
npm install arcara
```

If you use TypeScript in your project, install Node types to get full
`req`/`res` inference in editors and the compiler:

```bash
pnpm add -D @types/node
# or npm: npm i -D @types/node
```

## Quick Start

Copy → paste → run.

```ts
import { Arcara, HttpError } from 'arcara';

const app = new Arcara();

// Simple middleware
app.use((req, _res, next) => {
  console.log(req.method, req.url);
  next();
});

// Route with inferred path param
app.get('/users/:id', (req, res) => {
  res.json({ id: req.params.id });
});

// POST with parsed body
app.post('/users', (req, res) => {
  res.status(201).json(req.body);
});

// Router-level error handler (overrides default for this sub-tree)
app.onError((err, _req, res) => {
  res.status(err.status).json({ error: err.message });
});

app.listen(3000, () => console.log('Listening on :3000'));
```

**What's new (0.1.8)**

- Static file serving middleware: `serveStatic(root, { prefix?, index? })` —
  safe path resolution, index fallback, prefix mounting, HEAD support and
  streaming via `pipeline` with content sniffing for unknown extensions.
- Improved content-type detection (`detectContentType`) and a small in-memory
  sniff cache to avoid repeated reads for unchanged files.
- TypeScript typing fixes: conditional type bridge and module augmentations
  (both `node:http` and `http`) so consumers with `@types/node` get full
  `IncomingMessage` / `ServerResponse` members while other environments still
  compile with a minimal safe fallback.

See the changelog for full details.

## API Usage (practical)

- Create app
  - `const app = new Arcara();`

- Middleware / mounting
  - `app.use(handler)` — global middleware
  - `app.use('/prefix', handler)` — prefix-scoped middleware
  - `app.use('/prefix', router)` — mount a `Router` or `Arcara` layer

- Routing helpers
  - `app.get(path, ...handlers)`
  - `app.post(path, ...handlers)`
  - `app.put(path, ...handlers)`
  - `app.patch(path, ...handlers)`
  - `app.delete(path, ...handlers)`

  Handlers signature:

  ```ts
  (req, res, next) => void | Promise<void>
  ```

- Response helpers
  - `res.status(code)` — returns `this` for chaining
  - `res.json(value)` — sets `Content-Type: application/json` and ends
  - `res.send(value)` — auto-detects Content-Type, sets `Content-Length`, ends

  Example:

  ```ts
  res.status(201).json({ created: true });
  res.send('plain text or Buffer or object');
  ```

- Error handling
  - Register with `app.onError((err, req, res) => { ... })`
  - Throw `HttpError` to produce an HTTP status + JSON message:
    ```ts
    import { HttpError } from 'arcara';
    throw new HttpError(404, 'Not found');
    ```

- Server control
  - `app.listen(port[, host, callback])` — start server
  - `await app.close()` — graceful shutdown

## Examples (short)

- Mounting a `Router`:

```ts
import { Router } from 'arcara';
const users = new Router();
users.get('/:id', (req, res) => res.json({ id: req.params.id }));
app.use('/users', users);
```

- Auth middleware:

```ts
const requireAuth = (req, res, next) => {
  const token = req.headers['x-api-key'];
  if (!token || token !== 'secret')
    return res.status(401).json({ error: 'Unauthorized' });
  next();
};
```

## Notes (usage-relevant)

- Path params are inferred from literal route strings: `req.params.id` is typed when you define `'/users/:id'`.
- `req.body` is populated for POST/PUT/PATCH handlers; for other methods it is `undefined`.
- `HEAD` requests fall back to the `GET` handler automatically.
- `res.send()` detects string/Buffer/Uint8Array/ArrayBuffer/object and sets an appropriate `Content-Type` and `Content-Length`.
- Throw `HttpError(status, message)` or call `next(err)` to reach the registered error handler.

---

Minimal, practical, and ready for production usage — import `arcara`, write handlers, and ship.

## Static files

Arcara includes a small, zero-runtime-dependency static middleware useful for
serving assets from disk in simple deployments or local demos. The middleware
is implemented at `src/utils/static.ts` and supports:

- safe path resolution and directory index resolution (`index.html` by default)
- optional `prefix` mounting to scope files to a URL subtree
- proper `HEAD` handling and `Content-Length` negotiation
- extension-based MIME map and a magic-byte content sniff fallback via
  `detectContentType`

Usage (example):

```ts
import { Arcara, serveStatic } from 'arcara';

const app = new Arcara();
app.use(serveStatic('./public'));

// or mount under a prefix:
app.use(serveStatic('./public', { prefix: '/static' }));
```

Note: the middleware lives under `src/utils/static.ts` in this repository. When
publishing the package this utility is included in the `dist` artifacts and
can be re-exported from the public API in a future release.

## Testing & development

Run the test-suite and type checks locally:

```bash
pnpm install
pnpm test        # runs node:test suites via tsx
pnpm run typecheck
pnpm run build   # builds JS + declaration files
```

If you are contributing, please run tests and typechecks before opening a PR.

## Contributing

Contributions are very welcome. Open an issue to discuss design changes,
or submit a PR. Please keep changes focused, include tests for new behavior,
and follow the existing coding style (TypeScript, minimal runtime deps).

---

## License

[MIT](./LICENSE) © 2026 Ala Ben Aissia
