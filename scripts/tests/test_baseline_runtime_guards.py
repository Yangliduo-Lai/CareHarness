from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from scripts.baseline_result_integrity import inspect_result_file
from scripts.letta_runtime_guards import letta_failure_reason


class LettaRuntimeGuardTest(unittest.TestCase):
    def test_memory_and_query_provider_errors_are_fatal(self) -> None:
        memory = SimpleNamespace(
            success=False,
            extra={"error": "insufficient_balance"},
            extraction_result="",
            output="",
        )
        query = SimpleNamespace(
            success=None,
            extra={"error": "permission_denied"},
            extraction_result="",
            output="[Error: permission_denied]",
        )
        healthy = SimpleNamespace(
            success=True,
            extra={},
            extraction_result="stored",
            output="正常回答",
        )
        self.assertIn("infrastructure failure", letta_failure_reason(memory, "memory build"))
        self.assertIn("infrastructure failure", letta_failure_reason(query, "query"))
        self.assertIsNone(letta_failure_reason(healthy, "query"))

    def test_integrity_audit_rejects_error_answers_and_failed_memory(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            result_path = root / "sample_result.json"
            write_json(result_path, {
                "summary": {"total_queries": 1},
                "memory_build_summary": {"total_sessions": 1},
            })
            write_json(root / "sample_query_answer.json", {
                "queries": [{"query_id": "q1", "model_output": "[Error: insufficient_balance]"}],
            })
            write_json(root / "sample_memory_build.json", {
                "units": [{
                    "context_id": 1,
                    "session_builds": [{
                        "session_id": 1,
                        "success": False,
                        "extra": {"error": "permission_denied"},
                    }],
                }],
            })
            audit = inspect_result_file(result_path)
            self.assertFalse(audit["valid"])
            self.assertEqual(audit["failures_by_phase"], {"query": 1, "memory": 1})

    def test_integrity_audit_accepts_complete_healthy_result(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            result_path = root / "sample_result.json"
            write_json(result_path, {
                "summary": {"total_queries": 1},
                "memory_build_summary": {"total_sessions": 1},
            })
            write_json(root / "sample_query_answer.json", {
                "queries": [{"query_id": "q1", "model_output": "正常回答"}],
            })
            write_json(root / "sample_memory_build.json", {
                "units": [{
                    "context_id": 1,
                    "session_builds": [{"session_id": 1, "success": True, "extra": {}}],
                }],
            })
            self.assertTrue(inspect_result_file(result_path)["valid"])


def write_json(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    unittest.main()
