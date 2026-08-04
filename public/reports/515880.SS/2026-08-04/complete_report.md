# Trading Analysis Report: 515880.SS

Generated: 2026-08-04T08:19:41.657828+00:00

Analysis status: `insufficient_evidence` · Audit status: `legacy_unverified`

Evidence as of: 2026-08-04T08:07:01Z · content hash: `c9f2addd15cae3155dd13ce0db74e8b2923da44fcd7fd9e09dce7c03a600b4db`

Evidence claim validation: `failed` · FILTERED_UNSAFE_PUBLIC_CLAIM, UNSUPPORTED_CAUSAL_OR_PATH_CLAIM, UNSUPPORTED_DERIVED_NUMERIC_CLAIM

## Evidence Snapshot

- Status `ok`; as of `2026-08-04T08:07:01Z`; instrument `515880.SS` [M648]
- Market history: source `tencent`; adjustment `qfq`; 648 bars from `2023-11-29T16:00:00Z` to `2026-08-03T16:00:00Z`

### Latest market bars

- [M644] trade date 2026-07-29 (raw UTC 2026-07-28T16:00:00Z): O 0.599 · H 0.61 · L 0.574 · C 0.602 · volume 79074757.0
- [M645] trade date 2026-07-30 (raw UTC 2026-07-29T16:00:00Z): O 0.593 · H 0.597 · L 0.542 · C 0.555 · volume 110354509.0
- [M646] trade date 2026-07-31 (raw UTC 2026-07-30T16:00:00Z): O 0.601 · H 0.611 · L 0.581 · C 0.582 · volume 93598605.0
- [M647] trade date 2026-08-03 (raw UTC 2026-08-02T16:00:00Z): O 0.57 · H 0.595 · L 0.57 · C 0.582 · volume 46569718.0
- [M648] trade date 2026-08-04 (raw UTC 2026-08-03T16:00:00Z): O 0.6 · H 0.64 · L 0.6 · C 0.64 · volume 93309241.0

### Indicators

- [I1] adjustment: qfq
- [I2] asOf: 2026-08-03T16:00:00.000Z
- [I3] atr14: 0.04828387
- [I4] bars: 648
- [I5] ma20: 0.67865
- [I6] ma60: 0.77101667
- [I7] macd: -0.05368772
- [I8] macdHistogram: -0.0047318
- [I9] macdSignal: -0.04895592
- [I10] realizedVolatility20: 92.00633983
- [I11] rsi14: 43.54700064
- [I12] version: ta-indicators-v1

### Precomputed derived evidence

- [D1] recentWindowTradingDays: 8 trading_days · method `count_market_bars` · window `M641 → M648`
- [D2] recentWindowCloseChangePct: -0.92879257 percent · method `close_change_pct` · window `M641 → M648`
- [D3] latestCloseChangePct: 9.96563574 percent · method `close_change_pct` · window `M647 → M648`
- [D4] atrPctOfLatestClose: 7.54435469 percent · method `ratio_to_latest_close_pct` · window `M648`
- [D5] closeVsMa20Pct: -5.69513004 percent · method `close_vs_moving_average_pct` · window `M648`
- [D6] closeVsMa60Pct: -16.9927156 percent · method `close_vs_moving_average_pct` · window `M648`
- [D7] strictMovingAverageAlignment: bearish categorical · method `deterministic_comparison` · window `M648`
- [D8] rsiOversoldThreshold: 30 rsi_points · method `configured_technical_convention` · window `I11`
- [D9] rsiMidlineThreshold: 50 rsi_points · method `configured_technical_convention` · window `I11`
- [D10] rsiOverboughtThreshold: 70 rsi_points · method `configured_technical_convention` · window `I11`

### Corporate actions

- [CA1] fund_share_split_notice: 2026-07-05
- [CA2] fund_share_split_notice: 2026-06-29

### Point-in-time news

- [N1] 2026-07-20T16:00:00Z: [国泰中证全指通信设备交易型开放式指数证券投资基金2026年第2季度报告](https://www.sse.com.cn/disclosure/fund/announcement/c/new/2026-07-21/515880_20260721_LU1F.pdf) · 上海证券交易所基金公告 · evidence
- [N2] 2026-07-05T16:00:00Z: [国泰基金管理有限公司关于国泰中证全指通信设备交易型开放式指数证券投资基金基金份额拆分结果的公告](https://www.sse.com.cn/disclosure/fund/announcement/c/new/2026-07-06/515880_20260706_PYMW.pdf) · 上海证券交易所基金公告 · evidence
- [N3] 2026-07-05T16:00:00Z: [国泰中证全指通信设备交易型开放式指数证券投资基金更新招募说明书（2026年第二号）](https://www.sse.com.cn/disclosure/fund/announcement/c/new/2026-07-06/515880_20260706_OEJU.pdf) · 上海证券交易所基金公告 · evidence
- [N4] 2026-06-29T16:00:00Z: [国泰基金管理有限公司关于国泰中证全指通信设备交易型开放式指数证券投资基金实施基金份额拆分并调整最小申购、赎回单位及相关业务安排的公告](https://www.sse.com.cn/disclosure/fund/announcement/c/new/2026-06-30/515880_20260630_NHF1.pdf) · 上海证券交易所基金公告 · evidence

### Sources

- [S1] tencent · as of 2026-08-03T16:00:00.000Z · tier evidence
- [S2] 上海证券交易所基金公告 · as of 2026-07-20T16:00:00.000Z · tier evidence
- [S3] 上海证券交易所基金公告 · as of 2026-07-05T16:00:00.000Z · tier evidence
- [S4] 上海证券交易所基金公告 · as of 2026-06-29T16:00:00.000Z · tier evidence

## Research conclusion

**Not Rated**

The generated analysis did not pass the evidence claim gate, so the consolidated report intentionally withholds directional, allocation, and trading conclusions. Raw agent sections remain in the report subdirectories for audit only and must not be treated as verified output.

Validation errors: `FILTERED_UNSAFE_PUBLIC_CLAIM, UNSUPPORTED_CAUSAL_OR_PATH_CLAIM, UNSUPPORTED_DERIVED_NUMERIC_CLAIM`