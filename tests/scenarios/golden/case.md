# golden 场景说明（case.md）

- **层级目录**：`tests/specs/golden/`（1 个用例文件，1 条断言）
- **执行真相**：[suite.yaml](suite.yaml)（runner 只读它；本文件给人看）
- **规范**：[../../README.md](../../README.md)

## 1. 这一层管什么

44 条固定输入（消息类型 × 判断 × 档位 + 命令）→ `IngestOutcome`、发件箱行、会话、工作项，与 `support/golden/baseline.json` 逐字对拍。

## 2. 不管什么

- 新增行为本身（新增场景要重新生成基线，并在任务文档记录差异）

## 3. 判据来源

- [`docs/tasks/202611/20261104-dec27lee-9MNASZF5-工作站架构与插件能力事件层.md`](../../../docs/tasks/202611/20261104-dec27lee-9MNASZF5-工作站架构与插件能力事件层.md)（金标小节）

## 4. 用例清单

> 首个标题取该用例文件里第一条 `test(...)` 的原文，保证与代码一致；断言数即该文件的 `test(...)` 条数。

| 场景 ID | 层级 | 优先级 | 用例文件 | 断言数 | 首条断言 |
| --- | --- | --- | --- | --- | --- |
| `GOLDEN-INT-001` | integration | P1 | `golden.test.ts` | 1 | 控制台金标：固定输入与基线逐字一致 |

## 5. 夹具与清理

`:memory:` 库逐案独立；基线变更必须同批用 `node --experimental-strip-types tests/support/golden/capture.ts` 重生成。

## 6. 单跑

```bash
node tests/scripts/run-suite.mjs --case=GOLDEN-INT-001   # 一条，产物落 tests/out/<runId>/
node tests/scripts/run-suite.mjs --suite=golden                  # 本域全部
```
