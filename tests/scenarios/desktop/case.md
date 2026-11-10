# desktop 场景说明（case.md）

- **层级目录**：`tests/specs/desktop/`（6 个用例文件，21 条断言）
- **执行真相**：[suite.yaml](suite.yaml)（runner 只读它；本文件给人看）
- **规范**：[../../README.md](../../README.md)

## 1. 这一层管什么

桌面工作台：HTTP 路由、UI 目录与插槽、插件状态、工作站快照、窗口注册表、改配置后重启。

## 2. 不管什么

- 内核逻辑（→ `../kernel/`）
- 前端页面的视觉与交互（无自动化）

## 3. 判据来源

- [`docs/runtime/sessions-and-windows.md`](../../../docs/runtime/sessions-and-windows.md)
- [`docs/tasks/202611/20261105-dec27lee-A56T3BP3-桌面端插件插槽.md`](../../../docs/tasks/202611/20261105-dec27lee-A56T3BP3-桌面端插件插槽.md)

## 4. 用例清单

> 首个标题取该用例文件里第一条 `test(...)` 的原文，保证与代码一致；断言数即该文件的 `test(...)` 条数。

| 场景 ID | 层级 | 优先级 | 用例文件 | 断言数 | 首条断言 |
| --- | --- | --- | --- | --- | --- |
| `DESK-UNIT-001` | unit | P1 | `desktop-page.test.ts` | 2 | 桌面壳：占位符与固定菜单区存在 |
| `DESK-E2E-002` | e2e | P1 | `desktop-plugins.test.ts` | 2 | 插件台账：v1/v2 都扫，启用状态与配置一致 |
| `DESK-E2E-003` | e2e | P1 | `desktop-registry.test.ts` | 4 | 登记文件：写入能读回，字段不全时视为没有 |
| `DESK-E2E-004` | e2e | P1 | `desktop-workstation.test.ts` | 1 | 面板：工作站区块与 /api/workstation 可用 |
| `DESK-E2E-005` | e2e | P1 | `runtime.test.ts` | 10 | 单实例锁：第二个进程被拒，释放后可再拿 |
| `DESK-UNIT-006` | unit | P1 | `ui-catalog.test.ts` | 2 | UI 目录：只收启用插件的 nav/slot |

## 5. 夹具与清理

`startUi` 绑随机端口，用例内 `close`；状态目录用 `mkdtemp`。

## 6. 单跑

```bash
node tests/scripts/run-suite.mjs --case=DESK-UNIT-001   # 一条，产物落 tests/out/<runId>/
node tests/scripts/run-suite.mjs --suite=desktop                  # 本域全部
```
