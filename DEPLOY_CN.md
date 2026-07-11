# TradingAgents 研究终端 · 部署说明（gaaiyun fork）

在上游 [TauricResearch/TradingAgents](https://github.com/TauricResearch/TradingAgents)（Apache-2.0）
之上加了一层**零侵入**的产品化封装：上游负责多智能体分析内核，本 fork 负责跑批、网页应用与推送。

## 架构

```
Cloudflare Pages（正式网页 · 手机/电脑）
├── public/index.html      研究终端 UI（发起分析 / 运行状态 / 分卷阅读 / 问答）
└── functions/api/*        后端接口（Pages Functions）
    ├── analyze   POST  访问码校验 → 触发 GitHub Actions 分析
    ├── runs      GET   运行状态（GitHub API）
    ├── chat      POST  基于当前报告的 glm-5.2 问答
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

**网页发起分析**：左栏填标的 + 访问码 → 执行。美股写代码（`NVDA`），A股写 6 位数字
（`600519`→`.SS`、`000001`→`.SZ` 自动补后缀），单次上限 5 个。约 5–20 分钟后页面自动刷新、微信推送。

**Issue 点名**（手机 GitHub App 最方便）：开 Issue 标题「分析: 510050, NVDA」即触发，
完成后机器人回复评级与报告链接并自动关闭。

**问答**：底部输入框，就当前打开的报告分卷向 glm-5.2 提问（需访问码）。

**定时**：每个美股交易日收盘后（北京时间清晨 ~05:35）自动分析
`TRADINGAGENTS_TICKERS` 变量清单（现为 `NVDA,SPY,600519.SS`）。

## 密钥与配置

### Cloudflare Pages（wrangler pages secret put <名> --project-name tradingagents-board）

| Secret | 状态 | 用途 |
|---|---|---|
| `ACCESS_CODE` | ✅ | 网页发起分析/问答的访问码 |
| `OPENAI_COMPATIBLE_API_KEY` | ✅ | 问答功能的方舟 key |
| `GITHUB_DISPATCH_TOKEN` | ✅ | 网页"执行"按钮触发 Actions（fine-grained PAT, 仅本仓库 Actions 读写, 2026-10 到期需续） |

### GitHub 仓库（Actions 用）

Secrets：`OPENAI_COMPATIBLE_API_KEY` ✅、`PUSHPLUS_TOKEN` ✅、`CLOUDFLARE_API_TOKEN` ⬜（配置后
Actions 每次运行自动同步 pages.dev 静态资源；不配也不影响数据新鲜度，数据走 raw 代理）。

Variables：`TRADINGAGENTS_LLM_PROVIDER=openai_compatible`、
`TRADINGAGENTS_LLM_BACKEND_URL=https://ark.cn-beijing.volces.com/api/coding/v3`、
`TRADINGAGENTS_DEEP_THINK_LLM=glm-5.2`、`TRADINGAGENTS_QUICK_THINK_LLM=glm-5.2`、
`TRADINGAGENTS_TICKERS`、`TRADINGAGENTS_ANALYSTS`（默认 market,news,fundamentals）、
`TRADINGAGENTS_OUTPUT_LANGUAGE`（默认 中文）。

方舟 coding 端点可用模型：`glm-5.2`、`doubao-seed-2.0-pro/lite/mini/code`、`kimi-k2.7-code`、
`deepseek-v4-pro/flash`、`minimax-m3/m2.7`、`kimi-k2.6`——改 Variables 即可切换。

## 本地开发

```bash
pip install .
python scripts/run_daily.py --tickers NVDA,600519 --no-push   # 需先配 LLM key 环境变量
npx wrangler pages dev public                                  # 本地起 UI+Functions
```

## 风险提示

大模型研究输出，不构成投资建议。每次分析消耗方舟订阅额度；
访问码门禁保护写操作与问答，请勿公开传播访问码。
