# 20261103-dec27lee-WKD7Q23T 内核store与发件箱

- **任务 ID**：20261103-dec27lee-WKD7Q23T
- **任务名**：内核store与发件箱
- **创建人**：Dec27-Lee
- **创建时间**：2026-11-03 17:00:00
- **最后更新人**：Dec27-Lee
- **更新时间**：2026-11-03 17:18:13
- **相关材料**：
  - [任务索引](../INDEX.md)
  - [域模型](../../design/domain-model.md)｜[判断与分派](../../design/routing.md)

## 结论摘要

P1 完成。落 `kernel/store.ts`（`node:sqlite`，四表，`PRAGMA user_version` 顺序迁移）、
`kernel/outbox.ts`（`dedupe_key` 唯一、失败重试到 dead）、`routing/rules.ts`（顺序求值、首个命中即停）、
`routing/resolve.ts`（Intent→Work、入队前 `allowRoots` 门禁、三档模式生效）。
`pnpm build` exit=0，39 个测试全绿；四条判据（幂等／去重／命中即停／门禁）各做变异反证，均为真红。
未接线：尚无主流程调用它们，端到端在 P2 的插件批次落地。

## 现状与目标

开工前只有域模型与配置校验，没有任何持久化与判断代码（`src/plugins/` 为空）。
目标：让「消息进」到「派活」之间的每一步都可落库、可断言、可重放，
且副作用一律先落发件箱。

## 方案

| 文件 | 职责 | 关键约束 |
| --- | --- | --- |
| `src/kernel/store.ts` | SQLite 持久化（events / intents / works / outbox） | Event id 内容派生 → `INSERT OR IGNORE` 天然幂等；迁移按 `user_version` 顺序追加，单事务，失败回滚；打不开不兜底 |
| `src/kernel/outbox.ts` | 发件箱投递 | 同一 `dedupeKey` 只入队一次；失败 `attempts+1` 回 pending，达上限转 `dead` 并 error 日志；单条失败不影响同批其他条目 |
| `src/routing/rules.ts` | 规则引擎 | 按序求值首个命中即停；谓词 AND；`when` 为空／未知键／坏正则／重复 id 在加载期报错 |
| `src/routing/resolve.ts` | Intent → Work | 代码查表：`projects.yaml`（含别名）→ `executor_policies` → `allowRoots` 门禁 → 组装 prompt；observe 档不解析工作区 |

配套改动：

- `src/domain/types.ts`：Event 增可选 `atMe`。理由：`atMe` 是平台侧事实、规则谓词直接依赖，
  藏在 `raw` 里会让规则无法断言；已同步 `../../design/domain-model.md`。
- `src/domain/ports.ts`：抽出 `Log` 类型，内核与插件共用一套日志签名。
- `src/kernel/config.ts`：`assertValid` 导出复用，避免每个加载器各写一遍「一次性报全部问题」。
- 模块解析：源码内相对导入改用 `.ts` 后缀 + `tsconfig` 打开
  `allowImportingTsExtensions` / `rewriteRelativeImportExtensions`。
  理由：Node 24 不做 `.js`→`.ts` 回退，原先 `pnpm dev` 与「测试直接导入 src」两条路都是断的。

## 验证

```
pnpm build            → exit=0
pnpm test             → tests 39 / pass 39 / fail 0
node dist/main.js doctor      → 通过（2 工作区、2 启用来源）
node src/main.ts doctor（dev） → 通过
```

变异反证（改坏一处必须红，还原必须绿）：

| 变异 | 结果 |
| --- | --- |
| `INSERT OR IGNORE` → `INSERT OR REPLACE`（events） | store 4 通过 1 失败（幂等断言红） |
| 去掉 `dedupe_key TEXT NOT NULL UNIQUE` | outbox 3 通过 1 失败（去重断言红） |
| 首个命中 → 取最后一条命中 | rules 9 通过 2 失败（顺序语义断言红） |
| 删掉 `assertAllowedRoot(...)` 调用 | resolve 8 通过 1 失败（门禁断言红） |

## 风险与已记录的坑

- `node:sqlite` 同步 API 会阻塞同进程事件循环。P2 起「收消息 / 跑长任务 / tick 发件箱」同进程并发时，
  不能靠它做重活；需要时按每类操作短事务切分，不长时间持有。
- `node:sqlite` 无 `db.transaction()`，迁移里手写 `BEGIN`/`COMMIT`/`ROLLBACK`；嵌套事务场景要用 SAVEPOINT。
- 出站幂等是双保险：本地 `dedupe_key` 唯一 + `Channel.send` 按 key 幂等。只做一半会在崩溃重启后重发或丢消息。
- `eventId` 由「上游 id」派生，不是由正文派生：消息被编辑后不会重判。
  这是有意的——平台重推必须收敛，内容变化属于新事件；需要时在 P3 回放里单独对账。

## 完成判定

四条判据单测绿 + 变异反证成立，且 `pnpm build && pnpm test` 与 `doctor` 均通过。已达。
