"""Timestamped public news inputs for the personal radar (no keys or external packages)."""

from __future__ import annotations

import hashlib
import html
import json
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from urllib.request import Request, urlopen

UTC = timezone.utc
BEIJING = timezone(timedelta(hours=8))
WALL = "https://api-one-wscn.awtmt.com/apiv1/content/lives?channel=global-channel&limit=100"
SINA = "https://zhibo.sina.com.cn/api/zhibo/feed?zhibo_id=152&page=1&page_size=100"
SEC = "https://data.sec.gov/submissions/CIK0002130357.json"

_COMMENT = re.compile(
    r"解读|点评|展望|复盘|回顾|盘点|汇总|要闻一览|意味着什么|如何看|五大信号|释放.{0,6}信号|"
    r"分析师|策略师|研报|传言|谣言|网传|据悉|知情人士|消息人士|据传|或将|有望|"
    r"若当选|如果当选|民意调查|民调|出口民调|出口调查|投票站调查|可能|预计|尚未|否认|未证实"
)
_COUNCIL = re.compile(r"国务院常务会议|国常会")
_MEETING = re.compile(r"主持召开|召开.{0,7}常务会议|(?:国常会|常务会议)[：:、 ]?(?:研究|部署|审议|决定|要求|指出)")
_CN_AUTH = r"国务院(?:办公厅)?|中共中央(?:政治局)?|中国人民银行|中国央行|证监会|财政部|金融监管总局"
_POLICY = re.compile(r"关税|资本市场|股市|印花税|降准|降息|准备金率|房地产|地方债|特别国债|平准基金|稳市")
_CHAMBER = r"(?:参议院|众议院|参众两院|国会两院|上院|下院|议会)"
_CONTROL = rf"(?:拿下|控制|掌控|夺回|夺得|重夺|守住|保住|失去)(?:了|美国)?{_CHAMBER}"
_ELECTION = re.compile(rf"总统|大选|国会|{_CHAMBER}|首相|总理|公投|九合一|选举委员会|中选会")
_RESULT = re.compile(rf"当选|赢得|胜选|胜出|获胜|连任|取得.{{0,5}}多数|获得.{{0,5}}多数|公投通过|通过公投|落败|败选|{_CONTROL}")
_PROJECTION = re.compile(r"(?:美联社|路透社|媒体|电视台|广播公司|CNN|BBC).{0,18}(?:测算|预测|推算|宣布)")
_OFFICIAL = re.compile(r"(?:选举委员会|选举管理机构|中选会|选委会|选举当局|选务机关|内政部|宪法委员会|宪法法院).{0,12}(?:已公布|公布|发布|确认|宣布|认证)|(?:官方|最终|正式)(?:计票|选举|投票|开票)?结果(?:显示|证实|出炉|已公布|[：:])")
_BANK = re.compile(r"美联储|欧洲央行|日本央行|英国央行|英格兰银行|瑞士央行|加拿大央行|澳洲联储|澳大利亚央行|韩国央行|新西兰联储|中国央行|中国人民银行")
_RATE = re.compile(r"降息|加息|降准|上调.{0,8}利率|下调.{0,8}利率|利率.{0,8}(?:上调|下调)|维持.{0,12}利率.{0,5}不变|将.{0,12}利率维持|维持利率|利率保持不变")
_NO_DECISION = re.compile(r"呼吁|建议|讨论|考虑|概率|押注|预期|预测|支持|反对|不排除|暗示|前瞻|有意|希望")
_RATE_COMMENT = re.compile(r"官员|委员|理事|主席[：:]|行长[：:]|将于|明年|下次会议|此前|上次|自.{0,9}以来|(?:降息|加息|决议)后")
_CONFLICT = re.compile(
    r"签署.{0,12}(?:停火|和平)协议|达成.{0,10}停火协议|停火协议.{0,8}(?:生效|签署)|"
    r"宣布.{0,4}(?:全面停火|停火|宣战|进入战争状态)|(?:宣布|正式)(?:封锁|关闭|重开|重新开放)"
    r".{0,6}(?:霍尔木兹|苏伊士|曼德海峡)|(?:爆发|发动)全面战争"
)
_ANTH = re.compile(
    r"(?<![a-z])Anthropic(?![a-z])(?:公司)?[：:，,\s]*(?:已|正式|今日|今天)?"
    r"(?:向(?:美国)?(?:SEC|证交会|证监会|证券交易委员会))?"
    r"(?:宣布|公布|推出|发布|确认|提交|提起|披露|完成|签署|收购|下调|上调)", re.I
)


def _get(url):
    request = Request(url, headers={"User-Agent": "TradingWorkbench/1.0 (public news radar)"})
    with urlopen(request, timeout=6) as response:
        raw = response.read(2_000_001)
    if len(raw) > 2_000_000:
        raise ValueError("oversized response")
    return json.loads(raw)


def _clean(text):
    return " ".join(html.unescape(re.sub(r"<[^>]+>", "", text or "")).split())


def _classify(head, body):
    # Only trigger on the actual headline/lead, not historical context in a story.
    if _COMMENT.search(head) or _COMMENT.search(body[:38]):
        return None
    if _COUNCIL.search(head) and _MEETING.search(head) and _POLICY.search(head + body):
        return "国内重大政策", "同次国常会合并；为媒体转发的会议消息", "council"
    if re.match(rf"(?:{_CN_AUTH})", head) and _POLICY.search(head) and re.search(
        r"宣布|印发|正式发布|发布.{0,20}(?:通知|规定|措施|方案)|决定|审议通过|下调|上调|暂停征收|免征", head
    ) and not _NO_DECISION.search(head):
        return "国内重大政策", "媒体报道的主管部门决定", ""
    if _ELECTION.search(head) and _RESULT.search(head + body[:90]):
        evidence = head + body[:120]
        if _OFFICIAL.search(evidence) and not re.search(r"将(?:于|在)?[^。；]{0,14}(?:公布|发布|确认)|(?:公布|发布)(?:时间|安排)", evidence):
            return "选举·官方结果", "媒体引述选举机关或正式计票结果", ""
        if _PROJECTION.search(head + body[:90]):
            if "预测" in head + body[:90] and not re.search(r"开票|计票|投票结束|投票已结束", head + body[:90]):
                return None  # A pre-election forecast is not a call on the result.
            return "选举·媒体测算", "媒体已作胜负判定；不是选举机关公布的正式结果", ""
        if re.search(rf"宣布(?:自己)?胜选|宣布(?:自己)?获胜|承认败选|党宣布(?:已|成功)?{_CONTROL}", head):
            return "选举·当事人声明", "候选人表态；不是正式计票结果", ""
        return None
    if re.search(r"总统|总理|首相|政府|国王|国会|议会", head) and re.search(
        r"宣布(?:辞职|解散议会|提前(?:举行)?大选|实施戒严|解除戒严|进入紧急状态)|通过.{0,8}不信任案", head
    ):
        return "全球重大政治", "媒体报道的已宣布事项", ""
    if _BANK.match(head) and _RATE.search(head) and not (_NO_DECISION.search(head) or _RATE_COMMENT.search(head)):
        return "央行决议", "媒体报道的利率或存款准备金决定", ""
    if _CONFLICT.search(head) and not re.search(r"敦促|呼吁|力争|争取|指责|威胁|拒绝|希望|接近|将要|未能|防止|要求", head):
        return "重大冲突", "媒体报道的重大冲突或通航状态变化", ""
    if _ANTH.search(head):
        return "Anthropic 公司动态", "媒体报道的公司声明；不是监管披露原件", ""
    if (re.search(r"白宫|美国总统|特朗普|美国商务部|美国财政部|欧盟委员会|欧盟理事会", head)
            and re.search(r"宣布|签署|发布|正式实施", head)
            and re.search(r"关税|出口管制|出口限制|制裁|芯片禁令", head)
            and not _NO_DECISION.search(head)):
        return "贸易与出口政策", "媒体报道的政策行动；适用产品、对象及生效日以原件为准", ""
    return None


def _wire(rows, provider, now, cutoff):
    result = []
    for raw_head, raw_body, at, url in rows:
        if not cutoff <= at <= now:
            continue
        body, head = _clean(raw_body), _clean(raw_head)
        if not head:
            bracket = re.match(r"^【([^】]+)】(.*)", body)
            if bracket:
                head, body = bracket.groups()
            else:
                head = re.split(r"[。！？\n]", body, maxsplit=1)[0][:150]
        match = _classify(head, body)
        if not match:
            continue
        category, evidence, group = match
        day = at.astimezone(BEIJING).date().isoformat()
        if group == "council":
            key = "news:cn-council:" + day
        else:
            # Same-headline reprints survive a switch to the backup provider.
            digest = hashlib.sha256(re.sub(r"[\W_]", "", head).lower().encode()).hexdigest()[:20]
            key = f"news:{day}:{digest}"
        result.append({
            "key": key, "title": head[:160], "url": url, "at": at.astimezone(UTC).isoformat(),
            "detail": f"{provider}｜{evidence}。{body[:160]}", "category": category,
            "symbol": "ANT" if category.startswith("Anthropic") else "",
        })
    return result


def _wall(fetch, now, cutoff):
    # The live feed returns an empty page for a cursor ahead of its newest release.
    # A cursor is useful only when replaying an earlier point in time.
    url = WALL if (datetime.now(UTC) - now) < timedelta(minutes=2) else f"{WALL}&cursor={int(now.timestamp()) + 1}"
    data = fetch(url)
    rows = data["data"]["items"]
    if data["code"] != 20000 or not isinstance(rows, list) or not rows:
        raise ValueError("unavailable wire")
    parsed = [
        (x["title"], x["content_text"], datetime.fromtimestamp(x["display_time"], UTC),
         f"https://wallstreetcn.com/livenews/{int(x['id'])}")
        for x in rows
    ]
    return _wire(parsed, "华尔街见闻快讯", now, cutoff)


def _sina(fetch, now, cutoff):
    data = fetch(SINA)["result"]
    rows = data["data"]["feed"]["list"]
    if data["status"]["code"] != 0 or not isinstance(rows, list) or not rows:
        raise ValueError("unavailable wire")
    parsed = [
        ("", x["rich_text"], datetime.fromisoformat(x["create_time"]).replace(tzinfo=BEIJING),
         f"https://finance.sina.com.cn/7x24/?id={int(x['id'])}")
        for x in rows if not int(x.get("is_delete", 0))
    ]
    return _wire(parsed, "新浪财经快讯", now, cutoff)


_FORMS = {"8-K": "重大事项报告", "10-K": "年度报告", "10-Q": "季度报告", "S-1": "首次公开发行注册文件", "424B4": "最终招股书"}


def _sec(fetch, now, cutoff):
    company = fetch(SEC)
    if int(company["cik"]) != 2130357 or "Anthropic" not in company["name"]:
        raise ValueError("unexpected issuer")
    data = company["filings"]["recent"]
    result = []
    for form, stamp, accession in zip(data["form"], data["acceptanceDateTime"], data["accessionNumber"], strict=True):
        if form not in _FORMS or not re.fullmatch(r"\d{10}-\d{2}-\d{6}", accession):
            continue
        at = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
        if at.tzinfo is None or not cutoff <= at <= now:
            continue
        url = f"https://www.sec.gov/Archives/edgar/data/2130357/{accession.replace('-', '')}/{accession}-index.htm"
        result.append({"key": "news:sec:" + accession, "title": f"Anthropic 向 SEC 提交{_FORMS[form]}（{form}）",
                       "url": url, "at": at.astimezone(UTC).isoformat(), "category": "Anthropic 官方披露",
                       "symbol": "ANT", "detail": "来源：SEC EDGAR；时间为文件受理时间。具体内容以申报原件为准。"})
    return result


def collect_candidates(now: datetime, *, lookback_minutes: int = 90, fetch=None,
                       include_sec: bool = True) -> tuple[list[dict], list[str]]:
    """Use provider publication/acceptance time, never scraping time or date-only news."""
    if now.tzinfo is None or lookback_minutes <= 0:
        raise ValueError("timezone-aware now and positive lookback required")
    now = now.astimezone(UTC)
    cutoff = now - timedelta(minutes=lookback_minutes)
    fetch = _get if fetch is None else fetch
    failures = []

    def load(provider):
        try:
            return provider(fetch, now, cutoff), None
        except (OSError, ValueError, TypeError, KeyError, OverflowError):
            return [], provider.__name__.lstrip("_")

    if include_sec:
        with ThreadPoolExecutor(max_workers=2) as pool:
            (wire, wire_error), (filings, sec_error) = pool.map(load, (_wall, _sec))
    else:
        wire, wire_error = load(_wall)
        filings, sec_error = [], None
    if wire_error:
        failures.append(wire_error)
        wire, wire_error = load(_sina)
    failures.extend(code for code in (wire_error, sec_error) if code)
    unique = {}
    # Earliest wire item carries the event timestamp even if reposted separately later.
    for item in sorted(wire + filings, key=lambda x: x["at"]):
        previous = unique.setdefault(item["key"], item)
        if (previous is not item and item["key"].startswith("news:cn-council:")
                and "同场更新" not in previous["detail"] and _POLICY.search(item["title"])):
            previous["detail"] = f"同场更新（{item['at'][11:16]} UTC）：{item['title']}。{previous['detail']}"
    return sorted(unique.values(), key=lambda x: x["at"], reverse=True), failures
