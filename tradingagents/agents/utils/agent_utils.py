import functools
import logging
from collections.abc import Mapping
from typing import Any

import yfinance as yf
from langchain_core.messages import HumanMessage, RemoveMessage

from tradingagents.evidence import market_trade_date

# Import tools from separate utility files
from tradingagents.agents.utils.core_stock_tools import get_stock_data
from tradingagents.agents.utils.fundamental_data_tools import (
    get_balance_sheet,
    get_cashflow,
    get_fundamentals,
    get_income_statement,
)
from tradingagents.agents.utils.macro_data_tools import get_macro_indicators
from tradingagents.agents.utils.market_data_validation_tools import get_verified_market_snapshot
from tradingagents.agents.utils.news_data_tools import (
    get_global_news,
    get_insider_transactions,
    get_news,
)
from tradingagents.agents.utils.prediction_markets_tools import get_prediction_markets
from tradingagents.agents.utils.technical_indicators_tools import get_indicators

# Public surface: the data tools are imported here so agents and the graph
# import them from one place, plus the instrument/language helpers defined below.
__all__ = [
    "get_stock_data",
    "get_indicators",
    "get_fundamentals",
    "get_balance_sheet",
    "get_cashflow",
    "get_income_statement",
    "get_news",
    "get_global_news",
    "get_insider_transactions",
    "get_macro_indicators",
    "get_prediction_markets",
    "get_verified_market_snapshot",
    "build_instrument_context",
    "resolve_instrument_identity",
    "get_instrument_context_from_state",
    "get_language_instruction",
    "create_msg_delete",
]

logger = logging.getLogger(__name__)

_STATIC_IDENTITIES = {
    "515880.SS": {
        "company_name": "国泰中证全指通信设备交易型开放式指数证券投资基金",
        "sector": "Communication Equipment",
        "industry": "Exchange Traded Fund",
        "exchange": "SSE",
    },
    "512480.SS": {
        "company_name": "国联安中证全指半导体产品与设备交易型开放式指数证券投资基金",
        "sector": "Semiconductors",
        "industry": "Exchange Traded Fund",
        "exchange": "SSE",
    },
    "159995.SZ": {
        "company_name": "华夏国证半导体芯片交易型开放式指数证券投资基金",
        "sector": "Semiconductors",
        "industry": "Exchange Traded Fund",
        "exchange": "SZSE",
    },
    "GOOG": {
        "company_name": "Alphabet Inc.",
        "sector": "Communication Services",
        "industry": "Internet Content & Information",
        "exchange": "NASDAQ",
    },
    "GOOGL": {
        "company_name": "Alphabet Inc.",
        "sector": "Communication Services",
        "industry": "Internet Content & Information",
        "exchange": "NASDAQ",
    },
    "3887.HK": {
        "company_name": "HashKey Holdings Limited",
        "sector": "Financial Services",
        "industry": "Financial Data & Stock Exchanges",
        "exchange": "HKG",
    },
}


def get_language_instruction() -> str:
    """Return a prompt instruction for the configured output language.

    Returns empty string when English (default), so no extra tokens are used.
    Applied to every agent whose output reaches the saved report —
    analysts, researchers, debaters, research manager, trader, and
    portfolio manager — so a non-English run produces a fully localized
    report rather than a mix of languages.
    """
    from tradingagents.dataflows.config import get_config
    lang = get_config().get("output_language", "English")
    if lang.strip().lower() == "english":
        return ""
    return f" Write your entire response in {lang}."


def _clean_identity_value(value: Any) -> str | None:
    """Return a trimmed string, or None for empty / placeholder-ish values."""
    if not isinstance(value, str):
        return None
    cleaned = value.strip()
    if not cleaned or cleaned.lower() in {"none", "n/a", "nan", "null"}:
        return None
    return cleaned


@functools.lru_cache(maxsize=256)
def resolve_instrument_identity(ticker: str) -> dict:
    """Resolve deterministic identity metadata (company name, sector, …) for a ticker.

    This exists to stop the pipeline from hallucinating a *different* company
    when a chart pattern suggests a different industry than the real one
    (#814): without a ground-truth name, the market analyst would pattern-match
    the price action to a narrative and invent an identity that then cascaded
    through every downstream agent.

    Best-effort by design: if yfinance is unavailable, rate-limited, or doesn't
    recognise the ticker, we return ``{}`` and the caller falls back to
    ticker-only context rather than failing before analysis starts. Cached so
    the lookup happens at most once per ticker per process.

    The symbol is normalized first (e.g. ``XAUUSD`` -> ``GC=F``) so identity
    resolves for the same instrument the price path actually fetches (#983).
    """
    from tradingagents.dataflows.symbol_utils import normalize_symbol

    canonical = normalize_symbol(ticker)
    if canonical in _STATIC_IDENTITIES:
        return dict(_STATIC_IDENTITIES[canonical])
    try:
        info = yf.Ticker(canonical).info or {}
    except Exception as exc:  # noqa: BLE001 — fail open, never block the run
        logger.debug("Could not resolve instrument identity for %s: %s", ticker, exc)
        return dict(_STATIC_IDENTITIES.get(canonical, {}))

    identity: dict[str, str] = {}
    company_name = _clean_identity_value(info.get("longName")) or _clean_identity_value(
        info.get("shortName")
    )
    if company_name:
        identity["company_name"] = company_name
    for source_key, target_key in (
        ("sector", "sector"),
        ("industry", "industry"),
        ("exchange", "exchange"),
        ("quoteType", "quote_type"),
    ):
        value = _clean_identity_value(info.get(source_key))
        if value:
            identity[target_key] = value
    return identity or dict(_STATIC_IDENTITIES.get(canonical, {}))


def build_instrument_context(
    ticker: str,
    asset_type: str = "stock",
    identity: Mapping[str, str] | None = None,
) -> str:
    """Describe the exact instrument so agents preserve identity and ticker.

    When ``identity`` is provided (resolved deterministically via
    :func:`resolve_instrument_identity`), the company name and business
    classification are injected so agents anchor to the real company rather
    than pattern-matching the price chart to a wrong one (#814).
    """
    is_crypto = asset_type in {"crypto", "crypto_driver"}
    is_etf = asset_type in {"cn_etf", "us_etf"}
    instrument_label = "asset" if is_crypto else "ETF" if is_etf else "instrument"
    context = (
        f"The {instrument_label} to analyze is `{ticker}`. "
        "Use this exact ticker in every tool call, report, and recommendation, "
        "preserving any exchange suffix (e.g. `.TO`, `.L`, `.HK`, `.T`, `-USD`)."
    )

    details = []
    if identity:
        name = identity.get("company_name") or identity.get("name")
        if name:
            details.append(f"{'Name' if is_crypto or is_etf else 'Company'}: {name}")
        sector, industry = identity.get("sector"), identity.get("industry")
        if sector and industry:
            details.append(f"Business classification: {sector} / {industry}")
        elif sector:
            details.append(f"Sector: {sector}")
        elif industry:
            details.append(f"Industry: {industry}")
        if identity.get("exchange"):
            details.append(f"Exchange: {identity['exchange']}")

    if details:
        context += (
            f" Resolved identity: {'; '.join(details)}. "
            "Do not substitute a different company or ticker unless a tool "
            "result explicitly disproves this resolved identity."
        )

    if is_crypto:
        context += (
            " Treat it as a crypto asset rather than a company, and do not "
            "assume company fundamentals are available."
        )
    elif is_etf:
        context += (
            " Treat it as an ETF, not an operating company: analyze its tracked "
            "index, holdings, NAV/premium-discount, concentration, liquidity, "
            "fees, tracking error, and corporate actions before making a view. "
            "Do not invent an income statement or a company valuation."
        )
    return context


def get_instrument_context_from_state(state: Mapping[str, Any]) -> str:
    """Return the instrument context for the current run.

    Prefers the identity-resolved context computed once at run start and
    stored on the state (see ``TradingAgentsGraph.resolve_instrument_context``).
    Falls back to a ticker-only context — with no network lookup — when the
    state was constructed without it (bare programmatic states, tests), so a
    consumer is never forced to make a yfinance call mid-graph.
    """
    context = state.get("instrument_context")
    if isinstance(context, str) and context.strip():
        result = context
    else:
        result = build_instrument_context(
            str(state["company_of_interest"]),
            state.get("asset_type", "stock"),
        )
    packet = state.get("evidence_packet")
    if isinstance(packet, Mapping):
        market = str((packet.get("instrument") or {}).get("market") or "")
        errors = packet.get("integrity", {}).get("errors", [])
        result += (
            " EvidencePacketV1 is authoritative for this run: "
            f"status={packet.get('status', 'unknown')}, "
            f"asOf={packet.get('asOf', 'unknown')}, "
            f"contentHash={packet.get('contentHash', 'unknown')}. "
            "Every numerical claim must cite the packet's exact Evidence ID "
            "(M=market, I=indicator, CA=corporate action, N=news, S=source). "
            "Do not introduce a number that is absent from the ledger; write "
            "'unavailable' instead. Do not propose a target price, numeric "
            "allocation, entry level, exit level, or stop loss. "
            "Separate verified facts, inference, transmission path, confidence, "
            "counter-evidence, and the next observation. "
        )
        if errors:
            result += (
                f"Validation errors are present ({', '.join(map(str, errors))}); "
                "do not issue a Buy/Sell rating or target price. "
            )
        ledger: list[str] = []
        for row in list(packet.get("bars") or [])[-8:]:
            ledger.append(
                f"[{row.get('evidenceId')}] "
                f"tradeDate={market_trade_date(row.get('ts'), market)} "
                f"ts={row.get('ts')} "
                f"open={row.get('open')} high={row.get('high')} "
                f"low={row.get('low')} close={row.get('close')} "
                f"volume={row.get('volume')}"
            )
        for row in list(packet.get("indicatorEvidence") or [])[:12]:
            ledger.append(
                f"[{row.get('evidenceId')}] {row.get('name')}={row.get('value')}"
            )
        for row in list(packet.get("corporateActions") or [])[:6]:
            ledger.append(
                f"[{row.get('evidenceId')}] corporate action "
                f"{row.get('type')} on {row.get('exDate') or row.get('date')}"
            )
        for row in list(packet.get("news") or [])[:8]:
            ledger.append(
                f"[{row.get('evidenceId')}] {row.get('publishedAt')} "
                f"{str(row.get('title') or '')[:180]} ({row.get('source')})"
            )
        for row in list(packet.get("sources") or [])[:8]:
            ledger.append(
                f"[{row.get('evidenceId')}] source={row.get('source')} "
                f"asOf={row.get('asOf')} tier={row.get('sourceTier')}"
            )
        if ledger:
            result += " Citable evidence ledger:\n" + "\n".join(ledger) + "\n"
    return result


def create_msg_delete():
    def delete_messages(state):
        """Clear messages and add a context-anchored placeholder.

        The placeholder must not be a bare ``"Continue"``: some
        OpenAI-compatible providers interpret that literally as the user task
        and produce output about the word "continue" instead of analysing the
        instrument (#888). Anchoring it to the resolved instrument context and
        date keeps the next analyst on-task even if the provider treats the
        placeholder as a standalone request.
        """
        messages = state["messages"]
        removal_operations = [RemoveMessage(id=m.id) for m in messages]

        instrument_context = get_instrument_context_from_state(state)
        trade_date = state.get("trade_date", "the requested date")
        placeholder = HumanMessage(
            content=(
                f"Proceed with your assigned analysis for this workflow. "
                f"{instrument_context} The analysis date is {trade_date}."
            )
        )
        return {"messages": removal_operations + [placeholder]}

    return delete_messages



