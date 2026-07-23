import json
import math
import os
import threading
from datetime import datetime, timedelta, timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SCREENSHOT_DIR = Path(os.environ.get(
    "WORKBENCH_SCREENSHOT_DIR",
    r"G:\codex-home\visualizations\2026\07\22\019f8943-9db3-7c52-88de-0cb3773977ba"
    if os.name == "nt"
    else str(ROOT / "test-results" / "workbench"),
))
BASE_URL = "http://127.0.0.1:4207"
SETTINGS = json.loads((ROOT / "public/data/workbench-settings.json").read_text(encoding="utf-8"))
MARKET_REQUESTS = []
ANALYZE_REQUESTS = []
SETTINGS_REQUESTS = []
CHAT_REQUESTS = []
API_COUNTS = {}
BROWSER_DIAGNOSTICS = []


def capture_browser_diagnostics(page, label):
    def record(kind, detail):
        entry = f"[{label}] {kind}: {detail}"
        BROWSER_DIAGNOSTICS.append(entry)
        print(entry)

    page.on("console", lambda message: record(
        f"console.{message.type}", message.text
    ) if message.type in {"error", "warning"} else None)
    page.on("pageerror", lambda error: record("pageerror", error))
    page.on("requestfailed", lambda request: record(
        "requestfailed", f"{request.method} {request.url} — {request.failure}"
    ))


def envelope(data, status="ok", source="fixture-provider"):
    as_of = data[-1].get("ts") if data else "2026-07-23T07:10:00.000Z"
    return {
        "status": status,
        "asOf": as_of,
        "data": data,
        "sources": [{
            "source": source,
            "asOf": as_of,
            "fetchedAt": "2026-07-23T07:10:15.000Z",
            "freshness": "fresh" if status == "ok" else status,
            "quality": "verified" if status == "ok" else status,
            "adjustment": "none",
        }],
    }


def bars(symbol, timeframe, count=150):
    start = datetime(2026, 7, 22, 1, 30, tzinfo=timezone.utc)
    base = 1.46 if symbol.endswith((".SS", ".SZ")) else 170
    step = {"5m": 5, "15m": 15, "1h": 60, "1d": 1440}.get(timeframe, 15)
    result = []
    for index in range(count):
        trend = index * base * 0.00045
        wave = math.sin(index / 7) * base * 0.008
        opening = base + trend + wave
        closing = opening + math.sin(index / 3) * base * 0.002
        result.append({
            "symbol": symbol,
            "timeframe": timeframe,
            "ts": (start + timedelta(minutes=index * step)).isoformat().replace("+00:00", "Z"),
            "open": round(opening, 4),
            "high": round(max(opening, closing) + base * 0.003, 4),
            "low": round(min(opening, closing) - base * 0.003, 4),
            "close": round(closing, 4),
            "volume": 4_200_000 + index * 12_000 + int(abs(math.sin(index)) * 900_000),
        })
    return result


NEWS = [
    {
        "id": "n1", "symbol": "NVDA", "topic": "earnings", "title": "AI 加速卡供给链指引更新",
        "summary": "上游封装与先进制程排产继续影响下季度交付节奏。",
        "url": "https://example.com/nvda", "published_at": "2026-07-23T06:48:00.000Z",
        "source": "Reuters", "as_of": "2026-07-23T06:48:00.000Z", "fetched_at": "2026-07-23T06:49:00.000Z",
    },
    {
        "id": "n2", "symbol": "TSM", "topic": "supply-chain", "title": "先进制程利用率保持高位",
        "summary": "晶圆代工产能与价格变化是 A 股半导体设备链的重要外部驱动。",
        "url": "https://example.com/tsm", "published_at": "2026-07-23T05:30:00.000Z",
        "source": "Company IR", "as_of": "2026-07-23T05:30:00.000Z", "fetched_at": "2026-07-23T05:31:00.000Z",
    },
]
EVENTS = [
    {
        "id": "e1", "symbol": "515880.SS", "topic": "policy", "importance": "critical",
        "event_at": "2026-07-23T07:00:00.000Z", "title": "通信产业政策发布窗口",
        "description": "关注政策原文、执行范围和与预期差异。",
        "source": "Policy Monitor", "as_of": "2026-07-23T07:00:00.000Z", "fetched_at": "2026-07-23T07:01:00.000Z",
    },
]


def fulfill_json(route, payload, status=200):
    route.fulfill(status=status, content_type="application/json; charset=utf-8", body=json.dumps(payload, ensure_ascii=False))


def route_api(route):
    parsed = urlparse(route.request.url)
    query = parse_qs(parsed.query)
    path = parsed.path
    API_COUNTS[path] = API_COUNTS.get(path, 0) + 1
    if path == "/api/settings":
        if route.request.method == "PUT":
            request = route.request.post_data_json
            SETTINGS_REQUESTS.append(request)
            fulfill_json(route, {
                "ok": True, "settings": request["settings"],
                "updatedAt": "2026-07-23T07:12:00.000Z", "message": "设置已保存并即时生效",
            })
        else:
            fulfill_json(route, {**SETTINGS, "updatedAt": "2026-07-23T07:00:00.000Z"})
    elif path == "/api/market":
        symbol = query.get("symbol", ["515880.SS"])[0]
        timeframe = query.get("timeframe", ["15m"])[0]
        limit = int(query.get("limit", ["240"])[0])
        MARKET_REQUESTS.append((symbol, timeframe, limit))
        fulfill_json(route, envelope(bars(symbol, timeframe)[-limit:]))
    elif path == "/api/news":
        fulfill_json(route, envelope(NEWS))
    elif path == "/api/events":
        fulfill_json(route, envelope(EVENTS))
    elif path == "/api/monitor-status":
        fulfill_json(route, envelope([
            {"source": "cn-intraday", "status": "ok", "as_of": "2026-07-23T07:05:00.000Z", "detail": "最近采集成功", "fetched_at": "2026-07-23T07:05:02.000Z"},
            {"source": "pre-market", "status": "ok", "as_of": "2026-07-23T00:25:00.000Z", "detail": "简报已归档", "fetched_at": "2026-07-23T00:25:10.000Z"},
        ]))
    elif path == "/api/latest":
        fulfill_json(route, {
            "status": "ok", "generated_at": "2026-07-23T06:34:48+08:00", "trade_date": "2026-07-22",
            "provider": "openai_compatible", "analysts": ["market", "news", "fundamentals"],
            "results": [{
                "ticker": "515880.SS", "rating": "Overweight",
                "report": "reports/515880.SS/2026-07-22/complete_report.md",
                "decision_excerpt": "**Executive Summary**: 美股半导体驱动偏强，但 A 股成交确认仍是加仓前提。观察通信设备与光模块链的量价共振，若开盘后相关性衰减则保持中性仓位。",
            }],
        })
    elif path == "/api/history":
        fulfill_json(route, [{
            "trade_date": "2026-07-22",
            "generated_at": "2026-07-23T06:34:48+08:00",
            "provider": "openai_compatible",
            "results": [{
                "ticker": "515880.SS", "rating": "Overweight",
                "report": "reports/515880.SS/2026-07-22/complete_report.md",
                "error": False,
            }],
        }])
    elif path == "/api/runs":
        fulfill_json(route, {"runs": [{
            "id": 1001, "workflow": "analysis-request", "title": "515880.SS",
            "status": "completed", "conclusion": "success",
            "created_at": "2026-07-23T06:34:48+08:00",
            "url": "https://github.com/gaaiyun/TradingWorkbench/actions/runs/1001",
        }]})
    elif path == "/api/report":
        route.fulfill(
            status=200,
            content_type="text/plain; charset=utf-8",
            body="# 515880.SS 研究报告\n\n## 结论\n\n成交确认仍是最重要的跟踪条件。",
        )
    elif path == "/api/volguard":
        route.fulfill(
            status=200,
            headers={
                "content-type": "application/json; charset=utf-8",
                "x-volguard-mode": "live",
            },
            body=json.dumps({
                "schema_version": 2,
                "quote_generated_at": "2026-07-23T15:05:00+08:00",
                "source_asof": {
                    "underlying": "2026-07-23T15:04:48+08:00",
                    "options_latest": "2026-07-23T15:04:45+08:00",
                    "slow_snapshot": "2026-07-23T15:00:00+08:00",
                },
                "source_status": {
                    "overall": "live", "market_phase": "open",
                    "options": {"state": "ok", "contracts": 1},
                },
                "underlying": {
                    "symbol": "510050.SS", "last": 3.12, "change_pct": 1.25,
                },
                "quick_metrics": {
                    "contract_count": 1, "put_call_oi_ratio": 0.88,
                    "put_call_volume_ratio": 0.91, "front_max_pain": 3.1,
                    "front_expiry": "2026-07-29",
                },
                "contracts": [{
                    "code": "CON_OP_1", "name": "50ETF认购 2026-07-29 3.100",
                    "option_type": "call", "expiry": "2026-07-29",
                    "strike": 3.1, "last": 0.08, "volume": 100, "open_interest": 200,
                }],
                "slow_metrics": {
                    "risk": {
                        "hv30": 18.4, "iv_avg": 22.1, "var_95": 3.8,
                        "var_method": "GARCH(1,1)", "bsadf_stat": 1.9, "bsadf_cv": 2.4,
                    },
                    "exposure": {"gex_net": 1.2, "dex_net": -0.4},
                },
            }, ensure_ascii=False),
        )
    elif path == "/api/analyze":
        ANALYZE_REQUESTS.append(route.request.post_data_json)
        fulfill_json(route, {"ok": True, "message": "已受理，分析会在后台顺序执行", "tickers": [item["symbol"] for item in SETTINGS["profiles"][0]["targets"]]}, 202)
    elif path == "/api/chat":
        CHAT_REQUESTS.append(route.request.post_data_json)
        route.fulfill(
            status=200,
            content_type="text/event-stream; charset=utf-8",
            body=(
                'event: meta\ndata: {"context":"fixture-report"}\n\n'
                'event: delta\ndata: {"content":"当前归档显示："}\n\n'
                'event: delta\ndata: {"content":"**成交确认**仍是最重要的跟踪条件。"}\n\n'
                'event: done\ndata: {"done":true}\n\n'
            ),
        )
    else:
        fulfill_json(route, {"status": "unavailable", "asOf": None, "data": [], "sources": []})


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format, *args):
        return


def run_browser():
    SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        launch_options = {"headless": True}
        edge_path = Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")
        if edge_path.exists():
            launch_options["executable_path"] = str(edge_path)
        browser = playwright.chromium.launch(**launch_options)
        page = browser.new_page(viewport={"width": 1600, "height": 1000}, device_scale_factor=1)
        capture_browser_diagnostics(page, "desktop")
        page.add_init_script("""
          const nativeSetInterval = window.setInterval.bind(window);
          window.__pollWorkbench = null;
          window.setInterval = (fn, delay, ...args) => {
            if (delay >= 60000) {
              window.__pollWorkbench = () => fn(...args);
              return 60000;
            }
            return nativeSetInterval(fn, delay, ...args);
          };
        """)
        page.route("**/api/**", route_api)
        page.goto(BASE_URL, wait_until="domcontentloaded")
        page.wait_for_selector("#watchlist .watch-row")
        page.wait_for_function("document.querySelector('#chart-empty').hidden === true")
        page.screenshot(path=str(SCREENSHOT_DIR / "etf-workbench-desktop.png"), full_page=True)

        assert page.locator("#watchlist .watch-row").count() == 11
        assert page.locator("#market-chart").is_visible()
        assert page.locator("a[href*='tradingview.com']").count() >= 1
        assert page.locator('[data-route-link="agents"]').first.is_visible()
        assert page.locator('[data-route-link="options"]').first.is_visible()
        assert page.locator("#instrument-change").evaluate(
            "element => getComputedStyle(element).color",
        ) == "rgb(224, 95, 104)"
        assert "最近采集成功" not in page.locator("#task-timeline").inner_text()
        assert "任务结果接口未提供" in page.locator("#task-timeline").inner_text()
        page.get_by_role("tab", name="1h").click()
        assert page.get_by_role("tab", name="1h").get_attribute("aria-selected") == "true"
        page.wait_for_selector("#research-feed .feed-item")
        page.select_option("#feed-symbol", "NVDA")
        page.wait_for_function(
            "document.querySelectorAll('#research-feed .feed-item').length === 1",
        )
        assert page.locator("#research-feed .feed-item").count() == 1

        page.locator('[data-route-link="agents"]').first.click()
        page.wait_for_function("document.body.dataset.route === 'agents'")
        assert page.locator("#deep-analysis-open").is_visible()
        assert page.locator("#agent-pipeline .is-completed").count() == 4
        page.click("#deep-analysis-open")
        page.wait_for_selector("#settings-drawer.is-open")
        assert "515880.SS、512480.SS" in page.locator("#settings-notice").inner_text()
        page.select_option("#profile-timezone", "Asia/Singapore")
        page.uncheck("#enable-us-close")
        page.uncheck("#enable-premarket")
        page.uncheck("#enable-intraday")
        page.uncheck("#enable-close-analysis")
        page.uncheck("#alert-pushplus")
        page.screenshot(path=str(SCREENSHOT_DIR / "etf-workbench-settings.png"), full_page=True)
        page.fill("#settings-code", "fixture-code")
        page.check("#settings-remember")
        page.click("#save-settings")
        page.wait_for_function("document.querySelector('#settings-notice').textContent.includes('保存')")
        saved_profile = SETTINGS_REQUESTS[-1]["settings"]["profiles"][0]
        assert saved_profile["schedules"]["usCloseSnapshot"]["enabled"] is False
        assert saved_profile["schedules"]["preMarketBrief"]["enabled"] is False
        assert saved_profile["schedules"]["cnIntraday"]["enabled"] is False
        assert saved_profile["schedules"]["closeDeepAnalysis"]["enabled"] is False
        assert saved_profile["alerts"]["channels"]["pushPlus"] is False
        page.click("#run-analysis")
        page.wait_for_function("document.querySelector('#settings-notice').textContent.includes('已受理')")
        assert ANALYZE_REQUESTS[-1]["tickers"] == [
            item["symbol"]
            for item in SETTINGS["profiles"][0]["targets"]
            if item["analysis"] == "full"
        ]

        mobile = browser.new_page(viewport={"width": 390, "height": 844}, device_scale_factor=1)
        capture_browser_diagnostics(mobile, "mobile")
        mobile.route("**/api/**", route_api)
        mobile.goto(BASE_URL, wait_until="domcontentloaded")
        mobile.wait_for_selector("#market-chart")
        assert mobile.locator('[data-route-link="options"]').last.is_visible()
        mobile.locator('[data-route-link="options"]').last.click()
        mobile.wait_for_function("document.body.dataset.route === 'options'")
        mobile.wait_for_function("document.querySelector('#options-status').textContent.includes('正常')")
        assert mobile.locator("#options-chain .options-table tbody tr").count() == 1
        mobile.locator('[data-route-link="monitor"]').last.click()
        mobile.wait_for_function("document.body.dataset.route === 'monitor'")
        mobile.click('[data-mobile-section="watch"]')
        assert mobile.locator("body").get_attribute("data-mobile-view") == "watch"
        mobile.click('[data-mobile-section="chart"]')
        assert mobile.locator("#cross-market-drivers").is_visible()
        mobile.screenshot(path=str(SCREENSHOT_DIR / "etf-workbench-mobile.png"), full_page=True)

        mobile.click('[data-mobile-section="watch"]')
        mobile.locator('[data-symbol="NVDA"]').click()
        mobile.click('[data-mobile-section="chart"]')
        mobile.wait_for_function("document.querySelector('#conclusion-asof').textContent.includes('尚无')")
        assert "美股半导体驱动偏强" not in mobile.locator("#conclusion-body").inner_text()

        race = browser.new_page(viewport={"width": 1200, "height": 800}, device_scale_factor=1)
        capture_browser_diagnostics(race, "race")
        race.add_init_script("""
          const nativeFetch = window.fetch.bind(window);
          window.fetch = async (...args) => {
            const response = await nativeFetch(...args);
            const url = new URL(typeof args[0] === "string" ? args[0] : args[0].url, location.href);
            const delayedSymbol = url.pathname === "/api/market"
              && url.searchParams.get("symbol") === "512480.SS"
              && url.searchParams.get("limit") === "240";
            const delayedTimeframe = url.pathname === "/api/market"
              && url.searchParams.get("timeframe") === "1h"
              && url.searchParams.get("limit") === "240";
            if (delayedSymbol || delayedTimeframe) {
              await new Promise((resolve) => setTimeout(resolve, 350));
            }
            return response;
          };
        """)
        race.route("**/api/**", route_api)
        race.goto(BASE_URL, wait_until="domcontentloaded")
        race.wait_for_selector("#watchlist .watch-row")
        race.locator('[data-symbol="512480.SS"]').click()
        race.wait_for_timeout(40)
        race.locator('[data-symbol="NVDA"]').click()
        race.wait_for_function("document.querySelector('#instrument-symbol').textContent === 'NVDA'")
        race.wait_for_timeout(450)
        assert race.locator("#instrument-symbol").inner_text() == "NVDA"
        assert race.locator("#instrument-price").inner_text() == "182.089"
        assert race.locator("#instrument-change").evaluate(
            "element => getComputedStyle(element).color",
        ) == "rgb(56, 183, 136)"
        assert race.locator("#history-range-tabs").is_visible()
        assert any(
            symbol == "NVDA" and timeframe == "1d" and limit == 1260
            for symbol, timeframe, limit in MARKET_REQUESTS
        )
        race.locator('[data-history-range="3y"]').click()
        race.wait_for_timeout(120)
        assert any(
            symbol == "NVDA" and timeframe == "1d" and limit == 756
            for symbol, timeframe, limit in MARKET_REQUESTS
        )
        race.locator('[data-symbol="512480.SS"]').click()
        race.wait_for_timeout(120)
        race.get_by_role("tab", name="1h").click()
        race.wait_for_timeout(40)
        race.get_by_role("tab", name="1d").click()
        race.wait_for_timeout(450)
        assert race.get_by_role("tab", name="1d").get_attribute("aria-selected") == "true"
        assert "12/18" in race.locator("#freshness-asof").inner_text()
        race.close()

        hydration = browser.new_page(viewport={"width": 1200, "height": 800}, device_scale_factor=1)
        capture_browser_diagnostics(hydration, "hydration")
        hydration.add_init_script("""
          const nativeFetch = window.fetch.bind(window);
          const nativeSetInterval = window.setInterval.bind(window);
          window.__marketRequests = [];
          window.__pollWorkbench = null;
          window.fetch = async (...args) => {
            const url = new URL(typeof args[0] === "string" ? args[0] : args[0].url, location.href);
            if (url.pathname === "/api/market") {
              window.__marketRequests.push({
                symbol: url.searchParams.get("symbol"),
                timeframe: url.searchParams.get("timeframe"),
                limit: url.searchParams.get("limit"),
              });
            }
            const response = await nativeFetch(...args);
            const delayedFull = url.pathname === "/api/market"
              && url.searchParams.get("timeframe") === "1h"
              && url.searchParams.get("limit") === "240";
            if (delayedFull) await new Promise((resolve) => setTimeout(resolve, 350));
            return response;
          };
          window.setInterval = (fn, delay, ...args) => {
            if (delay >= 60000) {
              window.__pollWorkbench = () => fn(...args);
              return 60000;
            }
            return nativeSetInterval(fn, delay, ...args);
          };
        """)

        def route_hydration(route):
            parsed = urlparse(route.request.url)
            query = parse_qs(parsed.query)
            if parsed.path == "/api/market":
                symbol = query.get("symbol", ["515880.SS"])[0]
                timeframe = query.get("timeframe", ["15m"])[0]
                limit = int(query.get("limit", ["240"])[0])
                fulfill_json(route, envelope(bars(symbol, timeframe, 240)[-limit:]))
                return
            route_api(route)

        hydration.route("**/api/**", route_hydration)
        hydration.goto(BASE_URL, wait_until="domcontentloaded")
        hydration.wait_for_function("window.__pollWorkbench !== null")
        hydration.get_by_role("tab", name="1h").click()
        hydration.wait_for_timeout(40)
        hydration.evaluate("window.__pollWorkbench()")
        hydration.wait_for_timeout(450)
        one_hour_requests = hydration.evaluate("""
          window.__marketRequests
            .filter((request) => request.symbol === "515880.SS" && request.timeframe === "1h")
            .map((request) => request.limit)
        """)
        assert one_hour_requests == ["240"]
        chart_label = hydration.locator("#market-chart").get_attribute("aria-label")
        assert "240 根" in chart_label
        assert "MA60 历史充足" in chart_label
        hydration.close()

        page.click("#settings-close")
        page.click("#assistant-open")
        page.fill("#chat-question", "第一问")
        page.click("#chat-send")
        page.wait_for_function("document.querySelector('#chat-log').textContent.includes('成交确认')")
        page.fill("#chat-question", "第二问")
        page.click("#chat-send")
        page.wait_for_function("document.querySelectorAll('#chat-log .chat-message.user').length === 2")
        assert CHAT_REQUESTS[-1]["stream"] is True
        assert len(CHAT_REQUESTS[-1]["history"]) >= 2
        assert page.evaluate("JSON.parse(localStorage.getItem('ta.workbench.threads.v1')).length") >= 1
        page.evaluate("""
          let index = 0;
          let chunkSize = 250000;
          while (chunkSize >= 100) {
            try {
              localStorage.setItem(`quota-fixture-${index++}`, "x".repeat(chunkSize));
            } catch {
              chunkSize = Math.floor(chunkSize / 2);
            }
          }
        """)
        page.fill("#chat-question", "配额失败后仍应发送")
        page.click("#chat-send")
        page.wait_for_function("document.querySelectorAll('#chat-log .chat-message.user').length === 3")
        page.wait_for_function("document.querySelectorAll('#chat-log .chat-message.assistant').length === 3")
        assert "本地会话无法继续持久化" in page.locator("#toast-region").inner_text()

        page.click("#assistant-close")
        page.click("#settings-open")
        page.click("#settings-workspace-open")
        page.click("#clear-credential")
        assert page.input_value("#settings-code") == ""
        assert page.evaluate("sessionStorage.getItem('ta.workbench.access.session.v1')") is None
        assert page.evaluate("localStorage.getItem('ta.workbench.access.encrypted.v1')") is None
        assert page.evaluate("localStorage.getItem('ta.workbench.device-key.v1')") is None

        unavailable = browser.new_page(viewport={"width": 900, "height": 700})
        capture_browser_diagnostics(unavailable, "unavailable")
        unavailable.route("**/api/**", lambda route: fulfill_json(route, {"status": "unavailable", "asOf": None, "data": [], "sources": []}))
        unavailable.goto(BASE_URL, wait_until="domcontentloaded")
        unavailable.wait_for_selector("#chart-empty")
        assert unavailable.locator("#chart-empty").is_visible()
        assert unavailable.locator("#freshness-status").inner_text() == "UNAVAILABLE"

        counts_before_poll = dict(API_COUNTS)
        market_count_before_poll = len(MARKET_REQUESTS)
        page.evaluate("window.__pollWorkbench()")
        page.wait_for_timeout(650)
        assert any(symbol == "515880.SS" and limit == 2 for symbol, _, limit in MARKET_REQUESTS)
        assert len(MARKET_REQUESTS) >= market_count_before_poll + 10
        for path in ["/api/news", "/api/events", "/api/monitor-status"]:
            assert API_COUNTS[path] > counts_before_poll.get(path, 0)
        browser.close()


def main():
    handler = partial(QuietHandler, directory=str(ROOT / "public"))
    server = ThreadingHTTPServer(("127.0.0.1", 4207), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        run_browser()
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


if __name__ == "__main__":
    main()
