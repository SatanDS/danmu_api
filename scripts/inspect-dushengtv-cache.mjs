// Run from the repository root, or pipe into the container's /app workdir.
// Read-only aggregate diagnostics: never print media payloads, IDs or tokens.
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const filename = resolve('.cache/dushengtv-danmaku.sqlite');
if (!existsSync(filename)) {
  console.log(JSON.stringify({ exists: false, message: 'Database is created after the first remote DuShengTV request.' }));
} else {
  let db;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    db = new DatabaseSync(filename, { readOnly: true });
    const row = db.prepare('SELECT COUNT(*) AS entries, COALESCE(SUM(bytes), 0) AS contentBytes FROM comments').get();
    console.log(JSON.stringify({ exists: true, entries: Number(row.entries), contentBytes: Number(row.contentBytes), databaseBytes: statSync(filename).size }));
  } catch {
    console.error('Cannot read the existing SQLite cache. Check the Node version, file permissions and server logs. No files were modified.');
    process.exitCode = 1;
  } finally { db?.close(); }
}
