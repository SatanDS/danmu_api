// DuShengTV receives normalized comments through its authenticated Bot gateway.
// Keep this service token on the gateway, never in the desktop application.
import { danmakuCacheKey, cacheableResult } from '../../utils/dushengtv-cache-key.js';
export const DUSHENGTV_PATH = '/api/v1/dushengtv/danmaku';
const MAX_RESPONSE = 12 * 1024 * 1024;
const encoder = new TextEncoder();
const providerNames = new Map([['douban', 'Douban'], ['imdb', 'Imdb'], ['tmdb', 'Tmdb']]);
const result = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
const unavailable = (message, reason) => ({ available: false, comments: [], message, ...(reason ? { reason } : {}) });
class AdapterError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}
function sameToken(a, b) {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
export function metadataFrom(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AdapterError('需要影片资料', 400);
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title || title.length > 256 || /[\u0000-\u001f\u007f]|:\/\//.test(title)) throw new AdapterError('影片标题无效', 400);
  const type = input.type ?? (input.episode != null ? 'Episode' : 'Movie');
  if (!['Movie', 'Episode', 'local'].includes(type)) throw new AdapterError('仅支持电影或单集影片', 400);
  if (type === 'local') {
    const series = title.match(/^(.+?)[.\s_-]+S(\d{1,3})E(\d{1,5})(?:\D|$)/i);
    if (series) return metadataFrom({ title: series[1].replace(/[._]/g, ' ').trim(), type: 'Episode', season: Number(series[2]), episode: Number(series[3]) });
  }
  const number = (key, min, max, required = false) => {
    const value = input[key];
    if (value == null && !required) return undefined;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new AdapterError(`影片${key === 'season' ? '季数' : key === 'episode' ? '集数' : '年份'}无效，请更新客户端或检查媒体资料`, 400);
    return value;
  };
  const year = number('year', 1800, 2200);
  const suppliedIds = input.providerIds ?? {};
  if (typeof suppliedIds !== 'object' || Array.isArray(suppliedIds) || Object.keys(suppliedIds).length > 16) throw new AdapterError('影片外部编号无效', 400);
  const providerIds = {};
  for (const [key, value] of Object.entries(suppliedIds)) {
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(key) || typeof value !== 'string' || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) throw new AdapterError('影片外部编号无效', 400);
    const name = providerNames.get(key.toLowerCase());
    if (!name || !value.trim()) continue;
    const id = value.trim();
    if (!(name === 'Imdb' ? /^tt[0-9]{1,16}$/ : /^[1-9][0-9]{0,15}$/).test(id)
        || (providerIds[name] && providerIds[name] !== id)) throw new AdapterError('影片外部编号无效', 400);
    providerIds[name] = id;
  }
  return { title, type, ...(year === undefined || type === 'Episode' ? {} : { year }), ...(Object.keys(providerIds).length ? { providerIds } : {}), ...(type === 'Episode' ? { season: number('season', 0, 999, true), episode: number('episode', 0, 99999, true) } : {}) };
}
export function normalizeComments(rows) {
  if (!Array.isArray(rows)) throw new AdapterError('弹幕源返回的内容格式无效');
  const comments = []; let bytes = 4096;
  for (const row of rows.slice(0, 200000)) {
    if (!row || typeof row !== 'object') continue;
    const p = typeof row.p === 'string' ? row.p.split(',') : [];
    const value = row.time ?? p[0];
    if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) continue;
    const time = Number(value), text = row.text ?? row.m;
    if (!Number.isFinite(time) || time < 0 || time > 7 * 86400 || typeof text !== 'string' || !text.trim() || text.length > 300) continue;
    // Dandan JSON p: seconds, mode, color; Bilibili's 8-field p includes font size.
    const rawColor = row.color ?? p[p.length >= 8 ? 3 : 2];
    const numeric = typeof rawColor === 'number' || /^\d+$/.test(rawColor || '') ? Number(rawColor) : NaN;
    const color = typeof rawColor === 'string' && /^#[0-9a-f]{6}$/i.test(rawColor) ? rawColor.toLowerCase()
      : Number.isInteger(numeric) && numeric >= 0 && numeric <= 0xffffff ? `#${numeric.toString(16).padStart(6, '0')}` : '#ffffff';
    const mode = Number(row.mode ?? p[1]), comment = { time, mode: mode === 4 || mode === 5 ? mode : 1, color, text };
    bytes += encoder.encode(JSON.stringify(comment)).length + 1;
    if (bytes > MAX_RESPONSE) break;
    comments.push(comment); if (comments.length === 50000) break;
  }
  return comments.sort((a, b) => a.time - b.time);
}
async function readResponse(response) {
  if (!response?.ok) throw new AdapterError('弹幕源暂时无法响应，请稍后重试');
  const text = await response.text();
  if (encoder.encode(text).length > 20 * 1024 * 1024) throw new AdapterError('弹幕源响应过大');
  try { return JSON.parse(text); } catch { throw new AdapterError('弹幕源返回的内容格式无效'); }
}

export function createDuShengTVHandler({ match, getComments, findLocal, readLocal, initialize = async () => {}, getCache = async () => null, runProvider = fn => fn(), getCacheRevision = () => 0, timeout = 60000, maxConcurrent = 4, now = Date.now }) {
  const pending = new Map();
  async function localComments(metadata, localEnabled) {
    let comments, selection;
    // Title-only local uploads cannot prove the identity of a movie with an
    // external ID. Resolve that ID before considering any remote comments.
    const identifiedMovie = metadata.type === 'Movie' && Object.keys(metadata.providerIds || {}).length > 0;
    if (!identifiedMovie && (metadata.type !== 'Movie' || Number.isInteger(metadata.year)) && localEnabled && findLocal && readLocal) {
      const local = await findLocal({ ...metadata, type: metadata.type === 'Episode' ? 'tv' : 'movie', season: metadata.season ?? 1 });
      // Do not attach title-level/movie comments to an arbitrary episode.
      if (local && (metadata.type !== 'Episode' || (Number(local.episode) === metadata.episode && Number(local.season) === metadata.season))
          && (metadata.type !== 'Movie' || local.year === metadata.year)) {
        const stored = await readLocal(local.resourceKey);
        if (stored?.comments) { comments = stored.comments; selection = { source: 'local', animeTitle: metadata.title, episodeTitle: metadata.type === 'Episode' ? `S${metadata.season}E${metadata.episode}` : metadata.title }; }
      }
    }
    if (!comments) return null;
    const normalized = normalizeComments(comments);
    return normalized.length ? { available: true, comments: normalized, match: selection } : unavailable('無彈幕匹配', 'EMPTY_COMMENTS');
  }
  async function fetchComments(metadata) {
    let comments, selection;
    // Construct season/episode explicitly; episode names alone often match the wrong title.
    const fileName = `${metadata.title}${metadata.year && metadata.type !== 'Episode' ? ` (${metadata.year})` : ''}${metadata.type === 'Episode' ? ` S${String(metadata.season).padStart(2, '0')}E${String(metadata.episode).padStart(2, '0')}` : ''}`;
    const matched = await readResponse(await match(fileName, metadata));
    if (matched.success === false) throw new AdapterError('弹幕匹配服务暂时不可用，请稍后重试');
    if (matched.isMatched !== true || !Array.isArray(matched.matches) || matched.matches.length !== 1) return unavailable('無彈幕匹配', 'NO_MATCH');
    const chosen = matched.matches[0], episodeId = Number(chosen?.episodeId);
    if (!Number.isSafeInteger(episodeId) || episodeId <= 0) throw new AdapterError('弹幕源返回了无效的匹配编号');
    const mediaType = `${chosen.type || ''} ${chosen.typeDescription || ''}`;
    const movie = /\b(?:movie|film)\b|电影|電影|剧场版|劇場版/i.test(mediaType);
    const series = /\b(?:tv|tvseries|series|show)\b|电视剧|電視劇|连续剧|連續劇/i.test(mediaType);
    if ((metadata.type === 'Movie' && series && !movie) || (metadata.type === 'Episode' && movie && !series)) {
      return unavailable('無彈幕匹配', 'TYPE_MISMATCH');
    }
    // Only an ID from the matcher is used. Never follow a client/matcher supplied URL.
    const data = await readResponse(await getComments(episodeId, metadata));
    comments = data.comments;
    selection = { episodeId, animeTitle: String(chosen.animeTitle || metadata.title).slice(0, 256), episodeTitle: String(chosen.episodeTitle || '').slice(0, 256) };
    // Inspect provenance only; never request a matcher-supplied URL. A local
    // source reached via title mappings/merging must remain editable/deletable.
    if (chosen.source === 'local' || String(chosen.url || '').includes('local:')) selection.source = 'local';
    if (/^[1-9][0-9]{0,15}$/.test(matched.identity?.doubanId || '') && ['Douban', 'Imdb', 'Tmdb'].includes(matched.identity?.matchedBy)) {
      selection.doubanId = matched.identity.doubanId;
      selection.matchedBy = matched.identity.matchedBy;
    }
    const normalized = normalizeComments(comments);
    if (!normalized.length) return unavailable('無彈幕匹配', 'EMPTY_COMMENTS');
    return { available: true, comments: normalized, match: selection };
  }
  const cachedResponse = (entry, status, reason) => ({ ...entry.value, cache: {
    status, stale: status === 'stale', storedAt: new Date(entry.updatedAt).toISOString(), ...(reason ? { reason } : {})
  } });
  return async function handle(req, { token, localEnabled = false, cacheScope = '', cacheRevision = getCacheRevision() } = {}) {
    if (req.method !== 'POST') return result(unavailable('需要 POST 请求'), 405);
    if (typeof token !== 'string' || token === '87654321' || token.length < 32) return result(unavailable('请为弹幕服务配置至少 32 位的独立 TOKEN'), 503);
    const supplied = req.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{32,256})$/)?.[1] || '';
    if (!sameToken(supplied, token)) return result(unavailable('弹幕服务验证失败'), 401);
    if (req.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') return result(unavailable('需要 JSON 请求'), 415);
    let timer, previous, cache, key;
    try {
      const body = await req.text();
      if (encoder.encode(body).length > 16384) throw new AdapterError('请求内容过大', 413);
      let input; try { input = JSON.parse(body); } catch { throw new AdapterError('JSON 请求无效', 400); }
      const metadata = metadataFrom(input);
      key = danmakuCacheKey(metadata, cacheScope);
      const run = async () => {
        await initialize();
        if (metadata.type === 'Episode' && (!metadata.season || !metadata.episode)) return unavailable('特殊季或第 0 集暂不支持自动匹配，请在播放器导入本地弹幕');
        // Check uploads before the shared remote cache so adding/editing local
        // comments becomes visible immediately even while a remote row is fresh.
        const local = await localComments(metadata, localEnabled);
        if (local) return local;
        try { cache = await getCache(); previous = cache?.get(key); } catch { cache = null; }
        if (previous && !previous.stale) return cachedResponse(previous, 'hit');
        if (previous && previous.retryAt > now()) return cachedResponse(previous, 'stale', 'REFRESH_COOLDOWN');
        let job = pending.get(key);
        if (!job) {
          if (pending.size >= maxConcurrent) {
            if (previous) return cachedResponse(previous, 'stale', 'SERVICE_BUSY');
            throw new AdapterError('弹幕服务繁忙，请稍后重试', 429);
          }
          const release = cache?.protect(key);
          job = (async () => {
            try {
              const value = await (cache ? runProvider(() => fetchComments(metadata)) : fetchComments(metadata));
              if (value.match?.source === 'local') return value;
              if (cacheableResult(metadata, value)) {
                let saved = false;
                try { saved = getCacheRevision() === cacheRevision && cache?.put(key, value) === true; } catch { /* The transaction retains the last successful row. */ }
                return saved ? { ...value, cache: { status: previous ? 'refreshed' : 'miss', stale: false, storedAt: new Date(now()).toISOString() } } : value;
              }
              if (previous) {
                try { cache?.defer(key); } catch { /* Keep the stored result even if storage is unavailable. */ }
                return cachedResponse(previous, 'stale', 'REFRESH_UNAVAILABLE');
              }
              return value;
            } catch (error) {
              if (!previous) throw error;
              try { cache?.defer(key); } catch { /* Preserve the old row. */ }
              return cachedResponse(previous, 'stale', 'REFRESH_FAILED');
            } finally { release?.(); }
          })();
          pending.set(key, job);
          // Keep the slot until the provider settles, even after callers time out.
          void job.finally(() => { if (pending.get(key) === job) pending.delete(key); }).catch(() => {});
        }
        return job;
      };
      const expiry = new Promise((_, reject) => { timer = setTimeout(() => reject(new AdapterError('弹幕源响应超时，请稍后重试', 504)), timeout); });
      return result(await Promise.race([run(), expiry]));
    } catch (error) {
      if (previous) {
        try { cache?.defer(key); } catch { /* Preserve the old row. */ }
        return result(cachedResponse(previous, 'stale', error?.status === 504 ? 'REFRESH_TIMEOUT' : 'REFRESH_FAILED'));
      }
      return result(unavailable(error instanceof AdapterError ? error.message : '弹幕服务暂时不可用，请稍后重试'), error instanceof AdapterError ? error.status : 502);
    } finally { clearTimeout(timer); }
  };
}
