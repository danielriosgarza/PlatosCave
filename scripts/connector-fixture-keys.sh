#!/usr/bin/env bash
# Makes the client key pair the connector fixtures (profile `connector`) accept, in
# .local/connector-fixtures/ (never committed). Run it before `docker compose --profile connector
# up`; running it again keeps the existing key. Prints the key's directory.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dir="${CONNECTOR_FIXTURE_DIR:-$root/.local/connector-fixtures}"
if [ -d "$dir" ] && [ ! -O "$dir" ]; then
  echo "$dir is owned by another user (Docker creates it as root when compose runs before this script)." >&2
  echo "Remove it (sudo rm -r \"$dir\") and run this script again before docker compose." >&2
  exit 1
fi
parent="$dir"
while [ ! -e "$parent" ]; do parent="$(dirname "$parent")"; done
if [ ! -w "$parent" ]; then
  echo "$parent is not writable by you (Docker creates missing mount paths as root when compose runs before this script)." >&2
  echo "Remove the root-created directory (sudo rm -r \"$parent\") and run this script again before docker compose." >&2
  exit 1
fi
mkdir -p "$dir"
chmod 700 "$dir"
if [ ! -f "$dir/id_ed25519" ]; then
  ssh-keygen -q -t ed25519 -N '' -C 'parallax-connector-fixture' -f "$dir/id_ed25519"
fi
chmod 600 "$dir/id_ed25519"
chmod 644 "$dir/id_ed25519.pub"
echo "$dir"
