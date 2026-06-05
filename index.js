'use strict';

require('dotenv').config();
const cron = require('node-cron');
const logger = require('./logger');
const db = require('./db');
const { verifySmtp, sendEmail, closeTransporter } = require('./mailer');
const { generateEmail } = require('./generator');
const { startCleanupCron } = require('./cleanup');
const config = require('./config.json');

// ─── Timezone-aware helpers ────────────────────────────────────────────────────

const TZ = config.timezone || 'America/New_York';

function nowInTz() {
  // Returns a Date-like object adjusted to the configured timezone
  return new Date(new Date().toLocaleString('en-US', { timeZone: TZ }));
}

function isWeekday() {
  const d = nowInTz();
  const day = d.getDay(); // 0 = Sun, 6 = Sat
  return day >= 1 && day <= 5;
}

function isInSendWindow() {
  const d = nowInTz();
  const h = d.getHours();
  const { startHour, endHour } = config.sendWindow;
  return h >= startHour && h < endHour;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ─── Ramp schedule ────────────────────────────────────────────────────────────

function getEmailsPerDay(rampDay) {
  const schedule = config.rampSchedule;
  for (const entry of schedule) {
    if (rampDay >= entry.dayFrom && rampDay <= entry.dayTo) {
      return entry.emailsPerDay;
    }
  }
  return 8; // fallback maintenance
}

// ─── Build domain ring map ────────────────────────────────────────────────────

function buildRingMap() {
  const ring = config.domainRing;
  const map = {};
  for (let i = 0; i < ring.length; i++) {
    const current = ring[i];
    const nextIdx = (i + 1) % ring.length;
    const next = ring[nextIdx];
    map[current.domain] = {
      ...current,
      receiverDomain: next.domain,
      receiverSenders: next.senders,
      receiverNiche: next.niche,
    };
  }
  return map;
}

const ringMap = buildRingMap();

// ─── Queue population ─────────────────────────────────────────────────────────

function buildDayQueue() {
  if (!isWeekday()) {
    logger.info('[queue] Skipping queue build — not a weekday in configured timezone');
    return;
  }

  const { startHour, endHour } = config.sendWindow;
  const windowMinutes = (endHour - startHour) * 60;
  const todayStr = todayLocalISO();

  const items = [];

  for (const domainEntry of config.domainRing) {
    const stat = db.getDomainStat(domainEntry.domain);
    if (!stat) continue;

    const rampDay = db.getRampDay(stat.start_date);
    const targetCount = getEmailsPerDay(rampDay);

    if (db.hasTodayQueue(domainEntry.domain)) {
      logger.debug(`[queue] Already queued for ${domainEntry.domain} today`);
      continue;
    }

    const ring = ringMap[domainEntry.domain];
    if (!ring) continue;

    // Spread sends evenly across the window with random jitter
    const intervalMinutes = Math.floor(windowMinutes / targetCount);

    for (let i = 0; i < targetCount; i++) {
      const baseMinute = startHour * 60 + i * intervalMinutes;
      const jitter = randomBetween(
        config.minDelayMinutes || 25,
        config.maxDelayMinutes || 75
      );
      const actualMinute = Math.min(baseMinute + (jitter % intervalMinutes), endHour * 60 - 1);
      const hh = Math.floor(actualMinute / 60);
      const mm = actualMinute % 60;

      // Pick a random sender from this domain
      const sender = domainEntry.senders[Math.floor(Math.random() * domainEntry.senders.length)];
      // Pick a random receiver from the next domain
      const receiver = ring.receiverSenders[Math.floor(Math.random() * ring.receiverSenders.length)];

      const scheduledAt = `${todayStr}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`;

      items.push({
        sender,
        receiver,
        sender_domain: domainEntry.domain,
        scheduled_at: scheduledAt,
      });
    }

    logger.info(`[queue] Queued ${targetCount} emails for ${domainEntry.domain} (ramp day ${rampDay})`);
  }

  if (items.length > 0) {
    db.enqueueItems(items);
    logger.info(`[queue] Total ${items.length} emails queued for today`);
  }
}

function todayLocalISO() {
  const d = nowInTz();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ─── Send loop ────────────────────────────────────────────────────────────────

let isSending = false;

async function processDueItems() {
  if (isSending) return;
  if (!isWeekday()) return;
  if (!isInSendWindow()) return;

  const pending = db.getPendingQueueItems();
  const now = new Date();

  const due = pending.filter(item => {
    const scheduledAt = new Date(item.scheduled_at);
    return scheduledAt <= now;
  });

  if (due.length === 0) return;

  isSending = true;
  try {
    for (const item of due) {
      if (!isWeekday() || !isInSendWindow()) {
        logger.info('[send] Send window or weekday check failed — pausing batch');
        break;
      }

      const senderDomainEntry = config.domainRing.find(d => d.domain === item.sender_domain);
      const ring = ringMap[item.sender_domain];
      if (!senderDomainEntry || !ring) {
        db.markQueueItemSkipped(item.id);
        continue;
      }

      const stat = db.getDomainStat(item.sender_domain);
      if (!stat) {
        db.markQueueItemSkipped(item.id);
        continue;
      }

      const rampDay = db.getRampDay(stat.start_date);
      const targetCount = getEmailsPerDay(rampDay);

      if (stat.emails_today >= targetCount) {
        logger.debug(`[send] ${item.sender_domain} already hit today's limit (${stat.emails_today}/${targetCount})`);
        db.markQueueItemSkipped(item.id);
        continue;
      }

      try {
        logger.info(`[send] Generating email: ${item.sender} → ${item.receiver}`);

        const { subject, body } = await generateEmail({
          senderEmail: item.sender,
          receiverEmail: item.receiver,
          senderNiche: senderDomainEntry.niche,
          receiverNiche: ring.receiverNiche,
        });

        const messageId = await sendEmail({
          from: item.sender,
          to: item.receiver,
          subject,
          body,
        });

        db.logSentEmail({
          messageId,
          sender: item.sender,
          receiver: item.receiver,
          senderDomain: item.sender_domain,
          receiverDomain: ring.receiverDomain,
          subject,
        });

        db.markQueueItemSent(item.id);
        db.incrementDomainSentToday(item.sender_domain);

        // Random pause between sends
        const { min, max } = config.betweenSendPauseSeconds || { min: 3, max: 8 };
        const pause = randomBetween(min, max) * 1000;
        logger.debug(`[send] Pausing ${pause / 1000}s before next send`);
        await sleep(pause);

      } catch (err) {
        logger.error(`[send] Failed sending ${item.sender} → ${item.receiver}: ${err.message}`);
        db.markQueueItemSkipped(item.id);
      }
    }
  } finally {
    isSending = false;
  }
}

// ─── Midnight queue refresh ───────────────────────────────────────────────────

function scheduleMidnightRefresh() {
  cron.schedule('1 0 * * *', () => {
    logger.info('[cron] Midnight: resetting daily counters and refreshing queue');
    db.resetDailyCounters();
    db.clearTodayQueue();

    // Small delay then rebuild
    setTimeout(() => {
      if (isWeekday()) buildDayQueue();
    }, 5000);
  }, { timezone: TZ });

  logger.info('[cron] Midnight queue refresh scheduled');
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────

function gracefulShutdown(signal) {
  logger.info(`[agent] Received ${signal} — shutting down gracefully`);
  closeTransporter();
  db.closeDb();
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  logger.error(`[agent] uncaughtException: ${err.message}`, err.stack);
  closeTransporter();
  db.closeDb();
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error(`[agent] unhandledRejection: ${reason}`);
});

// ─── Boot sequence ────────────────────────────────────────────────────────────

async function boot() {
  logger.info('═══════════════════════════════════════════════════');
  logger.info(' Warmup Agent starting up');
  logger.info(`  Timezone : ${TZ}`);
  logger.info(`  Send window: ${config.sendWindow.startHour}:00–${config.sendWindow.endHour}:00 (weekdays only)`);
  logger.info('═══════════════════════════════════════════════════');

  // Verify SMTP credentials before doing anything
  const smtpOk = await verifySmtp();
  if (!smtpOk) {
    logger.error('[agent] SMTP verification failed — cannot start. Check BREVO credentials in .env');
    process.exit(1);
  }

  // Initialize DB and domain stats
  db.getDb();
  const domains = config.domainRing.map(d => d.domain);
  db.initDomainStats(domains);
  logger.info(`[agent] Initialized domain stats for ${domains.length} domains`);

  // Build today's queue if weekday
  if (isWeekday()) {
    buildDayQueue();
  } else {
    logger.info('[agent] Not a weekday — skipping initial queue build');
  }

  // Schedule midnight refresh
  scheduleMidnightRefresh();

  // Start cleanup cron (3am nightly + 5min startup)
  startCleanupCron();

  // Main 60-second tick
  logger.info('[agent] Starting main 60s tick loop');
  setInterval(async () => {
    try {
      await processDueItems();
    } catch (err) {
      logger.error(`[agent] Tick error: ${err.message}`);
    }
  }, 60 * 1000);

  // Also fire once immediately in case we're mid-window on startup
  setTimeout(async () => {
    try { await processDueItems(); } catch (err) {
      logger.error(`[agent] Initial tick error: ${err.message}`);
    }
  }, 3000);

  logger.info('[agent] Boot complete — agent is running');
}

boot().catch(err => {
  logger.error(`[agent] Boot failed: ${err.message}`);
  process.exit(1);
});
