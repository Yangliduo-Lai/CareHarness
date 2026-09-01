#!/usr/bin/env python3
"""Run selected official MedMemoryBench baselines with an OpenAI-compatible model.

This wrapper deliberately keeps credentials in environment variables.  It loads
the baseline and dataset definitions from the official MedMemoryBench checkout,
then overrides only the requested model, personas, and optional smoke-test limit.
"""

from __future__ import annotations

import argparse
import copy
import getpass
import json
import os
import sys
from pathlib import Path


METHOD_CONFIGS = {
    "amem": "amem_qwen3",
    "long_context": "long_context_gpt-5.1",
    "letta": "letta_qwen3",
}


def csv_ints(value: str) -> list[int]:
    try:
        result = [int(item.strip()) for item in value.split(",") if item.strip()]
    except ValueError as exc:
        raise argparse.ArgumentTypeError("personas must be comma-separated integers") from exc
    if not result or any(item <= 0 for item in result):
        raise argparse.ArgumentTypeError("personas must contain positive integers")
    return result


def positive_float(value: str) -> float:
    try:
        result = float(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("value must be a number") from exc
    if result <= 0:
        raise argparse.ArgumentTypeError("value must be positive")
    return result


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, required=True, help="Official MedMemoryBench repository")
    parser.add_argument("--method", choices=sorted(METHOD_CONFIGS), required=True)
    parser.add_argument("--personas", type=csv_ints, default=[1, 3, 5, 7])
    parser.add_argument("--model", default="qwen3.7-plus")
    parser.add_argument("--base-url", default="https://api.openai-proxy.org/v1")
    parser.add_argument("--judge-model", default=None)
    parser.add_argument("--embedding-model", default="BAAI/bge-small-zh-v1.5")
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--max-sessions", type=int, default=None)
    parser.add_argument("--amem-request-timeout-seconds", type=positive_float, default=300.0)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument(
        "--api-key-stdin",
        action="store_true",
        help="Read the API key once from stdin without storing it in the manifest",
    )
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--quiet", action="store_true")
    return parser.parse_args()


def configure_environment(args: argparse.Namespace) -> None:
    api_key = os.environ.get("CAREHARNESS_RUN_KEY") or os.environ.get("OPENAI_API_KEY")
    if not args.dry_run and not api_key:
        raise SystemExit("CAREHARNESS_RUN_KEY or OPENAI_API_KEY must be set")

    if api_key:
        os.environ["OPENAI_API_KEY"] = api_key
        os.environ["JUDGE_API_KEY"] = api_key
    os.environ["OPENAI_BASE_URL"] = args.base_url
    os.environ["JUDGE_BASE_URL"] = args.base_url
    os.environ["DEFAULT_LLM_MODEL"] = args.model
    os.environ["JUDGE_MODEL"] = args.judge_model or args.model
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    workspace_cache = Path(__file__).resolve().parents[1] / ".cache"
    os.environ.setdefault("HF_HOME", str(workspace_cache / "huggingface"))
    os.environ.setdefault("SENTENCE_TRANSFORMERS_HOME", str(workspace_cache / "sentence-transformers"))
    os.environ.setdefault("MPLCONFIGDIR", str(workspace_cache / "matplotlib"))
    os.environ.setdefault("COMPOSIO_CACHE_DIR", str(workspace_cache / "composio"))
    # Vendored Letta's current pydantic-settings declaration applies the
    # ``letta_`` prefix to ``letta_dir``.  Set both spellings so it never falls
    # back to ~/.letta (outside the workspace) on either dependency version.
    letta_dir = args.output_dir / ".letta-runtime"
    os.environ.setdefault("LETTA_DIR", str(letta_dir))
    os.environ.setdefault("LETTA_LETTA_DIR", str(letta_dir))
    os.environ.setdefault("LLM_MAX_RETRIES", "3")
    os.environ.setdefault("LLM_RETRY_MIN_DELAY", "2")
    os.environ.setdefault("LLM_RETRY_MAX_DELAY", "8")


def build_configs(args: argparse.Namespace):
    from src.config import ConfigLoader

    loader = ConfigLoader(project_root=args.repo)
    method_config = copy.deepcopy(loader.load_method_config(METHOD_CONFIGS[args.method]))
    dataset_config = copy.deepcopy(loader.load_dataset_config("medmemorybench"))

    # Replace the foundation model while preserving the official Qwen baseline
    # hyperparameters (retrieval count, chunk sizes, context limits, and so on).
    method_config.model.provider = "openai"
    method_config.model.name = args.model
    method_config.model.api_key = None
    method_config.model.base_url = args.base_url
    method_config.model.max_tokens = 10_000
    method_config.model.max_completion_tokens = 10_000

    raw_method = copy.deepcopy(method_config.raw_config)
    raw_method.setdefault("model", {})
    raw_method["model"].update(
        {
            "provider": "openai",
            "name": args.model,
            "temperature": method_config.model.temperature,
            "max_completion_tokens": 10_000,
            "base_url": args.base_url,
        }
    )

    if args.method == "amem":
        method_config.agent_params["amem_model"] = args.model
        method_config.agent_params["amem_embedding_model"] = args.embedding_model
        raw_method.setdefault("agent_params", {})
        raw_method["agent_params"]["amem_model"] = args.model
        raw_method["agent_params"]["amem_embedding_model"] = args.embedding_model
    elif args.method == "letta":
        if method_config.embedding is None:
            raise RuntimeError("official Letta config is missing its embedding section")
        method_config.embedding.provider = "local"
        method_config.embedding.model = "bge-small-zh-v1.5"
        method_config.embedding.model_path = args.embedding_model
        raw_method.setdefault("embedding", {})
        raw_method["embedding"].update(
            {
                "provider": "local",
                "model": "bge-small-zh-v1.5",
                "model_path": args.embedding_model,
                "dim": method_config.embedding.dim,
            }
        )

    method_config.raw_config = raw_method

    dataset_config.persona_ids = args.personas
    dataset_config.max_personas = None
    dataset_config.max_sessions_per_persona = args.max_sessions
    dataset_config.inject_noise = False
    raw_dataset = copy.deepcopy(dataset_config.raw_config)
    raw_dataset.setdefault("evaluation", {})
    raw_dataset["evaluation"].update(
        {
            "persona_ids": args.personas,
            "max_personas": None,
            "max_sessions_per_persona": args.max_sessions,
            "inject_noise": False,
        }
    )
    dataset_config.raw_config = raw_dataset
    return method_config, dataset_config


def main() -> int:
    args = parse_args()
    if args.api_key_stdin:
        api_key = getpass.getpass("") if sys.stdin.isatty() else sys.stdin.readline().strip()
        if not api_key:
            raise SystemExit("API key supplied on stdin is empty")
        os.environ["CAREHARNESS_RUN_KEY"] = api_key
    args.repo = args.repo.resolve()
    args.output_dir = args.output_dir.resolve()
    if not (args.repo / "benchmarks" / "medmemorybench").is_dir():
        raise SystemExit(f"not a MedMemoryBench repository: {args.repo}")
    if args.max_sessions is not None and args.max_sessions <= 0:
        raise SystemExit("--max-sessions must be positive")

    configure_environment(args)
    sys.path.insert(0, str(args.repo))

    if args.method == "amem":
        from amem_runtime_guards import install_amem_runtime_guards

        snapshot_dir = install_amem_runtime_guards(
            official_repo=args.repo,
            output_dir=args.output_dir,
            request_timeout_seconds=args.amem_request_timeout_seconds,
            resume=args.resume,
        )
        print(
            "A-Mem runtime guards enabled: "
            f"request_timeout={args.amem_request_timeout_seconds:g}s, "
            f"sdk_retries=0, snapshots={snapshot_dir}",
            flush=True,
        )
    elif args.method == "letta":
        from letta_runtime_guards import install_letta_runtime_guards

        install_letta_runtime_guards()
        print("Letta runtime guard enabled: native reasoning-content compatibility", flush=True)

    # Upstream's independent-mode resume path rebuilds the current persona's
    # memory, but start_persona() also clears its completed query IDs.  The
    # results themselves remain in completed_results, so clearing the IDs makes
    # every already-scored query in the partial persona run again.  Restore the
    # IDs from those canonical saved results while still clearing injected
    # sessions so the in-memory baseline state is rebuilt safely.
    if args.resume:
        from benchmarks.medmemorybench.checkpoint import MedMemoryBenchCheckpointManager

        original_start_persona = MedMemoryBenchCheckpointManager.start_persona

        def resume_safe_start_persona(manager, persona_id: int) -> None:
            checkpoint = manager._checkpoint
            if checkpoint is None:
                original_start_persona(manager, persona_id)
                return

            saved_results = checkpoint.completed_results.get(str(persona_id), [])
            saved_query_ids = list(dict.fromkeys(
                result.get("query_id")
                for result in saved_results
                if result.get("query_id")
            ))
            checkpoint.current_persona_id = persona_id
            checkpoint.current_persona_completed_queries = saved_query_ids
            checkpoint.current_persona_injected_sessions = []
            checkpoint.completed_query_count = sum(
                len({result.get("query_id") for result in results if result.get("query_id")})
                for results in checkpoint.completed_results.values()
            )
            manager.save()

        MedMemoryBenchCheckpointManager.start_persona = resume_safe_start_persona

    import src.evaluator as evaluator_module
    from utils.logger import get_eval_logger as make_eval_logger

    # The official logger defaults to <official-repo>/logs.  Keep every write in
    # this wrapper's output tree so the upstream checkout remains read-only.
    evaluator_module.get_eval_logger = lambda method_name, dataset_name: make_eval_logger(
        method_name,
        dataset_name,
        log_dir=args.output_dir / "logs",
    )
    Evaluator = evaluator_module.Evaluator

    method_config, dataset_config = build_configs(args)
    args.output_dir.mkdir(parents=True, exist_ok=True)

    run_manifest = {
        "method": args.method,
        "official_config": METHOD_CONFIGS[args.method],
        "model": args.model,
        "base_url": args.base_url,
        "judge_model": args.judge_model or args.model,
        "personas": args.personas,
        "max_sessions_per_persona": args.max_sessions,
        "inject_noise": False,
        "embedding_model": args.embedding_model if args.method in {"amem", "letta"} else None,
        "amem_request_timeout_seconds": (
            args.amem_request_timeout_seconds if args.method == "amem" else None
        ),
        "letta_reasoning_content_compat": args.method == "letta",
        "resume": args.resume,
        "dry_run": args.dry_run,
    }
    manifest_path = args.output_dir / "run-manifest.json"
    manifest_path.write_text(json.dumps(run_manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    evaluator = Evaluator(
        method_config=method_config,
        dataset_config=dataset_config,
        output_dir=args.output_dir,
        dry_run=args.dry_run,
        verbose=not args.quiet,
        resume=args.resume,
    )
    report = evaluator.run()
    print(json.dumps({"method": args.method, "summary": report.summary}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
