import {
  ProviderError,
  mapProviderSymbol,
  normalizeBar,
} from "./contracts.mjs";

function providerError(error, signal) {
  if (error instanceof ProviderError) return error;
  return new ProviderError(signal?.aborted ? "TIMEOUT" : "NETWORK_ERROR");
}

async function request(fetcher, url, { timeoutMs, format }) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException("provider timeout", "TimeoutError")),
    timeoutMs,
  );
  try {
    const response = await fetcher(url, { signal: controller.signal });
    if (!response?.ok) throw new ProviderError("HTTP_ERROR");
    try {
      return format === "text" ? await response.text() : await response.json();
    } catch {
      throw new ProviderError("MALFORMED_DATA");
    }
  } catch (error) {
    throw providerError(error, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

function zonedTimestamp(parts, timeZone) {
  const assumedUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour ?? 0),
    Number(parts.minute ?? 0),
    Number(parts.second ?? 0),
  );
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const offsetAt = (timestamp) => {
    const zoned = Object.fromEntries(
      formatter.formatToParts(new Date(timestamp))
        .filter(({ type }) => type !== "literal")
        .map(({ type, value: part }) => [type, Number(part)]),
    );
    return Date.UTC(
      zoned.year,
      zoned.month - 1,
      zoned.day,
      zoned.hour,
      zoned.minute,
      zoned.second,
    ) - timestamp;
  };
  let timestamp = assumedUtc - offsetAt(assumedUtc);
  timestamp = assumedUtc - offsetAt(timestamp);
  return new Date(timestamp).toISOString();
}

function utcTimestamp(value, timeZone) {
  if (typeof value === "number") return new Date(value * 1000).toISOString();
  if (typeof value !== "string") return value;
  const compact = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?$/.exec(value);
  if (compact) {
    const [, year, month, day, hour, minute, second = "00"] = compact;
    if (timeZone) {
      return zonedTimestamp({ year, month, day, hour, minute, second }, timeZone);
    }
    return `${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`;
  }
  const local = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(value);
  if (local) {
    const [, year, month, day, hour = "00", minute = "00", second = "00"] = local;
    if (timeZone) {
      return zonedTimestamp({ year, month, day, hour, minute, second }, timeZone);
    }
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T00:00:00.000Z`;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/.test(value)) {
    return `${value.replace(" ", "T")}${value.length === 16 ? ":00" : ""}.000Z`;
  }
  return value;
}

function normalizeRows(rows, context) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new ProviderError("MALFORMED_DATA");
  }
  return rows.map((row) => normalizeBar(row, context));
}

function tencentUrl(request) {
  const symbol = mapProviderSymbol("tencent", request.symbol);
  const series = request.timeframe === "5m" ? "m5" : "day";
  return `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},${series},,320`;
}

function parseTencent(payload, request) {
  const symbol = mapProviderSymbol("tencent", request.symbol);
  const series = request.timeframe === "5m" ? "m5" : "day";
  const rows = payload?.data?.[symbol]?.[series];
  return rows?.map(([timestamp, open, close, high, low, volume]) => ({
    timestamp: utcTimestamp(timestamp, "Asia/Shanghai"),
    open,
    high,
    low,
    close,
    volume,
  }));
}

function eastmoneyUrl(request) {
  const symbol = mapProviderSymbol("eastmoney", request.symbol);
  const klt = request.timeframe === "5m" ? "5" : "101";
  return `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${symbol}&klt=${klt}&fqt=0&lmt=320&fields1=f1&fields2=f51,f52,f53,f54,f55,f56`;
}

function parseEastmoney(payload) {
  return payload?.data?.klines?.map((line) => {
    const [timestamp, open, close, high, low, volume] = String(line).split(",");
    return {
      timestamp: utcTimestamp(timestamp, "Asia/Shanghai"),
      open,
      high,
      low,
      close,
      volume,
    };
  });
}

function yahooUrl(request) {
  const symbol = encodeURIComponent(mapProviderSymbol("yahoo", request.symbol));
  const interval = request.timeframe === "5m" ? "5m" : "1d";
  const range = request.timeframe === "5m" ? "5d" : "5y";
  return `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=${interval}&range=${range}&events=history`;
}

function parseYahoo(payload) {
  const result = payload?.chart?.result?.[0];
  const quote = result?.indicators?.quote?.[0];
  if (!result || !quote || !Array.isArray(result.timestamp)) return null;
  return result.timestamp.map((timestamp, index) => ({
    timestamp: utcTimestamp(timestamp),
    open: quote.open?.[index],
    high: quote.high?.[index],
    low: quote.low?.[index],
    close: quote.close?.[index],
    volume: quote.volume?.[index],
  }));
}

function alphaVantageUrl(request, apiKey) {
  const daily = request.timeframe === "1d";
  const parameters = new URLSearchParams({
    function: daily ? "TIME_SERIES_DAILY" : "TIME_SERIES_INTRADAY",
    symbol: mapProviderSymbol("alphavantage", request.symbol),
    outputsize: "compact",
    apikey: apiKey,
  });
  if (!daily) parameters.set("interval", "5min");
  return `https://www.alphavantage.co/query?${parameters}`;
}

function parseAlphaVantage(payload, timeframe) {
  const series = payload?.[
    timeframe === "1d" ? "Time Series (Daily)" : "Time Series (5min)"
  ];
  if (!series || typeof series !== "object") return null;
  return Object.entries(series).map(([timestamp, row]) => ({
    timestamp: utcTimestamp(timestamp, "America/New_York"),
    open: row["1. open"],
    high: row["2. high"],
    low: row["3. low"],
    close: row["4. close"],
    volume: row["5. volume"],
  }));
}

function stooqUrl(request) {
  return `https://stooq.com/q/d/l/?s=${mapProviderSymbol("stooq", request.symbol)}&i=d`;
}

function parseStooq(payload) {
  const lines = payload.trim().split(/\r?\n/);
  if (lines.length < 2) return null;
  return lines.slice(1).filter(Boolean).map((line) => {
    const [timestamp, open, high, low, close, volume] = line.split(",");
    return { timestamp: utcTimestamp(timestamp), open, high, low, close, volume };
  });
}

export function createAdapters({ fetch: fetcher, apiKey, timeoutMs }) {
  const fetchJson = (url) => request(fetcher, url, { timeoutMs, format: "json" });
  const contextFor = (request, source, fetchedAt, now, freshnessThresholdMs) => ({
    symbol: request.symbol,
    timeframe: request.timeframe,
    source,
    fetchedAt,
    now,
    freshnessThresholdMs,
  });
  return {
    tencent: async (marketRequest, runtime) => normalizeRows(
      parseTencent(await fetchJson(tencentUrl(marketRequest)), marketRequest),
      contextFor(marketRequest, "tencent", runtime.fetchedAt, runtime.now, runtime.freshnessThresholdMs),
    ),
    eastmoney: async (marketRequest, runtime) => normalizeRows(
      parseEastmoney(await fetchJson(eastmoneyUrl(marketRequest))),
      contextFor(marketRequest, "eastmoney", runtime.fetchedAt, runtime.now, runtime.freshnessThresholdMs),
    ),
    yahoo: async (marketRequest, runtime) => normalizeRows(
      parseYahoo(await fetchJson(yahooUrl(marketRequest))),
      contextFor(marketRequest, "yahoo", runtime.fetchedAt, runtime.now, runtime.freshnessThresholdMs),
    ),
    alphavantage: async (marketRequest, runtime) => normalizeRows(
      parseAlphaVantage(
        await fetchJson(alphaVantageUrl(marketRequest, apiKey)),
        marketRequest.timeframe,
      ),
      contextFor(marketRequest, "alphavantage", runtime.fetchedAt, runtime.now, runtime.freshnessThresholdMs),
    ),
    stooq: async (marketRequest, runtime) => normalizeRows(
      parseStooq(await request(fetcher, stooqUrl(marketRequest), {
        timeoutMs,
        format: "text",
      })),
      contextFor(marketRequest, "stooq", runtime.fetchedAt, runtime.now, runtime.freshnessThresholdMs),
    ),
  };
}
