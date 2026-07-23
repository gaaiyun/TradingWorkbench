import {
  queryMarketBars,
  queryMarketEvents,
  queryNewsItems,
} from "./_d1_repository.mjs";
import { hashChatValue } from "./_chat_repository.mjs";
import { calculateTechnicalSnapshot } from "./_indicators.mjs";

function value(value) {
  return value === null || value === undefined || value === "" ? "—" : String(value);
}

function line(parts) {
  return parts.filter(Boolean).join(" | ");
}

function latestAsOf(rows) {
  return rows.reduce((latest, row) => {
    const candidate = row.as_of || row.ts || row.published_at || row.event_at || null;
    return candidate && (!latest || candidate > latest) ? candidate : latest;
  }, null);
}

function evidenceTimeframes(symbol) {
  return /\.(?:SS|SZ)$/.test(symbol) ? ["5m", "15m"] : ["1d"];
}

function periodsPerYear(timeframe) {
  if (timeframe === "5m") return 48 * 252;
  if (timeframe === "15m") return 16 * 252;
  return 252;
}

function macdRelation(snapshot) {
  if (snapshot.macdHistogram === null) return "暂无可靠关系";
  if (snapshot.macdHistogram > 0) return "快线高于信号线";
  if (snapshot.macdHistogram < 0) return "快线低于信号线";
  return "快线等于信号线";
}

function aliasIndex(question, alias) {
  const value = String(alias || "").trim();
  if (!value) return -1;
  if (/^[A-Z0-9.^_-]+$/i.test(value)) {
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`(?:^|[^A-Z0-9])${escaped}(?![A-Z0-9])`, "i").exec(question);
    return match?.index ?? -1;
  }
  return question.indexOf(value);
}

export function resolveWorkbenchTarget(settings, {
  profileId,
  question,
  requestedSymbol,
}) {
  const fallback = requestedSymbol ? String(requestedSymbol).toUpperCase() : null;
  const profile = settings?.profiles?.find((candidate) => candidate?.id === profileId);
  if (!profile) return fallback;
  const targets = [...(profile.targets || []), ...(profile.systemBenchmarks || [])]
    .filter((target) => target?.symbol);
  const text = String(question || "");
  const matches = [];
  for (const target of targets) {
    const symbol = String(target.symbol).toUpperCase();
    const aliases = [symbol, target.name, target.label];
    if (/^\d{6}\.(?:SS|SZ)$/.test(symbol)) aliases.push(symbol.slice(0, 6));
    const indexes = aliases.map((alias) => aliasIndex(text, alias)).filter((index) => index >= 0);
    if (indexes.length) matches.push({ symbol, index: Math.min(...indexes) });
  }
  matches.sort((left, right) => left.index - right.index);
  return matches[0]?.symbol || fallback;
}

export async function loadWorkbenchEvidence(db, {
  profileId,
  symbol,
  now = new Date(),
}) {
  if (!db || !profileId || !symbol) {
    return {
      context: "",
      contextLabel: "",
      contextHash: await hashChatValue(""),
      evidence: [],
      asOf: null,
      source: {
        type: "workbench",
        label: "动态工作台暂无可用证据",
        chars: 0,
        truncated: false,
        status: "unavailable",
      },
    };
  }

  const query = {
    profile: profileId,
    symbol,
    from: null,
    to: null,
  };
  const timeframes = evidenceTimeframes(symbol);
  const [barGroups, news, events] = await Promise.all([
    Promise.all(timeframes.map((timeframe) => (
      queryMarketBars(db, { ...query, timeframe, limit: 80 })
    ))),
    queryNewsItems(db, { ...query, topic: null, limit: 8 }),
    queryMarketEvents(db, { ...query, topic: null, importance: null, limit: 8 }),
  ]);
  const selectedIndex = barGroups.findIndex((rows) => rows.length);
  const bars = selectedIndex >= 0 ? barGroups[selectedIndex] : [];
  const timeframe = selectedIndex >= 0 ? timeframes[selectedIndex] : timeframes[0];
  const evidence = [];
  const lines = [
    "以下是服务端动态证据账本。只能依据这些记录和随后附加的研究报告作答；引用时使用证据编号。",
  ];

  [...bars].slice(0, 4).reverse().forEach((row, index) => {
    const id = `M${index + 1}`;
    lines.push(`[${id}] ${line([
      `行情 ${row.symbol}`,
      `周期 ${row.timeframe}`,
      `时间 ${row.ts}`,
      `开 ${value(row.open)}`,
      `高 ${value(row.high)}`,
      `低 ${value(row.low)}`,
      `收 ${value(row.close)}`,
      `量 ${value(row.volume)}`,
      `来源 ${row.source}`,
      `asOf ${row.as_of}`,
      `质量 ${row.freshness}/${row.quality}`,
    ])}`);
    evidence.push({
      id,
      type: "market",
      title: `${row.symbol} ${row.timeframe} 行情`,
      asOf: row.as_of || row.ts,
      source: row.source,
      url: null,
    });
  });
  if (bars.length) {
    const snapshot = calculateTechnicalSnapshot(bars, {
      periodsPerYear: periodsPerYear(timeframe),
    });
    lines.push(`[I1] ${line([
      `指标 ${symbol}`,
      `版本 ${snapshot.version}`,
      `时间 ${snapshot.asOf}`,
      `样本 ${snapshot.bars}根`,
      `MA20 ${value(snapshot.ma20)}`,
      `MA60 ${value(snapshot.ma60)}`,
      `MACD ${value(snapshot.macd)}`,
      `信号线 ${value(snapshot.macdSignal)}`,
      `MACD柱 ${value(snapshot.macdHistogram)}`,
      `关系 ${macdRelation(snapshot)}`,
      `RSI14 ${value(snapshot.rsi14)}`,
      `ATR14 ${value(snapshot.atr14)}`,
      `20期实现波动率 ${value(snapshot.realizedVolatility20)}%`,
      `复权 ${snapshot.adjustment}`,
    ])}`);
    evidence.push({
      id: "I1",
      type: "indicator",
      title: `${symbol} ${timeframe} 技术指标`,
      asOf: snapshot.asOf,
      source: snapshot.version,
      url: null,
    });
  }
  news.forEach((row, index) => {
    const id = `N${index + 1}`;
    lines.push(`[${id}] ${line([
      `新闻 ${row.title}`,
      row.summary ? `摘要 ${row.summary}` : "",
      `发布时间 ${row.published_at}`,
      `来源 ${row.source}`,
      row.url ? `原文 ${row.url}` : "",
      `质量 ${row.freshness}/${row.quality}`,
    ])}`);
    evidence.push({
      id,
      type: "news",
      title: row.title,
      asOf: row.published_at,
      source: row.source,
      url: row.url || null,
    });
  });
  events.forEach((row, index) => {
    const id = `E${index + 1}`;
    lines.push(`[${id}] ${line([
      `事件 ${row.title}`,
      row.description ? `说明 ${row.description}` : "",
      `时间 ${row.event_at}`,
      `重要性 ${row.importance}`,
      `来源 ${row.source}`,
      `质量 ${row.freshness}/${row.quality}`,
    ])}`);
    evidence.push({
      id,
      type: "event",
      title: row.title,
      asOf: row.event_at,
      source: row.source,
      url: null,
    });
  });

  const allRows = [...bars, ...news, ...events];
  if (!evidence.length) {
    lines.push("当前没有该标的的动态行情、新闻或事件证据。涉及今日涨跌原因时，必须明确回答“证据不足，无法可靠归因”。");
  }
  const context = lines.join("\n");
  return {
    context,
    contextLabel: `${symbol} 动态证据账本`,
    contextHash: await hashChatValue(context),
    evidence,
    asOf: latestAsOf(allRows),
    source: {
      type: "workbench",
      label: `${symbol} 动态证据账本`,
      chars: context.length,
      truncated: false,
      status: evidence.length ? "ok" : "unavailable",
      fetchedAt: now.toISOString(),
    },
  };
}
