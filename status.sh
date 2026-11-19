#!/usr/bin/env bash
#
# status.sh — databaseMCP durumunu gösterir.
#
# Gösterir:
#   - node / npm sürümü
#   - node_modules kurulu mu
#   - FreeTDS (tsql) durumu
#   - master anahtar (neden geliyor: ortam değişkeni mi, dosya mı)
#   - config dosyaları (global + proje)
#   - kayıtlı bağlantılar ve ortam grupları (test: N, prod: M)
#
# Kullanım: ./status.sh [--help]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ -t 1 ]; then
  BOLD='\033[1m'; GREEN='\033[32m'; RED='\033[31m'; YELLOW='\033[33m'; CYAN='\033[36m'; RESET='\033[0m'
else
  BOLD=''; GREEN=''; RED=''; YELLOW=''; CYAN=''; RESET=''
fi
ok()  { printf '%s[✓]%s %s\n' "$GREEN" "$RESET" "$*"; }
warn(){ printf '%s[!]%s %s\n' "$YELLOW" "$RESET" "$*"; }
err() { printf '%s[✗]%s %s\n' "$RED" "$RESET" "$*" >&2; }
info(){ printf '%s[*]%s %s\n' "$CYAN" "$RESET" "$*"; }

usage() {
  cat <<EOF
Kullanım: $(basename "$0") [--help]

  databaseMCP durumunu özetler (bağımlılıklar, anahtar, config, bağlantılar).
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    *) err "Bilinmeyen argüman: $1"; usage; exit 2 ;;
  esac
done

printf '%s%s== databaseMCP Durum ==%s\n' "$BOLD" "$CYAN" "$RESET"

# ---- node / npm ------------------------------------------------------------
command -v node >/dev/null 2>&1 && ok "node $(node -v)" || err "node bulunamadı"
command -v npm  >/dev/null 2>&1 && info "npm $(npm -v)"  || warn "npm bulunamadı"

# ---- node_modules ----------------------------------------------------------
[ -d node_modules ] && ok "node_modules kurulu" || warn "node_modules yok. ./install.sh çalıştırın."

# ---- FreeTDS (Sybase) ------------------------------------------------------
command -v tsql >/dev/null 2>&1 && ok "FreeTDS (tsql) mevcut" || warn "FreeTDS (tsql) yok — Sybase bağlantıları çalışmaz"

# ---- master anahtar --------------------------------------------------------
printf '\n%s%s== Master anahtar ==%s\n' "$BOLD" "$CYAN" "$RESET"
if [ -n "${DATABASEMCP_MASTER_KEY:-}" ]; then
  ok "ortam değişkeni DATABASEMCP_MASTER_KEY ayarlı (kullanılıyor)"
else
  KEY_PATH="$HOME/.config/databaseMCP/master.key"
  if [ -f "$KEY_PATH" ]; then ok "dosya: $KEY_PATH"; else warn "master.key yok: $KEY_PATH (./install.sh ile üretin)"; fi
fi

# ---- config dosyaları ------------------------------------------------------
printf '\n%s%s== Config ==%s\n' "$BOLD" "$CYAN" "$RESET"
GLOBAL_CONFIG="$HOME/.config/databaseMCP/config.json"
if [ -f "$GLOBAL_CONFIG" ]; then ok "global: $GLOBAL_CONFIG"; else warn "global config yok: $GLOBAL_CONFIG"; fi
PROJECT_CONFIG="${DATABASEMCP_CONFIG:-$SCRIPT_DIR/config.json}"
if [ -f "$PROJECT_CONFIG" ]; then ok "proje: $PROJECT_CONFIG"; else warn "proje config yok: $PROJECT_CONFIG"; fi

# ---- bağlantılar / ortam grupları ------------------------------------------
printf '\n%s%s== Bağlantılar ==%s\n' "$BOLD" "$CYAN" "$RESET"
node -e '
const config = require("./src/config");
try {
  const { connections } = config.loadConfig();
  const byEnv = {};
  for (const name of Object.keys(connections)) {
    const c = connections[name];
    const e = c.environment || "?";
    (byEnv[e] = byEnv[e] || []).push(name + " [" + (c.id || "?") + "]");
  }
  const envs = Object.keys(byEnv).sort();
  if (envs.length === 0) {
    console.log("  (bağlantı yok)");
  } else {
    console.log("  ortam grupları: " + envs.map(e => e + ": " + byEnv[e].length).join(", "));
    for (const e of envs) {
      for (const line of byEnv[e]) console.log("    - " + line);
    }
  }
} catch (e) {
  console.log("  bağlantılar okunamadı: " + (e && e.message ? e.message : e));
}
'
