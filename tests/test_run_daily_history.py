import json

from scripts.run_daily import report_save_directory, update_history


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
