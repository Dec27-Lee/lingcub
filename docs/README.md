# 文档索引

`docs/` 放**需要展开写**的东西。入口文件（`README.md` / `AGENTS.md` / `CHANGELOG.md`）
只放读者必须知道的公共约束，具体内容进这里。

## 1. 按任务选择入口

| 当前任务 | 必须读取 | 发生变化时必须更新 |
| --- | --- | --- |
| 任意新增、修复、排查、设计、实现、测试或续接任务 | [`tasks/README.md`](tasks/README.md)、[`tasks/INDEX.md`](tasks/INDEX.md) 和命中的任务文档 | 任务索引、范围、状态、验收标准、文档元数据 |
| 改内核边界（`kernel`/`domain`/`routing`） | [`000-principles.md`](000-principles.md) | 设计正文（内核改动要先在这里说理由） |
| Event / Intent / Action / Work 四层模型与不变式 | [`001-domain.md`](001-domain.md) | 领域模型与任务文档 |
| 加插件、改插件契约、插件间通信 | [`002-plugin-contract.md`](002-plugin-contract.md)、[`000-principles.md`](000-principles.md) | 插件 manifest、端口定义与任务文档 |
| 改路由规则、判断谓词、三档模式 | [`003-routing.md`](003-routing.md) | 规则表与任务文档 |
| 改执行器（claude / dsh）、工作区门禁 | [`004-executors.md`](004-executors.md) | 执行器能力对照与任务文档 |
| 会话层、飞书卡片、桌面窗口、三端入口 | [`005-sessions-desktop.md`](005-sessions-desktop.md) | 能力对齐表与任务文档 |
| 改平台命令与参数（飞书 / 钉钉 / claude 调用）、spawn 子进程报 ENOENT | [`006-platform-contracts.md`](006-platform-contracts.md) | 契约文档与 `config/*.yaml` 模板 |
| 改配置项 | `config/*.yaml`、[`002-plugin-contract.md`](002-plugin-contract.md) | 配置 schema 与任务文档 |
| 发版本、写 CHANGELOG | [`../AGENTS.md`](../AGENTS.md) 的版本与变更日志节 | `CHANGELOG.md` 与 `package.json` |
| 同类项目选型、参考台账 | [`000-references.md`](000-references.md) | 参考结论与任务文档 |
| 交接给新开发窗口 | [`handoff-prompt.md`](handoff-prompt.md) | 交接提示词 |

不知道应该读取哪份资料时，先看本表，**不要全文扫描 `docs/`**。

## 2. 各份文档写什么

| 文档 | 读者 | 内容 |
| --- | --- | --- |
| [`000-principles.md`](000-principles.md) | 维护者 | 五条原则与违反后果、判断四层分工 |
| [`001-domain.md`](001-domain.md) | 维护者 | Event / Intent / Work / Action 类型、不变式、状态机 |
| [`002-plugin-contract.md`](002-plugin-contract.md) | 维护者 | 插件 manifest、四端口、生命周期、禁止事项 |
| [`003-routing.md`](003-routing.md) | 维护者 | 三级漏斗、规则谓词、三档模式 |
| [`004-executors.md`](004-executors.md) | 维护者 | claude / dsh 能力对照、启动命令、失败映射 |
| [`005-sessions-desktop.md`](005-sessions-desktop.md) | 维护者 | 会话层、能力对齐表、桌面窗口、三端、切换标准 |
| [`006-platform-contracts.md`](006-platform-contracts.md) | 维护者 | 平台实测事实：飞书／钉钉／claude 命令与载荷、子进程壳解析 |
| [`000-references.md`](000-references.md) | 维护者 | 同类项目参考台账，选型依据 |
| [`tasks/README.md`](tasks/README.md) | 维护者 | 任务台账规则：检索顺序、三段结构、编号、命名、头部模板、索引维护 |
| [`tasks/INDEX.md`](tasks/INDEX.md) | 维护者 | 任务清单，一行一个任务，看总览用 |
| [`handoff-prompt.md`](handoff-prompt.md) | 维护者 | 交接给新开发窗口的完整提示词 |

## 3. 写新内容前

1. **先判断它属于哪一格**——能被 `000`–`006` 吸收的，不新开文件。
2. 新文档用编号前缀 `NNN-`，与现有保持同一命名体系；临时交接材料用无编号名。
3. 在上表加一行，写清「读者 + 内容边界」；涉及新任务类型时，同时补第 1 节路由表。
4. 过程记录不写进这些文档，写进 [`tasks/`](tasks/README.md)。
