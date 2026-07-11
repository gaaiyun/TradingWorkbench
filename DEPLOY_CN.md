# 自动化部署说明（gaaiyun fork）

本 fork 在上游 [TauricResearch/TradingAgents](https://github.com/TauricResearch/TradingAgents) 之上
只增加了一层**零侵入**的自动化部署（不改上游任何模块）：

| 组件 | 文件 | 作用 |
|---|---|---|
| 无头运行器 | `scripts/run_daily.py` | 逐 ticker 跑完整多智能体分析，产出 JSON + Markdown 报告 + 历史累积 |
| 决策看板 | `public/index.html` | 响应式静态站（手机/桌面），评级卡片、历史回看、全文报告阅读器 |
| 定时工作流 | `.github/workflows/daily-analysis.yml` | 美股交易日收盘后自动分析默认清单 → 部署 → 微信推送 |
| 点名分析 | `.github/workflows/analysis-request.yml` | 开 Issue 即触发任意标的分析（仅仓库主人） |

## 线上地址

- **决策看板（GitHub Pages）**: https://gaaiyun.github.io/TradingAgents/
- **国内镜像（Cloudflare Pages）**: https://tradingagents-board.pages.dev/
- 手动触发：Actions → daily-analysis → Run workflow（可临时指定 tickers）

## 📱 随时点名分析（推荐用法）

到 [New Issue](https://github.com/gaaiyun/TradingAgents/issues/new?template=analysis.yml)
开一个标题为 **`分析: NVDA, 600519`** 的 Issue 即可（手机 GitHub App / 网页都行）：

1. 机器人立即回复"已受理"；
2. 约 5–20 分钟后：Issue 下回复各标的评级 + 报告链接，微信同步推送，看板更新；
3. Issue 自动关闭。

**标的写法**：美股直接写代码（`NVDA`、`SPY`）；A股写 6 位数字自动补后缀
（`600519`→`.SS`，`000001`→`.SZ`，`510050`→`.SS`），也可显式带后缀。单次上限 5 个。
安全：只有仓库主人开的 Issue 会触发，陌生人无法烧你的 LLM 配额。

## 配置（仓库 Settings）

### Secrets

| Secret | 状态 | 说明 |
|---|---|---|
| `OPENAI_COMPATIBLE_API_KEY` | ✅ 已配 | 火山方舟 coding 端点密钥 |
| `PUSHPLUS_TOKEN` | ✅ 已配 | 微信推送 |
| `CLOUDFLARE_API_TOKEN` | ⬜ 可选 | 配置后每次运行自动同步国内镜像（Pages:Edit 权限） |
| `DEEPSEEK_API_KEY` 等 | ⬜ 可选 | 换 provider 时配对应密钥（见 `tradingagents/llm_clients/api_key_env.py`） |

### Variables（当前生效值）

| Variable | 当前值 | 说明 |
|---|---|---|
| `TRADINGAGENTS_LLM_PROVIDER` | `openai_compatible` | LLM 供应商 |
| `TRADINGAGENTS_LLM_BACKEND_URL` | `https://ark.cn-beijing.volces.com/api/coding/v3` | 方舟 coding 端点 |
| `TRADINGAGENTS_DEEP_THINK_LLM` | `glm-5.2` | 深度思考模型 |
| `TRADINGAGENTS_QUICK_THINK_LLM` | `glm-5.2` | 快速模型 |
| `TRADINGAGENTS_TICKERS` | `NVDA,SPY,600519.SS` | 每日定时分析清单 |
| `TRADINGAGENTS_ANALYSTS` | 默认 `market,news,fundamentals` | 分析师子集（可加 `social`） |
| `TRADINGAGENTS_OUTPUT_LANGUAGE` | 默认 `中文` | 报告语言 |
| `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_PAGES_PROJECT` | 已配 / `tradingagents-board` | 国内镜像项目 |

方舟 coding 端点可用模型：`glm-5.2`、`doubao-seed-2.0-pro/lite/mini/code`、`kimi-k2.7-code`、
`deepseek-v4-pro/flash`、`minimax-m3/m2.7`、`kimi-k2.6`（改 Variables 即可切换，无需改代码）。

数据源默认全走 **yfinance（免 key）**，宏观数据可选配 `FRED_API_KEY`。
未配置 LLM key 时工作流保持绿色并在看板显示配置提示。

## 报告持久化

每次运行的报告 Markdown 与历史索引会由机器人 commit 回 main（`[skip ci]`），
看板"历史记录"区可回看最近 60 次运行，旧报告链接永久有效。

## 本地运行

```bash
pip install .
# 配好 provider 对应的 API key 环境变量后：
python scripts/run_daily.py --tickers NVDA,600519 --no-push
python -m http.server 8788 --directory public   # 本地预览看板
```

## 风险提示

TradingAgents 为研究框架，输出不构成投资建议；每次分析消耗 LLM token
（方舟 coding 订阅额度内），Issue 点名单次上限 5 标的。
