# domain 场景说明（case.md）

- **层级目录**：`tests/specs/domain/`（5 个用例文件，24 条断言）
- **执行真相**：[suite.yaml](suite.yaml)（runner 只读它；本文件给人看）
- **规范**：[../../README.md](../../README.md)

## 1. 这一层管什么

四层模型与纯规则：文档 XML 解析/渲染、待办抽取与合并、文档写入计划与指纹、卡片动作映射、ID 生成、工作站快照。

## 2. 不管什么

- 内核状态机与并发（→ `../kernel/`）
- 插件的端口装配与决策（→ `../plugins/`）
- 路由判定（→ `../routing/`）

## 3. 判据来源

- [`docs/design/domain-model.md`](../../../docs/design/domain-model.md)（Event / Intent / Action / Work 与不变式）
- [`docs/design/plugin-contract.md`](../../../docs/design/plugin-contract.md)（端口契约）

## 4. 用例清单

> 首个标题取该用例文件里第一条 `test(...)` 的原文，保证与代码一致；断言数即该文件的 `test(...)` 条数。

| 场景 ID | 层级 | 优先级 | 用例文件 | 断言数 | 首条断言 |
| --- | --- | --- | --- | --- | --- |
| `DOMAIN-UNIT-001` | unit | P1 | `card-action.test.ts` | 3 | 卡片回调归一：解析按钮值、保留原始字符串 |
| `DOMAIN-UNIT-002` | unit | P1 | `doc-todos.test.ts` | 4 | 文档待办：解析与渲染往返 |
| `DOMAIN-UNIT-003` | unit | P1 | `doc-write.test.ts` | 3 | doc-write：取小节正文，不跨到下一个标题 |
| `DOMAIN-UNIT-004` | unit | P1 | `doc-xml.test.ts` | 13 | doc-xml：按标签开闭扫描，记录带 id 的块与父子关系 |
| `DOMAIN-UNIT-005` | unit | P1 | `workstation.test.ts` | 1 | 工作站快照：会话/工作/发件箱按状态计数 |

## 5. 夹具与清理

纯函数与临时字符串，不写真实业务文件；无需清理。

## 6. 单跑

```bash
node tests/scripts/run-suite.mjs --case=DOMAIN-UNIT-001   # 一条，产物落 tests/out/<runId>/
node tests/scripts/run-suite.mjs --suite=domain                  # 本域全部
```
