"""Point-in-time evidence packets shared by the UI, agents, and reports.

The packet is intentionally deterministic and provider-neutral.  Providers
only supply rows plus provenance; this module decides whether those rows are
safe enough to support a rated conclusion.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Any

from tradingagents.dataflows.symbol_utils import normalize_symbol

SCHEMA_VERSION = "EvidencePacketV1"
_JUMP_THRESHOLD = 0.25


class EvidenceValidationError(ValueError):
    """Raised when a packet cannot satisfy the minimum evidence contract."""


def _iso(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise EvidenceValidationError(f"{field} is required")
    text = value.strip().replace("Z", "+00:00")
    try:
        timestamp = datetime.fromisoformat(text)
    except ValueError as exc:
        raise EvidenceValidationError(f"{field} is invalid") from exc
    if timestamp.tzinfo is None:
        timestamp = timestamp.replace(tzinfo=timezone.utc)
    return timestamp.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _time(value: Any) -> datetime:
    return datetime.fromisoformat(_iso(value, "timestamp").replace("Z", "+00:00"))


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _hashable(packet: Mapping[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in packet.items() if key not in {"contentHash", "generatedAt"}}


def _content_hash(packet: Mapping[str, Any]) -> str:
    return hashlib.sha256(_json(_hashable(packet)).encode("utf-8")).hexdigest()


def _bar(row: Mapping[str, Any], as_of: datetime) -> dict[str, Any]:
    timestamp = _time(row.get("ts") or row.get("timestamp"))
    if timestamp > as_of:
        raise EvidenceValidationError("bar timestamp is in the future")
    close = float(row.get("close"))
    if close <= 0:
        raise EvidenceValidationError("bar close must be positive")
    result = {
        "ts": timestamp.isoformat().replace("+00:00", "Z"),
        "open": float(row.get("open", close)),
        "high": float(row.get("high", close)),
        "low": float(row.get("low", close)),
        "close": close,
        "volume": float(row.get("volume", 0) or 0),
    }
    adjustment = row.get("adjustment")
    if adjustment:
        result["adjustment"] = str(adjustment)
    return result


def _news(row: Mapping[str, Any], as_of: datetime) -> dict[str, Any] | None:
    published = row.get("publishedAt") or row.get("published_at")
    if not published:
        return None
    timestamp = _time(published)
    if timestamp > as_of:
        return None
    result = {
        "id": str(row.get("id") or ""),
        "title": str(row.get("title") or "")[:300],
        "publishedAt": timestamp.isoformat().replace("+00:00", "Z"),
        "url": str(row.get("url") or ""),
        "source": str(row.get("source") or ""),
        "sourceTier": str(row.get("sourceTier") or row.get("source_tier") or "discovery"),
    }
    if not result["title"]:
        return None
    return result


def build_evidence_packet(
    *,
    ticker: str,
    asset_type: str,
    as_of: str,
    bars: list[Mapping[str, Any]],
    indicators: Mapping[str, Any] | None = None,
    sources: list[Mapping[str, Any]] | None = None,
    corporate_actions: list[Mapping[str, Any]] | None = None,
    news: list[Mapping[str, Any]] | None = None,
    financials: Mapping[str, Any] | None = None,
    generated_at: str | None = None,
) -> dict[str, Any]:
    """Build a validated, point-in-time packet.

    The packet never invents missing rows.  A provider can return a degraded
    packet, but a corporate-action jump on an unadjusted series is explicitly
    non-rateable.
    """

    cutoff = _time(as_of)
    generated = _iso(generated_at or datetime.now(timezone.utc).isoformat(), "generatedAt")
    symbol = normalize_symbol(ticker)
    normalized_bars = sorted(
        [_bar(row, cutoff) for row in (bars or [])],
        key=lambda row: row["ts"],
    )
    for index, row in enumerate(normalized_bars, start=1):
        row["evidenceId"] = f"M{index}"
    actions = [
        {"evidenceId": f"CA{index}", **dict(action)}
        for index, action in enumerate((corporate_actions or []), start=1)
    ]
    errors: list[str] = []
    warnings: list[str] = []

    for previous, current in zip(normalized_bars, normalized_bars[1:], strict=False):
        previous_close = previous["close"]
        change = abs(current["close"] / previous_close - 1) if previous_close else 0
        if change < _JUMP_THRESHOLD:
            continue
        nearby_action = any(
            str(action.get("exDate") or action.get("date") or "")[:10]
            == current["ts"][:10]
            for action in actions
        )
        if not nearby_action:
            errors.append("UNEXPLAINED_PRICE_JUMP")
        elif str(current.get("adjustment") or previous.get("adjustment") or "none").lower() in {
            "none",
            "raw",
            "unadjusted",
        }:
            errors.append("CORPORATE_ACTION_UNADJUSTED")
        else:
            warnings.append("CORPORATE_ACTION_PRESENT")

    normalized_news = [
        item for row in (news or []) if (item := _news(row, cutoff)) is not None
    ]
    for index, row in enumerate(normalized_news, start=1):
        row["evidenceId"] = f"N{index}"
    source_rows = [
        {
            "evidenceId": f"S{index}",
            "source": str(row.get("source") or "unknown"),
            "asOf": row.get("asOf") or row.get("as_of"),
            "fetchedAt": row.get("fetchedAt") or row.get("fetched_at"),
            "sourceTier": str(row.get("sourceTier") or row.get("source_tier") or "discovery"),
        }
        for index, row in enumerate((sources or []), start=1)
    ]
    status = "ok"
    if errors:
        status = "data_validation_failed"
    elif not normalized_bars:
        status = "unavailable"
    elif not source_rows or any(row["source"] == "unknown" for row in source_rows):
        status = "degraded"

    packet: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "status": status,
        "canRate": status in {"ok", "degraded"} and bool(normalized_bars),
        "asOf": cutoff.isoformat().replace("+00:00", "Z"),
        "generatedAt": generated,
        "instrument": {
            "symbol": symbol,
            "inputSymbol": str(ticker),
            "assetType": str(asset_type),
            "market": (
                "CN" if symbol.endswith((".SS", ".SZ"))
                else "HK" if symbol.endswith(".HK")
                else "US"
            ),
        },
        "bars": normalized_bars,
        "indicators": dict(indicators or {}),
        "corporateActions": actions,
        "financials": dict(financials or {}),
        "news": normalized_news,
        "sources": source_rows,
        "integrity": {
            "barCount": len(normalized_bars),
            "newsCount": len(normalized_news),
            "errors": sorted(set(errors)),
            "warnings": sorted(set(warnings)),
            "pointInTime": True,
        },
    }
    packet["contentHash"] = _content_hash(packet)
    return packet


def validate_evidence_packet(packet: Mapping[str, Any]) -> None:
    if not isinstance(packet, Mapping):
        raise EvidenceValidationError("packet must be an object")
    if packet.get("schemaVersion") != SCHEMA_VERSION:
        raise EvidenceValidationError("unsupported evidence schema")
    if not packet.get("contentHash") or packet.get("contentHash") != _content_hash(packet):
        raise EvidenceValidationError("contentHash is invalid")
    if packet.get("status") == "data_validation_failed" and packet.get("canRate"):
        raise EvidenceValidationError("failed packets cannot be rateable")
    instrument = packet.get("instrument")
    if not isinstance(instrument, Mapping) or not instrument.get("symbol"):
        raise EvidenceValidationError("instrument identity is required")
