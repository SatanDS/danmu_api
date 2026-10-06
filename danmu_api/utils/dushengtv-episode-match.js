import { extractYear, extractSeasonNumberFromAnimeTitle, extractEpisodeNumberFromTitle, normalizeTitleForMatch } from './common-util.js';

const cleanTitle = title => String(title || '').replace(/\s*from\s+[\w&＆]+.*$/i, '').replace(/【[^】]*】/g, '').trim();
const titleKey = title => normalizeTitleForMatch(title).toLowerCase();

export function filterEpisodeCandidates(animes, metadata) {
  const query = titleKey(extractSeasonNumberFromAnimeTitle(cleanTitle(metadata.title)).baseTitle);
  const candidates = animes.filter(anime => {
    const type = `${anime?.type || ''} ${anime?.typeDescription || ''}`;
    if (!query || /\b(?:movie|film)\b|电影|電影|剧场版|劇場版/i.test(type)) return false;
    const titles = [anime.animeTitle, ...(Array.isArray(anime.aliases) ? anime.aliases : [])].map(cleanTitle);
    const parsed = titles.map(extractSeasonNumberFromAnimeTitle);
    const seasons = new Set(parsed.map(row => row.season).filter(Number.isInteger));
    if (seasons.size > 1 || (seasons.size ? [...seasons][0] : 1) !== metadata.season) return false;
    return parsed.some(row => titleKey(row.baseTitle) === query);
  });
  // A title/season shared by distinct remakes is still ambiguous. Never choose
  // by source priority in that case. Unknown years cannot eliminate a remake.
  const years = new Set(candidates.map(anime => extractYear(anime.animeTitle || '')));
  return years.size <= 1 ? candidates : [];
}

export function exactEpisode(episodes, metadata) {
  return episodes.filter(episode => {
    const title = String(episode?.episodeTitle || '');
    if (/预告|預告|花絮|片花|特辑|特輯|幕后|幕後|\b(?:trailer|preview|recap)\b/i.test(title)) return false;
    const seasonEpisode = title.match(/\bS(\d{1,3})E(\d{1,5})\b/i);
    if (seasonEpisode && Number(seasonEpisode[1]) !== metadata.season) return false;
    // episodeNumber is generated from array order by buildBangumiData, so it
    // cannot prove an episode number when a platform omits early episodes.
    return extractEpisodeNumberFromTitle(title) === metadata.episode;
  });
}
