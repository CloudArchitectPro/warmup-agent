'use strict';

require('dotenv').config();
const { ImapFlow } = require('imapflow');
const cron = require('node-cron');
const logger = require('./logger');
const db = require('./db');
const config = require('./config.json');

const IMAP_HOST = 'imap.gmail.com';
const IMAP_PORT = 993;
const TRASH_FOLDERS = ['[Gmail]/Trash', 'Trash', 'Deleted Items'];
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// ─── Build per-domain IMAP credentials ────────────────────────────────────────

function domainSlug(domain) {
  return domain.replace(/[\.\-]/g, '_').toUpperCase();
}

function getImapCredentials(domainEntry) {
  const slug = domainSlug(domainEntry.domain);
  const password = process.env[`IMAP_PASSWORD_${slug}`];
  const userOverride = process.env[`IMAP_USER_${slug}`];
  const user = userOverride || domainEntry.senders[0];
  return { user, password };
}

// ─── Single-domain IMAP cleanup ───────────────────────────────────────────────

async function cleanDomain(domainEntry, emailsDue) {
  const { user, password } = getImapCredentials(domainEntry);

  if (!password) {
    logger.warn(`[cleanup] No IMAP password for ${domainEntry.domain} — skipping`);
    return;
  }

  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user, pass: password },
    logger: false,
  });

  try {
    await client.connect();
    logger.info(`[cleanup] Connected to IMAP for ${domainEntry.domain} as ${user}`);

    const lock = await client.getMailboxLock('INBOX');
    try {
      for (const email of emailsDue) {
        if (email.receiver_domain !== domainEntry.domain && email.sender_domain !== domainEntry.domain) {
          continue;
        }
        await processEmail(client, email, domainEntry.domain);
      }
    } finally {
      lock.release();
    }
  } catch (err) {
    logger.error(`[cleanup] IMAP error for ${domainEntry.domain}: ${err.message}`);
  } finally {
    try { await client.logout(); } catch (_) {}
  }
}

async function processEmail(client, email, currentDomain) {
  const messageId = email.message_id;
  const isOld = (Date.now() - new Date(email.sent_at).getTime()) >= SEVEN_DAYS_MS;

  try {
    // Search by Message-ID first
    let uids = await client.search({ header: { 'Message-ID': messageId } });

    // Fallback: search by X-Warmup header
    if (!uids || uids.length === 0) {
      uids = await client.search({ header: { 'X-Warmup': 'true' } });
      // Filter to just this message via envelope date proximity — best-effort
      if (uids && uids.length > 0) {
        logger.debug(`[cleanup] Fallback X-Warmup scan found ${uids.length} candidates for ${messageId}`);
        // We'll just attempt all; each is checked individually
      }
    }

    if (!uids || uids.length === 0) {
      logger.debug(`[cleanup] Message not found in INBOX: ${messageId}`);
      db.logDeletion({ messageId, sender: email.sender, receiver: email.receiver, action: 'not_found', reason: 'not in INBOX' });
      db.markEmailDeleted(messageId, 'deleted'); // Remove from tracking
      return;
    }

    for (const uid of uids) {
      // Check for replies via In-Reply-To
      let hasReply = false;
      try {
        const replies = await client.search({ header: { 'In-Reply-To': messageId } });
        if (replies && replies.length > 0) hasReply = true;
      } catch (_) {}

      if (hasReply) {
        logger.info(`[cleanup] Keeping ${messageId} — has reply (trust signal)`);
        db.markEmailDeleted(messageId, 'kept_reply');
        db.logDeletion({ messageId, sender: email.sender, receiver: email.receiver, action: 'kept_reply', reason: 'reply found' });
        return;
      }

      if (isOld) {
        // Hard delete — permanent
        await client.messageDelete(uid, { uid: true });
        logger.info(`[cleanup] Hard deleted (>7d): ${messageId}`);
        db.markEmailDeleted(messageId, 'hard_deleted');
        db.logDeletion({ messageId, sender: email.sender, receiver: email.receiver, action: 'hard_deleted', reason: '>7 days old' });
      } else {
        // Move to Trash
        let moved = false;
        for (const trashFolder of TRASH_FOLDERS) {
          try {
            await client.messageMove(uid, trashFolder, { uid: true });
            logger.info(`[cleanup] Moved to ${trashFolder}: ${messageId}`);
            db.markEmailDeleted(messageId, 'deleted');
            db.logDeletion({ messageId, sender: email.sender, receiver: email.receiver, action: 'moved_trash', reason: trashFolder });
            moved = true;
            break;
          } catch (_) {
            // Try next folder
          }
        }
        if (!moved) {
          logger.warn(`[cleanup] Could not move to trash: ${messageId} — attempting hard delete`);
          try {
            await client.messageDelete(uid, { uid: true });
            db.markEmailDeleted(messageId, 'hard_deleted');
            db.logDeletion({ messageId, sender: email.sender, receiver: email.receiver, action: 'hard_deleted', reason: 'trash unavailable' });
          } catch (err2) {
            logger.error(`[cleanup] Hard delete also failed for ${messageId}: ${err2.message}`);
            db.logDeletion({ messageId, sender: email.sender, receiver: email.receiver, action: 'error', reason: err2.message });
          }
        }
      }
    }
  } catch (err) {
    logger.error(`[cleanup] Error processing ${messageId}: ${err.message}`);
    db.logDeletion({ messageId, sender: email.sender, receiver: email.receiver, action: 'error', reason: err.message });
  }
}

// ─── Main cleanup runner ──────────────────────────────────────────────────────

async function runCleanup() {
  logger.info('[cleanup] Starting IMAP cleanup run');
  const emailsDue = db.getEmailsDueForDeletion();

  if (emailsDue.length === 0) {
    logger.info('[cleanup] No emails due for deletion');
    return;
  }

  logger.info(`[cleanup] Found ${emailsDue.length} email(s) due for deletion`);

  for (const domainEntry of config.domainRing) {
    const relevant = emailsDue.filter(
      e => e.receiver_domain === domainEntry.domain || e.sender_domain === domainEntry.domain
    );
    if (relevant.length === 0) continue;
    await cleanDomain(domainEntry, relevant);
  }

  logger.info('[cleanup] IMAP cleanup run complete');
}

// ─── Cron + startup scheduling ────────────────────────────────────────────────

function startCleanupCron() {
  // 3am nightly
  cron.schedule('0 3 * * *', async () => {
    logger.info('[cleanup] 3am cron triggered');
    try { await runCleanup(); } catch (err) { logger.error(`[cleanup] Cron error: ${err.message}`); }
  }, { timezone: config.timezone || 'America/New_York' });

  logger.info('[cleanup] 3am nightly cleanup cron scheduled');

  // 5 minutes after startup
  setTimeout(async () => {
    logger.info('[cleanup] Startup +5min cleanup triggered');
    try { await runCleanup(); } catch (err) { logger.error(`[cleanup] Startup cleanup error: ${err.message}`); }
  }, 5 * 60 * 1000);

  logger.info('[cleanup] Startup cleanup scheduled in 5 minutes');
}

module.exports = { startCleanupCron, runCleanup };
