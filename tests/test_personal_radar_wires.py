import hashlib
import unittest
from datetime import datetime, timedelta, timezone
from http.client import IncompleteRead

from scripts import personal_radar_sources as source

NOW = datetime(2026, 11, 27, 4, 30, tzinfo=timezone.utc)
ANT = "Anthropic宣布推出新模型"
SEAT = "甲赢得总统大选"


def wall_row(uid, title, minutes=1, body=""):
    return {"id": uid, "title": title, "content_text": body, "display_time": (NOW - timedelta(minutes=minutes)).timestamp()}


def sina_row(uid, title, minutes=1, body=""):
    return {"id": uid, "rich_text": f"【{title}】{body}",
            "create_time": (NOW - timedelta(minutes=minutes)).astimezone(source.BEIJING).strftime("%Y-%m-%d %H:%M:%S")}


def collect(wall, sina, sec=None, **options):
    def fetch(url):
        if url.startswith(source.WALL):
            if isinstance(wall, Exception):
                raise wall
            return {"code": 20000, "data": {"items": wall}}
        if url == source.SINA:
            return {"result": {"status": {"code": 0}, "data": {"feed": {"list": sina}}}}
        if url == source.SEC and sec is not None:
            return sec
        raise AssertionError(url)
    return source.collect_candidates(NOW, dual_wire=True, lookback_minutes=15, include_sec=sec is not None,
                                     fetch=fetch, **options)


class IndependentWires(unittest.TestCase):
    def test_healthy_primary_without_match_still_collects_sina_and_keeps_legacy_key(self):
        items, issues = collect([wall_row(1, "一般市场信息")], [sina_row(2, ANT)])
        self.assertEqual(issues, [])
        digest = hashlib.sha256(ANT.lower().encode()).hexdigest()[:20]
        self.assertEqual([x["key"] for x in items], [f"news:2026-11-27:{digest}"])
        self.assertEqual(items[0]["provider"], "新浪财经快讯")
        self.assertEqual(items[0]["symbol"], "ANT")
        self.assertEqual(items[0]["at"], (NOW - timedelta(minutes=1)).isoformat())

    def test_empty_stale_and_partial_http_read_do_not_hide_backup(self):
        for wall, expected in [([], "wall:empty"), ([wall_row(1, ANT, 16)], "wall:stale"),
                               ([wall_row(1, ANT, -1)], "wall:future"), (IncompleteRead(b""), "wall")]:
            with self.subTest(issue=expected):
                items, issues = collect(wall, [sina_row(9, ANT)])
                self.assertEqual(issues, [expected])
                self.assertEqual([x["provider"] for x in items], ["新浪财经快讯"])

    def test_malformed_date_only_and_deleted_records_do_not_poison_other_rows(self):
        sina = [None, {**sina_row(7, "英国央行宣布降息"), "create_time": "2026-11-27"},
                {**sina_row(8, "加拿大央行宣布加息"), "is_delete": 1},
                {**sina_row(9, ANT), "create_time": "2026-11-27T04:27:00+00:00"}]
        items, issues = collect([{"id": "bad"}, wall_row(4, "普通消息")], sina)
        self.assertEqual(issues, ["wall:partial", "sina:partial"])
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["at"], "2026-11-27T04:27:00+00:00")

    def test_same_head_confirmed_later_keeps_actual_source_time_not_projection(self):
        items, issues = collect([wall_row(1, SEAT, 8, "美联社测算甲赢得总统大选")],
                               [sina_row(2, SEAT, 2, "选举委员会公布甲赢得总统大选")])
        self.assertFalse(issues)
        self.assertEqual(len(items), 1)
        self.assertEqual((items[0]["category"], items[0]["evidence_rank"]), ("选举·官方结果", 3))
        self.assertEqual(items[0]["at"], (NOW - timedelta(minutes=2)).isoformat())
        self.assertIn("sina.com.cn", items[0]["url"])
        weak_only, _ = collect([wall_row(1, SEAT, 8, "美联社测算甲赢得总统大选")], [sina_row(3, "一般快讯")])
        self.assertEqual((weak_only[0]["key"], weak_only[0]["evidence_rank"]), (items[0]["key"], 2))

    def test_reprints_collapse_but_different_chamber_or_direction_does_not(self):
        first = "美联社测算甲党拿下参议院"
        items, issues = collect([wall_row(1, first, 8), wall_row(2, "美联社测算乙党拿下众议院", 5)],
                               [sina_row(3, first, 1)])
        self.assertEqual(issues, [])
        self.assertEqual(len(items), 2)
        item = next(x for x in items if x["title"] == first)
        self.assertEqual(item["at"], (NOW - timedelta(minutes=8)).isoformat())

    def test_council_roundups_vs_new_measures_different_scope_and_document(self):
        general = "国常会研究资本市场改革"
        cut = "国常会决定下调证券交易印花税至0.05%"
        reprint = "国务院常务会议宣布降低证券交易印花税至0.05％"
        items, issues = collect([wall_row(1, general, 10), wall_row(2, cut, 7),
                                 wall_row(6, "国常会审议通过《资本市场改革实施办法》", 2)],
                                [sina_row(3, reprint, 6), sina_row(4, "国常会决定上调证券交易印花税至0.15%", 5),
                                 sina_row(5, "国常会决定下调进口汽车关税至5%", 3)])
        self.assertFalse(issues)
        self.assertEqual(len(items), 5)
        keys = {x["title"]: x["key"] for x in items}
        self.assertEqual(keys[general], "news:cn-council:2026-11-27")
        self.assertIn(cut, keys)
        self.assertTrue(all(k.startswith(keys[general]) for k in keys.values()))

    def test_explicit_company_counterparty_and_confirmed_politics_have_guardrails(self):
        for title, body, category in [
            ("亚马逊宣布向Anthropic投资40亿美元", "", "Anthropic 公司动态"),
            ("Anthropic（ANT.US）公布季度业绩", "", "Anthropic 公司动态"),
            ("美联储降息25个基点，符合市场预期", "此前市场预计降息幅度较小。", "央行决议"),
            ("法国总统府证实总统遇刺身亡", "", "全球重大政治"),
            ("英国首相宣布辞职", "", "全球重大政治"),
            ("总统顾问宣布辞职", "", None),
            ("英国首相考虑宣布辞职", "", None),
            ("知情人士称亚马逊宣布向Anthropic投资40亿美元", "", None),
            ("亚马逊宣布使用Anthropic模型", "", None),
            (SEAT, "选举委员会公布初步计票结果，计票未结束。", None),
        ]:
            with self.subTest(title=title):
                match = source._classify(title, body)
                self.assertEqual(match[0] if match else None, category)

    def test_sec_recovery_window_does_not_revive_stale_wires(self):
        sec = {"name": "Anthropic, PBC", "cik": 2130357, "filings": {"recent": {
            "form": ["8-K/A"], "accessionNumber": ["0001628280-26-075973"],
            "acceptanceDateTime": ["2026-11-27T03:55:00Z"]}}}
        items, issues = collect([wall_row(1, ANT, 30)], [sina_row(2, ANT, 25)], sec, sec_lookback_minutes=60)
        self.assertEqual(issues, ["wall:stale", "sina:stale"])
        self.assertEqual([x["key"] for x in items], ["news:sec:0001628280-26-075973"])
        self.assertIn("修订件", items[0]["title"])
        self.assertEqual(items[0]["at"], "2026-11-27T03:55:00+00:00")
        self.assertEqual(collect([wall_row(1, ANT, 30)], [sina_row(2, ANT, 25)], sec)[0], [])


if __name__ == "__main__":
    unittest.main()
