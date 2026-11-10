# AGENTS.md — 给 AI 的上下文

本仓库是「幺幺零 · Lingcub」：个人 AI 开发调度台。消息进，任务出，结果回来。

## 文档分工（先看这里再动手）

| 文件 | 读者 | 写什么 |
| --- | --- | --- |
| `README.md` | 使用者 | 这个项目解决什么问题、怎么开始用 |
| `AGENTS.md`（本文件） | 维护者（AI） | 技术概览、开发规范、维护约束、文档分工 |
| `CHANGELOG.md` | 使用者 | 版本变化 |
| `docs/README.md` | 维护者 | 按任务选择入口的路由表 + 各份文档分别写什么 |
| `docs/design/` | 维护者 | 设计正文：原则、领域模型、插件契约、路由 |
| `docs/runtime/` | 维护者 | 执行器与会话窗口：claude / dsh 怎么跑、窗口与三端 |
| `docs/platform/` | 维护者 | 平台实测事实：飞书／钉钉／claude／CC Switch／子进程壳解析 |
| `docs/reference/` | 维护者 | 同类项目参考台账、交接提示词 |
| `docs/tasks/` | 维护者 | 任务台账，过程记录 |

**写新内容前先判断它属于哪一格**，不要往本文件继续堆——它只放「维护者必须知道的公共约束」。
具体设计进 `docs/`，过程记录进 `docs/tasks/`。

## 起手必读（按序）

1. `docs/design/principles.md` — 不可违反的五条
2. `docs/design/domain-model.md` — Event / Intent / Action / Work 四层
3. `docs/design/plugin-contract.md` — 加插件只改这里
4. `docs/design/routing.md` — 判断与分派
5. `docs/runtime/executors.md` — claude / dsh 两种执行器与工作区门禁

## 任务台账（接到任务的第一件事）

任务先有文档再动手，不是做完再补。接到任何新增、修复、排查、设计、实现、测试或续接任务后，
**在写第一行代码前**：先按 [`docs/README.md`](docs/README.md) 的路由表找到该读的文档，
再用 [`docs/tasks/INDEX.md`](docs/tasks/INDEX.md) 判断有没有相关任务——命中就续接原任务（不新建 ID），
没命中就新建任务文档、写下需求与技术设计再开工。

文档结构（需求描述 / 技术设计 / 实施计划）、实施计划按轮追加的规则、命名与索引维护，
全部只在 [`docs/tasks/README.md`](docs/tasks/README.md)，本文件不重复抄写。

文档是**上下文的落点**：会话里只记任务 ID 和索引行，设计与决策都进文档；换会话或上下文被压缩后
靠读文档恢复，不靠回忆。临时进度记在 todo 板，设计与证据必须进文档——板子会丢，文档不会。

## 硬规则

- 内核（`src/kernel`、`src/domain`、`src/routing`）不 import 任何 `src/plugins/*`。
- 插件之间不互相调用，一律经端口或 outbox；共用代码放 `src/plugin-kit/`（不参与插件发现）。
- 所有对外副作用（起会话、发消息、写文档）必须经 `kernel/outbox`。
- 新增能力优先加插件目录，不改内核；内核要改，先在 `docs/design/principles.md` 里说明理由。
- 配置改动只落在 `config/*.yaml`，不写死在代码里。
- 命令与参数属于平台事实，写成 `config/*.yaml` 里的模板（`{{占位符}}`），不写死在插件里。
- **改 `~/.claude/settings.json`（装钩子）必须同步 CC Switch**：它切服务商时用库里的配置
  整体覆盖 `settings.json`，漏一个服务商就等于「换个模型功能全丢」。装了才做，
  `lingcub hook install` 默认会同步、`lingcub doctor` 会报差异，细节与两条硬约束见
  [`docs/platform/contracts.md`](docs/platform/contracts.md)。

## 平台契约（实测，别照平台文档猜）

飞书、钉钉、claude 的命令与载荷、Windows 子进程的壳解析，全是本机实测得来的事实。
**改任何调用前先读 [`docs/platform/contracts.md`](docs/platform/contracts.md)**，不要照平台文档猜；
发现新的平台事实也写回那份文档，不写进本文件。

## 版本与变更日志

`CHANGELOG.md` 是产品版本日志。提交变更前必须查看暂存区 diff，并为本次提交追加一个小版本记录；条目与本次变更同批提交，提交前一次写定，不得写「待提交」，不得提交后补写或为补写另建提交。

- 每次提交合并成一个小版本，本地未提交修改不产生版本记录；同一变更随后进入主分支时不再改写、不重复新增，只有主分支带来独立的新功能或修复才新增条目。
- 仓库还没有提交时，第一次提交产出唯一一条初始版本，不保留从未发布过的中间版本号。
- 版本标题只能写纯版本号（`## 0.1.0`），不得写预发、正式、分支或 SHA；`CHANGELOG.md` 最新版本、`package.json` 的 `version`、本次提交的 tag 三处同号。
- 版本号小步走：修一处上 `0.1.x`，不因为改得多就跳版。
- 按暂存区 diff 逐项覆盖本次每个独立、可感知的变化，不得只把提交标题或「能力增强」「问题修复」这类概括词改写成一条。
- 条目写用户视角：能完成什么操作、看见什么结果、避开什么问题；不写类名、函数、数据库、协议、测试、构建、部署等实现细节。
- 多个独立变化拆成多条，同一功能不重复描述；标签只有［新增］［优化］［修复］，按此顺序排。
- 不写发布日期、验证结论、部署说明、风险、维护规则或实现过程——验证结论写 `docs/tasks/`，规则只维护在本文件。
- **未经负责人允许不提交代码**：改完只汇报，等确认后再提交。

## 验证

- **变异反证只对纯函数与纯内存路径做**。有真实副作用的脚本（切换、装钩子、自启、发消息）
  只能做「预演输出」级测试；否则一次把开关改成恒真的变异就会真的动生产（2026-11-03 踩过）。
- 任何会动生产状态的脚本都必须有第二道闸（`--apply` 之外再加显式确认变量）。

改完跑 `pnpm build && pnpm test`。测试用 `node --test`，不引入测试框架。
测试目录与规范见 [`tests/README.md`](tests/README.md)：新增用例必须登记 `tests/scenarios/<域>/suite.yaml`，
`pnpm test:check` 会拦「只加用例不登记」。
执行范围：开发中定向跑（`pnpm test:suite --suite=<域>`／`--case=<ID>`）；改 `src/kernel`、`src/routing`、
`src/plugin-kit`、`src/domain/{ports,types,plugin-v2}.ts`、`config/*.yaml`、`tests/support/` 必须全量。
全量 612 条约 18s，同步跑即可，不需要后台。`--check` 只验登记，不等于跑过。
任务台账的验证口径与事实源见 `docs/tasks/README.md` 第 5 节。
