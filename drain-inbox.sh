#!/bin/bash
# ═══════════════════════════════════════════════════
#  Nuvatron Warm-up Agent — Manual Inbox Drain
#  Runs in DRAIN_MODE: fast timing, window bypassed
#  Processes up to 15 × 30 = 450 emails
# ═══════════════════════════════════════════════════

cd "$(dirname "$0")"

echo "=== Nuvatron Inbox Drain Starting ==="
echo "=== DRAIN_MODE: fast timing, window bypassed ==="
echo ""

for i in {1..15}; do
  echo "=== Run $i / 15 ==="
  DRAIN_MODE=true node -e "require('./engager').runEngager().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); })"
  EXIT=$?
  if [ $EXIT -ne 0 ]; then
    echo "=== Run $i failed (exit $EXIT) — continuing ==="
  fi
  echo ""
done

pm2 restart warmup-agent --update-env
echo ""
echo "=== Done! Agent restarted in normal mode. ==="
