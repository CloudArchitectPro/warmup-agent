'use strict';

require('dotenv').config();
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const logger = require('./logger');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'warmup.db');

let _db = null;

function getDb() {
  if (_db) return _db;

  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  _db = new Database(DB_PATH);

  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');
  _db.pragma('foreign_keys = ON');

  initSchema(_db);
  logger.info(`[db] SQLite opened: ${DB_PATH} (WAL mode)`);
  return _db;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS domain_stats (
      domain        TEXT PRIMARY KEY,
      start_date    TEXT NOT NULL,
      emails_today  INTEGER NOT NULL DEFAULT 0,
      last_sent_at  TEXT,
      total_sent    INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS sender_stats (
      sender        TEXT PRIMARY KEY,
      domain        TEXT NOT NULL,
      start_date    TEXT NOT NULL,
      emails_today  INTEGER NOT NULL DEFAULT 0,
      last_sent_at  TEXT,
      total_sent    INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS sent_emails (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id          TEXT UNIQUE NOT NULL,
      sender              TEXT NOT NULL,
      receiver            TEXT NOT NULL,
      sender_domain       TEXT NOT NULL,
      receiver_domain     TEXT NOT NULL,
      subject             TEXT,
      sent_at             TEXT NOT NULL,
      scheduled_delete_at TEXT NOT NULL,
      status              TEXT NOT NULL DEFAULT 'sent',
      deleted_at          TEXT
    );

    CREATE TABLE IF NOT EXISTS send_queue (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      sender        TEXT NOT NULL,
      receiver      TEXT NOT NULL,
      sender_domain TEXT NOT NULL,
      scheduled_at  TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending',
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS deletion_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id  TEXT NOT NULL,
      sender      TEXT NOT NULL,
      receiver    TEXT NOT NULL,
      action      TEXT NOT NULL,
      reason      TEXT,
      logged_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_sent_status     ON sent_emails(status);
    CREATE INDEX IF NOT EXISTS idx_sent_sender     ON sent_emails(sender_domain);
    CREATE INDEX IF NOT EXISTS idx_queue_status    ON send_queue(status, scheduled_at);
    CREATE INDEX IF NOT EXISTS idx_queue_domain    ON send_queue(sender_domain);
    CREATE INDEX IF NOT EXISTS idx_queue_sender    ON send_queue(sender);
    CREATE INDEX IF NOT EXISTS idx_sender_stats    ON sender_stats(domain);
    CREATE INDEX IF NOT EXISTS idx_sent_message_id ON sent_emails(message_id);
  `);
}

// ─── Domain stats (kept for dashboard backward compat) ────────────────────────

function initDomainStats(domains) {
  const db = getDb();
  const today = todayISO();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO domain_stats (domain, start_date)
    VALUES (?, ?)
  `);
  const insertMany = db.transaction((domains) => {
    for (const d of domains) insert.run(d, today);
  });
  insertMany(domains);
}

function getDomainStat(domain) {
  return getDb().prepare('SELECT * FROM domain_stats WHERE domain = ?').get(domain);
}

function ensureSettingsTable() {
  getDb().prepare(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `).run();
}
function getSetting(key) {
  ensureSettingsTable();
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}
function setSetting(key, value) {
  ensureSettingsTable();
  getDb().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
}

function resetDailyCounters() {
  getDb().prepare(`UPDATE domain_stats SET emails_today = 0`).run();
  getDb().prepare(`UPDATE sender_stats SET emails_today = 0`).run();
  logger.info('[db] Daily counters reset for all senders');
}

// ─── Sender stats (per email account) ────────────────────────────────────────

function initSenderStats(senders) {
  const db = getDb();
  const today = todayISO();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO sender_stats (sender, domain, start_date)
    VALUES (?, ?, ?)
  `);
  const insertMany = db.transaction((senders) => {
    for (const s of senders) insert.run(s.sender, s.domain, today);
  });
  insertMany(senders);
}

function getSenderStat(sender) {
  return getDb().prepare('SELECT * FROM sender_stats WHERE sender = ?').get(sender);
}

function incrementSenderSentToday(sender) {
  const db = getDb();
  db.prepare(`
    UPDATE sender_stats
    SET emails_today = emails_today + 1,
        total_sent   = total_sent + 1,
        last_sent_at = datetime('now')
    WHERE sender = ?
  `).run(sender);

  // Keep domain_stats in sync for dashboard
  const stat = getSenderStat(sender);
  if (stat) {
    db.prepare(`
      UPDATE domain_stats
      SET emails_today = emails_today + 1,
          total_sent   = total_sent + 1,
          last_sent_at = datetime('now')
      WHERE domain = ?
    `).run(stat.domain);
  }
}

function getRampDay(startDateISO) {
  const start = new Date(startDateISO + 'T00:00:00Z');
  const now = new Date();
  const diffMs = now - start;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  return diffDays + 1;
}

// ─── Send queue ───────────────────────────────────────────────────────────────

function enqueueItems(items) {
  const db = getDb();
  const insert = db.prepare(`
    INSERT INTO send_queue (sender, receiver, sender_domain, scheduled_at)
    VALUES (@sender, @receiver, @sender_domain, @scheduled_at)
  `);
  const insertMany = db.transaction((items) => {
    for (const item of items) insert.run(item);
  });
  insertMany(items);
}

function getPendingQueueItems() {
  return getDb().prepare(`
    SELECT * FROM send_queue
    WHERE status = 'pending'
    ORDER BY scheduled_at ASC
  `).all();
}

function markQueueItemSent(id) {
  getDb().prepare(`UPDATE send_queue SET status = 'sent' WHERE id = ?`).run(id);
}

function markQueueItemSkipped(id) {
  getDb().prepare(`UPDATE send_queue SET status = 'skipped' WHERE id = ?`).run(id);
}

function clearTodayQueue() {
  getDb().prepare(`
    DELETE FROM send_queue
    WHERE status = 'pending'
      AND date(scheduled_at) = date('now')
  `).run();
}

function hasTodaySenderQueue(sender) {
  const row = getDb().prepare(`
    SELECT COUNT(*) as cnt FROM send_queue
    WHERE sender = ?
      AND date(scheduled_at) = date('now')
      AND status = 'pending'
  `).get(sender);
  return row && row.cnt > 0;
}

function hasTodayQueue(domain) {
  const row = getDb().prepare(`
    SELECT COUNT(*) as cnt FROM send_queue
    WHERE sender_domain = ?
      AND date(scheduled_at) = date('now')
      AND status = 'pending'
  `).get(domain);
  return row && row.cnt > 0;
}

// ─── Sent emails ──────────────────────────────────────────────────────────────

function logSentEmail({ messageId, sender, receiver, senderDomain, receiverDomain, subject }) {
  const now = new Date();
  const sentAt = now.toISOString();
  const deleteAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();

  getDb().prepare(`
    INSERT OR IGNORE INTO sent_emails
      (message_id, sender, receiver, sender_domain, receiver_domain, subject, sent_at, scheduled_delete_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(messageId, sender, receiver, senderDomain, receiverDomain, subject, sentAt, deleteAt);
}

function getEmailsDueForDeletion() {
  return getDb().prepare(`
    SELECT * FROM sent_emails
    WHERE status = 'sent'
      AND scheduled_delete_at <= datetime('now')
  `).all();
}

function markEmailDeleted(messageId, action, id) {
  if (id) {
    getDb().prepare(`
      UPDATE sent_emails
      SET status = ?, deleted_at = datetime('now')
      WHERE id = ?
    `).run(action, id);
  } else {
    getDb().prepare(`
      UPDATE sent_emails
      SET status = ?, deleted_at = datetime('now')
      WHERE message_id = ?
    `).run(action, messageId);
  }
}

// New function: mark by message_id (for engager which doesn't have the id)
function markEmailDeletedByMessageId(messageId, action) {
  getDb().prepare(`
    UPDATE sent_emails
    SET status = ?, deleted_at = datetime('now')
    WHERE message_id = ?
  `).run(action, messageId);
}

// ─── Deletion log ─────────────────────────────────────────────────────────────

function logDeletion({ messageId, sender, receiver, action, reason }) {
  getDb().prepare(`
    INSERT INTO deletion_log (message_id, sender, receiver, action, reason)
    VALUES (?, ?, ?, ?, ?)
  `).run(messageId, sender, receiver, action, reason || null);
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
    logger.info('[db] SQLite connection closed');
  }
}

module.exports = {
  getDb,
  initDomainStats,
  getDomainStat,
  initSenderStats,
  getSenderStat,
  incrementSenderSentToday,
  resetDailyCounters,
  getSetting,
  setSetting,
  enqueueItems,
  getPendingQueueItems,
  markQueueItemSent,
  markQueueItemSkipped,
  clearTodayQueue,
  hasTodayQueue,
  hasTodaySenderQueue,
  logSentEmail,
  getEmailsDueForDeletion,
  markEmailDeleted,
  markEmailDeletedByMessageId,
  logDeletion,
  getRampDay,
  todayISO,
  closeDb,
};
