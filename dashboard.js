'use strict';

require('dotenv').config();
const http = require('http');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'warmup.db');
const PORT = process.env.DASHBOARD_PORT || 3000;
const config = require('./config.json');

function getDb() {
  const db = new Database(DB_PATH, { readonly: true });
  db.pragma('journal_mode = WAL');
  return db;
}

function getData() {
  const db = getDb();
  try {
    let senderRows = [];
    try {
      senderRows = db.prepare('SELECT * FROM sender_stats ORDER BY domain, sender').all();
    } catch(e) {}

    const domains = db.prepare('SELECT * FROM domain_stats ORDER BY domain').all();
    const recentEmails = db.prepare(
      'SELECT sender, receiver, subject, sent_at, status FROM sent_emails ORDER BY sent_at DESC LIMIT 50'
    ).all();
    const totalSent = db.prepare('SELECT COUNT(*) as cnt FROM sent_emails').get();
    const totalReplied = db.prepare(
      "SELECT COUNT(*) as cnt FROM deletion_log WHERE action = 'kept_reply'"
    ).get();
    const totalDeleted = db.prepare(
      "SELECT COUNT(*) as cnt FROM deletion_log WHERE action IN ('hard_deleted','moved_trash')"
    ).get();
    const totalRead = db.prepare(
      "SELECT COUNT(*) as cnt FROM deletion_log WHERE action = 'marked_read'"
    ).get();
    const totalDeletedUnread = db.prepare(
      "SELECT COUNT(*) as cnt FROM deletion_log WHERE action = 'deleted_unread'"
    ).get();

    const todaySent = db.prepare(
      "SELECT COUNT(*) as cnt FROM sent_emails WHERE date(sent_at, '+5 hours', '30 minutes') = date('now', '+5 hours', '30 minutes')"
    ).get();
    const deletionLog = db.prepare('SELECT * FROM deletion_log ORDER BY logged_at DESC LIMIT 30').all();
    const queueToday = db.prepare(
      "SELECT COUNT(*) as cnt FROM send_queue WHERE date(scheduled_at, '+5 hours', '30 minutes') = date('now', '+5 hours', '30 minutes') AND status = 'pending'"
    ).get();
    const queueTotal = db.prepare(
      "SELECT COUNT(*) as cnt FROM send_queue WHERE status = 'pending'"
    ).get();

    const readToday = db.prepare(
      "SELECT COUNT(*) as cnt FROM deletion_log WHERE action = 'marked_read' AND date(logged_at, '+5 hours', '30 minutes') = date('now', '+5 hours', '30 minutes')"
    ).get();

    const deletedToday = db.prepare(
      "SELECT COUNT(*) as cnt FROM deletion_log WHERE action IN ('hard_deleted','moved_trash') AND date(logged_at, '+5 hours', '30 minutes') = date('now', '+5 hours', '30 minutes')"
    ).get();

    const repliedToday = db.prepare(
      "SELECT COUNT(*) as cnt FROM deletion_log WHERE action = 'kept_reply' AND date(logged_at, '+5 hours', '30 minutes') = date('now', '+5 hours', '30 minutes')"
    ).get();

    const sevenDayVolume = db.prepare(
      "SELECT date(sent_at, '+5 hours', '30 minutes') as day, COUNT(*) as cnt FROM sent_emails WHERE date(sent_at, '+5 hours', '30 minutes') >= date('now', '+5 hours', '30 minutes', '-6 days') GROUP BY date(sent_at, '+5 hours', '30 minutes') ORDER BY day ASC"
    ).all();

    const domainSummary = db.prepare(
      "SELECT d.domain, COUNT(s.sender) as senders, SUM(s.total_sent) as total_sent, SUM(s.emails_today) as today_sent FROM sender_stats s JOIN domain_stats d ON s.domain = d.domain GROUP BY d.domain ORDER BY d.domain"
    ).all();

    const hourlyActivity = db.prepare(
      "SELECT CAST(strftime('%H', sent_at, '+5 hours', '30 minutes') AS INTEGER) as hour, COUNT(*) as cnt FROM sent_emails WHERE date(sent_at, '+5 hours', '30 minutes') = date('now', '+5 hours', '30 minutes') GROUP BY hour ORDER BY hour"
    ).all();

    return {
      senderRows, domains, recentEmails,
      totalSent, totalReplied, totalDeleted, totalRead, totalDeletedUnread,
      todaySent, deletionLog,
      queueToday, queueTotal, readToday, deletedToday, repliedToday,
      sevenDayVolume, domainSummary, hourlyActivity
    };
  } finally {
    db.close();
  }
}

function getRampDay(startDate) {
  const start = new Date(startDate + 'T00:00:00Z');
  return Math.floor((Date.now() - start) / (1000 * 60 * 60 * 24)) + 1;
}

function getRampStage(rampDay) {
  const schedule = config.rampSchedule || [];
  for (const stage of schedule) {
    if (rampDay >= stage.dayFrom && rampDay <= stage.dayTo) {
      return {
        min: stage.minEmails,
        max: stage.maxEmails,
        label: stage.minEmails + '-' + stage.maxEmails + '/day',
        stageIdx: schedule.indexOf(stage)
      };
    }
  }
  return { min: 5, max: 13, label: '5-13/day', stageIdx: -1 };
}

function buildSevenDayChart(sevenDayVolume) {
  const result = [];
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const found = sevenDayVolume.find(function(r) { return r.day === key; });
    result.push({
      label: i === 0 ? 'Today' : i === 1 ? 'Yest' : key.slice(5),
      cnt: found ? found.cnt : 0
    });
  }
  return result;
}

var DOMAIN_COLORS = {
  'clouma.com':           { c: '#60a5fa', bg: '#1e3a5f' },
  'examtraps.com':        { c: '#a78bfa', bg: '#3b1f6e' },
  'flippyfly.com':        { c: '#f472b6', bg: '#4a1235' },
  'indxpro.com':          { c: '#34d399', bg: '#064e3b' },
  'medicalbrothers.com':  { c: '#fbbf24', bg: '#3d2c00' },
  'naveen.cloud':         { c: '#22d3ee', bg: '#0e3744' },
  'nimbusnebula.com':     { c: '#818cf8', bg: '#1e1b4b' },
  'nuvatron.com':         { c: '#f87171', bg: '#450a0a' },
  'santhigiri.org':       { c: '#fb923c', bg: '#4a1e06' },
  'tharunmoorthy.com':    { c: '#c084fc', bg: '#3b0a4e' },
  'xaipex.com':           { c: '#4ade80', bg: '#052e16' }
};

var BREVO1 = ['clouma.com','flippyfly.com','indxpro.com','nimbusnebula.com','santhigiri.org','tharunmoorthy.com'];
var BREVO2 = ['examtraps.com','medicalbrothers.com','naveen.cloud','nuvatron.com','xaipex.com'];

function getBrevo(d) {
  if (BREVO1.indexOf(d) !== -1) return 'B1';
  if (BREVO2.indexOf(d) !== -1) return 'B2';
  return '??';
}

function brevoStyle(d) {
  if (getBrevo(d) === 'B1') return 'background:#1e3a5f;color:#60a5fa;';
  return 'background:#064e3b;color:#34d399;';
}

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function html(data) {
  var senderRows = data.senderRows;
  var recentEmails = data.recentEmails;
  var totalSent = data.totalSent;
  var totalReplied = data.totalReplied;
  var totalDeleted = data.totalDeleted;
  var totalRead = data.totalRead;
  var totalDeletedUnread = data.totalDeletedUnread;
  var todaySent = data.todaySent;
  var deletionLog = data.deletionLog;
  var queueToday = data.queueToday;
  var queueTotal = data.queueTotal;
  var readToday = data.readToday;
  var deletedToday = data.deletedToday;
  var repliedToday = data.repliedToday;
  var sevenDayVolume = data.sevenDayVolume;
  var domainSummary = data.domainSummary;
  var hourlyActivity = data.hourlyActivity;

  var usingSenders = senderRows.length > 0;
  var senderCount = usingSenders
    ? senderRows.length
    : config.domainRing.reduce(function(s, d) { return s + d.senders.length; }, 0);
  var domainCount = config.domainRing.length;

  var domainGroups = {};
  for (var i = 0; i < senderRows.length; i++) {
    var d = senderRows[i];
    var dom = d.sender.split('@')[1] || d.domain;
    if (!domainGroups[dom]) domainGroups[dom] = [];
    domainGroups[dom].push(d);
  }

  var domainRows = Object.keys(domainGroups).map(function(domain) {
    var senders = domainGroups[domain];
    var dc = DOMAIN_COLORS[domain] || { c: '#94a3b8', bg: '#1e293b' };

    var senderHtml = senders.map(function(d) {
      var rampDay = getRampDay(d.start_date);
      var stage = getRampStage(rampDay);
      var target = Math.round((stage.min + stage.max) / 2);
      var pct = Math.min(100, Math.round((d.emails_today / target) * 100));
      var init = d.sender.split('@')[0].slice(0, 2).toUpperCase();
      var last = d.last_sent_at
        ? new Date(d.last_sent_at).toLocaleString('en-US', {
            timeZone: 'Asia/Kolkata',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
          })
        : '—';
      return '<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid #1e293b;" data-account="' + d.sender.toLowerCase() + '">' +
        '<span style="width:24px;height:24px;border-radius:50%;background:' + dc.bg + ';color:' + dc.c + ';display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;flex-shrink:0;">' + init + '</span>' +
        '<span style="font-size:11px;color:#e2e8f0;min-width:165px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(d.sender) + '</span>' +
        '<span style="font-size:8px;font-weight:600;padding:2px 6px;border-radius:10px;background:#334155;color:#94a3b8;">D' + String(rampDay).padStart(3, '0') + '</span>' +
        '<div style="flex:1;height:5px;background:#334155;border-radius:3px;overflow:hidden;"><div style="width:' + pct + '%;height:100%;border-radius:3px;background:' + dc.c + ';transition:width .3s;"></div></div>' +
        '<span style="font-size:9px;color:#94a3b8;min-width:44px;text-align:right;">' + d.emails_today + '/' + target + '</span>' +
        '<span style="font-size:9px;color:#64748b;min-width:38px;text-align:right;">∑' + (d.total_sent || 0) + '</span>' +
        '<span style="font-size:9px;color:#475569;min-width:78px;text-align:right;">' + last + '</span>' +
        '</div>';
    }).join('');

    var dt = senders.reduce(function(s, d) { return s + (d.total_sent || 0); }, 0);
    var dy = senders.reduce(function(s, d) { return s + (d.emails_today || 0); }, 0);
    var bv = getBrevo(domain);

    return '<div style="margin-bottom:8px;background:#0f172a;border-radius:8px;border:1px solid #1e293b;overflow:hidden;">' +
      '<div style="display:flex;align-items:center;gap:8px;padding:8px 10px;cursor:pointer;background:#1a2332;border-bottom:1px solid #1e293b;" onclick="toggleDomain(\'' + domain + '\')">' +
      '<span style="font-size:8px;font-weight:700;padding:2px 6px;border-radius:4px;' + brevoStyle(domain) + '">' + bv + '</span>' +
      '<span style="font-size:12px;font-weight:600;color:' + dc.c + ';">' + esc(domain) + '</span>' +
      '<span style="font-size:10px;color:#64748b;">' + senders.length + ' senders · ∑' + dt + ' · ' + dy + ' today</span>' +
      '<span style="margin-left:auto;font-size:9px;color:#475569;" id="arrow-' + domain + '">▼</span>' +
      '</div>' +
      '<div id="group-' + domain + '">' + senderHtml + '</div>' +
      '</div>';
  }).join('');

  var emailRows = recentEmails.map(function(e) {
    var dc = DOMAIN_COLORS[e.sender.split('@')[1]] || { c: '#94a3b8', bg: '#1e293b' };
    var init = e.sender.split('@')[0].slice(0, 2).toUpperCase();
    var t = new Date(e.sent_at).toLocaleString('en-US', {
      timeZone: 'Asia/Kolkata',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
    var statusLabels = { sent: '→ Sent', deleted: '✗ Del', kept_reply: '↩ Reply', hard_deleted: '✗ Hard', moved_trash: '⌫ Trash' };
    var sb = statusLabels[e.status] || e.status;
    return '<div style="display:flex;align-items:center;gap:8px;padding:7px 10px;border-bottom:1px solid #1e293b;font-size:11px;">' +
      '<span style="width:26px;height:26px;border-radius:50%;background:' + dc.bg + ';color:' + dc.c + ';display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;flex-shrink:0;">' + init + '</span>' +
      '<span style="flex:1;color:#e2e8f0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(e.subject || '—') + '</span>' +
      '<span style="color:#64748b;font-size:10px;white-space:nowrap;">' + esc(e.sender) + ' → ' + esc(e.receiver) + '</span>' +
      '<span style="color:#475569;font-size:10px;min-width:68px;text-align:right;">' + t + '</span>' +
      '<span style="font-size:9px;padding:2px 7px;border-radius:10px;background:#1e293b;color:#94a3b8;">' + sb + '</span>' +
      '</div>';
  }).join('') || '<div style="padding:20px;text-align:center;color:#475569;">No emails sent yet — first sends coming soon</div>';

  var actionColors = {
    marked_read: '#60a5fa',
    kept_reply: '#34d399',
    moved_trash: '#fbbf24',
    hard_deleted: '#f87171',
    deleted_unread: '#fb923c',
    not_found: '#64748b',
    error: '#f87171',
    trash_failed: '#fb923c'
  };

  var cleanupRows = deletionLog.map(function(l) {
    var t = new Date(l.logged_at).toLocaleString('en-US', {
      timeZone: 'Asia/Kolkata',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
    var ac = actionColors[l.action] || '#94a3b8';
    return '<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid #1e293b;font-size:10px;">' +
      '<span style="color:#475569;min-width:68px;">' + t + '</span>' +
      '<span style="color:#94a3b8;flex:1;">' + esc(l.sender) + '</span>' +
      '<span style="color:' + ac + ';font-weight:500;">' + esc(l.action) + '</span>' +
      '</div>';
  }).join('') || '<div style="padding:20px;text-align:center;color:#475569;">No engagement activity yet</div>';

  var chartDays = buildSevenDayChart(sevenDayVolume);
  var chartLabels = JSON.stringify(chartDays.map(function(d) { return d.label; }));
  var chartData = JSON.stringify(chartDays.map(function(d) { return d.cnt; }));
  var chartBg = JSON.stringify(chartDays.map(function(_, i) { return i === 6 ? '#3b82f6' : '#1e3a5f'; }));

  var rampRows = (config.rampSchedule || []).map(function(s, i) {
    var sc = ['#60a5fa', '#22d3ee', '#a78bfa', '#fbbf24'];
    var sn = ['Intro', 'Build', 'Scale', 'Maintain'];
    return '<tr>' +
      '<td style="padding:6px 10px;color:' + sc[i] + ';font-weight:600;">Stage ' + (i + 1) + ' · ' + sn[i] + '</td>' +
      '<td style="padding:6px 10px;color:#94a3b8;">Day ' + s.dayFrom + '–' + (s.dayTo === 99999 ? '∞' : s.dayTo) + '</td>' +
      '<td style="padding:6px 10px;color:#e2e8f0;text-align:right;">' + s.minEmails + '–' + s.maxEmails + ' / sender</td>' +
      '</tr>';
  }).join('');

  var domainSumRows = (domainSummary || []).map(function(d) {
    var dc = DOMAIN_COLORS[d.domain] || { c: '#94a3b8' };
    return '<div style="display:flex;align-items:center;gap:8px;padding:5px 0;font-size:11px;">' +
      '<span style="font-size:8px;font-weight:700;padding:2px 5px;border-radius:3px;' + brevoStyle(d.domain) + '">' + getBrevo(d.domain) + '</span>' +
      '<span style="color:' + dc.c + ';font-weight:500;min-width:115px;">' + esc(d.domain) + '</span>' +
      '<span style="color:#64748b;">' + d.senders + ' accts</span>' +
      '<span style="color:#94a3b8;min-width:55px;text-align:right;">∑' + d.total_sent + '</span>' +
      '<span style="color:#94a3b8;min-width:50px;text-align:right;">' + d.today_sent + ' today</span>' +
      '</div>';
  }).join('');

  var hourlyMap = {};
  for (var h = 0; h < 24; h++) hourlyMap[h] = 0;
  for (var ri = 0; ri < (hourlyActivity || []).length; ri++) {
    hourlyMap[hourlyActivity[ri].hour] = hourlyActivity[ri].cnt;
  }
  var maxHr = 1;
  for (var hk = 0; hk < 24; hk++) {
    if (hourlyMap[hk] > maxHr) maxHr = hourlyMap[hk];
  }

  var hourlyBars = '';
  for (var hr = 0; hr < 24; hr++) {
    var pct = Math.round((hourlyMap[hr] / maxHr) * 100);
    var inWin = (hr >= 19 || hr < 7);
    hourlyBars += '<div style="flex:1;text-align:center;" title="' + String(hr).padStart(2, '0') + ':00 — ' + hourlyMap[hr] + ' emails">' +
      '<div style="height:34px;display:flex;align-items:flex-end;justify-content:center;margin-bottom:2px;">' +
      '<div style="width:65%;height:' + Math.max(2, pct) + '%;background:' + (inWin ? '#3b82f6' : '#334155') + ';border-radius:2px 2px 0 0;min-height:2px;"></div>' +
      '</div>' +
      '<span style="font-size:7px;color:#475569;">' + hr + '</span>' +
      '</div>';
  }

  return '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n<title>NuvaWarm · Dashboard</title>\n<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">\n<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js"><\/script>\n' +
'<style>\n' +
'*{box-sizing:border-box;margin:0;padding:0;}\n' +
'body{background:#0b1120;color:#cbd5e1;font-family:"Inter",sans-serif;font-size:13px;min-height:100vh;padding:16px;}\n' +
'.topbar{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;padding:14px 18px;border-radius:10px;background:#131c31;border:1px solid #1e2d50;flex-wrap:wrap;gap:8px;}\n' +
'.logo{width:36px;height:36px;border-radius:8px;background:linear-gradient(135deg,#f59e0b,#ef4444);display:flex;align-items:center;justify-content:center;flex-shrink:0;}\n' +
'.badge{display:inline-flex;align-items:center;gap:3px;font-size:10px;font-weight:500;padding:2px 8px;border-radius:12px;}\n' +
'.bg{background:#064e3b;color:#6ee7b7;}.br{background:#1e3a5f;color:#93c5fd;}.bp{background:#3b1f6e;color:#c4b5fd;}\n' +
'.dot{width:5px;height:5px;border-radius:50%;background:#4ade80;animation:pulse 2s infinite;}\n' +
'@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}\n' +
'.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px;}\n' +
'@media(min-width:900px){.metrics{grid-template-columns:repeat(9,1fr);}}\n' +
'.mcard{border-radius:10px;padding:14px;border:0.5px solid transparent;text-align:center;}\n' +
'.mcard-val{font-size:24px;font-weight:700;color:#f8fafc;line-height:1;}\n' +
'.mcard-label{font-size:9px;color:rgba(255,255,255,.6);margin-top:4px;text-transform:uppercase;letter-spacing:.03em;}\n' +
'.mcard-sub{font-size:8px;color:rgba(255,255,255,.3);margin-top:2px;}\n' +
'.grid2{display:grid;grid-template-columns:1fr;gap:12px;margin-bottom:12px;}\n' +
'@media(min-width:900px){.grid2{grid-template-columns:1fr 1fr;}}\n' +
'.card{background:#131c31;border:1px solid #1e2d50;border-radius:10px;padding:16px;}\n' +
'.card-title{font-size:10px;font-weight:600;color:#94a3b8;margin-bottom:10px;text-transform:uppercase;letter-spacing:.04em;display:flex;align-items:center;gap:6px;}\n' +
'.win-box{border-radius:8px;padding:12px 14px;margin-bottom:10px;background:linear-gradient(135deg,#1e1b4b,#312e81);border:0.5px solid #4f46e5;display:flex;justify-content:space-between;}\n' +
'.date-box{background:linear-gradient(135deg,#1e1b4b,#312e81);border:0.5px solid #4f46e5;border-radius:8px;padding:8px 12px;text-align:center;}\n' +
'.chart-wrap{position:relative;width:100%;height:140px;margin-top:4px;}\n' +
'.filter-box{width:100%;padding:8px 10px;background:#0b1120;border:1px solid #1e2d50;border-radius:7px;color:#e2e8f0;font-size:11px;outline:none;margin-bottom:10px;}\n' +
'.filter-box:focus{border-color:#6366f1;}\n' +
'.ramp-table{width:100%;border-collapse:collapse;font-size:11px;}\n' +
'.ramp-table td{border-bottom:1px solid #1e2d50;}\n' +
'.footer{text-align:center;padding:16px 0 6px;border-top:1px solid #1e2d50;margin-top:4px;font-size:10px;color:#475569;}\n' +
'.footer a{color:#6366f1;text-decoration:none;font-weight:500;}\n' +
'.heatmap{display:flex;gap:1px;align-items:flex-end;height:36px;padding:0 2px;}\n' +
'</style>\n</head>\n<body>\n' +
'<div class="topbar">\n' +
'  <div style="display:flex;align-items:center;gap:10px;">\n' +
'    <div class="logo"><svg width="18" height="18" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg></div>\n' +
'    <div>\n' +
'      <div style="font-size:16px;font-weight:700;color:#f1f5f9;">NuvaWarm</div>\n' +
'      <div style="font-size:10px;color:#64748b;">' + senderCount + ' accounts · ' + domainCount + ' domains · 500/day cap</div>\n' +
'    </div>\n' +
'    <span class="badge bg"><span class="dot"></span>Live</span>\n' +
'    <span class="badge br">B1: 6</span>\n' +
'    <span class="badge bp">B2: 5</span>\n' +
'  </div>\n' +
'  <div style="display:flex;align-items:center;gap:10px;">\n' +
'    <div class="date-box">\n' +
'      <div style="font-size:8px;color:#a5b4fc;text-transform:uppercase;letter-spacing:.06em;">IST</div>\n' +
'      <div style="font-size:18px;font-weight:700;color:#f1f5f9;line-height:1.2;" id="ist-clock">--:-- --</div>\n' +
'    </div>\n' +
'    <div class="date-box" style="min-width:80px;">\n' +
'      <div style="font-size:11px;font-weight:600;color:#e2e8f0;" id="ist-day">Monday</div>\n' +
'      <div style="font-size:15px;font-weight:700;color:#f1f5f9;" id="ist-date-full">June 15</div>\n' +
'      <div style="font-size:9px;color:#a5b4fc;margin-top:2px;" id="ist-ramp-day">Day 1</div>\n' +
'    </div>\n' +
'    <div style="text-align:right;">\n' +
'      <div style="margin-top:2px;" id="next-pill"></div>\n' +
'    </div>\n' +
'  </div>\n' +
'</div>\n' +
'<div class="metrics">\n' +
'  <div class="mcard" style="background:linear-gradient(135deg,#1e3a5f,#1e40af);border-color:#3b82f6;">\n' +
'    <div class="mcard-val">' + todaySent.cnt + '</div><div class="mcard-label">Sent today</div><div class="mcard-sub">∑' + totalSent.cnt + ' total</div></div>\n' +
'  <div class="mcard" style="background:linear-gradient(135deg,#4c1d95,#6d28d9);border-color:#a78bfa;">\n' +
'    <div class="mcard-val">' + queueToday.cnt + '</div><div class="mcard-label">Queued today</div><div class="mcard-sub">' + queueTotal.cnt + ' pending</div></div>\n' +
'  <div class="mcard" style="background:linear-gradient(135deg,#0e3744,#0e7490);border-color:#22d3ee;">\n' +
'    <div class="mcard-val">' + readToday.cnt + '</div><div class="mcard-label">Read today</div><div class="mcard-sub">∑' + totalRead.cnt + ' total</div></div>\n' +
'  <div class="mcard" style="background:linear-gradient(135deg,#052e16,#166534);border-color:#4ade80;">\n' +
'    <div class="mcard-val">' + repliedToday.cnt + '</div><div class="mcard-label">Replied</div><div class="mcard-sub">∑' + totalReplied.cnt + ' total</div></div>\n' +
'  <div class="mcard" style="background:linear-gradient(135deg,#450a0a,#991b1b);border-color:#f87171;">\n' +
'    <div class="mcard-val">' + deletedToday.cnt + '</div><div class="mcard-label">Deleted</div><div class="mcard-sub">∑' + totalDeleted.cnt + ' total</div></div>\n' +
'  <div class="mcard" style="background:linear-gradient(135deg,#7c2d12,#c2410c);border-color:#f97316;">\n' +
'    <div class="mcard-val">' + totalDeletedUnread.cnt + '</div><div class="mcard-label">Del unread</div><div class="mcard-sub">inbox behav</div></div>\n' +
'  <div class="mcard" style="background:linear-gradient(135deg,#1e1b4b,#312e81);border-color:#6366f1;">\n' +
'    <div class="mcard-val">' + domainCount + '</div><div class="mcard-label">Domains</div><div class="mcard-sub">B1:6 · B2:5</div></div>\n' +
'  <div class="mcard" style="background:linear-gradient(135deg,#0d3320,#166534);border-color:#22c55e;">\n' +
'    <div class="mcard-val">' + senderCount + '</div><div class="mcard-label">Accounts</div><div class="mcard-sub">B1:20 · B2:21</div></div>\n' +
'  <div class="mcard" style="background:linear-gradient(135deg,#3d2c00,#854d0e);border-color:#eab308;">\n' +
'    <div class="mcard-val">500</div><div class="mcard-label">Daily Cap</div><div class="mcard-sub">250 × 2 Brevo</div></div>\n' +
'</div>\n' +
'<div class="grid2">\n' +
'  <div class="card">\n' +
'    <div class="card-title">📊 Account Ramp Progress <span style="margin-left:auto;color:#475569;font-size:9px;">TODAY/TARGET · ∑TOTAL</span></div>\n' +
'    <input class="filter-box" id="filter-input" type="text" placeholder="🔍 Filter ' + senderCount + ' accounts..." oninput="filterAccounts()">\n' +
'    <div style="max-height:450px;overflow-y:auto;">' + domainRows + '</div>\n' +
'  </div>\n' +
'  <div class="card">\n' +
'    <div class="card-title">⏰ Send Window</div>\n' +
'    <div class="win-box">\n' +
'      <div><div style="font-size:10px;color:#a5b4fc;">Window (IST)</div><div style="font-size:16px;font-weight:700;color:#e0e7ff;">19:00 – 07:00</div><div style="font-size:9px;color:#818cf8;">±25min jitter daily</div></div>\n' +
'      <div style="text-align:right;"><div style="font-size:10px;color:#a5b4fc;">Schedule</div><div style="font-size:14px;font-weight:600;color:#e0e7ff;" id="sched-label">Every day</div><div style="font-size:9px;color:#818cf8;">weekends reduced</div></div>\n' +
'    </div>\n' +
'    <div style="text-align:center;padding:8px 0;">\n' +
'      <div style="font-size:28px;font-weight:700;color:#f1f5f9;" id="countdown-val">--h --m</div>\n' +
'      <div style="font-size:10px;color:#64748b;" id="countdown-label">calculating...</div>\n' +
'    </div>\n' +
'    <div class="card-title" style="margin-top:10px;">📈 Hourly Activity</div>\n' +
'    <div class="heatmap">' + hourlyBars + '</div>\n' +
'    <div style="display:flex;justify-content:space-between;font-size:7px;color:#475569;padding:0 2px;"><span>0h</span><span>6h</span><span>12h</span><span>18h</span><span>23h</span></div>\n' +
'    <div style="display:flex;gap:10px;justify-content:center;margin-top:4px;font-size:9px;color:#475569;"><span>● Window (19-7)</span><span>○ Outside</span></div>\n' +
'    <div class="card-title" style="margin-top:10px;">📅 7-Day Volume</div>\n' +
'    <div class="chart-wrap"><canvas id="vol-chart"></canvas></div>\n' +
'  </div>\n' +
'</div>\n' +
'<div class="grid2" style="margin-bottom:12px;">\n' +
'  <div class="card">\n' +
'    <div class="card-title">✉️ Live Email Feed <span style="margin-left:auto;color:#475569;font-size:9px;">LAST 50</span></div>\n' +
'    <div style="max-height:450px;overflow-y:auto;">' + emailRows + '</div>\n' +
'  </div>\n' +
'  <div class="card">\n' +
'    <div class="card-title">📬 IMAP Engagement Log <span style="margin-left:auto;color:#475569;font-size:9px;">LAST 30</span></div>\n' +
'    <div style="max-height:450px;overflow-y:auto;">' + cleanupRows + '</div>\n' +
'  </div>\n' +
'</div>\n' +
'<div class="grid2" style="margin-bottom:12px;">\n' +
'  <div class="card">\n' +
'    <div class="card-title">📋 Ramp Schedule · Dual Brevo SMTP</div>\n' +
'    <table class="ramp-table">' + rampRows + '</table>\n' +
'    <div style="margin-top:10px;padding-top:8px;border-top:1px solid #1e2d50;font-size:10px;color:#94a3b8;line-height:1.7;">\n' +
'      <b>SMTP:</b> Dual Brevo · smtp-relay.brevo.com:587<br>\n' +
'      <span style="color:#93c5fd;">● B1</span> 20 senders / 6 domains &nbsp; <span style="color:#6ee7b7;">● B2</span> 21 senders / 5 domains &nbsp; 500/day safe cap (250 × 2)\n' +
'    </div>\n' +
'  </div>\n' +
'  <div class="card">\n' +
'    <div class="card-title">🌐 Domain Overview · Active Enhancements</div>\n' +
'    ' + domainSumRows + '\n' +
'    <div style="margin-top:8px;padding-top:6px;border-top:1px solid #1e2d50;font-size:9px;color:#64748b;line-height:1.7;">\n' +
'      📉 Weekend reducer · ⏰ Window jitter · ⚡ Burst mode · ☕ Coffee breaks<br>🌙 Time curve · 📥 Inbox behavior · ✍️ Subject styles\n' +
'    </div>\n' +
'  </div>\n' +
'</div>\n' +
'<div class="footer">\n' +
'  NuvaWarm · AUTO-REFRESH 2 MIN · <span id="last-refresh">—</span><br>\n' +
'  <span style="color:#94a3b8;">All rights reserved · Designed and crafted with ⚡ by <a href="https://nuvatron.com/" target="_blank">Nuvatron Systems Integration LLP</a></span>\n' +
'</div>\n' +
'<script>\n' +
'var DAYS=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"],MONTHS=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];\n' +
'function fmt12(h,m,s){var hh=h%12||12;return hh+":"+String(m).padStart(2,"0")+":"+String(s).padStart(2,"0")+" "+(h<12?"AM":"PM");}\n' +
'function toggleDomain(d){var e=document.getElementById("group-"+d),a=document.getElementById("arrow-"+d);if(e.style.display==="none"){e.style.display="block";if(a)a.textContent="▼"}else{e.style.display="none";if(a)a.textContent="▶"}}\n' +
'function filterAccounts(){var q=document.getElementById("filter-input").value.toLowerCase();document.querySelectorAll("[data-account]").forEach(function(e){e.style.display=e.dataset.account.includes(q)?"":"none";var p=e.closest("[id^=group-]");if(p)p.style.display="block"})}\n' +
'function updateTime(){\n' +
'  var now=new Date(),ist=new Date(now.toLocaleString("en-US",{timeZone:"Asia/Kolkata"})),pst=new Date(now.toLocaleString("en-US",{timeZone:"America/Los_Angeles"}));\n' +
'  var hi=ist.getHours(),mi=ist.getMinutes(),si=ist.getSeconds(),hp=pst.getHours(),mp=pst.getMinutes();\n' +
'  document.getElementById("ist-clock").textContent=fmt12(hi,mi,si);\n' +
'  document.getElementById("ist-day").textContent=DAYS[ist.getDay()];\n' +
'  document.getElementById("ist-date-full").textContent=MONTHS[ist.getMonth()]+" "+ist.getDate();\n' +
'  document.getElementById("ist-ramp-day").textContent="Day " + (function(){var s=document.querySelector("[data-account]");if(!s)return"1";var d=s.closest("[id^=group-]");if(!d)return"1";var t=d.querySelector("span");return t?t.textContent.replace("D",""):"1";})();\n' +
'  var inWin=(hi>=19||hi<7),isWd=ist.getDay()>=1&&ist.getDay()<=5;\n' +
'  var cv=document.getElementById("countdown-val"),cl=document.getElementById("countdown-label"),np=document.getElementById("next-pill");\n' +
'  var sl=document.getElementById("sched-label");\n' +
'  if(sl)sl.textContent=isWd?"Every weekday (full)":"Weekend (reduced)";\n' +
'  if(inWin&&isWd){cv.textContent="OPEN";cv.style.color="#4ade80";cl.textContent="full volume — sending now";np.innerHTML="<span class=\\"badge bg\\"><span class=\\"dot\\"></span>Sending</span>"}\n' +
'  else if(inWin&&!isWd){cv.textContent="OPEN";cv.style.color="#a78bfa";cl.textContent="reduced weekend volume";np.innerHTML="<span class=\\"badge bp\\">📉 Reduced</span>"}\n' +
'  else{cv.style.color="#f1f5f9";var next=new Date(ist);if(hi>=7&&hi<19)next.setHours(19,0,0,0);else{next.setDate(next.getDate()+1);next.setHours(19,0,0,0)}\n' +
'    var diff=next-ist,dh=Math.floor(diff/3600000),dm=Math.floor((diff%3600000)/60000);cv.textContent=dh+"h "+dm+"m";cl.textContent="until next window";\n' +
'    np.innerHTML="<span class=\\"badge br\\">Next: "+DAYS[next.getDay()]+" 7pm</span>"}\n' +
'  document.getElementById("last-refresh").textContent="UPDATED "+fmt12(hp,mp,0).replace(":00 "," ")+" PST";\n' +
'}\n' +
'updateTime();setInterval(updateTime,1000);\n' +
'new Chart(document.getElementById("vol-chart"),{type:"bar",data:{labels:' + chartLabels + ',datasets:[{label:"Emails",data:' + chartData + ',backgroundColor:' + chartBg + ',borderRadius:4}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{grid:{display:false},ticks:{color:"#64748b",font:{size:9}}},y:{grid:{color:"#1e2d50"},ticks:{color:"#64748b",font:{size:9},stepSize:1},beginAtZero:true}}}});\n' +
'<\/script>\n</body>\n</html>';
}

var server = http.createServer(function(req, res) {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', time: new Date().toISOString() }));
    return;
  }
  if (req.url === '/api/data') {
    try {
      var data = getData();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data, null, 2));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }
  try {
    var pageData = getData();
    var page = html(pageData);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Error: ' + err.message);
  }
});

server.listen(PORT, '0.0.0.0', function() {
  console.log('[dashboard] NuvaWarm running at http://0.0.0.0:' + PORT);
});
