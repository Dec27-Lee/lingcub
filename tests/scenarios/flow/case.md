# flow 场景说明（case.md）

- **层级目录**：`tests/specs/flow/`（10 个用例文件，37 条断言）
- **执行真相**：[suite.yaml](suite.yaml)（runner 只读它；本文件给人看）
- **规范**：[../../README.md](../../README.md)

## 1. 这一层管什么

真内核组件 + 假端口的整链：消息进 → 规则 → 发件箱 → 端口 → 回执；会话开窗、投递、文档写入、待办回执、本地窗口接管、六插件装配。

## 2. 不管什么

- 单组件规则（→ 各域）
- 真实平台调用（一律假端口或假 CLI）

## 3. 判据来源

- [`docs/design/domain-model.md`](../../../docs/design/domain-model.md)（不变式）
- [`docs/runtime/sessions-and-windows.md`](../../../docs/runtime/sessions-and-windows.md)（链路表）

## 4. 用例清单

> 首个标题取该用例文件里第一条 `test(...)` 的原文，保证与代码一致；断言数即该文件的 `test(...)` 条数。

| 场景 ID | 层级 | 优先级 | 用例文件 | 断言数 | 首条断言 |
| --- | --- | --- | --- | --- | --- |
| `FLOW-INT-001` | integration | P1 | `adopt-local-windows.test.ts` | 8 | dsh 活会话会被采纳：executor=dsh、source=source-local-dsh，卡片当… |
| `FLOW-INT-002` | integration | P1 | `bus-entry.test.ts` | 1 | 入口单消费者：bus 模式 Pipeline 只落库，场景派工一次 |
| `FLOW-INT-003` | integration | P1 | `doc-todos-assembly.test.ts` | 1 | 待办场景装配：启用后消息进总线，回执带待办列表 |
| `FLOW-INT-004` | integration | P1 | `doc-write-e2e.test.ts` | 2 | doc.write：内核比对后经 DocPort 只替换小节 |
| `FLOW-INT-005` | integration | P1 | `doc-write-plugin-e2e.test.ts` | 1 | doc.write：能力 → 发件箱 → 插件 block_replace，XML 走 stdin |
| `FLOW-INT-006` | integration | P1 | `e2e-session-open.test.ts` | 1 | 端到端（离线）：发任务 → 选执行器 → 选工作区 → 开窗 → 会话行 → 就绪卡 |
| `FLOW-E2E-007` | e2e | P0 | `e2e.test.ts` | 2 | 端到端：群里说话 → 开窗 → 锚消息 → 状态卡 → 钩子回传 |
| `FLOW-INT-008` | integration | P1 | `plugins.test.ts` | 18 | 飞书事件映射：扁平字段 → Event，毫秒时间戳转 ISO，atMe 留空不猜 |
| `FLOW-INT-009` | integration | P1 | `session-bind-e2e.test.ts` | 2 | session.bind：改绑走发件箱，会话执行器 id 与工作区一起更新 |
| `FLOW-INT-010` | integration | P1 | `session-post-e2e.test.ts` | 1 | session.post：能力 → 发件箱 → 执行器 post，正文带信封 |

## 5. 夹具与清理

`e2e.test.ts` 起假 `lark-cli` / `claude` 可执行文件 + 真实内核；其余在进程内注入假端口。

## 6. 单跑

```bash
node tests/scripts/run-suite.mjs --case=FLOW-INT-001   # 一条，产物落 tests/out/<runId>/
node tests/scripts/run-suite.mjs --suite=flow                  # 本域全部
```
