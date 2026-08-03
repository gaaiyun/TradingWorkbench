# Trading Analysis Report: 515880.SS

Generated: 2026-08-03T07:57:34.171706+00:00

Analysis status: `insufficient_evidence` · Audit status: `legacy_unverified`

Evidence as of: 2026-08-03T07:47:23Z · content hash: `4c989a68015bd8a9a6fc289f49cf8d97a7729df7c858baec8dd1ff075dae3f8e`

Evidence claim validation: `failed` · FILTERED_UNSAFE_PUBLIC_CLAIM, UNSUPPORTED_CAUSAL_OR_PATH_CLAIM, UNSUPPORTED_DERIVED_NUMERIC_CLAIM

## Evidence Snapshot

- Status `ok`; as of `2026-08-03T07:47:23Z`; instrument `515880.SS` [M647]
- Market history: source `tencent`; adjustment `qfq`; 647 bars from `2023-11-29T16:00:00Z` to `2026-08-02T16:00:00Z`

### Latest market bars

- [M643] trade date 2026-07-28 (raw UTC 2026-07-27T16:00:00Z): O 0.642 · H 0.65 · L 0.6 · C 0.6 · volume 81965825.0
- [M644] trade date 2026-07-29 (raw UTC 2026-07-28T16:00:00Z): O 0.599 · H 0.61 · L 0.574 · C 0.602 · volume 79074757.0
- [M645] trade date 2026-07-30 (raw UTC 2026-07-29T16:00:00Z): O 0.593 · H 0.597 · L 0.542 · C 0.555 · volume 110354509.0
- [M646] trade date 2026-07-31 (raw UTC 2026-07-30T16:00:00Z): O 0.601 · H 0.611 · L 0.581 · C 0.582 · volume 93598605.0
- [M647] trade date 2026-08-03 (raw UTC 2026-08-02T16:00:00Z): O 0.57 · H 0.6 · L 0.57 · C 0.58 · volume 46569718.0

### Indicators

- [I1] adjustment: qfq
- [I2] asOf: 2026-08-02T16:00:00.000Z
- [I3] atr14: 0.04789362
- [I4] bars: 647
- [I5] ma20: 0.6846
- [I6] ma60: 0.77268333
- [I7] macd: -0.05866115
- [I8] macdHistogram: -0.01085628
- [I9] macdSignal: -0.04780488
- [I10] realizedVolatility20: 83.67752226
- [I11] rsi14: 34.50827822
- [I12] version: ta-indicators-v1

### Precomputed derived evidence

- [D1] recentWindowTradingDays: 8 trading_days · method `count_market_bars` · window `M640 → M647`
- [D2] recentWindowCloseChangePct: -13.56184799 percent · method `close_change_pct` · window `M640 → M647`
- [D3] latestCloseChangePct: -0.34364261 percent · method `close_change_pct` · window `M646 → M647`
- [D4] atrPctOfLatestClose: 8.25752069 percent · method `ratio_to_latest_close_pct` · window `M647`
- [D5] closeVsMa20Pct: -15.27899503 percent · method `close_vs_moving_average_pct` · window `M647`
- [D6] closeVsMa60Pct: -24.93690785 percent · method `close_vs_moving_average_pct` · window `M647`
- [D7] strictMovingAverageAlignment: bearish categorical · method `deterministic_comparison` · window `M647`
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

- [S1] tencent · as of 2026-08-02T16:00:00.000Z · tier evidence
- [S2] 上海证券交易所基金公告 · as of 2026-07-20T16:00:00.000Z · tier evidence
- [S3] 上海证券交易所基金公告 · as of 2026-07-05T16:00:00.000Z · tier evidence
- [S4] 上海证券交易所基金公告 · as of 2026-06-29T16:00:00.000Z · tier evidence

## Research conclusion

**Not Rated**

The generated analysis did not pass the evidence claim gate, so the consolidated report intentionally withholds directional, allocation, and trading conclusions. Raw agent sections remain in the report subdirectories for audit only and must not be treated as verified output.

Validation errors: `FILTERED_UNSAFE_PUBLIC_CLAIM, UNSUPPORTED_CAUSAL_OR_PATH_CLAIM, UNSUPPORTED_DERIVED_NUMERIC_CLAIM`