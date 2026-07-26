"""Reliable multi-source news aggregation with a stable structured contract."""

from __future__ import annotations

import json
import logging
import os
from collections.abc import Callable
from datetime import datetime, timedelta
from functools import partial
from typing import Any

from . import alpha_vantage_news
from .config import get_config
from .google_news import fetch_ticker_news_google
from .news_common import (
    NewsAggregationResult,
    NewsItem,
    SourceStatus,
    ensure_utc,
    format_news_report,
    latest_feed_supports_window,
    normalize_filter_dedupe,
    parse_timestamp,
    ticker_window_timezone,
    utc_now,
    validate_news_window,
)
from .official_news import fetch_federal_reserve_news, fetch_sec_filings
from .symbol_utils import normalize_symbol
from .yfinance_news import fetch_global_news_yfinance, fetch_ticker_news_yfinance

logger = logging.getLogger(__name__)

_SOURCE_LABELS = {
    "yfinance": "Yahoo Finance",
    "google_news": "Google News RSS",
    "sec": "SEC EDGAR",
    "federal_reserve": "Federal Reserve",
    "alpha_vantage": "Alpha Vantage",
}
_SOURCE_ALIASES = {
    "fed": "federal_reserve",
    "edgar": "sec",
    "google": "google_news",
    "yahoo": "yfinance",
}


def _configured_sources(config: dict, key: str, default: str) -> list[str]:
    raw = config.get(key, default)
    values = raw if isinstance(raw, (list, tuple)) else str(raw).split(",")
    result: list[str] = []
    for value in values:
        source = _SOURCE_ALIASES.get(str(value).strip().lower(), str(value).strip().lower())
        if source and source not in result:
            result.append(source)
    return result


def _alpha_payload(payload: dict | str) -> dict:
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except json.JSONDecodeError as exc:
            raise ValueError("Alpha Vantage news response was not JSON") from exc
    if not isinstance(payload, dict):
        raise ValueError("Alpha Vantage news response was not an object")
    error = payload.get("Error Message") or payload.get("Information") or payload.get("Note")
    if error and not payload.get("feed"):
        raise ValueError("Alpha Vantage news response contained an API error")
    if "feed" not in payload or not isinstance(payload["feed"], list):
        raise ValueError("Alpha Vantage news response has no valid feed list")
    return payload


def _alpha_items(
    payload: dict | str,
    *,
    fetched_at: datetime,
    ticker: str | None,
) -> list[NewsItem]:
    canonical = normalize_symbol(ticker).upper() if ticker else None
    items: list[NewsItem] = []
    for article in _alpha_payload(payload).get("feed", []):
        if not isinstance(article, dict):
            continue
        published_at = parse_timestamp(article.get("time_published"))
        if published_at is None:
            continue
        sentiments = article.get("ticker_sentiment")
        if ticker and isinstance(sentiments, list) and sentiments:
            related = {
                str(entry.get("ticker", "")).strip().upper()
                for entry in sentiments
                if isinstance(entry, dict)
            }
            if canonical not in related and ticker.upper() not in related:
                continue
        publisher = str(article.get("source") or "Unknown").strip()
        items.append(
            NewsItem(
                title=article.get("title", ""),
                summary=article.get("summary", ""),
                url=article.get("url", ""),
                source=f"Alpha Vantage / {publisher}",
                published_at=published_at,
                fetched_at=fetched_at,
                ticker=ticker,
                source_tier="aggregator",
            )
        )
    return items


def _fetch_alpha_ticker(
    ticker: str,
    start_date: str,
    end_date: str,
    fetched_at: datetime,
) -> list[NewsItem]:
    return _alpha_items(
        alpha_vantage_news.get_news(ticker, start_date, end_date),
        fetched_at=fetched_at,
        ticker=ticker,
    )


def _fetch_alpha_global(
    curr_date: str,
    look_back_days: int,
    limit: int,
    fetched_at: datetime,
) -> list[NewsItem]:
    return _alpha_items(
        alpha_vantage_news.get_global_news(curr_date, look_back_days, limit),
        fetched_at=fetched_at,
        ticker=None,
    )


def _source_failure(source: str, exc: Exception) -> SourceStatus:
    # Do not put raw request exceptions in output/logs: prepared URLs from some
    # vendors can contain API keys. The exception type is enough for diagnosis.
    logger.warning("News source %s failed (%s)", source, type(exc).__name__)
    return SourceStatus(
        _SOURCE_LABELS.get(source, source),
        "failed",
        detail=f"request failed ({type(exc).__name__})",
    )


def _collect_source(
    source: str,
    collector: Callable[[], list[NewsItem]],
) -> tuple[list[NewsItem], SourceStatus]:
    try:
        items = collector()
    except Exception as exc:  # noqa: BLE001 - one bad source must not abort aggregation
        return [], _source_failure(source, exc)
    return items, SourceStatus(
        _SOURCE_LABELS.get(source, source),
        "ok" if items else "empty",
        len(items),
    )


def _common_settings(config: dict) -> tuple[int, str, int, str]:
    timeout = max(1, int(config.get("news_request_timeout_seconds", 15)))
    user_agent = str(
        config.get(
            "news_user_agent",
            "TradingAgents/0.3.1 (https://github.com/gaaiyun/TradingAgents)",
        )
    ).strip()
    future_minutes = max(0, int(config.get("news_future_tolerance_minutes", 5)))
    sec_contact_email = str(config.get("news_sec_contact_email", "")).strip()
    return timeout, user_agent, future_minutes, sec_contact_email


def aggregate_ticker_news(
    ticker: str,
    start_date: str,
    end_date: str,
    *,
    now: datetime | None = None,
    config: dict | None = None,
) -> NewsAggregationResult:
    """Collect, normalize, filter, and de-duplicate ticker-specific news."""
    config = get_config() if config is None else config
    window_timezone = ticker_window_timezone(ticker)
    validate_news_window(start_date, end_date, window_timezone)
    fetched_at = ensure_utc(now or utc_now())
    limit = max(0, int(config.get("news_article_limit", 20)))
    timeout, user_agent, future_minutes, sec_contact_email = _common_settings(config)
    sources = _configured_sources(config, "news_ticker_sources", "yfinance,google_news,sec")
    forms = {
        form.strip().upper()
        for form in str(
            config.get(
                "news_sec_forms",
                "8-K,10-Q,10-K,6-K,20-F,40-F,S-1,DEF 14A",
            )
        ).split(",")
        if form.strip()
    }

    collected: list[NewsItem] = []
    statuses: list[SourceStatus] = []
    if not sources:
        statuses.append(
            SourceStatus("news configuration", "not_configured", detail="no ticker sources")
        )
    for source in sources:
        if source == "yfinance":
            if not latest_feed_supports_window(end_date, fetched_at, window_timezone):
                statuses.append(
                    SourceStatus(
                        _SOURCE_LABELS[source],
                        "unsupported",
                        detail="latest-only feed cannot cover this historical window",
                    )
                )
                continue
            collector = partial(
                fetch_ticker_news_yfinance,
                ticker,
                limit=max(limit, 1),
                fetched_at=fetched_at,
            )
        elif source == "google_news":
            collector = partial(
                fetch_ticker_news_google,
                ticker,
                start_date=start_date,
                end_date=end_date,
                fetched_at=fetched_at,
                limit=max(limit, 1),
                timeout=timeout,
                user_agent=user_agent,
                window_timezone=window_timezone,
            )
        elif source == "sec":
            collector = partial(
                fetch_sec_filings,
                ticker,
                fetched_at=fetched_at,
                limit=max(limit, 1),
                timeout=timeout,
                user_agent=user_agent,
                forms=forms,
                sec_contact_email=sec_contact_email,
                start_date=start_date,
                end_date=end_date,
                window_timezone=window_timezone,
            )
        elif source == "alpha_vantage":
            if not os.getenv("ALPHA_VANTAGE_API_KEY"):
                statuses.append(
                    SourceStatus(
                        _SOURCE_LABELS[source],
                        "not_configured",
                        detail="ALPHA_VANTAGE_API_KEY is not set; source was not called",
                    )
                )
                continue
            collector = partial(
                _fetch_alpha_ticker,
                ticker,
                start_date,
                end_date,
                fetched_at,
            )
        else:
            statuses.append(
                SourceStatus(source, "failed", detail="unsupported configured news source")
            )
            continue

        source_items, source_status = _collect_source(source, collector)
        collected.extend(source_items)
        statuses.append(source_status)

    items = normalize_filter_dedupe(
        collected,
        start_date,
        end_date,
        fetched_at=fetched_at,
        limit=limit,
        future_tolerance=timedelta(minutes=future_minutes),
        window_timezone=window_timezone,
    )
    return NewsAggregationResult(
        items=items,
        source_statuses=statuses,
        fetched_at=fetched_at,
        start_date=start_date,
        end_date=end_date,
        ticker=ticker.upper(),
        query_type="ticker",
        metadata={"configured_sources": sources, "window_timezone": window_timezone},
    )


def aggregate_global_news(
    curr_date: str,
    look_back_days: int | None = None,
    limit: int | None = None,
    *,
    now: datetime | None = None,
    config: dict | None = None,
) -> NewsAggregationResult:
    """Collect global market news from Yahoo plus first-party Fed releases."""
    config = get_config() if config is None else config
    look_back_days = (
        int(config.get("global_news_lookback_days", 7))
        if look_back_days is None
        else int(look_back_days)
    )
    limit = (
        int(config.get("global_news_article_limit", 10)) if limit is None else int(limit)
    )
    if look_back_days < 0:
        raise ValueError("look_back_days must be non-negative")
    limit = max(0, limit)
    curr_dt = datetime.strptime(curr_date, "%Y-%m-%d")
    start_date = (curr_dt - timedelta(days=look_back_days)).strftime("%Y-%m-%d")
    fetched_at = ensure_utc(now or utc_now())
    window_timezone = "UTC"
    timeout, user_agent, future_minutes, _sec_contact_email = _common_settings(config)
    sources = _configured_sources(
        config,
        "news_global_sources",
        "yfinance,federal_reserve",
    )

    collected: list[NewsItem] = []
    statuses: list[SourceStatus] = []
    if not sources:
        statuses.append(
            SourceStatus("news configuration", "not_configured", detail="no global sources")
        )
    for source in sources:
        if source == "yfinance":
            if not latest_feed_supports_window(curr_date, fetched_at, window_timezone):
                statuses.append(
                    SourceStatus(
                        _SOURCE_LABELS[source],
                        "unsupported",
                        detail="latest-only feed cannot cover this historical window",
                    )
                )
                continue
            collector = partial(
                fetch_global_news_yfinance,
                queries=list(config.get("global_news_queries", [])),
                limit=max(limit, 1),
                fetched_at=fetched_at,
            )
        elif source == "federal_reserve":
            if not latest_feed_supports_window(curr_date, fetched_at, window_timezone):
                statuses.append(
                    SourceStatus(
                        _SOURCE_LABELS[source],
                        "unsupported",
                        detail="current RSS feed cannot cover this historical window",
                    )
                )
                continue
            collector = partial(
                fetch_federal_reserve_news,
                fetched_at=fetched_at,
                limit=max(limit, 1),
                timeout=timeout,
                user_agent=user_agent,
                start_date=start_date,
                end_date=curr_date,
                window_timezone=window_timezone,
            )
        elif source == "alpha_vantage":
            if not os.getenv("ALPHA_VANTAGE_API_KEY"):
                statuses.append(
                    SourceStatus(
                        _SOURCE_LABELS[source],
                        "not_configured",
                        detail="ALPHA_VANTAGE_API_KEY is not set; source was not called",
                    )
                )
                continue
            collector = partial(
                _fetch_alpha_global,
                curr_date,
                look_back_days,
                max(limit, 1),
                fetched_at,
            )
        else:
            statuses.append(
                SourceStatus(source, "failed", detail="unsupported configured news source")
            )
            continue

        source_items, source_status = _collect_source(source, collector)
        collected.extend(source_items)
        statuses.append(source_status)

    items = normalize_filter_dedupe(
        collected,
        start_date,
        curr_date,
        fetched_at=fetched_at,
        limit=limit,
        future_tolerance=timedelta(minutes=future_minutes),
        window_timezone=window_timezone,
    )
    return NewsAggregationResult(
        items=items,
        source_statuses=statuses,
        fetched_at=fetched_at,
        start_date=start_date,
        end_date=curr_date,
        query_type="global",
        metadata={"configured_sources": sources, "window_timezone": window_timezone},
    )


def get_news_items(ticker: str, start_date: str, end_date: str) -> list[dict[str, Any]]:
    """Return only JSON-ready NewsItems for simple batch/export callers.

    Call :func:`get_news_bundle` when source health must be preserved too.
    """
    return [item.to_dict() for item in aggregate_ticker_news(ticker, start_date, end_date).items]


def get_news_bundle(ticker: str, start_date: str, end_date: str) -> dict[str, Any]:
    """Return JSON-ready items and source health (recommended export contract)."""
    return aggregate_ticker_news(ticker, start_date, end_date).to_dict()


def get_global_news_bundle(
    curr_date: str,
    look_back_days: int | None = None,
    limit: int | None = None,
) -> dict[str, Any]:
    """Return the JSON-ready global-news bundle."""
    return aggregate_global_news(curr_date, look_back_days, limit).to_dict()


def get_news_aggregated(ticker: str, start_date: str, end_date: str) -> str:
    result = aggregate_ticker_news(ticker, start_date, end_date)
    return format_news_report(
        result,
        f"{ticker} News, from {start_date} to {end_date}",
    )


def get_global_news_aggregated(
    curr_date: str,
    look_back_days: int | None = None,
    limit: int | None = None,
) -> str:
    result = aggregate_global_news(curr_date, look_back_days, limit)
    return format_news_report(
        result,
        f"Global Market News, from {result.start_date} to {result.end_date}",
    )
