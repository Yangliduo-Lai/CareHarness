#!/usr/bin/env python3
"""Validate that an official baseline result contains no provider failures."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


INFRASTRUCTURE_MARKERS = (
    "[error:",
    "[error at chunk",
    "[api_error]",
    "insufficient_balance",
    "insufficient balance",
    "insufficient_quota",
    "余额不足",
    "permission_denied",
    "invalid_api_key",
    "authenticationerror",
    "unauthorized",
    "retries exhausted",
)


def error_reason(value: Any) -> str | None:
    text = str(value or "").strip()
    lowered = text.lower()
    if any(marker in lowered for marker in INFRASTRUCTURE_MARKERS):
        return text[:500]
    return None


def inspect_result_file(result_path: Path) -> dict[str, Any]:
    result_path = Path(result_path).resolve()
    result = read_json(result_path)
    result_name = result_path.name
    prefix = result_name[:-len("_result.json")] if result_name.endswith("_result.json") else result_name
    query_path = result_path.with_name(f"{prefix}_query_answer.json")
    memory_path = result_path.with_name(f"{prefix}_memory_build.json")
    summary = result.get("summary", {})
    expected_queries = int(summary.get("total_queries", summary.get("total", 0)) or 0)
    expected_sessions = int(result.get("memory_build_summary", {}).get("total_sessions", 0) or 0)

    failures: list[dict[str, Any]] = []
    query_count = 0
    if not query_path.exists():
        failures.append({"phase": "query", "reason": f"missing {query_path.name}"})
    else:
        query_data = read_json(query_path)
        queries = query_data.get("queries", [])
        query_count = len(queries)
        if expected_queries and query_count != expected_queries:
            failures.append({
                "phase": "query",
                "reason": f"query count {query_count} != expected {expected_queries}",
            })
        for item in queries:
            reason = error_reason(item.get("model_output"))
            details = item.get("evaluation_details") or item.get("details") or {}
            if not reason and isinstance(details, dict) and details.get("api_error"):
                reason = str(details.get("error_message") or "query api_error")
            if reason:
                failures.append({
                    "phase": "query",
                    "query_id": item.get("query_id"),
                    "reason": reason,
                })

    session_count = 0
    if not memory_path.exists():
        failures.append({"phase": "memory", "reason": f"missing {memory_path.name}"})
    else:
        memory_data = read_json(memory_path)
        for unit in memory_data.get("units", []):
            for item in unit.get("session_builds", []):
                session_count += 1
                build = item.get("build_result") if isinstance(item.get("build_result"), dict) else item
                extra = build.get("extra") if isinstance(build.get("extra"), dict) else {}
                reason = (
                    error_reason(item.get("error"))
                    or error_reason(build.get("error"))
                    or error_reason(extra.get("error"))
                    or error_reason(build.get("extraction_result"))
                )
                if build.get("success") is False and not reason:
                    reason = "memory build returned success=false"
                if reason:
                    failures.append({
                        "phase": "memory",
                        "context_id": unit.get("context_id"),
                        "session_id": item.get("session_id"),
                        "reason": reason,
                    })
        if expected_sessions and session_count != expected_sessions:
            failures.append({
                "phase": "memory",
                "reason": f"session count {session_count} != expected {expected_sessions}",
            })

    by_phase: dict[str, int] = {}
    for failure in failures:
        phase = str(failure.get("phase") or "unknown")
        by_phase[phase] = by_phase.get(phase, 0) + 1
    return {
        "valid": not failures,
        "result_path": str(result_path),
        "query_path": str(query_path),
        "memory_path": str(memory_path),
        "expected_queries": expected_queries,
        "observed_queries": query_count,
        "expected_sessions": expected_sessions,
        "observed_sessions": session_count,
        "failure_count": len(failures),
        "failures_by_phase": by_phase,
        "failure_examples": failures[:10],
    }


def newest_result(method_dir: Path, method: str, model: str) -> Path | None:
    result_dir = Path(method_dir) / f"{method}_{model}"
    candidates = list(result_dir.glob("*_result.json"))
    return max(candidates, key=lambda path: path.stat().st_mtime) if candidates else None


def newest_valid_result(method_dir: Path, method: str, model: str) -> tuple[Path | None, dict[str, Any] | None]:
    result_dir = Path(method_dir) / f"{method}_{model}"
    candidates = sorted(result_dir.glob("*_result.json"), key=lambda path: path.stat().st_mtime, reverse=True)
    newest_audit = None
    for path in candidates:
        audit = inspect_result_file(path)
        if newest_audit is None:
            newest_audit = audit
        if audit["valid"]:
            return path, audit
    return None, newest_audit


def read_json(path: Path) -> dict[str, Any]:
    with Path(path).open("r", encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise ValueError(f"expected a JSON object: {path}")
    return value


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--result", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    audit = inspect_result_file(args.result)
    print(json.dumps(audit, ensure_ascii=False, indent=2))
    return 0 if audit["valid"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
