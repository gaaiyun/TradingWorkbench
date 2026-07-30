# Trading Analysis Report: 512480.SS

Generated: 2026-07-30T08:27:46.889477+00:00

Analysis status: `insufficient_evidence` · Audit status: `legacy_unverified`

Evidence as of: 2026-07-30T08:15:43Z · content hash: `10b4b2cb3e14fcc12e6da5dd0a96bf73d935cd38056899f457a60f1536fb92fd`

Evidence claim validation: `failed` · CONTRADICTED_MOVING_AVERAGE_ALIGNMENT, FILTERED_UNSAFE_PUBLIC_CLAIM, INVALID_EVIDENCE_CITATION, MISSING_EVIDENCE_CITATION, UNCITED_NUMERIC_CLAIM, UNSUPPORTED_ACTOR_OR_FLOW_ATTRIBUTION, UNSUPPORTED_CAUSAL_OR_PATH_CLAIM, UNSUPPORTED_DERIVED_NUMERIC_CLAIM, UNSUPPORTED_WINDOW_RANK_CLAIM

## Evidence Snapshot

- Status `ok`; as of `2026-07-30T08:15:43Z`; instrument `512480.SS` [M645]
- Market history: source `tencent`; adjustment `qfq`; 645 bars from `2023-11-29T16:00:00Z` to `2026-07-29T16:00:00Z`

### Latest market bars

- [M641] trade date 2026-07-24 (raw UTC 2026-07-23T16:00:00Z): O 1.08 · H 1.14 · L 1.08 · C 1.113 · volume 16218702.0
- [M642] trade date 2026-07-27 (raw UTC 2026-07-26T16:00:00Z): O 1.101 · H 1.132 · L 1.06 · C 1.124 · volume 14850244.0
- [M643] trade date 2026-07-28 (raw UTC 2026-07-27T16:00:00Z): O 1.087 · H 1.116 · L 1.031 · C 1.041 · volume 17677464.0
- [M644] trade date 2026-07-29 (raw UTC 2026-07-28T16:00:00Z): O 1.035 · H 1.052 · L 0.978 · C 1.027 · volume 21113012.0
- [M645] trade date 2026-07-30 (raw UTC 2026-07-29T16:00:00Z): O 1.01 · H 1.02 · L 0.94 · C 0.96 · volume 21550818.0

### Indicators

- [I1] adjustment: qfq
- [I2] asOf: 2026-07-29T16:00:00.000Z
- [I3] atr14: 0.08686824
- [I4] bars: 645
- [I5] ma20: 1.1974
- [I6] ma60: 1.1604
- [I7] macd: -0.05786769
- [I8] macdHistogram: -0.03063449
- [I9] macdSignal: -0.0272332
- [I10] realizedVolatility20: 79.7592229
- [I11] rsi14: 33.35678335
- [I12] version: ta-indicators-v1

### Precomputed derived evidence

- [D1] recentWindowTradingDays: 8 trading_days · method `count_market_bars` · window `M638 → M645`
- [D2] recentWindowCloseChangePct: -16.08391608 percent · method `close_change_pct` · window `M638 → M645`
- [D3] latestCloseChangePct: -6.52385589 percent · method `close_change_pct` · window `M644 → M645`
- [D4] atrPctOfLatestClose: 9.048775 percent · method `ratio_to_latest_close_pct` · window `M645`
- [D5] closeVsMa20Pct: -19.8262903 percent · method `close_vs_moving_average_pct` · window `M645`
- [D6] closeVsMa60Pct: -17.26990693 percent · method `close_vs_moving_average_pct` · window `M645`
- [D7] strictMovingAverageAlignment: none categorical · method `deterministic_comparison` · window `M645`
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

- [S1] tencent · as of 2026-07-29T16:00:00.000Z · tier evidence
- [S2] 上海证券交易所基金公告 · as of 2026-07-20T16:00:00.000Z · tier evidence
- [S3] 上海证券交易所基金公告 · as of 2026-07-02T16:00:00.000Z · tier evidence
- [S4] 上海证券交易所基金公告 · as of 2026-06-28T16:00:00.000Z · tier evidence

## Research conclusion

**Not Rated**

The generated analysis did not pass the evidence claim gate, so the consolidated report intentionally withholds directional, allocation, and trading conclusions. Raw agent sections remain in the report subdirectories for audit only and must not be treated as verified output.

Validation errors: `CONTRADICTED_MOVING_AVERAGE_ALIGNMENT, FILTERED_UNSAFE_PUBLIC_CLAIM, INVALID_EVIDENCE_CITATION, MISSING_EVIDENCE_CITATION, UNCITED_NUMERIC_CLAIM, UNSUPPORTED_ACTOR_OR_FLOW_ATTRIBUTION, UNSUPPORTED_CAUSAL_OR_PATH_CLAIM, UNSUPPORTED_DERIVED_NUMERIC_CLAIM, UNSUPPORTED_WINDOW_RANK_CLAIM`