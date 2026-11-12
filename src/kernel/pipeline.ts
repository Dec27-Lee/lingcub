/** 主流程：Event 进 → 判断 → 分派 → 发件箱 → 投递；执行完成后再回收结果。 */

import { join } from 'node:path'
import type { Channel, Classifier, Executor, Log } from '../domain/ports.ts'
import type { Action, CardState, Event, Intent, Progress, ProjectCandidate, Session, Work } from '../domain/types.ts'
import { planSectionWrite } from '../domain/doc-write.ts'
import { evaluate, type Ruleset } from '../routing/rules.ts'
import { resolveWork } from '../routing/resolve.ts'
import { routeToSession, type SessionLookup } from '../routing/session-route.ts'
import { pickAnswer, pickPermissionAnswer } from './questions.ts'
import { HELP_TEXT, parseAbsolutePathCommand, parseCommand } from '../routing/commands.ts'
import { decideAutoReply } from '../routing/auto-reply.ts'
import { buildStatusCard, formatAgo, statusCardSignature } from './card-content.ts'
import { buildNoticeCard } from './notice-card.ts'
import { findDshTranscript, lastDshTurn } from './dsh-transcript.ts'
import { currentTurn, findTranscript, isTurnOpen } from './transcript.ts'
import { statsLine } from './transcript.ts'
import { resolveContextWindow } from './context-window.ts'
import { startSession } from './session-start.ts'
import { requestSessionOpen } from './session-open.ts'
import { assertAllowedRoot } from '../domain/allow-root.ts'
import type { Config, Projects } from './config.ts'
import { dedupeKey, workId } from './ids.ts'
import type { Deliver, Outbox } from './outbox.ts'
import type { Store } from './store.ts'
import type { Ports } from './wiring.ts'
import { existsSync } from 'node:fs'
import { AUTO_REPLY_ENVELOPE, withEnvelope } from './envelope.ts'
import { imageDayDir, replaceImageMarks } from './images.ts'
import { formatElapsed, transcriptTitle } from './transcript.ts'
import { basename, resolve, sep } from 'node:path'

export type IngestOutcome = 'duplicate' | 'posted' | 'ignored' | 'observed' | 'skipped' | 'queued'

/** 没有会话层时的空查表：一切消息都走判断。 */
const NO_SESSIONS: SessionLookup = { findSessionByThread: () => null }

/**
 * 「电脑上自己开的窗口」接进飞书时的来源标签。
 *
 * 按执行器分开记：会话行上的 executor 只影响投递走哪个端口，
 * 下游按 source 判断「这条会话从哪来」（比如要不要发结果回执）时还得靠它。
 */
export const SOURCE_LOCAL_CLAUDE = 'source-local-claude'
export const SOURCE_LOCAL_DSH = 'source-local-dsh'

/**
 * 采纳窗口的会话 id：取执行器会话 id 的前 8 位当短名。
 *
 * dsh 的会话 id 是 `session-<uuid>`，直接切前 8 位会得到 `session-`——
 * 所有 dsh 窗口撞成同一个 id，从第二个起全被当成「已经接过」而静默丢掉。
 */
export function localSessionId(executorSessionId: string): string {
  return `sess-local-${executorSessionId.replace(/^session-/, '').slice(0, 8)}`
}

/** 候选项目只来自 config/projects.yaml：模型在这张表里挑，不许自己编。 */
export function candidatesOf(projects: Projects): ProjectCandidate[] {
  return projects.workspaces.map((w) => ({ id: w.id, name: w.name, aliases: [...w.aliases] }))
}

/** 这个频道发卡时会不会顺手置顶（`channels.<key>.pinCards`）。 */
function pinEnabled(config: Config, channelKey?: string): boolean {
  const entries = Object.entries(config.channels as Record<string, { pinCards?: boolean }>)
  if (channelKey) {
    const hit = entries.find(([k]) => k === channelKey)
    if (hit) return hit[1].pinCards === true
  }
  return entries.some(([, v]) => v.pinCards === true)
}

function executorPort(ports: Ports, config: Config, kind: Work['executor']): Executor {
  const policy = config.executor_policies[kind]
  if (!policy) throw new Error(`执行器 ${kind} 在 executor_policies 里没有策略`)
  const exec = ports.executors.get(policy.plugin)
  if (!exec) throw new Error(`执行器插件 ${policy.plugin} 未装配`)
  return exec
}

/** 回消息走哪个频道：优先配了 defaultChatId 的那个，否则取配置里第一个；都不行就失败。 */
function channelPort(ports: Ports, config: Config): Channel {
  const entries = Object.entries(config.channels)
  const chosen = entries.find(([, c]) => c.defaultChatId) ?? entries[0]
  if (!chosen) throw new Error('config.channels 为空，无处回消息')
  const ch = ports.channels.get(chosen[1].plugin)
  if (!ch) throw new Error(`频道插件 ${chosen[1].plugin} 未装配`)
  return ch
}

/**
 * 从平台的置顶列表里挑出「没人认领」的那些：
 *   - 不在 keep 里（不是任何活窗口当前的卡）
 *   - 明确是机器人 pin 的（`operatorIdType === 'app'`）；不知道谁 pin 的一律不动，免得撤掉用户自己置顶的消息
 */
export function pickOrphanPins(
  pins: readonly { messageId: string; operatorIdType?: string }[],
  keep: ReadonlySet<string>,
  limit = 10,
): string[] {
  if (limit <= 0) return []
  const out: string[] = []
  for (const p of pins) {
    if (out.length >= limit) break
    if (!p.messageId || keep.has(p.messageId)) continue
    // 实测飞书返回的是 `app_id`；用户手动置顶是 `user_id`/`open_id`。只认机器人自己置的。
    if (!p.operatorIdType || !p.operatorIdType.startsWith('app')) continue
    out.push(p.messageId)
  }
  return out
}

/**
 * 该补置顶的卡：活窗口当前那张卡，且本地记着还没置顶。
 * 新卡走 `card_send`（不置顶），所以只有 adopt 那一刻会 pin——不补的话活窗口会一张置顶都没有。
 */
export function pickPinsToRestore(
  candidates: readonly { sessionId: string; messageId: string; pinned: boolean; alive: boolean }[],
  limit = 3,
): { sessionId: string; messageId: string }[] {
  if (limit <= 0) return []
  const out: { sessionId: string; messageId: string }[] = []
  for (const c of candidates) {
    if (out.length >= limit) break
    if (!c.alive || c.pinned || !c.messageId) continue
    out.push({ sessionId: c.sessionId, messageId: c.messageId })
  }
  return out
}

/**
 * 「这个窗口现在还开着吗」——决定要不要保留/补回它的置顶。
 *
 * **只看 `status`**，而 status 由两件事实维护：claude 的 `agents --json` 进程表
 * （`reapDeadSessions` 每轮对一次），以及用户显式的 `#stop`。
 *
 * 不能在这里叠「多久没说话」：窗口开着、人在看代码一小时没发言，按时间判就会把
 * 它的置顶撤掉（2026-11-09 就这么丢掉过 5 个窗口的置顶）。dsh 连进程信号都没有，
 * 拿「会话文件多久没动」当关窗信号同样会把「开着但没人说话」的窗口判死——
 * 所以 dsh 的生命周期只由 `#stop` 结束，不猜。
 */
export function windowStillOpen(s: { status: string }): boolean {
  return s.status === 'active'
}

/**
 * 改卡失败是不是「临时的」（网络 / 超时 / 限流）。
 *
 * 这类失败**不能换新卡**：换卡等于撤掉旧卡的置顶、再给新卡重新置顶，
 * 而重试期间旧卡已经没人认领了（2026-11-09：token 接口超时 → 改卡失败 → 换新卡 → 置顶也失败 → 那个窗口的置顶就没了）。
 * 只有「消息不存在 / 超过 14 天 / 被撤回」这种说了也改不动的，才值得换卡。
 */
export function isTransientCardError(message: string): boolean {
  // 超时的文案来自 plugin-kit/spawn.ts 的中文「命令超时」，只认英文关键词会把它判成永久失败
  return /network|timeout|timed out|deadline|rate limit|too many|429|502|503|504|ECONNRESET|ETIMEDOUT|超时/i.test(
    message,
  )
}

/**
 * 旧版（schemaV1）卡片**永远**改不动：飞书返回
 * `schemaV2 card can not change schemaV1`（code 230099 / ext 200830）。
 *
 * 这类卡多是窗口接入之前就存在的（实测 2026-10-30 建的一张卡，到 11-10 才发现一直改不动），
 * 重试多久都没用，只能在同一话题里发一张新卡。
 */
export function isLegacyCardError(message: string): boolean {
  return /schemaV2 card can not change schemaV1/i.test(message) || /200830/.test(message)
}

/** 发件箱的投递实现：把 Action 交给对应端口。 */
export function createDeliver(deps: {
  ports: Ports
  config: Config
  projects: Projects
  store: Store
  eventLog?: import('./event-log.ts').EventLog
  log: Log
}): Deliver {
  const { ports, config, projects, store, eventLog, log } = deps
  /**
   * 状态卡必须一直钉在飞书的「Pin 消息」面板里：那张卡就是话题根消息，
   * 而面板只列主消息流的消息 —— 面板里没有它，等于这个窗口在控制台里不存在。
   *
   * 会丢的情况都真实发生过：平台侧被撤、早期发卡没钉上、卡换过消息。
   * 所以每次改卡/建卡之后都过一遍这里；本地记着已置顶就不再调 CLI（一次 pin 一个子进程）。
   */
  const ensureCardPinned = async (ch: Channel, sessionId: string, messageId: string): Promise<void> => {
    if (!pinEnabled(config) || !ch.pinMessage) return
    if (store.isCardPinned(sessionId)) return
    try {
      await ch.pinMessage(messageId, true)
      store.setCardPinned(sessionId, true)
      log('info', `补回置顶：${sessionId}（${messageId}）`)
    } catch (e) {
      // 置顶失败不影响卡内容本身：下一拍还会再试
      log('warn', `补置顶失败（下轮再试）：${sessionId} — ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return async (action: Action, key: string) => {
    switch (action.kind) {
      case 'open_session': {
        if (!eventLog) throw new Error('开窗请求需要事件总线（eventLog）')
        const policy = config.executor_policies[action.work.executor]
        if (!policy) throw new Error(`执行器 ${action.work.executor} 在 executor_policies 里没有策略`)
        assertAllowedRoot(action.work.workspace, policy.allowRoots)
        const r = requestSessionOpen({ store, eventLog, work: action.work, mode: action.mode, log })
        return { externalId: r.requestId }
      }
      case 'dispatch_session': {
        const handle = await executorPort(ports, config, action.work.executor).start(action.work)
        store.setWorkStatus(action.work.id, 'running', handle.sessionId)
        log('info', `会话已起：${handle.executor}/${handle.sessionId} @ ${handle.workspace}`)

        // 开窗来源：回复进用户发起的那条话题（`--reply-in-thread`），
        // 不再用「发到群」的方式另起话题——那样等于把用户的话题晾在一边。
        const origin = action.work.origin
        if (!origin) return
        const title = origin.title?.trim() || action.work.prompt.slice(0, 40)
        const now = new Date().toISOString()

        // 先绑定再宣告：反过来的话，「窗口已创建」已经发出去了、会话行还没落库，
        // 这时候 claude 立刻回一个 Stop 钩子就找不到会话（消息被静默丢掉）。
        // 换会话：本话题已经有窗口了，改绑而不是再插一条。
        const sessionId = origin.rebindSessionId ?? `sess-${action.work.id}`
        if (origin.rebindSessionId) {
          store.rebindSession(origin.rebindSessionId, handle.sessionId, handle.workspace)
          log('info', `已换会话：话题 ${origin.threadId ?? '-'} → ${handle.sessionId}`)
        } else if (!store.getSession(sessionId)) {
          // 幂等：发锚消息失败会重试，重试时不能因为主键冲突再炸一次
          store.insertSession({
            id: sessionId,
            chatId: origin.chatId,
            source: origin.source,
            // 话题 id 还不知道（要等锚消息回来），先用发送前能确定的那个
            threadId: origin.threadId,
            rootMessageId: origin.rootMessageId,
            ownerId: action.work.ownerId,
            title,
            executor: action.work.executor,
            workspace: action.work.project,
            sessionId: handle.sessionId,
            status: 'active',
            createdAt: now,
            lastActiveAt: now,
          })
        }

        // 就绪卡（参考项目 buildReadyCard）：📁 + 会话短 id + 「直接在这里说话」+
        // 「换会话 / 再开一个」两个按钮。按钮等价于在这个话题里发命令，不是斜杠指令。
        const ch = channelPort(ports, config)
        const sent =
          typeof ch.sendCard === 'function'
            ? await ch.sendCard(
                {
                  chatId: origin.chatId,
                  replyTo: origin.rootMessageId,
                  card: {
                    kind: 'ready',
                    title: `窗口已创建：${title}`,
                    cwd:
                      projects.workspaces.find((w) => w.id === action.work.project)?.root ??
                      action.work.project,
                    sessionId: handle.sessionId,
                    threadId: origin.threadId,
                    rootMessageId: origin.rootMessageId,
                    chatId: origin.chatId,
                  },
                },
                `${key}:anchor`,
              )
            : await ch.send(
                {
                  kind: 'reply_only',
                  chatId: origin.chatId,
                  replyTo: origin.rootMessageId,
                  text: `窗口已创建：${title}`,
                },
                `${key}:anchor`,
              )
        if (!sent.messageId) {
          throw new Error('没能绑定话题：飞书信道没有返回消息 id（检查 channels.feishu.messageIdPath）')
        }
        // 锚消息发出去之后才拿得到「新话题」的 id；话题群里它是 omt_…，普通群里只能先拿锚消息
        // 的 om_… 顶着——路由侧同时用 thread_id / root_message_id 两列反查，所以两种都能回得来。
        if (!origin.threadId) store.setSessionThread(sessionId, sent.messageId)
        // 回复也记进映射：用户引用「窗口已创建」那句话能找回窗口
        if (origin.threadId) store.mapMessage(sent.messageId, sessionId, origin.chatId)
        log('info', `已开窗：话题 ${origin.threadId ?? sent.messageId} ↔ 会话 ${handle.sessionId}`)
        return
      }
      case 'start_session': {
        return startSession(action, { config, ports, store, log })
      }
      case 'dm_send': {
        const ch = channelPort(ports, config)
        if (typeof ch.sendDm !== 'function') throw new Error('频道插件不支持按人私聊（缺 sendDm）')
        const sent = await ch.sendDm({ userId: action.userId, card: action.card }, key)
        return { externalId: sent.messageId }
      }
      case 'transport_send': {
        const ch = ports.channels.get(action.plugin)
        if (!ch) throw new Error(`频道插件未就绪：${action.plugin}`)
        if (typeof ch.sendTransport !== 'function') {
          throw new Error(`频道插件不支持通用出站：${action.plugin}`)
        }
        const sent = await ch.sendTransport({ text: action.text, target: action.target }, key)
        return { externalId: sent.messageId }
      }
      case 'reply_only': {        const sent = await channelPort(ports, config).send(action, key)
        // 记映射：用户引用这条消息时能找回窗口
        if (action.sessionId && sent.messageId) store.mapMessage(sent.messageId, action.sessionId, action.chatId ?? '')
        return { externalId: sent.messageId }
      }
      case 'post_message': {
        let text = action.text
        const session = store.getSession(action.sessionId)
        if (!session) throw new Error(`会话 ${action.sessionId} 不存在`)
        if (!session.sessionId) throw new Error(`会话 ${session.id} 还没有执行器会话 id，无法投递`)
        const ws = projects.workspaces.find((w) => w.id === session.workspace) ?? {
          // 扫描出来的目录没进 projects.yaml：直接当根用
          id: session.workspace,
          root: session.workspace,
        }
        if (action.images?.length) {
          const ch = channelPort(ports, config)
          if (typeof ch.downloadImage !== 'function') throw new Error('频道插件不支持下载图片')
          // 一张一张下（lark-cli 一次只给一个 key），下完在正文里原地换标记。
          // 单张失败只留占位、不整条重试：重投会把已经下过的图和用户那句正文再发一遍。
          const resolved = new Map<string, string | undefined>()
          for (const [i, img] of action.images.entries()) {
            // 相对路径：lark-cli 只接受 cwd 之下的输出路径。
            // 按本地日期分目录 + `<消息id>_<序号>.png`：方便按天找图，手工清理也好挑。
            const outPath = join(
              imageDayDir(join('data', 'images')),
              `${img.messageId}_${i + 1}.png`,
            )
            try {
              resolved.set(img.fileKey, await ch.downloadImage({ ...img, outPath }))
            } catch (err) {
              resolved.set(img.fileKey, undefined)
              log('warn', `图片下载失败 ${img.fileKey}：${err instanceof Error ? err.message : String(err)}`)
            }
          }
          text = replaceImageMarks(text, resolved)
        }
        const exec = executorPort(ports, config, session.executor)
        if (typeof exec.post !== 'function') {
          // 能力缺失就明说，不静默丢弃
          throw new Error(`${session.executor} 执行器不支持追加消息`)
        }
        await exec.post(
          { executor: session.executor, sessionId: session.sessionId, workspace: ws.root },
          // 固定信封：跨会话投递自带的那句英文声明说的是通道不是发送者，
          // 不套信封模型会把用户的话当成「另一个会话发来的」（参考项目同一处理）
          withEnvelope(text),
        )
        store.touchSession(session.id)
        log('info', `已投递到会话 ${session.id}（${session.executor}：${session.sessionId}）`)
        return
      }
      case 'card_send': {
        const ch = action.channel ? ports.channels.get(action.channel) : channelPort(ports, config)
        if (!ch) throw new Error(`频道插件未就绪：${action.channel}`)
        if (typeof ch.sendCard !== 'function') throw new Error('频道插件不支持发卡')
        const sent = await ch.sendCard(
          { chatId: action.chatId, replyTo: action.replyTo, card: action.card, pin: action.pin === true },
          key,
        )
        if (sent.messageId) store.mapMessage(sent.messageId, action.sessionId ?? '', action.chatId)
        // 频道会在发卡时顺手置顶（channels.*.pinCards），这里必须记账：
        // 不记的话置顶对账永远以为「没置过」，撤不掉，群里的置顶只会越攒越多。
        if (sent.messageId && action.sessionId && action.pin === true) {
          store.markPinned(action.sessionId, action.chatId, sent.messageId)
        }
        // 题卡/权限卡记住自己的 messageId：答完之后要原地刷成「已送出」回执
        const cardId = (action.card as { id?: string; kind?: string }).id
        if (sent.messageId && cardId) {
          const kind = (action.card as { kind?: string }).kind
          if (kind === 'question' || kind === 'permission') store.setQuestionCard(cardId, sent.messageId)
        }
        if (sent.status === 'gone') throw new Error('卡片发送失败（频道返回 gone）')
        return { externalId: sent.messageId }
      }
      case 'card_patch': {
        const ch = channelPort(ports, config)
        if (typeof ch.patchCard !== 'function') throw new Error('频道插件不支持改卡')
        try {
          await ch.patchCard(action.messageId, action.card)
        } catch (e) {
          // 旧卡可能已超 14 天或被撤回：改不动就算了，不重试也不影响新卡
          log('warn', `旧卡改灰失败（不影响新卡）：${e instanceof Error ? e.message : String(e)}`)
        }
        return
      }
      case 'card_upsert': {
        const session = store.getSession(action.sessionId)
        if (!session) throw new Error(`会话 ${action.sessionId} 不存在`)
        const ch = channelPort(ports, config)
        if (!ch.sendCard || !ch.patchCard) throw new Error('频道插件不支持卡片（缺 sendCard/patchCard）')

        // '__pin_only__' 是「置顶记账」占位，不是真状态卡：当成还没有卡，直接发新的
        const raw = store.getCard(session.id)
        const prev = raw && raw.signature !== '__pin_only__' ? raw : undefined
        // 状态卡永远挂在**话题根消息**上：只有根消息在群主消息流的「Pin 消息」面板里可见。
        // 历史上曾把卡换成话题内第 N 条消息（一轮一张），那些消息 pin 了也不出现在面板里。
        const rootId = session.rootMessageId
        // 优先用已经建好的那张卡：它通常就是话题根；也可能是「老 schema 卡不可改」时换出来的新卡
        // ——再回头去 patch 根只会每次都失败，然后每次都换一张新卡（死循环）。
        const target = prev?.messageId ?? rootId
        if (prev && prev.signature === action.signature && target === prev.messageId) {
          log('debug', `状态卡没变，跳过 ${session.id}`)
          return
        }
        if (target) {
          try {
            await ch.patchCard(target, action.card)
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            if (isTransientCardError(msg)) {
              // 临时失败（网络/超时/限流）：这张卡还会被重试，别换卡——换卡会连带把它的置顶弄丢
              throw new Error(`改卡临时失败（下一轮重试，保留原卡）：${msg}`)
            }
            if (isLegacyCardError(msg)) {
              // 老 schema 的卡改不动，重试多久都没用：在同一话题里发一张新的，之后改新的那张。
              // 代价是它不在主消息流，「Pin 消息」面板里看不到——但「内容能更新」比「面板里有一行」重要。
              const fresh = await ch.sendCard(
                {
                  chatId: session.chatId,
                  replyTo: session.rootMessageId ?? session.threadId,
                  card: action.card,
                  pin: false,
                },
                `${key}:card-legacy`,
              )
              if (!fresh.messageId) throw new Error('老 schema 换新卡失败：发卡没拿到消息 id')
              store.upsertCard(session.id, session.chatId, fresh.messageId, action.signature, true)
              await ensureCardPinned(ch, session.id, fresh.messageId)
              log('warn', `状态卡是老 schema（改不动），已换新卡：${session.id} → ${fresh.messageId}`)
              return
            }
            // 根消息改不动（超 14 天、被撤回）：**不能换**——话题根换了，话题就断了。
            // 记一条警告，等人工处理；继续用这张卡显示旧内容，总比整个窗口失联好。
            log('warn', `状态卡改不动（话题根，不换卡）：${session.id} — ${msg}`)
            throw new Error(`改卡失败（话题根不可替换）：${msg}`)
          }
          // 保住 `detached`：它记的是「这张卡不在话题根」这个事实，
          // 改一次内容就被重置成 false 的话，下一拍对账又会把卡迁回那个改不动的根。
          store.upsertCard(
            session.id,
            prev?.chatId ?? session.chatId,
            target,
            action.signature,
            prev?.detached ?? false,
          )
          // 改卡成功 ≠ 还钉着：平台侧撤过、历史上没钉上的卡，都在这里补回来
          await ensureCardPinned(ch, session.id, target)
          log('info', `状态卡已更新：${session.id}`)
          return
        }
        const sentCard = await ch.sendCard(
          // pin 交给 ensureCardPinned：频道内部 pin 失败只 warn，内核却已经记账成「已置顶」，
          // 两边对不上，撤的时候就会漏（2026-11-09 置顶越来越少就是这么来的）。
          {
            chatId: session.chatId,
            replyTo: session.rootMessageId ?? session.threadId,
            card: action.card,
            pin: false,
          },
          `${key}:card`,
        )
        if (!sentCard.messageId) throw new Error('发卡没拿到消息 id，之后没法原地更新（检查 messageIdPath）')
        store.upsertCard(session.id, session.chatId, sentCard.messageId, action.signature)
        await ensureCardPinned(ch, session.id, sentCard.messageId)
        // 这条卡就是话题的根：把 thread/root 补绑上，之后话题里的消息才能路由回这个会话
        // （电脑上自己开的窗口靠这一句才「能对话」，否则消息只会被当成开窗向导）
        // 飞书的根消息 id（om_…）≠ 话题 id（omt_…）：话题 id 得回头问一次，
        // 拿到才能让话题里发的消息路由回这个会话（本地窗口「能对话」全靠它）。
        // 老会话曾经错绑成根消息 id 的，这里也顺手改过来。
        const threadId = ch.threadIdOf ? await ch.threadIdOf(sentCard.messageId).catch(() => undefined) : undefined
        if (!session.rootMessageId) store.setSessionRoot(session.id, sentCard.messageId)
        if (!session.threadId?.startsWith('omt_')) store.setSessionThread(session.id, threadId ?? sentCard.messageId)
        log('info', `状态卡已创建：${session.id} → ${sentCard.messageId}`)
        return
      }
      case 'answer_question': {
        const q = store.getQuestion(action.questionId)
        if (!q) throw new Error(`题目 ${action.questionId} 不存在`)
        store.answerQuestion(action.questionId, { ...q.answers, ...action.answers })
        const session = store.getSession(action.sessionId)
        if (session?.sessionId) {
          const ws = projects.workspaces.find((w) => w.id === session.workspace)
          const port = executorPort(ports, config, session.executor)
          if (ws && port.post) {
            const text = Object.entries(action.answers)
              .map(([k, v]) => `${k}：${v}`)
              .join('\n')
            await port.post(
              { executor: session.executor, sessionId: session.sessionId, workspace: ws.root },
              text,
            )
          }
        }
        break
      }
      case 'attach_session': {
        const now = new Date().toISOString()
        const existing = action.threadId ? store.findSessionByThread(action.chatId, action.threadId) : null
        if (existing) {
          store.rebindSession(existing.id, action.executorSessionId, action.workspace)
          log('info', `话题接入：${existing.id} → ${action.executorSessionId}`)
          return
        }
        const id = `s-attach-${action.executorSessionId.slice(0, 12)}`
        if (!store.getSession(id)) {
          store.insertSession({
            id,
            chatId: action.chatId,
            threadId: action.threadId,
            rootMessageId: action.rootMessageId,
            title: '接入的窗口',
            executor: action.executor,
            workspace: action.workspace,
            sessionId: action.executorSessionId,
            status: 'active',
            createdAt: now,
            lastActiveAt: now,
          })
        }
        log('info', `新话题接入：${id}（${action.executorSessionId}）`)
        return
      }
      case 'rebind_session': {
        const session = store.getSession(action.sessionId)
        if (!session) throw new Error(`会话 ${action.sessionId} 不存在`)
        store.rebindSession(action.sessionId, action.executorSessionId, action.workspace)
        log('info', `会话改绑：${action.sessionId} → ${action.executorSessionId} @ ${action.workspace}`)
        return
      }
      case 'stop_session': {
        const session = store.getSession(action.sessionId)
        if (!session) throw new Error(`会话 ${action.sessionId} 不存在`)
        if (session.sessionId && !action.keepExecutor) {
          const ws = projects.workspaces.find((w) => w.id === session.workspace)
          if (ws) {
            await executorPort(ports, config, session.executor).stop({
              executor: session.executor,
              sessionId: session.sessionId,
              workspace: ws.root,
            })
          }
        }
        // 停掉的窗口不该继续留在置顶位
        if (store.isCardPinned(session.id)) {
          const card = store.getCard(session.id)
          const ch = channelPort(ports, config)
          if (card && typeof ch.pinMessage === 'function') {
            await ch.pinMessage(card.messageId, false)
            store.setCardPinned(session.id, false)
          }
        }
        store.setSessionStatus(session.id, 'stopped')
        log('info', `会话已停止：${session.id}`)
        return
      }
      case 'pin_card': {
        const session = store.getSession(action.sessionId)
        if (!session) throw new Error(`会话 ${action.sessionId} 不存在`)
        const card = store.getCard(session.id)
        if (!card) throw new Error(`会话 ${session.id} 还没有状态卡，无从置顶`)
        if (!action.pin && !store.isCardPinned(session.id)) {
          // 不是自己置的就不动：别人的置顶不该被我们撤掉
          log('warn', `会话 ${session.id} 的卡不是我们置的，跳过取消置顶`)
          return
        }
        const ch = channelPort(ports, config)
        if (typeof ch.pinMessage !== 'function') throw new Error('频道插件不支持置顶')
        await ch.pinMessage(card.messageId, action.pin)
        store.setCardPinned(session.id, action.pin)
        log('info', `${action.pin ? '已置顶' : '已取消置顶'}：${session.id}`)
        return
      }
      case 'update_doc': {
        const pluginId = config.docs?.['feishu']?.plugin ?? [...(ports.docs?.keys() ?? [])][0]
        const doc = pluginId ? ports.docs?.get(pluginId) : undefined
        if (!doc) throw new Error('没有文档执行端口（config.docs / DocPort）')
        // docx 只能块级替换：端口提供 writeSection 时，冲突检测交给平台 revision。
        if (doc.writeSection) {
          const out = await doc.writeSection(action.doc, action.heading, action.body, {
            revision: action.expect.revision,
          })
          return { externalId: out.revision }
        }
        const cur = await doc.read(action.doc)
        const plan = planSectionWrite(cur, action.heading, action.body, action.expect)
        if (!plan.ok) throw new Error(`文档写回冲突（${plan.reason}）：${action.doc}`)
        const out = await doc.write(action.doc, plan.markdown, { revision: cur.revision })
        return { externalId: out.revision }
      }
      case 'create_todo':
        // 还没有对应插件：落死信并告警，好过静默丢弃。
        throw new Error(`动作 ${action.kind} 尚无实现插件`)
    }
  }
}

export interface PipelineDeps {
  store: Store
  outbox: Outbox
  /** 可选：把执行器观测到的进度发到事件总线，供场景/控制台订阅 */
  eventLog?: import('./event-log.ts').EventLog
  config: Config
  projects: Projects
  rules: Ruleset
  ports: Ports
  /** 会话查表；不给就表示还没启用会话层 */
  sessions?: SessionLookup
  classifier?: { impl: Classifier; minConfidence: number }
  /** 会话 id → 转录文件；默认按 claude 的目录约定去找，测试里可注入 */
  transcripts?: (sessionId?: string) => string | undefined
  log: Log
}

/** 选择卡上的一个候选项：key 决定点下去怎么开窗（预设项目 / 扫描出来的目录） */
export interface WorkspaceOption {
  key: string
  label: string
  root: string
  executor?: string
}

/** 扫描出来的目录不在 projects.yaml 里，没有项目说明可拼，用最简模板。 */
function buildOpenPrompt(title: string, e: Event, root: string): string {
  return [
    `# 任务：${title}`,
    '',
    `来源：${e.source} / ${e.channel.name ?? e.channel.id}`,
    `发起人：${e.actor.name ?? e.actor.id}`,
    `发生时间：${e.occurredAt}`,
    '',
    '## 原文',
    '',
    e.text,
    '',
    '## 工作区',
    '',
    `- 目录：${root}`,
  ].join('\n')
}

const rootMessageIdOf = (e: Event): string => e.rootId || e.externalId

/** 两个目录是不是同一个工作区（相等，或互为上下级）。 */
function sameWorkspace(a: string, b: string): boolean {
  const norm = (p: string): string => resolve(p).replace(/[\\/]+$/, '').toLowerCase()
  const x = norm(a)
  const y = norm(b)
  return x === y || y.startsWith(`${x}${sep}`) || x.startsWith(`${y}${sep}`)
}

/** 会话卡上那行字：标题 · 目录 · 轮数 · 时间 */
function resumeLabel(s: { title: string; cwd: string; userTurns: number; lastActive: number }): string {
  const title = (s.title || '无标题').slice(0, 18)
  const when = new Date(s.lastActive).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  const dir = s.cwd.split(/[\\/]/).filter(Boolean).pop() ?? s.cwd
  return `${title} ｜ ${dir} · ${when} · ${s.userTurns}轮`
}

const P2P_RECENT_MS = 5 * 60_000

/** 事件里带的图（多图优先；老的单图字段也兼容）。 */
function imageRefsOf(e: Event): { messageId: string; fileKey: string }[] | undefined {
  const keys = e.imageKeys?.length ? e.imageKeys : e.imageKey ? [e.imageKey] : []
  return keys.length ? keys.map((k) => ({ messageId: e.externalId, fileKey: k })) : undefined
}

export class Pipeline {
  readonly #d: PipelineDeps
  /** 话题是不是我们开的：同一话题 10 分钟内只查一次，别每条消息都打一次接口 */
  readonly #ownTopicCache = new Map<string, { own: boolean; at: number }>()
  /** 卡片进度刷新的节流表（只影响观感，不必落库） */
  readonly #cardRefreshedAt = new Map<string, number>()
  /**
   * 上次**真正画完**一张卡的时间。
   *
   * 和 `#cardRefreshedAt`（节流用，进函数就写）不是一回事：这个只在 enqueue 之后写。
   * 卡上有相对时间（`本轮结束 · 刚刚`、`已 3 分`），同一轮里一直跳过重画，它就会
   * 永远停在那一刻——2026-11-11 实测有个窗口的卡写着「刚刚」，实际是 20 小时前画的。
   */
  readonly #cardDrawnAt = new Map<string, number>()
  /** 自动回复巡检的节流时间戳 */
  #lastAutoReplyPoll = 0
  /** 置顶列表对账的节流时间戳（listPins 是一次真接口调用，别跟着每轮 tick 打） */
  #lastPinSyncAt = 0

  constructor(deps: PipelineDeps) {
    this.#d = deps
  }

  /** 一条消息进来：落库 → 规则 → 模型兜底 → 查表分派 → 入发件箱。 */
  async ingest(e: Event): Promise<IngestOutcome> {
    const { store, outbox, config, projects, rules, log } = this.#d

    if (!store.insertEvent(e)) {
      log('debug', `重复投递，跳过：${e.source}/${e.externalId}`)
      return 'duplicate'
    }

    // 总开关：消息交给总线（v2 场景）时，旧 Pipeline 只负责落库，不再路由。
    if (config.control?.messages === 'bus') return 'ignored'

    // 卡片按钮回调：单独一条路径，值里自带「哪个工作区/哪个话题/回到哪条消息」
    const cardResume = this.#cardAction(e, 'resume')
    if (cardResume) {
      return this.#dispatchResume(
        e,
        String(cardResume['sid'] ?? ''),
        String(cardResume['cwd'] ?? ''),
        String(cardResume['root'] ?? ''),
        String(cardResume['thread'] ?? '') || undefined,
        typeof cardResume['rebind'] === 'string' ? cardResume['rebind'] : undefined,
      )
    }

    // 选择题卡片：点选项作答，或点「我在电脑前」把题目交还终端
    const cardAns = this.#cardAction(e, 'ans')
    if (cardAns) return this.#answerByCard(e, cardAns)
    // 就绪卡上的两个按钮：等价于在这个话题里发一次 #resume / #新窗
    const readyResume = this.#cardAction(e, 'readyresume')
    if (readyResume) {
      const thread = String(readyResume['thread'] ?? '') || undefined
      return await this.#startResumeFlow({ ...e, threadId: thread ?? e.threadId })
    }
    const readyNewwin = this.#cardAction(e, 'readynewwin')
    if (readyNewwin) {
      // 从就绪卡点「再开一个」：本话题不动，另起一棵
      return await this.#startNewWindowFlow({ ...e, threadId: String(readyNewwin['thread'] ?? '') || e.threadId })
    }

    const cardPerm = this.#cardAction(e, 'perm')
    if (cardPerm) return this.#answerPermissionByCard(e, cardPerm)
    const cardAttach = this.#cardAction(e, 'attach')
    if (cardAttach) return this.#attachByCard(e, cardAttach)
    const cardOk = this.#cardAction(e, 'ansok')
    if (cardOk) return this.#commitDraft(e, cardOk)
    const cardHands = this.#cardAction(e, 'hands')
    if (cardHands) return this.#handBackByCard(e, cardHands)

    const cardPick = this.#cardPick(e)
    if (cardPick) {
      if (cardPick.fresh) {
        return this.#dispatchOpen(e, cardPick.workspaceId, cardPick.title ?? '新窗口', '', undefined)
      }
      return await this.#dispatchOpen(
        e,
        cardPick.workspaceId,
        cardPick.title ?? '新窗口',
        cardPick.rootMessageId,
        cardPick.threadId,
      )
    }

    // 待选工作区优先：话题里回「1」是选工作区，不是要说给窗口听的话
    const answered = await this.#answerPendingWorkspace(e)
    if (answered) return answered

    // 第 0 层：落在已绑定会话的话题里 → 直投，不再判断。
    // 三级回退（参考项目 route.js）：引用消息 id → 话题 thread → 单聊最近窗口。
    const session =
      (e.replyTo ? store.sessionByMessage(e.replyTo) : null) ??
      routeToSession(this.#d.sessions ?? NO_SESSIONS, e.channel.id, e.threadId) ??
      routeToSession(this.#d.sessions ?? NO_SESSIONS, e.channel.id, e.rootId) ??
      (e.channel.kind === 'dm' ? store.recentSession(e.channel.id, P2P_RECENT_MS) : null)
    if (session) {
      // 命令优先：`#stop` 这类是第一行命令，不是要说给窗口听的话
      const cmd = parseCommand(e.text)
      if (cmd) {
        store.setEventSession(e.id, session.id)
        const cooldown = config.sessions?.replyCooldownMs ?? 10_000
        const reply = (text: string, suffix: string): void => {
          // 冷却内不重复回（连点两下不该回两遍），落库所以重启也不丢
          if (!store.allowReply(session.id, suffix, cooldown)) {
            log('debug', `回执冷却中，跳过 ${suffix}`)
            return
          }
          outbox.enqueue(
            {
              kind: 'reply_only',
              sessionId: session.id,
              chatId: session.chatId,
              replyTo: session.rootMessageId ?? session.threadId,
              text,
            },
            dedupeKey(e.id, suffix),
          )
        }
        if (cmd.kind === 'stop' && config.control?.stop === 'scenario') return 'ignored'
        if (cmd.kind === 'resume' && config.control?.status === 'scenario') return 'ignored'
        if (cmd.kind === 'newwin' && config.control?.new === 'scenario') return 'ignored'
        if (cmd.kind === 'attach' && config.control?.status === 'scenario') return 'ignored'
        if (cmd.kind === 'stop') {
          outbox.enqueue({ kind: 'stop_session', sessionId: session.id }, dedupeKey(e.id, 'stop'))
          reply(`已停止：${session.title ?? session.id}`, 'stop-reply')
          return 'queued'
        }
        if (cmd.kind === 'pin' || cmd.kind === 'unpin') {
          if (config.control?.status === 'scenario') return 'ignored'
          outbox.enqueue(
            { kind: 'pin_card', sessionId: session.id, pin: cmd.kind === 'pin' },
            dedupeKey(e.id, cmd.kind),
          )
          return 'queued'
        }
        if (cmd.kind === 'newwin') {
          return await this.#startNewWindowFlow(e, session)
        }
        if (cmd.kind === 'resume') {
          // 换会话：列同工作区的历史会话，选一个把本话题改绑过去
          return await this.#startResumeFlow(e, session)
        }
        if (cmd.kind === 'new' && config.control?.new === 'scenario') return 'ignored'
        if (cmd.kind === 'new') {
          store.setSessionStatus(session.id, 'stopped')
          reply('这个窗口已关闭。直接发一条新任务，就会开一个新窗口。', 'new-reply')
          return 'queued'
        }
        if (cmd.kind === 'status' && config.control?.status === 'scenario') {
          // 同一来源一个处理器：事件已落 event_log，交给 scenario-console 回。
          return 'ignored'
        }
        if (cmd.kind === 'status') {
          reply(
            `窗口：${session.title ?? session.id}\n状态：${session.status}\n工作区：${session.workspace}\n执行器：${session.executor}`,
            'status-reply',
          )
          return 'queued'
        }
        if (cmd.kind === 'help' && config.control?.status === 'scenario') {
          // 同一来源一个处理器：#help 也归 scenario-console。
          return 'ignored'
        }
        reply(HELP_TEXT, 'help-reply')
        return 'queued'
      }
      // 有题在等答案：这句话就是答案，别再投给窗口
      if (session.status === 'stopped') {
        const cooldown = config.sessions?.replyCooldownMs ?? 10_000
        store.setEventSession(e.id, session.id)
        if (store.allowReply(session.id, 'stopped-reply', cooldown)) {
          outbox.enqueue(
            {
              kind: 'reply_only',
              chatId: session.chatId,
              replyTo: session.rootMessageId ?? session.threadId,
              text: '这个窗口已经停了：回 #resume 接着用旧的，或回 #new 关掉它再开一个。',
            },
            dedupeKey(e.id, 'stopped-reply'),
          )
        }
        return 'queued'
      }
      const pending = store.getPendingQuestion(session.id)
      if (pending?.kind === 'permission') {
        const decided = pickPermissionAnswer(e.text)
        if (decided) {
          store.answerQuestion(pending.id, {
            decision: decided.behavior,
            ...(decided.always ? { always: '1' } : {}),
          })
          store.setEventSession(e.id, session.id)
          outbox.enqueue(
            {
              kind: 'reply_only',
              chatId: session.chatId,
              replyTo: session.rootMessageId ?? session.threadId,
              text: decided.behavior === 'allow' ? '已允许这次操作' : '已拒绝这次操作',
            },
            dedupeKey(e.id, 'permission-answer'),
          )
          log('info', `工具授权已作答：${session.id} ${decided.behavior}`)
          return 'queued'
        }
      }
      if (pending && pending.kind !== 'permission') {
        const picked = pickAnswer(pending, e.text)
        if (picked) {
          store.answerQuestion(pending.id, { ...pending.answers, [picked.question]: picked.answer })
          store.setEventSession(e.id, session.id)
          outbox.enqueue(
            {
              kind: 'reply_only',
              chatId: session.chatId,
              replyTo: session.rootMessageId ?? session.threadId,
              text: `已记录：${picked.answer}`,
            },
            dedupeKey(e.id, 'answer'),
          )
          log('info', `选择题已作答：${session.id}`)
          return 'queued'
        }
      }
      store.setEventSession(e.id, session.id)
      outbox.enqueue(
        {
          kind: 'post_message',
          sessionId: session.id,
          text: textOf(e),
          images: imageRefsOf(e),
        },
        dedupeKey(e.id, 'post'),
      )
      log('debug', `话题内消息直投会话 ${session.id}`)
      return 'posted'
    }

    // 第 0.5 层：开窗档（群里发新消息 = 我要开一个窗口）
    // 没绑定话题时，#resume 是「把这个话题接到历史会话上」，不是开新窗
    const bareCmd = parseCommand(e.text)
    if (bareCmd?.kind === 'resume') {
      if (config.control?.status === 'scenario') return 'ignored'
      return await this.#startResumeFlow(e)
    }
    if (bareCmd?.kind === 'attach') {
      if (config.control?.status === 'scenario') return 'ignored'
      return await this.#startAttachFlow(e)
    }
    if (bareCmd?.kind === 'new' || bareCmd?.kind === 'stop') {
      outbox.enqueue(
        {
          kind: 'reply_only',
          chatId: e.channel.id,
          replyTo: e.rootId || e.externalId,
          text: `这个话题还没绑定窗口，${e.text.trim()} 暂时没作用。直接发任务名就会开一个新窗口。`,
        },
        dedupeKey(e.id, 'no-session-cmd'),
      )
      return 'queued'
    }

    const opened = await this.#openFlow(e)
    if (opened) return opened

    let intent = evaluate(rules, e)
    if (!intent) {
      intent = await this.#classify(e)
      if (!intent) {
        log('info', `判不了，只记录：${e.source}/${e.externalId}`)
        return 'ignored'
      }
    }
    // 判断结果一律落库：回放要能看见「当时判了什么」，包括低置信度的那部分。
    store.insertIntent(intent)

    const minConfidence = this.#d.classifier?.minConfidence
    if (minConfidence !== undefined && intent.confidence < minConfidence) {
      log('info', `置信度 ${intent.confidence} < ${minConfidence}，只记录不派工`)
      return 'ignored'
    }

    const resolved = resolveWork(intent, e, { config, projects })
    if (resolved.kind === 'observe') return 'observed'
    if (resolved.kind === 'skip') {
      log('info', `不派工：${resolved.reason}`)
      return 'skipped'
    }

    const work = resolved.work
    store.insertWork(work)

    if (config.mode === 'suggest') {
      // 待确认档：只发一条建议，不发工；点「执行」的回路在后续批次做。
      outbox.enqueue(
        { kind: 'reply_only', text: suggestText(work) },
        dedupeKey(work.id, 'suggest'),
      )
      return 'queued'
    }
    outbox.enqueue({ kind: 'dispatch_session', work }, dedupeKey(work.id, 'start'))
    return 'queued'
  }

  /** 读执行中任务的进度；完成或失败则入队回执。返回收敛掉的任务数。 */
  async collect(): Promise<number> {
    const { store, outbox, config, ports, log } = this.#d
    let settled = 0
    for (const work of store.listWorksByStatus('running')) {
      // event 开窗由 v2 执行器/场景推进，Pipeline 不再用旧执行器轮询，避免把 running 打回 failed。
      if (work.via === 'event') continue
      if (!work.sessionId) continue
      const progresses = await executorPort(ports, config, work.executor).read({
        executor: work.executor,
        sessionId: work.sessionId,
        workspace: work.workspace,
      })
      const last = progresses.at(-1)
      if (!last) continue
      this.#d.eventLog?.append({
        id: `session-progress:${work.id}:${last.at}:${last.kind}:${(last.text ?? '').slice(0, 120)}`,
        kind: 'session.progress',
        source: 'kernel',
        subject: work.sessionId,
        payload: {
          requestId: work.id,
          sessionId: work.sessionId,
          executor: work.executor,
          progress: last,
        },
      })
      if (last.kind === 'finished') {
        store.setWorkStatus(work.id, 'succeeded')
        outbox.enqueue(
          { kind: 'reply_only', text: last.text ?? `任务完成：${work.project}（${work.id}）` },
          dedupeKey(work.id, 'done'),
        )
        settled++
      } else if (last.kind === 'error') {
        store.setWorkStatus(work.id, 'failed')
        outbox.enqueue(
          {
            kind: 'reply_only',
            text: `任务失败：${work.project}（${work.id}）— ${last.text ?? '无详情'}`,
          },
          dedupeKey(work.id, 'done'),
        )
        settled++
      } else {
        log('debug', `任务 ${work.id} 进行中`)
      }
    }
    return settled
  }

  /**
   * `#接入`：把当前话题接到一个**正在跑**的窗口上。
   * 和 `#resume` 的区别：resume 是「另起一个进程接着旧记录」，attach 是「直接对这个活着的进程说话」。
   */
  async #startAttachFlow(e: Event): Promise<IngestOutcome> {
    const { outbox, ports, config, log } = this.#d
    const replyTo = rootMessageIdOf(e)
    const say = (text: string, kind: string): IngestOutcome => {
      outbox.enqueue({ kind: 'reply_only', chatId: e.channel.id, replyTo, text }, dedupeKey(e.id, kind))
      return 'queued'
    }
    const anyKind = Object.keys(config.executor_policies)[0] as Work['executor'] | undefined
    if (!anyKind) return say('没有配置执行器，接不上正在跑的窗口。', 'attach-noexec')
    const exec = executorPort(ports, config, anyKind)
    if (typeof exec.listLiveSessions !== 'function') {
      return say('这个执行器看不到正在跑的会话，没法接入。', 'attach-unsupported')
    }
    const live = (await exec.listLiveSessions().catch((err: unknown) => {
      log('warn', `列在跑的会话失败：${err instanceof Error ? err.message : String(err)}`)
      return []
    })) as { sessionId: string; cwd: string; title?: string; lastActive: number }[]
    if (!live.length) return say('现在没有正在跑的窗口可以接入。', 'attach-empty')

    const items = live.slice(0, config.sessions?.resumeMax ?? 8).map((x) => ({
      label: `${(x.title || '（无标题）').slice(0, 24)} · ${x.lastActive ? formatElapsed(Date.now() - x.lastActive) + '前' : '刚活动'}`,
      sessionId: x.sessionId,
      cwd: x.cwd,
    }))
    outbox.enqueue(
      {
        kind: 'card_send',
        chatId: e.channel.id,
        replyTo,
        card: {
          kind: 'resume',
          chatId: e.channel.id,
          title: '接入正在跑的窗口',
          items,
          attach: true,
          threadId: e.threadId,
          rootMessageId: replyTo,
          note: '下面是正在跑的窗口（按最近活动排序）。选一个，这个话题就接到它身上——不新开、不恢复，直接对它说话。',
        },
      },
      dedupeKey(e.id, 'attach-pick'),
    )
    return 'queued'
  }

  /** 答完之后把题卡改成回执；还有没答的题就接着推下一张。 */
  #settleQuestionCard(qid: string, question: string, answer: string): void {
    const { store, outbox, log } = this.#d
    const messageId = store.questionCard(qid)
    const q = store.getQuestion(qid)
    if (!messageId || !q) return
    const session = store.getSession(q.sessionId)
    const chatId = session?.chatId ?? ''
    const replyTo = session?.rootMessageId ?? session?.threadId ?? ''
    outbox.enqueue(
      {
        kind: 'card_patch',
        chatId,
        messageId,
        card: { kind: 'settled', title: '已答', status: 'done', lines: [], question, answer },
      } as never,
      dedupeKey(qid, `card-settled-${question}`),
    )
    const next = q.questions.find((x) => q.answers[x.question] === undefined)
    if (next) {
      const idx = q.questions.indexOf(next) + 1
      outbox.enqueue(
        {
          kind: 'card_send',
          sessionId: q.sessionId,
          chatId,
          replyTo,
          card: {
            kind: 'question',
            id: qid,
            header: next.header,
            question: next.question,
            options: next.options ?? [],
            index: idx,
            total: q.questions.length,
            multiSelect: Boolean(next.multiSelect),
            chatId,
          },
        } as never,
        dedupeKey(qid, `card-next-${idx}`),
      )
      log('info', `还有下一题，已推第 ${idx}/${q.questions.length} 题：${qid}`)
    }
  }

  /** 点了权限卡的按钮：把决定写进待答记录，钩子那边会读到并回给 Claude。 */
  #answerPermissionByCard(e: Event, v: Record<string, unknown>): IngestOutcome {
    const { store, outbox, log } = this.#d
    const qid = String(v['qid'] ?? '')
    const decision = String(v['d'] ?? '')
    const always = v['always'] === true
    const replyTo = e.rootId || e.externalId
    const reply = (text: string, kind: string): IngestOutcome => {
      outbox.enqueue({ kind: 'reply_only', chatId: e.channel.id, replyTo, text }, dedupeKey(e.id, kind))
      return 'queued'
    }
    const status = store.questionStatus(qid)
    if (status !== 'pending') {
      return reply(
        status === 'timeout' ? '等太久了，这次授权已经交还终端。' : '这次授权已经处理过了。',
        'perm-gone',
      )
    }
    if (decision !== 'allow' && decision !== 'deny') return reply('这个按钮没带决定，忽略。', 'perm-bad')
    store.answerQuestion(qid, {
      decision,
      ...(always && decision === 'allow' ? { always: '1' } : {}),
    })
    log('info', `工具授权由卡片作答：${qid} → ${decision}${always ? '（本会话不再问）' : ''}`)
    return reply(
      decision === 'allow'
        ? always
          ? '已允许，本会话不再问这个工具。'
          : '已允许这一次。'
        : '已拒绝。',
      'perm-ok',
    )
  }

  /** 点了「接入」卡片里的某一项：把话题绑到这个活着的会话上，不启动任何东西。 */
  #attachByCard(e: Event, v: Record<string, unknown>): IngestOutcome {
    const { store, outbox, log, config } = this.#d
    if (config.control?.status === 'scenario') return 'ignored'
    const sid = String(v['sid'] ?? '')
    const cwd = String(v['cwd'] ?? '')
    const thread = String(v['thread'] ?? '') || e.threadId
    const root = String(v['root'] ?? '') || e.rootId
    const reply = (text: string, kind: string): IngestOutcome => {
      outbox.enqueue(
        { kind: 'reply_only', chatId: e.channel.id, replyTo: root ?? e.externalId, text },
        dedupeKey(e.id, kind),
      )
      return 'queued'
    }
    if (!sid) return reply('这个按钮没带会话 id，接不上。', 'attach-bad')
    if (!thread) return reply('这条消息没有话题信息，接不上（请在话题里发 `#接入`）。', 'attach-nothread')

    // 同一个话题只绑一个会话：已有的先停用
    const now = new Date().toISOString()
    const existing = routeToSession(store, e.channel.id, thread)
    const id = existing?.id ?? `s-attach-${sid.slice(0, 12)}`
    if (existing) {
      store.rebindSession(id, sid, cwd)
    } else if (!store.getSession(id)) {
      store.insertSession({
        id,
        chatId: e.channel.id,
        threadId: thread,
        rootMessageId: root ?? thread,
        title: '接入的窗口',
        executor: 'claude',
        workspace: cwd,
        sessionId: sid,
        status: 'active',
        createdAt: now,
        lastActiveAt: now,
      })
    }
    log('info', `话题 ${thread} 已接入在跑的会话 ${sid}（${cwd}）`)
    return reply(`已接上正在跑的窗口（${sid.slice(0, 8)}）。在这里说话就会直接投进去。`, 'attach-ok')
  }

  /**
   * 这个话题是不是我们开的窗口（根消息是机器人发的卡）。
   * 频道支持查询才问；不支持就当「不知道」，保持原来的静默行为。
   */
  async #isOwnTopic(e: Event): Promise<boolean> {
    const { ports, config, log } = this.#d
    const key = e.threadId ?? e.rootId ?? ''
    const hit = this.#ownTopicCache.get(key)
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.own
    let own = false
    try {
      const ch = channelPort(ports, config)
      if (typeof ch.isOwnMessage === 'function' && e.rootId) {
        own = (await ch.isOwnMessage(e.rootId)) === true
      }
    } catch (err) {
      log('debug', `查根消息失败（按别人的话题处理）：${err instanceof Error ? err.message : String(err)}`)
    }
    this.#ownTopicCache.set(key, { own, at: Date.now() })
    return own
  }

  /**
   * 开窗流程（`sessions.newTopicPolicy=open` 时生效）：
   * 群里发一条非话题消息 = 我要开一个窗口，正文就是话题名。
   * 先问选哪个工作区；只有一个工作区就不问。选中后派工，由投递环节发锚消息、把话题绑成会话。
   */
  async #openFlow(e: Event): Promise<IngestOutcome | null> {
    const { store, outbox, config, log } = this.#d
    if ((config.sessions?.newTopicPolicy ?? 'judge') !== 'open') return null
    if (e.channel.kind !== 'group') return null

    // 待选工作区按话题分开存：同一个群里同时开两个窗口时不能互相抢答
    const choiceKey = e.threadId || e.channel.id

    // `#新窗` / `#再开`：另起一棵新话题再开一个窗口，本话题保持不动
    if (parseCommand(e.text)?.kind === 'newwin') {
      const all = await this.#workspaceOptions()
      if (!all.length) {
        outbox.enqueue(
          { kind: 'reply_only', chatId: e.channel.id, replyTo: rootMessageIdOf(e), text: '没有可用工作区。' },
          dedupeKey(e.id, 'newwin-empty'),
        )
        return 'queued'
      }
      store.setChoice(
        choiceKey,
        'workspace',
        {
          title: '新窗口',
          options: all,
          rootMessageId: rootMessageIdOf(e),
          fresh: true,
        },
        config.sessions?.choiceTtlMs ?? 30 * 60_000,
      )
      outbox.enqueue(
        {
          kind: 'card_send',
          chatId: e.channel.id,
          replyTo: rootMessageIdOf(e),
          card: {
            kind: 'picker',
            chatId: e.channel.id,
            threadId: undefined,
            rootMessageId: rootMessageIdOf(e),
            title: '新窗口',
            options: all,
            note: '另起一棵新话题，本话题保持不动。选一个工作区，我在群里新开一条并把它绑到新窗口。',
          },
        },
        dedupeKey(e.id, 'newwin-pick'),
      )
      return 'queued'
    }

    // 话题内回复且没有绑定会话。
    // 话题群里每条消息都有 threadId；只有话题内回复才带 rootId。
    if (e.rootId) {
      // 如果这个话题是我们自己开的窗口（根消息是机器人发的卡），却查不到绑定 ——
      // 多半是数据丢了或换了数据库。静默吞掉最糟：人以为发出去了。
      if (await this.#isOwnTopic(e)) {
        outbox.enqueue(
          {
            kind: 'reply_only',
            chatId: e.channel.id,
            replyTo: rootMessageIdOf(e),
            text:
              '这个话题没绑上窗口（本机数据里查不到）。\n' +
              '· 回 `#resume` 选一个已有会话接上\n' +
              '· 或者回 `#新窗` 另开一个',
          },
          dedupeKey(e.id, 'unbound-topic'),
        )
        log('warn', `话题 ${e.threadId} 没有绑定会话，但根消息是我们发的卡：已回提示`)
        return 'queued'
      }
      // 别人的话题：不开新窗（交给后面的规则/模型）
      return null
    }

    // `#别名 任务名`：直接指定工作区，跳过选择卡（参考项目同样支持 #tt）
    // 匹配顺序：别名精确 → 项目 id → 目录名精确 → 目录名「包含」该串（取最近活跃的那个）
    // `#E:\path`、`#/abs/path` 这种单发整行：直接拿它当工作区开窗（参考项目同一分支）
    const absPath = parseAbsolutePathCommand(e.text)
    if (absPath) {
      const all = await this.#workspaceOptions()
      const norm = (p: string): string => resolve(p).replace(/[\\/]+$/, '').toLowerCase()
      const hit = all.find((o) => norm(o.root) === norm(absPath))
      if (hit) return this.#dispatchOpen(e, hit.key, e.text.trim().replace(/^#/, '').trim(), rootMessageIdOf(e), e.threadId)
      outbox.enqueue(
        {
          kind: 'reply_only',
          chatId: e.channel.id,
          replyTo: rootMessageIdOf(e),
          text: `未找到目录 ${absPath}（它不在允许的根下面，或者还没被扫描到）。`,
        },
        dedupeKey(e.id, 'abs-miss'),
      )
      return 'queued'
    }

    const aliasHit = /^#([^\s]+)\s+([\s\S]+)$/.exec(e.text.trim())
    if (aliasHit) {
      const [, alias, rest] = aliasHit
      const all = await this.#workspaceOptions()
      const needle = String(alias).toLowerCase()
      const hit =
        all.find((o) => o.label === alias) ??
        all.find((o) => o.key === `project:${alias}`) ??
        all.find((o) => basename(o.root).toLowerCase() === needle) ??
        // 多目录撞名时命中哪个不确定——按列表顺序（最近的在前）取第一个
        all.find((o) => basename(o.root).toLowerCase().includes(needle))
      if (hit) return this.#dispatchOpen(e, hit.key, rest!.trim(), rootMessageIdOf(e), e.threadId)
      // 写了 #xxx 却没匹配上：不静默用别处，仍然弹选择卡并说清楚
      outbox.enqueue(
        {
          kind: 'reply_only',
          chatId: e.channel.id,
          replyTo: rootMessageIdOf(e),
          text: `没找到目录「${alias}」。下面是现有工作区，回序号挑一个：\n${optionList(all)}`,
        },
        dedupeKey(e.id, 'alias-miss'),
      )
      return 'queued'
    }

    const options = await this.#workspaceOptions()
    if (!options.length) {
      log('warn', '没有工作区可开窗')
      return 'skipped'
    }
    const rootMessageId = e.rootId || e.externalId
    if (options.length === 1) return this.#dispatchOpen(e, options[0]!.key, e.text, rootMessageId, e.threadId)

    store.setChoice(
      choiceKey,
      'workspace',
      { title: e.text, options, rootMessageId },
      config.sessions?.choiceTtlMs ?? 30 * 60_000,
    )
    outbox.enqueue(
      {
        kind: 'card_send',
        chatId: e.channel.id,
        // 必须回到用户那条消息所在的话题里，否则飞书会另起一个话题
        replyTo: rootMessageId,
        // 卡片长什么样由频道插件决定（内核只给数据，守住「内核不 import 插件」）
        card: {
          kind: 'picker',
          title: e.text,
          options,
          threadId: e.threadId,
          rootMessageId,
          chatId: e.channel.id,
        },
      },
      dedupeKey(e.id, 'ask-workspace'),
    )
    return 'queued'
  }

  /**
   * 回答「选择工作区」的待选表。**要在会话直投之前**处理：
   * 已经绑了窗口的话题里回「1」，那是选工作区，不是要说给窗口听的话。
   */
  async #answerPendingWorkspace(e: Event): Promise<IngestOutcome | null> {
    const { store, outbox, log } = this.#d
    // 不看 newTopicPolicy：待选表存在就说明我们刚问过，回答它不需要额外许可
    const choiceKey = e.threadId || e.channel.id
    const pending = store.getChoice(choiceKey, 'workspace') as
      | { title: string; options: WorkspaceOption[]; rootMessageId: string; fresh?: boolean }
      | null
    if (!pending) return null

    const answer = e.text.trim().replace(/^#/, '')
    const idx = Number(answer)
    const byLabel = pending.options.find((o) => answer === o.label)
    const picked = byLabel ?? (Number.isInteger(idx) ? pending.options[idx - 1] : undefined)
    if (!picked) {
      // 话题已经绑了窗口：这句多半是要说给窗口听的话，别把选择卡顶掉。
      // 还没绑窗口（刚发起开窗）：认不出就重问一遍选项。
      const bound = routeToSession(this.#d.sessions ?? NO_SESSIONS, e.channel.id, e.threadId)
      if (bound && !/^#?\d{1,2}$/.test(answer)) return null
      outbox.enqueue(
        {
          kind: 'reply_only',
          chatId: e.channel.id,
          replyTo: pending.rootMessageId,
          text: `序号超出范围了。回 1-${pending.options.length} 选工作区：\n${optionList(pending.options)}\n（当前话题名：${pending.title}）`,
        },
        dedupeKey(e.id, 'ask-workspace-again'),
      )
      return 'queued'
    }
    store.clearChoice(choiceKey, 'workspace')
    log('info', `已选工作区：${picked.label}（${pending.fresh ? '另起新话题' : '本话题'}）`)
    // fresh：另起一棵新话题，原话题保持不动（参考项目的「再开一个窗口」）
    if (pending.fresh) return this.#dispatchOpen(e, picked.key, pending.title, '', undefined)
    return this.#dispatchOpen(e, picked.key, pending.title, pending.rootMessageId, e.threadId ?? undefined)
  }

  /**
   * 再开一个窗口（参考项目 ready 卡上的「➕ 再开一个窗口」）：
   * 弹工作区选择，选中后**另起一棵新话题**，本话题的绑定不动。
   */
  async #startNewWindowFlow(e: Event, from?: Session): Promise<IngestOutcome> {
    const { store, outbox, config, log } = this.#d
    const options = await this.#workspaceOptions()
    if (!options.length) {
      outbox.enqueue(
        { kind: 'reply_only', chatId: e.channel.id, replyTo: rootMessageIdOf(e), text: '没有可用工作区。' },
        dedupeKey(e.id, 'newwin-empty'),
      )
      return 'queued'
    }
    const note = from
      ? `另起一棵新话题，本话题（${from.title ?? from.id}）保持不动。选一个工作区，我在群里新开一条并把它绑到新窗口。`
      : '另起一棵新话题，本话题保持不动。选一个工作区，我在群里新开一条并把它绑到新窗口。'
    store.setChoice(
      from?.threadId || e.threadId || e.channel.id,
      'workspace',
      { title: '新窗口', options, rootMessageId: rootMessageIdOf(e), fresh: true },
      config.sessions?.choiceTtlMs ?? 30 * 60_000,
    )
    outbox.enqueue(
      {
        kind: 'card_send',
        chatId: e.channel.id,
        replyTo: rootMessageIdOf(e),
        card: {
          kind: 'picker',
          fresh: true,
          chatId: e.channel.id,
          rootMessageId: rootMessageIdOf(e),
          title: '新窗口',
          options,
          note,
        },
      },
      dedupeKey(e.id, 'newwin-pick'),
    )
    log('info', `再开一个窗口：已弹工作区选择（${options.length} 个候选）`)
    return 'queued'
  }

  /** 点选项作答。点的是已经失效的卡就按原因说清楚，不误答。 */
  #answerByCard(e: Event, v: Record<string, unknown>): IngestOutcome {
    const { store, outbox, log } = this.#d
    const qid = String(v['qid'] ?? '')
    const status = store.questionStatus(qid)
    const reply = (text: string, kind: string): IngestOutcome => {
      outbox.enqueue(
        { kind: 'reply_only', chatId: e.channel.id, replyTo: e.rootId || e.externalId, text },
        dedupeKey(e.id, kind),
      )
      return 'queued'
    }
    if (status === 'answered') return reply('这道题已经答过了。', 'ans-done')
    if (status === 'timeout') return reply('等太久了，这道题已经交还终端；要答就在终端里选。', 'ans-timeout')
    if (status === 'hands') return reply('这道题你自己点了「我在电脑前」，终端会接着问你。', 'ans-hands')
    const q = status ? store.getQuestion(qid) : null
    if (!q) return reply('这道题已经不在了（窗口可能已经关了）。', 'ans-gone')

    const target = q.questions.find((x) => q.answers[x.question] === undefined)
    if (!target) return reply('这道题已经答过了。', 'ans-done')
    const label = String(v['label'] ?? '')

    // 多选题：先攒草稿，点「✅ 就这些」才提交（参考项目同样先勾选、后确认）
    if (target.multiSelect) {
      const draft = store.getDraft(qid)
      const cur = draft[target.question] ?? []
      const next = cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label]
      store.setDraft(qid, { ...draft, [target.question]: next })
      // 原地刷新那张卡：不刷新的话，人根本看不出自己勾上了没有
      const cardId = store.questionCard(qid)
      if (cardId) {
        outbox.enqueue(
          {
            kind: 'card_patch',
            chatId: e.channel.id,
            messageId: cardId,
            card: {
              kind: 'question',
              id: qid,
              header: target.header,
              question: target.question,
              options: target.options ?? [],
              index: q.questions.indexOf(target) + 1,
              total: q.questions.length,
              multiSelect: true,
              selected: next,
              chatId: e.channel.id,
            },
          } as never,
          dedupeKey(e.id, 'ans-toggle'),
        )
      }
      return 'queued'
    }

    const answers = { ...q.answers, [target.question]: label }
    store.answerQuestion(qid, answers)
    log('info', `选择题由卡片作答：${target.question} → ${label}`)
    // 卡片要落地：改成「已把答案送回窗口」，否则人点完不知道生效没有
    this.#settleQuestionCard(qid, target.question, label)
    return 'queued'
  }

  /** 点「✅ 就这些」：把草稿提交成答案。 */
  #commitDraft(e: Event, v: Record<string, unknown>): IngestOutcome {
    const { store, outbox, log } = this.#d
    const qid = String(v['qid'] ?? '')
    const status = store.questionStatus(qid)
    const reply = (text: string, kind: string): IngestOutcome => {
      outbox.enqueue(
        { kind: 'reply_only', chatId: e.channel.id, replyTo: e.rootId || e.externalId, text },
        dedupeKey(e.id, kind),
      )
      return 'queued'
    }
    if (status !== 'pending') return reply('这道题已经不在了（可能已经答过或交还终端）。', 'ansok-gone')
    const q = store.getQuestion(qid)
    if (!q) return reply('这道题已经不在了。', 'ansok-gone')
    const target = q.questions.find((x) => q.answers[x.question] === undefined)
    if (!target) return reply('这道题已经答过了。', 'ansok-done')

    const picks = store.getDraft(qid)[target.question] ?? []
    if (!picks.length) return reply('还没选任何一项；点选项按钮先选，再点「就这些」。', 'ansok-empty')
    store.answerQuestion(qid, { ...q.answers, [target.question]: picks.join(', ') })
    log('info', `选择题（多选）已提交：${target.question} → ${picks.join(', ')}`)
    return reply(`已提交：${picks.join(', ')}`, 'ansok-ok')
  }

  /** 点「我在电脑前，让终端问我」：取消这条待答记录，终端立刻接手。 */
  #handBackByCard(e: Event, v: Record<string, unknown>): IngestOutcome {
    const { store, outbox, log } = this.#d
    const qid = String(v['qid'] ?? '')
    const status = store.questionStatus(qid)
    const reply = (text: string, kind: string): IngestOutcome => {
      outbox.enqueue(
        { kind: 'reply_only', chatId: e.channel.id, replyTo: e.rootId || e.externalId, text },
        dedupeKey(e.id, kind),
      )
      return 'queued'
    }
    if (!status) return reply('这道题已经不在了（窗口可能已经关了）。', 'hands-gone')
    if (status === 'answered') return reply('这道题已经答过了。', 'hands-done')
    if (status === 'timeout') return reply('已经等太久自动交还终端了。', 'hands-timeout')
    if (status === 'hands') return reply('已经交还终端了。', 'hands-handed')
    store.handBackQuestion(qid)
    log('info', `选择题交还终端（人点了按钮）：${qid}`)
    return reply('好，已经在电脑前了——终端会接着问你。', 'hands-ok')
  }

  /** 卡片回调 → 取出按钮值；不是回调或 k 不匹配就返回 null。 */
  #cardAction(e: Event, kind: string): Record<string, unknown> | null {
    const raw = e.raw as { type?: string } | undefined
    if (raw?.type !== 'card.action.trigger') return null
    try {
      const v = JSON.parse(e.text) as Record<string, unknown>
      return v['k'] === kind ? v : null
    } catch {
      return null
    }
  }

  /** 列历史会话并回一张卡；没有可恢复的就明说原因，不瞎开窗。 */
  async #startResumeFlow(e: Event, boundOverride?: Session): Promise<IngestOutcome> {
    const { store, outbox, config, ports, log } = this.#d
    const rootMessageId = e.rootId || e.externalId
    // 话题已经绑了窗口时，候选只留同一工作区（或互为上下级）——
    // 跨目录恢复会把对话带到一个本来不属于它的目录里。
    const bound = boundOverride ?? routeToSession(this.#d.sessions ?? NO_SESSIONS, e.channel.id, e.threadId)
    const exec = ports.executors.get(Object.values(config.executor_policies)[0]?.plugin ?? '')
    if (typeof exec?.listSessions !== 'function') {
      outbox.enqueue(
        {
          kind: 'reply_only',
          chatId: e.channel.id,
          replyTo: rootMessageId,
          text: '当前执行器不支持列历史会话。',
        },
        dedupeKey(e.id, 'resume-unsupported'),
      )
      return 'queued'
    }

    let all: Awaited<ReturnType<NonNullable<typeof exec.listSessions>>>
    try {
      all = await exec.listSessions()
    } catch (err) {
      log('warn', `列历史会话失败：${err instanceof Error ? err.message : String(err)}`)
      all = []
    }
    const scoped = bound?.workspace ? all.filter((x) => sameWorkspace(bound.workspace, x.cwd)) : all
    const usable = scoped.filter(
      (x) =>
        // 空会话恢复出来没有意义
        !(x.userTurns === 0 && !x.title) &&
        // cwd 已被删除或移走的也恢复不了：恢复出来会是一个不存在的目录
        existsSync(x.cwd),
    )
    const runningCount = usable.filter((x) => x.running).length
    const pickable = usable.filter((x) => !x.running).slice(0, config.sessions?.resumeMax ?? 8)
    if (!pickable.length) {
      const running = usable.filter((x) => x.running).length
      const scope = bound?.workspace ? `\`${bound.workspace}\` 下` : ''
      outbox.enqueue(
        {
          kind: 'reply_only',
          chatId: e.channel.id,
          replyTo: rootMessageId,
          text: running
            ? `${scope}近几天有 ${usable.length} 个会话，但全部正在运行；同一会话不能同时开两个窗口，先关掉原窗口再试。`
            : `${scope}近几天没有找到可恢复的会话。`,
        },
        dedupeKey(e.id, 'resume-empty'),
      )
      return 'queued'
    }

    const choiceKey = e.threadId || e.channel.id
    store.setChoice(
      choiceKey,
      'resume',
      {
        title: e.text,
        rootMessageId,
        items: pickable.map((x) => ({ sessionId: x.sessionId, cwd: x.cwd, label: resumeLabel(x) })),
      },
      this.#d.config.sessions?.choiceTtlMs ?? 30 * 60_000,
    )
    outbox.enqueue(
      {
        kind: 'card_send',
        chatId: e.channel.id,
        replyTo: rootMessageId,
        card: {
          kind: 'resume',
          items: pickable.map((x) => ({ label: resumeLabel(x), sessionId: x.sessionId, cwd: x.cwd })),
          // 正在跑的不列（同一会话不能开两个窗口），但要说清有几个人没上场
          note: runningCount
            ? `近 5 天、同工作区、且当前没在运行的会话。另有 ${runningCount} 个会话正在运行，未列出。选一个，我把这个话题接到它上面继续。`
            : undefined,
          rebindSessionId: bound?.id,
          threadId: e.threadId,
          rootMessageId,
          chatId: e.channel.id,
        },
      },
      dedupeKey(e.id, 'resume-card'),
    )
    return 'queued'
  }

  /** 起一个「接着历史会话」的窗口。 */
  #dispatchResume(
    e: Event,
    sessionId: string,
    cwd: string,
    rootMessageId: string,
    threadId?: string,
    rebindSessionId?: string,
  ): IngestOutcome {
    const { store, outbox, config, log } = this.#d
    if (config.control?.status === 'scenario') return 'ignored'
    if (!sessionId) {
      log('warn', '恢复回调缺 sessionId，跳过')
      return 'skipped'
    }
    const execKind = (Object.keys(config.executor_policies)[0] ?? 'claude') as Work['executor']
    const policy = config.executor_policies[execKind]
    const id = workId(e.id)
    // works.intent_id 是外键，必须先落一条判断记录
    store.insertIntent({
      eventId: e.id,
      kind: 'dev-request',
      topic: `恢复 ${basename(cwd || sessionId)}`,
      project: basename(cwd || '.'),
      suggestedAction: 'dispatch_session',
      rationale: '用户在话题里点选了一条历史会话（#resume）',
      confidence: 1,
    })
    const work: Work = {
      id,
      intentId: e.id,
      kind: 'session',
      project: basename(cwd || '.'),
      executor: execKind,
      workspace: cwd,
      prompt: '（已恢复历史会话，等你的下一条指令）',
      resumeSessionId: sessionId,
      budgetUsd: policy?.defaultBudgetUsd,
      status: 'queued',
    }
    store.insertWork(work)
    outbox.enqueue(
      {
        kind: 'dispatch_session',
        work: {
          ...work,
          ownerId: e.actor.id,
          origin: {
            chatId: e.channel.id,
            title: `恢复 ${basename(cwd || sessionId)}`,
            threadId,
            rootMessageId,
            rebindSessionId,
          },
        },
      },
      dedupeKey(id, 'resume-start'),
    )
    return 'queued'
  }

  /** 卡片回调（`card.action.trigger`）→ 解出按钮值；不是回调就返回 null。 */
  #cardPick(
    e: Event,
  ): { workspaceId: string; threadId?: string; rootMessageId: string; title?: string; fresh?: boolean } | null {
    const raw = e.raw as { type?: string } | undefined
    if (raw?.type !== 'card.action.trigger') return null
    let value: Record<string, unknown>
    try {
      value = JSON.parse(e.text) as Record<string, unknown>
    } catch {
      return null
    }
    if (value['k'] !== 'pick') return null
    const workspaceId = typeof value['workspaceId'] === 'string' ? value['workspaceId'] : ''
    const root = typeof value['root'] === 'string' ? value['root'] : ''
    const thread = typeof value['thread'] === 'string' ? value['thread'] : ''
    if (!workspaceId) return null
    // 话题名从待选表里取；取不到就用通用标题，不瞎编
    const pending = this.#d.store.getChoice(thread || e.channel.id, 'workspace') as
      | { title?: string; fresh?: boolean }
      | null
    return {
      workspaceId,
      threadId: thread || undefined,
      rootMessageId: root || e.externalId,
      title: pending?.title,
      // 按钮自己也带 fresh（待选表过期了也能生效）
      fresh: value['fresh'] === '1' || pending?.fresh === true,
    }
  }

  /** 候选工作区：配置里声明的在前，执行器扫出来的真实目录补在后面（去重、限量）。 */
  async #workspaceOptions(): Promise<WorkspaceOption[]> {
    const { projects, ports, config, log } = this.#d
    const max = config.sessions?.pickMax ?? 20
    const out: WorkspaceOption[] = projects.workspaces.map((w) => ({
      key: `project:${w.id}`,
      label: w.aliases[0] ?? w.id,
      root: w.root,
    }))
    const seen = new Set(out.map((o) => resolve(o.root).toLowerCase()))

    for (const [kind, policy] of Object.entries(config.executor_policies)) {
      const exec = ports.executors.get(policy.plugin)
      if (typeof exec?.listWorkspaces !== 'function') continue
      try {
        for (const d of await exec.listWorkspaces()) {
          const key = resolve(d.root).toLowerCase()
          if (seen.has(key)) continue
          seen.add(key)
          out.push({ key: `root:${d.root}`, label: d.label, root: d.root, executor: kind })
          // 上限按配置走（参考项目 pickMax=20）；硬编码 8 会让配置项失效
          if (out.length >= max) break
        }
      } catch (e) {
        log('warn', `扫工作区失败（不影响预设项）：${e instanceof Error ? e.message : String(e)}`)
      }
      if (out.length >= max) break
    }
    return out.slice(0, this.#d.config.sessions?.pickMax ?? 20)
  }

  #dispatchOpen(
    e: Event,
    workspaceId: string,
    title: string,
    rootMessageId: string,
    threadId?: string,
  ): IngestOutcome {
    const { store, outbox, config, projects, log } = this.#d
    const projectId = workspaceId.startsWith('project:') ? workspaceId.slice('project:'.length) : workspaceId
    const intent: Intent = {
      eventId: e.id,
      kind: 'dev-request',
      topic: title,
      project: projectId,
      suggestedAction: 'dispatch_session',
      rationale: '群内新消息按开窗处理（sessions.newTopicPolicy=open）',
      confidence: 1,
    }
    store.insertIntent(intent)

    // 扫描出来的目录：不在 projects.yaml 里，直接按 allowRoots 组一个 Work
    if (workspaceId.startsWith('root:')) {
      const root = workspaceId.slice('root:'.length)
      const execKind = (Object.keys(config.executor_policies)[0] ?? 'claude') as Work['executor']
      const policy = config.executor_policies[execKind]
      const work: Work = {
        id: workId(intent.eventId),
        intentId: intent.eventId,
        kind: 'session',
        project: basename(root),
        executor: execKind,
        workspace: root,
        prompt: buildOpenPrompt(title, e, root),
        budgetUsd: policy?.defaultBudgetUsd,
        status: 'queued',
      }
      store.insertWork(work)
      outbox.enqueue(
        {
          kind: 'dispatch_session',
          work: {
            ...work,
            ownerId: e.actor.id,
            origin: { chatId: e.channel.id, title, threadId, rootMessageId },
          },
        },
        dedupeKey(work.id, 'start'),
      )
      return 'queued'
    }

    const resolved = resolveWork(intent, e, { config, projects })
    if (resolved.kind !== 'work') {
      const why =
        resolved.kind === 'observe'
          ? '当前是只记录档（mode=observe），不会真的开会话；改档后再试'
          : resolved.reason
      outbox.enqueue(
        { kind: 'reply_only', chatId: e.channel.id, text: `开窗失败：${why}` },
        dedupeKey(e.id, 'open-refused'),
      )
      log('info', `开窗未派工：${why}`)
      return resolved.kind === 'observe' ? 'observed' : 'skipped'
    }

    const work = {
      ...resolved.work,
      ownerId: e.actor.id,
      origin: {
        chatId: e.channel.id,
        title,
        threadId,
        rootMessageId,
      },
    }
    store.insertWork(work)
    outbox.enqueue({ kind: 'dispatch_session', work }, dedupeKey(work.id, 'start'))
    return 'queued'
  }

  /**
   * 给还没有状态卡的活跃会话立一张卡（跑完由钩子改成「已完成」）。
   * 走发件箱、按 cards 表幂等，所以每拍跑一次不会重复发。
   */
  async refreshCards(): Promise<number> {
    const { store, outbox, ports, config, projects, log } = this.#d
    const ch = ports.channels.get(Object.values(config.channels)[0]?.plugin ?? '')
    if (!ch?.sendCard) return 0
    let queued = 0
    for (const s of store.listSessions('active')) {
      // 先试着用转录画完整的卡（顺带把会话真名换上）；
      // 画不出来（没转录、被节流）才退回「工作区 + 执行器」这张最简卡。
      const fromTranscript = await this.#refreshOneCard(s, config, projects, ports, store, outbox, log)
      if (fromTranscript > 0 || store.getCard(s.id)) {
        queued += fromTranscript
        continue
      }
      // 这一轮已经结束、那张卡也已经收掉 → 别再补一张最简卡（用户看到的就是「关了又冒出来」）
      const tr = s.sessionId ? (this.#d.transcripts ?? findTranscript)(s.sessionId) : undefined
      if (tr && !isTurnOpen(tr)) continue
      const card = {
        title: s.title ?? s.id,
        status: 'running' as const,
        lines: [`工作区：${s.workspace}`, `执行器：${s.executor}`],
      }
      outbox.enqueue(
        { kind: 'card_upsert', sessionId: s.id, card, signature: cardSignature(card) },
        dedupeKey(s.id, 'card-open'),
      )
      queued++
    }
    return queued
  }

  /**
   * 自动回复巡检（参考项目 auto-reply）：每 pollSeconds 看一次活会话，
   * 命中策略就替用户发一句进窗口。事实全从库里采，不挂 hook。
   */
  async autoReplyTick(): Promise<number> {
    const { store, outbox, config, log } = this.#d
    const cfg = config.auto_reply
    if (!cfg?.enabled) return 0
    const now = Date.now()
    const pollMs = cfg.pollSeconds * 1000
    if (this.#lastAutoReplyPoll && now - this.#lastAutoReplyPoll < pollMs) return 0
    this.#lastAutoReplyPoll = now

    let fired = 0
    for (const s of store.listSessions('active')) {
      if (!s.sessionId) continue
      const facts = store.sessionFacts(s.id)
      if (!facts) continue
      const stopAt = facts.lastStopAt ? Date.parse(facts.lastStopAt) : undefined
      const activeAt = Date.parse(facts.lastActiveAt)
      // 判定「还在跑」：最近有投递、且那次投递晚于上一轮结束
      const busy = stopAt === undefined ? now - activeAt < 60_000 : activeAt > stopAt
      const idleSeconds = stopAt === undefined ? undefined : (now - stopAt) / 1000
      const busySeconds = busy ? (now - activeAt) / 1000 : undefined

      const hit = decideAutoReply(
        cfg.policies.map((p) => ({
          reply: p.reply,
          enabled: p.enabled,
          triggers: p.triggers.map((t) => ({
            when: t.when,
            afterSeconds: t.afterSeconds,
            busySeconds: t.busySeconds,
            match: Array.isArray(t.match) ? t.match : t.match ? [{ mode: 'contains' as const, text: t.match }] : [],
          })),
        })),
        { text: facts.lastText, busy, idleSeconds, busySeconds },
      )
      if (!hit) continue
      if (!store.canAutoReply(s.id, cfg.cooldownSeconds * 1000)) continue
      store.markAutoReplied(s.id)
      outbox.enqueue(
        {
          kind: 'post_message',
          sessionId: s.id,
          text: `${AUTO_REPLY_ENVELOPE}（这条是按你的策略自动发的，不是你现在打的）\n\n${hit.reply}`,
        },
        dedupeKey(`${s.id}-${Math.floor(now / 1000)}`, 'auto-reply'),
      )
      log('info', `自动回复命中「${hit.reply}」：${hit.why}`)
      fired++
    }
    return fired
  }

  /** 置顶对账：会话不再活跃、卡却还记着置顶 → 撤掉（别人的置顶不碰）。 */
  /**
   * 关窗回收：claude 的窗口关了不会有任何事件，只能靠「执行器说它不在跑了」发现。
   *
   * 只对 claude 做：`claude agents --json` / 注册表 + pid 探活是事实；
   * dsh 只有文件 mtime 推断，据此标 dead 会误杀还在跑的会话。
   * 刚建/刚活动过的先放过（closeGraceMinutes），避免一张卡还没发就先判死。
   */
  async reapDeadSessions(): Promise<number> {
    const { store, ports, config, projects, log } = this.#d
    const graceMs = (config.sessions?.closeGraceMinutes ?? 2) * 60_000
    const now = Date.now()
    const active = store.listSessions('active').filter((s) => s.executor === 'claude' && s.sessionId)
    // dsh 没有进程信号、也没有「窗口关了」的事件：拿「多久没说话」当关窗信号会误杀
    // 「开着但没人说话」的窗口，连带撤掉它的置顶（2026-11-09 每半小时掉一次就是这个）。
    // 所以 dsh 只由 `#stop` 结束，这里不碰它。
    if (!active.length) return 0
    // 一次问一个执行器就够：claude 只有一种 policy
    const exec = executorPort(ports, config, 'claude')
    if (!exec?.listLiveSessions) {
      log('info', '关窗回收：执行器没有 listLiveSessions，跳过（无法判断窗口是否还开着）')
      return 0
    }
    let live: { sessionId: string }[]
    try {
      live = await exec.listLiveSessions()
    } catch (e) {
      // 这条要能看到：列不出来就等于关窗回收整个失效，而它只会表现为「置顶不撤」
      log('info', `关窗回收：列在跑会话失败（本轮跳过）：${e instanceof Error ? e.message : String(e)}`)
      return 0
    }
    const liveIds = new Set(live.map((x) => x.sessionId))
    let reaped = 0
    for (const s of active) {
      const lastActive = Date.parse(s.lastActiveAt)
      if (Number.isFinite(lastActive) && now - lastActive < graceMs) continue
      // 短 id / 全 uuid 混着存：互为前缀也算活着
      const alive = [...liveIds].some((id) => id === s.sessionId || id.startsWith(s.sessionId!) || s.sessionId!.startsWith(id))
      if (alive) continue
      store.setSessionStatus(s.id, 'dead')
      reaped++
      log('info', `关窗回收：${s.id}（${s.title ?? s.sessionId}）不在在跑列表里，标记 dead`)
    }
    void projects
    return reaped
  }

  /**
   * 把电脑上自己开的终端窗口接进飞书：建一条话题（置顶的状态卡当根），
   * 之后这个话题里的消息照常投进去，窗口 answering 完钩子也会把回复发回这里。
   * 只接「执行器报的活会话」里我们还不认识的；每轮限量，避免一次冒出一堆话题。
   */
  async adoptLocalWindows(): Promise<number> {
    const { store, ports, config, log } = this.#d
    if (!config.sessions?.adoptLocalWindows) return 0
    const { outbox } = this.#d
    const chatId = Object.values(config.channels)[0]?.defaultChatId
    if (!chatId) return 0
    const limit = config.sessions?.adoptPerRun ?? 2
    let adopted = 0
    // 两种执行器各扫各的：claude 靠 `agents --json` 报的忙闲，dsh 只能按会话文件 mtime 推断。
    // 没配 executor_policies 的那种跳过——配置里只开了一种执行器时，另一种不该把整轮读窗口打挂。
    const kinds = (['claude', 'dsh'] as const).filter((k) => config.executor_policies[k])
    for (const kind of kinds) {
      if (adopted >= limit) break
      const exec = executorPort(ports, config, kind)
      if (!exec?.listLiveSessions) continue
      let live: { sessionId: string; cwd: string; title?: string; status?: string; createdAt?: number }[]
      try {
        live = (await exec.listLiveSessions()) as typeof live
      } catch (e) {
        log('debug', `扫本地 ${kind} 窗口失败（不影响主流程）：${e instanceof Error ? e.message : String(e)}`)
        continue
      }
      for (const s of live) {
        // 上限按两种执行器合计算：分开计数会让一轮冒出两倍的窗口
        if (adopted >= limit) break
        if (!s.sessionId || !s.cwd) continue
        const known = store.findSessionByExecutor(s.sessionId)
        if (known) {
          // 窗口还活着，但之前被关窗回收标过 dead（重启、短暂扫不到都会）：
          // 不复活就会一直撤它的置顶、不刷状态卡——用户看到「我明明开着，卡片却没了」。
          if (known.status !== 'active') {
            store.setSessionStatus(known.id, 'active')
            store.touchSession(known.id)
            log('info', `窗口复活：${known.id}（${known.title ?? s.sessionId.slice(0, 8)}）`)
          } else if (kind === 'dsh') {
            // dsh 没有进程状态：扫到「会话文件还在动」就是它在活动的唯一证据。
            // 不刷新活跃时间的话，你明明在用、只是没说话，半小时后也会被标 idle → 撤掉置顶（2026-11-09 反复出现）。
            store.touchSession(known.id)
            // dsh 也没有钩子：转录里的 `turn/end` 是「这一轮跑完了」的唯一信号。
            // 不接这一条，从飞书看这个窗口就只有「在跑 / 空闲」而永远没有回复（2026-11-10 用户报「没看到你发送的消息」）。
            this.#deliverDshTurn(known, store, outbox, log)
          }
          continue
        }
        // 老会话被「翻开来写一行」也会命中「90 秒内动过」，不能当新窗口接进来：
        // dsh 没有窗口概念，只能拿创建时间挡（2026-11-09：11-04 建的会话被激活，刷出两个莫名其妙的话题）。
        const freshMs = (config.sessions?.adoptNewMinutes ?? 10) * 60_000
        if (kind === 'dsh' && typeof s.createdAt === 'number' && Date.now() - s.createdAt > freshMs) {
          log('debug', `跳过老 dsh 会话（${Math.round((Date.now() - s.createdAt) / 60_000)} 分钟前建的）：${s.sessionId.slice(0, 12)}`)
          continue
        }
        const id = localSessionId(s.sessionId)
        if (store.getSession(id)) continue
        const now = new Date().toISOString()
        const title = (s.title && s.title.trim()) || s.cwd.replace(/\\/g, '/').split('/').filter(Boolean).pop() || s.sessionId.slice(0, 8)
        store.insertSession({
          id,
          chatId,
          title,
          executor: kind,
          workspace: s.cwd,
          sessionId: s.sessionId,
          status: 'active',
          createdAt: now,
          lastActiveAt: now,
          source: kind === 'dsh' ? SOURCE_LOCAL_DSH : SOURCE_LOCAL_CLAUDE,
        })
        const card = {
          title,
          status: 'done' as const,
          lines: [`💻 电脑上开的终端窗口（${kind} ${id.replace('sess-local-', '')}）`, `📁 \`${s.cwd}\``, '在这个话题里发消息就能直接投进去。'],
        }
        // 用卡片建话题：它同时是这条话题的根消息，也是这个窗口的状态卡（置顶）
        outbox.enqueue(
          { kind: 'card_upsert', sessionId: id, card, signature: cardSignature(card) },
          dedupeKey(id, 'local-adopt'),
        )
        adopted++
        // dsh 没有可读的进程状态，listLiveSessions 只按「会话文件 90 秒内动过」推断（dsh-discover.ts:125），
        // 日志里写清楚，别让读日志的人以为这是真的在跑
        log(
          'info',
          `接进飞书：${title}（${kind} ${id.replace('sess-local-', '')} @ ${s.cwd}）${
            kind === 'dsh' ? '；dsh 的「在跑」是会话文件推断值，不是进程状态' : ''
          }`,
        )
      }
    }
    return adopted
  }

  async reconcilePins(): Promise<number> {
    const { store, ports, config, log } = this.#d
    const ch = ports.channels.get(Object.values(config.channels)[0]?.plugin ?? '')
    // 话题绑定对账（幂等）：
    //  1) 有卡但 root_message_id 空着 → 补上；
    //  2) thread_id 不是 omt_ 开头（以前错绑成根消息 id）→ 回头问一次真的话题 id。
    // 不修这两条，话题里发的消息路由不回窗口，用户看到的就是「消息石沉大海」。
    for (const s of store.listSessions()) {
      const c = store.getCard(s.id)
      const usable = c && c.signature !== '__pin_only__' ? c : undefined
      if (!s.rootMessageId && usable) {
        store.setSessionRoot(s.id, usable.messageId)
        log('info', `话题根补绑：${s.id} → ${usable.messageId}`)
      }
      // 历史上状态卡曾发到话题内（一轮一张），那些消息 pin 了也不出现在群主消息流的置顶面板里。
      // 卡记录指回话题根，pin 才会跟着根走——根是唯一在主消息流可见的那条。
      // 换过卡的不迁回（`detached`）：话题根是老 schema、永远改不动，
      // 迁回去下一拍又得换一张，来回拉锯。
      if (usable && s.rootMessageId && usable.messageId !== s.rootMessageId && !usable.detached) {
        store.upsertCard(s.id, usable.chatId, s.rootMessageId, usable.signature)
        log('info', `状态卡迁回话题根：${s.id} → ${s.rootMessageId}`)
      }
      if (!usable) continue
      if (s.threadId?.startsWith('omt_')) continue
      const tid = ch?.threadIdOf ? await ch.threadIdOf(usable.messageId).catch(() => undefined) : undefined
      if (tid && tid !== s.threadId) {
        store.setSessionThread(s.id, tid)
        log('info', `话题 id 更正：${s.id} → ${tid}`)
      }
    }
    if (!ch?.pinMessage) return 0
    let fixed = 0
    const now = Date.now()
    // 每轮最多撤 10 条：一次撤太多会撞频率限制，也让日志难看
    for (const s of store.listSessions()) {
      if (fixed >= 10) break
      if (windowStillOpen(s)) continue
      if (!store.isCardPinned(s.id)) continue
      const card = store.getCard(s.id)
      if (!card) continue
      // 刚置上不到 5 分钟的先不动：会话表偶尔漏一拍，撤了下一秒又要重新置上
      const age = store.cardPinnedAge(s.id)
      if (age !== undefined && age < 5 * 60_000) continue
      try {
        await ch.pinMessage(card.messageId, false)
        store.setCardPinned(s.id, false)
        fixed++
        log('info', `置顶对账：撤掉已停会话 ${s.id} 的置顶`)
      } catch (e) {
        log('warn', `置顶对账失败（下次再试）：${e instanceof Error ? e.message : String(e)}`)
      }
    }
    // 孤儿置顶：一个窗口每轮一张卡，收卡后下一轮另起；cards 表只留最后一张，
    // 历史卡的置顶就没人认领了（用户看到「只有两个窗口，置顶一大堆」）。以平台列表为准对账。
    if (ch.listPins) {
      const chatId = Object.values(config.channels).find((c) => c.defaultChatId)?.defaultChatId
      if (chatId) {
        // 每轮 tick 都拉一次列表太重（一次 listPins 就是一个 CLI 子进程）：10 秒一次足够
        if (now - this.#lastPinSyncAt < 10_000) return fixed
        this.#lastPinSyncAt = now
        try {
          const pins = await ch.listPins(chatId)
          // 以平台为准校准本地标记：本地「记着置顶」但平台上没有的（被平台侧撤了、或当初 pin 没真的成功），
          // 不校准就永远不会再补——用户看到的就是「窗口开着，置顶却没有」。
          const onPlatform = new Set(pins.map((p) => p.messageId))
          for (const s of store.listSessions()) {
            const card = store.getCard(s.id)
            if (!card) continue
            const actual = onPlatform.has(card.messageId)
            if (actual !== store.isCardPinned(s.id)) {
              store.setCardPinned(s.id, actual)
              log('debug', `置顶标记校准：${s.id} → ${actual ? '已置顶' : '未置顶'}`)
            }
          }
          const keep = new Set<string>()
          for (const s of store.listSessions()) {
            const card = store.getCard(s.id)
            if (!card) continue
            // 活着的窗口保留它当前的卡；已停的不留（下面统一撤）
            if (windowStillOpen(s)) keep.add(card.messageId)
          }
          const orphans = pickOrphanPins(pins, keep, 10 - fixed)
          for (const mid of orphans) {
            try {
              await ch.pinMessage(mid, false)
              fixed++
              log('info', `置顶对账：撤掉没人认领的置顶 ${mid}`)
            } catch (e) {
              log('warn', `撤销孤儿置顶失败（下次再试）：${e instanceof Error ? e.message : String(e)}`)
            }
          }
          // 反过来也要补：活窗口的当前卡如果是 `card_send` 发出来的（没走过置顶），
          // 这里补上，保证「活窗口 = 一张置顶状态卡」这条语义两头都成立。
          const sessions = store.listSessions()
          const restore = pickPinsToRestore(
            sessions.map((s) => ({
              sessionId: s.id,
              messageId: store.getCard(s.id)?.messageId ?? '',
              pinned: store.isCardPinned(s.id),
              alive: windowStillOpen(s),
            })),
            // 上限跟着活窗口数走：写死 3 的话，开了 6 个窗口要等好几轮才能补齐
            Math.max(3, sessions.length),
          )
          for (const r of restore) {
            try {
              await ch.pinMessage(r.messageId, true)
              store.setCardPinned(r.sessionId, true)
              log('info', `置顶对账：补回活窗口 ${r.sessionId} 的状态卡置顶`)
            } catch (e) {
              log('warn', `补置顶失败（下次再试）：${e instanceof Error ? e.message : String(e)}`)
            }
          }
        } catch (e) {
          log('warn', `置顶列表对账失败（下次再试）：${e instanceof Error ? e.message : String(e)}`)
        }
      }
    }
    return fixed
  }

  /** 单张卡的进度刷新：节流 + 只在内容变化时才入队（签名比较在投递环节）。 */
  /**
   * 没有可读转录的窗口（dsh）用库里的事实画一张「会动」的卡。
   *
   * 「在跑」三条同时成立：会话还是 active、最近 2 分钟内有活动、那次活动晚于上一轮结束。
   * 活动时间来自 `adoptLocalWindows` 每 20 秒的扫描（扫到会话文件在动就 touch），
   * 所以它反映的是「这个窗口有没有在写东西」，不是「用户多久没说话」。
   */
  /**
   * dsh 窗口的结果回传。
   *
   * claude 靠 Stop 钩子把回复送回来；dsh 没有钩子，只能读它自己的转录
   * （`~/.dsh/sessions/<slug>/<id>/session.v*.jsonl.zstd`，多帧 zstd，解析见 `dsh-transcript.ts`）。
   * 判重按 `turn/end` 的 seq：同一轮只发一次，重启也不会重发。
   */
  #deliverDshTurn(s: Session, store: Store, outbox: Outbox, log: Log): number {
    if (!s.sessionId || !s.chatId) return 0
    const file = findDshTranscript(s.sessionId)
    if (!file) return 0
    const turn = lastDshTurn(file)
    if (!turn) return 0
    if (store.lastRepliedTurn(s.id) === turn.id) return 0
    outbox.enqueue(
      {
        kind: 'card_send',
        sessionId: s.id,
        chatId: s.chatId,
        replyTo: s.rootMessageId ?? s.threadId,
        card: buildNoticeCard({
          title: s.title ?? s.id,
          cwd: s.workspace,
          time: new Date(turn.endedAt ?? Date.now()).toLocaleTimeString('zh-CN', { hour12: false }),
          userSaid: turn.said,
          body: turn.text,
          index: 1,
          total: 1,
        }),
      },
      dedupeKey(s.id, `dsh-turn-${turn.id}`),
    )
    store.markReplied(s.id, turn.id)
    log('info', `dsh 结果回传：${s.id}（第 ${turn.id} 轮）`)
    return 1
  }

  #refreshFactsCard(
    s: Session,
    store: Store,
    outbox: Outbox,
    log: Log,
  ): number {
    const facts = store.sessionFacts(s.id)
    const activeAt = facts ? Date.parse(facts.lastActiveAt) : Number.NaN
    const stopAt = facts?.lastStopAt ? Date.parse(facts.lastStopAt) : Number.NaN
    const fresh = Number.isFinite(activeAt) && Date.now() - activeAt < 120_000
    const running = s.status === 'active' && fresh && !(Number.isFinite(stopAt) && stopAt > activeAt)
    // **必须用分钟粒度**（`刚刚` / `N 分钟前`）：`normalizeCardLine` 会把「12 秒」整段抹掉，
    // 抹完签名成了常量 → 入队键永久命中判重 → 卡冻在第一次画的那一刻（2026-11-10 实测冻了 8 小时）。
    const ago = Number.isFinite(activeAt) ? formatAgo(Math.max(0, Date.now() - activeAt)) : '未知'
    const said = (facts?.lastText ?? '').replace(/\s+/g, ' ').trim()
    const card: CardState = {
      title: s.title ?? s.id,
      status: running ? 'running' : 'done',
      lines: [
        ...(said ? [`💬 你说：${said.length > 60 ? `${said.slice(0, 60)}…` : said}`] : []),
        running ? `🟢 在跑 · 最近活跃 ${ago}` : `⚪ 空闲 · 最近活跃 ${ago}`,
        `📁 \`${s.workspace}\``,
        'dsh 的过程细节（工具、改动文件）没有可读转录，这里只反映窗口是否在动',
      ],
    }
    const signature = cardSignature(card)
    outbox.enqueue(
      { kind: 'card_upsert', sessionId: s.id, card, signature },
      dedupeKey(`${s.id}-${signature}`, 'card-facts'),
    )
    log('debug', `dsh 状态卡：${s.id} → ${running ? '在跑' : '空闲'}`)
    return 1
  }

  /** 单张卡的进度刷新：节流 + 只在内容变化时才入队（签名比较在投递环节）。 */
  async #refreshOneCard(
    s: Session,
    config: Config,
    projects: Projects,
    ports: Ports,
    store: Store,
    outbox: Outbox,
    log: Log,
  ): Promise<number> {
    const refreshMs = config.sessions?.cardRefreshMs ?? 2000
    if (refreshMs <= 0) return 0
    const last = this.#cardRefreshedAt.get(s.id) ?? 0
    if (Date.now() - last < refreshMs) return 0
    if (!s.sessionId) {
      log('debug', `卡跳过（会话没有 sessionId）：${s.id}`)
      return 0
    }
    const ws = projects.workspaces.find((w) => w.id === s.workspace) ?? { id: s.workspace, root: s.workspace }
    const executor = ws ? executorPort(ports, config, s.executor) : null
    if (!ws || !executor) {
      log('debug', `卡跳过（工作区或执行器没解析出来）：${s.id}`)
      return 0
    }
    this.#cardRefreshedAt.set(s.id, Date.now())
    let progress: Progress[]
    try {
      progress = await executor.read({ executor: s.executor, sessionId: s.sessionId, workspace: ws.root })
    } catch (e) {
      log('debug', `读进度失败（不影响主流程）：${e instanceof Error ? e.message : String(e)}`)
      // dsh 的 read 本来就没有东西可读：别因此整条链路退出，下面用库里的事实画卡
      if (s.executor !== 'dsh') return 0
      progress = []
    }
    const lastLine = [...progress].reverse().find((p) => p.kind === 'output' && p.text)?.text?.trim().split('\n').pop()
    const transcript = (this.#d.transcripts ?? findTranscript)(s.sessionId)
    // dsh 的转录在 `~/.dsh` 下的 zstd 多帧文件里，读不出过程细节；但它自己的事实（最后一句、
    // 最后活跃、上一轮结束时间）都在库里。原来这里直接 return 0，dsh 窗口的卡就永远停在
    // 接入那一刻（2026-11-09 用户报「实时状态又不显示了」）。
    if (!transcript && !lastLine) {
      // dsh 本来就没有可读转录，用库里的事实画一张会动的卡；
      // claude 读不到转录说明这一拍异常，别拿事实卡去覆盖它正常的进度卡。
      log(
        'debug',
        s.executor === 'dsh'
          ? `dsh 没有转录，改走事实卡：${s.id}`
          : `卡跳过（claude 读不到转录，也没有输出行）：${s.id}`,
      )
      return s.executor === 'dsh' ? this.#refreshFactsCard(s, store, outbox, log) : 0
    }
    // 会话真名（claude 自己的 aiTitle）到位就换掉「用户第一句话当标题」——放在任何 return 之前，
    // 否则一轮刚结束时（走补发分支直接 return）标题永远换不过来。
    if (transcript) {
      const realTitle = transcriptTitle(transcript)
      if (realTitle && realTitle !== s.title) {
        store.setSessionTitle(s.id, realTitle)
        log('info', `会话改名：${s.id} → ${realTitle}`)
      }
    }
    // 一轮已结束、且这张卡画的就是它的收尾 → 不用再刷。
    // 不判这个，同一张卡每拍都会被重算一遍；但轮次一变必须继续走，否则卡停在上一轮。
    const openTurn = transcript ? currentTurn(transcript) : undefined
    if (transcript && openTurn?.userId && !isTurnOpen(transcript)) {
      // 兜底：钩子丢了（实测 2026-11-06 有一次 POST 没到，整轮回复凭空消失）。
      // 转录里这一轮已经收尾、而库里没有「已回复」记录 → 补发一次，发完记下来不会重复。
      if (store.lastRepliedTurn(s.id) !== openTurn.userId) {
        const ch = channelPort(this.#d.ports, this.#d.config)
        if (ch?.sendCard && s.chatId) {
          const said = openTurn.said ?? ''
          outbox.enqueue(
            {
              kind: 'card_send',
              sessionId: s.id,
              chatId: s.chatId,
              replyTo: s.rootMessageId ?? s.threadId,
              card: buildNoticeCard({
                title: s.title ?? s.id,
                cwd: s.workspace,
                time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
                stats: statsLine(transcript, resolveContextWindow(config.contextWindow)),
                body: said || '（这一轮没有输出）',
                index: 1,
                total: 1,
              }),
            },
            dedupeKey(s.id, `catchup-reply-${openTurn.userId}`),
          )
          store.markReplied(s.id, openTurn.userId)
          // 补发的同时把状态卡也刷成这一轮的收尾：
          // 这张卡可能停在很久以前（实测有的窗口卡停了一整天，因为它的转录一直找不到），
          // 只发新消息、不刷卡的话，pin 面板里那条会继续显示旧内容。
          store.setCardTurn(s.id, openTurn.userId)
          const finalCard = buildStatusCard({
            session: s,
            transcript,
            running: false, // 这一轮已经收尾，别画成「在跑」
            contextWindow: config.contextWindow,
          })
          outbox.enqueue(
            {
              kind: 'card_upsert',
              sessionId: s.id,
              card: finalCard,
              signature: cardSignature(finalCard),
            },
            dedupeKey(`${s.id}-${cardSignature(finalCard)}`, 'card-final'),
          )
          log('warn', `钩子没到，补发这一轮的回复：${s.id}（${openTurn.userId.slice(0, 8)}）`)
          this.#cardDrawnAt.set(s.id, Date.now())
          return 1
        }
      }
      // 同一轮不必每拍重算，但也不能永久跳过：卡上的「刚刚 / 已 N 分」会一直停在旧值。
      // 一分钟放行一次，正好对上卡片的分钟粒度。
      if (store.cardTurn(s.id) === openTurn.userId) {
        const drawnAt = this.#cardDrawnAt.get(s.id) ?? 0
        if (Date.now() - drawnAt < 60_000) return 0
      }
    }
    // 有转录就用它画完整的几行（你说/在跑多久/改了哪些文件/它说/用量）；
    // 没有转录才退回「工作区 + 执行器 + 最后一行日志」。
    if (transcript) {
      const turnId = currentTurn(transcript).userId
      const prevTurn = store.cardTurn(s.id)
      if (turnId && prevTurn && turnId !== prevTurn) {
        // **不换卡、不换消息**：同一个窗口永远只用话题根那一条消息。
        // 理由：飞书的「Pin 消息」面板在群主消息流里只看得到主消息流的消息；
        // 状态卡如果每轮新发一条，那条落在话题内，pin 了也不出现在面板里（用户反复报「pin 里看不到」）。
        // 话题根消息本身就在主消息流，patch 它 = 置顶列表里一行一个窗口，内容是实时状态。
        log('info', `新一轮：${s.id}（${turnId.slice(0, 8)}）——状态卡原地更新，不换消息`)
      }
      if (turnId) store.setCardTurn(s.id, turnId)
    }
    const card = transcript
      ? buildStatusCard({
          session: s,
          transcript,
          // 「在跑」看转录，不看会话状态：会话状态只有关窗/超时才变，
          // 钩子漏一次卡就会一直显示「正在运行」（实测 14:22 就结束、14:23 卡还写着已 22 秒）
          running: s.status === 'active' && isTurnOpen(transcript),
          contextWindow: config.contextWindow,
        })
      : {
          title: s.title ?? s.id,
          status: 'running' as const,
          lines: [`📁 ${s.workspace}`, `🤖 ${(lastLine ?? '').slice(0, 120)}`],
        }
    outbox.enqueue(
      { kind: 'card_upsert', sessionId: s.id, card, signature: cardSignature(card) },
      dedupeKey(`${s.id}-${cardSignature(card)}`, 'card-progress'),
    )
    this.#cardDrawnAt.set(s.id, Date.now())
    return 1
  }

  async #classify(e: Event): Promise<Intent | null> {
    const { classifier, projects, log } = this.#d
    if (!classifier) return null
    let intent: Intent | null
    try {
      intent = await classifier.impl.classify(e, candidatesOf(projects))
    } catch (err) {
      log('warn', `分类失败，只记录：${err instanceof Error ? err.message : String(err)}`)
      return null
    }
    if (!intent) return null
    if (intent.eventId !== e.id) {
      log('warn', `分类结果 eventId 不符，丢弃：${intent.eventId} ≠ ${e.id}`)
      return null
    }
    return intent
  }
}

function textOf(e: Event): string {
  if (e.imageKey && e.text.trim().startsWith('{')) return '[图片]'
  return e.text
}

// 状态卡签名统一放在 card-content：入队签名与投递判重必须是同一个口径
const cardSignature = statusCardSignature

function optionList(options: readonly { label: string }[]): string {
  return options.map((o, i) => `${i + 1}) ${o.label}`).join('  ')
}

function suggestText(work: Work): string {
  return [
    `建议派工：${work.project}`,
    `执行器：${work.executor}`,
    `工作区：${work.workspace}`,
    '',
    '确认后回复「执行」才会真的开工（当前建议档不自动派工）。',
  ].join('\n')
}
