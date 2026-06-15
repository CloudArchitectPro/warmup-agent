'use strict';

/**
 * reset-to-day1.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Backs up the existing warmup.db, then wipes ALL history and resets every
 * sender to Day 1 starting TODAY. Every counter becomes 0, every queue is
 * cleared, every log is gone.
 *
 * Usage:
 *   node reset-to-day1.js           ← dry run, prints what will happen
 *   node reset-to-day1.js --apply   ← actually does it (backup is made first)
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');

const DB_PATH     = process.env.DB_PATH || path.join(__dirname, 'data', 'warmup.db');
const BACKUP_DIR  = path.join(__dirname, 'data', 'backups');
const config      = require('./config.json');

const APPLY = process.argv.includes('--apply');
const today = new Date().toISOString().slice(0, 10);

// ─── Collect all 37 senders from config ──────────────────────────────────────

const allSenders = [];
for (const domainEntry of config.domainRing) {
  for (const sender of domainEntry.senders) {
    allSenders.push({ sender: sender.toLowerCase(), domain: domainEntry.domain });
  }
}

const allDomains = config.domainRing.map(d => d.domain);

// ─── Dry run preview ──────────────────────────────────────────────────────────

console.log('\n══════════════════════════════════════════════════════════');
console.log('  WARMUP AGENT — FULL RESET TO DAY 1');
console.log('══════════════════════════════════════════════════════════');
console.log(`  Mode    : ${APPLY ? '⚡ APPLY (writes to DB)' : '🔍 DRY RUN (no writes)'}`);
console.log(`  DB      : ${DB_PATH}`);
console.log(`  Today   : ${today}`);
console.log(`  Senders : ${allSenders.length} across ${allDomains.length} domains`);
console.log('──────────────────────────────────────────────────────────');
console.log('\n  All senders will be reset to:');
console.log(`    start_date    = ${today}  (Day 1)`);
console.log('    emails_today  = 0');
console.log('    total_sent    = 0');
console.log('    last_sent_at  = NULL');
console.log('\n  Tables to be WIPED:');
console.log('    ✗  sent_emails');
console.log('    ✗  send_queue');
console.log('    ✗  deletion_log');
console.log('    ✗  pending_replies');
console.log('    ✗  settings  (engager_last_uid etc.)');
console.log('\n  Tables to be RESET (not wiped):');
console.log('    ~  sender_stats  → all counters zeroed, start_date = today');
console.log('    ~  domain_stats  → all counters zeroed, start_date = today');
console.log('──────────────────────────────────────────────────────────');

console.log('\n  Sender list:');
for (const s of allSenders) {
  console.log(`    • ${s.sender.padEnd(36)}  domain=${s.domain}`);
}

if (!APPLY) {
  console.log('\n  ⚠️  DRY RUN — nothing was changed.');
  console.log('  Run with --apply to execute.\n');
  process.exit(0);
}

// ─── Backup first ─────────────────────────────────────────────────────────────

if (!fs.existsSync(DB_PATH)) {
  console.error(`\n  ✗ DB not found at ${DB_PATH} — aborting.\n`);
  process.exit(1);
}

if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

const ts         = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const backupPath = path.join(BACKUP_DIR, `warmup-backup-${ts}.db`);
fs.copyFileSync(DB_PATH, backupPath);
console.log(`\n  ✅ Backup saved: ${backupPath}`);

// ─── Open DB and apply reset ───────────────────────────────────────────────────

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const reset = db.transaction(() => {

  // 1. Wipe transactional tables completely
  db.prepare('DELETE FROM sent_emails').run();
  db.prepare('DELETE FROM send_queue').run();
  db.prepare('DELETE FROM deletion_log').run();

  // Wipe pending_replies if it exists
  const hasPR = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='pending_replies'`
  ).get();
  if (hasPR) db.prepare('DELETE FROM pending_replies').run();

  // Wipe settings (clears engager_last_uid and daily-reset marker)
  const hasSettings = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='settings'`
  ).get();
  if (hasSettings) db.prepare('DELETE FROM settings').run();

  // Reset sqlite autoincrement sequences
  db.prepare(`DELETE FROM sqlite_sequence`).run();

  // 2. Reset domain_stats — upsert every domain to today / zeroed
  const upsertDomain = db.prepare(`
    INSERT INTO domain_stats (domain, start_date, emails_today, last_sent_at, total_sent)
    VALUES (?, ?, 0, NULL, 0)
    ON CONFLICT(domain) DO UPDATE SET
      start_date   = excluded.start_date,
      emails_today = 0,
      last_sent_at = NULL,
      total_sent   = 0
  `);
  for (const domain of allDomains) {
    upsertDomain.run(domain, today);
  }

  // 3. Reset sender_stats — upsert every sender to today / zeroed
  const upsertSender = db.prepare(`
    INSERT INTO sender_stats (sender, domain, start_date, emails_today, last_sent_at, total_sent)
    VALUES (?, ?, ?, 0, NULL, 0)
    ON CONFLICT(sender) DO UPDATE SET
      domain       = excluded.domain,
      start_date   = excluded.start_date,
      emails_today = 0,
      last_sent_at = NULL,
      total_sent   = 0
  `);
  for (const s of allSenders) {
    upsertSender.run(s.sender, s.domain, today);
  }

});

try {
  reset();
  console.log('\n  ✅ Reset complete!\n');
  console.log('  Summary:');
  console.log(`    • ${allSenders.length} senders → Day 1 (${today}), all counters = 0`);
  console.log(`    • ${allDomains.length} domains  → Day 1 (${today}), all counters = 0`);
  console.log('    • sent_emails, send_queue, deletion_log, pending_replies → WIPED');
  console.log('    • settings → WIPED');
  console.log(`    • Backup at: ${backupPath}`);
  console.log('\n  Restart your warmup agent now.\n');
} catch (err) {
  console.error('\n  ✗ Reset FAILED:', err.message);
  console.error('  Your original DB is safe at:', backupPath);
  process.exit(1);
} finally {
  db.close();
}
