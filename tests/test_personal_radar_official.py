import json
import unittest
from datetime import datetime, timezone

from scripts import personal_radar_official as source


def utc(stamp):
    return datetime.fromisoformat(stamp).replace(tzinfo=timezone.utc)


GOV_URL = "https://www.gov.cn/yaowen/liebiao/202611/content_7087445.htm"
GOV_TITLE = "李强主持召开国务院常务会议 听取推动高质量发展综合督查情况汇报等"
FED_URL = "https://www.federalreserve.gov/newsevents/pressreleases/monetary20261028a.htm"


def listing(uid="7087445", title=GOV_TITLE, day="2026-11-27", url=None):
    return {"TITLE": title, "URL": url or GOV_URL.replace("7087445", uid), "DOCRELPUBTIME": day}


def government_article(stamp="2026-11-27-12:25:00", uid="7087445"):
    return f"""<head><meta name="others" content="页面生成时间 2026-11-27 12:30:00">
        <meta content="{stamp}" name="firstpublishedtime"><meta name="lastmodifiedtime" content="2026-11-27-12:40:00">
        <meta name="manuscriptId" content="{uid}"><meta name="description" content="研究持续深化资本市场投融资综合改革工作。"></head>
        <div class="pages-date">2026-11-27 12:25 <span class="font">来源： 新华社 </span></div>"""


def fed_item(head="Federal Reserve issues FOMC statement", stamp="Wed, 28 Oct 2026 18:00:00 GMT", url=FED_URL):
    return f"<item><title>{head}</title><link>{url}</link><guid>{url}</guid><pubDate>{stamp}</pubDate></item>"


def rss(*items):
    return ("<rss><channel><title>FRB: Press Release - Monetary Policy</title>" +
            "".join(items) + "</channel></rss>").encode("utf-8-sig")


class OfficialNews(unittest.TestCase):
    def test_real_council_first_publication_original_credit_and_persistable_cache(self):
        urls, cache = [], {}
        def fetch(url):
            urls.append(url)
            if url == source.GOV:
                return json.dumps([listing(url="https://tv.cctv.com/video"), listing()])
            return government_article()

        def run(stamp):
            return source.collect_official_candidates(utc(stamp), providers=["govcn"], fetch=fetch, gov_cache=cache)
        self.assertEqual(run("2026-11-27T04:24"), ([], []))
        cache = json.loads(json.dumps(cache))
        (item,), errors = run("2026-11-27T04:30")
        self.assertEqual(errors, [])
        self.assertEqual(item["at"], "2026-11-27T04:25:00+00:00")
        self.assertEqual(item["key"], "news:cn-council:2026-11-27")
        self.assertEqual(item["evidence_rank"], 3)
        self.assertIn("稿源：新华社", item["detail"])
        self.assertIn("资本市场", item["detail"])
        self.assertEqual(run("2026-11-27T05:00"), ([], []))
        self.assertEqual(urls, [source.GOV, GOV_URL, source.GOV, source.GOV])

    def test_gov_no_modified_date_fallback_and_retry_missing_metadata(self):
        for article in [government_article("2026-11-27"), government_article(uid="33333")]:
            cache = {}
            data = {source.GOV: json.dumps([listing()]), GOV_URL: article}
            self.assertEqual(source.collect_official_candidates(utc("2026-11-27T04:30"), providers=["govcn"],
                             gov_cache=cache, fetch=data.__getitem__), ([], ["govcn"]))
            self.assertEqual(cache, {})

    def test_gov_filters_old_external_forecasts_and_caps_detail_requests(self):
        rows = [listing(day="2026-11-26"), listing(url=GOV_URL + "?other"),
                listing(title="国务院常务会议政策解读"), listing(title="政策评论"),
                *(listing(uid=str(i)) for i in range(4))]
        calls = []
        def fetch(url):
            calls.append(url)
            if url == source.GOV:
                return json.dumps(rows)
            raise TimeoutError()
        self.assertEqual(source.collect_official_candidates(utc("2026-11-27T04:30"), providers=["govcn"],
                         fetch=fetch), ([], ["govcn"]))
        self.assertEqual(calls, [source.GOV, rows[4]["URL"], rows[5]["URL"]])

    def test_fed_historical_rate_and_strict_release_time(self):
        body = """<p>Voting against were members who preferred to raise rates.</p>
              <p>The Committee decided to maintain the target range for the federal funds rate
              at 3-3/4 to 4 percent, in support of its mandate.</p>"""
        data = {source.FED: rss(fed_item(), fed_item(stamp="Wed, 28 Oct 2026 18:30:00 GMT"),
                                fed_item(stamp="2026-10-28")), FED_URL: body}
        (item,), errors = source.collect_official_candidates(utc("2026-10-28T18:05"),
                            providers=["fed"], fetch=data.__getitem__)
        self.assertFalse(errors)
        self.assertEqual(item["key"], "news:fed:monetary20261028a")
        self.assertEqual(item["at"], "2026-10-28T18:00:00+00:00")
        self.assertIn("维持在 3.75%–4%", item["title"])
        self.assertEqual(source.collect_official_candidates(utc("2026-10-28T19:05"),
                         providers=["fed"], fetch=data.__getitem__), ([], []))

    def test_fed_minutes_not_new_decision_or_discount_meeting(self):
        fed = rss(fed_item("Minutes of the Federal Open Market Committee, October 27-28, 2026"),
                  fed_item("Minutes of the Board's discount rate meetings on October 19"),
                  fed_item(url="https://example.com/story"))
        (item,), errors = source.collect_official_candidates(utc("2026-10-28T18:03"), providers=["fed"],
                             fetch={source.FED: fed}.__getitem__)
        self.assertFalse(errors)
        self.assertIn("纪要", item["title"])
        self.assertNotEqual(item["category"], "央行决定")
        self.assertIn("不是新的利率决定", item["detail"])

    def test_partial_failure_preserves_rss_statement_without_guessing(self):
        def get(url):
            if url == source.FED:
                return rss(fed_item())
            raise OSError("denied")
        (item,), errors = source.collect_official_candidates(utc("2026-10-28T18:03"), fetch=get)
        self.assertEqual(errors, ["govcn"])
        self.assertEqual(item["title"], "美联储发布议息声明")
        def denied(_url):
            raise OSError("denied")
        self.assertEqual(source.collect_official_candidates(utc("2026-10-28T18:03"), fetch=denied),
                         ([], ["govcn", "fed"]))
        self.assertEqual(source.collect_official_candidates(utc("2026-10-28T18:03"), providers=(),
                         fetch=denied), ([], []))
