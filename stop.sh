#!/usr/bin/env bash
#
# stop.sh — çalışan databaseMCP sunucusunu durdurur.
#
# node src/server.js olarak çalışan MCP sunucusunu bulup durdurur.
#
# Kullanım: ./stop.sh [--help]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ -t 1 ]; then
  GREEN='\033[32m'; RED='\033[31m'; YELLOW='\033[33m'; CYAN='\033[36m'; RESET='\033[0m'
else
  GREEN=''; RED=''; YELLOW=''; CYAN=''; RESET=''
fi
ok()  { printf '%s[✓]%s %s\n' "$GREEN" "$RESET" "$*"; }
warn(){ printf '%s[!]%s %s\n' "$YELLOW" "$RESET" "$*"; }
err() { printf '%s[✗]%s %s\n' "$RED" "$RESET" "$*" >&2; }

usage() {
  cat <<EOF
Kullanım: $(basename "$0") [--help]

  node src/server.js olarak çalışan MCP sunucusunu durdurur.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    *) err "Bilinmeyen argüman: $1"; usage; exit 2 ;;
  esac
done

# node src/server.js process'ini bul (bu script'in kendisi eşleşmez)
PIDS="$(pgrep -f "node .*src/server\.js" || true)"

if [ -z "$PIDS" ]; then
  warn "çalışan databaseMCP sunucu yok."
  exit 0
fi

printf '%s[*]%s durdurulan process(ler): %s\n' "$CYAN" "$RESET" "$PIDS"
for PID in $PIDS; do
  kill -0 "$PID" 2>/dev/null && kill "$PID" 2>/dev/null || true
done

# Birkaç saniye bekip hala durmadıysa zorla durdur
for _ in 1 2 3 4 5; do
  STILL="$(pgrep -f "node .*src/server\.js" || true)"
  [ -z "$STILL" ] && break
  sleep 0.2
done

STILL="$(pgrep -f "node .*src/server\.js" || true)"
if [ -n "$STILL" ]; then
  warn "zorla durduruluyor..."
  kill -9 $STILL 2>/dev/null || true
  ok "zorla durduruldu."
else
  ok "sunuyu durdu."
fi
