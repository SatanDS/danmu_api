// Offline HTTP integration check: node scripts/test-dushengtv-http.mjs
// Uses a temporary copy of the server, private config/cache, and loopback-only sockets.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { cp, copyFile, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
const temporaryParent = path.resolve(tmpdir());
const runtime = await mkdtemp(path.join(temporaryParent, 'dusheng-http-test-'));
const token = randomBytes(32).toString('hex');
const adminToken = randomBytes(32).toString('hex');
const redact = value => String(value).split(token).join('[redacted]').split(adminToken).join('[redacted]');
const env = {};
for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR']) {
  if (process.env[key] !== undefined) env[key] = process.env[key];
}
let server;
let serverOutput = '';

async function availablePort() {
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return port;
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const force = setTimeout(() => child.kill('SIGKILL'), 3000);
  try { await exited; } finally { clearTimeout(force); }
}

try {
  await cp(path.join(repo, 'danmu_api'), path.join(runtime, 'danmu_api'), { recursive: true });
  await copyFile(path.join(repo, 'package.json'), path.join(runtime, 'package.json'));
  await symlink(path.join(repo, 'node_modules'), path.join(runtime, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  await mkdir(path.join(runtime, 'config'), { mode: 0o700 });
  await mkdir(path.join(runtime, '.cache'), { mode: 0o700 });
  const port = await availablePort();
  await writeFile(path.join(runtime, 'config', '.env'), [
    `TOKEN=${token}`, `ADMIN_TOKEN=${adminToken}`, `DANMU_API_PORT=${port}`,
    'SOURCE_ORDER=local', 'USE_BANGUMI_DATA=false', 'LOCAL_CACHE_ENABLED=true',
    'REMEMBER_LAST_SELECT=false', 'LOG_LEVEL=warn', 'RATE_LIMIT_MAX_REQUESTS=3',
    'FAVORITE_REQUIRE_ADMIN=true', 'LOCAL_DANMU_NOT_REQUIRE_ADMIN=false', ''
  ].join('\n'), { mode: 0o600 });

  const preload = path.join(runtime, 'offline.mjs');
  await writeFile(preload, `
import net from 'node:net';
import { appendFileSync } from 'node:fs';
const allowed = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
function check(host) {
  if (!allowed.has(String(host))) {
    appendFileSync(${JSON.stringify(path.join(runtime, 'blocked-network.log'))}, 'blocked outbound\\n');
    throw new Error('Non-loopback network is disabled during this test');
  }
}
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function(options, ...args) {
  if (options && typeof options === 'object') {
    options = { ...options, host: '127.0.0.1', ipv6Only: false, port: options.port === 5321 ? 0 : options.port };
  }
  return listen.call(this, options, ...args);
};
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function(...args) {
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  check(options && typeof options === 'object' ? options.host || options.hostname || 'localhost' : typeof args[1] === 'string' ? args[1] : 'localhost');
  return connect.apply(this, args);
};
const fetch = globalThis.fetch;
globalThis.fetch = function(input, options) {
  check(new URL(typeof input === 'string' || input instanceof URL ? input : input.url).hostname);
  return fetch(input, options);
};
`);
  server = spawn(process.execPath, ['--import', pathToFileURL(preload).href, path.join(runtime, 'danmu_api', 'server.js')], {
    cwd: runtime, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  for (const stream of [server.stdout, server.stderr]) stream.on('data', chunk => {
    serverOutput = (serverOutput + chunk.toString()).slice(-32000);
  });

  const base = `http://127.0.0.1:${port}`;
  const fetchLocal = (route, options = {}) => fetch(base + route, { ...options, signal: AbortSignal.timeout(5000) });
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (server.exitCode !== null) throw new Error('Server exited during startup');
    try { ready = (await fetchLocal('/healthz')).ok; } catch {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'Server health check did not become ready');
  const health = await fetchLocal('/healthz');
  assert.deepEqual(await health.json(), { status: 'ok' });
  assert.equal(health.headers.get('cache-control'), 'no-store');
  const head = await fetchLocal('/healthz?test=1', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  console.log('HTTP health passed: GET, HEAD, no-store.');

  const route = '/api/v1/dushengtv/danmaku';
  const post = (body, credential = token) => fetchLocal(route, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(credential ? { Authorization: `Bearer ${credential}` } : {}) }, body
  });
  for (const credential of ['', 'x'.repeat(64), adminToken]) {
    assert.equal((await post('{}', credential)).status, 401);
  }
  assert.equal((await fetchLocal(route)).status, 405);
  assert.equal((await post('{')).status, 400);
  assert.equal((await post(JSON.stringify({ title: 'https://invalid.test/', type: 'Movie' }))).status, 400);
  assert.equal((await post('x'.repeat(16385))).status, 413);
  for (const [season, episode] of [[0, 1], [1, 0]]) {
    const response = await post(JSON.stringify({ title: 'Offline unsupported episode', type: 'Episode', season, episode }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).available, false);
  }
  console.log('HTTP validation passed: missing/wrong/admin credentials, method, JSON, metadata, 16 KiB limit, S00/E00.');

  const smoke = spawn(process.execPath, ['--import', pathToFileURL(preload).href, path.join(repo, 'scripts', 'smoke-dushengtv.mjs')], {
    cwd: runtime, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  let smokeOutput = '';
  for (const stream of [smoke.stdout, smoke.stderr]) stream.on('data', chunk => { smokeOutput += chunk.toString(); });
  const timeout = setTimeout(() => smoke.kill('SIGKILL'), 25000);
  try {
    const [code] = await once(smoke, 'exit');
    assert.equal(code, 0, redact(smokeOutput));
  } finally { clearTimeout(timeout); await stop(smoke); }
  console.log(redact(smokeOutput).trim());
  const list = await fetchLocal(`/${adminToken}/api/v2/local-danmu/list`);
  assert.deepEqual((await list.json()).resources, []);
  let blocked = '';
  try { blocked = await readFile(path.join(runtime, 'blocked-network.log'), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  assert.equal(blocked, '', 'The service attempted external network access');
  console.log('Offline verification passed: no outbound attempts, no local fixture left behind.');
} catch (error) {
  process.exitCode = 1;
  console.error(redact(error.stack || error.message));
  if (serverOutput) console.error(redact(serverOutput));
} finally {
  await stop(server);
  // Remove only the generated link, then the verified temporary runtime.
  await unlink(path.join(runtime, 'node_modules')).catch(error => { if (error.code !== 'ENOENT') throw error; });
  assert.equal(path.dirname(path.resolve(runtime)), temporaryParent);
  assert.ok(path.basename(runtime).startsWith('dusheng-http-test-'));
  await rm(runtime, { recursive: true, force: true });
}
