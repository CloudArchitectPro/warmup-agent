'use strict';

require('dotenv').config();
const { ImapFlow } = require('imapflow');
const nodemailer = require('nodemailer');
const logger = require('./logger');
const config = require('./config.json');
const db = require('./db');

const IMAP_HOST = 'imap.gmail.com';
const IMAP_PORT = 993;
const REPLY_RATE = 0.55;

const WINDOW_START = config.sendWindow?.startHour ?? 19;
const WINDOW_END   = config.sendWindow?.endHour   ?? 7;

const TIMING = {
  readDelayMin:    (config.readDelay?.minMinutes || 15) * 60,
  readDelayMax:    (config.readDelay?.maxMinutes || 240) * 60,
  trashDelayMin:   30 * 60,
  trashDelayMax:   72 * 60 * 60,
  betweenEmailMin: 3 * 60,
  betweenEmailMax: 25 * 60,
  replyDelayMin:   (config.replyDelay?.minHours || 2) * 60 * 60,
  replyDelayMax:   (config.replyDelay?.maxHours || 8) * 60 * 60,
};

const DRAIN_MODE = process.env.DRAIN_MODE === 'true';
if (DRAIN_MODE) {
  TIMING.readDelayMin    = 30;
  TIMING.readDelayMax    = 120;
  TIMING.trashDelayMin   = 60;
  TIMING.trashDelayMax   = 300;
  TIMING.betweenEmailMin = 15;
  TIMING.betweenEmailMax = 45;
  TIMING.replyDelayMin   = 60;
  TIMING.replyDelayMax   = 300;
  logger.warn('[engager] ⚠️ DRAIN MODE active — unrealistic timing, only for testing!');
}

const REPLY_TEMPLATES = [
  "Thanks for reaching out! I'll look into this and get back to you shortly.",
  "Got it, appreciate the update. Will follow up on my end.",
  "Thanks for the heads up — noted!",
  "Received, thanks. I'll take a look and circle back.",
  "Good to know, thanks for keeping me in the loop.",
  "Appreciate the update! I'll check and confirm.",
  "Thanks! Will review and respond soon.",
  "Got it — thanks for the quick note.",
  "Noted, appreciate you reaching out.",
  "Thanks for the message! I'll get back to you after reviewing.",
  "Sounds good, thanks for the update.",
  "Received — I'll follow up shortly.",
  "Thanks, this is helpful. I'll review and get back to you.",
  "Appreciate you sending this over — I'll take a look.",
  "Got it! Will circle back once I've had a chance to review.",
  "Thanks — noted on my end.",
  "Received! I'll follow up as soon as I can.",
  "Good timing, thanks for the note. I'll check and confirm.",
  "Appreciate the heads up. I'll look into this.",
  "Thanks for keeping me posted — I'll review and respond.",
  "Noted, thank you. Will be in touch.",
  "Thanks for this — I'll get back to you after going through it.",
  "Much appreciated! I'll follow up shortly.",
  "Got it, thanks. I'll review and circle back.",
  "Will do — thanks for the ping.",
  "On it! I'll get back to you soon.",
  "Thanks for the note, will get to this shortly.",
  "Received and noted — thanks!",
  "Appreciate it. I'll follow up once I've reviewed.",
  "Good to hear from you — I'll respond soon.",
];

function randomReplyBody() {
  return REPLY_TEMPLATES[Math.floor(Math.random() * REPLY_TEMPLATES.length)];
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function domainSlug(domain) {
  return domain.replace(/[\.\-]/g, '_').toUpperCase();
}

function nowIST() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: config.timezone || 'Asia/Kolkata' }));
}

function isInWindow() {
  const h = nowIST().getHours();
  return WINDOW_START > WINDOW_END
    ? (h >= WINDOW_START || h < WINDOW_END)
    : (h >= WINDOW_START && h < WINDOW_END);
}

function SKIP_RATE() { return 0.12; }

function senderSkipsToday(sender) {
  if (DRAIN_MODE) return false;
  const seed = `${sender}::${new Date().toISOString().slice(0, 10)}`;
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (Math.imul(31, hash) + seed.charCodeAt(i)) | 0;
  }
  const normalized = (hash >>> 0) / 4294967296;
  return normalized < SKIP_RATE();
}

// ─── Pending replies table ────────────────────────────────────────────────────

function ensurePendingRepliesTable() {
  db.getDb().prepare(`
    CREATE TABLE IF NOT EXISTS pending_replies (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      from_email  TEXT NOT NULL,
      to_email    TEXT NOT NULL,
      subject     TEXT NOT NULL,
      in_reply_to TEXT NOT NULL,
      reply_due   TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'pending',
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `).run();
  db.getDb().prepare(`
    CREATE INDEX IF NOT EXISTS idx_pending_replies_due
    ON pending_replies(reply_due, status)
  `).run();
}

function savePendingReply({ fromEmail, toEmail, subject, inReplyTo, replyDue }) {
  ensurePendingRepliesTable();
  db.getDb().prepare(`
    INSERT INTO pending_replies (from_email, to_email, subject, in_reply_to, reply_due)
    VALUES (?, ?, ?, ?, ?)
  `).run(fromEmail, toEmail, subject, inReplyTo, replyDue);
}

function getDueReplies() {
  ensurePendingRepliesTable();
  return db.getDb().prepare(`
    SELECT * FROM pending_replies
    WHERE status = 'pending'
      AND reply_due <= datetime('now')
    ORDER BY reply_due ASC
    LIMIT 10
  `).all();
}

function markReplyDone(id, status = 'sent') {
  ensurePendingRepliesTable();
  db.getDb().prepare(`
    UPDATE pending_replies SET status = ? WHERE id = ?
  `).run(status, id);
}

// ─── SMTP transporter ─────────────────────────────────────────────────────────

let _transporter = null;
function getTransporter() {
  if (_transporter) return _transporter;
  _transporter = nodemailer.createTransport({
    host: process.env.SENDER_SMTP_HOST || 'smtp.sender.net',
    port: parseInt(process.env.SENDER_SMTP_PORT || '587', 10),
    secure: false,
    auth: {
      user: process.env.SENDER_SMTP_LOGIN,
      pass: process.env.SENDER_SMTP_KEY,
    },
  });
  return _transporter;
}

async function sendReply({ from, to, subject, inReplyTo }) {
  const replySubject = subject.startsWith('Re:') ? subject : `Re: ${subject}`;
  const body = randomReplyBody();
  try {
    await getTransporter().sendMail({
      from,
      to,
      subject: replySubject,
      text: body,
      headers: {
        'In-Reply-To': inReplyTo,
        'References': inReplyTo,
        'X-Warmup': 'true',
      },
    });
    logger.info(`[engager] Replied: ${from} → ${to} | "${replySubject}"`);
    return true;
  } catch (err) {
    logger.error(`[engager] Reply failed ${from} → ${to}: ${err.message}`);
    return false;
  }
}

async function processDueReplies() {
  if (!isInWindow() && !DRAIN_MODE) return;
  const due = getDueReplies();
  if (due.length === 0) return;
  logger.info(`[engager] Processing ${due.length} deferred reply(s)`);
  const shuffled = shuffle(due);
  for (let i = 0; i < shuffled.length; i++) {
    const r = shuffled[i];
    const ok = await sendReply({
      from: r.from_email,
      to: r.to_email,
      subject: r.subject,
      inReplyTo: r.in_reply_to,
    });
    markReplyDone(r.id, ok ? 'sent' : 'failed');
    if (i < shuffled.length - 1) {
      const gap = randomBetween(60, 480) * 1000;
      await sleep(gap);
    }
  }
}

function getAllWarmupSenders() {
  const senders = [];
  for (const domainEntry of config.domainRing) {
    for (const sender of domainEntry.senders) {
      senders.push(sender.toLowerCase());
    }
  }
  return senders;
}

// ─── IMAP Credentials (Rotated Daily) ────────────────────────────────────────

function getImapCredentialsForDomain(domainEntry) {
  const slug = domainSlug(domainEntry.domain);
  const password = process.env[`IMAP_PASSWORD_${slug}`];
  const userOverride = process.env[`IMAP_USER_${slug}`];
  const user = userOverride || domainEntry.senders[0];
  return { user, password };
}

function getRotatedImapCredentials() {
  const dayOfYear = Math.floor(
    (new Date() - new Date(new Date().getFullYear(), 0, 0)) /
    (1000 * 60 * 60 * 24)
  );
  const index = dayOfYear % config.domainRing.length;
  const domainEntry = config.domainRing[index];
  const creds = getImapCredentialsForDomain(domainEntry);
  logger.info(`[engager] Today's IMAP auth: ${domainEntry.domain} as ${creds.user}`);
  return creds;
}

// ─── Process Single Email with Inbox Behavior ────────────────────────────────

async function processUid(client, uid, allSenders) {
  try {
    let msg = null;
    for await (const m of client.fetch(
      `${uid}:${uid}`,
      { envelope: true, flags: true, headers: ['x-warmup'] },
      { uid: true }
    )) {
      if (m.uid === uid) { msg = m; break; }
    }

    if (!msg || !msg.envelope) {
      logger.debug(`[engager] Skipping uid ${uid} — envelope missing`);
      return;
    }

    const headers = msg.headers ? msg.headers.toString() : '';
    if (!headers.toLowerCase().includes('x-warmup')) {
      logger.debug(`[engager] Skipping uid ${uid} — not a warm-up email`);
      return;
    }

    const toAddr = msg.envelope?.to?.[0];
    const toEmail = (toAddr?.address || '').toLowerCase();
    if (!toEmail || !allSenders.includes(toEmail)) {
      logger.debug(`[engager] Skipping uid ${uid} — TO: ${toEmail} not in warm-up list`);
      return;
    }

    const fromAddr = msg.envelope?.from?.[0];
    const fromEmail = (fromAddr?.address || '').toLowerCase();
    if (!fromEmail || !allSenders.includes(fromEmail)) {
      logger.debug(`[engager] Skipping uid ${uid} — FROM: ${fromEmail} not in warm-up list`);
      return;
    }

    const msgId = msg.envelope?.messageId || `<uid-${uid}@warmup>`;

    // ─── Inbox Behavior from Config ────────────────────────────────────
    const inboxBehavior = config.inboxBehavior || {};
    const deleteUnreadRate = inboxBehavior.deleteUnreadRate ?? 0.05;
    const skipRate = inboxBehavior.skipRate ?? 0.10;
    const readLaterChance = inboxBehavior.readLaterChance ?? 0.20;
    const behaviorRoll = Math.random();

    // Delete unread
    if (behaviorRoll < deleteUnreadRate) {
      try {
        await client.messageMove(uid, '[Gmail]/Trash', { uid: true });
        logger.info(`[engager] Deleted unread: uid ${uid}`);
        db.logDeletion({ messageId: msgId, sender: fromEmail, receiver: toEmail, action: 'deleted_unread', reason: 'inbox behavior' });
      } catch (_) {}
      return;
    }

    // Skip entirely (leave unread)
    if (behaviorRoll < deleteUnreadRate + skipRate) {
      logger.debug(`[engager] Skipping uid ${uid} — left unread`);
      return;
    }

    // Read later: extra delay
    if (Math.random() < readLaterChance) {
      const laterDelay = randomBetween(
        (inboxBehavior.readLaterDelayHours?.min || 3) * 3600,
        (inboxBehavior.readLaterDelayHours?.max || 24) * 3600
      );
      logger.debug(`[engager] Read later — delaying ${Math.round(laterDelay / 3600)}h for uid ${uid}`);
      await sleep(laterDelay * 1000);
    }

    // Human read delay
    const baseReadSec = randomBetween(TIMING.readDelayMin, TIMING.readDelayMax);
    const jitterReadSec = DRAIN_MODE ? 0 : randomBetween(0, 180);
    const readSec = baseReadSec + jitterReadSec;
    const readMinutes = Math.floor(readSec / 60);
    const readHours = Math.floor(readMinutes / 60);
    if (readHours > 0) {
      logger.debug(`[engager] Waiting ${readHours}h ${readMinutes % 60}min to read uid ${uid}`);
    } else {
      logger.debug(`[engager] Waiting ${readMinutes}min to read uid ${uid}`);
    }
    await sleep(readSec * 1000);

    // Mark as read
    await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
    logger.info(`[engager] Marked read: ${toEmail} <- uid ${uid}`);

    db.logDeletion({
      messageId: msgId,
      sender: fromEmail,
      receiver: toEmail,
      action: 'marked_read',
      reason: 'engager read'
    });

    // Schedule deferred reply
    const subject = msg.envelope?.subject || '';
    if (Math.random() < REPLY_RATE && !subject.startsWith('Re:')) {
      const replyDelaySec = randomBetween(TIMING.replyDelayMin, TIMING.replyDelayMax);
      const jitterFactor = 0.85 + Math.random() * 0.3;
      const finalDelaySec = Math.round(replyDelaySec * jitterFactor);
      const replyDue = new Date(Date.now() + finalDelaySec * 1000)
        .toISOString().replace('T', ' ').slice(0, 19);
      savePendingReply({ fromEmail: toEmail, toEmail: fromEmail, subject, inReplyTo: msgId, replyDue });
      const hrs = Math.round(finalDelaySec / 3600 * 10) / 10;
      if (hrs >= 1) {
        logger.info(`[engager] Reply queued in ${hrs}h: ${toEmail} → ${fromEmail}`);
      } else {
        const mins = Math.round(finalDelaySec / 60);
        logger.info(`[engager] Reply queued in ${mins}min: ${toEmail} → ${fromEmail}`);
      }
    } else {
      logger.debug(`[engager] No reply queued for uid ${uid}`);
    }

    // Human trash delay
    const baseTrashSec = randomBetween(TIMING.trashDelayMin, TIMING.trashDelayMax);
    const jitterTrashSec = DRAIN_MODE ? 0 : randomBetween(0, 180);
    const trashSec = baseTrashSec + jitterTrashSec;
    const trashMinutes = Math.floor(trashSec / 60);
    const trashHours = Math.floor(trashMinutes / 60);
    if (trashHours > 0) {
      logger.debug(`[engager] Will keep for ${trashHours}h ${trashMinutes % 60}min before trashing uid ${uid}`);
    } else {
      logger.debug(`[engager] Will keep for ${trashMinutes}min before trashing uid ${uid}`);
    }
    await sleep(trashSec * 1000);

    // Move to trash
    try {
      await client.messageMove(uid, '[Gmail]/Trash', { uid: true });
      logger.info(`[engager] Moved to Trash: uid ${uid}`);
      db.logDeletion({
        messageId: msgId,
        sender: fromEmail,
        receiver: toEmail,
        action: 'moved_trash',
        reason: 'engager trash'
      });
      db.markEmailDeletedByMessageId(msgId, 'deleted');
    } catch (trashErr) {
      logger.warn(`[engager] Could not move uid ${uid} to Trash: ${trashErr.message}`);
      db.logDeletion({
        messageId: msgId,
        sender: fromEmail,
        receiver: toEmail,
        action: 'trash_failed',
        reason: trashErr.message
      });
    }

  } catch (msgErr) {
    logger.error(`[engager] Error processing uid ${uid}: ${msgErr.message}`);
  }
}

async function runEngager() {
  logger.info('[engager] Starting engagement run');
  await processDueReplies();

  if (!DRAIN_MODE && !isInWindow()) {
    logger.info(`[engager] Outside send window (${WINDOW_START}:00–${WINDOW_END}:00) — skipping inbox scan`);
    return;
  }

  const { user, password } = getRotatedImapCredentials();
  if (!password) {
    logger.warn('[engager] No IMAP password found — skipping engagement run');
    return;
  }

  const allSenders = shuffle(getAllWarmupSenders());
  logger.info(`[engager] Tracking ${allSenders.length} warm-up addresses across ${config.domainRing.length} domains (order shuffled)`);

  const activeSenders = allSenders.filter(s => {
    const skip = senderSkipsToday(s);
    if (skip) logger.debug(`[engager] ${s} sitting out today (skip-day)`);
    return !skip;
  });
  logger.info(`[engager] ${activeSenders.length}/${allSenders.length} senders active today`);

  let batch = [];
  const fetchClient = new ImapFlow({
    host: IMAP_HOST, port: IMAP_PORT, secure: true,
    auth: { user, pass: password }, logger: false,
  });

  try {
    await fetchClient.connect();
    logger.info(`[engager] Connected to IMAP as ${user}`);

    const lock = await fetchClient.getMailboxLock('INBOX');
    try {
      const lastUid = parseInt(db.getSetting('engager_last_uid') || '0', 10);
      const uidFilter = lastUid > 0 ? { uid: String(lastUid + 1) + ':*' } : {};
      if (lastUid > 0) logger.info(`[engager] Searching from UID ${lastUid + 1} onwards`);

      let uids = [];
      for (const sender of activeSenders) {
        try {
          const found = await fetchClient.search(
            { seen: false, to: sender, ...uidFilter },
            { uid: true }
          );
          if (found && found.length > 0) uids.push(...found);
        } catch (_) {}
      }

      uids = [...new Set(uids)].sort((a, b) => a - b);

      if (uids.length === 0) {
        logger.info('[engager] No unread warm-up emails found');
        return;
      }

      const MAX_PER_RUN = DRAIN_MODE ? 30 : randomBetween(2, 8);
      batch = shuffle(uids).slice(0, MAX_PER_RUN);
      logger.info(`[engager] Found ${uids.length} unread warm-up email(s) — processing ${batch.length} this run (shuffled)`);

    } finally {
      lock.release();
    }
  } catch (err) {
    logger.error(`[engager] IMAP error (UID fetch): ${err.message}`);
    return;
  } finally {
    try { await fetchClient.logout(); } catch (_) {}
  }

  let processedCount = 0;
  for (const uid of batch) {
    const perClient = new ImapFlow({
      host: IMAP_HOST, port: IMAP_PORT, secure: true,
      auth: { user, pass: password }, logger: false,
    });
    try {
      await perClient.connect();
      const perLock = await perClient.getMailboxLock('INBOX');
      try {
        await processUid(perClient, uid, allSenders);
        processedCount++;
        db.setSetting('engager_last_uid', uid);
        logger.info(`[engager] Progress: ${processedCount}/${batch.length} emails processed this run`);
      } finally {
        perLock.release();
      }
    } catch (err) {
      logger.error(`[engager] IMAP error processing uid ${uid}: ${err.message}`);
    } finally {
      try { await Promise.race([perClient.logout(), new Promise(r => setTimeout(r, 3000))]); } catch (_) {}
    }

    if (processedCount < batch.length) {
      const basePause = randomBetween(TIMING.betweenEmailMin, TIMING.betweenEmailMax);
      const extraPause = (!DRAIN_MODE && Math.random() < 0.20)
        ? randomBetween(5 * 60, 20 * 60)
        : 0;
      const totalPause = (basePause + extraPause) * 1000;
      const pauseMinutes = Math.round(totalPause / 60000);
      if (extraPause > 0) {
        logger.debug(`[engager] Taking a longer pause of ${pauseMinutes}min (distraction)`);
      } else {
        logger.debug(`[engager] Pausing ${pauseMinutes}min before next email`);
      }
      await sleep(totalPause);
    }
  }

  logger.info('[engager] Engagement run complete');
}

function scheduleNextEngagerRun() {
  const inWin = isInWindow();
  const delayMin = inWin ? randomBetween(15, 45) : randomBetween(60, 120);
  const delayMs = delayMin * 60 * 1000;
  logger.info(`[engager] Next engagement run in ${delayMin} minutes`);

  setTimeout(async () => {
    try { await runEngager(); } catch (err) {
      logger.error(`[engager] Run error: ${err.message}`);
    }
    scheduleNextEngagerRun();
  }, delayMs);
}

function startEngagerCron() {
  const startDelayMin = randomBetween(5, 15);
  const startDelay = startDelayMin * 60 * 1000;
  logger.info(`[engager] First engagement run in ${startDelayMin} minutes`);

  setTimeout(async () => {
    try { await runEngager(); } catch (err) {
      logger.error(`[engager] Startup error: ${err.message}`);
    }
    scheduleNextEngagerRun();
  }, startDelay);

  logger.info('[engager] Randomized engagement scheduler started');
}

module.exports = { startEngagerCron, runEngager };
