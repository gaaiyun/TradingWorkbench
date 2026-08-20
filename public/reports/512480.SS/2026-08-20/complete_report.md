# Trading Analysis Report: 512480.SS

Generated: 2026-08-20T08:12:34.811531+00:00

Analysis status: `rated` · Audit status: `verified`

Evidence as of: 2026-08-20T08:06:33Z · content hash: `4eb512b202645a3ae550842a521a624b180ed98cf7a5e0adc667ff5105183b87`

Evidence claim validation: `passed`

## Evidence Snapshot

- Status `ok`; as of `2026-08-20T08:06:33Z`; instrument `512480.SS` [M660]
- Market history: source `tencent`; adjustment `qfq`; 660 bars from `2023-11-29T16:00:00Z` to `2026-08-19T16:00:00Z`

### Latest market bars

- [M656] trade date 2026-08-14 (raw UTC 2026-08-13T16:00:00Z): O 1.082 · H 1.088 · L 1.056 · C 1.077 · volume 11167893.0
- [M657] trade date 2026-08-17 (raw UTC 2026-08-16T16:00:00Z): O 1.077 · H 1.133 · L 1.076 · C 1.132 · volume 16379923.0
- [M658] trade date 2026-08-18 (raw UTC 2026-08-17T16:00:00Z): O 1.133 · H 1.146 · L 1.108 · C 1.132 · volume 13443322.0
- [M659] trade date 2026-08-19 (raw UTC 2026-08-18T16:00:00Z): O 1.1 · H 1.105 · L 1.035 · C 1.045 · volume 21409030.0
- [M660] trade date 2026-08-20 (raw UTC 2026-08-19T16:00:00Z): O 1.06 · H 1.07 · L 1.03 · C 1.04 · volume 14282755.0

### Indicators

- [I1] adjustment: qfq
- [I2] asOf: 2026-08-19T16:00:00.000Z
- [I3] atr14: 0.06459386
- [I4] bars: 660
- [I5] ma20: 1.05205
- [I6] ma60: 1.15883333
- [I7] macd: -0.02156036
- [I8] macdHistogram: 0.00875466
- [I9] macdSignal: -0.03031501
- [I10] realizedVolatility20: 68.40422794
- [I11] rsi14: 44.01344514
- [I12] version: ta-indicators-v1

### Precomputed derived evidence

- [D1] recentWindowTradingDays: 8 trading_days · method `count_market_bars` · window `M653 → M660`
- [D2] recentWindowCloseChangePct: -2.80373832 percent · method `close_change_pct` · window `M653 → M660`
- [D3] latestCloseChangePct: -0.4784689 percent · method `close_change_pct` · window `M659 → M660`
- [D4] atrPctOfLatestClose: 6.21094808 percent · method `ratio_to_latest_close_pct` · window `M660`
- [D5] closeVsMa20Pct: -1.14538282 percent · method `close_vs_moving_average_pct` · window `M660`
- [D6] closeVsMa60Pct: -10.25456612 percent · method `close_vs_moving_average_pct` · window `M660`
- [D7] strictMovingAverageAlignment: bearish categorical · method `deterministic_comparison` · window `M660`
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

- [S1] tencent · as of 2026-08-19T16:00:00.000Z · tier evidence
- [S2] 中国政府网政策文件库 · as of 2026-08-02T16:00:00.000Z · tier evidence
- [S3] 上海证券交易所基金公告 · as of 2026-07-20T16:00:00.000Z · tier evidence
- [S4] 上海证券交易所基金公告 · as of 2026-07-02T16:00:00.000Z · tier evidence
- [S5] 上海证券交易所基金公告 · as of 2026-06-28T16:00:00.000Z · tier evidence

## V. Portfolio Manager Decision

### Portfolio Manager
**Rating**: Hold
**Executive Summary**: 512480.SS 根据 [D7] 呈现严格熊市移动平均线对齐，收盘价低于 MA20 低于 MA60。[M660] close=1.04 与 [I5] MA20=1.05205 及 [I6] MA60=1.15883333 共同支持该对齐。[D2] 显示八个交易日收盘下跌 -2.80373832%。[EvidencePacketV1] 中持仓、NAV、费用、跟踪误差及集中度数据 unavailable。[N1] 集成电路布图设计保护条例与 [N2] 季度报告为政策事件，未证明实施效应。
**Investment Thesis**: 熊市技术信号为主导。[D7] 严格对齐结合 [M660]、[I5]、[I6] 及 [D2] 的近期下跌。股息拆分 [CA1] 与 [CA2] 仅为公告事件，无指定持有人响应细节。[N1] 与 [N2] 仅记录事件本身，未构成催化剂证据。研究经理立场为 Underweight，交易员提议 Hold 维持当前仓位。无新增仓位或数字目标，优先观察技术对齐变化与政策落地效果。