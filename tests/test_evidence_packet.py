import pytest

from tradingagents.evidence import (
    EvidenceValidationError,
    build_evidence_packet,
    validate_evidence_packet,
)
from tradingagents.graph.propagation import Propagator


def bar(ts, close, adjustment="qfq"):
    return {
        "ts": ts,
        "open": close,
        "high": close,
        "low": close,
        "close": close,
        "volume": 100,
        "adjustment": adjustment,
    }


def test_packet_filters_future_news_and_records_point_in_time_evidence():
    packet = build_evidence_packet(
        ticker="03887",
        asset_type="hk_equity",
        as_of="2026-07-23T08:00:00Z",
        bars=[bar("2026-07-22T08:00:00Z", 10), bar("2026-07-23T08:00:00Z", 10.2)],
        sources=[{"source": "hkexnews", "sourceTier": "evidence"}],
        news=[
            {"id": "n1", "publishedAt": "2026-07-23T07:00:00Z", "title": "published"},
            {"id": "n2", "publishedAt": "2026-07-24T07:00:00Z", "title": "future"},
        ],
        generated_at="2026-07-23T08:05:00Z",
    )

    assert packet["schemaVersion"] == "EvidencePacketV1"
    assert packet["instrument"]["symbol"] == "3887.HK"
    assert packet["status"] == "ok"
    assert [item["id"] for item in packet["news"]] == ["n1"]
    assert packet["integrity"]["barCount"] == 2
    assert packet["contentHash"] and len(packet["contentHash"]) == 64
    validate_evidence_packet(packet)


def test_unadjusted_split_jump_blocks_rating():
    packet = build_evidence_packet(
        ticker="512480.SS",
        asset_type="cn_etf",
        as_of="2026-07-04T07:00:00Z",
        bars=[bar("2026-07-02T07:00:00Z", 1.4, "none"), bar("2026-07-03T07:00:00Z", 0.7, "none")],
        corporate_actions=[{
            "type": "split",
            "exDate": "2026-07-03",
            "source": "sse",
        }],
        generated_at="2026-07-04T07:05:00Z",
    )

    assert packet["status"] == "data_validation_failed"
    assert "CORPORATE_ACTION_UNADJUSTED" in packet["integrity"]["errors"]
    assert packet["canRate"] is False


def test_packet_rejects_malformed_and_future_bars():
    with pytest.raises(EvidenceValidationError, match="future"):
        build_evidence_packet(
            ticker="GOOGL",
            asset_type="us_equity",
            as_of="2026-07-23T08:00:00Z",
            bars=[bar("2026-07-24T08:00:00Z", 100)],
        )

    with pytest.raises(EvidenceValidationError, match="contentHash"):
        validate_evidence_packet({"schemaVersion": "EvidencePacketV1"})


def test_propagator_carries_packet_status_into_agent_state():
    packet = build_evidence_packet(
        ticker="GOOGL",
        asset_type="us_equity",
        as_of="2026-07-23T08:00:00Z",
        bars=[bar("2026-07-23T07:00:00Z", 180)],
        generated_at="2026-07-23T08:05:00Z",
    )
    state = Propagator().create_initial_state(
        "GOOGL",
        "2026-07-23",
        asset_type="us_equity",
        evidence_packet=packet,
    )
    assert state["analysis_status"] == "degraded"
    assert state["evidence_packet"]["contentHash"] == packet["contentHash"]
