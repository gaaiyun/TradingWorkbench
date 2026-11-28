import unittest
from datetime import datetime, timedelta, timezone

from scripts import personal_radar_sources as source

NOW = datetime(2026, 11, 27, 4, 30, tzinfo=timezone.utc)
FIRST = datetime(2026, 11, 27, 4, 24, 19, tzinfo=timezone.utc)
EMPTY_SEC = {"name": "Anthropic, PBC", "cik": "2130357",
             "filings": {"recent": {"form": [], "acceptanceDateTime": [], "accessionNumber": []}}}


def news(uid, head, body, at):
    return {"id": uid, "title": head, "content_text": body, "display_time": at.timestamp()}


class NewsInputs(unittest.TestCase):
    def test_live_request_does_not_page_past_newest_release(self):
        now = datetime.now(timezone.utc)
        urls = []

        def fetch(url):
            urls.append(url)
            return {"code": 20000, "data": {"items": [news(1, "普通快讯", "", now)]}}

        self.assertEqual(source.collect_candidates(now, fetch=fetch, include_sec=False), ([], []))
        self.assertEqual(urls, [source.WALL])

    def test_nov_27_council_one_event_with_original_time(self):
        # Real publication times and headlines from the 11/27 wire; text abbreviated.
        rows = [
            news(3206758, "李强主持召开国务院常务会议 研究持续深化资本市场投融资综合改革工作 要求加力发挥“国家队”稳市作用",
                 "会议指出，资本市场事关经济发展大局。", FIRST + timedelta(seconds=58)),
            news(3206756, "李强主持召开国务院常务会议 听取推动高质量发展综合督查情况汇报",
                 "会议研究持续深化资本市场投融资综合改革工作。", FIRST),
            news(1, "如何理解国常会对资本市场的最新定调？专家解读来了", "", FIRST),
            news(2, "国常会：继续完善稳市机制", "", NOW + timedelta(seconds=1)),
        ]
        def get(url):
            return EMPTY_SEC if url == source.SEC else {"code": 20000, "data": {"items": rows}}

        results, failures = source.collect_candidates(NOW, lookback_minutes=15, fetch=get)
        self.assertEqual(failures, [])
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["at"], FIRST.isoformat())
        self.assertTrue(results[0]["url"].endswith("/3206756"))
        self.assertIn("国家队", results[0]["detail"])
        self.assertEqual(source.collect_candidates(NOW + timedelta(hours=2), lookback_minutes=15, fetch=get), ([], []))

    def test_elections_commentary_and_rumours(self):
        for headline in ["民调：甲或将赢得总统大选", "媒体预测甲赢得大选", "知情人士称Anthropic宣布收购甲公司",
                         "美联储官员支持降息", "高盛：美联储降息25个基点", "美联储降息后美元反弹",
                         "出口民调：甲赢得议会选举", "双方呼吁达成停火协议"]:
            with self.subTest(headline=headline):
                self.assertIsNone(source._classify(headline, ""))
        cases = [
            ("选举委员会宣布甲赢得总统选举", "选举·官方结果"),
            ("美联社测算甲赢得美国大选", "选举·媒体测算"),
            ("乙宣布在总统选举中承认败选", "选举·当事人声明"),
            ("美联储降息25个基点", "央行决议"),
            ("双方正式签署停火协议", "重大冲突"),
            ("Anthropic宣布推出新模型", "Anthropic 公司动态"),
        ]
        for head, category in cases:
            with self.subTest(head=head):
                self.assertEqual(source._classify(head, "")[0], category)

    def test_sec_time_and_backup_when_primary_unavailable(self):
        def get(url):
            if url == source.SEC:
                return {"cik": 2130357, "name": "Anthropic, PBC", "filings": {"recent": {
                    "form": ["8-K"], "accessionNumber": ["0001628280-26-075973"],
                    "acceptanceDateTime": ["2026-11-25T21:10:29.000Z"],
                }}}
            if url == source.SINA:
                return {"result": {"status": {"code": 0}, "data": {"feed": {"list": [{
                    "id": 101, "rich_text": "【日本央行维持政策利率不变】日本央行宣布决定。",
                    "create_time": "2026-11-26 05:14:00",
                }]}}}}
            raise TimeoutError()

        results, failures = source.collect_candidates(datetime(2026, 11, 25, 21, 15, tzinfo=timezone.utc), fetch=get)
        self.assertEqual(failures, ["wall"])
        self.assertEqual([x["category"] for x in results], ["央行决议", "Anthropic 官方披露"])
        self.assertEqual(results[0]["at"], "2026-11-25T21:14:00+00:00")
        self.assertEqual(results[1]["symbol"], "ANT")
        self.assertIn("000162828026075973", results[1]["url"])

    def test_total_provider_failure_is_not_quiet(self):
        def get(_url):
            raise OSError()

        self.assertEqual(source.collect_candidates(NOW, fetch=get), ([], ["wall", "sina", "sec"]))

    def test_sec_denial_does_not_suppress_company_wire(self):
        called = []
        def get(url):
            called.append(url)
            if url == source.SEC:
                raise PermissionError("403")
            rows = [news(5, "Anthropic向美国证交会提交季度报告", "", FIRST)]
            return {"code": 20000, "data": {"items": rows}}

        items, failures = source.collect_candidates(NOW, fetch=get)
        self.assertEqual(failures, ["sec"])
        self.assertEqual(items[0]["symbol"], "ANT")
        self.assertIn("媒体报道", items[0]["detail"])
        called.clear()
        items, failures = source.collect_candidates(NOW, fetch=get, include_sec=False)
        self.assertNotIn(source.SEC, called)
        self.assertTrue(items)
        self.assertEqual(failures, [])


if __name__ == "__main__":
    unittest.main()
