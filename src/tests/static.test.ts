import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Arcara } from '../index.js';
import { serveStatic } from '../utils/static.js';

interface TestServer {
  app: Arcara;
  port: number;
  close: () => Promise<void> | void;
}

async function createTestServer(
  setup: (app: Arcara) => void,
): Promise<TestServer> {
  const app = new Arcara();
  setup(app);

  await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));

  const port = (app['server'].address() as { port: number }).port;

  return { app, port, close: () => app.close() };
}

function request(
  port: number,
  method: string,
  pathStr: string,
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, method, path: pathStr },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('serveStatic middleware', () => {
  let server: TestServer;
  let root: string;

  before(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'arcara-static-'));
    await fs.writeFile(path.join(root, 'hello.txt'), 'hello world', 'utf8');
    await fs.writeFile(
      path.join(root, 'index.html'),
      '<!doctype html><html>INDEX</html>',
      'utf8',
    );

    server = await createTestServer((app) => {
      app.use(serveStatic(root));
    });
  });

  after(async () => {
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('serves a file by path', async () => {
    const res = await request(server.port, 'GET', '/hello.txt');
    assert.equal(res.status, 200);
    assert.equal(res.body, 'hello world');
    assert.match(res.headers['content-type'] ?? '', /text\/(plain|html)/);
  });

  it('responds to HEAD with headers only', async () => {
    const res = await request(server.port, 'HEAD', '/hello.txt');
    assert.equal(res.status, 200);
    assert.equal(res.body, '');
  });

  it('serves index file for directory root', async () => {
    const res = await request(server.port, 'GET', '/');
    assert.equal(res.status, 200);
    assert.match(res.body, /INDEX/);
    assert.match(res.headers['content-type'] ?? '', /text\/html/);
  });

  it('returns 404 when file not found (next passes to router)', async () => {
    const res = await request(server.port, 'GET', '/does-not-exist.txt');
    assert.equal(res.status, 404);
  });
});
