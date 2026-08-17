const STRATEGIES = new Set(["momentum20", "ma5x20"]);

function tradeDate(value) {
  return /^\d{4}-\d{2}-\d{2}/.test(String(value || ""))
    ? String(value).slice(0, 10)
    : null;
}

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function canonicalBars(rows) {
  const byDate = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const date = tradeDate(row?.ts);
    const weekday = date ? new Date(`${date}T00:00:00Z`).getUTCDay() : null;
    const open = finitePositive(row?.open);
    const high = finitePositive(row?.high);
    const low = finitePositive(row?.low);
    const close = finitePositive(row?.close);
    const volume = Number(row?.volume);
    if (
      !date || weekday === 0 || weekday === 6 || !open || !high || !low || !close
      || high < Math.max(open, close, low)
      || low > Math.min(open, close, high)
      || !Number.isFinite(volume) || volume < 0
    ) continue;
    const current = byDate.get(date);
    if (!current || String(row.fetched_at || "") > String(current.fetched_at || "")) {
      byDate.set(date, { ...row, date, open, high, low, close, volume });
    }
  }
  return [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function signalAt(bars, index, strategy) {
  if (index < 20) return false;
  if (strategy === "momentum20") {
    return bars[index].close / bars[index - 20].close - 1 > 0;
  }
  const fast = mean(bars.slice(index - 4, index + 1).map(({ close }) => close));
  const slow = mean(bars.slice(index - 19, index + 1).map(({ close }) => close));
  const previousFast = mean(bars.slice(index - 5, index).map(({ close }) => close));
  const previousSlow = mean(bars.slice(index - 20, index).map(({ close }) => close));
  return fast > slow && previousFast <= previousSlow;
}

function maxDrawdown(equity) {
  let peak = 1;
  let worst = 0;
  for (const value of equity) {
    peak = Math.max(peak, value);
    worst = Math.min(worst, value / peak - 1);
  }
  return worst;
}

function unavailable(reason, bars = []) {
  return {
    status: "unavailable",
    reason,
    asOf: bars.at(-1)?.date || null,
    metrics: null,
    trades: [],
    audit: {
      signalKnowledge: "signal_day_close",
      execution: "next_trading_day_open",
      adjustment: null,
      limitations: ["不模拟停牌、涨跌停封单、申赎和盘口冲击，不代表实盘结果。"],
    },
  };
}

export function runBacktest(rows, options = {}) {
  const bars = canonicalBars(rows);
  const strategy = STRATEGIES.has(options.strategy) ? options.strategy : "momentum20";
  const holdingDays = Math.min(20, Math.max(1, Number(options.holdingDays) || 5));
  const requestedCostBps = options.costBps === undefined ? 3 : Number(options.costBps);
  const requestedSlippageBps = options.slippageBps === undefined ? 5 : Number(options.slippageBps);
  const costBps = Math.min(100, Math.max(0, Number.isFinite(requestedCostBps) ? requestedCostBps : 3));
  const slippageBps = Math.min(100, Math.max(0, Number.isFinite(requestedSlippageBps) ? requestedSlippageBps : 5));
  if (bars.length < 25) return unavailable("insufficient_history", bars);
  const adjustments = new Set(bars.map(({ adjustment }) => adjustment));
  if (adjustments.size !== 1 || !adjustments.has("qfq")) {
    return unavailable("requires_qfq_daily_bars", bars);
  }

  const sideFriction = (costBps + slippageBps) / 10000;
  const trades = [];
  let nextEligibleSignal = 20;
  for (let index = 20; index < bars.length - holdingDays - 1; index += 1) {
    if (index < nextEligibleSignal || !signalAt(bars, index, strategy)) continue;
    const entryIndex = index + 1;
    const exitIndex = entryIndex + holdingDays;
    const entry = bars[entryIndex];
    const exit = bars[exitIndex];
    if (entry.volume <= 0 || exit.volume <= 0) continue;
    const grossReturn = exit.open / entry.open - 1;
    const netReturn = (exit.open * (1 - sideFriction)) / (entry.open * (1 + sideFriction)) - 1;
    trades.push({
      signalDate: bars[index].date,
      entryDate: entry.date,
      exitDate: exit.date,
      entryPrice: entry.open,
      exitPrice: exit.open,
      grossReturn,
      netReturn,
    });
    nextEligibleSignal = exitIndex;
  }

  let equity = 1;
  const equityCurve = [equity];
  for (const trade of trades) {
    equity *= 1 + trade.netReturn;
    equityCurve.push(equity);
  }
  const benchmarkReturn = bars.at(-1).close / bars[0].close - 1;
  const sourceRows = new Map();
  for (const row of bars) sourceRows.set(row.source || "unknown", row);
  return {
    status: trades.length ? "ok" : "degraded",
    reason: trades.length ? null : "no_completed_trades",
    asOf: bars.at(-1).date,
    metrics: {
      sampleBars: bars.length,
      tradeCount: trades.length,
      totalReturn: equity - 1,
      benchmarkReturn,
      winRate: trades.length
        ? trades.filter(({ netReturn }) => netReturn > 0).length / trades.length
        : null,
      maxDrawdown: maxDrawdown(equityCurve),
    },
    trades,
    sources: [...sourceRows.values()].map((row) => ({
      source: row.source || "unknown",
      asOf: row.as_of || row.ts || null,
      fetchedAt: row.fetched_at || null,
      freshness: row.freshness || "unknown",
      adjustment: row.adjustment || null,
      quality: row.quality || "unknown",
    })),
    audit: {
      strategy,
      signalKnowledge: "signal_day_close",
      execution: "next_trading_day_open",
      exit: `open_after_${holdingDays}_trading_days`,
      adjustment: "qfq",
      costBpsPerSide: costBps,
      slippageBpsPerSide: slippageBps,
      overlappingPositions: false,
      limitations: [
        "当前仅使用工作台已存日线；不使用未来数据。",
        "不模拟停牌、涨跌停封单、申赎、最低佣金和盘口冲击，不代表实盘结果。",
      ],
    },
  };
}
