# 参考项目、数据源与架构取舍

更新日期：2026-07-29

本文不是链接收藏，也不展示模型的私有推理过程。它记录可审查的工程依据：参考对象解决了什么问题、哪些做法已经落地、哪些只进入待办、哪些方案被拒绝，以及拒绝原因。

## 1. 评审标准

每个外部项目或数据源都按同一组问题评估：

1. 是否直接改善 A 股 ETF 主题研究、跨市场传导或期权风控。
2. 是否能提供来源、数据时间、复权方式和失败状态。
3. 是否适合 Cloudflare 的短任务限制，或应留在 Python 深度任务。
4. 是否需要付费 key、浏览器登录、代理或长期服务。
5. 上游变更时，能否局部降级而不是让整页失败。
6. 许可证是否允许复制代码；如果不适合复制，是否只参考架构思想。
7. 引入后的测试、部署和维护成本是否与收益匹配。

由此形成四种结论：

| 结论 | 含义 |
|---|---|
| 已落地 | 当前代码和测试中存在 |
| 设计已定 | schema 和边界明确，adapter 尚未全部实现 |
| 离线候选 | 适合 GitHub Actions / Python，不进入五分钟 Worker |
| 拒绝 | 与当前目标、成本或许可不匹配 |

## 2. 研究框架与 Agent 项目

### HKUDS Vibe-Trading

参考：[HKUDS/Vibe-Trading](https://github.com/HKUDS/Vibe-Trading)

采用：

- Research Goal 先于工具调用；
- 证据账本和 run card；
- 来源自动降级；
- 启动预检；
- A 股深度链按能力分层；
- MCP 默认只读的边界。

没有整体合并：

- 它自带完整前后端、技能注册、任务和会话体系；
- Trading Workbench 已经有 TradingAgents、Cloudflare、D1 和 GitHub Actions；
- 整体合并会制造两套调度、会话、权限和部署。

当前落地：profile 中保存研究目标；动态记录保留来源元数据；研究工作区展示运行状态和 run card；Provider Registry 有降级和熔断。完整证据账本字段仍在继续扩展。

### OpenBB

参考：[OpenBB-finance/OpenBB](https://github.com/OpenBB-finance/OpenBB)

采用“稳定标准模型 + 可替换 Provider”，不引入整个平台。工作台业务层只消费统一 OHLCV、新闻和事件 schema，来源 adapter 负责鉴权、字段和错误语义。

没有复制 OpenBB 代码：平台依赖、扩展和商业数据 key 远超当前需求；其代码许可也要求单独审查。这里只采用通用架构思想。

### Microsoft Qlib

参考：[microsoft/qlib](https://github.com/microsoft/qlib)

适合后续离线研究：

- Alpha158；
- IC / ICIR；
- 基准超额收益；
- 滚动验证；
- 交易成本、换手和最大回撤。

不进入 Worker。盘中边缘任务需要低延迟、可解释的事实和规则信号，不应每五分钟运行因子研究或训练。

### FinGPT

参考：[AI4Finance-Foundation/FinGPT](https://github.com/AI4Finance-Foundation/FinGPT)

采用的任务拆分：

- 新闻实体识别；
- 标题方向和情绪标注；
- 标的关系；
- 中文和英文金融别名。

不采用“情绪直接预测涨跌”。情绪只能是证据之一，必须与来源等级、时间、价格和成交量对齐，还要保留反证。

### AI Hedge Fund

参考：[virattt/ai-hedge-fund](https://github.com/virattt/ai-hedge-fund)

采用技术、新闻、风险和综合决策的职责分工。不采用知名投资者人物扮演，也不把个股基本面模板套给 ETF。

ETF 研究应优先处理指数、持仓、规模、流动性、费用、跟踪偏离、份额变化和公司行动。

## 3. 市场数据与研究工具

### Ashare、adata、AKShare、mootdx、Tushare

参考：

- [mpquant/Ashare](https://github.com/mpquant/Ashare)
- [1nchaos/adata](https://github.com/1nchaos/adata)
- [akfamily/akshare](https://github.com/akfamily/akshare)
- [rainx/mootdx](https://github.com/rainx/mootdx)
- [Tushare](https://tushare.pro/)

共同启示：A 股免费网页接口会改变，多源热备比押注单一库更实用。

运行划分：

| 场景 | 顺序 | 原因 |
|---|---|---|
| Cloudflare A 股 5 分钟 | 腾讯 → 东方财富 → Yahoo | 腾讯盘中接口轻量，适合边缘运行 |
| Cloudflare A 股日线 | 东方财富前复权 → 腾讯前复权 → Yahoo | 东方财富可返回完整上市历史，前复权避免 ETF 拆分假跳变 |
| Python 深度任务 | Tushare → mootdx → AKShare / adata | 覆盖更广，允许 pandas 和本地缓存 |

Tushare 只有在 token 和接口权限足够时才优先。AKShare 是 adapter，不是唯一依赖；其上游接口变化不能被业务层感知成 schema 漂移。

### ETF 份额、两融与“力度分位”

参考“桃子冰粉的数据看板”的是信息设计和验证方法，不是“国家队买卖”结论：把绝对值配成历史分位、区分动作力度与绝对水平、用对照主体做交叉检查、主动隐藏不能进入决策的噪音。当前三个核心标的是行业 ETF，公开数据不足以把融资或份额变化归因到汇金、证金、险资或具体机构。因此显性叙事只比较“ETF 自身融资账户”和“最新披露前十大持仓融资账户合计”，回答 ETF 端和个股端谁更积极；这是资金代理观察，不是投资者身份识别。

已落地来源与口径：

| 数据 | 来源 | 生产口径 |
|---|---|---|
| 融资余额、融资买入、融资净买入 | 东方财富 `RPTA_WEB_RZRQ_GGMX` | 日频、CNY、reported；515880/512480/159995 分别回填 1637/1579/1521 个交易日 |
| ETF 最新披露前十大持仓 | 天天基金 `FundArchivesDatas.aspx?type=jjcc` | 最新季度快照；保留披露日、股票代码与权重，只取前 10 大 |
| 成分股融资合计 | 对前十大持仓逐只调用同一 `RPTA_WEB_RZRQ_GGMX` 后按交易日求和 | `constituent_margin_*`；覆盖至少 80% 才写入；`current_top_N_approximation` |
| 沪市 ETF 基金规模 | 上交所 `COMMON_JJZWZ_JJLB_JJXQ_JJGM_CKLSGM_L` | 日频、亿元、evidence |
| 沪市 ETF 份额 | 上交所规模 ÷ 同日东方财富 `SPJ` 未复权收盘价 | `derived`，非登记份额，最多显示一位小数 |
| 当前 ETF 份额 | 东方财富 `push2delay` 的 `f84` | `snapshot_unstamped`，没有来源时间戳；用于深市累积和沪市失败降级 |

没有找到可免费、稳定回填 `159995.SZ` 日频份额的同等级官方源。天天基金 `gmbd` 只有季度和特殊时点，东财 ETF 列表与集思录只有快照；这些结果用于交叉核验，不伪装成日频历史。页面对该标的明确显示“仅快照、历史份额不可用、无可比历史”。上交所 commonQuery 对 GitHub/Cloudflare 出口存在间歇性 403，因此日常任务保留 source-level 降级：上交所失败时仍写入两融和当前份额快照。

分位规则固定为 2024-01-01 起、当前值不进入基准、并列值使用 mid-rank、有效历史少于 60 个交易日不输出 P 值。三张摘要卡仍保留 ETF 融资余额、融资净买入和份额；卡片明确标注“水平 P / 单日 P / 单日变化 P”。相邻份额变化超过 35% 的日期视为潜在拆分或口径变化，保留缺口但不参与分位。主对照改为 ETF 融资净买入与成分股融资净买入简单合计（不按 ETF 权重），两边都使用近 5 个可用交易日累计，再各自在 2024-01-01 起的全部自身历史中计算分位，图上仅展示最近 60 个点。累计值正负决定流入/流出方向，分位只描述相对历史力度，不能反过来覆盖实际正负；两端交易日不一致时不作方向比较。融券和股指期货没有进入页面：前者在当前研究场景占比过小，后者与三个行业 ETF 的直接解释力不足；以后只有先得到稳定相关性证据才重新评估。

`fund_flows.trade_date` 是资金数据的 Asia/Shanghai 业务日真源，格式固定为 `YYYY-MM-DD`。`ts` 只是为了排序、游标和兼容旧记录而保留的 UTC 瞬时：上海交易日零点会表现为前一日 `16:00Z`。API、分位、图表和生产验收必须使用 `trade_date`，禁止截取 `ts` 的 UTC 日期推断交易日。migration `0018_fund_flow_trade_date.sql` 以 `datetime(ts, '+8 hours')` 回填旧记录；采集器直接保存上游返回的交易日。生产门禁逐标的验证周末记录为 0、样本充分时周五存在，并要求资金交易日属于同标的日线交易日集合。`/api/flows?limit=2000` 的 `limit` 是所有 flow type 合计行数，不能用返回日期数判断 D1 的完整回填深度。

市场监控内的双线图比较 ETF 端与个股端近 5 个可用交易日融资累计的各自历史分位，图例标为“ETF 端 / 前 10 大持仓端”。确定性结论按正负与分位输出“两端显著净流出/流入、两端均为净流出/流入但力度未达极端、个股端或 ETF 端更明显、方向分化”；不能把两条线理解为同一主体。前十大持仓是最新披露快照，拿它回算历史存在成分变更和存活偏差；页面必须展示披露日与覆盖数，不能写成完整指数成分。图上的事件和官方新闻标记只回答“同期发生了什么”，不主张事件导致资金变化。页面一句话使用确定性规则，不调用模型，也不输出买卖建议。

资金面目前是 `decision/reference` 数据展示，不进入 EvidencePacket 和报告门禁。等 daily 运行稳定且真实报告引用方式完成二次审计后，才能评估是否新增 F# 证据族。

跨市场驱动按标的语义显式映射，而不是固定取目标列表中的第一个 driver：通信 ETF 使用 `NVDA + AVGO`，半导体与芯片 ETF 使用 `SOXX + SMH`。这里展示的是两个可核对的隔夜参考，不生成未经检验的综合指数。报价区的涨跌固定为日涨跌，不能随 5m/15m/1h 图表切换；A 股用最新 5 分钟精确价与前一交易日收盘价计算，并要求盘中交易日不早于日线交易日。没有 verified 报告时允许展示资金规则观察，但标题、徽标和正文必须与“已验证研究结论”分开，且明确不替代 Evidence 门禁。

### Yahoo、东方财富、腾讯、Alpha Vantage、Stooq

当前美股日线顺序：

1. Yahoo，目标五年；
2. 东方财富美股连续复权日线；
3. 腾讯美股；
4. 配置 key 时使用 Alpha Vantage；
5. Stooq 日线兜底。

当前美股 5 分钟采集与日线覆盖不同：生产只为核心盘中驱动 `SOXX`、`NVDA` 注册 `usIntradayCollect`，不是所有美股标的。任务按 `America/New_York` 判断交易日和常规时段 `09:30–16:00`，每 15 分钟抓取原始 5 分钟序列；来源顺序为 Yahoo、东方财富、配置 key 时的 Alpha Vantage。Yahoo 时间戳按 UTC 处理并丢弃末尾未完成或非整 5 分钟临时柱；东方财富美股分时字符串按 `Asia/Shanghai` 解释后转 UTC；Alpha Vantage 才按纽约时区处理，三者不能共用固定时差。数据继续写入 `market_bars`，沿用 90 天 5 分钟保留期，并使用独立 slot、provider 健康与熔断状态。

`SMH`、`TSM`、`AVGO`、`AMD`、`ASML`、`ORCL`、`GOOGL` 当前仍只有日线。限制范围是容量和请求预算决策：5 分钟数据每个标的每个常规交易日约 78 根，扩大到全部驱动会同时增加 D1 行数、Worker 请求和回填时间。扩容前必须先给出 D1 主要表行数、最早/最新时间、近 24 小时写入量和单轮 slot 时间预算，再按研究价值逐个加入 `US_INTRADAY_SYMBOLS`；不得把“adapter 支持美股 5m”写成“全部美股已定时采集”。

已经处理的陷阱：

- Yahoo 的时间点空值会逐条丢弃，全坏序列直接失败；
- 东方财富必须校验 `rc/data/klines`；
- 腾讯偶尔返回相隔多年的“首日 + 最新日”，这不是连续历史，应丢弃断裂种子；
- Stooq 返回 HTML challenge 时必须识别为失败；
- 备选来源也接收实际 limit，不再固定 320 根；
- 同一时间的多源记录可以保留用于审计，图表读取时按时间戳去重。

### QuantStats

参考：[ranaroussi/quantstats](https://github.com/ranaroussi/quantstats)

适合离线报告中的基准收益、回撤、波动率、Sharpe/Sortino 和滚动指标。它不是行情源，也不进入盘中采集。

### awesome-systematic-trading

参考：[wangzhe3224/awesome-systematic-trading](https://github.com/wangzhe3224/awesome-systematic-trading)

用途是能力地图：官方公告、SEC、宏观日历、期权和风险工具。清单中的链接不能自动成为生产来源，选中后仍要单独检查许可、更新时间和失败语义。

券商执行、自动下单和实盘路由不在本项目范围。

## 4. 图表与前端参考

### TradingView Lightweight Charts

参考：[TradingView Lightweight Charts](https://github.com/tradingview/lightweight-charts)

已采用 vendored 5.2.0，用于：

- 多窗格 K 线、成交量、MACD、RSI；
- MA20/60；
- 时间轴和十字线；
- 增量更新最后一根 bar；
- 新闻和事件标记的承载能力。

没有采用 Advanced Charts：它需要单独授权，而且不提供行情数据。当前产品更需要可控的轻量渲染和明确的数据契约。

视觉上只借鉴专业终端的信息密度，不复制 TradingView 产品。统一的字体、间距、按钮、空状态和移动端行为由本项目维护。

## 5. 期权项目

### iVIX

参考：[iVIX](https://github.com/fangbei/iVIX)

吸收了期权数据清洗、波动率研究和风险指标的思路。没有把旧接口或不可验证数据直接复制到生产。

### options_monitor

参考：[options_monitor](https://github.com/1nchaos/options_monitor)

借鉴合约链监控、Greeks、到期月份和暴露指标的组织方式。具体计算仍由 VolGuard 自己的 Black-Scholes、GARCH、BSADF 和暴露模块完成。

### VolGuard 的保留能力

当前实现保留：

- 四窗格联动；
- GARCH VaR；
- BSADF；
- HV / IV；
- Delta、Gamma、Vega、Theta；
- GEX / DEX；
- PCR、Max Pain、Skew；
- OTM 雷达和流动性覆盖。

边缘 `/api/live` 将快速报价与慢速风险快照分开。工作台按两个时间戳展示，缺失字段不填 `0`。

## 6. 新闻与事件来源

### 证据层

优先作为事实依据：

- [上交所基金公告](https://www.sse.com.cn/disclosure/fund/announcement/index.shtml)
- [深交所基金公告](https://www.szse.cn/disclosure/notice/fund/index.html)
- [巨潮资讯](https://www.cninfo.com.cn/new/index)
- 中证指数和基金管理人公告
- [工信部](https://www.miit.gov.cn/)
- 国家统计局
- [SEC EDGAR](https://www.sec.gov/edgar)
- [港交所披露易](https://www1.hkexnews.hk/search/titlesearch.xhtml?lang=ZH)
- 上市公司 Investor Relations
- [Federal Reserve](https://www.federalreserve.gov/)

证据层记录发布主体、发布时间和原文链接。原始公告仍可能更正，因此报告需要保留版本和抓取时间。

报告中的计算口径也属于证据边界。当前 EvidencePacket 只提供单时点技术指标，因此
Agent 只能引用当前值，不能据此声称 MACD/RSI/波动率“仍在扩张、已经收敛或正在
加速”。收益率、比例、均线偏离、交易日数量若需要进入结论，应先由确定性代码计算并
写入独立 Evidence 字段；模型不得在自然语言中临时计算。均线排列按
`close < MA20 < MA60`（空头）或 `close > MA20 > MA60`（多头）校验。
“约为”“估算”“本段临时计算”等免责声明不能把 ledger 中不存在的比例或百分比变成
可发布数字；模型只能改成不带具体数值的定性表达，或等待确定性代码先生成可引用的
`D#`。指标周期中的 `20日已实现波动率` / `已实现波动率20` 属于结构参数，但波动率
的实际数值仍必须与对应 `I#` 完全一致。

### 发现层

用于找线索，不直接替代原始证据：

- [GDELT](https://www.gdeltproject.org/)
- Google News RSS
- Yahoo Finance
- 东方财富
- 财联社
- [RSSHub](https://github.com/DIYgod/RSSHub)

GDELT 的多语言覆盖适合约十五分钟级发现；聚合站转载同一稿件只算一个重复簇。付费全文不复制，只保存标题、允许的摘要、元数据和原文链接。

当前 Worker 已接入 Google News RSS 主题查询，覆盖通信、A 股半导体、美股半导体、Oracle、Alphabet 和 HashKey。HashKey 主题优先解析公司投资者关系公告页内的官方文章 feed，验证域名、发布时间和原文链接后标记为 `evidence`。A 股政策改用中国政府网政策文件库，查询“通信 / 集成电路”，按上海日历过滤最近 30 天；部门文件、国务院公文与公报标记为 evidence，政策解读只作 discovery。上交所会拒绝 Cloudflare 出口，因此 `515880`、`512480` 公告由两小时 GitHub Actions 按代码精确查询，并通过 Cloudflare D1 REST API 参数化写入；只接受交易所原始 PDF，避免把宽泛政策强行映射到具体 ETF。该任务对网络错误、HTTP 429/5xx 与临时无效响应做两次有界重试，耗尽或其它 4xx 仍响亮失败。Google 从 Cloudflare 出口被拒绝时，A 股发现链改用东方财富；美股与港股降级到 Yahoo Finance RSS。东方财富结果始终标记为 discovery，不能替代政府、交易所、基金公司或发行人原文。A 股通信、半导体与政策 discovery 共用标题优先主题门禁：通信与半导体行业词必须直接出现在标题；政策主题只有在标题同时出现明确政策机关与政策动作时，摘要中的行业词才可补充匹配。采集层和 `/api/news` 读取层都执行该规则，因此旧误入库记录也会被隐藏，投资日历、宽基 ETF、海外个案以及碳酸锂、贵金属等仅在摘要或风险提示中顺带出现行业词的文章不会映射给核心 ETF。`03887.HK` 的发行人身份以港交所披露易和 HashKey 投资者关系页为准，不根据公司英文缩写猜测。每个条目保存发布者、发布时间、短摘要和链接，并明确区分聚合发现与官方来源。Google News RSS 是无鉴权发现入口，不是稳定契约；Worker 官方源失败时即使发现层成功也标记为 degraded；上交所任务失败时 Actions 响亮失败。所有来源失败时页面显示不可用，不用旧示例新闻替代。

### 处理管线

```mermaid
flowchart LR
    C["采集"] --> N["规范化时间、来源、链接"]
    N --> E["ETF / 指数 / 基金公司 / 成分股实体"]
    E --> F["短缩写误报过滤"]
    F --> D["标题与转载去重簇"]
    D --> R["相关度、重要性、方向"]
    R --> T["时间衰减"]
    T --> P["价格/成交量对齐"]
    P --> X["反证与替代解释"]
    X --> O["可引用事件"]
```

`SMH` 等普通英文中可能出现的短缩写不能单独命中。新闻和价格同时出现只能提高优先级，不能证明因果。

## 7. “计量客栈”复用范围

复用成熟的工程逻辑：

- 请求幂等 ID；
- 持久化会话；
- SSE 状态事件；
- 断线恢复；
- 结构化引用；
- 上下文哈希；
- 启动预检；
- 安全失败。

没有移植学生注册、课程 A/B 实验等与投资研究无关的领域功能。

## 8. 当前落地与待办

### 已落地

- V2 设置、D1 真值和 v1 兼容迁移；
- 11 个默认标的，包括 ORCL；
- 五分钟 Worker、时间槽幂等、租约、重试和 fencing；
- A 股和美股行情 Provider Registry、熔断和降级；
- 五年美股日线请求和页面区间；
- 动态行情、新闻、事件、状态 API；
- A 股最多 1500 根前复权日线、每日收盘回填和 `512480.SS` 拆分连续性校验；
- 每日资金与行情解释依赖的收盘业务日必须有真实任务记录。Monitor 对
  `cnDailySnapshot / closeFullAnalysis / usCloseSnapshot` 提供 36 小时有界补偿，
  但不历史追赶盘中、信号或新闻；“接口还能访问”不能代替对应业务日 slot 已入库。
- ETF 报告的 Market、News、Fundamentals 在 EvidencePacket 存在时只能读取 ledger；
  不得用上市公司财务、聚合新闻、预测市场或另一套行情填补缺口。claim validation 失败
  后公开界面只保留 `complete_report.md` 的 Not Rated 快照，角色分卷仅留 GitHub 审计。
- Google News RSS 主题发现、实体别名和 `SMH` 短缩写误报回归；
- MA、MACD、RSI、ATR 和实现波动率；
- 七工作区产品壳；
- TradingAgents 运行、档案和报告入口；
- VolGuard 实时 schema v2、快慢双时钟和合约链；
- D1 对话、SSE、请求回放、断线恢复和证据编号。
- 本地 stdio 只读 MCP：目标、状态、行情、新闻和研究运行五个 GET-only 工具。

### 尚未完成

- 交易所、巨潮、SEC、公司 IR 等官方证据层 adapter 的完整覆盖；
- 跨发布者新闻重复簇、影响方向与反证自动标注；
- ETF 持仓、规模、费用、跟踪误差和份额变化；
- 20/60 日相关性和隔夜传导统计；
- PushPlus 高等级盘中事件闭环；
- Qlib / QuantStats 离线研究。

这些内容不会在生产页面用示例数据冒充完成。

## 9. 明确拒绝的方案

| 方案 | 原因 |
|---|---|
| 整体合并 Vibe-Trading | 重复前后端、权限、会话和调度 |
| 把 OpenBB 整个平台装进 Worker | 依赖、许可和 key 面过大 |
| 每五分钟运行 Qlib 或完整 Agent | 时长、费用和噪音不合理 |
| 情绪分数直接给交易结论 | 缺少可验证因果和反证 |
| 聚合新闻当原始公告 | 发布主体和版本不可控 |
| 无来源时展示 iNAV、溢折价或 Greeks | 制造虚假精确值 |
| 旧缓存标成“实时” | 破坏数据可信度 |
| 接入券商自动交易 | 超出研究工具风险边界 |

## 10. 新来源准入清单

新增来源前必须记录：

- 官方文档或项目链接；
- 市场、标的和历史覆盖；
- 更新时间与时区；
- 复权方式；
- 免费额度和 key；
- 许可证和内容使用限制；
- 失败能否被稳定识别；
- 运行位置：Worker、Python 或仅研究；
- 备选来源和熔断方式；
- schema、成本、安全和测试影响。

没有完成这些检查的来源只能进入实验环境。

## 11. 2026-07-30 全局复审后的新增决策

### 美股分时按真实能力开放

生产不是“所有美股都有分时”。只有 `SOXX / NVDA` 有 `usIntradayCollect`，所以只有它们与 A 股核心标的开放 `5m / 15m / 1h`；其他美股和港股只开放日线。来源链保持 Yahoo → 东方财富 → 可选 Alpha Vantage，任一来源成功即可降级服务，但必须暴露来源和 freshness。若要扩到全部美股，应先做 D1 90 天容量、请求数、信号相关性和免费 Worker CPU 预算评估。

### 无任务级结果时不用“pending”冒充状态

当前 task board 只有计划配置和整体 monitor 状态，没有每个语义 slot 的结果 API。因此显示 `unknown / 未验证`，而不是“等待中”。将来只有在 API 返回稳定 slot identity 和结果后，才能显示 success/failed/running。

### 报告失败后用户可见正文必须 fail-closed

保存角色分卷有利于审计，但 claim validation 失败时继续在 `complete_report.md` 展示 SELL、目标仓位或交易计划会误导用户。新增规则是：Manifest 保留失败详情，分卷保留原始文本；汇总正文只展示 Evidence Snapshot、`Not Rated` 和错误码。verified 门禁不放宽。

### 报告公开边界按最终结论校验，不按内部草稿校验

内部 Market、News、Fundamentals、多空辩论和 Trader 草稿用于形成决策，也用于 GitHub
审计，但不是用户可见报告。packet 模式的公开产物只包含 Evidence Snapshot 与最终
Portfolio Decision。最终结论逐段检查：未知/非法 Evidence ID、无引用数字、无方法
目标价和数字仓位会整段省略，Manifest 记录 `omittedUnsafeParagraphs`；剩余正文没有
合法引用时仍为 `Not Rated`。这不是降低门禁，而是使“被校验的文本”和“被公开的文本”
完全一致。组合或同前缀范围引用可以使用；Markdown link 不能伪装 Evidence，异常长度
和展开范围受有界预算保护。

### ETF 拆分公告作为公司行动事实，不猜测参数

上交所 evidence 标题明确包含“份额拆分”时，可在 EvidencePacket 中记录 `fund_share_split_notice` 的公告日期、标题、原文 URL 和来源。公告未明确或解析器未验证的拆分比例、除权日不得补猜。Market Analyst 有 packet 时禁止再调用另一套精确行情工具，避免复权口径冲突。

### 免费边缘调度先缩小工作单元

生产观察到 direct cron `exceededCpu` 后，优先把每轮任务数限制为一、每个 task shard 限为三个外部请求，同时取消已被较新高频 slot 取代的 backlog并收口重试耗尽任务。任务被拆分后，同一 profile 必须先完成同一业务日的全部市场数据 shard 再启动 `closeFullAnalysis`，否则报告会读到混合截面；次日任务不能抢在前一日分析之前。若生产仍超 10ms，正确升级路径是经用户确认后启用 Queue，不是增加 direct 工作量或把 LangGraph 移进 Worker。

### 盘中 freshness 必须服从交易会话

5 分钟数据不能用固定“距现在多少分钟”覆盖所有时段。上海午休、收盘、周末和纽约收盘、周末都应以最近完成的合法会话端点为 freshness 基准；纽约时段必须使用 IANA 时区处理 DST。15m/30m/1h/4h 是 5m 的读取时聚合，当前聚合柱的存储状态跟随最后一个 5m 端点，顶层状态再按该端点、交易会话和周期容忍窗口重算；禁止取桶内最差历史状态。只有 `SOXX / NVDA` 的美股分时 provider 健康行参与该规则，普通日线 Yahoo/Tencent 健康记录保持原语义。腾讯把当前 A 股 5 分钟柱标成区间结束时刻，允许它在合法会话内最多领先当前时间一个 5 分钟步长；否则监控会在每个周期内规律性误报 stale。开盘期间超过 30 分钟的真实延迟、超过一步的未来时间、非整 5 分钟或时段外时间戳必须继续 degraded/stale。

### 派生数字先进入 D#，再进入报告

最终 Agent 不再自行计算窗口涨跌、ATR 占比、均线距离或阈值比较。确定性 Evidence 层预计算这些事实并记录方法、窗口及输入 Evidence ID；模型只能引用对应 `D#`。RSI 30/50/70 只作为明确标注的技术惯例，不包装成数据发现。内部多空辩论属于不可信中间文本，Risk 与 Portfolio Manager 在输出前重新对照 ledger；OHLCV 不能支持“承接盘、主力、机构、散户或资金流”归因。公开层逐段识别无引用叙事、没有 D 证据的窗口排名/极值、面值断言、持续路径和价量因果；任何被过滤段落都使整份方向性报告降为 `Not Rated`，不再从混合质量的模型输出中局部抢救评级。程度/罕见性、随机或噪音、置信度校准、波动率推演未来路径、公司行动经济效果不是普通引用可以支撑的事实类别；必须由被引证据显式给出相应 `claimCapabilities`，否则同义改写也一律拒绝。结构豁免只覆盖受控的 Rating/Time Horizon 值，标题和 Rating 尾随解释不能携带未引用结论；只剩评级、引用残片、条件/观察项时按 `NO_SUBSTANTIVE_SUPPORTED_CONCLUSION` 降级。普通新闻或公司行动引用不建立无关因果，否定词必须在局部从句中直接否定“识别/证明/推断”才能保护主体归因句。
