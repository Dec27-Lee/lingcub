# 幺幺零 · Lingcub

> 你的 AI 调度台：**有问题就呼叫，呼了有人接。**

一个入口（飞书）收所有来源的消息，判断哪些要干活，把活派给合适的 AI 开发会话，
再把结果送回来。调度一切，自己不干活。

## 它解决什么

散落在钉钉群、飞书私聊、文档评论里的需求，现在要人肉判断、人肉开窗口、人肉盯进度。
Lingcub 把这条链路自动化：**消息 → 判断 → 派工 → 回执**。

## 四条原则

1. **内核编排，插件实现**：源 / 频道 / 执行器 / 分类器 / 场景 / 文档 / 能力七类角色，插件之间零耦合。
2. **一切外部副作用走 outbox**：可重试、可去重、崩溃不丢；结果通过收据与 `effect.done/failed` 回总线。
3. **模型只做分类，路由由代码查表**；能确定性算的，不交给模型。
4. **默认 observe**：先记录，后执行；执行要人确认。

## 快速开始

```bash
pnpm install
pnpm build
pnpm test
node dist/main.js doctor
```

配置在 `config/`，设计在 `docs/`。先读 `docs/000-principles.md`。

## 代码目录架构

依赖方向严格单向：`src/domain` ← `src/kernel` / `src/routing` ← `src/plugins`。
**内核（`src/kernel`、`src/domain`、`src/routing`）不 import 任何 `src/plugins/*`**；
插件也不互相 import，共用代码只放 `src/plugin-kit/`。

```text
src/
  domain/          纯类型与契约，零 IO
    types.ts          Event / Intent / Work / Session / Action
    ports.ts          Source / Channel / Executor / Classifier / DocPort 接口
    events.ts         能力效果、事件处理器类型
    plugin-v2.ts      清单 v2、PluginContextV2、七类角色
    capability-names.ts  能力命名与效果家族规则
    card-action.ts    卡片回调载荷
    doc-*.ts          文档待办 / XML / 写回计划（纯函数）
    workstation.ts    工作站快照聚合

  kernel/          稳定内核：总线、注册表、存储、发件箱、策略
    event-log.ts      持久事件总线 + 订阅游标（至少一次、按 kind 顺序）
    capabilities.ts   能力注册表：call / submit / 收据
    outbox.ts         发件箱：重试、退避、死信
    receipts.ts       发件箱终态 → 收据 → effect.done / effect.failed
    policy.ts         三档策略闸（observe / suggest / auto）
    effect-router.ts  能力 → 发件箱动作
    pipeline.ts       旧编排器：命令/卡片/开窗/投递的历史路径（当前 bus 档下消息已交给 v2 场景）
    runtime.ts        常驻主循环、钩子服务、装配
    source-start.ts   启动旧 sources 与 v2 插件注册的 Source
    session-start.ts  起会话 / 改绑会话
    store.ts          SQLite：事件、订阅、会话、工作、收件箱、收据
    kernel-capabilities.ts  内核内置能力
    config.ts / config-schema.ts / config-alias.ts  配置与 v2 配置段解析
    wiring.ts / registry.ts  插件发现与端口装配
    hook-server.ts / hook-handlers.ts / hook-events.ts  Claude Code 钩子
    plugin-v2/        清单校验、能力图、控制权、切换检查

  routing/         确定性路由
    rules.ts          规则匹配
    resolve.ts        工作区解析（项目/路径/别名）
    commands.ts       命令解析
    session-route.ts  话题/消息 → 会话
    auto-reply.ts     自动回复策略

  plugins/         全部可替换的插件（见下一节）
    source-*/         来源
    channel-*/        频道
    executor-*/       执行器
    classifier-*/     分类器
    scenario-*/       场景
    capability-doc-*/ 文档端口

  plugin-kit/      插件共用工具（不参与插件发现，不依赖 kernel/plugins）
    spawn / template / json / map / pick / restart / feishu-cards

  desktop/         工作站面板
    server.ts         HTTP 服务 + 工作站页面/API

  main.ts          CLI：doctor | run | ui | hook
config/            事实来源：项目、规则、执行器策略、插件开关
scripts/           自检、切换、自启、文档检查
test/              离线测试（node --test）
docs/              目标、原则、契约、任务台账
data/              运行数据（库、日志、图片、钩子端点）
```

### 一条消息怎么流动

```text
Source（钉钉/飞书/卡片）
  → event_log（message.received / card.action）
  → 场景插件订阅并判断
  → ctx.submit(能力) → 收据 + outbox
  → effect-router → deliver（执行器/频道/文档）
  → effect.done / effect.failed
  → 场景再消费结果（回执、通知）
```

旧 `Pipeline` 仍承担未迁移的路径（尤其是开窗/新话题）；v2 场景与它通过
`config.control` 的控制权开关互斥，避免同一条消息双回。当前生产已是
`control.status/stop/new=scenario`、`control.messages=bus`。

## 插件分类与已实现清单

七类角色，来自 `src/domain/plugin-v2.ts` 的 `PLUGIN_ROLES`：

| 角色 | 职责 | 典型接口/能力 |
| --- | --- | --- |
| `source` | 把平台事件变成领域事件 | `Source` 端口；发 `message.received` |
| `channel` | 发消息、卡片、图片、传输层回执 | `Channel` 端口；`notify.*`、`transport.*` |
| `executor` | 起会话、读进度、投递、停止 | `Executor` 端口；`session.*` |
| `classifier` | 只做分类，产出 `Intent` | `judge.classify` |
| `scenario` | 业务编排：命令、派工、回执、文档待办 | 订阅事件 + 提交能力 |
| `doc` | 文档读写端口（飞书 docx / 内存） | `DocPort`；`doc.write`、`state.doc.snapshot` |
| `capability` | 只提供能力，不订阅事件 | `ctx.provide` |

### 安装、启用与生效

三件事分开：

1. **安装**：在 `src/plugins/` 放一个插件目录（清单 + `setup`），`pnpm build` 后出现在 doctor 的「已安装插件」里。
   没有配置段也算已安装，只是停用。
2. **启用**：在 `config/*.yaml` 写配置段并设 `enabled: true`。没配置段 = 停用；
   配置段写了 `enabled: false` = 装上但停用。
3. **生效**：清单可声明 `activation`：
   - `restart`（默认）：改启停后重启进程；
   - `hot`：只允许无事件订阅的纯 `capability` 插件声明；运行时监听 `data/local.json` 变更，开启/关闭即时加载/卸载，不需要重启。

`node dist/main.js doctor` 会打印：
`已安装插件 N 个：启用 …，停用 …`，停用的插件也在列表里。

### 来源（source）

| 插件 | 版本 | 做什么 | 怎么用 |
| --- | --- | --- | --- |
| `source-dingtalk` | v1 | `dws event +listen-im --kind all-direct -f ndjson`，把钉钉单聊消息归一成事件 | `sources.dingtalk-im`；字段映射在 `fields` |\n| `source-dingtalk-at` | v1 | `+listen-im --kind at-me`，群聊 @我 | `sources.dingtalk-at` |\n| `source-dingtalk-group` | v1 | `+listen-im --kind all-group`，全部群消息 | `sources.dingtalk-group` |\n| `source-dingtalk-sent` | v1 | 轮询 `chat message list-all`，按 `senderId=self` 取出站消息（非事件推送） | `sources.dingtalk-sent`；`selfId` 必填 |
| `source-feishu-im` | v1 | `lark-cli event consume im.message.receive_v1`，收飞书 IM | `sources.feishu-im` |
| `source-feishu-card` | v1 | 消费 `card.action.trigger`，旧卡片回调进 `Pipeline` | `sources.feishu-card`；与 v2 卡源二选一 |
| `source-feishu-card-v2` | v2 | 同上，但发类型化 `card.action` 事件，给场景消费 | `plugins.feishu-card-v2` + `control.messages=bus` |

### 频道（channel）

| 插件 | 版本 | 做什么 | 怎么用 |
| --- | --- | --- | --- |
| `channel-feishu` | v1 | 发文本、卡片、传输层回执、下载图片；卡片渲染在插件内 | `channels.feishu`；`dryRun: true` 可预演 |
| `channel-dingtalk` | v2 | 只注册 `transport.dingtalk.send` 回执；事件消费交给 `source-dingtalk` | `plugins.dingtalk`（`enabledO2o/Group: false`） |

### 执行器（executor）

| 插件 | 版本 | 做什么 | 怎么用 |
| --- | --- | --- | --- |
| `executor-claude` | v1 | `claude --bg` 后台会话；`logs/stop` 观测与止损；`--resume`；读 `~/.claude/sessions` 投递 | `executor_policies.claude`；需 `allowRoots` 与预算 |
| `executor-dsh` | v1 | `dsh --profile headless --json -` 起会话；post 追加一轮；列历史/活会话 | `executor_policies.dsh`；需 `allowRoots` |
| `executor-claude-v2` | v2 | 消费 `session.open.requested`：terminal 走 VBS+wt 开窗并等 SessionStart；headless 走 `--bg` | `plugins.claude-v2`；`terminal: true/false` |
| `executor-dsh-v2` | v2 | 消费 `session.open.requested`；dsh 没有预设 session id，只支持 headless | `plugins.dsh-v2` |

> 旧 `executor_policies` 仍指向 v1 插件，保证旧 Pipeline 过渡；新开窗链路走 v2 事件执行器。

### 分类器（classifier）

| 插件 | 版本 | 做什么 | 怎么用 |
| --- | --- | --- | --- |
| `classifier-llm` | v1 | 用 dsh headless 跑 `prompts/classify.md`，产出 `Intent`；低于 `minConfidence` 只记录 | `classifiers.llm` |

### 场景（scenario）

| 插件 | 版本 | 订阅/控制权 | 做什么 | 怎么用 |
| --- | --- | --- | --- | --- |
| `scenario-console` | v2 | `on: message.received / session.ask.requested / session.permission.requested / card.action`；`owns: status/stop/new` | 控制台命令：`#status`、`#stop`、`#new`、`#help`、`#resume`、`#attach`、`#pin/#unpin`；选择题/权限卡 | `scenarios.console`；需把 `control.status/stop/new` 切到 `scenario` |
| `scenario-dev-dispatch` | v2 | `on: message.received / session.turn.ended / confirmation.requested`；`owns: messages` | 钉钉消息 → 判断 → `task.open` 派工；一轮结束回执给反馈人；建议档确认 | `scenarios.dev-dispatch`（默认关，`project` 必填） |
| `scenario-session-post` | v2 | `on: message.received`；`owns: messages` | 已绑定话题里的普通消息 → `session.post` 追加一轮 | `scenarios.session-post`；`control.messages=bus` |
| `scenario-digest` | v2 | `on: message.received` | `#日报` 按时间窗统计事件并回执 | `scenarios.digest` |
| `scenario-doc-todos` | v2 | `on: message.received`；`owns: messages` | `#待办 <文档>` 列待办；`#认领 <文档> <小节> <序号>` 认领并整节回写 | `scenarios.doc-todos`（默认关） |
| `scenario-feishu` | v2 | 无事件；只提供能力 | `feishu.parse-todos / claim-todo / merge-todos / split-todo / read-doc` 纯逻辑与读正文 | `scenarios.feishu`；能力名受 `feishu.` 前缀约束 |

### 文档端口（doc）

| 插件 | 版本 | 做什么 | 怎么用 |
| --- | --- | --- | --- |
| `capability-doc-memory` | v2 | 内存文档端口，测试/离线用；带 revision 冲突检查 | `plugins.doc-memory` |
| `capability-doc-feishu` | v2 | 飞书 docx：读 markdown/XML；按小节 `block_replace` 写回；revision 冲突检测 | `plugins.feishu-doc`（当前生产已启用） |

## 能力分类

能力由内核与插件注册；调用前先看 `effect`：

- `effect: none`：同步 `call`，只读/纯计算，不进发件箱。
- `effect != none`：只能 `submit`，落收据 + 发件箱，执行结果由 `effect.done/failed` 回总线。
- 命名：内核能力用固定家族（`session.*`、`notify.*`、`doc.*`、`state.*`、`event.*`、`judge.*`、`task.*`、`workspace.*`）；
  插件自提供能力必须以自己的 slug 开头（如 `feishu.*`、`transport.dingtalk.*`）。

### 会话编排（effect=session）

| 能力 | 做什么 | 用法 |
| --- | --- | --- |
| `session.start` | 起一个新会话（不建锚/卡片） | 场景派工、恢复会话 |
| `session.dispatch` | 起会话 + 建锚/就绪卡（旧开窗编排） | `task.open` / 旧 Pipeline |
| `session.post` | 向已有执行器会话追加一轮 | 话题消息投递 |
| `session.stop` / `session.close` | 停止进程 / 关窗口（保留或关闭执行器） | 控制台 `#stop` |
| `session.answer` | 回答选择题/权限确认 | 控制台卡片回调 |
| `session.bind` | 把已有会话行改绑到另一个执行器会话 | `#resume` 选中后 |
| `session.attach` | 把话题接到正在跑的会话；无会话行则新建 | `#attach` |

### 通知与卡片（effect=message）

| 能力 | 做什么 |
| --- | --- |
| `notify.reply` | 回一条文本 |
| `notify.card.send` | 发一张卡片 |
| `notify.card.upsert` | 发/更新常驻状态卡 |
| `notify.card.patch` | 原地改卡片 |
| `notify.card.pin` | 置顶/取消置顶 |

### 文档（effect=doc / none）

| 能力 | effect | 做什么 |
| --- | --- | --- |
| `state.doc.snapshot` | none | 经 DocPort 读 `{revision, markdown}`，写回前拿版本 |
| `doc.write` | doc | 按小节写回；有 `writeSection` 的端口走 block_replace |

### 查询与路由（effect=none）

| 能力 | 做什么 |
| --- | --- |
| `state.session.get / route / list / history / live` | 查会话、按话题找会话、列历史/活会话 |
| `state.workspace.get` | 项目 id → `{root, executor}` |
| `state.question.get` | 查待答问题 |
| `state.workstation.snapshot` | 工作站聚合快照 |
| `workspace.list` | 列执行器可见工作区 |
| `event.query` | 按时间窗/kind 查事件 |
| `judge.classify` | 规则优先，不中再走分类器，产出 `Intent` |
| `task.open` | 解析 Work 并落库；`dispatch: true` 时走开窗编排 |

### 插件提供的能力

| 能力 | 提供方 | 做什么 |
| --- | --- | --- |
| `transport.dingtalk.send` | `channel-dingtalk` | 钉钉传输层回执（本人身份） |
| `feishu.parse-todos` / `claim-todo` / `merge-todos` / `split-todo` | `scenario-feishu` | 文档待办纯逻辑 |
| `feishu.read-doc` | `scenario-feishu` | 读飞书文档 markdown（只读） |

## 事件分类

事件总线是 `event_log`：单条历史、订阅游标、至少一次投递；订阅从当前最大 seq 之后开始。
场景通过 `ctx.on(kind, handler)` 订阅，`manifest.on` 必须先声明。

| 分类 | 事件 | 谁发 | 谁消费 |
| --- | --- | --- | --- |
| 入口 | `message.received` | 各 Source | 场景 |
| 入口 | `card.action` | `source-feishu-card-v2` | 场景（控制台/确认） |
| 会话钩子 | `session.turn.ended` | 运行时（Claude Code Stop 钩子） | 派工场景回执 |
| 会话钩子 | `session.ask.requested` | 运行时（AskUserQuestion 钩子） | 控制台发题卡 |
| 会话钩子 | `session.permission.requested` | 运行时（权限钩子） | 控制台发权限卡 |
| 治理 | `confirmation.requested` | 运行时（suggest 档落确认） | 派工场景 |
| 能力结果 | `effect.done` / `effect.failed` | 收据结算 | 需要结果回执的场景 |

> 规划中、尚未实现：`session.open.requested` / `session.opened` / `session.open.failed` / `session.ready`。
> 这是把「开窗」从内核 `dispatch_session` 移到执行器插件的下一步（见文末）。

## 三条产品链路

### 1. 钉钉消息派工 + 回执

```text
钉钉消息 → source-dingtalk → message.received
  → scenario-dev-dispatch → judge.classify → task.open(dispatch)
  → outbox dispatch_session → executor-claude/dsh 起会话 + 就绪卡
  → Claude Stop 钩子 → session.turn.ended
  → scenario-dev-dispatch → transport.dingtalk.send 回给反馈人
```

启用：`scenarios.dev-dispatch` + `plugins.dingtalk` + `control.messages=bus`；
`suggest` 档会先发建议卡，确认后才执行。

### 2. 飞书控制台

```text
飞书消息/卡片 → source-feishu-im / source-feishu-card-v2
  → scenario-console（#status/#stop/#new/#help/#resume/#attach/#pin）
  → 会话能力 / 通知能力
```

`#resume`：列同工作区历史 → 共享卡片 → `session.start` 带 `resumeSessionId` 与 rebind。
`#attach`：列正在跑的会话 → `session.attach`。
启用：`scenarios.console` + `control.status/stop/new=scenario`。

### 3. 文档待办认领/回写

```text
#待办 <文档> → state.doc.snapshot → parseTodos → 回执列表
#认领 <文档> <小节> <序号> → claimTodo → doc.write（带 revision）→ DocPort block_replace
```

启用：`scenarios.doc-todos` + `plugins.feishu-doc` + `control.messages=bus`。

## 怎么配置与切换

配置只写在 `config/*.yaml`：

- 来源/频道/分类器/执行器：旧段 `sources.*`、`channels.*`、`classifiers.*`、`executor_policies.*`。
- v2 插件：`plugins.*`；v2 场景：`scenarios.*`。**v2 插件必须显式 `enabled: true` 才装配**。
- 控制权：`control.status/stop/new = pipeline|scenario`；`control.messages = pipeline|bus`。
  场景的 `owns` 与开关不匹配时不会装配，避免与旧 `Pipeline` 双回。

切换前：

```bash
pnpm build && pnpm test
node dist/main.js doctor        # 会打印「切换检查」告警
node scripts/preflight.mjs      # 构建、钩子、档位、订阅、能力自审
```

真实切换必须走 `node scripts/switch.mjs --apply` 并带额外确认变量；不要手工改生产配置。
当前生产已于 2026-11-05 切到 bus 档，切换前备份在 `data/local.json.bak-before-bus-*`。

## 当前边界（重要）

- **开窗已事件化（过渡期）**：`session.open` → `session.open.requested` → v2 执行器 `session.opened` → `session.ready`；
  旧 `dispatch_session` 仍保留给未迁移的 `#newwin/#resume` 和旧 Pipeline。
- **执行器双轨**：旧 `executor_policies` 仍指向 v1（`executor-claude`/`executor-dsh`）；新链路走
  `plugin-kit/claude-executor`、`plugin-kit/dsh-executor` 的共享实现。终端开窗已在已信任工作区做过一次真实 smoke（窗口+SessionStart 注册通过）；未信任目录会停在 Claude 的文件夹信任提示。
- **`newTopicPolicy=open` 在 bus 模式下不可用**：当前生产已改为 `judge`；新话题自动开窗要等 P2.6 事件化完成。
- **生产已切 bus（2026-11-05）**：控制台命令、话题投递、卡片回调走 v2；DingTalk `+listen-im` 已连上、transport 已注册；08:09/08:11 两条真实单聊已入站；`dm-is-question` 已改为真实问句匹配，陈述/开发请求继续交分类器。

## 自检

| 命令 | 查什么 | 代价 |
| --- | --- | --- |
| `pnpm build && pnpm test` | 单测 **486 条**：路由、发件箱、能力、插件、钩子、卡片、自动回复、文档、工作站 | 秒级，纯离线 |
| `node --test --experimental-strip-types test/e2e.test.ts` | 离线端到端：假 `lark-cli` + 假 `claude`、真内核 | 秒级，不碰订阅 |
| `pnpm docs:check` | 文档链接、任务台账字段、INDEX 长度 | 瞬时 |
| `node scripts/audit-parity.mjs` | 能力对齐自审：文档里「已实现」的条目是否有代码落点与测试 | 瞬时 |
| `node scripts/verify-contracts.mjs` | 平台契约体检：用不存在的 id 调真 `lark-cli`，只验形状 | 约 30 秒，需已登录 |
| `channels.feishu.dryRun: true` | 预演：命令行写日志、返回假消息 id，不真的调飞书 | 跑一轮真事件 |
| `node scripts/preflight.mjs` | 切换前自检：构建产物、钩子、档位、订阅占用、能力自审 | 约 10 秒，只读 |

真实一轮（会动你的飞书群）只有 `node scripts/switch.mjs --apply` 那条路，它需要额外确认变量，见该脚本头部。

## 目录

| 路径 | 作用 |
| --- | --- |
| `src/domain` | 纯类型与端口接口，零 IO |
| `src/kernel` | 稳定内核：总线、注册表、配置、存储、发件箱 |
| `src/routing` | 确定性路由：规则匹配、决策、工作区解析 |
| `src/plugins` | 全部可替换的插件 |
| `src/desktop` | 工作站面板与只读 API |
| `config` | 事实来源：项目、规则、执行器策略、插件开关 |
| `docs` | 目标、原则、契约、任务台账 |
| `test` | 离线测试 |
