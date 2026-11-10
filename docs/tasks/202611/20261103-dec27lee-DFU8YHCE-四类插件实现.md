# 20261103-dec27lee-DFU8YHCE 四类插件实现

- **任务 ID**：20261103-dec27lee-DFU8YHCE
- **任务名**：四类插件实现
- **创建人**：Dec27-Lee
- **创建时间**：2026-11-03 17:00:00
- **最后更新人**：Dec27-Lee
- **更新时间**：2026-11-03 17:40:00
- **相关材料**：
  - [任务索引](../INDEX.md)
  - [插件契约](../../design/plugin-contract.md)｜[执行器](../../runtime/executors.md)

## 结论摘要

六个插件落地（钉钉源、飞书源、LLM 分类器、claude 执行器、dsh 执行器、飞书频道），加主流程
`kernel/pipeline.ts`（Event→判断→分派→发件箱→投递→结果回收）与 `kernel/wiring.ts`（配置→端口装配）。
`doctor` 能发现并校验全部插件；假端到端（假 Event→假分类器→假执行器→假频道收一条）不触网通过。
**未做真连接**：钉钉字段名、claude `logs/stop`、dsh 真实 session id 三处未实测，配置留空即降级为可观测量为零，不猜。

## 现状与目标

已有内核（store/outbox/规则/门禁），但没有任何真实能力：`src/plugins/` 为空，主流程不存在。
目标：让「消息进 → 派活 → 结果回」这条链路在本地可跑通，且不起真进程也能测。

## 方案

| 插件 | 端口 | 关键约束 |
| --- | --- | --- |
| `source-dingtalk` | Source | `dws event consume … --flatten -f ndjson`；一行一事件；缺字段时不静默，打印 payload 顶层键 |
| `source-feishu-im` | Source | `lark-cli event consume im.message.receive_v1 --as bot`；stdin 必须保持打开 |
| `classifier-llm` | Classifier | 一次 headless 调用（`dsh --profile headless --json -`，任务走 stdin），解析最后一个配平 JSON；不合 schema → null |
| `executor-claude` | Executor | `claude --bg`（异步）；第二道 `allowRoots` 门禁；预算必须显式配置，缺失即报错 |
| `executor-dsh` | Executor | `dsh --profile headless --json`（同步跑完）；子进程进度即 Progress，退出码 0 → finished |
| `channel-feishu` | Channel | `lark-cli im +messages-send --as bot --chat-id … --content …`；正文由代码生成 JSON，不手拼 |

内核新增：

- `kernel/pipeline.ts`：`ingest()`（落库→规则→模型兜底→resolve→入发件箱）、`collect()`（读进度、收敛状态、入队回执）、`createDeliver()`（Action→端口）。
- `kernel/wiring.ts`：**配置段只在一处**——谁引用插件，那一条配置就是该插件的配置；`plugin`/`enabled` 是内核记账字段，不进插件配置。装配后校验每处引用都有端口可用。
- `kernel/registry.ts`：注册实现与 `manifest.kind` 不符立即失败；配置里出现 manifest 未声明的字段立即失败（zod 会静默丢弃，这里补回拒绝）。
- `plugins/_shared/`：`spawn`（长连接/一次性调用）、`map`（平台事件→Event）、`json`（JSON 抽取）、`template`（参数模板）、`pick`。放在插件树里但**没有 `index.ts`，不参与发现**。

## 验证

```
pnpm build            → exit=0
pnpm test             → tests 57 / pass 57 / fail 0
node dist/main.js doctor
  → 已发现插件 6 个；端口就绪：源 2 / 分类器 1 / 执行器 2 / 频道 1；doctor 通过
```

测试覆盖（全部离线）：

- 假端到端：假 Event → 假分类器 → 假执行器开工 → `collect()` 收敛 → 假频道收到回执。
- 幂等：同一消息重复 ingest 只落一行、只开一次工。
- 三档模式：observe 只记录；suggest 只发建议不起会话；auto 低置信度只记录但判断落库。
- 飞书事件映射：真实 16 键 payload → Event（毫秒时间戳、p2p→dm、缺字段清单）。
- 分类输出解析：纯 JSON / 事件包裹 / 代码围栏三种形态。
- 执行器门禁：允许根外拒绝；未配预算报错。
- dsh 执行器：**真起子进程**（用 node 假脚本）收集进度、退出即完成。
- 飞书频道：正文含引号与换行时，步骤参数仍是合法 JSON。

变异反证（改坏必须红，还原必须绿）：

| 变异 | 结果 |
| --- | --- |
| 派工分支不真起会话 | pipeline 2 红（开工断言） |
| 删掉插件层第二道门禁 | plugins 1 红（门禁断言） |
| 执行完成不发回执 | pipeline 1 红（回执断言） |
| 频道正文不包 JSON 直接传 | plugins 1 红（参数结构断言） |

开发中另有两处**自然变红**（不是事后补的判据）：分类输出解析一开始把整行 envelope 排在携带文本之前，
测试当场红；修完后绿。

## 未实测与降级

| 项 | 现状 | 配置留空时的行为 |
| --- | --- | --- |
| 钉钉 IM 的 event_key 与扁平化字段名 | 未连，字段名按合理值预填 | 缺字段则 warn + 打印 payload 顶层键，照报错改 `sources.dingtalk-im.fields` |
| claude `logs` / `stop` 的参数与输出 | 未实测 | 不配 `logsArgs` → `read()` 返回空数组，任务不会自动收敛为完成 |
| dsh 真实 session id | `--session-id` 只认已存在会话，新任务无法预置 | 句柄用 Work id；续跑等后续批次从输出里抓 |
| 飞书「是否 @ 了我」 | 事件里没有 `mentions` | `atMe` 恒为 undefined，`atMe` 规则不命中 |
| 图/文件消息 | 只判 text/post 的正文串 | image 的 `{"image_key":…}` 会当正文原样进来 |

## 风险

- `classifier-llm` 与 `claude` 执行器都是**一次外部调用**，失败即返 null/报错；分类失败只记录不派工，是有意的保守。
- `dsh` 执行器的进度存在进程内 Map 里，进程重启后丢失；可靠状态在 `works` 表，重启不丢。
- 频道去重只有 outbox 一层：`lark-cli` 没有幂等键参数，重投可能重复发一条。

## 完成判定

doctor 校验全部插件 + 一条不触网的假端到端通过；两条要求均已满足。真连接留给 P3 回放批次。
