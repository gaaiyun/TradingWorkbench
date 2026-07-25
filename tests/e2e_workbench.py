import json
import math
import os
import threading
from copy import deepcopy
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
SECOND_PROFILE = deepcopy(SETTINGS["profiles"][0])
SECOND_PROFILE.update({
    "id": "profile-b",
    "name": "B 组同标的监控",
    "objective": "验证同一标的在不同监控组中的上下文隔离。",
    "enabled": False,
})
SECOND_PROFILE["targets"] = [
    deepcopy(SETTINGS["profiles"][0]["targets"][0]),
    deepcopy(next(
        target for target in SETTINGS["profiles"][0]["targets"]
        if target["symbol"] == "NVDA"
    )),
]
ACTIVE_SETTINGS = deepcopy(SETTINGS)
ACTIVE_SETTINGS["profiles"].append(SECOND_PROFILE)
ACTIVE_UPDATED_AT = ["2026-07-23T07:00:00.000Z"]
MARKET_REQUESTS = []
MARKET_PROFILE_REQUESTS = []
ANALYZE_REQUESTS = []
SETTINGS_REQUESTS = []
PROFILE_REQUESTS = []
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


def merge_dict(current, patch):
    merged = deepcopy(current)
    for key, value in patch.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = merge_dict(merged[key], value)
        else:
            merged[key] = deepcopy(value)
    return merged


def settings_response():
    return {
        "ok": True,
        "settings": deepcopy(ACTIVE_SETTINGS),
        "updatedAt": ACTIVE_UPDATED_AT[0],
        "message": "设置已保存并即时生效",
    }


def advance_settings_revision():
    current = datetime.fromisoformat(ACTIVE_UPDATED_AT[0].replace("Z", "+00:00"))
    ACTIVE_UPDATED_AT[0] = (
        current + timedelta(seconds=1)
    ).isoformat().replace("+00:00", "Z")


def route_api(route):
    parsed = urlparse(route.request.url)
    query = parse_qs(parsed.query)
    path = parsed.path
    API_COUNTS[path] = API_COUNTS.get(path, 0) + 1
    if path == "/api/settings":
        if route.request.method == "PUT":
            request = route.request.post_data_json
            SETTINGS_REQUESTS.append(request)
            ACTIVE_SETTINGS.clear()
            ACTIVE_SETTINGS.update(deepcopy(request["settings"]))
            advance_settings_revision()
            fulfill_json(route, settings_response())
        else:
            fulfill_json(route, {
                **deepcopy(ACTIVE_SETTINGS),
                "updatedAt": ACTIVE_UPDATED_AT[0],
            })
    elif path == "/api/settings/profiles":
        request = route.request.post_data_json
        PROFILE_REQUESTS.append({
            "method": route.request.method,
            "path": path,
            "body": deepcopy(request),
        })
        profile = deepcopy(request["profile"])
        profile.setdefault("objective", profile["name"])
        profile.setdefault("enabled", False)
        profile.setdefault("timezone", "Asia/Shanghai")
        profile.setdefault("targets", [])
        profile.setdefault("systemBenchmarks", [])
        profile.setdefault("schedules", deepcopy(SETTINGS["profiles"][0]["schedules"]))
        profile.setdefault("alerts", deepcopy(SETTINGS["profiles"][0]["alerts"]))
        profile.setdefault("agentBudget", deepcopy(SETTINGS["profiles"][0]["agentBudget"]))
        ACTIVE_SETTINGS["profiles"].append(profile)
        advance_settings_revision()
        fulfill_json(route, settings_response())
    elif path.startswith("/api/settings/profiles/"):
        request = route.request.post_data_json or {}
        PROFILE_REQUESTS.append({
            "method": route.request.method,
            "path": path,
            "body": deepcopy(request),
        })
        suffix = path.removeprefix("/api/settings/profiles/")
        is_copy = suffix.endswith("/copy")
        profile_id = suffix.removesuffix("/copy")
        profile_index = next(
            index for index, profile in enumerate(ACTIVE_SETTINGS["profiles"])
            if profile["id"] == profile_id
        )
        if is_copy:
            options = request.get("options") or {
                "id": request.get("newId"),
                "name": request.get("newName"),
            }
            copied = deepcopy(ACTIVE_SETTINGS["profiles"][profile_index])
            copied["id"] = options["id"]
            copied["name"] = options.get("name") or f"{copied['name']} 副本"
            copied["enabled"] = False
            ACTIVE_SETTINGS["profiles"].append(copied)
        elif route.request.method == "PATCH":
            ACTIVE_SETTINGS["profiles"][profile_index] = merge_dict(
                ACTIVE_SETTINGS["profiles"][profile_index],
                request["patch"],
            )
        elif route.request.method == "DELETE":
            ACTIVE_SETTINGS["profiles"].pop(profile_index)
        advance_settings_revision()
        fulfill_json(route, settings_response())
    elif path == "/api/market":
        profile = query.get("profile", [None])[0]
        symbol = query.get("symbol", ["515880.SS"])[0]
        timeframe = query.get("timeframe", ["15m"])[0]
        limit = int(query.get("limit", ["240"])[0])
        MARKET_REQUESTS.append((symbol, timeframe, limit))
        MARKET_PROFILE_REQUESTS.append((profile, symbol, timeframe, limit))
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
                "files": {
                    "market": "reports/515880.SS/2026-07-22/1_analysts/market.md",
                    "decision": "reports/515880.SS/2026-07-22/5_portfolio/decision.md",
                    "complete_report": "reports/515880.SS/2026-07-22/complete_report.md",
                },
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
            body=(
                "# 515880.SS 研究报告\n\n"
                "> **证据提示：** 只采用带时间戳的原始来源。\n\n"
                "## 关键信息\n\n"
                "| 类别 | 来源 | 可靠性 |\n"
                "| --- | --- | --- |\n"
                "| 公告 | [交易所](https://example.com/filing) | 高 |\n\n"
                "---\n\n"
                "成交确认仍是最重要的跟踪条件。"
            ),
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
        fulfill_json(route, {"ok": True, "message": "已受理，分析会在后台顺序执行", "tickers": route.request.post_data_json["tickers"]}, 202)
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

        assert page.locator("#watchlist .watch-row").count() == 13
        assert page.locator("#market-chart").is_visible()
        assert page.locator("a[href*='tradingview.com']").count() >= 1
        assert page.locator('[data-route-link="agents"]').first.is_visible()
        assert page.locator('[data-route-link="options"]').first.is_visible()
        assert page.locator("#instrument-change").evaluate(
            "element => getComputedStyle(element).color",
        ) == "rgb(224, 95, 104)"
        assert "最近采集成功" not in page.locator("#task-timeline").inner_text()
        assert "任务结果接口未提供" in page.locator("#task-timeline").inner_text()

        assert page.input_value("#profile-selector") == "cn-semi-comms"
        assert page.locator("#watchlist .watch-row").count() == 13
        page.select_option("#profile-selector", "profile-b")
        page.wait_for_function(
            "document.querySelector('#profile-selector').value === 'profile-b'"
        )
        page.wait_for_timeout(180)
        assert urlparse(page.url).fragment == "monitor"
        assert page.locator("#watchlist .watch-row").count() == 2
        assert "监控组已停用" in page.locator("#task-timeline").inner_text()
        assert "任务结果接口未提供" not in page.locator("#task-timeline").inner_text()
        assert page.evaluate(
            "localStorage.getItem('ta.workbench.selected-profile.v1')"
        ) == "profile-b"
        assert any(
            profile == "cn-semi-comms" and symbol == "515880.SS"
            for profile, symbol, _, _ in MARKET_PROFILE_REQUESTS
        )
        assert any(
            profile == "profile-b" and symbol == "515880.SS"
            for profile, symbol, _, _ in MARKET_PROFILE_REQUESTS
        )

        page.click("#watchlist-edit")
        page.wait_for_selector("#settings-drawer.is-open")
        assert page.input_value("#settings-profile-selector") == "profile-b"
        original_a_name = ACTIVE_SETTINGS["profiles"][0]["name"]
        page.fill("#target-search", "03887.HK")
        page.click("#target-add")
        assert "3887.HK" in page.locator("#target-editor .target-symbol strong").all_inner_texts()
        page.fill("#profile-name", "B 组已编辑")
        page.fill("#settings-code", "fixture-code")
        page.click("#save-settings")
        page.wait_for_function(
            "document.querySelector('#settings-notice').textContent.includes('保存')"
        )
        assert ACTIVE_SETTINGS["profiles"][0]["name"] == original_a_name
        assert next(
            profile for profile in ACTIVE_SETTINGS["profiles"]
            if profile["id"] == "profile-b"
        )["name"] == "B 组已编辑"
        assert any(
            target["symbol"] == "3887.HK" and target["market"] == "HK"
            for target in next(
                profile for profile in ACTIVE_SETTINGS["profiles"]
                if profile["id"] == "profile-b"
            )["targets"]
        )
        page.click("#settings-close")

        page.locator('[data-route-link="options"]').first.click()
        page.wait_for_function("document.body.dataset.route === 'options'")
        page.wait_for_function(
            "document.querySelector('#options-status').textContent.includes('正常')"
        )
        volguard_status = page.locator("#options-status").inner_text()
        page.select_option("#profile-selector", "cn-semi-comms")
        page.wait_for_timeout(180)
        assert urlparse(page.url).fragment == "options"
        assert page.locator("#options-status").inner_text() == volguard_status

        page.select_option("#profile-selector", "profile-b")
        page.wait_for_timeout(180)
        page.reload(wait_until="domcontentloaded")
        page.wait_for_function(
            "document.querySelector('#profile-selector').value === 'profile-b'"
        )
        assert page.evaluate(
            "localStorage.getItem('ta.workbench.selected-profile.v1')"
        ) == "profile-b"
        page.select_option("#profile-selector", "cn-semi-comms")
        page.locator('[data-route-link="monitor"]').first.click()
        page.wait_for_function("document.body.dataset.route === 'monitor'")
        page.wait_for_selector("#watchlist .watch-row")

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
        assert page.locator("#settings-drawer").get_attribute("aria-hidden") == "true"
        assert page.locator("#agent-research-tickers").evaluate("element => element === document.activeElement")
        page.fill("#agent-research-tickers", "515880.SS, NVDA")
        page.select_option("#agent-research-depth", "standard")
        page.fill("#agent-research-code", "fixture-code")
        settings_count = len(SETTINGS_REQUESTS)
        page.click("#agent-research-submit")
        page.wait_for_function("document.querySelector('#agent-research-notice').textContent.includes('已受理')")
        temporary_request = ANALYZE_REQUESTS[-1]
        assert temporary_request["tickers"] == ["515880.SS", "NVDA"]
        assert temporary_request["analysts"] == ["market", "news", "fundamentals"]
        assert temporary_request["researchDepth"] == "standard"
        assert temporary_request["requestId"]
        assert len(SETTINGS_REQUESTS) == settings_count

        page.locator('[data-route-link="settings"]').first.click()
        page.wait_for_function("document.body.dataset.route === 'settings'")
        page.click("#settings-workspace-open")
        page.wait_for_selector("#settings-drawer.is-open")
        assert page.locator("#settings-drawer").get_attribute("role") == "dialog"
        assert page.locator("#settings-drawer").get_attribute("aria-modal") == "true"
        assert page.locator("#workbench").evaluate("element => element.inert")
        page.fill("#settings-code", "fixture-code")

        page.fill("#new-profile-id", "profile-new")
        page.fill("#new-profile-name", "新建监控组")
        page.click("#profile-create")
        page.wait_for_function(
            "document.querySelector('#settings-profile-selector').value === 'profile-new'"
        )
        assert PROFILE_REQUESTS[-1]["method"] == "POST"
        assert PROFILE_REQUESTS[-1]["path"] == "/api/settings/profiles"
        page.click("#profile-copy")
        page.wait_for_function(
            "document.querySelector('#settings-profile-selector').value === 'profile-new-copy'"
        )
        assert PROFILE_REQUESTS[-1]["path"].endswith("/profile-new/copy")
        page.once("dialog", lambda dialog: dialog.accept())
        page.click("#profile-delete")
        page.wait_for_function(
            "document.querySelector('#settings-profile-selector').value === 'cn-semi-comms'"
        )
        page.select_option("#settings-profile-selector", "profile-new")
        page.wait_for_function(
            "document.querySelector('#settings-profile-selector').value === 'profile-new'"
        )
        page.once("dialog", lambda dialog: dialog.accept())
        page.click("#profile-delete")
        page.wait_for_function(
            "document.querySelector('#settings-profile-selector').value === 'cn-semi-comms'"
        )

        page.select_option("#profile-timezone", "Asia/Singapore")
        page.uncheck("#enable-us-close")
        page.uncheck("#enable-premarket")
        page.uncheck("#enable-intraday")
        page.uncheck("#enable-close-analysis")
        page.uncheck("#alert-pushplus")
        page.screenshot(path=str(SCREENSHOT_DIR / "etf-workbench-settings.png"), full_page=True)
        page.check("#settings-remember")
        page.click("#save-settings")
        page.wait_for_function("document.querySelector('#settings-notice').textContent.includes('保存')")
        saved_profile = PROFILE_REQUESTS[-1]["body"]["patch"]
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
        assert ANALYZE_REQUESTS[-1]["profileId"] == "cn-semi-comms"
        page.click("#settings-close")
        page.locator('[data-route-link="archive"]').first.click()
        page.wait_for_function("document.body.dataset.route === 'archive'")
        page.locator("#archive-list [data-archive-index]").first.click()
        page.wait_for_selector('#archive-report-tabs [data-report-section="decision"].is-active')
        assert page.locator("#archive-report-tabs [data-report-section]").evaluate_all(
            "nodes => nodes.map(node => node.dataset.reportSection)",
        ) == ["market", "decision", "complete_report"]
        assert page.locator("#archive-report-warning").is_visible()
        page.click('#archive-report-tabs [data-report-section="market"]')
        page.wait_for_selector('#archive-report-tabs [data-report-section="market"].is-active')
        assert page.locator("#archive-report-warning").is_visible()
        page.wait_for_selector("#archive-report-body blockquote")
        page.wait_for_selector("#archive-report-body .markdown-table-wrap table")
        assert page.locator("#archive-report-body a").get_attribute("href") == "https://example.com/filing"
        assert page.locator("#archive-report-body hr").is_visible()

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

        mobile.set_viewport_size({"width": 320, "height": 700})
        mobile.locator('[data-route-link="settings"]').last.click()
        mobile.wait_for_function("document.body.dataset.route === 'settings'")
        mobile.click("#settings-workspace-open")
        mobile.wait_for_selector("#settings-drawer.is-open")
        mobile.wait_for_timeout(250)
        assert mobile.evaluate(
            "document.documentElement.scrollWidth <= window.innerWidth"
        )
        assert mobile.locator("#target-editor .target-row").first.evaluate(
            "element => element.getBoundingClientRect().right <= window.innerWidth"
        )
        assert mobile.locator("#target-editor .target-remove").first.evaluate(
            "element => element.getBoundingClientRect().height >= 44"
        )
        mobile.click("#settings-close")
        mobile.locator('[data-route-link="monitor"]').last.click()

        mobile.click('[data-mobile-section="watch"]')
        mobile.locator('[data-symbol="NVDA"]').click()
        mobile.click('[data-mobile-section="chart"]')
        mobile.wait_for_function("document.querySelector('#conclusion-asof').textContent.includes('尚无')")
        assert "美股半导体驱动偏强" not in mobile.locator("#conclusion-body").inner_text()

        degraded = browser.new_page(
            viewport={"width": 1200, "height": 800},
            device_scale_factor=1,
        )
        capture_browser_diagnostics(degraded, "degraded-settings")

        def route_degraded_settings(route):
            if urlparse(route.request.url).path == "/api/settings":
                fulfill_json(route, {
                    "status": "unavailable",
                    "error": "D1 unavailable",
                    "data": deepcopy(ACTIVE_SETTINGS),
                })
                return
            route_api(route)

        degraded.route("**/api/**", route_degraded_settings)
        degraded.goto(BASE_URL, wait_until="domcontentloaded")
        degraded.wait_for_function(
            "document.querySelector('#settings-workspace-status').textContent.includes('只读')"
        )
        degraded.locator('[data-route-link="settings"]').first.click()
        degraded.click("#settings-workspace-open")
        degraded.wait_for_selector("#settings-drawer.is-open")
        assert degraded.locator("#save-settings").is_disabled()
        assert degraded.locator("#profile-create").is_disabled()
        assert degraded.locator("#settings-reload-remote").is_visible()
        assert "静态灾备快照" in degraded.locator("#settings-notice").inner_text()
        degraded.close()

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

        page.click("#assistant-open")
        page.fill("#chat-question", "第一问")
        page.click("#chat-send")
        page.wait_for_function("document.querySelector('#chat-log').textContent.includes('成交确认')")
        page.fill("#chat-question", "第二问")
        page.click("#chat-send")
        page.wait_for_function("document.querySelectorAll('#chat-log .chat-message.user').length === 2")
        assert CHAT_REQUESTS[-1]["stream"] is True
        assert len(CHAT_REQUESTS[-1]["history"]) >= 2
        assert CHAT_REQUESTS[-1]["reportSection"] == "market"
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
