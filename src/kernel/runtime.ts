/** 常驻主循环：起源 → 主循环（收事件 → 投发件箱 → 回收结果）→ 优雅退出。 */

import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync, appendFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { Channel, Classifier, DocPort, Executor, Log, Source } from '../domain/ports.ts'
import type { Event } from '../domain/types.ts'
import type { Config, Projects } from './config.ts'
import { loadConfigLayered, loadProjects } from './config.ts'
import { Outbox } from './outbox.ts'
import { EventLog } from './event-log.ts'
import { Capabilities } from './capabilities.ts'
import { createReceiptSettler } from './receipts.ts'
import { emitAskRequested, emitPermissionRequested } from './hook-events.ts'
import { createGate } from './policy.ts'
import { createEffectRouter } from './effect-router.ts'
import { registerKernelCapabilities } from './kernel-capabilities.ts'
import { createDeliver, Pipeline } from './pipeline.ts'
import { startSources } from './source-start.ts'
import { registerSessionOpenHandlers } from './session-open.ts'
import { filterByOwnership } from './plugin-v2/ownership.ts'
import { resolvePluginSections } from './config-alias.ts'
import type { Store } from './store.ts'
import { openStore } from './store.ts'
import { assemble, PLUGIN_DIR, type Ports } from './wiring.ts'
import { assembleV2, discoverPluginsV2 } from './plugin-v2/index.ts'
import { HotCapabilityManager } from './plugin-v2/hot.ts'
import { startHookServer, type HookPayload } from './hook-server.ts'
import { createHookHandlers } from './hook-handlers.ts'
import { runCleanup } from './cleanup.ts'
import { setSpawnRecorder } from '../plugin-kit/internal-claude.ts'
import { defaultSpawnDirs, purgeSpawnFiles } from '../plugin-kit/internal-session-files.ts'
import { buildHookDecision, buildPermissionCard, buildPermissionDecision, waitForAnswer, buildQuestionCard, renderQuestion } from './questions.ts'
import { isPresent, presencePath } from './presence.ts'
import { startPresenceSampler } from '../plugin-kit/presence-sampler.ts'
import type { PendingQuestion } from './store.ts'
import { dedupeKey, eventId } from './ids.ts'
import type { Ruleset } from '../routing/rules.ts'
import { loadRules } from '../routing/rules.ts'

export interface RuntimeOptions {
  root: string
  /** 主循环节拍 */
  tickMs?: number
  signal?: AbortSignal
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const

/** 日志：同一条同时写 stderr 与文件；文件写失败不影响主流程。 */
export function makeLog(minLevel: keyof typeof LEVELS, file?: string): Log {
  const threshold = LEVELS[minLevel]
  return (level, msg, extra) => {
    if (LEVELS[level] < threshold) return
    const line = `${new Date().toISOString()} ${level.toUpperCase()} ${msg}${
      extra === undefined ? '' : ' ' + JSON.stringify(extra)
    }`
    process.stderr.write(line + '\n')
    if (!file) return
    try {
      mkdirSync(dirname(file), { recursive: true })
      appendFileSync(file, line + '\n')
    } catch {
      /* 日志文件不可写不应拖垮主流程 */
    }
  }
}

export interface PidLock {
  release(): void
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * 单实例锁：同一份 data 只允许一个常驻进程。
 * 同一订阅并行起第二个 daemon 会让云事件被随机切分，所以这里必须硬拒。
 */
export function acquireLock(file: string): PidLock {
  mkdirSync(dirname(file), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, String(process.pid), { flag: 'wx' })
      return {
        release: () => {
          try {
            if (Number(readFileSync(file, 'utf8').trim()) === process.pid) unlinkSync(file)
          } catch {
            /* 已经被清掉就算了 */
          }
        },
      }
    } catch {
      const pid = Number(readFileSync(file, 'utf8').trim() || '0')
      // 同一个进程重复拿锁也算占用：两个运行体同时跑就是双 daemon
      if (pid > 0 && alive(pid)) {
        throw new Error(`已有实例在跑（pid=${pid}）。先停掉它，或删掉 ${file} 再试`)
      }
      unlinkSync(file) // 陈旧锁：进程已经不在了
    }
  }
  throw new Error(`拿不到单实例锁：${file}`)
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveP) => {
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolveP()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}

/** 配置覆盖层是否变了：变了才尝试热同步，没变不扫目录。 */
function overlayStamp(root: string): number {
  try {
    return statSync(resolve(root, 'data/local.json')).mtimeMs
  } catch {
    return 0
  }
}

/** 配置 → 已装配的运行体。doctor、run、ui 共用，避免几条路径各写一套。 */
export interface Bundle {
  config: Config
  projects: Projects
  rules: Ruleset
  store: Store
  pipeline: Pipeline
  outbox: Outbox
  eventLog: EventLog
  capabilities: Capabilities
  /** 纯能力插件的热加载管理器 */
  hot?: HotCapabilityManager
  ports: Ports
  classifier?: { impl: Classifier; minConfidence: number }
  discovered: string[]
  /** v2 插件 stop（逆序、幂等）；无 v2 插件时为空 */
  stopV2?: () => Promise<void>
  /** 本次装配启用的 v2 插件 id（决定哪些注册端口要启动/停止） */
  v2Plugins: string[]
}

/** 清理一轮：图片、映射、残留提问、超大日志。失败只记日志，不影响收发。 */
function cleanupOnce(bundle: Bundle, root: string, log: Log): void {
  const cfg = bundle.config.cleanup
  if (!cfg?.enabled) return
  try {
    const r = runCleanup({
      dataDir: resolve(root, 'data'),
      logDir: resolve(root, 'logs'),
      imageTtlDays: cfg.imageTtlDays,
      maxLogBytes: cfg.maxLogBytes,
    })
    const map = bundle.store.pruneMessageMap(cfg.mappingTtlDays * 86_400_000)
    const q = bundle.store.pruneQuestions(cfg.questionTtlHours * 3_600_000)
    const ev = bundle.eventLog.prune(bundle.config.bus.ttlDays * 86_400_000)
    const auditCutoff = new Date(Date.now() - bundle.config.bus.auditTtlDays * 86_400_000).toISOString()
    const calls = bundle.store.pruneCapabilityCalls(auditCutoff)
    // 我们自己发起的一次性会话：按表里的 id 删转录（分析/分类每次都在磁盘上留一个文件）
    const spawnCutoff = new Date(Date.now() - cfg.spawnTtlDays * 86_400_000).toISOString()
    const todo = bundle.store.listSpawnsToPurge(spawnCutoff)
    const purge = purgeSpawnFiles(todo, defaultSpawnDirs())
    for (const sid of [...purge.removed, ...purge.missing]) bundle.store.markSpawnPurged(sid)
    if (purge.removed.length) log('info', `清理：一次性会话转录 ${purge.removed.length} 个`)
    if (purge.failed.length) log('warn', `清理：${purge.failed.length} 个一次性会话没删掉（下次再试）：${purge.failed[0]?.error ?? ''}`)
    if (r.images || r.logs || map || q || ev.events || ev.deliveries || calls) {
      log(
        'info',
        `清理：图片 ${r.images} / 日志 ${r.logs} / 映射 ${map} / 提问 ${q} / 事件 ${ev.events} / 死信 ${ev.deliveries} / 能力审计 ${calls}`,
      )
    }
  } catch (e) {
    log('warn', `清理失败（不影响收发）：${e instanceof Error ? e.message : String(e)}`)
  }
}

export async function buildBundle(root: string, log: Log, opts: { readOnlyStore?: boolean } = {}): Promise<Bundle> {
  const config = loadConfigLayered(resolve(root, 'config/lingcub.yaml'), resolve(root, 'data/local.json'))
  const projects = loadProjects(resolve(root, 'config/projects.yaml'))
  const rules = loadRules(resolve(root, 'config/rules.yaml'))
  const store = openStore(resolve(root, config.store.path), { readOnly: opts.readOnlyStore })
  const { ports, discovered } = await assemble(PLUGIN_DIR, config, log)

  const classifierName = Object.keys(config.classifiers).sort()[0]
  const classifierEntry = classifierName ? config.classifiers[classifierName] : undefined
  const classifierPort = classifierEntry ? ports.classifiers.get(classifierEntry.plugin) : undefined
  const classifier =
    classifierPort && classifierEntry
      ? { impl: classifierPort, minConfidence: classifierEntry.minConfidence }
      : undefined

  const eventLog = new EventLog(store, {
    log,
    maxPerTick: config.bus.maxPerTick,
    maxAttempts: config.bus.maxAttempts,
    backoffBaseMs: config.bus.backoffBaseMs,
    backoffCapMs: config.bus.backoffCapMs,
    maxLag: config.bus.maxLag,
    maxCatchUp: config.bus.maxCatchUp,
    handlerTimeoutMs: config.bus.handlerTimeoutMs,
  })
  // 发件箱终态回填能力收据；发件箱仍是唯一副作用出口。
  const outbox = new Outbox(store, createDeliver({ ports, config, projects, store, eventLog, log }), {
    log,
    onSettled: createReceiptSettler(store, eventLog, log),
  })
  const capabilities = new Capabilities(store, {
    log,
    gate: createGate({
      config,
      store,
      log,
      onPending: (req, confirmationId) => {
        eventLog.append({
          id: `confirm:${confirmationId}`,
          kind: 'confirmation.requested',
          source: 'kernel',
          subject: `receipt:${req.receiptId}`,
          payload: {
            confirmationId,
            receiptId: req.receiptId,
            caller: req.caller,
            name: req.name,
            input: req.input,
          },
        })
      },
    }),
    enqueue: createEffectRouter({ store, outbox, config, projects }),
  })
  registerKernelCapabilities({ capabilities, config, projects, rules, classifier, ports, store, log })
  const discoveredV2 = await discoverPluginsV2(PLUGIN_DIR)
  const owned = filterByOwnership(discoveredV2, config.control, resolvePluginSections(config).enabled)
  for (const s of owned.skipped) log('warn', `插件 ${s.id} 未装配：${s.reason}`)
  const hotPlugins = owned.kept.filter((p) => p.manifest.activation === 'hot')
  const normalPlugins = owned.kept.filter((p) => p.manifest.activation !== 'hot')
  const v2 = await assembleV2(normalPlugins, {
    config,
    log,
    eventLog,
    capabilities,
    onPort: (id, port) => addV2Port(ports, id, port),
  })
  // 纯能力插件不进常规装配：先建管理器，再由它按 enabled 注册/注销能力。
  const hot = new HotCapabilityManager({ capabilities, eventLog, log })
  const hotSync = await hot.sync(hotPlugins, config)
  for (const err of hotSync.errors) log('warn', `热加载失败：${err}`)
  const pipeline = new Pipeline({
    store,
    outbox,
    eventLog,
    config,
    projects,
    rules,
    ports,
    sessions: store,
    classifier,
    log,
  })
  return {
    config,
    projects,
    rules,
    store,
    pipeline,
    outbox,
    eventLog,
    capabilities,
    hot,
    ports,
    classifier,
    discovered,
    stopV2: v2.stop,
    v2Plugins: v2.order,
  }
}

function addV2Port(ports: Ports, id: string, port: unknown): void {
  const p = port as Record<string, unknown>
  if (typeof p.send === 'function') {
    ports.channels.set(id, port as Channel)
    return
  }
  if (typeof p.read === 'function' && typeof p.write === 'function') {
    ports.docs ??= new Map()
    ports.docs.set(id, port as DocPort)
    return
  }
  if (typeof p.classify === 'function') {
    ports.classifiers.set(id, port as Classifier)
    return
  }
  if (typeof p.read === 'function' && typeof p.start === 'function') {
    ports.executors.set(id, port as Executor)
    return
  }
  if (typeof p.start === 'function') {
    ports.sources.set(id, port as Source)
    return
  }
  throw new Error(`v2 插件 ${id} 注册的端口无法识别（既不是 channel/classifier/executor/source）`)
}

export async function runRuntime(opts: RuntimeOptions): Promise<void> {
  const root = opts.root
  const tickMs = opts.tickMs ?? 1000
  const config = loadConfigLayered(resolve(root, 'config/lingcub.yaml'), resolve(root, 'data/local.json'))
  const log = makeLog(config.log.level, resolve(root, config.log.file ?? 'data/lingcub.log'))

  const lock = acquireLock(resolve(root, 'data/lingcub.lock'))
  let bundle: Bundle
  try {
    bundle = await buildBundle(root, log)
  } catch (e) {
    lock.release() // 起不来就别占着锁，否则下次启动会被自己的残留挡住
    throw e
  }
  const { store, outbox, pipeline, projects, ports, eventLog } = bundle
  // 平台自己发起的一次性调用（分析/分类）也把会话 id 记下来：清理按 id 删，不靠内容匹配
  setSpawnRecorder((rec) => {
    try {
      store.recordSpawn(rec.sessionId, rec.executor, rec.purpose)
    } catch {
      /* 记账失败不该拖垮这次调用 */
    }
  })

  const controller = new AbortController()
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort()
    else opts.signal.addEventListener('abort', () => controller.abort(), { once: true })
  }
  const signal = controller.signal

  const recovered = store.recoverOutbox()
  if (recovered) log('warn', `重启恢复：${recovered} 条发件箱回到 pending`)
  const recoveredEvents = eventLog.recover()
  if (recoveredEvents) log('warn', `重启恢复：${recoveredEvents} 条事件投递回到 pending`)
  registerSessionOpenHandlers({ store, eventLog, log })

  log(
    'info',
    `启动：mode=${bundle.config.mode} 工作区=${projects.workspaces.length} 插件=${bundle.discovered.length} pid=${process.pid}`,
  )

  // 投递链：同一时刻只处理一条事件，避免并发写库与重复判重竞态
  let chain: Promise<unknown> = Promise.resolve()
  const emit = (e: Event): void => {
    chain = chain.then(() => pipeline.ingest(e)).catch((err: unknown) => {
      log('error', `事件处理失败：${err instanceof Error ? err.message : String(err)}`)
    })
  }

  const sources = await startSources({
    ports,
    sources: bundle.config.sources,
    v2Plugins: bundle.v2Plugins,
    emit,
    log,
  })
  if (!sources.started.length) log('warn', '没有启用任何来源，只有主循环在跑')

  const shutdown = (): void => controller.abort()
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)

  // 结果回传：claude 的 Stop 钩子打到这里，转成一条回话题的消息（仍走发件箱）
  const handlers = createHookHandlers({
    store,
    outbox,
    log,
    contextWindow: bundle.config.contextWindow,
    onTurnEnd: (session, p) => {
      bundle.eventLog.append({
        // 事件 id 必须每轮唯一：以前拼「会话 id + 载荷正文」，而 Claude 的 Stop 载荷没有正文
        // （正文是我们从转录取的），于是每轮同 id → 被去重 → turn.ended 一辈子只发一条，私聊摘要永不触发。
        id: eventId('hook', `${session.id}:${Date.now()}`),
        kind: 'session.turn.ended',
        source: 'kernel',
        subject: session.id,
        payload: {
          sessionId: session.id,
          executorSessionId: session.sessionId ?? p.session_id,
          text: p.last_assistant_message ?? '',
        },
      })
    },
  })
  // 参考项目 away 档默认等 30 分钟：手机作答是核心场景，4 分钟太短
  const askTimeoutMs = Number(process.env.LINGCUB_ASK_TIMEOUT_MS ?? 1_800_000)
  /** 等作答期间重探在场的间隔：人一回到电脑前就立刻交还，别让终端干等 */
  const PRESENCE_PROBE_MS = 3_000
  const onAsk = async (p: HookPayload): Promise<Record<string, unknown>> => {
    const sid = p.session_id
    const questions = ((p.tool_input as { questions?: unknown[] } | undefined)?.questions ?? []) as PendingQuestion['questions']
    if (!sid || !questions.length) return {}
    const session = store.findSessionByExecutor(sid)
    if (!session) return {} // 不是本进程起的窗口：不代答，让终端弹窗照常出现
    // 人在电脑前就让终端弹窗照常出现，别把人晾在飞书上；
    // 但飞书仍推一张**不带按钮**的提醒卡，让手机那头知道「有个窗口在等你」（参考项目 noticeOnly 同款）。
    if (isPresent(root)) {
      const first = questions[0]
      outbox.enqueue(
        {
          kind: 'card_send',
          sessionId: session.id,
          chatId: session.chatId,
          replyTo: session.rootMessageId ?? session.threadId,
          card: {
            kind: 'here-notice',
            noticeKind: 'question',
            question: first ? `${first.header ? `${first.header}：` : ''}${first.question}` : '',
            workspace: session.workspace,
          },
        },
        dedupeKey(`here-${sid}`, 'ask-notice'),
      )
      log('info', `人在电脑前，选择题留给终端（飞书只推提醒卡）：${session.id}`)
      return {}
    }

    const now = Date.now()
    const id = `q-${sid}-${now}`
    store.insertQuestion({
      id,
      sessionId: session.id,
      questions,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + askTimeoutMs).toISOString(),
    })
    const pending = store.getQuestion(id)
    outbox.enqueue(
      {
        kind: 'reply_only',
        chatId: session.chatId,
        replyTo: session.rootMessageId ?? session.threadId,
        text: pending ? renderQuestion(pending) : '（有一道题要你答）',
      },
      dedupeKey(id, 'ask'),
    )
    // 带按钮的卡：选项一键作答，底部还能「交还终端」
    outbox.enqueue(
      {
        kind: 'card_send',
        sessionId: session.id,
        chatId: session.chatId,
        replyTo: session.rootMessageId ?? session.threadId,
        card: buildQuestionCard(id, pending ?? null, session),
      },
      dedupeKey(id, 'ask-card'),
    )
    log('info', `选择题已推到话题：${session.id}`)
    try {
      emitAskRequested(bundle.eventLog, {
        sessionId: session.id,
        executorSessionId: sid,
        questionId: id,
        questions,
      })
    } catch (err) {
      log('warn', `选择题事件写入失败（已忽略）：${err instanceof Error ? err.message : String(err)}`)
    }

    // 挂起等作答：不占内存状态，靠库里的记录，进程重启也能继续等。
    // 期间每 3 秒重探在场：人回到电脑前就交还终端（参考项目 handover 同款）。
    const r = await waitForAnswer(id, {
      getQuestion: (x) => store.getQuestion(x),
      status: (x) => store.questionStatus(x),
      handBack: (x, why) => store.handBackQuestion(x, why === 'timeout' ? 'timeout' : 'hands'),
      present: () => isPresent(root),
      probeMs: PRESENCE_PROBE_MS,
      deadline: now + askTimeoutMs,
    })
    if (r.outcome === 'answered') return buildHookDecision(r.question)
    if (r.why === 'present') log('info', `人回到电脑前，选择题交还终端：${session.id}`)
    else if (r.why === 'timeout') log('warn', `选择题等太久，已交还终端：${session.id}`)
    else log('info', `选择题交还终端：${session.id}`)
    return {}
  }

  const onPermission = async (p: HookPayload): Promise<Record<string, unknown>> => {
    const sid = p.session_id
    const session = sid ? store.findSessionByExecutor(sid) : null
    if (!sid || !session) return {}
    if (isPresent(root)) {
      log('debug', '人在电脑前，工具授权留给终端')
      return {}
    }
    const input = { tool_name: p.tool_name as string | undefined, tool_input: p.tool_input }
    const now = Date.now()
    if (isPresent(root)) {
      outbox.enqueue(
        {
          kind: 'card_send',
          sessionId: session.id,
          chatId: session.chatId,
          replyTo: session.rootMessageId ?? session.threadId,
          card: {
            kind: 'here-notice',
            noticeKind: 'permission',
            toolName: input.tool_name,
            workspace: session.workspace,
          },
        },
        dedupeKey(`here-${sid}`, 'perm-notice'),
      )
      log('info', `人在电脑前，工具授权留给终端（飞书只推提醒卡）：${session.id}`)
      return {}
    }
    const id = `perm-${sid}-${now}`
    store.insertQuestion({
      id,
      sessionId: session.id,
      questions: [],
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + askTimeoutMs).toISOString(),
      kind: 'permission',
    })
    // 主形态是卡片：四个按钮就是四种答案。
    // 自由文字分不清「允许」是在回答还是新指令，所以文字只认整行 1 / 2（在 pipeline 里收窄）。
    outbox.enqueue(
      {
        kind: 'card_send',
        sessionId: session.id,
        chatId: session.chatId,
        replyTo: session.rootMessageId ?? session.threadId,
        card: buildPermissionCard(id, input, {
          chatId: session.chatId,
          threadId: session.threadId,
          rootMessageId: session.rootMessageId,
          workspace: session.workspace,
        }),
      },
      dedupeKey(id, 'perm-card'),
    )
    log('info', `工具授权已推到话题：${session.id} ${input.tool_name ?? ''}`)
    try {
      emitPermissionRequested(bundle.eventLog, {
        sessionId: session.id,
        executorSessionId: sid,
        questionId: id,
        toolName: input.tool_name,
        toolInput: input.tool_input,
      })
    } catch (err) {
      log('warn', `授权事件写入失败（已忽略）：${err instanceof Error ? err.message : String(err)}`)
    }

    // 等作答同选择题：每 3 秒重探在场，人回来就交还终端；等太久也交还（不假装答过）
    const r = await waitForAnswer(id, {
      getQuestion: (x) => store.getQuestion(x),
      status: (x) => store.questionStatus(x),
      handBack: (x, why) => store.handBackQuestion(x, why === 'timeout' ? 'timeout' : 'hands'),
      present: () => isPresent(root),
      probeMs: PRESENCE_PROBE_MS,
      deadline: now + askTimeoutMs,
    })
    if (r.outcome === 'answered') {
      return buildPermissionDecision(r.question.answers, p.tool_input, input.tool_name)
    }
    log('info', `工具授权交还终端：${session.id}（${r.why}）`)
    return {}
  }

  const hooks = await startHookServer({
    root,
    log: (level, msg) => log(level, msg),
    ...handlers,
    onAsk,
    onPermission,
    // 钩子把回复入队后立刻投递一次：主循环一拍里还要跑分析、刷卡片，等它要十几秒
    kick: () => {
      void outbox.tick(20).catch((e: unknown) => log('warn', `立即投递失败（下一拍继续）：${e instanceof Error ? e.message : String(e)}`))
    },
  })
  log('info', `钩子端点已就绪：127.0.0.1:${hooks.port}`)

  // 在场采样：代答类钩子要判断「人是不是就在电脑前」，决定拦不拦。
  // 只支持 Windows（GetLastInputInfo）；其它平台不启动，内核读不到采样文件就按「不在」处理。
  const presence =
    process.platform === 'win32'
      ? startPresenceSampler({ file: presencePath(root), log: (level, msg) => log(level, msg) })
      : { stop: async () => {} }

  let lastCleanup = 0 // 首轮就会跑一次
  let lastAdopt = 0 // 首轮就会扫一次本地窗口
  let lastOverlay = overlayStamp(root)
  const applyHotConfig = async (): Promise<void> => {
    if (!bundle.hot) return
    let next: Config
    try {
      next = loadConfigLayered(resolve(root, 'config/lingcub.yaml'), resolve(root, 'data/local.json'))
    } catch (err) {
      log('warn', `配置覆盖层读取失败，跳过热同步：${err instanceof Error ? err.message : String(err)}`)
      return
    }
    const r = await bundle.hot.syncDir(PLUGIN_DIR, next)
    if (r.loaded.length || r.unloaded.length) {
      log('info', `热同步：加载 ${r.loaded.join(',') || '-'} 卸载 ${r.unloaded.join(',') || '-'}`)
    }
    for (const e of r.errors) log('warn', `热同步失败：${e}`)
  }
  try {
    while (!signal.aborted) {
      // 「保存并重启」：面板写下请求文件，这里看到就优雅退出，由入口脚本拉起新进程
      if (existsSync(restartRequestPath(root))) {
        unlinkSync(restartRequestPath(root))
        log('info', '收到重启请求，本次退出（入口脚本会拉起新进程）')
        process.exitCode = RESTART_EXIT_CODE
        controller.abort()
        break
      }
      await chain
      try {
        const stamp = overlayStamp(root)
        if (stamp !== lastOverlay) {
          lastOverlay = stamp
          await applyHotConfig()
        }
        // 先投递：用户最在意「话说完了没有」；分析和刷卡片慢一拍不影响体感
        const deliveredFirst = await outbox.tick(20)
        if (deliveredFirst.done) log('debug', `优先投递 ${deliveredFirst.done} 条`)
        const ev = await eventLog.tick()
        if (ev.delivered || ev.retried || ev.dead || ev.skipped) {
          log('info', `事件：投递=${ev.delivered} 重试=${ev.retried} 死信=${ev.dead} 跳过=${ev.skipped}`)
        }
        const delivered = await outbox.tick(20)
        const autoReplied = await pipeline.autoReplyTick()
        if (autoReplied) log('info', `自动回复：${autoReplied} 个窗口`)
        const cards = await pipeline.refreshCards()
        // 电脑上自己开的终端窗口：按间隔扫一次，接进飞书（建话题 + 置顶）
        const adoptEveryMs = (bundle.config.sessions?.adoptIntervalSeconds ?? 20) * 1000
        if (Date.now() - lastAdopt >= adoptEveryMs) {
          lastAdopt = Date.now()
          const adopted = await pipeline.adoptLocalWindows()
          if (adopted) log('info', `接入本地窗口：${adopted} 个`)
        }
        const reaped = await pipeline.reapDeadSessions()
        if (reaped) log('info', `关窗回收：${reaped} 个会话标记 dead`)
        await pipeline.reconcilePins()
        const settled = await pipeline.collect()
        // 启动时一次，之后每小时一次；顺手把「已结束很久的会话」也标成 stopped
        if (Date.now() - lastCleanup >= 3_600_000) {
          lastCleanup = Date.now()
          cleanupOnce(bundle, root, log)
        }
        if (delivered.done || delivered.failed || delivered.dead || settled || cards) {
          log(
            'info',
            `一轮：投递 done=${delivered.done} 重试=${delivered.failed} 死信=${delivered.dead} 收敛=${settled} 新卡=${cards}`,
          )
        }
      } catch (err) {
        // 任何一步失败都不许拖垮常驻：记日志，下一拍继续。
        log(
          'error',
          `主循环一轮失败（继续）：${err instanceof Error ? err.message : String(err)}${
            err instanceof Error && err.stack ? `\n${err.stack.split('\n').slice(1, 4).join(' / ')}` : ''
          }`,
        )
      }
      await sleep(tickMs, signal)
    }
  } finally {
    await presence.stop()
    await sources.stop()
    process.removeListener('SIGINT', shutdown)
    process.removeListener('SIGTERM', shutdown)
    await hooks.close()
    bundle.hot?.unloadAll()
    await bundle.stopV2?.()
    store.close()
    lock.release()
    log('info', '已退出')
  }
}

/** 面板「保存并重启」写的请求文件 */
export function restartRequestPath(root: string): string {
  return resolve(root, 'data/restart-request')
}

/** 用这个退出码表示「要重启」，入口脚本据此判断该不该拉起 */
export const RESTART_EXIT_CODE = 75

export function configExists(root: string): boolean {
  return existsSync(resolve(root, 'config/lingcub.yaml'))
}
