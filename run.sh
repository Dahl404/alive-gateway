#!/usr/bin/env bash
# Supervisor: keeps the gateway and a public tunnel alive, and keeps public.url current.
# Quick-tunnel hostnames rotate, so this rewrites public.url whenever a new one appears.
set -u
cd "$(dirname "$0")"
mkdir -p logs
export PAY_TO=$(cat wallet.addr)
export FACILITATOR=${FACILITATOR:-https://x402.dexter.cash}
export PORT=${PORT:-8080}
export PRICE_USD=${PRICE_USD:-0.005}
if [ -z "${UPSTREAM_KEY:-}" ]; then
  UPSTREAM_KEY=$(python3 -c "import json;print(json.load(open('$HOME/.selesai/agent/auth.json'))['openrouter']['key'])")
  export UPSTREAM_KEY
fi

[ -x ./bin-cloudflared ] || { echo "missing bin-cloudflared"; exit 1; }

# gateway
if ! curl -sf -m 3 "http://127.0.0.1:$PORT/health" >/dev/null; then
  nohup node gateway.js >> logs/gw.log 2>&1 &
  echo "started gateway pid $!"
fi

# tunnel, restarted whenever it dies or the hostname changes
while true; do
  if ! pgrep -f 'cloudflared tunnel --url' >/dev/null; then
    nohup ./bin-cloudflared tunnel --url "http://127.0.0.1:$PORT" --no-autoupdate >> logs/tunnel.log 2>&1 &
    sleep 15
  fi
  url=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' logs/tunnel.log | tail -1)
  if [ -n "${url:-}" ] && [ "$url" != "$(cat public.url 2>/dev/null)" ]; then
    printf '%s\n' "$url" > public.url
    printf '%s  url %s\n' "$(date -u +%FT%TZ)" "$url" >> logs/url.log
  fi
  # a live endpoint must answer 402, not 200 or a tunnel error page
  code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' -X POST "${url:-http://127.0.0.1:$PORT}/v1/chat/completions" -d '{}' 2>/dev/null)
  if [ "${code:-000}" != "402" ]; then
    echo "$(date -u +%FT%TZ) bad challenge code=$code, restarting tunnel" >> logs/url.log
    pkill -f 'cloudflared tunnel --url' 2>/dev/null
    sleep 3
  fi
  sleep 60
done
