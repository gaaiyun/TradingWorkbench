from __future__ import annotations

import requests

from scripts.run_daily import publish_evidence_bundle, run_ticker


def packet() -> dict:
    return {
        "schemaVersion": "EvidencePacketV1",
        "status": "ok",
        "asOf": "2026-07-24T20:00:00Z",
        "generatedAt": "2026-07-24T20:05:00Z",
        "instrument": {"symbol": "GOOGL", "assetType": "us_equity"},
        "bars": [],
        "corporateActions": [],
        "news": [],
        "sources": [],
        "integrity": {"errors": [], "warnings": []},
        "canRate": True,
        "contentHash": "a" * 64,
    }


def test_publish_evidence_bundle_posts_only_to_configured_endpoint(monkeypatch):
    observed = {}

    class Response:
        status_code = 201

    def post(url, *, json, headers, timeout):
        observed.update(url=url, json=json, headers=headers, timeout=timeout)
        return Response()

    monkeypatch.setenv("EVIDENCE_API_URL", "https://board.example/api/evidence")
    monkeypatch.setenv("EVIDENCE_WRITE_TOKEN", "write-secret")
    monkeypatch.setattr(requests, "post", post)

    result = publish_evidence_bundle(packet())

    assert result == {"published": True, "status": 201}
    assert observed["url"] == "https://board.example/api/evidence"
    assert observed["headers"]["authorization"] == "Bearer write-secret"
    assert observed["json"]["packet"]["instrument"]["symbol"] == "GOOGL"
    assert "write-secret" not in str(result)


def test_publish_evidence_bundle_fails_safely_without_configuration(monkeypatch):
    monkeypatch.delenv("EVIDENCE_API_URL", raising=False)
    monkeypatch.delenv("EVIDENCE_WRITE_TOKEN", raising=False)

    result = publish_evidence_bundle(packet())

    assert result == {"published": False, "reason": "not_configured"}


def test_publish_evidence_bundle_normalizes_http_and_network_failures(monkeypatch):
    class Response:
        status_code = 500

    monkeypatch.setenv("EVIDENCE_API_URL", "https://board.example/api/evidence")
    monkeypatch.setenv("EVIDENCE_WRITE_TOKEN", "write-secret")
    monkeypatch.setattr(requests, "post", lambda *args, **kwargs: Response())
    assert publish_evidence_bundle(packet()) == {
        "published": False,
        "reason": "http_error",
        "status": 500,
    }

    def fail(*args, **kwargs):
        raise requests.RequestException("contains upstream details")

    monkeypatch.setattr(requests, "post", fail)
    assert publish_evidence_bundle(packet()) == {
        "published": False,
        "reason": "network_error",
    }


def test_run_ticker_publishes_validated_evidence_before_starting_the_model(
    monkeypatch,
    tmp_path,
):
    calls = []
    runtime_packet = packet()

    def publish(packet_payload, *, manifest=None, report=None):
        calls.append(("publish", manifest, report))
        return {"published": True, "status": 201}

    class FakeGraph:
        def __init__(self, **_kwargs):
            pass

        def propagate(self, *_args, **_kwargs):
            assert calls == [("publish", None, None)]
            calls.append(("model", None, None))
            return {"final_trade_decision": "Hold [BAR-1]"}, "Hold"

        def save_reports(self, _state, _symbol, *, save_path, evidence_packet):
            assert evidence_packet is runtime_packet
            save_path.mkdir(parents=True)
            (save_path / "complete_report.md").write_text(
                "Hold [BAR-1]",
                encoding="utf-8",
            )
            (save_path / "report_manifest.json").write_text(
                '{"analysisStatus":"rated","auditStatus":"verified"}',
                encoding="utf-8",
            )

    monkeypatch.setattr(
        "scripts.run_daily.build_runtime_evidence",
        lambda _ticker, _trade_date: runtime_packet,
    )
    monkeypatch.setattr("scripts.run_daily.publish_evidence_bundle", publish)
    monkeypatch.setattr(
        "tradingagents.graph.trading_graph.TradingAgentsGraph",
        FakeGraph,
    )

    result = run_ticker(
        "GOOGL",
        "2026-07-24",
        ["market"],
        tmp_path / "reports",
    )

    assert result["analysis_status"] == "rated"
    assert calls == [
        ("publish", None, None),
        ("model", None, None),
        (
            "publish",
            {"analysisStatus": "rated", "auditStatus": "verified"},
            "reports/GOOGL/2026-07-24/complete_report.md",
        ),
    ]
