"""Reusable report-tree writer shared by the CLI and the programmatic API.

Writes a run's per-section markdown (analysts, research, trading, risk,
portfolio) plus a consolidated ``complete_report.md`` under ``save_path``. The
CLI and ``TradingAgentsGraph.save_reports`` both call this, so a headless / API
run produces the same on-disk report tree a CLI run does.
"""

import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path

from tradingagents.evidence import market_trade_date, validate_evidence_packet


class ReportValidationError(ValueError):
    """Raised when evidence explicitly says a report must not be rated."""


_EVIDENCE_CITATION_RE = re.compile(r"\[((?:M|I|CA|N|S)\d+)\]", re.IGNORECASE)
_NUMERIC_CLAIM_RE = re.compile(
    r"(?<![A-Za-z])(?:[$¥£€]\s*)?[-+]?\d+(?:,\d{3})*(?:\.\d+)?%?"
)
_NON_CLAIM_NUMERIC_CONTEXT = (
    # ISO/Chinese dates and timestamps are metadata, not numeric assertions.
    re.compile(
        r"(?<!\d)(?:19|20)\d{2}-\d{1,2}-\d{1,2}"
        r"(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?",
    ),
    re.compile(r"(?<!\d)(?:19|20)\d{2}/\d{1,2}/\d{1,2}"),
    re.compile(
        r"(?<!\d)(?:19|20)\d{2}年\s*\d{1,2}月(?:\s*\d{1,2}日)?",
    ),
    re.compile(r"(?<!\d)\d{1,2}月\s*\d{1,2}日"),
    # Hashes and supported instrument identifiers are structural metadata.
    re.compile(r"(?i)(?<![A-Za-z0-9])[0-9a-f]{32,}(?![A-Za-z0-9])"),
    re.compile(
        r"(?i)(?<![A-Za-z0-9])(?:\d{6}\.(?:SS|SZ)|\d{1,5}\.HK)"
        r"(?![A-Za-z0-9])",
    ),
    # Markdown heading/list ordinals are not research values.
    re.compile(r"^\s*(?:#{1,6}\s+)?\d+(?:\.\d+)*[.)、．]?"),
    # Indicator look-back periods and canonical parameter tuples.
    re.compile(
        r"(?i)(?<!\d)\d+\s*(?:日|天|周|月)?\s*"
        r"(?=(?:均线|EMA|SMA|MA|ATR|RSI|MACD|KDJ|布林|"
        r"移动平均线|指数移动平均线|简单移动平均线))",
    ),
    re.compile(r"(?i)(?<!\d)\d+\s*(?:EMA|SMA|MA|ATR)\b"),
    re.compile(r"(?i)\b(?:RSI|ATR)\s*\(\s*\d+\s*\)"),
    re.compile(r"(?i)\bMACD\s*\d+\s*[-/]\s*\d+(?:\s*[-/]\s*\d+)?"),
    re.compile(r"(?i)\b(?:RSI|ATR|ADX|KDJ)\d+\b"),
)
_PRICE_TARGET_RE = re.compile(
    r"(?:price\s*target|target\s*price|目标价|目标价格)",
    re.IGNORECASE,
)
_ALLOCATION_RE = re.compile(
    r"(?:\d+(?:\.\d+)?\s*%[^。\n]*(?:仓位|配置|减仓|加仓|清仓)|"
    r"(?:仓位|配置|减仓|加仓|清仓)[^。\n]*\d+(?:\.\d+)?\s*%)",
    re.IGNORECASE,
)


def _packet_evidence_ids(packet: dict) -> set[str]:
    ids = set()
    for key in ("bars", "indicatorEvidence", "corporateActions", "news", "sources"):
        for row in packet.get(key) or []:
            if isinstance(row, dict) and row.get("evidenceId"):
                ids.add(str(row["evidenceId"]).upper())
    return ids


def _mask_non_claim_numeric_context(text: str) -> str:
    """Mask structural numbers before searching for uncited numeric claims.

    The report validator must still catch an uncited price or ratio in a
    dated paragraph, so only the date/identifier/heading/indicator-parameter
    spans themselves are removed.  The surrounding prose and all remaining
    numbers stay visible to ``_NUMERIC_CLAIM_RE``.
    """
    chars = list(str(text or ""))
    for pattern in _NON_CLAIM_NUMERIC_CONTEXT:
        for match in pattern.finditer(str(text or "")):
            start, end = match.span()
            chars[start:end] = [" "] * (end - start)
    return "".join(chars)


def _market_history_metadata(packet: dict) -> dict:
    """Summarize market-history provenance without changing adjustment semantics."""
    bars = list(packet.get("bars") or [])
    sources = list(packet.get("sources") or [])
    adjustments = {
        str(row.get("adjustment"))
        for row in bars
        if isinstance(row, dict) and row.get("adjustment")
    }
    adjustment = (
        next(iter(adjustments))
        if len(adjustments) == 1
        else "mixed"
        if len(adjustments) > 1
        else "unknown"
    )
    return {
        "source": (
            str(sources[0].get("source") or "unknown")
            if sources and isinstance(sources[0], dict)
            else "unknown"
        ),
        "adjustment": adjustment,
        "barCount": len(bars),
        "startAt": bars[0].get("ts") if bars else None,
        "endAt": bars[-1].get("ts") if bars else None,
    }


def validate_report_claims(text: str, packet: dict) -> dict:
    """Validate that a rated narrative remains tied to packet evidence."""
    known_ids = _packet_evidence_ids(packet)
    cited_ids = {
        match.upper() for match in _EVIDENCE_CITATION_RE.findall(str(text or ""))
    }
    unknown_ids = sorted(cited_ids - known_ids)
    uncited_numeric = 0
    for paragraph in re.split(r"\n\s*\n", str(text or "")):
        without_urls = re.sub(r"https?://\S+", "", paragraph)
        without_citations = _EVIDENCE_CITATION_RE.sub("", without_urls)
        if _NUMERIC_CLAIM_RE.search(
            _mask_non_claim_numeric_context(without_citations),
        ):
            paragraph_ids = {
                match.upper() for match in _EVIDENCE_CITATION_RE.findall(paragraph)
            }
            if not paragraph_ids.intersection(known_ids):
                uncited_numeric += 1
    error_codes = []
    if not cited_ids.intersection(known_ids):
        error_codes.append("MISSING_EVIDENCE_CITATION")
    if unknown_ids:
        error_codes.append("UNKNOWN_EVIDENCE_ID")
    if uncited_numeric:
        error_codes.append("UNCITED_NUMERIC_CLAIM")
    if _PRICE_TARGET_RE.search(str(text or "")):
        error_codes.append("UNSUPPORTED_PRICE_TARGET")
    if _ALLOCATION_RE.search(str(text or "")):
        error_codes.append("UNSUPPORTED_ALLOCATION")
    return {
        "status": "passed" if not error_codes else "failed",
        "errorCodes": error_codes,
        "citationCount": len(cited_ids.intersection(known_ids)),
        "unknownEvidenceIds": unknown_ids,
        "uncitedNumericParagraphs": uncited_numeric,
    }


def _sanitize_final_proposals(text: str) -> str:
    """Keep one final proposal marker in the consolidated report.

    Agent sub-reports remain untouched for auditability; the reader-facing
    consolidated report cannot present multiple conflicting final actions.
    """
    lines = str(text or "").splitlines()
    marker_indexes = [
        index for index, line in enumerate(lines)
        if re.search(r"FINAL TRANSACTION PROPOSAL", line, re.IGNORECASE)
    ]
    if len(marker_indexes) <= 1:
        return str(text or "")
    return "\n".join(
        line for index, line in enumerate(lines)
        if index not in marker_indexes[:-1]
    )


def _render_evidence_snapshot(packet: dict) -> str:
    """Render a compact, human-readable ledger without inventing analysis."""
    bars = list(packet.get("bars") or [])
    indicators = list(packet.get("indicatorEvidence") or [])
    actions = list(packet.get("corporateActions") or [])
    news = list(packet.get("news") or [])
    sources = list(packet.get("sources") or [])
    market = str((packet.get("instrument") or {}).get("market") or "")
    anchor = (
        (bars[-1].get("evidenceId") if bars else None)
        or (sources[0].get("evidenceId") if sources else None)
        or "—"
    )
    market_history = _market_history_metadata(packet)
    lines = [
        "## Evidence Snapshot",
        "",
        (
            f"- Status `{packet.get('status', 'unknown')}`; "
            f"as of `{packet.get('asOf', 'unknown')}`; "
            f"instrument `{packet.get('instrument', {}).get('symbol', 'unknown')}` "
            f"[{anchor}]"
        ),
        (
            f"- Market history: source `{market_history['source']}`; "
            f"adjustment `{market_history['adjustment']}`; "
            f"{market_history['barCount']} bars from "
            f"`{market_history['startAt'] or 'unavailable'}` to "
            f"`{market_history['endAt'] or 'unavailable'}`"
        ),
    ]
    if bars:
        lines.extend(["", "### Latest market bars", ""])
        for row in bars[-5:]:
            lines.append(
                f"- [{row.get('evidenceId')}] trade date "
                f"{market_trade_date(row.get('ts'), market)} "
                f"(raw UTC {row.get('ts')}): "
                f"O {row.get('open')} · H {row.get('high')} · "
                f"L {row.get('low')} · C {row.get('close')} · "
                f"volume {row.get('volume')}"
            )
    if indicators:
        lines.extend(["", "### Indicators", ""])
        for row in indicators[:12]:
            lines.append(
                f"- [{row.get('evidenceId')}] {row.get('name')}: {row.get('value')}"
            )
    if actions:
        lines.extend(["", "### Corporate actions", ""])
        for row in actions[:6]:
            lines.append(
                f"- [{row.get('evidenceId')}] {row.get('type')}: "
                f"{row.get('exDate') or row.get('date') or 'date unavailable'}"
            )
    if news:
        lines.extend(["", "### Point-in-time news", ""])
        for row in news[:8]:
            title = str(row.get("title") or "Untitled").replace("\n", " ")
            url = str(row.get("url") or "").strip()
            label = f"[{title}]({url})" if url else title
            lines.append(
                f"- [{row.get('evidenceId')}] {row.get('publishedAt')}: "
                f"{label} · {row.get('source')} · {row.get('sourceTier')}"
            )
    if sources:
        lines.extend(["", "### Sources", ""])
        for row in sources[:8]:
            lines.append(
                f"- [{row.get('evidenceId')}] {row.get('source')} · "
                f"as of {row.get('asOf') or 'unavailable'} · "
                f"tier {row.get('sourceTier')}"
            )
    integrity = packet.get("integrity") or {}
    if integrity.get("warnings") or integrity.get("errors"):
        lines.extend([
            "",
            "### Integrity",
            "",
            f"- [{anchor}] warnings: {', '.join(integrity.get('warnings') or []) or 'none'}",
            f"- [{anchor}] errors: {', '.join(integrity.get('errors') or []) or 'none'}",
        ])
    return "\n".join(lines)


def write_report_tree(
    final_state: dict,
    ticker: str,
    save_path,
    *,
    evidence_packet: dict | None = None,
) -> Path:
    """Save a completed run's reports to ``save_path``; return the complete-report path."""
    save_path = Path(save_path)
    packet = evidence_packet or final_state.get("evidence_packet")
    if packet:
        validate_evidence_packet(packet)
        if packet.get("status") == "data_validation_failed" or not packet.get("canRate"):
            raise ReportValidationError(
                f"evidence validation failed; cannot generate a rated report for {ticker}"
            )
    save_path.mkdir(parents=True, exist_ok=True)
    sections = [_render_evidence_snapshot(packet)] if packet else []

    # 1. Analysts
    analysts_dir = save_path / "1_analysts"
    analyst_parts = []
    if final_state.get("market_report"):
        analysts_dir.mkdir(exist_ok=True)
        text = _sanitize_final_proposals(final_state["market_report"])
        (analysts_dir / "market.md").write_text(text, encoding="utf-8")
        analyst_parts.append(("Market Analyst", text))
    if final_state.get("sentiment_report"):
        analysts_dir.mkdir(exist_ok=True)
        text = _sanitize_final_proposals(final_state["sentiment_report"])
        (analysts_dir / "sentiment.md").write_text(text, encoding="utf-8")
        analyst_parts.append(("Sentiment Analyst", text))
    if final_state.get("news_report"):
        analysts_dir.mkdir(exist_ok=True)
        text = _sanitize_final_proposals(final_state["news_report"])
        (analysts_dir / "news.md").write_text(text, encoding="utf-8")
        analyst_parts.append(("News Analyst", text))
    if final_state.get("fundamentals_report"):
        analysts_dir.mkdir(exist_ok=True)
        text = _sanitize_final_proposals(final_state["fundamentals_report"])
        (analysts_dir / "fundamentals.md").write_text(text, encoding="utf-8")
        analyst_parts.append(("Fundamentals Analyst", text))
    if analyst_parts:
        content = "\n\n".join(f"### {name}\n{text}" for name, text in analyst_parts)
        sections.append(f"## I. Analyst Team Reports\n\n{content}")

    # 2. Research
    if final_state.get("investment_debate_state"):
        research_dir = save_path / "2_research"
        debate = final_state["investment_debate_state"]
        research_parts = []
        if debate.get("bull_history"):
            research_dir.mkdir(exist_ok=True)
            text = _sanitize_final_proposals(debate["bull_history"])
            (research_dir / "bull.md").write_text(text, encoding="utf-8")
            research_parts.append(("Bull Researcher", text))
        if debate.get("bear_history"):
            research_dir.mkdir(exist_ok=True)
            text = _sanitize_final_proposals(debate["bear_history"])
            (research_dir / "bear.md").write_text(text, encoding="utf-8")
            research_parts.append(("Bear Researcher", text))
        if debate.get("judge_decision"):
            research_dir.mkdir(exist_ok=True)
            text = _sanitize_final_proposals(debate["judge_decision"])
            (research_dir / "manager.md").write_text(text, encoding="utf-8")
            research_parts.append(("Research Manager", text))
        if research_parts:
            content = "\n\n".join(f"### {name}\n{text}" for name, text in research_parts)
            sections.append(f"## II. Research Team Decision\n\n{content}")

    # 3. Trading
    if final_state.get("trader_investment_plan"):
        trading_dir = save_path / "3_trading"
        trading_dir.mkdir(exist_ok=True)
        text = _sanitize_final_proposals(final_state["trader_investment_plan"])
        (trading_dir / "trader.md").write_text(text, encoding="utf-8")
        sections.append(f"## III. Trading Team Plan\n\n### Trader\n{text}")

    # 4. Risk Management
    if final_state.get("risk_debate_state"):
        risk_dir = save_path / "4_risk"
        risk = final_state["risk_debate_state"]
        risk_parts = []
        if risk.get("aggressive_history"):
            risk_dir.mkdir(exist_ok=True)
            text = _sanitize_final_proposals(risk["aggressive_history"])
            (risk_dir / "aggressive.md").write_text(text, encoding="utf-8")
            risk_parts.append(("Aggressive Analyst", text))
        if risk.get("conservative_history"):
            risk_dir.mkdir(exist_ok=True)
            text = _sanitize_final_proposals(risk["conservative_history"])
            (risk_dir / "conservative.md").write_text(text, encoding="utf-8")
            risk_parts.append(("Conservative Analyst", text))
        if risk.get("neutral_history"):
            risk_dir.mkdir(exist_ok=True)
            text = _sanitize_final_proposals(risk["neutral_history"])
            (risk_dir / "neutral.md").write_text(text, encoding="utf-8")
            risk_parts.append(("Neutral Analyst", text))
        if risk_parts:
            content = "\n\n".join(f"### {name}\n{text}" for name, text in risk_parts)
            sections.append(f"## IV. Risk Management Team Decision\n\n{content}")

        # 5. Portfolio Manager
        if risk.get("judge_decision"):
            portfolio_dir = save_path / "5_portfolio"
            portfolio_dir.mkdir(exist_ok=True)
            text = _sanitize_final_proposals(risk["judge_decision"])
            (portfolio_dir / "decision.md").write_text(text, encoding="utf-8")
            sections.append(f"## V. Portfolio Manager Decision\n\n### Portfolio Manager\n{text}")

    # Write consolidated report
    generated_at = datetime.now(timezone.utc).isoformat()
    report_body = "\n\n".join(sections)
    status = str(final_state.get("analysis_status") or ("rated" if packet else "not_rated"))
    claim_validation = (
        validate_report_claims(report_body, packet)
        if packet else {
            "status": "not_applicable",
            "errorCodes": [],
            "citationCount": 0,
            "unknownEvidenceIds": [],
            "uncitedNumericParagraphs": 0,
        }
    )
    if packet and status == "rated" and claim_validation["status"] != "passed":
        status = "insufficient_evidence"
        final_state["analysis_status"] = status
    if packet and status == "insufficient_evidence":
        error_codes = ", ".join(claim_validation.get("errorCodes") or []) or "CLAIM_VALIDATION_FAILED"
        report_body = "\n\n".join([
            _render_evidence_snapshot(packet),
            (
                "## Research conclusion\n\n"
                "**Not Rated**\n\n"
                "The generated analysis did not pass the evidence claim gate, so the "
                "consolidated report intentionally withholds directional, allocation, "
                "and trading conclusions. Raw agent sections remain in the report "
                "subdirectories for audit only and must not be treated as verified output.\n\n"
                f"Validation errors: `{error_codes}`"
            ),
        ])
    audit_status = (
        "verified"
        if (
            packet
            and packet.get("status") == "ok"
            and status == "rated"
            and claim_validation["status"] == "passed"
        )
        else "legacy_unverified"
    )
    header = (
        f"# Trading Analysis Report: {ticker}\n\n"
        f"Generated: {generated_at}\n\n"
        f"Analysis status: `{status}` · Audit status: `{audit_status}`\n\n"
    )
    if packet:
        header += (
            f"Evidence as of: {packet.get('asOf', '—')} · "
            f"content hash: `{packet.get('contentHash', '—')}`\n\n"
        )
        header += (
            f"Evidence claim validation: `{claim_validation['status']}`"
            f"{' · ' + ', '.join(claim_validation['errorCodes']) if claim_validation['errorCodes'] else ''}\n\n"
        )
    (save_path / "complete_report.md").write_text(header + report_body, encoding="utf-8")
    packet_text = (
        json.dumps(packet, ensure_ascii=False, indent=2, allow_nan=False)
        if packet
        else None
    )
    packet_file_hash = (
        hashlib.sha256(packet_text.encode("utf-8")).hexdigest()
        if packet_text is not None
        else None
    )
    manifest = {
        "schemaVersion": 1,
        "ticker": str(ticker),
        "tradeDate": final_state.get("trade_date"),
        "generatedAt": generated_at,
        "analysisStatus": status,
        "auditStatus": audit_status,
        "claimValidation": claim_validation,
        "evidence": (
            {
                "schemaVersion": packet.get("schemaVersion"),
                "asOf": packet.get("asOf"),
                "contentHash": packet.get("contentHash"),
                "packetFileHash": packet_file_hash,
                "status": packet.get("status"),
                "marketHistory": _market_history_metadata(packet),
            }
            if packet else None
        ),
    }
    (save_path / "report_manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2, allow_nan=False),
        encoding="utf-8",
    )
    if packet_text is not None:
        (save_path / "evidence_packet.json").write_bytes(packet_text.encode("utf-8"))
    return save_path / "complete_report.md"
