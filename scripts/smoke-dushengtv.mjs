// Run inside the container: docker compose exec -T danmu-api node --input-type=module < scripts/smoke-dushengtv.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parse } from 'dotenv';

const settings = { ...parse(readFileSync('config/.env', 'utf8')), ...process.env };
const token = settings.TOKEN;
const adminToken = settings.ADMIN_TOKEN;
const secrets = [token, adminToken].filter(Boolean);
const redact = message => secrets.reduce((text, secret) => text.split(secret).join('[redacted]'), String(message));
const port = Number(settings.DANMU_API_PORT || 9321);
let resourceKey;

async function request(path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...options,
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`Smoke request failed with HTTP ${response.status}`);
  return response.json();
}

try {
  assert.ok(token && token.length >= 32 && token !== '87654321', 'Set a custom TOKEN of at least 32 characters before running the smoke check.');
  assert.ok(adminToken && adminToken !== token, 'Set a separate ADMIN_TOKEN before running the smoke check.');
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535, 'Invalid DANMU_API_PORT.');
  assert.ok(String(settings.SOURCE_ORDER || '').split(',').map(source => source.trim()).includes('local'), 'SOURCE_ORDER must include local.');

  const title = `DuShengTV deployment smoke ${randomUUID()}`;
  const year = new Date().getFullYear();
  const fixture = [
    { time: 1.25, mode: 1, color: 16777215, text: 'DuShengTV local smoke first' },
    { time: 3.5, mode: 1, color: 16711680, text: 'DuShengTV local smoke second' }
  ];
  const form = new FormData();
  form.set('title', title);
  form.set('year', String(year));
  form.set('type', 'movie');
  form.set('file', new Blob([JSON.stringify(fixture)], { type: 'application/json' }), 'dushengtv-smoke.json');

  const uploaded = await request(`/${encodeURIComponent(adminToken)}/api/v2/local-danmu/upload`, {
    method: 'POST',
    body: form
  });
  resourceKey = uploaded.resource?.resourceKey;
  assert.equal(uploaded.success, true, 'Local fixture upload failed.');
  assert.ok(resourceKey, 'Upload did not return a resource key.');
  assert.equal(uploaded.resource.count, fixture.length, 'Local fixture parsing failed.');

  // The adapter resolves this exact uploaded movie before any remote search.
  const result = await request('/api/v1/dushengtv/danmaku', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, type: 'Movie', year })
  });
  assert.equal(result.available, true, 'The adapter did not find the uploaded local movie.');
  assert.equal(result.match?.source, 'local', 'The adapter did not use the local fixture.');
  assert.ok(Array.isArray(result.comments), 'The adapter did not return normalized comments.');
  assert.equal(result.comments.length, fixture.length, 'The adapter returned an unexpected comment count.');
  for (const expected of fixture) {
    const actual = result.comments.find(comment => comment.text === expected.text);
    assert.ok(actual, 'A fixture comment was missing from the adapter response.');
    assert.equal(Number(actual.time), expected.time, 'A fixture timestamp changed.');
    assert.equal(actual.color, `#${expected.color.toString(16).padStart(6, '0')}`, 'A fixture color changed.');
  }
} catch (error) {
  process.exitCode = 1;
  console.error(`DuShengTV smoke failed: ${redact(error.message)}`);
} finally {
  if (resourceKey) {
    try {
      const deleted = await request(`/${encodeURIComponent(adminToken)}/api/v2/local-danmu/${encodeURIComponent(resourceKey)}`, { method: 'DELETE' });
      assert.equal(deleted.success, true, 'Could not delete the local fixture.');
    } catch (error) {
      process.exitCode = 1;
      console.error(`Fixture cleanup failed: ${redact(error.message)}. Remove the resource named "DuShengTV deployment smoke" in the admin UI.`);
    }
  }
}

if (!process.exitCode) console.log('DuShengTV smoke passed: local upload, Bearer API, normalized comments, cleanup.');
