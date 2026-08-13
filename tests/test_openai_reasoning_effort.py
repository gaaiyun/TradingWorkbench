"""OpenAI-style ``reasoning_effort`` is gated to reasoning models.

Non-reasoning OpenAI models (gpt-4.1, gpt-4o, ...) 400 with "Unsupported
parameter: 'reasoning.effort'". The client must drop the kwarg for those rather
than forward it and crash the run. The GPT-5 family and the o-series accept it.

xAI's grok-N(.M) flagship models (served through this project's
``openai_compatible`` provider, e.g. the sub.anzhiyu.com relay) are reasoning
models too and accept the same kwarg — confirmed against the live endpoint on
2026-08-13: a trivial prompt against grok-4.5 burned 3527 reasoning tokens with
no effort override and 1738 with ``reasoning_effort=low``. Without this gate
recognizing grok models, TRADINGAGENTS_OPENAI_REASONING_EFFORT has no effect on
them, every agent call runs at full (unbounded) reasoning effort, and a chain
of sequential calls in one ticker's analysis can exceed the relay's 120s
Cloudflare proxy timeout (observed in production run 31680176206: both tickers
failed with repeated ``Error 524`` after the run ran 52 minutes with zero
completed reports, versus ~10 minutes for equivalent successful runs).

A second, independent gap in the same incident: fixing ``_supports_reasoning_
effort`` above was not sufficient on its own.
``TradingAgentsGraph._get_provider_kwargs()`` only forwarded the
``openai_reasoning_effort`` config value into LLM-client kwargs for the
literal provider string ``"openai"`` — every other OpenAI-compatible alias
(``openai_compatible``, ``xai``, ``deepseek``, ...), despite routing through
the exact same ``OpenAIClient``, never had the kwarg forwarded at all, so it
never even reached ``_supports_reasoning_effort`` to be filtered. Confirmed via
two real post-fix verification runs (single ticker, 2026-08-13) that still hit
transient backend errors (``Error 524`` then ``Error 503``) — the fix at the
model-recognition layer alone never actually took effect in production because
this earlier gate silently dropped the kwarg first.
"""

import pytest

from tradingagents.graph.trading_graph import TradingAgentsGraph
from tradingagents.llm_clients.openai_client import (
    OpenAIClient,
    _supports_reasoning_effort,
)


@pytest.mark.parametrize(
    "model,expected",
    [
        ("gpt-5.5", True), ("gpt-5.4", True), ("gpt-5.4-mini", True),
        ("gpt-5.5-pro", True), ("o1", True), ("o3-mini", True),
        ("gpt-4.1", False), ("gpt-4o", False), ("gpt-4o-mini", False),
        ("gpt-3.5-turbo", False),
        # xAI grok reasoning-tier models (flagship, version-numbered).
        ("grok-4.5", True), ("grok-4.3", True), ("grok-4.6", True),
        ("grok-4.20-0309-reasoning", True), ("grok-4.20-multi-agent-0309", True),
        # Explicit non-reasoning / utility grok variants must still drop it —
        # sending reasoning_effort to these would 400 the same way gpt-4.1 does.
        ("grok-4.20-0309-non-reasoning", False), ("grok-chat-fast", False),
        ("grok-composer-2.5-fast", False), ("grok-build-0.1", False),
    ],
)
def test_supports_reasoning_effort(model, expected):
    assert _supports_reasoning_effort(model) is expected


def _effort_on(model, monkeypatch, provider="openai", api_key_env="OPENAI_API_KEY"):
    # A fake key lets get_llm() construct the client without a network call.
    monkeypatch.setenv(api_key_env, "test-key")
    kwargs = {"reasoning_effort": "low"}
    if provider == "openai_compatible":
        kwargs["base_url"] = "https://sub.anzhiyu.com/v1"
    llm = OpenAIClient(model, provider=provider, **kwargs).get_llm()
    return getattr(llm, "reasoning_effort", None)


def test_reasoning_model_receives_effort(monkeypatch):
    assert _effort_on("gpt-5.4-mini", monkeypatch) == "low"


def test_non_reasoning_model_drops_effort(monkeypatch):
    # gpt-4.1 would 400 with reasoning_effort — it must be dropped.
    assert _effort_on("gpt-4.1", monkeypatch) is None


def test_grok_reasoning_model_receives_effort_via_openai_compatible_provider(monkeypatch):
    # This is the actual production path (TRADINGAGENTS_LLM_PROVIDER=openai_compatible,
    # TRADINGAGENTS_LLM_BACKEND_URL=https://sub.anzhiyu.com/v1), not the native "openai"
    # provider — the gate must recognize grok models through this path too.
    assert _effort_on(
        "grok-4.5", monkeypatch,
        provider="openai_compatible", api_key_env="OPENAI_COMPATIBLE_API_KEY",
    ) == "low"


def test_grok_non_reasoning_model_drops_effort_via_openai_compatible_provider(monkeypatch):
    assert _effort_on(
        "grok-chat-fast", monkeypatch,
        provider="openai_compatible", api_key_env="OPENAI_COMPATIBLE_API_KEY",
    ) is None


# --- _get_provider_kwargs(): config -> kwargs forwarding, before OpenAIClient
# ever sees the value (the second, independent gap described in the module
# docstring). Uses the same object.__new__ bypass as test_llm_max_retries.py
# so this stays a pure config-in/kwargs-out unit test with no network.

def _bare_graph(config):
    g = object.__new__(TradingAgentsGraph)
    g.config = config
    return g


def test_reasoning_effort_not_forwarded_for_native_openai_only_historically():
    """Documents the pre-fix behavior for the literal "openai" provider,
    which always worked — the bug was every OTHER openai-compatible alias
    being silently excluded, not "openai" itself."""
    kwargs = _bare_graph(
        {"llm_provider": "openai", "openai_reasoning_effort": "low"}
    )._get_provider_kwargs()
    assert kwargs["reasoning_effort"] == "low"


@pytest.mark.parametrize("provider", ["openai_compatible", "xai", "deepseek"])
def test_reasoning_effort_forwarded_for_openai_compatible_aliases(provider):
    kwargs = _bare_graph(
        {"llm_provider": provider, "openai_reasoning_effort": "low"}
    )._get_provider_kwargs()
    assert kwargs["reasoning_effort"] == "low"


def test_reasoning_effort_not_forwarded_when_unset():
    kwargs = _bare_graph(
        {"llm_provider": "openai_compatible", "openai_reasoning_effort": None}
    )._get_provider_kwargs()
    assert "reasoning_effort" not in kwargs
