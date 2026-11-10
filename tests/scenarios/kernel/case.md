# kernel 场景说明（case.md）

- **层级目录**：`tests/specs/kernel/`（40 个用例文件，279 条断言）
- **执行真相**：[suite.yaml](suite.yaml)（runner 只读它；本文件给人看）
- **规范**：[../../README.md](../../README.md)

## 1. 这一层管什么

内核不变式：事件史幂等、发件箱「先标记后投递」、能力收据与审计、插件清单 v2 装配与拓扑、配置分层、闸门策略、状态卡与置顶对账、会话生命周期、转录解析、额度与清理、迁移。

## 2. 不管什么

- 单个插件的内部行为（→ `../plugins/`）
- CLI 探测与载荷清洗（→ `../plugin-kit/`）
- 桌面 HTTP 服务（→ `../desktop/`）
- 跨域整链装配（→ `../flow/`）

## 3. 判据来源

- [`docs/design/principles.md`](../../../docs/design/principles.md)（五条不可违反）
- [`docs/design/plugin-contract.md`](../../../docs/design/plugin-contract.md)
- [`docs/design/domain-model.md`](../../../docs/design/domain-model.md)
- [`docs/runtime/sessions-and-windows.md`](../../../docs/runtime/sessions-and-windows.md)

## 4. 用例清单

> 首个标题取该用例文件里第一条 `test(...)` 的原文，保证与代码一致；断言数即该文件的 `test(...)` 条数。

| 场景 ID | 层级 | 优先级 | 用例文件 | 断言数 | 首条断言 |
| --- | --- | --- | --- | --- | --- |
| `KERNEL-INT-001` | integration | P0 | `capabilities.test.ts` | 6 | 效果由能力名家族决定：副作用不能声明成 none，插件不能用内核前缀 |
| `KERNEL-INT-002` | integration | P1 | `capability-effects.test.ts` | 1 | 九分支能力化：提交后的 Action 与旧 createDeliver 分支一一对应 |
| `KERNEL-INT-003` | integration | P1 | `cards.test.ts` | 21 | 状态卡：第一次是建卡，记下 message_id |
| `KERNEL-INT-004` | integration | P1 | `cleanup.test.ts` | 7 | 图片清理：按天/按会话的目录过期就整目录删，没过期的一个不动 |
| `KERNEL-UNIT-005` | unit | P1 | `config-console-keys.test.ts` | 3 | 配置页：控制台开窗与重点私聊的键都能在页面上改 |
| `KERNEL-UNIT-006` | unit | P1 | `config-overlay.test.ts` | 6 | 深合并：对象递归，数组整体替换 |
| `KERNEL-UNIT-007` | unit | P1 | `config-schema.test.ts` | 4 | 配置页字段：从配置本身推出来，不用改代码就能出现新键 |
| `KERNEL-UNIT-008` | unit | P1 | `config.test.ts` | 5 | allowRoots 命中：子目录通过 |
| `KERNEL-UNIT-009` | unit | P1 | `envelope.test.ts` | 3 | 信封：短、稳定、写清「这是用户本人打的」 |
| `KERNEL-INT-010` | integration | P0 | `event-log.test.ts` | 12 | 消息事件与事件史同事务写入，重复投递不追加 |
| `KERNEL-UNIT-011` | unit | P1 | `hook-events.test.ts` | 2 | 选择题事件：kind/自然键/题目都带上 |
| `KERNEL-E2E-012` | e2e | P1 | `hooks.test.ts` | 18 | 钩子端点：无令牌 403，有令牌才回调 |
| `KERNEL-INT-013` | integration | P1 | `hot-capability.test.ts` | 3 | hot 能力：启用即注册，停用即注销 |
| `KERNEL-UNIT-014` | unit | P1 | `ids.test.ts` | 5 | eventId 对同一输入稳定（幂等的基础） |
| `KERNEL-UNIT-015` | unit | P1 | `images.test.ts` | 5 | 纯图消息的 JSON 正文转成统一标记 |
| `KERNEL-INT-016` | integration | P1 | `kernel-capabilities.test.ts` | 15 | judge.classify：规则优先，命中即返回 Intent |
| `KERNEL-INT-017` | integration | P1 | `lifecycle-primitives.test.ts` | 3 | remove：注销能力后 call 报未知能力，重复 remove 返回 false |
| `KERNEL-UNIT-018` | unit | P1 | `notice-card.test.ts` | 4 | 通知卡：📁/🕐/📦 各占一个元素（挤在一个里会被飞书折成一段） |
| `KERNEL-INT-019` | integration | P0 | `outbox.test.ts` | 4 | 同一 dedupeKey 只投递一次 |
| `KERNEL-INT-020` | integration | P0 | `pipeline.test.ts` | 14 | 假端到端：Event → 假分类器 → 假执行器开工 → 收到回执（不触网） |
| `KERNEL-UNIT-021` | unit | P1 | `plugin-admin.test.ts` | 4 | 重扫安装台账：v1/v2 合并、新装的下一轮就可见（不缓存）、目录不存在返回空 |
| `KERNEL-UNIT-022` | unit | P0 | `plugin-boundaries.test.ts` | 1 | 插件边界：只允许 domain、plugin-kit、自身目录和 npm 包 |
| `KERNEL-UNIT-023` | unit | P1 | `plugin-catalog.test.ts` | 2 | 安装台账：停用/未配置的插件也在列，启用状态独立 |
| `KERNEL-INT-024` | integration | P1 | `plugin-v2.test.ts` | 9 | 清单校验：合法清单通过；id/效果/依赖/未知键逐条报错 |
| `KERNEL-INT-025` | integration | P0 | `policy-receipts.test.ts` | 7 | auto：提交入发件箱，投递成功回填收据并追加 effect.done |
| `KERNEL-UNIT-026` | unit | P1 | `presence.test.ts` | 2 | 在场：3 分钟内算在，超过算走（阈值对齐参考项目 awayIdleSeconds=180） |
| `KERNEL-INT-027` | integration | P1 | `questions.test.ts` | 17 | 作答后：等待循环返回 answered，钩子决策已经是 hookSpecificOutput 形状 |
| `KERNEL-INT-028` | integration | P1 | `session-answer.test.ts` | 1 | session.answer：记录答案并投给执行器 |
| `KERNEL-INT-029` | integration | P1 | `session-close.test.ts` | 1 | session.close：只关窗口，不停执行器 |
| `KERNEL-INT-030` | integration | P1 | `session-open.test.ts` | 6 | session.open：先落请求与事件，执行器 opened 后建会话并发 ready |
| `KERNEL-INT-031` | integration | P1 | `session-ready.test.ts` | 1 | session.ready：场景发 ready 卡，内核不再拼卡片 |
| `KERNEL-INT-032` | integration | P1 | `session-topic.test.ts` | 7 | 话题路由：只记了根消息 om_ 的会话，用根消息也能命中 |
| `KERNEL-INT-033` | integration | P1 | `session.test.ts` | 28 | 会话表：一个话题只绑一个会话 |
| `KERNEL-UNIT-034` | unit | P1 | `source-start.test.ts` | 1 | 来源启动：旧 sources 段与 v2 注册端口都启动，同一插件不重复 |
| `KERNEL-INT-035` | integration | P1 | `status-card.test.ts` | 5 | 状态卡：v2 建出来的会话（workspace 是绝对 cwd）也能出卡并回到话题 |
| `KERNEL-INT-036` | integration | P0 | `store.test.ts` | 18 | 同一条 Event 插两次只有一行（内容派生 id 幂等） |
| `KERNEL-INT-037` | integration | P1 | `task-session.test.ts` | 7 | task.open：落 intent/work → start_session → 会话行与收据闭环 |
| `KERNEL-UNIT-038` | unit | P1 | `transcript.test.ts` | 16 | 反查人话：跳过系统产物与工具回执，取最后一条真正的输入 |
| `KERNEL-UNIT-039` | unit | P1 | `v2-ownership.test.ts` | 2 | 控制权：开关没切到场景档就不装配，避免与旧 Pipeline 双回 |
| `KERNEL-INT-040` | integration | P1 | `workspace-order.test.ts` | 3 | 工作区列表：配置里登记的仓库排第一（别把子目录顶到第一个） |

## 5. 夹具与清理

每条用例自建 `:memory:` 或 `mkdtemp` 库；`hooks.test.ts` 起本地钩子服务并在用例内关闭。

## 6. 单跑

```bash
node tests/scripts/run-suite.mjs --case=KERNEL-INT-001   # 一条，产物落 tests/out/<runId>/
node tests/scripts/run-suite.mjs --suite=kernel                  # 本域全部
```
