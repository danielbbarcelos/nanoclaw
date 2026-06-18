/**
 * Message-retention pruning. Locks the security/privacy property: terminal
 * history older than the cutoff is removed, but live work (pending/paused
 * tasks, in-flight acks, future-scheduled deliveries) is never dropped.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { INBOUND_SCHEMA, OUTBOUND_SCHEMA } from './schema.js';
import { pruneDeliveredTable, pruneInboundMessages, pruneOutboundMessages } from './session-db.js';

const OLD_ISO = '2000-01-01T00:00:00.000Z';
const OLD_SQLITE = '2000-01-01 00:00:00';
const CUTOFF = '2020-01-01T00:00:00.000Z';

function recent(): string {
  return new Date().toISOString();
}

describe('pruneInboundMessages', () => {
  it('drops old terminal rows, keeps live + recent, and never touches delivered', () => {
    const db = new Database(':memory:');
    db.exec(INBOUND_SCHEMA);
    const ins = db.prepare(
      'INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES (?, ?, ?, ?, ?, ?)',
    );
    ins.run('old-done', 2, 'chat', OLD_ISO, 'completed', '{}');
    ins.run('old-failed', 4, 'chat', OLD_SQLITE, 'failed', '{}');
    ins.run('old-task-pending', 6, 'task', OLD_ISO, 'pending', '{}'); // live → keep
    ins.run('old-task-paused', 8, 'task', OLD_ISO, 'paused', '{}'); // live → keep
    ins.run('recent-done', 10, 'chat', recent(), 'completed', '{}'); // recent → keep

    // Delivery ledger must be left intact here — pruning it independently would
    // make the delivery loop re-send messages whose messages_out still exists.
    db.prepare('INSERT INTO delivered (message_out_id, delivered_at) VALUES (?, ?)').run('d-old', OLD_SQLITE);

    const r = pruneInboundMessages(db, CUTOFF);
    expect(r.messages).toBe(2);

    const ids = (db.prepare('SELECT id FROM messages_in ORDER BY id').all() as Array<{ id: string }>).map((x) => x.id);
    expect(ids).toEqual(['old-task-paused', 'old-task-pending', 'recent-done']);
    // delivered untouched by the inbound prune.
    expect((db.prepare('SELECT COUNT(*) c FROM delivered').get() as { c: number }).c).toBe(1);
    db.close();
  });
});

describe('pruneDeliveredTable', () => {
  it('drops old delivery-tracking rows, keeps recent', () => {
    const db = new Database(':memory:');
    db.exec(INBOUND_SCHEMA);
    db.prepare('INSERT INTO delivered (message_out_id, delivered_at) VALUES (?, ?)').run('d-old', OLD_SQLITE);
    db.prepare('INSERT INTO delivered (message_out_id, delivered_at) VALUES (?, ?)').run('d-new', recent());

    expect(pruneDeliveredTable(db, CUTOFF)).toBe(1);
    const left = (db.prepare('SELECT message_out_id FROM delivered').all() as Array<{ message_out_id: string }>).map(
      (x) => x.message_out_id,
    );
    expect(left).toEqual(['d-new']);
    db.close();
  });
});

describe('pruneOutboundMessages', () => {
  it('drops old messages + old terminal acks, keeps future-scheduled + processing + recent', () => {
    const db = new Database(':memory:');
    db.exec(OUTBOUND_SCHEMA);
    const ins = db.prepare(
      'INSERT INTO messages_out (id, seq, timestamp, deliver_after, kind, content) VALUES (?, ?, ?, ?, ?, ?)',
    );
    ins.run('out-old', 1, OLD_ISO, null, 'chat', '{}');
    ins.run('out-old-future', 3, OLD_ISO, '2099-01-01T00:00:00.000Z', 'chat', '{}'); // scheduled → keep
    ins.run('out-recent', 5, recent(), null, 'chat', '{}'); // recent → keep

    const ack = db.prepare('INSERT INTO processing_ack (message_id, status, status_changed) VALUES (?, ?, ?)');
    ack.run('a-old-done', 'completed', OLD_SQLITE);
    ack.run('a-old-processing', 'processing', OLD_SQLITE); // in-flight → keep
    ack.run('a-recent', 'completed', recent());

    const r = pruneOutboundMessages(db, CUTOFF);
    expect(r.messages).toBe(1);
    expect(r.acks).toBe(1);

    const ids = (db.prepare('SELECT id FROM messages_out ORDER BY id').all() as Array<{ id: string }>).map((x) => x.id);
    expect(ids).toEqual(['out-old-future', 'out-recent']);
    const acks = (
      db.prepare('SELECT message_id FROM processing_ack ORDER BY message_id').all() as Array<{
        message_id: string;
      }>
    ).map((x) => x.message_id);
    expect(acks).toEqual(['a-old-processing', 'a-recent']);
    db.close();
  });
});

// ── Integration: the daily-gated sweep wired into the host loop ──

const TEST_DIR = '/tmp/nanoclaw-retention-sweep-test';

vi.mock('../config.js', async () => {
  const actual = await vi.importActual('../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-retention-sweep-test' };
});
vi.mock('../container-runner.js', () => ({
  isContainerRunning: vi.fn(() => false),
  killContainer: vi.fn(),
  wakeContainer: vi.fn().mockResolvedValue(undefined),
}));

describe('runRetentionSweep', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    process.env.NANOCLAW_MESSAGE_RETENTION_DAYS = '30';
  });

  afterEach(async () => {
    const { closeDb } = await import('./index.js');
    closeDb();
    delete process.env.NANOCLAW_MESSAGE_RETENTION_DAYS;
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('prunes old inbound history for active sessions and honors the daily gate + env switch', async () => {
    const { initTestDb, runMigrations } = await import('./index.js');
    const { createAgentGroup } = await import('./agent-groups.js');
    const { createSession } = await import('./sessions.js');
    const { ensureSchema } = await import('./session-db.js');
    const { inboundDbPath, sessionDir } = await import('../session-manager.js');
    const { runRetentionSweep, resetRetentionGate } = await import('../host-sweep.js');

    const db = initTestDb();
    runMigrations(db);
    const now = () => new Date().toISOString();
    createAgentGroup({ id: 'ag-1', name: 'A', folder: 'a', agent_provider: null, created_at: now() });
    createSession({
      id: 'sess-1',
      agent_group_id: 'ag-1',
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: now(),
      created_at: now(),
    });

    fs.mkdirSync(sessionDir('ag-1', 'sess-1'), { recursive: true });
    const inPath = inboundDbPath('ag-1', 'sess-1');
    ensureSchema(inPath, 'inbound');
    const sdb = new Database(inPath);
    const ins = sdb.prepare(
      'INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES (?, ?, ?, ?, ?, ?)',
    );
    ins.run('old', 2, 'chat', OLD_ISO, 'completed', '{}');
    ins.run('fresh', 4, 'chat', now(), 'completed', '{}');
    sdb.close();

    resetRetentionGate();
    runRetentionSweep(Date.parse('2026-06-17T00:00:00Z'));

    const after = new Database(inPath);
    const ids = (after.prepare('SELECT id FROM messages_in').all() as Array<{ id: string }>).map((x) => x.id);
    expect(ids).toEqual(['fresh']);

    // Daily gate: a second call in the same window is a no-op (re-add old, stays).
    after
      .prepare('INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES (?, ?, ?, ?, ?, ?)')
      .run('old2', 6, 'chat', OLD_ISO, 'completed', '{}');
    after.close();
    runRetentionSweep(Date.parse('2026-06-17T01:00:00Z')); // <24h later → gated

    const after2 = new Database(inPath);
    const ids2 = (after2.prepare('SELECT id FROM messages_in ORDER BY id').all() as Array<{ id: string }>).map(
      (x) => x.id,
    );
    expect(ids2).toEqual(['fresh', 'old2']);
    after2.close();
  });

  it('keeps the delivered ledger + outbound while a container is RUNNING (no re-delivery)', async () => {
    const { initTestDb, runMigrations } = await import('./index.js');
    const { createAgentGroup } = await import('./agent-groups.js');
    const { createSession } = await import('./sessions.js');
    const { ensureSchema } = await import('./session-db.js');
    const { inboundDbPath, outboundDbPath, sessionDir } = await import('../session-manager.js');
    const { runRetentionSweep, resetRetentionGate } = await import('../host-sweep.js');
    const { isContainerRunning } = await import('../container-runner.js');
    vi.mocked(isContainerRunning).mockReturnValue(true); // session is live

    const db = initTestDb();
    runMigrations(db);
    const now = () => new Date().toISOString();
    createAgentGroup({ id: 'ag-1', name: 'A', folder: 'a', agent_provider: null, created_at: now() });
    createSession({
      id: 'sess-1',
      agent_group_id: 'ag-1',
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'running',
      last_active: now(),
      created_at: now(),
    });

    fs.mkdirSync(sessionDir('ag-1', 'sess-1'), { recursive: true });
    const inPath = inboundDbPath('ag-1', 'sess-1');
    const outPath = outboundDbPath('ag-1', 'sess-1');
    ensureSchema(inPath, 'inbound');
    ensureSchema(outPath, 'outbound');

    const sin = new Database(inPath);
    sin
      .prepare('INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES (?, ?, ?, ?, ?, ?)')
      .run('old', 2, 'chat', OLD_ISO, 'completed', '{}');
    // An old delivery marker whose messages_out still exists — must NOT be pruned.
    sin.prepare('INSERT INTO delivered (message_out_id, delivered_at) VALUES (?, ?)').run('m-old', OLD_SQLITE);
    sin.close();
    const sout = new Database(outPath);
    sout
      .prepare('INSERT INTO messages_out (id, seq, timestamp, kind, content) VALUES (?, ?, ?, ?, ?)')
      .run('m-old', 1, OLD_ISO, 'chat', '{}');
    sout.close();

    resetRetentionGate();
    runRetentionSweep(Date.parse('2026-06-17T00:00:00Z'));

    // messages_in pruned (always safe), but delivered + messages_out preserved
    // because the container is running → no re-delivery of m-old.
    const ain = new Database(inPath);
    expect((ain.prepare('SELECT COUNT(*) c FROM messages_in').get() as { c: number }).c).toBe(0);
    expect((ain.prepare('SELECT COUNT(*) c FROM delivered').get() as { c: number }).c).toBe(1);
    ain.close();
    const aout = new Database(outPath);
    expect((aout.prepare('SELECT COUNT(*) c FROM messages_out').get() as { c: number }).c).toBe(1);
    aout.close();

    vi.mocked(isContainerRunning).mockReturnValue(false);
  });

  it('is a no-op when retention is disabled', async () => {
    const { initTestDb, runMigrations } = await import('./index.js');
    const { runRetentionSweep, resetRetentionGate } = await import('../host-sweep.js');
    process.env.NANOCLAW_MESSAGE_RETENTION_DAYS = '0';
    const db = initTestDb();
    runMigrations(db);
    resetRetentionGate();
    expect(() => runRetentionSweep(Date.now())).not.toThrow();
  });
});
