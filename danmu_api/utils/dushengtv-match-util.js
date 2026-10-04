import { extractYear, normalizeTitleForMatch } from './common-util.js';

const numericId = value => typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value);
const imdbId = value => typeof value === 'string' && /^tt\d{1,16}$/.test(value);

export function hasMovieProviderId(ids) {
  return Boolean(ids && ['Douban', 'Imdb', 'Tmdb'].some(key => ids[key] !== undefined));
}

// These dependencies perform lookups by ID only. An absent or failed mapping
// must never turn into a title search, which could identify a different remake.
export async function resolveMovieIdentity(ids, { getDoubanInfoByImdbId, getTmdbExternalIds, tmdbConfigured }) {
  try {
    if (ids?.Douban !== undefined) {
      return numericId(ids.Douban) ? { doubanId: ids.Douban, matchedBy: 'Douban' } : null;
    }
    let externalId = ids?.Imdb;
    const matchedBy = externalId !== undefined ? 'Imdb' : 'Tmdb';
    if (externalId === undefined) {
      if (!numericId(ids?.Tmdb) || !tmdbConfigured) return null;
      const response = await getTmdbExternalIds('movie', ids.Tmdb);
      if (String(response?.data?.id) !== ids.Tmdb) return null;
      externalId = response?.data?.imdb_id;
    }
    if (!imdbId(externalId)) return null;
    const response = await getDoubanInfoByImdbId(externalId);
    const url = new URL(response?.data?.id);
    if (!['https:', 'http:'].includes(url.protocol) || url.hostname !== 'api.douban.com' ||
        url.port || url.username || url.password || url.search || url.hash) return null;
    const doubanId = url.pathname.match(/^\/movie\/([1-9]\d{0,15})\/?$/)?.[1];
    return doubanId ? { doubanId, matchedBy } : null;
  } catch {
    return null;
  }
}

export function filterMovieCandidates(animes, title, year) {
  const query = normalizeTitleForMatch(title);
  const movies = animes.filter(anime => {
    const type = `${anime?.type || ''} ${anime?.typeDescription || ''}`;
    if (!query || !/\b(?:movie|film)\b|电影|電影|剧场版|劇場版/i.test(type) ||
        /\b(?:tv|tvseries|series|show)\b|电视剧|電視劇|连续剧|連續劇/i.test(type)) return false;
    const titles = [anime.animeTitle, ...(Array.isArray(anime.aliases) ? anime.aliases : [])];
    return titles.some(candidate => typeof candidate === 'string' &&
      normalizeTitleForMatch(candidate.split('(')[0].trim()) === query);
  });
  if (Number.isInteger(year)) return movies.filter(anime => extractYear(anime.animeTitle || '') === year);
  // Without a requested year, every exact title candidate must agree on one
  // known year. Unknown years cannot exclude a same-name remake.
  const years = new Set(movies.map(anime => extractYear(anime.animeTitle || '')));
  return years.size === 1 && !years.has(null) ? movies : [];
}
