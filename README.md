# Warmup Agent

A production-ready Node.js email warm-up agent that runs 24/7 on a Raspberry Pi. Sends AI-generated, human-like emails between your domains in a circular ring pattern, with automatic IMAP cleanup and crash-safe SQLite state.

---

## Quick Start (Raspberry Pi)

```bash
# 1. Copy the project to your Pi
scp -r warmup-agent pi@<pi-ip>:/home/pi/

# 2. SSH into the Pi
ssh pi@<pi-ip>

# 3. Run the setup script
cd /home/pi/warmup-agent
bash setup-pi.sh

# 4. Fill in IMAP passwords
nano .env

# 5. Restart the agent to apply IMAP credentials
pm2 restart warmup-agent
```

---

## Send Window

Emails are sent **Monday–Friday, 6:00 AM – 8:00 AM** in the configured timezone (default: `America/New_York`).

To change the timezone or window, edit `config.json`:

```json
{
  "timezone": "America/New_York",
  "sendWindow": {
    "startHour": 6,
    "endHour": 8
  }
}
```

---

## PM2 Commands

| Command | Description |
|---|---|
| `pm2 status` | Show agent health and uptime |
| `pm2 logs warmup-agent` | Live log tail |
| `pm2 logs warmup-agent --lines 200` | Last 200 log lines |
| `pm2 restart warmup-agent` | Restart agent |
| `pm2 stop warmup-agent` | Stop agent |
| `pm2 delete warmup-agent` | Remove from PM2 |
| `pm2 monit` | Full monitoring dashboard |

---

## Configuration Reference (`config.json`)

| Key | Description |
|---|---|
| `timezone` | IANA timezone string (e.g. `America/New_York`, `Asia/Kolkata`) |
| `sendWindow.startHour` | Send window start (24h, e.g. `6` = 6am) |
| `sendWindow.endHour` | Send window end (24h, e.g. `8` = 8am) |
| `weekdaysOnly` | `true` = Monday–Friday only |
| `minDelayMinutes` | Minimum random delay between sends (default: 25) |
| `maxDelayMinutes` | Maximum random delay between sends (default: 75) |
| `betweenSendPauseSeconds.min` | Minimum pause between consecutive sends (default: 3) |
| `betweenSendPauseSeconds.max` | Maximum pause between consecutive sends (default: 8) |
| `rampSchedule` | Array of `{dayFrom, dayTo, emailsPerDay}` ramp entries |
| `domainRing` | Array of domain objects (domain, niche, senders) |

---

## Ramp Schedule

Each domain starts its ramp on the `start_date` recorded in SQLite when the agent first runs.

| Days Since Start | Emails/Day |
|---|---|
| 1–7 | 2 |
| 8–14 | 4 |
| 15–21 | 10 |
| 22–30 | 20 |
| 31–60 | 40 |
| 61+ (maintenance) | 8 |

Volume never increases by more than 2× per week. After Day 60 the agent drops to 8 emails/day per domain and runs indefinitely — there is no end date.

---

## IMAP Auto-Delete

The cleanup job runs:
- **Nightly at 3:00 AM** (via node-cron)
- **5 minutes after every startup** (to catch missed runs from power cuts)

### Delete logic

| Condition | Action |
|---|---|
| Email has a reply (`In-Reply-To` match) | Keep — marks as `kept_reply` (trust signal for spam filters) |
| Age < 7 days | Move to Trash (`[Gmail]/Trash` → `Trash` → `Deleted Items`) |
| Age ≥ 7 days | Hard delete (permanent) |

Only emails tagged with `X-Warmup: true` header are touched — real emails are never affected.

---

## Domain Ring

Emails flow in a circular pattern:

```
clouma.com → nuvatron.com → medicalbrothers.com → naveen.cloud
    → xaipex.com → santhigiri.org → tharunmoorthy.com
    → nimbusnebula.com → flippyfly.com → indxpro.com
    → examtraps.com → (back to clouma.com)
```

---

## IMAP Password Configuration

Edit `.env` and fill in one Gmail app password per domain:

```
IMAP_PASSWORD_CLOUMA_COM=your-app-password
IMAP_PASSWORD_NUVATRON_COM=your-app-password
...
```

**To get a Gmail app password:**
1. Go to your Google Account → Security → 2-Step Verification → App passwords
2. Create a password for "Mail" on "Other device"
3. Use the 16-character password generated

By default the first sender address for a domain is used as the IMAP login. Override with:
```
IMAP_USER_CLOUMA_COM=admin@clouma.com
```

---

## Smart Plug / Power Cut Behaviour

The agent is designed to survive hard power cuts with no manual intervention:

- **All state is in SQLite** — no critical state is held only in memory
- **WAL mode** is enabled on SQLite for crash-safe writes
- **PM2 autorestart** will relaunch the agent after a reboot
- **On each startup**, the cleanup job runs 5 minutes in — any missed 3am runs are caught automatically
- **The send queue is rebuilt** from SQLite on each boot — no sends are lost or duplicated

---

## Logs

Daily rolling log files are written to `logs/warmup-YYYY-MM-DD.log`.

```bash
# Live tail
tail -f logs/warmup-$(date +%Y-%m-%d).log

# Last 50 lines
tail -50 logs/warmup-$(date +%Y-%m-%d).log
```

PM2 also writes its own logs to `logs/pm2-out.log` and `logs/pm2-error.log`.

---

## Troubleshooting

### Agent won't start — SMTP error
- Check `BREVO_SMTP_LOGIN` and `BREVO_SMTP_KEY` in `.env`
- Verify your Brevo account has SMTP enabled
- Run `pm2 logs warmup-agent` to see the error message

### Emails not sending
- Check that today is a weekday and within 6am–8am send window
- Check `pm2 logs warmup-agent` for queue/send errors
- Verify Anthropic API key is valid

### IMAP cleanup not working
- Fill in `IMAP_PASSWORD_<DOMAIN_SLUG>` for each domain in `.env`
- Make sure you're using Gmail App Passwords (not your account password)
- Check `pm2 logs warmup-agent` for IMAP errors

### better-sqlite3 fails to install
```bash
sudo apt-get install -y build-essential python3
npm install
```
Node native modules require compilation tools on ARM64.

### PM2 doesn't survive reboot
```bash
pm2 startup
# Run the sudo command it outputs
pm2 save
```

### Check database state
```bash
sqlite3 data/warmup.db
.tables
SELECT * FROM domain_stats;
SELECT COUNT(*) FROM sent_emails;
SELECT * FROM send_queue WHERE status='pending' LIMIT 10;
.quit
```

---

## Author

**Naveen Madhavan**

### Certifications

- AWS Certified Security – Specialty (SCS-C02)
- AWS Certified Solutions Architect – Associate (SAA-C03)
- AWS Certified Cloud Practitioner

---

## License

MIT License — Copyright (c) 2026 Naveen Madhavan

Use it, fork it, build on it. See [LICENSE](LICENSE) for full terms.
