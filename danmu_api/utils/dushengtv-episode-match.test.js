import test from 'node:test';
import assert from 'node:assert/strict';
import { filterEpisodeCandidates, exactEpisode } from './dushengtv-episode-match.js';
import { danmakuCacheKey } from './dushengtv-cache-key.js';

const metadata = { title: '庆余年', type: 'Episode', season: 2, episode: 4 };
const anime = (name, extra = {}) => ({ animeTitle: `${name}(2024)【电视剧】from tencent`, type: 'tvseries', ...extra });

test('a season must match explicitly; other seasons and unspecified later seasons never substitute', () => {
  const correct = anime('庆余年 第二季');
  assert.deepEqual(filterEpisodeCandidates([anime('庆余年 第一季'), anime('庆余年'), correct, anime('庆余年 第三季')], metadata), [correct]);
  assert.deepEqual(filterEpisodeCandidates([anime('庆余年 第二季 花絮'), anime('庆余年 续传 第二季')], metadata), []);
  assert.deepEqual(filterEpisodeCandidates([anime('庆余年')], { ...metadata, season: 1 }).length, 1);
});

test('conflicting season aliases, remake years and film results are not selected', () => {
  assert.deepEqual(filterEpisodeCandidates([anime('庆余年 第二季', { aliases: ['庆余年 第一季'] })], metadata), []);
  assert.deepEqual(filterEpisodeCandidates([anime('庆余年 第二季'), { ...anime('庆余年 第二季'), animeTitle: '庆余年 第二季(2020)' }], metadata), []);
  assert.deepEqual(filterEpisodeCandidates([anime('庆余年 第二季', { type: 'movie' })], metadata), []);
});

test('missing episode numbers do not fall back to array position or generated episodeNumber', () => {
  const rows = [{ episodeTitle: '【qq】第5集', episodeNumber: '4' }, { episodeTitle: '正片', episodeNumber: '4' },
    { episodeTitle: '【qq】第4集预告', episodeNumber: '3' }, { episodeTitle: '【qq】S01E04', episodeNumber: '4' }];
  assert.deepEqual(exactEpisode(rows, metadata), []);
  const correct = { episodeTitle: '【qq】第4集', episodeNumber: '10' };
  assert.deepEqual(exactEpisode([...rows, correct], metadata), [correct]);
});

test('strict episode matching invalidates pre-fix persistent results without discarding movie cache', () => {
  assert.equal(JSON.parse(danmakuCacheKey(metadata))[0], 'dushengtv-comments-episode-v2');
  assert.equal(JSON.parse(danmakuCacheKey({ title: '片名', type: 'Movie' }))[0], 'dushengtv-comments-v1');
});
