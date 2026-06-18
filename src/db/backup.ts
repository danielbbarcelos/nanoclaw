/**
 * Backups for the central DB (`data/v2.db`).
 *
 * `data/v2.db` is the sole store of identity, roles, and wiring — and it's
 * gitignored, so a corruption/`rm`/botched-migration loses everything with no
 * recovery path. This module adds consistent online snapshots via
 * `VACUUM INTO`, which (unlike a raw `cp`) folds in any WAL frames and reads a
 * single committed view even with the host still writing — no `-wal`/`-shm`
 * sidecar to copy.
 *
 * Snapshots land in `data/backups/`. Three triggers:
 *   - pre-migration  (runMigrations, before applying any pending migration)
 *   - periodic       (startDbBackupTimer, default daily)
 *   - manual         (scripts/backup-db.ts)
 */
import fs from 'fs';
import path from 'path';

import type Database from 'better-sqlite3';

import { DATA_DIR } from '../config.js';
import { getDb } from './connection.js';
import { log } from '../log.js';

/** How many snapshots per source DB to retain. Override with NANOCLAW_DB_BACKUP_KEEP. */
const KEEP = Math.max(1, Number(process.env.NANOCLAW_DB_BACKUP_KEEP) || 14);

/** Periodic backup interval in hours (0 disables). Override with NANOCLAW_DB_BACKUP_INTERVAL_HOURS. */
const INTERVAL_HOURS =
  process.env.NANOCLAW_DB_BACKUP_INTERVAL_HOURS !== undefined
    ? Number(process.env.NANOCLAW_DB_BACKUP_INTERVAL_HOURS)
    : 24;

export function backupDir(dataDir: string = DATA_DIR): string {
  return path.join(dataDir, 'backups');
}

/**
 * Write a consistent snapshot of `db` to `data/backups/<name>.<label>-<ts>.bak`
 * and prune to the most recent KEEP snapshots for that source. Returns the
 * backup path, or null when the DB has no on-disk file (in-memory/test).
 */
export function backupSqlite(db: Database.Database, label: string, dataDir: string = DATA_DIR): string | null {
  const src = db.name; // better-sqlite3 exposes the file path
  if (!src || src === ':memory:') return null;

  const dir = backupDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const base = path.basename(src);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(dir, `${base}.${label}-${stamp}.bak`);

  // Path is host-constructed (never user input); escape quotes defensively.
  db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  pruneBackups(dir, base);
  log.info('DB backup written', { dest, label });
  return dest;
}

function pruneBackups(dir: string, base: string): void {
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(`${base}.`) && f.endsWith('.bak'))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(KEEP)) {
      try {
        fs.unlinkSync(path.join(dir, f));
      } catch {
        /* best effort */
      }
    }
  } catch (err) {
    log.warn('Backup prune failed', { err });
  }
}

let _timer: ReturnType<typeof setInterval> | null = null;

/** Start the periodic backup timer for the central DB. No-op if disabled. */
export function startDbBackupTimer(): void {
  if (_timer || !Number.isFinite(INTERVAL_HOURS) || INTERVAL_HOURS <= 0) return;
  const ms = INTERVAL_HOURS * 60 * 60 * 1000;
  _timer = setInterval(() => {
    try {
      backupSqlite(getDb(), 'periodic');
    } catch (err) {
      log.warn('Periodic DB backup failed', { err });
    }
  }, ms);
  // Don't keep the event loop alive solely for backups.
  _timer.unref?.();
  log.info('DB backup timer started', { intervalHours: INTERVAL_HOURS, keep: KEEP });
}

export function stopDbBackupTimer(): void {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}
