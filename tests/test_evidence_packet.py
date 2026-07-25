import pytest

from scripts.run_daily import build_runtime_evidence
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
        indicators={"ma20": 9.8, "rsi14": 55.2},
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
    assert packet["indicatorEvidence"] == [
        {"evidenceId": "I1", "name": "ma20", "value": 9.8},
        {"evidenceId": "I2", "name": "rsi14", "value": 55.2},
    ]
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


def test_cn_runtime_evidence_prefers_workbench_qfq_history(monkeypatch):
    observed = {}

    class Response:
        status_code = 200

        @staticmethod
        def json():
            return {
                "status": "ok",
                "asOf": "2026-07-24T07:00:00Z",
                "data": [
                    {
                        "symbol": "512480.SS",
                        "timeframe": "1d",
                        "ts": "2026-07-24T07:00:00Z",
                        "open": 1.25,
                        "high": 1.29,
                        "low": 1.24,
                        "close": 1.27,
                        "volume": 100,
                        "source": "tencent",
                        "as_of": "2026-07-24T07:00:00Z",
                        "fetched_at": "2026-07-24T07:01:00Z",
                        "freshness": "fresh",
                        "adjustment": "qfq",
                        "quality": "good",
                    },
                    {
                        "symbol": "512480.SS",
                        "timeframe": "1d",
                        "ts": "2026-07-23T07:00:00Z",
                        "open": 1.24,
                        "high": 1.27,
                        "low": 1.23,
                        "close": 1.25,
                        "volume": 90,
                        "source": "tencent",
                        "as_of": "2026-07-23T07:00:00Z",
                        "fetched_at": "2026-07-24T07:01:00Z",
                        "freshness": "fresh",
                        "adjustment": "qfq",
                        "quality": "good",
                    },
                ],
                "sources": [{
                    "source": "tencent",
                    "asOf": "2026-07-24T07:00:00Z",
                    "fetchedAt": "2026-07-24T07:01:00Z",
                    "freshness": "fresh",
                    "adjustment": "qfq",
                    "quality": "good",
                }],
            }

    def get(url, *, params, timeout):
        observed.update(url=url, params=params, timeout=timeout)
        return Response()

    monkeypatch.setenv("PAGES_URL", "https://board.example/")
    monkeypatch.setattr("requests.get", get)
    monkeypatch.setattr(
        "yfinance.Ticker",
        lambda *_: (_ for _ in ()).throw(AssertionError("Yahoo must not run")),
    )

    packet = build_runtime_evidence("512480.SS", "2026-07-24")

    assert packet["status"] == "ok"
    assert packet["canRate"] is True
    assert packet["integrity"]["barCount"] == 2
    assert {bar["adjustment"] for bar in packet["bars"]} == {"qfq"}
    assert packet["sources"][0]["source"] == "tencent"
    assert observed["params"]["limit"] == 1260


def test_us_runtime_evidence_uses_the_same_five_year_workbench_history(monkeypatch):
    observed = {}

    class Response:
        status_code = 200

        @staticmethod
        def json():
            return {
                "status": "ok",
                "asOf": "2026-07-24T20:00:00Z",
                "data": [
                    {
                        "ts": "2026-07-24T13:30:00Z",
                        "open": 190,
                        "high": 194,
                        "low": 189,
                        "close": 193,
                        "volume": 1000,
                        "source": "yahoo",
                        "adjustment": "qfq",
                        "quality": "good",
                    },
                    {
                        "ts": "2021-07-26T13:30:00Z",
                        "open": 189,
                        "high": 191,
                        "low": 188,
                        "close": 190,
                        "volume": 900,
                        "source": "yahoo",
                        "adjustment": "qfq",
                        "quality": "good",
                    },
                ],
                "sources": [{
                    "source": "yahoo",
                    "asOf": "2026-07-24T20:00:00Z",
                    "fetchedAt": "2026-07-25T05:35:00Z",
                    "adjustment": "qfq",
                    "quality": "good",
                }],
            }

    def get(url, *, params, timeout):
        observed.update(url=url, params=params, timeout=timeout)
        return Response()

    monkeypatch.setenv("PAGES_URL", "https://board.example/")
    monkeypatch.setattr("requests.get", get)
    monkeypatch.setattr(
        "yfinance.Ticker",
        lambda *_: (_ for _ in ()).throw(AssertionError("Yahoo fallback must not run")),
    )

    packet = build_runtime_evidence("GOOGL", "2026-07-24")

    assert packet["instrument"]["symbol"] == "GOOGL"
    assert packet["status"] == "ok"
    assert packet["integrity"]["barCount"] == 2
    assert packet["bars"][0]["ts"].startswith("2021-07-26")
    assert observed["params"] == {
        "symbol": "GOOGL",
        "timeframe": "1d",
        "limit": 1260,
    }
