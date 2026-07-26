"""Offline coverage for the canonical multi-source news pipeline."""

import copy
from datetime import datetime, timedelta, timezone
from unittest import mock

import pytest

import tradingagents.dataflows.google_news as google_news
import tradingagents.dataflows.news_aggregator as aggregator
import tradingagents.dataflows.official_news as official
import tradingagents.dataflows.yfinance_news as yfinance_news
import tradingagents.default_config as default_config
from tradingagents.dataflows import config as config_module, interface
from tradingagents.dataflows.config import set_config
from tradingagents.dataflows.news_common import (
    NewsItem,
    canonicalize_url,
    format_news_report,
    normalize_filter_dedupe,
    parse_timestamp,
)

UTC = timezone.utc
NOW = datetime(2026, 7, 22, 10, 0, tzinfo=UTC)


def _item(
    title="Headline",
    *,
    source="Publisher",
    tier="aggregator",
    published_at=None,
    url="https://example.com/story",
    ticker="AAPL",
):
    return NewsItem(
        title=title,
        summary=f"Summary for {title}",
        url=url,
        source=source,
        published_at=published_at or NOW - timedelta(hours=1),
        fetched_at=NOW,
        ticker=ticker,
        source_tier=tier,
    )


@pytest.mark.unit
def test_news_item_contract_is_json_ready_and_utc():
    item = NewsItem(
        title="  Material   update  ",
        summary=" Summary\ntext ",
        url="HTTPS://Example.COM/a?utm_source=x&b=2#frag",
        source="Issuer",
        published_at=datetime(2026, 7, 22, 9, 0),
        fetched_at=NOW,
        ticker="aapl",
        source_tier="PRIMARY",
    )

    assert item.to_dict() == {
        "title": "Material update",
        "summary": "Summary text",
        "url": "https://example.com/a?utm_source=x&b=2",
        "source": "Issuer",
        "published_at": "2026-07-22T09:00:00Z",
        "fetched_at": "2026-07-22T10:00:00Z",
        "ticker": "AAPL",
        "source_tier": "primary",
    }


@pytest.mark.unit
def test_timestamp_parser_handles_vendor_sec_and_rss_formats():
    assert parse_timestamp(1753174800).tzinfo is UTC
    assert parse_timestamp("20260722T091500").isoformat() == "2026-07-22T09:15:00+00:00"
    assert parse_timestamp("2026-07-22T09:15:00Z").isoformat() == "2026-07-22T09:15:00+00:00"
    assert parse_timestamp("Wed, 22 Jul 2026 09:15:00 GMT").isoformat() == (
        "2026-07-22T09:15:00+00:00"
    )


@pytest.mark.unit
def test_filter_rejects_old_and_future_and_prefers_primary_duplicate():
    aggregator_copy = _item("Same headline", url="https://example.com/same", tier="aggregator")
    primary_copy = _item(
        "Same headline",
        url="https://issuer.example/same",
        source="SEC EDGAR",
        tier="primary",
    )
    old = _item("Old", published_at=NOW - timedelta(days=40))
    future = _item("Future", published_at=NOW + timedelta(minutes=6))

    items = normalize_filter_dedupe(
        [aggregator_copy, primary_copy, old, future],
        "2026-07-01",
        "2026-07-22",
        fetched_at=NOW,
        limit=20,
        future_tolerance=timedelta(minutes=5),
    )

    assert [item.title for item in items] == ["Same headline"]
    assert items[0].source == "SEC EDGAR"


@pytest.mark.unit
def test_dedupe_handles_chinese_titles_and_tracking_variants():
    first = _item("公司发布重大事项公告", url="https://example.com/cn?id=1&utm_source=a")
    duplicate = _item("公司发布重大事项公告", url="https://example.com/cn?utm_source=b&id=1")

    items = normalize_filter_dedupe(
        [first, duplicate],
        "2026-07-01",
        "2026-07-22",
        fetched_at=NOW,
        limit=20,
    )

    assert len(items) == 1


@pytest.mark.unit
def test_ticker_aggregation_degrades_when_one_source_fails(monkeypatch):
    def fail_yahoo(*args, **kwargs):
        raise TimeoutError("secret-bearing request must not appear in output")

    monkeypatch.setattr(aggregator, "fetch_ticker_news_yfinance", fail_yahoo)
    monkeypatch.setattr(
        aggregator,
        "fetch_sec_filings",
        lambda *args, **kwargs: [_item("Issuer filing", source="SEC EDGAR", tier="primary")],
    )
    result = aggregator.aggregate_ticker_news(
        "AAPL",
        "2026-07-01",
        "2026-07-22",
        now=NOW,
        config={"news_ticker_sources": "yfinance,sec", "news_article_limit": 10},
    )

    assert result.status == "partial"
    assert [item.title for item in result.items] == ["Issuer filing"]
    assert [status.status for status in result.source_statuses] == ["failed", "ok"]
    rendered = format_news_report(result, "AAPL News")
    assert "https://example.com/story" in rendered
    assert "2026-07-22T09:00:00Z" in rendered
    assert "secret-bearing" not in rendered


@pytest.mark.unit
def test_all_source_failures_are_not_reported_as_no_news(monkeypatch):
    monkeypatch.setattr(
        aggregator,
        "fetch_ticker_news_yfinance",
        lambda *args, **kwargs: (_ for _ in ()).throw(ConnectionError("down")),
    )
    monkeypatch.setattr(
        aggregator,
        "fetch_sec_filings",
        lambda *args, **kwargs: (_ for _ in ()).throw(TimeoutError("down")),
    )
    result = aggregator.aggregate_ticker_news(
        "AAPL",
        "2026-07-01",
        "2026-07-22",
        now=NOW,
        config={"news_ticker_sources": "yfinance,sec", "news_article_limit": 10},
    )
    rendered = format_news_report(result, "AAPL News")

    assert result.status == "unavailable"
    assert "NEWS_DATA_UNAVAILABLE" in rendered
    assert "NO_RELEVANT_NEWS" not in rendered


@pytest.mark.unit
def test_optional_alpha_vantage_is_not_called_without_key(monkeypatch):
    monkeypatch.delenv("ALPHA_VANTAGE_API_KEY", raising=False)
    call = mock.Mock(side_effect=AssertionError("optional source must not be called"))
    monkeypatch.setattr(aggregator.alpha_vantage_news, "get_news", call)

    result = aggregator.aggregate_ticker_news(
        "AAPL",
        "2026-07-01",
        "2026-07-22",
        now=NOW,
        config={"news_ticker_sources": "alpha_vantage", "news_article_limit": 10},
    )

    call.assert_not_called()
    assert result.status == "unavailable"
    assert result.source_statuses[0].status == "not_configured"


@pytest.mark.unit
def test_alpha_vantage_adapter_checks_exact_ticker_relevance(monkeypatch):
    monkeypatch.setenv("ALPHA_VANTAGE_API_KEY", "configured-for-test")
    payload = {
        "feed": [
            {
                "title": "Relevant",
                "summary": "AAPL item",
                "url": "https://example.com/relevant",
                "source": "Wire",
                "time_published": "20260722T090000",
                "ticker_sentiment": [{"ticker": "AAPL"}],
            },
            {
                "title": "Wrong ticker",
                "summary": "MSFT item",
                "url": "https://example.com/wrong",
                "source": "Wire",
                "time_published": "20260722T090000",
                "ticker_sentiment": [{"ticker": "MSFT"}],
            },
        ]
    }
    monkeypatch.setattr(aggregator.alpha_vantage_news, "get_news", lambda *args: payload)
    result = aggregator.aggregate_ticker_news(
        "AAPL",
        "2026-07-01",
        "2026-07-22",
        now=NOW,
        config={"news_ticker_sources": "alpha_vantage", "news_article_limit": 10},
    )

    assert [item.title for item in result.items] == ["Relevant"]


@pytest.mark.unit
def test_yfinance_adapter_uses_exact_related_tickers(monkeypatch):
    raw = [
        {
            "title": "Relevant",
            "publisher": "Wire",
            "link": "https://example.com/relevant",
            "providerPublishTime": int((NOW - timedelta(hours=1)).timestamp()),
            "relatedTickers": ["AAPL"],
        },
        {
            "title": "Unrelated",
            "publisher": "Wire",
            "link": "https://example.com/unrelated",
            "providerPublishTime": int((NOW - timedelta(hours=1)).timestamp()),
            "relatedTickers": ["MSFT"],
        },
    ]

    class FakeSearch:
        def __init__(self, *args, **kwargs):
            self.news = raw
            self.quotes = [{"symbol": "AAPL", "shortname": "Apple"}]

    class FakeTicker:
        def __init__(self, symbol):
            self.symbol = symbol

        def get_info(self):
            return {}

    monkeypatch.setattr(yfinance_news.yf, "Search", FakeSearch)
    monkeypatch.setattr(yfinance_news.yf, "Ticker", FakeTicker)
    monkeypatch.setattr(yfinance_news, "yf_retry", lambda fn: fn())

    items = yfinance_news.fetch_ticker_news_yfinance("AAPL", limit=10, fetched_at=NOW)
    assert [item.title for item in items] == ["Relevant"]


@pytest.mark.unit
def test_sec_collector_builds_primary_source_item(monkeypatch):
    monkeypatch.setattr(official, "_sec_ticker_map", lambda timeout, user_agent: {"AAPL": (320193, "Apple Inc.")})
    monkeypatch.setattr(
        official,
        "_get_json",
        lambda *args, **kwargs: {
            "filings": {
                "recent": {
                    "form": ["8-K", "4"],
                    "accessionNumber": ["0000320193-26-000001", "ignored"],
                    "filingDate": ["2026-07-22", "2026-07-22"],
                    "acceptanceDateTime": ["2026-07-22T09:15:00.000Z", "2026-07-22T09:20:00Z"],
                    "reportDate": ["2026-07-21", ""],
                    "primaryDocument": ["form8-k.htm", "xslF345X05/doc.xml"],
                    "primaryDocDescription": ["Current report", "Ownership"],
                }
            }
        },
    )

    items = official.fetch_sec_filings(
        "AAPL",
        fetched_at=NOW,
        limit=10,
        timeout=5,
        user_agent="test-agent",
        forms={"8-K"},
    )

    assert len(items) == 1
    assert items[0].source_tier == "primary"
    assert items[0].published_at.isoformat() == "2026-07-22T09:15:00+00:00"
    assert items[0].url.endswith("/000032019326000001/form8-k.htm")


@pytest.mark.unit
def test_sec_collector_adds_runtime_contact_email_to_fair_access_user_agent(monkeypatch):
    observed = {}

    def ticker_map(timeout, user_agent):
        observed["ticker_map_user_agent"] = user_agent
        return {"AAPL": (320193, "Apple Inc.")}

    def get_json(*args, **kwargs):
        observed.setdefault("request_user_agents", []).append(kwargs["user_agent"])
        return {
            "filings": {
                "recent": {
                    "form": [],
                    "accessionNumber": [],
                    "filingDate": [],
                },
            },
        }

    monkeypatch.setattr(official, "_sec_ticker_map", ticker_map)
    monkeypatch.setattr(official, "_get_json", get_json)
    official.fetch_sec_filings(
        "AAPL",
        fetched_at=NOW,
        limit=10,
        timeout=5,
        user_agent="TradingWorkbench/1.0",
        forms={"8-K"},
        sec_contact_email="researcher@example.com",
    )

    assert observed["ticker_map_user_agent"].endswith("researcher@example.com")
    assert all(
        value.endswith("researcher@example.com")
        for value in observed["request_user_agents"]
    )


@pytest.mark.unit
def test_federal_reserve_rss_collector_is_offline_testable(monkeypatch):
    xml = """<?xml version='1.0'?>
    <rss><channel><item>
      <title>Federal Reserve issues statement</title>
      <link>https://www.federalreserve.gov/newsevents/pressreleases/test.htm</link>
      <description><![CDATA[<p>Policy update.</p>]]></description>
      <pubDate>Wed, 22 Jul 2026 09:00:00 GMT</pubDate>
    </item></channel></rss>"""

    class FakeResponse:
        content = xml

        def raise_for_status(self):
            return None

    monkeypatch.setattr(official.requests, "get", lambda *args, **kwargs: FakeResponse())
    items = official.fetch_federal_reserve_news(
        fetched_at=NOW,
        limit=5,
        timeout=5,
        user_agent="test-agent",
    )

    assert len(items) == 1
    assert items[0].source == "Federal Reserve"
    assert items[0].summary == "Policy update."
    assert items[0].source_tier == "primary"


@pytest.mark.unit
def test_google_news_a_share_collector_resolves_name_and_filters_window(monkeypatch):
    xml = """<?xml version='1.0'?>
    <rss><channel>
      <item><title>贵州茅台公布经营数据 - 财经社</title><link>https://news.google.com/a</link><source>财经社</source><description>贵州茅台 600519</description><pubDate>Wed, 22 Jul 2026 08:00:00 GMT</pubDate></item>
      <item><title>其他公司新闻 - 财经社</title><link>https://news.google.com/b</link><source>财经社</source><description>无关内容</description><pubDate>Wed, 22 Jul 2026 08:00:00 GMT</pubDate></item>
      <item><title>贵州茅台旧闻 - 财经社</title><link>https://news.google.com/c</link><source>财经社</source><description>贵州茅台</description><pubDate>Mon, 01 Jun 2026 08:00:00 GMT</pubDate></item>
    </channel></rss>""".encode()

    class FakeResponse:
        def __init__(self, *, payload=None, content=b""):
            self._payload = payload
            self.content = content

        def raise_for_status(self):
            return None

        def json(self):
            return self._payload

    def fake_get(url, **kwargs):
        if url == google_news.EASTMONEY_QUOTE:
            return FakeResponse(payload={"data": {"f57": "600519", "f58": "贵州茅台"}})
        return FakeResponse(content=xml)

    monkeypatch.setattr(google_news.requests, "get", fake_get)
    items = google_news.fetch_ticker_news_google(
        "600519.SS",
        start_date="2026-07-15",
        end_date="2026-07-22",
        fetched_at=NOW,
        limit=10,
        timeout=5,
        user_agent="test-agent",
        window_timezone="Asia/Shanghai",
    )
    assert [item.title for item in items] == ["贵州茅台公布经营数据"]
    assert items[0].source == "Google News / 财经社"


@pytest.mark.unit
def test_bundle_contract_keeps_statuses_separate_from_items(monkeypatch):
    monkeypatch.setattr(
        aggregator,
        "fetch_ticker_news_yfinance",
        lambda *args, **kwargs: [_item()],
    )
    result = aggregator.aggregate_ticker_news(
        "AAPL",
        "2026-07-01",
        "2026-07-22",
        now=NOW,
        config={"news_ticker_sources": "yfinance", "news_article_limit": 10},
    ).to_dict()

    assert set(result["items"][0]) == {
        "title",
        "summary",
        "url",
        "source",
        "published_at",
        "fetched_at",
        "ticker",
        "source_tier",
    }
    assert result["status"] == "ok"
    assert result["source_statuses"] == [
        {"source": "Yahoo Finance", "status": "ok", "item_count": 1}
    ]


@pytest.mark.unit
def test_news_vendor_routing_still_respects_explicit_single_vendor(monkeypatch):
    monkeypatch.setattr(config_module, "_config", copy.deepcopy(default_config.DEFAULT_CONFIG))
    set_config({"data_vendors": {"news_data": "yfinance"}})
    multi_source = mock.Mock(return_value="MULTI")
    yfinance = mock.Mock(return_value="YAHOO")
    alpha = mock.Mock(return_value="ALPHA")
    with mock.patch.dict(
        interface.VENDOR_METHODS,
        {"get_news": {"multi_source": multi_source, "yfinance": yfinance, "alpha_vantage": alpha}},
        clear=False,
    ):
        result = interface.route_to_vendor("get_news", "AAPL", "2026-07-01", "2026-07-22")

    assert result == "YAHOO"
    yfinance.assert_called_once()
    multi_source.assert_not_called()
    alpha.assert_not_called()


@pytest.mark.unit
def test_default_multi_source_config_does_not_break_insider_routing(monkeypatch):
    monkeypatch.setattr(config_module, "_config", copy.deepcopy(default_config.DEFAULT_CONFIG))
    yfinance = mock.Mock(return_value="INSIDER_DATA")
    with mock.patch.dict(
        interface.VENDOR_METHODS,
        {"get_insider_transactions": {"yfinance": yfinance, "alpha_vantage": mock.Mock()}},
        clear=False,
    ):
        result = interface.route_to_vendor("get_insider_transactions", "AAPL")

    assert result == "INSIDER_DATA"
    yfinance.assert_called_once_with("AAPL")


@pytest.mark.unit
def test_canonicalize_url_rejects_non_http_links():
    assert canonicalize_url("javascript:alert(1)") == ""


@pytest.mark.unit
def test_invalid_window_fails_before_calling_sources(monkeypatch):
    collector = mock.Mock(side_effect=AssertionError("must validate before fetching"))
    monkeypatch.setattr(aggregator, "fetch_ticker_news_yfinance", collector)

    with pytest.raises(ValueError, match="must not be after"):
        aggregator.aggregate_ticker_news(
            "AAPL",
            "2026-07-23",
            "2026-07-22",
            now=NOW,
            config={"news_ticker_sources": "yfinance", "news_article_limit": 10},
        )

    collector.assert_not_called()
