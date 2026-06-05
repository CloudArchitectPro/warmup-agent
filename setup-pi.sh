#!/usr/bin/env bash
set -euo pipefail

# ─── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
die()     { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }

# ─── Detect home directory (works for 'pi', ubuntu, or any user) ──────────────
AGENT_USER="${SUDO_USER:-$(whoami)}"
AGENT_HOME=$(eval echo "~${AGENT_USER}")
AGENT_DIR="${AGENT_HOME}/warmup-agent"
ENV_FILE="${AGENT_DIR}/.env"

[[ "$(id -u)" != "0" ]] || die "Do not run this script as root. Run as your normal user."

echo -e "\n${CYAN}════════════════════════════════════════════════════${NC}"
echo -e "${CYAN}   Warmup Agent — Raspberry Pi Setup Script         ${NC}"
echo -e "${CYAN}════════════════════════════════════════════════════${NC}\n"

# ─── System dependencies ──────────────────────────────────────────────────────
info "Installing system dependencies (build-essential, python3, git, curl)..."
sudo apt-get update -qq
sudo apt-get install -y -qq build-essential python3 git curl
success "System dependencies installed"

# ─── NVM + Node 20 ────────────────────────────────────────────────────────────
if [ ! -d "$HOME/.nvm" ]; then
  info "Installing NVM..."
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
  success "NVM installed"
else
  info "NVM already installed — skipping"
fi

export NVM_DIR="$HOME/.nvm"
# shellcheck source=/dev/null
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

info "Installing Node 20..."
nvm install 20
nvm use 20
nvm alias default 20
success "Node $(node -v) active"

# ─── PM2 ──────────────────────────────────────────────────────────────────────
if ! command -v pm2 &>/dev/null; then
  info "Installing PM2 globally..."
  npm install -g pm2
  success "PM2 installed"
else
  info "PM2 already installed — skipping"
fi

# ─── Project directory ────────────────────────────────────────────────────────
if [ ! -d "$AGENT_DIR" ]; then
  die "Agent directory not found at $AGENT_DIR. Please copy the project files there first."
fi

cd "$AGENT_DIR"
info "Working in $AGENT_DIR"

# ─── npm install ──────────────────────────────────────────────────────────────
info "Running npm install (this may take a few minutes on ARM64)..."
npm install
success "npm packages installed"

# ─── Create required directories ──────────────────────────────────────────────
mkdir -p data logs
success "data/ and logs/ directories created"

# ─── Collect credentials ──────────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}Please enter your credentials (input hidden where sensitive):${NC}"
echo ""

read -rp "  Brevo SMTP login (your Brevo account email): " BREVO_LOGIN
read -rsp "  Brevo SMTP key (API key from Brevo SMTP settings): " BREVO_KEY
echo ""
read -rsp "  Anthropic API key: " ANTHROPIC_KEY
echo ""

# ─── Write .env ───────────────────────────────────────────────────────────────
info "Writing .env ..."

# Dynamically generate IMAP_PASSWORD_ entries from config.json domainRing
IMAP_ENTRIES=""
if command -v node &>/dev/null && [ -f config.json ]; then
  while IFS= read -r slug; do
    IMAP_ENTRIES+=$'\n'"IMAP_PASSWORD_${slug}="
  done < <(node -e "
    const cfg = require('./config.json');
    cfg.domainRing.forEach(d => {
      const slug = d.domain.replace(/[\.\-]/g, '_').toUpperCase();
      console.log(slug);
    });
  ")
fi

cat > "$ENV_FILE" <<EOF
# ─── Brevo SMTP ───────────────────────────────────────────────────────────────
BREVO_SMTP_HOST=smtp-relay.brevo.com
BREVO_SMTP_PORT=587
BREVO_SMTP_LOGIN=${BREVO_LOGIN}
BREVO_SMTP_KEY=${BREVO_KEY}

# ─── Anthropic Claude API ─────────────────────────────────────────────────────
ANTHROPIC_API_KEY=${ANTHROPIC_KEY}

# ─── SQLite DB path ───────────────────────────────────────────────────────────
DB_PATH=${AGENT_DIR}/data/warmup.db

# ─── IMAP passwords (fill in each one) ───────────────────────────────────────
${IMAP_ENTRIES}

# ─── Optional IMAP user override (blank = use first sender) ──────────────────
# IMAP_USER_YOURDOMAIN1_COM=
EOF

chmod 600 "$ENV_FILE"
success ".env written with 600 permissions"

# ─── Export AGENT_DIR for ecosystem.config.js ─────────────────────────────────
export AGENT_DIR

# ─── Start agent with PM2 ─────────────────────────────────────────────────────
info "Starting warmup-agent with PM2..."
pm2 start ecosystem.config.js
success "Agent started"

info "Saving PM2 process list..."
pm2 save

info "Setting up PM2 startup hook..."
PM2_STARTUP=$(pm2 startup | grep "sudo env" || true)
if [ -n "$PM2_STARTUP" ]; then
  echo ""
  warn "Run this command to enable PM2 on boot:"
  echo -e "${YELLOW}${PM2_STARTUP}${NC}"
  echo ""
else
  pm2 startup systemd -u "${AGENT_USER}" --hp "${AGENT_HOME}" || warn "Could not auto-configure PM2 startup — run 'pm2 startup' manually"
fi

# ─── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}   Setup complete!                                  ${NC}"
echo -e "${GREEN}════════════════════════════════════════════════════${NC}"
echo ""
echo "  Next steps:"
echo "  1. Fill in IMAP passwords in: $ENV_FILE"
echo "  2. Run 'pm2 logs warmup-agent' to watch live logs"
echo "  3. Run 'pm2 status' to check agent health"
echo ""
