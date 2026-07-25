#!/usr/bin/env python3
"""Headless daily runner for CI: multi-ticker analysis -> static site + WeChat push.

设计目标（与上游解耦）：
  - 只消费 tradingagents 的公开 API（TradingAgentsGraph.propagate / save_reports），
    不改动上游任何模块；上游升级时本脚本随 fork rebase 即可。
  - 无 LLM key 时不报错：写出 status=unconfigured 的 latest.json 并 exit 0，
    静态站自我说明缺什么，定时任务保持绿色。
  - 单 ticker 失败不影响其余 ticker；全部失败才 exit 1。

环境变量（均可选）：
  TRADINGAGENTS_TICKERS      逗号分隔，默认 "SPY,NVDA"
  TRADINGAGENTS_ANALYSTS     逗号分隔子集，默认 "market,news,fundamentals"
  TRADINGAGENTS_LLM_PROVIDER 由 default_config 读取（default: openai）
  PUSHPLUS_TOKEN             微信推送 token，缺省跳过推送
  PAGES_URL                  推送消息里的报告站链接
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import traceback
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

CST = timezone(timedelta(hours=8))

RATING_TIERS = ["Sell", "Underweight", "Hold", "Overweight", "Buy"]

HISTORY_CAP = 60

NEWS_EXPORT_VERSION = 1
YAHOO_HISTORY_LIMIT = 1260
YAHOO_AUTO_ADJUSTMENT = "split-and-dividend-adjusted"
TECHNICAL_INDICATOR_VERSION = "ta-indicators-v1"
_NEWS_ITEM_FIELDS = (
    "title",
    "summary",
    "url",
    "source",
    "published_at",
    "fetched_at",
    "ticker",
    "source_tier",
)


def _failed_news_bundle(
    *,
    query_type: str,
    ticker: str | None,
    start_date: str,
    end_date: str,
    generated_at: str,
) -> dict[str, Any]:
    """Return a public-safe bundle when the aggregator itself cannot run."""
    return {
        "status": "failed",
        "query_type": query_type,
        "ticker": ticker,
        "start_date": start_date,
        "end_date": end_date,
        "fetched_at": generated_at,
        "items": [],
        "source_statuses": [
            {"source": "news exporter", "status": "failed", "item_count": 0}
        ],
    }


def _public_news_bundle(bundle: Any, fallback: dict[str, Any]) -> dict[str, Any]:
    """Keep the export limited to the stable aggregator contract.

    The aggregator already hides vendor request details.  This defensive
    projection also protects the static site if a future collector adds debug
    metadata or a monkeypatched/third-party adapter returns an exception value.
    """
    if not isinstance(bundle, dict):
        return fallback

    result = {
        key: bundle.get(key, fallback[key])
        for key in ("status", "query_type", "ticker", "start_date", "end_date", "fetched_at")
    }
    result["items"] = [
        {field: item.get(field) for field in _NEWS_ITEM_FIELDS}
        for item in bundle.get("items", [])
        if isinstance(item, dict)
    ]
    result["source_statuses"] = [
        {
            "source": str(status.get("source", "unknown source")),
            "status": str(status.get("status", "failed")),
            "item_count": int(status.get("item_count", 0) or 0),
        }
        for status in bundle.get("source_statuses", [])
        if isinstance(status, dict)
    ]
    return result


def _news_item_key(item: dict[str, Any]) -> tuple[str, str]:
    """Return a deterministic cross-bundle key, ignoring common URL tracking."""
    title = " ".join(str(item.get("title", "")).casefold().split())
    url = str(item.get("url", "")).strip()
    try:
        parsed = urlsplit(url)
        query = [
            (key, value)
            for key, value in parse_qsl(parsed.query, keep_blank_values=True)
            if not key.lower().startswith("utm_")
        ]
        url = urlunsplit(
            (
                parsed.scheme.lower(),
                parsed.netloc.lower(),
                parsed.path,
                urlencode(sorted(query)),
                "",
            )
        )
    except ValueError:
        pass
    return url, title


def _merge_news_items(bundles: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Combine global and ticker news without duplicate stories."""
    items: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for bundle in bundles:
        for item in bundle["items"]:
            key = _news_item_key(item)
            if key in seen:
                continue
            seen.add(key)
            items.append(item)
    return sorted(items, key=lambda item: str(item.get("published_at") or ""), reverse=True)


def write_news_export(
    data_dir: Path,
    *,
    tickers: list[str],
    trade_date: str,
    generated_at: str,
) -> dict[str, Any]:
    """Fetch independent news and write the static site's stable v1 contract.

    News is supplemental to the LLM workflow: every retrieval failure becomes a
    safe ``failed`` bundle rather than aborting ticker analysis or leaking a
    request URL, credential, or raw exception to the public artifact.
    """
    global_fallback = _failed_news_bundle(
        query_type="global",
        ticker=None,
        start_date=trade_date,
        end_date=trade_date,
        generated_at=generated_at,
    )
    ticker_bundles: dict[str, dict[str, Any]] = {}
    try:
        from tradingagents.dataflows.news_aggregator import (
            get_global_news_bundle,
            get_news_bundle,
        )
    except Exception:  # a partial install still gets a valid public artifact
        get_global_news_bundle = None
        get_news_bundle = None

    if get_global_news_bundle is None:
        global_bundle = global_fallback
    else:
        try:
            global_bundle = _public_news_bundle(
                get_global_news_bundle(trade_date), global_fallback
            )
        except Exception:  # supplemental data must not fail the analysis job
            global_bundle = global_fallback

    for ticker in tickers:
        fallback = _failed_news_bundle(
            query_type="ticker",
            ticker=ticker,
            start_date=trade_date,
            end_date=trade_date,
            generated_at=generated_at,
        )
        try:
            if get_news_bundle is None:
                raise RuntimeError("news aggregator unavailable")
            bundle = get_news_bundle(ticker, trade_date, trade_date)
            ticker_bundles[ticker] = _public_news_bundle(bundle, fallback)
        except Exception:  # supplemental data must not fail the analysis job
            ticker_bundles[ticker] = fallback

    all_bundles = [global_bundle, *ticker_bundles.values()]
    statuses = {str(bundle.get("status", "failed")) for bundle in all_bundles}
    if statuses == {"failed"}:
        status = "failed"
    elif statuses <= {"unavailable", "failed"}:
        status = "unavailable"
    elif statuses & {"failed", "unavailable", "partial", "partial_empty"}:
        status = "partial"
    else:
        status = "ok"

    payload = {
        "version": NEWS_EXPORT_VERSION,
        "status": status,
        "generated_at": generated_at,
        "trade_date": trade_date,
        "global": global_bundle,
        "tickers": ticker_bundles,
        "items": _merge_news_items(all_bundles),
    }
    (data_dir / "news.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return payload


def normalize_ticker(raw: str) -> str:
    """标准化标的代码：A股 6 位数字自动补交易所后缀，方便手机输入。

    6/5/9 开头（沪A/沪基金ETF/沪B）→ .SS；0/1/2/3 开头（深A/深基金/深B/创业板）→ .SZ。
    已带后缀或美股字母代码原样返回。
    """
    t = raw.strip().upper()
    if not t or "." in t:
        return "3887.HK" if t == "03887.HK" else t
    if t in {"03887", "3887"}:
        return "3887.HK"
    if t.isdigit() and len(t) == 6:
        return t + (".SS" if t[0] in "569" else ".SZ")
    return t


def _load_workbench_daily(symbol: str, trade_date: str) -> dict[str, Any] | None:
    """读取生产工作台已经校验和去重的前复权日线。"""
    import requests

    base = (
        os.environ.get("EVIDENCE_MARKET_API_URL", "").strip()
        or f"{os.environ.get('PAGES_URL', '').rstrip('/')}/api/market"
    )
    if not base.startswith("https://"):
        return None
    try:
        response = requests.get(
            base,
            params={"symbol": symbol, "timeframe": "1d", "limit": 1260},
            timeout=30,
        )
        if response.status_code != 200:
            return None
        payload = response.json()
    except (requests.RequestException, ValueError, TypeError):
        return None
    if payload.get("status") not in {"ok", "degraded", "stale"}:
        return None
    rows = payload.get("data")
    if not isinstance(rows, list) or not rows:
        return None
    bars: list[dict[str, Any]] = []
    for row in rows:
        timestamp = str(row.get("ts") or "")
        if not timestamp or timestamp[:10] > trade_date:
            continue
        bars.append({
            "ts": timestamp,
            "open": row.get("open"),
            "high": row.get("high"),
            "low": row.get("low"),
            "close": row.get("close"),
            "volume": row.get("volume"),
            "adjustment": row.get("adjustment") or "unknown",
        })
    if not bars:
        return None
    fetched_at = datetime.now(timezone.utc).isoformat()
    sources = []
    for row in payload.get("sources") or []:
        sources.append({
            "source": row.get("source") or "workbench-market",
            "asOf": row.get("asOf") or row.get("as_of") or payload.get("asOf"),
            "fetchedAt": row.get("fetchedAt") or row.get("fetched_at") or fetched_at,
            "sourceTier": (
                "evidence"
                if row.get("quality") == "good" and row.get("adjustment") == "qfq"
                else "discovery"
            ),
        })
    if not sources:
        for source in sorted({str(row.get("source") or "") for row in rows} - {""}):
            sources.append({
                "source": source,
                "asOf": payload.get("asOf"),
                "fetchedAt": fetched_at,
                "sourceTier": "evidence",
            })
    return {
        "bars": bars,
        "sources": sources,
        "indicators": payload.get("indicators") or {},
    }


def _load_workbench_news(symbol: str, trade_date: str) -> dict[str, Any]:
    """读取工作台新闻账本，并在建包前执行 point-in-time 截断。"""
    import requests

    base = (
        os.environ.get("EVIDENCE_NEWS_API_URL", "").strip()
        or f"{os.environ.get('PAGES_URL', '').rstrip('/')}/api/news"
    )
    empty = {"items": [], "sources": []}
    if not base.startswith("https://"):
        return empty
    try:
        response = requests.get(
            base,
            params={"symbol": symbol, "limit": 50},
            timeout=20,
        )
        if response.status_code != 200:
            return empty
        payload = response.json()
    except (requests.RequestException, ValueError, TypeError):
        return empty
    if payload.get("status") not in {"ok", "degraded", "stale"}:
        return empty
    rows = payload.get("data")
    if not isinstance(rows, list):
        return empty
    cutoff = f"{trade_date}T23:59:59Z"
    items = []
    for row in rows:
        published_at = str(row.get("published_at") or row.get("publishedAt") or "")
        if not published_at or published_at > cutoff or not row.get("title"):
            continue
        items.append({
            "id": row.get("id"),
            "title": row.get("title"),
            "url": row.get("url"),
            "publishedAt": published_at,
            "source": row.get("source"),
            "sourceTier": row.get("source_tier") or row.get("sourceTier") or "discovery",
        })
    sources = [
        {
            "source": row.get("source") or "workbench-news",
            "asOf": row.get("asOf") or row.get("as_of") or payload.get("asOf"),
            "fetchedAt": row.get("fetchedAt") or row.get("fetched_at"),
            "sourceTier": (
                row.get("sourceTier")
                or row.get("source_tier")
                or ("evidence" if row.get("quality") == "evidence" else "discovery")
            ),
        }
        for row in (payload.get("sources") or [])
    ]
    return {"items": items, "sources": sources}


def _ema_series(values: list[float], period: int) -> list[float | None]:
    result: list[float | None] = [None] * len(values)
    if len(values) < period:
        return result
    current = sum(values[:period]) / period
    result[period - 1] = current
    multiplier = 2 / (period + 1)
    for index in range(period, len(values)):
        current = (values[index] - current) * multiplier + current
        result[index] = current
    return result


def _rounded_indicator(value: float | None) -> float | None:
    return round(value, 8) if value is not None and math.isfinite(value) else None


def _calculate_technical_snapshot(bars: list[dict[str, Any]]) -> dict[str, Any]:
    """Match the workbench's deterministic daily indicator snapshot."""
    closes = [float(bar["close"]) for bar in bars]

    def simple_average(period: int) -> float | None:
        if len(closes) < period:
            return None
        return sum(closes[-period:]) / period

    fast = _ema_series(closes, 12)
    slow = _ema_series(closes, 26)
    macd_values = [
        fast[index] - slow[index]
        for index in range(len(closes))
        if fast[index] is not None and slow[index] is not None
    ]
    signal_values = _ema_series(macd_values, 9)
    latest_macd = macd_values[-1] if macd_values else None
    latest_signal = signal_values[-1] if signal_values else None

    rsi: float | None = None
    if len(closes) >= 15:
        changes = [
            closes[index] - closes[index - 1]
            for index in range(1, len(closes))
        ]
        average_gain = sum(max(0.0, change) for change in changes[:14]) / 14
        average_loss = sum(max(0.0, -change) for change in changes[:14]) / 14
        for change in changes[14:]:
            average_gain = (average_gain * 13 + max(0.0, change)) / 14
            average_loss = (average_loss * 13 + max(0.0, -change)) / 14
        if average_loss == 0:
            rsi = 50.0 if average_gain == 0 else 100.0
        else:
            rsi = 100 - 100 / (1 + average_gain / average_loss)

    atr: float | None = None
    eligible = [
        bar for bar in bars
        if bar.get("high") is not None and bar.get("low") is not None
    ]
    if len(eligible) >= 14:
        ranges = []
        for index, bar in enumerate(eligible):
            high = float(bar["high"])
            low = float(bar["low"])
            if index == 0:
                ranges.append(high - low)
                continue
            previous_close = float(eligible[index - 1]["close"])
            ranges.append(max(
                high - low,
                abs(high - previous_close),
                abs(low - previous_close),
            ))
        atr = sum(ranges[:14]) / 14
        for value in ranges[14:]:
            atr = (atr * 13 + value) / 14

    realized_volatility: float | None = None
    if len(closes) >= 21 and all(value > 0 for value in closes[-21:]):
        returns = [
            math.log(closes[index] / closes[index - 1])
            for index in range(len(closes) - 20, len(closes))
        ]
        mean = sum(returns) / len(returns)
        variance = sum((value - mean) ** 2 for value in returns) / max(
            1, len(returns) - 1
        )
        realized_volatility = math.sqrt(variance * 252) * 100

    adjustments = {
        str(bar.get("adjustment"))
        for bar in bars
        if isinstance(bar.get("adjustment"), str) and bar.get("adjustment")
    }
    missing_adjustment = any(not bar.get("adjustment") for bar in bars)
    adjustment = (
        "none" if not adjustments
        else next(iter(adjustments))
        if len(adjustments) == 1 and not missing_adjustment
        else "unknown"
    )
    return {
        "version": TECHNICAL_INDICATOR_VERSION,
        "bars": len(bars),
        "asOf": bars[-1]["ts"] if bars else None,
        "adjustment": adjustment,
        "ma20": _rounded_indicator(simple_average(20)),
        "ma60": _rounded_indicator(simple_average(60)),
        "ma200": _rounded_indicator(simple_average(200)),
        "macd": _rounded_indicator(latest_macd),
        "macdSignal": _rounded_indicator(latest_signal),
        "macdHistogram": _rounded_indicator(
            latest_macd - latest_signal
            if latest_macd is not None and latest_signal is not None
            else None
        ),
        "rsi14": _rounded_indicator(rsi),
        "atr14": _rounded_indicator(atr),
        "realizedVolatility20": _rounded_indicator(realized_volatility),
        "methodology": {
            "macd": "EMA 12/26, signal EMA 9",
            "rsi": "Wilder 14",
            "atr": "Wilder 14",
            "realizedVolatility": "20-period log returns, annualized with 252",
        },
    }


def build_runtime_evidence(ticker: str, trade_date: str) -> dict[str, Any]:
    """在模型调用前构建 point-in-time 证据包。

    A 股优先读取工作台 D1 中的前复权日线，使网页、问答和 Agent 使用同一数据口径；
    工作台不可用时才回退 Yahoo。任何无法解释的价格跳变都会阻断评级。
    """
    from cli.utils import detect_asset_type, normalize_ticker_symbol
    from tradingagents.evidence import build_evidence_packet

    symbol = normalize_ticker_symbol(ticker)
    asset_type = detect_asset_type(symbol).value
    cutoff = f"{trade_date}T23:59:59Z"
    workbench = _load_workbench_daily(symbol, trade_date)
    workbench_news = _load_workbench_news(symbol, trade_date)
    if workbench:
        return build_evidence_packet(
            ticker=symbol,
            asset_type=asset_type,
            as_of=cutoff,
            bars=workbench["bars"],
            indicators=workbench["indicators"],
            sources=[*workbench["sources"], *workbench_news["sources"]],
            news=workbench_news["items"],
        )

    import yfinance as yf

    trade_day = datetime.strptime(trade_date, "%Y-%m-%d").date()
    end_date = trade_day + timedelta(days=1)
    start_date = trade_day - timedelta(days=365 * 5 + 3)
    history = yf.Ticker(symbol).history(
        start=start_date.isoformat(),
        end=end_date.isoformat(),
        auto_adjust=True,
        actions=True,
    )
    bars: list[dict[str, Any]] = []
    dropped_incomplete_bars = 0
    dropped_target_bar = False
    if history is not None and not history.empty:
        for index, row in history.iterrows():
            timestamp = index.to_pydatetime()
            exchange_date = timestamp.date().isoformat()
            if exchange_date < start_date.isoformat() or exchange_date > trade_date:
                continue
            if timestamp.tzinfo is None:
                timestamp = timestamp.replace(tzinfo=timezone.utc)
            timestamp = timestamp.astimezone(timezone.utc)
            try:
                open_price = float(row.get("Open"))
                high = float(row.get("High"))
                low = float(row.get("Low"))
                close = float(row.get("Close"))
            except (TypeError, ValueError):
                dropped_incomplete_bars += 1
                dropped_target_bar = dropped_target_bar or exchange_date == trade_date
                continue
            if not all(math.isfinite(value) for value in (open_price, high, low, close)):
                dropped_incomplete_bars += 1
                dropped_target_bar = dropped_target_bar or exchange_date == trade_date
                continue
            bars.append({
                "ts": timestamp.isoformat().replace("+00:00", "Z"),
                "open": open_price,
                "high": high,
                "low": low,
                "close": close,
                "volume": row.get("Volume"),
                "adjustment": YAHOO_AUTO_ADJUSTMENT,
            })
    bars = bars[-YAHOO_HISTORY_LIMIT:]
    actions: list[dict[str, Any]] = []
    if history is not None and "Stock Splits" in history.columns:
        for index, value in history["Stock Splits"].items():
            action_date = index.date().isoformat()
            if (
                value
                and float(value) != 0
                and start_date.isoformat() <= action_date <= trade_date
            ):
                actions.append({
                    "type": "split",
                    "exDate": action_date,
                    "ratio": float(value),
                    "source": "yahoo-actions",
                })
    return build_evidence_packet(
        ticker=symbol,
        asset_type=asset_type,
        as_of=cutoff,
        bars=bars,
        indicators=_calculate_technical_snapshot(bars),
        corporate_actions=actions,
        integrity_errors=(
            ["MISSING_TARGET_DATE_BAR"]
            if bars and dropped_target_bar
            else []
        ),
        integrity_warnings=(
            ["DROPPED_INCOMPLETE_BAR"] if dropped_incomplete_bars else []
        ),
        sources=[{
            "source": "yahoo-finance",
            "asOf": cutoff,
            "fetchedAt": datetime.now(timezone.utc).isoformat(),
            "sourceTier": "discovery",
        }, *workbench_news["sources"]],
        news=workbench_news["items"],
    )


def backfill_history_report_files(data_dir: Path) -> int:
    """Record only report sections that actually exist on disk."""
    history_path = data_dir / "history.json"
    try:
        history = json.loads(history_path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return 0
    if not isinstance(history, list):
        return 0

    public_root = data_dir.parent.resolve()
    reports_root = (public_root / "reports").resolve()
    enriched = 0
    for batch in history:
        for result in batch.get("results", []) if isinstance(batch, dict) else []:
            if not isinstance(result, dict) or result.get("files"):
                continue
            report = str(result.get("report") or "")
            parts = report.split("/")
            if (
                len(parts) != 4
                or parts[0] != "reports"
                or parts[3] != "complete_report.md"
                or any(
                    not part
                    or part in {".", ".."}
                    or not all(char.isalnum() or char in "._-" for char in part)
                    for part in parts[1:3]
                )
            ):
                continue
            report_dir = public_root.joinpath(*parts[:-1]).resolve()
            try:
                report_dir.relative_to(reports_root)
            except ValueError:
                continue
            complete_report = report_dir / "complete_report.md"
            if not complete_report.is_file():
                continue
            files = {
                path.stem: path.relative_to(public_root).as_posix()
                for path in sorted(report_dir.rglob("*.md"))
                if path.is_file()
            }
            if not files:
                continue
            result["files"] = files
            enriched += 1

    if enriched:
        history_path.write_text(
            json.dumps(history, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    return enriched


def update_history(data_dir: Path, payload: dict, cap: int = HISTORY_CAP) -> int:
    """把本次运行追加进 history.json（同交易日同标的组合覆盖旧条目）。"""
    hist_path = data_dir / "history.json"
    try:
        history = json.loads(hist_path.read_text(encoding="utf-8"))
        if not isinstance(history, list):
            history = []
    except Exception:
        history = []

    key = (
        payload.get("trade_date"),
        tuple(sorted(r["ticker"] for r in payload.get("results", []))),
        tuple(sorted(str(r.get("report") or "") for r in payload.get("results", []))),
    )
    history = [
        h for h in history
        if (
            h.get("trade_date"),
            tuple(sorted(r.get("ticker", "") for r in h.get("results", []))),
            tuple(sorted(str(r.get("report") or "") for r in h.get("results", []))),
        ) != key
    ]
    entry = {
        "trade_date": payload.get("trade_date"),
        "generated_at": payload.get("generated_at"),
        "provider": payload.get("provider"),
        "results": [
            {
                "ticker": r["ticker"],
                "rating": r["rating"],
                "report": r["report"],
                "files": r.get("files") or {},
                "error": bool(r.get("error")),
                "analysis_status": r.get("analysis_status"),
                "audit_status": r.get("audit_status"),
                "evidence_publish": r.get("evidence_publish"),
            }
            for r in payload.get("results", [])
        ],
    }
    for field in ("request", "run"):
        if field in payload:
            entry[field] = payload[field]
    history.insert(0, entry)
    history = history[:cap]
    hist_path.write_text(json.dumps(history, ensure_ascii=False, indent=2), encoding="utf-8")
    backfill_history_report_files(data_dir)
    return len(history)


def report_save_directory(reports_dir: Path, symbol: str, trade_date: str) -> Path:
    """Choose a versioned directory without replacing an archived report."""
    base = reports_dir / symbol / trade_date
    if not (base / "complete_report.md").exists():
        return base
    version = 2
    while (reports_dir / symbol / f"{trade_date}-v{version}").exists():
        version += 1
    return reports_dir / symbol / f"{trade_date}-v{version}"


def last_us_trading_day(now_utc: datetime | None = None) -> str:
    """最近一个已收盘/进行中的美股交易日（周末回滚到周五）。"""
    now = now_utc or datetime.now(timezone.utc)
    d = now.date()
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    return d.isoformat()


def _workflow_metadata(analysts: list[str]) -> tuple[dict[str, Any], dict[str, Any]]:
    """Project trusted workflow identity fields into the public run manifest."""
    request_id = os.environ.get("TRADINGAGENTS_REQUEST_ID", "").strip() or None
    kind = os.environ.get("TRADINGAGENTS_REQUEST_KIND", "").strip()
    if not kind:
        kind = (
            "adhoc" if request_id
            else "monitor"
            if os.environ.get("TRADINGAGENTS_PROFILE_ID", "").strip()
            else "manual"
        )
    request = {
        "requestId": request_id,
        "analysts": list(analysts),
        "researchDepth": (
            os.environ.get("TRADINGAGENTS_RESEARCH_DEPTH", "").strip()
            or "standard"
        ),
        "kind": kind,
    }

    run_id = os.environ.get("GITHUB_RUN_ID", "").strip()
    server = os.environ.get("GITHUB_SERVER_URL", "").strip().rstrip("/")
    repository = os.environ.get("GITHUB_REPOSITORY", "").strip().strip("/")
    run = {
        "id": run_id or None,
        "attempt": os.environ.get("GITHUB_RUN_ATTEMPT", "").strip() or None,
        "workflow": os.environ.get("GITHUB_WORKFLOW", "").strip() or None,
        "url": (
            f"{server}/{repository}/actions/runs/{run_id}"
            if server and repository and run_id
            else None
        ),
    }
    return request, run


def resolve_llm_key_status() -> tuple[bool, str]:
    """判断当前 provider 的 API key 是否就绪。返回 (ready, provider)。"""
    from tradingagents.default_config import DEFAULT_CONFIG
    from tradingagents.llm_clients.api_key_env import get_api_key_env

    provider = str(DEFAULT_CONFIG.get("llm_provider", "openai")).lower()
    if os.environ.get("TRADINGAGENTS_ALLOW_KEYLESS", "").lower() in ("1", "true", "yes"):
        return True, provider
    env_name = get_api_key_env(provider)
    if env_name is None:  # ollama / bedrock 等自带凭据链
        return True, provider
    return bool(os.environ.get(env_name, "")), provider


def push_wechat(title: str, content: str) -> dict:
    """PushPlus 微信推送；无 token 时静默跳过。"""
    token = os.environ.get("PUSHPLUS_TOKEN", "")
    if not token:
        return {"sent": False, "reason": "no_token"}
    import requests

    try:
        resp = requests.post(
            "https://www.pushplus.plus/send",
            json={"token": token, "title": title, "content": content,
                  "template": "markdown", "channel": "wechat"},
            headers={"Content-Type": "application/json"},
            timeout=15,
        )
        data = resp.json()
        return {"sent": data.get("code") == 200, "code": data.get("code"), "msg": data.get("msg")}
    except Exception as exc:  # 推送失败不影响主流程
        return {"sent": False, "reason": str(exc)}


def publish_evidence_bundle(
    packet: dict,
    *,
    manifest: dict | None = None,
    report: str | None = None,
) -> dict:
    """把本次确定性证据包写入 D1；未配置或失败时不泄露响应正文。"""
    endpoint = os.environ.get("EVIDENCE_API_URL", "").strip()
    token = os.environ.get("EVIDENCE_WRITE_TOKEN", "").strip()
    if not endpoint or not token:
        return {"published": False, "reason": "not_configured"}

    import requests

    payload: dict = {"packet": packet}
    if manifest is not None and report is not None:
        payload.update({"manifest": manifest, "report": report})
    try:
        json.dumps(payload, ensure_ascii=False, allow_nan=False)
    except (TypeError, ValueError):
        return {"published": False, "reason": "invalid_payload"}
    try:
        response = requests.post(
            endpoint,
            json=payload,
            headers={
                "authorization": f"Bearer {token}",
                "content-type": "application/json",
            },
            timeout=20,
        )
    except requests.RequestException:
        return {"published": False, "reason": "network_error"}
    if response.status_code != 201:
        return {
            "published": False,
            "reason": "http_error",
            "status": response.status_code,
        }
    return {"published": True, "status": response.status_code}


def run_ticker(ticker: str, trade_date: str, analysts: list[str], reports_dir: Path) -> dict:
    """跑单个 ticker 的完整多智能体分析，返回结果摘要 dict。"""
    from cli.utils import detect_asset_type, normalize_ticker_symbol
    from tradingagents.default_config import DEFAULT_CONFIG
    from tradingagents.evidence import EvidenceValidationError
    from tradingagents.graph.trading_graph import TradingAgentsGraph

    symbol = normalize_ticker_symbol(ticker)
    try:
        evidence_packet = build_runtime_evidence(symbol, trade_date)
    except EvidenceValidationError:
        return {
            "ticker": symbol,
            "rating": None,
            "report": None,
            "files": {},
            "decision_excerpt": "",
            "analysis_status": "data_validation_failed",
            "audit_status": "invalidated",
            "evidence_publish": {
                "published": False,
                "reason": "invalid_payload",
            },
            "error": "evidence validation failed; model run skipped",
        }
    evidence_publish = publish_evidence_bundle(evidence_packet)
    if not evidence_packet.get("canRate"):
        return {
            "ticker": symbol,
            "rating": None,
            "report": None,
            "files": {},
            "decision_excerpt": "",
            "analysis_status": evidence_packet.get("status", "not_rated"),
            "audit_status": "invalidated" if evidence_packet.get("status") == "data_validation_failed" else "legacy_unverified",
            "evidence_publish": evidence_publish,
            "error": "evidence validation failed; model run skipped",
        }
    asset_type = detect_asset_type(symbol).value
    config = DEFAULT_CONFIG.copy()
    ta = TradingAgentsGraph(selected_analysts=analysts, debug=False, config=config)
    final_state, rating = ta.propagate(
        symbol,
        trade_date,
        asset_type=asset_type,
        evidence_packet=evidence_packet,
    )

    save_dir = report_save_directory(reports_dir, symbol, trade_date)
    ta.save_reports(final_state, symbol, save_path=save_dir, evidence_packet=evidence_packet)
    manifest = json.loads((save_dir / "report_manifest.json").read_text(encoding="utf-8"))
    if manifest.get("analysisStatus") != "rated":
        rating = "Not Rated"

    # 各 agent 分报告的相对路径映射，供前端按角色分 tab 阅读
    files: dict[str, str] = {}
    for md in sorted(save_dir.rglob("*.md")):
        rel = str(md.relative_to(reports_dir.parent)).replace(os.sep, "/")
        files[md.stem] = rel

    decision_md = str(final_state.get("final_trade_decision", "")).strip()
    evidence_publish = publish_evidence_bundle(
        evidence_packet,
        manifest=manifest,
        report=files.get("complete_report"),
    )
    return {
        "ticker": symbol,
        "rating": rating,
        "report": files.get("complete_report"),
        "files": files,
        "decision_excerpt": decision_md[:400],
        "analysis_status": manifest.get("analysisStatus", "not_rated"),
        "audit_status": manifest.get("auditStatus", "legacy_unverified"),
        "evidence_publish": evidence_publish,
        "error": None,
    }


def build_push_message(trade_date: str, results: list[dict], provider: str) -> tuple[str, str]:
    ok = [r for r in results if not r.get("error")]
    bad = [r for r in results if r.get("error")]
    tags = " ".join(f"{r['ticker']}:{r['rating']}" for r in ok) or "全部失败"
    title = f"TradingAgents {trade_date} | {tags}"

    lines = [f"## TradingAgents 每日决策 ({trade_date})", ""]
    for r in ok:
        lines.append(f"- **{r['ticker']}** → **{r['rating']}**")
    if bad:
        lines.append("")
        lines.append("**失败**: " + ", ".join(f"{r['ticker']}({str(r['error'])[:60]})" for r in bad))
    site = os.environ.get("PAGES_URL", "")
    if site:
        lines += ["", f"[查看完整多智能体报告]({site})"]
    lines += ["", f"---\n*provider: {provider} · TradingAgents 自动推送*"]
    return title, "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run daily multi-agent analysis and build the static site payload.")
    parser.add_argument("--tickers", default=os.environ.get("TRADINGAGENTS_TICKERS", "SPY,NVDA"))
    parser.add_argument("--date", default="", help="交易日 YYYY-MM-DD，默认最近一个美股交易日")
    parser.add_argument("--analysts", default=os.environ.get("TRADINGAGENTS_ANALYSTS", "market,news,fundamentals"))
    parser.add_argument("--output", default=str(ROOT / "public"))
    parser.add_argument("--no-push", action="store_true", help="跳过微信推送（本地调试用）")
    args = parser.parse_args(argv)

    public_dir = Path(args.output)
    data_dir = public_dir / "data"
    reports_dir = public_dir / "reports"
    data_dir.mkdir(parents=True, exist_ok=True)

    trade_date = args.date or last_us_trading_day()
    tickers = [normalize_ticker(t) for t in args.tickers.split(",") if t.strip()]
    tickers = list(dict.fromkeys(t for t in tickers if t))
    analysts = [a.strip().lower() for a in args.analysts.split(",") if a.strip()]
    request_metadata, run_metadata = _workflow_metadata(analysts)
    generated_at = datetime.now(CST).isoformat(timespec="seconds")
    news_payload = write_news_export(
        data_dir,
        tickers=tickers,
        trade_date=trade_date,
        generated_at=generated_at,
    )
    print(f"[NEWS] status={news_payload['status']}, items={len(news_payload['items'])}")

    ready, provider = resolve_llm_key_status()
    if not ready:
        payload = {
            "status": "unconfigured",
            "generated_at": generated_at,
            "trade_date": trade_date,
            "provider": provider,
            "request": request_metadata,
            "run": run_metadata,
            "hint": (f"未检测到 {provider} 的 API key。请在仓库 Settings → Secrets 配置对应密钥"
                     "（如 DEEPSEEK_API_KEY / OPENAI_COMPATIBLE_API_KEY），并可用仓库变量"
                     " TRADINGAGENTS_LLM_PROVIDER / TRADINGAGENTS_LLM_BACKEND_URL 切换后端。"),
            "results": [],
        }
        (data_dir / "latest.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"[SKIP] no API key for provider '{provider}', wrote unconfigured payload")
        return 0

    results: list[dict] = []
    for ticker in tickers:
        print(f"[RUN ] {ticker} @ {trade_date} (analysts: {','.join(analysts)})")
        try:
            res = run_ticker(ticker, trade_date, analysts, reports_dir)
            print(f"[OK  ] {ticker} -> {res['rating']}")
        except Exception as exc:
            traceback.print_exc()
            res = {"ticker": ticker, "rating": None, "report": None,
                   "decision_excerpt": "", "error": f"{type(exc).__name__}: {exc}"}
            print(f"[FAIL] {ticker}: {res['error']}")
        results.append(res)

    ok_count = sum(1 for r in results if not r["error"])
    payload = {
        "status": "ok" if ok_count else "failed",
        "generated_at": generated_at,
        "trade_date": trade_date,
        "provider": provider,
        "analysts": analysts,
        "request": request_metadata,
        "run": run_metadata,
        "rating_tiers": RATING_TIERS,
        "results": results,
    }
    (data_dir / "latest.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    hist_size = update_history(data_dir, payload)
    print(f"[DONE] {ok_count}/{len(results)} tickers ok, payload written, history={hist_size}")

    if not args.no_push:
        title, content = build_push_message(trade_date, results, provider)
        outcome = push_wechat(title, content)
        print(f"[PUSH] sent={outcome.get('sent')} detail={outcome.get('msg') or outcome.get('reason', '')}")

    return 0 if ok_count else 1


if __name__ == "__main__":
    raise SystemExit(main())
