"""Parse the structured ``标的代码`` field from the GitHub issue form.

Free-form titles and notes are deliberately ignored.  This prevents words such
as ``ISSUE`` or ``NEW`` from being guessed as tradable symbols.
"""

from __future__ import annotations

import re
import sys

FIELD = re.compile(r"(?mi)^###\s*标的代码\s*$\s*([\s\S]*?)(?=^###\s|\Z)")
def _normalize(raw: str) -> str | None:
    value = raw.strip().upper()
    if value in {"03887", "03887.HK", "3887", "3887.HK"}:
        return "3887.HK"
    if re.fullmatch(r"\d{4,5}(?:\.HK)?", value, re.IGNORECASE):
        code = value.removesuffix(".HK")
        return f"{code}.HK"
    a_share = re.fullmatch(r"(\d{6})(?:\.(SS|SH|SZ))?", value)
    if a_share:
        code, suffix = a_share.groups()
        expected = "SS" if code[0] in "569" else "SZ" if code[0] in "0123" else None
        suffix = "SS" if suffix == "SH" else suffix
        return f"{code}.{expected}" if expected and (not suffix or suffix == expected) else None
    if re.fullmatch(r"[A-Z]{1,5}(?:[.-][A-Z])?", value):
        return value.replace(".", "-")
    return None


def extract_tickers_from_issue_body(body: str, limit: int = 5) -> list[str]:
    match = FIELD.search(str(body or ""))
    if not match:
        return []
    seen: set[str] = set()
    tickers: list[str] = []
    for token in re.split(r"[,，\s]+", match.group(1).strip()):
        normalized = _normalize(token)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        tickers.append(normalized)
        if len(tickers) >= limit:
            break
    return tickers


if __name__ == "__main__":
    print(",".join(extract_tickers_from_issue_body(sys.stdin.read())))
