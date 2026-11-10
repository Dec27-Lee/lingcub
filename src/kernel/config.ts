import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'

/** 内核只读下面声明的字段；插件自己的字段靠 passthrough 透传，由插件 manifest 校验。 */
const SourceCfg = z
  .object({ enabled: z.boolean(), plugin: z.string() })
  .passthrough()

const ExecutorPolicy = z
  .object({
    plugin: z.string(),
    allowRoots: z.array(z.string()).default([]),
    defaultBudgetUsd: z.number().positive().optional(),
    maxTurns: z.number().int().positive().optional(),
    headless: z.boolean().optional(),
  })
  .passthrough()

export const ConfigSchema = z.object({
  mode: z.enum(['observe', 'suggest', 'auto']).default('observe'),
  log: z
    .object({
      level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
      file: z.string().optional(),
    })
    .default({}),
  store: z.object({ path: z.string() }),
  /** 持久事件日志与投递（P1a）：全部有默认值，旧配置不用改。 */
  bus: z
    .object({
      maxPerTick: z.number().int().positive().default(50),
      maxAttempts: z.number().int().positive().default(5),
      backoffBaseMs: z.number().int().nonnegative().default(1_000),
      backoffCapMs: z.number().int().positive().default(60_000),
      maxLag: z.number().int().positive().default(5_000),
      maxCatchUp: z.number().int().nonnegative().default(200),
      handlerTimeoutMs: z.number().int().positive().default(5_000),
      ttlDays: z.number().positive().default(14),
      auditTtlDays: z.number().positive().default(30),
    })
    .default({}),
  sources: z.record(SourceCfg).default({}),
  channels: z
    .record(z.object({ plugin: z.string(), defaultChatId: z.string().default('') }).passthrough())
    .default({}),
  classifiers: z
    .record(
      z
        .object({
          plugin: z.string(),
          prompt: z.string(),
          minConfidence: z.number().min(0).max(1).default(0.3),
        })
        .passthrough(),
    )
    .default({}),
  executor_policies: z.record(ExecutorPolicy).default({}),

  /** v2 控制台场景接管哪条命令；缺省仍由 Pipeline 处理 */
  control: z
    .object({
      status: z.enum(['pipeline', 'scenario']).default('pipeline'),
      stop: z.enum(['pipeline', 'scenario']).default('pipeline'),
      new: z.enum(['pipeline', 'scenario']).default('pipeline'),
      messages: z.enum(['pipeline', 'bus']).default('pipeline'),
    })
    .optional(),

  /** 文档执行插件：`docs.<名>.plugin` 指定提供 DocPort 的 v2 插件 */
  docs: z.record(z.object({ plugin: z.string().min(1) })).optional(),

  /** v2 插件配置：`plugins.<名>` / `scenarios.<名>`；`plugin` 缺省时键名即插件 id。 */
  plugins: z
    .record(
      z.object({ plugin: z.string().optional(), enabled: z.boolean().default(true) }).passthrough(),
    )
    .default({}),
  scenarios: z
    .record(
      z.object({ plugin: z.string().optional(), enabled: z.boolean().default(true) }).passthrough(),
    )
    .default({}),
  /** 过期数据清理（启动一次，之后每小时一次） */
  cleanup: z
    .object({
      enabled: z.boolean().default(true),
      imageTtlDays: z.number().positive().default(7),
      mappingTtlDays: z.number().positive().default(14),
      questionTtlHours: z.number().positive().default(2),
      maxLogBytes: z.number().positive().default(5 * 1024 * 1024),
      /**
       * 我们自己发起的一次性会话（分析/分类）的转录保留天数，按记录的会话 id 删。
       * 1 天就够：这些转录只在排查「这一轮分类为什么这么判」时回看，钉钉来源的
       * 分析调用一次 300KB 上下，堆两天就是几百兆。
       */
      spawnTtlDays: z.number().positive().default(1),
    })
    .default({}),

  /**
   * 上下文窗口大小：用量那一行的分母，**只是兜底**。
   * 优先用 claude 自己声明的窗口（`CLAUDE_CODE_AUTO_COMPACT_WINDOW`）；0 = 不知道，就不画百分比。
   */
  contextWindow: z.number().nonnegative().default(0),

  /** 自动回复：窗口停下或跑太久时替你说一句（参考项目 auto-reply 插件） */
  auto_reply: z
    .object({
      enabled: z.boolean().default(false),
      pollSeconds: z.number().positive().default(5),
      cooldownSeconds: z.number().nonnegative().default(60),
      policies: z
        .array(
          z.object({
            reply: z.string().min(1),
            enabled: z.boolean().default(true),
            triggers: z
              .array(
                z.object({
                  when: z.enum(['stopped', 'busy']).default('stopped'),
                  afterSeconds: z.number().nonnegative().optional(),
                  busySeconds: z.number().nonnegative().optional(),
                  match: z
                    .union([
                      z.string(),
                      z.array(z.object({ mode: z.enum(['prefix', 'contains', 'regex']), text: z.string() })),
                    ])
                    .optional(),
                }),
              )
              .min(1),
          }),
        )
        .default([]),
    })
    .default({}),

  sessions: z
    .object({
      /** 选择工作区时最多列几个（参考项目 pickMax，默认 20） */
      pickMax: z.number().int().positive().default(20),
      /** 恢复会话时最多列几个（参考项目 resumeMax，默认 8） */
      resumeMax: z.number().int().positive().default(8),
      /** judge：群里的新消息照常判断；open：群里的新消息就是「开一个窗口」 */
      newTopicPolicy: z.enum(['judge', 'open']).default('judge'),
      /** 等待用户选择（选工作区）的有效期 */
      choiceTtlMs: z.number().int().positive().default(30 * 60_000),
      /** 自动回执的冷却：同一类回执在这个窗口内只回一次 */
      replyCooldownMs: z.number().int().nonnegative().default(10_000),
      /** 状态卡按这个间隔刷执行器进度（0 = 不刷） */
      cardRefreshMs: z.number().int().nonnegative().default(2000),
      /**
       * 预留：目前**不参与任何判定**。
       *
       * 曾经用它判「多久没动静 = 窗口关了 → 撤置顶」，结果把「开着但没人说话」的窗口判死
       * （2026-11-09：claude 一轮结束丢置顶、dsh 每半小时丢一次）。现在「还开着吗」只看会话状态，
       * 保留字段只为兼容已有的 `data/local.json` 覆盖层。
       */
      staleMinutes: z.number().int().positive().default(30),
      /** 判「窗口已关」前的保护期：刚建/刚活动过的先不动，避免误杀 */
      closeGraceMinutes: z.number().int().nonnegative().default(2),
      /** 电脑上自己开的终端窗口要不要自动接进飞书（建话题 + 置顶） */
      adoptLocalWindows: z.boolean().default(false),
      /** 多久扫一次本地窗口（秒） */
      adoptIntervalSeconds: z.number().int().positive().default(20),
      /** 一轮最多接几个，避免一次冒出一堆话题 */
      adoptPerRun: z.number().int().positive().default(2),
      /**
       * dsh 会话要「这么新」才算刚打开的窗口（分钟）。
       * dsh 没有窗口概念，只能按「文件最近被写过」推断在跑；把去年建的会话翻开写一行也会命中，
       * 所以再按创建时间挡一道：只接真正新开的。
       */
      adoptNewMinutes: z.number().int().positive().default(10),
    })
    .default({}),
  limits: z
    .object({
      maxConcurrentSessions: z.number().int().positive().default(2),
      maxSessionMB: z.number().positive().default(80),
    })
    .default({}),
})

export type Config = z.infer<typeof ConfigSchema>

const WorkspaceSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  kind: z.enum(['umbrella', 'repo']),
  root: z.string().min(1),
  executor: z.enum(['claude', 'dsh']),
  isolation: z.enum(['session', 'worktree']),
  concurrency: z.number().int().positive().default(1),
  freshSession: z.boolean().default(true),
  repoHint: z.enum(['from-router', 'explicit']).optional(),
  reposIndex: z.string().optional(),
  router: z.string().optional(),
  aliases: z.array(z.string()).default([]),
})

export const ProjectsSchema = z.object({ workspaces: z.array(WorkspaceSchema) })
export type Projects = z.infer<typeof ProjectsSchema>
export type Workspace = z.infer<typeof WorkspaceSchema>

function readYaml(path: string): unknown {
  return parse(readFileSync(path, 'utf8'))
}

/** 校验失败一次性列出全部问题，不逐条重试。 */
export function assertValid<S extends z.ZodTypeAny>(schema: S, data: unknown, label: string): z.infer<S> {
  const r = schema.safeParse(data)
  if (!r.success) {
    const lines = r.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
    throw new Error(`${label} 校验失败（${r.error.issues.length} 处）：\n${lines.join('\n')}`)
  }
  return r.data as z.infer<S>
}

export function loadConfig(path: string): Config {
  return assertValid(ConfigSchema, readYaml(path), path)
}

/** 深合并：只对「两边都是纯对象」的键递归，其余一律覆盖（数组整体替换，不拼接）。 */
export function deepMerge(base: unknown, over: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(over)) return over
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(over)) out[k] = k in out ? deepMerge(out[k], v) : v
  return out
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * 配置分层：`config/*.yaml` 是带注释的基线，`data/local.json` 是本机覆盖。
 * 页面只写覆盖层，YAML 从不被程序写回——写回会丢注释，而注释是这个项目的文档。
 */
export function loadConfigLayered(configPath: string, overlayPath: string): Config {
  const base = readYaml(configPath)
  const overlay = existsSync(overlayPath) ? readYaml(overlayPath) : undefined
  const merged = overlay === undefined ? base : deepMerge(base, overlay)
  return assertValid(ConfigSchema, merged, overlay === undefined ? configPath : `${configPath} + ${overlayPath}`)
}

/** 把一份补丁合并进覆盖层并校验；校验不过则不落盘。 */
export function writeOverlay(configPath: string, overlayPath: string, patch: unknown): void {
  const existing = existsSync(overlayPath) ? readYaml(overlayPath) : {}
  const next = deepMerge(existing, patch)
  assertValid(ConfigSchema, deepMerge(readYaml(configPath), next), `覆盖层 ${overlayPath}`)
  mkdirSync(dirname(overlayPath), { recursive: true })
  writeFileSync(overlayPath, JSON.stringify(next, null, 2) + '\n', 'utf8')
}

export function loadProjects(path: string): Projects {
  const p = assertValid(ProjectsSchema, readYaml(path), path)
  const ids = new Set<string>()
  for (const w of p.workspaces) {
    if (ids.has(w.id)) throw new Error(`${path}: workspace id 重复：${w.id}`)
    ids.add(w.id)
  }
  return p
}

/** 历史入口：路径门禁已移到 domain，内核调用方无需改 import。 */
export { assertAllowedRoot } from '../domain/allow-root.ts'
