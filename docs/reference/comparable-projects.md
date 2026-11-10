# 同类项目参考

> 状态：调研存档。**未逐一验证运行**，引用前复核 star、活跃度与实际能力。
> 记录时间：2026-11-03。用途：后续开发选型与抄设计。

## A. 同赛道实现（agent 编排 / 任务派发）

| 项目 | 定位 | 可借鉴 | 不直接用的原因 |
|---|---|---|---|
| [Untrivial-ai/agent-orchestrator](https://github.com/Untrivial-ai/agent-orchestrator) | ~12.2k star。worktree 并行编排 coding agent + 自动 CI + review 反馈 | 多 agent 并行的 worktree 隔离、看板、review 回路 | 输入是代码任务而非多源消息；无飞书/钉钉 |
| [sortie-ai/sortie](https://github.com/sortie-ai/sortie) | issue tracker（GitHub/GitLab/Gitea/Linear/Jira）→ 每条 ticket 起 agent 会话，独立 workspace，并发 4，失败重试 | **两段式 YAML（tracker/agent）**、`query_filter`（= 什么算需求）、`handoff_state`（= 完成回写） | 输入是结构化 issue；写死 claude-code；无统一人机入口 |
| [frumu-ai/tandem](https://github.com/frumu-ai/tandem) | AI agent 与公司之间的授权层：审批点、审计、handoff artifacts | **审批点与审计设计**（正好补我们的「默认 observe」） | 面向企业治理，重 |
| [jubbydev/tandem](https://github.com/jubbydev/tandem) | 本地优先的 agent 协调器 | 「与一个 agent 对话来协调其他 agent」的交互形态 | 生态绑定 |
| [MikeeBuilds/Squadron](https://github.com/MikeeBuilds/Squadron) | 本地 AI agent 指挥中心，把 Gemini/Claude/Codex 当员工管 | 多执行器统一视图、会话看板 | 桌面应用形态，非消息驱动 |
| [mlund01/squadron](https://github.com/mlund01/squadron) | HCL 声明式多 agent 工作流 | 声明式定义 agent/tool/task graph | 无消息接入层 |
| [getwingmanai.com](https://getwingmanai.com/)（`@wingman-ai/gateway`） | 分布式 AI agent gateway，常驻运行时，任意设备接入 | 常驻 runtime + 远程接入的产品形态 | 闭源/商用为主 |
| [RussellCanfield/wingman-ai](https://github.com/RussellCanfield/wingman-ai) | 分布式 AI agent 平台：多 LLM、orchestration/subagents、长期记忆、动态 UI | 长期记忆与编排的组织方式 | 平台化，超出个人工作流需求 |
| [1broseidon/hotline](https://github.com/1broseidon/hotline) | 自托管、任意模型、房间式 agent | 多模型并存 | 无任务派发 |
| [Picrew/awesome-agent-harness](https://github.com/Picrew/awesome-agent-harness) | 该赛道的项目目录 | **持续跟踪用**，避免重复造 | 仅为索引 |

## B. 直接依赖 / 源码可搬

| 来源 | 位置 | 用途 |
|---|---|---|
| dsh-superagent-prototype | `C:\Users\Yue\dsp-git` | Source 契约（320 行）、幂等三件套（内容派生 id / 脏游标 / 出站标记）、prompt 分段与 policy 注入机制 |
| feishu-bridge-claude | `E:\Develop_E\feishu-bridge-claude` | lark event consume、跨会话命名管道投递、Stop hook 回传、wt 拉起 |
| `@deepseek-ai/dsh-sdk-jsonrpc-server` | DSH asar 内 | 程序化建会话：`session/prompt`/`resume`/`wait`/`event` |
| `dsh` headless profile | 本机 | 一次性任务：`dsh --profile headless "task" --json --session-id` |
| `claude` CLI | 本机 2.1.317 | `--bg` 原生后台会话 + `logs/attach/stop`；`-p --output-format stream-json --verbose` |
| `dws` / `lark-cli` | 本机 | 钉钉个人流事件订阅、飞书文档与待办读写 |

## C. 已确认的同类命名（**避免重名**）

`Wingman`（getwingmanai / RussellCanfield / ShipBit）、`Sortie`、`Squadron`、`Workmate`、`DevMate`、`TaskWing`、`AgentNest`、`Weft`、`Conductor`（Netflix）。
**结论：通用英文词在该赛道已饱和，新项目需中文名或加限定词。**

## D. 待复核项

- agent-orchestrator 的 worktree 方案能否迁到 Windows（其 CI 假设为 POSIX）。
- sortie 的 `query_filter` 语义能否映射到「非结构化消息 + 模型分类」。
- tandem 的审批点模型是否适合单人使用（可能是过重治理）。

## E. 同源项目（最权威参照，先读这个）

- **文章**：[Super-agent 设计探索：迈向更自主的 Agent 系统](https://zhuanlan.zhihu.com/p/2099987320443237060)（DeepSeek Harness 团队，2026-10-31）
- **代码**：[deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)
- **本机**：`C:\Users\Yue\dsp-git`（已 clone）

文章要点：Super-agent 四个特征（连续 / 高效 / 主动 / 持久）；双层架构——常驻 Router 只分派、
Worker 上下文隔离并发且不直接对用户说话；事件驱动——Fast Path 走程序策略、Slow Path 走模型语义，
已订阅 Thread 的后续事件直发 Worker；计算与状态分离；外部 Watchdog 看护。
开放问题：单 Router 超限后如何切分、脱离 Session 后如何协作、上下文边界与 A2A、安全隐私。

其 `docs/000-philosophy.md` 的核心原则：**Take as little human attention as possible, and give as much value as possible**；
无事不主动，主动先只记录（`observe`）；少概念、少设置；文档按编号顺序读。

**本项目抄**：编号文档体系（000–004）、Source 契约、幂等三件套（内容派生 id / 脏游标 / 出站标记）、
prompt 与 policy 分段、Router 只分派不分活。

**本项目有意偏离**：不设常驻 Router 会话——改为每次判断一次独立 headless 调用、记忆落 SQLite，
用一次冷启动换来「每条消息可回放、可算准确率」；不做提前行动；暂不做 Thread 订阅直通与 Watchdog。
