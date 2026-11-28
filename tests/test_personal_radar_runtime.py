import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

with patch.object(sys, "path", [str(Path(__file__).resolve().parents[1] / "scripts"), *sys.path]):
    from scripts import personal_radar as radar, personal_radar_world as world

SAT = datetime(2026, 11, 28, 4, 30, tzinfo=timezone.utc)


def test_schedule_does_not_fetch_closed_or_undue_sources(tmp_path):
    with (patch.object(radar, "STATE", tmp_path), patch.object(radar, "fetch_quotes") as quote,
          patch.object(radar, "collect_candidates", return_value=([], [])) as wire,
          patch.object(radar, "collect_official_candidates", return_value=([], [])) as official,
          patch.object(radar, "world_candidates", return_value=[]) as international):
        db = radar.open_db()
        assert radar.tick(db, SAT)["quoteSession"] == "closed"
        second = radar.tick(db, SAT + timedelta(minutes=1))
        assert second["polled"] == ["wall", "sina"] and second["errors"] == []
        quote.assert_not_called()
        assert official.call_count == 2 and international.call_count == 1
        assert wire.call_args.kwargs["dual_wire"] and not wire.call_args.kwargs["include_sec"]
        db.close()


def test_source_upgrade_once_and_uncertain_channel_not_resubmitted(tmp_path):
    with patch.object(radar, "STATE", tmp_path):
        db = radar.open_db()
        item = {"key": "news:test", "at": SAT.isoformat(), "title": "甲党取得多数",
                "category": "选举", "url": "https://example.org/news"}
        for rank in [2, 2, 3, 2, 3]:
            radar.queue(db, [dict(item, evidence_rank=rank)], SAT)
        assert db.execute("SELECT count(*) FROM outbox").fetchone() == (2,)
        with patch.object(radar, "send", side_effect=radar.UnconfirmedDelivery()) as send:
            radar.deliver(db, SAT)
            radar.deliver(db, SAT + timedelta(minutes=2))
            assert send.call_count == 2
        assert db.execute("SELECT count(*) FROM outbox WHERE receipt IS NOT NULL").fetchone() == (0,)
        db.close()


def test_actual_lunch_observation_does_not_become_five_minute_return(tmp_path):
    zone = timezone(timedelta(hours=8))
    with patch.object(radar, "STATE", tmp_path):
        db = radar.open_db()
        times = [datetime(2026, 11, 27, h, m, tzinfo=zone) for h, m in [(11, 30), (13, 5)]]
        sessions = [(570, 690), (780, 900)]
        for at, price in zip(times, [0.737, 0.766], strict=True):
            events = radar.market_events(db, {"sh512480": (price, 0.696, at, sessions)}, at)
        assert any("午后较午休前报价 +3.93%" in x["title"] for x in events)
        assert not any("/fast/" in x["key"] for x in events)
        db.close()


def test_english_rss_requires_action_time_and_real_link():
    def feed(_):
        return b"""<rss><channel><item><title>Democrats win control of the House</title>
        <link>https://www.cnbc.com/2026/11/28/results.html</link>
        <pubDate>Sat, 28 Nov 2026 04:24:00 GMT</pubDate></item></channel></rss>"""
    assert world.candidates(SAT, fetch=feed)[0]["category"] == "选举·媒体报道"
    assert world.candidates(SAT + timedelta(hours=1), fetch=feed) == []
    assert world.classify("Could Democrats win control of the House?") is None
    assert world.classify("Anthropic announces export deal") is not None


def test_news_does_not_pass_off_an_earlier_quote_as_a_market_reaction():
    item = {"category": "Anthropic 公司动态", "at": SAT.isoformat()}
    quotes = {"usANT": (102.0, 100.0, SAT - timedelta(minutes=1), [])}
    assert "消息前报价" in radar.price_context(item, quotes, SAT, ["usANT"])
    assert "暂无同期报价" in radar.price_context(item, quotes, SAT, [])
    assert "没有取得" in radar.price_context(item, quotes, SAT + timedelta(minutes=22), ["usANT"])
