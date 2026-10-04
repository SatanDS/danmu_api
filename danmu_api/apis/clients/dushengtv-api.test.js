import test from 'node:test';
import assert from 'node:assert/strict';
import { createDuShengTVHandler, DUSHENGTV_PATH, metadataFrom, normalizeComments } from './dushengtv-api.js';

const token = 'test-only-'.padEnd(64, 'x');
const movie = { title: 'A film', type: 'Movie', year: 2024 };
const episode = { title: 'A show', type: 'Episode', season: 2, episode: 4 };
const reply = value => Response.json(value);
function fixture(overrides = {}) {
  const calls = { match: [], comments: [] };
  const handler = createDuShengTVHandler({
    match: async name => { calls.match.push(name); return reply({ success: true, isMatched: true, matches: [{ episodeId: 42, animeTitle: 'Matched', url: 'http://untrusted.invalid/' }] }); },
    getComments: async id => { calls.comments.push(id); return reply({ comments: [{ p: '1.25,1,0,user', m: 'Hello' }] }); },
    ...overrides
  });
  const request = async (body = movie, { secret = token, configToken = token, method = 'POST', contentType = 'application/json', localEnabled = false, raw } = {}) => {
    const headers = { 'Content-Type': contentType };
    if (secret) headers.Authorization = `Bearer ${secret}`;
    const req = new Request(`http://localhost${DUSHENGTV_PATH}`, { method, headers, ...(method === 'GET' ? {} : { body: raw ?? JSON.stringify(body) }) });
    const response = await handler(req, { token: configToken, localEnabled });
    return { status: response.status, data: await response.json() };
  };
  return { calls, request };
}

test('private adapter rejects unauthenticated and malformed requests before provider access', async () => {
  const { request, calls } = fixture();
  for (const options of [{ secret: null }, { secret: 'wrong'.padEnd(64, 'z') }]) assert.equal((await request(movie, options)).status, 401);
  assert.equal((await request(movie, { configToken: '87654321' })).status, 503);
  assert.equal((await request(movie, { method: 'GET' })).status, 405);
  assert.equal((await request(movie, { contentType: 'text/plain' })).status, 415);
  assert.equal((await request(movie, { raw: '{bad' })).status, 400);
  assert.equal((await request(movie, { raw: '中'.repeat(6000) })).status, 413);
  for (const body of [null, [], { title: 'https://example.com' }, { title: 'x\n' }, { ...episode, season: undefined }, { ...episode, episode: true }, { ...movie, year: '2024' }, { ...movie, type: 'Series' }]) {
    // Trailing whitespace is harmless; embedded control characters are invalid.
    if (body?.title === 'x\n') body.title = 'x\ny';
    assert.equal((await request(body)).status, 400);
  }
  assert.deepEqual(calls, { match: [], comments: [] });
});

test('metadata selects a movie year or an explicit season/episode and only follows numeric IDs', async () => {
  const { request, calls } = fixture();
  const film = await request();
  assert.equal(film.status, 200); assert.equal(film.data.available, true);
  assert.deepEqual(film.data.comments, [{ time: 1.25, mode: 1, color: '#000000', text: 'Hello' }]);
  await request(episode);
  assert.deepEqual(calls.match, ['A film (2024)', 'A show S02E04']);
  assert.deepEqual(calls.comments, [42, 42]);
});

test('special season/episode zero never falls through to a first-episode match', async () => {
  const { request, calls } = fixture();
  for (const body of [{ ...episode, season: 0 }, { ...episode, episode: 0 }, { title: 'Show.S00E01.mkv', type: 'local' }]) {
    const response = await request(body);
    assert.equal(response.status, 200); assert.equal(response.data.available, false); assert.match(response.data.message, /特殊/);
  }
  assert.equal(calls.match.length, 0);
});

test('external IDs are canonicalized and invalid or conflicting IDs are rejected', () => {
  assert.deepEqual(metadataFrom({ ...movie, providerIds: { IMDb: 'tt29308412', douban: '33458979', Tmdb: '123', Other: 'ignored' } }).providerIds,
    { Imdb: 'tt29308412', Douban: '33458979', Tmdb: '123' });
  assert.equal(metadataFrom({ ...movie, providerIds: JSON.parse('{"__proto__":"1","constructor":"2"}') }).providerIds, undefined);
  assert.equal(metadataFrom({ ...movie, providerIds: { Douban: '', Imdb: ' ' } }).providerIds, undefined,
    'empty Emby metadata fields mean no external ID is available');
  for (const providerIds of [[], { Douban: 'https://movie.douban.com/subject/33458979/' }, { Imdb: 'tt1?secret' },
    { Douban: '0' }, { Douban: 33458979 }, { Douban: '1', douban: '2' }, { Tmdb: '1'.repeat(129) }]) {
    assert.throws(() => metadataFrom({ ...movie, providerIds }), /外部编号/);
  }
});

test('ID-bound movies skip local title-only uploads and pass identity through the matcher and comment reader', async () => {
  const metadata = { ...movie, providerIds: { Imdb: 'tt29308412' } };
  const { request } = fixture({
    findLocal: async () => { assert.fail('A title-only upload must not override an external ID'); },
    readLocal: async () => { assert.fail('A title-only upload must not override an external ID'); },
    match: async (_name, received) => {
      assert.deepEqual(received, metadata);
      return reply({ isMatched: true, matches: [{ episodeId: 42, type: 'movie' }],
        identity: { doubanId: '33458979', matchedBy: 'Imdb' } });
    },
    getComments: async (id, received) => {
      assert.equal(id, 42); assert.deepEqual(received, metadata);
      return reply({ comments: [{ time: 1, text: 'same work' }] });
    }
  });
  const response = await request(metadata, { localEnabled: true });
  assert.equal(response.data.available, true);
  assert.equal(response.data.match.doubanId, '33458979');
  assert.equal(response.data.match.matchedBy, 'Imdb');
});

test('local movie shortcuts require the exact known year', async () => {
  for (const input of [movie, { title: movie.title, type: 'Movie' }]) {
    const { request } = fixture({
      findLocal: async () => ({ resourceKey: 'uncertain-year', year: null }),
      readLocal: async () => assert.fail('Do not guess which same-title local movie was uploaded'),
      match: async () => reply({ isMatched: false, matches: [] })
    });
    assert.equal((await request(input, { localEnabled: true })).data.available, false);
  }
});

test('no match or empty comments displays only the requested no-match message', async () => {
  const missing = fixture({ match: async () => reply({ isMatched: false, matches: [] }) });
  const empty = fixture({ getComments: async () => reply({ comments: [] }) });
  assert.deepEqual((await missing.request()).data, { available: false, comments: [], message: '無彈幕匹配', reason: 'NO_MATCH' });
  assert.deepEqual((await empty.request()).data, { available: false, comments: [], message: '無彈幕匹配', reason: 'EMPTY_COMMENTS' });
});

test('concurrent requests for different external movie IDs never share a match job', async () => {
  let release;
  const blocker = new Promise(resolve => { release = resolve; });
  const ids = [];
  const { request } = fixture({ match: async (_name, metadata) => {
    ids.push(metadata.providerIds.Imdb);
    await blocker;
    return reply({ isMatched: false, matches: [] });
  } });
  const requests = ['tt29308412', 'tt1234567'].map(Imdb => request({ ...movie, providerIds: { Imdb } }));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(ids.sort(), ['tt1234567', 'tt29308412']);
  release();
  await Promise.all(requests);
});

test('series premiere year is not used as a later season release year; local SxxExx titles retain season', async () => {
  const { request, calls } = fixture();
  await request({ ...episode, year: 2018 });
  await request({ title: 'A.Show.S02E04.mkv', type: 'local' });
  assert.deepEqual(calls.match, ['A show S02E04', 'A Show S02E04']);
});

test('local uploaded comments take precedence, but title-level comments cannot attach to an arbitrary episode', async () => {
  const criteria = [];
  const local = fixture({
    findLocal: async query => { criteria.push(query); return { resourceKey: 'fixture', episode: 4 }; },
    readLocal: async key => { assert.equal(key, 'fixture'); return { comments: [{ time: 2, text: 'Local' }] }; }
  });
  const response = await local.request(episode, { localEnabled: true });
  assert.equal(response.data.match.source, 'local'); assert.equal(criteria[0].type, 'tv'); assert.equal(criteria[0].season, 2);
  assert.equal(local.calls.match.length, 0);
  const fallback = fixture({ findLocal: async () => ({ resourceKey: 'wrong', episode: null }), readLocal: async () => { throw new Error('must not read'); } });
  assert.equal((await fallback.request(episode, { localEnabled: true })).data.available, true);
  assert.equal(fallback.calls.match.length, 1);
});

test('ambiguous, missing, wrong-type and empty matches never report available comments', async () => {
  for (const matches of [[], [{ episodeId: 1 }, { episodeId: 2 }], [{ episodeId: 1, type: 'tvseries' }]]) {
    const { request, calls } = fixture({ match: async () => reply({ isMatched: true, matches }) });
    assert.equal((await request()).data.available, false); assert.equal(calls.comments.length, 0);
  }
  const wrongFilm = fixture({ match: async () => reply({ isMatched: true, matches: [{ episodeId: 1, typeDescription: '电影' }] }) });
  assert.equal((await wrongFilm.request(episode)).data.available, false);
  const invalidId = fixture({ match: async () => reply({ isMatched: true, matches: [{ episodeId: 'https://bad.invalid' }] }) });
  assert.equal((await invalidId.request()).status, 502);
  const empty = fixture({ getComments: async () => reply({ comments: [] }) });
  assert.equal((await empty.request()).data.available, false);
  const failure = fixture({ match: async () => { throw new Error('upstream private token'); } });
  const response = await failure.request(); assert.equal(response.status, 502); assert.equal(JSON.stringify(response).includes('private token'), false);
});

test('normalization keeps seconds, black, fixed modes and text while bounding invalid/oversized input', () => {
  const rows = [null, [], { time: true, text: 'invalid' }, { time: -1, text: 'invalid' }, { time: 1, text: ' ' }, { time: 1, text: 'x'.repeat(301) },
    { p: '2.5,4,0,user', m: 'Black' }, { p: '1.25,5,25,255,0,0,user,0', m: '<literal>' }, { time: 3, mode: 6, color: '#FF0000', text: 'Red' }];
  assert.deepEqual(normalizeComments(rows), [
    { time: 1.25, mode: 5, color: '#0000ff', text: '<literal>' }, { time: 2.5, mode: 4, color: '#000000', text: 'Black' }, { time: 3, mode: 1, color: '#ff0000', text: 'Red' }
  ]);
  assert.equal(normalizeComments(Array(50001).fill({ time: 1, text: 'short' })).length, 50000);
  const limited = normalizeComments(Array(50000).fill({ time: 1, text: '中'.repeat(300) }));
  assert.ok(limited.length > 10000 && limited.length < 50000);
  assert.ok(Buffer.byteLength(JSON.stringify({ available: true, comments: limited })) < 12 * 1024 * 1024);
});

test('identical in-flight requests share work; concurrency stays bounded even after caller timeout', async () => {
  let release, matches = 0;
  const blocker = new Promise(resolve => { release = resolve; });
  const { request } = fixture({ timeout: 30, maxConcurrent: 1, match: async () => { matches++; await blocker; return reply({ isMatched: false, matches: [] }); } });
  const first = request(movie), duplicate = request(movie);
  assert.equal((await request({ ...movie, title: 'Another' })).status, 429);
  const timedOut = await Promise.all([first, duplicate]);
  assert.ok(timedOut.every(result => result.status === 504)); assert.equal(matches, 1);
  assert.equal((await request({ ...movie, title: 'Another' })).status, 429);
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await request({ ...movie, title: 'Another' })).status, 200);
});
