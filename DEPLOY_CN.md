# TradingAgents 研究终端 · 部署说明（gaaiyun fork）

在上游 [TauricResearch/TradingAgents](https://github.com/TauricResearch/TradingAgents)（Apache-2.0）
之上加了一层**零侵入**的产品化封装：上游负责多智能体分析内核，本 fork 负责跑批、网页应用与推送。

## 架构

```
Cloudflare Pages（正式网页 · 手机/电脑）
├── public/index.html      研究工作台（总览 / 任务 / 档案 / 新闻 / 期权 / 设置）
└── functions/api/*        后端接口（Pages Functions）
    ├── analyze   POST  访问码校验 → 触发 GitHub Actions 分析
    ├── settings  GET/POST 读取清单 / 校验后持久化网页设置
    ├── runs      GET   运行状态（GitHub API）
    ├── chat      POST  基于当前报告或期权数据的流式问答
    ├── volguard  GET   实时优先、静态兜底的期权数据代理
    ├── health    GET   数据链路与服务配置健康检查
    └── latest / history / report   数据实时代理（GitHub raw main 分支）

GitHub Actions（分析计算层）
├── daily-analysis.yml     每个美股交易日收盘后跑默认清单 + workflow_dispatch
└── analysis-request.yml   Issue「分析: ...」点名触发（仅仓库主人）
    → 报告 commit 回 main（历史永久可回看）→ 微信推送 → 双站点更新
```

数据经 `/api/*` 直接代理 GitHub main 分支，**页面数据永远是最新一次运行的结果**，
与静态部署的时效无关。

## 入口

| | |
|---|---|
| **主站（国内可达）** | https://tradingagents-board.pages.dev/ |
| 备份镜像 | https://gaaiyun.github.io/TradingAgents/ |
| 仓库 | https://github.com/gaaiyun/TradingAgents |

## 使用

**网页发起分析**：在“任务”页填写标的和访问码后执行。美股写代码（`NVDA`），A股写 6 位数字
（`600519`→`.SS`、`000001`→`.SZ` 自动补后缀），单次上限 10 个。完成后可在任务状态和研究档案中查看结果。

**网页维护每日清单**：在“设置”页直接增删、排序并保存每日分析标的。保存操作触发
`settings-update.yml`，校验后把版本化配置写入 `public/data/workbench-settings.json`；定时分析运行时读取该配置。

**Issue 点名**（手机 GitHub App 最方便）：开 Issue 标题「分析: 510050, NVDA」即触发，
完成后机器人回复评级与报告链接并自动关闭。

**问答**：右侧研究助理支持本机持久会话和流式回复，可使用当前报告或 VolGuard 作为上下文。
访问码默认只保存在当前浏览器会话；如果启用“本机加密记住”，则使用 Web Crypto 加密后存储。

**期权监控**：工作台每 30 秒检查 VolGuard 实时接口，显示行情时间、市场开闭状态、数据来源和慢指标时间。
快速行情与 IV、VaR、GEX、DEX、Max Pain 等慢指标分开展示；实时接口不可用时明确回退到静态快照，
不会把旧快照伪装成实时数据。实时行情当前来自公开网页接口并带 20 秒边缘缓存，生产使用前需自行确认数据授权与稳定性。

**新闻**：默认聚合 Yahoo Finance、Google News RSS、SEC EDGAR 和 Federal Reserve RSS；
`ALPHA_VANTAGE_API_KEY` 存在时可增加 Alpha Vantage。每个来源分别记录成功、空结果、不可用或失败状态，
失败不会中断整次研究，也不会将聚合站误标为原始发布者。

**定时**：每个工作日北京时间 05:35 触发，默认读取网页保存的每日清单；手工运行工作流时可以临时覆盖。

## 密钥与配置

### Cloudflare Pages（wrangler pages secret put <名> --project-name tradingagents-board）

| Secret | 状态 | 用途 |
|---|---|---|
| `ACCESS_CODE` | ✅ | 网页发起分析/问答的访问码 |
| `OPENAI_COMPATIBLE_API_KEY` | ✅ | 问答功能的方舟 key |
| `GITHUB_DISPATCH_TOKEN` | ✅ | 网页发起分析和保存清单（fine-grained PAT，仅本仓库 Actions 读写） |

可选变量：`TRADINGAGENTS_CHAT_ENDPOINT`、`TRADINGAGENTS_CHAT_MODEL` 用于切换 OpenAI-compatible
问答后端；`VOLGUARD_LIVE_URL`、`VOLGUARD_SNAPSHOT_URL` 用于覆盖期权实时与兜底地址。

### GitHub 仓库（Actions 用）

Secrets：`OPENAI_COMPATIBLE_API_KEY` ✅、`PUSHPLUS_TOKEN` ✅、`CLOUDFLARE_API_TOKEN` ⬜（配置后
Actions 每次运行自动同步 pages.dev 静态资源；不配也不影响数据新鲜度，数据走 raw 代理）。

Variables：`TRADINGAGENTS_LLM_PROVIDER=openai_compatible`、
`TRADINGAGENTS_LLM_BACKEND_URL=https://ark.cn-beijing.volces.com/api/coding/v3`、
`TRADINGAGENTS_DEEP_THINK_LLM=glm-5.2`、`TRADINGAGENTS_QUICK_THINK_LLM=glm-5.2`、
`TRADINGAGENTS_ANALYSTS`（默认 market,news,fundamentals）、
`TRADINGAGENTS_OUTPUT_LANGUAGE`（默认 中文）。

方舟 coding 端点可用模型：`glm-5.2`、`doubao-seed-2.0-pro/lite/mini/code`、`kimi-k2.7-code`、
`deepseek-v4-pro/flash`、`minimax-m3/m2.7`、`kimi-k2.6`——改 Variables 即可切换。

## 本地开发

```bash
pip install .
python scripts/run_daily.py --tickers NVDA,600519 --no-push   # 需先配 LLM key 环境变量
npx wrangler pages dev public                                  # 本地起 UI+Functions
npm run test:functions
npm run check:workbench
```

发布顺序：先部署 VolGuard，使 `/api/live` 提供 schema v2；再部署 TradingAgents。
部署后依次检查 `/api/live`、`/api/health`、设置保存、手工任务、流式问答和期权自动刷新。
工作台代码或 Functions 变更推送到 `main` 后，由 `deploy-workbench.yml` 做快速发布，
不会重复执行耗时的股票分析；日常报告仍由 `daily-analysis.yml` 生成。
若本仓库尚未配置 Cloudflare Token，该工作流只运行接口测试并明确跳过发布；可在 VolGuard
仓库手工运行 `deploy-tradingagents.yml`，由已有的 Cloudflare Secret 安全完成同一发布。

## 风险提示

大模型研究输出，不构成投资建议。每次分析消耗方舟订阅额度；
访问码门禁保护写操作与问答，请勿公开传播访问码。
