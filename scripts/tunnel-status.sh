#!/usr/bin/env bash
set -Eeuo pipefail
SCRIPTS="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
exec python3 "$SCRIPTS/status.py" "$@"
