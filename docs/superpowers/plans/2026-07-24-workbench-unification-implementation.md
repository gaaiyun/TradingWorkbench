# TradingAgents Workbench Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 恢复 TradingAgents 一等研究流程，把 ETF 监控和 VolGuard 期权风控纳入统一、可操作的专业工作台。

**Architecture:** 保留当前 Cloudflare Pages、D1、定时 Worker 和 GitHub Actions。前端增加稳定 hash 路由和七个工作区；市场监控复用现 ETF 终端，研究与档案复用现有 API，期权工作区组合 VolGuard 快速行情与慢指标。

**Tech Stack:** HTML、CSS、ES modules、Node test runner、TradingView Lightweight Charts、Cloudflare Pages Functions、D1、Workers、GitHub Actions、Python pytest。

---

## 文件结构

- `public/index.html`：共享产品壳与七个工作区的语义结构。
- `public/assets/workbench.css`：统一设计令牌、布局、控件和响应式规则。
- `public/assets/workbench.js`：页面编排、API 请求和现有市场监控。
- `public/assets/workbench-router.mjs`：纯路由表、路由归一化和 hash 同步。
- `public/assets/workbench-research.mjs`：研究任务、运行和档案的纯数据转换。
- `public/assets/workbench-options.mjs`：VolGuard 快速/慢速数据的归一化和状态合并。
- `public/assets/workbench-data.mjs`：行情范围、现有指标和通用数据函数。
- `functions/api/market.js`、`functions/api/_dynamic_api.mjs`：五年日线查询。
- `workers/monitor/src/providers/adapters.mjs`：美股多源历史窗口。
- `tests/test_workbench_navigation.mjs`：路由、导航和工作区契约。
- `tests/test_workbench_research.mjs`：任务、运行和档案转换。
- `tests/test_workbench_options.mjs`：期权双时钟和降级契约。
- `tests/e2e_workbench.py`：浏览器真实操作。
- `G:/ClaudeCode/SH_50_Index_Option_Trading_Signals/functions/_lib/live.mjs`：Edge 期权计算。
- `G:/ClaudeCode/SH_50_Index_Option_Trading_Signals/tests/js/live.test.mjs`：Edge 指标测试。
- `G:/ClaudeCode/SH_50_Index_Option_Trading_Signals/test_enhanced.py`：修复 pytest 收集错误。
- `README.md`、`DEPLOY_CN.md`、`docs/etf-monitoring-reference-and-decisions.md`：产品、参考项目、部署和验证记录。

### Task 1: 建立路由与一级入口回归保护

**Files:**
- Create: `public/assets/workbench-router.mjs`
- Create: `tests/test_workbench_navigation.mjs`
- Modify: `package.json`

- [ ] **Step 1: 写失败测试**

测试必须断言七条稳定路由、未知路由回退 `monitor`、每条路由都对应 `href`，并检查 `public/index.html` 包含七个 `data-workspace` 区域。

```js
test("every primary route has a visible navigation target and workspace", () => {
  for (const route of PRIMARY_ROUTES) {
    assert.match(html, new RegExp(`href="#${route.id}"`));
    assert.match(html, new RegExp(`data-workspace="${route.id}"`));
  }
});
```

- [ ] **Step 2: 验证测试因缺少模块和工作区而失败**

Run: `node --test tests/test_workbench_navigation.mjs`

Expected: FAIL，缺少 `workbench-router.mjs` 或七个工作区。

- [ ] **Step 3: 实现纯路由模块**

导出 `PRIMARY_ROUTES`、`normalizeRoute(hash)` 和 `routeHref(id)`。路由表固定为 `monitor`、`agents`、`tasks`、`archive`、`news`、`options`、`settings`。

- [ ] **Step 4: 运行单测**

Run: `node --test tests/test_workbench_navigation.mjs`

Expected: 纯路由断言通过；HTML 工作区断言仍失败。

- [ ] **Step 5: 提交**

```text
test(工作台): 锁定一级路由契约
```

### Task 2: 恢复共享产品壳并保留 ETF 监控

**Files:**
- Modify: `public/index.html`
- Modify: `public/assets/workbench.css`
- Modify: `public/assets/workbench.js`
- Test: `tests/test_workbench_navigation.mjs`
- Test: `tests/test_workbench_frontend.mjs`

- [ ] **Step 1: 扩展失败测试**

断言桌面导航使用链接而不是只能点击的无地址按钮，当前工作区设置 `aria-current="page"`，浏览器 hash 变化会切换 `[hidden]`。

- [ ] **Step 2: 运行测试并确认失败原因是缺少产品壳**

Run: `node --test tests/test_workbench_navigation.mjs tests/test_workbench_frontend.mjs`

- [ ] **Step 3: 修改 HTML**

增加固定产品侧栏和移动导航。把当前 `.terminal` 包进：

```html
<section class="workspace-view" data-workspace="monitor" aria-labelledby="monitor-title">
  <!-- 现有 ETF 终端 -->
</section>
```

为其他路由创建带明确标题、加载骨架和恢复动作的工作区。删除顶栏“多智能体分析”和“期权风控”替代入口，保留上下文操作按钮。

- [ ] **Step 4: 修改 CSS**

建立共享的 `--nav-width`、`--topbar-height`、`--control-height` 和状态色。桌面使用侧栏加内容区；市场监控内部保留三列。移动端侧栏折叠为底栏和“更多”面板。

- [ ] **Step 5: 接入路由**

在 `workbench.js` 初始化 `hashchange`，切换工作区 `hidden`、导航 `aria-current` 和页面标题。刷新当前路由时不得重置行情或会话状态。

- [ ] **Step 6: 运行导航与现有前端测试**

Run: `node --test tests/test_workbench_navigation.mjs tests/test_workbench_frontend.mjs`

Expected: PASS。

- [ ] **Step 7: 提交**

```text
feat(工作台): 恢复统一产品导航
```

### Task 3: 恢复 Agent 研究、任务和档案

**Files:**
- Create: `public/assets/workbench-research.mjs`
- Create: `tests/test_workbench_research.mjs`
- Modify: `public/index.html`
- Modify: `public/assets/workbench.js`
- Modify: `public/assets/workbench.css`

- [ ] **Step 1: 写失败测试**

测试 `buildAnalyzePayload` 只提交选择的标的与深度，`normalizeRuns` 保留真实状态，`reportLinkForRun` 只为完成运行生成档案链接。

```js
assert.deepEqual(
  buildAnalyzePayload({ profileId: "cn-semi-comms", symbols: ["515880.ss"], depth: "full" }),
  { profileId: "cn-semi-comms", tickers: ["515880.SS"], depth: "full" },
);
```

- [ ] **Step 2: 运行测试确认模块缺失**

Run: `node --test tests/test_workbench_research.mjs`

- [ ] **Step 3: 实现纯数据模块**

实现 `buildAnalyzePayload`、`normalizeRuns`、`groupHistoryByTicker`、`reportLinkForRun` 和 `runStatusLabel`，拒绝页面自行推测 Agent 内部阶段。

- [ ] **Step 4: 构建三个工作区**

Agent 研究包含标的、深度、研究链路和提交按钮；任务包含状态筛选、下一次运行和失败原因；档案包含索引、报告正文、run card、证据和“作为问答上下文”操作。

- [ ] **Step 5: 接入 API**

使用 `/api/analyze`、`/api/runs`、`/api/history` 和 `/api/report`。提交期间禁用按钮并显示请求状态；成功后跳转 `#tasks`；已完成任务可跳转 `#archive`。

- [ ] **Step 6: 运行单测与 Functions 测试**

Run: `node --test tests/test_workbench_research.mjs tests/test_actions_api.mjs tests/test_legacy_capabilities.mjs`

Expected: PASS。

- [ ] **Step 7: 提交**

```text
feat(研究): 恢复多智能体任务与档案
```

### Task 4: 把新闻和设置恢复为完整工作区

**Files:**
- Modify: `public/index.html`
- Modify: `public/assets/workbench.js`
- Modify: `public/assets/workbench.css`
- Test: `tests/test_workbench_frontend.mjs`
- Test: `tests/e2e_workbench.py`

- [ ] **Step 1: 写失败测试**

断言 `#news` 有标的、主题、来源层级、重要性和时间筛选；`#settings` 能编辑目标角色、分析深度、时区、任务时间、盘中频率、阈值和提醒。

- [ ] **Step 2: 运行测试确认当前抽屉结构不满足工作区契约**

Run: `node --test tests/test_workbench_frontend.mjs`

- [ ] **Step 3: 复用当前数据与表单逻辑**

把右侧新闻流保留在监控页，同时在新闻工作区提供完整筛选与较长列表。把设置抽屉内容迁移到设置工作区；保存仍使用 D1 revision 冲突保护。

- [ ] **Step 4: 运行前端与设置测试**

Run: `node --test tests/test_workbench_frontend.mjs tests/test_workbench_settings.mjs tests/test_d1_settings_api.mjs`

- [ ] **Step 5: 提交**

```text
feat(工作台): 恢复新闻与设置工作区
```

### Task 5: 恢复期权双时钟工作区

**Files:**
- Create: `public/assets/workbench-options.mjs`
- Create: `tests/test_workbench_options.mjs`
- Modify: `public/index.html`
- Modify: `public/assets/workbench.js`
- Modify: `public/assets/workbench.css`

- [ ] **Step 1: 写失败测试**

用 VolGuard fixture 验证快速行情时间、慢指标时间、来源状态、合约筛选和单层失败。快速层失败时必须保留慢指标；慢层失败时必须保留行情和合约。

```js
assert.deepEqual(mergeOptionLayers(liveOnly, null).availability, {
  quote: "ok",
  slow: "unavailable",
});
```

- [ ] **Step 2: 运行测试确认模块缺失**

Run: `node --test tests/test_workbench_options.mjs`

- [ ] **Step 3: 实现归一化模块**

导出 `normalizeLiveOptions`、`normalizeSlowMetrics`、`mergeOptionLayers`、`filterOptionContracts` 和 `optionFreshnessLabel`。

- [ ] **Step 4: 构建期权页面**

页面包含标的、快速/慢速时间、PCR、ATM、Max Pain、HV/IV、BSADF、VaR、GEX/DEX、到期月份、认购/认沽筛选和期权链。独立 VolGuard 链接放在次要操作区。

- [ ] **Step 5: 接入自动刷新**

进入 `#options` 后立即请求 `/api/volguard`，每 30 秒刷新。离开页面后停止定时器。失败时保留最近可信层并更新状态文字。

- [ ] **Step 6: 运行期权与前端测试**

Run: `node --test tests/test_workbench_options.mjs tests/test_volguard_api.mjs tests/test_workbench_frontend.mjs`

- [ ] **Step 7: 提交**

```text
feat(期权): 恢复双时钟风控工作区
```

### Task 6: 补全 VolGuard Edge 指标与测试基线

**Files:**
- Modify: `G:/ClaudeCode/SH_50_Index_Option_Trading_Signals/functions/_lib/live.mjs`
- Modify: `G:/ClaudeCode/SH_50_Index_Option_Trading_Signals/tests/js/live.test.mjs`
- Modify: `G:/ClaudeCode/SH_50_Index_Option_Trading_Signals/test_enhanced.py`
- Modify: `G:/ClaudeCode/SH_50_Index_Option_Trading_Signals/pytest.ini`

- [ ] **Step 1: 写 IV、Greeks、GEX/DEX 和 Skew 的失败测试**

fixture 使用固定 spot、strike、TTE、无风险利率和报价，断言结果有限、单位明确，异常报价返回 `null`。

- [ ] **Step 2: 运行 Node 测试并确认缺少 Edge 指标**

Run: `node --test tests/js/live.test.mjs`

- [ ] **Step 3: 实现确定性 Edge 指标**

复用 Python 项目的到期规则和单位契约。在 `/api/live` 中加入 `derived_metrics`，包含 IV 样本、Greeks、GEX、DEX、PCR、Max Pain、Skew 和流动性覆盖。GARCH、BSADF 与 HV 继续放在 `slow_metrics`。

- [ ] **Step 4: 修复 pytest 收集**

把 `test_enhanced.py` 的手工诊断函数移出 pytest 收集命名，或给诊断入口增加显式调用。添加 `pytest.ini`，只收集 `tests/test_*.py`，避免返回布尔值的脚本伪装成测试。

- [ ] **Step 5: 运行 VolGuard 全量测试**

Run: `node --test tests/js/live.test.mjs`

Run: `python -m pytest -q`

Expected: 两个命令退出码为 0，不出现收集错误和 `PytestReturnNotNoneWarning`。

- [ ] **Step 6: 提交 VolGuard**

```text
feat(期权): 补全实时暴露指标
```

### Task 7: 扩充美股五年日线

**Files:**
- Modify: `functions/api/_dynamic_api.mjs`
- Modify: `workers/monitor/src/providers/adapters.mjs`
- Modify: `public/assets/workbench-data.mjs`
- Modify: `public/assets/workbench.js`
- Modify: `public/index.html`
- Modify: `tests/test_dynamic_api.mjs`
- Modify: `tests/test_provider_adapters_contract.mjs`
- Modify: `tests/test_workbench_frontend.mjs`

- [ ] **Step 1: 写失败测试**

断言 API 接受 1260、封顶 1500；东方财富和腾讯 URL 请求 1250；页面范围映射为 126、252、756、1260；返回结果展示起止日期和数据源。

- [ ] **Step 2: 运行测试确认当前 500/320/240 限制导致失败**

Run: `node --test tests/test_dynamic_api.mjs tests/test_provider_adapters_contract.mjs tests/test_workbench_frontend.mjs`

- [ ] **Step 3: 修改查询与 Provider**

把 `MAX_LIMIT` 改为 1500。Yahoo 保持五年；东方财富 `lmt=1250`；腾讯请求 1250，并继续执行断裂种子过滤。

- [ ] **Step 4: 增加范围选择**

美股日线显示 6 月、1 年、3 年和 5 年。选择区间时请求对应根数，图表标题旁显示 `起始日期 → 结束日期 · N 个交易日 · source`。

- [ ] **Step 5: 运行数据链测试**

Run: `node --test tests/test_dynamic_api.mjs tests/test_provider_adapters_contract.mjs tests/test_provider_registry.mjs tests/test_market_bar_writer.mjs tests/test_workbench_frontend.mjs`

- [ ] **Step 6: 提交**

```text
feat(行情): 补全美股五年日线
```

### Task 8: 浏览器端到端验收

**Files:**
- Modify: `tests/e2e_workbench.py`

- [ ] **Step 1: 写失败场景**

新增七个路由跳转、浏览器前进后退、研究任务提交、完成任务进入档案、期权 30 秒刷新、双时钟、移动端导航和美股五年范围场景。

- [ ] **Step 2: 运行 E2E 并记录失败**

Run: `python tests/e2e_workbench.py`

- [ ] **Step 3: 修复实现暴露的问题**

只修改导致当前失败场景的代码。每次修复后先运行对应场景，再运行完整 E2E。

- [ ] **Step 4: 运行完整 E2E**

Run: `python tests/e2e_workbench.py`

Expected: 所有场景通过。

- [ ] **Step 5: 提交**

```text
test(工作台): 覆盖跨工作区真实操作
```

### Task 9: 重写产品与工程文档

**Files:**
- Modify: `README.md`
- Modify: `DEPLOY_CN.md`
- Modify: `docs/etf-monitoring-reference-and-decisions.md`
- Create: `docs/WORKBENCH_CHANGELOG.md`

- [ ] **Step 1: 写文档检查测试**

在 `tests/test_legacy_capabilities.mjs` 中检查文档列出七个工作区、双时钟、五年日线、两个部署和参考项目。

- [ ] **Step 2: 运行测试确认文档缺项**

Run: `node --test tests/test_legacy_capabilities.mjs`

- [ ] **Step 3: 重写文档**

README 开头说明本 fork 的工作台入口和适用范围。部署文档写清 D1、Worker、Pages、GitHub Actions 和 VolGuard 的关系。参考文档记录 Vibe-Trading、OpenBB、Qlib、FinGPT、AI Hedge Fund、Ashare、adata、awesome-systematic-trading、Lightweight Charts、AKShare、iVIX 和 options_monitor 的借鉴与拒绝项。变更日志列出旧能力、回归原因、本次恢复和验证证据。

- [ ] **Step 4: 使用 stop-slop 检查文字**

删除套话、二元反转、模糊结论、被动语态和不必要的三项排比。

- [ ] **Step 5: 运行文档契约测试**

Run: `node --test tests/test_legacy_capabilities.mjs`

- [ ] **Step 6: 提交**

```text
docs(工作台): 重写架构与恢复记录
```

### Task 10: 全量验证、部署与主分支收敛

**Files:**
- Modify as required by failed verification only.

- [ ] **Step 1: 运行 TradingAgents 全量验证**

Run: `npm run test:functions`

Run: `npm run test:frontend`

Run: `python -m pytest -q`

Run: `python tests/e2e_workbench.py`

Run: `node --check public/assets/workbench.js`

- [ ] **Step 2: 运行 VolGuard 全量验证**

Run in `G:/ClaudeCode/SH_50_Index_Option_Trading_Signals`:

`node --test tests/js/live.test.mjs`

`python -m pytest -q`

- [ ] **Step 3: 安全扫描**

检查仓库没有 API key、Cloudflare token、PushPlus token、访问码和凭据文件。扫描只报告文件位置和键名，不输出秘密值。

- [ ] **Step 4: 推送功能分支并部署**

先推送两个仓库当前提交，再部署 VolGuard，随后部署 TradingAgents Pages 与监控 Worker。检查部署版本对应已推送提交。

- [ ] **Step 5: 生产验收**

验证七个工作区、任务提交、档案、问答、期权双时钟、ORCL 五年日线、A 股与美股颜色规则和移动端导航。若当前网络策略阻止 Pages 浏览器访问，记录限制并使用本地 E2E、Cloudflare 部署状态和用户可见页面复核，不伪造浏览器冒烟结果。

- [ ] **Step 6: 快进 main**

确认 `origin/main` 仍是当前功能分支祖先后，把功能分支快进推送到 `main`。创建恢复 tag 后删除已合并开发分支。VolGuard 只删除已经被 `main` 包含的功能分支。

- [ ] **Step 7: 最终提交记录**

保存测试数量、部署版本、生产时间戳和剩余限制。只有所有验收项都有当前证据时才声明完成。

