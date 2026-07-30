# Trading Analysis Report: 515880.SS

Generated: 2026-07-30T06:00:02.096903+00:00

Analysis status: `insufficient_evidence` · Audit status: `legacy_unverified`

Evidence as of: 2026-07-30T05:50:45Z · content hash: `ae78c3e871bb955e08e2b82090bc78d5247e48b0a8a3faa6ac99f33fb01a0ecf`

Evidence claim validation: `failed` · UNSUPPORTED_DERIVED_NUMERIC_CLAIM

## Evidence Snapshot

- Status `ok`; as of `2026-07-30T05:50:45Z`; instrument `515880.SS` [M644]
- Market history: source `tencent`; adjustment `qfq`; 644 bars from `2023-11-29T16:00:00Z` to `2026-07-28T16:00:00Z`

### Latest market bars

- [M640] trade date 2026-07-23 (raw UTC 2026-07-22T16:00:00Z): O 0.679 · H 0.696 · L 0.664 · C 0.671 · volume 52478191.0
- [M641] trade date 2026-07-24 (raw UTC 2026-07-23T16:00:00Z): O 0.653 · H 0.669 · L 0.646 · C 0.646 · volume 45064802.0
- [M642] trade date 2026-07-27 (raw UTC 2026-07-26T16:00:00Z): O 0.639 · H 0.668 · L 0.632 · C 0.667 · volume 42346596.0
- [M643] trade date 2026-07-28 (raw UTC 2026-07-27T16:00:00Z): O 0.642 · H 0.65 · L 0.6 · C 0.6 · volume 81965825.0
- [M644] trade date 2026-07-29 (raw UTC 2026-07-28T16:00:00Z): O 0.599 · H 0.61 · L 0.574 · C 0.602 · volume 79074757.0

### Indicators

- [I1] adjustment: qfq
- [I2] asOf: 2026-07-28T16:00:00.000Z
- [I3] atr14: 0.04788716
- [I4] bars: 644
- [I5] ma20: 0.7155
- [I6] ma60: 0.77903333
- [I7] macd: -0.05062674
- [I8] macdHistogram: -0.01232936
- [I9] macdSignal: -0.03829738
- [I10] realizedVolatility20: 81.77023733
- [I11] rsi14: 33.98295251
- [I12] version: ta-indicators-v1

### Precomputed derived evidence

- [D1] recentWindowTradingDays: 8 trading_days · method `count_market_bars` · window `M637 → M644`
- [D2] recentWindowCloseChangePct: -6.66666667 percent · method `close_change_pct` · window `M637 → M644`
- [D3] latestCloseChangePct: 0.33333333 percent · method `close_change_pct` · window `M643 → M644`
- [D4] atrPctOfLatestClose: 7.95467774 percent · method `ratio_to_latest_close_pct` · window `M644`
- [D5] closeVsMa20Pct: -15.86303284 percent · method `close_vs_moving_average_pct` · window `M644`
- [D6] closeVsMa60Pct: -22.72474401 percent · method `close_vs_moving_average_pct` · window `M644`
- [D7] strictMovingAverageAlignment: bearish categorical · method `deterministic_comparison` · window `M644`
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

- [S1] tencent · as of 2026-07-28T16:00:00.000Z · tier evidence
- [S2] 上海证券交易所基金公告 · as of 2026-07-20T16:00:00.000Z · tier evidence
- [S3] 上海证券交易所基金公告 · as of 2026-07-05T16:00:00.000Z · tier evidence
- [S4] 上海证券交易所基金公告 · as of 2026-06-29T16:00:00.000Z · tier evidence

## Research conclusion

**Not Rated**

The generated analysis did not pass the evidence claim gate, so the consolidated report intentionally withholds directional, allocation, and trading conclusions. Raw agent sections remain in the report subdirectories for audit only and must not be treated as verified output.

Validation errors: `UNSUPPORTED_DERIVED_NUMERIC_CLAIM`