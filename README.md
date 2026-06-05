# Email Warmup Agent

A production-ready, self-hosted email warm-up daemon built for Raspberry Pi. Automatically sends AI-generated, human-like emails between your domains in a circular ring topology, manages progressive volume ramp-up, and runs nightly IMAP cleanup — all with zero manual intervention.

Built to solve a real problem: cold domains sent to spam. This agent brings new domains to inbox reputation without relying on paid warm-up SaaS tools.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         Raspberry Pi (PM2)                      │
│                                                                 │
│  ┌──────────┐   ┌───────────┐   ┌──────────┐   ┌───────────┐  │
│  │  Scheduler│──▶│ Generator │──▶│  Mailer  │──▶│  SQLite   │  │
│  │ (node-cron│   │ (Claude AI)   │(Nodemailer   │  (WAL mode│  │
│  │  60s tick)│   │           │   │+ Brevo)  │   │           │  │
│  └──────────┘   └───────────┘   └──────────┘   └──────────┘  │
│                                                      │          │
│  ┌──────────────────────────────────────────────┐   │          │
│  │          IMAP Cleanup (3am nightly)           │◀──┘          │
│  │  imapflow · move-to-trash · hard-delete >7d  │              │
│  └──────────────────────────────────────────────┘              │
└─────────────────────────────────────────────────────────────────┘
```

**Send flow:**  
`Scheduler` → reads `config.json` ring → calls `Claude API` to generate a contextual email → sends via `Brevo SMTP` → logs to `SQLite` → `IMAP cleanup` removes warmup emails 24h–7d later.

---

## Key Features

- **AI-generated content** — Every email is uniquely written by Claude (Anthropic) with business-context-aware prompts. No templates. No detectable patterns.
- **Circular domain ring** — N domains send to each other in sequence. Each domain receives and sends, building two-way trust signals.
- **Progressive ramp schedule** — Volume scales from 2 to 40 emails/day over 60 days, then drops to 8/day maintenance. Follows industry warm-up best practices.
- **IMAP auto-cleanup** — Warmup emails are automatically moved to trash after 24h and hard-deleted after 7 days. Emails with replies are preserved as trust signals.
- **Crash-safe state** — All state lives in SQLite with WAL mode. PM2 autorestart + on-boot startup means the agent survives power cuts with no manual recovery.
- **Time-window aware** — Sends only on weekdays within a configured hour window (default 6–8am) to mimic human behaviour.
- **Zero dependencies on external warm-up services** — Self-contained. Runs entirely on a $35 device.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20 (LTS) |
| Email generation | Anthropic Claude API (`claude-sonnet-4-*`) |
| SMTP delivery | Nodemailer + Brevo SMTP relay |
| IMAP cleanup | imapflow |
| State persistence | better-sqlite3 (WAL mode) |
| Scheduling | node-cron + setInterval (60s tick) |
| Process management | PM2 (autorestart, log rotation, boot hook) |
| Hardware | Raspberry Pi (ARM64, any model with Node 20 support) |

---

## Quick Start

### Prerequisites

- Raspberry Pi running Raspberry Pi OS (or Ubuntu Server for Pi)
- [Brevo](https://brevo.com) account with SMTP enabled (free tier works)
- [Anthropic API key](https://console.anthropic.com)
- Gmail App Passwords for each domain (for IMAP cleanup)

### Installation

```bash
# 1. Clone the repo
git clone https://github.com/YOUR_USERNAME/warmup-agent.git

# 2. Copy to your Pi
scp -r warmup-agent pi@<pi-ip>:/home/pi/

# 3. SSH into the Pi
ssh pi@<pi-ip>

# 4. Run the automated setup script
cd /home/pi/warmup-agent
bash setup-pi.sh

# 5. Fill in IMAP passwords (one per domain)
nano .env

# 6. Restart to apply
pm2 restart warmup-agent
```

---

## Configuration

All behaviour is controlled via `config.json` — no code changes needed.

### Domain Ring

Add your domains to `domainRing`. Emails flow A → B → C → ... → A.

```json
"domainRing": [
  {
    "domain": "yourdomain1.com",
    "niche": "cloud security consulting",
    "senders": ["admin@yourdomain1.com", "support@yourdomain1.com"]
  },
  {
    "domain": "yourdomain2.com",
    "niche": "SaaS product development",
    "senders": ["hello@yourdomain2.com"]
  }
]
```

The `niche` field is injected into the Claude prompt so email content is contextually relevant to each domain's business.

### Send Window

```json
"timezone": "America/New_York",
"sendWindow": { "startHour": 6, "endHour": 8 },
"weekdaysOnly": true
```

### Ramp Schedule

```json
"rampSchedule": [
  { "dayFrom": 1,  "dayTo": 7,  "emailsPerDay": 2 },
  { "dayFrom": 8,  "dayTo": 14, "emailsPerDay": 4 },
  { "dayFrom": 15, "dayTo": 21, "emailsPerDay": 10 },
  { "dayFrom": 22, "dayTo": 30, "emailsPerDay": 20 },
  { "dayFrom": 31, "dayTo": 60, "emailsPerDay": 40 },
  { "dayFrom": 61, "dayTo": 99999, "emailsPerDay": 8 }
]
```

Volume never more than doubles per week. After Day 60 the agent shifts to 8 emails/day maintenance mode indefinitely.

---

## IMAP Auto-Cleanup

The cleanup job runs **nightly at 3am** and **5 minutes after every startup** (to catch missed runs from power cuts).

| Condition | Action |
|---|---|
| Email has a reply (`In-Reply-To` match) | **Keep** — marks as `kept_reply` (genuine engagement signal) |
| Age < 7 days, no reply | Move to Trash |
| Age ≥ 7 days, no reply | Hard delete (permanent) |

Only emails tagged with the `X-Warmup: true` header are touched — real inbox email is never affected.

---

## Environment Variables

Copy `.env.example` to `.env` and fill in your values:

```env
BREVO_SMTP_LOGIN=your_brevo_login@example.com
BREVO_SMTP_KEY=your_brevo_smtp_api_key
ANTHROPIC_API_KEY=sk-ant-...

# One per domain (slug = domain with . and - replaced by _, uppercased)
IMAP_PASSWORD_YOURDOMAIN1_COM=your-gmail-app-password
IMAP_PASSWORD_YOURDOMAIN2_COM=your-gmail-app-password
```

**Getting a Gmail App Password:**
1. Google Account → Security → 2-Step Verification → App passwords
2. Create for "Mail" on "Other device"
3. Use the 16-character password

---

## PM2 Commands

```bash
pm2 status                          # Agent health and uptime
pm2 logs warmup-agent               # Live log tail
pm2 logs warmup-agent --lines 200   # Last 200 lines
pm2 restart warmup-agent            # Restart
pm2 monit                           # Full monitoring dashboard
```

---

## Database Inspection

```bash
sqlite3 data/warmup.db

.tables
SELECT * FROM domain_stats;
SELECT COUNT(*) FROM sent_emails WHERE status = 'sent';
SELECT * FROM deletion_log ORDER BY logged_at DESC LIMIT 20;
.quit
```

**Tables:**

| Table | Purpose |
|---|---|
| `domain_stats` | Per-domain ramp start date, daily/total counts |
| `sent_emails` | Message tracking with scheduled delete timestamps |
| `send_queue` | Today's pre-scheduled sends with jittered times |
| `deletion_log` | Full audit trail of every IMAP cleanup action |

---

## Troubleshooting

**Agent won't start — SMTP error**
- Verify `BREVO_SMTP_LOGIN` and `BREVO_SMTP_KEY` in `.env`
- Confirm SMTP is enabled in your Brevo account settings
- Check: `pm2 logs warmup-agent`

**Emails not sending**
- Confirm today is a weekday and within the configured send window
- Check: `pm2 logs warmup-agent` for queue/send errors
- Verify Anthropic API key is valid and has credit

**IMAP cleanup not working**
- Fill in `IMAP_PASSWORD_<DOMAIN_SLUG>` for each domain
- Ensure you're using Gmail App Passwords, not account passwords
- Check: `pm2 logs warmup-agent` for IMAP errors

**`better-sqlite3` fails to install on ARM64**
```bash
sudo apt-get install -y build-essential python3
npm install
```

**PM2 doesn't survive reboot**
```bash
pm2 startup
# Run the sudo command it outputs
pm2 save
```

---

## Project Structure

```
warmup-agent/
├── index.js          # Main entry point — boot, scheduler, send loop
├── generator.js      # Claude API integration — AI email generation
├── mailer.js         # Nodemailer/Brevo SMTP transport
├── cleanup.js        # IMAP cleanup (nightly + startup)
├── db.js             # SQLite layer (WAL mode, all queries)
├── logger.js         # Structured logger — console + rolling daily files
├── config.json       # Domain ring, ramp schedule, send window
├── ecosystem.config.js  # PM2 process definition
├── setup-pi.sh       # One-shot Raspberry Pi setup script
├── .env.example      # Environment variable template
├── data/             # SQLite database (git-ignored)
└── logs/             # Daily rolling log files (git-ignored)
```

---

## Design Decisions

**Why Raspberry Pi?**  
Always-on, low power ($5/yr in electricity), ARM64 Node support is excellent. No cloud compute costs.

**Why Brevo for SMTP?**  
Free tier supports 300 emails/day. Good deliverability for relay. Easy API key rotation.

**Why SQLite over PostgreSQL?**  
Zero operational overhead on a Pi. WAL mode gives crash safety. The write volume (a few dozen rows/day) doesn't justify a server database.

**Why AI-generated email content?**  
Spam filters are trained on repetitive templates. Unique, contextually relevant email content per send avoids pattern detection — the same reason human-written warmup emails work better than templates.

---

## Author

**Naveen Madhavan**  
AWS Security Professional | Cloud Architect | Builder  
[![GitHub](https://img.shields.io/badge/GitHub-CloudArchitectPro-181717?logo=github)](https://github.com/CloudArchitectPro)

---

## License

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

MIT © 2026 Naveen Madhavan — see [LICENSE](LICENSE) for full terms and usage disclaimers.
