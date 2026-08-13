"""Automatic fallback to a secondary OpenAI-compatible model when the primary
relay is transiently unavailable.

Motivated by a real incident (2026-08-13): the sub.anzhiyu.com relay serving
grok-4.5 went down mid-session (confirmed via two real verification runs
hitting ``Error 524`` then ``Error 503``, and a direct probe where even a
trivial ``/v1/chat/completions`` request failed to connect within 60s while
``/v1/models`` stayed healthy). The user has a second, independently-billed
key on the same relay routed to cheap GPT models (gpt-5.4-mini) and asked for
an automatic default-to-GPT fallback for exactly this situation, favoring the
cheap model.

Only genuinely transient conditions fall back (connection failure, 5xx,
429) — a 400/401/403 must still surface normally, since retrying those
against a different backend would silently mask a real misconfiguration
(bad request shape, revoked key) instead of failing loudly.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import httpx
import openai
import pytest
from langchain_core.messages import AIMessage, HumanMessage
from pydantic import BaseModel

from tradingagents.graph.trading_graph import TradingAgentsGraph
from tradingagents.llm_clients.openai_client import NormalizedChatOpenAI


def _request():
    return httpx.Request("POST", "https://sub.anzhiyu.com/v1/chat/completions")


def _connection_error():
    return openai.APIConnectionError(request=_request())


def _status_error(cls, status_code):
    return cls("simulated", response=httpx.Response(status_code, request=_request()), body=None)


TRANSIENT_ERRORS = [
    pytest.param(_connection_error(), id="connection-error"),
    pytest.param(_status_error(openai.InternalServerError, 524), id="524-cloudflare-timeout"),
    pytest.param(_status_error(openai.InternalServerError, 503), id="503-service-unavailable"),
    pytest.param(_status_error(openai.RateLimitError, 429), id="429-rate-limited"),
]

NON_TRANSIENT_ERRORS = [
    pytest.param(_status_error(openai.BadRequestError, 400), id="400-bad-request"),
    pytest.param(_status_error(openai.AuthenticationError, 401), id="401-bad-key"),
]


def _primary(model="grok-4.5"):
    return NormalizedChatOpenAI(
        model=model, api_key="primary-dummy", base_url="https://sub.anzhiyu.com/v1"
    )


@pytest.mark.unit
def test_fallback_llm_defaults_to_none():
    assert _primary().fallback_llm is None


@pytest.mark.unit
def test_no_fallback_configured_propagates_transient_error():
    llm = _primary()
    with patch.object(llm, "_generate", side_effect=_connection_error()):
        with pytest.raises(openai.APIConnectionError):
            llm.invoke([HumanMessage(content="hi")])


@pytest.mark.unit
@pytest.mark.parametrize("error", TRANSIENT_ERRORS)
def test_transient_error_falls_back(error):
    llm = _primary()
    fallback = MagicMock()
    fallback.invoke.return_value = AIMessage(content="fallback answer")
    llm.fallback_llm = fallback

    with patch.object(llm, "_generate", side_effect=error):
        result = llm.invoke([HumanMessage(content="hi")])

    assert result.content == "fallback answer"
    fallback.invoke.assert_called_once()


@pytest.mark.unit
@pytest.mark.parametrize("error", NON_TRANSIENT_ERRORS)
def test_non_transient_error_is_not_masked_by_fallback(error):
    """A 400/401 must still surface even with a fallback configured — retrying
    elsewhere would hide a real bug (malformed request, revoked key) instead
    of failing loudly."""
    llm = _primary()
    fallback = MagicMock()
    fallback.invoke.return_value = AIMessage(content="should never be returned")
    llm.fallback_llm = fallback

    with patch.object(llm, "_generate", side_effect=error):
        with pytest.raises(type(error)):
            llm.invoke([HumanMessage(content="hi")])

    fallback.invoke.assert_not_called()


@pytest.mark.unit
def test_fallback_reached_through_structured_output():
    """with_structured_output()'s bound chain must still trigger the fallback
    — Portfolio Manager and every other structured-output agent call through
    this path, not a bare .invoke()."""
    llm = _primary()
    fallback = MagicMock()
    fallback.invoke.return_value = AIMessage(content='{"x": 1}')
    llm.fallback_llm = fallback

    class Schema(BaseModel):
        x: int

    structured = llm.with_structured_output(Schema, method="json_mode")
    with patch.object(llm, "_generate", side_effect=_status_error(openai.InternalServerError, 524)):
        structured.invoke([HumanMessage(content="hi")])

    fallback.invoke.assert_called_once()


# --- TradingAgentsGraph._build_fallback_llm(): config -> constructed client ---

def _bare_graph(config):
    g = object.__new__(TradingAgentsGraph)
    g.config = config
    return g


@pytest.mark.unit
def test_build_fallback_llm_none_when_unset():
    assert _bare_graph({"llm_fallback_model": None})._build_fallback_llm() is None


@pytest.mark.unit
def test_build_fallback_llm_none_when_empty_string():
    assert _bare_graph({"llm_fallback_model": ""})._build_fallback_llm() is None


@pytest.mark.unit
def test_build_fallback_llm_constructed_with_defaults(monkeypatch):
    monkeypatch.setenv("TRADINGAGENTS_LLM_FALLBACK_API_KEY", "fallback-dummy")
    graph = _bare_graph({
        "llm_fallback_model": "gpt-5.4-mini",
        "backend_url": "https://sub.anzhiyu.com/v1",
    })
    llm = graph._build_fallback_llm()
    assert llm is not None
    assert llm.model_name == "gpt-5.4-mini"
    # Defaults: provider openai_compatible, base_url inherited from the
    # primary's backend_url when llm_fallback_backend_url is unset.
    assert str(llm.openai_api_base).rstrip("/") == "https://sub.anzhiyu.com/v1"


@pytest.mark.unit
def test_build_fallback_llm_respects_explicit_overrides(monkeypatch):
    monkeypatch.setenv("TRADINGAGENTS_LLM_FALLBACK_API_KEY", "fallback-dummy")
    graph = _bare_graph({
        "llm_fallback_model": "gpt-5.4-mini",
        "llm_fallback_provider": "openai_compatible",
        "llm_fallback_backend_url": "https://example.invalid/v1",
        "backend_url": "https://sub.anzhiyu.com/v1",
    })
    llm = graph._build_fallback_llm()
    assert str(llm.openai_api_base).rstrip("/") == "https://example.invalid/v1"


@pytest.mark.unit
def test_provider_kwargs_include_fallback_llm_when_configured(monkeypatch):
    monkeypatch.setenv("TRADINGAGENTS_LLM_FALLBACK_API_KEY", "fallback-dummy")
    graph = _bare_graph({
        "llm_provider": "openai_compatible",
        "llm_fallback_model": "gpt-5.4-mini",
        "backend_url": "https://sub.anzhiyu.com/v1",
    })
    fallback = graph._build_fallback_llm()
    assert fallback is not None
    assert getattr(fallback, "model_name", None) == "gpt-5.4-mini"
