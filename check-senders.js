require('dotenv').config();
const config = require('./config.json');
const db = require('./db');

db.getDb();

const configSenders = [];
for (const d of config.domainRing) {
  for (const s of d.senders) {
    configSenders.push(s.toLowerCase());
  }
}

const dbSenders = db.getDb().prepare('SELECT sender FROM sender_stats').all().map(r => r.sender.toLowerCase());
const missing = configSenders.filter(s => !dbSenders.includes(s));

console.log('Config senders:', configSenders.length);
console.log('DB senders:', dbSenders.length);
console.log('Missing:', missing.length > 0 ? missing : 'None');
