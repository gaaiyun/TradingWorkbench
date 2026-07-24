"""Report parity: the shared writer produces the report tree for the CLI and the
programmatic API alike (#1037)."""

from types import SimpleNamespace

import pytest

from tradingagents.evidence import build_evidence_packet
from tradingagents.graph.trading_graph import TradingAgentsGraph
from tradingagents.reporting import write_report_tree


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
    state = {**_state(), "trade_date": "2026-07-23", "analysis_status": "rated", "evidence_packet": packet}
    out = write_report_tree(state, "GOOGL", tmp_path)
    manifest = __import__("json").loads((tmp_path / "report_manifest.json").read_text())
    assert manifest["analysisStatus"] == "rated"
    assert manifest["auditStatus"] == "verified"
    assert manifest["evidence"]["contentHash"] == packet["contentHash"]
    assert (tmp_path / "evidence_packet.json").exists()
    assert out.read_text().count("FINAL TRANSACTION PROPOSAL") <= 1


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
