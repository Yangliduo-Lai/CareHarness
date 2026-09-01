"""Runtime safety guards for the official MedMemoryBench A-Mem adapter.

The official adapter keeps all A-Mem state in memory and lets the OpenAI SDK
apply its own retries underneath A-Mem's retry decorator.  This module is a
wrapper-only patch: it bounds each internal request and persists the exact
in-memory state after every successfully memorized session.
"""

from __future__ import annotations

import hashlib
import importlib
import json
import logging
import os
import sys
from pathlib import Path
from typing import Any


logger = logging.getLogger(__name__)

SNAPSHOT_VERSION = 1
NOTE_FIELDS = (
    "content",
    "id",
    "keywords",
    "links",
    "importance_score",
    "retrieval_count",
    "timestamp",
    "last_accessed",
    "context",
    "evolution_history",
    "category",
    "tags",
)


class AMemSnapshotError(RuntimeError):
    """Raised when a saved A-Mem state cannot be replayed safely."""


def _input_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _agent_signature(agent: Any) -> dict[str, Any]:
    return {
        "amem_backend": agent.amem_backend,
        "amem_model": agent.amem_model,
        "amem_embedding_model": str(agent.amem_embedding_model),
        "amem_evo_threshold": agent.amem_evo_threshold,
        "amem_max_tokens": agent.amem_max_tokens,
        "amem_max_context_tokens": agent.amem_max_context_tokens,
        "amem_chunk_size_tokens": agent.amem_chunk_size_tokens,
    }


def _snapshot_path(snapshot_dir: Path, context_id: int) -> Path:
    return snapshot_dir / f"context-{context_id}.snapshot.json"


def _json_default(value: Any) -> Any:
    item = getattr(value, "item", None)
    if callable(item):
        return item()
    raise TypeError(f"cannot serialize {type(value).__name__}")


def _serialize_note(note: Any) -> dict[str, Any]:
    return {field: getattr(note, field) for field in NOTE_FIELDS}


def _write_snapshot(
    snapshot_dir: Path,
    context_id: int,
    agent: Any,
    system: Any,
    input_hashes: list[str],
) -> Path:
    embeddings = system.retriever.embeddings
    payload = {
        "version": SNAPSHOT_VERSION,
        "context_id": context_id,
        "agent_signature": _agent_signature(agent),
        "input_hashes": input_hashes,
        "evo_cnt": system.evo_cnt,
        "memories": [_serialize_note(note) for note in system.memories.values()],
        "retriever": {
            "corpus": list(system.retriever.corpus),
            "document_ids": dict(system.retriever.document_ids),
            "embedding_dtype": str(embeddings.dtype) if embeddings is not None else None,
            "embeddings": embeddings.tolist() if embeddings is not None else None,
        },
    }

    snapshot_dir.mkdir(parents=True, exist_ok=True)
    path = _snapshot_path(snapshot_dir, context_id)
    temp_path = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        with temp_path.open("w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"), default=_json_default)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, path)
    finally:
        if temp_path.exists():
            temp_path.unlink()
    return path


def _load_snapshot(path: Path, context_id: int, agent: Any, system: Any, note_class: type) -> list[str]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise AMemSnapshotError(f"cannot read A-Mem snapshot {path}: {exc}") from exc

    if payload.get("version") != SNAPSHOT_VERSION:
        raise AMemSnapshotError(
            f"unsupported A-Mem snapshot version in {path}: {payload.get('version')!r}"
        )
    if payload.get("context_id") != context_id:
        raise AMemSnapshotError(f"A-Mem snapshot context mismatch in {path}")
    if payload.get("agent_signature") != _agent_signature(agent):
        raise AMemSnapshotError(
            f"A-Mem snapshot configuration mismatch in {path}; refusing an unsafe replay"
        )

    saved_memories = payload.get("memories")
    input_hashes = payload.get("input_hashes")
    retriever_state = payload.get("retriever")
    if not isinstance(saved_memories, list) or not isinstance(input_hashes, list):
        raise AMemSnapshotError(f"invalid A-Mem snapshot contents in {path}")
    if not isinstance(retriever_state, dict):
        raise AMemSnapshotError(f"missing A-Mem retriever state in {path}")

    corpus = retriever_state.get("corpus")
    document_ids = retriever_state.get("document_ids")
    saved_embeddings = retriever_state.get("embeddings")
    if not isinstance(corpus, list) or not isinstance(document_ids, dict):
        raise AMemSnapshotError(f"invalid A-Mem retriever state in {path}")
    if len(corpus) != len(saved_memories):
        raise AMemSnapshotError(f"A-Mem memory/retriever length mismatch in {path}")

    memories: dict[str, Any] = {}
    for saved_note in saved_memories:
        if not isinstance(saved_note, dict) or any(field not in saved_note for field in NOTE_FIELDS):
            raise AMemSnapshotError(f"invalid A-Mem note in {path}")
        note = note_class(content=saved_note["content"])
        for field in NOTE_FIELDS:
            setattr(note, field, saved_note[field])
        if note.id in memories:
            raise AMemSnapshotError(f"duplicate A-Mem note ID in {path}: {note.id}")
        memories[note.id] = note

    embedding_migrated = False
    if saved_embeddings is None:
        embeddings = None
    else:
        import numpy as np

        dtype = retriever_state.get("embedding_dtype") or "float32"
        embeddings = np.asarray(saved_embeddings, dtype=dtype)
        if embeddings.ndim != 2 or embeddings.shape[0] != len(corpus):
            raise AMemSnapshotError(f"invalid A-Mem embedding matrix in {path}")
        model = getattr(system.retriever, "model", None)
        dimension_getter = getattr(model, "get_sentence_embedding_dimension", None)
        expected_dimension = dimension_getter() if callable(dimension_getter) else None
        if expected_dimension and embeddings.shape[1] != int(expected_dimension):
            logger.warning(
                "Re-embedding A-Mem snapshot context %d: saved dimension=%d, current dimension=%d",
                context_id,
                embeddings.shape[1],
                int(expected_dimension),
            )
            embeddings = np.asarray(model.encode(corpus), dtype=dtype)
            if embeddings.ndim != 2 or embeddings.shape != (len(corpus), int(expected_dimension)):
                raise AMemSnapshotError(
                    f"A-Mem snapshot re-embedding produced an invalid matrix in {path}"
                )
            embedding_migrated = True

    system.memories = memories
    system.evo_cnt = int(payload.get("evo_cnt", 0))
    system.retriever.corpus = corpus
    system.retriever.document_ids = {str(key): int(value) for key, value in document_ids.items()}
    system.retriever.embeddings = embeddings

    agent._memory_chunks = [note.content for note in memories.values()]
    agent._is_initialized = bool(memories)
    if embedding_migrated:
        _write_snapshot(path.parent, context_id, agent, system, [str(value) for value in input_hashes])
    return [str(value) for value in input_hashes]


def install_amem_runtime_guards(
    *,
    official_repo: Path,
    output_dir: Path,
    request_timeout_seconds: float,
    resume: bool,
) -> Path:
    """Patch the official A-Mem classes before the evaluator creates an agent."""
    if request_timeout_seconds <= 0:
        raise ValueError("A-Mem request timeout must be positive")

    # Import the official adapter while the repository root still has priority.
    # A-Mem itself contains a top-level ``utils.py`` that would otherwise shadow
    # MedMemoryBench's ``utils`` package during this import.
    from methods.amem_agent import AMemAgent
    from methods.base import MemoryBuildResult

    amem_source = official_repo / "methods" / "amem" / "A-mem"
    if str(amem_source) not in sys.path:
        sys.path.insert(0, str(amem_source))

    memory_module = importlib.import_module("memory_layer_robust")
    controller_class = memory_module.RobustOpenAIController

    if not getattr(controller_class, "_careharness_transport_guard", False):
        def bounded_controller_init(
            controller,
            model: str = "gpt-4",
            api_key: str | None = None,
            api_base: str | None = None,
            max_tokens: int = 1000,
            usage_tracker: Any | None = None,
        ) -> None:
            from openai import OpenAI

            resolved_key = api_key or os.environ.get("OPENAI_API_KEY")
            if resolved_key is None:
                raise ValueError("OpenAI API key not found. Set OPENAI_API_KEY environment variable.")
            controller.model = model
            controller.max_tokens = max_tokens
            controller.usage_tracker = usage_tracker
            controller.client = OpenAI(
                api_key=resolved_key,
                base_url=api_base,
                timeout=request_timeout_seconds,
                max_retries=0,
            )

        controller_class.__init__ = bounded_controller_init
        controller_class._careharness_transport_guard = True

    if getattr(AMemAgent, "_careharness_snapshot_guard", False):
        return output_dir / ".amem-runtime"

    snapshot_dir = output_dir / ".amem-runtime"
    original_get_memory_system = AMemAgent._get_memory_system
    original_memorize = AMemAgent.memorize
    note_class = memory_module.RobustMemoryNote

    def guarded_get_memory_system(agent, context_id: int):
        system = original_get_memory_system(agent, context_id)
        restored_contexts = agent.__dict__.setdefault("_amem_snapshot_restored_contexts", set())
        if context_id in restored_contexts:
            return system

        hashes_by_context = agent.__dict__.setdefault("_amem_snapshot_input_hashes", {})
        cursors_by_context = agent.__dict__.setdefault("_amem_snapshot_replay_cursors", {})
        path = _snapshot_path(snapshot_dir, context_id)
        if path.exists() and resume:
            hashes_by_context[context_id] = _load_snapshot(path, context_id, agent, system, note_class)
            logger.info(
                "Restored A-Mem snapshot for context %d: %d sessions, %d notes",
                context_id,
                len(hashes_by_context[context_id]),
                len(system.memories),
            )
        elif path.exists():
            raise AMemSnapshotError(
                f"A-Mem snapshot already exists at {path}; use --resume or a clean output directory"
            )
        else:
            hashes_by_context[context_id] = []
        cursors_by_context[context_id] = 0
        restored_contexts.add(context_id)
        return system

    def checkpointed_memorize(agent, text: str, **kwargs):
        context_id = agent._get_context_id()
        system = agent._get_memory_system(context_id)
        hashes = agent._amem_snapshot_input_hashes[context_id]
        cursor = agent._amem_snapshot_replay_cursors[context_id]
        digest = _input_hash(text)

        if cursor < len(hashes):
            expected = hashes[cursor]
            if digest != expected:
                raise AMemSnapshotError(
                    "A-Mem replay input diverged at "
                    f"context {context_id}, session position {cursor + 1}; "
                    "refusing to mix the snapshot with changed benchmark data"
                )
            agent._amem_snapshot_replay_cursors[context_id] = cursor + 1
            return MemoryBuildResult(
                success=True,
                method="amem",
                action="resume_snapshot_skip",
                input_content=text,
                stored_content=text,
                memory_entries=[],
                all_passages=[],
                chunk_count=len(agent._memory_chunks),
                extra={
                    "context_id": context_id,
                    "resume_skipped": True,
                    "inserted_count": 0,
                },
            )

        result = original_memorize(agent, text, **kwargs)
        if isinstance(result, MemoryBuildResult) and result.success:
            hashes.append(digest)
            agent._amem_snapshot_replay_cursors[context_id] = len(hashes)
            _write_snapshot(snapshot_dir, context_id, agent, system, hashes)
        return result

    AMemAgent._get_memory_system = guarded_get_memory_system
    AMemAgent.memorize = checkpointed_memorize
    AMemAgent._careharness_snapshot_guard = True
    return snapshot_dir
