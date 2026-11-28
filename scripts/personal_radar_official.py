"""Official-publication adapters for the personal radar. All times are publication times."""

from __future__ import annotations

import html
import json
import re
from concurrent.futures import ThreadPoolExecutor
from contextlib import suppress
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from fractions import Fraction
from html.parser import HTMLParser
from http.client import HTTPException
from urllib.request import Request, urlopen
from xml.etree import ElementTree

UTC = timezone.utc
BEIJING = timezone(timedelta(hours=8))
GOV = "https://www.gov.cn/yaowen/liebiao/YAOWENLIEBIAO.json"
FED = "https://www.federalreserve.gov/feeds/press_monetary.xml"
_GOV_ARTICLE = re.compile(r"https://www\.gov\.cn/(?:yaowen/liebiao|zhengce(?:/content)?)/\d{6}/content_(\d+)\.htm")
_FED_ARTICLE = re.compile(r"https://www\.federalreserve\.gov/newsevents/pressreleases/(monetary\d{8}[a-z])\.htm")
_MEETING = re.compile(r"主持召开国务院常务会议|中共中央政治局召开会议")
_TOPIC = re.compile(r"经济形势|宏观政策|财政政策|货币政策|扩大内需|资本市场|房地产|地方债|降准|降息|关税|出口管制|印花税|特别国债|金融稳定|稳增长")
_POLICY = re.compile(r"^(?:中共中央|国务院(?:办公厅)?|中国人民银行|财政部|证监会).{0,55}(?:印发|发布|决定|关于)")
_COMMENT = re.compile(r"解读|图解|一图|回顾|评论|答记者问|视频|综述|吹风会|将召开|拟召开")
_FAIL = (OSError, HTTPException, ValueError, KeyError, TypeError, ElementTree.ParseError)
_MAX_BYTES = 600_000


def _get(url):
    request = Request(url, headers={"User-Agent": "TradingWorkbench/1.0 (public news radar)"})
    with urlopen(request, timeout=4) as response:
        if response.geturl() != url:
            raise ValueError("unexpected redirected source")
        raw = response.read(_MAX_BYTES + 1)
    if len(raw) > _MAX_BYTES:
        raise ValueError("oversized official response")
    return raw


def _text(raw):
    return raw.decode("utf-8-sig") if isinstance(raw, bytes) else raw


def _clean(value):
    return " ".join(html.unescape(re.sub(r"<[^>]+>", " ", value or "")).split())


class _Head(HTMLParser):
    def __init__(self):
        super().__init__()
        self.meta = {}

    def handle_starttag(self, tag, attrs):
        if tag == "meta":
            fields = dict(attrs)
            self.meta[(fields.get("name") or "").lower()] = fields.get("content") or ""


def _gov_candidate(raw, head, url, uid):
    page = _text(raw)
    meta = _Head()
    meta.feed(re.split(r"</head\s*>", page, maxsplit=1, flags=re.I)[0])
    if meta.meta.get("manuscriptid") != uid:
        raise ValueError("government article ID mismatch")
    # Neither the date-only listing, page generation time, nor lastmodifiedtime is publication.
    stamp = meta.meta.get("firstpublishedtime", "")
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}-\d{2}:\d{2}:\d{2}", stamp):
        raise ValueError("missing government publication time")
    at = datetime.strptime(stamp, "%Y-%m-%d-%H:%M:%S").replace(tzinfo=BEIJING)
    summary = _clean(meta.meta.get("description"))
    if not _TOPIC.search(head + summary):
        return None
    source = re.search(r'<span\b[^>]*>\s*来源\s*[：:]\s*(.*?)</span>', page, re.S | re.I)
    attribution = _clean(source[1])[:40] if source else ""
    if not attribution:
        return None  # Government hosting alone does not identify the author.
    if "国务院常务会议" in head:
        key = "news:cn-council:" + at.date().isoformat()
    else:
        key = "news:govcn:" + uid
    return {"key": key, "at": at.astimezone(UTC).isoformat(), "url": url, "title": head[:160],
            "category": "国内重大政策", "symbol": "", "evidence_rank": 3,
            "detail": f"中国政府网刊载；稿源：{attribution}。{summary[:175]}"}


def _govcn(fetch, now, cutoff, cache):
    rows = json.loads(_text(fetch(GOV)))
    if not isinstance(rows, list) or not rows:
        raise ValueError("missing government list")
    first, last = (x.astimezone(BEIJING).date().isoformat() for x in (cutoff, now))
    out, failures = [], []
    calls = 0
    for row in rows:
        head, url, day = row["TITLE"], row["URL"], row["DOCRELPUBTIME"]
        if not first <= day <= last or _COMMENT.search(head):
            continue
        article = _GOV_ARTICLE.fullmatch(url)
        if not article or not (_MEETING.search(head) or (_POLICY.search(head) and _TOPIC.search(head))):
            continue
        uid = article[1]
        if uid not in cache:
            if calls >= 2:
                continue  # Bound request fan-out; cached entries do not consume this allowance.
            calls += 1
            try:
                cache[uid] = _gov_candidate(fetch(url), head, url, uid)
            except _FAIL:
                failures = ["govcn"]
                continue
            while len(cache) > 64:
                del cache[next(iter(cache))]
        item = cache[uid]
        if item and cutoff <= datetime.fromisoformat(item["at"]) <= now:
            out.append(item)
    return out, failures


_NUMBER = r"\d+(?:(?:-| )\d+/\d+|\.\d+|/\d+)?"
_TARGET = re.compile(
    r"the Committee decided to (maintain|lower|raise|keep) the target range for the federal funds rate"
    rf"(?: by {_NUMBER} percentage points?)? (?:at|to) ({_NUMBER}) to ({_NUMBER}) percent", re.I)


def _rate_detail(raw):
    match = _TARGET.search(_clean(_text(raw)))
    if not match:
        return ""
    # Require the committee decision clause; never extract a dissenting member's preference.
    def percent(value):
        return float(sum(Fraction(part) for part in re.split(r"[- ]", value)))
    try:
        low, high = percent(match[2]), percent(match[3])
    except (ValueError, ZeroDivisionError):
        return ""
    if not 0 <= low <= high <= 30:
        return ""
    verb = {"maintain": "维持", "keep": "维持", "lower": "下调", "raise": "上调"}[match[1].lower()]
    prep = "在" if verb == "维持" else "至"
    return f"；联邦基金利率目标区间{verb}{prep} {low:g}%–{high:g}%"


def _fed(fetch, now, cutoff):
    channel = ElementTree.fromstring(fetch(FED)).find("channel")
    if channel is None or "FRB:" not in (channel.findtext("title") or "") or not channel.findall("item"):
        raise ValueError("missing Fed monetary releases")
    out = []
    for row in channel.findall("item"):
        title = _clean(row.findtext("title"))
        if title == "Federal Reserve issues FOMC statement":
            name, kind = "美联储发布议息声明", "statement"
        elif title.startswith("Minutes of the Federal Open Market Committee,"):
            name, kind = "美联储公布上次议息会议纪要", "minutes"
        elif "release economic projections" in title and "Federal Open Market Committee" in title:
            name, kind = "美联储公布经济及利率预测", "projections"
        else:
            continue  # Exclude schedules, routine discount-rate minutes and personnel news.
        url, guid, stamp = row.findtext("link") or "", row.findtext("guid"), row.findtext("pubDate") or ""
        article = _FED_ARTICLE.fullmatch(url)
        if not article or guid != url or not re.search(r"\d{1,2}:\d{2}:\d{2}", stamp):
            continue
        at = parsedate_to_datetime(stamp)
        if at.tzinfo is None or not cutoff <= at <= now:
            continue
        if kind == "statement":
            # RSS independently confirms the release even if article retrieval fails.
            with suppress(*_FAIL):
                name += _rate_detail(fetch(url))
        detail = {"statement": "本次会议的政策决定以所附声明原文为准。",
                  "minutes": "这是对已结束会议的记录，不是新的利率决定。",
                  "projections": "这是参会者的预测，不代表委员会对未来利率的承诺。"}[kind]
        out.append({"key": "news:fed:" + article[1], "at": at.astimezone(UTC).isoformat(),
                    "url": url, "title": name, "category": "央行决定" if kind == "statement" else "美联储政策发布",
                    "detail": "美联储官网；" + detail, "symbol": "", "evidence_rank": 3})
    return out, []


def collect_official_candidates(now, *, lookback_minutes=15, providers=("govcn", "fed"),
                                fetch=None, gov_cache=None):
    """Return (items, failed provider names). Optional bounded JSON-safe gov_cache survives polls."""
    if now.utcoffset() is None or lookback_minutes <= 0:
        raise ValueError("timezone-aware now and positive lookback required")
    selected = tuple(dict.fromkeys(providers))
    if not set(selected) <= {"govcn", "fed"}:
        raise ValueError("unknown official provider")
    now = now.astimezone(UTC)
    cutoff = now - timedelta(minutes=lookback_minutes)
    fetch = _get if fetch is None else fetch

    def read(provider):
        try:
            if provider == "govcn":
                return _govcn(fetch, now, cutoff, {} if gov_cache is None else gov_cache)
            return _fed(fetch, now, cutoff)
        except _FAIL:
            return [], [provider]

    if len(selected) > 1:
        with ThreadPoolExecutor(max_workers=2) as pool:
            batches = list(pool.map(read, selected))
    else:
        batches = [read(name) for name in selected]
    unique = {item["key"]: item for items, _ in batches for item in items}
    return sorted(unique.values(), key=lambda x: x["at"], reverse=True), [e for _, errors in batches for e in errors]
