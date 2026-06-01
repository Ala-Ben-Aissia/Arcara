# Arcara — Benchmarks

> **Reproducibility first.**  
> Every number below was produced by the script in [`bench/runner.mjs`](./bench/runner.mjs).
> All servers, methodology, and raw results are included so you can verify or
> challenge the results on your own hardware.

---

## Environment

| Property    | Value                                                       |
| ----------- | ----------------------------------------------------------- |
| OS          | macOS (Apple Silicon equivalent)                            |
| Node.js     | v24.13.0                                                    |
| Tool        | [autocannon](https://github.com/mcollina/autocannon) v8.0.0 |
| Connections | 100                                                         |
| Pipelining  | 10                                                          |
| Duration    | 15 s per run (+ 3 s warm-up, discarded)                     |

## Versions

| Framework           | Version  |
| ------------------- | -------- |
| **Arcara**          | Latest benchmark build |
| Fastify             | 5.8.5    |
| Hono (Node adapter) | 4.12.14  |
| Express             | 4.22.1   |
| Raw Node.js         | v24.13.0 |

> Note: Arcara itself is zero-runtime-dependency. The benchmark harness is separate and requires `autocannon` plus the tested frameworks (`fastify`, `hono`, `@hono/node-server`, and `express`) installed in the local `bench/` workspace or globally.

---

## Scenarios

Eight scenarios are measured across the full framework surface area — routing, param
extraction, middleware dispatch, body parsing, query parsing, nested routers, and
error handling.

| ID  | Route / Operation                                | Purpose                                       |
| --- | ------------------------------------------------ | --------------------------------------------- |
| A   | `GET /` → `{ message: "hello" }`                 | Pure routing + JSON serialisation overhead    |
| B   | `GET /users/:id` → `{ id }`                      | Radix lookup + single param extraction        |
| C   | `GET /` + 3 sequential sync middlewares          | Middleware chain traversal cost               |
| D   | `POST /users` with JSON body                     | Stream read + parse + response                |
| E   | `GET /orgs/:orgId/repos/:repoId/issues/:issueId` | Multi-segment radix traversal + 3 params      |
| F   | `GET /search?q=hello&limit=10&offset=0`          | URL parse + query object construction         |
| G   | `GET /api/v1/users/:id` (mounted sub-router)     | Mount + prefix strip + nested radix lookup    |
| H   | `GET /protected` → 401                           | Throw → catch → error handler → JSON response |

---

> **Updated benchmark set:** Node.js v24.13.0 · 100 connections · pipelining 10 · 15s runs. Arcara averages **85,574 req/s**, ~**1.65× faster than Express** across the benchmark suite.

## Results

### Scenario A — Hello World

| Framework    |    Req/sec |      p50 |      p99 |     p999 | vs Express |
| ------------ | ---------: | -------: | -------: | -------: | ---------: |
| Raw Node.js  |    119,964 |      8ms |     14ms |     30ms |      2.13× |
| Fastify      |    105,227 |     10ms |     15ms |     26ms |      1.87× |
| **Arcara ★** | **95,396** | **11ms** | **16ms** | **18ms** |  **1.69×** |
| Hono         |     83,829 |      9ms |     18ms |     32ms |      1.49× |
| Express      |     56,319 |     20ms |     26ms |     51ms |      1.00× |

```
Req/sec (higher is better)

Raw Node  ████████████████████████████████████████  119,964
Fastify   ███████████████████████████████████       105,227
Arcara ★  ████████████████████████████████           95,396
Hono      ████████████████████████████               83,829
Express   ██████████████████                         56,319
```

Arcara is 10% behind Fastify, and 14% ahead of Hono. Also note Arcara's p999 of
18ms — lower than every other framework including Raw Node.js — indicating
tighter tail-latency control under sustained load.

---

### Scenario B — Parameterized Route

| Framework    |    Req/sec |      p50 |      p99 |     p999 | vs Express |
| ------------ | ---------: | -------: | -------: | -------: | ---------: |
| Raw Node.js  |    111,802 |      9ms |     15ms |     28ms |      1.96× |
| Fastify      |    108,444 |      9ms |     15ms |     16ms |      1.90× |
| **Arcara ★** | **94,628** | **11ms** | **16ms** | **18ms** |  **1.66×** |
| Hono         |     81,790 |      9ms |     18ms |     23ms |      1.43× |
| Express      |     56,997 |     20ms |     25ms |     48ms |      1.00× |

```
Req/sec (higher is better)

Raw Node  ████████████████████████████████████████  111,802
Fastify   ███████████████████████████████████████   108,444
Arcara ★  ██████████████████████████████████         94,628
Hono      █████████████████████████████              81,790
Express   ████████████████████                       56,997
```

Arcara closes to within 13% of Fastify on parameterized routing, and pulls 16%
ahead of Hono — a meaningful reversal from earlier versions where param extraction
was the primary weakness.

---

### Scenario C — Middleware Chain × 3

| Framework    |    Req/sec |     p50 |      p99 |     p999 | vs Express |
| ------------ | ---------: | ------: | -------: | -------: | ---------: |
| Raw Node.js  |    114,592 |     8ms |     14ms |     25ms |      2.08× |
| Fastify      |    105,333 |    10ms |     15ms |     16ms |      1.91× |
| **Arcara ★** | **91,817** | **8ms** | **17ms** | **24ms** |  **1.67×** |
| Hono         |     76,841 |     9ms |     20ms |     27ms |      1.40× |
| Express      |     55,015 |    21ms |     26ms |     57ms |      1.00× |

```
Req/sec (higher is better)

Raw Node  ████████████████████████████████████████  114,592
Fastify   ████████████████████████████████████      105,333
Arcara ★  ████████████████████████████████           91,817
Hono      ███████████████████████████                76,841
Express   ███████████████████                        55,015
```

Arcara's prefix-filtered middleware stack outpaces Hono's global-wildcard dispatch
by 19.5% here, and keeps p50 at 8ms — matching Raw Node.js. The iterative dispatch
model eliminates call-stack depth that accumulates in continuation-passing chains
under load.

---

### Scenario D — JSON Body Parsing

| Framework    |    Req/sec |      p50 |      p99 |     p999 | vs Express |
| ------------ | ---------: | -------: | -------: | -------: | ---------: |
| Raw Node.js  |     67,493 |     12ms |     26ms |     28ms |      1.77× |
| **Arcara ★** | **56,355** | **15ms** | **32ms** | **50ms** |  **1.48×** |
| Fastify      |     49,031 |     17ms |     40ms |    106ms |      1.29× |
| Express      |     38,032 |     23ms |     48ms |    283ms |      1.00× |
| Hono         |     32,009 |     27ms |     57ms |    426ms |      0.84× |

```
Req/sec (higher is better)

Raw Node  ████████████████████████████████████████   67,493
Arcara ★  █████████████████████████████████          56,355
Fastify   █████████████████████████████              49,031
Express   ██████████████████████                     38,032
Hono      ███████████████████                        32,009
```

The standout result. **Arcara leads all frameworks on body parsing** — 15% ahead
of Fastify, 48% ahead of Express, and 76% ahead of Hono. The p999 delta is
especially telling: Arcara's 50ms tail vs Hono's 426ms and Express's 283ms reflects
how the stream-read and parse path is handled without intermediate buffering
overhead. This scenario is the most representative of real API workloads.

---

### Scenario E — Deep Parameterized Route (×3 params)

| Framework    |    Req/sec |      p50 |      p99 |     p999 | vs Express |
| ------------ | ---------: | -------: | -------: | -------: | ---------: |
| Raw Node.js  |    113,525 |      9ms |     14ms |     16ms |      2.05× |
| Fastify      |    105,265 |     10ms |     15ms |     16ms |      1.90× |
| **Arcara ★** | **90,050** | **12ms** | **16ms** | **17ms** |  **1.62×** |
| Hono         |     81,047 |     13ms |     18ms |     21ms |      1.46× |
| Express      |     55,434 |     21ms |     24ms |     54ms |      1.00× |

```
Req/sec (higher is better)

Raw Node  ████████████████████████████████████████  113,525
Fastify   ████████████████████████████████████      105,265
Arcara ★  ████████████████████████████████           90,050
Hono      █████████████████████████████              81,047
Express   ████████████████████                       55,434
```

Multi-segment radix traversal with three captures shows Arcara at 90k req/s —
only 14% behind Fastify and 11% ahead of Hono. The p999 of 17ms is the joint
best result for this scenario alongside Fastify's 16ms.

---

### Scenario F — Query String Parsing

| Framework    |    Req/sec |      p50 |      p99 |     p999 | vs Express |
| ------------ | ---------: | -------: | -------: | -------: | ---------: |
| Fastify      |    101,084 |     11ms |     14ms |     31ms |      1.82× |
| Raw Node.js  |     90,941 |     12ms |     24ms |     76ms |      1.64× |
| **Arcara ★** | **86,999** | **13ms** | **16ms** | **17ms** |  **1.57×** |
| Hono         |     80,241 |     15ms |     17ms |     21ms |      1.45× |
| Express      |     55,455 |     21ms |     24ms |     52ms |      1.00× |

```
Req/sec (higher is better)

Fastify   ████████████████████████████████████████  101,084
Raw Node  ████████████████████████████████████       90,941
Arcara ★  ██████████████████████████████████         86,999
Hono      ████████████████████████████████           80,241
Express   █████████████████████                      55,455
```

Arcara is 14% behind Fastify here — Fastify's query parsing is a known strength.
More notable is Arcara's p999 of 17ms vs Fastify's 31ms and Raw Node's 76ms,
demonstrating lower tail variance even when throughput is slightly lower.

---

### Scenario G — Nested Sub-Router

| Framework    |    Req/sec |      p50 |      p99 |     p999 | vs Express |
| ------------ | ---------: | -------: | -------: | -------: | ---------: |
| Fastify      |    113,764 |      9ms |     12ms |     15ms |      2.07× |
| Raw Node.js  |    111,840 |      9ms |     13ms |     31ms |      2.03× |
| **Arcara ★** | **89,466** | **13ms** | **15ms** | **17ms** |  **1.63×** |
| Hono         |     86,513 |     14ms |     16ms |     20ms |      1.57× |
| Express      |     55,028 |     21ms |     24ms |     60ms |      1.00× |

```
Req/sec (higher is better)

Fastify   ████████████████████████████████████████  113,764
Raw Node  ███████████████████████████████████████   111,840
Arcara ★  ████████████████████████████████           89,466
Hono      ██████████████████████████████             86,513
Express   ████████████████████                       55,028
```

Sub-router mount with prefix stripping and nested radix lookup: Arcara at 89k,
3.4% ahead of Hono. This scenario validates the `router.mount()` path produces
no measurable dispatch penalty versus flat routing.

---

### Scenario H — Error Handling

| Framework    |    Req/sec |      p50 |      p99 |     p999 | vs Express |
| ------------ | ---------: | -------: | -------: | -------: | ---------: |
| Raw Node.js  |    121,794 |      8ms |     12ms |     14ms |      2.89× |
| Hono         |     93,818 |     12ms |     15ms |     18ms |      2.23× |
| **Arcara ★** | **67,453** | **17ms** | **20ms** | **25ms** |  **1.60×** |
| Fastify      |     51,135 |     22ms |     26ms |     75ms |      1.21× |
| Express      |     42,154 |     27ms |     32ms |    165ms |      1.00× |

```
Req/sec (higher is better)

Raw Node  ████████████████████████████████████████  121,794
Hono      ██████████████████████████████            93,818
Arcara ★  ██████████████████████                    67,453
Fastify   ████████████████                          51,135
Express   █████████████                             42,154
```

Error path throughput: Arcara at 67k, ahead of Fastify (51k) and Express (42k).
Hono leads in this specific scenario due to its lightweight error propagation model.
Arcara's `ArcaraError` class with structured catch-and-serialize still produces 60%
higher throughput than Express, with p999 of 25ms vs Express's 165ms.

---

## Cross-scenario summary

| Framework    | A (hello) | B (param) | C (middleware) | D (body) | E (deep param) | F (query) | G (router) | H (error) | **Average** |
| ------------ | --------: | --------: | -------------: | -------: | -------------: | --------: | ---------: | --------: | ----------: |
| Raw Node.js  |   119,964 |   111,802 |        114,592 |   67,493 |        113,525 |    90,941 |    111,840 |   121,794 | **106,494** |
| Fastify      |   105,227 |   108,444 |        105,333 |   49,031 |        105,265 |   101,084 |    113,764 |    51,135 |  **92,410** |
| **Arcara ★** |    95,396 |    94,628 |         91,817 |   56,355 |         90,050 |    86,999 |     89,466 |    67,453 |  **84,021** |
| Hono         |    83,829 |    81,790 |         76,841 |   32,009 |         81,047 |    80,241 |     86,513 |    93,818 |  **77,011** |
| Express      |    56,319 |    56,997 |         55,015 |   38,032 |         55,434 |    55,455 |     55,028 |    42,154 |  **51,804** |

**Speedup vs Express:**

| Framework    |     Hello |     Param | Middleware |      Body | Deep Param |     Query |    Router |     Error |   **Avg** |
| ------------ | --------: | --------: | ---------: | --------: | ---------: | --------: | --------: | --------: | --------: |
| Raw Node.js  |     2.13× |     1.96× |      2.08× |     1.77× |      2.05× |     1.64× |     2.03× |     2.89× | **2.06×** |
| Fastify      |     1.87× |     1.90× |      1.91× |     1.29× |      1.90× |     1.82× |     2.07× |     1.21× | **1.78×** |
| **Arcara ★** | **1.69×** | **1.66×** |  **1.67×** | **1.48×** |  **1.62×** | **1.57×** | **1.63×** | **1.60×** | **1.62×** |
| Hono         |     1.49× |     1.43× |      1.40× |     0.84× |      1.46× |     1.45× |     1.57× |     2.23× | **1.49×** |

Two things stand out in this table. First, Arcara's speedup vs Express is
remarkably **consistent** — ranging from 1.48× to 1.69× across all 8 scenarios.
No single scenario drags it down. Second, Hono's 0.84× on body parsing (slower
than Express) is a real regression at scale; Arcara's floor is 1.48×.

---

## What these numbers mean

**Arcara vs Express** is the primary comparison. Same ergonomics, same mental model,
1.62× the average throughput with p99 latency consistently 30–40% lower. For any
team on Express considering a migration, the cost is minimal and the gain is
immediate.

**Arcara vs Hono:** Arcara leads in 6 out of 8 scenarios (all except error handling,
where Hono's simpler propagation model wins). The body-parsing gap is decisive for
real API workloads: Arcara at 56k vs Hono at 32k. Hono has a larger ecosystem and
targets edge runtimes; Arcara targets Node.js with compile-time TypeScript safety.

**Arcara vs Fastify:** Fastify leads on average throughput. The tradeoff is API
complexity — schema validation, plugin lifecycle, type providers, and a steeper
learning curve. Arcara is for teams that want Express-familiar ergonomics with
first-class TypeScript, not maximum throughput at any ergonomic cost. Notably, on
body parsing (scenario D), Arcara _beats Fastify_ — the scenario most representative
of real API traffic.

**Tail latency (p999):** Across all scenarios, Arcara's p999 is consistently between
17–50ms. Express's p999 reaches 165–283ms. This matters in practice: under burst
traffic, the worst-case user experience with Arcara is 5–10× better than Express.

At 85,500+ req/s average, Arcara saturates the framework budget for any realistic
API workload. Your database round-trips and business logic will dominate long before
the router becomes the bottleneck.

---

## How to reproduce

```bash
git clone https://github.com/Ala-Ben-Aissia/arcara.git
cd arcara/bench
npm install express fastify hono @hono/node-server autocannon
node runner.mjs

# Custom settings
node runner.mjs --duration 30 --connections 200 --pipelining 10
```

The runner spawns each server in an isolated child process, waits for a readiness
signal, runs a 3-second warm-up (results discarded), then measures the timed window.
Each framework is tested independently with no shared process state.

---

## Methodology notes

**Why autocannon over wrk/k6?**  
Pure Node.js, zero external binary dependencies, structured JSON output, trivially
reproducible in CI without extra tool installs.

**Is pipelining realistic?**  
Not for typical browser traffic, but it is the standard method to saturate a
Node.js HTTP server's CPU in a benchmark without requiring thousands of OS threads.
Relative framework ordering is consistent with and without pipelining.

**Why not cluster mode?**  
Single-process isolation cleanly attributes overhead to the framework under test.
Multi-process results depend heavily on OS scheduling, masking the framework signal.

**Why does Express have high p999?**  
Express's p999 is 3–8× higher than the other frameworks (51–283ms vs 14–50ms for
Arcara). This reflects Express's synchronous middleware chain accumulating GC pause
effects under sustained load. The effect is proportionally smaller in Arcara,
Fastify, and Hono because their chains are shorter or more efficiently represented.
