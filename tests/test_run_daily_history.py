import json

from scripts.run_daily import (
    _load_workbench_daily,
    _load_workbench_news,
    _workflow_metadata,
    backfill_history_report_files,
    build_push_message,
    main,
    report_save_directory,
    update_history,
)


def test_pushplus_message_is_explicitly_a_daily_report_not_an_intraday_alert():
    title, content = build_push_message(
        "2026-07-24",
        [{"ticker": "SPY", "rating": "Hold", "error": None}],
        "ark",
    )

    assert "日报" in title
    assert "日报 PushPlus" in content
    assert "盘中事件" not in content


def test_report_save_directory_never_overwrites_an_archived_report(tmp_path):
    reports = tmp_path / "reports"
    original = reports / "GOOGL" / "2026-07-24"
    original.mkdir(parents=True)
    (original / "complete_report.md").write_text("legacy")
    (reports / "GOOGL" / "2026-07-24-v2").mkdir()

    selected = report_save_directory(reports, "GOOGL", "2026-07-24")

    assert selected == reports / "GOOGL" / "2026-07-24-v3"
    assert (original / "complete_report.md").read_text() == "legacy"


def test_history_keeps_a_superseding_report_with_a_distinct_path(tmp_path):
    data = tmp_path / "data"
    data.mkdir()
    (data / "history.json").write_text(json.dumps([{
        "trade_date": "2026-07-24",
        "generated_at": "2026-07-24T08:00:00Z",
        "provider": "ark",
        "results": [{
            "ticker": "GOOGL",
            "rating": "Hold",
            "report": "reports/GOOGL/2026-07-24/complete_report.md",
            "error": False,
        }],
    }]))
    payload = {
        "trade_date": "2026-07-24",
        "generated_at": "2026-07-25T08:00:00Z",
        "provider": "ark",
        "results": [{
            "ticker": "GOOGL",
            "rating": "Not Rated",
            "report": "reports/GOOGL/2026-07-24-v2/complete_report.md",
            "analysis_status": "insufficient_evidence",
            "audit_status": "legacy_unverified",
            "error": None,
        }],
    }

    assert update_history(data, payload) == 2
    history = json.loads((data / "history.json").read_text())
    assert [row["results"][0]["report"] for row in history] == [
        "reports/GOOGL/2026-07-24-v2/complete_report.md",
        "reports/GOOGL/2026-07-24/complete_report.md",
    ]
    assert history[0]["results"][0]["analysis_status"] == "insufficient_evidence"


def test_history_keeps_same_ticker_failures_from_two_profile_runs(tmp_path):
    data = tmp_path / "data"
    data.mkdir()

    def failed_payload(profile_id, run_id):
        return {
            "trade_date": "2026-07-25",
            "generated_at": f"2026-07-25T{run_id}:00:00Z",
            "provider": "ark",
            "identity": {
                "scope": "profile",
                "kind": "manual",
                "profileId": profile_id,
                "requestId": None,
                "slotId": None,
                "scheduledFor": None,
            },
            "run": {"id": run_id},
            "results": [{
                "ticker": "SPY",
                "rating": None,
                "report": None,
                "error": "provider failed",
            }],
        }

    assert update_history(data, failed_payload("profile-a", "10")) == 1
    assert update_history(data, failed_payload("profile-b", "11")) == 2

    history = json.loads((data / "history.json").read_text())
    assert [entry["identity"]["profileId"] for entry in history] == [
        "profile-b",
        "profile-a",
    ]


def test_workflow_metadata_builds_strict_profile_manual_monitor_and_adhoc_identity(
    monkeypatch,
):
    monkeypatch.delenv("GITHUB_RUN_ID", raising=False)
    fields = (
        "TRADINGAGENTS_REQUEST_ID",
        "TRADINGAGENTS_REQUEST_KIND",
        "TRADINGAGENTS_PROFILE_ID",
        "TRADINGAGENTS_SLOT_ID",
        "TRADINGAGENTS_SCHEDULED_FOR",
    )
    for field in fields:
        monkeypatch.delenv(field, raising=False)

    monkeypatch.setenv("TRADINGAGENTS_PROFILE_ID", "profile-a")
    request, _, identity = _workflow_metadata(["market"])
    assert identity == {
        "scope": "profile",
        "kind": "manual",
        "runId": None,
        "profileId": "profile-a",
        "requestId": None,
        "slotId": None,
        "scheduledFor": None,
    }
    assert request["kind"] == "manual"

    monkeypatch.setenv("TRADINGAGENTS_SLOT_ID", "slot-a")
    monkeypatch.setenv("TRADINGAGENTS_SCHEDULED_FOR", "2026-07-25T09:30:00.000Z")
    request, _, identity = _workflow_metadata(["market"])
    assert identity["kind"] == "monitor"
    assert identity["slotId"] == "slot-a"
    assert request["kind"] == "monitor"

    for field in fields:
        monkeypatch.delenv(field, raising=False)
    monkeypatch.setenv(
        "TRADINGAGENTS_REQUEST_ID",
        "123e4567-e89b-42d3-a456-426614174000",
    )
    request, _, identity = _workflow_metadata(["news"])
    assert identity["scope"] == "adhoc"
    assert identity["profileId"] is None
    assert identity["requestId"] == "123e4567-e89b-42d3-a456-426614174000"
    assert request["kind"] == "adhoc"


def test_workflow_metadata_rejects_ambiguous_or_incomplete_identity(monkeypatch):
    fields = (
        "TRADINGAGENTS_REQUEST_ID",
        "TRADINGAGENTS_REQUEST_KIND",
        "TRADINGAGENTS_PROFILE_ID",
        "TRADINGAGENTS_SLOT_ID",
        "TRADINGAGENTS_SCHEDULED_FOR",
    )
    for field in fields:
        monkeypatch.delenv(field, raising=False)

    monkeypatch.setenv("TRADINGAGENTS_PROFILE_ID", "profile-a")
    monkeypatch.setenv(
        "TRADINGAGENTS_REQUEST_ID",
        "123e4567-e89b-42d3-a456-426614174000",
    )
    try:
        _workflow_metadata(["market"])
    except ValueError as error:
        assert "profileId" in str(error)
        assert "requestId" in str(error)
    else:
        raise AssertionError("ambiguous identity must be rejected")

    monkeypatch.delenv("TRADINGAGENTS_REQUEST_ID")
    monkeypatch.setenv("TRADINGAGENTS_SLOT_ID", "slot-a")
    try:
        _workflow_metadata(["market"])
    except ValueError as error:
        assert "profileId/slotId/scheduledFor" in str(error)
    else:
        raise AssertionError("incomplete monitor identity must be rejected")


def test_profile_runner_scopes_market_and_news_queries_but_adhoc_does_not(
    monkeypatch,
):
    observed = []

    class Response:
        status_code = 200

        def __init__(self, payload):
            self._payload = payload

        def json(self):
            return self._payload

    def get(url, *, params, timeout):
        observed.append((url, params.copy(), timeout))
        if url.endswith("/api/market"):
            return Response({
                "status": "ok",
                "data": [{
                    "ts": "2026-07-24T20:00:00Z",
                    "open": 1,
                    "high": 1,
                    "low": 1,
                    "close": 1,
                    "volume": 1,
                    "source": "fixture",
                }],
                "sources": [],
            })
        return Response({"status": "ok", "data": [], "sources": []})

    monkeypatch.setenv("PAGES_URL", "https://workbench.example")
    monkeypatch.setattr("requests.get", get)
    monkeypatch.setenv("TRADINGAGENTS_PROFILE_ID", "profile-a")
    _load_workbench_daily("SPY", "2026-07-24")
    _load_workbench_news("SPY", "2026-07-24")
    assert [params["profile"] for _, params, _ in observed] == [
        "profile-a",
        "profile-a",
    ]

    observed.clear()
    monkeypatch.delenv("TRADINGAGENTS_PROFILE_ID")
    monkeypatch.setenv(
        "TRADINGAGENTS_REQUEST_ID",
        "123e4567-e89b-42d3-a456-426614174000",
    )
    _load_workbench_daily("SPY", "2026-07-24")
    _load_workbench_news("SPY", "2026-07-24")
    assert all("profile" not in params for _, params, _ in observed)


def test_history_preserves_report_tabs_and_request_run_metadata(tmp_path):
    data = tmp_path / "data"
    data.mkdir()
    payload = {
        "trade_date": "2026-07-24",
        "generated_at": "2026-07-25T08:00:00Z",
        "provider": "ark",
        "request": {
            "kind": "adhoc",
            "issue_number": 321,
            "tickers": ["ADHOC"],
        },
        "run": {
            "id": "987654321",
            "workflow": "analysis-request",
            "url": "https://github.example/actions/runs/987654321",
        },
        "results": [{
            "ticker": "ADHOC",
            "rating": "Hold",
            "report": "reports/ADHOC/2026-07-24/complete_report.md",
            "files": {
                "market": "reports/ADHOC/2026-07-24/1_analysts/market.md",
                "complete_report": "reports/ADHOC/2026-07-24/complete_report.md",
            },
            "analysis_status": "rated",
            "audit_status": "verified",
            "error": None,
        }],
    }

    assert update_history(data, payload) == 1

    [entry] = json.loads((data / "history.json").read_text())
    assert entry["request"] == payload["request"]
    assert entry["run"] == payload["run"]
    assert entry["results"][0]["files"] == payload["results"][0]["files"]


def test_history_preserves_market_history_metadata_for_successful_report(tmp_path):
    data = tmp_path / "data"
    data.mkdir()
    market_history = {
        "source": "yahoo-finance",
        "adjustment": "split-and-dividend-adjusted",
        "barCount": 1260,
        "startAt": "2021-07-26T04:00:00Z",
        "endAt": "2026-07-24T04:00:00Z",
    }
    payload = {
        "trade_date": "2026-07-24",
        "generated_at": "2026-07-25T08:00:00Z",
        "provider": "ark",
        "results": [{
            "ticker": "MSFT",
            "rating": "Hold",
            "report": "reports/MSFT/2026-07-24/complete_report.md",
            "files": {},
            "marketHistory": market_history,
            "analysis_status": "rated",
            "audit_status": "verified",
            "error": None,
        }],
    }

    assert update_history(data, payload) == 1

    [entry] = json.loads((data / "history.json").read_text())
    assert entry["results"][0]["marketHistory"] == market_history


def test_history_backfill_scans_real_report_files_without_changing_report_text(
    tmp_path,
):
    public = tmp_path / "public"
    data = public / "data"
    report_dir = public / "reports" / "NVDA" / "2026-07-24"
    analyst_dir = report_dir / "1_analysts"
    portfolio_dir = report_dir / "5_portfolio"
    analyst_dir.mkdir(parents=True)
    portfolio_dir.mkdir(parents=True)
    complete = report_dir / "complete_report.md"
    complete.write_text("完整报告原文", encoding="utf-8")
    (analyst_dir / "market.md").write_text("市场分卷", encoding="utf-8")
    (portfolio_dir / "decision.md").write_text("组合决策", encoding="utf-8")
    data.mkdir()
    (data / "history.json").write_text(json.dumps([{
        "trade_date": "2026-07-24",
        "results": [{
            "ticker": "NVDA",
            "report": "reports/NVDA/2026-07-24/complete_report.md",
        }],
    }]), encoding="utf-8")

    assert backfill_history_report_files(data) == 1

    [entry] = json.loads((data / "history.json").read_text(encoding="utf-8"))
    assert entry["results"][0]["files"] == {
        "market": "reports/NVDA/2026-07-24/1_analysts/market.md",
        "decision": "reports/NVDA/2026-07-24/5_portfolio/decision.md",
        "complete_report": "reports/NVDA/2026-07-24/complete_report.md",
    }
    assert complete.read_text(encoding="utf-8") == "完整报告原文"


def test_main_persists_allowlisted_workflow_request_and_run_metadata(
    monkeypatch,
    tmp_path,
):
    monkeypatch.setenv(
        "TRADINGAGENTS_REQUEST_ID",
        "123e4567-e89b-42d3-a456-426614174000",
    )
    monkeypatch.setenv("TRADINGAGENTS_REQUEST_KIND", "adhoc")
    monkeypatch.setenv("TRADINGAGENTS_RESEARCH_DEPTH", "deep")
    monkeypatch.setenv("GITHUB_RUN_ID", "987654321")
    monkeypatch.setenv("GITHUB_RUN_ATTEMPT", "2")
    monkeypatch.setenv("GITHUB_WORKFLOW", "daily-analysis")
    monkeypatch.setenv("GITHUB_SERVER_URL", "https://github.example")
    monkeypatch.setenv("GITHUB_REPOSITORY", "owner/repository")
    monkeypatch.setattr(
        "scripts.run_daily.write_news_export",
        lambda *_args, **_kwargs: {"status": "ok", "items": []},
    )
    monkeypatch.setattr(
        "scripts.run_daily.resolve_llm_key_status",
        lambda: (True, "ark"),
    )
    monkeypatch.setattr(
        "scripts.run_daily.run_ticker",
        lambda ticker, *_args: {
            "ticker": ticker,
            "rating": "Hold",
            "report": "reports/NVDA/2026-07-24/complete_report.md",
            "files": {
                "complete_report": "reports/NVDA/2026-07-24/complete_report.md",
            },
            "decision_excerpt": "",
            "analysis_status": "rated",
            "audit_status": "verified",
            "evidence_publish": {"published": True},
            "error": None,
        },
    )
    output = tmp_path / "public"

    assert main([
        "--tickers", "NVDA",
        "--date", "2026-07-24",
        "--analysts", "market,news",
        "--output", str(output),
        "--no-push",
    ]) == 0

    latest = json.loads((output / "data" / "latest.json").read_text())
    [archived] = json.loads((output / "data" / "history.json").read_text())
    expected_request = {
        "requestId": "123e4567-e89b-42d3-a456-426614174000",
        "analysts": ["market", "news"],
        "researchDepth": "deep",
        "kind": "adhoc",
    }
    expected_run = {
        "id": "987654321",
        "attempt": "2",
        "workflow": "daily-analysis",
        "url": "https://github.example/owner/repository/actions/runs/987654321",
    }
    expected_identity = {
        "scope": "adhoc",
        "kind": "adhoc",
        "runId": "987654321",
        "profileId": None,
        "requestId": "123e4567-e89b-42d3-a456-426614174000",
        "slotId": None,
        "scheduledFor": None,
    }
    assert latest["request"] == expected_request
    assert latest["run"] == expected_run
    assert latest["identity"] == expected_identity
    assert archived["request"] == expected_request
    assert archived["run"] == expected_run
    assert archived["identity"] == expected_identity
