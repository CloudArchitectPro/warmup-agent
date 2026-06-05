'use strict';

require('dotenv').config();
const nodemailer = require('nodemailer');
const logger = require('./logger');

let _transporter = null;

function getTransporter() {
  if (_transporter) return _transporter;

  _transporter = nodemailer.createTransport({
    host: process.env.BREVO_SMTP_HOST || 'smtp-relay.brevo.com',
    port: parseInt(process.env.BREVO_SMTP_PORT || '587', 10),
    secure: false, // STARTTLS
    auth: {
      user: process.env.BREVO_SMTP_LOGIN,
      pass: process.env.BREVO_SMTP_KEY,
    },
    pool: true,
    maxConnections: 3,
    maxMessages: 100,
    rateDelta: 1000,
    rateLimit: 5,
  });

  return _transporter;
}

async function verifySmtp() {
  try {
    await getTransporter().verify();
    logger.info('[mailer] SMTP connection verified successfully');
    return true;
  } catch (err) {
    logger.error(`[mailer] SMTP verification FAILED: ${err.message}`);
    return false;
  }
}

async function sendEmail({ from, to, subject, body }) {
  const transporter = getTransporter();

  const info = await transporter.sendMail({
    from,
    to,
    subject,
    text: body,
    headers: {
      'X-Warmup': 'true',
      'X-Warmup-Version': '1.0',
    },
  });

  logger.info(`[mailer] Sent: ${info.messageId} | ${from} → ${to} | "${subject}"`);
  return info.messageId;
}

function closeTransporter() {
  if (_transporter) {
    _transporter.close();
    _transporter = null;
    logger.info('[mailer] SMTP transporter closed');
  }
}

module.exports = { verifySmtp, sendEmail, closeTransporter };
