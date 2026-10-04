import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { handleRequest } from './worker.js';
import { matchAnime } from './apis/dandan-api.js';
import { Globals } from './configs/globals.js';
import { getSourceByKey } from './sources/registry.js';
import { addAnime } from './utils/cache-util.js';
import { saveLocalDanmu } from './utils/local-danmu-store.js';
import { buildLocalDanmuResourceKey } from './utils/local-danmu-parser.js';

test('DuShengTV routes movie IDs only to the identified work', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dushengtv-identity-'));
  t.mock.method(process, 'cwd', () => root);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const token = 'identity-test-'.padEnd(64, 'x');
  const env = { TOKEN: token, SOURCE_ORDER: 'local,tencent', LOCAL_CACHE_ENABLED: 'false',
    LOCAL_REDIS_URL: '', USE_BANGUMI_DATA: 'false', LOG_LEVEL: 'error',
    REMEMBER_LAST_SELECT: 'false', TITLE_TO_CHINESE: 'false', GROUP_MINUTE: '0' };
  let found = true, searches = 0, identityReads = 0, commentReads = 0;
  const anime = { animeId: 900001, bangumiId: '900001', animeTitle: '老枪(2023)【电影】from tencent',
    type: 'movie', typeDescription: '电影', source: 'tencent', startDate: '2023-01-01', episodeCount: 1 };
  const publish = (animes, details) => {
    addAnime({ ...anime, links: [{ title: '【qq】 正片', url: 'https://v.qq.com/identified-work' }] }, details);
    animes.push(anime);
  };
  t.mock.method(getSourceByKey('douban'), 'handleMovieById', async (id, animes, details) => {
    identityReads++; assert.equal(id, '33458979');
    if (!found) return null;
    publish(animes, details);
    return { id, type: 'movie' };
  });
  const source = getSourceByKey('tencent');
  t.mock.method(source, 'search', async () => { searches++; return [{}]; });
  t.mock.method(source, 'handleAnimes', async (_items, _title, animes, details) => publish(animes, details));
  t.mock.method(source, 'getComments', async () => {
    commentReads++; return [{ p: '1,1,16777215', m: 'correct remote identity' }];
  });
  const reset = () => {
    found = true; searches = identityReads = commentReads = 0;
    Globals.init(env);
    Object.assign(Globals, { deployPlatform: 'node', animes: [], episodeIds: [], episodeNum: 10001,
      searchCache: new Map(), commentCache: new Map(), favoriteCache: new Map(),
      lastSelectMap: new Map(), requestHistory: new Map(), queryCacheInitialized: true,
      queryCacheWritable: {}, favoriteCacheWritable: {}, localCacheValid: false,
      redisValid: false, localRedisValid: false });
  };
  const metadata = { title: '老枪', type: 'Movie', year: 2024, providerIds: { Douban: '33458979' } };
  const request = async (body = metadata) => {
    const response = await handleRequest(new Request('http://localhost/api/v1/dushengtv/danmaku', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }), env, 'node', null);
    assert.equal(response.status, 200);
    return response.json();
  };
  await t.test('verified ID overrides differing release year without title search or local substitution', async () => {
    reset();
    for (const year of [2023, 2024]) {
      const fields = { title: '老枪', year, type: 'movie' };
      await saveLocalDanmu({ ...fields, status: 'ready', count: 1,
        resourceKey: buildLocalDanmuResourceKey(fields), comments: [{ p: '1,1,16777215', m: 'unverified local title' }] });
    }
    const result = await request();
    assert.equal(result.available, true);
    assert.equal(result.match.doubanId, '33458979');
    assert.equal(result.comments[0].text, 'correct remote identity');
    assert.equal(searches, 0); assert.equal(identityReads, 1); assert.equal(commentReads, 1);
  });
  await t.test('failed ID resolution never searches the title or substitutes local comments', async () => {
    reset(); found = false;
    assert.deepEqual(await request(), { available: false, comments: [], message: '無彈幕匹配', reason: 'NO_MATCH' });
    assert.equal(searches, 0); assert.equal(commentReads, 0);
  });
  await t.test('public request JSON cannot activate the trusted ID route', async () => {
    reset();
    const url = new URL('http://localhost/api/v2/match');
    const req = new Request(url, { method: 'POST', body: JSON.stringify({ fileName: '老枪(2024)', validatedMetadata: metadata, providerIds: metadata.providerIds }) });
    await matchAnime(url, req, null);
    assert.equal(identityReads, 0);
  });
});
