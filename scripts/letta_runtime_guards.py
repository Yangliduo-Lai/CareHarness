"""Runtime compatibility fixes for MedMemoryBench's vendored Letta."""

from __future__ import annotations

import importlib
from typing import Any


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

    def guarded_load_letta_package(agent) -> None:
        # LettaAgent intentionally removes all ``letta.*`` modules before each
        # new agent, so the serializer patch must be reinstalled after loading.
        original_load_letta_package(agent)
        _patch_message_serializer()

    LettaAgent._load_letta_package = guarded_load_letta_package
    LettaAgent._careharness_reasoning_loader_guard = True
