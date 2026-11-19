#!/usr/bin/env bash
#
# run.sh — databaseMCP MCP stdio sunucusunu başlatır.
#
# OpenCode gibi bir MCP client, bu stdio sunucusuna bağlanır.
# Ortam değişkenleri:
#   DATABASEMCP_CONFIG       Proje config dosyası yolu (opsiyonel).
#   DATABASEMCP_MASTER_KEY   Master anahtar (hex, 32 byte) (opsiyonel).
#
# Kullanım: ./run.sh [--help]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ---- Renkler ----------------------------------------------------------------
if [ -t 1 ]; then
  GREEN='\033[32m'; RED='\033[31m'; YELLOW='\033[33m'; CYAN='\033[36m'; RESET='\033[0m'
else
  GREEN=''; RED=''; YELLOW=''; CYAN=''; RESET=''
fi

usage() {
  cat <<EOF
Kullanım: $(basename "$0") [--help]

  MCP stdio sunucusunu başlatır (OpenCode vb. client bağlar).

  Ortam değişkenleri:
    DATABASEMCP_CONFIG       Proje config yolu (opsiyonel).
    DATABASEMCP_MASTER_KEY   Master anahtar hex (opsiyonel).
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    *) printf '%s[✗]%s Bilinmeyen argüman: %s\n' "$RED" "$RESET" "$1" >&2; usage; exit 2 ;;
  esac
done

if ! command -v node >/dev/null 2>&1; then
  printf '%s[✗]%s node bulunamadı. ./install.sh çalıştırın.\n' "$RED" "$RESET" >&2
  exit 1
fi

# Temiz durdurma (Ctrl+C / TERM)
cleanup() {
  printf '\n%s[*]%s sunuyu durduruyor...\n' "$CYAN" "$RESET"
  if [ -n "${SERVER_PID:-}" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup INT TERM

printf '%s[*]%s databaseMCP başlatılıyor: node src/server.js\n' "$CYAN" "$RESET"
node src/server.js &
SERVER_PID=$!
wait "$SERVER_PID"
