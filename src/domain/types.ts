/** 域模型：四层 + 动作。纯类型，无 IO。 */

export type SourceKind = 'dingtalk-im' | 'feishu-im' | 'feishu-task' | 'feishu-doc'

export type ChannelKind = 'dm' | 'group' | 'doc' | 'task'

export interface Event {
  /** 内容派生：sha256(source|externalId)[:16]，重复投递得同值 */
  id: string
  source: string
  externalId: string
  receivedAt: string
  occurredAt: string
  actor: { id: string; name?: string }
  channel: { kind: ChannelKind; id: string; name?: string }
  /** 话题 id（飞书的 thread_id）；有它才能把消息路由回某个会话 */
  threadId?: string
  /** 话题内回复指向的根消息 id；**新话题的第一条消息与普通群消息没有它** */
  rootId?: string
  /** 这条消息引用（回复）的那条消息 id：命中映射表就能找回窗口 */
  replyTo?: string
  /** 图片消息的 image_key；投递时据此把图下载到本地再告诉窗口 */
  imageKey?: string
  /** 这条消息里的所有图片 key（纯图消息一张，图文消息可能多张） */
  imageKeys?: string[]
  /** 平台侧是否 @ 了我；规则谓词 atMe 依赖它，由 source 插件映射 */
  atMe?: boolean
  text: string
  raw: unknown
}

/** 平台中间层对一条消息的分析产物；分发场景只读这份结果。 */
export interface MessageAnalysis {
  eventId: string
  /** 第几次分析；1 为首轮，重试递增，事件 id 也随之后缀。 */
  attempt?: number
  /** live=新消息；backfill=受控补分析，分发端默认不落副作用。 */
  origin?: 'live' | 'backfill'
  summary: string
  urgency?: 'low' | 'normal' | 'high'
  entities?: string[]
  contextVia?: 'event-store' | 'source-history'
  /** 从开始取上下文到模型返回的耗时；失败也记录。 */
  latencyMs?: number
  status: 'ok' | 'degraded'
  model?: string
  contextCount: number
  error?: string
  at: string
}

/**
 * 会话 = 可继续说话的对话：话题 ↔ 执行器会话 ↔ 工作区。
 * 不变式：一个话题最多绑一个会话；一个执行器会话同时只被一个话题绑定。
 */
export interface Session {
  id: string
  chatId: string
  /** 平台来源插件 id；决定结果回执走哪个渠道。 */
  source?: string
  /** 话题 id（飞书话题群里每条消息都带）；没有话题留空。路由按它匹配 */
  threadId?: string
  /** 话题根消息 id（om_…）：所有回复都回到它所在的话题里 */
  rootMessageId?: string
  /** 发起人的平台 id（`ou_…`）；需要 @ 他时用 */
  ownerId?: string
  title?: string
  executor: ExecutorKind
  /** 工作区 id（projects.yaml 的 id） */
  workspace: string
  /** 执行器侧会话 id */
  sessionId?: string
  status: 'active' | 'idle' | 'stopped' | 'dead'
  createdAt: string
  lastActiveAt: string
}

export type SessionOpenMode = 'terminal' | 'headless'

/** 开窗请求：内核持久化，执行器插件消费。requestId 用 Work id，保证重试稳定。 */
export interface SessionOpenRequest {
  requestId: string
  work: Work
  mode: SessionOpenMode
}

export interface SessionOpened {
  requestId: string
  executor: ExecutorKind
  sessionId: string
  cwd: string
  window?: { pid?: number; title?: string }
}

export interface SessionReady {
  requestId: string
  sessionRowId: string
  executor: ExecutorKind
  sessionId: string
  cwd: string
  chatId?: string
  source?: string
  threadId?: string
  rootMessageId?: string
  title?: string
  project?: string
}

/** 执行器观测到的一次进度；由执行器插件发事件，不经过内核轮询。 */
export interface SessionProgress {
  requestId?: string
  sessionId: string
  executor: ExecutorKind
  progress: Progress
}

export type IntentKind =
  | 'dev-request'
  | 'bug'
  | 'question'
  | 'chatter'
  | 'doc-update'
  | 'todo'

export type ActionKind = 'dispatch_session' | 'reply_only' | 'update_doc' | 'create_todo'

export interface Intent {
  eventId: string
  kind: IntentKind
  topic: string
  project?: string
  suggestedAction: ActionKind
  rationale: string
  confidence: number
  /** 命中规则时有值；模型判断为 undefined */
  byRule?: string
}

export type WorkStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
export type ExecutorKind = 'claude' | 'dsh'

export interface Work {
  id: string
  intentId: string
  kind: 'session' | 'reply' | 'doc'
  /** 开窗路径：event 由执行器插件消费 session.open.requested，Pipeline 不再轮询它 */
  via?: 'pipeline' | 'event'
  project: string
  executor: ExecutorKind
  /** 绝对路径，必须命中 executor_policies[executor].allowRoots */
  workspace: string
  prompt: string
  /** 要接着用的历史会话（`claude --resume <id>`）；不填就是新会话 */
  resumeSessionId?: string
  budgetUsd?: number
  sessionId?: string
  status: WorkStatus
  /** 开窗来源：有它就把回复发回原话题，并把话题绑成会话 */
  origin?: {
    chatId: string
    /** 平台来源插件 id（source-feishu-im / source-dingtalk）；决定 ready 卡由谁渲染 */
    source?: string
    title?: string
    threadId?: string
    rootMessageId?: string
    /** 已有会话时：把本话题改绑到新起的窗口，而不是再插一条会话 */
    rebindSessionId?: string
  }
  /** 发起人（`ou_…`），会话建起来后记到 sessions.owner_id */
  ownerId?: string
}

export type Action =
  | { kind: 'dispatch_session'; work: Work }
  /** 能力路径的会话：只起执行器并绑定来源会话，不建飞书窗口/卡片 */
  | { kind: 'start_session'; work: Work }
  /** P2.6：只落开窗请求并发事件，由执行器插件真正开窗 */
  | { kind: 'open_session'; work: Work; mode: SessionOpenMode }
  /** 渠道中立出站：由指定频道插件按 target 发送（钉钉回执等） */
  | { kind: 'transport_send'; plugin: string; target: Record<string, string>; text: string }
  /**
   * 私聊一张卡给某个人（open_id 直发）。
   * 与 notify.card.send 的区别：那条要 chatId，而 p2p 会话 id 未必拿得到；
   * `im +messages-send --user-id ou_…` 可以直接按人发。
   */
  | { kind: 'dm_send'; userId: string; card: unknown }
  /** 回一条消息；带 threadId 时回到该话题，否则回到频道默认会话 */
  | {
      kind: 'reply_only'
      text: string
      chatId?: string
      /** 要回复的那条消息 id：带它就进它所在的话题（飞书 `--reply-in-thread`） */
      replyTo?: string
      /** 这条回复属于哪个会话：投递成功后把消息 id 记进映射，用户引用它能找回窗口 */
      sessionId?: string
    }
  /** 把一条消息投进已有会话（话题里继续说话） */
  | {
      kind: 'post_message'
      sessionId: string
      text: string
      /** 要投递的图片（先下载再换成路径写进正文）；图文消息可以有多张 */
      images?: { messageId: string; fileKey: string }[]
    }
  /**
   * 状态卡：同一个会话只有一张卡，内容不变就不重发。
   * 是否需要新建/原地改，由内核按 `cards` 表判断，插件只负责两个 CLI 调用。
   */
  | { kind: 'card_upsert'; sessionId: string; card: CardState; signature: string }
  /** 发一张不属于任何会话的卡（选择器之类）；带 replyTo 就回进那个话题 */
  | {
      kind: 'card_send'
      chatId: string
      /** 指定频道插件（不填走默认频道）；独立 webhook 群用 */
      channel?: string
      replyTo?: string
      card: unknown
      sessionId?: string
      /** 发完顺手置顶（每窗口一张状态卡用；就绪卡不置顶，免得一个窗口挂两条置顶） */
      pin?: boolean
    }
  /** 改一张已经存在的卡（比如把上一轮的状态卡改成灰的「已结束」） */
  | { kind: 'card_patch'; chatId: string; messageId: string; card: unknown }
  /**
   * 收掉这个窗口的状态卡：改成灰的「上一轮的状态」、撤掉置顶、并从 cards 表删掉。
   * 一轮结束后状态卡就没用了，留着只会让话题里那一条一直占着置顶；新的一轮会另起一张。
   */
  | { kind: 'card_retire'; sessionId: string }
  /** 停掉这个窗口（执行器 stop + 会话置 stopped）；keepExecutor 只关窗口不停执行器 */
  | { kind: 'stop_session'; sessionId: string; keepExecutor?: boolean }
  /** 把会话改绑到另一个执行器会话（#resume 选中后） */
  | { kind: 'rebind_session'; sessionId: string; executorSessionId: string; workspace: string }
  /** 把话题接到正在跑的执行器会话（#attach；无会话行时新建） */
  | {
      kind: 'attach_session'
      chatId: string
      threadId?: string
      rootMessageId?: string
      executorSessionId: string
      workspace: string
      executor: 'claude' | 'dsh'
    }
  /** 回答待答题目：记录答案并投给执行器（能投的话） */
  | { kind: 'answer_question'; sessionId: string; questionId: string; answers: Record<string, string> }
  /** 置顶/取消置顶这个窗口的状态卡 */
  | { kind: 'pin_card'; sessionId: string; pin: boolean }
  /** 文档写回：只替换指定小节，写前比对版本与整篇指纹 */
  | {
      kind: 'update_doc'
      doc: string
      heading: string
      body: string
      expect: { revision: string; fingerprint: string }
    }
  | { kind: 'create_todo'; title: string; assignee?: string }

/** 状态卡的内容（渲染成飞书交互卡片由频道插件负责）。 */
export interface CardState {
  title: string
  status: 'running' | 'done' | 'failed' | 'waiting'
  lines: string[]
}

export interface Progress {
  at: string
  kind: 'started' | 'output' | 'finished' | 'error'
  text?: string
  costUsd?: number
}

/** 交给分类器的候选项目：模型只在这张表里挑，不许自己编项目名。 */
export interface ProjectCandidate {
  id: string
  name: string
  aliases: readonly string[]
}
