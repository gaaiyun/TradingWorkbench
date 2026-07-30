# Trading Analysis Report: 512480.SS

Generated: 2026-07-30T07:29:18.653185+00:00

Analysis status: `rated` · Audit status: `verified`

Evidence as of: 2026-07-30T07:15:28Z · content hash: `b6182c3df7cf88bd867579894deaf1e65ab469905668f05af84a2abba5d5033e`

Evidence claim validation: `passed`

## Evidence Snapshot

- Status `ok`; as of `2026-07-30T07:15:28Z`; instrument `512480.SS` [M644]
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

## V. Portfolio Manager Decision

### Portfolio Manager
**Rating**: Underweight

- 最新收盘价为1.027 [M644]，MA20为1.2169 [I5]，MA60为1.16035 [I6]。收盘价同时低于两条均线，偏离MA20为-15.60522639% [D5]，偏离MA60为-11.49222217% [D6]。
- 严格均线排列判定为"none" [D7]——当前价格结构为close < MA60 < MA20，既不满足close < MA20 < MA60的空头排列，也不满足close > MA20 > MA60的多头排列。
- MACD为-0.04770645 [I7]，低于信号线-0.01957457 [I9]，柱状图为-0.02813188 [I8]。RSI14为37.12045566 [I11]，低于中线50 [D9]，高于超卖阈值30 [D8]。
- 20日已实现波动率为81.62166617% [I10]，ATR14为0.08685811 [I3]，ATR占最新收盘价比为8.45745959% [D4]。
- 8个交易日窗口内 [D1]，窗口收盘变动为-1.25% [D2]，最新交易日收盘变动为-1.34486071% [D3]。
- 2026年6月28日 [CA2] 和7月2日 [CA1] 各有一次基金份额拆分公告，7月20日发布第二季度报告 [N1]。行情采用前复权 [I1]。
- ETF结构性数据——NAV、跟踪误差、持仓集中度、AUM、溢价折价率、费率——均为unavailable。

所有可观测技术指标在单一时点上方向一致指向弱势——这是减仓的合理依据。收盘价深度低于两条主要均线 [D5, D6]、MACD为负且低于信号线 [I7, I9]、RSI处于弱势区间 [I11]，这些读数共同构成对多头叙事的反证。在高波动率环境 [I10] 下维持既有敞口，等同于被动承受方向不利的日内摆动风险，ATR占收盘价比8.45745959% [D4] 直接量化了这一摆动幅度。传导路径假设为：技术指标弱势 → 短期价格承压概率较高 → 逐步降低敞口以控制下行风险。此为假设，非已观测事实。

限制信心的关键因素如下。第一，严格均线排列为"none" [D7]——当前并非教科书式空头趋势确认，单一快照不能证明均线在收敛或发散，因此无法将当前弱势读数升级为确定性下行趋势。第二，RSI为37.12045566 [I11]，尚未触及超卖阈值30 [D8]；单一快照不能证明RSI正在改善或即将反弹，但同样不能证明弱势正在加速恶化。第三，窗口净变动仅-1.25% [D2]，表明市场并非单边崩跌。第四，ETF结构性数据全部unavailable——既无法判断二级市场价格相对净值是折价还是溢价，也无法评估跟踪质量和持仓集中度风险；unavailable不等于便宜，也不等于昂贵，仅意味着无法评估。第五，两次份额拆分公告 [CA1, CA2] 的拆分比例和实施效果在证据包内unavailable，无法判断其对价格序列连续性和流动性的具体影响。

窗口内并非所有信号都指向极端弱势。严格均线排列"none" [D7] 意味着趋势信号不够干净；RSI未触超卖 [D8, I11] 意味着极端弱势尚未到来；窗口净变动温和 [D2] 说明市场存在多空拉锯而非单边下行。此外，最新交易日成交量21,113,012 [M644] 高于7月27日的14,850,244 [M642]——但价格与成交量数据仅支持价格和成交量行为本身，不能将其归因于特定投资者群体的买卖行为或资金流向。

**Time Horizon**: null