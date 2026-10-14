#!/bin/sh /etc/rc.common
# ProxyBox release builder: builds the panel frontend, then packs
# panel/dist + server + openwrt files into a release tarball with SHA256.
# Run on a build machine (not on the router).
set -eu
cd "$(dirname "$0")/.."

VERSION="${1:-0.1.0}"
DIST="dist/proxybox-$VERSION"

echo "[proxybox] building panel frontend..."
if [ ! -d panel/node_modules ]; then
  (cd panel && npm install)
fi
# binary assets travel as .b64 in the repo; restore before building
sh scripts/restore-assets.sh
# no-fonts build: use system fonts, keeps dist small (~4MB instead of ~27MB)
(cd panel && npm run build:no-fonts)

echo "[proxybox] packing..."
rm -rf "$DIST"
mkdir -p "$DIST"
cp -r panel/dist "$DIST/panel"
# production dependencies travel with the tarball (routers have no npm)
(cd server && npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1)
cp -r server "$DIST/server"
rm -rf "$DIST/server/smoke.mjs"
cp -r openwrt "$DIST/openwrt"
cp -r scripts/install.sh "$DIST/install.sh"
printf '{"version":"%s","singbox":"1.13.14"}\n' "$VERSION" > "$DIST/meta.json"

TARBALL="dist/proxybox-$VERSION.tar.gz"
tar -czf "$TARBALL" -C dist "proxybox-$VERSION"
sha256sum "$TARBALL" | awk '{print $1}' > "$TARBALL.sha256"
echo "[proxybox] built: $TARBALL"
cat "$TARBALL.sha256"

# Split a base64 of the tarball into committable text chunks + manifest,
# so the release can be distributed straight from the git repo
# (install.sh reassembles them; no GitHub Release needed).
# Chunks are kept small (~96KB) to stay pushable through text-only APIs.
CHUNKDIR="releases/v$VERSION"
rm -rf "$CHUNKDIR"
mkdir -p "$CHUNKDIR"
base64 -w0 "$TARBALL" | split -b 98304 - "$CHUNKDIR/chunk-"
{
  echo "version=$VERSION"
  echo "sha256=$(cat "$TARBALL.sha256")"
  echo -n "chunks="
  ls "$CHUNKDIR" | tr '\n' ' '
  echo
} > "$CHUNKDIR/manifest.txt"
echo "[proxybox] release chunks in $CHUNKDIR ($(du -sh "$CHUNKDIR" | cut -f1))"
