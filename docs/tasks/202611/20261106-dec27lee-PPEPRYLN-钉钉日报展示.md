# 20261106-dec27lee-PPEPRYLN 钉钉日报展示

- **任务 ID**：20261106-dec27lee-PPEPRYLN
- **任务名**：钉钉日报展示
- **创建人**：Dec27-Lee
- **创建时间**：2026-11-06 08:30:00
- **最后更新人**：Dec27-Lee
- **更新时间**：2026-11-06 08:40:00
- **相关材料**：
  - [任务索引](../INDEX.md)
  - [平台契约](../../006-platform-contracts.md)

## 需求描述

钉钉日报（工作日志）经飞书卡片展示时，正文后面带出成串 `[label](dingtalk://…)` / `[label](https://…)` Markdown 链接和三行 `工 / 0 / 0` 噪声，用户看到的是原始载荷而不是日报内容。

期望：

- 日报正文保留“谁的工作日志、日期、今日工作、进度、工作说明”。
- 去掉钉钉客户端深链、重复的 landray 链接、文档链接和尾部噪声。
- 非日报消息保持原文，不误删普通链接。
- 原始 Event 不改，只改展示层；分析和回放仍看原文。

## 技术设计

- 新增 `src/plugin-kit/dingtalk-report.ts` 纯函数 `formatDingTalkReport(text)`。
- 仅在检测到“工作日志 + 今日工作/日期”模式时清理：
  1. 截掉首个行首 Markdown 链接起的整个链接块；
  2. 去掉尾部空行和仅 `工` / 纯数字的噪声行；
  3. 合并多余空行，保留正文结构。
- `scenario-dingtalk-feishu-relay` 在 `media.resolve` 之后、`buildRelayCard` 之前调用；不改 `Event.text`。
- 单测覆盖日报清理、普通消息不变。

## 实施计划

### 第 1 轮

- 落地纯函数与单测，接入 relay，构建/测试/doctor/docs 全绿。
- 用历史日报 Event 做一次离线格式化验证。

## 结论

- 历史 Event `d7ae8371554da64b` 实测：清理后只保留标题、日期、今日工作、进度和工作说明；`dingtalk://` / landray / alidocs 链接全部消失。
- 仅带链接的 `[日志]:肖亚伦的工作日志 url: …` 也收敛成标题，不再把 URL 铺在卡片里。
- `Event.text` 未改，分析和回放仍是原文。
- 新增 3 条单测；当前 **486 pass / 0 fail**。
