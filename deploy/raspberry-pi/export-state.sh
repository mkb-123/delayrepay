#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 DESTINATION_DIRECTORY" >&2
  exit 2
fi

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
mkdir -p "$1"
destination="$(cd "$1" && pwd)"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
bundle="$destination/delayrepay-state-$stamp"
mkdir -p "$bundle/secrets"
chmod 700 "$bundle" "$bundle/secrets"

"$repo_dir/.venv/bin/python" -m delayrepay backup --keep 30 >/dev/null
latest="$(find /var/lib/delayrepay/backups -maxdepth 1 -name 'delayrepay-*.sqlite' -type f -printf '%T@ %p\n' | sort -nr | head -n 1 | cut -d' ' -f2-)"
install -m 600 "$latest" "$bundle/delayrepay.sqlite"
[[ -f /var/lib/delayrepay/service-catalogue.json ]] && install -m 600 /var/lib/delayrepay/service-catalogue.json "$bundle/"
[[ -f /var/lib/delayrepay/service-catalogue.md ]] && install -m 600 /var/lib/delayrepay/service-catalogue.md "$bundle/"
install -m 600 "$repo_dir/.env" "$bundle/.env"
for secret in /var/lib/delayrepay/secrets/*.json; do
  [[ -e "$secret" ]] || continue
  install -m 600 "$secret" "$bundle/secrets/"
done

cat >"$bundle/README.txt" <<EOF
Private Delay Repay recovery state created $stamp.
Contains credentials and must be stored on encrypted media.
Restore after cloning the repository with:
  ./deploy/raspberry-pi/restore-state.sh /path/delayrepay.sqlite /path/to/this-directory
EOF
chmod 600 "$bundle/README.txt"
echo "$bundle"
