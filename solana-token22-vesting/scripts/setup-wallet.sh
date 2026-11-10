#!/usr/bin/env bash
# Generates the local test/devnet payer keypair if it does not exist yet.
# The file is gitignored; it never leaves this machine.
set -euo pipefail

WALLET_DIR="wallet"
WALLET_FILE="wallet/devnet-payer.json"

if [ ! -f "$WALLET_FILE" ]; then
  echo "No payer keypair at $WALLET_FILE; generating a fresh one."
  mkdir -p "$WALLET_DIR"
  solana-keygen new --no-bip39-passphrase --force --outfile "$WALLET_FILE"
fi

echo "Payer pubkey: $(solana-keygen pubkey "$WALLET_FILE")"
