# 数据目录与回测校验实施记录

> 本文是本批变更的逐步记录与回滚入口。唯一项目交接入口仍为
> `docs/NEXT_AGENT_HANDOFF.md`。

## 1. 基线与边界

- 开始时间：2026-08-18（Asia/Singapore）
- 起始提交：`c837528bb7f012eb85e18c03763e29c3f53e32b2`
- 工作树：`G:\worktrees\TradingWorkbench\model-migration-release`
- 基线测试：Functions `436 passed / 1 skipped`；前端 `121 passed`
- 不改：七个一级入口、EvidencePacket、报告 Manifest/哈希、Monitor 调度、VolGuard、既有 D1 表。
- 本批只交付：数据来源目录、股票宇宙覆盖快照、单标的日线回测校验和对应 UI。

## 2. 已确认口径

- 外部参考站点显示的 `1092` 只股票、`957,684` 行和 `103` 个因子来自其内部
  `stock_signal_features` 表，不是 TradingWorkbench 数据，也不代表 A 股全市场。
- 免费公开源不能同时保证全量、稳定、低延迟和长期可复现。本批必须显示来源、覆盖、
  时效和局限，不把 best-effort 数据写成授权全市场数据。
- 第一版回测是面向现有 A 股 ETF 日线的有限校验工具，不是全市场选股或实盘成交模拟。

## 3. 分步实施与回滚

| 步骤 | 状态 | 变更 | 验证 | 回滚 |
|---|---|---|---|---|
| 0 | 已完成 | 同步 `origin/main`，记录基线 | Functions/前端基线通过 | 回到起始提交 |
| 1 | 已完成 | 数据目录、宇宙快照及只读 API | API 契约测试通过；全量首刷待 workflow | 删除新增静态文件/API/工作流 |
| 2 | 已完成 | 有时点约束的单标的回测 | 信号/成交日、周末、成本、缺失测试通过 | 删除回测模块/API |
| 3 | 已完成 | Agent 研究页内二级 UI | 1440×1000、390×844 浏览器均无横向溢出和页面错误；表单可实际提交并渲染结果 | 删除二级区块和事件绑定 |
| 4 | 进行中 | 文档、部署和生产冒烟 | 本地必要回归已完成；CI、Pages API 和全量宇宙首刷待验证 | 关闭 UI 接入或回滚本批提交 |

## 4. 数据与回测纪律

- 宇宙快照只描述当前可取得的上市标的；历史退市成员不可用时明确写 `unavailable`。
- 交易日使用来源业务日期；周末数据、非法 OHLCV、重复代码和空名称不得进入快照。
- 回测只使用信号日收盘前可见数据，最早在下一交易日开盘成交。
- 回测结果必须返回数据来源、复权口径、样本区间、交易成本和未建模限制。
- 缺数据、非 qfq A 股日线或样本不足时 fail closed，不输出收益结论。

## 5. 发布前验证

- Functions：`443 passed / 1 skipped / 0 failed`（东财兼容调整后）。
- 前端：`122 passed / 0 failed`。
- `npm run check:workbench` 与 `npm run check:asset-version` 通过，资产版本为
  `8e75c71538c9`。
- 浏览器在 1440×1000 与 390×844 两种视口均无横向溢出、无 `pageerror`；模拟生产
  响应下回测表单真实提交并显示收益、基准、回撤、胜率、交易数、样本数和限制。
- 发布前审阅补正：显式 `0 bp` 成本不再被替换成默认值；宇宙筛选的 `totalMatched`
  反映截断前数量；宇宙机器人提交后显式触发 `deploy-workbench.yml`，不依赖 GitHub
  token push 的级联事件。
- 本批没有修改 Python、Worker 或 D1 migration，因此未额外运行 Python 全量矩阵；
  由既有 CI 执行仓库完整质量门禁。

## 6. 首轮股票宇宙刷新记录

- workflow `32046914735`、`32047201467` 均在第一页返回 `eastmoney universe HTTP 502`。
- 两次失败都发生在写文件前，`public/data/universe.json` 继续保留 13 个核心标的的
  `degraded` 快照，没有产生空覆盖或错误上线。
- 对照公开的 AKShare 东财 A 股现货请求后，更新脚本改用 `82.push2.eastmoney.com`、
  `np=2`、`ut` 和每页 100 条，并保留原 `push2` 域名及一轮有界重试。最终成功 run、
  覆盖数和 Pages SHA 待复跑后回填。
