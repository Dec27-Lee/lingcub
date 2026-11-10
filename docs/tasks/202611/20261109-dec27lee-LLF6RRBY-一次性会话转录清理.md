# 20261109-dec27lee-LLF6RRBY 一次性会话转录清理

- **任务 ID**：20261109-dec27lee-LLF6RRBY
- **任务名**：一次性会话转录清理
- **创建人**：Dec27-Lee
- **创建时间**：2026-11-09 18:06:00
- **最后更新人**：Dec27-Lee
- **更新时间**：2026-11-10 15:30:00
- **相关材料**：
  - [任务索引](../INDEX.md)

## 需求描述

渠道分析、意图分类每次都是一次 `claude -p`。claude 会把这次调用落成一份转录：
`~/.claude/projects/<cwd-slug>/<session-id>.jsonl`，**一次 300KB 上下**。

实测（2026-11-09）：

| 项 | 数 |
| --- | --- |
| `E--Develop-E-lingcub` 目录 | 614 个文件 / 188.4 MB，最早 11-05 |
| 其中本平台发起的一次性调用 | **540 个 / 162.4 MB** |
| 日增 | 11-09 一天 140 个 / 44.7 MB |

**没有清理机制**：`kernel/cleanup.ts` 只清 `data/images` 和截日志；`~/.claude/projects` 是 claude 的目录，
它自己也不修剪（4 天只增不减）。

要求（用户原话）：**不要通过规则匹配**——每次通过本平台发起的会话都要记录唯一标识，按标识删。

## 技术设计

### 唯一标识从哪来

| 执行器 | 来源 | 时机 |
| --- | --- | --- |
| claude | 我们自己传的 `--session-id`（`plugin-kit/internal-claude.ts` 已经在传 randomUUID） | 起进程**之前**就知道 |
| dsh | 输出首行的 `{"type":"session","sessionId":"session-…"}` | 只能跑完再读 |

**平台事实**（2026-11-09 实测）：`claude -p --session-id <uuid>` 跑完后，
`~/.claude/projects/<cwd-slug>/<uuid>.jsonl` 就是它的转录——文件名等于会话 id。

### 落库与删除口径

```sql
spawned_sessions(session_id PK, executor, purpose, created_at, purged_at)
```

- **只有记在这张表里的 id 会被删**。用户自己开的窗口 id 不在表里，永远不进删除清单——
  不需要「看内容像不像我们的」这种判据，也不会误删别人的会话记录。
- 路径不猜 slug：claude 扫 `~/.claude/projects/*/<sid>.jsonl`，dsh 扫 `~/.dsh/sessions/*/<sid>/`。
  cwd→slug 的规则会变，按 id 匹配一层子目录更稳。
- 清理沿用现有每小时一次的 `cleanupOnce`，`cutoff = now - cleanup.spawnTtlDays`（默认 7 天）。
  删成功、或文件本来就不在 → 标 `purged_at`（下次不再查）；删失败留着重试。

### 插件边界

插件不能碰库（契约禁止）。所以由 `plugin-kit` 这一层（真正 spawn 的地方）把 id 回调出去，
内核启动时注入 `setSpawnRecorder` 接上 store。`internal-claude.ts` 已有同类单例（`internal` Set），不新增概念。

## 实施计划

### 第 1 轮（2026-11-09）

| 文件 | 改动 |
| --- | --- |
| `src/kernel/store.ts` | `spawned_sessions` 表 + `recordSpawn` / `listSpawnsToPurge` / `markSpawnPurged` / `countSpawns` |
| `src/plugin-kit/internal-claude.ts` | `SpawnRecord`、`setSpawnRecorder`、`firstSessionId`；`runClaudeOnce` 收 `purpose`，claude 先记账再起进程 |
| `src/plugin-kit/internal-session-files.ts` | 新文件：`purgeSpawnFiles` 按 id 删两个执行器的转录 |
| `src/kernel/runtime.ts` | 启动注入 recorder；`cleanupOnce` 里按 TTL 取清单并删 |
| `src/plugins/{classifier-llm,capability-ai}` | 传 `purpose: 'classify'` / `'analyze'` |
| `src/kernel/config.ts`、`config/lingcub.yaml` | `cleanup.spawnTtlDays: 7` |
| `src/main.ts` | doctor 报「已记录 N 个（待清 M 个）」 |

### 验证

| 项 | 结果 |
| --- | --- |
| 平台事实 | `claude -p --session-id 706d762b-…` 后该 uuid 的 `.jsonl` 出现（310KB） |
| 端到端 | 重启后跑一次分析 → 表 1 行；`5b7bc7b5-…` 精确命中磁盘 `338,596B` 的文件 |
| 真删 | 临时 `spawnTtlDays: 0.0001` → 重启 → 日志「清理：一次性会话转录 2 个」、两行 `purged_at` 有值、两个文件消失；随后改回 7 并重启 |
| `pnpm test` | 622 pass / 0 fail（新增 3 条：`firstSessionId`、`purgeSpawnFiles`、store 登记） |
| 变异反证 | `created_at < ?` 改成 `>` → 登记用例真红；把 missing 记成 removed → 清理用例真红；均已复原 |

### 已知边界

- dsh 的 id 只能事后从输出读：那次调用如果超时/崩溃，就没有记录，会在磁盘留一个文件。

### 第 2 轮：补登记本轮之前的转录（2026-11-09 18:42）

第一轮只保证**今后**的调用有 id。用户选 A：把之前那批也补登记，仍然按 id 删。

**导入判据**（只在「认 id」这一步用一次，之后删除仍只认表里的 id）：

1. 平台元数据 `entrypoint === 'sdk-cli'` —— 编程式一次性调用（`cli` 是用户开的窗口）。
2. 我们拼任务时写死的两个小标题之一：`## 候选项目`（分类）/ `## 当前消息`（分析）。
   比首句文案稳——提示词改过几轮，模板没改。

两条都满足才进清单。实测 617 个文件的分组：

| 组 | 数 | 体积 | 处理 |
| --- | --- | --- | --- |
| sdk-cli + 模板 | **601** | **182.7 MB** | 已登记 |
| sdk-cli 无模板（手工探针） | 6 | 1.8 MB | 不动 |
| `entrypoint=cli`（用户自己的窗口） | 44 | — | 不动 |
| 无 entrypoint（旧格式/别的来源） | 9 | 4.4 MB | 不动 |

**命令**（`lingcub spawn`，两道闸：`--apply` + `LINGCUB_SPAWN_CONFIRM=1`）：

```
lingcub spawn scan                    # 只读：清单 + 体量 + 抽样
lingcub spawn adopt --apply           # 写进 spawned_sessions
lingcub spawn adopt --apply --purge   # 写进去后立刻按 id 删掉这批
```

**发生时间用文件 mtime**，不是导入时间：否则这批要再等一整轮 7 天。

**实测**：`spawn adopt --apply` → 「已登记 601 个（原发生时间 2026-11-05 ~ 2026-11-09）」；
`doctor` 报「已记录 603 个（待清 601 个）」。`pnpm test` 625 全绿（新增 3 条导入判据用例）。

按 TTL 7 天，最早那批（11-05）3 天后开始自动回收；要立刻回收就加 `--purge`（未擅自执行）。

### 第 3 轮：保留期改成 3 天（2026-11-09 19:00）

用户要求「不用 7 天，3 天回收，做成配置」。保留期本来就是配置项 `cleanup.spawnTtlDays`，
所以只改默认值与基线：7 → 3。

顺带把单轮上限从 300 提到 1000：实测有 358 个到期，300 的上限要跑两轮（第二轮在 1 小时后）。
清理一次只是「一次 readdir + N 次删除文件」，没有理由分两轮。

**实测**（重启后，cutoff = 2026-11-06T10:54Z）：

- 10:55:11 清理：一次性会话转录 300 个
- 10:56:15 清理：一次性会话转录 58 个
- doctor：一次性会话 已记录 606 个（待清 246 个，保留 3 天）

**效果**：`E--Develop-E-lingcub` 从 614 个文件 / 189.3 MB 降到 **262 个 / 83.5 MB**（回收 105.8 MB）；
剩下 246 个在 3 天内，随新数据一起滚动回收（76.9 MB）。

**没有误删**：重扫分组 = 可登记 246 + 探针 6 + 交互式 44 + 认不出 9，与磁盘实际 305 个文件逐个对上。
用户自己的 44 个会话、6 个探针、9 个旧格式文件一个没动。

### 第 4 轮：保留期 3 天 → 1 天（2026-11-10）

**为什么**：用户判断 3 天还是太多，钉钉来源的分析调用占大头（`analyze` 用途 186 条 / 两天）。

**改动**

- `cleanup.spawnTtlDays`：`config.ts` 默认值与 `config/lingcub.yaml` 一起从 3 改成 **1**。
- `config-schema.ts` 补上这一项——原来只能手改 yaml，配置面板里根本看不到它。
- **顺带修一个数字口径**：doctor 原来打「待清 N 个」，`N` 是「所有没清过的记录」，不看是否到期。
  实测 788 条里未清理 205 个、真正到期只有 0–4 个，读起来像下次要删 205 个。
  新增 `store.countSpawnsDue(cutoff)`，doctor 改成「未清理 N 个，其中到期 M 个」。

**实测**（重启后，cutoff = 1 天）

| 项 | 前 | 后 |
| --- | --- | --- |
| `E--Develop-E-lingcub` 转录 | 381 个 / 124.9 MB | **220 个 / 74.6 MB** |
| 日志 | — | `清理：一次性会话转录 161 个` |
| doctor | 待清 353（口径含糊） | 未清理 205 个，其中到期 0 个；保留 1 天 |

清理条数与改配置前按 1 天算出的 **161 条逐个对上**，回收 50.3 MB。
用户自己的窗户不动：`E--Develop-E-tt-tt-design-space-ai` 仍是 44 个 / 803.4 MB（交互式会话，不在登记表里）。

变异反证：`countSpawnsDue` 去掉 `purged_at IS NULL` → 「到期数和未清理数是两个口径」那条断言红，已复原。
