# 平台契约（实测）

下面全是**本机实测**得到的平台事实，不是照官方文档抄的。改任何调用前先读对应那一节；
发现新的平台事实写回这里，不要写进 `AGENTS.md`。

## 按任务读取

| 要做的事 | 读哪节 |
| --- | --- |
| 收发飞书消息、发卡片／改卡／置顶／删消息、处理按钮回调、列工作区候选 | 飞书 |
| 接钉钉事件、停机、多实例互斥 | 钉钉 |
| 在 Windows 上 spawn 命令、全局 CLI 调用报 ENOENT | 子进程 |
| 起 claude 会话、读会话 id、跨会话投递 | claude |

## 飞书（`lark-cli` 1.0.98）

- 收：`lark-cli event consume im.message.receive_v1 --as bot`，无 `--format`，stdout 天然 NDJSON；
  **stdin 必须保持打开**（`stdio[0]='pipe'` 且不关），否则 CLI 见 EOF 立刻退出，表现为「消费进程无限重启」。
- 载荷扁平，16 个顶层键：`type/event_id/timestamp/id/message_id/create_time/update_time/chat_id/chat_type/message_type/sender_id/sender_type/root_id/thread_id/reply_to/content`。
- `chat_type` 是 `group`/`p2p`；类型字段叫 `message_type`（不是 `msg_type`）；`create_time` 是 13 位毫秒字符串。
- 发送者只有 `sender_id`（`ou_` open_id）+ `sender_type`，**没有 user_id、没有 name**。
- `content`：text 是纯文本（不再套 JSON）；post 是带换行的 markdown；image 是 `{"image_key":"img_…"}` 字符串。
- **没有 `mentions`**：事件里判断不出「是否 @ 了我」，`atMe` 只能留空让规则不命中，不许猜成 true。
- 发：`lark-cli im +messages-send --as bot --chat-id <oc_> --msg-type text --content '{"text":"…"}'`。
  收是纯文本、发要套 `{"text":…}`，别统一「再解一层」。**无幂等键参数** → 去重只能靠 outbox 的 `dedupe_key`。
- **一次性命令的输出是多行美化 JSON**（不是 NDJSON）：取 `message_id` 要按整体 JSON 解析，
  按行解析永远拿不到（实测踩过：卡发出去了但话题绑不上）。
- 卡片：`--msg-type interactive --content <卡片 JSON>` 发，`im messages patch --data '{"content":"<卡片 JSON 字符串>"}'` 改；
  置顶 `im pins create --data '{"message_id":"…"}'`，**取消置顶必须带 `--yes`**（属 high-risk-write，不带直接被拒）。
- 删消息：`im messages delete --message-id <om_> --yes`。
- **卡片按钮回调是独立订阅**：`lark-cli event consume card.action.trigger --as bot`；
  载荷形如 `{type:'card.action.trigger', event_id, operator_id, message_id, chat_id, action_tag, action_value}`，
  **没有 thread_id** —— 话题信息必须由按钮的 `value` 自己带上。
- 工作区候选不是预设清单：`~/.claude.json` 的 `projects` 键 + `~/.claude/projects/*/*.jsonl` 里最后出现的 `cwd`，
  再按执行器的 `allowRoots` 过滤（参考项目就是这么列的）。

## 钉钉（`dws` 1.0.66）

- 收：`dws event consume <event_key> --flatten -f ndjson`。默认输出 transport envelope（`type/event_type/data/headers`），
  **必须加 `--flatten`** 才拿到稳定顶层业务字段；就绪信号是 stderr 的 `[event] ready event_count=<n> bus_pid=<pid>`。
- 停机用 SIGTERM 或 `dws event stop`，**不要 kill -9**（跳过退订、泄漏服务端订阅）。
- 同一订阅**不得并行起第二个 daemon**（官方帮助：云事件会被随机切分），只有 `--force` 能跳过单实例锁。
- **IM 事件 key（实测 `dws event list --category im -f json`，16 条）**：全部单聊 `user_im_message_receive_o2o_all`、
  全部群 `user_im_message_receive_group_all`、指定单聊/群/发送人 `_o2o`/`_group`/`_user`、@我 `_at`；
  另有 `_reaction_*`、`_read_*`、`_recall_*`、`user_im_group_{updated,member_added,member_exited,disbanded}`。
  **`user_im_message_receive` 不存在**——旧 config 的 key 必然订阅失败（2026-11-04 实测；2026-11-05 已改为 +listen-im）。
- **没有“自己发出”的 IM 事件 key**：`+listen-im` 的 `--kind at-me|sender|group|all-direct|all-group` 全部对应
  `user_im_message_receive_*`（收件方向）；`event list --category im` 也没有 send/outgoing。自己发出的消息
  只能走 `dws chat message list-all` 历史轮询（`source-dingtalk-sent`），这是 DWS/个人事件流的能力边界，
  不是实现选择（2026-11-06 核对 help/event list）。
- 个人 IM 的推荐入口是 `+listen-im`（不是 `event consume`）：全部单聊用
  `dws event +listen-im --kind all-direct -f ndjson`；它对应 `user_im_message_receive_o2o_all`，
  **不接受 `--flatten`**（2026-11-05 实测；加了会报 unknown flag）。输出是扁平 NDJSON，字段按事件
  `message_id/content/conversation_id/sender/sender_open_dingtalk_id/create_time` 读取；私聊没有 `channelType`，
  由来源声明 `fallbackChannelKind=dm`。
- **用户类与群类不能混用**（help 原文）：单聊 all 与群 all 要分别起 consume；用户类共享 `--user`，群类共享 `--group`。
- **`--flatten` 后 13 个字段**（6 个 receive 类完全一致）：`content, conversation_id, create_time, event_id,
  event_time, forward_messages, message_id, quoted_message, sender, sender_open_dingtalk_id, subscribe_id, timestamp, type`。
  `type` 恒等于 event_key，是群/私聊的**唯一**区分依据；payload **没有** `conversationType`、群名、msgtype。
  `event_id` 官方注「可用于去重」；`quoted_message.message_id` 可用点路径取。
- 出站（**只能 `--as user`**：本机 `dws chat bot search` 返回 `robotList: []`，无自建机器人；Bot 仅支持普通群引用，单聊不支持）：
  ```
  dws chat +messages-reply --as user --open-dingtalk-id {{openDingtalkId}} \
    --ref-msg-id {{messageId}} --content "{{text}}" --idempotency-key {{dedupeKey}} -f json
  ```
  `--ref-msg-id`/`--message-id` 二选一，`--uuid`/`--idempotency-key` 二选一；省略 `--group` 时只读定位源会话并核对发送者；
  **幂等键仅 user 支持**；`--wait-delivery` 返回 `deliveryStatus`（未知状态不得重发）；`--ai-tag` 默认 true。
  实测 `--help`：成功时返回 `messageId`（camelCase，不是 `message_id`），另有 `conversationId`/`threadId`/`deliveryStatus`/`idempotencyKey`；`--content` 必填。
  免引用直发用 `dws chat +messages-send --as user --open-dingtalk-id … --text … --idempotency-key …`。
- 错误信封：`error.{category,code,message,reason,retryable,server_error_code,server_key}`；`retryable` 是唯一可编程重试判据。
  回执是**本人身份**发出，误发等于本人发言——业务侧必须有闸门与模板，不用模型自由发挥。

## 飞书（`lark-cli` 1.0.98，文档/待办部分 2026-11-04 实测）

- **成功判据是 `ok == true`（或 exit 0）**，信封 `{ok,identity,data,meta}`，**没有顶层 `code`**；
  按 `code==0` 判会把成功当失败，封装写入类可能因此重复创建。
- 身份：`--as bot` 读**用户资源**（任务、文档）会「空成功」而不是报错；`task +get-my-tasks` / `+search` **只接受 `--as user`**；
  bot 创建的文档归属 bot。权限失败 `error.type=authorization, subtype=missing_scope, code=99991679, missing_scopes[], console_url`。
  **exit code 10 = 高风险确认门禁**（不是错误），不要静默加 `--yes`。
- 文档：读 `docs +fetch --as user --doc {{doc}} --scope full|outline|range|section|keyword --detail with-ids [--doc-format xml|markdown]`；
  写 `docs +update --as user --doc {{doc}} --command str_replace|block_insert_after|block_replace|block_delete|block_move_after|append|overwrite --block-id {{blockId}} --content @file.xml --doc-format xml`；
  建 `docs +create`。块 id 必须先用 `+fetch --detail with-ids` 取，**结构变更后要重取**；多行正文走 `@file`/stdin，别塞命令行。
  **实测（2026-11-04）**：xml 输出每个块都带 `id="doxcn…"`，标题是 `<h1..h9 id=…>`，正文 `<p>`、`<checkbox done="true|false">`、`<ul><li>`；`data.document.revision_id` 为数字。
  `--doc-format markdown` 下 `--detail with-ids` 的请求体 `export_block_id=false`，**拿不到 block id**；要块 id 必须 xml。
  `block_replace` 支持 `--start-block-id/--end-block-id`（同父连续闭区间），不能与 `--block-id` 同用；替换内容按目标父容器结构给（如列表项给 `<li>`）。
  **dry-run 实测**：请求体 `PUT /open-apis/docs_ai/v1/documents/<token>`，body `{command:"block_replace", content, start_block_id, end_block_id, format:"xml", revision_id:<number>}`；区间两端都含。
  `overwrite --doc-format markdown` 可整篇覆盖，但官方声明会丢评论/资源，且目标可能是 Drive 原生 `.md` 而非 docx；docx 不要默认走它。
- 待办：`task +get-my-tasks --as user --page-all --json`、`task +search`、`task +create --idempotency-key`、`task +update --task-id {{guid}}`、
  `task +complete`。`--task-id` 必须是 guid 或含 `guid=` 的 applink，**不接受 `t104121` 这类展示号**。
  scope：`tasks.create/patch/delete → task:task:write`，`tasks.get/list → task:task:read`。

## 子进程（Windows 通病，本机实测）

- npm 全局装的是 `xxx`（sh 壳）+ `xxx.cmd` + `xxx.ps1`；Node 20+ 直接 `spawn('xxx')` 会 **ENOENT**，
  而 `.cmd` 又不允许无 shell 直跑。所以 `plugin-kit/spawn.ts` 先解析壳：指向 `.exe` 用那个 exe，
  指向 `node <script.js>` 就用当前 node 跑脚本，解析不到才原样返回（让真实错误露出来）。
- 别用 `shell: true` 去绕：参数里有 JSON 正文，过一层 cmd 引号就毁了。实测过，会报
  `--content is not valid JSON near byte 2`。

## claude（2.1.317，本机实测）

- `--bg` 与 `-p/--print` 冲突：提示词必须是**位置参数**，不能写 `-p "…"`。
- `--bg` **不接受** `--session-id` 预设；会话短 id 只能从 stdout 的 `backgrounded · xxxxxxxx` 里读。
- `claude logs` / `claude stop` 只认**短 id**；`~/.claude/sessions/<pid>.json` 里存的是**完整 uuid**。
- 跨会话投递：连 `messagingSocketPath` 命名管道 → `{"type":"auth","token":peerToken}` 一行 →
  `{"type":"user","message":{"role":"user","content":"…"}}` 一行 → 400ms 后关闭；
  收端需 `settings.json` 里 `crossSessionInbound: "accept"`。实测投递成功（会话记录里能看到）。

## dsh（0.2.1-rc.5，本机实测 + 源码核对）

- 新任务：`dsh --profile headless --json -`，任务正文走 **stdin**；stdout 是 NDJSON，
  首行 `{"type":"session","sessionId":"session-…","cwd":…}`，末行 `{"type":"final","text":…}`，失败 `{"type":"error","message":…}`。
- 追加一轮：`dsh --profile headless --json --session-id <真实id> -`（同样 stdin）；`--session-id` 只采纳已存在会话，
  未知 id 报 `session "<id>" does not exist`；**cwd 必须等于原会话 cwd**，否则 `recorded in X, not Y`。
- 追加**不幂等**：同一文本投两次就是两轮；并发投同一会话会被跨进程写锁拒绝（SessionAlreadyOwned），不会重复建会话。
- 退出码 0 且出现 `final` 才算成功；缺 `final` 不能当成功。

## 飞书图片与钉钉媒体（2026-11-05 实测）

- 钉钉图片下载：`dws chat message download-media --type mediaId --resource-id <mediaId> --message-id <openMessageId> --open-conversation-id <openConversationId> --output <path> -f json`，返回临时 `downloadUrl`。
- 媒体消息正文：DWS 把媒体消息返回成 `[图片消息](mediaId=…)` 这类占位符，并在后面追加一句
  `注意：如需下载使用dws chat message download-media命令下载`（2026-11-06 实测，`events` 表三条图片消息正文一致）。
  这句是 CLI 写给读输出方的操作提示，不是发送人内容；展示给人和喂给模型前要清掉（`src/plugin-kit/dingtalk-text.ts`）。
- **飞书话题 id 与根消息 id 不是同一个值**（2026-11-06 实测）：话题是 `omt_…`，根消息是 `om_…`；
  `+messages-reply --reply-in-thread` 发新话题时只能拿到根消息 id，用户在话题里说话的事件里才同时有
  `thread_id=omt_…` 与 `root_id=om_…`。所以话题路由必须「先按 thread_id 查、再按 root_id 查」，
 只认其中一个会出现「同一话题被反复当新话题开窗」（`store.findSessionByThread` 已按两列匹配）。
- **按人发消息比按会话发更省事**（2026-11-06 实测）：`im +messages-send --as bot --user-id ou_… --idempotency-key k`
  能直接发给某个人（`--user-id` 与 `--chat-id` 互斥）；反过来先拿 p2p 会话 id 反而卡权限——
  `contact +get-user` 报 `missing_scope: contact:user.basic_profile:readonly`，`contact +search-user` 返回空数组。
  所以重点私聊走 `--user-id`，不去解析 p2p `oc_`。
- **bot 能撤回自己发的消息**（2026-11-06 实测）：`im messages delete --as bot --message-id om_… --yes`，群里与 p2p 都有效；
  真连体检就用「发卡 → 拿 id → 改卡 → 置顶 → 撤置顶 → 撤回」一条链，跑完不留垃圾。
- **飞书卡片 patch 的频率要自己控住**（2026-11-06 实测）：状态卡每 2 秒刷新一次，卡里带「已 3 分 12 秒」这种秒级文案，
  整卡哈希每秒都变 → 会真的每 2 秒 patch 一次。签名前必须把秒级抖动抹平（`stableCardSignature`），否则既撞频率限制也没意义。
- **置顶撤除有两道时间闸**（2026-11-06 实测）：`sessions.staleMinutes`（多久没动静算停）决定「要不要撤」，
  「刚置上不到 5 分钟不撤」只是防抖动保护；实测 1 分钟口径下仍然要等到置顶满 5 分钟才真的撤掉。
- **Claude Code 的项目路径用正斜杠**（2026-11-06 实测，2.1.318）：`~/.claude.json` 的 `projects` 键是 `E:/Develop_E/lingcub`，
  写成 `E:\Develop_E\lingcub` 的条目**不会被认**——预置 `hasTrustDialogAccepted` 因此一直不生效，窗口每次都停在信任确认框。
  写之前先按正斜杠 + 盘符大写归一（`trustKey`）。另：纯文件夹（非 git、无 `.claude`/`.mcp.json`）本来就不弹确认。
- 飞书图片上传：`lark-cli im images create --as bot --data - --file image=<path> --format json`，stdin 传 `{"image_type":"message"}`；`--data '<json>'` 在本机报 `invalid JSON format`，必须走 `--data -`。
- 上传返回 `data.image_key`；飞书群自定义机器人 webhook 卡片可直接使用 `{tag:'img', img_key}`，实测 HTTP 200。
