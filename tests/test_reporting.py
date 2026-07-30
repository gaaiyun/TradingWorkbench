"""Report parity: the shared writer produces the report tree for the CLI and the
programmatic API alike (#1037)."""

import hashlib
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from tradingagents.evidence import build_evidence_packet
from tradingagents.graph.trading_graph import TradingAgentsGraph
from tradingagents.reporting import validate_report_claims, write_report_tree


def _state():
    return {
        "market_report": "MKT",
        "news_report": "NEWS",
        "investment_debate_state": {"judge_decision": "RM PLAN"},
        "trader_investment_plan": "TRADE",
        "risk_debate_state": {"judge_decision": "PM DECISION"},
    }


@pytest.mark.unit
def test_write_report_tree_creates_files(tmp_path):
    out = write_report_tree(_state(), "AAPL", tmp_path)
    assert out.name == "complete_report.md"
    assert (tmp_path / "1_analysts" / "market.md").read_text() == "MKT"
    assert (tmp_path / "1_analysts" / "news.md").read_text() == "NEWS"
    assert (tmp_path / "2_research" / "manager.md").read_text() == "RM PLAN"
    assert (tmp_path / "3_trading" / "trader.md").read_text() == "TRADE"
    assert (tmp_path / "5_portfolio" / "decision.md").read_text() == "PM DECISION"
    complete = out.read_text()
    assert "Trading Analysis Report: AAPL" in complete
    assert "MKT" in complete and "PM DECISION" in complete


@pytest.mark.unit
def test_save_reports_explicit_path(tmp_path):
    # Unbound: with an explicit save_path, the method doesn't touch self/config.
    out = TradingAgentsGraph.save_reports(None, _state(), "AAPL", save_path=tmp_path)
    assert (tmp_path / "complete_report.md").exists()
    assert out == tmp_path / "complete_report.md"


@pytest.mark.unit
def test_save_reports_defaults_under_results_dir(tmp_path):
    mock_self = SimpleNamespace(config={"results_dir": str(tmp_path)})
    out = TradingAgentsGraph.save_reports(mock_self, _state(), "AAPL")
    assert out.exists()
    assert out.parent.parent.name == "reports"  # results_dir/reports/AAPL_<stamp>/...
    assert out.parent.name.startswith("AAPL_")


@pytest.mark.unit
def test_report_manifest_and_evidence_metadata_are_written(tmp_path):
    packet = build_evidence_packet(
        ticker="GOOGL",
        asset_type="us_equity",
        as_of="2026-07-23T08:00:00Z",
        bars=[{"ts": "2026-07-23T07:00:00Z", "close": 180}],
        sources=[{"source": "sec", "sourceTier": "evidence"}],
        generated_at="2026-07-23T08:05:00Z",
    )
    state = {
        **{key: f"{value} [M1]" if isinstance(value, str) else value
           for key, value in _state().items()},
        "investment_debate_state": {"judge_decision": "RM PLAN [M1]"},
        "risk_debate_state": {"judge_decision": "PM DECISION [M1]"},
        "trade_date": "2026-07-23",
        "analysis_status": "rated",
        "evidence_packet": packet,
    }
    out = write_report_tree(state, "GOOGL", tmp_path)
    manifest = __import__("json").loads((tmp_path / "report_manifest.json").read_text())
    assert manifest["analysisStatus"] == "rated"
    assert manifest["auditStatus"] == "verified"
    assert manifest["evidence"]["contentHash"] == packet["contentHash"]
    assert (tmp_path / "evidence_packet.json").exists()
    packet_bytes = (tmp_path / "evidence_packet.json").read_bytes()
    assert manifest["evidence"]["packetFileHash"] == hashlib.sha256(
        packet_bytes
    ).hexdigest()
    assert "## Evidence Snapshot" in out.read_text()
    assert "[M1]" in out.read_text()
    assert "[S1]" in out.read_text()
    assert out.read_text().count("FINAL TRANSACTION PROPOSAL") <= 1


@pytest.mark.unit
def test_uncited_numeric_claims_are_saved_as_not_rated(tmp_path):
    packet = build_evidence_packet(
        ticker="GOOGL",
        asset_type="us_equity",
        as_of="2026-07-23T08:00:00Z",
        bars=[{"ts": "2026-07-23T07:00:00Z", "close": 180}],
        sources=[{"source": "sec", "sourceTier": "evidence"}],
        generated_at="2026-07-23T08:05:00Z",
    )
    state = {
        **_state(),
        "market_report": "Internal draft close 180 without a citation.",
        "risk_debate_state": {
            "judge_decision": "Final decision relies on close 180 without a citation.",
        },
        "trade_date": "2026-07-23",
        "analysis_status": "rated",
        "evidence_packet": packet,
    }
    out = write_report_tree(state, "GOOGL", tmp_path)
    manifest = __import__("json").loads((tmp_path / "report_manifest.json").read_text())
    assert manifest["analysisStatus"] == "insufficient_evidence"
    assert manifest["auditStatus"] == "legacy_unverified"
    assert "UNCITED_NUMERIC_CLAIM" in manifest["claimValidation"]["errorCodes"]
    assert state["analysis_status"] == "insufficient_evidence"
    complete = out.read_text()
    assert "Evidence claim validation: `failed`" in complete
    assert "Not Rated" in complete
    assert "Final decision relies on close 180 without a citation." not in complete
    assert (tmp_path / "1_analysts" / "market.md").read_text() == (
        "Internal draft close 180 without a citation."
    )


@pytest.mark.unit
def test_public_report_omits_unsafe_final_paragraphs_but_keeps_cited_conclusion(
    tmp_path,
):
    packet = build_evidence_packet(
        ticker="GOOGL",
        asset_type="us_equity",
        as_of="2026-07-23T08:00:00Z",
        bars=[{"ts": "2026-07-23T07:00:00Z", "close": 180}],
        sources=[{"source": "sec", "sourceTier": "evidence"}],
        generated_at="2026-07-23T08:05:00Z",
    )
    state = {
        **_state(),
        "market_report": "Internal draft close 999 without a citation.",
        "risk_debate_state": {
            "judge_decision": (
                "**Rating**: Hold\n\n"
                "Unsafe executive paragraph says the close is 999.\n\n"
                "**Investment Thesis**: The verified close is 180 [M1]."
            ),
        },
        "trade_date": "2026-07-23",
        "analysis_status": "rated",
        "evidence_packet": packet,
    }

    out = write_report_tree(state, "GOOGL", tmp_path)
    manifest = __import__("json").loads((tmp_path / "report_manifest.json").read_text())
    complete = out.read_text()

    assert manifest["analysisStatus"] == "rated"
    assert manifest["auditStatus"] == "verified"
    assert manifest["claimValidation"]["omittedUnsafeParagraphs"] == 1
    assert "The verified close is 180 [M1]." in complete
    assert "close is 999" not in complete
    assert "Internal draft close 999" not in complete
    assert "Internal draft close 999" in (
        tmp_path / "1_analysts" / "market.md"
    ).read_text()


@pytest.mark.unit
def test_claim_validation_accepts_grouped_and_range_evidence_citations():
    packet = build_evidence_packet(
        ticker="GOOGL",
        asset_type="us_equity",
        as_of="2026-07-23T08:00:00Z",
        bars=[
            {"ts": "2026-07-22T07:00:00Z", "close": 175},
            {"ts": "2026-07-23T07:00:00Z", "close": 180},
        ],
        sources=[{"source": "sec", "sourceTier": "evidence"}],
        generated_at="2026-07-23T08:05:00Z",
    )
    text = (
        "The two closes were 175 and 180 [M1-M2, S1].\n\n"
        "The latest close was 180 [M2, S1]."
    )

    result = validate_report_claims(text, packet)

    assert result["status"] == "passed"
    assert result["citationCount"] == 3
    assert result["uncitedNumericParagraphs"] == 0


@pytest.mark.unit
def test_claim_validation_rejects_derived_numbers_not_present_in_cited_rows():
    packet = build_evidence_packet(
        ticker="512480.SS",
        asset_type="cn_etf",
        as_of="2026-07-29T08:00:00Z",
        bars=[
            {"ts": "2026-07-22T16:00:00Z", "high": 1.21, "close": 1.152},
            {"ts": "2026-07-28T16:00:00Z", "close": 1.027},
        ],
        sources=[{"source": "tencent", "sourceTier": "evidence"}],
        generated_at="2026-07-29T08:05:00Z",
    )

    exact = validate_report_claims(
        "The cited closes are 1.152 and 1.027 [M1-M2].",
        packet,
    )
    derived = validate_report_claims(
        "The price fell about 10.9% from the 1.21 high to the 1.027 close [M1-M2].",
        packet,
    )

    assert exact["status"] == "passed"
    assert "UNSUPPORTED_DERIVED_NUMERIC_CLAIM" in derived["errorCodes"]
    assert derived["unsupportedDerivedNumericParagraphs"] == 1


@pytest.mark.unit
def test_indicator_periods_and_inline_ordinals_are_structural_not_derived_claims():
    packet = build_evidence_packet(
        ticker="512480.SS",
        asset_type="cn_etf",
        as_of="2026-07-29T08:00:00Z",
        bars=[{"ts": "2026-07-28T07:00:00Z", "close": 1.041}],
        indicators={
            "atr14": 0.08685811,
            "ma20": 1.2169,
            "ma60": 1.16035,
            "realizedVolatility20": 81.62166617,
            "rsi14": 37.12045566,
        },
        news=[{
            "publishedAt": "2026-07-20T07:00:00Z",
            "title": "2026年第2季度报告",
            "source": "SSE",
        }],
        sources=[{"source": "tencent", "sourceTier": "evidence"}],
        generated_at="2026-07-29T08:05:00Z",
    )
    evidence_ids = {
        row["name"]: row["evidenceId"] for row in packet["indicatorEvidence"]
    }
    text = (
        f"RSI14=37.12045566 [{evidence_ids['rsi14']}]，"
        f"MA20=1.2169 [{evidence_ids['ma20']}]，"
        f"MA60=1.16035 [{evidence_ids['ma60']}]，"
        f"ATR14=0.08685811 [{evidence_ids['atr14']}]。\n\n"
        f"20日已实现波动率=81.62166617 "
        f"[{evidence_ids['realizedVolatility20']}]，"
        f"已实现波动率20=81.62166617 "
        f"[{evidence_ids['realizedVolatility20']}]，"
        "2026年第2季度为报告期 [N1]。\n\n"
        f"理由如下：(1) RSI偏弱 [{evidence_ids['rsi14']}]；"
        f"(2) 价格低于均线 [{evidence_ids['ma20']}]。\n\n"
        f"1. RSI偏弱 [{evidence_ids['rsi14']}]；"
        f"2. 价格低于均线 [{evidence_ids['ma20']}]。"
    )

    result = validate_report_claims(text, packet)

    assert result["status"] == "passed"
    assert result["unsupportedDerivedNumericParagraphs"] == 0


@pytest.mark.unit
def test_precomputed_derived_rows_pass_but_unlisted_thresholds_and_math_fail():
    packet = build_evidence_packet(
        ticker="512480.SS",
        asset_type="cn_etf",
        as_of="2026-07-29T08:00:00Z",
        bars=[
            {
                "ts": f"2026-07-{day:02d}T07:00:00Z",
                "close": 1 + offset / 100,
            }
            for offset, day in enumerate(range(20, 29))
        ],
        indicators={"atr14": 0.08, "rsi14": 37.12045566},
        sources=[{"source": "tencent", "sourceTier": "evidence"}],
        generated_at="2026-07-29T08:05:00Z",
    )
    assert "derivedEvidence" in packet
    derived = {row["name"]: row for row in packet["derivedEvidence"]}
    indicators = {row["name"]: row for row in packet["indicatorEvidence"]}
    window = derived["recentWindowTradingDays"]
    atr_ratio = derived["atrPctOfLatestClose"]
    rsi_threshold = derived["rsiOversoldThreshold"]
    controlled = (
        f"观察窗口包含 {window['value']} 个交易日 [{window['evidenceId']}]。"
        f"\n\nATR相对最新收盘为 {atr_ratio['value']}% "
        f"[{atr_ratio['evidenceId']}]。"
        f"\n\n配置的RSI超卖阈值为 {rsi_threshold['value']} "
        f"[{rsi_threshold['evidenceId']}]。"
    )
    unlisted_threshold = (
        f"RSI14为37.12045566 [{indicators['rsi14']['evidenceId']}]，"
        "高于30阈值。"
    )
    self_calculated = (
        f"ATR14为0.08 [{indicators['atr14']['evidenceId']}]，"
        f"最新收盘1.08 [M9]，约占7.4%。"
    )

    assert validate_report_claims(controlled, packet)["status"] == "passed"
    assert "UNSUPPORTED_DERIVED_NUMERIC_CLAIM" in validate_report_claims(
        unlisted_threshold,
        packet,
    )["errorCodes"]
    assert "UNSUPPORTED_DERIVED_NUMERIC_CLAIM" in validate_report_claims(
        self_calculated,
        packet,
    )["errorCodes"]


@pytest.mark.unit
def test_chinese_realized_volatility_value_is_not_masked_as_an_indicator_period():
    packet = build_evidence_packet(
        ticker="512480.SS",
        asset_type="cn_etf",
        as_of="2026-07-29T08:00:00Z",
        bars=[{"ts": "2026-07-28T07:00:00Z", "close": 1.027}],
        indicators={"realizedVolatility20": 81.62166617},
        sources=[{"source": "tencent", "sourceTier": "evidence"}],
        generated_at="2026-07-29T08:05:00Z",
    )
    evidence_id = packet["indicatorEvidence"][0]["evidenceId"]

    result = validate_report_claims(
        f"20日已实现波动率为81.62166617 [{evidence_id}]。",
        packet,
    )

    assert result["status"] == "passed"
    assert result["unsupportedDerivedNumericParagraphs"] == 0


@pytest.mark.unit
def test_close_change_derived_row_carries_its_trading_day_window():
    packet = build_evidence_packet(
        ticker="515880.SS",
        asset_type="cn_etf",
        as_of="2026-07-29T08:00:00Z",
        bars=[
            {
                "ts": f"2026-07-{day:02d}T07:00:00Z",
                "close": 1 + offset / 100,
            }
            for offset, day in enumerate(range(20, 29))
        ],
        sources=[{"source": "tencent", "sourceTier": "evidence"}],
        generated_at="2026-07-29T08:05:00Z",
    )
    row = next(
        item
        for item in packet["derivedEvidence"]
        if item["name"] == "recentWindowCloseChangePct"
    )
    text = (
        f"8个交易日窗口累计变动为{row['value']}% "
        f"[{row['evidenceId']}]。"
    )

    assert row["window"]["tradingDays"] == 8
    assert validate_report_claims(text, packet)["status"] == "passed"


@pytest.mark.unit
def test_negated_and_conditional_moving_average_phrases_are_not_claims():
    packet = build_evidence_packet(
        ticker="512480.SS",
        asset_type="cn_etf",
        as_of="2026-07-29T08:00:00Z",
        bars=[{"ts": "2026-07-28T07:00:00Z", "close": 1.027}],
        indicators={"ma20": 1.2169, "ma60": 1.16035},
        sources=[{"source": "tencent", "sourceTier": "evidence"}],
        generated_at="2026-07-29T08:05:00Z",
    )
    derived = next(
        item
        for item in packet["derivedEvidence"]
        if item["name"] == "strictMovingAverageAlignment"
    )
    text = (
        f"当前不满足 close < MA20 < MA60 的空头排列定义 "
        f"[{derived['evidenceId']}]。\n\n"
        f"关注是否出现 close > MA20 > MA60 的多头排列信号 "
        f"[{derived['evidenceId']}]。"
    )

    result = validate_report_claims(text, packet)

    assert result["status"] == "passed"
    assert result["contradictedMovingAverageAlignmentParagraphs"] == 0


@pytest.mark.unit
@pytest.mark.parametrize("ticker", ["515880.SS", "512480.SS"])
def test_july_30_production_raw_decisions_remain_fail_closed(ticker):
    report_dir = (
        Path(__file__).resolve().parents[1]
        / "public"
        / "reports"
        / ticker
        / "2026-07-30"
    )
    packet = __import__("json").loads(
        (report_dir / "evidence_packet.json").read_text(encoding="utf-8")
    )
    raw_decision = (report_dir / "5_portfolio" / "decision.md").read_text(
        encoding="utf-8"
    )

    result = validate_report_claims(raw_decision, packet)

    assert result["status"] == "failed"
    assert "UNSUPPORTED_DERIVED_NUMERIC_CLAIM" in result["errorCodes"]


@pytest.mark.unit
def test_single_snapshot_indicator_cannot_claim_expansion_or_convergence():
    packet = build_evidence_packet(
        ticker="512480.SS",
        asset_type="cn_etf",
        as_of="2026-07-29T08:00:00Z",
        bars=[{"ts": "2026-07-28T16:00:00Z", "close": 1.027}],
        indicators={
            "macd": -0.04770645,
            "macdSignal": -0.01957457,
            "macdHistogram": -0.02813188,
        },
        sources=[{"source": "tencent", "sourceTier": "evidence"}],
        generated_at="2026-07-29T08:05:00Z",
    )

    current = validate_report_claims(
        "MACD and its signal are both negative [I1-I3].",
        packet,
    )
    trend = validate_report_claims(
        "MACD柱状图仍在扩张，表明下行动能加速 [I1-I3]。",
        packet,
    )

    assert current["status"] == "passed"
    assert "UNSUPPORTED_SINGLE_SNAPSHOT_TREND" in trend["errorCodes"]
    assert trend["unsupportedSingleSnapshotTrendParagraphs"] == 1


@pytest.mark.unit
def test_moving_average_alignment_must_match_price_and_average_order():
    packet = build_evidence_packet(
        ticker="512480.SS",
        asset_type="cn_etf",
        as_of="2026-07-29T08:00:00Z",
        bars=[{"ts": "2026-07-28T16:00:00Z", "close": 1.027}],
        indicators={"ma20": 1.2169, "ma60": 1.16035},
        sources=[{"source": "tencent", "sourceTier": "evidence"}],
        generated_at="2026-07-29T08:05:00Z",
    )

    below = validate_report_claims(
        "The close is below MA20 and MA60 [M1, I1-I2].",
        packet,
    )
    false_alignment = validate_report_claims(
        "均线系统呈现空头排列 [M1, I1-I2]。",
        packet,
    )

    assert below["status"] == "passed"
    assert "CONTRADICTED_MOVING_AVERAGE_ALIGNMENT" in false_alignment["errorCodes"]
    assert false_alignment["contradictedMovingAverageAlignmentParagraphs"] == 1


@pytest.mark.unit
def test_claim_validation_ignores_target_and_allocation_disclaimers():
    packet = build_evidence_packet(
        ticker="GOOGL",
        asset_type="us_equity",
        as_of="2026-07-23T08:00:00Z",
        bars=[{"ts": "2026-07-23T07:00:00Z", "close": 180}],
        sources=[{"source": "sec", "sourceTier": "evidence"}],
        generated_at="2026-07-23T08:05:00Z",
    )
    text = (
        "The verified close was 180 [M1].\n\n"
        "This report does not provide a price target or numeric allocation."
    )

    result = validate_report_claims(text, packet)

    assert result["status"] == "passed"
    assert "UNSUPPORTED_PRICE_TARGET" not in result["errorCodes"]
    assert "UNSUPPORTED_ALLOCATION" not in result["errorCodes"]


@pytest.mark.unit
def test_allocation_and_target_validation_requires_adjacent_claim_semantics():
    packet = build_evidence_packet(
        ticker="GOOGL",
        asset_type="us_equity",
        as_of="2026-07-23T08:00:00Z",
        bars=[{"ts": "2026-07-23T07:00:00Z", "close": 180}],
        sources=[{"source": "sec", "sourceTier": "evidence"}],
        generated_at="2026-07-23T08:05:00Z",
    )

    benign = validate_report_claims(
        "历史单日近10%的反弹说明一次性清仓的执行风险不可忽视 [M1]。",
        packet,
    )
    reduce_to = validate_report_claims("建议将仓位降至50% [M1]。", packet)
    maintain = validate_report_claims("建议维持50%仓位 [M1]。", packet)
    target = validate_report_claims("目标价120 [M1]。", packet)

    assert "UNSUPPORTED_ALLOCATION" not in benign["errorCodes"]
    assert "UNSUPPORTED_ALLOCATION" in reduce_to["errorCodes"]
    assert "UNSUPPORTED_ALLOCATION" in maintain["errorCodes"]
    assert "UNSUPPORTED_PRICE_TARGET" in target["errorCodes"]


@pytest.mark.unit
def test_public_report_omits_invalid_citation_containers(tmp_path):
    packet = build_evidence_packet(
        ticker="GOOGL",
        asset_type="us_equity",
        as_of="2026-07-23T08:00:00Z",
        bars=[
            {"ts": "2026-07-22T07:00:00Z", "close": 175},
            {"ts": "2026-07-23T07:00:00Z", "close": 180},
        ],
        sources=[{"source": "sec", "sourceTier": "evidence"}],
        generated_at="2026-07-23T08:05:00Z",
    )
    state = {
        **_state(),
        "risk_debate_state": {
            "judge_decision": (
                "**Rating**: Hold\n\n"
                "Verified close is 180 [M2].\n\n"
                "Invalid prefix assertion [X1].\n\n"
                "Cross-prefix range assertion [M1-S1].\n\n"
                "Descending range assertion [M2-M1]."
            ),
        },
        "trade_date": "2026-07-23",
        "analysis_status": "rated",
        "evidence_packet": packet,
    }

    out = write_report_tree(state, "GOOGL", tmp_path)
    manifest = __import__("json").loads((tmp_path / "report_manifest.json").read_text())
    complete = out.read_text()

    assert manifest["analysisStatus"] == "rated"
    assert manifest["auditStatus"] == "verified"
    assert manifest["claimValidation"]["omittedUnsafeParagraphs"] == 3
    assert "Verified close is 180 [M2]." in complete
    assert "Invalid prefix assertion" not in complete
    assert "Cross-prefix range assertion" not in complete
    assert "Descending range assertion" not in complete


@pytest.mark.unit
def test_markdown_link_labels_do_not_count_as_numeric_claims_or_citations():
    packet = build_evidence_packet(
        ticker="GOOGL",
        asset_type="us_equity",
        as_of="2026-07-23T08:00:00Z",
        bars=[{"ts": "2026-07-23T07:00:00Z", "close": 180}],
        sources=[{"source": "sec", "sourceTier": "evidence"}],
        generated_at="2026-07-23T08:05:00Z",
    )
    text = (
        "See the [10-K](https://example.test/filings/2026/10-k) for context.\n\n"
        "The verified close was 180 [M1]."
    )

    result = validate_report_claims(text, packet)

    assert result["status"] == "passed"
    assert result["citationCount"] == 1
    assert result["uncitedNumericParagraphs"] == 0


@pytest.mark.unit
def test_evidence_like_markdown_links_do_not_satisfy_or_bypass_citation_gate():
    packet = build_evidence_packet(
        ticker="GOOGL",
        asset_type="us_equity",
        as_of="2026-07-23T08:00:00Z",
        bars=[{"ts": "2026-07-23T07:00:00Z", "close": 180}],
        sources=[{"source": "sec", "sourceTier": "evidence"}],
        generated_at="2026-07-23T08:05:00Z",
    )

    linked_evidence = validate_report_claims(
        "Qualitative conclusion [M1](https://example.test/footnote).",
        packet,
    )
    linked_invalid = validate_report_claims(
        "Claim [M1-S1](footnote).",
        packet,
    )

    assert linked_evidence["citationCount"] == 0
    assert "MISSING_EVIDENCE_CITATION" in linked_evidence["errorCodes"]
    assert "INVALID_EVIDENCE_CITATION" in linked_invalid["errorCodes"]


@pytest.mark.unit
def test_extremely_long_citation_number_is_invalid_instead_of_crashing():
    packet = build_evidence_packet(
        ticker="GOOGL",
        asset_type="us_equity",
        as_of="2026-07-23T08:00:00Z",
        bars=[{"ts": "2026-07-23T07:00:00Z", "close": 180}],
        generated_at="2026-07-23T08:05:00Z",
    )
    citation = f"[M{'9' * 4_301}]"

    result = validate_report_claims(f"Claim {citation}.", packet)

    assert result["status"] == "failed"
    assert result["citationCount"] == 0
    assert result["unknownEvidenceIds"] == []
    assert result["invalidEvidenceCitations"] == [citation]
    assert "INVALID_EVIDENCE_CITATION" in result["errorCodes"]


@pytest.mark.unit
def test_oversized_repeated_citation_ranges_are_rejected_without_expansion():
    packet = build_evidence_packet(
        ticker="GOOGL",
        asset_type="us_equity",
        as_of="2026-07-23T08:00:00Z",
        bars=[{"ts": "2026-07-23T07:00:00Z", "close": 180}],
        generated_at="2026-07-23T08:05:00Z",
    )
    citation = "[M1-M10001]"
    text = " ".join([citation] * 64)

    result = validate_report_claims(text, packet)

    assert result["status"] == "failed"
    assert result["citationCount"] == 0
    assert result["unknownEvidenceIds"] == []
    assert result["invalidEvidenceCitations"] == [citation] * 64
    assert "INVALID_EVIDENCE_CITATION" in result["errorCodes"]


@pytest.mark.unit
def test_long_markdown_links_are_removed_before_recommendation_scanning():
    packet = build_evidence_packet(
        ticker="GOOGL",
        asset_type="us_equity",
        as_of="2026-07-23T08:00:00Z",
        bars=[{"ts": "2026-07-23T07:00:00Z", "close": 180}],
        generated_at="2026-07-23T08:05:00Z",
    )
    long_link = (
        "[Portfolio allocation"
        + (" " * 10_000)
        + "20%](https://example.test/"
        + ("7" * 20_000)
        + ")"
    )
    text = f"Qualitative conclusion [M1]. See {long_link}."
    malformed = (
        ("[" * 10_000)
        + "Portfolio allocation"
        + (" " * 10_000)
        + "20% [M1]."
    )

    started = time.perf_counter()
    results = [
        validate_report_claims(candidate, packet)
        for candidate in ([text] * 4 + [malformed] * 4)
    ]
    elapsed = time.perf_counter() - started

    assert all(result["status"] == "passed" for result in results[:4])
    assert all(
        "UNSUPPORTED_DERIVED_NUMERIC_CLAIM" in result["errorCodes"]
        for result in results[4:]
    )
    assert all(
        "UNSUPPORTED_ALLOCATION" not in result["errorCodes"]
        for result in results
    )
    assert elapsed < 8


@pytest.mark.unit
def test_target_and_allocation_claim_variants_but_not_numeric_disclaimers(tmp_path):
    packet = build_evidence_packet(
        ticker="GOOGL",
        asset_type="us_equity",
        as_of="2026-07-23T08:00:00Z",
        bars=[{"ts": "2026-07-23T07:00:00Z", "close": 180}],
        sources=[{"source": "sec", "sourceTier": "evidence"}],
        generated_at="2026-07-23T08:05:00Z",
    )
    target_claims = [
        "Raise price target to $200 [M1].",
        "目标价上调至200元 [M1]。",
        "目标价区间190至200元 [M1]。",
    ]
    allocation_claims = [
        "建议持有20% [M1]。",
        "持仓比例20% [M1]。",
        "Keep 20% of portfolio [M1].",
    ]
    disclaimers = (
        "The verified close was 180 [M1].\n\n"
        "This report does not set a $200 price target.\n\n"
        "This report does not recommend a 20% allocation."
    )

    for text in target_claims:
        assert "UNSUPPORTED_PRICE_TARGET" in validate_report_claims(
            text, packet
        )["errorCodes"]
    for text in allocation_claims:
        assert "UNSUPPORTED_ALLOCATION" in validate_report_claims(
            text, packet
        )["errorCodes"]
    assert validate_report_claims(disclaimers, packet)["status"] == "passed"

    state = {
        **_state(),
        "risk_debate_state": {"judge_decision": disclaimers},
        "trade_date": "2026-07-23",
        "analysis_status": "rated",
        "evidence_packet": packet,
    }
    complete = write_report_tree(state, "GOOGL", tmp_path).read_text()
    assert "does not set a $200 price target" in complete
    assert "does not recommend a 20% allocation" in complete


@pytest.mark.unit
def test_more_numeric_disclaimers_and_allocation_phrasings():
    packet = build_evidence_packet(
        ticker="GOOGL",
        asset_type="us_equity",
        as_of="2026-07-23T08:00:00Z",
        bars=[{"ts": "2026-07-23T07:00:00Z", "close": 180}],
        sources=[{"source": "sec", "sourceTier": "evidence"}],
        generated_at="2026-07-23T08:05:00Z",
    )
    disclaimers = [
        "The conclusion is cited [M1]. This report does not set a price target of $200.",
        "The conclusion is cited [M1]. No price target of $200 is provided.",
        "结论已有证据 [M1]。本报告不设目标价200元。",
    ]
    allocations = [
        "Portfolio allocation should be 20% [M1].",
        "仓位建议为20% [M1]。",
    ]

    for text in disclaimers:
        assert validate_report_claims(text, packet)["status"] == "passed"
    for text in allocations:
        assert "UNSUPPORTED_ALLOCATION" in validate_report_claims(
            text, packet
        )["errorCodes"]


@pytest.mark.unit
def test_numeric_validation_ignores_structural_dates_and_indicator_parameters():
    packet = build_evidence_packet(
        ticker="GOOGL",
        asset_type="us_equity",
        as_of="2026-07-23T08:00:00Z",
        bars=[{"ts": "2026-07-23T07:00:00Z", "close": 180}],
        sources=[{"source": "sec", "sourceTier": "evidence"}],
        generated_at="2026-07-23T08:05:00Z",
    )
    text = (
        "# 1. GOOGL 2026-07-23\n\n"
        "Generated: 2026-07-26T05:39:49.782261+00:00\n\n"
        "The short-form trade date is 07-29.\n\n"
        "RSI(14)、MACD 12-26-9 和 50日指数移动平均线是指标参数。\n\n"
        "The close was 180 without a citation.\n\n"
        "The verified close was 180 [M1]."
    )

    result = validate_report_claims(text, packet)

    assert result["citationCount"] == 1
    assert result["uncitedNumericParagraphs"] == 1
    assert result["errorCodes"] == ["UNCITED_NUMERIC_CLAIM"]


@pytest.mark.unit
def test_validation_failed_packet_cannot_generate_a_report(tmp_path):
    packet = build_evidence_packet(
        ticker="512480.SS",
        asset_type="cn_etf",
        as_of="2026-07-04T07:00:00Z",
        bars=[
            {"ts": "2026-07-02T07:00:00Z", "close": 1.4, "adjustment": "none"},
            {"ts": "2026-07-03T07:00:00Z", "close": 0.7, "adjustment": "none"},
        ],
        corporate_actions=[{"type": "split", "exDate": "2026-07-03"}],
        generated_at="2026-07-04T07:05:00Z",
    )
    with pytest.raises(ValueError, match="cannot generate"):
        write_report_tree({**_state(), "evidence_packet": packet}, "512480.SS", tmp_path)
