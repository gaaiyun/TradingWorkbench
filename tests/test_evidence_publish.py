from __future__ import annotations

import json
import math

import requests

from scripts.run_daily import publish_evidence_bundle, run_ticker
from tradingagents.evidence import EvidenceValidationError


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
    monkeypatch.delenv("GITHUB_RUN_ID", raising=False)

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
    assert observed["json"]["identity"] == {
        "scope": "legacy",
        "kind": "legacy",
        "runId": None,
        "profileId": None,
        "requestId": None,
        "slotId": None,
        "scheduledFor": None,
    }
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


def test_publish_evidence_bundle_rejects_non_standard_json_before_network(monkeypatch):
    invalid = packet()
    invalid["bars"] = [{"close": math.nan}]
    called = False

    def post(*_args, **_kwargs):
        nonlocal called
        called = True
        raise AssertionError("invalid payload must not reach the network")

    monkeypatch.setenv("EVIDENCE_API_URL", "https://board.example/api/evidence")
    monkeypatch.setenv("EVIDENCE_WRITE_TOKEN", "write-secret")
    monkeypatch.setattr(requests, "post", post)

    assert publish_evidence_bundle(invalid) == {
        "published": False,
        "reason": "invalid_payload",
    }
    assert called is False


def test_run_ticker_publishes_validated_evidence_before_starting_the_model(
    monkeypatch,
    tmp_path,
):
    monkeypatch.delenv("GITHUB_RUN_ID", raising=False)
    calls = []
    runtime_packet = packet()

    def publish(packet_payload, *, manifest=None, report=None):
        if manifest is not None:
            assert manifest["identity"] == {
                "scope": "legacy",
                "kind": "legacy",
                "runId": None,
                "profileId": None,
                "requestId": None,
                "slotId": None,
                "scheduledFor": None,
            }
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
    saved_manifest = json.loads(
        (
            tmp_path
            / "reports"
            / "GOOGL"
            / "2026-07-24"
            / "report_manifest.json"
        ).read_text(encoding="utf-8")
    )
    assert saved_manifest["identity"]["scope"] == "legacy"
    assert calls == [
        ("publish", None, None),
        ("model", None, None),
        (
            "publish",
            saved_manifest,
            "reports/GOOGL/2026-07-24/complete_report.md",
        ),
    ]


def test_run_ticker_classifies_gateway_rejection_as_invalidated_without_model(
    monkeypatch,
    tmp_path,
):
    monkeypatch.setattr(
        "scripts.run_daily.build_runtime_evidence",
        lambda *_: (_ for _ in ()).throw(
            EvidenceValidationError("bar market values must be finite")
        ),
    )
    monkeypatch.setattr(
        "tradingagents.graph.trading_graph.TradingAgentsGraph",
        lambda **_kwargs: (_ for _ in ()).throw(
            AssertionError("model must not start after evidence rejection")
        ),
    )

    result = run_ticker("MSFT", "2026-07-24", ["market"], tmp_path / "reports")

    assert result["analysis_status"] == "data_validation_failed"
    assert result["audit_status"] == "invalidated"
    assert result["evidence_publish"] == {
        "published": False,
        "reason": "invalid_payload",
    }
    assert result["report"] is None
    assert result["error"] == "evidence validation failed; model run skipped"
