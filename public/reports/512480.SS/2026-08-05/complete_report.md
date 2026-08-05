# Trading Analysis Report: 512480.SS

Generated: 2026-08-05T08:12:41.138361+00:00

Analysis status: `rated` · Audit status: `verified`

Evidence as of: 2026-08-05T07:59:39Z · content hash: `d420bf2b1a1530d23b475724bfefe1da74650c8e995cfeaeefef03e791a2711d`

Evidence claim validation: `passed`

## Evidence Snapshot

- Status `ok`; as of `2026-08-05T07:59:39Z`; instrument `512480.SS` [M649]
- Market history: source `tencent`; adjustment `qfq`; 649 bars from `2023-11-29T16:00:00Z` to `2026-08-04T16:00:00Z`

### Latest market bars

- [M645] trade date 2026-07-30 (raw UTC 2026-07-29T16:00:00Z): O 1.008 · H 1.02 · L 0.942 · C 0.958 · volume 21550818.0
- [M646] trade date 2026-07-31 (raw UTC 2026-07-30T16:00:00Z): O 1.035 · H 1.054 · L 0.991 · C 0.992 · volume 29187095.0
- [M647] trade date 2026-08-03 (raw UTC 2026-08-02T16:00:00Z): O 0.969 · H 0.978 · L 0.919 · C 0.921 · volume 24238137.0
- [M648] trade date 2026-08-04 (raw UTC 2026-08-03T16:00:00Z): O 0.929 · H 0.98 · L 0.921 · C 0.969 · volume 25990479.0
- [M649] trade date 2026-08-05 (raw UTC 2026-08-04T16:00:00Z): O 0.98 · H 1.05 · L 0.97 · C 1.03 · volume 23577450.0

### Indicators

- [I1] adjustment: qfq
- [I2] asOf: 2026-08-04T16:00:00.000Z
- [I3] atr14: 0.08416258
- [I4] bars: 649
- [I5] ma20: 1.1259
- [I6] ma60: 1.15976667
- [I7] macd: -0.06947134
- [I8] macdHistogram: -0.01708666
- [I9] macdSignal: -0.05238468
- [I10] realizedVolatility20: 91.73276055
- [I11] rsi14: 43.1969438
- [I12] version: ta-indicators-v1

### Precomputed derived evidence

- [D1] recentWindowTradingDays: 8 trading_days · method `count_market_bars` · window `M642 → M649`
- [D2] recentWindowCloseChangePct: -8.36298932 percent · method `close_change_pct` · window `M642 → M649`
- [D3] latestCloseChangePct: 6.29514964 percent · method `close_change_pct` · window `M648 → M649`
- [D4] atrPctOfLatestClose: 8.17112427 percent · method `ratio_to_latest_close_pct` · window `M649`
- [D5] closeVsMa20Pct: -8.51763034 percent · method `close_vs_moving_average_pct` · window `M649`
- [D6] closeVsMa60Pct: -11.18903253 percent · method `close_vs_moving_average_pct` · window `M649`
- [D7] strictMovingAverageAlignment: bearish categorical · method `deterministic_comparison` · window `M649`
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

- [S1] tencent · as of 2026-08-04T16:00:00.000Z · tier evidence
- [S2] 中国政府网政策文件库 · as of 2026-08-02T16:00:00.000Z · tier evidence
- [S3] 上海证券交易所基金公告 · as of 2026-07-20T16:00:00.000Z · tier evidence
- [S4] 上海证券交易所基金公告 · as of 2026-07-02T16:00:00.000Z · tier evidence
- [S5] 上海证券交易所基金公告 · as of 2026-06-28T16:00:00.000Z · tier evidence

## V. Portfolio Manager Decision

### Portfolio Manager
**Rating**: Underweight

**Executive Summary**
综合激进、保守与中性三位风险分析师的辩论，当前512480.SS的技术面证据明确偏空，高波动环境叠加ETF关键产品数据缺失，支持削减敞口的决策。技术面呈现严格空头排列 [D7]，最新收盘价1.03 [M649]同时低于MA20的1.1259 [I5]和MA60的1.15976667 [I6]。最新单日反弹缺乏成交量配合且处于高波动背景下，不构成趋势反转依据。鉴于各方对“有序削减敞口”的共识，最终决定维持