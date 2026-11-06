# 003 判断与分派

## 三级漏斗

```
Event
 ├─ 1. 规则（rules.yaml）命中 → Intent，不调模型
 ├─ 2. 模型分类（一次 headless 调用 + JSON schema）→ Intent
 └─ 3. 都不确定 → 只记录，不入库为 Work
```

规则命中率越高越好：规则不花钱、可复现、可断言。模型只处理规则覆盖不到的语义。

## 规则形状

```yaml
- id: keyword-bug
  when: { channel: group, textMatches: '(bug|报错|异常)' }
  then: { kind: bug, suggestedAction: dispatch_session, confidence: 0.8 }
```

可用谓词：`channel`、`atMe`、`groupIn`、`peopleIn`、`textMatches`、`always`。
按顺序求值，首个命中即停；没有 fallthrough，避免多条规则叠加出意外组合。
谓词之间是 AND；`when` 不能为空，未知键、非法正则、重复 id 一律在加载期报错，不静默失效。

## 从 Intent 到 Work

代码查表，不问模型：

1. `intent.project` → `projects.yaml` 找 workspace（找不到则 `project` 缺失 → 只回消息问人）
2. `workspace.executor` → 对应执行器策略
3. 校验 `workspace.root` 命中 `executor_policies[executor].allowRoots`
4. 组装 prompt（`prompts/*.md` + Intent + 工作区提示）
5. 写入 outbox

## 三档模式

| mode | 行为 |
|---|---|
| `observe` | 只落 Event/Intent，不发任何消息、不起会话 |
| `suggest` | 发飞书卡片，等你点「执行」才入队 |
| `auto` | 仅 `confidence >= 0.9` 且 `project` 命中白名单时自动入队 |

白名单就是 `config/projects.yaml` 里已声明的工作区：路由只认这张表，表外的 project 一律不派。

「确认后执行」的回路当前只做到**发建议**这一步：suggest 档发一条建议消息，点「执行」的回传在后续批次做。

默认 `observe`。升档的前提是回放验证过：`scripts/replay.ts` 跑历史消息，抽检 50 条，
判断准确率 ≥ 90% 才允许进 `suggest`。

## 为什么不用模型做路由

模型不可复现、不可断言、成本随消息量线性上升。路由一旦错了（把公司仓库派给个人执行器），
代价远高于判断错一次。所以：**模型答「是什么」，代码定「怎么办」**。
