# Trading Workbench 下一 Agent 交接

更新日期：2026-07-28（外部审核第四轮修复候选）

实现基线：`main`。不要依赖本文中的旧提交号；接手时同时执行 `git rev-parse HEAD`、`git rev-parse origin/main`，并读取 Pages 与 Worker health 的 commit SHA。

工作分支：`fix/report-evidence-pipeline`

## 0. 本文的地位与维护方式

**本文是唯一权威交接入口。** 接手时先读本文，再按需跳转其它文档。

读的顺序：本文 §1 → §1.5 生产状态真相 → §2 产品边界 → [开发史](PROJECT_HISTORY.md)（知道为什么是现在这样）→ 具体子文档。

**维护约定**：任何 agent 做完一轮工作后，必须回到本文更新三处——§1 当前结论、§1.5 生产状态、§15 更新日志。发现本文与代码或生产不符时，**在同一提交里修正本文**，不要另开新的交接文档。数字和状态必须来自实际执行的命令，不要沿用上一轮的结论。

## 1. 当前结论

多 profile、运行身份隔离、Chat/Evidence owner、调度可靠性、提醒 shadow 账本、Worker/Pages 部署指纹，以及独立的全天资讯采集任务均已合入 `main`。

GitHub 自动部署链已恢复。仓库主人在 2026-07-27 配置了 `CLOUDFLARE_API_TOKEN`，同时补齐 `MONITOR_WORKER_URL`；Pages 自动部署 run `30279626692` 成功，Monitor 在修复生产别名传播等待后 run `30280008338` 成功，CI run `30280007660` 全绿。童装 Agent 使用同一 Cloudflare token 的 production 部署 run `30279633026` 也已从凭据校验、D1 migration、Worker/Pages 发布走到生产冒烟全绿。token 只保存在 GitHub secret，未写入仓库、日志或本文。

同日终审又修复了三个用户可见回归：旧版无 identity 的 43 份 `legacy_unverified` 报告恢复只读展示、同一新闻按 cluster/原文聚合关联标的、交易时钟按沪深与纽约时区及周末判断。历史未验证报告仍不能进入问答，4 份 `invalidated` 报告仍只在“历史审计”中显示。

`cn-semi-comms` 已在 2026-07-27 再生成 `515880.SS`、`512480.SS` 的 profile-scoped 报告及角色分卷；两份仍被引用门禁判为 `insufficient_evidence / legacy_unverified / Not Rated`，没有进入最新观点或问答。当前审计索引共 `58` 条：`47 legacy_unverified`、`4 invalidated`、`7 invalid_record`、`0 verified`。

资讯刷新回归已经定位并修复：浏览器原本每 60 秒轮询，但 Worker 的上游采集错误地只挂在交易日 08:25 盘前任务下。现在每个 profile 可独立配置 15/30/60 分钟全天采集，默认 15 分钟；周日 20:00、20:10 与 20:15 的真实批次已让 `cn-semi-comms` 新闻从 146 条增至 162 条，最新 `fetchedAt=2026-07-26T12:15:06.874Z`。来源部分失败会保留成功结果并记录 `NEWS_COLLECTION_PARTIAL`，不会用旧数据伪装全部成功。`market_events` 仍只在真实行情、公告或信号发生时生成，不为周末伪造事件。

2026-07-27 的官方源验收已证明 SEC 修复生效：GOOGL 有真实 `sec.gov/Archives` 8-K evidence；ORCL 最近 8-K 早于 30 天窗口，因此 evidence 为 0 是正确行为，禁止为了凑数放宽窗口。2026-07-28 的修复候选已删除失效的工信部反爬端点，改接中国政府网政策文件库，并新增上交所 ETF 公告 provider。本机真实请求确认政府网返回合法 JSON；上交所对 `515880` 返回 4 份、`512480` 返回 3 份 30 天内官方公告，包括季度报告和份额拆分原始 PDF。首份 `verified` 报告仍未生成，报告门禁没有放宽。

第四轮还修复了运维可观测性：Worker `/health.newsProviders.reason` 现在区分 `no_binding / query_timeout / empty_table / query_error`，默认 1500ms、冷启动仅重试一次；Pages 发布生成与运行时 SHA 交叉校验的 deployment manifest，`/api/health.deployment` 增加真实 `deployedAt`；`/api/monitor-status?capacity=1` 可按需读取有界 D1 行数和存储估算，默认页面轮询不执行容量查询。

本轮接手已完成数字引用判定修复：`_NUMERIC_CLAIM_RE` 不再把日期、时间戳、标的代码、哈希、Markdown 标题序号和 RSI/MACD/均线参数当作研究数字；逐段复测后 `515880.SS` 为 `179→117`、`512480.SS` 为 `128→84`、`3887.HK` 为 `169→108`，剩余段落仍含未带 Evidence ID 的真实数值，因此没有放宽门禁。三份 `-v4` Manifest 与 `public/data/report-audit.json` 已同步更新。

## 1.5 生产状态真相（2026-07-27 独立核查）

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

2026-07-26 20:20 的线上回读已确认两个运行时与当时的 `origin/main` 一致，并包含全天资讯调度、任务容量保护、750ms 有界健康查询与 HashKey 1,028,172 字节官方公告页适配。任何后续提交都必须重新执行三方 SHA 比对。

### ✅ 已完成：GitHub 自动部署凭据

自动发布已从“本机 Wrangler 手工兜底”恢复为 GitHub Actions 权威路径。后续仍需检查具体 migration、deploy、SHA verify step，不能只看 workflow 名称为绿色。

### ✅ 已完成：远程 D1 migrations 核验

`d1_migrations` 只读查询已返回 `0013_monitor_reliability.sql`、`0014_chat_evidence_scope.sql`、`0015_notification_deliveries.sql`，三项均已在远程 D1。

### 🟡 P2：main 是直接 push 的，无 PR 留痕

`git ls-remote --heads origin` 只返回 `refs/heads/main`——远程不存在 `fix/report-evidence-pipeline` 分支。全仓库历史只有 1 个 PR，且与本次工作无关。这不算错，但接手者要知道 review 轨迹只存在于 commit message 里。

本机另有一个 worktree `G:\TradingWorkbench`，其 `main` 停在 `76cd29c`（落后 28 个提交，对应 tag `pre-operability-20260726`）。**误进那个目录会看到过时代码。**

### ⚪ 符合预期，不是故障

- 周日没有行情/信号事件符合市场时钟，但资讯采集不再受交易日限制。20:00 自动批次与 20:10 重试累计写入 16 条新增记录；组合资讯流会出现新的 `NEWS`，`EVENT` 只在真实行情、公告或信号产生时更新。
- provider 汇总为 `degraded` 不等于“没有刷新”：成功来源继续入库，失败来源保存状态码与时间，slot 标记 `NEWS_COLLECTION_PARTIAL` 后按幂等键重试。
- 20:15 `/health` 现场状态：`eastmoney-search`、`federal-reserve-rss`、`hashkey-ir`、`sec-edgar-submissions`、`yahoo-finance-rss` 为 `ok`；`google-news-rss=NEWS_TIMEOUT`；`miit-policy-api` 同批一条查询成功、一条 `NEWS_MALFORMED_RESPONSE`，因此为 `degraded`。HashKey 在 `40da695` 部署后已从响应过大恢复。
- 报告审计 `49 / 0 verified / 45 legacy_unverified / 4 invalidated`：直接读 `public/data/report-audit.json`（`generatedAt 2026-07-26T05:50:32Z`）核对无误，`complete_report.md` 实际文件数也是 49。
- GitHub Actions run `30189419616`（cn-semi-comms 首轮）：conclusion **success**，与文档描述一致。
- 最新提交的 `ci.yml` run `30190646220`：8 个 job 全绿。

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
- `515880`、`512480`：上交所基金公告，按代码精确查询并只接受官方公告路径。
- 3887.HK：HashKey 投资者关系公告。
- 宏观：Federal Reserve 官方 RSS。
- 发现层：Google News；Cloudflare 失败时使用东方财富或 Yahoo。

官方失败不能由 discovery 成功掩盖。SEC、中国政府网、上交所、HashKey 响应结构错误也算失败。

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

### 代码层已完成

- `main` 已同步（HEAD = `origin/main`，工作树干净）；
- Worker `/health` 已实现回读运行时 SHA 和部署时间；
- Pages `/api/health` 已增加 commit SHA、deployedAt、branch 和不可变 deployment URL；deployedAt 来自随部署发布且 SHA 匹配的 manifest；
- 部署 workflow 均写成缺凭据即失败，发布后回读目标 SHA。

### 生产层已验证

- `deploy-workbench`、`deploy-monitor` 已通过 GitHub Actions 自动发布，不再依赖本机 OAuth；
- Monitor `/health` 回读到自动部署 SHA，Pages `/api/health` 由自动部署 workflow 通过生产别名核验；
- migrations `0013`–`0015` 已通过远程 D1 与两条部署 workflow 重复核验；
- 童装 Agent 的同一 token 复用、D1 migration、Worker、Pages 和生产读路径冒烟均已通过。

### 尚未完成

- 本轮政府网与上交所 provider 尚需经 GitHub 自动部署后，从 Cloudflare 出口执行一次真实采集并回读生产 evidence；本机已验证两条官方接口和解析结果；
- 当前生产审计仍为 `verified=0`；首轮 profile 报告已生成但被引用门禁降为 `Not Rated`，下一轮应先消除 `UNCITED_NUMERIC_CLAIM`、`UNSUPPORTED_ALLOCATION` 和无依据目标价；
- PushPlus live 尚未开启，也不在本轮默认授权范围内。

即使 workflow 为绿色，也要打开步骤确认 migration、deploy 和 SHA verify 都执行。**反过来同样成立：生产端点返回了正确的 SHA，也不代表它是经门禁发布的——必须回到 Actions 找到对应的成功 run。**

## 7. 本轮实际验证

以下命令在 2026-07-26 的当前交付候选上执行：

| 命令 | 结果 |
|---|---|
| `npm run test:functions` | 336 tests：335 passed、1 skipped、0 failed（2026-07-28 第四轮候选） |
| `npm run test:frontend` | 89 passed、0 failed |
| `npm run check:workbench` | 通过 |
| `G:\ClaudeCode\TradingAgents\.venv\Scripts\python.exe -m pytest -q` | 651 passed、2 skipped、0 failed；另有 69 个 subtests passed |
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
| 4 | ~~**"最新观点"路径没有第二道门禁**~~ **已修复** | `functions/api/latest.js` | 无 selector 的首页路径并行读取 `latest.json` 与 `report-audit.json`，只放行 `verified + rated + claimValidation=passed`；审计索引不可用时 fail-closed，不把未审报告当最新观点 |
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
4. 用 `wrangler d1 migrations list --remote` 确认 0013–0015 仍已应用。
5. 比对 GitHub、Pages、Worker 三方 SHA 和两处 deployedAt。
6. 从生产触发一次 `newsCollect`，确认 `gov-policy-library`、`sse-fund-announcements` 在 Cloudflare 出口成功；核对 `515880.SS`、`512480.SS` 官方 evidence 与原始链接。
7. 读取 `/api/monitor-status?capacity=1`，确认容量快照有界且不影响默认请求。
8. 之后才轮到报告质量：消除 `UNCITED_NUMERIC_CLAIM` / `UNSUPPORTED_ALLOCATION`，争取第一份 `verified` 报告。

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
