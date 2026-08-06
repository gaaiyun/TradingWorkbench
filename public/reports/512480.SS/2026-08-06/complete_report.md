# Trading Analysis Report: 512480.SS

Generated: 2026-08-06T08:11:11.875167+00:00

Analysis status: `insufficient_evidence` · Audit status: `legacy_unverified`

Evidence as of: 2026-08-06T07:59:00Z · content hash: `9ea1b4d4af23dd562969a08e6d9f2b3a71a9a81fefd87114c0a830953de5cf06`

Evidence claim validation: `failed` · FILTERED_UNSAFE_PUBLIC_CLAIM, UNSUPPORTED_CAUSAL_OR_PATH_CLAIM

## Evidence Snapshot

- Status `ok`; as of `2026-08-06T07:59:00Z`; instrument `512480.SS` [M650]
- Market history: source `tencent`; adjustment `qfq`; 650 bars from `2023-11-29T16:00:00Z` to `2026-08-05T16:00:00Z`

### Latest market bars

- [M646] trade date 2026-07-31 (raw UTC 2026-07-30T16:00:00Z): O 1.035 · H 1.054 · L 0.991 · C 0.992 · volume 29187095.0
- [M647] trade date 2026-08-03 (raw UTC 2026-08-02T16:00:00Z): O 0.969 · H 0.978 · L 0.919 · C 0.921 · volume 24238137.0
- [M648] trade date 2026-08-04 (raw UTC 2026-08-03T16:00:00Z): O 0.929 · H 0.98 · L 0.921 · C 0.969 · volume 25990479.0
- [M649] trade date 2026-08-05 (raw UTC 2026-08-04T16:00:00Z): O 0.975 · H 1.048 · L 0.97 · C 1.033 · volume 23577450.0
- [M650] trade date 2026-08-06 (raw UTC 2026-08-05T16:00:00Z): O 1.0 · H 1.07 · L 1.0 · C 1.05 · volume 19188353.0

### Indicators

- [I1] adjustment: qfq
- [I2] asOf: 2026-08-05T16:00:00.000Z
- [I3] atr14: 0.08301832
- [I4] bars: 650
- [I5] ma20: 1.105
- [I6] ma60: 1.15991667
- [I7] macd: -0.06373657
- [I8] macdHistogram: -0.00911981
- [I9] macdSignal: -0.05461676
- [I10] realizedVolatility20: 83.83737176
- [I11] rsi14: 44.90623147
- [I12] version: ta-indicators-v1

### Precomputed derived evidence

- [D1] recentWindowTradingDays: 8 trading_days · method `count_market_bars` · window `M643 → M650`
- [D2] recentWindowCloseChangePct: 0.86455331 percent · method `close_change_pct` · window `M643 → M650`
- [D3] latestCloseChangePct: 1.64569216 percent · method `close_change_pct` · window `M649 → M650`
- [D4] atrPctOfLatestClose: 7.90650667 percent · method `ratio_to_latest_close_pct` · window `M650`
- [D5] closeVsMa20Pct: -4.97737557 percent · method `close_vs_moving_average_pct` · window `M650`
- [D6] closeVsMa60Pct: -9.47625574 percent · method `close_vs_moving_average_pct` · window `M650`
- [D7] strictMovingAverageAlignment: bearish categorical · method `deterministic_comparison` · window `M650`
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

- [S1] tencent · as of 2026-08-05T16:00:00.000Z · tier evidence
- [S2] 中国政府网政策文件库 · as of 2026-08-02T16:00:00.000Z · tier evidence
- [S3] 上海证券交易所基金公告 · as of 2026-07-20T16:00:00.000Z · tier evidence
- [S4] 上海证券交易所基金公告 · as of 2026-07-02T16:00:00.000Z · tier evidence
- [S5] 上海证券交易所基金公告 · as of 2026-06-28T16:00:00.000Z · tier evidence

## Research conclusion

**Not Rated**

The generated analysis did not pass the evidence claim gate, so the consolidated report intentionally withholds directional, allocation, and trading conclusions. Raw agent sections remain in the report subdirectories for audit only and must not be treated as verified output.

Validation errors: `FILTERED_UNSAFE_PUBLIC_CLAIM, UNSUPPORTED_CAUSAL_OR_PATH_CLAIM`