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


_EVIDENCE_CITATION_RE = re.compile(r"\[([^\[\]\r\n]+)\]")
_EVIDENCE_CITATION_TOKEN_RE = re.compile(
    r"^(M|I|CA|N|S)(\d+)(?:\s*-\s*(?:(M|I|CA|N|S))?(\d+))?$",
    re.IGNORECASE,
)
_EVIDENCE_LIKE_CONTAINER_RE = re.compile(r"^\s*[A-Z]{1,3}\d", re.IGNORECASE)
_MAX_EVIDENCE_CITATION_CONTAINER_LENGTH = 4_096
_MAX_EVIDENCE_CITATION_NUMBER_DIGITS = 9
_MAX_EVIDENCE_IDS_PER_CONTAINER = 2_000
_MARKDOWN_LINK_RE = re.compile(
    r"\[[^\[\]\r\n]{0,16384}\]"
    r"\(https?://[^()\r\n]{1,65536}\)",
)
_CLAIM_GAP_PATTERN = r"\s{0,16}"
_CLAIM_WORD_GAP_PATTERN = r"\s{1,16}"
_NUMERIC_CLAIM_RE = re.compile(
    rf"(?<![A-Za-z])(?:[$¥£€]{_CLAIM_GAP_PATTERN})?"
    r"[-+]?\d+(?:,\d{3})*(?:\.\d+)?%?"
)
_NUMERIC_VALUE_PATTERN = (
    rf"(?:[$¥£€]{_CLAIM_GAP_PATTERN})?"
    r"[-+]?\d+(?:,\d{3})*(?:\.\d+)?"
)
_PERCENT_VALUE_PATTERN = (
    rf"\d+(?:\.\d+)?{_CLAIM_GAP_PATTERN}%"
    rf"(?:{_CLAIM_GAP_PATTERN}[-–—~至]{_CLAIM_GAP_PATTERN}"
    rf"\d+(?:\.\d+)?{_CLAIM_GAP_PATTERN}%)?"
)
_PRICE_TARGET_TERM_PATTERN = (
    rf"(?:price{_CLAIM_GAP_PATTERN}target|"
    rf"target{_CLAIM_GAP_PATTERN}price|目标价|目标价格)"
)
_ALLOCATION_TERM_PATTERN = (
    rf"(?:position{_CLAIM_GAP_PATTERN}(?:size|sizing)|"
    r"allocation|exposure|weight|"
    r"持仓|底仓|仓位|配置|减仓|加仓|清仓)"
)
_ALLOCATION_CONNECTOR_PATTERN = (
    rf"(?:{_CLAIM_GAP_PATTERN}(?:[:：=]|"
    r"(?:is|at|to|of|should\s+be)\b|为|建议为|至|降至|减至|增至|提高至|"
    r"调整至|控制在|维持在?|保持在?|不超过|不低于|上限为|下限为|"
    rf"削减至不超过))?{_CLAIM_GAP_PATTERN}"
)
_NUMERIC_RECOMMENDATION_DISCLAIMER_RE = re.compile(
    rf"\b(?:does|do){_CLAIM_WORD_GAP_PATTERN}not"
    rf"{_CLAIM_WORD_GAP_PATTERN}(?:set|provide|recommend)"
    rf"{_CLAIM_WORD_GAP_PATTERN}(?:an?{_CLAIM_WORD_GAP_PATTERN})?"
    rf"(?:{_NUMERIC_VALUE_PATTERN}{_CLAIM_GAP_PATTERN}"
    rf"{_PRICE_TARGET_TERM_PATTERN}|"
    rf"{_PRICE_TARGET_TERM_PATTERN}{_CLAIM_GAP_PATTERN}"
    rf"(?:of|at|to)?{_CLAIM_GAP_PATTERN}"
    rf"{_NUMERIC_VALUE_PATTERN}|"
    rf"{_PERCENT_VALUE_PATTERN}{_CLAIM_GAP_PATTERN}"
    rf"(?:allocation|position|exposure|weight))|"
    rf"\bno{_CLAIM_WORD_GAP_PATTERN}{_PRICE_TARGET_TERM_PATTERN}"
    rf"{_CLAIM_GAP_PATTERN}(?:of|at|to)?{_CLAIM_GAP_PATTERN}"
    rf"{_NUMERIC_VALUE_PATTERN}{_CLAIM_WORD_GAP_PATTERN}is"
    rf"{_CLAIM_WORD_GAP_PATTERN}(?:set|provided|recommended)|"
    rf"本报告不(?:设|提供|建议){_PRICE_TARGET_TERM_PATTERN}"
    rf"{_CLAIM_GAP_PATTERN}{_NUMERIC_VALUE_PATTERN}(?:元)?",
    re.IGNORECASE,
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
    rf"{_PRICE_TARGET_TERM_PATTERN}{_CLAIM_GAP_PATTERN}"
    rf"(?:(?:is|of|at|to|为|至|上调至|下调至|区间)"
    rf"{_CLAIM_GAP_PATTERN})?"
    rf"[:：=]?{_CLAIM_GAP_PATTERN}{_NUMERIC_VALUE_PATTERN}|"
    rf"{_NUMERIC_VALUE_PATTERN}{_CLAIM_GAP_PATTERN}"
    rf"{_PRICE_TARGET_TERM_PATTERN}",
    re.IGNORECASE,
)
_ALLOCATION_RE = re.compile(
    rf"{_ALLOCATION_TERM_PATTERN}{_ALLOCATION_CONNECTOR_PATTERN}"
    rf"{_PERCENT_VALUE_PATTERN}|"
    rf"{_PERCENT_VALUE_PATTERN}{_CLAIM_GAP_PATTERN}"
    rf"(?:的{_CLAIM_GAP_PATTERN})?{_ALLOCATION_TERM_PATTERN}|"
    rf"(?:建议{_CLAIM_GAP_PATTERN})?持有{_CLAIM_GAP_PATTERN}"
    rf"{_PERCENT_VALUE_PATTERN}|"
    rf"持仓比例{_CLAIM_GAP_PATTERN}{_PERCENT_VALUE_PATTERN}|"
    rf"\bkeep{_CLAIM_WORD_GAP_PATTERN}{_PERCENT_VALUE_PATTERN}"
    rf"{_CLAIM_WORD_GAP_PATTERN}of{_CLAIM_WORD_GAP_PATTERN}"
    rf"(?:the{_CLAIM_WORD_GAP_PATTERN})?portfolio\b",
    re.IGNORECASE,
)


def _packet_evidence_ids(packet: dict) -> set[str]:
    ids = set()
    for key in ("bars", "indicatorEvidence", "corporateActions", "news", "sources"):
        for row in packet.get(key) or []:
            if isinstance(row, dict) and row.get("evidenceId"):
                ids.add(str(row["evidenceId"]).upper())
    return ids


def _parse_evidence_citation(body: str) -> frozenset[str] | None:
    """Parse one citation group, expanding same-prefix inclusive ranges."""
    body = str(body or "")
    if len(body) > _MAX_EVIDENCE_CITATION_CONTAINER_LENGTH:
        return None
    evidence_ids: set[str] = set()
    expanded_count = 0
    for raw_token in body.split(","):
        token = raw_token.strip()
        match = _EVIDENCE_CITATION_TOKEN_RE.fullmatch(token)
        if not match:
            return None
        start_prefix, start_text, end_prefix, end_text = match.groups()
        if len(start_text) > _MAX_EVIDENCE_CITATION_NUMBER_DIGITS or (
            end_text is not None
            and len(end_text) > _MAX_EVIDENCE_CITATION_NUMBER_DIGITS
        ):
            return None
        prefix = start_prefix.upper()
        start = int(start_text)
        if end_text is None:
            expanded_count += 1
            if expanded_count > _MAX_EVIDENCE_IDS_PER_CONTAINER:
                return None
            evidence_ids.add(f"{prefix}{start}")
            continue
        if end_prefix and end_prefix.upper() != prefix:
            return None
        end = int(end_text)
        range_size = end - start + 1
        if (
            range_size <= 0
            or range_size > _MAX_EVIDENCE_IDS_PER_CONTAINER
            or expanded_count + range_size > _MAX_EVIDENCE_IDS_PER_CONTAINER
        ):
            return None
        expanded_count += range_size
        evidence_ids.update(f"{prefix}{index}" for index in range(start, end + 1))
    return frozenset(evidence_ids) or None


def _scan_evidence_citations(
    text: str,
    parse_cache: dict[str, frozenset[str] | None] | None = None,
) -> tuple[set[str], list[str]]:
    """Parse each citation container once, reusing results within a report."""
    evidence_ids: set[str] = set()
    invalid: list[str] = []
    safe_text = str(text or "")
    cache = parse_cache if parse_cache is not None else {}
    for match in _EVIDENCE_CITATION_RE.finditer(safe_text):
        body = match.group(1)
        if body not in cache:
            cache[body] = _parse_evidence_citation(body)
        parsed = cache[body]
        followed_by_parenthesis = (
            match.end() < len(safe_text) and safe_text[match.end()] == "("
        )
        if followed_by_parenthesis and parsed:
            continue
        if parsed:
            evidence_ids.update(parsed)
        elif _EVIDENCE_LIKE_CONTAINER_RE.match(body):
            invalid.append(match.group(0))
    return evidence_ids, invalid


def _evidence_citations(text: str) -> set[str]:
    return _scan_evidence_citations(text)[0]


def _invalid_evidence_citations(text: str) -> list[str]:
    return _scan_evidence_citations(text)[1]


def _strip_evidence_citations(text: str) -> str:
    def replace(match: re.Match) -> str:
        body = match.group(1)
        if _EVIDENCE_LIKE_CONTAINER_RE.match(body):
            return ""
        return match.group(0)

    return _EVIDENCE_CITATION_RE.sub(replace, str(text or ""))


def _mask_numeric_recommendation_disclaimers(text: str) -> str:
    return _NUMERIC_RECOMMENDATION_DISCLAIMER_RE.sub("", str(text or ""))


def _claim_scan_text(text: str) -> str:
    without_links = _MARKDOWN_LINK_RE.sub("", str(text or ""))
    without_urls = re.sub(r"https?://\S+", "", without_links)
    without_citations = _strip_evidence_citations(without_urls)
    return _mask_numeric_recommendation_disclaimers(without_citations)


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
    cited_ids: set[str] = set()
    invalid_citations: list[str] = []
    parse_cache: dict[str, frozenset[str] | None] = {}
    uncited_numeric = 0
    has_price_target = False
    has_allocation = False
    for paragraph in re.split(r"\n\s*\n", str(text or "")):
        paragraph_ids, paragraph_invalid = _scan_evidence_citations(
            paragraph,
            parse_cache,
        )
        cited_ids.update(paragraph_ids)
        invalid_citations.extend(paragraph_invalid)
        claim_text = _claim_scan_text(paragraph)
        if (
            _NUMERIC_CLAIM_RE.search(
                _mask_non_claim_numeric_context(claim_text),
            )
            and not paragraph_ids.intersection(known_ids)
        ):
            uncited_numeric += 1
        has_price_target = has_price_target or bool(
            _PRICE_TARGET_RE.search(claim_text)
        )
        has_allocation = has_allocation or bool(_ALLOCATION_RE.search(claim_text))
    unknown_ids = sorted(cited_ids - known_ids)
    error_codes = []
    if not cited_ids.intersection(known_ids):
        error_codes.append("MISSING_EVIDENCE_CITATION")
    if unknown_ids:
        error_codes.append("UNKNOWN_EVIDENCE_ID")
    if invalid_citations:
        error_codes.append("INVALID_EVIDENCE_CITATION")
    if uncited_numeric:
        error_codes.append("UNCITED_NUMERIC_CLAIM")
    if has_price_target:
        error_codes.append("UNSUPPORTED_PRICE_TARGET")
    if has_allocation:
        error_codes.append("UNSUPPORTED_ALLOCATION")
    return {
        "status": "passed" if not error_codes else "failed",
        "errorCodes": error_codes,
        "citationCount": len(cited_ids.intersection(known_ids)),
        "unknownEvidenceIds": unknown_ids,
        "invalidEvidenceCitations": invalid_citations,
        "uncitedNumericParagraphs": uncited_numeric,
    }


def _filter_public_final_decision(text: str, packet: dict) -> tuple[str, int, set[str]]:
    """Omit unsafe final-decision paragraphs without modifying their claims."""
    known_ids = _packet_evidence_ids(packet)
    kept: list[str] = []
    omitted = 0
    omitted_error_codes: set[str] = set()
    parse_cache: dict[str, frozenset[str] | None] = {}
    for paragraph in re.split(r"\n\s*\n", str(text or "")):
        if not paragraph.strip():
            continue
        paragraph_ids, invalid_citations = _scan_evidence_citations(
            paragraph,
            parse_cache,
        )
        unknown_ids = paragraph_ids - known_ids
        claim_text = _claim_scan_text(paragraph)
        has_numeric_claim = bool(
            _NUMERIC_CLAIM_RE.search(
                _mask_non_claim_numeric_context(claim_text),
            )
        )
        has_uncited_numeric = has_numeric_claim and not paragraph_ids.intersection(known_ids)
        has_price_target = bool(_PRICE_TARGET_RE.search(claim_text))
        has_allocation = bool(_ALLOCATION_RE.search(claim_text))
        if (
            unknown_ids
            or invalid_citations
            or has_uncited_numeric
            or has_price_target
            or has_allocation
        ):
            omitted += 1
            if unknown_ids:
                omitted_error_codes.add("UNKNOWN_EVIDENCE_ID")
            if invalid_citations:
                omitted_error_codes.add("INVALID_EVIDENCE_CITATION")
            if has_uncited_numeric:
                omitted_error_codes.add("UNCITED_NUMERIC_CLAIM")
            if has_price_target:
                omitted_error_codes.add("UNSUPPORTED_PRICE_TARGET")
            if has_allocation:
                omitted_error_codes.add("UNSUPPORTED_ALLOCATION")
            continue
        kept.append(paragraph.strip())
    return "\n\n".join(kept), omitted, omitted_error_codes


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
    raw_final_decision = ""

    # 1. Analysts
    analysts_dir = save_path / "1_analysts"
    analyst_parts = []
    if final_state.get("market_report"):
        analysts_dir.mkdir(exist_ok=True)
        raw_text = str(final_state["market_report"])
        text = raw_text if packet else _sanitize_final_proposals(raw_text)
        (analysts_dir / "market.md").write_text(text, encoding="utf-8")
        analyst_parts.append(("Market Analyst", text))
    if final_state.get("sentiment_report"):
        analysts_dir.mkdir(exist_ok=True)
        raw_text = str(final_state["sentiment_report"])
        text = raw_text if packet else _sanitize_final_proposals(raw_text)
        (analysts_dir / "sentiment.md").write_text(text, encoding="utf-8")
        analyst_parts.append(("Sentiment Analyst", text))
    if final_state.get("news_report"):
        analysts_dir.mkdir(exist_ok=True)
        raw_text = str(final_state["news_report"])
        text = raw_text if packet else _sanitize_final_proposals(raw_text)
        (analysts_dir / "news.md").write_text(text, encoding="utf-8")
        analyst_parts.append(("News Analyst", text))
    if final_state.get("fundamentals_report"):
        analysts_dir.mkdir(exist_ok=True)
        raw_text = str(final_state["fundamentals_report"])
        text = raw_text if packet else _sanitize_final_proposals(raw_text)
        (analysts_dir / "fundamentals.md").write_text(text, encoding="utf-8")
        analyst_parts.append(("Fundamentals Analyst", text))
    if analyst_parts and not packet:
        content = "\n\n".join(f"### {name}\n{text}" for name, text in analyst_parts)
        sections.append(f"## I. Analyst Team Reports\n\n{content}")

    # 2. Research
    if final_state.get("investment_debate_state"):
        research_dir = save_path / "2_research"
        debate = final_state["investment_debate_state"]
        research_parts = []
        if debate.get("bull_history"):
            research_dir.mkdir(exist_ok=True)
            raw_text = str(debate["bull_history"])
            text = raw_text if packet else _sanitize_final_proposals(raw_text)
            (research_dir / "bull.md").write_text(text, encoding="utf-8")
            research_parts.append(("Bull Researcher", text))
        if debate.get("bear_history"):
            research_dir.mkdir(exist_ok=True)
            raw_text = str(debate["bear_history"])
            text = raw_text if packet else _sanitize_final_proposals(raw_text)
            (research_dir / "bear.md").write_text(text, encoding="utf-8")
            research_parts.append(("Bear Researcher", text))
        if debate.get("judge_decision"):
            research_dir.mkdir(exist_ok=True)
            raw_text = str(debate["judge_decision"])
            text = raw_text if packet else _sanitize_final_proposals(raw_text)
            (research_dir / "manager.md").write_text(text, encoding="utf-8")
            research_parts.append(("Research Manager", text))
        if research_parts and not packet:
            content = "\n\n".join(f"### {name}\n{text}" for name, text in research_parts)
            sections.append(f"## II. Research Team Decision\n\n{content}")

    # 3. Trading
    if final_state.get("trader_investment_plan"):
        trading_dir = save_path / "3_trading"
        trading_dir.mkdir(exist_ok=True)
        raw_text = str(final_state["trader_investment_plan"])
        text = raw_text if packet else _sanitize_final_proposals(raw_text)
        (trading_dir / "trader.md").write_text(text, encoding="utf-8")
        if not packet:
            sections.append(f"## III. Trading Team Plan\n\n### Trader\n{text}")

    # 4. Risk Management
    if final_state.get("risk_debate_state"):
        risk_dir = save_path / "4_risk"
        risk = final_state["risk_debate_state"]
        risk_parts = []
        if risk.get("aggressive_history"):
            risk_dir.mkdir(exist_ok=True)
            raw_text = str(risk["aggressive_history"])
            text = raw_text if packet else _sanitize_final_proposals(raw_text)
            (risk_dir / "aggressive.md").write_text(text, encoding="utf-8")
            risk_parts.append(("Aggressive Analyst", text))
        if risk.get("conservative_history"):
            risk_dir.mkdir(exist_ok=True)
            raw_text = str(risk["conservative_history"])
            text = raw_text if packet else _sanitize_final_proposals(raw_text)
            (risk_dir / "conservative.md").write_text(text, encoding="utf-8")
            risk_parts.append(("Conservative Analyst", text))
        if risk.get("neutral_history"):
            risk_dir.mkdir(exist_ok=True)
            raw_text = str(risk["neutral_history"])
            text = raw_text if packet else _sanitize_final_proposals(raw_text)
            (risk_dir / "neutral.md").write_text(text, encoding="utf-8")
            risk_parts.append(("Neutral Analyst", text))
        if risk_parts and not packet:
            content = "\n\n".join(f"### {name}\n{text}" for name, text in risk_parts)
            sections.append(f"## IV. Risk Management Team Decision\n\n{content}")

        # 5. Portfolio Manager
        if risk.get("judge_decision"):
            portfolio_dir = save_path / "5_portfolio"
            portfolio_dir.mkdir(exist_ok=True)
            raw_text = str(risk["judge_decision"])
            raw_final_decision = raw_text
            text = raw_text if packet else _sanitize_final_proposals(raw_text)
            (portfolio_dir / "decision.md").write_text(text, encoding="utf-8")
            if not packet:
                sections.append(
                    f"## V. Portfolio Manager Decision\n\n### Portfolio Manager\n{text}"
                )

    # Write consolidated report
    generated_at = datetime.now(timezone.utc).isoformat()
    omitted_unsafe_paragraphs = 0
    omitted_error_codes: set[str] = set()
    if packet:
        public_final_decision, omitted_unsafe_paragraphs, omitted_error_codes = (
            _filter_public_final_decision(raw_final_decision, packet)
        )
        public_final_decision = _sanitize_final_proposals(public_final_decision)
        if public_final_decision:
            sections.append(
                "## V. Portfolio Manager Decision\n\n"
                f"### Portfolio Manager\n{public_final_decision}"
            )
    else:
        public_final_decision = ""
    report_body = "\n\n".join(sections)
    status = str(final_state.get("analysis_status") or ("rated" if packet else "not_rated"))
    claim_validation = (
        validate_report_claims(public_final_decision, packet)
        if packet else {
            "status": "not_applicable",
            "errorCodes": [],
            "citationCount": 0,
            "unknownEvidenceIds": [],
            "invalidEvidenceCitations": [],
            "uncitedNumericParagraphs": 0,
        }
    )
    if packet:
        claim_validation["omittedUnsafeParagraphs"] = omitted_unsafe_paragraphs
        if "MISSING_EVIDENCE_CITATION" in claim_validation["errorCodes"]:
            for error_code in sorted(omitted_error_codes):
                if error_code not in claim_validation["errorCodes"]:
                    claim_validation["errorCodes"].append(error_code)
            claim_validation["status"] = "failed"
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
