# 005 会话、桌面窗口与多端

生产版（`feishu-bridge-claude`）的真实用法是「**一个窗口一棵话题，我在话题里持续说话**」。
本文补上 lingcub 缺的那一层：可继续说话的**会话**，以及承载它的桌面窗口与三端适配。

## 1. 为什么要有 Session

现有链路是一次性的：Event → Intent → Work → Action，做完就结束。
但用户不会「按任务说话」，他在话题里连着说十句，每句都该进同一个窗口。所以：

- `Work` = 一次派工（已有）
- `Session` = 一个可继续说话的对话 = 话题 ↔ 执行器会话 ↔ 工作区

## 2. 会话模型

```
Session
  id            内部 id
  chat_id       飞书群
  thread_id     话题（root/thread id）
  title         话题名（飞书没有改话题名的接口，开窗时定死）
  executor      claude | dsh
  workspace     执行器真实 cwd（绝对路径）；**不是** projects.yaml 里的工作区 id——
                投递与停止都拿它当 cwd 用，存成 id 会让「在话题里继续说话」直接失败
  session_id    执行器侧会话 id
  status        active | idle | stopped | dead
  card_id       状态卡（就地 patch 用的 message id）
  pinned        是否被我们置顶
  last_active_at
```

不变式：

1. 一个话题最多绑一个会话；一个执行器会话同时只能被一个话题绑定。
   跨目录复用会把对话带到错误的目录，宁可让用户重开。
2. 话题内消息命中 session → **直通投递，不再走判断层**。
3. `status=dead` 的会话保留记录，但不再接受投递，需要用户重开。

## 3. 判断层不变，只是前面多一层会话路由

```
Event
 ├─ 0. 命中 session（按 chat_id + thread_id）→ executor.post(会话, 文本)
 ├─ 1. 规则（rules.yaml）命中 → Intent
 ├─ 2. 模型分类 → Intent
 └─ 3. 都不确定 → 只记录
```

第 0 层是 dsh-superagent 的「已订阅 Thread 的事件直发 Worker」。
交接时有意没做（单人先保证判断可测），现在为了对齐生产用法补上。
它**不降低可回放性**：直通也落 `events` 表并记 `session_id`，回放时能看出「这句是投给已有会话的」。

### 3.2 开窗（一个窗口怎么诞生）

`sessions.newTopicPolicy` 决定群消息的去向：`judge`（默认，照常判断）或 `open`（群消息即开窗请求）。

`open` 档的流程：

1. 收到群里的非话题消息 → 查 `choices` 表有没有待选（默认 30 分钟过期）；
2. 没有待选：只有一个工作区就直接开；多个就回「选工作区（回序号或 #别名）」并记下待选；
3. 有待选：`2` 或 `#order` 命中 → 派工；认不出 → 重发选项，**不派工**；
4. 派工成功 → 投递环节发一条锚消息（`窗口已创建：<话题名>`），**这条消息的 message_id 是话题的根消息 `om_…`**，
   写进 `sessions.thread_id`；真话题 id 是 `omt_…`（用户在这棵话题里说话时才由平台给出），
   两者并不相等，所以路由按 `thread_id` / `root_message_id` 两列先后匹配（见 [006](../006-platform-contracts.md)）；
5. 之后该话题里的每条消息在第 0 层直接命中会话，不再判断。

边界：`dead` 会话不接消息（宁可让人重开）；频道没返回消息 id → 投递失败并重试，**不写半截会话**；
`mode=observe` 时不开窗，只回一句「当前只记录档」。

### 3.3 结果回传（窗口跑完了怎么回来）

claude 的 `Stop` / `Notification` 钩子被调起时是**独立进程**，它不认我们的端口，所以：

```
claude 钩子 → node dist/main.js hook post stop  （读 data/hooks.json）
            → POST http://127.0.0.1:<port>/stop?t=<token>
            → 常驻进程：按 session_id 找会话 → 入队一条 reply_only（回到该会话的 chatId+threadId）
```

要点：

- **认不出的 session_id 一律不回复**——那可能是别的进程（比如生产桥接）起的窗口，串回别人话题比不回更糟。
- 空输出回「（这一轮没有输出）」；超 1500 字截断并注明，避免把话题刷屏。
- 常驻进程没在跑时 `hook post` 静默成功（退出码 0），否则会打断 claude 的一轮。
- 装钩子用 `lingcub hook install`：默认**只预演**，`--apply` 才写，写前备份；已装过就不重复写。
  它会保留文件里已有的钩子（生产桥接也在用这些钩子），不整体覆盖。

### 3.4 状态卡

一个会话只有一张卡，内容是「状态 + 几行字」，由内核给、频道渲染：

| 环节 | 谁做 | 约束 |
| --- | --- | --- |
| 生成 | 内核（`active` 会话还没卡时，`refreshCards` 每拍补一张） | 走发件箱，按 `cards` 表幂等 |
| 签名比较 | 内核 | 内容签名一致就跳过，不刷屏 |
| 建卡 / 改卡 | 频道插件 | `sendCard` 用 `--msg-type interactive`；`patchCard` 用 `im messages patch`（限自己发的卡、14 天内） |
| 记 message_id | 内核 `cards` 表 | 拿不到 id 就明确失败，不记成已建卡 |

状态取值：`running`（蓝）/ `waiting`（橙，需要人看）/ `done`（绿）/ `failed`（红）。
钩子把 `done` 与 `waiting` 推进来，所以卡片的生命周期跟会话一致。

### 3.5 图片与置顶

| 场景 | 做法 |
| --- | --- |
| 话题里发图片 | 图片消息的 `content` 是 `{"image_key":"img_x"}`，不转就成了一段 JSON 字面量。投递前用 `im +messages-resources-download` 下到 `data/images/<会话>/<key>`，正文换成 `[图片]` 并附本地路径 |
| 输出路径限制 | `lark-cli` 只允许写到 cwd 之下，所以统一用**相对路径**（`data/images/...`），不传绝对路径 |
| 状态卡置顶 | `channels.feishu.pinCards: true` 时建卡后调 `im pins create`；**置顶失败只告警，不让发卡算失败** |

### 3.6 选择题（AskUserQuestion）

Claude Code 的 `PreToolUse(AskUserQuestion)` 钩子里有一条官方代答通道：

```json
{ "permissionDecision": "allow", "updatedInput": { "questions": [...], "answers": { "<问题原文>": "<答案>" } } }
```

返回它就跳过终端弹窗、把 `answers` 当作「用户作答」交给模型；`answers` 的 key 必须是问题原文。

我们的做法：

| 环节 | 行为 |
| --- | --- |
| 钩子 `hook post ask` | 转发到常驻 `/ask`，**把返回体原样打到 stdout**（那就是决策） |
| 常驻 `/ask` | 按 `session_id` 找会话；不是本进程起的窗口 → 返回 `{}`（终端弹窗照常出现） |
| 提问 | 题目写进 `questions` 表并推到该会话的话题（`1) … 2) …`） |
| 等待 | 每 500ms 查库，不占内存状态；超时（默认 240s）返回 `{}` |
| 作答 | 话题里的回复先撞「有待答题」这一层：`2` / `#2` / 自由文字都算答案，**不再投进窗口** |
| 多题 | 一次答一题，答完自动问下一题 |

### 3.7 工具授权（PermissionRequest）

与选择题同一套挂起机制，只是钩子事件与返回形状不同：

```json
{ "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": {
  "behavior": "allow", "updatedInput": <原样回传>, "updatedPermissions": [...]
} } }
```

| 点 | 做法 |
| --- | --- |
| 触发 | `hook post permission` → 常驻 `/permission`，按 `session_id` 找会话 |
| 提问 | 话题里回：「🔐 要用工具 X：command=… 回 1 允许 / 2 拒绝」 |
| 作答 | `1`/允许/yes → allow；`2`/拒绝/no → deny；带「总是」→ 放行并写 `updatedPermissions` |
| 放行时 | `updatedInput` **必须原样回传**，否则字段会被清空 |
| 不代答 | 没人答或超时 → 返回 `{}`，终端弹窗照常出现 |
| 边界 | deny 规则仍优先；`requiresUserInteraction` 的 MCP 工具、关键路径 rm 一律放不过——这是「帮人点一下」，不是绕过权限 |

### 3.8 命令与在场

话题里的第一行如果是命令，就不投给窗口：

| 命令 | 行为 |
| --- | --- |
| `#stop` / `#停` | 停掉窗口（执行器 stop + 会话置 `stopped`） |
| `#pin` / `#置顶`、`#unpin` / `#取消置顶` | 置顶或取消置顶状态卡；没有卡就明确失败重试 |
| `#status` / `#状态` | 回一句窗口状态（标题/状态/工作区/执行器） |
| `#help` / `#帮助` | 回命令说明 |

不在表里的 `#xxx` 当普通消息投给窗口——**认不出就不猜**。

在场探测读 `data/presence.json`（每秒由平台层写），超过 15 秒的采样视为过期；
没有采样器时一律判定「不在」，于是照常推卡片：功能不缺，只是手机上多收几张。

### 3.9 回执冷却

同一会话的同一类回执（`status-reply`、`help-reply`、`stop-reply`）在 `sessions.replyCooldownMs`
（默认 10 秒）内只回一次，且记在 `replies` 表里——重启不丢，连点两下不会回两遍。

## 4. 执行器要补的能力

| 能力 | claude | dsh |
|---|---|---|
| 交互式会话（持续收消息） | `--bg` / 长驻窗口 | `--profile sdk`（stdio JSON-RPC，ACP 风格）；或 `--session-id` 逐轮追加 |
| 投递消息 | 命名管道 + peerToken（claude 专有） | `session/prompt`（ACP 客户端）；headless 用 `--session-id` 续跑 |
| 停止 | `claude stop` / kill | `session/cancel`（协议通知） |
| 同一轮运行中插话 | 有（claude 输入队列） | 有 steering 机制；ACP 层暴露方式**未确认** |
| 观测进度 | Stop / Notification / Pre·PostToolUse hook | Cordis `session/event` + ACP 通知流 |
| 提问回传 | `PreToolUse(AskUserQuestion)` hook | `user-questions/request` 瀑布 + answerer 插件 |
| 工具授权 | `PermissionRequest` hook | `session/request_permission`（客户端回 outcome，含 Cancelled） |

**结论**：两种执行器都能承载会话。claude 是原生现成；dsh 要按 ACP 客户端来写，
授权与停止都有协议位。选 claude 做公司工作区是历史连续与止损成熟，不是能力缺失。
`lingcub` 对两者的要求一致：一个 `Session` 就是「能收消息、能给进度、能被停止」。

## 5. 能力对齐表（按参考项目源码逐条清点，32 条）

状态口径：**已实现** = 有代码有测试；**不适用** = 平台前提在我们这里不存在；**不做** = 有意的产品取舍（理由写在表里）。
括注是**已知的边界**，不是待办——每一条都写了为什么不再往下做。
这张表有机器自审：`node scripts/audit-parity.mjs`（也挂在 `preflight` 里）逐条核对「已实现」的落点是否真的在代码里、
测试里是否碰过它。表里写了而代码没有，会当场报出来。
它同时核对 §5.1b 的 15 条实现层约定（阈值与文案也按**字面量**核：常量改名不算破坏，标记文本变了才算）。
「参考做法」摘自 `feishu-bridge-claude` 的 `docs/FEATURES.md` 与源码，不是平台文档。

| # | 功能 | 参考做法（关键边界） | lingcub 落点 | 状态 |
|---|---|---|---|---|
| 1 | 话题路由 | 引用消息 id → 话题 thread → p2p 最近 5 分钟窗口，三级回退 | 层 0：`store.sessionByMessage` → `routeToSession` → `store.recentSession` | 已实现 |
| 2 | 引用回复路由 | 桥接发出的每条消息都进映射表，引用它能找回窗口（`mappingTtlDays` 回收） | `message_map` 表；回复/卡片投递成功后写映射 | 已实现（映射 14 天清理已做） |
| 3 | 单聊免引用直发 | 只有 p2p 才回退到「最近 5 分钟聊过的窗口」，群聊不回退 | `store.recentSession`（仅 `kind='dm'`） | 已实现 |
| 4 | 从飞书新开窗口 | 群里非话题消息 = 开窗信号，正文即话题名 | `#openFlow`（`newTopicPolicy=open`） | 已实现 |
| 5 | 选择工作区卡片 | 扫描真实目录、按最近活跃排序、`pickMax`、按钮+序号兜底、30 分钟有效 | `card.renderPickerCard` + `discover` + `sessions.pickMax`（默认 20）/`resumeMax`（默认 8） | 已实现（未信任标注不适用：后台会话没有信任弹窗） |
| 6 | `#目录名`/别名/绝对路径 | 别名精确 → 目录名精确 → 目录名「包含」模糊匹配；没匹配上不静默换别处 | `#openFlow` 的 `#别名` 分支（四级匹配 + 未命中文案） | 已实现 |
| 7 | 命令别名与序号作答 | `#resume/#恢复/#继续`、`#目录`、纯序号（30 分钟内有效） | `routing/commands` + 待选表按话题存 | 已实现 |
| 8 | 恢复历史会话 | 近 5 天 + 未在运行 + 同工作区；空会话与「目录已不在」的也不列；卡片注明「另有 N 个正在运行，未列出」 | `discoverSessions` + `#startResumeFlow`（四条过滤 + 在跑数量说明） | 已实现 |
| 9 | 换会话 | 就绪卡上的「换会话」按钮 = 在当前话题里再发一次 `#resume` | 已绑定话题里发 `#resume` → 选会话 → 起 `--resume` 窗口并**改绑同一话题**（不新插会话） | 已实现 |
| 10 | 再开一个窗口 | 按钮/命令 → 选工作区 → 另起一棵新话题，原话题不动 | `#新窗`（含卡片按钮 `fresh` 标记）：选中后起窗口但不绑本话题、锚消息自成新话题 | 已实现 |
| 11 | 新话题自动置顶 | 开窗/首条通知时 `pins create`，失败只记日志 | `channels.feishu.pinCards` | 已实现 |
| 12 | 撤掉不再需要的置顶 | 对账，只撤自己置的、5 分钟内新置的不撤、每轮最多撤 10 条 | `Pipeline.reconcilePins` + `cards.pinned_at` | 已实现（分页看不出来：我们只撤自己记录过的置顶） |
| 13 | 答窗口的选择题 | 单选即答；**多选先攒着（再点取消）→ 点「✅ 就这些」才提交**；多题逐题；答案走 `PreToolUse(AskUserQuestion)` | `questions` + `#answerByCard`/`#commitDraft`（草稿存在 `questions.draft`） | 已实现 |
| 14 | 交还终端/自定义答案/过期点击 | 「我在电脑前，让终端问我」按钮；失效点击按四种原因回文案 | 选择题卡片带选项按钮 + 「🖥 我在电脑前」；失效点击回「已答过/等太久/你自己点了/窗口没了」；文字答案仍然认 | 已实现（缺 BEL 响铃：终端不在我们手里） |
| 15 | 在场探测 | 没锁屏 + 3 分钟内有输入；采不到一律按「不在」 | `kernel/presence`（15 秒过期即当不在） | 已实现 |
| 16 | 工具权限确认 | 允许/允许本会话不再问/拒绝；走 `PermissionRequest` hook | `kernel/questions.buildPermissionDecision` + hook `/permission` | 已实现 |
| 17 | 任务完成通知 | 头三行 📁目录/🕐时间/📦上下文用量，长回复按段落切段连发、段标题带 (i/总) | `formatStopMessage` + `splitChunks`（按空行切、单段超长硬切） | 已实现 |
| 18 | 通知带「你在终端里说」 | 从转录尾部反查最后一条真人输入；飞书发起的那轮不回显 | `kernel/transcript.lastUserInput`（跳过 compact/工具回执/系统产物，命中飞书标记即返回 null） | 已实现 |
| 19 | 需要介入时的提醒卡 | 按通知类型分派标题；权限类只提示去终端处理；**2 分钟内已有待答记录就跳过**；同窗口同类型同文案 10 分钟去重 | `notifyKind` + `NOTIFY_TITLE` + `hasFreshPendingQuestion` + `allowReply(…,10min)` | 已实现 |
| 20 | 提醒卡 @ 你 | 配了 `notifyOpenId` 才 @ | `sessions.owner_id` + `formatNotifyText` | 已实现 |
| 21 | 实时状态卡 | 2 秒扫一次、签名不变不发请求、patch 原地改；在跑时给「🔧 工具 / 🤔 思考」；有子任务在跑时黄灯；用量行 **4 格 floor**、统计按 mtime+size 缓存 | `refreshCards` + `buildStatusCard`（💬你说 / 🟢在跑 + 🔧或🤔 / 🟡子任务 / ✏️文件 / 🤖它说 / 📁 / 📦） | 已实现 |
| 22 | 状态卡换卡 | 出现新的用户消息 → 另起一张 | 转录里新的 user 消息 id 与 `card_turns` 比对，变了就丢卡记录重发 | 已实现（子代理黄卡按产品口径不做） |
| 23 | 自动回复策略 | 时机 `stopped`（可带 afterSeconds）/`busy`（busySeconds）+ 比对 prefix/contains/regex；策略与条件都从上往下先命中先生效；`enabled=false` 永不触发；busy 不许填比对文本 | `routing/auto-reply.ts`（纯函数）+ `config.auto_reply` | 已实现 |
| 24 | 自动回复投递与防跑飞 | 5 秒巡检、60 秒冷却落盘、来源标记「自动回复」 | `Pipeline.autoReplyTick`（每拍 + `sessions.auto_reply_at` 冷却 + `【自动回复】` 前缀） | 已实现 |
| 25 | 图片转发 | 一条消息可多张图；两种形态都认；下载后原地换 `[图片] 路径`，失败换占位；落盘 `data/images/<本地日期>/<消息id>_<n>.png`；清理按**目录名日期**判过期（按 mtime 会让活跃目录里的旧图永远删不掉） | `kernel/images.ts` + `post_message` + `cleanup.cleanupImages` | 已实现 |
| 26 | 网页改配置 | 页面从 schema 生成、保存三条规则、令牌 + 15 分钟闲置退出 | `kernel/config-schema.describeConfig`：按分组渲染中文名/单位/下拉/JSON 文本域/只读；执行器参数与字段映射不上页面；保存仍走覆盖层 + zod 校验 | 已实现（差「保存前改动预览」） |
| 27 | 开机自启 | 三平台用户级自启（Windows 装 `.vbs`，登录不弹窗口）+ 看门狗退避（5s→30s→300s，跑满 60 秒清零） | `scripts/install-autostart.mjs`（生成 `.vbs` 转调 `start-hidden.vbs`，卸载连带清旧 `.cmd`）+ `scripts/supervise.mjs`（子命令缺省 `run`，启动路径不必各自重复传） | 已实现 |
| 28 | 开窗失败与超时回收 | 30 秒没注册就关掉自己开的窗口并回红卡 | `executor-claude.start` 起不来当场报错并回话题 | 不适用（`--bg` 同步返回会话 id，没有「等窗口注册」这一步） |
| 29 | 工作区信任预置 | 写 `hasTrustDialogAccepted` 免得终端停在信任框 | 无（我们起后台会话，没有信任框） | 不适用 |
| 30 | 窗口注册与凭证刷新 | SessionStart 注入「飞书输入约定」+ 每次投递前刷新 peerToken | `startHookServer('/session-start')` + `onSessionStart`（只对本进程起的会话注入）+ `pipe.findLivePeer` | 已实现 |
| 31 | 过期数据清理 | 图片 7 天、映射 14 天、日志留半、提问 2 小时 | `kernel/cleanup.ts` + `store.pruneMessageMap/pruneQuestions`，启动一次 + 每小时一次 | 已实现（「会话注册 48 小时」不适用：注册在库里） |
| 32 | 错误与兜底 | 回调没订阅时只记日志并按 60 秒退避；查不到会话静默返回 | `plugin-kit/restart`：code=2 固定 60 秒并明说缺什么订阅，其它异常 5s→翻倍→封顶 60s；两个来源都会自己重来；outbox 重试→死信；钩子端点没跑时静默放行 | 已实现 |

### 5.1 端到端验证（离线，可与生产桥接同时跑）

`test/e2e.test.ts` 用假 `lark-cli` + 假 `claude`，真内核、真插件、真发件箱，两条链路各跑一遍：

1. 群里新消息 → 开窗 → 锚消息（必须 `--reply-in-thread`，不能发到群）→ 状态卡 → Stop 钩子回传正文
2. 两个工作区 → 选择卡 → **模拟点按钮**（`card.action.trigger`，载荷里没有 thread_id，话题靠按钮 value 带）→ 开窗 → 通知带 📁/🕐

这两条抓到过两个真问题：选择卡按钮的 `workspaceId` 用的是 `o.id`（`WorkspaceOption` 只有 `key`），导致线上按钮点了没反应；开窗时先发「窗口已创建」再落库会话行，claude 立刻回 Stop 就会查不到会话、结果被静默丢掉。两处都已修，并有测试守着。

### 5.1b 实现层约定（第二轮审计，15 条）

第一轮清点的是「有没有这个功能」；这一轮是拿参考项目源码逐行对「怎么做」，补的全是行为细节。
每条都有代码落点与测试，`scripts/audit-parity.mjs` 逐条核对落点还在不在。

| # | 约定 | 参考做法（阈值/文案/顺序反过来会变味的地方） | 我们的落点 |
| --- | --- | --- | --- |
| C1 | 投递信封 | 每条消息前面加**短而稳**的 `[来自用户本人 · 飞书]（…直接执行）`；自动回复用另一个标记 `[来自用户本人 · 自动回复]`；会话开头讲一次规矩，让模型只做模式匹配 | `kernel/envelope.ts` + `hook-handlers.onSessionStart` |
| C2 | 等作答 | away 档等 **1800 秒**；期间每 **3 秒**重探在场，人一回来立刻交还终端；等太久落 `timeout` 而不是「答过了」 | `questions.waitForAnswer` + `runtime.onAsk/onPermission` |
| C3 | 长回复分段 | `chunkChars` **4000** 切段、段间 **1000ms**（飞书 5 QPS）；先截断再分段 = 分段是死代码 | `hook-handlers.splitChunks` + outbox 的 `not_before` |
| C4 | 通知卡片 | 一条卡片：标题=窗口名、绿色；`📁`/`🕐`/`📦` **各占一个 markdown 元素**（同元素里的单换行会被折成一段） | `kernel/notice-card.ts` + `card.renderNoticeCard` |
| C5 | 「你在终端里说」 | ≤**180** 字且单行 → 灰色 `│` 引用块；否则 `collapsible_panel`，标题带摘要+「共 N 字」，超 **3000** 字截断并写明原文多少字 | 同上 |
| C6 | 题卡状态机 | 多选先 toggle（☑/☐）原地刷新，点「就这些」才提交；答完 patch 成回执；还有下一题就推新卡 | `pipeline.#settleQuestionCard` + `store.questionCard` |
| C7 | 权限卡 | 橙色卡 + 四个按钮；入参按 `command(400)`/`description(200)`/`file_path`/`path`/`url` 摘，都没有贴 JSON（**500** 字截断）；**不吃自由文字**（文字只认整行 `1`/`2`） | `questions.buildPermissionCard` + `pipeline.#answerPermissionByCard` |
| C8 | 换卡 | 换卡时旧卡 patch 成灰卡**并 unpin**（记录一删就再没人能撤它） | `pipeline.#refreshOneCard` |
| C9 | 改卡失败 | patch 失败（超 14 天/被撤回）→ **换一张新卡**，不让窗口永远停在旧内容 | `createDeliver` 的 `card_upsert` |
| C10 | 子任务黄灯 | 主会话说完了但 `Agent`/后台 `Bash` 的 tool_use 还没对应 tool_result → 黄灯 + 列出子代理在干什么 | `transcript.currentTurn.openSubtasks` + `card-content` |
| C11 | 就绪卡 | 开窗回一张卡：`📁` + `🆔 短号` + 「直接在这个话题里发消息」+ 「换会话 / 再开一个」两个按钮 | `card.renderReadyCard` + `pipeline` 锚消息 |
| C12 | 在场阈值 | `awayIdleSeconds` **180**；锁屏单独判；采样超 15 秒当不知道 | `presence.isPresent` |
| C13 | 工作区候选 | `pickMax` **20**；超出时卡上写「共发现 N 个」 | `pipeline.#workspaceOptions` + `renderPickerCard` |
| C14 | 命令匹配 | **前缀**匹配（`#resume 一下` 也算）、`#继续`、`#E:\path` 单发直接按路径开窗 | `routing/commands.ts` |
| C15 | 图片与用量 | 图按**本地日期**分目录、清理按目录名判过期；进度条 **4 格 floor**（满格 ⇔ 真到顶）、统计按 mtime+size 缓存；会话名 `customTitle → aiTitle` 回退 | `kernel/images.ts` + `cleanup.ts` + `transcript.ts` + `pipeline` |

三处**有意的不同**（不是漏做）：

1. **子任务状态用黄灯而不是另起黄卡**：状态卡本来就在话题里，多一张卡会刷屏。
2. **不另开一棵「正确命名」的话题**：飞书改不了话题名，参考项目只能另开一棵；那会把一段对话撕成两半，而我们的前提是「一棵话题 = 一个窗口」。
3. **图片落盘按日期不按会话**：会话目录里只要还在收新图，旧图按 mtime 就永远清不掉——这一条正是参考项目注释里点明的坑。

### 5.2 预演模式（dryRun）

`channels.feishu.dryRun: true` 时，频道插件不真的调 CLI：把渲染后的**完整命令行**写进日志，
并返回一个假消息 id（`om_dry_N`）让链路继续走——这样「绑定话题」「状态卡」这些后续步骤也能被观察到。

覆盖发文本 / 发卡 / 改卡 / 置顶 / 取消置顶 / 下载图片六种动作。用途有两个：切换前看清它到底会发什么；
端到端测试里不必碰真接口。字段入配置而非环境变量，与其它开关同一处。

### 5.3 平台契约体检（零副作用）

`node scripts/verify-contracts.mjs`：用**明显不存在的 id** 调真实 `lark-cli`，只判断「参数形状对不对、我们的 JSON 能不能过 CLI 解析」。

区分两类失败是这套检查的关键：

| 结果 | 含义 |
| --- | --- |
| `--content is not valid JSON near byte 2` / `unknown flag` / `missing required path parameter` | **我们写错了**，上线就是坏的 → 报错退出 |
| `invalid receive_id` / `not a valid {open_message_id}` | 参数形状没问题，只是这个 id 不存在 → 预期 |

实测覆盖 9 项：四种卡片（状态/选择/恢复/选择题）各发一次、`+messages-reply --reply-in-thread`、`im messages patch --data`、
`im pins create --data`、`im pins delete --message-id --yes`、`+messages-resources-download`。
一次全过：**9 项、写错 0 项**。变异反证：把 `pins delete` 改成 `--data`（我最初误以为的写法）→ 报「写错了」，真红；
把卡片 JSON 弄坏 → 4 项红。

自动回复另有一条**到执行器**的整链测试（`test/auto-reply.test.ts`）：策略命中 → 发件箱 → `executor.post`，
断言正文带 `【自动回复】` 标记、冷却期内不重复发。

## 6. 桌面窗口

**不自建 Electron。** 照参考项目的做法：本机 HTTP + 浏览器独立窗口。

- 服务只监听 `127.0.0.1`，带一次性令牌；默认 15 分钟无操作自退（`--idle-exit 0` 关掉）。
- 独立窗口用 Chromium/Edge 的 `--app=<url>`（无地址栏、任务栏单独一个窗口）；
  机器上没有则退回系统默认浏览器。窗口大小按屏幕可用区算，宽高分开。
- 三端入口都落到同一个 `scripts/launch-ui.mjs`：先探是否已有实例在跑，有就复用；
  它自身上溯定位项目根，所以整个目录换个位置不会断。
  Windows 双击 `lingcub-ui.cmd`；macOS/Linux 用 `scripts/launch-ui.sh`（Linux 另附 `.desktop`）。
- 实例登记写在 `data/ui.json`（port / token / pid）；只有 pid 还活着才算「在跑」，面板关闭时删登记。

**配置分层（解决 YAML 注释丢失）**：

| 层 | 文件 | 谁改 | 进版本控制 |
|---|---|---|---|
| 基线 | `config/*.yaml`（带注释） | 人 / AI，手写 | 是 |
| 本机覆盖 | `data/local.json`（git 忽略） | 桌面页面 | 否 |

页面改的是**覆盖层**，读取时按「基线 ← 覆盖」合并，再交给 zod 校验；
「恢复默认」= 删掉对应覆盖项。这样既不丢注释，也不需要把配置改成 JSON。

页面只开放**白名单**字段（运行档位、飞书 chatId、两个来源开关、分类置信度门槛），
改不到执行器参数与工作区路径；不在白名单的键、类型不对的值都会被拒绝且不落盘。

- 保存前先预览 diff；「保存并重启」先校验再重启，校验不过就拒绝重启（避免老进程已停、新的起不来）。
- 页面不放密钥，也不做远程访问。

## 7. 多端

「多端」= 同一套内核跑在 Windows / macOS / Linux，不是多客户端协议。

- `platform/<os>/`：自启安装与卸载、presence（锁屏 + 空闲时长）、窗口壳。
- presence 决定「人在电脑前 → 弹窗留在终端；人不在 → 推飞书」。
  判据必须两条同时满足：**没锁屏** + **N 分钟内有键鼠输入**（只看空闲时长会把「刚敲完就锁屏走了」判成在电脑前）。
- 单实例：pid 文件 + 进程名校验，防止两个 daemon 抢同一订阅
  （官方帮助：同一订阅并行会随机切分云事件）。

## 8. 什么时候把生产切到 lingcub

八条全部可测、全部满足才切；未达成的必须写进台账，不允许「先切了再说」。

| # | 判据 | 离线怎么验 | 线上怎么验 |
| --- | --- | --- | --- |
| 1 | 话题内消息能投进正在跑的会话 | `test/e2e.test.ts` 第 1 条 | 在已绑话题里说一句，日志出现「已投递到会话」 |
| 2 | 结果回到原话题、状态卡原地刷新 | `test/e2e.test.ts` 第 1 条（断言 `--reply-in-thread`） | 跑完看话题里是否多出带 📁/🕐/📦 的消息；状态卡不产生新消息 |
| 3 | 选择题与授权能在手机端完成 | `test/questions.test.ts`（含多选与交还终端） | 人离开电脑，触发一次提问，点按钮作答 |
| 4 | 图片落盘并把路径交给会话 | `test/images.test.ts` + `test/cards.test.ts` | 发一张图，窗口里能 Read 到本地路径 |
| 5 | 置顶只保留活窗口，只撤自己置的 | `test/commands.test.ts` 两条对账用例 | 停一个窗口，看置顶是否被撤、别人的置顶是否不动 |
| 6 | 自动回复策略与冷却落盘 | `test/auto-reply.test.ts`（含冷却） | 重启后策略仍生效、冷却不丢 |
| 7 | 一个订阅只有一个 daemon | `scripts/preflight.mjs` 的「订阅占用」 | lock 文件与进程表一致 |
| 8 | 桌面窗口能改配置并重启 | `test/runtime.test.ts` | 面板改一项、保存并重启、页面报新 pid |

### 8.1 切换清单（每步都有检查点）

```bash
# 0. 体检（只读）：八条里能离线验的先跑一遍
node scripts/preflight.mjs          # 期待：只剩「订阅占用」一项（那是旧桥接）
node scripts/audit-parity.mjs       # 期待：30 条落点 0 缺失
pnpm test                           # 期待：全绿

# 1. 预演：不起真进程，先看它打算发什么
#    配置里把 channels.feishu.dryRun 设为 true，再收一条消息，日志里会出现「[预演] …」

# 2. 停旧桥接（含它的看门狗，否则会被拉起来）
#    Windows：先停 vbs 看门狗，再停 node 主进程；命令见 data/switch-snapshot/old-watchdog.txt

# 3. 起 lingcub
node scripts/preflight.mjs          # 这次「订阅占用」应为 ✔

# 4. 线上八条逐条过一遍（表右列），每条都能在日志或话题里看到证据

# 5. 回滚：停 lingcub → 按 switch 脚本的快照还原 hooks 与 data/local.json → 起旧桥接
```

改配置/装钩子这类会动生产状态的步骤，一律走 `scripts/switch.mjs`（默认预演，`--apply` 之外还要 `LINGCUB_SWITCH_CONFIRM=1`），
不要手敲命令——2026-11-03 就因为一次变异让开关恒真，真把生产切了 95 秒。

切换脚本本身有三条硬规矩（都有测试守着）：

1. **先停旧桥接的看门狗**（`watch-bridge.vbs`），否则它几秒内把旧桥接重新拉起来，两边抢同一个订阅；
2. **只杀别人的消费者**：顺着父子链认「lingcub → node 包装 → lark-cli」，自己的不动；
3. 回滚时打印快照里的旧看门狗启动命令，照着它能一键把旧桥接拉回来。

## 9. 明确不做

- 不做 Electron / 不做远程访问（配置页只在本机）
- 不做「一个应用变多个机器人」（飞书一对一，改不了）
- 不做改话题名（无接口）
- 不绕过 Claude Code 权限系统（`deny` 规则优先于任何 hook 返回）
