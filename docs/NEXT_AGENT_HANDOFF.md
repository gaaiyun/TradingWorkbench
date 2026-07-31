# Trading Workbench 下一 Agent 交接

更新日期：2026-07-31（发布边界、A 股分时业务不变量与 Hermes 职责分离）

实现基线：`main`。不要依赖本文中的旧提交号；接手时同时执行 `git rev-parse HEAD`、`git rev-parse origin/main`，并读取 Pages 与 Worker health 的 commit SHA。

工作分支：`feat/fund-flow`；权威发布分支：`main`。本轮代码、报告数据和本文均直接同步到 `origin/main`；接手时不得沿用本文中的短 SHA，应以当前 `origin/main` 和 Pages/Worker 两个 health 端点的完整 SHA 为准。

## 0. 本文的地位与维护方式

**本文是唯一权威交接入口。** 接手时先读本文，再按需跳转其它文档。

读的顺序：本文 §1 → §1.5 生产状态真相 → §2 产品边界 → [开发史](PROJECT_HISTORY.md)（知道为什么是现在这样）→ 具体子文档。

**维护约定**：任何 agent 做完一轮工作后，必须回到本文更新三处——§1 当前结论、§1.5 生产状态、§15 更新日志。发现本文与代码或生产不符时，**在同一提交里修正本文**，不要另开新的交接文档。数字和状态必须来自实际执行的命令，不要沿用上一轮的结论。

## 1. 当前结论

2026-07-31 本轮发布修复包含：Pages 以 `public/data/report-audit.json` 为权威 allowlist 生成 `build/pages-public`，旧 Manifest 即使仍写 verified、但当前索引已 invalidated，也不能发布角色分卷；invalidated、insufficient-evidence、claim-failed 及其它未验证报告的完整正文和原 raw 同名路径生成统一 `Not Rated` 安全内容，以覆盖旧部署/CDN 可能缓存的历史评级。历史兼容例外严格限定为审计索引按完整路径登记且未失败的 `legacy_unverified`：即使 identity 上线前没有 Manifest，完整报告与各原始分卷仍可在持久“历史未验证”警告下只读，不能进入 latest、Chat 或 Evidence。`/api/report` 的门禁和 raw 响应均为 `no-store`。A 股 5m 在采集层拒绝 Yahoo 午休/零成交平盘端点，读取层按交易日选单一来源，migration `0019` 精确清理既有脏行。报告校验补齐“实现波动率”和中文跨月日期的结构数字识别，最终提示词不再诱导无 capability 的传导路径、置信度或公司行动效果。Hermes 原 Job `8dc0823402e7` 已从工程审计原地切换为 08:30 盘前投资简报；旧工程审计 Skill 保留为手工排障，不新建重复 cron。上线真相仍须按 §1.5 的 GitHub、Pages、Worker 三方完整 SHA 和生产端点实时回读，不以本文中的旧短 SHA替代。

多 profile、运行身份隔离、Chat/Evidence owner、调度可靠性、提醒 shadow 账本、Worker/Pages 部署指纹，以及独立的全天资讯采集任务均已合入 `main`。

2026-07-30 本轮全局审查新增五个收口：定时 5 分钟采集每标的只处理最近 96 根而不删除 D1 的 90 天历史；超过 30 分钟仍未执行的高频 slot 以 `STALE_SLOT_EXPIRED` 收口，真实 staging 唯一键冲突单独计入 `conflicted`；5m 及其 15m/1h 等聚合周期的 freshness 改为上海/纽约会话感知并以最新完成端点为准，桶内旧状态不再把当前聚合周期误报 stale，开盘期真实延迟仍保留；EvidencePacket 增加带方法、窗口和输入引用的 `D#` 派生证据；Risk/Portfolio 最终提示禁止自行算数及从 OHLCV 归因主力、机构、承接盘、卖压或资金流。旧的 2026-07-30 原始决策仍被门禁拒绝，受控 D 引用样例通过；本轮没有降低 verified 标准。

同轮独立终审继续封堵公开报告绕过：结构豁免只接受受控 Rating/Time Horizon 值，标题与 Rating 尾随理由不能夹带结论；纯引用、免责声明、条件句和“下一步观察”不能单独构成 verified 报告；普通 N#/CA# 不替无关因果或连续价格路径背书；资金归因的否定按局部从句生效，“不能忽视/无法否认主力流出”仍会被拒。没有阈值、历史分位、统计检验或显式证据能力时，“极端/异常/罕见”“无信号/随机/噪音”、指标一致带来置信度、单点波动率推出反弹或清仓风险、公司行动不损害权益等同义改写同样拒绝；只有被引证据声明对应 `claimCapabilities` 才能放行。更关键的是，最终决策只要有任一段被过滤，就追加 `FILTERED_UNSAFE_PUBLIC_CLAIM` 并将整份方向性报告降为 `Not Rated`，不能局部洗白后保留 Sell/Underweight。真实 v6 重放中两份报告分别有 9/7 个被过滤段落，因此旧的 verified 结果必须由最终代码重算为未评级。

本轮还补齐日报到生产的自动部署链：`daily-analysis` 的 `GITHUB_TOKEN` 数据 push 受 GitHub 递归保护，不能依赖它级联触发 `on: push`。报告持久化成功后现在用 job 自带的最小 `actions: write` 权限和 `github.token` 显式 dispatch `deploy-workbench.yml`，无需新增 PAT；持久化失败不触发部署。提示词同时明确禁止用“估算/约为/本段临时计算”等免责声明绕过派生数字门禁，只能引用已有 `D#` 或改成无数字的定性表达。

人工回读 v7 后发现审计索引仍把旧 v5/v6 三份语义越界评级当作 verified。当前索引已精确失效 `515880.SS 2026-07-30-v5/v6` 与 `512480.SS 2026-07-30-v6`，并加入通用规则：历史 bundle 若声称 rated/verified 但 `omittedUnsafeParagraphs > 0`，直接判 `invalidated`。最终真实单标的 v9 重跑后的索引为 `80 successful / 0 verified / 14 invalidated / 66 legacy_unverified / 7 invalid_record`；`/api/latest?profile=cn-semi-comms` 不再回退到旧 Sell/Underweight。Workbench health 现在检查与用户路由一致的 VolGuard live→snapshot 链，预算为 5 秒 + 3 秒，并在 detail 中保留真实 mode/fallback；snapshot 可用时不误报全站故障，也不冒充 live。

第一次真实重跑暴露了校验器把中文“20日已实现波动率”的数值整数部分误当周期、并把“不满足空头排列/关注是否形成多头排列”误当正向主张；两处已按语义修正，8 日窗口长度也进入 D 行。第二次真实重跑让 `515880.SS` 首次生成 `verified` 报告、`512480.SS` 只剩上述误判；但人工逐句复核又发现 `515880.SS 2026-07-30-v3` 把高成交量写成“更可能反映抛压”。即使标成“假设”也超出 OHLCV 证据边界，因此该报告已精确 invalidated，校验器新增 `UNSUPPORTED_ACTOR_OR_FLOW_ATTRIBUTION`，不能把该 v3 当质量基线。

GitHub 自动部署链已恢复。仓库主人在 2026-07-27 配置了 `CLOUDFLARE_API_TOKEN`，同时补齐 `MONITOR_WORKER_URL`；Pages 自动部署 run `30279626692` 成功，Monitor 在修复生产别名传播等待后 run `30280008338` 成功，CI run `30280007660` 全绿。童装 Agent 使用同一 Cloudflare token 的 production 部署 run `30279633026` 也已从凭据校验、D1 migration、Worker/Pages 发布走到生产冒烟全绿。token 只保存在 GitHub secret，未写入仓库、日志或本文。

同日终审又修复了三个用户可见回归：旧版无 identity 的 43 份 `legacy_unverified` 报告恢复只读展示、同一新闻按 cluster/原文聚合关联标的、交易时钟按沪深与纽约时区及周末判断。历史未验证报告仍不能进入问答，4 份 `invalidated` 报告仍只在“历史审计”中显示。

`cn-semi-comms` 在 2026-07-28 再生成 `515880.SS`、`512480.SS` 的 profile-scoped 报告及角色分卷；两份被引用门禁判为 `insufficient_evidence / legacy_unverified / Not Rated`，没有进入最新观点或问答。该段的 `60` 条旧快照已被后续真实重跑取代，当前数字统一以本节上方的最终 `80 / 0 / 14 / 66 / 7` 为准。

资讯刷新回归已经定位并修复：浏览器原本每 60 秒轮询，但 Worker 的上游采集错误地只挂在交易日 08:25 盘前任务下。现在每个 profile 可独立配置 15/30/60 分钟全天采集，默认 15 分钟；周日 20:00、20:10 与 20:15 的真实批次已让 `cn-semi-comms` 新闻从 146 条增至 162 条，最新 `fetchedAt=2026-07-26T12:15:06.874Z`。来源部分失败会保留成功结果并记录 `NEWS_COLLECTION_PARTIAL`，不会用旧数据伪装全部成功。`market_events` 仍只在真实行情、公告或信号发生时生成，不为周末伪造事件。

2026-07-27 的官方源验收已证明 SEC 修复生效：GOOGL 有真实 `sec.gov/Archives` 8-K evidence；ORCL 最近 8-K 早于 30 天窗口，因此 evidence 为 0 是正确行为，禁止为了凑数放宽窗口。2026-07-28 已删除失效的工信部反爬端点并发布中国政府网政策库。上交所会拒绝 Cloudflare 出口，因此最终改由两小时 GitHub Actions 从可用出口查询并写 D1；首轮生产 run `30290500176` 写入 `515880.SS=4`、`512480.SS=3`，包括二季报和份额拆分原始 PDF。首份 `verified` 报告仍未生成，报告门禁没有放宽。

第四轮还修复了运维可观测性：Worker `/health.newsProviders.reason` 现在区分 `no_binding / query_timeout / empty_table / query_error`，默认 1500ms、冷启动仅重试一次；Pages 发布生成与运行时 SHA 交叉校验的 deployment manifest，`/api/health.deployment` 增加真实 `deployedAt`；`/api/monitor-status?capacity=1` 可按需读取有界 D1 行数和存储估算，默认页面轮询不执行容量查询。本轮生产尾延迟复核后，容量探针自身的默认/硬上限改为 3000/5000ms，不做无法取消的超时重试；这不改变 Worker `/health` 的 1500ms 独立预算。

2026-07-28 又完成 ETF 日频资金面：新增纯追加 migration `0016_fund_flows.sql`、`/api/flows`、独立 GitHub Actions 采集器和市场监控内嵌面板。生产 backfill run `30295062725` 写入 `19636` 条，业务自然键重复为 0；三个 ETF 的融资历史分别为 `1637 / 1579 / 1521` 个交易日，两只沪市 ETF 各有 `1354` 条推导份额，三只均有当前份额快照。daily run `30295641181` 成功处理 `491` 条更新、失败源为 0；工作日北京时间 20:17 已启用自动日更。随后用 `0017_deployment_metadata.sql` 修复同 SHA 后续 Pages 部署遮盖静态 manifest 时 `deployedAt=unknown` 的竞态。最终运行时代码为 `e66def33e034b41e63b8ecd4b930a42a38e7c0bc`：Pages run `30297566846`、Worker run `30297566845`、CI run `30297566980` 全绿；Pages `deployedAt=2026-07-27T19:17:32Z`，Worker `deployedAt=2026-07-27T19:18:37Z`。该数据当前不进入 Evidence/报告，报告门禁与 `0 verified` 状态没有改变。

第五轮把资金面从三张孤立卡片升级为可核验叙事，但没有虚构“国家队/主力”：三卡继续保留当前值，新增融资净买入与 ETF 份额增量的近 60 期历史分位对照、P85/P15、最多 3 个事件时间锚和确定性一句话。份额相邻跳变超过 35% 会以 `possible_split_or_method_change` 排除，缺值不回退、不跨缺口连线；流入/流出由数值正负决定，分位只描述相对力度。事件明确“不代表因果”，隔夜驱动和 ETF 涨跌都显示实际日线日期。最终 CI run `30340865649`、Pages run `30340878635`、Monitor run `30340881245` 全绿；生产浏览器实测 7 个可见一级入口、3 卡、2 条资金线、1 个事件锚、0 pageerror，390px 与 1440px 无横向溢出。Pages `/api/health` 为 `ok`，deployment manifest 合法。该层仍不进入 EvidencePacket、Manifest、报告哈希或 verified 门禁。

第六轮补齐了真正的对照主体：不再把 ETF 融资与 ETF 份额当作“两个玩家”，而是比较 ETF 自身融资净买入与最新披露前十大持仓融资净买入简单合计。采集继续留在独立 `fund-flow` Actions，三个篮子各限 10 只、跨篮子去重、串行抓取、覆盖低于 80% 不写；聚合行的 `method/quality` 明示披露日、覆盖数和 `current_top_N_approximation`。UI 两边统一使用近 5 个可用交易日累计，分位基准为 2024-01-01 起的全部自身历史，图上只展示最近 60 个点；方向先看累计值正负，再用分位表达显著或偏弱。页面明确这不识别国家队、主力或任何具体机构，也不代表因果；三卡、七入口、主图三窗格、期权和 Evidence 边界未变。

### 2026-07-29 资金观察纠错（本轮）

- 根因不是 D1 聚合数值：`515880.SS` 原始两融与前十大持仓逐股数据核对一致；问题是 `/api/flows` 历史查询把旧日期的 `stale` 汇总到最新状态，以及 UI 把单日卡片 P 值与近 5 日叙事 P 值混成裸 `P#`。
- `/api/flows` 现在按 `profile + symbol + flow_type + period + source + adjustment` 的每条逻辑序列分别取最新行判断状态，并在请求时按 4 天阈值重算 freshness；历史旧行不再污染最新状态，多类型查询也不会用较新的一个类型遮住另一个滞后类型。卡片改为“水平 P / 单日 P / 单日变化 P”。
- 叙事改为 `ETF自身融资净买入` 对 `前10大持仓股票融资净买入`，明确“近5个可用交易日累计”、资金日期、最近 60 点展示与 2024-01-01 分位基准；成分股端明确“简单合计，不按 ETF 权重”。
- 结论先由累计值正负决定方向：`515880.SS` 的 P3/P2 输出“两端显著净流出”；`159995.SZ` 的 P48/P19 输出“个股端撤出更明显”；两端日期不一致则输出“暂不可比”。不输出国家队、主力或具体机构归因。
- 本地回归验收：前端 `115/115`；Functions `368 passed / 1 skipped / 0 failed`；完整浏览器脚本退出 0；Ruff、JS 语法、资产版本和 `git diff --check` 全部通过。功能提交 `b6d8a88` 的 CI `30379749679`、Pages `30379749744`、Monitor `30379750103` 均成功；生产回读 Pages 与 Worker SHA 均为完整 `b6d8a883f43b136f896fd6edb9a079da1142826f`，部署时间分别为 `2026-07-28T16:45:54Z` 与 `2026-07-28T16:46:37Z`。
- 外审所称“周五消失、周日幽灵”已证伪：它按 UTC 日期统计了上海本地午夜时间戳。现场按 `Asia/Shanghai` 重算三个 ETF 的 2026 年 `margin_net_buy` 各 135 条，周六/周日均为 0，星期分布为周一 26、周二 27、周三 28、周四 28、周五 26，日期范围 2026-01-05 至 2026-07-27。不得把这些正确行整体搬移一天。
- 真正的数据缺口是历史 backfill 未完成：东财现场 count 已更新为 `515880=1638 / 512480=1580 / 159995=1522`，生产此前只有 135 条。backfill run `30378437748` 已成功，写入 21,471 条更新；三只 ETF 的 `margin_balance / margin_buy / margin_net_buy` 已分别补到 `1638 / 1580 / 1522`。上交所规模源在该 run 中因 GitHub 出口 403 降级，但没有阻断两融与成分股数据。
- 回填后生产完整回读 `margin_net_buy`：`515880=1638`（2019-10-21 至 2026-07-27）、`512480=1580`（2020-01-13 至 2026-07-27）、`159995=1522`（2020-04-13 至 2026-07-27）；`constituent_margin_net_buy` 分别为 `1677 / 1035 / 912` 条，最新交易日同为 2026-07-27。六组序列按 `Asia/Shanghai` 还原后周六、周日计数均为 0，`/api/flows` 状态均为 `ok`。与同标的 643 个日线 market bars 交叉校验时，市场数据覆盖区间内缺失于 market bars 的 flow 日期均为 0；日线已到 2026-07-28、两融到 2026-07-27 是上游披露时差，不是刷新故障。
- `159995.SZ` 仍只有 3 条 `snapshot_unstamped` 份额快照。UI 已改为“ETF 份额（仅快照）/ 历史份额不可用 / 无可比历史”，不再与两只沪市 derived 历史伪装成同口径。
- 生产浏览器验收覆盖 1440×1000 与 390×844：均为 7 个可见一级入口、3 张资金卡、2 条对照线，无横向溢出、无 pageerror/console error；实测从 `515880.SS` 切换到 `512480.SS` 后，资金叙事同步变为截至 2026-07-27 的 ETF 端 P21、前十大持仓端 P17“两端净流出”。页面无框架错误覆盖层。

### 2026-07-29 资金观察红框问题纠错（已发布）

- 根因 1：`loadFundFlow()` 把 `SOXX` 硬编码成所有 ETF 的唯一隔夜驱动。现改为显式篮子：`515880.SS → NVDA + AVGO`，`512480.SS / 159995.SZ → SOXX + SMH`，叙事逐项显示日期和涨跌，不能把篮子冒充成一个指数。
- 根因 2：左侧自选原来让 A 股报价跟随当前图表周期；15m 页面因此显示最后两根 15 分钟 K 线的涨跌，而不是日涨跌。现已将 quote strip 与图表周期解耦，并把列名改为“最新 / 日涨跌”。A 股使用最新 5m 精确价除以前一交易日收盘价；5m 交易日早于日线时拒绝使用。现场交叉核验的真实日涨跌为 `515880=-10.04% / 512480=-7.38% / 159995=-7.98%`，不会再显示截图中的 `+0.00% / -0.10% / +0.00%`。
- 根因 3：`renderConclusion()` 只接收 verified 报告；当前 `0 verified` 时直接渲染永久空白。门禁保持不变，但当资金两端同日且分位可用时显示独立的“主题观察”，输出 `资金偏强 / 资金偏弱 / 方向分化` 和近 5 日两端数值，同时明确“不替代通过 Evidence 门禁的研究报告”。不能把该观察送入报告问答上下文。
- 新增回归覆盖：驱动篮子、日线/盘中精度合并、陈旧盘中拒绝、规则观察 fallback、标题口径。前端 `118/118`、Functions `368 passed / 1 skipped / 0 failed`、完整浏览器脚本退出 0。最终功能提交 `328cda9` 的 CI `30383472709`、Pages `30383472699`、Monitor `30383498898` 全绿；生产回读 Pages 与 Worker SHA 均为 `328cda999dd9d0599bd367445d6976d482f38a8e`，部署时间分别为 `2026-07-28T17:34:32Z` 与 `2026-07-28T17:35:39Z`。
- 生产红框复测：1440×1000 与 390×844 均显示 `512480.SS=1.041 / -7.38%`，标的标题和资金叙事同为 `-7.38%`；叙事为“美股半导体基准：SOXX + SMH”，主题观察为“资金偏弱”，近 5 日 ETF 端 `-4937.38万（P21）`、前十大持仓端 `-8.49亿（P17）`。两种宽度均无横向溢出、pageerror 或 console warning/error。

### 2026-07-29 外部日期复审纠偏与美股分时补齐

- 外部复审把 `/api/flows.ts` 的 UTC 日期直接按 `slice(0,10)` 分组，因此把 `2026-07-26T16:00:00Z` 误判为周日；它实际表示上海 `2026-07-27 00:00`。远程 D1 按 `datetime(ts,'+8 hours')` 复核后，三只 ETF 自身两融周末均为 0，周五分别为 `325 / 313 / 302` 条；前十大持仓聚合周五分别为 `332 / 204 / 179` 条。审核建议中的 `-8 hours` 方向也错误，不能采用。
- “只回填 286/401 天”同样是审核方法错误：它用 `limit=2000` 同时读取 7/5 种 flow type，再把总行数除成日期数。远程 D1 真值为自身 `margin_net_buy`：`515880=1638`、`512480=1580`、`159995=1522`；前十大持仓端为 `1677 / 1035 / 912`。同标的日线覆盖区间内 642 个可比 flow 日期，三只标的缺失于 market bars 的数量都为 0。
- 虽然数据本身没有周末错位，API 只暴露 `ts` 容易反复误读。migration `0018_fund_flow_trade_date.sql` 因此纯追加 `trade_date`，按 `+8 hours` 回填并建立索引；采集器以后直接写东财/上交所返回的业务日期，API 返回 `trade_date`，前端优先使用它。`scripts/verify-fund-flow-production.mjs` 已加入 Pages 发布后验收，要求周末 0、周五存在、flow 日期属于同标的日线集合。
- 真正缺陷是美股 5 分钟历史未被任何 slot 采集：registry 虽支持 Yahoo 5m，但现有 `usCloseSnapshot` 只写 1d。现新增独立 `usIntradayCollect`，按 `America/New_York` 交易日和 09:30–16:00 每 15 分钟执行，只选 `SOXX / NVDA`；来源为 Yahoo → 东方财富 → 可选 Alpha Vantage。东财美股 5m 字符串按北京时间解析，不能复用美东日线时区；Yahoo 末尾未完成且未对齐 5 分钟的实时柱会被丢弃。写入继续使用原 `market_bars`、独立 slot/幂等键、90 天 5m 保留期和 provider 熔断，不改 A 股 intraday、新闻或 Evidence。
- 本机真实上游契约已验证 Yahoo 与东方财富的 SOXX/NVDA 5m 均返回合法行情。功能提交 `64934de` 的 CI `30387614133`、Pages `30387770552`、Monitor `30387613679` 均成功；CI 的浏览器、Functions、Python 3.10–3.13、Ruff 和 clean install 全绿。production alias 回读 Pages/Worker 均为完整 SHA `64934de0f189b4bb37d27603337d6a5891c0d26c`，部署时间分别为 `2026-07-28T18:31:28Z / 18:29:23Z`。
- 生产资金业务日脚本返回三只 ETF 各 `620` 个 2024 年以来交易日，周五各 `121`、周末各 `0`、日线集合缺失各 `0`；D1 完整历史计数仍是 `1638 / 1580 / 1522`。migration 表确认 `0018` 于 `2026-07-28 18:16:12` 应用。
- SOXX/NVDA 生产 D1 各写入 `370` 根 5m，范围 `2026-07-22T13:30:00Z` 至 `2026-07-28T18:15:00Z`；API 最近 300 根均为 `status=ok / source=yahoo-us-intraday / unaligned=0 / 纽约时段外=0 / 周末=0`。bootstrap 首次写入的两条未对齐临时柱（SOXX `18:20:43Z`、NVDA `18:20:52Z`）已在新 Worker 发布后精确删除，D1 `changes=2`，可由上游重新获取但不会再被新适配器写入。
- Pages 首次 run `30386601402` 的业务日步骤在新 deployment alias 传播完成前读到旧 API，因 `FUND_FLOW_TRADE_DATE_MISSING` 正确失败；不是 schema 或数据失败。workflow 增加 12 次、每 5 秒的有界传播等待后，run `30386918595` 与最终 `30387770552` 均通过同一生产不变量。不要删除该重试或把首次失败写成数据回归。

第六轮既有生产收口以功能提交 `8f6381e` 为基线：CI `30361159671`、Pages `30361159801`、Monitor `30361281881` 全绿；backfill `30361200473` 写入 22,329 条更新，随后 daily `30362024552` 无失败写入 793 条更新。远程 `fund_flows=26899` 且业务自然键也是 26899。三只 ETF 的 `constituent_margin_balance / constituent_margin_net_buy` 分别为 `515880.SS=1677/1677`、`512480.SS=1035/1035`、`159995.SZ=912/912`，最新交易日均为 2026-07-27，披露篮子均为 2026-06-30、覆盖 10/10。生产 390px 与 1440px 浏览器均为 3 卡、2 线、无横向溢出、0 pageerror；这些运行号不代表 2026-07-29 本轮修复已发布。

本轮接手已完成数字引用判定修复：`_NUMERIC_CLAIM_RE` 不再把日期、时间戳、标的代码、哈希、Markdown 标题序号和 RSI/MACD/均线参数当作研究数字；逐段复测后 `515880.SS` 为 `179→117`、`512480.SS` 为 `128→84`、`3887.HK` 为 `169→108`，剩余段落仍含未带 Evidence ID 的真实数值，因此没有放宽门禁。三份 `-v4` Manifest 与 `public/data/report-audit.json` 已同步更新。

### 2026-07-30 报告证据链根因与公开边界修复

- 根因不是 LLM 单次失常：`Propagator.create_initial_state()` 虽写入
  `evidence_packet / analysis_status`，但 `AgentState` 未声明这两个字段，编译后的
  LangGraph 会将其丢弃。Agent 因此在没有 Evidence ledger 的情况下生成数字；报告
  writer 最后才看到 packet 并 fail-closed。两个字段现已进入状态 schema，并有真实
  compiled graph 回归测试，不能再改回只在初始字典临时附加。
- 三个核心 ETF 的官方身份已作为静态权威映射提供给 Agent；有 packet 时市场、新闻和
  基本面节点只读 ledger，禁止另取 Yahoo、聚合 discovery、上市公司财务或预测市场
  补数。Evidence 截止日按标的市场业务日展示，不再把原始 UTC 日期当交易日。
- packet 模式不再把全部内部草稿拼成公开报告。角色分卷仍原样留在 GitHub 审计；
  `complete_report.md` 只含 Evidence Snapshot 与最终 Portfolio Decision。最终结论
  中含未知/非法引用、无引用数字、目标价或数字仓位的段落整段省略，不自动补引用；
  Manifest 记录 `omittedUnsafeParagraphs`。省略后没有至少一个合法引用时仍为
  `Not Rated`。
- 引用门禁支持 `[M1-M2, S1]` 等组合与同前缀范围，同时拒绝跨前缀、倒序、未知和
  Markdown-link 伪引用。正常数字免责声明不会误删；真实目标价和中英文数字仓位仍
  拦截。容器长度、编号位数、展开数和推荐语邻域均有预算，超长恶意输入只会
  fail-closed，不会让报告任务崩溃或产生 CPU 回溯。
- v4 虽达到 `verified=2`，逐句复审仍发现模型把前复权价格回撤写成“真实资金
  流出”，并推断散户接盘、程序化卖盘。EvidencePacket 没有资金流或投资者身份字段，
  因此不能接受这种语义越界。全局 Agent context 已新增硬规则：OHLCV 只证明价格与
  成交量，不能改写为资金流、申赎或具体主体行为；`unavailable` 只表示无法判断，
 不能作为隐性风险或定价失效证据。v4 两份报告已加入 `INVALIDATED_REPORTS`。
- 规则修正后的 v5（run `30500333580`）消除了具体主体和资金流伪归因，但人工复算又
  抓到更深一层问题：`512480.SS` 把 1.21 到 1.027 错写成约 10.9%，并在
  `MA20 > MA60` 时称为“空头排列”；两份报告还从单时点 MACD 快照推断“仍在扩张 /
  尚未收敛”。引用存在并不能证明算术或时间趋势正确，因此 v5 两份报告同样精确
  invalidated。校验器现要求最终结论中的数字直接存在于所引 ledger 行，拒绝模型临时
  计算的收益率、比例、均线偏离和交易日数量；单时点指标趋势与矛盾均线排列也会
  fail-closed 为 `Not Rated`。不得把 v4/v5 当最终质量基线。
- 本轮 Functions 基线已增至 `395 passed / 1 skipped / 0 failed`；完整 Python 的上一
  个全绿基线为 `671 passed / 2 skipped / 0 failed`。新增 Python 门禁必须以最终 CI
  的 Python 3.10–3.13 矩阵为准；本机 C 盘满且系统 Python 的可选依赖不完整，不能用
  本机 import 失败冒充代码回归。

## 1.5 生产状态真相（2026-07-29 独立核查）

以下每条都由实际执行的命令或 HTTP 请求得出，不是从上一轮文档抄来的。已完成项也保留，便于下一个 agent 区分“代码未做”与“生产依赖未满足”。

### ✅ 已完成：Cloudflare 自动部署凭据与流水线

- `CLOUDFLARE_API_TOKEN` 已作为 TradingWorkbench repository secret 保存；
- `CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_PAGES_PROJECT`、`MONITOR_WORKER_URL` 已作为 repository variable 保存；
- Pages 自动部署 run `30279626692` 成功；
- Monitor 首次 run `30279619417` 完成 migration 与发布后，因立即读到旧 SHA 而误报失败；`96d63da` 为 SHA 核验增加 12 次、每 5 秒的有界传播等待，run `30280008338` 随后成功；
- 同一 token 已保存到 `gaaiyun/amazon-kidswear-operator-agent` 的 `production` Environment，run `30279633026` 成功。

### ✅ 已完成：Pages 与 Monitor Worker 已发布到当前 SHA

```text
Pages `/api/health` commitSha : 由生产端点实时回读，交接时必须与 `origin/main` 比对
Worker `/health` commitSha : 由生产端点实时回读，交接时必须与 `origin/main` 比对
Worker deployedAt : 由生产端点实时回读，不能为 `unknown`
Pages immutable deployment : 每次发布都会变化，以 `wrangler pages deploy` 输出和 `/api/health` 为准
```

`e66def3` 与 `039ba5a` 均为历史基线，不再当作当前版本。资金观察纠错功能提交 `b6d8a88` 的 CI `30379749679`、Pages `30379749744`、Monitor `30379750103` 中，测试、migration、deploy 和 SHA verify 均执行成功；现场回读 Pages 与 Worker 完整 SHA 均为 `b6d8a883f43b136f896fd6edb9a079da1142826f`，Pages `deployedAt=2026-07-28T16:45:54Z`，Worker `deployedAt=2026-07-28T16:46:37Z`。后续纯文档提交也必须重新发布 Pages 与 Worker，精确 SHA 与部署时间须从生产端点实时回读，不能只抄本文固定值。

其它成功 run：资金流原始 backfill `30295062725`、原始 daily `30295641181`；成分股融资 backfill `30361200473`、恢复 daily `30362024552`；官方公告首轮 `30290500176`。

### ✅ 已完成：GitHub 自动部署凭据

自动发布已从“本机 Wrangler 手工兜底”恢复为 GitHub Actions 权威路径。后续仍需检查具体 migration、deploy、SHA verify step，不能只看 workflow 名称为绿色。

### ✅ 已完成：远程 D1 migrations 核验

`d1_migrations` 只读查询已返回 `0013_monitor_reliability.sql` 至 `0017_deployment_metadata.sql`。0017 用于在同 SHA 的后续 Pages 部署遮盖静态 manifest 时，从 D1 回读可信部署时间；0018 在本轮发布后应新增 `fund_flows.trade_date`，必须用远程 schema/接口回读确认，不能只看文件存在。

### ✅ 已完成：资金流回填、daily 与生产显示

- 原始 backfill run `30295062725` 写入 `19636` 条；成分股回填 `30361200473` 与恢复 daily `30362024552` 后总行数为 `26899`、自然键重复 0；
- 补全历史 backfill run `30378437748` 成功写入或更新 `21471` 条，三只 ETF 自身两融分别补到 `1638 / 1580 / 1522` 条；上交所规模源在 GitHub 出口 403 时单独降级，没有阻断两融与成分股数据；
- `/api/flows` 已启用，UI 只对 `515880.SS / 512480.SS / 159995.SZ` 请求；
- 2026-07-29 `/api/monitor-status?capacity=1` 返回 `fund_flows=26899`，未达到 `100001` 截断线；同次只读容量快照为 `market_bars=15924`、`news_items=799`、`market_events=6`、`evidence_packets=17`、`report_manifests=10`、`chat_messages=26`；
- 沪市份额为 `derived`，深市历史从上线日起累积；不得写成具体机构买卖。
- repository variable `FUND_FLOW_COLLECTION_ENABLED=false` 可跳过定时采集，但保留手工运维入口；页面/API 另由 `FUND_FLOW_ENABLED` 控制，两层开关的作用不同。
- 三个前十大篮子均为披露日 `2026-06-30`、最新交易日 `2026-07-27`、覆盖 `10/10`；`constituent_margin_net_buy` 分别为 `1677 / 1035 / 912` 条。backfill 中 `159995.SZ` 自身两融曾瞬时网络失败但没有丢旧值，随后 daily `30362024552` 恢复且 `failures=[]`。

### ✅ 已完成：资金行为叙事与边界审计

- 叙事主语限定为“ETF 自身融资净买入”和“最新披露前十大持仓融资净买入合计”；两者都是融资账户代理，不识别具体投资者身份；
- 双线使用近 5 个可用交易日累计的各自历史分位，正负决定方向，分位只描述力度；
- 最新持仓近似必须显示披露日和覆盖数；当前篮子回算历史存在持仓变更与存活偏差，不得写成完整指数成分；
- 事件与官方 evidence 新闻只作同期时间锚；页面、SVG 无障碍描述和交接文档均明确不代表因果；
- 份额拆分/口径跳变、最新 null、低样本 20 日中位、正负方向反转、图线跨缺口和重复 SOXX 请求均有回归测试；
- 生产 `515880.SS` 一句话同时显示 SOXX/ETF 日线日期与资金数据截止日，避免把盘中报价、完整日线和滞后两融误当成同一时点；
- Cloudflare 项目现场回读 Git Provider 为 `No`。此前同 SHA 覆盖来自无身份的 Wrangler/ad-hoc 发布，不是 Git integration；最终交付必须由 `deploy-workbench` 生成 manifest 并回读 SHA。

### 🟡 P2：main 是直接 push 的，无 PR 留痕

`git ls-remote --heads origin` 只返回 `refs/heads/main`——远程不存在 `fix/report-evidence-pipeline` 分支。全仓库历史只有 1 个 PR，且与本次工作无关。这不算错，但接手者要知道 review 轨迹只存在于 commit message 里。

本机另有一个 worktree `G:\TradingWorkbench`，其 `main` 停在 `76cd29c`（落后 28 个提交，对应 tag `pre-operability-20260726`）。**误进那个目录会看到过时代码。**

### ⚪ 符合预期，不是故障

- 周日没有行情/信号事件符合市场时钟，但资讯采集不再受交易日限制。20:00 自动批次与 20:10 重试累计写入 16 条新增记录；组合资讯流会出现新的 `NEWS`，`EVENT` 只在真实行情、公告或信号产生时更新。
- provider 汇总为 `degraded` 不等于“没有刷新”：成功来源继续入库，失败来源保存状态码与时间，slot 标记 `NEWS_COLLECTION_PARTIAL` 后按幂等键重试。
- 2026-07-28 03:21 `/health` 现场状态：`eastmoney-search`、`federal-reserve-rss`、`gov-policy-library`、`hashkey-ir`、`sec-edgar-submissions`、`yahoo-finance-rss` 为 `ok`；`google-news-rss=NEWS_HTTP_503`，因此汇总为 degraded。退役的 `miit-policy-api` 与移出 Worker 的上交所 source 均不再污染 active provider health。
- 当前报告审计 `60 / 0 verified / 49 legacy_unverified / 4 invalidated / 7 invalid_record`：直接读 `public/data/report-audit.json`（`generatedAt 2026-07-28T07:50:48.864Z`）核对。零 verified 是 fail-closed 的真实结果。
- GitHub Actions run `30189419616`（cn-semi-comms 首轮）：conclusion **success**，与文档描述一致。
- 资金叙事最终验收的 CI run `30340865649` 全绿，Python 3.10–3.13、Pages Functions、浏览器验收、Ruff 和 clean-install 均成功；Pages run `30340878635` 与 Monitor run `30340881245` 的 migration、deploy 和 SHA verify 均执行成功。
- 上交所 `official-news` 的历史间歇失败包括 `SSE_RESPONSE_INVALID_515880`、连接超时和 HTTP 403。2026-07-30 run `30491426783` 再次因 GitHub runner 连接超时失败；随后代码只对网络错误、HTTP 429/5xx 和临时无效响应按 1 秒、3 秒做两次有界重试，耗尽或其它 4xx 仍响亮失败。影响范围仅是新公告入库延迟，既有 evidence 不删除，也不影响资金流、行情、新闻其它来源或报告门禁；禁止用东方财富等 discovery 结果冒充上交所原文。

## 2. 不可破坏的产品边界

1. 保留七个一级入口：市场监控、Agent 研究、研究任务、研究档案、新闻/事件、期权风控、设置。
2. 保留 TradingAgents Python、CLI、LangGraph、模型 Provider、GitHub Actions 和报告归档。
3. 保留 VolGuard 完整期权能力及独立故障域。
4. 数据失败时显示 degraded、stale 或 unavailable，不使用 fixture 冒充生产数据。
5. 报告只有通过 Evidence、引用、Manifest 和 identity 门禁后才能进入最新观点或问答。
6. 不把访问码、API key、Cloudflare token、GitHub token、Cookie 或 SEC 联系邮箱写入仓库和日志。
7. commit message 使用中文规范，不添加 AI 或 Co-Authored-By 署名。

## 3. 本地与生产对象

| 项目 | 当前值 |
|---|---|
| 工作树 | `G:\worktrees\TradingWorkbench\report-evidence-pipeline` |
| 本地分支 | `feat/fund-flow` |
| 权威发布分支 | `main` |
| 远程 | `https://github.com/gaaiyun/TradingWorkbench.git` |
| Python venv | `G:\venvs\tradingworkbench-report-evidence` |
| Pages | `https://tradingagents-board.pages.dev/` |
| Monitor Worker | `https://tradingagents-monitor.gaaiyun-risk-selfcheck.workers.dev/` |
| VolGuard | `https://sh50-volguard.pages.dev/` |
| 童装 Agent health | `https://amazon-kidswear-agent.pages.dev/healthz` |
| D1 | `tradingagents-workbench` |

## 4. 本轮实现

### 4.1 Profile

- 最多 8 个 profile，每组最多 14 个 targets。
- 网页支持创建、复制、编辑、启停和删除。
- profile ID 不可修改；至少保留一组；副本默认 disabled。
- D1 revision 做 CAS。缺 revision 为 428，冲突为 409。
- D1 不可用时 profile 写接口 fail-closed。
- 页面使用一个 `selectedProfileId`。切换后取消旧请求，重置行情、新闻、任务、档案、报告和聊天。
- 临时研究和 VolGuard 不随 profile 重置。

### 4.2 Run identity

| scope / kind | 字段 |
|---|---|
| `legacy / legacy` | 无 |
| `profile / manual` | `profileId` |
| `profile / monitor` | `profileId + slotId + scheduledFor` |
| `adhoc / adhoc` | UUID `requestId` |

workflow 校验互斥和字段完整性。history、Manifest、Evidence、run title 和报告 API 保存或验证同一 identity。

### 4.3 Chat 和 Evidence

- chat session 绑定 profile；跨组读写或删除返回 409。
- 报告问答范围只允许 `profileId`、`reportRequestId` 或 `reportScope=global` 之一。
- Evidence GET 要显式选择 profile、requestId、global 或 legacy。
- Packet、Manifest 和提交 bundle identity 必须完全一致。
- 报告 selector 与 Manifest 不匹配时返回不可见，不回退到其他运行。

### 4.4 调度

- slot 冻结 profile revision、payload JSON、payload hash 和 local date。
- profile 删除、停用或修改后取消旧 slot。
- bootstrap 按 profile、symbol、timeframe、schema 和 target hash。
- `fullAnalysesPerDay` 使用 D1 原子预算；0 表示不 dispatch。
- profile 公平轮转，计划任务、Queue、consumer 和手工补跑都有硬上限。
- outbox、receipt 和 reconcile 处理 GitHub dispatch 的不确定响应。
- Worker `/health` 暴露 commit SHA、部署时间、有界新闻 provider health 和稳定失败原因；冷启动查询只重试一次。
- `/api/monitor-status?capacity=1` 才执行有界 D1 容量查询，普通页面轮询不增加扫描负担。

### 4.5 提醒

- migration 0015 保存 event provider provenance 和 notification ledger。
- Web 的 `sent / WEB_EVENT_PERSISTED` 表示事件已落库，可在网页看到。
- PushPlus 当前固定 `skipped / SHADOW_MODE`，没有 live 发送。
- 页面显示 SHADOW、延期、失败、结果不确定和已发送。
- live 策略函数已有阈值、静默时段和 critical 例外测试，但生产执行路径尚未启用。

### 4.6 行情 history

- A 股工作台主路径使用 `qfq`。
- Yahoo auto-adjust 使用 `split-and-dividend-adjusted`。
- 报告 Market history 披露 source、adjustment、起止日期和样本数。
- mixed 或 unknown 不改写成 qfq。
- `512480.SS` 2026-07-03 拆分连续性仍是发布门禁。

### 4.7 新闻证据

- ORCL、GOOGL：SEC EDGAR Submissions `8-K/8-K/A`。
- A 股政策：中国政府网政策文件库，查询“通信 / 集成电路”，上海 30 天窗口；部门文件、公文、公报为 evidence，政策解读为 discovery。
- `515880`、`512480`：上交所基金公告由 `official-news.yml` 每两小时从 GitHub runner 按代码精确查询，只接受官方 PDF，再向 enabled profile 参数化写入 D1。
- 3887.HK：HashKey 投资者关系公告。
- 宏观：Federal Reserve 官方 RSS。
- 发现层：Google News；Cloudflare 失败时使用东方财富或 Yahoo。

官方失败不能由 discovery 成功掩盖。SEC、中国政府网、HashKey 响应结构错误会让 Worker 保持 degraded；上交所 HTTP、结构或 D1 写入错误会让独立 `official-news` run 失败，不再污染 Worker health。

## 5. Migration

发布时必须包含：

| Migration | 内容 |
|---|---|
| `0013_monitor_reliability.sql` | slot snapshot、预算、outbox/receipt、bootstrap、公平轮转、新闻健康 |
| `0014_chat_evidence_scope.sql` | Chat/Evidence/Manifest scope 和 owner |
| `0015_notification_deliveries.sql` | event provenance、提醒 shadow 账本 |
| `0016_fund_flows.sql` | 资金流 long-form 表、自然键和查询索引 |
| `0017_deployment_metadata.sql` | Pages 部署身份 D1 兜底 |
| `0018_fund_flow_trade_date.sql` | Asia/Shanghai 资金业务日 |
| `0019_remove_invalid_cn_intraday_bars.sql` | Yahoo A 股 5m 午休与零成交平盘端点精确清理 |

migration 只向前保留。回退代码时不要删除新表或列。

## 6. 部署状态

### 已实现的门禁

`deploy-monitor.yml` 现在：

1. 缺 Cloudflare token、account ID 或 `MONITOR_WORKER_URL` 时失败；
2. 运行 monitor contract tests；
3. 应用 migration；
4. 注入 `WORKER_COMMIT_SHA` 和 `WORKER_DEPLOYED_AT`；
5. 部署后请求 `/health`；
6. 要求运行时 SHA 等于 GitHub SHA。

### 代码层已完成

- `main` 已同步（HEAD = `origin/main`，工作树干净）；
- Worker `/health` 已实现回读运行时 SHA 和部署时间；
- Pages `/api/health` 已增加 commit SHA、deployedAt、branch 和不可变 deployment URL；deployedAt 来自随部署发布且 SHA 匹配的 manifest；
- 部署 workflow 均写成缺凭据即失败，发布后回读目标 SHA。
- Pages 和可选 GitHub Pages workflow 均只上传 `build/pages-public`；当前审计索引未明确 verified 的报告，其 raw Markdown 同名路径只含统一 `Not Rated` 安全墓碑，不含原始分卷正文。

### 生产层已验证

- `deploy-workbench`、`deploy-monitor` 已通过 GitHub Actions 自动发布，不再依赖本机 OAuth；
- Monitor `/health` 回读到自动部署 SHA，Pages `/api/health` 由自动部署 workflow 通过生产别名核验；
- migrations `0013`–`0015` 已通过远程 D1 与两条部署 workflow 重复核验；
- 童装 Agent 的同一 token 复用、D1 migration、Worker、Pages 和生产读路径冒烟均已通过。

### 尚未完成

- 当前生产审计仍为 `verified=0`；首轮 profile 报告已生成但被引用门禁降为 `Not Rated`，下一轮应先消除 `UNCITED_NUMERIC_CLAIM`、`UNSUPPORTED_ALLOCATION` 和无依据目标价；
- PushPlus live 尚未开启，也不在本轮默认授权范围内。

即使 workflow 为绿色，也要打开步骤确认 migration、deploy 和 SHA verify 都执行。**反过来同样成立：生产端点返回了正确的 SHA，也不代表它是经门禁发布的——必须回到 Actions 找到对应的成功 run。**

## 7. 本轮实际验证

以下命令在 2026-07-26 的当前交付候选上执行：

| 命令 | 结果 |
|---|---|
| `npm run test:functions` | 341 tests：340 passed、1 skipped、0 failed（`fbe6c4d` 发布前） |
| `npm run test:frontend` | 89 passed、0 failed |
| `npm run check:workbench` | 通过 |
| `G:\venvs\tradingworkbench-report-evidence\Scripts\python.exe -m pytest -q` | 651 passed、2 skipped、0 failed；另有 69 个 subtests passed |
| `python -m ruff check .` | 通过 |
| `python tests/e2e_workbench.py` | 通过；请求取消及 403/404 为预期的 profile 切换与安全回退用例 |

Functions 的 skip 是显式 opt-in 的在线免费 Provider contract。

两项 Python skip 分别来自未安装的 `langchain_aws` 和未设置的在线 `DEEPSEEK_API_KEY`。旧交接中的测试数字不代表当前 HEAD，不能引用为本轮结果。

## 8. 2026-07-27 08:25 外审

完整协议见 [部署、验收与回退](operations-and-deployment.md#12-2026-07-27-周一-0825-外审协议)。

关键时间：

- 08:20 前：记录 main SHA、migrations、deploy-monitor step 和 Worker health。
- 08:25：观察每个 enabled profile 的 `newsCollect` 与 `premarketBrief` slot。
- 08:30–08:35：检查 slot 状态、attempt、payload 不可变、backlog 和重复 Cron。

SEC 检查：

- ORCL、GOOGL 各自查询 `sec-edgar-submissions`；
- 只接受 `8-K/8-K/A` 和 `sec.gov/Archives` 链接；
- 零条可以合格，但 source trail 必须证明请求成功且结构有效；
- 403、malformed 或超限时保持 degraded。

中国政府网与上交所检查：

- 政策查询词为“通信”“集成电路”，参数与政府网网页真实请求一致；
- 部门文件、公文、公报为 evidence，政策解读为 discovery；
- 上交所按 `515880`、`512480` 精确查询基金公告；
- 两条来源都使用上海 30 天 point-in-time 窗口；
- 每条查询最多 8 项；
- 拒绝未来、窗口外、非官方域名和非公告路径；
- 东方财富成功不能掩盖官方 provider 失败。

外审还要检查 A 股 qfq、Yahoo `split-and-dividend-adjusted`、`512480.SS` 拆分连续和 PushPlus shadow。

## 9. 合并与发布顺序

1. 等正在运行的 `daily-analysis` 完成。
2. `git fetch origin --prune`。
3. 检查 main 新增的报告、history、latest、Manifest 和 Evidence。
4. 运行 `node scripts/report-audit.mjs`。
5. 在最终合并候选上重跑 Node、Python、Ruff 和 E2E。
6. 使用普通 merge 或 fast-forward 合入 main。
7. push 后检查 CI、`deploy-monitor` 和 `deploy-workbench`。
8. 核对 migrations、Worker SHA 和 Pages 路由。
9. 执行生产 profile、identity、Chat/Evidence、行情、新闻、提醒 shadow 和 VolGuard 冒烟。
10. 记录 2026-07-27 SEC 验收和本轮中国政府网、上交所生产验收证据。

不要 force push，也不要在报告任务写 main 时覆盖同日版本目录。

## 10. 接手命令

```powershell
Set-Location "G:\worktrees\TradingWorkbench\report-evidence-pipeline"

git fetch origin --prune
git status --short
git rev-parse HEAD
git rev-parse origin/main
git log --oneline --decorate --graph --max-count=30 --all
```

工作树不干净时先辨认改动归属，不要 rebase、切分支或删除文件。

## 11. 开发史与会话恢复

完整的演化脉络、决策理由、踩过的坑和用户红线见 **[开发史](PROJECT_HISTORY.md)**。接手前建议先读，能避免重新发明已被否决的方案。

一句话版本：项目 2026-07-09 诞生于 Claude Code（v1 静态看板 → v2 Cloudflare Pages 研究终端），2026-07-22 09:59 UTC 用户带 5 条验收清单移交 Codex，07-22 ~ 07-26 由 Codex 完成 v3 统一工作台（D1 + Monitor Worker + Evidence 门禁 + 多 profile），07-25 起 Claude 转为外部审核角色。

主要恢复路径：

| 用途 | 路径 |
|---|---|
| Codex 根会话（v3 主线） | `G:\codex-home\sessions\2026\07\22\rollout-2026-07-22T17-59-01-019f8943-9db3-7c52-88de-0cb3773977ba.jsonl` |
| Codex 索引 | `G:\codex-home\session_index.jsonl` |
| Claude 断线审计会话（2026-07-26 14:45–15:38） | `C:\Users\gaaiy\.claude\projects\G--ClaudeCode\37ac3441-129f-42f1-b85f-9dedff671e97.jsonl` |
| Claude 主线会话（v1→v2 + 监理） | `G:\ClaudeCode\_sessions-store\635a569f-582b-4469-8bcc-4f83c8f7bd0a.jsonl` |
| Claude 可读归档 | `G:\ClaudeCode\readable\_INDEX.md`、`G:\ClaudeCode\archive\` |

Codex 根 task ID：`019f8943-9db3-7c52-88de-0cb3773977ba`

两条已知的陈旧信息：`G:\ClaudeCode\项目恢复提示词.md` 和 `SESSIONS_AND_RECOVERY_MAP.md` 更新时间早于本项目诞生，**没有收录本项目**；Claude 侧 memory `project_tradingagents_deploy.md` 冻结在 2026-07-12 的 v2 阶段，不反映 v3 重构和改名。

这些文件只用于本机恢复。使用 `rg` 搜索目标短语，不要全文打印、提交或上传。不要从历史中复制 token、访问码、Cookie 或密钥。

## 12. 已知边界

- PushPlus live 未启用。
- 上交所 ETF 公告已接入；深交所、巨潮、基金管理人和中证指数的直接适配器仍需按具体数据契约补齐。
- ETF AUM、持仓、份额、费用、跟踪误差和 iNAV 只有取得带时间戳的可靠来源后才能展示。
- 免费来源可能拒绝 Cloudflare 出口，必须保留 provider 失败轨迹。
- VolGuard 工作台已保持快报价 30 秒、慢指标 5 分钟的双时钟；卖方策略观察卡按到期日用一日 VaR（缺失时 HV30 正态近似）计算 90% 认怂线与 99% 目标线，低于 90% 不观察，达到 99% 才列候选。缺失 Greeks 时仍展示阈值距离和覆盖率，但明确不生成 Delta 档位或裸卖指令，不能把周末最近收盘误称为实时。
- 20/60 日跨市场相关性、隔夜传导统计和 Qlib 离线评估仍是后续工作。
- 系统不连接券商，也不宣称交易所级实时。

### 12.1 代码级已知缺陷（2026-07-26 核查新增）

以下是本轮独立核查发现、此前任何文档都未记录的问题。按影响排序。**不要在没读懂上下文的情况下顺手"修复"它们**，其中几条是有意为之的保守设计。

| # | 缺陷 | 位置 | 说明 |
|---|---|---|---|
| 1 | ~~`evidence_packet.json` 写出了非法 JSON `NaN`~~ **已修复，勿重复处理** | `public/reports/MSFT/2026-07-24/evidence_packet.json:12576` | 该文件确实含字面量 `NaN`，Node `JSON.parse` 抛错（.NET 容忍，PowerShell 检查不出来），被判 `invalidated / INVALID_EVIDENCE_PACKET`。**但代码侧的根因已于 2026-07-26 由 `ed6acb7`「fix(证据): 阻断非有限行情并校验报告文件」修复**：`tradingagents/evidence.py:51`、`tradingagents/reporting.py:366/396` 均已加 `allow_nan=False`，上游另有 `evidence.py:79`、`scripts/run_daily.py:402/572` 的 `math.isfinite` 拦截。MSFT 那份报告提交于 2026-07-25（`2e3cd23`），**早于修复**，属修复前的遗留数据产物，不是活跃缺陷。全仓库仅此一处 |
| 2 | ~~**Queue 消费路径不可达**~~ **已补齐可审计 IaC，默认仍安全走 direct** | `wrangler.monitor.queue.toml` | 新增可选 Queue 配置，显式绑定 `MONITOR_QUEUE`、批大小、重试和 DLQ；默认 `wrangler.monitor.toml` 不会在未确认账户套餐/队列已创建时强行启用，避免基础设施漂移和意外计费 |
| 3 | ~~**`/health` 新闻 provider 查询超时过短且四态塌缩**~~ **已修复** | `workers/monitor/src/index.mjs` | 默认 1500ms，可在 10–3000ms 覆盖；冷启动 timeout 重试一次。无 binding、两次超时、空表和查询错误分别返回稳定 reason，不泄漏异常正文 |
| 4 | ~~**"最新观点"路径没有第二道门禁**~~ **已修复并补齐 selector** | `functions/api/latest.js` | 无 selector、带 `profile` 或带 `requestId` 的路径都交叉读取 `report-audit.json`，只放行 `verified + rated + claimValidation=passed`；审计索引不可用时 fail-closed。2026-07-30 生产复核发现旧实现只保护无 selector，而网页实际使用 profile selector，已补回归测试，后续被 invalidated 的历史批次不再冒充已验证最新观点 |
| 5 | **`report-audit.mjs` 的失效名单是硬编码** | `scripts/report-audit.mjs:7-11` | `INVALIDATED_REPORTS` 是人工维护的 3 条路径黑名单。新出现的同类污染报告若无人手动加入，只能靠动态一致性检查兜底，两种机制覆盖面不重叠 |
| 6 | **claim validation 的价格目标/仓位检查仍是无条件关键词匹配** | `tradingagents/reporting.py` | `_PRICE_TARGET_RE` / `_ALLOCATION_RE` 仍不检查附近是否真给了方法论或用户约束。报告写"我们不设目标价"同样会被判违规。文档措辞暗示这是有条件判断，实际不是——**想靠"补一段方法论说明"过门禁是行不通的**。数字主张的结构性误报已在本轮修复：日期、时间戳、标的代码、哈希、Markdown 标题序号和指标参数不再被当作研究数字；剩余价格、比例和指标读数仍需 Evidence ID。 |
| 7 | **CLI 产出物完全在 Evidence 门禁体系之外** | `cli/main.py` | 不传 `evidence_packet`、绕过 `TradingAgentsGraph.propagate()`，产出报告的 `analysisStatus` 恒为 `not_rated`、`auditStatus` 恒为 `legacy_unverified`。想复现"如何让报告变 verified"必须走 `scripts/run_daily.py` |
| 8 | **Python 侧 SEC 客户端需运行时 fair-access 联系邮箱** | `tradingagents/dataflows/official_news.py` | 已加入 `TRADINGAGENTS_SEC_CONTACT_EMAIL` / `news_sec_contact_email`，只在运行时将合规邮箱附加到 SEC UA；仓库不保存个人邮箱。GitHub Actions 仍需用户创建同名 secret，缺失时保持失败并由 discovery 降级，不伪装成 evidence |
| 9 | **`sec-edgar-8k` 是死代码** | `workers/monitor/src/news-collector.mjs:276-304` | `parseSecEdgarAtom()` 完整实现且在 `EVIDENCE_PROVIDERS` 里声明，但 `providerCandidates()` 从不产出该 source。实际只用 `sec-edgar-submissions`。会让人误以为有两条 SEC 通道 |
| 10 | ~~**前端缓存靠手工版本号**~~ **已修复** | `scripts/asset-version.mjs`、`public/index.html` | 版本号改为 CSS+JS 内容哈希；`npm run check:asset-version` 在 CI 阻止漏更新，`npm run update:asset-version` 负责同步 |
| 11 | **行情与新闻的 provider 重名** | `providers/adapters.mjs` vs `news-collector.mjs` | `eastmoney`/`yahoo` 在两套体系里各有一份独立实现，健康状态分别记在 `source_health` 和 `monitor_news_provider_health` 两张表。排障时容易把"行情东财挂了"和"新闻东财挂了"搞混 |

### 12.2 文档陈旧项

- **`docs/REPORT_QUALITY_AUDIT.md` 的审计数字过期一天**：写的是 `46 / 43 / 3`（2026-07-25 快照），实际是 `49 / 45 / 4`。该文档也未提及 `-v4` 版本报告和 MSFT 那条 invalidated。**无条件以 `public/data/report-audit.json` 为准。**
- **`docs/etf-monitoring-reference-and-decisions.md` 说"11 个默认标的"**，实际 `workbench-settings.json` 的 `cn-semi-comms` 有 13 个，与 README 一致。
- **`CHANGELOG.md` 不是本产品的变更记录**：它是上游 TradingAgents Python 包的版本日志（v0.1.0 ~ v0.3.1，最新条目 2026-07-05），完全不含 profile / D1 / Worker / Evidence 等概念。想知道 Workbench 最近发生了什么，看 `git log` 或本文。

## 13. 回退

- Pages：选择前一个已验证 deployment。
- Worker：部署前一个已验证 commit，并注入对应 SHA。
- D1：保留 0013–0015 schema。
- Git：普通 revert 或已验证 tag。
- 设置：D1 是真值，仓库 JSON 只做空库种子。

回退后重跑 Worker SHA、profile 隔离、行情 adjustment、新闻证据、Chat/Evidence owner、提醒 shadow 和 VolGuard 冒烟。

## 14. 参考文档

- [开发史](PROJECT_HISTORY.md)——演化脉络、决策理由、用户红线、会话恢复路径
- [README](../README.md)
- [架构、接口与数据流](architecture-and-data-flows.md)
- [部署、验收与回退](operations-and-deployment.md)
- [产品回归与迁移](regression-and-migration.md)
- [报告质量审计](REPORT_QUALITY_AUDIT.md)——数字已过期一天，见 §12.2
- [参考项目与架构取舍](etf-monitoring-reference-and-decisions.md)——标的数量表述过期，见 §12.2
- [只读 MCP](mcp-readonly.md)

代码、D1 schema、workflow 日志和机器审计索引优先于本文。发现不一致时，在同一提交中修正文档。

## 15. 接手后的建议顺序

1. 跑 §10 的接手命令，确认工作树和分支状态。
2. 读 §1.5，逐条复核生产状态——不要相信本文写的，自己再跑一遍。
3. 确认自动部署凭据仍存在（见 §15.1），不读取 secret 明文。
4. 用 `wrangler d1 migrations list --remote` 确认 0013–0017 仍已应用。
5. 比对 GitHub、Pages、Worker 三方 SHA 和两处 deployedAt。
6. 检查 Worker `gov-policy-library`；另手工运行 `official-news.yml`，核对 `515880.SS`、`512480.SS` 官方 evidence 与原始链接。不要再要求 Cloudflare 直连上交所。
7. 读取 `/api/flows` 的 `margin_net_buy / constituent_margin_net_buy / constituent_margin_balance` 和 `/api/monitor-status?capacity=1`，确认资金面最新交易日、前十大持仓披露日、覆盖数、`fund_flows` 行数与日更 workflow 一致；上交所 403 时应是 degraded + snapshot，不得把整批写成“无数据”。
8. 资金面先稳定观察，不进入 Evidence；之后才轮到报告质量：消除 `UNCITED_NUMERIC_CLAIM` / `UNSUPPORTED_ALLOCATION`，争取第一份 `verified` 报告。

### 15.1 恢复部署凭据（2026-07-27 已完成，保留作灾难恢复）

**Agent 不能代劳这一步**——创建 API token、填写 secret 属于凭据操作，必须由用户在 Cloudflare 和 GitHub 的界面里自己完成。以下是精确到选项的说明，照做即可。

以下名称已配置。若 secret 被轮换或删除，按本节恢复：

| 配置项 | 类型 | 缺了会怎样 |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | GitHub Actions **secret** | `deploy-workbench` 与 `deploy-monitor` 都在第一步 `Check deployment credentials` 直接失败 |
| `MONITOR_WORKER_URL` | GitHub Actions **variable** | 仅 `deploy-monitor` 失败（部署后无法回读 `/health` 校验 SHA） |

已存在：`CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_PAGES_PROJECT=tradingagents-board`、`MONITOR_WORKER_URL`。同一 token 也保存在童装 Agent 的 `production` Environment；只轮换值，不把明文复制到文档或命令历史。

**第一步：在 Cloudflare 创建 API token**

Cloudflare Dashboard → 右上角头像 → **My Profile** → **API Tokens** → **Create Token** → **Create Custom Token**。

权限按下表勾（三条都要，缺一条对应的 step 就会失败）：

| 权限 | 作用域 | 对应的 workflow step |
|---|---|---|
| **Workers Scripts** → Edit | Account | `deploy-monitor` 的 `wrangler deploy`（部署 Monitor Worker） |
| **D1** → Edit | Account | 两个 workflow 的 `wrangler d1 migrations apply --remote` |
| **Cloudflare Pages** → Edit | Account | `deploy-workbench` 的 `wrangler pages deploy` |

Account Resources 限定到本项目所在的那个账号即可，不要给 All accounts。若创建后 wrangler 报账号解析失败，再补一条 **Account Settings → Read**。

**第二步：把 token 存进 GitHub**

在仓库 Settings → Secrets and variables → Actions 里操作，或用 CLI（**下面第一条命令会提示你粘贴 token，token 不要写进命令行，也不要贴进任何会话或文件**）：

```bash
gh secret set CLOUDFLARE_API_TOKEN --repo gaaiyun/TradingWorkbench
```

```bash
gh variable set MONITOR_WORKER_URL --repo gaaiyun/TradingWorkbench --body "https://tradingagents-monitor.gaaiyun-risk-selfcheck.workers.dev"
```

**第三步：验证**

```bash
gh workflow run deploy-monitor.yml --repo gaaiyun/TradingWorkbench --ref main
```

然后 `gh run watch`，**逐个打开 step 确认 migration、deploy、SHA verify 三步都真的执行了、没有 skipped**。跑完再请求一次 Worker `/health`，确认 `deployment.commitSha` 已等于当前 `origin/main`。

**安全提醒**：token 只存在 GitHub secret 里。不要回填进仓库文件、`.env`、D1、日志或任何会话记录。若怀疑泄漏，去 Cloudflare 立即 Roll 掉重建。

## 16. 更新日志

| 日期 | 变更 | 依据 |
|---|---|---|
| 2026-07-26 | 初版交接文档 | Codex 根会话 `019f8943` 收尾 |
| 2026-07-26 | 第二次核查修订：新增 §0 维护约定、§1.5 生产状态真相、§12.1 代码级缺陷、§12.2 文档陈旧项、§15 接手顺序、§16 本表；修正 §1 与 §6 把"已合入"当"已上线"的表述；§11 改为链接开发史；新建 [PROJECT_HISTORY.md](PROJECT_HISTORY.md) | Claude Code 六路并行独立核查（Cloudflare 代码 / Python 与 CI / 全套文档 / Codex 历史 / Claude 历史 / GitHub 与生产端点），关键结论均已二次人工复核 |
| 2026-07-26 | 修复数字引用判定的结构性误报；对当前三份 `-v4` 报告重新计算 Manifest 与审计索引 | Claude 断线审计会话完整解析 249 条记录；逐段实测：`515880.SS 179→117`、`512480.SS 128→84`、`3887.HK 169→108`；保留剩余真实价格、比例和指标读数的 Evidence 门禁 |
| 2026-07-26 | 收尾部署与数据门禁：最新观点增加 verified-only 二次审计；Worker `/health` 查询默认 50ms；新增可选 Queue/DLQ IaC；Python SEC UA 支持运行时联系邮箱；前端 CSS/JS 改用内容哈希缓存；期权页新增卖方策略观察与缺失指标警告；资讯标题去重增强 | 代码测试、生产 VolGuard `/api/live` 现场核验与远程 D1 migrations list；待 GitHub secret `TRADINGAGENTS_SEC_CONTACT_EMAIL` 与 Cloudflare API token 由仓库主人补齐 |
| 2026-07-26 | 卖方策略观察补充分位数规则：为每个到期日计算 90% 认怂线与 99% 目标线，前端显示 Put/Call 行权价边界、真实候选和阈值来源；同步更新静态资源内容哈希 | `test_workbench_options.mjs` 5 项通过、前端 89 项通过；仍受 VolGuard 逐合约 Greeks 覆盖限制，不生成裸卖指令 |
| 2026-07-26 | 手工发布卖方分位数前端并回读 canonical Pages；修正本文件线上 SHA 与 immutable URL | Pages `62562e64ae34` / `9f5b3f07`，Worker `/health` 仍为 `f88df97`；GitHub CI 与自动部署凭据状态分开记录 |
| 2026-07-26 | 修复资讯“页面轮询但上游不采集”的调度回归：新增可配置全天 15/30/60 分钟采集、跨 profile 容量保护、周末调度测试；提高 health 查询阈值并适配 HashKey 1MB 官方公告页 | 周日 20:00–20:15 生产批次使 `cn-semi-comms` 新闻 146→162，HashKey 恢复 `ok`，最新 `fetchedAt=2026-07-26T12:15:06.874Z` |
| 2026-07-27 | 恢复 Cloudflare 自动部署；同一 token 安全复用到 TradingWorkbench 与童装 Agent；Monitor SHA 校验增加生产别名传播等待 | Pages run `30279626692`、Monitor run `30280008338`、CI run `30280007660`、童装 Agent run `30279633026` 全部成功；token 明文未进入仓库或日志 |
| 2026-07-28 | 外审第四轮：替换工信部旧端点，接入中国政府网政策库与上交所 ETF 公告；拆分 Worker health 四态、为 Pages 增加可信 deployedAt、增加显式有界 D1 容量快照；补童装 Agent `/healthz` URL | 本机官方接口实测：`515880` 4 份、`512480` 3 份上交所公告；Functions 335 passed、1 skipped；生产部署与 Cloudflare 出口验收见本轮后续记录 |
| 2026-07-28 | 第四轮生产收口：确认 Cloudflare 无法访问上交所后，将官方公告改为两小时 GitHub Actions；按 enabled profile 参数化写 D1；同步修正文档与运维协议 | SHA `fbe6c4d`；CI `30290486752`、Monitor `30290487359`、Pages `30290488517`、official-news `30290500176` 全绿；生产 `515880.SS=4`、`512480.SS=3` 条 SSE evidence；Functions 340 passed、1 skipped |
| 2026-07-28 | 接入 ETF 日频资金面：两融六年回填、沪市 derived 份额、深市快照累积、2024 起 mid-rank 分位、独立 API/UI/容量观测和工作日 20:17 日更；保持七入口、三窗格、期权与 Evidence 不变 | 安全 tag `pre-fundflow-20260728`；backfill `30295062725` 写入 19636 条且 0 重复；daily `30295641181` 成功；面板启用 Pages `30295901009`、CI `30295900436` 全绿，SHA `eb8e007` |
| 2026-07-28 | 修复 Pages 同 SHA 后续部署遮盖静态 manifest 后 `deployedAt=unknown`：发布成功后才参数化写入 D1，health 仅在静态 manifest 失败时有界回读；同步发布 Worker 并完成最终全链审计 | migration `0017`；Pages `30297566846`、Worker `30297566845`、CI `30297566980` 全绿；现场 Pages/Worker SHA `e66def3`，Pages `deployedAt=2026-07-27T19:17:32Z`、Worker `2026-07-27T19:18:37Z` |
| 2026-07-28 | 将资金面升级为“融资净买入 vs ETF 份额增量”确定性叙事：近 60 期分位双线、事件时间锚、拆分/缺值保护、日线日期与无机构归因边界；保持七入口、主图三窗格、期权和 Evidence 零改动 | 安全 tag `pre-fundflow-narrative-20260728`；功能验收基线 `039ba5a`，CI `30340865649`、Pages `30340878635`、Monitor `30340881245` 全绿；生产 7 入口、3 卡、2 线、1 锚、0 pageerror，`/api/health=ok` 且 manifest 合法 |
| 2026-07-28 | 将主对照改为“ETF 自身融资 vs 最新披露前十大持仓融资合计”：篮子去重串行采集、80% 覆盖门槛、近 5 日累计分位、直接但不冒充机构身份的确定性结论；官方公告故障频率单独披露 | 功能提交 `8f6381e`；CI `30361159671`、Pages `30361159801`、Monitor `30361281881` 全绿；backfill `30361200473` + daily `30362024552` 后 `fund_flows=26899` 且 0 重复；Functions 364/1 skip、前端 111/111、Python 651/2 skip、生产双宽度浏览器验收通过 |
| 2026-07-29 | 全面纠正资金观察状态与叙事：按逻辑序列判断 freshness，区分卡片与近 5 日分位口径，按正负确定资金方向，补齐全历史回填并证明 UTC 周日为上海周一；深市份额明确仅快照 | 功能提交 `b6d8a88`；CI `30379749679`、Pages `30379749744`、Monitor `30379750103` 全绿；backfill `30378437748` 更新 21471 条；三方 SHA 一致；三只 ETF 自身两融 `1638 / 1580 / 1522` 条、上海周末为 0、`/api/flows=ok`；1440px/390px 生产切换标的验收无溢出和控制台错误 |
| 2026-07-29 | 修复用户截图红框：标的专属隔夜驱动篮子、精确日涨跌、无 verified 报告时的规则化主题观察；Evidence 与问答门禁不变 | 功能提交 `328cda9`；CI `30383472709`、Pages `30383472699`、Monitor `30383498898` 全绿；三方 SHA 对齐；1440px/390px 生产实测 512480 左侧、标题、叙事均为 -7.38%，主题观察显示资金偏弱，0 溢出和控制台错误 |
| 2026-07-29 | 证伪 UTC 截断造成的伪周末结论；增加显式 `trade_date` 与生产业务日门禁；补齐 SOXX/NVDA 独立美股 5m 采集、纽约时段/DST、东财北京时间降级和未完成柱过滤 | 功能提交 `64934de`；CI `30387614133`、Pages `30387770552`、Monitor `30387613679` 全绿；三只资金序列周末 0、日线缺口 0；SOXX/NVDA 各 370 根且非整 5 分钟行 0；首次两条临时柱已精确删除 |
| 2026-07-30 | 全局运行、数据、图形、分析和报告正文复审：修复 Worker CPU 工作单元与积压收口、收盘聚合伪 K 线、SOXX/NVDA 分时 UI、新闻层级可见性、任务状态误导、报告未来截止与拆分污染、无效报告仍显示建议等问题；新增云端 Agent 每日全局审查提示词；补齐日报提交后的显式 Pages 部署、波动率周期语义、临时算术提示词约束、历史不安全评级失效和 VolGuard live→snapshot 健康判定 | 本地前端 `120/120`、Functions `419 passed / 1 skipped`、Python `694 passed / 2 skipped`（Windows 使用 `PYTHONUTF8=1`）、Ruff 全绿；代码 CI `30526207092` 全绿；真实单标的 daily-analysis `30526506641` 的分析、持久化和部署 dispatch 均成功，自动 Pages run `30527742906` 的迁移、部署、身份落库、SHA 与资金业务日校验全部成功；最终生产证据见 §1.6 |
| 2026-07-31 | 修复发布过滤收紧后无 Manifest 的 legacy 档案 404 回归：仅按审计索引完整路径恢复 `legacy_unverified` 原文只读并加持久警告；invalidated、insufficient-evidence 和 claim-failed raw 继续封闭 | RED 复现 API 404 与 Pages 产物缺失；定向边界 `3/3`、Functions `431 passed / 1 skipped`、frontend `120/120`；生产 commit、run 与 API 证据待本次部署后回填 |
| 2026-07-31 | 修复档案 UI 丢失 `claimValidation` 后默认请求受阻角色分卷的回归：门禁失败条目只显示并打开安全完整报告，未失败 legacy 原文仍可读 | 生产全量点击复现 66 份中 33 份首次请求 409；新增档案模型回归测试，部署后须复跑 66 份首次点击并确认 0 个读取失败 |

## 1.6 2026-07-30 全局质量复审

生产审计确认的真实问题：

- Monitor direct cron 出现 Cloudflare 免费计划 `exceededCpu`，同时存在被新高频 slot 替代的积压、三次重试耗尽但仍显示 failed/claimed 的历史状态；
- `usCloseSnapshot` 多 shard 共用同一 `scheduled_for`，被既有唯一键静默吞掉第二 shard，造成 ASML/ORCL/GOOGL/3887.HK 日线落后；
- SOXX/NVDA 已有生产 5m 数据，但前端把所有非 A 股强制锁为日线；15m/1h 在精确 session close 时会产生单点零成交伪柱；
- 前 200 条 discovery 新闻挤掉 official evidence，source health API 没完整带出稳定错误码，事件旧数据仍可能显示 fresh；
- 任务板没有任务级结果 API，却把所有计划写成 pending；
- 2026-07-28 的 `512480.SS / 515880.SS` 报告把 ETF 份额拆分误判为价格崩跌，Evidence `asOf` 还晚于生成时间；packet 没带公司行动，Market Analyst 又调用了另一套精确行情，导致数字与复权口径冲突；
- 上述报告虽被外层门禁标为 Not Rated，用户可见 `complete_report.md` 仍保留 SELL 和仓位建议。

本轮代码修复：

- direct cron 每轮最多一个任务、task shard 最多三个外部请求；取消被更新高频 slot 取代的 backlog，三次重试耗尽后标 `RETRY_EXHAUSTED`；多 shard 的 `scheduled_for` 按秒错开；同一 profile 的 retry backlog 按 `local_date → task_priority → scheduled_for → id` 排序，确保同一业务日全部日线 shard 完成后才启动 `closeFullAnalysis`，又不让次日任务饿死前一日分析；
- 增加 36 小时关键日任务补偿：Cron 在入库前失败时，后续 tick 只补建
  `cnDailySnapshot / closeFullAnalysis / usCloseSnapshot`，稳定 slotId 去重；不追赶
  盘中、信号和新闻高频任务；
- 市场任务优先于新闻；SOXX/NVDA 在 UI 开放真实 `5m/15m/1h`，其他美股仍只开放日线；Yahoo 16:00 的 `O=H=L=C / volume=0` 收盘哨兵在采集和 API 读取两层过滤，15m/1h 收盘端点并入前一聚合桶；
- A 股腾讯当前形成柱使用区间结束标签，读取层只容忍一个合法 5 分钟步长内的前置端点；这修复了监控状态每五分钟规律性闪烁 stale，同时继续拒绝更远未来、非整 5 分钟和时段外时间戳；
- evidence/discovery 分层查询，事件 freshness 按四天重算，source health 暴露错误码和熔断元数据；
- 任务板无结果时显示“未验证”；
- Evidence 截止时间不晚于实际生成时点，官方拆分公告进入公司行动；有 EvidencePacket 时 Market Analyst 不再调用另一套精确行情工具；
- 公开 Portfolio Decision 逐段复用 claim validator：无引用定性叙事、未预计算的窗口排名/极值、面值、持续路径/价量因果和虚构主体归因会被剔除并计入 `omittedUnsafeParagraphs`，孤立标题一并清理；raw Agent 分卷保留审计但不对用户发布。否定式均线与“无法确认卖压是否释放”已加入防误报回归；
- 精确 invalidated 两份 2026-07-28 拆分污染报告；新报告 claim validation 失败时，汇总正文只显示 Evidence Snapshot、Not Rated 和失败码；Market/News/Fundamentals 在 packet 存在时全部关闭平行精确数据工具，失败报告的原始角色分卷只留 GitHub 开发审计，不再出现在网页标签页或带身份的报告 API；
- 2026-07-30 新报告仍因自行计算派生比例而被 `UNSUPPORTED_DERIVED_NUMERIC_CLAIM` 降为 Not Rated；这是门禁正常工作，不是可用结论。生产资讯发现碳酸锂、海外个案、投资日历和宽基 ETF 文章会因摘要碰词误路由，现将 A 股通信、半导体与政策 discovery 统一为标题优先：前两类必须在标题命中行业词；政策类只有在标题同时命中政策机关与政策动作时才允许摘要补充行业词。采集与 `/api/news` 两层执行同一规则，旧误入库记录无需等过期即从页面隐藏；
- 新增 [云端 Agent 每日全局审查提示词](CLOUD_AGENT_DAILY_AUDIT_PROMPT.md)，覆盖部署、调度、行情、图形、资金、新闻、报告、VolGuard 和问答。

最终复验结论：

- 真实 monitor 分析 run `30524023076` 成功，随后真实单标的 daily-analysis `30526506641` 也成功；后者生成 `515880.SS 2026-07-30-v9`，报告因 `FILTERED_UNSAFE_PUBLIC_CLAIM / MISSING_EVIDENCE_CITATION / UNSUPPORTED_CAUSAL_OR_PATH_CLAIM / UNSUPPORTED_DERIVED_NUMERIC_CLAIM` 保持 `Not Rated`，方向、仓位和交易建议未公开。最终审计为 `80 successful / 0 verified / 14 invalidated / 66 legacy_unverified / 7 invalid_record`，零 verified 是 fail-closed 真值。
- `daily-analysis` 的报告 push 后显式触发 Pages 已由同一次真实运行证明：分析、`Persist reports to main`、`Trigger Cloudflare Pages deployment` 均为 success；自动部署 run `30527742906` 的 migration、部署、deployment identity 落库、生产 SHA 校验和资金业务日校验全部成功。不得再用手工 `wrangler pages deploy` 绕过该链。
- Pages `/api/health` 连续回读为 `ok`；VolGuard 闭市/慢响应时 detail 如实显示 `mode=snapshot / fallback=timeout`，deployment manifest 合法。Google News 仍可能 `NEWS_TIMEOUT/503`，其余六个 active 新闻源正常时 Worker 新闻汇总仍应如实为 degraded，不能压成 ok。
- 三只 ETF 自 2024-01-01 起各有 `621` 个资金业务日，周五各 `121`、周末 `0`、与同标的日线集合缺口 `0`。SOXX/NVDA 最近生产 5m 各 `299` 根，非整 5 分钟、周末、纽约常规时段外和重复行均为 `0`。只有 SOXX/NVDA 开启美股分时；SMH、TSM、AVGO、AMD、ASML、ORCL、GOOGL 等仍为日线，这是容量控制边界，不得写成“所有美股都有分时”。
- 本文最终提交后已让 Pages 与 Worker 各执行一次 workflow_dispatch；GitHub main、Pages、Worker 三处完整 SHA 已由两个 health 端点回读确认一致。以后任何只改文档或报告数据的 main 提交也必须重复这项身份对齐，不能让运行时长期停在旧 SHA。
