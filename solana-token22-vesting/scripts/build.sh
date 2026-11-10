#!/usr/bin/env bash
# Build the program and mirror the SBF artifacts into the project-local
# target/deploy that anchor test / anchor deploy read from.
#
# The workspace shares one cargo target dir (web3-projects/.target, see
# TOOLCHAIN.md), so cargo emits the .so under
# .target/sbf-solana-solana/release/. Anchor 0.30 expects it at the
# project-local target/deploy/ and will silently deploy whatever sits
# there, stale or not. This script fails loudly instead of letting a
# stale binary reach the validator.
set -euo pipefail

cd "$(dirname "$0")/.."

anchor build

SHARED_SO=/home/ale/web3-projects/.target/sbf-solana-solana/release/token22_vesting.so
LOCAL_DIR=target/deploy

test -f "$SHARED_SO" || { echo "missing $SHARED_SO" >&2; exit 1; }
mkdir -p "$LOCAL_DIR"
cp "$SHARED_SO" "$LOCAL_DIR/token22_vesting.so"

SUM_SHARED=$(md5sum "$SHARED_SO" | cut -d' ' -f1)
SUM_LOCAL=$(md5sum "$LOCAL_DIR/token22_vesting.so" | cut -d' ' -f1)
if [ "$SUM_SHARED" != "$SUM_LOCAL" ]; then
  echo "mirror checksum mismatch" >&2
  exit 1
fi
echo "build ok, deployed .so checksum $SUM_LOCAL"
