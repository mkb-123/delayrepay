#!/usr/bin/env bash
set -euo pipefail

repo_dir="${DELAYREPAY_REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$repo_dir"
service_date="$(date +%F)"
while [[ "$(date -d "$service_date" +%u)" -gt 5 ]]; do
  service_date="$(date -d "$service_date - 1 day" +%F)"
done

.venv/bin/python -m delayrepay collect --date "$service_date" --lookback-days 10
.venv/bin/python -m delayrepay report --date "$service_date" --lookback-days 10 --action-only
