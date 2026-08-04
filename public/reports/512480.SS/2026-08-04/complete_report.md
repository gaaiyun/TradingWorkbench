# Trading Analysis Report: 512480.SS

Generated: 2026-08-04T08:32:50.265645+00:00

Analysis status: `insufficient_evidence` · Audit status: `legacy_unverified`

Evidence as of: 2026-08-04T08:19:44Z · content hash: `0a7cc126491823f9b841c5f56c65ad346cd10c5557df9ee58d33eee98efe2fbd`

Evidence claim validation: `failed` · FILTERED_UNSAFE_PUBLIC_CLAIM, UNSUPPORTED_ACTOR_OR_FLOW_ATTRIBUTION, UNSUPPORTED_CAUSAL_OR_PATH_CLAIM

## Evidence Snapshot

- Status `ok`; as of `2026-08-04T08:19:44Z`; instrument `512480.SS` [M648]
- Market history: source `tencent`; adjustment `qfq`; 648 bars from `2023-11-29T16:00:00Z` to `2026-08-03T16:00:00Z`

### Latest market bars

- [M644] trade date 2026-07-29 (raw UTC 2026-07-28T16:00:00Z): O 1.035 · H 1.052 · L 0.978 · C 1.027 · volume 21113012.0
- [M645] trade date 2026-07-30 (raw UTC 2026-07-29T16:00:00Z): O 1.008 · H 1.02 · L 0.942 · C 0.958 · volume 21550818.0
- [M646] trade date 2026-07-31 (raw UTC 2026-07-30T16:00:00Z): O 1.035 · H 1.054 · L 0.991 · C 0.992 · volume 29187095.0
- [M647] trade date 2026-08-03 (raw UTC 2026-08-02T16:00:00Z): O 0.969 · H 0.978 · L 0.919 · C 0.921 · volume 24238137.0
- [M648] trade date 2026-08-04 (raw UTC 2026-08-03T16:00:00Z): O 0.93 · H 0.98 · L 0.92 · C 0.97 · volume 25990479.0

### Indicators

- [I1] adjustment: qfq
- [I2] asOf: 2026-08-03T16:00:00.000Z
- [I3] atr14: 0.08447729
- [I4] bars: 648
- [I5] ma20: 1.1414
- [I6] ma60: 1.1595
- [I7] macd: -0.07342852
- [I8] macdHistogram: -0.02533146
- [I9] macdSignal: -0.04809706
- [I10] realizedVolatility20: 87.81859268
- [I11] rsi14: 37.75232667
- [I12] version: ta-indicators-v1

### Precomputed derived evidence

- [D1] recentWindowTradingDays: 8 trading_days · method `count_market_bars` · window `M641 → M648`
- [D2] recentWindowCloseChangePct: -12.84815813 percent · method `close_change_pct` · window `M641 → M648`
- [D3] latestCloseChangePct: 5.32030402 percent · method `close_change_pct` · window `M647 → M648`
- [D4] atrPctOfLatestClose: 8.70899897 percent · method `ratio_to_latest_close_pct` · window `M648`
- [D5] closeVsMa20Pct: -15.01664622 percent · method `close_vs_moving_average_pct` · window `M648`
- [D6] closeVsMa60Pct: -16.3432514 percent · method `close_vs_moving_average_pct` · window `M648`
- [D7] strictMovingAverageAlignment: bearish categorical · method `deterministic_comparison` · window `M648`
- [D8] rsiOversoldThreshold: 30 rsi_points · method `configured_technical_convention` · window `I11`
- [D9] rsiMidlineThreshold: 50 rsi_points · method `configured_technical_convention` · window `I11`
- [D10] rsiOverboughtThreshold: 70 rsi_points · method `configured_technical_convention` · window `I11`

### Corporate actions

- [CA1] fund_share_split_notice: 2026-07-02
- [CA2] fund_share_split_notice: 2026-06-28

### Point-in-time news

- [N1] 2026-08-02T16:00:00Z: [集成电路布图设计保护条例](https://www.gov.cn/zhengce/zhengceku/202608/content_7077399.htm) · 中国政府网政策文件库 · evidence
- [N2] 2026-07-20T16:00:00Z: [国联安中证全指半导体产品与设备交易型开放式指数证券投资基金2026年第2季度报告](https://www.sse.com.cn/disclosure/fund/announcement/c/new/2026-07-21/512480_20260721_OL38.pdf) · 上海证券交易所基金公告 · evidence
- [N3] 2026-07-02T16:00:00Z: [国联安基金管理有限公司关于国联安中证全指半导体产品与设备交易型开放式指数证券投资基金基金份额拆分结果的公告](https://www.sse.com.cn/disclosure/fund/announcement/c/new/2026-07-03/512480_20260703_WPHJ.pdf) · 上海证券交易所基金公告 · evidence
- [N4] 2026-06-28T16:00:00Z: [国联安基金管理有限公司关于国联安中证全指半导体产品与设备交易型开放式指数证券投资基金实施基金份额拆分并调整最小申购、赎回单位及相关业务安排的公告](https://www.sse.com.cn/disclosure/fund/announcement/c/new/2026-06-29/512480_20260629_CA4B.pdf) · 上海证券交易所基金公告 · evidence

### Sources

- [S1] tencent · as of 2026-08-03T16:00:00.000Z · tier evidence
- [S2] 中国政府网政策文件库 · as of 2026-08-02T16:00:00.000Z · tier evidence
- [S3] 上海证券交易所基金公告 · as of 2026-07-20T16:00:00.000Z · tier evidence
- [S4] 上海证券交易所基金公告 · as of 2026-07-02T16:00:00.000Z · tier evidence
- [S5] 上海证券交易所基金公告 · as of 2026-06-28T16:00:00.000Z · tier evidence

## Research conclusion

**Not Rated**

The generated analysis did not pass the evidence claim gate, so the consolidated report intentionally withholds directional, allocation, and trading conclusions. Raw agent sections remain in the report subdirectories for audit only and must not be treated as verified output.

Validation errors: `FILTERED_UNSAFE_PUBLIC_CLAIM, UNSUPPORTED_ACTOR_OR_FLOW_ATTRIBUTION, UNSUPPORTED_CAUSAL_OR_PATH_CLAIM`