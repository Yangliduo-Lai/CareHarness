"""Runtime compatibility fixes for MedMemoryBench's vendored Letta."""

from __future__ import annotations

import importlib
from typing import Any


class LettaInfrastructureError(RuntimeError):
    """Abort the run without consuming the failed Session/query checkpoint."""


_ERROR_PREFIXES = ("[error:", "[error at chunk", "[api_error]")
_FATAL_PROVIDER_MARKERS = (
    "insufficient_balance",
    "insufficient balance",
    "insufficient_quota",
    "余额不足",
    "permission_denied",
    "invalid_api_key",
    "authenticationerror",
    "unauthorized",
)


def letta_failure_reason(value: Any, phase: str) -> str | None:
    """Return a concise infrastructure failure found in a Letta result."""
    if value is None:
        return f"Letta {phase} returned no result"

    success = getattr(value, "success", None)
    extra = getattr(value, "extra", None)
    extra = extra if isinstance(extra, dict) else {}
    candidates = [
        extra.get("error"),
        getattr(value, "error", None),
        getattr(value, "extraction_result", None),
        getattr(value, "output", None),
    ]
    texts = [str(item).strip() for item in candidates if item not in (None, "")]
    failure_text = next(
        (
            text
            for text in texts
            if text.lower().startswith(_ERROR_PREFIXES)
            or any(marker in text.lower() for marker in _FATAL_PROVIDER_MARKERS)
        ),
        None,
    )
    if success is False or failure_text:
        detail = failure_text or f"success={success!r}"
        return f"Letta {phase} infrastructure failure: {detail}"
    return None


def _patch_message_serializer() -> None:
    message_module = importlib.import_module("letta.schemas.message")
    content_module = importlib.import_module("letta.schemas.letta_message_content")

    message_class = message_module.Message
    if getattr(message_class, "_careharness_reasoning_compat", False):
        return

    original_to_openai_dict = message_class.to_openai_dict
    reasoning_types = (
        content_module.ReasoningContent,
        content_module.RedactedReasoningContent,
        content_module.OmittedReasoningContent,
    )

    def reasoning_compatible_to_openai_dict(message, *args: Any, **kwargs: Any) -> dict[str, Any]:
        original_content = list(message.content or [])
        reasoning_parts = [part for part in original_content if isinstance(part, reasoning_types)]
        if not reasoning_parts:
            return original_to_openai_dict(message, *args, **kwargs)

        # The vendored implementation already knows how to emit the native
        # reasoning fields, but raises while scanning the same content parts.
        # Let its original serializer handle text/image/tool metadata, then add
        # the native fields exactly as its unreachable tail intended.
        regular_parts = [part for part in original_content if not isinstance(part, reasoning_types)]
        if not regular_parts and message.role == "assistant" and message.tool_calls is None:
            regular_parts = [content_module.TextContent(text="")]

        try:
            message.content = regular_parts
            result = original_to_openai_dict(message, *args, **kwargs)
        finally:
            message.content = original_content

        for part in reasoning_parts:
            if isinstance(part, content_module.ReasoningContent):
                result["reasoning_content"] = part.reasoning
                if part.signature:
                    result["reasoning_content_signature"] = part.signature
            elif isinstance(part, content_module.RedactedReasoningContent):
                result["redacted_reasoning_content"] = part.data
            # OmittedReasoningContent deliberately has no text to replay.

        return result

    message_class.to_openai_dict = reasoning_compatible_to_openai_dict
    message_class._careharness_reasoning_compat = True


def install_letta_runtime_guards() -> None:
    """Patch every freshly loaded copy of the vendored Letta package."""
    from methods.letta_agent import LettaAgent

    if getattr(LettaAgent, "_careharness_reasoning_loader_guard", False):
        return

    original_load_letta_package = LettaAgent._load_letta_package
    original_memorize = LettaAgent.memorize
    original_query = LettaAgent.query

    def guarded_load_letta_package(agent) -> None:
        # LettaAgent intentionally removes all ``letta.*`` modules before each
        # new agent, so the serializer patch must be reinstalled after loading.
        original_load_letta_package(agent)
        _patch_message_serializer()

    def fail_fast_memorize(agent, text: str, **kwargs: Any):
        result = original_memorize(agent, text, **kwargs)
        reason = letta_failure_reason(result, "memory build")
        if reason:
            raise LettaInfrastructureError(reason)
        return result

    def fail_fast_query(agent, question: str, system_message: str | None = None, **kwargs: Any):
        result = original_query(agent, question, system_message=system_message, **kwargs)
        reason = letta_failure_reason(result, "query")
        if reason:
            raise LettaInfrastructureError(reason)
        return result

    LettaAgent._load_letta_package = guarded_load_letta_package
    LettaAgent.memorize = fail_fast_memorize
    LettaAgent.query = fail_fast_query
    LettaAgent._careharness_reasoning_loader_guard = True
