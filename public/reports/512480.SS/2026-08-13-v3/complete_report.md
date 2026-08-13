# Trading Analysis Report: 512480.SS

Generated: 2026-08-13T21:28:23.455488+00:00

Analysis status: `rated` · Audit status: `verified`

Evidence as of: 2026-08-13T20:18:03Z · content hash: `5389e287a877f6509d7a4f6d9b0d7431dee3313a068e65de6c40ec601df373b9`

Evidence claim validation: `passed`

## Evidence Snapshot

- Status `ok`; as of `2026-08-13T20:18:03Z`; instrument `512480.SS` [M655]
- Market history: source `tencent`; adjustment `qfq`; 655 bars from `2023-11-29T16:00:00Z` to `2026-08-12T16:00:00Z`

### Latest market bars

- [M651] trade date 2026-08-07 (raw UTC 2026-08-06T16:00:00Z): O 1.044 · H 1.089 · L 1.04 · C 1.083 · volume 16505992.0
- [M652] trade date 2026-08-10 (raw UTC 2026-08-09T16:00:00Z): O 1.085 · H 1.095 · L 1.057 · C 1.081 · volume 14992795.0
- [M653] trade date 2026-08-11 (raw UTC 2026-08-10T16:00:00Z): O 1.07 · H 1.096 · L 1.058 · C 1.07 · volume 12942907.0
- [M654] trade date 2026-08-12 (raw UTC 2026-08-11T16:00:00Z): O 1.073 · H 1.095 · L 1.066 · C 1.088 · volume 11498040.0
- [M655] trade date 2026-08-13 (raw UTC 2026-08-12T16:00:00Z): O 1.11 · H 1.12 · L 1.07 · C 1.07 · volume 14575886.0

### Indicators

- [I1] adjustment: qfq
- [I2] asOf: 2026-08-12T16:00:00.000Z
- [I3] atr14: 0.06967671
- [I4] bars: 655
- [I5] ma20: 1.05645
- [I6] ma60: 1.16225
- [I7] macd: -0.03572475
- [I8] macdHistogram: 0.01105734
- [I9] macdSignal: -0.04678209
- [I10] realizedVolatility20: 76.47901325
- [I11] rsi14: 46.76577061
- [I12] version: ta-indicators-v1

### Precomputed derived evidence

- [D1] recentWindowTradingDays: 8 trading_days · method `count_market_bars` · window `M648 → M655`
- [D2] recentWindowCloseChangePct: 10.42311662 percent · method `close_change_pct` · window `M648 → M655`
- [D3] latestCloseChangePct: -1.65441176 percent · method `close_change_pct` · window `M654 → M655`
- [D4] atrPctOfLatestClose: 6.51184206 percent · method `ratio_to_latest_close_pct` · window `M655`
- [D5] closeVsMa20Pct: 1.28259738 percent · method `close_vs_moving_average_pct` · window `M655`
- [D6] closeVsMa60Pct: -7.93719079 percent · method `close_vs_moving_average_pct` · window `M655`
- [D7] strictMovingAverageAlignment: none categorical · method `deterministic_comparison` · window `M655`
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

- [S1] tencent · as of 2026-08-12T16:00:00.000Z · tier evidence
- [S2] 中国政府网政策文件库 · as of 2026-08-02T16:00:00.000Z · tier evidence
- [S3] 上海证券交易所基金公告 · as of 2026-07-20T16:00:00.000Z · tier evidence
- [S4] 上海证券交易所基金公告 · as of 2026-07-02T16:00:00.000Z · tier evidence
- [S5] 上海证券交易所基金公告 · as of 2026-06-28T16:00:00.000Z · tier evidence

## V. Portfolio Manager Decision

### Portfolio Manager
**Rating**: Hold

**Executive Summary**: `512480.SS` 近期收盘从 [M648] `0.969` 走到 [M655] `1.07`，且最近 8 个交易日收盘变化为 [D2] `10.42311662%`，说明短线确有修复；但最新收盘仍低于 MA60 [I6] `1.16225`，严格均线排列为 [D7] `none`，中期趋势尚未被证据确认。ETF 的 NAV、折溢价、跟踪误差、费率、持仓集中度、规模和申赎数据均为 `unavailable`，因此当前更适合维持中性持有，而不是把缺失信息解释为质量改善。

**Investment Thesis**: 从技术状态看，`512480.SS` 最新收盘 [M655] `1.07` 高于 MA20 [I5] `1.05645`，但仍低于 MA60 [I6] `1.16225`，且严格均线排列为 [D7] `none`，这只说明短线修复存在，中期上升结构还没有被确认。RSI14 为 [I11] `46.76577061`，处于中性区间；MACD [I7] `-0.03572475`、信号线 [I9] `-0.04678209`、柱状值 [I8] `0.01105734` 只代表当前快照，不能单凭这一组数据证明动量已经持续改善。波动方面，ATR14 为 [I3] `0.06967671`，占最新收盘价比例为 [D4] `6.51184206%`，20 日实现波动率为 [I10] `76.47901325`，说明持有过程仍可能较为颠簸。基金份额拆分公告见 [CA1] 与 [CA2]，相关基金公告见 [N3] 与 [N4]，但这些只能证明事件发生，不能据此推出比例、流动性改善、持有人行为或价格影响；政策文件 [N1] 也只提供外部背景，不能直接转化为对 `512480.SS` 的质量判断。