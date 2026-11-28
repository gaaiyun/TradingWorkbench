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

from personal_radar_market import WATCH, fetch_quotes, market_events
from personal_radar_sources import collect_candidates

STATE = Path(os.environ.get("RADAR_STATE", "/state"))
RELAY = "https://tradingagents-board.pages.dev/api/personal-push"
SG = ZoneInfo("Asia/Singapore")
RELATED = {
    "国内重大政策": "可对照沪深300、科创50和三只行业 ETF 的盘中反应。",
    "央行决议": "可对照标普500、黄金 ETF 与半导体板块。",
    "贸易与出口政策": "涉及 AI 算力时，可对照 ANT、NVDA 和 SOXX。",
    "重大冲突": "可观察原油 ETF、黄金 ETF 与主要股指是否同步异动。",
}


def open_db():
    db = sqlite3.connect(STATE / "alerts.sqlite", timeout=5)
    db.executescript("""
        CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY, ts INTEGER);
        CREATE TABLE IF NOT EXISTS outbox
        (id TEXT PRIMARY KEY, ts INTEGER, payload TEXT, receipt TEXT);
        CREATE TABLE IF NOT EXISTS cooldown (provider TEXT PRIMARY KEY, retry_at INTEGER NOT NULL);
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
        if at.tzinfo is None or not 0 <= (now - at).total_seconds() <= 1200:
            continue
        key = str(item["key"])
        if not db.execute("INSERT OR IGNORE INTO seen VALUES (?,?)", (key, tick)).rowcount:
            continue
        title = str(item["title"])[:120]
        detail = str(item.get("detail") or "")[:260]
        related = RELATED.get(item["category"], "")
        if item["category"].startswith("选举"):
            related = "关注随后公布的财政、关税和科技政策，以及股指和芯片板块的反应。"
        if related:
            detail += "\n" + related
        body = f"{at.astimezone(SG):%m-%d %H:%M}（北京时间） · {item['category']}\n{title}\n{detail}\n{item['url']}"
        if size + len(body.encode()) > 4800 or len(messages) >= 6:
            flush()
            size = 0
        messages.append((key, body, title))
        size += len(body.encode())
    flush()
    db.execute("DELETE FROM seen WHERE ts < ?", (tick - 14 * 86400,))
    db.execute("DELETE FROM outbox WHERE ts < ?", (tick - 30 * 86400,))


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
        raise RuntimeError(f"relay HTTP {exc.code}: {reason}") from exc
    if not (outcome.get("ok") and outcome.get("id") == json.loads(payload)["id"] and outcome.get("receipt")):
        raise RuntimeError("PushPlus returned no matching receipt")
    return str(outcome["receipt"])


def tick(db, now):
    stamp = int(now.timestamp())
    paused = db.execute("SELECT retry_at FROM cooldown WHERE provider='sec' AND retry_at>?", (stamp,)).fetchone()
    with ThreadPoolExecutor(max_workers=2) as pool:
        news = pool.submit(collect_candidates, now, lookback_minutes=15, include_sec=not paused)
        prices = pool.submit(fetch_quotes)
        try:
            items, errors = news.result()
        except Exception as exc:
            items, errors = [], [f"news:{type(exc).__name__}"]
        try:
            quotes = prices.result()
        except Exception as exc:
            quotes = {}
            errors.append(f"quotes:{type(exc).__name__}")
    missing = sorted(WATCH.keys() - quotes.keys())
    if missing:
        errors.append("quotes_missing:" + ",".join(missing))
    with db:
        if "sec" in errors:
            db.execute("INSERT OR REPLACE INTO cooldown VALUES ('sec',?)", (stamp + 1800,))
        events = market_events(db, quotes, now)
        queue(db, [*items, *events], now)
    return {"quoteCount": len(quotes), "newsCandidates": len(items), "priceCandidates": len(events),
            "secCooldownUntil": paused[0] if paused else (stamp + 1800 if "sec" in errors else None), "errors": errors}


def deliver(db, now):
    rows = db.execute("SELECT id,payload FROM outbox WHERE receipt IS NULL AND ts>=? ORDER BY ts,id LIMIT 6",
                      (int(now.timestamp()) - 900,)).fetchall()
    for key, payload in rows:
        try:
            receipt = send(payload)
        except Exception as exc:
            logging.warning("delivery pending id=%s error=%s", key[:12], str(exc)[:100])
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
