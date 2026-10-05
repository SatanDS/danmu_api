import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDanmakuCache, danmakuCacheKey, danmakuCacheScope, cacheableResult, clampCacheDays, getPersistentDanmakuCache, DAY_MS } from './dushengtv-cache.js';
import { createDuShengTVHandler, metadataFrom } from '../apis/clients/dushengtv-api.js';
import { Envs } from '../configs/envs.js';
import { Globals } from '../configs/globals.js';
import { withFreshDuShengTVFetch, getSearchCache, setSearchCache, getCommentCache, setCommentCache, addAnime } from './cache-util.js';
import { getComment, searchAnime } from '../apis/dandan-api.js';
import { getSourceByKey } from '../sources/registry.js';

const film = { title: 'Same film', type: 'Movie', year: 2024, providerIds: { Imdb: 'tt29308412' } };
const show = { title: 'Same show', type: 'Episode', season: 2, episode: 4, providerIds: { Imdb: 'tt123' } };
const success = text => ({ available: true, comments: [{ time: 1, mode: 1, color: '#ffffff', text }],
  match: { episodeId: 42, animeTitle: 'Same film', episodeTitle: 'Movie', doubanId: '33458979', matchedBy: 'Imdb' } });
const secret = 'private-test-token-'.padEnd(64, 'x');
async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'dushengtv-sqlite-'));
  const filename = path.join(directory, 'comments.sqlite');
  let timestamp = Date.UTC(2026, 9, 5);
  let cache = await openDanmakuCache({ filename, now: () => timestamp, ...options });
  t.after(async () => { cache.close(); await rm(directory, { recursive: true, force: true }); });
  return { filename, get cache() { return cache; }, advance(ms) { timestamp += ms; }, now: () => timestamp,
    async reopen() { cache.close(); cache = await openDanmakuCache({ filename, now: () => timestamp, ...options }); } };
}
function adapter(f, overrides = {}) {
  let requests = 0;
  const handler = createDuShengTVHandler({ getCache: async () => f.cache, now: f.now,
    match: async () => { requests++; return Response.json({ isMatched: true, matches: [{ episodeId: 42 }], identity: { doubanId: '33458979', matchedBy: 'Imdb' } }); },
    getComments: async () => Response.json({ comments: success('remote').comments }), ...overrides });
  return { get requests() { return requests; }, async request(metadata = film, options = {}) {
    const response = await handler(new Request('http://local/api/v1/dushengtv/danmaku', { method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, body: JSON.stringify(metadata) }), { token: secret, ...options });
    return { status: response.status, data: await response.json() };
  } };
}

test('canonical keys share proven movie IDs, preserve all IDs, type, year and episode boundaries', () => {
  const key = metadata => danmakuCacheKey(metadataFrom(metadata));
  assert.equal(key(film), key({ ...film, title: 'A translated title', year: 2025 }));
  assert.equal(key({ ...film, providerIds: { Douban: '33458979', Imdb: 'tt29308412' } }), key({ ...film, providerIds: { IMDb: 'tt29308412', douban: '33458979' } }));
  for (const other of [{ ...film, providerIds: { Imdb: 'tt124' } }, { ...film, providerIds: { Douban: '33458979' } }, { ...film, type: 'local' }]) assert.notEqual(key(film), key(other));
  assert.notEqual(key({ ...film, providerIds: {} }), key({ ...film, providerIds: {}, year: 2025 }));
  for (const other of [{ ...show, episode: 5 }, { ...show, season: 3 }, { ...show, title: 'Another show' }]) assert.notEqual(key(show), key(other));
  assert.equal(cacheableResult(film, success('yes')), true);
  assert.equal(cacheableResult(film, { ...success('yes'), match: {} }), false);
  assert.equal(cacheableResult({ ...film, providerIds: { Douban: '123', Imdb: 'tt29308412' } }, success('yes')), false);
});

test('source/matching/output changes invalidate cache without including account credentials', () => {
  const config = { sourceOrderArr: ['douban', 'tencent'], strictTitleMatch: true, danmuOffset: 'Film:2' };
  const base = danmakuCacheScope(config);
  assert.notEqual(base, danmakuCacheScope({ ...config, sourceOrderArr: ['douban'] }));
  assert.notEqual(base, danmakuCacheScope({ ...config, strictTitleMatch: false }));
  assert.notEqual(base, danmakuCacheScope({ ...config, danmuOffset: 'Film:3' }));
  assert.equal(base, danmakuCacheScope({ ...config, token: secret, adminToken: secret, doubanCookie: secret }));
});

test('SQLite survives a process-style reopen; TTL is configurable from 7 to 30 days', async t => {
  const f = await fixture(t);
  const key = danmakuCacheKey(film);
  assert.equal(f.cache.put(key, success('persistent')), true);
  await f.reopen();
  assert.equal(f.cache.get(key).value.comments[0].text, 'persistent');
  f.advance(8 * DAY_MS);
  assert.equal(f.cache.get(key).stale, false);
  f.cache.configure({ ttlDays: 7 }); assert.equal(f.cache.get(key).stale, true);
  f.cache.configure({ ttlDays: 30 }); assert.equal(f.cache.get(key).stale, false);
  f.advance(23 * DAY_MS); assert.equal(f.cache.get(key).stale, true);
  assert.deepEqual([clampCacheDays(2), clampCacheDays(100), clampCacheDays(undefined)], [7, 30, 14]);
  const bytes = await readFile(f.filename);
  assert.equal(bytes.includes(Buffer.from(film.providerIds.Imdb)), false);
  assert.equal(bytes.includes(Buffer.from(secret)), false);
});

test('empty/oversized replacement and capacity failures retain the old successful row atomically', async t => {
  const f = await fixture(t, { maxBytes: 2000 });
  f.cache.put('a', success('previous'));
  const previous = f.cache.get('a');
  assert.equal(f.cache.put('a', { available: false, comments: [] }), false);
  assert.equal(f.cache.put('a', success('x'.repeat(3000))), false);
  f.cache.put('b', success('protected'));
  const release = f.cache.protect('b');
  f.cache.configure({ maxBytes: 450 });
  assert.equal(f.cache.put('a', success('x'.repeat(100))), false);
  release();
  assert.deepEqual(f.cache.get('a').value, previous.value);
  assert.equal(f.cache.stats().entries, 2);
});

test('SQLite transaction errors roll back replacement without erasing the old row', async t => {
  const f = await fixture(t);
  f.cache.put('film', success('keep after SQL failure'));
  const { DatabaseSync } = await import('node:sqlite');
  const control = new DatabaseSync(f.filename);
  control.exec("CREATE TRIGGER reject_test_update BEFORE UPDATE OF payload ON comments BEGIN SELECT RAISE(ABORT, 'test write failure'); END");
  control.close();
  assert.throws(() => f.cache.put('film', success('new content')), /test write failure/);
  assert.equal(f.cache.get('film').value.comments[0].text, 'keep after SQL failure');
  assert.equal(f.cache.stats().entries, 1);
});

test('expiration never deletes successful fallback data; only capacity evicts LRU and protects refreshes', async t => {
  const f = await fixture(t);
  f.cache.put('old-idle', success('unused'));
  f.cache.put('refreshing', success('keep'));
  f.cache.put('recently-read', success('active'));
  const release = f.cache.protect('refreshing');
  f.advance(15 * DAY_MS);
  f.cache.get('recently-read');
  f.cache.maintain();
  f.cache.put('another-film', success('new'));
  assert.equal(f.cache.get('old-idle').value.comments[0].text, 'unused');
  assert.equal(f.cache.get('old-idle').stale, true);
  assert.equal(f.cache.get('refreshing').value.comments[0].text, 'keep');
  assert.equal(f.cache.stats().entries, 4);
  release();
  f.cache.configure({ maxBytes: 350 });
  f.cache.maintain();
  assert.ok(f.cache.stats().bytes <= 350);
});

test('fresh shared content avoids all upstream work across clients and handler/database restart', async t => {
  const f = await fixture(t), first = adapter(f);
  assert.equal((await first.request()).data.cache.status, 'miss');
  await f.reopen();
  const second = adapter(f);
  const response = await second.request({ ...film, title: 'Translated title', year: 2025 });
  assert.equal(response.data.cache.status, 'hit');
  assert.equal(first.requests, 1); assert.equal(second.requests, 0);
});

test('expired concurrent requests share one refresh and atomically replace only after success', async t => {
  const f = await fixture(t), key = danmakuCacheKey(film);
  f.cache.put(key, success('old')); f.advance(15 * DAY_MS);
  let release;
  const block = new Promise(resolve => { release = resolve; });
  const api = adapter(f, { getComments: async () => { await block; return Response.json({ comments: success('new').comments }); } });
  const requests = [api.request(), api.request({ ...film, title: 'An alias' })];
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(api.requests, 1); assert.equal(f.cache.get(key).value.comments[0].text, 'old');
  f.cache.maintain(); assert.equal(f.cache.stats().entries, 1);
  release();
  for (const response of await Promise.all(requests)) assert.equal(response.data.comments[0].text, 'new');
  assert.equal(f.cache.get(key).stale, false); assert.equal(f.cache.stats().entries, 1);
});

test('configuration A to B to A during an upstream await never saves mixed data under A', async t => {
  const f = await fixture(t);
  const config = { SOURCE_ORDER: 'tencent', DANMU_OFFSET: 'Film:1' };
  Globals.init(config);
  const originalRevision = Globals.dushengtvCacheRevision;
  const scope = Globals.dushengtvCacheScope;
  Globals.init({ ...config });
  assert.equal(Globals.dushengtvCacheRevision, originalRevision, 'ordinary requests do not invalidate active work');
  let release;
  const block = new Promise(resolve => { release = resolve; });
  const api = adapter(f, { getCacheRevision: () => Globals.dushengtvCacheRevision,
    getComments: async () => { await block; return Response.json({ comments: success('mixed settings').comments }); } });
  const pending = api.request(film, { cacheScope: scope });
  await new Promise(resolve => setImmediate(resolve));
  Globals.env = { ...config, DANMU_OFFSET: 'Film:10' }; Globals.reInit();
  Globals.env = { ...config }; Globals.reInit();
  assert.equal(Globals.dushengtvCacheScope, scope);
  assert.ok(Globals.dushengtvCacheRevision > originalRevision);
  release();
  assert.equal((await pending).data.available, true);
  assert.equal(f.cache.stats().entries, 0, 'late mixed result is returned once but never persisted');
});

test('429, empty and no-match refreshes keep successful content and share a cooldown', async t => {
  for (const kind of ['429', 'empty', 'missing']) {
    const f = await fixture(t), key = danmakuCacheKey(film);
    f.cache.put(key, success('old')); f.advance(15 * DAY_MS);
    const api = adapter(f, kind === 'missing' ? { match: async () => Response.json({ isMatched: false }) }
      : { getComments: async () => kind === '429' ? new Response('', { status: 429 }) : Response.json({ comments: [] }) });
    const response = await api.request();
    assert.equal(response.status, 200); assert.equal(response.data.cache.stale, true); assert.equal(response.data.comments[0].text, 'old');
    const repeated = await api.request(); assert.equal(repeated.data.cache.reason, 'REFRESH_COOLDOWN');
    assert.equal(f.cache.get(key).value.comments[0].text, 'old');
    await f.reopen(); assert.equal(f.cache.get(key).retryAt > f.now(), true);
  }
});

test('timeout serves stale while preserving the in-flight slot; late success can safely replace it', async t => {
  const f = await fixture(t), key = danmakuCacheKey(film);
  f.cache.put(key, success('old')); f.advance(15 * DAY_MS);
  let release;
  const block = new Promise(resolve => { release = resolve; });
  const api = adapter(f, { timeout: 15, maxConcurrent: 1, getComments: async () => { await block; return Response.json({ comments: success('late').comments }); } });
  const response = await api.request();
  assert.equal(response.data.cache.reason, 'REFRESH_TIMEOUT');
  assert.equal((await api.request({ ...film, providerIds: { Imdb: 'tt99' } })).status, 429);
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.cache.get(key).value.comments[0].text, 'late');
});

test('new local uploads/editing take priority over fresh remote cache and are never stored there', async t => {
  const f = await fixture(t), metadata = { ...film, providerIds: {} }, key = danmakuCacheKey(metadataFrom(metadata));
  f.cache.put(key, success('remote'));
  let localText = 'upload one';
  const api = adapter(f, { findLocal: async () => ({ resourceKey: 'uploaded', year: 2024 }), readLocal: async () => ({ comments: [{ time: 1, text: localText }] }) });
  assert.equal((await api.request(metadata, { localEnabled: true })).data.comments[0].text, 'upload one');
  localText = 'edited';
  assert.equal((await api.request(metadata, { localEnabled: true })).data.comments[0].text, 'edited');
  assert.equal(f.cache.get(key).value.comments[0].text, 'remote'); assert.equal(api.requests, 0);
});

test('local sources returned by the matcher are not stored as remote persistent content', async t => {
  const f = await fixture(t);
  let contents = [{ time: 1, text: 'uploaded' }];
  const api = adapter(f, {
    match: async () => Response.json({ isMatched: true, matches: [{ episodeId: 42, url: 'local:fixture' }] }),
    getComments: async () => Response.json({ comments: contents })
  });
  const metadata = { title: 'Mapped local film', type: 'Movie' };
  assert.equal((await api.request(metadata)).data.comments[0].text, 'uploaded');
  assert.equal(f.cache.stats().entries, 0);
  contents = [];
  assert.equal((await api.request(metadata)).data.available, false);
});

test('persistent refresh isolates legacy search/comment caches and honors changed offset/source configuration', async t => {
  Globals.init({ SOURCE_ORDER: 'tencent', GROUP_MINUTE: '0', COMMENT_CACHE_MIN_COUNT: '0', DANMU_OFFSET: 'Film:5', LOG_LEVEL: 'error', LOCAL_CACHE_ENABLED: 'false' });
  Object.assign(Globals, { animes: [], episodeIds: [], episodeNum: 10001, searchCache: new Map(), commentCache: new Map(), favoriteCache: new Map(), lastSelectMap: new Map() });
  const url = 'https://v.qq.com/fixture-cache-scope';
  const original = [{ p: '1,1,16777215', m: 'legacy time' }];
  setCommentCache(url, original);
  setSearchCache('Film', [{ animeId: 99, animeTitle: 'Removed source', episodeCount: 1 }]);
  addAnime({ animeId: 12345, animeTitle: 'Film(2024)【电影】from tencent', type: 'movie', source: 'tencent',
    links: [{ title: '【qq】 正片', url }] });
  const id = Globals.episodeIds[0].id;
  let liveCalls = 0;
  t.mock.method(getSourceByKey('tencent'), 'getComments', async () => { liveCalls++; return [{ p: '1,1,16777215', m: 'fresh time' }]; });
  const response = await withFreshDuShengTVFetch(() => getComment(`/api/v2/comment/${id}`, 'json', false, null, false, { skipLocalFallback: true }));
  const data = await response.json();
  assert.equal(liveCalls, 1); assert.equal(Number(data.comments[0].p.split(',')[0]), 6);
  assert.deepEqual(getCommentCache(url), original, 'isolated refresh does not overwrite other clients legacy cache');
  t.mock.method(getSourceByKey('tencent'), 'search', async () => []);
  const searched = await withFreshDuShengTVFetch(() => searchAnime(new URL('http://localhost/api/v2/search/anime?keyword=Film')));
  assert.deepEqual((await searched.json()).animes, [], 'refresh never promotes removed-source cached search results');
  assert.equal(getSearchCache('Film')[0].animeTitle, 'Removed source');
  await withFreshDuShengTVFetch(async () => {
    assert.equal(getSearchCache('Film'), null);
    setCommentCache(url, [{ p: '999,1,0', m: 'do not publish' }]);
    setSearchCache('Film', []);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(getCommentCache(url), null);
  });
  assert.deepEqual(getCommentCache(url), original);
});

test('fresh cached films remain available when all upstream slots are busy', async t => {
  const f = await fixture(t); f.cache.put(danmakuCacheKey(film), success('cached'));
  let release; const block = new Promise(resolve => { release = resolve; });
  const api = adapter(f, { maxConcurrent: 1, getComments: async () => { await block; return Response.json({ comments: [] }); } });
  const pending = api.request({ ...film, providerIds: { Imdb: 'tt99' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await api.request()).data.cache.status, 'hit');
  release(); await pending;
});

test('failed cache writes do not discard successful network data; cold no-match remains unchanged', async t => {
  const f = await fixture(t);
  const api = adapter(f, { getCache: async () => ({ get: () => null, protect: () => () => {}, put: () => { throw new Error('disk full'); } }) });
  assert.equal((await api.request()).data.comments[0].text, 'remote');
  const missing = adapter(f, { match: async () => Response.json({ isMatched: false }) });
  assert.deepEqual((await missing.request()).data, { available: false, comments: [], message: '無彈幕匹配', reason: 'NO_MATCH' });
  assert.equal(f.cache.stats().entries, 0);
  for (const platform of ['cloudflare', 'vercel', 'forward']) assert.equal(await getPersistentDanmakuCache({ platform }), null);
});

test('environment and settings schema expose real 7–30 day choices with safe bounds', () => {
  const config = Envs.load({ DUSHENGTV_CACHE_DAYS: '7', DUSHENGTV_CACHE_MAX_MB: '64' });
  assert.equal(config.dushengtvCacheDays, 7); assert.equal(config.dushengtvCacheMaxMB, 64);
  assert.equal(config.envVarConfig.DUSHENGTV_CACHE_DAYS.min, 7); assert.equal(config.envVarConfig.DUSHENGTV_CACHE_DAYS.max, 30);
  assert.equal(Envs.load({ DUSHENGTV_CACHE_DAYS: '30' }).dushengtvCacheDays, 30);
  assert.equal(Envs.load({ DUSHENGTV_CACHE_DAYS: '1' }).dushengtvCacheDays, 7);
  assert.equal(Envs.load({ DUSHENGTV_CACHE_DAYS: '100' }).dushengtvCacheDays, 30);
});
