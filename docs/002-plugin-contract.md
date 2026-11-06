# 002 插件契约

加一个场景 = 加一个目录 + 一个 manifest。**内核零改动。**

## 目录

```
src/plugins/<id>/
├── index.ts      # manifest + setup
└── ...           # 实现自便
```

## manifest

```ts
import { z } from 'zod'

export const manifest = {
  id: 'executor-claude',                 // 唯一，等于目录名
  kind: 'executor' as const,             // source | classifier | executor | channel
  needs: [] as const,                    // 需要内核提供的其他端口（只在同 kind 内组合）
  config: z.object({                     // 缺省配置；由 config/lingcub.yaml 覆盖
    binary: z.string().default('claude'),
    allowRoots: z.array(z.string()).default([]),
    budgetUsd: z.number().positive().default(2),
  }),
}
```

## setup

```ts
export function setup(ctx: PluginContext<typeof manifest>) {
  ctx.register({
    async start(work) { /* 返回 Handle */ },
    async read(handle) { /* 返回 Progress[] */ },
    async stop(handle) { /* 幂等 */ },
  })
}
```

## PluginContext

| 成员 | 说明 |
|---|---|
| `ctx.config` | 已校验的插件配置（`config/lingcub.yaml` 里**引用该插件的那一条**） |
| `ctx.log` | 结构化日志，带插件 id |
| `ctx.register` | 注册端口实现；实现必须与 `manifest.kind` 相符，否则启动失败 |

`ctx.bus` / `ctx.outbox` / `ctx.store` 目前**没有实现**——还没有插件需要它们，
先不加用不到的抽象；真要加，先改本文件说明理由。

## 配置从哪来

配置段与插件一一对应：`sources.<名>.plugin`、`channels.<名>.plugin`、`classifiers.<名>.plugin`、
`executor_policies.<执行器>.plugin` 指向哪个插件，那一条（去掉 `plugin`、`enabled` 两个内核记账字段）
就是该插件的配置段。**同一个插件只能被引用一次**，重复引用直接启动失败。

命令与参数属于平台事实，写成 `args` 模板（`{{prompt}}`、`{{chatId}}` 等），由插件在运行时渲染；
模板里出现代码没提供的变量时直接失败，不静默留空。

## 共用代码

`src/plugin-kit/` 放插件共用工具（起进程、映射事件、抽 JSON、渲染参数），不在 `src/plugins/` 下，不参与插件发现。
它**没有 `index.ts`，不参与插件发现**，因此不算「插件 import 另一个插件」。

## 校验规则

- **拒绝未知键**：`config` 里出现 manifest 未声明的字段 → 启动失败并指出字段名。
- **拒绝未知插件**：`config` 里引用了 `src/plugins` 不存在的 id → 启动失败。
- **拒绝没有端口**：config 引用了插件，但该插件没有注册可用实现 → 启动失败。
- **不静默兜底**：缺必填项直接失败，不猜默认值。
- 启动校验失败时打印完整问题列表，一次性报完。

## 生命周期

```
load manifests → validate config → setup() → start() → [运行] → stop()
```

`setup()` 里不得做 IO；首次 `start()` 才允许连平台。
`stop()` 必须幂等，且不得抛错（异常只记日志）。

## 禁止

- 插件 import 另一个插件。
- 插件直接写库、直接调平台 API（必须经 `ctx.outbox`）。
- 插件在 `setup()` 里读文件或发请求。

## 清单 v2（现行）

`v: 2` 的插件用 `manifest` + `setup(ctx)`，由内核 `discoverPluginsV2` 发现、`assembleV2` 装配：

- `id`：`<source|channel|executor|classifier|scenario|capability>-<小写/数字/连字符>`。
- `roles`：`source|channel|executor|classifier|scenario|capability|doc`。
- `provides`：`{name, effect, input?, output?, timeoutMs?}`；能力名至少两段，插件自提供必须用自身前缀，禁止内核保留前缀。
  能力的 `input`/`output` schema 是**白名单**：没声明的字段会被 zod 剥掉，调用方拿不到。给能力加字段必须同时改 schema，只改实现（或只给别的同名能力加）都会静默丢字段——2026-11-06 在 `state.session.live` 的 `status` 上踩过一次。
- `needs/wants`：必需/可选能力；`wants` 缺失只降级，调用时抛 `CapabilityMissingError`。
- `on`：订阅的事件 kind；`ctx.on` 未声明的 kind 直接报错。
- `owns`：可选，场景独占的控制开关（`status|stop|new|messages`）。运行时在装配前按 `config.control` 过滤：开关没切到 `scenario`/`bus` 就不装配该场景，避免与旧 `Pipeline` 双回。\n- `activation`：可选，`restart`（默认）或 `hot`；`hot` 只允许无事件订阅的纯 `capability` 插件声明；运行时监听覆盖层变更，热加载/卸载该能力。
- `config`：zod schema，默认 `.strict()`；只有 `plugins.*`/`scenarios.*` 显式 enabled 的 v2 插件才会启动。

`ctx` 提供 `has/call/submit/provide/on/emit/ingest/registerPort`：

- `call` 只能调 `effect=none` 的能力；副作用一律 `submit` → 发件箱 → 收据。
- `provide` 注册同步能力；`registerPort` 注册 `Source/Classifier/Executor/Channel/DocPort`。
- `emit(kind, payload, {id, subject})` 追加总线事件；`ingest(event)` 走旧事件入口（迁移期用）。
- 结果通过 `effect.done/effect.failed` 回总线，插件可订阅。

**启动顺序**：发现 → 校验 → 按 `needs` 拓扑 `setup` → `start`；`stop` 逆序且幂等。旧 `sources` 段先启动，再启动本次装配启用的 v2 插件注册的 Source（同一插件只启一次）。
