# TradingWorkbench 可用性闭环实施计划

> 实施方式：每个任务先写红灯测试，再做最小实现，随后由规格审查和代码质量审查复核。任何 P0/P1 未清零则进入下一轮，不以“控件已出现”作为完成。

**目标：** 建立可实际使用的多监控组工作台，并修复由单 profile 假设暴露的行情、任务、问答、报告、提醒和发布一致性问题。

**架构：** 保留 `WorkbenchSettingsV2` 单行 D1 真值，以 profile 级 CAS API 管理小规模配置；浏览器使用唯一 profile 上下文；Monitor Worker 只执行有硬上限的轻量编排；TradingAgents 长任务留在 GitHub Actions。

## Task 1：锁定 profile 领域与原子 API

**Files**

- Modify: `functions/api/_workbench_settings.mjs`
- Modify: `functions/api/settings.js`
- Create: `functions/api/settings/profiles/index.js`
- Create: `functions/api/settings/profiles/[profileId].js`
- Create: `functions/api/settings/profiles/[profileId]/copy.js`
- Modify/Create: `tests/test_workbench_settings.mjs`
- Modify/Create: `tests/test_d1_settings_api.mjs`
- Create: `tests/test_settings_profiles_api.mjs`

- [ ] 写红灯测试：最多 8 组、严格 ID、每组 14 targets、V2 不受 legacy 全局 10 标的反向限制。
- [ ] 写红灯测试：创建、局部修改、复制、启停、删除、最后一组保护、revision 冲突和访问码。
- [ ] 写红灯测试：已有设置完整 PUT 缺 revision 返回 428；D1 不可用时 profile 写失败关闭。
- [ ] 实现共享 profile domain helper 和 D1 CAS 读改写。
- [ ] 保持旧 GET/PUT/legacy POST 兼容；新 API 只接受 header 访问码。
- [ ] 运行 profile/settings 相关 Node 测试并提交。

## Task 2：建立唯一 profile 上下文与网页 CRUD

**Files**

- Create: `public/assets/workbench-profiles.mjs`
- Modify: `public/index.html`
- Modify: `public/assets/workbench.js`
- Modify: `public/assets/workbench.css`
- Create/Modify: `tests/test_workbench_profiles.mjs`
- Modify: `tests/test_workbench_frontend.mjs`
- Modify: `tests/test_workbench_navigation.mjs`
- Modify: `tests/e2e_workbench.py`

- [ ] 写纯函数红灯测试：选择恢复、删除后的回退、停用 profile、标的回退和切换清理计划。
- [ ] 增加顶栏 profile 选择器与设置页新建、复制、启停、删除动作。
- [ ] 把所有 `profiles[0]` 和“首个 enabled”隐式寻址改成 `currentProfile()`。
- [ ] 切换时清理行情、资讯、任务、报告和聊天上下文；不清理期权状态和临时研究表单。
- [ ] 所有 market/news/events/monitor/chat/run 请求携带 profile。
- [ ] 处理 409：展示并执行“重新载入远端配置”。
- [ ] 修复 320px、44px 触控目标、focus-visible 和 drawer modal/focus trap。
- [ ] 跑前端 Node 与 Playwright 双 profile CRUD/E2E 并提交。

## Task 3：贯通任务、手工监控运行、问答和报告身份

**Files**

- Modify: `functions/api/analyze.js`
- Modify: `functions/api/runs.js`
- Modify: `functions/api/monitor-status.js`
- Modify: `functions/api/chat.js`
- Modify: `functions/api/_chat_repository.mjs`
- Modify: `public/assets/workbench-research.mjs`
- Modify: `public/assets/workbench.js`
- Modify: `scripts/run_daily.py`
- Modify: `.github/workflows/daily-analysis.yml`
- Modify: related Node/Python/E2E tests

- [ ] 红灯测试：监控手工运行携带 profileId，临时研究仍不写 settings。
- [ ] 红灯测试：任务状态只返回当前 profile；任务按钮直接执行当前组。
- [ ] 红灯测试：聊天线程不能改绑 profile；切换后旧 report path 不进入新组问答。
- [ ] 红灯测试：报告 Manifest/history 保存 request/profile/slot/scheduled identity，旧无 profile 报告仍可阅读。
- [ ] Actions 监控任务要求 profileId、slotId、scheduledFor、tickers 成组出现；空输入不读取过期的聚合 seed。
- [ ] 运行研究、问答、报告索引与浏览器回归并提交。

## Task 4：修复调度快照、预算、bootstrap 与 dispatch 幂等

**Files**

- Create: new forward-only D1 migration
- Modify: `workers/monitor/src/scheduler.mjs`
- Modify: `workers/monitor/src/slots.mjs`
- Modify: `workers/monitor/src/index.mjs`
- Modify: `workers/monitor/src/github-dispatch.mjs`
- Modify: Worker tests

- [ ] 红灯测试：两个 profile 同槽分别 claim/finish，A 失败重试不改变 B。
- [ ] 红灯测试：slot 固化 revision/targets/hash；修改、停用、删除 profile 后遵循 snapshot/cancel 策略。
- [ ] 红灯测试：`fullAnalysesPerDay=0/1/N` 原子 reserve，跨本地午夜正确。
- [ ] 红灯测试：GitHub 已接收但客户端超时、204 后 D1 finish 失败时不产生第二次研究。
- [ ] 红灯测试：bootstrap 按 profile/symbol/timeframe，新增 profile/target 立即补齐。
- [ ] 实现每 tick task/query/subrequest 上限和 profile 公平轮转；超额留待下次，不在一个 Cron 中无限顺序执行。
- [ ] 记录阶段 wall time 与稳定 error code；不把 wall time 宣称为 CPU time。
- [ ] 运行 Worker 双 profile、失败注入和资源边界测试并提交。

## Task 5：把提醒配置变成真实能力

**Files**

- Create: D1 `notification_deliveries` migration
- Create: `workers/monitor/src/notifications.mjs`
- Modify: `workers/monitor/src/signals.mjs`
- Modify: `workers/monitor/src/index.mjs`
- Modify: `functions/api/monitor-status.js`
- Modify: `public/assets/workbench.js`
- Create/Modify: notification tests

- [ ] 红灯测试：severity 阈值、profile 时区静默、critical 越过静默、web 状态。
- [ ] 红灯测试：PushPlus 缺 secret、成功、HTTP 失败、重试和重复事件幂等。
- [ ] 实现 `eventId + channel` 唯一投递账本，token 不进入日志/D1/响应。
- [ ] 页面显示 sent/deferred/failed 与安全错误原因。
- [ ] 先 shadow 记录，再用单 profile 生产 canary 开启真实推送。
- [ ] 运行通知与监控回归并提交。

## Task 6：完成任务页、新闻页和错误状态

**Files**

- Modify: `public/index.html`
- Modify: `public/assets/workbench-data.mjs`
- Modify: `public/assets/workbench.js`
- Modify: `public/assets/workbench.css`
- Modify: frontend/E2E tests

- [ ] 任务页展示当前 profile、时区、下一次时间、slot、状态、attempt、最近结果与失败原因。
- [ ] 新闻页增加标的、authority/source tier、主题、来源和重要性筛选。
- [ ] “刷新全部”返回逐项结果并显示降级/失败数量。
- [ ] 空列表、接口失败、只读 fallback 和 stale 数据使用不同状态。
- [ ] 完成桌面、390px、320px 和键盘流程验收。

## Task 7：增强官方证据源和 provider contract

**Files**

- Modify: `workers/monitor/src/providers/registry.mjs`
- Modify: `workers/monitor/src/news-collector.mjs`
- Modify: provider/news tests and fixtures
- Modify: data-source documentation

- [ ] 扩展 registry 字段：authority、transport、auth、限额、freshness、usage/redistribution。
- [ ] 使用 SEC Submissions JSON，正确 User-Agent，403 必须记录失败轨迹。
- [ ] 加入 Federal Register、Federal Reserve RSS 和 HKEX 官方 RSS 的有界采集。
- [ ] GDELT 仅作发现层，批量、缓存、429 退避，不进入同步关键路径。
- [ ] 为解析条数、响应体大小、每 tick 来源数设置上限，验证 10ms 免费 CPU 架构边界。
- [ ] 保留 Yahoo/东财/腾讯 best-effort 标签，不宣称官方或授权实时。

## Task 8：重建发布门禁、生产冒烟与文档

**Files**

- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/deploy-workbench.yml`
- Modify: release metadata API/UI
- Rewrite/update: `README.md`
- Update: `docs/architecture-and-data-flows.md`
- Update: `docs/operations-and-deployment.md`
- Update: `docs/NEXT_AGENT_HANDOFF.md`
- Update: reference and regression docs

- [ ] 部署 exact SHA/已验 artifact；完整 CI 未成功不得部署。
- [ ] release 模式缺 Cloudflare 凭据必须失败，不再 green+skipped。
- [ ] 输出并保存 SHA、Pages deployment ID、Worker version、migration list。
- [ ] Functions、frontend、Python、Ruff、Playwright、语法和密钥扫描全量实跑。
- [ ] 生产 CRUD 冒烟使用 disabled 临时 profile，finally 清理并验证 settings revision。
- [ ] 生产双 profile/same-symbol、任务 identity、提醒 shadow、新闻、报告、问答和 VolGuard 冒烟。
- [ ] README 和架构文档写清参考项目、取舍、Cloudflare/Actions 边界、失败语义和回退。
- [ ] 在同一 `NEXT_AGENT_HANDOFF.md` 记录最新 SHA、部署标识、迁移、测试数字、已知限制和本任务对话 ID/可读历史位置。
- [ ] 对照最初需求、旧版本能力、全部用户反馈和最终 diff 执行上下文漂移审计，逐项证明 TradingAgents、临时研究、13 栏报告、问答、期权、新闻、监控与数据源没有被遗漏或错改。
- [ ] 复核 Cloudflare 职责矩阵：不适合免费 Worker 10ms CPU 的 Python、LangGraph、LLM、历史回填和重计算必须留在 GitHub Actions/现有 Python 运行时。
- [ ] 独立最终审查；发现 P0/P1 则回到对应 Task。
- [ ] 全部证明后合入唯一 `main`、推送 GitHub、部署生产并删除已合并开发分支。
