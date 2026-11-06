# 20261106-dec27lee-BTGVY6XF 媒体提示清洗

- **任务 ID**：20261106-dec27lee-BTGVY6XF
- **任务名**：媒体提示清洗
- **创建人**：Dec27-Lee
- **创建时间**：2026-11-06 09:50:00
- **最后更新人**：Dec27-Lee
- **更新时间**：2026-11-06 10:05:00
- **相关材料**：
  - [任务索引](../INDEX.md)
  - [平台契约](../../006-platform-contracts.md)

## 需求描述

用户在飞书看到的钉钉图片消息卡片，正文是一句 `注意：如需下载使用dws chat message download-media命令下载`，不是发送人说的话。

来源是 DWS 自己：媒体消息正文被拼成 `[图片消息](mediaId=…)` 占位符 + 这句下载命令提示。占位符由 lingcub 换成卡片图片，提示没人清理，于是原样漏给飞书群里的人，也进到 AI 摘要的提示词里。

期望：

- 展示层不出现任何 CLI 命令提示；图片该发还发，下载失败只留占位。
- 喂给模型的“当前消息 / 最近聊天记录”同样不带这句提示。
- `Event.text` 与 `Event.raw` 不改：原始载荷是排查依据，清洗只在展示与模型输入两处。

## 技术设计

- 新增 `src/plugin-kit/dingtalk-text.ts` 纯函数 `stripDwsMediaNotice(text)`：
  只匹配 `注意：如需下载使用…命令下载` 这一句（含句中前后空白与句末句号），不含 `命令下载` 字样直接原样返回，避免误伤普通链接与日报正文。
- `dingtalk-media.ts` 的 `renderImageText` / `renderImageMarkdown` 先清洗再替换图片占位符，卡片与 `media.resolve` 两条路径同时生效。
- `capability-ai.buildSummaryTask` 对历史行与当前消息各清洗一次，模型看不到 CLI 操作提示。
- 单测覆盖：纯提示、混排正文、视频/文件占位、含链接普通消息不变；卡片有图/下载失败两种分支；AI 提示词无提示字样。

## 实施计划

### 第 1 轮

- 落纯函数与三处接入，补单测。
- 变异反证：把 `stripDwsMediaNotice` 改成恒返回原文，新增判据必须全红。
- 定向测试 → 全量 `pnpm build && pnpm test` → `docs:check`。

## 结论

- 卡片实测对象：`events` 表 `dcd5439243a01ca2`（2026-11-06 09:38 邢鑫鑫图片消息）的历史卡片正文正是那句提示，图片由 `img_key` 单独发出；清洗后卡片元素只剩 `["img","column_set"]`，JSON 里 `命令下载` 为 false。
- 新增 4 条纯函数单测 + 3 条接入单测；恒等变异下 6 条变红（AI 提示词、卡片两分支、纯函数三条），已恢复。
- `pnpm build` 通过；`pnpm test` **493 pass / 0 fail**；`pnpm docs:check` 通过（14 行台账合规）。
- 运行时 2026-11-06 09:54:58 重启（pid 48712），六个来源全部拉起（dingtalk-im/at/group/sent、feishu-im、飞书卡片），01:55 起事件正常投递。
