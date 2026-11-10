# plugins 场景说明（case.md）

- **层级目录**：`tests/specs/plugins/`（29 个用例文件，111 条断言）
- **执行真相**：[suite.yaml](suite.yaml)（runner 只读它；本文件给人看）
- **规范**：[../../README.md](../../README.md)

## 1. 这一层管什么

单个插件的行为契约：清单与 `setup`、频道发送与卡片渲染、源事件归一、场景决策、执行器启动与投递、能力读写。

## 2. 不管什么

- 内核不变式（→ `../kernel/`）
- 多插件编排与整链（→ `../flow/`）
- CLI 二进制与会话文件细节（→ `../plugin-kit/`）

## 3. 判据来源

- [`docs/design/plugin-contract.md`](../../../docs/design/plugin-contract.md)
- [`docs/platform/contracts.md`](../../../docs/platform/contracts.md)（命令与载荷实测）

## 4. 用例清单

> 首个标题取该用例文件里第一条 `test(...)` 的原文，保证与代码一致；断言数即该文件的 `test(...)` 条数。

| 场景 ID | 层级 | 优先级 | 用例文件 | 断言数 | 首条断言 |
| --- | --- | --- | --- | --- | --- |
| `PLUG-UNIT-001` | unit | P1 | `analysis-retry.test.ts` | 1 | 分析降级后补扫重试：attempt=1 degraded，attempt=2 ok |
| `PLUG-UNIT-002` | unit | P1 | `analysis.test.ts` | 7 | AI 摘要任务包含同会话历史与当前消息 |
| `PLUG-INT-003` | integration | P1 | `channel-dingtalk.test.ts` | 2 | 钉钉渠道：双 consume 只开一个也能入站，事件进 events + event_log |
| `PLUG-UNIT-004` | unit | P1 | `channel-dryrun.test.ts` | 2 | 预演：发文本只记命令行，不真调 CLI |
| `PLUG-UNIT-005` | unit | P1 | `dingtalk-relay.test.ts` | 8 | 钉钉飞书中转卡：正文带来源、发送人、会话和消息内容 |
| `PLUG-UNIT-006` | unit | P1 | `dingtalk-sent.test.ts` | 1 | 钉钉出站来源：历史里只保留 senderId=self，映射成 dm 事件 |
| `PLUG-UNIT-007` | unit | P1 | `distribution-backfill.test.ts` | 1 | backfill 分析不触发任何分发出口 |
| `PLUG-UNIT-008` | unit | P1 | `distribution.test.ts` | 3 | 分发决策：先匹配高优先级规则，返回多出口 |
| `PLUG-UNIT-009` | unit | P1 | `doc-feishu.test.ts` | 10 | doc-feishu：清单 id/role 与默认参数模板（strict 拒未知键） |
| `PLUG-UNIT-010` | unit | P1 | `doc-output.test.ts` | 2 | 文档出口：doc target 命中时按快照 revision 提交 doc.write |
| `PLUG-UNIT-011` | unit | P1 | `dsh-gate.test.ts` | 2 | dsh 执行器：同工作区 60 秒内只起一个任务，第二个请求给明确失败原因 |
| `PLUG-UNIT-012` | unit | P1 | `executor-dsh-post.test.ts` | 7 | start：句柄用首行 session 的真实 id，Work id 在 dsh 这边不存在 |
| `PLUG-UNIT-013` | unit | P1 | `feishu-webhook.test.ts` | 2 | 飞书 webhook：notice 卡转为 interactive 卡，保留标题/时间/正文 |
| `PLUG-INT-014` | integration | P1 | `question-card.test.ts` | 5 | 题卡：多选时把勾选态画在按钮上（☑ / ☐） |
| `PLUG-INT-015` | integration | P1 | `scenario-console-attach.test.ts` | 1 | #接入：终端里自己开的 dsh 会话也能列出来，并标明忙闲 |
| `PLUG-INT-016` | integration | P1 | `scenario-console-open.test.ts` | 5 | 开窗向导：未绑定的普通消息先问执行器 |
| `PLUG-UNIT-017` | unit | P1 | `scenario-console-resume.test.ts` | 4 | #resume：列出未在跑的历史会话，卡片带 sid/rebind |
| `PLUG-INT-018` | integration | P1 | `scenario-console-sources.test.ts` | 5 | 来源白名单：钉钉群的普通消息不进开窗向导，一张卡都不发 |
| `PLUG-INT-019` | integration | P1 | `scenario-console.test.ts` | 9 | 控制台只读片：#status 命中已绑定会话，回一行状态 |
| `PLUG-INT-020` | integration | P1 | `scenario-digest.test.ts` | 2 | summarize：按 kind 计数、空窗有兜底、顺序稳定 |
| `PLUG-INT-021` | integration | P1 | `scenario-dispatch.test.ts` | 4 | 派工出口：distribution dispatch → task.open → 会话 → 一轮结束回执 |
| `PLUG-UNIT-022` | unit | P1 | `scenario-doc-todos.test.ts` | 2 | #待办：读快照并列出待办 |
| `PLUG-INT-023` | integration | P1 | `scenario-feishu.test.ts` | 2 | 飞书待办能力：解析、认领冲突、拆分 |
| `PLUG-INT-024` | integration | P1 | `scenario-focus-dm.test.ts` | 13 | 重点私聊：窗口等你回答 → 私聊一张卡，不发到群里 |
| `PLUG-UNIT-025` | unit | P1 | `scenario-session-post.test.ts` | 4 | 话题投递：按 thread 找到活会话就 session.post |
| `PLUG-INT-026` | integration | P1 | `scenario-stop.test.ts` | 1 | 控制台写库片：#stop 提交 session.stop 并停会话 |
| `PLUG-UNIT-027` | unit | P1 | `session-result.test.ts` | 2 | 回执正文：保留换行与列表，只做长度保护 |
| `PLUG-UNIT-028` | unit | P1 | `source-card-v2.test.ts` | 2 | 卡片事件源 v2：归一后发 card.action，带稳定 id 与 subject |
| `PLUG-UNIT-029` | unit | P1 | `terminal-launcher.test.ts` | 2 | terminal：cscript 参数带 sessionId/cwd，等到 SessionStart 注… |

## 5. 夹具与清理

外部 CLI 一律用注入端口或假可执行文件；临时目录自清。

## 6. 单跑

```bash
node tests/scripts/run-suite.mjs --case=PLUG-UNIT-001   # 一条，产物落 tests/out/<runId>/
node tests/scripts/run-suite.mjs --suite=plugins                  # 本域全部
```
