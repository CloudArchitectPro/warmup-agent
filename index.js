'use strict';

require('dotenv').config();
const logger = require('./logger');
const db = require('./db');
const { verifySmtp, sendEmail, closeTransporter } = require('./mailer');
const { generateEmail } = require('./generator');
const { startCleanupCron } = require('./cleanup');
const { startEngagerCron } = require('./engager');
const config = require('./config.json');

const TZ = config.timezone || 'Asia/Kolkata';

const healthState = {
  lastSendTime: null,
  lastEngagerRun: null,
  lastCleanupRun: null,
  errors24h: 0,
  startTime: new Date().toISOString()
};

function nowInTz() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: TZ }));
}

function isWeekday() {
  const d = nowInTz();
  const day = d.getDay();
  return day >= 1 && day <= 5;
}

// ─── Send Window with Daily Jitter ─────────────────────────────────────────

let _windowJitter = null;

function isInSendWindow() {
  const d = nowInTz();
  const h = d.getHours();
  const m = d.getMinutes();
  const { startHour, endHour, startJitterMinutes, endJitterMinutes } = config.sendWindow;

  const today = d.toISOString().slice(0, 10);
  if (!_windowJitter || _windowJitter.date !== today) {
    const sj = startJitterMinutes ? randomBetween(-startJitterMinutes, startJitterMinutes) : 0;
    const ej = endJitterMinutes ? randomBetween(-endJitterMinutes, endJitterMinutes) : 0;
    _windowJitter = { date: today, startOffset: sj, endOffset: ej };
  }

  const effectiveStart = startHour * 60 + (_windowJitter.startOffset || 0);
  const effectiveEnd = endHour * 60 + (_windowJitter.endOffset || 0);
  const nowMinutes = h * 60 + m;

  return startHour > endHour
    ? (nowMinutes >= effectiveStart || nowMinutes < effectiveEnd)
    : (nowMinutes >= effectiveStart && nowMinutes < effectiveEnd);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ─── Human Pause with Coffee Breaks & Time Volume Curve ────────────────────

function humanPauseSec() {
  // Coffee break: occasionally take a very long pause
  if (config.coffeeBreak && config.coffeeBreak.enabled) {
    const hourlyChance = config.coffeeBreak.chancePerHour || 0.12;
    if (Math.random() < hourlyChance) {
      const coffeeSec = randomBetween(
        (config.coffeeBreak.durationMinutes?.min || 15) * 60,
        (config.coffeeBreak.durationMinutes?.max || 60) * 60
      );
      logger.debug(`[send] ☕ Coffee break — pausing ${Math.round(coffeeSec / 60)}min`);
      return coffeeSec;
    }
  }

  // Time volume curve: longer pauses during low-activity hours
  if (config.timeVolumeCurve && config.timeVolumeCurve.enabled) {
    const h = nowInTz().getHours();
    let activityLevel = 0.5;
    if (h >= 19 && h < 21) activityLevel = 1.0;
    else if (h >= 21 && h < 23) activityLevel = 0.8;
    else if (h >= 23 || h < 1) activityLevel = 0.5;
    else if (h >= 1 && h < 3) activityLevel = 0.3;
    else if (h >= 3 && h < 5) activityLevel = 0.2;
    else if (h >= 5 && h < 7) activityLevel = 0.4;

    if (activityLevel < 0.5 && Math.random() > activityLevel * 2) {
      return randomBetween(2700, 7200);
    }
  }

  const r = Math.random();
  if (r < 0.20) return randomBetween(60, 180);
  if (r < 0.50) return randomBetween(180, 480);
  if (r < 0.75) return randomBetween(480, 1200);
  if (r < 0.90) return randomBetween(1200, 2700);
  return randomBetween(2700, 7200);
}

// ─── Ramp Schedule with Weekend Multiplier ────────────────────────────────

function getEmailsPerDay(rampDay) {
  const schedule = config.rampSchedule;
  for (const entry of schedule) {
    if (rampDay >= entry.dayFrom && rampDay <= entry.dayTo) {
      let min, max;
      if (entry.minEmails !== undefined && entry.maxEmails !== undefined) {
        min = entry.minEmails;
        max = entry.maxEmails;
      } else {
        min = max = (entry.emailsPerDay || 8);
      }

      const dow = nowInTz().getDay();
      const wm = config.weekendMultiplier;
      if (wm) {
        if (dow === 0 && wm.sunday) {
          const factor = randomBetween(Math.round(wm.sunday.min * 100), Math.round(wm.sunday.max * 100)) / 100;
          min = Math.max(1, Math.round(min * factor));
          max = Math.max(1, Math.round(max * factor));
        } else if (dow === 6 && wm.saturday) {
          const factor = randomBetween(Math.round(wm.saturday.min * 100), Math.round(wm.saturday.max * 100)) / 100;
          min = Math.max(1, Math.round(min * factor));
          max = Math.max(1, Math.round(max * factor));
        }
      }

      const count = randomBetween(min, max);
      const dayName = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dow];
      logger.debug(`[queue] Ramp day ${rampDay} (${dayName}): ${count} emails (range ${min}–${max})`);
      return count;
    }
  }
  return randomBetween(3, 6);
}

function buildSenderList() {
  const ring = config.domainRing;
  const senders = [];
  for (let i = 0; i < ring.length; i++) {
    const currentDomain = ring[i];
    const nextDomain = ring[(i + 1) % ring.length];
    for (const senderEmail of currentDomain.senders) {
      senders.push({
        sender: senderEmail,
        senderDomain: currentDomain.domain,
        senderNiche: currentDomain.niche,
        receiverDomain: nextDomain.domain,
        receiverSenders: nextDomain.senders,
        receiverNiche: nextDomain.niche,
      });
    }
  }
  return senders;
}

const senderList = buildSenderList();

function buildDayQueue() {
  if (config.weekdaysOnly && !isWeekday()) {
    logger.info('[queue] Skipping queue build — not a weekday in configured timezone');
    return;
  }

  const { startHour, endHour } = config.sendWindow;
  const todayStr = todayLocalISO();
  const items = [];

  function humanRandomMinutes(count) {
    if (count === 0) return [];
    const peakHours = [9, 10, 11, 14, 15, 16];
    const lowHours = [12, 13, 20, 21, 22, 23];
    const normalHours = [8, 17, 18, 19];
    const picks = [];
    let attempts = 0;

    while (picks.length < count && attempts < 1000) {
      attempts++;
      let hour;
      const hourRand = Math.random();
      if (hourRand < 0.55) {
        hour = peakHours[Math.floor(Math.random() * peakHours.length)];
      } else if (hourRand < 0.75) {
        hour = normalHours[Math.floor(Math.random() * normalHours.length)];
      } else {
        hour = lowHours[Math.floor(Math.random() * lowHours.length)];
      }

      const minute = Math.floor(Math.random() * 60);
      const totalMinute = hour * 60 + minute;
      let adjustedMinute = totalMinute;
      if (startHour > endHour) {
        if (totalMinute < endHour * 60) adjustedMinute = totalMinute + 24 * 60;
      }

      if (adjustedMinute >= startHour * 60 && adjustedMinute <= (endHour > startHour ? endHour * 60 : 24 * 60 + endHour * 60)) {
        const tooClose = picks.some(p => Math.abs(p - adjustedMinute) < 2);
        if (!tooClose) picks.push(adjustedMinute);
      }
    }

    return picks.sort((a, b) => a - b).map(m => (m >= 24 * 60 ? m - 24 * 60 : m));
  }

  for (const entry of senderList) {
    if (db.hasTodaySenderQueue(entry.sender)) {
      logger.debug(`[queue] Already queued for ${entry.sender} today`);
      continue;
    }

    const stat = db.getSenderStat(entry.sender);
    if (!stat) continue;

    const rampDay = db.getRampDay(stat.start_date);
    let targetCount = getEmailsPerDay(rampDay);
    const variation = randomBetween(80, 120) / 100;
    targetCount = Math.max(1, Math.round(targetCount * variation));
    const offsets = humanRandomMinutes(targetCount);

    for (let i = 0; i < targetCount && i < offsets.length; i++) {
      const totalMinute = (startHour * 60 + offsets[i]) % (24 * 60);
      const hh = Math.floor(totalMinute / 60);
      const mm = totalMinute % 60;

      const receiver = entry.receiverSenders[Math.floor(Math.random() * entry.receiverSenders.length)];

      const dayOffset = (startHour * 60 + offsets[i]) >= 24 * 60 ? 1 : 0;
      let schedDate = todayStr;
      if (dayOffset) {
        const d = new Date(todayStr + 'T00:00:00');
        d.setDate(d.getDate() + 1);
        schedDate = d.toISOString().slice(0, 10);
      }

      const scheduledAt = `${schedDate}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`;

      items.push({
        sender: entry.sender,
        receiver,
        sender_domain: entry.senderDomain,
        scheduled_at: scheduledAt,
      });
    }

    logger.info(`[queue] Queued ${targetCount} emails for ${entry.sender} (ramp day ${rampDay}) — human-pattern spread`);
  }

  if (items.length > 0) {
    db.enqueueItems(items);
    logger.info(`[queue] Total ${items.length} emails queued for today across ${senderList.length} senders`);
  }
}

function todayLocalISO() {
  const d = nowInTz();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

let isSending = false;

async function processDueItems() {
  if (isSending) return;
  if (config.weekdaysOnly && !isWeekday()) return;
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
    const shuffled = [...due];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    for (let i = 0; i < shuffled.length; i++) {
      const item = shuffled[i];

      if ((config.weekdaysOnly && !isWeekday()) || !isInSendWindow()) {
        logger.info('[send] Send window or weekday check failed — pausing batch');
        break;
      }

      const senderEntry = senderList.find(s => s.sender === item.sender);
      if (!senderEntry) { db.markQueueItemSkipped(item.id); continue; }

      const stat = db.getSenderStat(item.sender);
      if (!stat) { db.markQueueItemSkipped(item.id); continue; }

      const rampDay = db.getRampDay(stat.start_date);
      let targetCount = getEmailsPerDay(rampDay);
      const variation = randomBetween(80, 120) / 100;
      targetCount = Math.max(1, Math.round(targetCount * variation));

      if (stat.emails_today >= targetCount) {
        logger.debug(`[send] ${item.sender} already hit today's limit (${stat.emails_today}/${targetCount})`);
        db.markQueueItemSkipped(item.id);
        continue;
      }

      try {
        logger.info(`[send] Generating email: ${item.sender} → ${item.receiver}`);

        const { subject, body } = await generateEmail({
          senderEmail: item.sender,
          receiverEmail: item.receiver,
          senderNiche: senderEntry.senderNiche,
          receiverNiche: senderEntry.receiverNiche,
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
          receiverDomain: senderEntry.receiverDomain,
          subject,
        });

        db.markQueueItemSent(item.id);
        db.incrementSenderSentToday(item.sender);
        healthState.lastSendTime = new Date().toISOString();

        // ─── Burst Mode Pause ──────────────────────────────────────────
        const shouldBurst = config.burstMode?.enabled &&
          Math.random() < (config.burstMode.chance || 0.15) &&
          i < shuffled.length - 1;

        let pauseSec;
        if (shouldBurst) {
          pauseSec = randomBetween(
            config.burstMode.burstPauseSeconds?.min || 20,
            config.burstMode.burstPauseSeconds?.max || 90
          );
          logger.debug(`[send] ⚡ Burst mode — next email in ${pauseSec}s`);
        } else {
          pauseSec = humanPauseSec();
          logger.debug(`[send] Pausing ${Math.round(pauseSec / 60)}m ${pauseSec % 60}s before next send`);
        }
        await sleep(pauseSec * 1000);

      } catch (err) {
        logger.error(`[send] Failed sending ${item.sender} → ${item.receiver}: ${err.message}`);
        healthState.errors24h++;
        db.markQueueItemSkipped(item.id);
      }
    }
  } finally {
    isSending = false;
  }
}

function scheduleNextMidnightRefresh() {
  const now = nowInTz();
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  midnight.setDate(midnight.getDate() + 1);

  const randomOffsetMs = randomBetween(1, 45) * 60 * 1000;
  const fireAt = new Date(midnight.getTime() + randomOffsetMs);
  const delayMs = fireAt - now;

  logger.info(`[cron] Next queue refresh scheduled at ${fireAt.toLocaleTimeString('en-US', { timeZone: TZ })} ${TZ} (${Math.round(delayMs/60000)}min from now)`);

  setTimeout(() => {
    logger.info('[cron] Midnight: resetting daily counters and refreshing queue');
    db.resetDailyCounters();
    db.clearTodayQueue();
    setTimeout(() => {
      if (!config.weekdaysOnly || isWeekday()) buildDayQueue();
    }, randomBetween(5, 15) * 1000);
    scheduleNextMidnightRefresh();
  }, delayMs);
}

function startHealthMonitor() {
  setInterval(() => {
    const now = new Date();
    const lastSend = healthState.lastSendTime ? new Date(healthState.lastSendTime) : null;
    const hoursSinceLastSend = lastSend ? (now - lastSend) / (1000 * 60 * 60) : null;
    if (isInSendWindow() && hoursSinceLastSend && hoursSinceLastSend > 2) {
      logger.warn(`[health] No emails sent in ${Math.round(hoursSinceLastSend * 10) / 10} hours during send window`);
    }
    if (healthState.errors24h > 10) {
      logger.warn(`[health] High error count in last 24h: ${healthState.errors24h}`);
    }
  }, 30 * 60 * 1000);
}

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

async function boot() {
  logger.info('═══════════════════════════════════════════════════');
  logger.info(' Warmup Agent starting up');
  logger.info(`  Timezone   : ${TZ}`);
  logger.info(`  Send window: ${config.sendWindow.startHour}:00–${config.sendWindow.endHour}:00`);
  logger.info(`  Senders    : ${senderList.length} accounts across ${config.domainRing.length} domains`);
  logger.info('═══════════════════════════════════════════════════');

  const smtpOk = await verifySmtp();
  if (!smtpOk) {
    logger.error('[agent] SMTP verification failed — cannot start. Check BREVO credentials in .env');
    process.exit(1);
  }

  db.getDb();

  const domains = config.domainRing.map(d => d.domain);
  db.initDomainStats(domains);
  logger.info(`[agent] Initialized domain stats for ${domains.length} domains`);

  const senders = senderList.map(s => ({ sender: s.sender, domain: s.senderDomain }));
  db.initSenderStats(senders);
  logger.info(`[agent] Initialized sender stats for ${senders.length} accounts`);

  const today = new Date().toISOString().slice(0, 10);
  const stale = db.getDb().prepare('SELECT COUNT(*) as cnt FROM sender_stats WHERE emails_today > 0 AND (last_sent_at IS NULL OR date(last_sent_at) < ?)').get(today);
  if (stale && stale.cnt > 0) {
    logger.info('[agent] Stale counters on boot — resetting for new day');
    db.resetDailyCounters();
  }

  if (!config.weekdaysOnly || isWeekday()) {
    if (!db.hasTodayQueue(config.domainRing[0].domain)) {
      buildDayQueue();
    } else {
      logger.info('[agent] Queue already populated — skipping rebuild');
    }
  } else {
    logger.info('[agent] Not a weekday — skipping initial queue build');
  }

  scheduleNextMidnightRefresh();
  startCleanupCron();
  startEngagerCron();
  startHealthMonitor();

  logger.info('[agent] Starting main 60s tick loop');
  setInterval(async () => {
    try { await processDueItems(); } catch (err) {
      logger.error(`[agent] Tick error: ${err.message}`);
      healthState.errors24h++;
    }
  }, 60 * 1000);

  setTimeout(async () => {
    try { await processDueItems(); } catch (err) {
      logger.error(`[agent] Initial tick error: ${err.message}`);
      healthState.errors24h++;
    }
  }, 3000);

  logger.info('[agent] Boot complete — agent is running');
}

boot().catch(err => {
  logger.error(`[agent] Boot failed: ${err.message}`);
  process.exit(1);
});
