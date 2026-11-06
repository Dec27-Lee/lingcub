# 004 执行器

两种执行器，按项目分流，由 `projects.yaml` 的 `executor` 字段决定。

## 差异（实测 claude 2.1.317 / dsh 0.2.1-rc.5）

| 能力 | claude | dsh |
|---|---|---|
| 后台会话 | `--bg`，配 `logs`/`attach`/`stop`/`rm` | 无，只能杀进程 |
| 预算闸 | `--max-budget-usd`、`--max-turns` | 无 |
| 流式事件 | `-p --output-format stream-json --verbose` | `--profile headless --json`（NDJSON） |
| 续跑 | `--resume <id>` / `--continue`（cwd 必须一致） | `--session-id`（**只认已存在的会话**，cwd 必须一致，且不能是 subagent/fork） |
| 会话 id | 可用 `--session-id <uuid>` **预置** | 新任务**不能预置**，只能从输出里抓 |
| 结构化输出 | `--json-schema` | 无 |
| 会话存储 | `~/.claude/projects/<slug>/<uuid>.jsonl` | `~/.dsh/sessions/<slug>/<id>/session.v4.jsonl.zstd` |
| 权限 | `--permission-mode` | 默认 fail-closed，自动化须 `danger-full-access` |

**结论**：公司项目用 claude（可观测、可止损），日常/个人任务用 dsh（轻、快、无预算诉求）。

## 启动约定

claude：
```
claude --bg --permission-mode bypassPermissions \
  --max-budget-usd <budget> --max-turns <turns> \
  --output-format stream-json --verbose \
  -p "<prompt>"
```
cwd = `workspace.root`（伞根），子仓库由 cc 按 `REPOSITORY-ROUTER.md` 自行定位。

dsh：
```
dsh --profile headless --json "<prompt>"
```
cwd = worktree 路径。新任务不传 `--session-id`（只认已存在会话），句柄先用 Work id，
真实 session id 在后续批次从 NDJSON 输出里抓。

## 观测与止损（现状）

- claude：观测靠配置里的 `logsArgs` / `stopArgs` 模板；**这两个命令的参数未实测**，
  没配就 `read()` 返回空数组（任务不会自动收敛为完成），`stop()` 只告警不动作。
- dsh：任务期间就是一个子进程，进程输出即进度，退出码 0 → 完成、非 0 → 失败，无需额外命令。

## 工作区门禁（双保险）

1. 路由层：`resolveWorkspace()` 校验 root 在 `allowRoots` 内，否则不入队。
2. 插件层：`start()` 再校验一次，不符直接抛错。

模型说错顶多漏派，不会把公司代码交给错的执行器。

## 交互式会话通道（生产实测，来自 feishu-bridge-claude）

要让「在飞书话题里打字 → 进正在跑的 claude 窗口」，不需要自己造队列：
claude 自带跨会话消息通道，桥接只是往里写一行。

| 环节 | 事实 |
| --- | --- |
| 通道 | Windows 命名管道 `\\.\pipe\LOCAL\cc-msg-<hash>`；先发 auth 行，再发 user 信封行 |
| 地址与凭证 | `~/.claude/sessions/<pid>.json` 的 `messagingSocketPath` + 同目录 `<pid>.<hash>.key` 的 peerToken |
| 凭证会换 | /compact、resume 会重签 token，**每次投递前重读**，不能缓存 |
| 不打断 | 写完 400ms 即关连接，不等回复；排队交给 claude 自己的输入队列 |
| 必需开关 | `~/.claude/settings.json` 里 `crossSessionInbound: "accept"`，缺了投递静默失败 |
| 正文信封 | `[来自用户本人 · 飞书]` 前缀，配 SessionStart 注入规则，抵消连接层「来自另一个会话」的提示 |

**结果回传**靠 hook，写进 `~/.claude/settings.json`：

| hook | 用途 |
| --- | --- |
| `Stop` | 一轮结束：取 `session_id / cwd / last_assistant_message / transcript_path`，回一张结果卡 |
| `Notification` | 需要人介入：推提醒卡并 @ 人 |
| `PreToolUse(AskUserQuestion)` / `PermissionRequest` | 手机上答题 / 放行工具，返回值即决策 |

同一份 hooks 必须写进每个服务商配置（如 cc-switch 的每个 provider），否则切服务商就丢。

**dsh 走的是另一条路（此前文档写成「dsh 没有这条路」，是错的，已更正）**：

| 能力 | dsh 的做法 | 状态 |
|---|---|---|
| 可写的会话通道 | `dsh --profile sdk`：stdio JSON-RPC 运行时（ACP 风格协议：`session/new`、`session/prompt`、`session/cancel`、`session/request_permission`） | 实测（`--help` 原文 + 包内协议条款） |
| 逐轮追加 | `dsh --profile headless --session-id <id> "新一句"`（只认已存在会话，cwd 一致） | 帮助文档明确 |
| 事件观测 | Cordis `session/event`：post-commit、fire-and-forget，覆盖全部 durable 事件 | 包内 85 处；本地 `dsh-tt-event-tap` 同款 |
| 提问回传 | `user-questions/request` 瀑布：插件认领请求、挂起本轮、作答以 tool result 回流 | 包内 10 处；本地 `dsh-tt-ask-bridge` 同款 |
| **工具授权放行** | 协议里有 `session/request_permission`：服务端发请求，客户端回 outcome（含 `Cancelled`） | 实测（包内协议原文） |
| **同一轮插话** | 有 steering 机制（`steering/message` 在历史归一化里转成 `user/message`，界面有 `steeringAvailable`）；**ACP 层用什么方法暴露未确认** | 部分实测 |

### claude 的 `--bg`（2026-11-03 本机实测，claude 2.1.317）

| 事实 | 证据 |
| --- | --- |
| `--bg` 与 `-p/--print` **冲突** | `claude --bg ... -p "..."` → `--bg and --print conflict … The prompt is the positional` |
| `--bg` **不接受** `--session-id` 预设 | 传了 uuid `c8293688-…`，实际会话变成 `af74099e-2b7d-…`（claude 自己定的） |
| 会话短 id 只能从输出里读 | stdout 一行：`backgrounded · af74099e` |
| `logs` / `stop` 只认**短 id** | `claude logs af74099e` ✓；`claude logs <完整uuid>` → `No job matching` |
| 会话表里存**完整 uuid** | `~/.claude/sessions/52264.json` 的 `sessionId` 是完整 uuid，`messagingSocketPath` 是命名管道，密钥在同目录 `<pid>.<hash>.key` |
| 管道投递**实测成功** | 注入「现在只回复四个字：管道通了」→ 会话记录为 `Another Claude session sent a message: …`，模型回「管道通了」 |
| 必需的开关 | `~/.claude/settings.json` 里 `crossSessionInbound: "accept"`（本机已是） |

**结论更正**：两种执行器都能承载飞书会话。claude 是原生现成（管道 + hook），
dsh 要按 ACP 客户端来写（`session/prompt` 投递、`session/cancel` 停止、`session/request_permission` 回授权），
授权与停止都有协议位，只剩「轮内 steering 怎么暴露」这一格没确认。
我此前把「headless 一次性」当成 dsh 的全部能力，是判断错误。

## 会话寿命

- `freshSession: true` → 每个 Work 新会话，不复用历史。
- `maxSessionMB` → 历史文件超限强制换新（实测历史会话可达 135MB，resume 成本极高）。
- 同一 workspace 并发受 `concurrency` 限制；超限排队，不降级到别的执行器。

## 失败处理

`result.subtype` 映射：`error_max_budget_usd` / `error_max_turns` → 不重试，回飞书报原因；
`error_during_execution` → 重试一次；连续两次失败 → 标记 `failed` 并告警。
