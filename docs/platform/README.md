# 平台事实（platform）

这里只放**本机实测**出来的平台事实：飞书、钉钉、claude、dsh、CC Switch、Windows 子进程。
不是照官方文档抄的，也不是设计意见——是可以拿命令复现的事实。

**改任何对外调用前先读对应那一节。** 平台会变，凭记忆写调用是这类项目最常见的返工来源。

## 按顺序读

只有一份：[contracts.md](contracts.md)。按任务找节：

| 要做的事 | 读哪节 |
| --- | --- |
| 收发飞书消息、发卡片／改卡／置顶／删消息、处理按钮回调 | 飞书 |
| 接钉钉事件、停机、多实例互斥 | 钉钉 |
| 在 Windows 上 spawn 命令、全局 CLI 报 ENOENT | 子进程 |
| 起 / 追加 / 停 claude 与 dsh 会话 | claude、dsh |
| 装钩子、改 `~/.claude/settings.json` | CC Switch |

## 什么该写进来

- 实测得到的命令、参数、返回结构、错误码，**带日期**。
- 平台行为与官方文档不一致的地方（这才是价值所在）。
- 踩过的坑与它的边界条件。

## 什么不该写进来

- 设计决策、架构理由 → [`../design/`](../design/README.md)。
- 某次排查的过程与时间线 → [`../tasks/`](../tasks/README.md)（这里只留结论）。
- 本项目自己的配置项含义 → `config/*.yaml` 与 [`../design/plugin-contract.md`](../design/plugin-contract.md)。
