# Trading Workbench 下一 Agent 交接

更新日期：2026-07-26

实现基线：`main`。不要依赖本文中的旧提交号；接手时同时执行 `git rev-parse HEAD`、`git rev-parse origin/main`，并读取 Pages 与 Worker health 的 commit SHA。

工作分支：`fix/report-evidence-pipeline`

## 1. 当前结论

多 profile、运行身份隔离、Chat/Evidence owner、调度可靠性、提醒 shadow 账本、Worker/Pages 部署指纹均已合入 `main` 并于 2026-07-26 发布。生产冒烟已覆盖 Pages、行情、新闻、事件、Monitor health 与 VolGuard；GitHub CI 已通过。

同日终审又修复了三个用户可见回归：旧版无 identity 的 43 份 `legacy_unverified` 报告恢复只读展示、同一新闻按 cluster/原文聚合关联标的、交易时钟按沪深与纽约时区及周末判断。历史未验证报告仍不能进入问答，4 份 `invalidated` 报告仍只在“历史审计”中显示。

首轮 `cn-semi-comms` 手工监控组研究已由 GitHub Actions 运行 `30189419616` 完成，并生成 `515880.SS`、`512480.SS` 的 profile-scoped 报告及角色分卷。两份 Evidence Packet 均有效，但引用门禁发现未引用数字、无依据仓位或目标价，故均为 `insufficient_evidence / legacy_unverified / Not Rated`，没有进入最新观点或问答。当前审计为 `49` 份成功报告、`0 verified`、`45 legacy_unverified`、`4 invalidated`。

尚未完成的是 2026-07-27 08:25 的真实 SEC/工信部采集验收，以及生成首份真正通过当前 Evidence 门禁的报告。接手者不能把周日 Provider `unavailable` 写成采集失败，也不能把旧报告或本次未通过引用门禁的报告升级为 verified。

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
| 本地分支 | `fix/report-evidence-pipeline` |
| 权威发布分支 | `main` |
| 远程 | `https://github.com/gaaiyun/TradingWorkbench.git` |
| Python venv | `G:\venvs\tradingworkbench-report-evidence` |
| Pages | `https://tradingagents-board.pages.dev/` |
| Monitor Worker | `https://tradingagents-monitor.gaaiyun-risk-selfcheck.workers.dev/` |
| VolGuard | `https://sh50-volguard.pages.dev/` |
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
- Worker `/health` 暴露 commit SHA、部署时间和有界新闻 provider health。

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
- A 股通信和芯片：工信部文件发布 API，`cateid=58`，上海 30 天窗口。
- 3887.HK：HashKey 投资者关系公告。
- 宏观：Federal Reserve 官方 RSS。
- 发现层：Google News；Cloudflare 失败时使用东方财富或 Yahoo。

官方失败不能由 discovery 成功掩盖。SEC、MIIT、HashKey 响应结构错误也算失败。

## 5. Migration

发布时必须包含：

| Migration | 内容 |
|---|---|
| `0013_monitor_reliability.sql` | slot snapshot、预算、outbox/receipt、bootstrap、公平轮转、新闻健康 |
| `0014_chat_evidence_scope.sql` | Chat/Evidence/Manifest scope 和 owner |
| `0015_notification_deliveries.sql` | event provenance、提醒 shadow 账本 |

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

### 已完成

- `main` 已同步，migrations `0013`–`0015` 已应用；
- Worker `/health` 已回读运行时 SHA 和部署时间；
- Pages `/api/health` 已增加 commit SHA、branch 和不可变 deployment URL；
- Pages、Worker、D1、动态 API 与 VolGuard 已完成生产冒烟；
- 部署 workflow 均为缺凭据失败，发布后必须回读目标 SHA。

### 尚未完成

- 2026-07-27 08:25 外审尚未执行；
- 当前生产审计仍为 `verified=0`；首轮 profile 报告已生成但被引用门禁降为 `Not Rated`，下一轮应先消除 `UNCITED_NUMERIC_CLAIM`、`UNSUPPORTED_ALLOCATION` 和无依据目标价；
- PushPlus live 尚未开启，也不在本轮默认授权范围内。

即使 workflow 为绿色，也要打开步骤确认 migration、deploy 和 SHA verify 都执行。

## 7. 本轮实际验证

以下命令在 2026-07-26 的当前交付候选上执行：

| 命令 | 结果 |
|---|---|
| `npm run test:functions` | 321 tests：320 passed、1 skipped、0 failed |
| `npm run test:frontend` | 87 passed、0 failed |
| `npm run check:workbench` | 通过 |
| `python -m pytest -q` | 649 passed、2 skipped、0 failed；另有 69 个 subtests passed |
| `python -m ruff check .` | 通过 |
| `python tests/e2e_workbench.py` | 通过；403/404 为预期的安全回退用例 |

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

MIIT 检查：

- 通信、芯片两条查询；
- `cateid=58`、`p=1`、`pg=10`；
- `begin=2026-06-27`、`end=2026-07-27`；
- 每条查询最多 8 项；
- 拒绝未来、窗口外、领导活动和非政策栏目；
- 东方财富成功不能掩盖 MIIT 失败。

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
10. 2026-07-27 08:25 外审通过后记录证据。

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

## 11. Codex 与 Claude 历史

当前根 Codex task ID：

```text
019f8943-9db3-7c52-88de-0cb3773977ba
```

根会话 JSONL：

```text
G:\codex-home\sessions\2026\07\22\rollout-2026-07-22T17-59-01-019f8943-9db3-7c52-88de-0cb3773977ba.jsonl
```

Claude Code 三个恢复路径：

```text
G:\ClaudeCode\readable\
G:\ClaudeCode\archive\
G:\ClaudeCode\项目恢复提示词.md
```

Codex 索引：

```text
G:\codex-home\session_index.jsonl
```

这些文件只用于本机恢复。使用 `rg` 搜索目标短语，不要全文打印、提交或上传。不要从历史中复制 token、访问码、Cookie 或密钥。

## 12. 已知边界

- PushPlus live 未启用。
- 上交所、深交所、巨潮、基金管理人和中证指数的直接适配器仍需补齐。
- ETF AUM、持仓、份额、费用、跟踪误差和 iNAV 只有取得带时间戳的可靠来源后才能展示。
- 免费来源可能拒绝 Cloudflare 出口，必须保留 provider 失败轨迹。
- 20/60 日跨市场相关性、隔夜传导统计和 Qlib 离线评估仍是后续工作。
- 系统不连接券商，也不宣称交易所级实时。

## 13. 回退

- Pages：选择前一个已验证 deployment。
- Worker：部署前一个已验证 commit，并注入对应 SHA。
- D1：保留 0013–0015 schema。
- Git：普通 revert 或已验证 tag。
- 设置：D1 是真值，仓库 JSON 只做空库种子。

回退后重跑 Worker SHA、profile 隔离、行情 adjustment、新闻证据、Chat/Evidence owner、提醒 shadow 和 VolGuard 冒烟。

## 14. 参考文档

- [README](../README.md)
- [架构、接口与数据流](architecture-and-data-flows.md)
- [部署、验收与回退](operations-and-deployment.md)
- [产品回归与迁移](regression-and-migration.md)
- [报告质量审计](REPORT_QUALITY_AUDIT.md)
- [参考项目与架构取舍](etf-monitoring-reference-and-decisions.md)
- [只读 MCP](mcp-readonly.md)

代码、D1 schema、workflow 日志和机器审计索引优先于本文。发现不一致时，在同一提交中修正文档。
