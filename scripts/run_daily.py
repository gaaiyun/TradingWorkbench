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


def build_runtime_evidence(ticker: str, trade_date: str) -> dict[str, Any]:
    """Build a small point-in-time packet before any model call.

    This preflight deliberately uses adjusted history and corporate actions.
    If the vendor returns a split-contaminated series, the run is marked
    non-rateable instead of allowing the LLM to turn the jump into a Sell.
    """
    import yfinance as yf

    from cli.utils import detect_asset_type, normalize_ticker_symbol
    from tradingagents.evidence import build_evidence_packet

    symbol = normalize_ticker_symbol(ticker)
    asset_type = detect_asset_type(symbol).value
    cutoff = f"{trade_date}T23:59:59Z"
    history = yf.Ticker(symbol).history(period="6mo", auto_adjust=True, actions=True)
    bars: list[dict[str, Any]] = []
    if history is not None and not history.empty:
        for index, row in history.iterrows():
            timestamp = index.to_pydatetime()
            if timestamp.tzinfo is None:
                timestamp = timestamp.replace(tzinfo=timezone.utc)
            timestamp = timestamp.astimezone(timezone.utc)
            if timestamp.date().isoformat() > trade_date:
                continue
            bars.append({
                "ts": timestamp.isoformat(),
                "open": row.get("Open"),
                "high": row.get("High"),
                "low": row.get("Low"),
                "close": row.get("Close"),
                "volume": row.get("Volume"),
                "adjustment": "qfq",
            })
    actions: list[dict[str, Any]] = []
    if history is not None and "Stock Splits" in history.columns:
        for index, value in history["Stock Splits"].items():
            if value and float(value) != 0 and index.date().isoformat() <= trade_date:
                actions.append({
                    "type": "split",
                    "exDate": index.date().isoformat(),
                    "ratio": float(value),
                    "source": "yahoo-actions",
                })
    return build_evidence_packet(
        ticker=symbol,
        asset_type=asset_type,
        as_of=cutoff,
        bars=bars,
        corporate_actions=actions,
        sources=[{
            "source": "yahoo-finance",
            "asOf": cutoff,
            "fetchedAt": datetime.now(timezone.utc).isoformat(),
            "sourceTier": "discovery",
        }],
    )


def update_history(data_dir: Path, payload: dict, cap: int = HISTORY_CAP) -> int:
    """把本次运行追加进 history.json（同交易日同标的组合覆盖旧条目）。"""
    hist_path = data_dir / "history.json"
    try:
        history = json.loads(hist_path.read_text(encoding="utf-8"))
        if not isinstance(history, list):
            history = []
    except Exception:
        history = []

    key = (payload.get("trade_date"), tuple(sorted(r["ticker"] for r in payload.get("results", []))))
    history = [
        h for h in history
        if (h.get("trade_date"), tuple(sorted(r.get("ticker", "") for r in h.get("results", [])))) != key
    ]
    entry = {
        "trade_date": payload.get("trade_date"),
        "generated_at": payload.get("generated_at"),
        "provider": payload.get("provider"),
        "results": [
            {"ticker": r["ticker"], "rating": r["rating"], "report": r["report"],
             "error": bool(r.get("error"))}
            for r in payload.get("results", [])
        ],
    }
    history.insert(0, entry)
    history = history[:cap]
    hist_path.write_text(json.dumps(history, ensure_ascii=False, indent=2), encoding="utf-8")
    return len(history)


def last_us_trading_day(now_utc: datetime | None = None) -> str:
    """最近一个已收盘/进行中的美股交易日（周末回滚到周五）。"""
    now = now_utc or datetime.now(timezone.utc)
    d = now.date()
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    return d.isoformat()


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


def run_ticker(ticker: str, trade_date: str, analysts: list[str], reports_dir: Path) -> dict:
    """跑单个 ticker 的完整多智能体分析，返回结果摘要 dict。"""
    from cli.utils import detect_asset_type, normalize_ticker_symbol
    from tradingagents.default_config import DEFAULT_CONFIG
    from tradingagents.graph.trading_graph import TradingAgentsGraph

    symbol = normalize_ticker_symbol(ticker)
    evidence_packet = build_runtime_evidence(symbol, trade_date)
    if not evidence_packet.get("canRate"):
        return {
            "ticker": symbol,
            "rating": None,
            "report": None,
            "files": {},
            "decision_excerpt": "",
            "analysis_status": evidence_packet.get("status", "not_rated"),
            "audit_status": "invalidated" if evidence_packet.get("status") == "data_validation_failed" else "legacy_unverified",
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

    save_dir = reports_dir / symbol / trade_date
    ta.save_reports(final_state, symbol, save_path=save_dir, evidence_packet=evidence_packet)

    # 各 agent 分报告的相对路径映射，供前端按角色分 tab 阅读
    files: dict[str, str] = {}
    for md in sorted(save_dir.rglob("*.md")):
        rel = str(md.relative_to(reports_dir.parent)).replace(os.sep, "/")
        files[md.stem] = rel

    decision_md = str(final_state.get("final_trade_decision", "")).strip()
    return {
        "ticker": symbol,
        "rating": rating,
        "report": files.get("complete_report"),
        "files": files,
        "decision_excerpt": decision_md[:400],
        "analysis_status": final_state.get("analysis_status", "rated"),
        "audit_status": "verified",
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
