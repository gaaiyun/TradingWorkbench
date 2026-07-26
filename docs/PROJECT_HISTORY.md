# Trading Workbench 开发史

更新日期：2026-07-26

本文记录项目从诞生到当前的演化脉络、关键决策的理由、返工过程和用户明确划定的红线。目的是让接手者知道**为什么是现在这个样子**，避免重新发明已被否决的方案，或推翻有理由的约束。

当前状态见 [NEXT_AGENT_HANDOFF.md](NEXT_AGENT_HANDOFF.md)。本文只写历史，不写当前状态。

## 1. 时间线

项目诞生于 2026-07-09。在此之前用户账号下不存在任何叫 TradingAgents 的仓库（2026-05-31 的一次全量 `gh repo list` 转储可证）。名字相近的 `gaaiyun/TradingAgents-OpenClaw-Skill` 是另一个无关的小项目，不要混淆。

| 阶段 | 时间 | 主导 | 成果 |
|---|---|---|---|
| v1 静态看板 | 2026-07-09 ~ 07-11 上午 | Claude Code | `scripts/run_daily.py` 无头批处理 + 静态 `public/index.html` + GitHub Pages + `daily-analysis.yml` 定时 + PushPlus 推送。无后端、无对话 |
| v2 研究终端 | 2026-07-11 下午 ~ 07-12 | Claude Code | 迁到 Cloudflare Pages（`tradingagents-board.pages.dev`）+ Pages Functions 作后端（analyze/chat/runs/latest/history/report）。状态仍是仓库里的 JSON 文件，无 D1。接入 VolGuard 期权面板代理 |
| 交接 | 2026-07-22 09:59 UTC | 用户 | 用户带着 5 条验收清单把开发主导权移交 Codex |
| v3 统一工作台 | 2026-07-22 ~ 07-26 | Codex | 引入 D1 + Monitor Worker + Evidence Packet 门禁 + 多 profile 隔离 + run identity。仓库改名 `TradingAgents` → `TradingWorkbench` |
| 监理 | 2026-07-25 起 | Claude Code | 用户把 Claude 的角色重定义为外部审核/调研/做计划/指挥，不再直接开发 |

v1 被用户一句话否决（2026-07-11，原话）：

> 现在这个界面不好，首先和原版不一样，没有直接了当的交互和聊天窗口，没有后端等等，最好是部署到 cloudflare 上成为一个正式的网页，而且 UI 也少一点 ai 味道吧拜托

这条同时定下了后来一直生效的 UI 约束：衬线刊头 + 等宽数据、直角发丝线、单一强调色，禁 emoji / 渐变 / 药丸按钮。

### 1.1 交接时刻

2026-07-22 09:59 UTC，Codex 根会话 `019f8943` 第 9 行，用户首条消息即交接指令，附带当时的问题清单：

1. 对话功能失效
2. 每日任务不能在页面指定分析标的
3. 页面展示内容待完善
4. 期权监控非实时、不自动刷新、指标计算不完善
5. 页面待打磨

第 4 条当天就查出是实质性计算错误：DEX 少算 100 倍、到期合约仍参与 IV/GEX/Max Pain 计算、VaR 与已实现波动率重复放大。

### 1.2 奠基设计文档

2026-07-23 12:35，用户粘贴一份完整的《TradingAgents ETF 主题监控工作台实施计划》并要求实现。原文存档：

```text
G:\codex-home\attachments\e8a42e8d-475a-44f8-833c-c44d1ef4e8e5\pasted-text.txt
```

七个一级入口、三层运行时职责分离、不连券商等产品骨架都出自这份计划。

### 1.3 证据链危机

2026-07-24 11:41，用户的朋友测试已发布的 515880.SS 报告，反馈被证实成立：系统把一次合法的 1:2 份额拆分误判成价格暴跌，并给出"立即清仓"结论。根因分析原文存档：

```text
G:\codex-home\attachments\a92adedc-0279-4ba4-990d-ef8c469a9264\pasted-text.txt
```

同日 11:55 建立隔离工作树 `G:\worktrees\TradingWorkbench\report-evidence-pipeline`，分支 `fix/report-evidence-pipeline`——当前工作树的名字就是这么来的。

## 2. 关键决策与理由

### 2.1 Evidence Packet 门禁

515880.SS 事件的根因有四层：

1. 网页与 GitHub Actions 深度分析用两套互相独立、口径不一致的行情（D1 腾讯前复权 vs Yahoo/Python）
2. 所谓"验证快照"只查 OHLCV 是否存在、是否过期、能否算指标，完全不查拆分、复权口径、相邻交易日异常跳变——错误数据反而被盖上"可信"戳
3. ETF 被套用公司财务模板
4. 结构化 Schema 只允许 Buy/Hold/Sell 五档评级，没有"证据不足"选项，提示词还要求"要果断"，逼模型在底层数据错误时也编结论

评估过三个方案：

| 方案 | 结论 |
|---|---|
| A. 只改提示词加代码检查 | 拒绝。最快但不解根因 |
| B. 统一 Evidence Packet 入口 | **采纳**。行情/指标/新闻/问答/TradingAgents 全部读同一份经校验的证据包，任何数据质量失败都阻断评级 |
| C. 整体接入 OpenBB | 拒绝。依赖过重，仍解决不了拆分校验和幻觉问题 |

落地机制：`EvidencePacketV1`（标的身份、复权行情、公司行动、指标、新闻、来源降级过程、内容哈希）**先于模型运行**发布到 D1，模型失败也不丢失确定性证据；模型产出再过一道确定性 claim validation。

这套门禁很克制地生效了：直到本文写作时 `verified` 报告数仍为 0。最后一轮 5 标的重验里全部 Packet 通过预检，但 5 份 Agent 文本全部因未引用数字、无约束仓位建议被打回。**团队没有为了"出评级"而放松门禁**——接手者也不要。

### 2.2 多 profile 隔离

不是一开始就规划的，是被证据链危机顺带逼出来的：根因文档提出要为 GOOGL / 3887.HK 建一个独立的"全球科技与数字资产"研究目标，不能硬塞进 ETF 主题。系统第一次真正需要两个以上并存的研究目标。

2026-07-25 的只读审计发现当时的"隔离"只是前端幻觉——前端已经在传 `profile` 参数，但 `/api/analyze`、`history`/`latest`/`runs`/`report`、Chat session 大多在后端被忽略；`_chat_repository.mjs` 的 UPSERT 甚至会把已有 session 的 profile 悄悄改写；D1 里 evidence packet 只按 symbol 查询，两个 profile 共享同一 ticker 时会串包。

### 2.3 run identity 是四类身份，不是四个字段

系统只接受四种 scope/kind **组合**（`legacy/legacy`、`profile/manual`、`profile/monitor`、`adhoc/adhoc`），不是一个固定四字段的元组。手工分析、Monitor 定时分析、临时研究三类运行如果不显式打身份标签，历史记录、Manifest、Evidence、Chat 上下文会互相串组，同一 ticker 被不同 profile 监控时尤其明显。

### 2.4 PushPlus 只做 shadow

2026-07-25 审计发现现有"提醒"是假的：唯一真实的 PushPlus 发送发生在 GitHub Actions 每日 Python 分析结束后；Monitor Worker 生成盘中事件后不发送、不记录投递、完全不消费 alerts 配置。

刚经历过 515880 假信号，团队不愿意在数据可信度和投递逻辑都未验证前就往用户手机推真实消息。分阶段策略：先建 `notification_deliveries` 投递账本（migration 0015），事件插入时原子创建 web / PushPlus 两行 shadow 记录但不真调 API；对账后再对单个 profile 开 canary。

**开启 live 需要用户另行明确授权，不在默认授权范围内。排障时也不要私自打开。**

### 2.5 明确拒绝的方案

完整清单见 [etf-monitoring-reference-and-decisions.md](etf-monitoring-reference-and-decisions.md) §9。摘要：

| 方案 | 拒绝原因 |
|---|---|
| 整体合并 Vibe-Trading | 会制造两套调度、会话、权限、部署 |
| 把整个 OpenBB 装进 Worker | 依赖、许可和 key 面过大 |
| 每 5 分钟跑 Qlib 或完整 Agent | 时长、费用和噪音不合理 |
| 情绪分数直接给交易结论 | 缺少可验证因果和反证 |
| 聚合新闻当原始公告 | 发布主体和版本不可控 |
| 无来源时展示 iNAV / 溢折价 / Greeks | 制造虚假精确值 |
| 旧缓存标成"实时" | 破坏数据可信度 |
| 接入券商自动交易 | 超出研究工具风险边界 |

接手者不要为了"更完整"重新引入这些。Vibe-Trading 只落地了 Research Goal、证据账本、run card、来源降级、MCP 只读边界这几点思想；Qlib 的 IC/ICIR/回测留给 GitHub Actions 离线扩展，不进 5 分钟 Worker。

## 3. 踩过的坑

- **期权指标从一开始就算错**：DEX 少算 100 倍、到期合约仍参与计算、VaR 与波动率重复放大。不是展示问题，是计算本身有偏差。
- **UI 大改把老功能改没了**：期权监控工作区和完整 TradingAgents 工作流在重设计中被隐藏，用户靠截图投诉才发现，需要专门的三阶段恢复计划。
- **两轮"严格重验"都失败**：run `30150410693` 模型文本没保留 Evidence ID；run `30150722479` 补齐五年美股数据后，ORCL 真实的 2025-09-10 财报跳空被通用的 25% 涨跌幅规则误判为拆分异常。修复方式是分流——ETF 无公司行动的大跳变维持硬拦截，个股真实极端跳空降级为 `EXTREME_PRICE_MOVE` 软警告。
- **报告发布路径本身有 bug**：版本目录不支持 `-v2`/`-v3` 后缀，同日重跑发布返回 400。后来才加上版本路径 + Manifest 日期与 Packet `asOf` 交叉校验。
- **门禁建完了报告还是全灭**：证明"数据层能用"和"模型输出能过审"是两件独立的事，要分别攻克。
- **"绿色 workflow ≠ 已上线"反复发生**：外部审核直接点名交接文档警告过这件事却没有配套验证手段，才有了 Worker `/health` 回读 commit SHA。**这个坑在 2026-07-26 又踩了一次**，见 NEXT_AGENT_HANDOFF.md 的核查章节。
- **复权口径不统一**：临时标的走 yfinance `auto_adjust`（后复权），profile 监控标的走 D1 `qfq`（前复权）。选择在报告 Evidence Snapshot 里如实标注差异，而不是仓促统一。

## 4. 用户明确的红线

以下每条都有原始会话出处，不是推测。

1. **分支名、仓库名不能带 `codex/` 字样。**
2. **TradingAgents 与 VolGuard（上证 50 期权信号）绝不能合并**成一个仓库或运行时。这条从 2026-07-15 就定了，07-23 重新评审后再次否决完全合并方案。
3. **不要弄丢已有的期权监控和 TradingAgents 基本功能**——固化为交接文档 §2 的七条产品边界。
4. **UI 不能有明显 AI 味**，点名"左侧彩色卡片"是典型 Codex 风格；要接近互联网大厂产品设计水准。
5. **前端阅读报告要维持原来的分栏布局。**
6. **只做研究、回测、提醒，不连接券商、不执行真实交易。**
7. **Cloudflare 免费额度可以用足，但不适合的任务不要强行迁移过去。**
8. **密钥、访问码、GitHub token、Cloudflare token、Cookie、SEC 联系邮箱一律不落地**到仓库、日志、D1、前端。
9. **不 force push**；migration 只能向前累加，代码回退不能删表删列。
10. **commit message 用中文规范，不加 AI 或 Co-Authored-By 署名。**

第 8、10 条与用户的全局工具约束一致，是跨项目的一贯习惯，不是本项目临时起意。

## 5. VolGuard 与主工作台的关系

结论：**两个独立仓库、独立部署，故意保持独立，只在 UI 和运维层轻耦合。**

- VolGuard = `SH_50_Index_Option_Trading_Signals`，本地 `G:\ClaudeCode\SH_50_Index_Option_Trading_Signals`，非 fork，最早 GitHub 活动 2026-02-28——**比本项目诞生早四个多月**。
- 部署目标是它自己的 `sh50-volguard.pages.dev` + Streamlit Cloud。推送客户端 `push_client.py` 是它的原生模块，不是从本项目共享过去的。
- v3 把期权风控视图纳入七个一级入口之一，但延续的是 v2 就建立的 API 代理模式（`/api/volguard` 代理 `sh50-volguard.pages.dev`），属于 UI 层组合展示，**不是代码库合并**。
- 两者唯一共享的是运维资源：同一个 PushPlus 账号。
- 因此不能把 Workbench 的部署状态推断为 VolGuard 的状态，反之亦然。

## 6. 会话与恢复路径

这些文件只用于本机恢复。用 `rg` 搜索目标短语，不要全文打印、提交或上传。**不要从历史中复制 token、访问码、Cookie 或密钥。**

### Codex

| 用途 | 路径 |
|---|---|
| 根会话（v3 主线，07-22 ~ 07-26，22685 行 / 114MB） | `G:\codex-home\sessions\2026\07\22\rollout-2026-07-22T17-59-01-019f8943-9db3-7c52-88de-0cb3773977ba.jsonl` |
| 会话索引 | `G:\codex-home\session_index.jsonl` |
| 前史：确立独立项目、定下不合并红线（07-15） | `G:\codex-home\sessions\2026\07\15\rollout-2026-07-15T12-22-53-019f6403-6b9c-71f2-ba89-81766dbc4516.jsonl` |
| 奠基实施计划原文 | `G:\codex-home\attachments\e8a42e8d-475a-44f8-833c-c44d1ef4e8e5\pasted-text.txt` |
| 515880.SS 根因分析原文 | `G:\codex-home\attachments\a92adedc-0279-4ba4-990d-ef8c469a9264\pasted-text.txt` |

根会话 Task ID：`019f8943-9db3-7c52-88de-0cb3773977ba`

`G:\codex-home\sessions\2026\07\{22,23,24,25,26}\` 下另有约 200 个 rollout 文件，是主会话 spawn 出的子 agent（`profile_domain_api_impl`、`run_identity_audit`、`alerts_operability_audit`、`scheduler_isolation_audit` 等），内容已通过主 jsonl 的记录体现，不需要逐一复核。

会话 `019f98c4-8664-7ea0-a685-5aea1bebc1c6`（07-25）虽然同名，但实为根会话的一次重放式续开，10:27 起被转向完全不相关的课程作业，**与本项目开发无关**。

### Claude Code

| 用途 | 路径 |
|---|---|
| 主线会话（v1→v2 开发 + 后期监理，07-09 ~ 07-26，5.9MB） | `G:\ClaudeCode\_sessions-store\635a569f-582b-4469-8bcc-4f83c8f7bd0a.jsonl` |
| Codex 成果复盘（07-25） | `G:\ClaudeCode\_sessions-store\ab7336b7-be87-40f8-b42b-4c2c4164411d.jsonl` |
| 可读归档索引 | `G:\ClaudeCode\readable\_INDEX.md` |
| 原始 jsonl 冻结备份 | `G:\ClaudeCode\archive\` |

两条已知的陈旧信息，接手者不要被误导：

- `G:\ClaudeCode\_sessions-store\memory\project_tradingagents_deploy.md` 的内容**冻结在 2026-07-12（v2 阶段）**，完全没反映 v3 重构和改名。
- `G:\ClaudeCode\SESSIONS_AND_RECOVERY_MAP.md` 和 `G:\ClaudeCode\项目恢复提示词.md` 更新时间早于本项目诞生，**没有收录本项目**；前者记录的 memory 路径也与实际不符。

## 7. 运维遗留事项

- **`GITHUB_DISPATCH_TOKEN` 是 fine-grained PAT，命名 `trading_agent`，2026-10-10 到期。** 权限范围：仅本仓库、仅 Actions 读写。到期前需要续期，否则 Worker 的 GitHub dispatch 会全线失败。
- 项目历史上有过两次权限边界事件，形成了沿用至今的做法：不翻其它项目的凭据文件复用 key（无 key 时优雅降级为 unconfigured 状态页）；不把宽权限的 `gh auth token` 写进第三方 secret store，改用细粒度 PAT。
- 上游 fork 自带的 CI（pytest）曾因每次 push 刷红叉被用户授权禁用。当前 `ci.yml` 是本项目自己的，与那次禁用无关。
