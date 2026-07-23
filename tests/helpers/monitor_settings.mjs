export function monitorSettings(overrides = {}) {
  const profile = {
    id: "etf-main",
    name: "ETF 监控",
    objective: "监控核心 ETF、比较标的和美股驱动因素。",
    enabled: true,
    timezone: "Asia/Shanghai",
    targets: [
      {
        symbol: "515880.SS",
        name: "通信 ETF",
        market: "CN",
        role: "core",
        analysis: "full",
      },
      {
        symbol: "159995.SZ",
        name: "芯片 ETF",
        market: "CN",
        role: "comparison",
        analysis: "signal",
      },
      {
        symbol: "SPY",
        name: "标普 500 ETF",
        market: "US",
        role: "driver",
        analysis: "signal",
      },
      {
        symbol: "QQQ",
        name: "纳指 ETF",
        market: "US",
        role: "core",
        analysis: "full",
      },
    ],
    systemBenchmarks: [],
    schedules: {
      usCloseSnapshot: { enabled: true, time: "05:35" },
      preMarketBrief: { enabled: true, time: "08:25" },
      cnIntraday: {
        enabled: true,
        windows: [
          { start: "09:30", end: "11:30" },
          { start: "13:00", end: "15:00" },
        ],
        collectionIntervalMinutes: 5,
        signalIntervalMinutes: 15,
      },
      closeDeepAnalysis: { enabled: true, time: "15:20" },
    },
    alerts: {
      channels: { web: true, pushPlus: false },
      pushMinSeverity: "high",
      quietHours: { start: "22:30", end: "07:30" },
    },
    agentBudget: {
      intradayLightSummariesPerDay: 3,
      fullAnalysesPerDay: 1,
    },
    ...overrides,
  };
  return { version: 2, profiles: [profile] };
}
