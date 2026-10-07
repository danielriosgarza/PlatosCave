#!/usr/bin/env bash
# Makes the client key pair the connector fixtures (profile `connector`) accept, in
# .local/connector-fixtures/ (never committed). Run it before `docker compose --profile connector
# up`; running it again keeps the existing key. Prints the key's directory.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dir="${CONNECTOR_FIXTURE_DIR:-$root/.local/connector-fixtures}"
mkdir -p "$dir"
chmod 700 "$dir"
if [ ! -f "$dir/id_ed25519" ]; then
  ssh-keygen -q -t ed25519 -N '' -C 'parallax-connector-fixture' -f "$dir/id_ed25519"
fi
chmod 600 "$dir/id_ed25519"
chmod 644 "$dir/id_ed25519.pub"
echo "$dir"
