# 设计正文（design）

这里回答**系统应该长什么样**：不可违反的原则、领域模型、插件契约、判断与分派。
写代码之前读，改内核边界之前必读；换实现方式时先改这里，再改代码。

## 按顺序读

| 顺序 | 文档 | 读完应该能回答 |
| --- | --- | --- |
| 1 | [principles.md](principles.md) | 这个系统的五条原则是什么？违反哪条会导致什么？ |
| 2 | [domain-model.md](domain-model.md) | Event / Intent / Work / Action 各是什么，谁不许跨层？ |
| 3 | [plugin-contract.md](plugin-contract.md) | 加一个插件要写什么、能用哪些端口、不许做什么？ |
| 4 | [routing.md](routing.md) | 一条消息怎么判断该不该接、该派给谁？三档模式差在哪？ |

前三份是**约束**，第四份是**决策流程**。读的顺序就是它们互相引用的顺序。

## 什么该写进来

- 改变了「系统边界」的决定：新增一层、合并两层、换职责划分。
- 新增的不可违反约束（原则、禁止事项），并写清违反后果。
- 端口 / 契约的语义变化（不是字段增减——字段走 `config/` 与代码）。

## 什么不该写进来

- 平台命令、载荷格式 → [`../platform/contracts.md`](../platform/contracts.md)。
- 具体执行器的启动命令、能力对照 → [`../runtime/executors.md`](../runtime/executors.md)。
- 某次任务怎么做、验收了什么 → [`../tasks/`](../tasks/README.md)。
- 一次性的调研与选型依据 → [`../reference/comparable-projects.md`](../reference/comparable-projects.md)。
