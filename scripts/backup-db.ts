/**
 * scripts/backup-db.ts — manual / cron backup of the central DB (`data/v2.db`).
 *
 * Usage:
 *   pnpm exec tsx scripts/backup-db.ts [<db-path>]
 *
 * Writes a consistent snapshot to `data/backups/<name>.manual-<ts>.bak` via
 * `VACUUM INTO` — safe to run while the host is live (it takes only a read
 * lock and folds in WAL frames, so there's no `-wal`/`-shm` to copy). Prunes
 * to the most recent NANOCLAW_DB_BACKUP_KEEP (default 14) snapshots.
 *
 * Restore is a plain copy: stop NanoClaw, then
 *   cp data/backups/v2.db.<...>.bak data/v2.db   (remove any v2.db-wal/-shm first)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import Database from 'better-sqlite3';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = process.argv[2] || path.join(projectRoot, 'data', 'v2.db');

if (!fs.existsSync(dbPath)) {
  console.error(`DB not found: ${dbPath}`);
  process.exit(1);
}

const keep = Math.max(1, Number(process.env.NANOCLAW_DB_BACKUP_KEEP) || 14);
// Backups live in a `backups/` dir alongside the DB being backed up.
const backupsDir = path.join(path.dirname(dbPath), 'backups');
fs.mkdirSync(backupsDir, { recursive: true });

const base = path.basename(dbPath);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dest = path.join(backupsDir, `${base}.manual-${stamp}.bak`);

const db = new Database(dbPath, { readonly: true });
try {
  db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
} finally {
  db.close();
}

// Prune oldest beyond `keep`.
const snapshots = fs
  .readdirSync(backupsDir)
  .filter((f) => f.startsWith(`${base}.`) && f.endsWith('.bak'))
  .map((f) => ({ f, t: fs.statSync(path.join(backupsDir, f)).mtimeMs }))
  .sort((a, b) => b.t - a.t);
for (const { f } of snapshots.slice(keep)) {
  try {
    fs.unlinkSync(path.join(backupsDir, f));
  } catch {
    /* best effort */
  }
}

const sizeKb = Math.round(fs.statSync(dest).size / 1024);
console.log(`Backup written: ${dest} (${sizeKb} KB)`);
