/**
 * Arcara Load Test
 *
 * Usage:
 *   npx tsx load-test.ts
 *   npx tsx load-test.ts --url http://localhost:3000/api/users --concurrency 50 --duration 10
 *
 * Flags:
 *   --url         Target URL           (default: http://localhost:3000/)
 *   --concurrency Parallel workers     (default: 20)
 *   --duration    Test duration in sec (default: 5)
 *   --method      HTTP method          (default: GET)
 */

import http from 'node:http';
import { parseArgs } from 'node:util';

// ── CLI args ─────────────────────────────────────────────────────────────────

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://localhost:3000/' },
    concurrency: { type: 'string', default: '20' },
    duration: { type: 'string', default: '5' },
    method: { type: 'string', default: 'GET' },
  },
  strict: false,
});

const TARGET = values.url as string;
const CONCURRENCY = parseInt(values.concurrency as string, 10);
const DURATION_MS = parseInt(values.duration as string, 10) * 1000;
const METHOD = (values.method as string).toUpperCase();

// ── Single request (raw http — no fetch overhead) ─────────────────────────────

function request(url: URL): Promise<{ status: number; latency: number }> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();

    const agent = new http.Agent({
      keepAlive: true,
      maxSockets: CONCURRENCY, // one socket per worker, no queuing
    });

    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + url.search,
        method: METHOD,
        headers: { connection: 'keep-alive' },
        agent,
      },
      (res) => {
        // Drain — must consume body or socket backs up
        res.resume();
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            latency: performance.now() - t0,
          }),
        );
      },
    );

    req.on('error', reject);
    req.end();
  });
}

// ── Worker loop — fires requests back-to-back for the full duration ───────────

async function worker(
  url: URL,
  endAt: number,
  results: { status: number; latency: number }[],
  errors: Error[],
): Promise<void> {
  while (performance.now() < endAt) {
    try {
      results.push(await request(url));
    } catch (e) {
      errors.push(e as Error);
    }
  }
}

// ── Stats ─────────────────────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return Math.round(sorted[Math.max(0, idx)]!);
}

function summarize(
  results: { status: number; latency: number }[],
  errors: Error[],
  durationMs: number,
): void {
  const total = results.length;
  const successful = results.filter(
    (r) => r.status >= 200 && r.status < 500,
  ).length;
  const rps = Math.round((total / durationMs) * 1000);

  const latencies = results.map((r) => r.latency).sort((a, b) => a - b);
  const avg = latencies.reduce((s, l) => s + l, 0) / latencies.length;

  const statusMap = new Map<number, number>();
  for (const r of results)
    statusMap.set(r.status, (statusMap.get(r.status) ?? 0) + 1);

  const line = '─'.repeat(44);

  console.log(`\n${line}`);
  console.log(`  Arcara Load Test Results`);
  console.log(line);
  console.log(`  Target      ${TARGET}`);
  console.log(`  Method      ${METHOD}`);
  console.log(`  Concurrency ${CONCURRENCY} workers`);
  console.log(`  Duration    ${DURATION_MS / 1000}s`);
  console.log(line);
  console.log(`  Requests    ${total.toLocaleString()} total`);
  console.log(`  Req/sec     ${rps.toLocaleString()} rps`);
  console.log(
    `  Success     ${successful.toLocaleString()} (${Math.round((successful / total) * 100)}%)`,
  );
  console.log(`  Errors      ${errors.length}`);
  console.log(line);
  console.log(`  Latency`);
  console.log(`    avg       ${Math.round(avg)}ms`);
  console.log(`    p50       ${percentile(latencies, 50)}ms`);
  console.log(`    p90       ${percentile(latencies, 90)}ms`);
  console.log(`    p99       ${percentile(latencies, 99)}ms`);
  console.log(`    min       ${Math.round(latencies[0]!)}ms`);
  console.log(
    `    max       ${Math.round(latencies[latencies.length - 1]!)}ms`,
  );
  console.log(line);
  console.log(`  Status codes`);
  for (const [code, count] of [...statusMap.entries()].sort()) {
    console.log(`    ${code}        ${count.toLocaleString()}`);
  }
  console.log(line);

  if (errors.length > 0) {
    console.log(`\n  First 3 errors:`);
    errors.slice(0, 3).forEach((e) => console.log(`    ${e.message}`));
  }

  console.log();
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const url = new URL(TARGET);

  console.log(`\nWarming up (1s)...`);

  // 1s warm-up — JIT + connection pool settle
  const warmupEnd = performance.now() + 1000;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, 5) }, () =>
      worker(url, warmupEnd, [], []),
    ),
  );

  console.log(
    `Running ${CONCURRENCY} workers for ${DURATION_MS / 1000}s → ${TARGET}\n`,
  );

  const results: { status: number; latency: number }[] = [];
  const errors: Error[] = [];
  const endAt = performance.now() + DURATION_MS;

  await Promise.all(
    Array.from({ length: CONCURRENCY }, () =>
      worker(url, endAt, results, errors),
    ),
  );

  summarize(results, errors, DURATION_MS);
}

main().catch((e) => {
  console.error('Load test failed:', e.message);
  process.exit(1);
});

// BEFORE RADIX TREE
// ────────────────────────────────────────────
//   Arcara Load Test Results
// ────────────────────────────────────────────
//   Target      http://localhost:3000/
//   Method      GET
//   Concurrency 20 workers
//   Duration    5s
// ────────────────────────────────────────────
//   Requests    33,940 total
//   Req/sec     6,788 rps
//   Success     33,940 (100%)
//   Errors      0
// ────────────────────────────────────────────
//   Latency
//     avg       3ms
//     p50       3ms
//     p90       3ms
//     p99       4ms
//     min       1ms
//     max       25ms
// ────────────────────────────────────────────
//   Status codes
//     200        33,940
// ────────────────────────────────────────────

// AFTER RADIX TREE
