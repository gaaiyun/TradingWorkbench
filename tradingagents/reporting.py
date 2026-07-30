"""Reusable report-tree writer shared by the CLI and the programmatic API.

Writes a run's per-section markdown (analysts, research, trading, risk,
portfolio) plus a consolidated ``complete_report.md`` under ``save_path``. The
CLI and ``TradingAgentsGraph.save_reports`` both call this, so a headless / API
run produces the same on-disk report tree a CLI run does.
"""

import hashlib
import json
import math
import re
from datetime import datetime, timezone
from pathlib import Path

from tradingagents.evidence import market_trade_date, validate_evidence_packet


class ReportValidationError(ValueError):
    """Raised when evidence explicitly says a report must not be rated."""


_EVIDENCE_CITATION_RE = re.compile(r"\[([^\[\]\r\n]+)\]")
_EVIDENCE_CITATION_TOKEN_RE = re.compile(
    r"^(M|I|D|CA|N|S)(\d+)(?:\s*-\s*(?:(M|I|D|CA|N|S))?(\d+))?$",
    re.IGNORECASE,
)
_EVIDENCE_LIKE_CONTAINER_RE = re.compile(r"^\s*[A-Z]{1,3}\d", re.IGNORECASE)
_MAX_EVIDENCE_CITATION_CONTAINER_LENGTH = 4_096
_MAX_EVIDENCE_CITATION_NUMBER_DIGITS = 9
_MAX_EVIDENCE_IDS_PER_CONTAINER = 2_000
_MARKDOWN_LINK_RE = re.compile(
    r"\[[^\[\]\r\n]{0,16384}\]"
    r"\(https?://[^()\r\n]{1,65536}\)",
)
_CLAIM_GAP_PATTERN = r"\s{0,16}"
_CLAIM_WORD_GAP_PATTERN = r"\s{1,16}"
_NUMERIC_CLAIM_RE = re.compile(
    rf"(?<![A-Za-z0-9])(?:[$¥£€]{_CLAIM_GAP_PATTERN})?"
    r"[-+]?\d+(?:,\d{3})*(?:\.\d+)?%?"
)
_NUMERIC_VALUE_PATTERN = (
    rf"(?:[$¥£€]{_CLAIM_GAP_PATTERN})?"
    r"[-+]?\d+(?:,\d{3})*(?:\.\d+)?"
)
_PERCENT_VALUE_PATTERN = (
    rf"\d+(?:\.\d+)?{_CLAIM_GAP_PATTERN}%"
    rf"(?:{_CLAIM_GAP_PATTERN}[-–—~至]{_CLAIM_GAP_PATTERN}"
    rf"\d+(?:\.\d+)?{_CLAIM_GAP_PATTERN}%)?"
)
_PRICE_TARGET_TERM_PATTERN = (
    rf"(?:price{_CLAIM_GAP_PATTERN}target|"
    rf"target{_CLAIM_GAP_PATTERN}price|目标价|目标价格)"
)
_ALLOCATION_TERM_PATTERN = (
    rf"(?:position{_CLAIM_GAP_PATTERN}(?:size|sizing)|"
    r"allocation|exposure|weight|"
    r"持仓|底仓|仓位|配置|减仓|加仓|清仓)"
)
_ALLOCATION_CONNECTOR_PATTERN = (
    rf"(?:{_CLAIM_GAP_PATTERN}(?:[:：=]|"
    r"(?:is|at|to|of|should\s+be)\b|为|建议为|至|降至|减至|增至|提高至|"
    r"调整至|控制在|维持在?|保持在?|不超过|不低于|上限为|下限为|"
    rf"削减至不超过))?{_CLAIM_GAP_PATTERN}"
)
_NUMERIC_RECOMMENDATION_DISCLAIMER_RE = re.compile(
    rf"\b(?:does|do){_CLAIM_WORD_GAP_PATTERN}not"
    rf"{_CLAIM_WORD_GAP_PATTERN}(?:set|provide|recommend)"
    rf"{_CLAIM_WORD_GAP_PATTERN}(?:an?{_CLAIM_WORD_GAP_PATTERN})?"
    rf"(?:{_NUMERIC_VALUE_PATTERN}{_CLAIM_GAP_PATTERN}"
    rf"{_PRICE_TARGET_TERM_PATTERN}|"
    rf"{_PRICE_TARGET_TERM_PATTERN}{_CLAIM_GAP_PATTERN}"
    rf"(?:of|at|to)?{_CLAIM_GAP_PATTERN}"
    rf"{_NUMERIC_VALUE_PATTERN}|"
    rf"{_PERCENT_VALUE_PATTERN}{_CLAIM_GAP_PATTERN}"
    rf"(?:allocation|position|exposure|weight))|"
    rf"\bno{_CLAIM_WORD_GAP_PATTERN}{_PRICE_TARGET_TERM_PATTERN}"
    rf"{_CLAIM_GAP_PATTERN}(?:of|at|to)?{_CLAIM_GAP_PATTERN}"
    rf"{_NUMERIC_VALUE_PATTERN}{_CLAIM_WORD_GAP_PATTERN}is"
    rf"{_CLAIM_WORD_GAP_PATTERN}(?:set|provided|recommended)|"
    rf"本报告不(?:设|提供|建议){_PRICE_TARGET_TERM_PATTERN}"
    rf"{_CLAIM_GAP_PATTERN}{_NUMERIC_VALUE_PATTERN}(?:元)?",
    re.IGNORECASE,
)
_NON_CLAIM_NUMERIC_CONTEXT = (
    # ISO/Chinese dates and timestamps are metadata, not numeric assertions.
    re.compile(
        r"(?<!\d)(?:19|20)\d{2}-\d{1,2}-\d{1,2}"
        r"(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?",
    ),
    re.compile(r"(?<!\d)(?:19|20)\d{2}/\d{1,2}/\d{1,2}"),
    re.compile(
        r"(?<![\d.])(?:0?[1-9]|1[0-2])[-/]"
        r"(?:0?[1-9]|[12]\d|3[01])(?!\d)",
    ),
    re.compile(
        r"(?<!\d)(?:19|20)\d{2}年\s*\d{1,2}月(?:\s*\d{1,2}日)?",
    ),
    re.compile(r"(?<!\d)\d{1,2}月\s*\d{1,2}日"),
    re.compile(
        r"(?i)(?<!\d)(?:19|20)\d{2}\s*(?:年\s*)?"
        r"(?:第\s*)?(?:[1-4]\s*季度|Q[1-4])(?!\d)",
    ),
    # Hashes and supported instrument identifiers are structural metadata.
    re.compile(r"(?i)(?<![A-Za-z0-9])[0-9a-f]{32,}(?![A-Za-z0-9])"),
    re.compile(
        r"(?i)(?<![A-Za-z0-9])(?:\d{6}\.(?:SS|SZ)|\d{1,5}\.HK)"
        r"(?![A-Za-z0-9])",
    ),
    # Markdown heading/list ordinals are not research values.
    re.compile(r"^\s*(?:#{1,6}\s+)?\d+(?:\.\d+)*[.)、．]?"),
    re.compile(r"(?<![A-Za-z0-9])\(\d{1,2}\)(?=\s)"),
    re.compile(r"(?m)(?:^|[；;])\s*\d{1,2}[.)、．](?=\s)"),
    # Indicator look-back periods and canonical parameter tuples.
    re.compile(
        r"(?i)(?<!\d)\d+\s*(?:日|天|周|月)?\s*"
        r"(?=(?:均线|EMA|SMA|MA|ATR|RSI|MACD|KDJ|布林|"
        r"移动平均线|指数移动平均线|简单移动平均线|"
        r"已实现波动率|realized\s*volatility))",
    ),
    re.compile(r"(?i)(?<!\d)\d+\s*(?:EMA|SMA|MA|ATR)\b"),
    re.compile(r"(?i)\b(?:RSI|ATR)\s*\(\s*\d+\s*\)"),
    re.compile(r"(?i)\bMACD\s*\d+\s*[-/]\s*\d+(?:\s*[-/]\s*\d+)?"),
    re.compile(
        r"(?i)(?<![A-Za-z0-9])"
        r"(?:RSI|ATR|ADX|KDJ|MA|SMA|EMA|realizedVolatility)\d+"
        r"(?![A-Za-z0-9])"
    ),
    re.compile(r"(?<=已实现波动率)\d+(?![A-Za-z0-9])"),
)
_PRICE_TARGET_RE = re.compile(
    rf"{_PRICE_TARGET_TERM_PATTERN}{_CLAIM_GAP_PATTERN}"
    rf"(?:(?:is|of|at|to|为|至|上调至|下调至|区间)"
    rf"{_CLAIM_GAP_PATTERN})?"
    rf"[:：=]?{_CLAIM_GAP_PATTERN}{_NUMERIC_VALUE_PATTERN}|"
    rf"{_NUMERIC_VALUE_PATTERN}{_CLAIM_GAP_PATTERN}"
    rf"{_PRICE_TARGET_TERM_PATTERN}",
    re.IGNORECASE,
)
_ALLOCATION_RE = re.compile(
    rf"{_ALLOCATION_TERM_PATTERN}{_ALLOCATION_CONNECTOR_PATTERN}"
    rf"{_PERCENT_VALUE_PATTERN}|"
    rf"{_PERCENT_VALUE_PATTERN}{_CLAIM_GAP_PATTERN}"
    rf"(?:的{_CLAIM_GAP_PATTERN})?{_ALLOCATION_TERM_PATTERN}|"
    rf"(?:建议{_CLAIM_GAP_PATTERN})?持有{_CLAIM_GAP_PATTERN}"
    rf"{_PERCENT_VALUE_PATTERN}|"
    rf"持仓比例{_CLAIM_GAP_PATTERN}{_PERCENT_VALUE_PATTERN}|"
    rf"\bkeep{_CLAIM_WORD_GAP_PATTERN}{_PERCENT_VALUE_PATTERN}"
    rf"{_CLAIM_WORD_GAP_PATTERN}of{_CLAIM_WORD_GAP_PATTERN}"
    rf"(?:the{_CLAIM_WORD_GAP_PATTERN})?portfolio\b",
    re.IGNORECASE,
)
_SINGLE_SNAPSHOT_INDICATOR_TREND_RE = re.compile(
    r"(?is)(?:MACD|RSI|ATR|均线|移动平均|波动率|"
    r"momentum|moving\s+average|volatility)"
    r".{0,240}?"
    r"(?:仍(?:在)?(?:扩张|发散|走负|走强|走弱)|"
    r"尚未(?:出现)?(?:收敛|收窄|拐头|改善)|"
    r"(?:负向|正向)(?:扩张|发散)|"
    r"动能(?:加速|减速|增强|衰减)|"
    r"下行动能可能仍有释放空间|"
    r"still\s+(?:widening|narrowing|diverging|converging)|"
    r"continues?\s+to\s+(?:widen|narrow|diverge|converge|accelerate|decelerate))",
)
_BEARISH_ALIGNMENT_RE = re.compile(
    r"空头排列|bearish\s+(?:moving[-\s]average\s+)?alignment",
    re.IGNORECASE,
)
_BULLISH_ALIGNMENT_RE = re.compile(
    r"多头排列|bullish\s+(?:moving[-\s]average\s+)?alignment",
    re.IGNORECASE,
)
_ACTOR_OR_FLOW_ATTRIBUTION_RE = re.compile(
    r"(?:资金(?:净)?(?:流入|流出)|资金主体|主力(?:资金)?|"
    r"散户(?:接盘|买入|卖出)|机构(?:买入|卖出|资金|行为|意图)|"
    r"程序化(?:买盘|卖盘|交易)|承接盘|抛压|卖压|买盘|"
    r"申购(?:增加|减少|流入|行为|资金)|"
    r"赎回(?:增加|减少|流出|行为|资金)|"
    r"accumulation|distribution|buying\s+support|selling\s+pressure|"
    r"fund\s+(?:inflow|outflow)|institutional\s+buying|retail\s+buying)",
    re.IGNORECASE,
)
_ATTRIBUTION_NEGATION_RE = re.compile(
    r"(?:"
    r"(?:不能|不可|无法|不应|不得|未能|不足以)"
    r"(?:从[^，,。；;]{0,24})?(?:据此)?"
    r"(?:确认|判断|证明|推断|识别|归因|说明|得出)|"
    r"(?:没有|缺乏)(?:直接|充分|足够)?证据"
    r"(?:显示|表明|证明|支持)|"
    r"(?:并非|不是|不等同于)|"
    r"(?:cannot|can't|does\s+not|doesn't)\s+"
    r"(?:prove|show|identify|infer)"
    r")\s*$",
    re.IGNORECASE,
)
_ATTRIBUTION_POST_NEGATION_RE = re.compile(
    r"(?:是否|能否).{0,80}?(?:不能|不可|无法|未能|不足以)"
    r".{0,40}?(?:确认|判断|证明|推断)"
)
_WINDOW_RANK_RE = re.compile(
    r"(?:窗口(?:内)?|近\s*\d+\s*(?:个)?交易日|本期|最新交易日).{0,60}?"
    r"(?:最低|最高|第[二三四五]高|次高|次低)|"
    r"(?:收盘价|成交量|价格).{0,40}?(?:创新高|创新低|刷新高点|刷新低点)|"
    r"(?:下行|下跌)日.{0,40}?成交量.{0,40}?高于.{0,20}?(?:反弹|上涨)日|"
    r"\b(?:window|period)[-\s]?(?:low|high)|"
    r"\b(?:lowest|highest|second[-\s]highest|new\s+(?:high|low))\b",
    re.IGNORECASE,
)
_HYPOTHETICAL_PREFIX_RE = re.compile(
    r"(?:若|如果|一旦|后续|未来|关注是否|等待|\bwhen\b|\bif\b)",
    re.IGNORECASE,
)
_CAUSAL_OR_PATH_RE = re.compile(
    r"(?:持续回落|持续下跌|持续上涨|连续走低|连续走高|"
    r"已证明|证明了|导致|造成|引发|"
    r"确定性(?:最高|最强)|最可靠|趋势方向清晰|"
    r"(?:极端|深度|显著|极高|极低).{0,16}?(?:偏离|水平|风险|波动)|"
    r"(?:双向|下行|上行)?风险.{0,12}?(?:显著|客观存在)|"
    r"(?:不具备|具备).{0,12}?(?:信号意义|方向性意义)|"
    r"方向一致性.{0,24}?(?:提高|增强).{0,12}?置信|"
    r"(?:中性)?技术操作|不改变.{0,16}?(?:权益|持有人)|"
    r"历史经验.{0,36}?(?:反弹|回归)|错失.{0,12}?反转|"
    r"(?:企稳|升幅).{0,20}?(?:噪音|信号)|"
    r"理论上.{0,28}?驱动|意味着.{0,24}?(?:风险|反弹|下行|上行)|"
    r"(?:短期)?(?:反弹|下跌|上涨|回落)(?:的)?路径|"
    r"路径.{0,12}?(?:剧烈|显著|明显)|"
    r"波动.{0,20}?(?:制造|带来|创造).{0,12}?机会|"
    r"多重独立指标|相互独立(?:的)?指标|"
    r"continued?\s+(?:decline|rise|fall)|"
    r"(?:proves?|demonstrates?|causes?|drives?|triggers?)\b|"
    r"independent\s+indicators?)",
    re.IGNORECASE,
)
_QUALITATIVE_INFERENCE_CLASSIFIERS = {
    "distribution_degree": re.compile(
        r"(?:(?:价格|收盘|涨幅|跌幅|偏离|波动率|风险|水平|区间)"
        r".{0,24}?(?:异常(?:大|高|低)?|罕见|少见|极端|极高|极低|显著|"
        r"远超常态|超出常态|偏离常态)|"
        r"(?:异常(?:大|高|低)?|罕见|少见|极端|极高|极低|显著|"
        r"远超常态|超出常态|偏离常态)"
        r".{0,24}?(?:价格|收盘|涨幅|跌幅|偏离|波动率|风险|水平|区间)|"
        r"(?:unusual(?:ly)?|rare|extreme|exceptional|significant(?:ly)?)"
        r".{0,24}?(?:price|return|deviation|volatility|risk|level|range))",
        re.IGNORECASE,
    ),
    "randomness_test": re.compile(
        r"(?:随机波动|随机噪声|只是随机|只是噪音|只是噪声|"
        r"(?:只是)?偶然(?:扰动|波动)|偶发(?:扰动|波动)|"
        r"不具备.{0,12}?(?:信号|方向性)|"
        r"\b(?:random(?:\s+move)?|noise|no\s+signal)\b)",
        re.IGNORECASE,
    ),
    "confidence_calibration": re.compile(
        r"(?:(?:方向|指标|信号).{0,12}?(?:一致|相同|同向)"
        r".{0,28}?(?:可信|置信|可靠|确信)|"
        r"(?:多个|多项).{0,16}?(?:方向相同|同向).{0,28}?"
        r"(?:有把握|可信|可靠)|"
        r"(?:一致性|confirmation).{0,28}?"
        r"(?:confidence|credible|reliable|可信|置信|可靠))",
        re.IGNORECASE,
    ),
    "volatility_path": re.compile(
        r"(?:(?:波动率|高波动|剧烈波动|大幅波动|波动环境|volatility)"
        r".{0,40}?(?:孕育|暗示|预示|伴随|带来|产生|反弹|反转|"
        r"清仓|上涨|下跌|上行|下行|"
        r"rebound|reversal|rally|selloff|risk)|"
        r"(?:反弹|反转|上涨|下跌|rebound|reversal)"
        r".{0,24}?(?:并不意外|可预期|来自|源于)"
        r".{0,16}?(?:波动|volatility)?)",
        re.IGNORECASE,
    ),
    "corporate_action_effect": re.compile(
        r"(?:(?:份额)?拆分|分红|除权|公司行动|corporate\s+action|split)"
        r".{0,48}?(?:中性|不(?:会)?(?:损害|影响|改变|稀释)|"
        r"稀释|权益|利益|持有份额的价值|"
        r"neutral|dilut|does\s+not\s+(?:harm|affect|change))",
        re.IGNORECASE,
    ),
}
_FACE_VALUE_RE = re.compile(
    r"(?:击穿|跌破|低于|高于|突破|below|above|breach(?:ed)?)"
    r".{0,32}?(?:面值|票面价值|par\s+value)",
    re.IGNORECASE,
)
_STRUCTURAL_FINAL_PARAGRAPH_RE = re.compile(
    r"^(?:"
    r"\*\*Rating\*\*\s*:\s*"
    r"(?:Strong\s+)?(?:Buy|Sell)|"
    r"\*\*Rating\*\*\s*:\s*"
    r"(?:Hold|Neutral|Overweight|Underweight|Not\s+Rated)|"
    r"\*\*Rating\*\*\s*:\s*(?:买入|增持|持有|中性|减持|卖出|未评级)|"
    r"\*\*Time\s+Horizon\*\*\s*:\s*"
    r"(?:null|N/?A|short(?:[-\s]?term)?|medium(?:[-\s]?term)?|"
    r"long(?:[-\s]?term)?|短期|中期|长期)"
    r"(?:\s*\([^)\n]{1,40}\))?"
    r")$",
    re.IGNORECASE,
)
_RATING_OR_HORIZON_RE = re.compile(
    r"^\*\*(?:Rating|Time\s+Horizon)\*\*\s*:",
    re.IGNORECASE,
)
_OBSERVATION_ONLY_HEADING_RE = re.compile(
    r"^(?:#{1,6}\s*|\*\*)"
    r"(?:下一步|后续|未来|待获取|观察|监测|Next\s+Steps?|Watchlist)",
    re.IGNORECASE,
)
_CLAUSE_SPLIT_RE = re.compile(
    r"[。！？；;，,:：—–.!?…/\n]+|(?:但|不过|然而|\bbut\b|\bhowever\b)",
    re.IGNORECASE,
)
_NON_CONCLUSION_MARKER_RE = re.compile(
    r"(?:若|如果|一旦|届时|作为下一步|下一步|后续|未来|"
    r"关注是否|观察|监测|跟踪|静候|等待|待获取|优先获取|"
    r"(?:需要|需|建议)(?:关注|获取|等待|重新评估)|重新评估|"
    r"\bif\b|\bwhen\b|\bwatch\b|\bwait\b|\bmonitor\b|\bnext\s+step\b)",
    re.IGNORECASE,
)
def _packet_evidence_ids(packet: dict) -> set[str]:
    ids = set()
    for key in (
        "bars",
        "indicatorEvidence",
        "derivedEvidence",
        "corporateActions",
        "news",
        "sources",
    ):
        for row in packet.get(key) or []:
            if isinstance(row, dict) and row.get("evidenceId"):
                ids.add(str(row["evidenceId"]).upper())
    return ids


def _packet_evidence_rows(packet: dict) -> dict[str, dict]:
    rows: dict[str, dict] = {}
    for key in (
        "bars",
        "indicatorEvidence",
        "derivedEvidence",
        "corporateActions",
        "news",
        "sources",
    ):
        for row in packet.get(key) or []:
            if isinstance(row, dict) and row.get("evidenceId"):
                rows[str(row["evidenceId"]).upper()] = row
    return rows


def _row_numeric_values(value, *, key: str | None = None) -> list[float]:
    if key == "evidenceId" or isinstance(value, bool):
        return []
    if isinstance(value, (int, float)):
        numeric = float(value)
        return [numeric] if math.isfinite(numeric) else []
    if isinstance(value, dict):
        result: list[float] = []
        for child_key, child in value.items():
            result.extend(_row_numeric_values(child, key=str(child_key)))
        return result
    if isinstance(value, (list, tuple)):
        result = []
        for child in value:
            result.extend(_row_numeric_values(child))
        return result
    return []


def _numeric_token_value(token: str) -> tuple[float, int] | None:
    normalized = re.sub(r"[$¥£€,%\s]", "", str(token or ""))
    try:
        value = float(normalized)
    except ValueError:
        return None
    if not math.isfinite(value):
        return None
    decimal_places = (
        len(normalized.rsplit(".", 1)[1])
        if "." in normalized
        else 0
    )
    return value, decimal_places


def _unsupported_derived_numbers(
    paragraph: str,
    packet_rows: dict[str, dict],
    paragraph_ids: set[str],
) -> list[str]:
    claim_text = _mask_non_claim_numeric_context(_claim_scan_text(paragraph))
    numeric_tokens = [
        match.group(0) for match in _NUMERIC_CLAIM_RE.finditer(claim_text)
    ]
    if not numeric_tokens:
        return []
    supported_values: list[float] = []
    for evidence_id in paragraph_ids:
        row = packet_rows.get(evidence_id)
        if row is not None:
            supported_values.extend(_row_numeric_values(row))
    unsupported: list[str] = []
    for token in numeric_tokens:
        parsed = _numeric_token_value(token)
        if parsed is None:
            unsupported.append(token)
            continue
        value, decimal_places = parsed
        if decimal_places == 0:
            is_supported = any(value == candidate for candidate in supported_values)
        else:
            tolerance = 0.5 * (10 ** -decimal_places) + 1e-12
            is_supported = any(
                abs(value - candidate) <= tolerance
                for candidate in supported_values
            )
        if not is_supported:
            unsupported.append(token)
    return unsupported


def _moving_average_alignment_is_contradicted(paragraph: str, packet: dict) -> bool:
    evaluable_text = re.sub(
        r"(?:不|未|无|非|尚未|并非|而非|不是)(?:满足|构成|形成|属于|是)?"
        r"[^。；;\n]{0,80}?(?:多头|空头)排列(?:定义|条件|信号)?",
        "",
        paragraph,
    )
    evaluable_text = re.sub(
        r"(?:若|如果|一旦|关注是否|等待)"
        r"[^。；;\n]{0,80}?(?:多头|空头)排列(?:信号|条件)?",
        "",
        evaluable_text,
    )
    bearish_claim = bool(_BEARISH_ALIGNMENT_RE.search(evaluable_text))
    bullish_claim = bool(_BULLISH_ALIGNMENT_RE.search(evaluable_text))
    if not bearish_claim and not bullish_claim:
        return False
    indicators = packet.get("indicators") or {}
    bars = packet.get("bars") or []
    try:
        close = float(bars[-1]["close"])
        ma20 = float(indicators["ma20"])
        ma60 = float(indicators["ma60"])
    except (IndexError, KeyError, TypeError, ValueError):
        return True
    if not all(math.isfinite(value) for value in (close, ma20, ma60)):
        return True
    if bearish_claim and not (close < ma20 < ma60):
        return True
    return bool(bullish_claim and not close > ma20 > ma60)


def _has_unsupported_actor_or_flow_attribution(paragraph: str) -> bool:
    """Reject price/volume narratives that invent actors or fund flows."""
    clauses = _CLAUSE_SPLIT_RE.split(str(paragraph or ""))
    for clause in clauses:
        matches = list(_ACTOR_OR_FLOW_ATTRIBUTION_RE.finditer(clause))
        if not matches:
            continue
        first_match = matches[0]
        prefix = clause[:first_match.start()]
        suffix = clause[first_match.start():]
        if (
            _ATTRIBUTION_NEGATION_RE.search(prefix)
            or _ATTRIBUTION_POST_NEGATION_RE.search(suffix)
        ):
            continue
        return True
    return False


def _has_unsupported_window_rank(
    paragraph: str,
    packet_rows: dict[str, dict],
    paragraph_ids: set[str],
) -> bool:
    for sentence in _CLAUSE_SPLIT_RE.split(str(paragraph or "")):
        match = _WINDOW_RANK_RE.search(sentence)
        if not match:
            continue
        if _HYPOTHETICAL_PREFIX_RE.search(sentence[:match.start()]):
            continue
        supported = any(
            str((packet_rows.get(evidence_id) or {}).get("name") or "").lower()
            in {
                "recentwindowcloseextremum",
                "latestcloserankinrecentwindow",
                "latestvolumerankinrecentwindow",
            }
            for evidence_id in paragraph_ids
        )
        if not supported:
            return True
    return False


def _has_unsupported_causal_or_path_claim(
    paragraph: str,
    packet_rows: dict[str, dict],
    paragraph_ids: set[str],
) -> bool:
    capabilities: set[str] = set()
    for evidence_id in paragraph_ids:
        raw = (packet_rows.get(evidence_id) or {}).get("claimCapabilities") or []
        if isinstance(raw, str):
            raw = [raw]
        if isinstance(raw, (list, tuple, set)):
            capabilities.update(str(value).strip() for value in raw if str(value).strip())
    for sentence in _CLAUSE_SPLIT_RE.split(str(paragraph or "")):
        for match in _CAUSAL_OR_PATH_RE.finditer(sentence):
            if _HYPOTHETICAL_PREFIX_RE.search(sentence[:match.start()]):
                continue
            return True
        for capability, classifier in _QUALITATIVE_INFERENCE_CLASSIFIERS.items():
            match = classifier.search(sentence)
            if not match or capability in capabilities:
                continue
            if _HYPOTHETICAL_PREFIX_RE.search(sentence[:match.start()]):
                continue
            return True
    return False


def _is_structural_final_paragraph(paragraph: str) -> bool:
    return bool(_STRUCTURAL_FINAL_PARAGRAPH_RE.fullmatch(str(paragraph or "").strip()))


def _is_rating_or_horizon_paragraph(paragraph: str) -> bool:
    return bool(_RATING_OR_HORIZON_RE.match(str(paragraph or "").strip()))


def _has_substantive_claim_text(claim_text: str) -> bool:
    return bool(re.sub(r"[\s*_#：:，,。.!！?？；;—–-]+", "", str(claim_text or "")))


def _is_numeric_recommendation_disclaimer(paragraph: str) -> bool:
    original = str(paragraph or "")
    if not _NUMERIC_RECOMMENDATION_DISCLAIMER_RE.search(original):
        return False
    remainder = _NUMERIC_RECOMMENDATION_DISCLAIMER_RE.sub("", original)
    remainder = re.sub(r"(?i)\bthis\s+report\b|本报告", "", remainder)
    return not _has_substantive_claim_text(remainder)


def _is_substantive_supported_conclusion(
    paragraph: str,
    known_ids: set[str],
) -> bool:
    paragraph_ids, _invalid = _scan_evidence_citations(paragraph)
    if not paragraph_ids.intersection(known_ids):
        return False
    if _is_structural_final_paragraph(paragraph):
        return False
    if _OBSERVATION_ONLY_HEADING_RE.match(str(paragraph or "").strip()):
        return False
    for raw_line in str(paragraph or "").splitlines():
        line = re.sub(r"^\s*(?:[-*+]\s+|\d+[.)]\s+)", "", raw_line).strip()
        if re.fullmatch(r"(?:#{1,6}\s+.+|\*\*[^*\n]+\*\*\s*:?)", line):
            continue
        for clause in _CLAUSE_SPLIT_RE.split(line):
            claim_text = _claim_scan_text(clause)
            if not _has_substantive_claim_text(claim_text):
                continue
            if _NON_CONCLUSION_MARKER_RE.search(claim_text):
                continue
            return True
    return False


def _parse_evidence_citation(body: str) -> frozenset[str] | None:
    """Parse one citation group, expanding same-prefix inclusive ranges."""
    body = str(body or "")
    if len(body) > _MAX_EVIDENCE_CITATION_CONTAINER_LENGTH:
        return None
    evidence_ids: set[str] = set()
    expanded_count = 0
    for raw_token in body.split(","):
        token = raw_token.strip()
        match = _EVIDENCE_CITATION_TOKEN_RE.fullmatch(token)
        if not match:
            return None
        start_prefix, start_text, end_prefix, end_text = match.groups()
        if len(start_text) > _MAX_EVIDENCE_CITATION_NUMBER_DIGITS or (
            end_text is not None
            and len(end_text) > _MAX_EVIDENCE_CITATION_NUMBER_DIGITS
        ):
            return None
        prefix = start_prefix.upper()
        start = int(start_text)
        if end_text is None:
            expanded_count += 1
            if expanded_count > _MAX_EVIDENCE_IDS_PER_CONTAINER:
                return None
            evidence_ids.add(f"{prefix}{start}")
            continue
        if end_prefix and end_prefix.upper() != prefix:
            return None
        end = int(end_text)
        range_size = end - start + 1
        if (
            range_size <= 0
            or range_size > _MAX_EVIDENCE_IDS_PER_CONTAINER
            or expanded_count + range_size > _MAX_EVIDENCE_IDS_PER_CONTAINER
        ):
            return None
        expanded_count += range_size
        evidence_ids.update(f"{prefix}{index}" for index in range(start, end + 1))
    return frozenset(evidence_ids) or None


def _scan_evidence_citations(
    text: str,
    parse_cache: dict[str, frozenset[str] | None] | None = None,
) -> tuple[set[str], list[str]]:
    """Parse each citation container once, reusing results within a report."""
    evidence_ids: set[str] = set()
    invalid: list[str] = []
    safe_text = str(text or "")
    cache = parse_cache if parse_cache is not None else {}
    for match in _EVIDENCE_CITATION_RE.finditer(safe_text):
        body = match.group(1)
        if body not in cache:
            cache[body] = _parse_evidence_citation(body)
        parsed = cache[body]
        followed_by_parenthesis = (
            match.end() < len(safe_text) and safe_text[match.end()] == "("
        )
        if followed_by_parenthesis and parsed:
            continue
        if parsed:
            evidence_ids.update(parsed)
        elif _EVIDENCE_LIKE_CONTAINER_RE.match(body):
            invalid.append(match.group(0))
    return evidence_ids, invalid


def _evidence_citations(text: str) -> set[str]:
    return _scan_evidence_citations(text)[0]


def _invalid_evidence_citations(text: str) -> list[str]:
    return _scan_evidence_citations(text)[1]


def _strip_evidence_citations(text: str) -> str:
    def replace(match: re.Match) -> str:
        body = match.group(1)
        if _EVIDENCE_LIKE_CONTAINER_RE.match(body):
            return ""
        return match.group(0)

    return _EVIDENCE_CITATION_RE.sub(replace, str(text or ""))


def _mask_numeric_recommendation_disclaimers(text: str) -> str:
    return _NUMERIC_RECOMMENDATION_DISCLAIMER_RE.sub("", str(text or ""))


def _claim_scan_text(text: str) -> str:
    without_links = _MARKDOWN_LINK_RE.sub("", str(text or ""))
    without_urls = re.sub(r"https?://\S+", "", without_links)
    without_citations = _strip_evidence_citations(without_urls)
    return _mask_numeric_recommendation_disclaimers(without_citations)


def _mask_non_claim_numeric_context(text: str) -> str:
    """Mask structural numbers before searching for uncited numeric claims.

    The report validator must still catch an uncited price or ratio in a
    dated paragraph, so only the date/identifier/heading/indicator-parameter
    spans themselves are removed.  The surrounding prose and all remaining
    numbers stay visible to ``_NUMERIC_CLAIM_RE``.
    """
    chars = list(str(text or ""))
    for pattern in _NON_CLAIM_NUMERIC_CONTEXT:
        for match in pattern.finditer(str(text or "")):
            start, end = match.span()
            chars[start:end] = [" "] * (end - start)
    return "".join(chars)


def _market_history_metadata(packet: dict) -> dict:
    """Summarize market-history provenance without changing adjustment semantics."""
    bars = list(packet.get("bars") or [])
    sources = list(packet.get("sources") or [])
    adjustments = {
        str(row.get("adjustment"))
        for row in bars
        if isinstance(row, dict) and row.get("adjustment")
    }
    adjustment = (
        next(iter(adjustments))
        if len(adjustments) == 1
        else "mixed"
        if len(adjustments) > 1
        else "unknown"
    )
    return {
        "source": (
            str(sources[0].get("source") or "unknown")
            if sources and isinstance(sources[0], dict)
            else "unknown"
        ),
        "adjustment": adjustment,
        "barCount": len(bars),
        "startAt": bars[0].get("ts") if bars else None,
        "endAt": bars[-1].get("ts") if bars else None,
    }


def validate_report_claims(text: str, packet: dict) -> dict:
    """Validate that a rated narrative remains tied to packet evidence."""
    known_ids = _packet_evidence_ids(packet)
    packet_rows = _packet_evidence_rows(packet)
    cited_ids: set[str] = set()
    invalid_citations: list[str] = []
    parse_cache: dict[str, frozenset[str] | None] = {}
    uncited_numeric = 0
    unsupported_derived_numeric = 0
    unsupported_single_snapshot_trend = 0
    contradicted_ma_alignment = 0
    unsupported_actor_or_flow_attribution = 0
    unsupported_window_rank = 0
    unsupported_causal_or_path = 0
    unsupported_face_value = 0
    has_price_target = False
    has_allocation = False
    for paragraph in re.split(r"\n\s*\n", str(text or "")):
        paragraph_ids, paragraph_invalid = _scan_evidence_citations(
            paragraph,
            parse_cache,
        )
        cited_ids.update(paragraph_ids)
        invalid_citations.extend(paragraph_invalid)
        claim_text = _claim_scan_text(paragraph)
        if (
            _NUMERIC_CLAIM_RE.search(
                _mask_non_claim_numeric_context(claim_text),
            )
            and not paragraph_ids.intersection(known_ids)
        ):
            uncited_numeric += 1
        known_paragraph_ids = paragraph_ids.intersection(known_ids)
        if known_paragraph_ids and _unsupported_derived_numbers(
            paragraph,
            packet_rows,
            known_paragraph_ids,
        ):
            unsupported_derived_numeric += 1
        if (
            known_paragraph_ids
            and _SINGLE_SNAPSHOT_INDICATOR_TREND_RE.search(claim_text)
        ):
            unsupported_single_snapshot_trend += 1
        if (
            known_paragraph_ids
            and _moving_average_alignment_is_contradicted(claim_text, packet)
        ):
            contradicted_ma_alignment += 1
        if (
            known_paragraph_ids
            and _has_unsupported_actor_or_flow_attribution(claim_text)
        ):
            unsupported_actor_or_flow_attribution += 1
        if (
            known_paragraph_ids
            and _has_unsupported_window_rank(
                claim_text,
                packet_rows,
                known_paragraph_ids,
            )
        ):
            unsupported_window_rank += 1
        if (
            known_paragraph_ids
            and _has_unsupported_causal_or_path_claim(
                claim_text,
                packet_rows,
                known_paragraph_ids,
            )
        ):
            unsupported_causal_or_path += 1
        if known_paragraph_ids and _FACE_VALUE_RE.search(claim_text):
            unsupported_face_value += 1
        has_price_target = has_price_target or bool(
            _PRICE_TARGET_RE.search(claim_text)
        )
        has_allocation = has_allocation or bool(_ALLOCATION_RE.search(claim_text))
    unknown_ids = sorted(cited_ids - known_ids)
    error_codes = []
    if not cited_ids.intersection(known_ids):
        error_codes.append("MISSING_EVIDENCE_CITATION")
    if unknown_ids:
        error_codes.append("UNKNOWN_EVIDENCE_ID")
    if invalid_citations:
        error_codes.append("INVALID_EVIDENCE_CITATION")
    if uncited_numeric:
        error_codes.append("UNCITED_NUMERIC_CLAIM")
    if unsupported_derived_numeric:
        error_codes.append("UNSUPPORTED_DERIVED_NUMERIC_CLAIM")
    if unsupported_single_snapshot_trend:
        error_codes.append("UNSUPPORTED_SINGLE_SNAPSHOT_TREND")
    if contradicted_ma_alignment:
        error_codes.append("CONTRADICTED_MOVING_AVERAGE_ALIGNMENT")
    if unsupported_actor_or_flow_attribution:
        error_codes.append("UNSUPPORTED_ACTOR_OR_FLOW_ATTRIBUTION")
    if unsupported_window_rank:
        error_codes.append("UNSUPPORTED_WINDOW_RANK_CLAIM")
    if unsupported_causal_or_path:
        error_codes.append("UNSUPPORTED_CAUSAL_OR_PATH_CLAIM")
    if unsupported_face_value:
        error_codes.append("UNSUPPORTED_FACE_VALUE_CLAIM")
    if has_price_target:
        error_codes.append("UNSUPPORTED_PRICE_TARGET")
    if has_allocation:
        error_codes.append("UNSUPPORTED_ALLOCATION")
    return {
        "status": "passed" if not error_codes else "failed",
        "errorCodes": error_codes,
        "citationCount": len(cited_ids.intersection(known_ids)),
        "unknownEvidenceIds": unknown_ids,
        "invalidEvidenceCitations": invalid_citations,
        "uncitedNumericParagraphs": uncited_numeric,
        "unsupportedDerivedNumericParagraphs": unsupported_derived_numeric,
        "unsupportedSingleSnapshotTrendParagraphs": (
            unsupported_single_snapshot_trend
        ),
        "contradictedMovingAverageAlignmentParagraphs": contradicted_ma_alignment,
        "unsupportedActorOrFlowAttributionParagraphs": (
            unsupported_actor_or_flow_attribution
        ),
        "unsupportedWindowRankParagraphs": unsupported_window_rank,
        "unsupportedCausalOrPathParagraphs": unsupported_causal_or_path,
        "unsupportedFaceValueParagraphs": unsupported_face_value,
    }


def _filter_public_final_decision(text: str, packet: dict) -> tuple[str, int, set[str]]:
    """Omit unsafe final-decision paragraphs without modifying their claims."""
    known_ids = _packet_evidence_ids(packet)
    packet_rows = _packet_evidence_rows(packet)
    paragraphs = [
        paragraph.strip()
        for paragraph in re.split(r"\n\s*\n", str(text or ""))
        if paragraph.strip()
    ]
    kept_indexes: list[int] = []
    omitted = 0
    omitted_error_codes: set[str] = set()
    parse_cache: dict[str, frozenset[str] | None] = {}
    for index, paragraph in enumerate(paragraphs):
        paragraph_ids, invalid_citations = _scan_evidence_citations(
            paragraph,
            parse_cache,
        )
        unknown_ids = paragraph_ids - known_ids
        claim_text = _claim_scan_text(paragraph)
        has_numeric_claim = bool(
            _NUMERIC_CLAIM_RE.search(
                _mask_non_claim_numeric_context(claim_text),
            )
        )
        has_uncited_numeric = has_numeric_claim and not paragraph_ids.intersection(known_ids)
        has_price_target = bool(_PRICE_TARGET_RE.search(claim_text))
        has_allocation = bool(_ALLOCATION_RE.search(claim_text))
        known_paragraph_ids = paragraph_ids.intersection(known_ids)
        has_unsupported_derived_numeric = bool(
            known_paragraph_ids
            and _unsupported_derived_numbers(
                paragraph,
                packet_rows,
                known_paragraph_ids,
            )
        )
        has_unsupported_snapshot_trend = bool(
            known_paragraph_ids
            and _SINGLE_SNAPSHOT_INDICATOR_TREND_RE.search(claim_text)
        )
        has_contradicted_ma_alignment = bool(
            known_paragraph_ids
            and _moving_average_alignment_is_contradicted(claim_text, packet)
        )
        has_unsupported_actor_or_flow = bool(
            known_paragraph_ids
            and _has_unsupported_actor_or_flow_attribution(claim_text)
        )
        has_unsupported_window_rank = bool(
            known_paragraph_ids
            and _has_unsupported_window_rank(
                claim_text,
                packet_rows,
                known_paragraph_ids,
            )
        )
        has_unsupported_causal_or_path = bool(
            known_paragraph_ids
            and _has_unsupported_causal_or_path_claim(
                claim_text,
                packet_rows,
                known_paragraph_ids,
            )
        )
        has_unsupported_face_value = bool(
            known_paragraph_ids and _FACE_VALUE_RE.search(claim_text)
        )
        has_missing_qualitative_citation = bool(
            _has_substantive_claim_text(claim_text)
            and not known_paragraph_ids
            and not _is_structural_final_paragraph(paragraph)
            and not _is_numeric_recommendation_disclaimer(paragraph)
        )
        has_empty_evidence_fragment = bool(
            known_paragraph_ids
            and not _has_substantive_claim_text(claim_text)
            and not _is_structural_final_paragraph(paragraph)
        )
        if (
            unknown_ids
            or invalid_citations
            or has_uncited_numeric
            or has_missing_qualitative_citation
            or has_empty_evidence_fragment
            or has_price_target
            or has_allocation
            or has_unsupported_derived_numeric
            or has_unsupported_snapshot_trend
            or has_contradicted_ma_alignment
            or has_unsupported_actor_or_flow
            or has_unsupported_window_rank
            or has_unsupported_causal_or_path
            or has_unsupported_face_value
        ):
            omitted += 1
            if unknown_ids:
                omitted_error_codes.add("UNKNOWN_EVIDENCE_ID")
            if invalid_citations:
                omitted_error_codes.add("INVALID_EVIDENCE_CITATION")
            if has_uncited_numeric:
                omitted_error_codes.add("UNCITED_NUMERIC_CLAIM")
            if has_missing_qualitative_citation:
                omitted_error_codes.add("MISSING_EVIDENCE_CITATION")
            if has_empty_evidence_fragment:
                omitted_error_codes.add("EMPTY_EVIDENCE_FRAGMENT")
            if has_price_target:
                omitted_error_codes.add("UNSUPPORTED_PRICE_TARGET")
            if has_allocation:
                omitted_error_codes.add("UNSUPPORTED_ALLOCATION")
            if has_unsupported_derived_numeric:
                omitted_error_codes.add("UNSUPPORTED_DERIVED_NUMERIC_CLAIM")
            if has_unsupported_snapshot_trend:
                omitted_error_codes.add("UNSUPPORTED_SINGLE_SNAPSHOT_TREND")
            if has_contradicted_ma_alignment:
                omitted_error_codes.add("CONTRADICTED_MOVING_AVERAGE_ALIGNMENT")
            if has_unsupported_actor_or_flow:
                omitted_error_codes.add("UNSUPPORTED_ACTOR_OR_FLOW_ATTRIBUTION")
            if has_unsupported_window_rank:
                omitted_error_codes.add("UNSUPPORTED_WINDOW_RANK_CLAIM")
            if has_unsupported_causal_or_path:
                omitted_error_codes.add("UNSUPPORTED_CAUSAL_OR_PATH_CLAIM")
            if has_unsupported_face_value:
                omitted_error_codes.add("UNSUPPORTED_FACE_VALUE_CLAIM")
            continue
        kept_indexes.append(index)
    kept_index_set = set(kept_indexes)
    kept: list[str] = []
    for index in kept_indexes:
        paragraph = paragraphs[index]
        if (
            _is_structural_final_paragraph(paragraph)
            and not _is_rating_or_horizon_paragraph(paragraph)
            and (
                index + 1 not in kept_index_set
                or _is_structural_final_paragraph(paragraphs[index + 1])
            )
        ):
            omitted += 1
            omitted_error_codes.add("ORPHAN_HEADING")
            continue
        kept.append(paragraph)
    has_substantive_supported_conclusion = any(
        _is_substantive_supported_conclusion(paragraph, known_ids)
        for paragraph in kept
    )
    if not has_substantive_supported_conclusion:
        omitted_error_codes.add("NO_SUBSTANTIVE_SUPPORTED_CONCLUSION")
    return "\n\n".join(kept), omitted, omitted_error_codes


def _sanitize_final_proposals(text: str) -> str:
    """Keep one final proposal marker in the consolidated report.

    Agent sub-reports remain untouched for auditability; the reader-facing
    consolidated report cannot present multiple conflicting final actions.
    """
    lines = str(text or "").splitlines()
    marker_indexes = [
        index for index, line in enumerate(lines)
        if re.search(r"FINAL TRANSACTION PROPOSAL", line, re.IGNORECASE)
    ]
    if len(marker_indexes) <= 1:
        return str(text or "")
    return "\n".join(
        line for index, line in enumerate(lines)
        if index not in marker_indexes[:-1]
    )


def _render_evidence_snapshot(packet: dict) -> str:
    """Render a compact, human-readable ledger without inventing analysis."""
    bars = list(packet.get("bars") or [])
    indicators = list(packet.get("indicatorEvidence") or [])
    derived = list(packet.get("derivedEvidence") or [])
    actions = list(packet.get("corporateActions") or [])
    news = list(packet.get("news") or [])
    sources = list(packet.get("sources") or [])
    market = str((packet.get("instrument") or {}).get("market") or "")
    anchor = (
        (bars[-1].get("evidenceId") if bars else None)
        or (sources[0].get("evidenceId") if sources else None)
        or "—"
    )
    market_history = _market_history_metadata(packet)
    lines = [
        "## Evidence Snapshot",
        "",
        (
            f"- Status `{packet.get('status', 'unknown')}`; "
            f"as of `{packet.get('asOf', 'unknown')}`; "
            f"instrument `{packet.get('instrument', {}).get('symbol', 'unknown')}` "
            f"[{anchor}]"
        ),
        (
            f"- Market history: source `{market_history['source']}`; "
            f"adjustment `{market_history['adjustment']}`; "
            f"{market_history['barCount']} bars from "
            f"`{market_history['startAt'] or 'unavailable'}` to "
            f"`{market_history['endAt'] or 'unavailable'}`"
        ),
    ]
    if bars:
        lines.extend(["", "### Latest market bars", ""])
        for row in bars[-5:]:
            lines.append(
                f"- [{row.get('evidenceId')}] trade date "
                f"{market_trade_date(row.get('ts'), market)} "
                f"(raw UTC {row.get('ts')}): "
                f"O {row.get('open')} · H {row.get('high')} · "
                f"L {row.get('low')} · C {row.get('close')} · "
                f"volume {row.get('volume')}"
            )
    if indicators:
        lines.extend(["", "### Indicators", ""])
        for row in indicators[:12]:
            lines.append(
                f"- [{row.get('evidenceId')}] {row.get('name')}: {row.get('value')}"
            )
    if derived:
        lines.extend(["", "### Precomputed derived evidence", ""])
        for row in derived:
            window = row.get("window") or {}
            window_text = " → ".join(
                str(window.get(key))
                for key in ("startEvidenceId", "endEvidenceId")
                if window.get(key)
            ) or str(window.get("asOfEvidenceId") or "unavailable")
            lines.append(
                f"- [{row.get('evidenceId')}] {row.get('name')}: "
                f"{row.get('value')} {row.get('unit')} · "
                f"method `{row.get('method')}` · window `{window_text}`"
            )
    if actions:
        lines.extend(["", "### Corporate actions", ""])
        for row in actions[:6]:
            lines.append(
                f"- [{row.get('evidenceId')}] {row.get('type')}: "
                f"{row.get('exDate') or row.get('date') or 'date unavailable'}"
            )
    if news:
        lines.extend(["", "### Point-in-time news", ""])
        for row in news[:8]:
            title = str(row.get("title") or "Untitled").replace("\n", " ")
            url = str(row.get("url") or "").strip()
            label = f"[{title}]({url})" if url else title
            lines.append(
                f"- [{row.get('evidenceId')}] {row.get('publishedAt')}: "
                f"{label} · {row.get('source')} · {row.get('sourceTier')}"
            )
    if sources:
        lines.extend(["", "### Sources", ""])
        for row in sources[:8]:
            lines.append(
                f"- [{row.get('evidenceId')}] {row.get('source')} · "
                f"as of {row.get('asOf') or 'unavailable'} · "
                f"tier {row.get('sourceTier')}"
            )
    integrity = packet.get("integrity") or {}
    if integrity.get("warnings") or integrity.get("errors"):
        lines.extend([
            "",
            "### Integrity",
            "",
            f"- [{anchor}] warnings: {', '.join(integrity.get('warnings') or []) or 'none'}",
            f"- [{anchor}] errors: {', '.join(integrity.get('errors') or []) or 'none'}",
        ])
    return "\n".join(lines)


def write_report_tree(
    final_state: dict,
    ticker: str,
    save_path,
    *,
    evidence_packet: dict | None = None,
) -> Path:
    """Save a completed run's reports to ``save_path``; return the complete-report path."""
    save_path = Path(save_path)
    packet = evidence_packet or final_state.get("evidence_packet")
    if packet:
        validate_evidence_packet(packet)
        if packet.get("status") == "data_validation_failed" or not packet.get("canRate"):
            raise ReportValidationError(
                f"evidence validation failed; cannot generate a rated report for {ticker}"
            )
    save_path.mkdir(parents=True, exist_ok=True)
    sections = [_render_evidence_snapshot(packet)] if packet else []
    raw_final_decision = ""

    # 1. Analysts
    analysts_dir = save_path / "1_analysts"
    analyst_parts = []
    if final_state.get("market_report"):
        analysts_dir.mkdir(exist_ok=True)
        raw_text = str(final_state["market_report"])
        text = raw_text if packet else _sanitize_final_proposals(raw_text)
        (analysts_dir / "market.md").write_text(text, encoding="utf-8")
        analyst_parts.append(("Market Analyst", text))
    if final_state.get("sentiment_report"):
        analysts_dir.mkdir(exist_ok=True)
        raw_text = str(final_state["sentiment_report"])
        text = raw_text if packet else _sanitize_final_proposals(raw_text)
        (analysts_dir / "sentiment.md").write_text(text, encoding="utf-8")
        analyst_parts.append(("Sentiment Analyst", text))
    if final_state.get("news_report"):
        analysts_dir.mkdir(exist_ok=True)
        raw_text = str(final_state["news_report"])
        text = raw_text if packet else _sanitize_final_proposals(raw_text)
        (analysts_dir / "news.md").write_text(text, encoding="utf-8")
        analyst_parts.append(("News Analyst", text))
    if final_state.get("fundamentals_report"):
        analysts_dir.mkdir(exist_ok=True)
        raw_text = str(final_state["fundamentals_report"])
        text = raw_text if packet else _sanitize_final_proposals(raw_text)
        (analysts_dir / "fundamentals.md").write_text(text, encoding="utf-8")
        analyst_parts.append(("Fundamentals Analyst", text))
    if analyst_parts and not packet:
        content = "\n\n".join(f"### {name}\n{text}" for name, text in analyst_parts)
        sections.append(f"## I. Analyst Team Reports\n\n{content}")

    # 2. Research
    if final_state.get("investment_debate_state"):
        research_dir = save_path / "2_research"
        debate = final_state["investment_debate_state"]
        research_parts = []
        if debate.get("bull_history"):
            research_dir.mkdir(exist_ok=True)
            raw_text = str(debate["bull_history"])
            text = raw_text if packet else _sanitize_final_proposals(raw_text)
            (research_dir / "bull.md").write_text(text, encoding="utf-8")
            research_parts.append(("Bull Researcher", text))
        if debate.get("bear_history"):
            research_dir.mkdir(exist_ok=True)
            raw_text = str(debate["bear_history"])
            text = raw_text if packet else _sanitize_final_proposals(raw_text)
            (research_dir / "bear.md").write_text(text, encoding="utf-8")
            research_parts.append(("Bear Researcher", text))
        if debate.get("judge_decision"):
            research_dir.mkdir(exist_ok=True)
            raw_text = str(debate["judge_decision"])
            text = raw_text if packet else _sanitize_final_proposals(raw_text)
            (research_dir / "manager.md").write_text(text, encoding="utf-8")
            research_parts.append(("Research Manager", text))
        if research_parts and not packet:
            content = "\n\n".join(f"### {name}\n{text}" for name, text in research_parts)
            sections.append(f"## II. Research Team Decision\n\n{content}")

    # 3. Trading
    if final_state.get("trader_investment_plan"):
        trading_dir = save_path / "3_trading"
        trading_dir.mkdir(exist_ok=True)
        raw_text = str(final_state["trader_investment_plan"])
        text = raw_text if packet else _sanitize_final_proposals(raw_text)
        (trading_dir / "trader.md").write_text(text, encoding="utf-8")
        if not packet:
            sections.append(f"## III. Trading Team Plan\n\n### Trader\n{text}")

    # 4. Risk Management
    if final_state.get("risk_debate_state"):
        risk_dir = save_path / "4_risk"
        risk = final_state["risk_debate_state"]
        risk_parts = []
        if risk.get("aggressive_history"):
            risk_dir.mkdir(exist_ok=True)
            raw_text = str(risk["aggressive_history"])
            text = raw_text if packet else _sanitize_final_proposals(raw_text)
            (risk_dir / "aggressive.md").write_text(text, encoding="utf-8")
            risk_parts.append(("Aggressive Analyst", text))
        if risk.get("conservative_history"):
            risk_dir.mkdir(exist_ok=True)
            raw_text = str(risk["conservative_history"])
            text = raw_text if packet else _sanitize_final_proposals(raw_text)
            (risk_dir / "conservative.md").write_text(text, encoding="utf-8")
            risk_parts.append(("Conservative Analyst", text))
        if risk.get("neutral_history"):
            risk_dir.mkdir(exist_ok=True)
            raw_text = str(risk["neutral_history"])
            text = raw_text if packet else _sanitize_final_proposals(raw_text)
            (risk_dir / "neutral.md").write_text(text, encoding="utf-8")
            risk_parts.append(("Neutral Analyst", text))
        if risk_parts and not packet:
            content = "\n\n".join(f"### {name}\n{text}" for name, text in risk_parts)
            sections.append(f"## IV. Risk Management Team Decision\n\n{content}")

        # 5. Portfolio Manager
        if risk.get("judge_decision"):
            portfolio_dir = save_path / "5_portfolio"
            portfolio_dir.mkdir(exist_ok=True)
            raw_text = str(risk["judge_decision"])
            raw_final_decision = raw_text
            text = raw_text if packet else _sanitize_final_proposals(raw_text)
            (portfolio_dir / "decision.md").write_text(text, encoding="utf-8")
            if not packet:
                sections.append(
                    f"## V. Portfolio Manager Decision\n\n### Portfolio Manager\n{text}"
                )

    # Write consolidated report
    generated_at = datetime.now(timezone.utc).isoformat()
    omitted_unsafe_paragraphs = 0
    omitted_error_codes: set[str] = set()
    if packet:
        public_final_decision, omitted_unsafe_paragraphs, omitted_error_codes = (
            _filter_public_final_decision(raw_final_decision, packet)
        )
        public_final_decision = _sanitize_final_proposals(public_final_decision)
        if public_final_decision:
            sections.append(
                "## V. Portfolio Manager Decision\n\n"
                f"### Portfolio Manager\n{public_final_decision}"
            )
    else:
        public_final_decision = ""
    report_body = "\n\n".join(sections)
    status = str(final_state.get("analysis_status") or ("rated" if packet else "not_rated"))
    claim_validation = (
        validate_report_claims(public_final_decision, packet)
        if packet else {
            "status": "not_applicable",
            "errorCodes": [],
            "citationCount": 0,
            "unknownEvidenceIds": [],
            "invalidEvidenceCitations": [],
            "uncitedNumericParagraphs": 0,
            "unsupportedDerivedNumericParagraphs": 0,
            "unsupportedSingleSnapshotTrendParagraphs": 0,
            "contradictedMovingAverageAlignmentParagraphs": 0,
            "unsupportedActorOrFlowAttributionParagraphs": 0,
            "unsupportedWindowRankParagraphs": 0,
            "unsupportedCausalOrPathParagraphs": 0,
            "unsupportedFaceValueParagraphs": 0,
        }
    )
    if packet:
        claim_validation["omittedUnsafeParagraphs"] = omitted_unsafe_paragraphs
        blocking_filter_errors = set(omitted_error_codes)
        if omitted_unsafe_paragraphs:
            blocking_filter_errors.add("FILTERED_UNSAFE_PUBLIC_CLAIM")
        for error_code in sorted(blocking_filter_errors):
            if error_code not in claim_validation["errorCodes"]:
                claim_validation["errorCodes"].append(error_code)
        if blocking_filter_errors:
            claim_validation["status"] = "failed"
        if "MISSING_EVIDENCE_CITATION" in claim_validation["errorCodes"]:
            for error_code in sorted(omitted_error_codes):
                if error_code not in claim_validation["errorCodes"]:
                    claim_validation["errorCodes"].append(error_code)
            claim_validation["status"] = "failed"
    if packet and status == "rated" and claim_validation["status"] != "passed":
        status = "insufficient_evidence"
        final_state["analysis_status"] = status
    if packet and status == "insufficient_evidence":
        error_codes = ", ".join(claim_validation.get("errorCodes") or []) or "CLAIM_VALIDATION_FAILED"
        report_body = "\n\n".join([
            _render_evidence_snapshot(packet),
            (
                "## Research conclusion\n\n"
                "**Not Rated**\n\n"
                "The generated analysis did not pass the evidence claim gate, so the "
                "consolidated report intentionally withholds directional, allocation, "
                "and trading conclusions. Raw agent sections remain in the report "
                "subdirectories for audit only and must not be treated as verified output.\n\n"
                f"Validation errors: `{error_codes}`"
            ),
        ])
    audit_status = (
        "verified"
        if (
            packet
            and packet.get("status") == "ok"
            and status == "rated"
            and claim_validation["status"] == "passed"
        )
        else "legacy_unverified"
    )
    header = (
        f"# Trading Analysis Report: {ticker}\n\n"
        f"Generated: {generated_at}\n\n"
        f"Analysis status: `{status}` · Audit status: `{audit_status}`\n\n"
    )
    if packet:
        header += (
            f"Evidence as of: {packet.get('asOf', '—')} · "
            f"content hash: `{packet.get('contentHash', '—')}`\n\n"
        )
        header += (
            f"Evidence claim validation: `{claim_validation['status']}`"
            f"{' · ' + ', '.join(claim_validation['errorCodes']) if claim_validation['errorCodes'] else ''}\n\n"
        )
    (save_path / "complete_report.md").write_text(header + report_body, encoding="utf-8")
    packet_text = (
        json.dumps(packet, ensure_ascii=False, indent=2, allow_nan=False)
        if packet
        else None
    )
    packet_file_hash = (
        hashlib.sha256(packet_text.encode("utf-8")).hexdigest()
        if packet_text is not None
        else None
    )
    manifest = {
        "schemaVersion": 1,
        "ticker": str(ticker),
        "tradeDate": final_state.get("trade_date"),
        "generatedAt": generated_at,
        "analysisStatus": status,
        "auditStatus": audit_status,
        "claimValidation": claim_validation,
        "evidence": (
            {
                "schemaVersion": packet.get("schemaVersion"),
                "asOf": packet.get("asOf"),
                "contentHash": packet.get("contentHash"),
                "packetFileHash": packet_file_hash,
                "status": packet.get("status"),
                "marketHistory": _market_history_metadata(packet),
            }
            if packet else None
        ),
    }
    (save_path / "report_manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2, allow_nan=False),
        encoding="utf-8",
    )
    if packet_text is not None:
        (save_path / "evidence_packet.json").write_bytes(packet_text.encode("utf-8"))
    return save_path / "complete_report.md"
