# 运行与客户端（runtime）

这里回答**它怎么跑起来、跑在谁那里**：claude / dsh 两种执行器怎么起、失败怎么映射；
一个会话怎么承载窗口、飞书卡片怎么对齐、三端（终端 / 飞书 / 桌面面板）怎么共用一套状态。

## 按顺序读

| 顺序 | 文档 | 读完应该能回答 |
| --- | --- | --- |
| 1 | [executors.md](executors.md) | claude 与 dsh 各能干什么、启动命令是什么、失败怎么归类？ |
| 2 | [sessions-and-windows.md](sessions-and-windows.md) | 一个话题怎么对应一个可继续的会话？窗口、卡片、三端怎么同步？ |

先看「谁去执行」，再看「执行的结果挂在哪」。两份都依赖 [`../design/domain-model.md`](../design/domain-model.md) 的 Session / Work 定义。

## 什么该写进来

- 执行器的能力差异与**实测**行为（能起、不能起、超时、退出码）。
- 会话层的状态机：什么情况下复用窗口、什么情况下新开。
- 客户端适配的取舍：飞书卡片、桌面面板、终端三端各自负责什么。

## 什么不该写进来

- 平台命令的原始载荷、参数坑 → [`../platform/contracts.md`](../platform/contracts.md)（本文只引用结论）。
- 插件怎么写 → [`../design/plugin-contract.md`](../design/plugin-contract.md)。
- 某次任务的过程 → [`../tasks/`](../tasks/README.md)。
