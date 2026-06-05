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

  // Ensure directory exists
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  _db = new Database(DB_PATH);

  // WAL mode for crash safety
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
      start_date    TEXT NOT NULL,          -- ISO date YYYY-MM-DD
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
      sent_at             TEXT NOT NULL,    -- ISO timestamp
      scheduled_delete_at TEXT NOT NULL,    -- sent_at + 24h
      status              TEXT NOT NULL DEFAULT 'sent',  -- sent | deleted | kept_reply | hard_deleted
      deleted_at          TEXT
    );

    CREATE TABLE IF NOT EXISTS send_queue (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      sender        TEXT NOT NULL,
      receiver      TEXT NOT NULL,
      sender_domain TEXT NOT NULL,
      scheduled_at  TEXT NOT NULL,           -- ISO timestamp
      status        TEXT NOT NULL DEFAULT 'pending',  -- pending | sent | skipped
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS deletion_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id  TEXT NOT NULL,
      sender      TEXT NOT NULL,
      receiver    TEXT NOT NULL,
      action      TEXT NOT NULL,            -- moved_trash | hard_deleted | kept_reply | not_found | error
      reason      TEXT,
      logged_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_sent_status     ON sent_emails(status);
    CREATE INDEX IF NOT EXISTS idx_sent_sender     ON sent_emails(sender_domain);
    CREATE INDEX IF NOT EXISTS idx_queue_status    ON send_queue(status, scheduled_at);
    CREATE INDEX IF NOT EXISTS idx_queue_domain    ON send_queue(sender_domain);
  `);
}

// ─── Domain stats ─────────────────────────────────────────────────────────────

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

function incrementDomainSentToday(domain) {
  getDb().prepare(`
    UPDATE domain_stats
    SET emails_today = emails_today + 1,
        total_sent   = total_sent + 1,
        last_sent_at = datetime('now')
    WHERE domain = ?
  `).run(domain);
}

function resetDailyCounters() {
  getDb().prepare(`UPDATE domain_stats SET emails_today = 0`).run();
  logger.info('[db] Daily counters reset for all domains');
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
  // Remove today's pending items (midnight refresh)
  getDb().prepare(`
    DELETE FROM send_queue
    WHERE status = 'pending'
      AND date(scheduled_at) = date('now')
  `).run();
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

function markEmailDeleted(messageId, action) {
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

function getRampDay(startDateISO) {
  const start = new Date(startDateISO + 'T00:00:00Z');
  const now = new Date();
  const diffMs = now - start;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  return diffDays + 1; // Day 1 on start date
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
  incrementDomainSentToday,
  resetDailyCounters,
  enqueueItems,
  getPendingQueueItems,
  markQueueItemSent,
  markQueueItemSkipped,
  clearTodayQueue,
  hasTodayQueue,
  logSentEmail,
  getEmailsDueForDeletion,
  markEmailDeleted,
  logDeletion,
  getRampDay,
  todayISO,
  closeDb,
};
