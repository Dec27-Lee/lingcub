# plugin-kit 场景说明（case.md）

- **层级目录**：`tests/specs/plugin-kit/`（18 个用例文件，66 条断言）
- **执行真相**：[suite.yaml](suite.yaml)（runner 只读它；本文件给人看）
- **规范**：[../../README.md](../../README.md)

## 1. 这一层管什么

插件共用工具：claude/dsh 会话探测与信任、钩子配置、CC Switch 同步、钉钉/飞书载荷清洗、`spawn` 行协议、模板与 JSON 提取。

## 2. 不管什么

- 插件装配与决策（→ `../plugins/`）
- 内核状态与不变式（→ `../kernel/`）

## 3. 判据来源

- [`docs/platform/contracts.md`](../../../docs/platform/contracts.md)
- [`docs/runtime/executors.md`](../../../docs/runtime/executors.md)

## 4. 用例清单

> 首个标题取该用例文件里第一条 `test(...)` 的原文，保证与代码一致；断言数即该文件的 `test(...)` 条数。

| 场景 ID | 层级 | 优先级 | 用例文件 | 断言数 | 首条断言 |
| --- | --- | --- | --- | --- | --- |
| `KIT-UNIT-001` | unit | P2 | `cc-switch.test.ts` | 7 | 没装 cc-switch 时返回 null（不该影响没用这个工具的人） |
| `KIT-UNIT-002` | unit | P2 | `claude-agents.test.ts` | 5 | agents --json：解析出全 uuid / cwd / busy-idle |
| `KIT-UNIT-003` | unit | P2 | `claude-trust.test.ts` | 9 | 信任预置：把工作区标记成已信任，其它字段一字不动 |
| `KIT-UNIT-004` | unit | P2 | `claude-window.test.ts` | 4 | 收窗：按 cc-launch-<前8位> 找到根进程，带 /T 连子孙一起关 |
| `KIT-UNIT-005` | unit | P1 | `dingtalk-report.test.ts` | 3 | 钉钉日报：去掉尾部链接块和空字段噪声 |
| `KIT-UNIT-006` | unit | P1 | `dingtalk-text.test.ts` | 4 | 媒体提示清洗：图片占位符后的命令提示被去掉 |
| `KIT-UNIT-007` | unit | P2 | `discover.test.ts` | 3 | 工作区扫描：登记过的 + 转录里出现过的，且只在允许根之内 |
| `KIT-UNIT-008` | unit | P2 | `dsh-discover.test.ts` | 5 | dsh 会话发现：读 projcache 的 cwd/标题，按 allowRoots 过滤 |
| `KIT-UNIT-009` | unit | P1 | `feishu-history.test.ts` | 2 | 飞书历史解析：取正文、按时间升序、排除卡片空消息 |
| `KIT-UNIT-010` | unit | P1 | `hook-config.test.ts` | 3 | 代答类钩子：必须带 matcher 与 1900 秒超时（默认 60 秒会把等人的那一轮掐断） |
| `KIT-UNIT-011` | unit | P2 | `internal-claude.test.ts` | 6 | claude 二进制识别：`.cmd` 壳和绝对路径也算，dsh 不算 |
| `KIT-UNIT-012` | unit | P1 | `json-extract.test.ts` | 2 | extractJson：lark-cli 的缩进 JSON 按整段解析 |
| `KIT-UNIT-013` | unit | P1 | `open-gate.test.ts` | 2 | 开窗闸门：同工作区 60 秒内只放一次（防连点开多窗） |
| `KIT-UNIT-014` | unit | P1 | `presence-sampler.test.ts` | 2 | 在场采样脚本：here-string 必须顶格（缩进会让整段 PowerShell 解析失败） |
| `KIT-UNIT-015` | unit | P2 | `restart.test.ts` | 3 | 订阅没配（code=2）：固定 60 秒一次，别刷屏 |
| `KIT-UNIT-016` | unit | P1 | `shared-cards.test.ts` | 1 | renderResumeCard：恢复与接入用不同的回调 k |
| `KIT-UNIT-017` | unit | P1 | `spawn-lines.test.ts` | 2 | spawnLines：不传 input 时 stdin 保持打开，lark-cli 不会因 EOF 退出 |
| `KIT-UNIT-018` | unit | P1 | `spawn.test.ts` | 3 | Windows 上 npm 全局壳要解析成真实目标，否则 spawn 直接 ENOENT |

## 5. 夹具与清理

探测类函数只喂临时目录构造的会话文件；不读写真实 `~/.claude`。

## 6. 单跑

```bash
node tests/scripts/run-suite.mjs --case=KIT-UNIT-001   # 一条，产物落 tests/out/<runId>/
node tests/scripts/run-suite.mjs --suite=plugin-kit                  # 本域全部
```
