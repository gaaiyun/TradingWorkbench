"""Keyless, first-party news collectors (SEC EDGAR and Federal Reserve RSS)."""

from __future__ import annotations

import html
import os
import re
from datetime import datetime
from functools import lru_cache
from xml.etree import ElementTree

import requests

from .news_common import NewsItem, clean_text, parse_timestamp, timestamp_in_window
from .symbol_utils import normalize_symbol

SEC_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"
SEC_SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK{cik:010d}.json"
SEC_ARCHIVE_URL = "https://www.sec.gov/Archives/edgar/data/{cik}/{accession}/{document}"
FEDERAL_RESERVE_RSS_URL = "https://www.federalreserve.gov/feeds/press_all.xml"

_NON_US_SUFFIXES = (
    ".AX",
    ".BO",
    ".HK",
    ".L",
    ".NS",
    ".SS",
    ".SZ",
    ".T",
    ".TO",
)


def sec_user_agent(user_agent: str, contact_email: str | None = None) -> str:
    """Return an EDGAR fair-access User-Agent without exposing the email.

    SEC requires an identifying contact address.  The address is deliberately
    supplied through runtime configuration (or ``TRADINGAGENTS_SEC_CONTACT_EMAIL``)
    rather than committed to the repository.
    """
    base = str(user_agent or "").strip()
    email = str(
        contact_email
        if contact_email is not None
        else os.getenv("TRADINGAGENTS_SEC_CONTACT_EMAIL", "")
    ).strip()
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        return base
    if email.casefold() in base.casefold():
        return base
    return f"{base} {email}".strip()


def _get_json(url: str, *, timeout: int, user_agent: str) -> dict:
    response = requests.get(
        url,
        headers={
            "User-Agent": user_agent,
            "Accept": "application/json",
            "Accept-Encoding": "gzip, deflate",
        },
        timeout=timeout,
    )
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, dict):
        raise ValueError(f"Expected a JSON object from {url}")
    return payload


@lru_cache(maxsize=4)
def _sec_ticker_map(timeout: int, user_agent: str) -> dict[str, tuple[int, str]]:
    payload = _get_json(SEC_TICKERS_URL, timeout=timeout, user_agent=user_agent)
    result: dict[str, tuple[int, str]] = {}
    for entry in payload.values():
        if not isinstance(entry, dict):
            continue
        ticker = clean_text(entry.get("ticker")).upper()
        try:
            cik = int(entry.get("cik_str"))
        except (TypeError, ValueError):
            continue
        if ticker:
            result[ticker] = (cik, clean_text(entry.get("title")))
    return result


def _sec_symbol(ticker: str) -> str | None:
    symbol = normalize_symbol(ticker).strip().upper()
    if (
        not symbol
        or symbol.startswith("^")
        or symbol.endswith(_NON_US_SUFFIXES)
        or symbol.endswith("-USD")
        or "=" in symbol
    ):
        return None
    # EDGAR represents class separators with a hyphen (BRK-B, BF-B).
    symbol = symbol.replace(".", "-")
    return symbol if re.fullmatch(r"[A-Z0-9-]{1,12}", symbol) else None


def fetch_sec_filings(
    ticker: str,
    *,
    fetched_at: datetime,
    limit: int,
    timeout: int,
    user_agent: str,
    forms: set[str],
    sec_contact_email: str | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
    window_timezone: str = "UTC",
) -> list[NewsItem]:
    """Return recent material EDGAR filings for a US-listed ticker.

    EDGAR is a primary source, not a newspaper.  Filings are intentionally
    labelled as such so downstream consumers do not mistake them for reporting.
    """
    sec_symbol = _sec_symbol(ticker)
    if sec_symbol is None:
        return []
    user_agent = sec_user_agent(user_agent, sec_contact_email)
    mapping = _sec_ticker_map(timeout, user_agent)
    match = mapping.get(sec_symbol)
    if match is None:
        return []

    cik, company_name = match
    payload = _get_json(
        SEC_SUBMISSIONS_URL.format(cik=cik),
        timeout=timeout,
        user_agent=user_agent,
    )
    recent = payload.get("filings", {}).get("recent", {})
    if not isinstance(recent, dict):
        return []

    forms_data = recent.get("form", [])
    accessions = recent.get("accessionNumber", [])
    filing_dates = recent.get("filingDate", [])
    acceptance_times = recent.get("acceptanceDateTime", [])
    report_dates = recent.get("reportDate", [])
    documents = recent.get("primaryDocument", [])
    descriptions = recent.get("primaryDocDescription", [])

    items: list[NewsItem] = []
    for index, form in enumerate(forms_data):
        form = clean_text(form).upper()
        if forms and form not in forms:
            continue
        try:
            accession = clean_text(accessions[index])
            filing_date = clean_text(filing_dates[index])
        except IndexError:
            continue
        accepted = acceptance_times[index] if index < len(acceptance_times) else filing_date
        published_at = parse_timestamp(accepted) or parse_timestamp(filing_date)
        if published_at is None or not accession:
            continue
        if start_date and end_date and not timestamp_in_window(
            published_at, start_date, end_date, window_timezone,
        ):
            continue

        document = clean_text(documents[index]) if index < len(documents) else ""
        description = clean_text(descriptions[index]) if index < len(descriptions) else ""
        report_date = clean_text(report_dates[index]) if index < len(report_dates) else ""
        url = ""
        if document:
            url = SEC_ARCHIVE_URL.format(
                cik=cik,
                accession=accession.replace("-", ""),
                document=document,
            )
        summary_parts = [f"Filed {filing_date}"]
        if report_date:
            summary_parts.append(f"reporting period {report_date}")
        summary_parts.append(f"accession {accession}")
        summary = "; ".join(summary_parts) + "."
        title_detail = description if description and description.upper() != form else form
        items.append(
            NewsItem(
                title=f"{company_name or sec_symbol} SEC {form} filing: {title_detail}",
                summary=summary,
                url=url,
                source="SEC EDGAR",
                published_at=published_at,
                fetched_at=fetched_at,
                ticker=ticker,
                source_tier="primary",
            )
        )
        if len(items) >= limit:
            break
    return items


def _strip_markup(value: str) -> str:
    return clean_text(html.unescape(re.sub(r"<[^>]+>", " ", value or "")))


def fetch_federal_reserve_news(
    *,
    fetched_at: datetime,
    limit: int,
    timeout: int,
    user_agent: str,
    start_date: str | None = None,
    end_date: str | None = None,
    window_timezone: str = "UTC",
) -> list[NewsItem]:
    """Return official Federal Reserve press releases from its public RSS feed."""
    response = requests.get(
        FEDERAL_RESERVE_RSS_URL,
        headers={"User-Agent": user_agent, "Accept": "application/rss+xml, application/xml"},
        timeout=timeout,
    )
    response.raise_for_status()
    root = ElementTree.fromstring(response.content)
    items: list[NewsItem] = []
    for node in root.findall(".//item"):
        title = clean_text(node.findtext("title"))
        published_at = parse_timestamp(node.findtext("pubDate"))
        if not title or published_at is None:
            continue
        if start_date and end_date and not timestamp_in_window(
            published_at, start_date, end_date, window_timezone,
        ):
            continue
        items.append(
            NewsItem(
                title=title,
                summary=_strip_markup(node.findtext("description") or ""),
                url=clean_text(node.findtext("link")),
                source="Federal Reserve",
                published_at=published_at,
                fetched_at=fetched_at,
                ticker=None,
                source_tier="primary",
            )
        )
        if len(items) >= limit:
            break
    return items
