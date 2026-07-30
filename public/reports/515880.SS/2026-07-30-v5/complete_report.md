# Trading Analysis Report: 515880.SS

Generated: 2026-07-30T06:42:28.525033+00:00

Analysis status: `rated` · Audit status: `verified`

Evidence as of: 2026-07-30T06:31:11Z · content hash: `a228781384eae76fb487f90dc247a89916a36ab49836a13405968d480371d2f2`

Evidence claim validation: `passed`

## Evidence Snapshot

- Status `ok`; as of `2026-07-30T06:31:11Z`; instrument `515880.SS` [M644]
- Market history: source `tencent`; adjustment `qfq`; 644 bars from `2023-11-29T16:00:00Z` to `2026-07-28T16:00:00Z`

### Latest market bars

- [M640] trade date 2026-07-23 (raw UTC 2026-07-22T16:00:00Z): O 0.679 · H 0.696 · L 0.664 · C 0.671 · volume 52478191.0
- [M641] trade date 2026-07-24 (raw UTC 2026-07-23T16:00:00Z): O 0.653 · H 0.669 · L 0.646 · C 0.646 · volume 45064802.0
- [M642] trade date 2026-07-27 (raw UTC 2026-07-26T16:00:00Z): O 0.639 · H 0.668 · L 0.632 · C 0.667 · volume 42346596.0
- [M643] trade date 2026-07-28 (raw UTC 2026-07-27T16:00:00Z): O 0.642 · H 0.65 · L 0.6 · C 0.6 · volume 81965825.0
- [M644] trade date 2026-07-29 (raw UTC 2026-07-28T16:00:00Z): O 0.599 · H 0.61 · L 0.574 · C 0.602 · volume 79074757.0

### Indicators

- [I1] adjustment: qfq
- [I2] asOf: 2026-07-28T16:00:00.000Z
- [I3] atr14: 0.04788716
- [I4] bars: 644
- [I5] ma20: 0.7155
- [I6] ma60: 0.77903333
- [I7] macd: -0.05062674
- [I8] macdHistogram: -0.01232936
- [I9] macdSignal: -0.03829738
- [I10] realizedVolatility20: 81.77023733
- [I11] rsi14: 33.98295251
- [I12] version: ta-indicators-v1

### Precomputed derived evidence

- [D1] recentWindowTradingDays: 8 trading_days · method `count_market_bars` · window `M637 → M644`
- [D2] recentWindowCloseChangePct: -6.66666667 percent · method `close_change_pct` · window `M637 → M644`
- [D3] latestCloseChangePct: 0.33333333 percent · method `close_change_pct` · window `M643 → M644`
- [D4] atrPctOfLatestClose: 7.95467774 percent · method `ratio_to_latest_close_pct` · window `M644`
- [D5] closeVsMa20Pct: -15.86303284 percent · method `close_vs_moving_average_pct` · window `M644`
- [D6] closeVsMa60Pct: -22.72474401 percent · method `close_vs_moving_average_pct` · window `M644`
- [D7] strictMovingAverageAlignment: bearish categorical · method `deterministic_comparison` · window `M644`
- [D8] rsiOversoldThreshold: 30 rsi_points · method `configured_technical_convention` · window `I11`
- [D9] rsiMidlineThreshold: 50 rsi_points · method `configured_technical_convention` · window `I11`
- [D10] rsiOverboughtThreshold: 70 rsi_points · method `configured_technical_convention` · window `I11`

### Corporate actions

- [CA1] fund_share_split_notice: 2026-07-05
- [CA2] fund_share_split_notice: 2026-06-29

### Point-in-time news

- [N1] 2026-07-20T16:00:00Z: [国泰中证全指通信设备交易型开放式指数证券投资基金2026年第2季度报告](https://www.sse.com.cn/disclosure/fund/announcement/c/new/2026-07-21/515880_20260721_LU1F.pdf) · 上海证券交易所基金公告 · evidence
- [N2] 2026-07-05T16:00:00Z: [国泰基金管理有限公司关于国泰中证全指通信设备交易型开放式指数证券投资基金基金份额拆分结果的公告](https://www.sse.com.cn/disclosure/fund/announcement/c/new/2026-07-06/515880_20260706_PYMW.pdf) · 上海证券交易所基金公告 · evidence
- [N3] 2026-07-05T16:00:00Z: [国泰中证全指通信设备交易型开放式指数证券投资基金更新招募说明书（2026年第二号）](https://www.sse.com.cn/disclosure/fund/announcement/c/new/2026-07-06/515880_20260706_OEJU.pdf) · 上海证券交易所基金公告 · evidence
- [N4] 2026-06-29T16:00:00Z: [国泰基金管理有限公司关于国泰中证全指通信设备交易型开放式指数证券投资基金实施基金份额拆分并调整最小申购、赎回单位及相关业务安排的公告](https://www.sse.com.cn/disclosure/fund/announcement/c/new/2026-06-30/515880_20260630_NHF1.pdf) · 上海证券交易所基金公告 · evidence

### Sources

- [S1] tencent · as of 2026-07-28T16:00:00.000Z · tier evidence
- [S2] 上海证券交易所基金公告 · as of 2026-07-20T16:00:00.000Z · tier evidence
- [S3] 上海证券交易所基金公告 · as of 2026-07-05T16:00:00.000Z · tier evidence
- [S4] 上海证券交易所基金公告 · as of 2026-06-29T16:00:00.000Z · tier evidence

## V. Portfolio Manager Decision

### Portfolio Manager
**Rating**: Underweight

**Executive Summary**: 515880.SS 当前处于确定性最高的空头均线排列 [D7]，近 8 个交易日收盘变动 -6.66666667% [D2]，趋势方向清晰。但收盘价相对 MA20 偏离 -15.86303284% [D5]、相对 MA60 偏离 -22.72474401% [D6] 的极端偏离，叠加已实现波动率 81.77023733 [I10] 的高波动环境，使得双向风险均显著。RSI14 尚未触发超卖阈值 [I11, D8]，且指标快照早于最新交易日 [I2, M644]，技术面判断存在时滞。ETF 专项数据全面缺失，公允价值偏离风险无法量化。建议降低敞口但保留部分仓位，待获得更新指标快照及 ETF 专项数据后重新评估。

**Investment Thesis**: **已验证事实：**
- 严格均线排列判定为 bearish [D7]：收盘价 0.602 [M644] < MA20 0.7155 [I5] < MA60 0.77903333 [I6]，这是证据包中确定性最高的技术判断。
- 近 8 个交易日窗口收盘变动为 -6.66666667% [D2]，价格从 0.645 [M637] 走至 0.602 [M644]。
- RSI14 = 33.98295251 [I11]，超卖阈值为 30 [D8]，当前 RSI 在超卖阈值之上，尚未触发。
- 最新交易日收盘变动 +0.33333333% [D3]，在 ATR 占收盘比 7.95467774% [D4] 的高波动环境下不具备信号意义。
- MACD = -0.05062674 [I7]、信号线 = -0.03829738 [I9]、柱状 = -0.01232936 [I8]，三者均为负，与 bearish 均线排列 [D7] 方向一致。但单一快照不支持"收敛""发散"或"改善"的动态判断。
- 已实现波动率20 = 81.77023733 [I10]，处于极高水平。
- 指标快照 asOf = 2026-07-28T16:00:00Z [I2]，早于最新交易日 2026-07-29（M644），即当前技术指标未吸收 M644 行情。
- 两次基金份额拆分公告 [CA1, CA2]，qfq 复权 [I1] 已处理拆分对历史价格的调整。
- Q2 季报 [N1] 及更新招募说明书 [N3] 已发布，但公告标题仅证明文件发布，文件正文内容不在证据包中。
- ETF 专项数据（NAV/IOPV、折溢价率、跟踪误差、成分股权重、管理费/托管费、AUM）均为 unavailable。

**推断：**
- 当前最可靠的技术格局判断为中期下行趋势，依据是 bearish 均线排列 [D7] 与负值 MACD 系统 [I7, I8, I9] 的方向一致性。两者均源自同一 OHLCV 历史，不构成独立交叉印证，但方向一致性本身提高了对当前趋势状态的置信度。
- 收盘价相对 MA20 偏离 -15.86303284% [D5]、相对 MA60 偏离 -22.72474401% [D6] 表明价格深度偏离均线，但在缺乏回归机制证据的情况下，偏离本身不证明反弹将发生，也不排除价格继续远离均线。
- 高波动率 [I10] 意味着双向风险均显著——既可能加速下行，也可能出现剧烈反弹。在此环境下完全清仓面临错失急速反转的风险，而维持高敞口则面临趋势延续的下行风险。

**传导路径假设（非已观测事实）：**
- 作为通信设备 ETF，515880.SS 的价格理论上受底层指数及成分股表现驱动，但由于持仓和指数点位数据 unavailable，此路径未被直接证实。
- 份额拆分 [CA1, CA2] 为中性技术操作，不改变持有人权益比例；拆分比例、实施效果、套利效率影响均 unavailable。

**评级为 Underweight 而非 Sell 的理由：**
- 空头趋势的确定性 [D7] 支持降低敞口，这是减仓的核心依据。
- 但以下因素使完全清仓（Sell）的证据不足：(1) 价格深度偏离均线 [D5, D6] 在历史经验中偶尔伴随技术反弹，虽然证据包内不包含回归机制的证明；(2) RSI 接近但未触发超卖 [I11, D8]，后续快照可能显示 RSI 进一步下探或反弹；(3) 指标快照 [I2] 时滞意味着当前判断基于不完整信息；(4) 在波动率 81.77023733 [I10] 的环境中，极端价格运动的双向性增大了完全清仓被反向冲击的风险。
- Underweight 允许在降低主要下行风险敞口的同时，保留部分仓位以应对数据更新后的重新评估。

**反证与不确定性：**
- 多头的核心论据（超卖回归、企稳信号、放量见底）在证据层面均不成立：RSI 未触发超卖 [I11, D8]、"企稳"升幅 [D3] 在 ATR [D4] 面前为噪音、成交量数据不支持买卖方向或投资者行为归因。
- ETF 专项数据全面缺失使公允价值无法验证——0.602 [M644] 的二级价格可能是折价也可能是溢价，证据不支持任何一方，但风险敞口客观存在。

**下一步观察：**
- 获取 asOf 晚于或等于 2026-07-29 的技术指标快照，以确认 RSI 是否触及 30 [D8] 及均线排列 [D7] 是否变化。
- 从公开披露渠道获取 Q2 季报 [N1] 及更新招募说明书 [N3] 正文，以补充 NAV/IOPV、折溢价率、跟踪误差、成分股权重、费率等 ETF 专项数据。
- 观察后续交易日收盘价行为：若连续收盘回升且均线排列发生变化，需重新评估趋势状态。

**Time Horizon**: null