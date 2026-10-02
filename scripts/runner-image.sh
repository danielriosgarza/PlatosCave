#!/usr/bin/env bash
# Identify and build the runner images (docs/design/runner.md section 6.2).
#
#   scripts/runner-image.sh hash <lang>    print the content hash of runner/images/<lang>/, runner/harness/
#                                          and the protocol fixtures the harness tests read
#   scripts/runner-image.sh build <lang>   build parallax-runner-<lang>:<content-hash> and tag it :dev
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
command="${1:-}"
lang="${2:-}"

usage() {
  echo "usage: $0 hash|build python|r" >&2
  exit 2
}

[ -n "$command" ] && [ -n "$lang" ] || usage
[ -d "$root/runner/images/$lang" ] || { echo "no image directory runner/images/$lang" >&2; exit 2; }

content_hash() {
  (
    cd "$root/runner"
    find "images/$lang" harness protocol -type f ! -name '*.pyc' ! -path '*/__pycache__/*' -print0 \
      | LC_ALL=C sort -z \
      | xargs -0 sha256sum \
      | sha256sum \
      | cut -d' ' -f1
  )
}

case "$command" in
  hash)
    content_hash
    ;;
  build)
    hash="$(content_hash)"
    harness_version="$(sed -n 's/^HARNESS_VERSION = "\([0-9][0-9]*\)"$/\1/p' "$root/runner/harness/run.py")"
    [ -n "$harness_version" ] || { echo "HARNESS_VERSION not found in runner/harness/run.py" >&2; exit 1; }
    revision="$(git -C "$root" rev-parse HEAD 2>/dev/null || echo unknown)"
    docker build \
      --file "$root/runner/images/$lang/Dockerfile" \
      --build-arg "REVISION=$revision" \
      --build-arg "CONTENT_HASH=$hash" \
      --build-arg "HARNESS_VERSION=$harness_version" \
      --tag "parallax-runner-$lang:$hash" \
      --tag "parallax-runner-$lang:dev" \
      "$root/runner"
    echo "parallax-runner-$lang:$hash"
    ;;
  *)
    usage
    ;;
esac
