# Arcara

A TypeScript-first, zero-dependency Node.js HTTP framework — tiny, fast, and fully typed for everyday APIs.

## Install

```bash
npm install arcara
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
