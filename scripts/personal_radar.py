"""Poll the personal watchlist and send grouped, time-stamped alerts through the signed relay."""

import argparse
import base64
import hashlib
import json
import logging
import os
import sqlite3
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from personal_radar_market import WATCH, active_symbols, fetch_quotes, market_events
from personal_radar_official import collect_official_candidates
from personal_radar_sources import collect_candidates
from personal_radar_world import candidates as world_candidates

STATE = Path(os.environ.get("RADAR_STATE", "/state"))
RELAY = "https://tradingagents-board.pages.dev/api/personal-push"
SG = ZoneInfo("Asia/Singapore")
RELATED = {
    "国内重大政策": "可对照沪深300、科创50和三只行业 ETF 的盘中反应。",
    "央行决议": "可对照标普500、黄金 ETF 与半导体板块。",
    "贸易与出口政策": "涉及 AI 算力时，可对照 ANT、NVDA 和 SOXX。",
    "重大冲突": "可观察原油 ETF、黄金 ETF 与主要股指是否同步异动。",
}

CONTEXT = {
    "国内重大政策": ("sh000300", "sh512480"), "央行": ("us.INX", "usGLD"),
    "美联储": ("us.INX", "usSOXX"), "贸易与出口政策": ("usANT", "usNVDA"),
    "重大冲突": ("usUSO", "usGLD"), "Anthropic": ("usANT", "usSOXX"),
    "选举": ("us.INX", "usSOXX"), "全球重大政治": ("us.INX", "usGLD"),
}


def price_context(item, quotes, now, active):
    targets = next((symbols for prefix, symbols in CONTEXT.items() if item["category"].startswith(prefix)), ())
    if not targets:
        return ""
    lines = []
    event_time = datetime.fromisoformat(item["at"].replace("Z", "+00:00"))
    for key in targets:
        if key not in quotes or key not in active:
            continue
        price, previous, at, _ = quotes[key]
        if not 0 <= (now - at).total_seconds() <= 1200 or price <= 0 or previous <= 0:
            continue
        timing = "消息前" if at < event_time else "消息发布时或之后"
        lines.append(f"{WATCH[key][0]} {price:g}（较昨收 {(price / previous - 1) * 100:+.2f}%，"
                     f"{timing}报价 {at.astimezone(SG):%H:%M}）")
    if lines:
        return "相关报价（北京时间，不代表因果）：" + "；".join(lines)
    if not any(key in active for key in targets):
        return "相关标的当前不在常规交易时段，暂无同期报价。"
    return "本轮没有取得可核实的同期报价。"


def open_db():
    db = sqlite3.connect(STATE / "alerts.sqlite", timeout=5)
    db.executescript("""
        CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY, ts INTEGER);
        CREATE TABLE IF NOT EXISTS outbox
        (id TEXT PRIMARY KEY, ts INTEGER, payload TEXT, receipt TEXT);
        CREATE TABLE IF NOT EXISTS cooldown (provider TEXT PRIMARY KEY, retry_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS evidence_level (id TEXT PRIMARY KEY, rank INTEGER);
        CREATE TABLE IF NOT EXISTS source_poll (provider TEXT PRIMARY KEY, due INTEGER, failed INTEGER);
        CREATE TABLE IF NOT EXISTS source_cache (provider TEXT PRIMARY KEY, payload TEXT);
        CREATE TABLE IF NOT EXISTS delivery_hold (id TEXT PRIMARY KEY, next_try INTEGER, attempts INTEGER);
    """)
    return db


def queue(db, items, now):
    tick = int(now.timestamp())
    messages = []
    size = 0

    def flush():
        if not messages:
            return
        key = hashlib.sha256("\n".join(row[0] for row in messages).encode()).hexdigest()
        content = "\n\n".join(row[1] for row in messages)
        payload = {"id": key, "title": messages[0][2] if len(messages) == 1 else f"投资提醒 · {len(messages)} 条新动态",
                   "content": content}
        db.execute("INSERT OR IGNORE INTO outbox VALUES (?,?,?,NULL)",
                   (key, tick, json.dumps(payload, ensure_ascii=False)))
        messages.clear()

    for item in items:
        at = datetime.fromisoformat(str(item["at"]).replace("Z", "+00:00"))
        max_age = 3600 if item.get("official_catchup") else 1200
        if at.tzinfo is None or not 0 <= (now - at).total_seconds() <= max_age:
            continue
        key = str(item["key"])
        rank = int(item.get("evidence_rank") or (1 if key.startswith("news:cn-council:") else 0))
        new = db.execute("INSERT OR IGNORE INTO seen VALUES (?,?)", (key, tick)).rowcount
        if new and rank:
            db.execute("INSERT OR REPLACE INTO evidence_level VALUES (?,?)", (key, rank))
        elif not new:
            if not rank or not db.execute("UPDATE evidence_level SET rank=? WHERE id=? AND rank<?",
                                          (rank, key, rank)).rowcount:
                continue
            key = f"{key}:rank:{rank}"
        title = str(item["title"])[:120]
        if not new:
            title = "来源更新｜" + title
        if (now - at).total_seconds() > 1200:
            title = "恢复后补报｜" + title
        detail = str(item.get("detail") or "")[:260]
        related = RELATED.get(item["category"], "")
        if item["category"].startswith("选举"):
            related = "关注随后公布的财政、关税和科技政策，以及股指和芯片板块的反应。"
        if related:
            detail += "\n" + related
        if item.get("price_context"):
            detail += "\n" + item["price_context"]
        body = f"{at.astimezone(SG):%m-%d %H:%M}（北京时间） · {item['category']}\n{title}\n{detail}\n{item['url']}"
        if size + len(body.encode()) > 4800 or len(messages) >= 6:
            flush()
            size = 0
        messages.append((key, body, title))
        size += len(body.encode())
    flush()
    db.execute("DELETE FROM seen WHERE ts < ?", (tick - 14 * 86400,))
    db.execute("DELETE FROM outbox WHERE ts < ?", (tick - 30 * 86400,))
    db.execute("DELETE FROM evidence_level WHERE id NOT IN (SELECT id FROM seen)")
    db.execute("DELETE FROM delivery_hold WHERE id NOT IN (SELECT id FROM outbox)")


class UnconfirmedDelivery(Exception):
    """Relay reserved this message but could not confirm delivery. Do not resubmit."""


def send(payload):
    from cryptography.hazmat.primitives.serialization import load_pem_private_key

    body = payload.encode()
    stamp = str(int(time.time()))
    private_key = load_pem_private_key((STATE / "signer.pem").read_bytes(), password=None)
    signature = private_key.sign(stamp.encode() + b"\n" + body)
    req = urllib.request.Request(RELAY, data=body, headers={
        "User-Agent": "TradingWorkbench-Radar/1.0 (+https://tradingagents-board.pages.dev)",
        "Content-Type": "application/json", "X-Radar-Timestamp": stamp,
        "X-Radar-Signature": base64.b64encode(signature).decode(),
    })
    try:
        with urllib.request.urlopen(req, timeout=18) as res:
            outcome = json.load(res)
    except urllib.error.HTTPError as exc:
        detail = exc.read(256).decode("utf-8", errors="replace")
        try:
            reason = str(json.loads(detail).get("status", ""))[:40]
        except (ValueError, AttributeError):
            reason = detail if detail.startswith("error code:") else "non-json response"
        if exc.code in (409, 502) and reason == "unconfirmed":
            raise UnconfirmedDelivery("channel outcome unconfirmed") from exc
        raise RuntimeError(f"relay HTTP {exc.code}: {reason}") from exc
    if not (outcome.get("ok") and outcome.get("id") == json.loads(payload)["id"] and outcome.get("receipt")):
        raise RuntimeError("PushPlus returned no matching receipt")
    return str(outcome["receipt"])


def tick(db, now):
    stamp = int(now.timestamp())
    paused = db.execute("SELECT retry_at FROM cooldown WHERE provider='sec' AND retry_at>?", (stamp,)).fetchone()
    schedule = {name: (due, failed) for name, due, failed in db.execute("SELECT * FROM source_poll")}
    cached = db.execute("SELECT payload FROM source_cache WHERE provider='govcn'").fetchone()
    gov_cache = json.loads(cached[0]) if cached else {}
    intervals = {"sec": 120, "govcn": 120, "fed": 300, "cnbc": 180}
    due = {name for name in intervals if schedule.get(name, (0, False))[0] <= stamp}
    if paused:
        due.discard("sec")
    symbols = active_symbols(now)
    with ThreadPoolExecutor(max_workers=5) as pool:
        sec_recovery = bool(schedule.get("sec", (0, False))[1])
        news = pool.submit(collect_candidates, now, lookback_minutes=15, include_sec="sec" in due,
                           sec_lookback_minutes=60 if sec_recovery else 15, dual_wire=True)
        prices = pool.submit(fetch_quotes, symbols) if symbols else None
        official = {name: pool.submit(collect_official_candidates, now, providers=(name,),
                    gov_cache=gov_cache if name == "govcn" else None,
                    lookback_minutes=60 if schedule.get(name, (0, False))[1] else 15)
                    for name in ("govcn", "fed") if name in due}
        world = pool.submit(world_candidates, now) if "cnbc" in due else None
        try:
            items, errors = news.result()
            if sec_recovery:
                for item in items:
                    if item["key"].startswith("news:sec:"):
                        item["official_catchup"] = True
        except Exception as exc:
            items, errors = [], [f"news:{type(exc).__name__}"]
            if "sec" in due:
                errors.append("sec")
        try:
            quotes = prices.result() if prices else {}
        except Exception as exc:
            quotes = {}
            errors.append(f"quotes:{type(exc).__name__}")
        for name, future in official.items():
            try:
                updates, failures = future.result()
                for item in updates:
                    item["official_catchup"] = bool(schedule.get(name, (0, False))[1])
                items.extend(updates)
                errors.extend(failures)
            except Exception:
                errors.append(name)
        if world:
            try:
                items.extend(world.result())
            except Exception as exc:
                errors.append(f"cnbc:{type(exc).__name__}")
    missing = sorted(set(symbols) - quotes.keys())
    if missing:
        errors.append("quotes_missing:" + ",".join(missing))
    with db:
        if "govcn" in due:
            db.execute("INSERT OR REPLACE INTO source_cache VALUES ('govcn',?)", (json.dumps(gov_cache, ensure_ascii=False),))
        if "sec" in errors:
            db.execute("INSERT OR REPLACE INTO cooldown VALUES ('sec',?)", (stamp + 1800,))
        for name in due:
            failed = any(code.split(":")[0] == name for code in errors)
            interval = (1800 if name == "sec" else max(300, intervals[name] * 2)) if failed else intervals[name]
            db.execute("INSERT OR REPLACE INTO source_poll VALUES (?,?,?)", (name, stamp + interval, int(failed)))
        events = market_events(db, quotes, now)
        # Keep the most authoritative version when several levels arrive in the same poll.
        items.sort(key=lambda row: int(row.get("evidence_rank") or 0), reverse=True)
        for item in items:
            item["price_context"] = price_context(item, quotes, now, symbols)
        queue(db, [*items, *events], now)
    fresh_quotes = sum(0 <= (now - q[2]).total_seconds() <= 1200 for q in quotes.values())
    return {"quoteCount": len(quotes), "freshQuoteCount": fresh_quotes, "quoteExpected": len(symbols),
            "quoteSession": "scheduled_hours" if symbols else "closed",
            "polled": ["wall", "sina", *sorted(due)], "newsCandidates": len(items), "priceCandidates": len(events),
            "secCooldownUntil": paused[0] if paused else (stamp + 1800 if "sec" in errors else None), "errors": errors}


def deliver(db, now):
    stamp = int(now.timestamp())
    rows = db.execute("""SELECT o.id,payload,COALESCE(h.attempts,0) FROM outbox o LEFT JOIN delivery_hold h ON o.id=h.id
                      WHERE receipt IS NULL AND ts>=? AND COALESCE(h.next_try,0)<=? ORDER BY ts,o.id LIMIT 6""",
                      (stamp - 900, stamp)).fetchall()
    for key, payload, attempts in rows:
        try:
            receipt = send(payload)
        except Exception as exc:
            terminal = isinstance(exc, UnconfirmedDelivery)
            next_try = stamp + (86400 if terminal else min(480, 60 * (2 ** min(attempts, 3))))
            with db:
                db.execute("INSERT OR REPLACE INTO delivery_hold VALUES (?,?,?)", (key, next_try, attempts + 1))
            logging.warning("delivery %s id=%s error=%s", "unconfirmed" if terminal else "pending", key[:12], str(exc)[:100])
            continue
        with db:
            db.execute("UPDATE outbox SET receipt=? WHERE id=?", (receipt, key))
        logging.info("accepted id=%s receipt=%s", key[:12], receipt)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--canary", action="store_true")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    db = open_db()
    now = datetime.now(timezone.utc)
    if args.canary:
        with db:
            queue(db, [{"key": "personal-push-canary-v1", "title": "投资提醒已启用（送达测试）",
                        "at": now.isoformat(), "category": "测试",
                        "detail": "已启用 PushPlus 私聊。关注 Anthropic（ANT）、芯片 ETF、全球政策与主要市场异动。",
                        "url": "https://tradingagents-board.pages.dev/"}], now)
    else:
        status = tick(db, now)
        logging.info("tick %s", json.dumps(status, ensure_ascii=False))
    deliver(db, now)


if __name__ == "__main__":
    main()
