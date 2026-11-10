# 交接提示词：继续开发「幺幺零 · Lingcub」

> 用法：整段复制到新开的工作窗口（建议 Claude Code / DSH，cwd = `E:\Develop_E\lingcub`）。

---

你现在的工作目录是 `E:\Develop_E\lingcub`。

## 起手五件事（必须先做，别跳过）

1. 读本文件**第五节「背景读物与参考项目」**——它决定了你后面为什么这样写
2. 读 `AGENTS.md`
3. 按序读 `../design/principles.md` → `../design/domain-model.md` → `../design/plugin-contract.md` → `../design/routing.md` → `../runtime/executors.md`
4. 读 `docs/tasks/INDEX.md`（已有 3 条任务台账）与 `docs/tasks/README.md`（台账规范）
5. 跑 `pnpm install && pnpm build && pnpm test && node dist/main.js doctor && node scripts/check-docs.mjs`
   预期：build exit=0、10 个测试全过、doctor 打印 2 个工作区、文档自检通过。**结果不符就先停下报告，不要往下写代码。**

---

## 一、背景：这是什么，为什么做

**一句话**：你的 AI 调度台 —— 消息进，任务出，结果回来。

产品负责人（AI 产品经理，同时在带公司项目与多个个人项目）每天从钉钉群、飞书私聊、飞书文档评论里收到大量需求与问题。现状全靠人肉：人肉判断哪条值得做、人肉开 Claude Code 窗口、人肉盯进度、人肉写回执。这个系统要把这条链路自动化。

**唯一入口是飞书**：他给机器人发消息，结果回到飞书。

### 四个真实场景（这就是验收用例）

1. 群里有人报 bug → 判出「这是开发任务」→ 起 Claude Code 会话去公司仓库修 → 完成后回一条带摘要与改动清单的飞书消息
2. 他发「帮我分析下今天群里的消息」→ 不起会话，直接回一份分析
3. 飞书文档里有条待办 → 认领 → 起会话做 → 完成回写文档、更新待办状态
4. 他问一个技术问题 → 直接回答，不派工

### 前身：已经做过一版，知道坑在哪

`E:\Develop_E\feishu-bridge-claude`（本机已有，不是 fork）是这条路的第一次尝试，
已经跑在生产上，解决的是**通道问题**：

- `lark-cli event consume` 长驻，接飞书 IM 事件
- 每个 Claude Code 窗口在飞书群里有一棵话题，话题里打字就是给它发消息
- 用命名管道把消息跨会话投进去，窗口执行中也能收进输入队列
- Stop hook 把结果回成飞书卡片
- 会话状态用一张常驻卡片原地 patch，不产生未读

**它缺的正是 lingcub 要补的那一层**：`route.js` 把「收到消息」直接等同于「开一个窗口」，
没有「这条消息该不该干活、该干什么、用什么执行器」的判断。于是：

- 所有消息一视同仁，闲聊也开会话
- 判断逻辑散在路由代码里，没法回放、没法算准确率
- 只支持 Claude Code 一种执行器
- 没有入站幂等，同一条消息重投会重复开窗口

**所以 lingcub 不重写通道，只在通道之上加一层可回放、可测试的判断与分派。**
新窗口遇到通道细节（lark-cli 怎么起、事件怎么消费、命名管道怎么投），
直接去读 `E:\Develop_E\feishu-bridge-claude` 的实现，不要重造。

### 明确不做

- 不做多 agent 聊天室
- 不做通用工作流引擎
- 不替代 Claude Code / DSH —— 它只是**调度器**，干活的是那两个 CLI

---

## 二、已完成的部分（可信起点，别推倒重来）

24 个文件、415 行 TS，已实测：

| 检查 | 结果 |
|---|---|
| `tsc -p tsconfig.json` | exit=0 |
| `node --test` | 10 passed / 0 failed |
| `lingcub doctor` | exit=0，打印 2 个工作区、2 个启用来源 |
| `node scripts/check-docs.mjs` | ✔ 链接可达、3 行台账合规、3 份任务文档字段齐全 |
| 门禁变异反证 | worktree root 改到 `D:\elsewhere` → exit=1「不在允许根内」；还原 → exit=0 |
| 文档自检变异反证 | 任务 ID 改错一字 / 概述撑到 188 字 → 均 exit=1；还原 → exit=0 |

已落地：

- `docs/design/` 四篇设计 + `docs/runtime/` 两篇（执行器、会话与窗口）+ `docs/platform/contracts.md`，
  外加 `comparable-projects.md`（18 个参考项目）
- `config/{lingcub,projects,rules}.yaml`
- `src/domain/types.ts`（Event / Intent / Work / Action / Progress）、`src/domain/ports.ts`（四端口）
- `src/kernel/ids.ts`（内容派生 id，长度前缀编码）、`src/kernel/config.ts`（zod 校验 + allowRoots 门禁）、`src/kernel/registry.ts`（插件发现与装配）
- `src/main.ts`（`lingcub doctor`）
- 文档体系：`docs/README.md`（文档索引）、`docs/tasks/{README.md, INDEX.md, 202611/}`（台账 + 3 条任务）、
  `CHANGELOG.md`（0.1.0）、`scripts/check-docs.mjs`（规范自检）；`AGENTS.md` 已写入文档分工表与台账触发规则

**尚未实现**：store、outbox、routing、任何插件。`src/plugins/` 是空目录。

---

## 三、五条不可违反的原则

1. **内核编排、插件实现**：`src/kernel`、`src/domain`、`src/routing` 不得 import `src/plugins/*`
2. **一切外部副作用走 outbox**：起会话、发消息、写文档，全部先落库再投递
3. **模型只做分类，路由代码查表**：模型答「是什么」，代码定「怎么办」
4. **默认 `observe`**：只记录不动手；升档必须先用回放验证准确率
5. **配置即事实**：路径、人名、仓库名只出现在 `config/*.yaml`

---

## 四、你的任务（按顺序做，每批跑验证再继续）

### P0 文档体系与台账 —— **已完成，不要重做**

`docs/README.md`、`docs/tasks/{README.md, INDEX.md, 202611/}`、`CHANGELOG.md`、
`scripts/check-docs.mjs` 都已建好，`AGENTS.md` 已含文档分工表与台账触发规则。

你要做的只有：**开工前**把 `docs/tasks/INDEX.md` 里对应那行的状态改成「进行中」，
**完工后**改成真实阶段并更新概述（≤150 字，覆盖写，不追加）。台账编号与命名规则见
`docs/tasks/README.md`，不要另立一套。

工作期间守这五条纪律（来自参考项目，别简化）：

1. **每份文档只写自己那一格**：写新内容前先判断属于哪一格，不往入口文件继续堆。
2. **规则只在一处维护，别处只放链接**。理由原话：*两份规则一定会漂移*。
3. **台账细节只在 `docs/tasks/README.md`**，`AGENTS.md` 只放「开工前先检索台账」这个动作和链接。
4. **CHANGELOG 一次提交 = 一个小版本**：提交前看暂存 diff 写条目，与提交同批落盘；
   写用户视角，标签只有 ［新增］［优化］［修复］。
5. **改完文档跑 `node scripts/check-docs.mjs`**：查链接可达、头部字段齐全、概述 ≤150 字、规则单一来源。

---

### P1 内核：store + outbox + routing

- `src/kernel/store.ts`：用 `node:sqlite`（Node 24 内置，不装包）。表：`events`（id 主键，`INSERT OR IGNORE`）、`intents`、`works`、`outbox`（`dedupe_key` 唯一；status: pending/dispatched/done/dead；attempts）。迁移用 `PRAGMA user_version` 顺序执行。
- `src/kernel/outbox.ts`：`enqueue(action, dedupeKey)`、`tick()`（取 pending → 调对应插件 → 标 done；失败 attempts+1，超过 3 次标 dead 并告警）
- `src/routing/rules.ts`：读 `config/rules.yaml`，按序求值，**首个命中即停**。谓词：`channel` / `atMe` / `groupIn` / `peopleIn` / `textMatches` / `always`。命中产出 Intent（`byRule` 有值）
- `src/routing/resolve.ts`：`Intent.project` → `projects.yaml` workspace → 校验 `allowRoots` → 产出 Work
- 单测覆盖：幂等（同 Event 插两次只 1 行）、outbox 去重（同 dedupeKey 只发一次）、规则命中即停、门禁拒绝

**验收**：`pnpm build && pnpm test` 全绿，上述四条各有测试。

### P2 插件（一个目录一个插件，各挂 `index.ts`）

- `source-dingtalk`：`dws event consume` 长连接，映射成 Event
- `source-feishu-im`：`lark-cli event consume im.message.receive_v1`
- `classifier-llm`：单次 headless 调用（`dsh --profile headless --json` 或 `claude -p --json-schema`），输入 `prompts/classify.md` + 消息文本 + 候选项目列表，输出 Intent JSON。**不做常驻会话**
- `executor-claude`：`claude --bg --permission-mode bypassPermissions --max-budget-usd <n> --max-turns <n> -p "<prompt>"`，cwd = `workspace.root`；用 `claude logs` / `claude stop` 观测与止损
- `executor-dsh`：`dsh --profile headless --json --session-id <id>`，cwd = worktree
- `channel-feishu`：发消息 / 卡片，按 dedupeKey 幂等

**验收**：`lingcub doctor` 能发现并校验全部插件；一个 fake 端到端测试（假 Event → 假 Classifier → 假 Executor → 假 Channel 收到一条），全过程不触网。

### P3 replay 回放

`scripts/replay.ts`：读历史 Event，重跑规则 + 分类，输出每条 Event 的 Intent 与人可标注的表格。
这是从 `observe` 升到 `suggest` 的前置：抽检 50 条、准确率 ≥90% 才允许升档。

---

## 五、背景读物与参考项目（开工前先读，别凭想象设计）

### 5.1 同源项目（最该先读）：DeepSeek Harness 团队的 Super-agent

- **文章**：[Super-agent 设计探索：迈向更自主的 Agent 系统](https://zhuanlan.zhihu.com/p/2099987320443237060)
- **代码**：[deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)
- **本机**：`C:\Users\Yue\dsp-git`（已 clone，直接读，不用联网）

这不是「社区参考」，是**同族最权威的实现**：本项目跑在 DSH 上，DSH 团队自己做
「事件驱动 + 多任务 + 人退到上一层」的设计，就在这一份里。

#### 它的问题设定（和我们一模一样）

> Agent 的工作模式仍以单一 Session 为基本单位，不同 Session 彼此独立。
> 一个人通常只能同时跟进 3 到 5 个活跃 Session。
> **单任务的上限取决于模型能力，多任务的上限取决于人的注意力。**

它的答案是 Super-agent，四个特征：**连续**（IM 与 GitHub 评论像同一个 agent）、
**高效**（并行多任务）、**主动**（持续观察，该出手才出手）、**持久**（始终在线、能自愈）。

#### 双层架构（本项目的五层模型就是在它上面具体化）

| 它的设计 | 本项目对应 |
|---|---|
| **Router 层**：常驻，承接人类交互、维护全局记忆与分派，只分派不干活 | `src/routing/` + `Intent` 层 |
| **Worker 层**：上下文隔离，各挂完整工具并发执行，**不直接对用户说话** | `Work` + `Executor`，结果经 outbox 回传 |
| **事件过滤**：Fast Path（程序策略）/ Slow Path（LLM 语义） | 三级漏斗：`rules.yaml` → 一次模型调用 → 不确定只记录 |
| **事件路由**：已订阅 Thread 的事件**直发 Worker，不再绕 Router** | 暂不做（单人场景，每条消息都过一次判断，可回放更重要） |
| **计算与状态分离**：会话是可丢弃的计算，状态在存储里 | `Event`/`Work` 落 SQLite，会话可随时重开 |
| **Watchdog**：外部看护、异常自愈 | 暂不做（P2 之后再议） |

#### 它的哲学（几乎逐条变成了本项目的原则）

`C:\Users\Yue\dsp-git\docs\000-philosophy.md` 原文：

> **Take as little human attention as possible, and give as much value as possible.**
> It acts only when asked, or when a written rule allows it.
> Work nobody asked for needs a rule the team wrote, **and starts in a mode that only records what the agent would have done.**
> Few concepts. Few settings. Documents read in order.

→ 「只记录不执行」就是本项目的 `observe` 模式；「Few concepts」就是
`../design/principles.md` 的「内核编排、插件实现」；「Documents read in order」就是按组读文档的
来历——本项目的文档分组直接学自这里（早期用 `000`–`006` 编号，2026-11-09 改为按组分类）。

#### 要抄的与不要的

**要**：

- `docs/` 按组分类的文档体系（它用 `000`–`007` 编号，我们改成 `design/`、`runtime/`、`platform/`、
  `reference/`、`tasks/` 五组，顺序写在每组 `README.md` 里）
- Source 契约 + **幂等三件套**：内容派生 id / 脏游标 / 出站标记
- prompt 分段与 policy 注入：`src/policy.ts` 的 `maxWorkers: 3`、`src/dsh.ts:207` 的执行器调用、`src/dsh.ts:24` 的会话 id 规则 `worker-<ticketId>`
- 「Router 只分派、不干活」这条边界

**不要**：

- **常驻 Router 会话**。它靠一个长期活着的 Router 维持全局记忆；本项目改成
  「每次判断是一次独立 headless 调用，记忆在 SQLite」，代价是多一次冷启动，
  换来的是**每条消息的判断都能回放、能算准确率**。这是本项目最重要的一处有意偏离。
- **提前行动 / 投机执行**。它会在有人开口前先动手；本项目默认 `observe` 只记录。
- **Thread 订阅直通**。它为「一个仓库一个团队」设计；本项目是单人，优先保证判断层可测。

#### 一句话定位差异

> dsh-superagent 是「一个仓库的主动 coding agent」；
> lingcub 是「多源消息 → 多执行器」的调度台。
> 前者把「怎么干活」做到了极致，后者要先解决「这条消息该不该干活」。

---

### 5.2 其余三篇知乎文章（补充视角）

**① [Claude Code Dynamic Workflows（UltraCode）深度研究](https://zhuanlan.zhihu.com/p/2053431404428636713)**
最重要的一篇。核心论点：

Anthropic 做 Dynamic Workflows 是为了解决单智能体的**三重结构性失败**：

- **agentic laziness**：长任务里完成一部分就宣告完成（内部评估：50 项审查平均只做 35 项）
- **self-preferential bias**：自己验证自己的产出时系统性宽容
- **目标漂移**：多次上下文压缩后丢失原始目标

解法一句话：**把调度逻辑从模型上下文里剥离，固化成可执行的代码**。

→ **这正是本项目的核心设计**。`../design/principles.md` 里「模型只做分类，路由是代码 + 表」
和「每次判断是一次独立 headless 调用、记忆在 SQLite 不在会话里」，就是这条论证的直接落地。
写代码前读一遍，能省掉很多「为什么不让模型自己决定下一步」的争论。

它同时给了**代价清单**，本项目据此设了防守：

| 文章的代价 | 本项目的防守 |
|---|---|
| token 约为普通会话的 15 倍 | 三级漏斗，规则先挡掉大部分，模型只兜底 |
| 协调开销税 | 并发上限 2，不做大规模并行 |
| 错误放大（独立架构可达 17.2 倍） | 默认 `observe`，升档要回放 50 条 ≥90% |
| 人类弱参与时结果漂移 | `suggest` 档必须人工确认 |

**② [Claude Code 多 Agent 并行完整技术指南](https://zhuanlan.zhihu.com/p/2057216454588683953)**
把并行能力分三层：SubAgent（有限并行、只向上汇报）/ Dynamic Workflow（脚本编排、完全并行）/
Agent Teams（多实例集群、双向通信 + 共享任务列表）。

→ 本项目**刻意不用 Agent Teams 做常驻**。每多一层自主编排，可复现性就少一分；
我们要的是「每条消息都能回放、能算准确率」，不是「一群 agent 自由发挥」。

**③ [feishu-claudecode：飞书 bot 和 Claude Code 的无缝连接](https://zhuanlan.zhihu.com/p/2003604523235698469)**
同款竞品：飞书 bot 直连本机 Claude Code，以 `bypassPermissions` 运行。
另有 [cc-connect 配置教程](https://zhuanlan.zhihu.com/p/2038044804798490294) 做了 Claude Code + Cursor 的统一远程控制。

→ 它们的共同点：**只管通道，不管判断**。消息进来直接喂给一个常驻会话，
没有「这条消息该不该干活」这一层。lingcub 的差异就在这一层，别把那层退化掉。

### 5.3 开源项目（抄结构，不抄代码）

| 项目 | 抄什么 | 为什么不直接用 |
|---|---|---|
| [sortie-ai/sortie](https://github.com/sortie-ai/sortie) | **两段式 YAML（`tracker` / `agent`）**、`query_filter`（= 什么算需求）、`handoff_state`（= 完成回写） | 输入是结构化 issue；写死 claude-code；无统一人机入口 |
| [Untrivial-ai/agent-orchestrator](https://github.com/Untrivial-ai/agent-orchestrator)（~12.2k star） | worktree 隔离、看板、review 回路 | 输入是代码任务而非多源消息；无飞书/钉钉 |
| [frumu-ai/tandem](https://github.com/frumu-ai/tandem) | **审批点与审计设计**（正好补「默认 observe」） | 面向企业治理，重 |
| [MikeeBuilds/Squadron](https://github.com/MikeeBuilds/Squadron) | 多执行器统一视图、会话看板 | 桌面应用形态，非消息驱动 |
| [mlund01/squadron](https://github.com/mlund01/squadron) | 声明式定义 agent / tool / task graph | 无消息接入层 |
| [jubbydev/tandem](https://github.com/jubbydev/tandem) | 「与一个 agent 对话来协调其他 agent」的交互形态 | 生态绑定 |
| [Picrew/awesome-agent-harness](https://github.com/Picrew/awesome-agent-harness) | 赛道目录，持续跟踪，避免重复造 | 仅索引 |

完整的 18 个项目、命名冲突排查与待复核项在 `../reference/comparable-projects.md`，选型前读它。

### 5.4 本机可直接读的源码（别重造轮子）

| 位置 | 有什么 |
|---|---|
| `E:\Develop_E\feishu-bridge-claude` | 通道层完整实现：lark-cli 事件消费、跨会话命名管道投递、Stop hook 回传、wt 拉起窗口 |
| `C:\Users\Yue\dsp-git` | 见 5.1，同源项目源码，不要重复造 |
| `dsh --profile headless` | 一次性任务调用方式，分类器与 dsh 执行器都用它 |
| `claude --bg` | 原生后台会话 + `logs` / `attach` / `stop`，claude 执行器用它 |

### 5.5 否决过的方案（别再提）

- **fork `dsh-superagent` 改造**：目标不同——它是「一个仓库的主动 coding agent」，我们是「多源消息调度台」；
  再加不变量区 7380 行 vs 可改区 2897 行，四条需求里三条正打在不变量上。抄它的模式，不抄它的实现。
- **直接改 `feishu-bridge-claude`**：它的 `route.js` 把「收到消息」等同于「开窗口」，
  这个前提本身就是要改的东西，在里面加判断只会越缠越乱。
- **用 n8n / Dify 之类工作流引擎**：判据是「消息 → 意图」这一步必须模型来做，
  而模型输出必须落成可回放的表；工作流引擎的编排能力在这里是负担不是助力。

---

## 六、环境事实（已实测，别再踩一遍）

- Node v24.12.0 / pnpm 11.7.0 / claude 2.1.317 / dsh 0.2.1-rc.5 / dws 1.0.66 / lark-cli 1.0.98；`gh`、`tmux`、`uv` 均未安装
- **公司工作区是伞形**：`E:\Develop_E\tt\tt-design-space-ai` 下挂 51 个子仓库。74 个历史 claude 会话的 cwd **全部是伞根**，靠 `workspace/REPOSITORY-ROUTER.md` 自己定位子仓库。→ **不要给子仓库单独起会话**，会切断历史连续性。公司侧并发固定 1、每任务一会话
- claude 单个历史会话可达 135MB → 禁止 resume 大历史，`freshSession: true`
- dsh headless 默认 `workspace-write` + approval ask，无客户端时 fail-closed（直接拒，不是挂住）→ 自动化必须显式 `danger-full-access`
- `dsh --session-id` 续跑要求 cwd 完全一致，且不能是 subagent / fork 会话
- 飞书 `im.*` 事件 AUTH=bot，**只能收到「用户私聊机器人」和「机器人在群里」**，看不到人与人聊天
- 同一订阅**不得并行起第二个 daemon**（官方帮助原文：会让云事件被随机切分）。已有 daemon 在跑，复用不新建
- Windows 下 MSYS 路径 `/e/...` 传给 node 会解析成 `C:\e\...`，一律传 `E:\...`

---

## 七、Git 与远程仓库

- 仓库已初始化：分支 `main`，remote `origin` = `git@github.com:Dec27-Lee/lingcub.git`
- 提交身份由 `C:\Users\Yue\.gitconfig` 按 remote 自动切换，实测解析为 `Dec27-Lee <lipengyue31@163.com>`（与仓库 owner 一致）。**不要改动全局 git config**
- 提交信息用 Conventional Commits：`feat:` / `fix:` / `test:` / `docs:` / `chore:` / `refactor:`
  这是个人 GitHub 仓库，**不要**用公司的 `[A][任务编号]` 格式
- 节奏：**一批一提交**（P1 一个 commit、P2 一个 commit），提交后汇报，**等产品负责人确认再 `git push`**
- 已在 `.gitignore` 中排除 `node_modules/`、`dist/`、`data/`、`*.log`、`.env`；`pnpm-lock.yaml` 要提交
- 不 force push，不改写已推送历史，不 `git add -A` 盲提交（先 `git status -s` 核对）

---

## 八、工作方式

- 最小改动；不重构没出问题的代码；不加用不到的抽象
- 报「通过」前必须真跑 `pnpm build && pnpm test`，不许推断
- 新增规则做**变异反证**：故意改坏一处，测试必须红；红了才算有判据
- **不碰** `E:\Develop_E\tt\tt-design-space-ai`（公司仓库），只读其中的索引文件
- 不 fork `dsh-superagent`（不变量区 7380 行 vs 可改区 2897 行，四条需求里三条正打在不变量上）
- 只清理因本次改动而失效的代码，不顺手改相邻代码
- 改动文档后跑 `pnpm docs:check`；它红了就是文档不合规，别绕过

---

## 九、汇报格式

每批结束只报四件事：**改了什么 / 实测（贴命令与结果）/ 变异反证 / 下一批**。不写排查过程。

---

## 十、第一个动作

读完、跑完 doctor，**先回报起点是否绿**，等确认后再动 P1。
