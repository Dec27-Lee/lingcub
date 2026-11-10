# 域模型

四层，逐层加信息，逐层可持久化。

```
Source ──emit──▶ Event ──classify──▶ Intent ──decide──▶ Work ──outbox──▶ Action
```

## Event（不可变）

来源的原始消息，落库后不再改。

```ts
type Event = {
  id: string          // 内容派生：sha256(source|externalId)[:16]
  source: string      // 来源插件 id，如 'source-feishu-im'
  externalId: string  // 平台侧唯一标识
  receivedAt: string  // ISO8601
  occurredAt: string  // 平台事件时间
  actor: { id: string; name?: string }
  channel: { kind: 'dm' | 'group' | 'doc' | 'task'; id: string; name?: string }
  atMe?: boolean      // 平台侧是否 @ 了我；规则谓词 atMe 依赖它，由 source 插件填
  text: string
  raw: unknown        // 原样保留，供回放
}
```

**不变量**：`id` 由内容派生，同一 `(source, externalId)` 重复投递得到同一个 `id`，`INSERT OR IGNORE` 天然幂等。

## 中间层分析（message.analyzed）

所有渠道的 `message.received` 先经过平台中间层，再进入分发；分发场景不再各自理解原始消息。

```
Source ──▶ message.received ──▶ scenario-analysis ──▶ message.analyzed
       ──▶ scenario-distribution ──▶ distribution.decided ──▶ 出口消费者
                                      │
                                      ├─ state.history.fetch（source 历史优先，事件库兜底）
                                      └─ ai.summarize（capability-ai 提供的一次模型调用）
```

```ts
type MessageAnalysis = {
  eventId: string
  summary: string              // 一句中文摘要，分发卡片直接展示
  urgency?: 'low' | 'normal' | 'high'
  entities?: string[]         // 消息里出现的人/系统/项目
  contextVia?: 'event-store' | 'source-history'
  status: 'ok' | 'degraded'    // 模型失败也发事件，分发仍能降级发送
  model?: string
  contextCount: number         // 实际带入的历史消息数
  error?: string
  at: string
}
```

**边界**：`message.analyzed` 是事件，不是 Intent；它只回答“这条消息在说什么”，不决定执行器、目录或是否动手。路由与执行仍由现有 Intent/Work 层负责。

## Intent（分析产物）

模型或规则对 Event 的判断结果。

```ts
type Intent = {
  eventId: string
  kind: 'dev-request' | 'bug' | 'question' | 'chatter' | 'doc-update' | 'todo'
  topic: string            // 一句话概括
  project?: string         // 指向 projects.yaml 的 id，可为空
  suggestedAction: ActionKind
  rationale: string        // 为什么这么判
  confidence: number       // 0..1
  byRule?: string          // 规则命中则该字段有值，模型判断为空
}
```

**不变量**：Intent 不携带执行细节（用哪个执行器、哪个目录）。那些由路由查表得出。

## Work（仅需执行器时存在）

```ts
type Work = {
  id: string
  intentId: string
  kind: 'session' | 'reply' | 'doc'
  project: string
  executor: 'claude' | 'dsh'
  workspace: string        // 绝对路径，来自 projects.yaml
  prompt: string           // 组装好的任务描述
  budgetUsd?: number
  sessionId?: string       // 执行器返回
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
}
```

**不变量**：`workspace` 必须命中执行器策略的 `allowRoots`，否则在入队前拒绝。

## Action

```ts
type Action =
  | { kind: 'dispatch_session'; work: Work }
  | { kind: 'reply_only'; text: string }         // 只回一条飞书消息
  | { kind: 'update_doc'; doc: string; content: string }
  | { kind: 'create_todo'; title: string; assignee?: string }
```

## 状态机

```
Event:   stored
Intent:  stored ──(observe)──▶ dropped
Work:    queued ──▶ running ──▶ succeeded | failed | cancelled
Action:  pending ──▶ dispatched ──▶ done | retry(N) ──▶ dead
```
