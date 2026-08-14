# Trading Analysis Report: 512480.SS

Generated: 2026-08-14T08:05:28.540636+00:00

Analysis status: `insufficient_evidence` · Audit status: `legacy_unverified`

Evidence as of: 2026-08-14T07:56:22Z · content hash: `dda0d499611095ad9accdec34409b1310bcc46764d113c2c9ad35a14c23d7be1`

Evidence claim validation: `failed` · FILTERED_UNSAFE_PUBLIC_CLAIM, MISSING_EVIDENCE_CITATION

## Evidence Snapshot

- Status `ok`; as of `2026-08-14T07:56:22Z`; instrument `512480.SS` [M656]
- Market history: source `tencent`; adjustment `qfq`; 656 bars from `2023-11-29T16:00:00Z` to `2026-08-13T16:00:00Z`

### Latest market bars

- [M652] trade date 2026-08-10 (raw UTC 2026-08-09T16:00:00Z): O 1.085 · H 1.095 · L 1.057 · C 1.081 · volume 14992795.0
- [M653] trade date 2026-08-11 (raw UTC 2026-08-10T16:00:00Z): O 1.07 · H 1.096 · L 1.058 · C 1.07 · volume 12942907.0
- [M654] trade date 2026-08-12 (raw UTC 2026-08-11T16:00:00Z): O 1.073 · H 1.095 · L 1.066 · C 1.088 · volume 11498040.0
- [M655] trade date 2026-08-13 (raw UTC 2026-08-12T16:00:00Z): O 1.105 · H 1.115 · L 1.067 · C 1.068 · volume 14575886.0
- [M656] trade date 2026-08-14 (raw UTC 2026-08-13T16:00:00Z): O 1.08 · H 1.09 · L 1.06 · C 1.08 · volume 11167893.0

### Indicators

- [I1] adjustment: qfq
- [I2] asOf: 2026-08-13T16:00:00.000Z
- [I3] atr14: 0.06671001
- [I4] bars: 656
- [I5] ma20: 1.05685
- [I6] ma60: 1.16245
- [I7] macd: -0.03191167
- [I8] macdHistogram: 0.01192186
- [I9] macdSignal: -0.04383354
- [I10] realizedVolatility20: 71.19974538
- [I11] rsi14: 47.8678868
- [I12] version: ta-indicators-v1

### Precomputed derived evidence

- [D1] recentWindowTradingDays: 8 trading_days · method `count_market_bars` · window `M649 → M656`
- [D2] recentWindowCloseChangePct: 4.54985479 percent · method `close_change_pct` · window `M649 → M656`
- [D3] latestCloseChangePct: 1.12359551 percent · method `close_change_pct` · window `M655 → M656`
- [D4] atrPctOfLatestClose: 6.17685278 percent · method `ratio_to_latest_close_pct` · window `M656`
- [D5] closeVsMa20Pct: 2.19047168 percent · method `close_vs_moving_average_pct` · window `M656`
- [D6] closeVsMa60Pct: -7.09277818 percent · method `close_vs_moving_average_pct` · window `M656`
- [D7] strictMovingAverageAlignment: none categorical · method `deterministic_comparison` · window `M656`
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

- [S1] tencent · as of 2026-08-13T16:00:00.000Z · tier evidence
- [S2] 中国政府网政策文件库 · as of 2026-08-02T16:00:00.000Z · tier evidence
- [S3] 上海证券交易所基金公告 · as of 2026-07-20T16:00:00.000Z · tier evidence
- [S4] 上海证券交易所基金公告 · as of 2026-07-02T16:00:00.000Z · tier evidence
- [S5] 上海证券交易所基金公告 · as of 2026-06-28T16:00:00.000Z · tier evidence

## Research conclusion

**Not Rated**

The generated analysis did not pass the evidence claim gate, so the consolidated report intentionally withholds directional, allocation, and trading conclusions. Raw agent sections remain in the report subdirectories for audit only and must not be treated as verified output.

Validation errors: `FILTERED_UNSAFE_PUBLIC_CLAIM, MISSING_EVIDENCE_CITATION`