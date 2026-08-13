# Trading Analysis Report: 512480.SS

Generated: 2026-08-12T23:59:42.237735+00:00

Analysis status: `insufficient_evidence` · Audit status: `legacy_unverified`

Evidence as of: 2026-08-12T23:50:41Z · content hash: `74779c19e55881fe23a88a221d024922007040f453b5b8e508720abffd1093b8`

Evidence claim validation: `failed` · FILTERED_UNSAFE_PUBLIC_CLAIM, MISSING_EVIDENCE_CITATION

## Evidence Snapshot

- Status `ok`; as of `2026-08-12T23:50:41Z`; instrument `512480.SS` [M654]
- Market history: source `tencent`; adjustment `qfq`; 654 bars from `2023-11-29T16:00:00Z` to `2026-08-11T16:00:00Z`

### Latest market bars

- [M650] trade date 2026-08-06 (raw UTC 2026-08-05T16:00:00Z): O 1.002 · H 1.067 · L 1.002 · C 1.047 · volume 19188353.0
- [M651] trade date 2026-08-07 (raw UTC 2026-08-06T16:00:00Z): O 1.044 · H 1.089 · L 1.04 · C 1.083 · volume 16505992.0
- [M652] trade date 2026-08-10 (raw UTC 2026-08-09T16:00:00Z): O 1.085 · H 1.095 · L 1.057 · C 1.081 · volume 14992795.0
- [M653] trade date 2026-08-11 (raw UTC 2026-08-10T16:00:00Z): O 1.07 · H 1.096 · L 1.058 · C 1.07 · volume 12942907.0
- [M654] trade date 2026-08-12 (raw UTC 2026-08-11T16:00:00Z): O 1.07 · H 1.1 · L 1.07 · C 1.09 · volume 11498040.0

### Indicators

- [I1] adjustment: qfq
- [I2] asOf: 2026-08-11T16:00:00.000Z
- [I3] atr14: 0.07126173
- [I4] bars: 654
- [I5] ma20: 1.061
- [I6] ma60: 1.16301667
- [I7] macd: -0.0390515
- [I8] macdHistogram: 0.01046302
- [I9] macdSignal: -0.04951452
- [I10] realizedVolatility20: 79.11019688
- [I11] rsi14: 48.61642995
- [I12] version: ta-indicators-v1

### Precomputed derived evidence

- [D1] recentWindowTradingDays: 8 trading_days · method `count_market_bars` · window `M647 → M654`
- [D2] recentWindowCloseChangePct: 18.34961998 percent · method `close_change_pct` · window `M647 → M654`
- [D3] latestCloseChangePct: 1.86915888 percent · method `close_change_pct` · window `M653 → M654`
- [D4] atrPctOfLatestClose: 6.53777339 percent · method `ratio_to_latest_close_pct` · window `M654`
- [D5] closeVsMa20Pct: 2.7332705 percent · method `close_vs_moving_average_pct` · window `M654`
- [D6] closeVsMa60Pct: -6.27821354 percent · method `close_vs_moving_average_pct` · window `M654`
- [D7] strictMovingAverageAlignment: none categorical · method `deterministic_comparison` · window `M654`
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

- [S1] tencent · as of 2026-08-11T16:00:00.000Z · tier evidence
- [S2] 中国政府网政策文件库 · as of 2026-08-02T16:00:00.000Z · tier evidence
- [S3] 上海证券交易所基金公告 · as of 2026-07-20T16:00:00.000Z · tier evidence
- [S4] 上海证券交易所基金公告 · as of 2026-07-02T16:00:00.000Z · tier evidence
- [S5] 上海证券交易所基金公告 · as of 2026-06-28T16:00:00.000Z · tier evidence

## Research conclusion

**Not Rated**

The generated analysis did not pass the evidence claim gate, so the consolidated report intentionally withholds directional, allocation, and trading conclusions. Raw agent sections remain in the report subdirectories for audit only and must not be treated as verified output.

Validation errors: `FILTERED_UNSAFE_PUBLIC_CLAIM, MISSING_EVIDENCE_CITATION`