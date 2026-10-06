export const DAY_MS = 86400000;
export const clampCacheDays = value => Math.max(7, Math.min(30, Math.trunc(Number(value) || 14)));

export function danmakuCacheScope(config) {
  // Source/matching/output changes invalidate old results. Dedicated credential
  // and user/session fields are excluded. Endpoint URLs only contribute to the
  // SHA-256 key; SQLite never stores this raw configuration string.
  const fields = ['sourceOrderArr', 'platformOrderArr', 'mergeSourcePairs', 'customMergeRules',
    'otherServer', 'customSourceApiUrl', 'vodServers', 'vodReturnMode', 'strictTitleMatch',
    'animeTitleFilter', 'episodeTitleFilter', 'enableAnimeEpisodeFilter', 'titleNoiseFilter',
    'titleToChinese', 'animeTitleSimplified', 'titleMappingTable', 'autoMatchMappingTable',
    'hongguoMergeAllEpisodes', 'blockedWords', 'groupMinute', 'danmuLimit', 'danmuSimplifiedTraditional',
    'likeSwitch', 'danmuOffset', 'convertTopBottomToScroll', 'convertColor', 'colorPool',
    'gradientChance', 'gradientColors', 'aiModel', 'aiMatchPrompt'];
  return JSON.stringify(fields.map(field => config[field] ?? null), (_key, value) =>
    value instanceof Map ? Array.from(value.entries()) : value instanceof RegExp ? value.toString() : value);
}

export function danmakuCacheKey(metadata, scope = '') {
  const ids = Object.entries(metadata.providerIds || {}).sort(([a], [b]) => a.localeCompare(b));
  // Movie IDs are only cached after the existing strict matcher proves identity.
  // Episode provider IDs may identify a series, not this particular episode: keep
  // its exact series title and explicit season/episode as well. Never alias IDs.
  const identity = metadata.type === 'Movie' && ids.length
    ? { ids }
    : { title: metadata.title.normalize('NFC'), year: metadata.year ?? null, ids };
  return JSON.stringify([metadata.type === 'Episode' ? 'dushengtv-comments-episode-v2' : 'dushengtv-comments-v1', scope, metadata.type, identity,
    metadata.type === 'Episode' ? [metadata.season, metadata.episode] : null]);
}

export function cacheableResult(metadata, value) {
  if (value?.available !== true || !Array.isArray(value.comments) || !value.comments.length || value.match?.source === 'local') return false;
  const ids = metadata.providerIds || {};
  if (metadata.type === 'Movie' && Object.keys(ids).length) {
    const { doubanId, matchedBy } = value.match || {};
    if (!/^[1-9][0-9]{0,15}$/.test(doubanId || '') || !ids[matchedBy]) return false;
    if (ids.Douban && ids.Douban !== doubanId) return false;
  }
  return true;
}
