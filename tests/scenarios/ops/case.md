# ops 场景说明（case.md）

- **层级目录**：`tests/specs/ops/`（5 个用例文件，18 条断言）
- **执行真相**：[suite.yaml](suite.yaml)（runner 只读它；本文件给人看）
- **规范**：[../../README.md](../../README.md)

## 1. 这一层管什么

运维脚本：开机自启目标解析、看门狗退避、切换库与切换前预检、钩子安装与 CC Switch 同步。

## 2. 不管什么

- 业务链路（→ 各域）

## 3. 判据来源

- [`docs/platform/contracts.md`](../../../docs/platform/contracts.md)（钩子与 CC Switch 段）
- [`docs/runtime/sessions-and-windows.md`](../../../docs/runtime/sessions-and-windows.md)（三端入口）

## 4. 用例清单

> 首个标题取该用例文件里第一条 `test(...)` 的原文，保证与代码一致；断言数即该文件的 `test(...)` 条数。

| 场景 ID | 层级 | 优先级 | 用例文件 | 断言数 | 首条断言 |
| --- | --- | --- | --- | --- | --- |
| `OPS-UNIT-001` | unit | P2 | `autostart.test.ts` | 3 | Windows 自启：装 .vbs、窗口样式 0，且能清掉旧的 .cmd |
| `OPS-E2E-002` | e2e | P2 | `hooks-install.test.ts` | 1 | 装钩子时清掉旧桥接留下的钩子，并且同一条命令只留一份 |
| `OPS-UNIT-003` | unit | P2 | `supervise.test.ts` | 3 | 看门狗：不给子命令时默认 run |
| `OPS-UNIT-004` | unit | P2 | `switch-preflight.test.ts` | 4 | 切换检查：场景开关与插件配套 |
| `OPS-E2E-005` | e2e | P2 | `switch.test.ts` | 7 | 切换预演：列出四步且声明「没做任何事」 |

## 5. 夹具与清理

安装类用例只写 `mkdtemp` 目录的 `settings.json`；`--apply` 场景由 `LINGCUB_SWITCH_CONFIRM` 第二道闸挡住，不触真实配置。

## 6. 单跑

```bash
node tests/scripts/run-suite.mjs --case=OPS-UNIT-001   # 一条，产物落 tests/out/<runId>/
node tests/scripts/run-suite.mjs --suite=ops                  # 本域全部
```
