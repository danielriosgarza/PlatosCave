#!/usr/bin/env bash
# Prepares the single-node Garage from infra/compose.yml (profile `s3`): layout, access key,
# bucket. Idempotent. Prints the S3_* variables the server and integration tests read.
# GARAGE overrides the CLI invocation (default: the compose service's binary).
set -euo pipefail
cd "$(dirname "$0")/.."

GARAGE="${GARAGE:-docker compose -f infra/compose.yml --profile s3 exec -T garage /garage}"
# Fixed development credentials; Garage key ids are GK + 24 hex, secrets 64 hex.
KEY_ID=GK0123456789abcdef01234567
SECRET=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
BUCKET=parallax

g() { $GARAGE "$@"; }

for _ in $(seq 1 30); do g status >/dev/null 2>&1 && break; sleep 1; done
node="$(g node id -q | cut -d@ -f1)"
if ! g layout show 2>/dev/null | grep -q "${node:0:16}.*dc1"; then
  g layout assign -z dc1 -c 1G "$node" >/dev/null
  version="$(g layout show | sed -n 's/.*garage layout apply --version \([0-9]*\).*/\1/p' | head -1)"
  g layout apply --version "${version:-1}" >/dev/null
fi
g key info "$KEY_ID" >/dev/null 2>&1 || g key import --yes -n parallax-dev "$KEY_ID" "$SECRET" >/dev/null
g bucket info "$BUCKET" >/dev/null 2>&1 || g bucket create "$BUCKET" >/dev/null
g bucket allow --read --write --owner "$BUCKET" --key "$KEY_ID" >/dev/null
# The A22 s3 test creates and deletes its own buckets (a restore needs an empty one).
g key allow --create-bucket "$KEY_ID" >/dev/null

echo "S3_ENDPOINT=http://127.0.0.1:3900"
echo "S3_REGION=garage"
echo "S3_BUCKET=$BUCKET"
echo "S3_ACCESS_KEY_ID=$KEY_ID"
echo "S3_SECRET_ACCESS_KEY=$SECRET"
