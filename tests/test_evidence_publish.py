from __future__ import annotations

import requests

from scripts.run_daily import publish_evidence_bundle


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
