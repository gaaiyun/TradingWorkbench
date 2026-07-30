# Trading Analysis Report: 512480.SS

Generated: 2026-07-30T05:43:24.068705+00:00

Analysis status: `insufficient_evidence` · Audit status: `legacy_unverified`

Evidence as of: 2026-07-30T05:34:46Z · content hash: `8fb696fb153a5d18cd193a25956e5dfc70a92743e199f11107a23e31002f554b`

Evidence claim validation: `failed` · UNSUPPORTED_DERIVED_NUMERIC_CLAIM, CONTRADICTED_MOVING_AVERAGE_ALIGNMENT

## Evidence Snapshot

- Status `ok`; as of `2026-07-30T05:34:46Z`; instrument `512480.SS` [M644]
- Market history: source `tencent`; adjustment `qfq`; 644 bars from `2023-11-29T16:00:00Z` to `2026-07-28T16:00:00Z`

### Latest market bars

- [M640] trade date 2026-07-23 (raw UTC 2026-07-22T16:00:00Z): O 1.163 · H 1.167 · L 1.091 · C 1.106 · volume 18378028.0
- [M641] trade date 2026-07-24 (raw UTC 2026-07-23T16:00:00Z): O 1.08 · H 1.14 · L 1.08 · C 1.113 · volume 16218702.0
- [M642] trade date 2026-07-27 (raw UTC 2026-07-26T16:00:00Z): O 1.101 · H 1.132 · L 1.06 · C 1.124 · volume 14850244.0
- [M643] trade date 2026-07-28 (raw UTC 2026-07-27T16:00:00Z): O 1.087 · H 1.116 · L 1.031 · C 1.041 · volume 17677464.0
- [M644] trade date 2026-07-29 (raw UTC 2026-07-28T16:00:00Z): O 1.035 · H 1.052 · L 0.978 · C 1.027 · volume 21113012.0

### Indicators

- [I1] adjustment: qfq
- [I2] asOf: 2026-07-28T16:00:00.000Z
- [I3] atr14: 0.08685811
- [I4] bars: 644
- [I5] ma20: 1.2169
- [I6] ma60: 1.16035
- [I7] macd: -0.04770645
- [I8] macdHistogram: -0.02813188
- [I9] macdSignal: -0.01957457
- [I10] realizedVolatility20: 81.62166617
- [I11] rsi14: 37.12045566
- [I12] version: ta-indicators-v1

### Precomputed derived evidence

- [D1] recentWindowTradingDays: 8 trading_days · method `count_market_bars` · window `M637 → M644`
- [D2] recentWindowCloseChangePct: -1.25 percent · method `close_change_pct` · window `M637 → M644`
- [D3] latestCloseChangePct: -1.34486071 percent · method `close_change_pct` · window `M643 → M644`
- [D4] atrPctOfLatestClose: 8.45745959 percent · method `ratio_to_latest_close_pct` · window `M644`
- [D5] closeVsMa20Pct: -15.60522639 percent · method `close_vs_moving_average_pct` · window `M644`
- [D6] closeVsMa60Pct: -11.49222217 percent · method `close_vs_moving_average_pct` · window `M644`
- [D7] strictMovingAverageAlignment: none categorical · method `deterministic_comparison` · window `M644`
- [D8] rsiOversoldThreshold: 30 rsi_points · method `configured_technical_convention` · window `I11`
- [D9] rsiMidlineThreshold: 50 rsi_points · method `configured_technical_convention` · window `I11`
- [D10] rsiOverboughtThreshold: 70 rsi_points · method `configured_technical_convention` · window `I11`

### Corporate actions

- [CA1] fund_share_split_notice: 2026-07-02
- [CA2] fund_share_split_notice: 2026-06-28

### Point-in-time news

- [N1] 2026-07-20T16:00:00Z: [国联安中证全指半导体产品与设备交易型开放式指数证券投资基金2026年第2季度报告](https://www.sse.com.cn/disclosure/fund/announcement/c/new/2026-07-21/512480_20260721_OL38.pdf) · 上海证券交易所基金公告 · evidence
- [N2] 2026-07-02T16:00:00Z: [国联安基金管理有限公司关于国联安中证全指半导体产品与设备交易型开放式指数证券投资基金基金份额拆分结果的公告](https://www.sse.com.cn/disclosure/fund/announcement/c/new/2026-07-03/512480_20260703_WPHJ.pdf) · 上海证券交易所基金公告 · evidence
- [N3] 2026-06-28T16:00:00Z: [国联安基金管理有限公司关于国联安中证全指半导体产品与设备交易型开放式指数证券投资基金实施基金份额拆分并调整最小申购、赎回单位及相关业务安排的公告](https://www.sse.com.cn/disclosure/fund/announcement/c/new/2026-06-29/512480_20260629_CA4B.pdf) · 上海证券交易所基金公告 · evidence

### Sources

- [S1] tencent · as of 2026-07-28T16:00:00.000Z · tier evidence
- [S2] 上海证券交易所基金公告 · as of 2026-07-20T16:00:00.000Z · tier evidence
- [S3] 上海证券交易所基金公告 · as of 2026-07-02T16:00:00.000Z · tier evidence
- [S4] 上海证券交易所基金公告 · as of 2026-06-28T16:00:00.000Z · tier evidence

## Research conclusion

**Not Rated**

The generated analysis did not pass the evidence claim gate, so the consolidated report intentionally withholds directional, allocation, and trading conclusions. Raw agent sections remain in the report subdirectories for audit only and must not be treated as verified output.

Validation errors: `UNSUPPORTED_DERIVED_NUMERIC_CLAIM, CONTRADICTED_MOVING_AVERAGE_ALIGNMENT`