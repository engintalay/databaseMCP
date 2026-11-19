#!/usr/bin/env bash
#
# install.sh — databaseMCP bağımlılıklarını kurar ve master anahtar üretir.
#
# Ne yapar:
#   1. node / npm var mı kontrol eder
#   2. npm ci (veya npm install) ile node_modules kurar
#   3. FreeTDS (tsql) var mı kontrol eder — Sybase için gerekli
#   4. master anahtar üretir (~/.config/databaseMCP/master.key, izin 0600)
#      - zaten varsa --force verilmedikçe dokunmaz
#   5. Mevcut şifreli değerleri (global + proje config VE dbpassword.json)
#      yeni anahtarla yeniden şifreler (scripts/migrate-keys.js)
#
# Kullanım: ./install.sh [--force-key] [--help]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

KEY_FORCE=0

# ---- Renkler (renk yoksa devre dışı) ---------------------------------------
if [ -t 1 ]; then
  BOLD='\033[1m'; GREEN='\033[32m'; RED='\033[31m'; YELLOW='\033[33m'; CYAN='\033[36m'; RESET='\033[0m'
else
  BOLD=''; GREEN=''; RED=''; YELLOW=''; CYAN=''; RESET=''
fi
ok()   { printf '%s[✓]%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '%s[!]%s %s\n' "$YELLOW" "$RESET" "$*"; }
err()  { printf '%s[✗]%s %s\n' "$RED" "$RESET" "$*" >&2; }
info() { printf '%s[*]%s %s\n' "$CYAN" "$RESET" "$*"; }

usage() {
  cat <<EOF
Kullanım: $(basename "$0") [--force-key] [--help]

  --force-key   Mevcum master anahtarını da yeniden üret. Eski şifreli değerler
                (config içindeki enc:... ve dbpassword.json'daki {id: enc:...}) otomatik olarak yeni anahtarla
                yeniden şifrlenir.
  --help        Bu yardımı göster.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --force-key) KEY_FORCE=1; shift ;;
    --help|-h)   usage; exit 0 ;;
    *) err "Bilinmeyen argüman: $1"; usage; exit 2 ;;
  esac
done

# ---- 1. node / npm ---------------------------------------------------------
info "node / npm sürümü kontrol ediliyor..."
if ! command -v node >/dev/null 2>&1; then err "node bulunamadı. Önce yükleyin."; exit 1; fi
if ! command -v npm >/dev/null 2>&1; then err "npm bulunamadı."; exit 1; fi
ok "node $(node -v) | npm $(npm -v)"

# ---- 2. bağımlılıklar ------------------------------------------------------
info "bağımlılıklar kuruluyor..."
if [ -f package-lock.json ]; then
  npm ci
else
  warn "package-lock.json yok, npm install kullanılıyor..."
  npm install
fi
ok "node_modules kuruldu."

# ---- 3. FreeTDS (Sybase) ---------------------------------------------------
info "FreeTDS (tsql) kontrol ediliyor..."
if command -v tsql >/dev/null 2>&1; then
  ok "tsql bulundu (Sybase uyumlu)."
else
  warn "tsql (FreeTDS) bulunamadı. Sybase bağlantıları için gerekli."
  if command -v apt-get >/dev/null 2>&1; then
    info "Kurulum: sudo apt-get install -y freetds-bin"
  elif command -v brew >/dev/null 2>&1; then
    info "Kurulum: brew install freetds"
  fi
fi

# ---- 4. master anahtar -----------------------------------------------------
KEY_PATH="$HOME/.config/databaseMCP/master.key"
mkdir -p "$(dirname "$KEY_PATH")"

# Eski anahtarı oku (rotasyon için migrate-keys.js'ye DATABASEMCP_OLD_KEY ile verilir).
OLD_KEY=""
if [ -f "$KEY_PATH" ]; then
  OLD_KEY="$(tr -d '[:space:]' < "$KEY_PATH")"
fi

if [ "$KEY_FORCE" -eq 1 ]; then
  info "master anahtar yenileniyor (--force-key)..."
  NEW_KEY="$(node -e "console.log(require('./src/crypto').generateMasterKeyHex())")"
elif [ -n "$OLD_KEY" ]; then
  ok "master anahtar mevcut: $KEY_PATH (kullanılıyor. --force-key ile yenilebilir)."
  NEW_KEY="$OLD_KEY"
else
  info "master anahtar üretiliyor..."
  NEW_KEY="$(node -e "console.log(require('./src/crypto').generateMasterKeyHex())")"
fi

# ---- 5. şifreli değerleri YENİ anahtarla yenile ----------------------------
# Anahtar rotasyonunda önceki anahtar DATABASEMCP_OLD_KEY ile geçilir.
# migrate-keys.js GÜVENLİK (fail-closed) göçü: çözülemeyen değer varsa
# yazmadan DURUR (çıkış kodu 1). Bu satırdan sonra gelinirse göç BAŞARILI demektir
# ve master.key YENİ anahtarla güncellenir. Göç başarısızsa anahtar dosyası
# DEĞİŞTİRİLMEZ; eski anahtarla veriler hâlâ çözülebilir (veri kaybı yok).
info "mevcum şifreli değerler yeni anahtarla yenileniyor..."
if [ -n "$OLD_KEY" ]; then
  DATABASEMCP_OLD_KEY="$OLD_KEY" \
  DATABASEMCP_MASTER_KEY="$NEW_KEY" \
  node "$SCRIPT_DIR/scripts/migrate-keys.js"
else
  DATABASEMCP_MASTER_KEY="$NEW_KEY" \
  node "$SCRIPT_DIR/scripts/migrate-keys.js"
fi

# Göç başarılıysa yeni anahtarı kaydet.
printf '%s\n' "$NEW_KEY" > "$KEY_PATH"
chmod 0600 "$KEY_PATH"
ok "master anahtar kaydedildi: $KEY_PATH (izin 0600)"

ok "kurulum tamam."
