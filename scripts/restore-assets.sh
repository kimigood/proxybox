#!/bin/sh
# Restore binary panel assets from their base64 text copies.
# (The GitHub push path is text-only, so binaries travel as .b64 parts.)
set -eu
cd "$(dirname "$0")/../panel/src/assets"
restore_one() {
  # $1 = target filename, $2 = b64 prefix
  if [ ! -f "$1" ]; then
    parts="$2-*"
    # shellcheck disable=SC2086
    if ls $parts >/dev/null 2>&1; then
      # shellcheck disable=SC2086
      cat $parts | base64 -d > "$1"
      echo "restored $1"
      return 0
    fi
    single="$2"
    if [ -f "$single" ]; then
      base64 -d "$single" > "$1"
      echo "restored $1"
      return 0
    fi
  fi
  return 0
}
restore_one NotoColorEmoji-flagsonly.ttf NotoColorEmoji-flagsonly.ttf.b64
restore_one TwemojiMozilla-flags.woff2 TwemojiMozilla-flags.woff2.b64
restore_one metacubex.jpg metacubex.jpg.b64
