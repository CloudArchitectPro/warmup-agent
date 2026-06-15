'use strict';
require('dotenv').config();
const nodemailer = require('nodemailer');
const logger = require('./logger');

// Which Brevo account handles which domains
const ACCOUNT1_DOMAINS = [
  'clouma.com', 'flippyfly.com', 'indxpro.com', 'nimbusnebula.com',
  'santhigiri.org', 'tharunmoorthy.com'
];
const ACCOUNT2_DOMAINS = [
  'examtraps.com', 'medicalbrothers.com', 'naveen.cloud',
  'nuvatron.com', 'xaipex.com'
];

let _transporter1 = null;
let _transporter2 = null;

function getTransporter(account) {
  if (account === 1) {
    if (_transporter1) return _transporter1;
    _transporter1 = nodemailer.createTransport({
      host: process.env.SMTP1_HOST || 'smtp-relay.brevo.com',
      port: parseInt(process.env.SMTP1_PORT || '587', 10),
      secure: false,
      auth: {
        user: process.env.SMTP1_USER,
        pass: process.env.SMTP1_PASS,
      },
      pool: true,
      maxConnections: 3,
      maxMessages: 100,
      rateDelta: 1000,
      rateLimit: 5,
      connectionTimeout: 10000,
      socketTimeout: 30000,
      tls: { rejectUnauthorized: false },
    });
    return _transporter1;
  }
  if (_transporter2) return _transporter2;
  _transporter2 = nodemailer.createTransport({
    host: process.env.SMTP2_HOST || 'smtp-relay.brevo.com',
    port: parseInt(process.env.SMTP2_PORT || '587', 10),
    secure: false,
    auth: {
      user: process.env.SMTP2_USER,
      pass: process.env.SMTP2_PASS,
    },
    pool: true,
    maxConnections: 3,
    maxMessages: 100,
    rateDelta: 1000,
    rateLimit: 5,
    connectionTimeout: 10000,
    socketTimeout: 30000,
    tls: { rejectUnauthorized: false },
  });
  return _transporter2;
}

function getAccountForSender(from) {
  const domain = from.split('@')[1]?.toLowerCase();
  if (!domain) return 2;
  if (ACCOUNT1_DOMAINS.includes(domain)) return 1;
  if (ACCOUNT2_DOMAINS.includes(domain)) return 2;
  logger.warn(`[mailer] Unknown domain: ${domain}, defaulting to account 2`);
  return 2;
}

async function verifySmtp() {
  try {
    await getTransporter(1).verify();
    logger.info('[mailer] SMTP Account 1 verified successfully');
  } catch (err) {
    logger.error(`[mailer] SMTP Account 1 verification FAILED: ${err.message}`);
    _transporter1 = null;
  }
  try {
    await getTransporter(2).verify();
    logger.info('[mailer] SMTP Account 2 verified successfully');
  } catch (err) {
    logger.error(`[mailer] SMTP Account 2 verification FAILED: ${err.message}`);
    _transporter2 = null;
  }
  return true;
}

async function sendEmail({ from, to, subject, body }) {
  const account = getAccountForSender(from);
  const transporter = getTransporter(account);
  const info = await transporter.sendMail({
    from,
    to,
    subject,
    text: body,
    headers: {
      'X-Warmup': 'true',
      'X-Warmup-Version': '1.0',
      'X-Warmup-Account': String(account),
    },
  });
  logger.info(`[mailer] Sent [Brevo${account}]: ${info.messageId} | ${from} → ${to} | "${subject}"`);
  return info.messageId;
}

function closeTransporter() {
  if (_transporter1) { _transporter1.close(); _transporter1 = null; }
  if (_transporter2) { _transporter2.close(); _transporter2 = null; }
  logger.info('[mailer] SMTP transporters closed');
}

module.exports = { verifySmtp, sendEmail, closeTransporter };
