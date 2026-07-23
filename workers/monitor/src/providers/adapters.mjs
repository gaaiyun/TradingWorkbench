import {
  ProviderError,
  mapProviderSymbol,
  normalizeBar,
} from "./contracts.mjs";

function providerError(error, signal) {
  if (error instanceof ProviderError) return error;
  return new ProviderError(signal?.aborted ? "TIMEOUT" : "NETWORK_ERROR");
}

function providerHeaders(url) {
  const headers = new Headers({
    accept: "application/json,text/plain,*/*",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/138 Safari/537.36",
  });
  const hostname = new URL(url).hostname;
  if (hostname.endsWith("eastmoney.com")) {
    headers.set("referer", "https://quote.eastmoney.com/");
  } else if (hostname.endsWith("finance.yahoo.com")) {
    headers.set("referer", "https://finance.yahoo.com/");
  } else if (hostname.endsWith("gtimg.cn")) {
    headers.set("referer", "https://gu.qq.com/");
  }
  return headers;
}

async function request(fetcher, url, { timeoutMs, format }) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException("provider timeout", "TimeoutError")),
    timeoutMs,
  );
  try {
    const response = await fetcher(url, {
      signal: controller.signal,
      headers: providerHeaders(url),
    });
    if (!response?.ok) throw new ProviderError("HTTP_ERROR");
    try {
      return {
        body: format === "text" ? await response.text() : await response.json(),
        contentType: response.headers.get("content-type") ?? "",
      };
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
  const limit = request.limit || 320;
  if (request.timeframe === "5m") {
    return `https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=${symbol},m5,,${limit}`;
  }
  return `https://ifzq.gtimg.cn/appstock/app/kline/kline?param=${symbol},day,,,${limit}`;
}

function parseTencent(payload, request) {
  if (payload?.code !== 0) return null;
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

function tencentUsUrl(request) {
  const symbol = mapProviderSymbol("tencent-us", request.symbol);
  return `https://web.ifzq.gtimg.cn/appstock/app/usfqkline/get?param=${symbol},day,,,${request.limit || 320},qfq`;
}

function parseTencentUs(payload, request) {
  if (payload?.code !== 0) return null;
  const symbol = mapProviderSymbol("tencent-us", request.symbol);
  const rows = payload?.data?.[symbol]?.day?.map(
    ([timestamp, open, close, high, low, volume]) => ({
      timestamp: utcTimestamp(timestamp, "America/New_York"),
      open,
      high,
      low,
      close,
      volume,
    }),
  );
  if (!Array.isArray(rows) || rows.length < 2) return rows;
  const sorted = [...rows].sort(
    (left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp),
  );
  let start = sorted.length - 1;
  while (start > 0) {
    const gap = Date.parse(sorted[start].timestamp) - Date.parse(sorted[start - 1].timestamp);
    if (!Number.isFinite(gap) || gap > 7 * 24 * 60 * 60 * 1000) break;
    start -= 1;
  }
  return sorted.slice(start);
}

function eastmoneyUsUrl(request) {
  const symbol = mapProviderSymbol("eastmoney-us", request.symbol);
  return `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${symbol}&klt=101&fqt=1&beg=0&end=20500101&lmt=${request.limit || 320}&fields1=f1&fields2=f51,f52,f53,f54,f55,f56`;
}

function parseEastmoneyUs(payload, request) {
  if (payload?.rc !== 0 || payload?.data?.code !== request.symbol) return null;
  return payload?.data?.klines?.slice(-(request.limit || 320)).map((line) => {
    const [timestamp, open, close, high, low, volume] = String(line).split(",");
    return {
      timestamp: utcTimestamp(timestamp, "America/New_York"),
      open,
      high,
      low,
      close,
      volume,
    };
  });
}

function eastmoneyUrl(request) {
  const symbol = mapProviderSymbol("eastmoney", request.symbol);
  const klt = request.timeframe === "5m" ? "5" : "101";
  return `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${symbol}&klt=${klt}&fqt=0&beg=0&end=20500101&lmt=${request.limit || 320}&fields1=f1&fields2=f51,f52,f53,f54,f55,f56`;
}

function parseEastmoney(payload, request) {
  if (payload?.rc !== 0 || payload?.data?.code !== request.symbol.slice(0, 6)) {
    return null;
  }
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

function yahooUrl(request, host = "query1") {
  const symbol = encodeURIComponent(mapProviderSymbol("yahoo", request.symbol));
  const interval = request.timeframe === "5m" ? "5m" : "1d";
  const range = request.timeframe === "5m" ? "5d" : "5y";
  return `https://${host}.finance.yahoo.com/v8/finance/chart/${symbol}?interval=${interval}&range=${range}&events=history`;
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
  })).filter((row) =>
    row.timestamp &&
    [row.open, row.high, row.low, row.close, row.volume]
      .every((value) => value !== null && value !== undefined)
  );
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

function parseStooq(payload, contentType) {
  if (
    contentType.toLowerCase().includes("text/html") ||
    /requires javascript to verify|<noscript/i.test(payload)
  ) {
    throw new ProviderError("UPSTREAM_CHALLENGE");
  }
  if (
    contentType &&
    !/(?:text\/csv|text\/plain|application\/octet-stream)/i.test(contentType)
  ) {
    throw new ProviderError("MALFORMED_DATA");
  }
  const lines = payload.trim().split(/\r?\n/);
  if (
    lines.length < 2 ||
    lines[0].trim().toLowerCase() !== "date,open,high,low,close,volume"
  ) {
    return null;
  }
  return lines.slice(1).filter(Boolean).map((line) => {
    const [timestamp, open, high, low, close, volume] = line.split(",");
    return { timestamp: utcTimestamp(timestamp), open, high, low, close, volume };
  });
}

export function createAdapters({ fetch: fetcher, apiKey, timeoutMs }) {
  const fetchJson = async (url) => (
    await request(fetcher, url, { timeoutMs, format: "json" })
  ).body;
  const contextFor = (
    request,
    source,
    fetchedAt,
    now,
    freshnessThresholdMs,
    adjustment = "none",
  ) => ({
    symbol: request.symbol,
    timeframe: request.timeframe,
    source,
    fetchedAt,
    now,
    freshnessThresholdMs,
    adjustment,
  });
  return {
    tencent: async (marketRequest, runtime) => normalizeRows(
      parseTencent(await fetchJson(tencentUrl(marketRequest)), marketRequest),
      contextFor(marketRequest, "tencent", runtime.fetchedAt, runtime.now, runtime.freshnessThresholdMs),
    ),
    "tencent-us": async (marketRequest, runtime) => normalizeRows(
      parseTencentUs(await fetchJson(tencentUsUrl(marketRequest)), marketRequest),
      contextFor(
        marketRequest,
        "tencent-us",
        runtime.fetchedAt,
        runtime.now,
        runtime.freshnessThresholdMs,
        "qfq",
      ),
    ),
    "eastmoney-us": async (marketRequest, runtime) => normalizeRows(
      parseEastmoneyUs(await fetchJson(eastmoneyUsUrl(marketRequest)), marketRequest),
      contextFor(
        marketRequest,
        "eastmoney-us",
        runtime.fetchedAt,
        runtime.now,
        runtime.freshnessThresholdMs,
        "qfq",
      ),
    ),
    eastmoney: async (marketRequest, runtime) => normalizeRows(
      parseEastmoney(await fetchJson(eastmoneyUrl(marketRequest)), marketRequest),
      contextFor(marketRequest, "eastmoney", runtime.fetchedAt, runtime.now, runtime.freshnessThresholdMs),
    ),
    yahoo: async (marketRequest, runtime) => {
      const load = async (host) => normalizeRows(
        parseYahoo(await fetchJson(yahooUrl(marketRequest, host))),
        contextFor(
          marketRequest,
          "yahoo",
          runtime.fetchedAt,
          runtime.now,
          runtime.freshnessThresholdMs,
        ),
      );
      try {
        return await load("query1");
      } catch (error) {
        if (marketRequest.timeframe !== "1d") throw error;
        return load("query2");
      }
    },
    alphavantage: async (marketRequest, runtime) => normalizeRows(
      parseAlphaVantage(
        await fetchJson(alphaVantageUrl(marketRequest, apiKey)),
        marketRequest.timeframe,
      ),
      contextFor(marketRequest, "alphavantage", runtime.fetchedAt, runtime.now, runtime.freshnessThresholdMs),
    ),
    stooq: async (marketRequest, runtime) => {
      const response = await request(fetcher, stooqUrl(marketRequest), {
        timeoutMs,
        format: "text",
      });
      return normalizeRows(
        parseStooq(response.body, response.contentType),
        contextFor(
          marketRequest,
          "stooq",
          runtime.fetchedAt,
          runtime.now,
          runtime.freshnessThresholdMs,
        ),
      );
    },
  };
}
