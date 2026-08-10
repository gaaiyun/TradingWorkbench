"""Shared helpers for invoking an agent with structured output and a graceful fallback.

The Portfolio Manager, Trader, and Research Manager all follow the same
canonical pattern:

1. At agent creation, wrap the LLM with ``with_structured_output(Schema)``
   so the model returns a typed Pydantic instance. If the provider does
   not support structured output (rare; mostly older Ollama models), the
   wrap is skipped and the agent uses free-text generation instead.
2. At invocation, run the structured call and render the result back to
   markdown. If the structured call itself fails for any reason
   (malformed JSON from a weak model, transient provider issue), fall
   back to a plain ``llm.invoke`` so the pipeline never blocks.

Centralising the pattern here keeps the agent factories small and ensures
all three agents log the same warnings when fallback fires.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any, TypeVar

from pydantic import BaseModel

logger = logging.getLogger(__name__)

T = TypeVar("T", bound=BaseModel)


class IncompleteAgentOutputError(RuntimeError):
    """Raised when an LLM response is still missing required sections after a retry.

    Pydantic rejects a structured call whose JSON is truncated mid-field (parse
    error) or missing a required key (validation error), so that path is
    already caught by the existing ``except Exception`` below. The free-text
    fallback has no such protection: a response cut off by a token limit or a
    dropped connection is returned to the caller verbatim. The first report to
    ever pass claim validation (512480.SS 2026-08-05) shipped with its entire
    Investment Thesis section missing for exactly this reason.
    """


def bind_structured(llm: Any, schema: type[T], agent_name: str) -> Any | None:
    """Return ``llm.with_structured_output(schema)`` or ``None`` if unsupported.

    Logs a warning when the binding fails so the user understands the agent
    will use free-text generation for every call instead of one-shot fallback.
    """
    try:
        return llm.with_structured_output(schema)
    except (NotImplementedError, AttributeError) as exc:
        logger.warning(
            "%s: provider does not support with_structured_output (%s); "
            "falling back to free-text generation",
            agent_name, exc,
        )
        return None


def _looks_complete(text: str, required_labels: tuple[str, ...]) -> bool:
    if not text or not text.strip():
        return False
    return all(label in text for label in required_labels)


def invoke_structured_or_freetext(
    structured_llm: Any | None,
    plain_llm: Any,
    prompt: Any,
    render: Callable[[T], str],
    agent_name: str,
    required_labels: tuple[str, ...] = (),
) -> str:
    """Run the structured call and render to markdown; fall back to free-text on any failure.

    ``prompt`` is whatever the underlying LLM accepts (a string for chat
    invocations, a list of message dicts for chat models that take that
    shape). The same value is forwarded to the free-text path so the
    fallback sees the same input the structured call did.

    ``required_labels`` names substrings that must all be present in the
    final text (e.g. ``("**Rating**", "**Investment Thesis**")``) for the
    output to count as complete. Leave it empty (the default) to skip the
    check for callers that have not opted in. When the free-text fallback is
    missing a label it is retried once; if it is still incomplete,
    ``IncompleteAgentOutputError`` is raised instead of silently saving a
    truncated response as a finished report.
    """
    if structured_llm is not None:
        try:
            result = structured_llm.invoke(prompt)
            if result is None:
                # A thinking model can answer in plain text instead of calling
                # the tool, leaving the parser with nothing to return. Treat it
                # as a structured miss and fall back, with a clear reason.
                raise ValueError("structured output returned no parsed result")
            rendered = render(result)
            if not _looks_complete(rendered, required_labels):
                raise ValueError("structured output is missing required sections")
            return rendered
        except Exception as exc:
            logger.warning(
                "%s: structured-output invocation failed (%s); retrying once as free text",
                agent_name, exc,
            )

    response = plain_llm.invoke(prompt)
    text = response.content
    if not _looks_complete(text, required_labels):
        logger.warning(
            "%s: free-text response is missing required sections %s; retrying once",
            agent_name, required_labels,
        )
        response = plain_llm.invoke(prompt)
        text = response.content
        if not _looks_complete(text, required_labels):
            raise IncompleteAgentOutputError(
                f"{agent_name}: LLM response still missing required sections "
                f"{required_labels} after retry"
            )
    return text
