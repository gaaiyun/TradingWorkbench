# TradingAgents 工作台统一设计

## 目标

恢复 TradingAgents 原有研究流程，把 ETF 主题监控作为新增工作区接入，并在同一套导航和视觉规范下呈现 VolGuard 期权风控。用户应当能在网页内完成监控、研究、任务、档案、新闻、期权和设置操作。

## 回归证据

- `8a8eae8` 的工作台提供总览、研究任务、研究档案、新闻资讯、期权和设置六个一级入口。
- `7da70ef` 把 `public/index.html`、`public/assets/workbench.css` 和 `public/assets/workbench.js` 改成单页 ETF 终端。研究任务、档案、新闻和期权从一级工作区退化为按钮、局部区域或外链。
- 当前功能分支 `feat/etf-monitoring-workbench` 是 `origin/main` 的线性后继，领先 29 个提交。D1、定时 Worker、Provider Registry、指标、ORCL、证据问答等实现可以直接保留。
- `SH_50_Index_Option_Trading_Signals` 的 `app.py` 仍包含四窗格、BSADF、GARCH VaR、HV/IV、GEX/DEX、Max Pain 和期权雷达表。Cloudflare Pages 的 `public/index.html` 只展示简化快照。
- TradingAgents 的现有“保留一级入口”测试只检查按钮与外链文本，没有验证用户能否进入完整工作区并完成任务。

## 产品结构

工作台使用稳定的 hash 路由，Cloudflare Pages 不需要额外重写规则：

| 路由 | 名称 | 主要任务 |
|---|---|---|
| `#monitor` | 市场监控 | ETF 与跨市场行情、指标、新闻和定时监控 |
| `#agents` | Agent 研究 | 选择标的和深度，运行完整 TradingAgents |
| `#tasks` | 研究任务 | 查看手工与定时任务的排队、运行、失败和完成状态 |
| `#archive` | 研究档案 | 阅读历史报告、run card、证据与未解决问题 |
| `#news` | 新闻/事件 | 按标的、主题、来源等级和重要性筛选 |
| `#options` | 期权风控 | 50ETF 期权报价、暴露、波动率、期限和风控 |
| `#settings` | 设置 | 监控目标、时区、频率、阈值、访问码和提醒 |

浏览器前进、后退和刷新必须保留当前工作区。桌面使用固定侧栏；移动端保留四个高频入口，其他入口进入“更多”面板。任何核心能力不得只存在于外链。

## 视觉方向

产品采用“机构研究控制台”风格：

- 背景使用深石墨灰；内容面板按一层背景差区分，不使用彩色卡片墙。
- IBM Plex Sans、Noto Sans SC 和 Microsoft YaHei UI 承担界面文字；IBM Plex Mono 只用于价格、时间、代码和指标。
- 使用一个冷青灰强调色标记选中项和主要操作。
- A 股使用红涨绿跌；美股使用绿涨红跌。健康状态使用独立的成功、警告和错误色。
- 按钮、输入框、筛选器、表格、空状态、错误状态和加载骨架共享组件样式。
- 控件动画控制在 160 至 220 毫秒，并尊重 `prefers-reduced-motion`。
- 页面不使用装饰性渐变标题、发光边框、无意义玻璃卡片和入口级弹窗。

## 数据与状态

### 市场监控

市场监控沿用当前 D1 和 Worker。A 股展示 5m、15m、1h、1d；美股只有日线时自动切换到日线，并显示数据覆盖起止日期。

美股日线目标为 5 年：

- Yahoo 请求 `range=5y`。
- 东方财富和腾讯请求最多约 1250 根连续日线。
- `/api/market` 允许最多 1500 根。
- 页面提供 6 月、1 年、3 年和 5 年区间。
- 每次美股收盘任务把完整返回窗口幂等写入 D1。空库启动任务执行同一回填，因此不再增加一套重复的周任务。

### TradingAgents

Agent 研究使用 `/api/analyze` 发起 GitHub Actions，使用 `/api/runs` 读取状态，使用 `/api/history` 与 `/api/report` 读取档案。完整分析默认只作用于 `analysis: full` 的核心标的；用户可以在手工任务中临时覆盖标的。

问答继续使用已实现的请求 ID、D1 会话、SSE 恢复、证据 ID 和来源时间。Agent 研究和档案页面都能设置当前问答上下文。

### 期权风控

期权页面使用两个数据时钟：

1. 快速行情层从 VolGuard `/api/live` 读取，20 至 30 秒刷新一次，包含标的、合约报价、PCR、ATM、近月 Max Pain 和来源状态。
2. 慢指标层来自 VolGuard 快照，显示 BSADF、GARCH VaR、HV、IV、GEX、DEX 和期权链计算结果。页面单独显示计算时间。

后续把可由当期期权链确定的 IV、Greeks、GEX、DEX、Max Pain 和 Skew 移入 VolGuard Edge 计算。依赖长历史的 GARCH、BSADF 和 HV 继续由 Python 任务计算。页面不得把慢指标时间标成行情时间。

TradingAgents 的 `/api/volguard` 负责实时源和静态快照降级。用户可以打开独立 VolGuard 专业站，但该链接是辅助操作，不替代工作台内的期权页面。

## 组件状态契约

每个交互组件必须覆盖：

- 默认、hover、focus、active、disabled 和 loading。
- 输入错误使用字段旁提示，不清空用户输入。
- 加载使用局部骨架，不能用整页空白。
- 数据不可用时保留导航、筛选和上一次可信数据，并显示来源、时间和恢复动作。
- 保存、提交、删除和刷新都提供可读状态反馈。
- 图标按钮必须有 `aria-label`；关键状态不能只靠颜色表达。

## Git 与部署

- 在 `feat/etf-monitoring-workbench` 完成实现和测试。
- 通过全量验证后快进更新 `main`。
- 删除已经合并的 `feat/etf-monitoring-workbench`。
- VolGuard 的 `feat/live-dashboard-pages` 若为 `main` 的祖先，则删除。
- 不创建带 `codex/` 的新分支。现存本地旧分支在确认无独有提交后清理。
- TradingAgents 和 VolGuard 保持独立部署与故障域，通过导航、API 契约和设计令牌组成一个产品。

## 验收标准

- 七个工作区都能通过可见导航进入，浏览器前进、后退和刷新不丢失路由。
- 用户能从 Agent 研究提交任务，在任务页看到状态，并从完成项进入档案。
- 问答能流式返回，刷新后恢复会话，回答列出证据和时间。
- 期权页面自动刷新快速行情，慢指标显示独立时间，任一数据层失败不会清空另一层。
- ORCL 和美股半导体日线支持 6 月、1 年、3 年和 5 年区间；接口返回的覆盖日期与来源可见。
- A 股和美股涨跌色规则正确，健康状态不复用涨跌色。
- 桌面和移动端都能完成监控、发起研究、阅读档案和查看期权四个核心任务。
- TradingAgents Node、Python、E2E 以及 VolGuard Node、Python 测试全部通过，测试输出不保留收集错误或伪测试警告。

