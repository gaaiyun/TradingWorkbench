# 参考项目、数据源与架构取舍

更新日期：2026-07-24

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

### Yahoo、东方财富、腾讯、Alpha Vantage、Stooq

当前美股日线顺序：

1. Yahoo，目标五年；
2. 东方财富美股连续复权日线；
3. 腾讯美股；
4. 配置 key 时使用 Alpha Vantage；
5. Stooq 日线兜底。

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
- 上市公司 Investor Relations
- [Federal Reserve](https://www.federalreserve.gov/)

证据层记录发布主体、发布时间和原文链接。原始公告仍可能更正，因此报告需要保留版本和抓取时间。

### 发现层

用于找线索，不直接替代原始证据：

- [GDELT](https://www.gdeltproject.org/)
- Google News RSS
- Yahoo Finance
- 东方财富
- 财联社
- [RSSHub](https://github.com/DIYgod/RSSHub)

GDELT 的多语言覆盖适合约十五分钟级发现；聚合站转载同一稿件只算一个重复簇。付费全文不复制，只保存标题、允许的摘要、元数据和原文链接。

当前生产 Worker 已接入 Google News RSS 主题查询，覆盖通信、A 股半导体、美股半导体、Oracle 和工信部站点发现。Google 从 Cloudflare 出口被拒绝时，A 股和政策主题自动改用工信部官方 RSS，美股半导体与 Oracle 改用 Yahoo Finance RSS；相同的工信部大文档在单次任务内只下载一次。每个条目保存发布者、发布时间、短摘要和链接，并明确区分聚合发现与官方来源。Google News RSS 是无鉴权发现入口，不是稳定契约；所有来源都失败时页面显示不可用，不用旧示例新闻替代。

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
- Google News RSS 主题发现、实体别名和 `SMH` 短缩写误报回归；
- MA、MACD、RSI、ATR 和实现波动率；
- 七工作区产品壳；
- TradingAgents 运行、档案和报告入口；
- VolGuard 实时 schema v2、快慢双时钟和合约链；
- D1 对话、SSE、请求回放、断线恢复和证据编号。

### 尚未完成

- 交易所、巨潮、SEC、公司 IR 等官方证据层 adapter 的完整覆盖；
- 跨发布者新闻重复簇、影响方向与反证自动标注；
- ETF 持仓、规模、费用、跟踪误差和份额变化；
- 20/60 日相关性和隔夜传导统计；
- PushPlus 高等级盘中事件闭环；
- 只读 MCP 工具；
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
