import test from 'node:test';
import assert from 'node:assert/strict';
import { filterMovieCandidates, hasMovieProviderId, resolveMovieIdentity } from './dushengtv-match-util.js';

const noLookup = async () => { throw new Error('Unexpected provider lookup'); };
const dependencies = overrides => ({ getDoubanInfoByImdbId: noLookup, getTmdbExternalIds: noLookup, tmdbConfigured: false, ...overrides });
const movie = (year, extra = {}) => ({ animeTitle: `老枪${year ? `(${year})` : ''}`, type: '电影', ...extra });

test('explicit Douban identity takes precedence over other provider IDs', async () => {
  assert.equal(hasMovieProviderId({ Douban: '33458979' }), true);
  assert.equal(hasMovieProviderId({}), false);
  assert.deepEqual(await resolveMovieIdentity({ Douban: '33458979', Imdb: 'tt29308412', Tmdb: '42' }, dependencies()), {
    doubanId: '33458979', matchedBy: 'Douban'
  });
});

test('IMDb maps to a Douban subject without relying on title or release year', async () => {
  let lookedUp;
  const resolved = await resolveMovieIdentity({ Imdb: 'tt29308412', Tmdb: '42' }, dependencies({
    getDoubanInfoByImdbId: async id => {
      lookedUp = id;
      return { data: { id: 'https://api.douban.com/movie/33458979', title: 'A Long Shot', attrs: { year: ['2023'] } } };
    }
  }));
  assert.equal(lookedUp, 'tt29308412');
  assert.deepEqual(resolved, { doubanId: '33458979', matchedBy: 'Imdb' });
});

test('failed IMDb lookup does not fall through to a different supplied provider', async () => {
  let tmdbCalls = 0;
  for (const getDoubanInfoByImdbId of [async () => null, async () => { throw new Error('unavailable'); }]) {
    assert.equal(await resolveMovieIdentity({ Imdb: 'tt29308412', Tmdb: '42' }, dependencies({
      getDoubanInfoByImdbId,
      tmdbConfigured: true,
      getTmdbExternalIds: async () => { tmdbCalls++; return { data: { id: 42, imdb_id: 'tt1234' } }; }
    })), null);
  }
  assert.equal(tmdbCalls, 0);
});

test('TMDB lookup requires configuration and matching external-ID response identity', async () => {
  assert.equal(await resolveMovieIdentity({ Tmdb: '42' }, dependencies()), null);
  for (const responseId of [undefined, 43]) {
    assert.equal(await resolveMovieIdentity({ Tmdb: '42' }, dependencies({
      tmdbConfigured: true,
      getTmdbExternalIds: async () => ({ data: { id: responseId, imdb_id: 'tt29308412' } })
    })), null);
  }
  assert.deepEqual(await resolveMovieIdentity({ Tmdb: '42' }, dependencies({
    tmdbConfigured: true,
    getTmdbExternalIds: async (kind, id) => {
      assert.equal(kind, 'movie'); assert.equal(id, '42');
      return { data: { id: 42, imdb_id: 'tt29308412' } };
    },
    getDoubanInfoByImdbId: async () => ({ data: { id: 'https://api.douban.com/movie/33458979' } })
  })), { doubanId: '33458979', matchedBy: 'Tmdb' });
});

test('IMDb lookup accepts only a canonical Douban subject reference', async () => {
  for (const id of [undefined, '33458979', 'https://example.com/movie/33458979',
    'https://api.douban.com@localhost/movie/33458979', 'https://api.douban.com/movie/33458979?next=other',
    'https://api.douban.com/tv/33458979']) {
    assert.equal(await resolveMovieIdentity({ Imdb: 'tt29308412' }, dependencies({
      getDoubanInfoByImdbId: async () => ({ data: { id } })
    })), null);
  }
});

test('malformed explicit IDs cannot be reinterpreted as a title search', async () => {
  for (const ids of [{ Douban: '' }, { Douban: '../33458979' }, { Douban: 33458979 },
    { Imdb: '29308412' }, { Imdb: 'tt29308412/path' }, { Tmdb: 'https://example.com/' }]) {
    assert.equal(hasMovieProviderId(ids), true);
    assert.equal(await resolveMovieIdentity(ids, dependencies()), null);
  }
});

test('movie title matching preserves the exact requested year and media type', () => {
  const exact = movie(2024);
  const candidates = [movie(1975), movie(2023), movie(2025), movie(null),
    movie(2024, { animeTitle: '三个老枪手(2024)' }), movie(2024, { type: '电视剧' }),
    movie(2024, { type: '' }), movie(2024, { type: 'Movie', typeDescription: 'TV Series' }), exact];
  assert.deepEqual(filterMovieCandidates(candidates, '老枪', 2024), [exact]);
  assert.deepEqual(filterMovieCandidates([movie(2023)], '老枪', 2024), []);
});

test('exact aliases and traditional Chinese are accepted without fuzzy title matching', () => {
  const alias = movie(2024, { animeTitle: 'A Long Shot(2024)', aliases: ['老槍'] });
  assert.deepEqual(filterMovieCandidates([alias], '老枪', 2024), [alias]);
  assert.deepEqual(filterMovieCandidates([movie(2024)], '老槍', 2024), [movie(2024)]);
});

test('a missing requested year rejects remakes and candidates with unknown years', () => {
  assert.deepEqual(filterMovieCandidates([movie(2023), movie(1975)], '老枪'), []);
  assert.deepEqual(filterMovieCandidates([movie(2023), movie(null)], '老枪'), []);
  assert.deepEqual(filterMovieCandidates([movie(null)], '老枪'), []);
  const sources = [movie(2023, { source: 'tencent' }), movie(2023, { source: 'youku' })];
  assert.deepEqual(filterMovieCandidates(sources, '老枪'), sources);
});
