import math
import sys

import pandas as pd
import pytest
from langgraph.graph import END, START, StateGraph

from scripts.run_daily import (
    _corporate_actions_from_news,
    _point_in_time_cutoff,
    build_runtime_evidence,
)
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


def test_runtime_cutoff_never_claims_a_future_end_of_day():
    assert _point_in_time_cutoff(
        "2026-07-28",
        now="2026-07-28T07:21:00Z",
    ) == "2026-07-28T07:21:00Z"
    assert _point_in_time_cutoff(
        "2026-07-28",
        now="2026-07-29T01:00:00Z",
    ) == "2026-07-28T23:59:59Z"


def test_official_split_notice_becomes_a_citable_corporate_action():
    actions = _corporate_actions_from_news([{
        "title": "某基金基金份额拆分结果的公告",
        "publishedAt": "2026-07-05T16:00:00Z",
        "url": "https://www.sse.com.cn/split.pdf",
        "source": "上海证券交易所基金公告",
        "sourceTier": "evidence",
    }])
    assert actions == [{
        "type": "fund_share_split_notice",
        "date": "2026-07-05",
        "title": "某基金基金份额拆分结果的公告",
        "url": "https://www.sse.com.cn/split.pdf",
        "source": "上海证券交易所基金公告",
    }]


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


def test_unexplained_etf_jump_still_blocks_rating():
    packet = build_evidence_packet(
        ticker="512480.SS",
        asset_type="cn_etf",
        as_of="2026-07-04T07:00:00Z",
        bars=[bar("2026-07-02T07:00:00Z", 1.4), bar("2026-07-03T07:00:00Z", 0.7)],
        generated_at="2026-07-04T07:05:00Z",
    )

    assert packet["status"] == "data_validation_failed"
    assert "UNEXPLAINED_PRICE_JUMP" in packet["integrity"]["errors"]
    assert packet["canRate"] is False


def test_extreme_equity_move_is_flagged_without_treating_a_real_gap_as_a_split():
    packet = build_evidence_packet(
        ticker="ORCL",
        asset_type="us_equity",
        as_of="2025-09-11T23:59:59Z",
        bars=[
            bar("2025-09-10T20:00:00Z", 241.51),
            bar("2025-09-11T20:00:00Z", 328.33),
        ],
        sources=[{"source": "yahoo", "sourceTier": "evidence"}],
        generated_at="2025-09-12T00:05:00Z",
    )

    assert packet["status"] == "ok"
    assert packet["canRate"] is True
    assert "EXTREME_PRICE_MOVE" in packet["integrity"]["warnings"]
    assert "UNEXPLAINED_PRICE_JUMP" not in packet["integrity"]["errors"]


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


def test_langgraph_state_schema_preserves_evidence_gate_fields():
    """The compiled graph must not silently discard the evidence ledger."""
    AgentState = sys.modules[
        "tradingagents.agents.utils.agent_states"
    ].AgentState
    assert "evidence_packet" in AgentState.__annotations__
    assert "analysis_status" in AgentState.__annotations__

    packet = build_evidence_packet(
        ticker="512480.SS",
        asset_type="cn_etf",
        as_of="2026-07-29T08:00:00Z",
        bars=[bar("2026-07-28T16:00:00Z", 1.05)],
        sources=[{"source": "tencent", "sourceTier": "evidence"}],
        generated_at="2026-07-29T08:05:00Z",
    )
    initial = Propagator().create_initial_state(
        "512480.SS",
        "2026-07-29",
        asset_type="cn_etf",
        evidence_packet=packet,
    )
    workflow = StateGraph(AgentState)
    workflow.add_node(
        "observe_evidence",
        lambda state: {"analysis_status": state["analysis_status"]},
    )
    workflow.add_edge(START, "observe_evidence")
    workflow.add_edge("observe_evidence", END)

    final = workflow.compile().invoke(initial)
    assert final["evidence_packet"]["contentHash"] == packet["contentHash"]
    assert final["analysis_status"] == "rated"


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
        if url.endswith("/api/news"):
            return type(
                "EmptyNewsResponse",
                (),
                {
                    "status_code": 200,
                    "json": staticmethod(
                        lambda: {"status": "unavailable", "data": [], "sources": []}
                    ),
                },
            )()
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
        if url.endswith("/api/news"):
            return type(
                "EmptyNewsResponse",
                (),
                {
                    "status_code": 200,
                    "json": staticmethod(
                        lambda: {"status": "unavailable", "data": [], "sources": []}
                    ),
                },
            )()
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


def test_adhoc_yahoo_evidence_uses_a_bounded_point_in_time_history_and_indicators(
    monkeypatch,
):
    observed = {}
    count = 1400
    dates = pd.date_range("2020-12-01", periods=count, freq="B", tz="UTC")
    history = pd.DataFrame(
        {
            "Open": [100 + index * 0.1 for index in range(count)],
            "High": [101 + index * 0.1 for index in range(count)],
            "Low": [99 + index * 0.1 for index in range(count)],
            "Close": [100.5 + index * 0.1 for index in range(count)],
            "Volume": [1_000_000 + index for index in range(count)],
            "Stock Splits": [0.0] * count,
        },
        index=dates,
    )

    class Ticker:
        def history(self, **kwargs):
            observed.update(kwargs)
            return history

    monkeypatch.setattr("scripts.run_daily._load_workbench_daily", lambda *_: None)
    monkeypatch.setattr(
        "scripts.run_daily._load_workbench_news",
        lambda *_: {"items": [], "sources": []},
    )
    monkeypatch.setattr("yfinance.Ticker", lambda _symbol: Ticker())

    packet = build_runtime_evidence("ADHOC", "2026-01-02")

    assert observed == {
        "start": "2020-12-31",
        "end": "2026-01-03",
        "auto_adjust": True,
        "actions": True,
    }
    assert packet["integrity"]["barCount"] == 1260
    assert packet["bars"][-1]["ts"].startswith("2026-01-02")
    assert all(bar["ts"][:10] <= "2026-01-02" for bar in packet["bars"])
    assert {bar["adjustment"] for bar in packet["bars"]} == {
        "split-and-dividend-adjusted"
    }
    assert packet["indicators"]["version"] == "ta-indicators-v1"
    assert packet["indicators"]["bars"] == packet["integrity"]["barCount"]
    assert packet["indicators"]["asOf"] == packet["bars"][-1]["ts"]
    assert packet["indicators"]["adjustment"] == "split-and-dividend-adjusted"
    assert {
        "ma20",
        "ma60",
        "ma200",
        "macd",
        "macdSignal",
        "macdHistogram",
        "rsi14",
        "atr14",
        "realizedVolatility20",
    } <= packet["indicators"].keys()


def test_adhoc_yahoo_drops_an_incomplete_trailing_bar_before_calculating_indicators(
    monkeypatch,
):
    count = 201
    dates = pd.date_range("2025-03-27", periods=count, freq="B", tz="UTC")
    valid = count - 1
    history = pd.DataFrame(
        {
            "Open": [100 + index * 0.1 for index in range(valid)] + [math.nan],
            "High": [101 + index * 0.1 for index in range(valid)] + [math.nan],
            "Low": [99 + index * 0.1 for index in range(valid)] + [math.nan],
            "Close": [100.5 + index * 0.1 for index in range(valid)] + [math.nan],
            "Volume": [1_000_000 + index for index in range(count)],
            "Stock Splits": [0.0] * count,
        },
        index=dates,
    )

    monkeypatch.setattr("scripts.run_daily._load_workbench_daily", lambda *_: None)
    monkeypatch.setattr(
        "scripts.run_daily._load_workbench_news",
        lambda *_: {"items": [], "sources": []},
    )
    monkeypatch.setattr(
        "yfinance.Ticker",
        lambda _symbol: type(
            "Ticker",
            (),
            {"history": lambda _self, **_kwargs: history},
        )(),
    )

    packet = build_runtime_evidence("MSFT", dates[-1].date().isoformat())

    assert packet["integrity"]["barCount"] == 200
    assert packet["status"] == "data_validation_failed"
    assert packet["canRate"] is False
    assert "DROPPED_INCOMPLETE_BAR" in packet["integrity"]["warnings"]
    assert "MISSING_TARGET_DATE_BAR" in packet["integrity"]["errors"]
    assert packet["indicators"]["bars"] == 200
    assert packet["indicators"]["asOf"] == packet["bars"][-1]["ts"]
    assert packet["indicators"]["ma200"] is not None
    assert all(
        math.isfinite(bar[field])
        for bar in packet["bars"]
        for field in ("open", "high", "low", "close", "volume")
    )


def test_adhoc_yahoo_does_not_fail_when_the_requested_date_has_no_provider_bar(
    monkeypatch,
):
    history = pd.DataFrame(
        {
            "Open": [100.0],
            "High": [101.0],
            "Low": [99.0],
            "Close": [100.5],
            "Volume": [1_000_000],
            "Stock Splits": [0.0],
        },
        index=pd.DatetimeIndex(["2026-01-16T00:00:00Z"]),
    )
    monkeypatch.setattr("scripts.run_daily._load_workbench_daily", lambda *_: None)
    monkeypatch.setattr(
        "scripts.run_daily._load_workbench_news",
        lambda *_: {"items": [], "sources": []},
    )
    monkeypatch.setattr(
        "yfinance.Ticker",
        lambda _symbol: type(
            "Ticker",
            (),
            {"history": lambda _self, **_kwargs: history},
        )(),
    )

    packet = build_runtime_evidence("MSFT", "2026-01-19")

    assert packet["status"] == "ok"
    assert packet["canRate"] is True
    assert "MISSING_TARGET_DATE_BAR" not in packet["integrity"]["errors"]


def test_adhoc_yahoo_filter_uses_the_exchange_date_before_utc_conversion(monkeypatch):
    history = pd.DataFrame(
        {
            "Open": [10.0, 20.0],
            "High": [11.0, 21.0],
            "Low": [9.0, 19.0],
            "Close": [10.5, 20.5],
            "Volume": [100, 200],
            "Stock Splits": [0.0, 0.0],
        },
        index=pd.DatetimeIndex(
            ["2026-01-02T00:00:00+08:00", "2026-01-03T00:00:00+08:00"],
        ),
    )

    monkeypatch.setattr("scripts.run_daily._load_workbench_daily", lambda *_: None)
    monkeypatch.setattr(
        "scripts.run_daily._load_workbench_news",
        lambda *_: {"items": [], "sources": []},
    )
    monkeypatch.setattr(
        "yfinance.Ticker",
        lambda _symbol: type(
            "Ticker",
            (),
            {"history": lambda _self, **_kwargs: history},
        )(),
    )

    packet = build_runtime_evidence("3887.HK", "2026-01-02")

    assert packet["integrity"]["barCount"] == 1
    assert packet["bars"][0]["close"] == 10.5


@pytest.mark.parametrize("field", ["open", "high", "low", "close", "volume"])
@pytest.mark.parametrize("invalid_value", [math.nan, math.inf, -math.inf])
def test_evidence_gateway_rejects_non_finite_market_values(field, invalid_value):
    invalid_bar = bar("2026-01-02T20:00:00Z", 100)
    invalid_bar[field] = invalid_value

    with pytest.raises(EvidenceValidationError, match="finite"):
        build_evidence_packet(
            ticker="MSFT",
            asset_type="us_equity",
            as_of="2026-01-02T21:00:00Z",
            bars=[invalid_bar],
            sources=[{"source": "yahoo-finance", "sourceTier": "discovery"}],
        )


def test_adhoc_yahoo_returns_unavailable_when_every_provider_bar_is_incomplete(
    monkeypatch,
):
    history = pd.DataFrame(
        {
            "Open": [math.nan],
            "High": [math.nan],
            "Low": [math.nan],
            "Close": [math.nan],
            "Volume": [100],
            "Stock Splits": [0.0],
        },
        index=pd.DatetimeIndex(["2026-01-02T00:00:00Z"]),
    )
    monkeypatch.setattr("scripts.run_daily._load_workbench_daily", lambda *_: None)
    monkeypatch.setattr(
        "scripts.run_daily._load_workbench_news",
        lambda *_: {"items": [], "sources": []},
    )
    monkeypatch.setattr(
        "yfinance.Ticker",
        lambda _symbol: type(
            "Ticker",
            (),
            {"history": lambda _self, **_kwargs: history},
        )(),
    )

    packet = build_runtime_evidence("MSFT", "2026-01-02")

    assert packet["status"] == "unavailable"
    assert packet["canRate"] is False
    assert packet["integrity"]["barCount"] == 0
    assert packet["indicators"]["bars"] == 0
    assert packet["indicators"]["asOf"] is None


def test_adhoc_yahoo_does_not_coerce_non_finite_volume_to_zero(monkeypatch):
    history = pd.DataFrame(
        {
            "Open": [100.0],
            "High": [101.0],
            "Low": [99.0],
            "Close": [100.5],
            "Volume": [math.nan],
            "Stock Splits": [0.0],
        },
        index=pd.DatetimeIndex(["2026-01-02T00:00:00Z"]),
    )
    monkeypatch.setattr("scripts.run_daily._load_workbench_daily", lambda *_: None)
    monkeypatch.setattr(
        "scripts.run_daily._load_workbench_news",
        lambda *_: {"items": [], "sources": []},
    )
    monkeypatch.setattr(
        "yfinance.Ticker",
        lambda _symbol: type(
            "Ticker",
            (),
            {"history": lambda _self, **_kwargs: history},
        )(),
    )

    with pytest.raises(EvidenceValidationError, match="finite"):
        build_runtime_evidence("MSFT", "2026-01-02")


@pytest.mark.parametrize(
    "invalid_bar",
    [
        {
            "ts": "2026-01-02T20:00:00Z",
            "open": -1,
            "high": 101,
            "low": 99,
            "close": 100,
            "volume": 10,
        },
        {
            "ts": "2026-01-02T20:00:00Z",
            "open": 100,
            "high": 98,
            "low": 99,
            "close": 100,
            "volume": 10,
        },
        {
            "ts": "2026-01-02T20:00:00Z",
            "open": 100,
            "high": 101,
            "low": 99,
            "close": 102,
            "volume": 10,
        },
    ],
)
def test_evidence_gateway_rejects_impossible_ohlc_ranges(invalid_bar):
    with pytest.raises(EvidenceValidationError, match="OHLC"):
        build_evidence_packet(
            ticker="MSFT",
            asset_type="us_equity",
            as_of="2026-01-02T21:00:00Z",
            bars=[invalid_bar],
            sources=[{"source": "yahoo-finance", "sourceTier": "discovery"}],
        )


def test_runtime_evidence_includes_point_in_time_workbench_news(monkeypatch):
    observed = {}

    monkeypatch.setattr(
        "scripts.run_daily._load_workbench_daily",
        lambda _symbol, _trade_date: {
            "bars": [
                {
                    "ts": "2026-07-24T08:00:00Z",
                    "open": 6.1,
                    "high": 6.3,
                    "low": 6.0,
                    "close": 6.2,
                    "volume": 1000,
                    "adjustment": "qfq",
                },
            ],
            "sources": [
                {
                    "source": "yahoo",
                    "asOf": "2026-07-24T08:00:00Z",
                    "fetchedAt": "2026-07-25T05:35:00Z",
                    "sourceTier": "evidence",
                },
            ],
            "indicators": {},
        },
    )

    class Response:
        status_code = 200

        @staticmethod
        def json():
            return {
                "status": "stale",
                "data": [
                    {
                        "id": "official-1",
                        "title": "HashKey publishes a licensed exchange update",
                        "url": "https://group.hashkey.com/en/newsroom/update",
                        "published_at": "2026-07-21T01:39:24Z",
                        "source": "HashKey Investor Relations",
                        "source_tier": "evidence",
                    },
                    {
                        "id": "future-1",
                        "title": "Future announcement",
                        "url": "https://example.com/future",
                        "published_at": "2026-07-25T01:00:00Z",
                        "source": "Example",
                        "source_tier": "discovery",
                    },
                ],
                "sources": [],
            }

    def get(url, *, params, timeout):
        observed.update(url=url, params=params, timeout=timeout)
        return Response()

    monkeypatch.setenv("PAGES_URL", "https://board.example/")
    monkeypatch.setattr("requests.get", get)

    packet = build_runtime_evidence("3887.HK", "2026-07-24")

    assert packet["integrity"]["newsCount"] == 1
    assert packet["news"][0]["evidenceId"] == "N1"
    assert packet["news"][0]["sourceTier"] == "evidence"
    assert observed["url"] == "https://board.example/api/news"
    assert observed["params"] == {
        "symbol": "3887.HK",
        "tier": "evidence",
        "limit": 200,
    }
