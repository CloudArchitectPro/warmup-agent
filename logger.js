'use strict';

const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, 'logs');

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function getLogFilePath() {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return path.join(LOG_DIR, `warmup-${date}.log`);
}

function formatMessage(level, ...args) {
  const ts = new Date().toISOString();
  const msg = args
    .map(a => (typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)))
    .join(' ');
  return `[${ts}] [${level.padEnd(5)}] ${msg}`;
}

function write(level, ...args) {
  ensureLogDir();
  const line = formatMessage(level, ...args);
  // Console output
  if (level === 'ERROR') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
  // File output
  try {
    fs.appendFileSync(getLogFilePath(), line + '\n');
  } catch (err) {
    process.stderr.write(`[logger] Failed to write log file: ${err.message}\n`);
  }
}

const logger = {
  info:  (...args) => write('INFO',  ...args),
  warn:  (...args) => write('WARN',  ...args),
  error: (...args) => write('ERROR', ...args),
  debug: (...args) => write('DEBUG', ...args),
};

module.exports = logger;
