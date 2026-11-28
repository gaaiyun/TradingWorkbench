import sqlite3
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from scripts import personal_radar_sources as sources

with patch.object(sys, "path", [str(Path(__file__).resolve().parents[1] / "scripts"), *sys.path]):
    from scripts import personal_radar as radar


class RadarBoundaries(unittest.TestCase):
    def test_market_hours_apply_to_quote_and_current_exchange_clock(self):
        utc8 = timezone(timedelta(hours=8))
        windows = [(570, 690), (780, 900)]
        with sqlite3.connect(":memory:") as db:
            for day, quote_clock, now_clock, eligible in [
                (27, (11, 29), (11, 30), True),    # Friday, in session
                (27, (11, 29), (11, 40), False),   # stale in-session quote during lunch
                (27, (12, 58), (13, 1), False),    # off-session source time
                (27, (13, 1), (13, 2), True),
                (28, (13, 1), (13, 2), False),     # Saturday, both clocks look intraday
            ]:
                with self.subTest(day=day, quote_clock=quote_clock, now_clock=now_clock):
                    at = datetime(2026, 11, day, *quote_clock, tzinfo=utc8)
                    now = datetime(2026, 11, day, *now_clock, tzinfo=utc8).astimezone(timezone.utc)
                    items = radar.market_events(db, {"sh000300": (104, 100, at, windows)}, now)
                    self.assertEqual(bool(items), eligible)

    def test_repeated_price_tick_does_not_create_another_pending_push(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(radar, "STATE", Path(directory)):
            with radar.open_db() as db:
                at = datetime(2026, 11, 27, 10, 0, tzinfo=timezone(timedelta(hours=8)))
                quotes = {"sh000300": (103, 100, at, [(570, 690), (780, 900)])}
                for offset in (0, 1):
                    now = at + timedelta(minutes=offset)
                    events = radar.market_events(db, quotes, now)
                    radar.queue(db, events + events, now)
                self.assertEqual(db.execute("SELECT count(*) FROM outbox WHERE receipt IS NULL").fetchone(), (1,))
                self.assertEqual(db.execute("SELECT count(*) FROM seen").fetchone(), (1,))
                self.assertEqual(db.execute("SELECT count(*) FROM samples").fetchone(), (1,))
            db.close()

    def test_congress_control_calls_preserve_evidence_level(self):
        for title, expected in [
            ("美联社宣布共和党拿下参议院", "选举·媒体测算"),
            ("民主党宣布夺回众议院控制权", "选举·当事人声明"),
            ("官方计票结果：甲党获得议会多数席位", "选举·官方结果"),
            ("民调：甲党可能夺回众议院控制权", None),
        ]:
            with self.subTest(title=title):
                result = sources._classify(title, "")
                self.assertEqual(result[0] if result else None, expected)
