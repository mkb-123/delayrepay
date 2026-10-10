#!/usr/bin/env bash
set -euo pipefail

repo_dir="${DELAYREPAY_REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$repo_dir"
end_date="$(date -d 'yesterday' +%F)"
.venv/bin/python -m delayrepay email-summary --date "$end_date" --lookback-days 10
