# Trading Analysis Report: 512480.SS

Generated: 2026-08-19T08:16:58.160330+00:00

Analysis status: `insufficient_evidence` · Audit status: `legacy_unverified`

Evidence as of: 2026-08-19T08:08:21Z · content hash: `994306ebd0c2ae94d23df473b73009596ed9f2cbb9c1c86096d8e28d3e1fa03a`

Evidence claim validation: `failed` · CONTRADICTED_MOVING_AVERAGE_ALIGNMENT, FILTERED_UNSAFE_PUBLIC_CLAIM

## Evidence Snapshot

- Status `ok`; as of `2026-08-19T08:08:21Z`; instrument `512480.SS` [M659]
- Market history: source `tencent`; adjustment `qfq`; 659 bars from `2023-11-29T16:00:00Z` to `2026-08-18T16:00:00Z`

### Latest market bars

- [M655] trade date 2026-08-13 (raw UTC 2026-08-12T16:00:00Z): O 1.105 · H 1.115 · L 1.067 · C 1.068 · volume 14575886.0
- [M656] trade date 2026-08-14 (raw UTC 2026-08-13T16:00:00Z): O 1.082 · H 1.088 · L 1.056 · C 1.077 · volume 11167893.0
- [M657] trade date 2026-08-17 (raw UTC 2026-08-16T16:00:00Z): O 1.077 · H 1.133 · L 1.076 · C 1.132 · volume 16379923.0
- [M658] trade date 2026-08-18 (raw UTC 2026-08-17T16:00:00Z): O 1.133 · H 1.146 · L 1.108 · C 1.132 · volume 13443322.0
- [M659] trade date 2026-08-19 (raw UTC 2026-08-18T16:00:00Z): O 1.1 · H 1.11 · L 1.04 · C 1.05 · volume 21409030.0

### Indicators

- [I1] adjustment: qfq
- [I2] asOf: 2026-08-18T16:00:00.000Z
- [I3] atr14: 0.06612855
- [I4] bars: 659
- [I5] ma20: 1.0556
- [I6] ma60: 1.16046667
- [I7] macd: -0.01957926
- [I8] macdHistogram: 0.01284464
- [I9] macdSignal: -0.03242391
- [I10] realizedVolatility20: 69.03768019
- [I11] rsi14: 44.87908645
- [I12] version: ta-indicators-v1

### Precomputed derived evidence

- [D1] recentWindowTradingDays: 8 trading_days · method `count_market_bars` · window `M652 → M659`
- [D2] recentWindowCloseChangePct: -2.86771508 percent · method `close_change_pct` · window `M652 → M659`
- [D3] latestCloseChangePct: -7.24381625 percent · method `close_change_pct` · window `M658 → M659`
- [D4] atrPctOfLatestClose: 6.29795714 percent · method `ratio_to_latest_close_pct` · window `M659`
- [D5] closeVsMa20Pct: -0.53050398 percent · method `close_vs_moving_average_pct` · window `M659`
- [D6] closeVsMa60Pct: -9.51915922 percent · method `close_vs_moving_average_pct` · window `M659`
- [D7] strictMovingAverageAlignment: bearish categorical · method `deterministic_comparison` · window `M659`
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

- [S1] tencent · as of 2026-08-18T16:00:00.000Z · tier evidence
- [S2] 中国政府网政策文件库 · as of 2026-08-02T16:00:00.000Z · tier evidence
- [S3] 上海证券交易所基金公告 · as of 2026-07-20T16:00:00.000Z · tier evidence
- [S4] 上海证券交易所基金公告 · as of 2026-07-02T16:00:00.000Z · tier evidence
- [S5] 上海证券交易所基金公告 · as of 2026-06-28T16:00:00.000Z · tier evidence

## Research conclusion

**Not Rated**

The generated analysis did not pass the evidence claim gate, so the consolidated report intentionally withholds directional, allocation, and trading conclusions. Raw agent sections remain in the report subdirectories for audit only and must not be treated as verified output.

Validation errors: `CONTRADICTED_MOVING_AVERAGE_ALIGNMENT, FILTERED_UNSAFE_PUBLIC_CLAIM`