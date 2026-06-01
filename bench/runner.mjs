/**
 * Arcara Comparative Benchmark Runner
 *
 * Place this file in your bench/ directory alongside a servers/ folder.
 *
 * Usage:
 *   node runner.mjs
 *   node runner.mjs --duration 15 --connections 100 --pipelining 10
 */

import autocannon from 'autocannon';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVERS_DIR = __dirname;

// ── CLI ───────────────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    duration: { type: 'string', default: '15' },
    connections: { type: 'string', default: '100' },
    pipelining: { type: 'string', default: '10' },
  },
  strict: false,
});

const DURATION = parseInt(args.duration);
const CONNECTIONS = parseInt(args.connections);
const PIPELINING = parseInt(args.pipelining);
const WARMUP_S = 3;

// ── Scenario definitions ──────────────────────────────────────────────────────

const SCENARIOS = [
  {
    id: 'hello',
    name: 'Hello World (JSON)',
    desc: 'GET / → { message: "hello" }  —  baseline routing + serialisation',
    path: '/',
    method: 'GET',
  },
  {
    id: 'param',
    name: 'Parameterized Route',
    desc: 'GET /users/:id → { id }  —  radix lookup + single param extraction',
    path: '/users/42',
    method: 'GET',
  },
  {
    id: 'middleware',
    name: 'Middleware Chain (×3)',
    desc: 'GET / with 3 sequential sync middlewares  —  chain traversal cost',
    path: '/',
    method: 'GET',
  },
  {
    id: 'body',
    name: 'JSON Body Parsing',
    desc: 'POST /users with JSON body  —  stream read + parse + response',
    path: '/users',
    method: 'POST',
    body: JSON.stringify({ name: 'alice' }),
    headers: { 'Content-Type': 'application/json' },
  },
  {
    id: 'deep-param',
    name: 'Deep Param Route (×3)',
    desc: 'GET /orgs/:orgId/repos/:repoId/issues/:issueId  —  multi-segment traversal',
    path: '/orgs/acme/repos/backend/issues/99',
    method: 'GET',
  },
  {
    id: 'query',
    name: 'Query String Parsing',
    desc: 'GET /search?q=hello&limit=10&offset=0  —  URL parse + query object build',
    path: '/search?q=hello&limit=10&offset=0',
    method: 'GET',
  },
  {
    id: 'router',
    name: 'Nested Sub-Router',
    desc: 'GET /api/v1/users/:id  —  mount + prefix strip + nested radix lookup',
    path: '/api/v1/users/42',
    method: 'GET',
  },
  {
    id: 'error',
    name: 'Error Handling',
    desc: 'GET /protected → 401  —  throw → catch → error handler → json response',
    path: '/protected',
    method: 'GET',
    expectedStatus: 401,
  },
];

// ── Framework definitions ─────────────────────────────────────────────────────

const FRAMEWORKS = [
  {
    id: 'node',
    name: 'Raw Node.js',
    file: join(SERVERS_DIR, 'node.mjs'),
    port: 3011,
    runner: 'node',
    note: 'Hardcoded routing per scenario — throughput ceiling, not a fair routing comparison',
  },
  {
    id: 'fastify',
    name: 'Fastify',
    file: join(SERVERS_DIR, 'fastify.mjs'),
    port: 3012,
    runner: 'node',
  },
  {
    id: 'hono',
    name: 'Hono',
    file: join(SERVERS_DIR, 'hono.mjs'),
    port: 3013,
    runner: 'node',
  },
  {
    id: 'arcara',
    name: 'Arcara',
    file: join(SERVERS_DIR, 'arcara.mjs'),
    port: 3014,
    runner: 'node',
    highlight: true,
  },
  {
    id: 'express',
    name: 'Express',
    file: join(SERVERS_DIR, 'express.mjs'),
    port: 3015,
    runner: 'node',
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer(fw, scenario) {
  const cmd = fw.runner === 'tsx' ? 'tsx' : 'node';
  const cmdArgs = [fw.file, String(fw.port), scenario.id];

  const proc = spawn(cmd, cmdArgs, {
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  const stderrChunks = [];
  proc.stderr.on('data', (chunk) => stderrChunks.push(chunk));
  proc.getStderr = () => Buffer.concat(stderrChunks).toString().trim();
  proc.on('error', (err) => {
    proc._spawnError = err;
  });

  return proc;
}

async function waitReady(port, proc, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (proc.exitCode !== null || proc._spawnError) {
      const reason = proc._spawnError
        ? proc._spawnError.message
        : `exited with code ${proc.exitCode}`;
      const stderr = proc.getStderr();
      throw new Error(
        `Process ${reason}${stderr ? `\n    ${stderr.split('\n').slice(0, 5).join('\n    ')}` : ''}`,
      );
    }

    await sleep(100);

    const alive = await new Promise((resolve) => {
      const req = http.get(
        { hostname: '127.0.0.1', port, path: '/', timeout: 300 },
        (res) => {
          res.resume();
          resolve(true);
        },
      );
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
    });

    if (alive) return;
  }

  const stderr = proc.getStderr();
  throw new Error(
    `Server on :${port} did not respond within ${timeoutMs}ms` +
      (stderr ? `\n    ${stderr.split('\n').slice(0, 8).join('\n    ')}` : ''),
  );
}

async function runBench(port, scenario) {
  const cannonOpts = {
    url: `http://127.0.0.1:${port}${scenario.path}`,
    method: scenario.method ?? 'GET',
    connections: CONNECTIONS,
    pipelining: PIPELINING,
  };

  if (scenario.body) {
    cannonOpts.body = scenario.body;
    cannonOpts.headers = scenario.headers ?? {};
  }

  // Warm-up (discarded)
  await new Promise((res, rej) => {
    const w = autocannon({ ...cannonOpts, duration: WARMUP_S }, (err) =>
      err ? rej(err) : res(),
    );
    autocannon.track(w, {
      renderProgressBar: false,
      renderResultsTable: false,
    });
  });

  // Timed run
  return new Promise((res, rej) => {
    const inst = autocannon(
      { ...cannonOpts, duration: DURATION },
      (err, result) => {
        if (err) return rej(err);
        res({
          rps: Math.round(result.requests.mean),
          p50: result.latency.p50,
          p99: result.latency.p99,
          p999: result.latency.p99_9,
        });
      },
    );
    autocannon.track(inst, {
      renderProgressBar: false,
      renderResultsTable: false,
    });
  });
}

// ── Average RPS across all scenarios ─────────────────────────────────────────

function avgRps(fwId) {
  const vals = SCENARIOS.map((s) => RESULTS[s.id]?.[fwId]?.rps ?? 0);
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

// ── Main ──────────────────────────────────────────────────────────────────────

const RESULTS = {};
const SEP = '─'.repeat(72);

console.log(`\n${SEP}`);
console.log(`  Arcara Comparative Benchmark`);
console.log(
  `  Node.js ${process.version}  ·  ${CONNECTIONS} connections  ·  pipelining ${PIPELINING}  ·  ${DURATION}s runs`,
);
console.log(SEP);

for (const scenario of SCENARIOS) {
  console.log(`\n  Scenario: ${scenario.name}`);
  console.log(`  ${scenario.desc}\n`);
  RESULTS[scenario.id] = {};

  for (const fw of FRAMEWORKS) {
    const label = (fw.highlight ? '★ ' : '  ') + fw.name.padEnd(18);
    process.stdout.write(`  ${label} `);

    const proc = startServer(fw, scenario);

    try {
      await waitReady(fw.port, proc);
      const r = await runBench(fw.port, scenario);
      RESULTS[scenario.id][fw.id] = r;
      console.log(
        `${String(r.rps.toLocaleString()).padStart(8)} req/s` +
          `  p50=${r.p50}ms  p99=${r.p99}ms  p999=${r.p999}ms`,
      );
    } catch (e) {
      RESULTS[scenario.id][fw.id] = null;
      const lines = e.message.split('\n');
      console.log(`FAILED — ${lines[0]}`);
      if (lines.length > 1) console.log(lines.slice(1).join('\n'));
    } finally {
      proc.kill('SIGKILL');
      await sleep(200);
    }
  }
}

// ── Summary — sorted by average RPS descending ────────────────────────────────

const sorted = [...FRAMEWORKS].sort((a, b) => avgRps(b.id) - avgRps(a.id));

console.log(`\n${SEP}`);
console.log(`  Summary — Requests/sec (higher is better, sorted by average)`);
console.log(SEP);

const COL = 22;
const scenarioHeader = SCENARIOS.map((s) => s.name.padStart(COL)).join('');
const header =
  'Framework'.padEnd(20) + scenarioHeader + '  Average'.padStart(COL);
console.log(`  ${header}`);
console.log(`  ${'─'.repeat(header.length)}`);

for (const [rank, fw] of sorted.entries()) {
  const tag = fw.highlight ? '★ ' : `${rank + 1}.`.padStart(2) + ' ';
  const avg = avgRps(fw.id);
  const cols = SCENARIOS.map((s) => {
    const r = RESULTS[s.id]?.[fw.id];
    return r ? r.rps.toLocaleString().padStart(COL) : '—'.padStart(COL);
  }).join('');
  const avgCol =
    avg > 0
      ? Math.round(avg).toLocaleString().padStart(COL)
      : '—'.padStart(COL);
  console.log(`  ${tag}${fw.name.padEnd(20)}${cols}${avgCol}`);
}

// ── Speedup vs Express ────────────────────────────────────────────────────────

console.log(`\n  Speedup vs Express (per scenario + overall average)`);
for (const fw of sorted.filter((f) => f.id !== 'express')) {
  const mults = SCENARIOS.map((s) => {
    const a = RESULTS[s.id]?.[fw.id];
    const e = RESULTS[s.id]?.express;
    return a && e ? `${(a.rps / e.rps).toFixed(2)}×` : '—';
  });
  const avgMult = (() => {
    const a = avgRps(fw.id);
    const e = avgRps('express');
    return a && e ? `${(a / e).toFixed(2)}×` : '—';
  })();
  console.log(
    `  ${fw.name.padEnd(20)} ${mults.map((m) => m.padStart(8)).join('  ')}  avg ${avgMult}`,
  );
}

// ── Machine-readable JSON ─────────────────────────────────────────────────────

console.log(`\n${SEP}`);
console.log('  Raw JSON (paste into BENCHMARKS.md):');
console.log(JSON.stringify(RESULTS, null, 2));
console.log(SEP + '\n');
