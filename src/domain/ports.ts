/** 四类端口 + 插件契约。插件的全部能力都在这里，内核只认这些。 */

import type { z } from 'zod'
import type {
  Action,
  Event,
  ExecutorKind,
  Intent,
  Progress,
  ProjectCandidate,
  Work,
} from './types.ts'

export type PluginKind = 'source' | 'classifier' | 'executor' | 'channel'

export interface Manifest {
  id: string
  kind: PluginKind
  /** 同 kind 内依赖（一般留空，插件之间不互相调用） */
  needs?: readonly string[]
  /** 缺省配置；config/lingcub.yaml 的同 id 段覆盖 */
  config: z.ZodTypeAny
}

export interface HistoryQuery {
  channelId: string
  before?: string
  limit: number
}

export interface HistoryItem {
  externalId: string
  actor: { id: string; name?: string }
  text: string
  occurredAt: string
}

export interface Source {
  start(emit: (e: Event) => void): Promise<void>
  stop(): Promise<void>
  /** 可选：平台事件库之外的会话历史；分析层只经 state.history.fetch 调用。 */
  fetchHistory?(q: HistoryQuery): Promise<HistoryItem[] | undefined>
}

export interface Classifier {
  /** candidates 只来自 config/projects.yaml；返回 null 表示「判不了」，内核只记录不派工。 */
  classify(e: Event, candidates: readonly ProjectCandidate[]): Promise<Intent | null>
}

export interface Handle {
  executor: ExecutorKind
  sessionId: string
  workspace: string
}

/** 执行器扫出来的候选工作区（用户机器上真实存在的目录） */
export interface DiscoveredWorkspace {
  root: string
  label: string
  /** 最近活动时间（毫秒），用于排序；没有就 0 */
  lastActive: number
  /**
   * 在这个目录开窗口会不会先弹信任确认（claude 的「Is this a project you created…?」）。
   * 没给 = 不知道（比如 dsh 没这个概念）。
   */
  trusted?: boolean
}

/** 可恢复的历史会话 */
export interface DiscoveredSession {
  sessionId: string
  cwd: string
  title: string
  lastActive: number
  userTurns: number
  running: boolean
  /** 平台直接给出的忙闲（claude `agents --json` 有；dsh 只能推断，没把握就不填） */
  status?: 'busy' | 'idle'
}

export interface Executor {
  start(w: Work): Promise<Handle>
  read(h: Handle): Promise<Progress[]>
  stop(h: Handle): Promise<void>
  /** 把一句话投进已有会话（能力可缺失：缺了就是「这个执行器不支持追加」） */
  post?(h: Handle, text: string): Promise<void>
  /** 扫出这台机器上可用（且在 allowRoots 内）的工作区，供选择卡列出 */
  listWorkspaces?(): Promise<DiscoveredWorkspace[]>
  /** 列出这台机器上近几天的历史会话（供 `#resume` 恢复） */
  listSessions?(): Promise<DiscoveredSession[]>
  /** 正在跑的会话（用来把话题接到已经开着的窗口上，不是恢复） */
  listLiveSessions?(): Promise<DiscoveredSession[]>
  /**
   * 把工作区登记进「已信任」——用户选了工作区就等于说他信任这个目录，
   * 别让他再跑去终端按一次 Enter。返回登记后是否已信任、这次有没有真的改配置。
   */
  trustWorkspace?(root: string): Promise<{ trusted: boolean; changed: boolean }>
}

/** 文档执行端口：读快照、按整篇 markdown 写回；冲突由内核先比对再调用。 */
export interface DocPort {
  read(doc: string): Promise<{ revision: string; markdown: string }>
  write(doc: string, markdown: string, expect: { revision: string }): Promise<{ revision: string }>
  /**
   * 按小节省略整篇读写：docx 只能块级替换时用它。
   * 提供时内核不再调用 read/planSectionWrite，冲突检测由端口按平台 revision 负责。
   */
  writeSection?(
    doc: string,
    heading: string,
    body: string,
    expect: { revision: string },
  ): Promise<{ revision: string }>
}

/** send 必须幂等：同一 dedupeKey 重复调用只送达一次；messageId 用于后续在话题里续话/改卡 */
export interface SendResult {
  status: 'sent' | 'gone'
  messageId?: string
}

export interface Channel {
  send(a: Action, dedupeKey: string): Promise<SendResult>
  /** 发一张新卡；返回 messageId（之后原地改它） */
  /** pin=true 时频道会在发卡后置顶（只给「每窗口一张状态卡」用，别给就绪卡也置顶） */
  sendCard?(a: { chatId: string; replyTo?: string; card: unknown; pin?: boolean }, dedupeKey: string): Promise<SendResult>
  /** 原地改卡（飞书只允许改 14 天内、自己发的 interactive 消息） */
  patchCard?(messageId: string, card: unknown): Promise<void>
  /** 按人私聊一张卡（open_id 直发，不需要先知道 p2p 会话 id） */
  sendDm?(a: { userId: string; card: unknown }, dedupeKey: string): Promise<SendResult>
  /** 置顶/取消置顶（失败不该打挂主流程） */
  pinMessage?(messageId: string, pin: boolean): Promise<void>
  /**
   * 这条消息是不是我们自己发的卡（用来判断「某个话题是不是我们开的窗口」）。
   * 不实现就当作「不知道」——内核会退回静默，不猜。
   */
  isOwnMessage?(messageId: string): Promise<boolean | undefined>
  /**
   * 这条消息所在话题的 thread id（omt_…）。
   * 飞书里我们发的卡是新话题的根，但根消息 id（om_…）≠ 话题 id（omt_…）；
   * 拿不到真的 thread id，话题里发的消息就路由不回这个会话。
   */
  threadIdOf?(messageId: string): Promise<string | undefined>
  /** 下载消息里的图片到本地，返回可直接发给执行器的路径 */
  downloadImage?(a: { messageId: string; fileKey: string; outPath: string }): Promise<string>
  /**
   * 渠道中立出站：`transport.<渠道>.send` 能力提交后由 outbox 调到这里。
   * target 由插件自己解释（钉钉是 openDingtalkId/messageId），内核不拆。
   */
  sendTransport?(
    input: { text: string; target: Record<string, string> },
    dedupeKey: string,
  ): Promise<{ messageId?: string }>
}

export interface PluginContext<M extends Manifest = Manifest> {
  readonly config: z.infer<M['config']>
  readonly log: Log
  register(impl: Source | Classifier | Executor | Channel): void
}

/** 结构化日志签名；内核各部件与插件共用。 */
export type Log = (level: 'debug' | 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void

export interface Plugin<M extends Manifest = Manifest> {
  manifest: M
  setup(ctx: PluginContext<M>): void
}
