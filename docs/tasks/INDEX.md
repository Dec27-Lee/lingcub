# 任务索引

- **文档角色**：研发任务台账、AI 的当前知识
- **读取时机**：开始任何新增、修复、排查、设计、实现、测试或续接任务时，在读代码之前
- **更新条件**：新增任务、复用已有任务、任务状态／范围变化，或任务文档新增、移动、重命名时
- **事实来源**：用户确认的任务范围、当前任务文档、代码与自测、Git 历史、`CHANGELOG.md`

> 维护规则、任务 ID 分配、目录命名和文档头部模板见 [`README.md`](README.md)。
> 定位**某个**历史任务优先按任务 ID、任务名或关键词检索 `YYYYMM/` 下的文档与小节；
> 需要看**完整清单**或状态总览时才用本表。命中已有任务时续接原任务 ID，不重复创建。

## 1. 当前任务清单

> 排序：按任务 ID 的创建日期倒序（最近任务在前）；同日保留录入顺序。
> 新增、补录与续接规则见 [任务文档维护](README.md#4-索引维护)。
> 状态只写任务自身的研发阶段，不写 Git 提交／推送状态。

| 任务 ID | 任务 | 涉及模块 | 当前状态 | 相关文档 | 任务概述 |
| --- | --- | --- | --- | --- | --- |
| 20261106-dec27lee-97G2E83Z | 飞书多窗口控制台 | `src/plugins/`<br>`src/plugin-kit/`<br>`src/kernel/` | 已完成 | [文档](202611/20261106-dec27lee-97G2E83Z-飞书多窗口控制台.md) | 把「一话题=一窗口」扩到 claude+dsh：飞书选执行器/工作区拉起、本机窗口同步与状态卡、置顶由活跃度对账、私聊只发重点；按 002 分层，禁止场景直调 CLI。 |
| 20261106-dec27lee-BTGVY6XF | 媒体提示清洗 | `src/plugin-kit/`<br>`src/plugins/capability-ai/`<br>`src/plugins/scenario-dingtalk-feishu-relay/` | 已完成 | [文档](202611/20261106-dec27lee-BTGVY6XF-媒体提示清洗.md) | DWS 给媒体消息追加的“注意：如需下载使用dws chat message download-media命令下载”不再漏到飞书卡片和 AI 提示词；图片照发，Event 原文不动。 |
| 20261106-dec27lee-HHD9A63J | 钉钉到飞书延迟分析 | `src/plugins/scenario-analysis/`<br>`src/plugins/source-dingtalk-sent/`<br>`src/plugins/scenario-dingtalk-feishu-relay/` | 已调整轮询 | [文档](202611/20261106-dec27lee-HHD9A63J-钉钉到飞书延迟分析.md) | 实测轮询 2.5–16s、历史 0.8–3s、AI 摘要 10.7–22.7s、relay 2–3s；已把自发送轮询从 15s 降到 10s，卡片语义未改。 |
| 20261106-dec27lee-T4EE8F8P | 自己消息显示 | `src/plugin-kit/`<br>`src/plugins/scenario-dingtalk-feishu-relay/`<br>`src/desktop/` | 已完成 | [文档](202611/20261106-dec27lee-T4EE8F8P-自己消息显示.md) | 自己发出的钉钉消息在飞书卡和桌面里显示“我”，别人的消息保留姓名；按 source-dingtalk-sent 判定，原文与回放不动。486 测试绿。 |
| 20261106-dec27lee-PPEPRYLN | 钉钉日报展示 | `src/plugins/scenario-dingtalk-feishu-relay/`<br>`src/plugin-kit/`<br>`docs/` | 已完成 | [文档](202611/20261106-dec27lee-PPEPRYLN-钉钉日报展示.md) | 飞书卡片日报已按展示层清理深链/landray/alidocs 与尾部噪声，只保留标题、日期、任务、进度、说明；Event 原文不动，486 测试绿。 |
| 20261105-dec27lee-A56T3BP3 | 桌面端插件插槽 | `src/desktop/`<br>`src/domain/`<br>`src/plugins/`<br>`docs/` | 第一版完成 | [文档](202611/20261105-dec27lee-A56T3BP3-桌面端插件插槽.md) | 桌面工作台第一版：侧栏/概览/消息/会话/插件/配置、详情抽屉、命令面板、消息筛选、三档响应式；插件 ui.json 贡献 nav/slot 与只读 API 桥；483 测试绿，待用户调视觉与交互。 |
| 20261105-dec27lee-66EXCJ4M | 消息中间层目标与实施 | `src/domain/`<br>`src/kernel/`<br>`src/plugins/`<br>`config/`<br>`docs/` | 进行中 | [文档](202611/20261105-dec27lee-66EXCJ4M-消息中间层目标与实施.md) | 中间层目标：历史/分析 → message.analyzed → distribution.decided → 出口。已加 state.history.fetch、补扫、structured 理解与 feishu-card 路由；待做任务/执行器出口、legacy 迁移与观测。 |
| 20261104-dec27lee-EPEN75RK | 项目更名Lingcub | `config/`<br>`data/`<br>`scripts/`<br>`package.json` | 已完成 | [文档](202611/20261104-dec27lee-EPEN75RK-项目更名Lingcub.md) | 英文名 Mayday→Lingcub（中文名不变），53 文件 311 处替换 + 9 个文件改名，仓库名、包名、git remote、两处钩子路径全部对齐，历史数据原样保留。251 测试全绿、两项巡检通过、常驻无窗口跑通。 |
| 20261104-dec27lee-PR74GC7W | 历史变更归档 | `CHANGELOG.md`<br>`docs/tasks/` | 已完成 | [文档](202611/20261104-dec27lee-PR74GC7W-历史变更归档.md) | 仓库零提交期间 CHANGELOG 累计的 52 条未发布「版本」（`0.1.0`–`0.1.50`）原样移出留档；CHANGELOG 改为发布记录语义，从一条真实的 `0.1.0` 重新开始。 |
| 20261104-dec27lee-9MNASZF5 | 工作站架构与插件能力事件层 | `src/kernel/`<br>`src/domain/`<br>`src/plugins/`<br>`docs/` | 进行中 | [文档](202611/20261104-dec27lee-9MNASZF5-工作站架构与插件能力事件层.md) | 现状：场景写内核、插件只有四阶段端口。定稿：事件史单一、副作用提交+收据、清单 v2。P1/P2/P3/P4 完成；P2.6 开窗事件化第一轮；生产 bus；插件安装/开关/hot；Feishu stdin 修复（444 绿）。 |
| 20261103-dec27lee-WKD7Q23T | 内核store与发件箱 | `src/kernel/store.ts`<br>`src/kernel/outbox.ts`<br>`src/routing/` | 已完成 | [文档](202611/20261103-dec27lee-WKD7Q23T-内核store与发件箱.md) | 四表落库（`events` 幂等、`outbox` `dedupe_key` 唯一、失败重试到 dead）、规则首个命中即停、Intent→Work 过 `allowRoots` 门禁、三档模式生效。39 测试全绿，四位判据已变异反证。尚未接线，端到端留到 P2 插件批次。 |
| 20261103-dec27lee-DFU8YHCE | 四类插件实现 | `src/plugins/<id>/`<br>`src/kernel/pipeline.ts`<br>`src/kernel/wiring.ts` | 已完成 | [文档](202611/20261103-dec27lee-DFU8YHCE-四类插件实现.md) | 六插件（钉钉/飞书源、分类器、claude/dsh 执行器、飞书频道）+ 主流程全链路；doctor 校验全部插件、假端到端不触网通过，57 测试绿、四条变异反证红。未真连：钉钉字段名、claude logs/stop、dsh session id 待实测。 |
| 20261103-dec27lee-UBBZ4KNT | 回放验证 | `scripts/replay.ts` | 待开始 | [文档](202611/20261103-dec27lee-UBBZ4KNT-回放验证.md) | 读历史 Event 重跑规则与分类，输出可人工标注的表格并统计判断准确率。这是 `observe` 升 `suggest` 的前置门槛：抽检 50 条历史消息、判断准确率 ≥90% 才允许升档；不达标就留在 observe，只记录不动手。 |
| 20261103-dec27lee-HBH6G64F | 桌面窗口与三端 | `src/kernel/runtime.ts`<br>`src/desktop/`<br>`scripts/launch-ui.mjs`<br>`scripts/install-autostart.mjs`<br>`scripts/supervise.mjs` | 进行中 | [文档](202611/20261103-dec27lee-HBH6G64F-桌面窗口与三端.md) | 常驻、面板、配置覆盖层、三端入口、开机自启（Windows 装 `.vbs` 无窗口）已完成；看门狗缺省 `run` 兜住四条启动路径。255 测试绿。待做：presence。 |
| 20261103-dec27lee-86KABK7D | 话题会话与场景对齐 | `src/kernel/`（store·pipeline·hook-server·questions·presence）<br>`src/routing/`<br>`src/plugins/channel-feishu/`<br>`src/desktop/` | 进行中 | [文档](202611/20261103-dec27lee-86KABK7D-话题会话与场景对齐.md) | P3.0–P3.3 落地；与参考项目 32 条能力对齐（30 实现 / 1 不适用 / 1 不做）。离线端到端两条链路全绿，修掉「选择卡按钮缺工作区」「先宣告后落库」两个 bug。 |
