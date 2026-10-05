// No Node imports at module load: Worker, Forward Widget and older Node runtimes
// must remain usable without SQLite. Only the persistent Node server opens it.
import { DAY_MS, clampCacheDays } from './dushengtv-cache-key.js';
export { DAY_MS, clampCacheDays, danmakuCacheKey, danmakuCacheScope, cacheableResult } from './dushengtv-cache-key.js';

export async function openDanmakuCache({ filename, ttlDays = 14, maxBytes = 512 * 1024 * 1024, now = Date.now } = {}) {
  const sqliteModule = ['node', 'sqlite'].join(':');
  const { DatabaseSync } = await import(sqliteModule);
  const [{ mkdir, chmod }, path, { fileURLToPath }, { createHash }] = await Promise.all([
    import('node:fs/promises'), import('node:path'), import('node:url'), import('node:crypto')
  ]);
  filename ||= fileURLToPath(new URL('../../.cache/dushengtv-danmaku.sqlite', import.meta.url));
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  try {
    await chmod(filename, 0o600);
    db.exec(`PRAGMA busy_timeout=3000; PRAGMA auto_vacuum=INCREMENTAL;
      PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      PRAGMA journal_size_limit=8388608; PRAGMA wal_autocheckpoint=128;
      CREATE TABLE IF NOT EXISTS comments (
        cache_key TEXT PRIMARY KEY, payload TEXT NOT NULL, bytes INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, accessed_at INTEGER NOT NULL,
        retry_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS comments_accessed ON comments(accessed_at);`);
  } catch (error) { db.close(); throw error; }
  const hash = key => createHash('sha256').update(key).digest('hex');
  const protectedKeys = new Set();
  let days = clampCacheDays(ttlDays), capacity = maxBytes;
  const read = db.prepare('SELECT payload, updated_at, retry_at FROM comments WHERE cache_key=?');
  const touch = db.prepare('UPDATE comments SET accessed_at=? WHERE cache_key=?');
  const remove = db.prepare('DELETE FROM comments WHERE cache_key=?');
  const totalBytes = db.prepare('SELECT COALESCE(SUM(bytes),0) AS size FROM comments');
  function prune(exclude = null) {
    let size = Number(totalBytes.get().size);
    if (size <= capacity) return size;
    // TTL decides freshness, never deletion: a quiet film must still have its
    // previous successful result if its next refresh encounters a provider error.
    const rows = db.prepare('SELECT cache_key, bytes FROM comments ORDER BY accessed_at').all();
    for (const row of rows) {
      if (size <= capacity) break;
      if (row.cache_key === exclude || protectedKeys.has(row.cache_key)) continue;
      remove.run(row.cache_key); size -= Number(row.bytes);
    }
    return size;
  }
  const cache = {
    configure(options = {}) {
      days = clampCacheDays(options.ttlDays ?? days);
      capacity = Math.max(1, Number(options.maxBytes) || capacity);
    },
    protect(key) { const id = hash(key); protectedKeys.add(id); return () => protectedKeys.delete(id); },
    get(key) {
      const id = hash(key), row = read.get(id);
      if (!row) return null;
      let value;
      try { value = JSON.parse(row.payload); } catch { return null; }
      if (value?.available !== true || !Array.isArray(value.comments) || !value.comments.length) return null;
      touch.run(now(), id);
      return { value, updatedAt: Number(row.updated_at), stale: now() >= Number(row.updated_at) + days * DAY_MS, retryAt: Number(row.retry_at) };
    },
    put(key, value) {
      if (value?.available !== true || !Array.isArray(value.comments) || !value.comments.length) return false;
      const payload = JSON.stringify({ available: true, comments: value.comments, match: value.match });
      const bytes = new TextEncoder().encode(payload).length;
      if (bytes > capacity) return false;
      const id = hash(key), timestamp = now();
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare(`INSERT INTO comments(cache_key,payload,bytes,updated_at,accessed_at,retry_at) VALUES(?,?,?,?,?,0)
          ON CONFLICT(cache_key) DO UPDATE SET payload=excluded.payload,bytes=excluded.bytes,
            updated_at=excluded.updated_at,accessed_at=excluded.accessed_at,retry_at=0`).run(id, payload, bytes, timestamp, timestamp);
        // Replacement and eviction commit together; failures keep the prior row.
        if (prune(id) > capacity) { db.exec('ROLLBACK'); return false; }
        db.exec('COMMIT');
        return true;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    defer(key, retryMs = 60000) {
      db.prepare('UPDATE comments SET retry_at=? WHERE cache_key=?').run(now() + retryMs, hash(key));
    },
    maintain() {
      prune();
      db.exec('PRAGMA incremental_vacuum(2048); PRAGMA wal_checkpoint(PASSIVE)');
    },
    close() { clearInterval(timer); db.close(); },
    stats() { return { entries: Number(db.prepare('SELECT COUNT(*) AS count FROM comments').get().count), bytes: Number(totalBytes.get().size) }; }
  };
  const timer = setInterval(() => { try { cache.maintain(); } catch { /* Retry later without deleting/replacing the database. */ } }, 60 * 60 * 1000);
  timer.unref?.();
  return cache;
}

let cachePromise;
let unavailableUntil = 0;
export async function getPersistentDanmakuCache({ enabled = true, ttlDays = 14, maxMB = 512, platform } = {}) {
  if (!enabled || platform !== 'node' || typeof process === 'undefined' || Number(process.versions?.node?.split('.')[0]) < 22) return null;
  if (Date.now() < unavailableUntil) return null;
  const options = { ttlDays, maxBytes: Math.max(64, Math.min(4096, Number(maxMB) || 512)) * 1024 * 1024 };
  if (!cachePromise) {
    cachePromise = openDanmakuCache(options).catch(() => {
      cachePromise = null; unavailableUntil = Date.now() + 60000;
      // Never log exception text: disk paths or provider information can be private.
      console.warn('[dushengtv-cache] SQLite unavailable; using live provider results and preserving the existing database.');
      return null;
    });
  }
  const cache = await cachePromise;
  cache?.configure(options);
  return cache;
}
