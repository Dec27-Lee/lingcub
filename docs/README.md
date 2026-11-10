# 文档索引

`docs/` 放**需要展开写**的东西。入口文件（`README.md` / `AGENTS.md` / `CHANGELOG.md`）
只放读者必须知道的公共约束，具体内容进这里。

根目录只有本文件；其余文档一律归到下面五个分组里，每组有自己的 `README.md` 说明边界与阅读顺序。

| 分组 | 回答什么问题 | 什么时候读 |
| --- | --- | --- |
| [`design/`](design/README.md) | 系统**应该**长什么样 | 写代码前、改内核边界前 |
| [`runtime/`](runtime/README.md) | 它**怎么跑起来**、跑在谁那里 | 改执行器、改会话与窗口 |
| [`platform/`](platform/README.md) | 外部平台**实际**是什么样（实测） | 改任何对外调用前 |
| [`reference/`](reference/README.md) | 别人怎么做的、怎么交接 | 选型、开新窗口接手 |
| [`tasks/`](tasks/README.md) | 某件事**做过什么、验收了什么** | 接到任何任务的第一件事 |

## 1. 按任务选择入口

| 当前任务 | 必须读取 | 发生变化时必须更新 |
| --- | --- | --- |
| 任意新增、修复、排查、设计、实现、测试或续接任务 | [`tasks/README.md`](tasks/README.md)、[`tasks/INDEX.md`](tasks/INDEX.md) 和命中的任务文档 | 任务索引、范围、状态、验收标准、文档元数据 |
| 加测试用例、改测试目录、跑单域／单场景 | [`../tests/README.md`](../tests/README.md) | 该域 `scenarios/<domain>/suite.yaml` 与 `case.md` |
| 改内核边界（`kernel`/`domain`/`routing`） | [`design/principles.md`](design/principles.md) | 设计正文（内核改动要先在这里说理由） |
| Event / Intent / Action / Work 四层模型与不变式 | [`design/domain-model.md`](design/domain-model.md) | 领域模型与任务文档 |
| 加插件、改插件契约、插件间通信 | [`design/plugin-contract.md`](design/plugin-contract.md)、[`design/principles.md`](design/principles.md) | 插件 manifest、端口定义与任务文档 |
| 改路由规则、判断谓词、三档模式 | [`design/routing.md`](design/routing.md) | 规则表与任务文档 |
| 改执行器（claude / dsh）、工作区门禁 | [`runtime/executors.md`](runtime/executors.md) | 执行器能力对照与任务文档 |
| 会话层、飞书卡片、桌面窗口、三端入口 | [`runtime/sessions-and-windows.md`](runtime/sessions-and-windows.md) | 能力对齐表与任务文档 |
| 改平台命令与参数（飞书 / 钉钉 / claude 调用）、spawn 子进程报 ENOENT、装钩子 | [`platform/contracts.md`](platform/contracts.md) | 契约文档与 `config/*.yaml` 模板 |
| 改配置项 | `config/*.yaml`、[`design/plugin-contract.md`](design/plugin-contract.md) | 配置 schema 与任务文档 |
| 发版本、写 CHANGELOG | [`../AGENTS.md`](../AGENTS.md) 的版本与变更日志节 | `CHANGELOG.md` 与 `package.json` |
| 同类项目选型、参考台账 | [`reference/comparable-projects.md`](reference/comparable-projects.md) | 参考结论与任务文档 |
| 交接给新开发窗口 | [`reference/handoff-prompt.md`](reference/handoff-prompt.md) | 交接提示词 |

不知道应该读取哪份资料时，先看本表，**不要全文扫描 `docs/`**。

## 2. 各份文档写什么

| 文档 | 读者 | 内容 |
| --- | --- | --- |
| [`design/principles.md`](design/principles.md) | 维护者 | 五条原则与违反后果、判断四层分工 |
| [`design/domain-model.md`](design/domain-model.md) | 维护者 | Event / Intent / Work / Action 类型、不变式、状态机 |
| [`design/plugin-contract.md`](design/plugin-contract.md) | 维护者 | 插件 manifest、四端口、生命周期、禁止事项 |
| [`design/routing.md`](design/routing.md) | 维护者 | 三级漏斗、规则谓词、三档模式 |
| [`runtime/executors.md`](runtime/executors.md) | 维护者 | claude / dsh 能力对照、启动命令、失败映射 |
| [`runtime/sessions-and-windows.md`](runtime/sessions-and-windows.md) | 维护者 | 会话层、能力对齐表、桌面窗口、三端、切换标准 |
| [`platform/contracts.md`](platform/contracts.md) | 维护者 | 平台实测事实：飞书／钉钉／claude／dsh／CC Switch／子进程 |
| [`reference/comparable-projects.md`](reference/comparable-projects.md) | 维护者 | 同类项目参考台账，选型依据 |
| [`reference/handoff-prompt.md`](reference/handoff-prompt.md) | 维护者 | 交接给新开发窗口的完整提示词 |
| [`tasks/README.md`](tasks/README.md) | 维护者 | 任务台账规则：检索顺序、三段结构、编号、命名、头部模板、索引维护 |
| [`tasks/INDEX.md`](tasks/INDEX.md) | 维护者 | 任务清单，一行一个任务，看总览用 |

## 3. 写新内容前

1. **先判断它属于哪个分组**（看上面第一张表）。能被现有文档吸收的，不新开文件。
2. 文件名用**语义**命名，小写连字符，不加数字编号；阅读顺序由各组的 `README.md` 给出，不靠文件名前缀。
3. 在所属分组的 `README.md` 表里加一行（写清「什么时候读 / 内容边界」）；影响任务类型的，同时补第 1 节路由表。
4. 过程记录不写进这些文档，写进 [`tasks/`](tasks/README.md)。
5. 新开分组目录时要同时写它的 `README.md`：这份目录回答什么问题、按什么顺序读、什么不该放进来。
