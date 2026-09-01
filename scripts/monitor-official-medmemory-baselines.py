#!/usr/bin/env python3
"""Write compact live progress for the sequential official baseline run."""

from __future__ import annotations

import argparse
import json
import re
import time
from datetime import datetime
from pathlib import Path

from baseline_result_integrity import inspect_result_file


METHODS = ("long_context", "amem", "letta")
RESULT_RE = re.compile(r"\[([✓✗])\]\s+(\S+)\s+\([^)]*\):\s+([0-9.]+)")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--interval", type=int, default=60)
    parser.add_argument("--once", action="store_true")
    return parser.parse_args()


def newest_result(method_dir: Path) -> dict[str, str | None]:
    log_path = method_dir / "process.log"
    if not log_path.exists():
        return {"query": None, "mark": None, "score": None}
    latest = None
    for line in log_path.read_text(encoding="utf-8", errors="replace").splitlines():
        match = RESULT_RE.search(line)
        if match:
            latest = {"mark": match.group(1), "query": match.group(2), "score": match.group(3)}
    return latest or {"query": None, "mark": None, "score": None}


def method_status(root: Path, method: str) -> dict:
    method_dir = root / method
    completed_results = list(method_dir.glob(f"{method}_qwen3.7-plus/*_result.json"))
    if completed_results:
        newest = max(completed_results, key=lambda path: path.stat().st_mtime)
        try:
            result = json.loads(newest.read_text(encoding="utf-8"))
            summary = result.get("summary", {})
            integrity = inspect_result_file(newest)
        except (OSError, ValueError, json.JSONDecodeError):
            summary = {}
            integrity = {"valid": False, "failure_count": 1}
        return {
            "method": method,
            "status": "completed" if integrity["valid"] else "invalid",
            "completed": summary.get("total", 395),
            "total": summary.get("total", 395),
            "persona": None,
            "latest": newest_result(method_dir),
            "integrity": integrity,
        }

    checkpoint = method_dir / "checkpoints" / "medmemorybench" / f"{method}_qwen3.7-plus" / "checkpoint.json"
    if checkpoint.exists():
        try:
            data = json.loads(checkpoint.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            data = {}
        return {
            "method": method,
            "status": data.get("status", "in_progress"),
            "completed": data.get("completed_query_count", 0),
            "total": data.get("total_queries", 395),
            "persona": data.get("current_persona_id"),
            "latest": newest_result(method_dir),
        }

    return {
        "method": method,
        "status": "pending",
        "completed": 0,
        "total": 395,
        "persona": None,
        "latest": newest_result(method_dir),
    }


def snapshot(root: Path) -> dict:
    methods = [method_status(root, method) for method in METHODS]
    active = next((item for item in methods if item["status"] == "in_progress"), None)
    return {
        "updated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "active_method": active["method"] if active else None,
        "methods": methods,
    }


def format_line(data: dict) -> str:
    active = next((item for item in data["methods"] if item["status"] == "in_progress"), None)
    if active:
        latest = active["latest"]
        recent = latest["query"] or "-"
        if latest["score"] is not None:
            recent += f"({latest['mark']},{latest['score']})"
        return (
            f"{data['updated_at']} method={active['method']} persona={active['persona']} "
            f"progress={active['completed']}/{active['total']} latest={recent}"
        )
    states = ",".join(f"{item['method']}:{item['status']}" for item in data["methods"])
    return f"{data['updated_at']} {states}"


def main() -> int:
    args = parse_args()
    root = args.root.resolve()
    root.mkdir(parents=True, exist_ok=True)
    progress_json = root / "live-progress.json"
    progress_log = root / "live-progress.log"

    while True:
        data = snapshot(root)
        progress_json.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        with progress_log.open("a", encoding="utf-8") as handle:
            handle.write(format_line(data) + "\n")

        if args.once or all(item["status"] == "completed" for item in data["methods"]):
            return 0
        time.sleep(max(args.interval, 10))


if __name__ == "__main__":
    raise SystemExit(main())
