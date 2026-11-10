# routing 场景说明（case.md）

- **层级目录**：`tests/specs/routing/`（4 个用例文件，55 条断言）
- **执行真相**：[suite.yaml](suite.yaml)（runner 只读它；本文件给人看）
- **规范**：[../../README.md](../../README.md)

## 1. 这一层管什么

三级漏斗：规则首命中即停、谓词求值与非法谓词报错、命令解析（`#open` / `#stop` / `#status` / 绝对路径）、自动回复策略与冷却、话题路由。

## 2. 不管什么

- 分类器模型调用（用假分类器在 kernel/flow 里验）
- 执行器启动与投递（→ `../plugins/`）

## 3. 判据来源

- [`docs/design/routing.md`](../../../docs/design/routing.md)（三级漏斗、谓词、三档模式）

## 4. 用例清单

> 首个标题取该用例文件里第一条 `test(...)` 的原文，保证与代码一致；断言数即该文件的 `test(...)` 条数。

| 场景 ID | 层级 | 优先级 | 用例文件 | 断言数 | 首条断言 |
| --- | --- | --- | --- | --- | --- |
| `ROUTING-INT-001` | integration | P1 | `auto-reply.test.ts` | 9 | 自动回复：策略从上往下，先命中的生效 |
| `ROUTING-INT-002` | integration | P1 | `commands.test.ts` | 25 | 命令解析：只认第一行的固定词，其它当普通消息 |
| `ROUTING-UNIT-003` | unit | P0 | `resolve.test.ts` | 9 | 门禁拒绝：工作区不在执行器 allowRoots 内时抛错，不产出 Work |
| `ROUTING-UNIT-004` | unit | P0 | `rules.test.ts` | 12 | 首个命中即停：两条规则都能匹配，只认第一条 |

## 5. 夹具与清理

`rules.test.ts` 直接加载生产 `config/rules.yaml`——判据就是线上规则，改规则必须同步看这里。

## 6. 单跑

```bash
node tests/scripts/run-suite.mjs --case=ROUTING-INT-001   # 一条，产物落 tests/out/<runId>/
node tests/scripts/run-suite.mjs --suite=routing                  # 本域全部
```
