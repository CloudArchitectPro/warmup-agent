'use strict';

require('dotenv').config();
const { ImapFlow } = require('imapflow');
const logger = require('./logger');
const db = require('./db');
const config = require('./config.json');

const IMAP_HOST = 'imap.gmail.com';
const IMAP_PORT = 993;
const TRASH_FOLDERS = ['[Gmail]/Trash', 'Trash', 'Deleted Items'];
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

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

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function cleanDomain(domainEntry, emailsDue, processedIds) {
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
        if (email.receiver_domain !== domainEntry.domain) continue;
        if (processedIds.has(email.message_id)) continue;
        processedIds.add(email.message_id);
        await processEmail(client, email, domainEntry.domain);

        // Random pause between processing emails — human-like
        await sleep(randomBetween(5, 20) * 1000);
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
    // Search INBOX by exact Message-ID only.
    // REMOVED: the X-Warmup fallback that previously matched ALL warm-up emails
    // when a specific Message-ID wasn't found — this caused an infinite move loop
    // where the same messages were repeatedly found and re-moved to Trash.
    const uids = await client.search({ header: { 'Message-ID': messageId } });

    if (!uids || uids.length === 0) {
      logger.debug(`[cleanup] Message not found in INBOX: ${messageId}`);
      db.logDeletion({ messageId, sender: email.sender, receiver: email.receiver, action: 'not_found', reason: 'not in INBOX' });
      db.markEmailDeleted(messageId, 'deleted', email.id);
      return;
    }

    for (const uid of uids) {
      let hasReply = false;
      try {
        const replies = await client.search({ header: { 'In-Reply-To': messageId } });
        if (replies && replies.length > 0) hasReply = true;
      } catch (_) {}

      if (hasReply) {
        logger.info(`[cleanup] Keeping ${messageId} — has reply (trust signal)`);
        db.markEmailDeleted(messageId, 'kept_reply', email.id);
        db.logDeletion({ messageId, sender: email.sender, receiver: email.receiver, action: 'kept_reply', reason: 'reply found' });
        return;
      }

      if (isOld) {
        await client.messageDelete(uid, { uid: true });
        logger.info(`[cleanup] Hard deleted (>7d): ${messageId}`);
        db.markEmailDeleted(messageId, 'hard_deleted', email.id);
        db.logDeletion({ messageId, sender: email.sender, receiver: email.receiver, action: 'hard_deleted', reason: '>7 days old' });
      } else {
        let moved = false;
        for (const trashFolder of TRASH_FOLDERS) {
          try {
            await client.messageMove(uid, trashFolder, { uid: true });
            logger.info(`[cleanup] Moved to ${trashFolder}: ${messageId}`);
            db.markEmailDeleted(messageId, 'deleted', email.id);
            db.logDeletion({ messageId, sender: email.sender, receiver: email.receiver, action: 'moved_trash', reason: trashFolder });
            moved = true;
            break;
          } catch (_) {}
        }
        if (!moved) {
          logger.warn(`[cleanup] Could not move to trash: ${messageId} — attempting hard delete`);
          try {
            await client.messageDelete(uid, { uid: true });
            db.markEmailDeleted(messageId, 'hard_deleted', email.id);
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

async function runCleanup() {
  logger.info('[cleanup] Starting IMAP cleanup run');
  const emailsDue = db.getEmailsDueForDeletion();

  if (emailsDue.length === 0) {
    logger.info('[cleanup] No emails due for deletion');
    return;
  }

  logger.info(`[cleanup] Found ${emailsDue.length} email(s) due for deletion`);

  const processedIds = new Set();
  for (const domainEntry of config.domainRing) {
    const relevant = emailsDue.filter(e => e.receiver_domain === domainEntry.domain);
    if (relevant.length === 0) continue;
    await cleanDomain(domainEntry, emailsDue, processedIds);

    // Random gap between domains
    await sleep(randomBetween(30, 120) * 1000);
  }

  logger.info('[cleanup] IMAP cleanup run complete');
}

// ─── Randomized cleanup scheduler ────────────────────────────────────────────

function scheduleNextCleanup() {
  const delayMin = randomBetween(60, 180);
  const delayMs = delayMin * 60 * 1000;
  logger.info(`[cleanup] Next cleanup in ${delayMin} minutes`);
  setTimeout(async () => {
    logger.info('[cleanup] Randomized cleanup triggered');
    try { await runCleanup(); } catch (err) {
      logger.error(`[cleanup] Cleanup error: ${err.message}`);
    }
    scheduleNextCleanup();
  }, delayMs);
}

function startCleanupCron() {
  // Randomized cleanup every 1–3 hours
  scheduleNextCleanup();
  logger.info('[cleanup] Randomized cleanup scheduler started');

  // Startup cleanup: random 8–20 minutes after boot
  const startupDelay = randomBetween(8, 20) * 60 * 1000;
  logger.info(`[cleanup] Startup cleanup scheduled in ${Math.round(startupDelay/60000)} minutes`);

  setTimeout(async () => {
    logger.info('[cleanup] Startup cleanup triggered');
    try { await runCleanup(); } catch (err) {
      logger.error(`[cleanup] Startup cleanup error: ${err.message}`);
    }
  }, startupDelay);
}

module.exports = { startCleanupCron, runCleanup };
