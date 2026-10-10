#!/usr/bin/env bash
set -euo pipefail

repo_dir="${DELAYREPAY_REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$repo_dir"
.venv/bin/python -m delayrepay daily-brief
