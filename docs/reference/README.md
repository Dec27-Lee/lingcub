# 参考与交接（reference）

这里放**依据**与**交接材料**，不是本项目的设计正文：
别人的项目怎么做的（选型依据）、把工作交给新窗口时该说什么。

结论要指回设计文档：在这里读到的东西，最终要落到
[`../design/`](../design/README.md)、[`../runtime/`](../runtime/README.md) 或 [`../platform/contracts.md`](../platform/contracts.md) 里才算数。

## 按顺序读

| 顺序 | 文档 | 什么时候读 |
| --- | --- | --- |
| 1 | [comparable-projects.md](comparable-projects.md) | 要选型、要抄别人设计、要判断「这个功能别人怎么做的」 |
| 2 | [handoff-prompt.md](handoff-prompt.md) | 新开一个开发窗口、要把上下文整段交出去时 |

## 什么该写进来

- 同类项目的定位、可借鉴点、**不直接用的原因**（调研存档，引用前复核）。
- 交接提示词：让一个新窗口从零接手需要的最小上下文。

## 什么不该写进来

- 已经定下来的设计 → [`../design/`](../design/README.md)。
- 实测的平台事实 → [`../platform/contracts.md`](../platform/contracts.md)。
- 任务进度与验收 → [`../tasks/`](../tasks/README.md)。

> `comparable-projects.md` 是调研存档，**未逐一验证运行**，引用前复核 star、活跃度与实际能力。
