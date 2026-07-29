import json

import pytest

from tradingagents.evidence import build_evidence_packet
from tradingagents.reporting import write_report_tree


def _state():
    return {
        "market_report": "MKT [M1]",
        "news_report": "NEWS [M1]",
        "investment_debate_state": {"judge_decision": "RM PLAN [M1]"},
        "trader_investment_plan": "TRADE [M1]",
        "risk_debate_state": {"judge_decision": "PM DECISION [M1]"},
        "trade_date": "2026-07-24",
        "analysis_status": "rated",
    }


@pytest.mark.unit
@pytest.mark.parametrize(
    ("source", "adjustment"),
    [
        ("tencent", "qfq"),
        ("yahoo-finance", "split-and-dividend-adjusted"),
    ],
)
def test_report_explicitly_records_market_history_metadata(
    tmp_path,
    source,
    adjustment,
):
    packet = build_evidence_packet(
        ticker="512480.SS" if adjustment == "qfq" else "MSFT",
        asset_type="cn_etf" if adjustment == "qfq" else "us_equity",
        as_of="2026-07-24T23:59:59Z",
        bars=[
            {
                "ts": "2026-07-22T07:00:00Z",
                "close": 1.1,
                "adjustment": adjustment,
            },
            {
                "ts": "2026-07-23T07:00:00Z",
                "close": 1.2,
                "adjustment": adjustment,
            },
        ],
        sources=[{"source": source, "sourceTier": "evidence"}],
        generated_at="2026-07-24T08:05:00Z",
    )

    report_path = write_report_tree(
        {**_state(), "evidence_packet": packet},
        packet["instrument"]["symbol"],
        tmp_path,
    )
    manifest = json.loads((tmp_path / "report_manifest.json").read_text())
    expected = {
        "source": source,
        "adjustment": adjustment,
        "barCount": 2,
        "startAt": "2026-07-22T07:00:00Z",
        "endAt": "2026-07-23T07:00:00Z",
    }

    assert manifest["evidence"]["marketHistory"] == expected
    report = report_path.read_text()
    assert (
        f"Market history: source `{source}`; adjustment `{adjustment}`; "
        "2 bars from `2026-07-22T07:00:00Z` to `2026-07-23T07:00:00Z`"
    ) in report


@pytest.mark.unit
def test_cn_report_shows_business_trade_date_before_raw_utc_timestamp(tmp_path):
    packet = build_evidence_packet(
        ticker="512480.SS",
        asset_type="cn_etf",
        as_of="2026-07-29T08:00:00Z",
        bars=[{
            "ts": "2026-07-28T16:00:00Z",
            "open": 1.0,
            "high": 1.1,
            "low": 0.9,
            "close": 1.05,
            "volume": 100,
            "adjustment": "qfq",
        }],
        sources=[{"source": "tencent", "sourceTier": "evidence"}],
        generated_at="2026-07-29T08:05:00Z",
    )

    report_path = write_report_tree(
        {**_state(), "evidence_packet": packet},
        packet["instrument"]["symbol"],
        tmp_path,
    )

    report = report_path.read_text()
    assert "[M1] trade date 2026-07-29" in report
    assert "raw UTC 2026-07-28T16:00:00Z" in report
