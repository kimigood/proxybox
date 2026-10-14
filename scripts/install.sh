#!/bin/sh
# ProxyBox installer for OpenWrt (x86_64 / aarch64).
#
#   install.sh [--port 3037] [<proxybox-*.tar.gz or URL>]
#
# With no tarball argument it pulls the latest release from GitHub.
#
# Fresh implementation for the ProxyBox project.
set -eu

TARBALL=""
PORT=3037
while [ "$#" -gt 0 ]; do
  case "$1" in
    --port) PORT="${2:?missing port}"; shift 2 ;;
    -*) echo "[proxybox] ERROR: unknown option: $1" >&2; exit 1 ;;
    *) [ -z "$TARBALL" ] || { echo "[proxybox] ERROR: only one tarball argument" >&2; exit 1; }; TARBALL="$1"; shift ;;
  esac
done

ROOT=/opt/proxybox
SINGBOX_VERSION=1.13.14
NODE_VERSION=22.23.3
# GitHub repo hosting releases (override with PROXYBOX_REPO=owner/repo).
GITHUB_REPO="${PROXYBOX_REPO:-kimigood/proxybox}"

die() { echo "[proxybox] ERROR: $*" >&2; exit 1; }
info() { echo "[proxybox] $*"; }

if [ -z "$TARBALL" ]; then
  # Default: reassemble the release tarball from base64 chunks committed in
  # the repo (releases/<version>/). No GitHub Release needed.
  RV="${PROXYBOX_VERSION:-0.1.0}"
  RBASE="https://raw.githubusercontent.com/$GITHUB_REPO/main/releases/v$RV"
  info "fetching ProxyBox v$RV release manifest from github.com/$GITHUB_REPO..."
  MF=/tmp/pbmanifest.txt
  wget -qO "$MF" "$RBASE/manifest.txt" || die "cannot fetch release manifest ($RBASE/manifest.txt)"
  # shellcheck disable=SC1090
  . "$MF" # sets: version, sha256, chunks
  [ -n "${chunks:-}" ] && [ -n "${sha256:-}" ] || die "bad release manifest"
  info "downloading ${version} ($(echo "$chunks" | wc -w) chunks)..."
  rm -rf /tmp/pbchunks && mkdir -p /tmp/pbchunks
  for c in $chunks; do
    wget -qO "/tmp/pbchunks/$c" "$RBASE/$c" || die "chunk $c download failed"
  done
  cat /tmp/pbchunks/chunk-* | base64 -d > /tmp/proxybox.tar.gz
  rm -rf /tmp/pbchunks
  printf '%s  /tmp/proxybox.tar.gz\n' "$sha256" | sha256sum -c - >/dev/null \
    || die "sha256 mismatch on reassembled tarball"
  info "release verified."
  TARBALL=/tmp/proxybox.tar.gz
fi
[ "$(id -u)" = "0" ] || die "run as root"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64) SB_ARCH=amd64 ;;
  aarch64) SB_ARCH=arm64 ;;
  *) die "unsupported architecture: $ARCH (need x86_64 or aarch64)" ;;
esac
[ -f /etc/openwrt_release ] || die "OpenWrt required"

# --- conflict check: another transparent proxy already here? ---
# ProxyBox and Open-Box would fight over the panel port, the tun default
# route, clash_api and DNS. Refuse to install alongside a RUNNING instance.
if [ -x /etc/init.d/openbox ] && /etc/init.d/openbox running 2>/dev/null; then
  die "Open-Box core is running on this machine. Installing ProxyBox alongside it would break networking (port 3036, tun routes, DNS). Stop and disable Open-Box first if you want to replace it -- or better, test ProxyBox on a separate machine/VM."
fi
if [ -x /etc/init.d/openbox-panel ] && /etc/init.d/openbox-panel running 2>/dev/null; then
  die "Open-Box panel is running on this machine (port 3036). Stop it first, or install ProxyBox with --port <free-port> on a test machine."
fi
if ss -ltn 2>/dev/null | grep -q ":$PORT "; then
  die "port $PORT is already in use on this machine. Re-run with --port <free-port>."
fi
[ -d /opt/open-box ] && info "NOTE: /opt/open-box exists but is stopped; continuing."

# --- fetch tarball ---
case "$TARBALL" in
  http://*|https://*) info "downloading $TARBALL"; wget -O /tmp/proxybox.tar.gz "$TARBALL" || die "download failed"; TARBALL=/tmp/proxybox.tar.gz ;;
esac
[ -f "$TARBALL" ] || die "tarball not found: $TARBALL"
if [ -f "$TARBALL.sha256" ]; then
  info "verifying sha256..."
  (cd "$(dirname "$TARBALL")" && sha256sum -c "$(basename "$TARBALL").sha256") || die "sha256 mismatch"
fi

# --- deps ---
info "installing dependencies..."
opkg update >/dev/null 2>&1 || true
for pkg in kmod-tun ca-bundle; do
  opkg list-installed 2>/dev/null | grep -q "^$pkg " || opkg install "$pkg" || info "(optional) $pkg not installed"
done

# --- lay down files (keep data/ across upgrades) ---
if [ -d "$ROOT/data" ]; then
  info "backing up existing data..."
  rm -rf /tmp/proxybox-data-backup
  cp -a "$ROOT/data" /tmp/proxybox-data-backup
  /etc/init.d/proxybox-core stop 2>/dev/null || true
  /etc/init.d/proxybox-panel stop 2>/dev/null || true
fi
info "extracting to $ROOT..."
rm -rf /tmp/pbinstall && mkdir -p /tmp/pbinstall
tar -xzf "$TARBALL" -C /tmp/pbinstall
PKGDIR="$(find /tmp/pbinstall -maxdepth 1 -name "proxybox-*" -type d | head -1)"
[ -n "$PKGDIR" ] || die "cannot find package dir inside tarball"
mkdir -p "$ROOT"
rm -rf "$ROOT/panel" "$ROOT/server" "$ROOT/openwrt"
cp -a "$PKGDIR/panel" "$PKGDIR/server" "$PKGDIR/openwrt" "$ROOT/"
mkdir -p "$ROOT/bin" "$ROOT/data/rulesets" "$ROOT/etc"
if [ -d /tmp/proxybox-data-backup ]; then
  cp -a /tmp/proxybox-data-backup/. "$ROOT/data/"
  rm -rf /tmp/proxybox-data-backup
fi
rm -rf /tmp/pbinstall

# --- node ---
pick_node() {
  if command -v node >/dev/null 2>&1; then
    major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
    [ "$major" -ge 22 ] && { command -v node; return 0; }
  fi
  return 1
}
if NODE_BIN="$(pick_node)"; then
  info "node $($NODE_BIN -v) present"
else
  info "downloading Node.js v$NODE_VERSION (musl)..."
  mkdir -p "$ROOT/node"
  wget -O /tmp/node.tgz "https://unofficial-builds.nodejs.org/download/release/v$NODE_VERSION/node-v$NODE_VERSION-linux-$SB_ARCH-musl.tar.gz" \
    || die "node download failed"
  tar --no-same-owner -xzf /tmp/node.tgz -C "$ROOT/node" --strip-components=1
  rm -f /tmp/node.tgz
  NODE_BIN="$ROOT/node/bin/node"
fi
"$NODE_BIN" -e "console.log('node ready:', process.version)"

# --- sing-box ---
if [ -x "$ROOT/bin/sing-box" ] && "$ROOT/bin/sing-box" version 2>/dev/null | grep -q "$SINGBOX_VERSION"; then
  info "sing-box $SINGBOX_VERSION present"
else
  info "downloading sing-box $SINGBOX_VERSION..."
  SB_TGZ="/tmp/sing-box.tar.gz"
  wget -O "$SB_TGZ" "https://github.com/SagerNet/sing-box/releases/download/v$SINGBOX_VERSION/sing-box-${SINGBOX_VERSION}-linux-${SB_ARCH}-musl.tar.gz" \
    || die "sing-box download failed"
  tar --no-same-owner -xzf "$SB_TGZ" -C /tmp
  mv "/tmp/sing-box-${SINGBOX_VERSION}-linux-${SB_ARCH}-musl/sing-box" "$ROOT/bin/sing-box"
  chmod +x "$ROOT/bin/sing-box"
  rm -rf "$SB_TGZ" "/tmp/sing-box-${SINGBOX_VERSION}-linux-${SB_ARCH}-musl"
fi
"$ROOT/bin/sing-box" version | head -1

# --- services ---
info "installing services..."
cp "$ROOT/openwrt/initd/proxybox-core" /etc/init.d/proxybox-core
cp "$ROOT/openwrt/initd/proxybox-panel" /etc/init.d/proxybox-panel
chmod +x /etc/init.d/proxybox-core /etc/init.d/proxybox-panel
/etc/init.d/proxybox-core enable 2>/dev/null || true
/etc/init.d/proxybox-panel enable

# --- LuCI emergency page (optional) ---
if [ -d /usr/share/luci ] || [ -d /www/luci-static ]; then
  info "installing LuCI page..."
  LUCI_SRC="$ROOT/openwrt/luci"
  for d in /www/luci-static/resources/view /usr/share/luci/static/resources/view; do
    if [ -d "$(dirname "$d")" ]; then
      cp "$LUCI_SRC/htdocs/luci-static/resources/view/proxybox.js" "$d/proxybox.js" && break
    fi
  done
  mkdir -p /usr/share/luci/menu.d /usr/share/rpcd/acl.d
  cp "$LUCI_SRC/root/usr/share/luci/menu.d/luci-app-proxybox.json" /usr/share/luci/menu.d/
  cp "$LUCI_SRC/root/usr/share/rpcd/acl.d/luci-app-proxybox.json" /usr/share/rpcd/acl.d/
  /etc/init.d/rpcd reload 2>/dev/null || true
fi

# --- start panel ---
echo "$PORT" > "$ROOT/data/panel-port"
info "starting panel..."
/etc/init.d/proxybox-panel start || die "panel failed to start (see logread)"
sleep 2
/etc/init.d/proxybox-panel running && info "panel running" || die "panel did not stay up"

LAN_IP="$(ip -4 route get 1 2>/dev/null | sed -n 's/.*src \([0-9.]*\).*/\1/p' | head -1)"
echo ""
echo "[proxybox] installed. Open the panel at: http://${LAN_IP:-<router-ip>}:$PORT"
echo "[proxybox] Set your password on first visit, add a subscription, then Deploy."
echo "[proxybox] Keep this port LAN-only. LuCI: Services -> ProxyBox (emergency page)."
