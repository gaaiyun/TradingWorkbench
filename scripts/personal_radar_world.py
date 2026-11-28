"""High-impact headlines from CNBC's public international RSS for private, non-commercial alerts."""
import hashlib
import re
from datetime import timedelta, timezone
from email.utils import parsedate_to_datetime
from urllib.parse import urlsplit
from urllib.request import Request, urlopen
from xml.etree import ElementTree as ET

FEED = "https://www.cnbc.com/id/100727362/device/rss/rss.html"
_NO_CALL = re.compile(r"\?|\b(?:could|may|might|would|likely|rumou?r|expected|prediction|odds|polls?|preview|explainer|opinion|if|whether|denies?|denied|not|urges?|talks?)\b|\b(?:set|poised|on track) to\b", re.I)
_PARTY = r"(?:Republicans|Democrats|GOP|Republican Party|Democratic Party)"
_CONGRESS = re.compile(rf"^(?:US |U\.S\. )?{_PARTY}\s+(?:(?:projected to|projected to have)\s+)?(?:win|take|keep|retain|lose|regain|capture|hold|flip)s?\s+(?:back\s+)?(?:control of\s+|majority in\s+)?(?:the\s+)?(?:US\s+|U\.S\.\s+)?(?:House|Senate|Congress)\b", re.I)


def classify(title):
    if _NO_CALL.search(title):
        return None
    if _CONGRESS.search(title):
        return "选举·媒体报道", "美国国会席位控制权出现结果报道；以正式计票为准"
    if re.match(r"^(?:Anthropic)\s+(?:launches|releases|files|raises|announces|acquires|reports|cuts|signs)\b", title, re.I):
        return "Anthropic 公司动态", "Anthropic 出现公司行动报道；留意 ANT 及随后官方申报"
    if re.match(r"^(?:U\.S\.|US|White House|Trump|China|Beijing|EU|European Union)\s+(?:imposes|impose|raises|cuts|lifts|suspends|bans|blocks|signs|announces)\b", title, re.I) and re.search(r"tariff|sanction|export|chip ban", title, re.I):
        return "贸易与出口政策", "出现贸易或出口政策行动报道"
    if re.search(r"\b(?:agrees? to|signs?|reaches?) (?:a |an )?(?:ceasefire|peace deal)\b|\b(?:strait of hormuz|suez canal) (?:is |has been )?(?:closed|reopens|shut)\b", title, re.I):
        return "重大冲突", "出现停火协议或关键航道变化报道"
    return None


def candidates(now, *, fetch=None):
    if fetch is None:
        req = Request(FEED, headers={"User-Agent": "TradingWorkbench-Radar/1.0 (+https://tradingagents-board.pages.dev)"})
        with urlopen(req, timeout=6) as response:
            raw = response.read(768001)
    else:
        raw = fetch(FEED)
    if len(raw) > 768000:
        raise ValueError("oversize RSS")
    rows = ET.fromstring(raw).findall("./channel/item")
    if not rows:
        raise ValueError("empty RSS")
    events = []
    for row in rows:
        title = " ".join((row.findtext("title") or "").split())
        url = (row.findtext("link") or "").strip()
        if urlsplit(url).scheme != "https" or urlsplit(url).netloc != "www.cnbc.com":
            continue
        try:
            at = parsedate_to_datetime(row.findtext("pubDate") or "")
        except (ValueError, TypeError, OverflowError):
            continue
        if at.tzinfo is None or not timedelta(0) <= now - at <= timedelta(minutes=15):
            continue
        matched = classify(title)
        if matched:
            category, cue = matched
            key = hashlib.sha256(url.encode()).hexdigest()[:24]
            events.append({"key": "news:cnbc:" + key, "at": at.astimezone(timezone.utc).isoformat(),
                           "title": cue, "category": category, "url": url, "detail": "CNBC 国际版（媒体）｜" + title[:180]})
    return events
