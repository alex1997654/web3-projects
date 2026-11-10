#!/usr/bin/env bash
# Pair the platform-tools v1.41 rustc (sbf, rustc 1.75, shipped with
# solana-cli 1.18.26) with the cargo 1.79 binary from platform-tools v1.45.
# Needed because:
#   - the committed Cargo.lock is lockfile v4; the cargo bundled with
#     platform-tools v1.41 (cargo 1.75) cannot read v4
#   - a current host cargo writes v4 and passes --check-cfg flags that the
#     sbf rustc 1.75 in v1.41 rejects
# cargo 1.79 reads v4 and emits no --check-cfg, so it pairs cleanly with the
# v1.41 rustc. If the solana platform-tools cache is empty (fresh machine,
# CI runner), the v1.41 tools (rust and llvm) are downloaded first.
# Idempotent.
set -euo pipefail

CACHE="$HOME/.cache/solana/v1.41/platform-tools"

fetch() {
  local ver=$1
  local tmp
  tmp=$(mktemp -d)
  curl -sfL -o "$tmp/pt.tar.bz2" \
    "https://github.com/anza-xyz/platform-tools/releases/download/v$ver/platform-tools-linux-x86_64.tar.bz2"
  tar -xjf "$tmp/pt.tar.bz2" -C "$tmp"
  echo "$tmp"
}

if [ ! -x "$CACHE/rust/bin/rustc" ]; then
  echo "platform-tools v1.41 not installed; downloading..."
  mkdir -p "$CACHE"
  d=$(fetch 1.41)
  cp -r "$d/rust" "$CACHE/rust"
  cp -r "$d/llvm" "$CACHE/llvm"
  [ -f "$d/version.md" ] && cp "$d/version.md" "$CACHE/version.md"
  rm -rf "$d"
fi

if "$CACHE/rust/bin/cargo" --version | grep -q "cargo 1.79"; then
  echo "sbf cargo already at 1.79"
  exit 0
fi

echo "swapping in cargo 1.79 from platform-tools v1.45..."
d=$(fetch 1.45)
cp "$d/rust/bin/cargo" "$CACHE/rust/bin/cargo"
rm -rf "$d"
"$CACHE/rust/bin/cargo" --version
"$CACHE/rust/bin/rustc" --version

echo "sbf toolchain ready"
