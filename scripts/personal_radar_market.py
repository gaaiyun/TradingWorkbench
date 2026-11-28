"""Minute observations of public Tencent quotes. Source timestamps govern alert eligibility."""

import math
import re
import urllib.request
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

# quote key, display label, intraday versus yesterday thresholds (percentage points)
WATCH = {
    "usANT": ("Anthropic ANT", 2, 5), "usNVDA": ("英伟达", 2, 4),
    "usSOXX": ("美股半导体 SOXX", 1.5, 3), "us.INX": ("标普500", 0.8, 2),
    "us.IXIC": ("纳斯达克综合", 1, 2), "ukUKX": ("富时100", 0.8, 2),
    "usGLD": ("黄金 ETF GLD", 1, 2), "usUSO": ("原油 ETF USO", 1.5, 3),
    "hkHSI": ("恒生指数", 1, 2), "hk03887": ("HashKey", 2, 5),
    "sh000300": ("沪深300", 0.8, 2), "sz399006": ("创业板指", 1.2, 3),
    "sh000688": ("科创50", 1.2, 3), "sh515880": ("通信ETF 515880", 1.5, 3),
    "sh512480": ("半导体ETF 512480", 1.5, 3), "sz159995": ("芯片ETF 159995", 1.5, 3),
}
SESSIONS = {
    "us": ("America/New_York", "%Y-%m-%d %H:%M:%S", [(570, 960)]),
    "hk": ("Asia/Hong_Kong", "%Y/%m/%d %H:%M:%S", [(570, 720), (780, 960)]),
    "uk": ("Europe/London", "%Y-%m-%d %H:%M:%S", [(480, 990)]),
    "cn": ("Asia/Shanghai", "%Y%m%d%H%M%S", [(570, 690), (780, 900)]),
}


def parse_quotes(raw):
    quotes = {}
    for key, data in re.findall(r'v_([\w.]+)="([^"]+)"', raw):
        if key not in WATCH:
            continue
        fields = data.split("~")
        zone, fmt, sessions = SESSIONS.get(key[:2], SESSIONS["cn"])
        try:
            at = datetime.strptime(fields[30], fmt).replace(tzinfo=ZoneInfo(zone))
            price, previous = float(fields[3]), float(fields[4])
        except (ValueError, IndexError):
            continue
        if all(math.isfinite(x) and x > 0 for x in (price, previous)):
            quotes[key] = (price, previous, at, sessions)
    return quotes


def fetch_quotes():
    url = "https://qt.gtimg.cn/q=" + ",".join(WATCH)
    with urllib.request.urlopen(url, timeout=6) as res:
        return parse_quotes(res.read(120000).decode("gb18030", errors="replace"))


def market_events(db, quotes, now):
    db.execute("CREATE TABLE IF NOT EXISTS samples (symbol TEXT, t INTEGER, price REAL, PRIMARY KEY(symbol,t))")
    db.execute("DELETE FROM samples WHERE t < ?", (int(now.timestamp()) - 1800,))
    events = []
    for symbol, (price, prev, at, sessions) in quotes.items():
        local_now = now.astimezone(at.tzinfo)
        if (not timedelta(0) <= now - at <= timedelta(minutes=20)
                or at.weekday() >= 5 or local_now.date() != at.date()):
            continue
        minute = at.hour * 60 + at.minute
        clock = local_now.hour * 60 + local_now.minute
        if not any(start <= minute <= end and start <= clock <= end for start, end in sessions):
            continue
        stamp = int(at.timestamp())
        label, fast_threshold, day_threshold = WATCH[symbol]
        anchor = db.execute("SELECT t,price FROM samples WHERE symbol=? AND t BETWEEN ? AND ? ORDER BY t LIMIT 1",
                            (symbol, stamp - 300, stamp - 45)).fetchone()
        db.execute("INSERT OR IGNORE INTO samples VALUES (?,?,?)", (symbol, stamp, price))
        daily = (price / prev - 1) * 100
        sign = "up" if daily > 0 else "down"
        steps = int(abs(daily) // day_threshold)
        tags = []
        if steps:
            tags.append((f"day/{sign}/{steps}", f"较昨收 {daily:+.2f}%"))
        if anchor:
            move = (price / anchor[1] - 1) * 100
            if abs(move) >= fast_threshold:
                direction = "up" if move > 0 else "down"
                tags.append((f"fast/{direction}/{stamp // 1800}", f"近 {(stamp-anchor[0])/60:.1f} 分钟 {move:+.2f}%"))
        for suffix, title in tags:
            events.append({"key": f"price/{symbol}/{at.date()}/{suffix}", "title": f"{label} {title}",
                           "at": at.astimezone(timezone.utc).isoformat(), "category": "行情",
                           "symbol": symbol, "url": "https://qt.gtimg.cn/q=" + symbol,
                           "detail": f"腾讯行情，报价 {price:g}，昨收 {prev:g}。"})
    return events
