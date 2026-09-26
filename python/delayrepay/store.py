from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def read_json(path: Path, default: Any = None) -> Any:
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    temporary.replace(path)


def catalogue_path(root: Path) -> Path:
    return root / "service-catalogue.json"


def daily_path(root: Path, service_date: str) -> Path:
    return root / "daily" / f"{service_date}.json"


def report_path(root: Path, service_date: str) -> Path:
    return root / "reports" / f"{service_date}.md"
