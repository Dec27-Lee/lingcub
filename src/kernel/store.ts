/** 持久化：SQLite（node:sqlite，零依赖）。所有状态都在这里，会话是可丢弃的计算。 */

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MESSAGE_RECEIVED, type BusEvent, type CapabilityEffect } from '../domain/events.ts'
import type {
  Action,
  Event,
  Intent,
  MessageAnalysis,
  Session,
  SessionOpenRequest,
  Work,
  WorkStatus,
} from '../domain/types.ts'

export type OutboxStatus = 'pending' | 'dispatched' | 'done' | 'dead' | 'unknown'

export interface OutboxRow {
  id: number
  dedupeKey: string
  action: Action
  status: OutboxStatus
  attempts: number
}

export interface SessionOpenRow {
  request: SessionOpenRequest
  status: 'requested' | 'opened' | 'failed'
  sessionId?: string
  error?: string
  createdAt: string
  updatedAt: string
}

export interface SubscriptionRow {
  subscriber: string
  kind: string
  cursor: number
  enabled: number
  updatedAt: string
}

export interface DeliveryRow {
  subscriber: string
  kind: string
  seq: number
  status: 'pending' | 'dispatched' | 'dead'
  attempts: number
  nextAt: number
  lastError: string | null
}

export interface CapabilityCallRow {
  id: number
  at: string
  caller: string
  name: string
  effect: CapabilityEffect
  status: 'would-do' | 'pending' | 'submitted' | 'done' | 'failed' | 'error'
  opKey: string | null
  inputDigest: string
  inputHead: string | null
  outboxId: number | null
  resultHead: string | null
  error: string | null
  durationMs: number
  causedBy: string | null
}

const now = () => new Date().toISOString()

/** 顺序执行的迁移；下标即目标 user_version。只能追加，不能改历史条目。 */
const MIGRATIONS: readonly ((db: DatabaseSync) => void)[] = [
  (db) => {
    db.exec(`
      CREATE TABLE events (
        id            TEXT PRIMARY KEY,
        source        TEXT NOT NULL,
        external_id   TEXT NOT NULL,
        received_at   TEXT NOT NULL,
        occurred_at   TEXT NOT NULL,
        at_me         INTEGER,
        actor_id      TEXT NOT NULL,
        actor_name    TEXT,
        channel_kind  TEXT NOT NULL,
        channel_id    TEXT NOT NULL,
        channel_name  TEXT,
        text          TEXT NOT NULL,
        raw           TEXT NOT NULL
      );
      CREATE TABLE intents (
        event_id         TEXT PRIMARY KEY REFERENCES events(id),
        kind             TEXT NOT NULL,
        topic            TEXT NOT NULL,
        project          TEXT,
        suggested_action TEXT NOT NULL,
        rationale        TEXT NOT NULL,
        confidence       REAL NOT NULL,
        by_rule          TEXT,
        created_at       TEXT NOT NULL
      );
      CREATE TABLE works (
        id          TEXT PRIMARY KEY,
        intent_id   TEXT NOT NULL REFERENCES intents(event_id),
        kind        TEXT NOT NULL,
        project     TEXT NOT NULL,
        executor    TEXT NOT NULL,
        workspace   TEXT NOT NULL,
        prompt      TEXT NOT NULL,
        budget_usd  REAL,
        session_id  TEXT,
        status      TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE TABLE outbox (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        dedupe_key TEXT NOT NULL UNIQUE,
        action     TEXT NOT NULL,
        status     TEXT NOT NULL,
        attempts   INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        event_id   TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX outbox_status ON outbox(status, id);
    `)
  },
  (db) => {
    db.exec(`
      ALTER TABLE events ADD COLUMN session_id TEXT;
      CREATE TABLE sessions (
        id             TEXT PRIMARY KEY,
        chat_id        TEXT NOT NULL,
        source         TEXT,
        thread_id      TEXT,
        title          TEXT,
        executor       TEXT NOT NULL,
        workspace      TEXT NOT NULL,
        session_id     TEXT,
        status         TEXT NOT NULL,
        created_at     TEXT NOT NULL,
        last_active_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX sessions_thread ON sessions(chat_id, thread_id);
      CREATE INDEX sessions_status ON sessions(status);
    `)
  },
  (db) => {
    db.exec(`
      CREATE TABLE choices (
        chat_id    TEXT NOT NULL,
        kind       TEXT NOT NULL,
        payload    TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY (chat_id, kind)
      );
    `)
  },
  (db) => {
    db.exec(`
      CREATE TABLE questions (
        id         TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        payload    TEXT NOT NULL,
        answers    TEXT NOT NULL DEFAULT '{}',
        status     TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX questions_session ON questions(session_id, status);
    `)
  },
  (db) => {
    db.exec(`
      ALTER TABLE questions ADD COLUMN kind TEXT NOT NULL DEFAULT 'question';
      ALTER TABLE sessions ADD COLUMN owner_id TEXT;
      CREATE TABLE replies (
        session_id TEXT NOT NULL,
        kind       TEXT NOT NULL,
        last_at    TEXT NOT NULL,
        PRIMARY KEY (session_id, kind)
      );
    `)
  },
  (db) => {
    db.exec(`
      CREATE TABLE cards (
        session_id TEXT PRIMARY KEY,
        chat_id    TEXT NOT NULL,
        message_id TEXT NOT NULL,
        signature  TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        pinned     INTEGER NOT NULL DEFAULT 0
      );
    `)
  },
  // 追加：会话上后加的列（老库可能还缺），按需补——SQLite 的 ADD COLUMN 没有 IF NOT EXISTS
  (db) => {
    const cols = new Set(
      (db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map((c) => c.name),
    )
    const add = (name: string, type: string): void => {
      if (!cols.has(name)) db.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${type}`)
    }
    add('root_message_id', 'TEXT')
    add('last_stop_at', 'TEXT')
    add('last_text', 'TEXT')
    add('auto_reply_at', 'TEXT')
  },
  // 追加：多选题草稿（先攒着，点「就这些」才提交）
  (db) => {
    const cols = new Set(
      (db.prepare('PRAGMA table_info(questions)').all() as { name: string }[]).map((c) => c.name),
    )
    if (!cols.has('draft')) db.exec('ALTER TABLE questions ADD COLUMN draft TEXT')
  },
  // 追加：置顶时间（刚置上不到 5 分钟的先不撤，避免撤了又置）
  (db) => {
    const cols = new Set(
      (db.prepare('PRAGMA table_info(cards)').all() as { name: string }[]).map((c) => c.name),
    )
    if (!cols.has('pinned_at')) db.exec('ALTER TABLE cards ADD COLUMN pinned_at TEXT')
  },
  // 追加：状态卡属于哪一轮（换了新的一轮就另起一张卡）
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS card_turns (
        session_id TEXT PRIMARY KEY,
        turn_id    TEXT NOT NULL
      )
    `)
  },
  // 追加：桥接发出去的每条消息都记一笔，用户引用它能找回窗口（幂等）
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS message_map (
        message_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        chat_id    TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_message_map_session ON message_map(session_id);
    `)
  },
  // 追加：分段限流用的「最早可投递时间」（毫秒时间戳，0 = 立刻）
  (db) => {
    const cols = new Set(
      (db.prepare('PRAGMA table_info(outbox)').all() as { name: string }[]).map((c) => c.name),
    )
    if (!cols.has('not_before')) db.exec('ALTER TABLE outbox ADD COLUMN not_before INTEGER NOT NULL DEFAULT 0')
  },
  /**
   * 追加：置顶时间。
   *
   * 这条**必须**是新的迁移，不能塞回上面那条：老库里那条早已记账为「已执行」，
   * 塞回去等于永远不跑——现场就是 `user_version=12` 但 `cards` 没有 `pinned_at`，
   * 于是「发卡顺手置顶」的记账每次都抛 SQL 错，置顶永远撤不掉。
   */
  (db) => {
    const cols = new Set((db.prepare('PRAGMA table_info(cards)').all() as { name: string }[]).map((c) => c.name))
    if (!cols.has('pinned_at')) db.exec('ALTER TABLE cards ADD COLUMN pinned_at TEXT')
  },
  /**
   * 追加：结构自愈。
   *
   * 现场的库 `user_version` 走到 12，却缺 `pinned_at` 列与 `card_turns` 表——
   * 因为它们被加进了**已经执行过**的迁移里（迁移是 append-only，改中间那条等于不执行）。
   * 这里把「代码假定一定存在」的结构统一补一遍：缺什么补什么，已有就跳过，可重复执行。
   */
  (db) => {
    const colsOf = (t: string) =>
      new Set((db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name))
    if (!colsOf('cards').has('pinned_at')) db.exec('ALTER TABLE cards ADD COLUMN pinned_at TEXT')
    if (!colsOf('outbox').has('not_before')) db.exec('ALTER TABLE outbox ADD COLUMN not_before INTEGER NOT NULL DEFAULT 0')
    if (!colsOf('sessions').has('owner_id')) db.exec('ALTER TABLE sessions ADD COLUMN owner_id TEXT')
    if (!colsOf('questions').has('kind')) db.exec("ALTER TABLE questions ADD COLUMN kind TEXT NOT NULL DEFAULT 'question'")
    if (!colsOf('questions').has('draft')) db.exec('ALTER TABLE questions ADD COLUMN draft TEXT')
    db.exec(`
      CREATE TABLE IF NOT EXISTS card_turns (
        session_id TEXT PRIMARY KEY,
        turn_id    TEXT NOT NULL
      )
    `)
    db.exec(`
      CREATE TABLE IF NOT EXISTS message_map (
        message_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        chat_id    TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `)
    db.exec('CREATE INDEX IF NOT EXISTS idx_message_map_session ON message_map(session_id)')
  },
  // 哪一轮的回复已经发过了：钩子丢一次时，巡检靠它判断「这轮还没回」，只补一次不重复。
  // 迁移只能往末尾追加——改已经执行过的那一条，线上库永远不会再跑它（踩过两次）。
  (db) => {
    const cols = new Set((db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map((c) => c.name))
    if (!cols.has('last_replied_turn')) db.exec('ALTER TABLE sessions ADD COLUMN last_replied_turn TEXT')
  },
]

interface EventRow {
  id: string
  source: string
  external_id: string
  received_at: string
  occurred_at: string
  at_me: number | null
  actor_id: string
  actor_name: string | null
  channel_kind: string
  channel_id: string
  channel_name: string | null
  text: string
  raw: string
}

interface EventLogRow {
  seq: number
  id: string
  kind: string
  source: string
  subject: string | null
  at: string
  payload: string
  caused_by: string | null
}

interface DeliveryDbRow {
  subscriber: string
  kind: string
  seq: number
  status: string
  attempts: number
  next_at: number
  last_error: string | null
}

interface CapabilityCallDbRow {
  id: number
  at: string
  caller: string
  name: string
  effect: string
  status: string
  op_key: string | null
  input_digest: string
  input_head: string | null
  outbox_id: number | null
  result_head: string | null
  error: string | null
  duration_ms: number
  caused_by: string | null
}

interface IntentRow {
  event_id: string
  kind: string
  topic: string
  project: string | null
  suggested_action: string
  rationale: string
  confidence: number
  by_rule: string | null
}

interface OutboxDbRow {
  id: number
  dedupe_key: string
  action: string
  status: string
  attempts: number
}

interface WorkRow {
  id: string
  intent_id: string
  kind: string
  via: string | null
  project: string
  executor: string
  workspace: string
  prompt: string
  budget_usd: number | null
  session_id: string | null
  status: string
}

export interface PendingQuestion {
  id: string
  /** 这条待答属于哪个会话（发下一题/回执要知道发到哪） */
  sessionId: string
  /** question：选择题；permission：工具授权 */
  kind?: 'question' | 'permission'
  questions: { question: string; header?: string; multiSelect?: boolean; options?: { label: string; description?: string }[] }[]
  answers: Record<string, string>
  expiresAt: string
}

interface SessionRow {
  id: string
  chat_id: string
  source: string | null
  thread_id: string | null
  root_message_id: string | null
  owner_id: string | null
  title: string | null
  executor: string
  workspace: string
  session_id: string | null
  status: string
  created_at: string
  last_active_at: string
}

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    chatId: row.chat_id,
    source: row.source ?? undefined,
    threadId: row.thread_id ?? undefined,
    rootMessageId: row.root_message_id ?? undefined,
    ownerId: row.owner_id ?? undefined,
    title: row.title ?? undefined,
    executor: row.executor as Session['executor'],
    workspace: row.workspace,
    sessionId: row.session_id ?? undefined,
    status: row.status as Session['status'],
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
  }
}

function toWork(row: WorkRow): Work {  return {
    id: row.id,
    intentId: row.intent_id,
    kind: row.kind as Work['kind'],
    via: row.via === 'event' ? 'event' : row.via === 'pipeline' ? 'pipeline' : undefined,
    project: row.project,
    executor: row.executor as Work['executor'],
    workspace: row.workspace,
    prompt: row.prompt,
    budgetUsd: row.budget_usd ?? undefined,
    sessionId: row.session_id ?? undefined,
    status: row.status as Work['status'],
  }
}

function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
  let version = Number(row?.user_version ?? 0)
  if (version > MIGRATIONS.length) {
    throw new Error(`数据库版本 ${version} 高于代码支持的 ${MIGRATIONS.length}，请升级程序`)
  }
  for (; version < MIGRATIONS.length; version++) {
    db.exec('BEGIN')
    try {
      MIGRATIONS[version]!(db)
      db.exec(`PRAGMA user_version = ${version + 1}`)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  }
  // 补列兜底：版本号只能保证「按顺序跑过」，保不了「某次改表真的生效」。
  // 2026-11-03 就因为把新迁移插在数组中间，旧库的 user_version 直接跳过了它，
  // 运行时炸 `no such column`。这里每次打开都幂等地补一遍关键列，代价是两条 PRAGMA。
  ensureColumns(db)
}

/** 必须存在的列（缺了就补）。只放「漏了会让运行期炸」的，不要当成常规做法。 */
const REQUIRED_COLUMNS: readonly { table: string; column: string; ddl: string }[] = [
  { table: 'sessions', column: 'source', ddl: 'ALTER TABLE sessions ADD COLUMN source TEXT' },
  { table: 'outbox', column: 'event_id', ddl: 'ALTER TABLE outbox ADD COLUMN event_id TEXT' },
  { table: 'outbox', column: 'not_before', ddl: 'ALTER TABLE outbox ADD COLUMN not_before INTEGER NOT NULL DEFAULT 0' },
  { table: 'sessions', column: 'root_message_id', ddl: 'ALTER TABLE sessions ADD COLUMN root_message_id TEXT' },
  { table: 'sessions', column: 'last_stop_at', ddl: 'ALTER TABLE sessions ADD COLUMN last_stop_at TEXT' },
  { table: 'questions', column: 'draft', ddl: 'ALTER TABLE questions ADD COLUMN draft TEXT' },
  { table: 'questions', column: 'card_message_id', ddl: 'ALTER TABLE questions ADD COLUMN card_message_id TEXT' },
]

function ensureColumns(db: DatabaseSync): void {
  for (const need of REQUIRED_COLUMNS) {
    const cols = new Set(
      (db.prepare(`PRAGMA table_info(${need.table})`).all() as { name: string }[]).map((c) => c.name),
    )
    if (!cols.has(need.column)) {
      db.exec('BEGIN')
      try {
        db.exec(need.ddl)
        db.exec('COMMIT')
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
    }
  }
}

/**
 * 总线与能力层的表：**幂等创建、不推 user_version**。
 * 理由：迁移一旦推进版本，回滚到旧二进制会被 store.ts 的版本检查拒绝启动；
 * 这几张表对旧代码不可见，CREATE TABLE IF NOT EXISTS 是安全的最小改动。
 */
function ensureTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_log (
      seq       INTEGER PRIMARY KEY AUTOINCREMENT,
      id        TEXT NOT NULL UNIQUE,
      kind      TEXT NOT NULL,
      source    TEXT NOT NULL,
      subject   TEXT,
      at        TEXT NOT NULL,
      payload   TEXT NOT NULL,
      caused_by TEXT
    );
    CREATE INDEX IF NOT EXISTS event_log_kind_seq ON event_log(kind, seq);
    CREATE INDEX IF NOT EXISTS event_log_at ON event_log(at);

    CREATE TABLE IF NOT EXISTS subscriptions (
      subscriber TEXT NOT NULL,
      kind       TEXT NOT NULL,
      cursor     INTEGER NOT NULL DEFAULT 0,
      enabled    INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (subscriber, kind)
    );

    CREATE TABLE IF NOT EXISTS deliveries (
      subscriber TEXT NOT NULL,
      kind       TEXT NOT NULL,
      seq        INTEGER NOT NULL,
      status     TEXT NOT NULL,
      attempts   INTEGER NOT NULL DEFAULT 0,
      next_at    INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (subscriber, kind, seq)
    );
    CREATE INDEX IF NOT EXISTS deliveries_ready ON deliveries(subscriber, kind, status, next_at);

    CREATE TABLE IF NOT EXISTS capability_calls (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      at           TEXT NOT NULL,
      caller       TEXT NOT NULL,
      name         TEXT NOT NULL,
      effect       TEXT NOT NULL,
      status       TEXT NOT NULL,
      op_key       TEXT UNIQUE,
      input_digest TEXT NOT NULL,
      input_head   TEXT,
      outbox_id    INTEGER,
      result_head  TEXT,
      error        TEXT,
      duration_ms  INTEGER NOT NULL,
      caused_by    TEXT
    );
    CREATE INDEX IF NOT EXISTS capability_calls_name_at ON capability_calls(name, at);

    CREATE TABLE IF NOT EXISTS session_opens (
      request_id    TEXT PRIMARY KEY,
      payload       TEXT NOT NULL,
      mode          TEXT NOT NULL,
      status        TEXT NOT NULL,
      session_id    TEXT,
      error         TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS session_opens_status ON session_opens(status, created_at);

    CREATE TABLE IF NOT EXISTS session_turns (
      session_id TEXT PRIMARY KEY,
      turns      INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS confirmations (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_id INTEGER NOT NULL UNIQUE,
      caller     TEXT NOT NULL,
      name       TEXT NOT NULL,
      payload    TEXT NOT NULL,
      status     TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS confirmations_status ON confirmations(status, id);
  `)

  // 轻量列迁移：works 的 via 只用于区分 event/pipeline 开窗，旧库补列即可。
  const workCols = db.prepare('PRAGMA table_info(works)').all() as { name: string }[]
  if (!workCols.some((c) => c.name === 'via')) db.exec('ALTER TABLE works ADD COLUMN via TEXT')
}

export interface OpenOptions {
  /** 只读打开（桌面面板用）：不迁移、不恢复，避免和常驻进程抢写 */
  readOnly?: boolean
}

export class Store {
  readonly #db: DatabaseSync

  constructor(path: string, opts: OpenOptions = {}) {
    if (path !== ':memory:' && !opts.readOnly) mkdirSync(dirname(path), { recursive: true })
    this.#db = new DatabaseSync(path, opts.readOnly ? { readOnly: true } : {})
    if (!opts.readOnly) {
      migrate(this.#db)
      // 新表走幂等创建，不进 MIGRATIONS：旧二进制打开新库时 user_version 不变、能正常启动。
      ensureTables(this.#db)
    }
  }

  /**
   * 崩溃恢复：dispatched 未完成的**不自动重投**，标成 unknown 等人工对账。
   * 理由：claude --bg 不认预置会话 id、飞书无幂等键——重投会起第二个会话/重复发消息。
   * 只在常驻进程启动时调用。
   */
  recoverOutbox(): number {
    const r = this.#db.prepare(`UPDATE outbox SET status = 'unknown' WHERE status = 'dispatched'`).run()
    return Number(r.changes)
  }

  close(): void {
    this.#db.close()
  }

  /**
   * 幂等：同一 (source, externalId) 派生同一 id，重复投递返回 false。
   * 写入 `events` 与 `event_log` 在同一事务里：事件史只有一份，不会一边成功一边丢。
   */
  insertEvent(e: Event): boolean {
    this.#db.exec('BEGIN')
    try {
      const r = this.#db
        .prepare(
          `INSERT OR IGNORE INTO events
            (id, source, external_id, received_at, occurred_at, at_me, actor_id, actor_name,
             channel_kind, channel_id, channel_name, text, raw)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          e.id,
          e.source,
          e.externalId,
          e.receivedAt,
          e.occurredAt,
          e.atMe === undefined ? null : e.atMe ? 1 : 0,
          e.actor.id,
          e.actor.name ?? null,
          e.channel.kind,
          e.channel.id,
          e.channel.name ?? null,
          e.text,
          JSON.stringify(e.raw ?? null),
        )
      if (Number(r.changes) === 0) {
        this.#db.exec('COMMIT')
        return false
      }
      // payload 不含 raw：原始载荷留在 events，事件史只放回放需要的字段。
      const payload = { ...e, raw: undefined }
      this.#db
        .prepare(
          `INSERT OR IGNORE INTO event_log (id, kind, source, subject, at, payload)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(e.id, MESSAGE_RECEIVED, e.source, e.channel.id, e.receivedAt, JSON.stringify(payload))
      this.#db.exec('COMMIT')
      return true
    } catch (err) {
      this.#db.exec('ROLLBACK')
      throw err
    }
  }

  getEvent(id: string): Event | null {
    const row = this.#db.prepare('SELECT * FROM events WHERE id = ?').get(id) as EventRow | undefined
    if (!row) return null
    return {
      id: row.id,
      source: row.source,
      externalId: row.external_id,
      receivedAt: row.received_at,
      occurredAt: row.occurred_at,
      atMe: row.at_me === null ? undefined : row.at_me === 1,
      actor: { id: row.actor_id, name: row.actor_name ?? undefined },
      channel: {
        kind: row.channel_kind as Event['channel']['kind'],
        id: row.channel_id,
        name: row.channel_name ?? undefined,
      },
      text: row.text,
      raw: JSON.parse(row.raw) as unknown,
    }
  }

  findEventByExternalId(externalId: string): Event | null {
    const row = this.#db
      .prepare('SELECT id FROM events WHERE external_id = ? ORDER BY received_at DESC LIMIT 1')
      .get(externalId) as { id: string } | undefined
    return row ? this.getEvent(row.id) : null
  }

  /**
   * 中间层取同一会话的历史消息（不含 `before` 本身），按时间正序返回。
   * 平台事件库是跨渠道的；分析插件不需要知道钉钉/飞书的差异。
   */
  recentChannelMessages(channelId: string, before: string | undefined, limit: number): Event[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM events
         WHERE channel_id = ? AND (? IS NULL OR received_at < ?)
         ORDER BY received_at DESC LIMIT ?`,
      )
      .all(channelId, before ?? null, before ?? null, limit) as unknown as EventRow[]
    return rows.reverse().map((row) => ({
      id: row.id,
      source: row.source,
      externalId: row.external_id,
      receivedAt: row.received_at,
      occurredAt: row.occurred_at,
      atMe: row.at_me === null ? undefined : row.at_me === 1,
      actor: { id: row.actor_id, name: row.actor_name ?? undefined },
      channel: {
        kind: row.channel_kind as Event['channel']['kind'],
        id: row.channel_id,
        name: row.channel_name ?? undefined,
      },
      text: row.text,
      raw: JSON.parse(row.raw) as unknown,
    }))
  }

  /** 中间层补扫：还没有 message.analyzed 的最近消息（分析事件 id 固定为 analysis:<eventId>）。 */
  eventsWithoutAnalysis(limit: number, since: string): Event[] {
    const rows = this.#db
      .prepare(
        `SELECT e.* FROM events e
         WHERE e.received_at >= ?
           AND NOT EXISTS (
             SELECT 1 FROM event_log l WHERE l.id = 'analysis:' || e.id
           )
         ORDER BY e.received_at DESC LIMIT ?`,
      )
      .all(since, limit) as unknown as EventRow[]
    return rows.reverse().map((row) => ({
      id: row.id,
      source: row.source,
      externalId: row.external_id,
      receivedAt: row.received_at,
      occurredAt: row.occurred_at,
      atMe: row.at_me === null ? undefined : row.at_me === 1,
      actor: { id: row.actor_id, name: row.actor_name ?? undefined },
      channel: {
        kind: row.channel_kind as Event['channel']['kind'],
        id: row.channel_id,
        name: row.channel_name ?? undefined,
      },
      text: row.text,
      raw: JSON.parse(row.raw) as unknown,
    }))
  }

  /** 早于补扫窗口、仍没有分析事件的消息数；用于把静默缺口显式告警。 */
  countEventsWithoutAnalysis(beforeIso: string): number {
    const row = this.#db
      .prepare(
        `SELECT COUNT(*) AS n FROM events e
         WHERE e.received_at < ?
           AND NOT EXISTS (SELECT 1 FROM event_log l WHERE l.id = 'analysis:' || e.id)`,
      )
      .get(beforeIso) as { n: number }
    return Number(row.n)
  }

  /** 早于窗口的缺口，按时间正序取一批；用于受控 backfill。 */
  oldEventsWithoutAnalysis(beforeIso: string, limit: number): Event[] {
    const rows = this.#db
      .prepare(
        `SELECT e.* FROM events e
         WHERE e.received_at < ?
           AND NOT EXISTS (SELECT 1 FROM event_log l WHERE l.id = 'analysis:' || e.id)
         ORDER BY e.received_at ASC LIMIT ?`,
      )
      .all(beforeIso, limit) as unknown as EventRow[]
    return rows.map((row) => ({
      id: row.id,
      source: row.source,
      externalId: row.external_id,
      receivedAt: row.received_at,
      occurredAt: row.occurred_at,
      atMe: row.at_me === null ? undefined : row.at_me === 1,
      actor: { id: row.actor_id, name: row.actor_name ?? undefined },
      channel: {
        kind: row.channel_kind as Event['channel']['kind'],
        id: row.channel_id,
        name: row.channel_name ?? undefined,
      },
      text: row.text,
      raw: JSON.parse(row.raw) as unknown,
    }))
  }

  countEvents(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }
    return Number(row.n)
  }

  /** 同一 Event 重判时覆盖，不追加，避免一条消息留下多条判断。 */
  insertIntent(i: Intent): void {
    this.#db
      .prepare(
        `INSERT OR REPLACE INTO intents
          (event_id, kind, topic, project, suggested_action, rationale, confidence, by_rule, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        i.eventId,
        i.kind,
        i.topic,
        i.project ?? null,
        i.suggestedAction,
        i.rationale,
        i.confidence,
        i.byRule ?? null,
        now(),
      )
  }

  getIntent(eventId: string): Intent | null {
    const row = this.#db.prepare('SELECT * FROM intents WHERE event_id = ?').get(eventId) as
      | IntentRow
      | undefined
    if (!row) return null
    return {
      eventId: row.event_id,
      kind: row.kind as Intent['kind'],
      topic: row.topic,
      project: row.project ?? undefined,
      suggestedAction: row.suggested_action as Intent['suggestedAction'],
      rationale: row.rationale,
      confidence: row.confidence,
      byRule: row.by_rule ?? undefined,
    }
  }

  /** 同一 Work 重放不覆盖已有状态（INSERT OR IGNORE），避免把 running 打回 queued。 */
  insertWork(w: Work): boolean {
    const t = now()
    const r = this.#db
      .prepare(
        `INSERT OR IGNORE INTO works
          (id, intent_id, kind, via, project, executor, workspace, prompt, budget_usd, session_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        w.id,
        w.intentId,
        w.kind,
        w.via ?? null,
        w.project,
        w.executor,
        w.workspace,
        w.prompt,
        w.budgetUsd ?? null,
        w.sessionId ?? null,
        w.status,
        t,
        t,
      )
    return Number(r.changes) === 1
  }

  setWorkStatus(id: string, status: WorkStatus, sessionId?: string): void {
    this.#db
      .prepare(
        `UPDATE works SET status = ?, session_id = COALESCE(?, session_id), updated_at = ? WHERE id = ?`,
      )
      .run(status, sessionId ?? null, now(), id)
  }

  getWork(id: string): Work | null {
    const row = this.#db.prepare('SELECT * FROM works WHERE id = ?').get(id) as unknown as WorkRow | undefined
    return row ? toWork(row) : null
  }

  listWorksByStatus(status: WorkStatus): Work[] {
    const rows = this.#db.prepare('SELECT * FROM works WHERE status = ? ORDER BY created_at').all(status) as unknown as WorkRow[]
    return rows.map(toWork)
  }

  // ---- 会话（话题 ↔ 执行器会话 ↔ 工作区）----

  /** 开窗请求：只落请求，不碰执行器；执行器插件消费事件后回 opened/failed。 */
  insertSessionOpen(req: SessionOpenRequest, at = new Date().toISOString()): boolean {
    const r = this.#db
      .prepare(
        `INSERT OR IGNORE INTO session_opens
          (request_id, payload, mode, status, created_at, updated_at)
         VALUES (?, ?, ?, 'requested', ?, ?)`,
      )
      .run(req.requestId, JSON.stringify(req), req.mode, at, at)
    return r.changes > 0
  }

  getSessionOpen(requestId: string): SessionOpenRow | null {
    const row = this.#db.prepare('SELECT * FROM session_opens WHERE request_id = ?').get(requestId) as
      | {
          payload: string
          status: SessionOpenRow['status']
          session_id: string | null
          error: string | null
          created_at: string
          updated_at: string
        }
      | undefined
    if (!row) return null
    return {
      request: JSON.parse(row.payload) as SessionOpenRequest,
      status: row.status,
      sessionId: row.session_id ?? undefined,
      error: row.error ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  setSessionOpenStatus(
    requestId: string,
    status: SessionOpenRow['status'],
    extra: { sessionId?: string; error?: string } = {},
  ): void {
    this.#db
      .prepare(
        `UPDATE session_opens
            SET status = ?, session_id = COALESCE(?, session_id), error = COALESCE(?, error), updated_at = ?
          WHERE request_id = ?`,
      )
      .run(status, extra.sessionId ?? null, extra.error ?? null, new Date().toISOString(), requestId)
  }

  /** 已完成轮次：场景推进器据此做 maxRounds，不靠内存变量。 */
  bumpSessionTurn(sessionId: string): number {
    const t = new Date().toISOString()
    this.#db
      .prepare(
        `INSERT INTO session_turns (session_id, turns, updated_at) VALUES (?, 1, ?)
         ON CONFLICT(session_id) DO UPDATE SET turns = turns + 1, updated_at = excluded.updated_at`,
      )
      .run(sessionId, t)
    return this.getSessionTurns(sessionId)
  }

  getSessionTurns(sessionId: string): number {
    const row = this.#db.prepare('SELECT turns FROM session_turns WHERE session_id = ?').get(sessionId) as
      | { turns: number }
      | undefined
    return row?.turns ?? 0
  }

  insertSession(s: Session): boolean {
    const r = this.#db
      .prepare(
        `INSERT OR IGNORE INTO sessions
          (id, chat_id, source, thread_id, root_message_id, title, executor, workspace, session_id, status, created_at, last_active_at, owner_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        s.id,
        s.chatId,
        s.source ?? null,
        s.threadId ?? null,
        s.rootMessageId ?? null,
        s.title ?? null,
        s.executor,
        s.workspace,
        s.sessionId ?? null,
        s.status,
        s.createdAt,
        s.lastActiveAt,
        s.ownerId ?? null,
      )
    return Number(r.changes) === 1
  }

  getSession(id: string): Session | null {
    const row = this.#db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined
    return row ? toSession(row) : null
  }

  /**
   * 按话题找回会话。
   *
   * 飞书的话题 id 是 `omt_…`，而开窗时我们手里只有那条根消息的 `om_…`，
   * 两种 id 都可能落到这个字段上，所以两个列都要认；thread 命中优先于根消息命中。
   */
  findSessionByThread(chatId: string, threadId: string): Session | null {
    const row = this.#db
      .prepare(
        `SELECT * FROM sessions
          WHERE chat_id = ? AND (thread_id = ? OR root_message_id = ?)
          ORDER BY (thread_id = ?) DESC, last_active_at DESC
          LIMIT 1`,
      )
      .get(chatId, threadId, threadId, threadId) as SessionRow | undefined
    return row ? toSession(row) : null
  }

  /**
   * 按执行器侧会话 id 反查（钩子回传时是 claude 的全 uuid）。
   *
   * 入库的可能是 `claude --bg` 回的 8 位短 id，而钩子/注册表给的是全 uuid，
   * 所以两边互为前缀也要认；短于 6 位不参与前缀匹配，避免误撞。
   */
  findSessionByExecutor(executorSessionId: string): Session | null {
    const exact = this.#db
      .prepare('SELECT * FROM sessions WHERE session_id = ? ORDER BY last_active_at DESC')
      .get(executorSessionId) as SessionRow | undefined
    if (exact) return toSession(exact)
    if (executorSessionId.length < 6) return null
    const row = this.#db
      .prepare(
        `SELECT * FROM sessions
          WHERE session_id IS NOT NULL
            AND length(session_id) >= 6
            AND (session_id LIKE ? || '%' OR ? LIKE session_id || '%')
          ORDER BY last_active_at DESC
          LIMIT 1`,
      )
      .get(executorSessionId, executorSessionId) as SessionRow | undefined
    return row ? toSession(row) : null
  }

  listSessions(status?: Session['status']): Session[] {    const rows = (
      status === undefined
        ? this.#db.prepare('SELECT * FROM sessions ORDER BY last_active_at DESC').all()
        : this.#db.prepare('SELECT * FROM sessions WHERE status = ? ORDER BY last_active_at DESC').all(status)
    ) as unknown as SessionRow[]
    return rows.map(toSession)
  }

  /** 收到话题内消息：标记活跃，别的不动。 */
  touchSession(id: string): void {
    this.#db
      .prepare(`UPDATE sessions SET status = 'active', last_active_at = ? WHERE id = ?`)
      .run(now(), id)
  }

  /** 记下「这一轮结束了」以及最后一句正文（自动回复策略要用）。 */
  /** 记「这一轮的回复已经发过」（钩子发过的不再补发）。 */
  markReplied(sessionId: string, turnId: string): void {
    this.#db.prepare('UPDATE sessions SET last_replied_turn = ? WHERE id = ?').run(turnId, sessionId)
  }

  lastRepliedTurn(sessionId: string): string | null {
    const row = this.#db.prepare('SELECT last_replied_turn AS t FROM sessions WHERE id = ?').get(sessionId) as
      | { t?: string | null }
      | undefined
    return row?.t ?? null
  }

  markStopped(sessionId: string, text: string): void {
    this.#db
      .prepare('UPDATE sessions SET last_stop_at = ?, last_text = ?, last_active_at = ? WHERE id = ?')
      .run(now(), text, now(), sessionId)
  }

  /** 自动回复的冷却：同一窗口这个间隔内最多自动回一次。 */
  canAutoReply(sessionId: string, cooldownMs: number): boolean {
    const row = this.#db
      .prepare('SELECT auto_reply_at FROM sessions WHERE id = ?')
      .get(sessionId) as { auto_reply_at?: string | null } | undefined
    const last = row?.auto_reply_at
    if (!last) return true
    return Date.now() - Date.parse(last) >= cooldownMs
  }

  markAutoReplied(sessionId: string): void {
    this.#db.prepare('UPDATE sessions SET auto_reply_at = ? WHERE id = ?').run(now(), sessionId)
  }

  /** 自动回复要看的会话事实（不动 status，只读最后一轮）。 */
  sessionFacts(sessionId: string): {
    lastStopAt?: string
    lastText?: string
    lastActiveAt: string
  } | null {
    const row = this.#db
      .prepare('SELECT last_stop_at, last_text, last_active_at FROM sessions WHERE id = ?')
      .get(sessionId) as
      | { last_stop_at?: string | null; last_text?: string | null; last_active_at: string }
      | undefined
    if (!row) return null
    return {
      lastStopAt: row.last_stop_at ?? undefined,
      lastText: row.last_text ?? undefined,
      lastActiveAt: row.last_active_at,
    }
  }

  /** 锚消息发出去之后，把新话题的 thread_id 补绑到会话上。 */
  setSessionThread(id: string, threadId: string): void {
    this.#db.prepare('UPDATE sessions SET thread_id = ? WHERE id = ?').run(threadId, id)
  }

  /** 这条话题的根消息（= 话题 id）：之后进来的消息靠它路由回这个会话。 */
  setSessionRoot(id: string, rootMessageId: string): void {
    this.#db.prepare('UPDATE sessions SET root_message_id = ? WHERE id = ?').run(rootMessageId, id)
  }

  /** 换会话：同一个话题改绑到新的执行器会话（工作区随之更新） */
  /** 换会话标题（claude 自己起了名字之后用）。 */
  setSessionTitle(id: string, title: string): void {
    this.#db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(title, id)
  }

  rebindSession(id: string, executorSessionId: string, workspace: string): void {
    this.#db
      .prepare('UPDATE sessions SET session_id = ?, workspace = ?, status = ?, last_active_at = ? WHERE id = ?')
      .run(executorSessionId, workspace, 'active', now(), id)
  }

  setSessionStatus(id: string, status: Session['status'], sessionId?: string): void {
    this.#db
      .prepare(
        'UPDATE sessions SET status = ?, session_id = COALESCE(?, session_id), last_active_at = ? WHERE id = ?',
      )
      .run(status, sessionId ?? null, now(), id)
  }

  /** 记下「这条消息被投给了哪个会话」：回放时能区分直投与判断。 */
  setEventSession(eventId: string, sessionId: string): void {
    this.#db.prepare('UPDATE events SET session_id = ? WHERE id = ?').run(sessionId, eventId)
  }

  getEventSession(eventId: string): string | null {
    const row = this.#db.prepare('SELECT session_id FROM events WHERE id = ?').get(eventId) as
      | { session_id: string | null }
      | undefined
    return row?.session_id ?? null
  }

  /** 已发出、等人回复的选择（如「选哪个工作区」）；同一群同类只留最新一份。 */
  setChoice(chatId: string, kind: string, payload: unknown, ttlMs: number): void {
    const t = new Date()
    this.#db
      .prepare(
        `INSERT OR REPLACE INTO choices (chat_id, kind, payload, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(chatId, kind, JSON.stringify(payload), t.toISOString(), new Date(t.getTime() + ttlMs).toISOString())
  }

  getChoice(chatId: string, kind: string): unknown | null {
    const row = this.#db
      .prepare('SELECT payload, expires_at FROM choices WHERE chat_id = ? AND kind = ?')
      .get(chatId, kind) as { payload: string; expires_at: string } | undefined
    if (!row) return null
    if (row.expires_at <= new Date().toISOString()) {
      this.clearChoice(chatId, kind)
      return null
    }
    try {
      return JSON.parse(row.payload) as unknown
    } catch {
      return null
    }
  }

  clearChoice(chatId: string, kind: string): void {
    this.#db.prepare('DELETE FROM choices WHERE chat_id = ? AND kind = ?').run(chatId, kind)
  }

  // ---- 选择题（claude 的 AskUserQuestion 搬到话题里答）----

  insertQuestion(q: {
    id: string
    sessionId: string
    questions: unknown
    createdAt: string
    expiresAt: string
    kind?: PendingQuestion['kind']
  }): void {
    this.#db
      .prepare(
        `INSERT INTO questions (id, session_id, payload, answers, status, created_at, expires_at, kind)
         VALUES (?, ?, ?, '{}', 'pending', ?, ?, ?)`,
      )
      .run(q.id, q.sessionId, JSON.stringify(q.questions), q.createdAt, q.expiresAt, q.kind ?? 'question')
  }

  /** 取这个会话里最新一道还没答的题（一次只答一道，避免序号对不上）。 */
  getPendingQuestion(sessionId: string): PendingQuestion | null {
    const row = this.#db
      .prepare(
        `SELECT id, session_id, payload, answers, expires_at, kind FROM questions
          WHERE session_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1`,
      )
      .get(sessionId) as
      | { id: string; session_id: string; payload: string; answers: string; expires_at: string; kind: string }
      | undefined
    if (!row) return null
    if (row.expires_at <= new Date().toISOString()) {
      this.#db.prepare(`UPDATE questions SET status = 'timeout' WHERE id = ?`).run(row.id)
      return null
    }
    return {
      id: row.id,
      sessionId: row.session_id,
      kind: row.kind as PendingQuestion['kind'],
      questions: JSON.parse(row.payload) as PendingQuestion['questions'],
      answers: JSON.parse(row.answers) as Record<string, string>,
      expiresAt: row.expires_at,
    }
  }

  answerQuestion(id: string, answers: Record<string, string>): void {
    this.#db
      .prepare(`UPDATE questions SET answers = ?, status = 'answered' WHERE id = ?`)
      .run(JSON.stringify(answers), id)
  }

  /** 这个会话有没有「刚推出去的待答提问」（用于提醒卡去重：ask/permission 已经推过卡就别再喊）。 */
  hasFreshPendingQuestion(sessionId: string, withinMs: number): boolean {
    const row = this.#db
      .prepare(
        `SELECT created_at FROM questions
          WHERE session_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1`,
      )
      .get(sessionId) as { created_at: string } | undefined
    if (!row) return false
    return Date.now() - Date.parse(row.created_at) < withinMs
  }

  /** 提问的当前状态：pending / answered / timeout / hands（人点了「我在电脑前」） */
  /** 题卡发出去时的消息 id（之后原地刷新勾选态 / 回执用）。 */
  setQuestionCard(id: string, messageId: string): void {
    this.#db.prepare('UPDATE questions SET card_message_id = ? WHERE id = ?').run(messageId, id)
  }

  questionCard(id: string): string | undefined {
    const row = this.#db.prepare('SELECT card_message_id FROM questions WHERE id = ?').get(id) as
      | { card_message_id?: string | null }
      | undefined
    return row?.card_message_id ?? undefined
  }

  /** 多选题的草稿：点按钮先攒着，点「就这些」才提交。 */
  setDraft(id: string, draft: Record<string, string[]>): void {
    this.#db.prepare(`UPDATE questions SET draft = ? WHERE id = ?`).run(JSON.stringify(draft), id)
  }

  getDraft(id: string): Record<string, string[]> {
    const row = this.#db.prepare('SELECT draft FROM questions WHERE id = ?').get(id) as
      | { draft?: string | null }
      | undefined
    if (!row?.draft) return {}
    try {
      return JSON.parse(row.draft) as Record<string, string[]>
    } catch {
      return {}
    }
  }

  questionStatus(id: string): string | undefined {
    const row = this.#db.prepare('SELECT status FROM questions WHERE id = ?').get(id) as
      | { status?: string }
      | undefined
    return row?.status
  }

  /** 人点了「我在电脑前，让终端问我」：取消这条待答记录。 */
  /** 交还终端：默认记 'hands'（人点了按钮）；等太久就记 'timeout'，两者文案不同。 */
  handBackQuestion(id: string, reason: 'hands' | 'timeout' = 'hands'): void {
    this.#db
      .prepare(`UPDATE questions SET status = ? WHERE id = ? AND status = 'pending'`)
      .run(reason, id)
  }

  getQuestion(id: string): PendingQuestion | null {
    const row = this.#db
      .prepare('SELECT id, session_id, payload, answers, expires_at, kind FROM questions WHERE id = ?')
      .get(id) as
      | { id: string; session_id: string; payload: string; answers: string; expires_at: string; kind: string }
      | undefined
    if (!row) return null
    return {
      id: row.id,
      sessionId: row.session_id,
      kind: row.kind as PendingQuestion['kind'],
      questions: JSON.parse(row.payload) as PendingQuestion['questions'],
      answers: JSON.parse(row.answers) as Record<string, string>,
      expiresAt: row.expires_at,
    }
  }

  /**
   * 自动回复的冷却：同一会话同一类回执，冷却窗口内只回一次。
   * 落库是为了重启不丢——连点两下不该回两遍。
   */
  allowReply(sessionId: string, kind: string, cooldownMs: number, nowMs = Date.now()): boolean {
    const row = this.#db
      .prepare('SELECT last_at FROM replies WHERE session_id = ? AND kind = ?')
      .get(sessionId, kind) as { last_at: string } | undefined
    if (row && nowMs - Date.parse(row.last_at) < cooldownMs) return false
    this.#db
      .prepare(
        `INSERT INTO replies (session_id, kind, last_at) VALUES (?, ?, ?)
         ON CONFLICT(session_id, kind) DO UPDATE SET last_at = excluded.last_at`,
      )
      .run(sessionId, kind, new Date(nowMs).toISOString())
    return true
  }

  /** 记下「这条消息属于哪个会话」：用户引用它就能路由回来。 */
  mapMessage(messageId: string, sessionId: string, chatId: string): void {
    this.#db
      .prepare('INSERT OR REPLACE INTO message_map (message_id, session_id, chat_id, created_at) VALUES (?, ?, ?, ?)')
      .run(messageId, sessionId, chatId, now())
  }

  /** 按被引用的消息 id 找回会话。 */
  sessionByMessage(messageId: string): Session | null {
    const row = this.#db
      .prepare('SELECT session_id FROM message_map WHERE message_id = ?')
      .get(messageId) as { session_id: string } | undefined
    return row ? this.getSession(row.session_id) : null
  }

  /** 单聊回退：这个会话最近 `withinMs` 内有过收发就返回它。 */
  recentSession(chatId: string, withinMs: number): Session | null {
    const row = this.#db
      .prepare(
        `SELECT * FROM sessions WHERE chat_id = ? AND status = 'active'
           AND last_active_at >= ? ORDER BY last_active_at DESC LIMIT 1`,
      )
      .get(chatId, new Date(Date.now() - withinMs).toISOString()) as SessionRow | undefined
    return row ? toSession(row) : null
  }

  /** 清掉超时未答的提问（hook 答完本会自己删，这里兜底超时与被取消的）。 */
  pruneQuestions(olderThanMs: number): number {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString()
    return Number(this.#db.prepare("DELETE FROM questions WHERE created_at < ? AND status != 'answered'").run(cutoff).changes)
  }

  /** 清理过期的消息映射（参考项目 mappingTtlDays）。 */
  pruneMessageMap(olderThanMs: number): number {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString()
    return Number(this.#db.prepare('DELETE FROM message_map WHERE created_at < ?').run(cutoff).changes)
  }

  /**
   * 「这张卡对应的是哪一轮」。单独存一张表而不是挂在 cards 上——
   * 换卡时要先删 cards 记录，挂在上面的话记下的轮次会跟着一起没了。
   */
  setCardTurn(sessionId: string, userId: string): void {
    this.#db
      .prepare(
        `INSERT INTO card_turns (session_id, turn_id) VALUES (?, ?)
         ON CONFLICT(session_id) DO UPDATE SET turn_id = excluded.turn_id`,
      )
      .run(sessionId, userId)
  }

  cardTurn(sessionId: string): string | undefined {
    const row = this.#db
      .prepare('SELECT turn_id FROM card_turns WHERE session_id = ?')
      .get(sessionId) as { turn_id?: string | null } | undefined
    return row?.turn_id ?? undefined
  }

  /** 删掉卡记录：下一次 upsert 会重新发一张（换卡）。 */
  dropCard(sessionId: string): void {
    this.#db.prepare('DELETE FROM cards WHERE session_id = ?').run(sessionId)
  }

  /** 取走旧卡记录（换卡时用：要拿它的 messageId 去把旧卡改灰）。 */
  takeCard(sessionId: string): { messageId: string; chatId: string } | null {
    const row = this.#db
      .prepare('SELECT message_id, chat_id FROM cards WHERE session_id = ?')
      .get(sessionId) as { message_id: string; chat_id: string } | undefined
    if (!row) return null
    this.dropCard(sessionId)
    return { messageId: row.message_id, chatId: row.chat_id }
  }

  /** 状态卡：一个会话一张，记下 message_id 与上次内容签名（签名没变就不重发）。 */
  getCard(sessionId: string): { messageId: string; chatId: string; signature: string } | null {
    const row = this.#db
      .prepare('SELECT message_id, chat_id, signature FROM cards WHERE session_id = ?')
      .get(sessionId) as { message_id: string; chat_id: string; signature: string } | undefined
    return row ? { messageId: row.message_id, chatId: row.chat_id, signature: row.signature } : null
  }

  /** 只记「这张卡是我们自己置顶的」——取消置顶时才敢动它。 */
  /** 记置顶状态。`at` 用于补记/测试回溯（判定「刚置上多久」要它）。 */
  setCardPinned(sessionId: string, pinned: boolean, at: Date = new Date()): void {
    this.#db
      .prepare('UPDATE cards SET pinned = ?, pinned_at = ? WHERE session_id = ?')
      .run(pinned ? 1 : 0, at.toISOString(), sessionId)
  }

  /** 置顶多久了（毫秒）；没置顶或没记录返回 undefined。 */
  cardPinnedAge(sessionId: string): number | undefined {
    const row = this.#db.prepare('SELECT pinned_at FROM cards WHERE session_id = ?').get(sessionId) as
      | { pinned_at?: string | null }
      | undefined
    if (!row?.pinned_at) return undefined
    return Date.now() - Date.parse(row.pinned_at)
  }

  isCardPinned(sessionId: string): boolean {
    const row = this.#db.prepare('SELECT pinned FROM cards WHERE session_id = ?').get(sessionId) as
      | { pinned: number }
      | undefined
    return row?.pinned === 1
  }

  /**
   * 记下「这条消息是我们置顶的」。
   *
   * 发卡时频道会顺手置顶，但那张卡未必是状态卡（比如「窗口已创建」就绪卡），
   * cards 表里没有它的行——只 UPDATE 会静默 0 行，置顶就永远撤不掉。
   * 所以这里没有行就补一行占位（signature='__pin_only__'），状态卡刷新时会把占位当「还没有状态卡」。
   */
  markPinned(sessionId: string, chatId: string, messageId: string, at: Date = new Date()): void {
    const existing = this.#db.prepare('SELECT message_id FROM cards WHERE session_id = ?').get(sessionId) as
      | { message_id: string }
      | undefined
    if (!existing) {
      this.#db
        .prepare(
          `INSERT INTO cards (session_id, chat_id, message_id, signature, updated_at, pinned, pinned_at)
           VALUES (?, ?, ?, '__pin_only__', ?, 1, ?)`,
        )
        .run(sessionId, chatId, messageId, at.toISOString(), at.toISOString())
      return
    }
    this.setCardPinned(sessionId, true, at)
  }

  upsertCard(sessionId: string, chatId: string, messageId: string, signature: string): void {
    this.#db
      .prepare(
        `INSERT INTO cards (session_id, chat_id, message_id, signature, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           message_id = excluded.message_id,
           signature  = excluded.signature,
           updated_at = excluded.updated_at`,
      )
      .run(sessionId, chatId, messageId, signature, new Date().toISOString())
  }

  /** 返回 'duplicate' 表示该 dedupeKey 已在队列里，不会再发一次。 */
  /**
   * 入队。可选 `notBefore`（毫秒时间戳）：到点前不出队——飞书对同一用户有 5 QPS，
   * 长回复分段连发时按 1 秒一段排开，别一口气全打出去。
   */
  enqueue(
    a: Action,
    dedupeKey: string,
    opts: { notBefore?: number; eventId?: string } = {},
  ): 'enqueued' | 'duplicate' {
    const t = now()
    const r = this.#db
      .prepare(
        `INSERT OR IGNORE INTO outbox (dedupe_key, action, status, attempts, created_at, updated_at, not_before, event_id)
         VALUES (?, ?, 'pending', 0, ?, ?, ?, ?)`,
      )
      .run(dedupeKey, JSON.stringify(a), t, t, opts.notBefore ?? 0, opts.eventId ?? null)
    return Number(r.changes) === 1 ? 'enqueued' : 'duplicate'
  }

  pendingOutbox(limit: number): OutboxRow[] {
    const rows = this.#db
      .prepare(
        `SELECT id, dedupe_key, action, status, attempts FROM outbox
          WHERE status = 'pending' AND (not_before IS NULL OR not_before = 0 OR not_before <= ?)
          ORDER BY
            -- 回复类先走：用户最在意「话说完了没有」。每张状态卡要 4 秒左右，
            -- 排在回复前面时，一条回复得等十几秒（2026-11-06 实测）。
            CASE
              WHEN action LIKE '%"kind":"card_send"%' THEN 0
              WHEN action LIKE '%"kind":"dm_send"%' THEN 0
              WHEN action LIKE '%"kind":"card_retire"%' THEN 1
              WHEN action LIKE '%"kind":"post_message"%' THEN 1
              WHEN action LIKE '%"kind":"card_upsert"%' THEN 2
              ELSE 1
            END,
            id
          LIMIT ?`,
      )
      .all(Date.now(), limit) as unknown as OutboxDbRow[]
    return rows.map((r) => ({
      id: r.id,
      dedupeKey: r.dedupe_key,
      action: JSON.parse(r.action) as Action,
      status: r.status as OutboxStatus,
      attempts: r.attempts,
    }))
  }

  markOutbox(id: number, status: OutboxStatus, attempts: number, lastError?: string): void {
    this.#db
      .prepare('UPDATE outbox SET status = ?, attempts = ?, last_error = ?, updated_at = ? WHERE id = ?')
      .run(status, attempts, lastError ?? null, now(), id)
  }

  /** 人工重放死信：只允许 dead，清空错误和重试计数。 */
  retryDeadOutbox(id: number): boolean {
    const r = this.#db
      .prepare(
        `UPDATE outbox
         SET status = 'pending', attempts = 0, last_error = NULL, not_before = 0, updated_at = ?
         WHERE id = ? AND status = 'dead'`,
      )
      .run(now(), id)
    return Number(r.changes) === 1
  }

  countOutbox(status: OutboxStatus): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE status = ?').get(status) as {
      n: number
    }
    return Number(row.n)
  }

  /** 发件箱里排队的动作（测试与面板要看「到底排了什么」）。 */
  listOutbox(
    status: OutboxStatus,
    limit = 50,
  ): { id: number; dedupeKey: string; action: Action; lastError?: string }[] {
    const rows = this.#db
      .prepare('SELECT id, dedupe_key, action, last_error FROM outbox WHERE status = ? ORDER BY id LIMIT ?')
      .all(status, limit) as unknown as (OutboxDbRow & { last_error?: string })[]
    return rows.map((r) => ({
      id: r.id,
      dedupeKey: r.dedupe_key,
      action: JSON.parse(r.action) as Action,
      lastError: r.last_error ?? undefined,
    }))
  }

  /** 收据与发件箱行的关联：提交后用 dedupe key 找回 outbox id。 */
  outboxIdByDedupeKey(dedupeKey: string): number | null {
    const row = this.#db.prepare('SELECT id FROM outbox WHERE dedupe_key = ?').get(dedupeKey) as
      | { id: number }
      | undefined
    return row ? Number(row.id) : null
  }

  countIntents(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM intents').get() as { n: number }
    return Number(row.n)
  }

  countWorks(): Record<WorkStatus, number> {
    const rows = this.#db.prepare('SELECT status, COUNT(*) AS n FROM works GROUP BY status').all() as unknown as {
      status: string
      n: number
    }[]
    const out: Record<WorkStatus, number> = {
      queued: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
    }
    for (const r of rows) out[r.status as WorkStatus] = Number(r.n)
    return out
  }

  /** 桌面面板用：最近若干条事件（含判断）。 */
  recentEvents(limit: number): {
    id: string
    source: string
    text: string
    receivedAt: string
    actorId: string
    actorName?: string
    channelKind: string
    channelId: string
    channelName?: string
    kind?: string
    project?: string
  }[] {
    const rows = this.#db
      .prepare(
        `SELECT e.id, e.source, e.text, e.received_at,
                e.actor_id, e.actor_name, e.channel_kind, e.channel_id, e.channel_name,
                i.kind, i.project
         FROM events e LEFT JOIN intents i ON i.event_id = e.id
         ORDER BY e.received_at DESC LIMIT ?`,
      )
      .all(limit) as unknown as {
      id: string
      source: string
      text: string
      received_at: string
      actor_id: string
      actor_name: string | null
      channel_kind: string
      channel_id: string
      channel_name: string | null
      kind: string | null
      project: string | null
    }[]
    return rows.map((r) => ({
      id: r.id,
      source: r.source,
      text: r.text,
      receivedAt: r.received_at,
      actorId: r.actor_id,
      actorName: r.actor_name ?? undefined,
      channelKind: r.channel_kind,
      channelId: r.channel_id,
      channelName: r.channel_name ?? undefined,
      kind: r.kind ?? undefined,
      project: r.project ?? undefined,
    }))
  }

  // ---- 事件日志（event_log）：唯一事件史 -------------------------------------------------

  /** 幂等追加；同 id 返回已有 seq 且 duplicate=true。消息事件的 id 与 events.id 相同。 */
  appendEventLog(e: {
    id: string
    kind: string
    source: string
    subject?: string
    at: string
    payload: unknown
    causedBy?: string
  }): { seq: number; duplicate: boolean } {
    const r = this.#db
      .prepare(
        `INSERT OR IGNORE INTO event_log (id, kind, source, subject, at, payload, caused_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(e.id, e.kind, e.source, e.subject ?? null, e.at, JSON.stringify(e.payload ?? null), e.causedBy ?? null)
    if (Number(r.changes) === 1) return { seq: Number(r.lastInsertRowid), duplicate: false }
    const row = this.#db.prepare('SELECT seq FROM event_log WHERE id = ?').get(e.id) as
      | { seq: number }
      | undefined
    if (!row) throw new Error(`事件日志写入失败：${e.id}`)
    return { seq: Number(row.seq), duplicate: true }
  }

  eventLogMaxSeq(): number {
    const row = this.#db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM event_log').get() as { n: number }
    return Number(row.n)
  }

  /** 按 kind 取 seq 之后的事件，按 seq 升序。 */
  eventLogAfter(kind: string, afterSeq: number, limit: number): BusEvent[] {
    const rows = this.#db
      .prepare(
        `SELECT seq, id, kind, source, subject, at, payload, caused_by
         FROM event_log WHERE kind = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
      )
      .all(kind, afterSeq, limit) as unknown as EventLogRow[]
    return rows.map((r) => this.#toBusEvent(r))
  }

  queryEventLog(fromIso: string, toIso: string, limit: number): BusEvent[] {
    const rows = this.#db
      .prepare(
        `SELECT seq, id, kind, source, subject, at, payload, caused_by
         FROM event_log WHERE at >= ? AND at <= ? ORDER BY seq DESC LIMIT ?`,
      )
      .all(fromIso, toIso, limit) as unknown as EventLogRow[]
    return rows.map((r) => this.#toBusEvent(r))
  }

  getEventLog(id: string): BusEvent | null {
    const row = this.#db
      .prepare(
        `SELECT seq, id, kind, source, subject, at, payload, caused_by FROM event_log WHERE id = ?`,
      )
      .get(id) as EventLogRow | undefined
    return row ? this.#toBusEvent(row) : null
  }

  /** 一条消息的全链路：原始事件、分析、分发决策、出口发件箱。 */
  traceMessage(eventId: string): {
    event: Event | null
    intent: Intent | null
    sessions: Session[]
    works: Work[]
    outcomes: BusEvent[]
    events: BusEvent[]
    outbox: {
      id: number
      dedupeKey: string
      status: string
      attempts: number
      action: unknown
      lastError?: string
    }[]
  } {
    const event = this.getEvent(eventId)
    const rootIds = [eventId, event?.externalId, event?.rootId].filter((x): x is string => Boolean(x))
    const placeholders = rootIds.map(() => '?').join(',')
    const sessionRows = rootIds.length
      ? (this.#db
          .prepare(`SELECT * FROM sessions WHERE root_message_id IN (${placeholders}) ORDER BY last_active_at DESC`)
          .all(...rootIds) as unknown as SessionRow[])
      : []
    const sessionIds = sessionRows.map((s) => s.id)
    const outcomeRows = sessionIds.length
      ? (this.#db
          .prepare(
            `SELECT seq, id, kind, source, subject, at, payload, caused_by FROM event_log
             WHERE kind = 'session.turn.ended'
               AND (${sessionIds.map(() => 'payload LIKE ?').join(' OR ')})
             ORDER BY seq ASC`,
          )
          .all(...sessionIds.map((id) => `%${id}%`)) as unknown as EventLogRow[])
      : []
    const workRows = this.#db
      .prepare('SELECT * FROM works WHERE intent_id = ? ORDER BY created_at ASC')
      .all(eventId) as unknown as WorkRow[]
    const logRows = this.#db
      .prepare(
        `SELECT seq, id, kind, source, subject, at, payload, caused_by FROM event_log
         WHERE id = ? OR id LIKE ? OR id LIKE ?
         ORDER BY seq ASC`,
      )
      .all(eventId, `analysis:${eventId}%`, `distribution:${eventId}%`) as unknown as EventLogRow[]
    const outboxRows = this.#db
      .prepare(
        `SELECT id, dedupe_key, action, status, attempts, last_error FROM outbox
         WHERE event_id = ? OR dedupe_key = ? OR dedupe_key LIKE ? OR action LIKE ?
         ORDER BY id ASC`,
      )
      .all(eventId, `dingtalk-relay:${eventId}`, `%${eventId}`, `%${eventId}%`) as unknown as {
      id: number
      dedupe_key: string
      action: string
      status: string
      attempts: number
      last_error: string | null
    }[]
    return {
      event,
      intent: this.getIntent(eventId),
      sessions: sessionRows.map(toSession),
      works: workRows.map(toWork),
      outcomes: outcomeRows.map((r) => this.#toBusEvent(r)),
      events: logRows.map((r) => this.#toBusEvent(r)),
      outbox: outboxRows.map((r) => ({
        id: r.id,
        dedupeKey: r.dedupe_key,
        status: r.status,
        attempts: r.attempts,
        action: JSON.parse(r.action) as unknown,
        lastError: r.last_error ?? undefined,
      })),
    }
  }

  /** 最近窗口内每条消息的最新一次分析；只返回仍然 degraded 的，供重试扫描。 */
  degradedAnalyses(
    sinceIso: string,
    limit = 20,
  ): { event: Event; analysis: MessageAnalysis; analysisEventId: string }[] {
    const rows = this.#db
      .prepare(
        `SELECT seq, id, payload FROM event_log
         WHERE kind = 'message.analyzed' AND at >= ?
         ORDER BY seq DESC
         LIMIT 500`,
      )
      .all(sinceIso) as unknown as { seq: number; id: string; payload: string }[]
    const latest = new Map<string, { event: Event; analysis: MessageAnalysis; analysisEventId: string }>()
    for (const row of rows) {
      const payload = JSON.parse(row.payload) as { event?: Event; analysis?: MessageAnalysis }
      if (!payload.event || !payload.analysis) continue
      if (!latest.has(payload.event.id)) {
        latest.set(payload.event.id, {
          event: payload.event,
          analysis: payload.analysis,
          analysisEventId: row.id,
        })
      }
    }
    return [...latest.values()].filter((x) => x.analysis.status === 'degraded').slice(0, limit)
  }

  /** 单条消息的最新分析（含重试），供最近事件列表展示状态。 */
  latestAnalysis(eventId: string): MessageAnalysis | null {
    const row = this.#db
      .prepare(
        `SELECT payload FROM event_log
         WHERE kind = 'message.analyzed' AND (id = ? OR id LIKE ?)
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(`analysis:${eventId}`, `analysis:${eventId}:%`) as { payload: string } | undefined
    if (!row) return null
    const payload = JSON.parse(row.payload) as { analysis?: MessageAnalysis }
    return payload.analysis ?? null
  }

  getEventLogAt(kind: string, seq: number): BusEvent | null {
    const row = this.#db
      .prepare(
        `SELECT seq, id, kind, source, subject, at, payload, caused_by
         FROM event_log WHERE kind = ? AND seq = ?`,
      )
      .get(kind, seq) as EventLogRow | undefined
    return row ? this.#toBusEvent(row) : null
  }

  advanceSubscription(subscriber: string, kind: string, seq: number): void {
    this.#db
      .prepare(`UPDATE subscriptions SET cursor = MAX(cursor, ?), updated_at = ? WHERE subscriber = ? AND kind = ?`)
      .run(seq, now(), subscriber, kind)
  }

  countEventLog(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM event_log').get() as { n: number }
    return Number(row.n)
  }

  countAnalysis(status: 'ok' | 'degraded', sinceIso: string): number {
    const row = this.#db
      .prepare(
        `SELECT COUNT(*) AS n FROM event_log
         WHERE kind = 'message.analyzed' AND at >= ? AND payload LIKE ?`,
      )
      .get(sinceIso, `%"status":"${status}"%`) as { n: number }
    return Number(row.n)
  }

  #toBusEvent(r: EventLogRow): BusEvent {
    return {
      seq: Number(r.seq),
      id: r.id,
      kind: r.kind,
      source: r.source,
      subject: r.subject ?? undefined,
      at: r.at,
      payload: JSON.parse(r.payload) as unknown,
      causedBy: r.caused_by ?? undefined,
    }
  }

  // ---- 订阅与投递 ------------------------------------------------------------------------

  ensureSubscription(subscriber: string, kind: string, sinceSeq: number): void {
    this.#db
      .prepare(
        `INSERT OR IGNORE INTO subscriptions (subscriber, kind, cursor, enabled, updated_at)
         VALUES (?, ?, ?, 1, ?)`,
      )
      .run(subscriber, kind, sinceSeq, now())
  }

  /** 卸载订阅：删该 subscriber 的全部订阅行（游标随之消失），返回删除条数。事件史与投递行不动。 */
  deleteSubscriptions(subscriber: string): number {
    const r = this.#db.prepare('DELETE FROM subscriptions WHERE subscriber = ?').run(subscriber)
    return Number(r.changes)
  }

  getSubscription(subscriber: string, kind: string): SubscriptionRow | null {
    const row = this.#db
      .prepare(
        `SELECT subscriber, kind, cursor, enabled, updated_at FROM subscriptions
         WHERE subscriber = ? AND kind = ?`,
      )
      .get(subscriber, kind) as
      | { subscriber: string; kind: string; cursor: number; enabled: number; updated_at: string }
      | undefined
    if (!row) return null
    return {
      subscriber: row.subscriber,
      kind: row.kind,
      cursor: Number(row.cursor),
      enabled: Number(row.enabled),
      updatedAt: row.updated_at,
    }
  }

  listSubscriptions(): SubscriptionRow[] {
    const rows = this.#db
      .prepare(
        `SELECT subscriber, kind, cursor, enabled, updated_at FROM subscriptions
         ORDER BY subscriber, kind`,
      )
      .all() as unknown as {
      subscriber: string
      kind: string
      cursor: number
      enabled: number
      updated_at: string
    }[]
    return rows.map((r) => ({
      subscriber: r.subscriber,
      kind: r.kind,
      cursor: Number(r.cursor),
      enabled: Number(r.enabled),
      updatedAt: r.updated_at,
    }))
  }

  setSubscriptionEnabled(subscriber: string, kind: string, enabled: boolean): void {
    this.#db
      .prepare(`UPDATE subscriptions SET enabled = ?, updated_at = ? WHERE subscriber = ? AND kind = ?`)
      .run(enabled ? 1 : 0, now(), subscriber, kind)
  }

  /** 最小游标；没有启用中的订阅时返回 null。 */
  minSubscriptionCursor(): number | null {
    const row = this.#db
      .prepare('SELECT MIN(cursor) AS c FROM subscriptions WHERE enabled = 1')
      .get() as { c: number | null }
    return row.c === null ? null : Number(row.c)
  }

  getDelivery(subscriber: string, kind: string, seq: number): DeliveryRow | null {
    const row = this.#db
      .prepare(
        `SELECT subscriber, kind, seq, status, attempts, next_at, last_error FROM deliveries
         WHERE subscriber = ? AND kind = ? AND seq = ?`,
      )
      .get(subscriber, kind, seq) as DeliveryDbRow | undefined
    return row ? this.#toDelivery(row) : null
  }

  /** 该流最早一条未决投递（pending，含未到退避点的）；没有返回 null。 */
  pendingDelivery(subscriber: string, kind: string): DeliveryRow | null {
    const row = this.#db
      .prepare(
        `SELECT subscriber, kind, seq, status, attempts, next_at, last_error FROM deliveries
         WHERE subscriber = ? AND kind = ? AND status = 'pending'
         ORDER BY seq ASC LIMIT 1`,
      )
      .get(subscriber, kind) as DeliveryDbRow | undefined
    return row ? this.#toDelivery(row) : null
  }

  #toDelivery(r: DeliveryDbRow): DeliveryRow {
    return {
      subscriber: r.subscriber,
      kind: r.kind,
      seq: Number(r.seq),
      status: r.status as DeliveryRow['status'],
      attempts: Number(r.attempts),
      nextAt: Number(r.next_at),
      lastError: r.last_error,
    }
  }

  /** 投递前先记 dispatched（崩在这中间时恢复会打回 pending，宁可重投）。 */
  markDeliveryDispatched(subscriber: string, kind: string, seq: number, attempts: number): void {
    this.#db
      .prepare(
        `INSERT INTO deliveries (subscriber, kind, seq, status, attempts, next_at, last_error, updated_at)
         VALUES (?, ?, ?, 'dispatched', ?, 0, NULL, ?)
         ON CONFLICT(subscriber, kind, seq) DO UPDATE SET
           status = 'dispatched', attempts = excluded.attempts, updated_at = excluded.updated_at`,
      )
      .run(subscriber, kind, seq, attempts, now())
  }

  /** 成功：删投递行 + 推进游标，同一事务。 */
  completeDelivery(subscriber: string, kind: string, seq: number): void {
    this.#db.exec('BEGIN')
    try {
      this.#db
        .prepare(`DELETE FROM deliveries WHERE subscriber = ? AND kind = ? AND seq = ?`)
        .run(subscriber, kind, seq)
      this.#db
        .prepare(`UPDATE subscriptions SET cursor = MAX(cursor, ?), updated_at = ? WHERE subscriber = ? AND kind = ?`)
        .run(seq, now(), subscriber, kind)
      this.#db.exec('COMMIT')
    } catch (err) {
      this.#db.exec('ROLLBACK')
      throw err
    }
  }

  retryDelivery(
    subscriber: string,
    kind: string,
    seq: number,
    attempts: number,
    nextAt: number,
    error: string,
  ): void {
    this.#db
      .prepare(
        `INSERT INTO deliveries (subscriber, kind, seq, status, attempts, next_at, last_error, updated_at)
         VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)
         ON CONFLICT(subscriber, kind, seq) DO UPDATE SET
           status = 'pending', attempts = excluded.attempts, next_at = excluded.next_at,
           last_error = excluded.last_error, updated_at = excluded.updated_at`,
      )
      .run(subscriber, kind, seq, attempts, nextAt, error, now())
  }

  /** 死信：保留行 + 推进游标（毒事件不卡后续）。 */
  deadDelivery(subscriber: string, kind: string, seq: number, attempts: number, error: string): void {
    this.#db.exec('BEGIN')
    try {
      this.#db
        .prepare(
          `INSERT INTO deliveries (subscriber, kind, seq, status, attempts, next_at, last_error, updated_at)
           VALUES (?, ?, ?, 'dead', ?, 0, ?, ?)
           ON CONFLICT(subscriber, kind, seq) DO UPDATE SET
             status = 'dead', attempts = excluded.attempts, next_at = 0,
             last_error = excluded.last_error, updated_at = excluded.updated_at`,
        )
        .run(subscriber, kind, seq, attempts, error, now())
      this.#db
        .prepare(`UPDATE subscriptions SET cursor = MAX(cursor, ?), updated_at = ? WHERE subscriber = ? AND kind = ?`)
        .run(seq, now(), subscriber, kind)
      this.#db.exec('COMMIT')
    } catch (err) {
      this.#db.exec('ROLLBACK')
      throw err
    }
  }

  /** 崩溃恢复：dispatched 未完成的回到 pending（attempts 不归零）。 */
  recoverDeliveries(): number {
    const r = this.#db.prepare(`UPDATE deliveries SET status = 'pending' WHERE status = 'dispatched'`).run()
    return Number(r.changes)
  }

  countDeliveries(status?: DeliveryRow['status']): number {
    const row = status
      ? (this.#db.prepare('SELECT COUNT(*) AS n FROM deliveries WHERE status = ?').get(status) as { n: number })
      : (this.#db.prepare('SELECT COUNT(*) AS n FROM deliveries').get() as { n: number })
    return Number(row.n)
  }

  /** 清理事件史：TTL 之外、最小游标之前、且没有未决投递的事件；死信按 TTL 清。 */
  pruneEventLog(eventCutoffIso: string, deadCutoffIso: string): { events: number; deliveries: number } {
    const min = this.minSubscriptionCursor()
    const e = this.#db
      .prepare(
        `DELETE FROM event_log
         WHERE at < ? AND (? IS NULL OR seq <= ?)
           AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.seq = event_log.seq)`,
      )
      .run(eventCutoffIso, min, min ?? 0)
    const d = this.#db
      .prepare(`DELETE FROM deliveries WHERE status = 'dead' AND updated_at < ?`)
      .run(deadCutoffIso)
    return { events: Number(e.changes), deliveries: Number(d.changes) }
  }

  // ---- 能力收据与审计 --------------------------------------------------------------------

  insertCapabilityCall(row: {
    at: string
    caller: string
    name: string
    effect: CapabilityEffect
    status: CapabilityCallRow['status']
    opKey?: string
    inputDigest: string
    inputHead?: string
    outboxId?: number
    resultHead?: string
    error?: string
    durationMs: number
    causedBy?: string
  }): number {
    const r = this.#db
      .prepare(
        `INSERT INTO capability_calls
          (at, caller, name, effect, status, op_key, input_digest, input_head, outbox_id,
           result_head, error, duration_ms, caused_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.at,
        row.caller,
        row.name,
        row.effect,
        row.status,
        row.opKey ?? null,
        row.inputDigest,
        row.inputHead ?? null,
        row.outboxId ?? null,
        row.resultHead ?? null,
        row.error ?? null,
        row.durationMs,
        row.causedBy ?? null,
      )
    return Number(r.lastInsertRowid)
  }

  updateCapabilityCall(
    id: number,
    patch: Partial<Pick<CapabilityCallRow, 'status' | 'outboxId' | 'resultHead' | 'error' | 'durationMs'>>,
  ): void {
    const sets: string[] = []
    const values: (string | number | null)[] = []
    if (patch.status !== undefined) {
      sets.push('status = ?')
      values.push(patch.status)
    }
    if (patch.outboxId !== undefined) {
      sets.push('outbox_id = ?')
      values.push(patch.outboxId)
    }
    if (patch.resultHead !== undefined) {
      sets.push('result_head = ?')
      values.push(patch.resultHead)
    }
    if (patch.error !== undefined) {
      sets.push('error = ?')
      values.push(patch.error)
    }
    if (patch.durationMs !== undefined) {
      sets.push('duration_ms = ?')
      values.push(patch.durationMs)
    }
    if (!sets.length) return
    values.push(id)
    this.#db.prepare(`UPDATE capability_calls SET ${sets.join(', ')} WHERE id = ?`).run(...values)
  }

  findCapabilityCallByOpKey(opKey: string): CapabilityCallRow | null {
    const row = this.#db
      .prepare('SELECT * FROM capability_calls WHERE op_key = ?')
      .get(opKey) as CapabilityCallDbRow | undefined
    return row ? this.#toCapabilityCall(row) : null
  }

  getCapabilityCall(id: number): CapabilityCallRow | null {
    const row = this.#db.prepare('SELECT * FROM capability_calls WHERE id = ?').get(id) as
      | CapabilityCallDbRow
      | undefined
    return row ? this.#toCapabilityCall(row) : null
  }

  countCapabilityCalls(status?: CapabilityCallRow['status']): number {
    const row = status
      ? (this.#db
          .prepare('SELECT COUNT(*) AS n FROM capability_calls WHERE status = ?')
          .get(status) as { n: number })
      : (this.#db.prepare('SELECT COUNT(*) AS n FROM capability_calls').get() as { n: number })
    return Number(row.n)
  }

  /** 审计按 TTL 清理；只删终态（submitted 的收据留着，等结果）。 */
  pruneCapabilityCalls(cutoffIso: string): number {
    const r = this.#db
      .prepare(
        `DELETE FROM capability_calls
         WHERE at < ? AND status IN ('done', 'failed', 'error', 'would-do')`,
      )
      .run(cutoffIso)
    return Number(r.changes)
  }

  #toCapabilityCall(r: CapabilityCallDbRow): CapabilityCallRow {
    return {
      id: Number(r.id),
      at: r.at,
      caller: r.caller,
      name: r.name,
      effect: r.effect as CapabilityEffect,
      status: r.status as CapabilityCallRow['status'],
      opKey: r.op_key ?? null,
      inputDigest: r.input_digest,
      inputHead: r.input_head ?? null,
      outboxId: r.outbox_id === null ? null : Number(r.outbox_id),
      resultHead: r.result_head ?? null,
      error: r.error ?? null,
      durationMs: Number(r.duration_ms),
      causedBy: r.caused_by ?? null,
    }
  }

  findCapabilityCallByOutboxId(outboxId: number): CapabilityCallRow | null {
    const row = this.#db.prepare('SELECT * FROM capability_calls WHERE outbox_id = ?').get(outboxId) as
      | CapabilityCallDbRow
      | undefined
    return row ? this.#toCapabilityCall(row) : null
  }

  // ---- 确认（suggest 档） ----------------------------------------------------------------

  insertConfirmation(row: {
    receiptId: number
    caller: string
    name: string
    payload: unknown
    createdAt: string
  }): number {
    const r = this.#db
      .prepare(
        `INSERT OR IGNORE INTO confirmations (receipt_id, caller, name, payload, status, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?)`,
      )
      .run(row.receiptId, row.caller, row.name, JSON.stringify(row.payload ?? null), row.createdAt)
    if (Number(r.changes) === 1) return Number(r.lastInsertRowid)
    const existing = this.getConfirmationByReceipt(row.receiptId)
    if (!existing) throw new Error(`确认写入失败：receipt=${row.receiptId}`)
    return existing.id
  }

  getConfirmationByReceipt(receiptId: number): {
    id: number
    receiptId: number
    caller: string
    name: string
    payload: unknown
    status: string
    createdAt: string
  } | null {
    const row = this.#db.prepare('SELECT * FROM confirmations WHERE receipt_id = ?').get(receiptId) as
      | {
          id: number
          receipt_id: number
          caller: string
          name: string
          payload: string
          status: string
          created_at: string
        }
      | undefined
    if (!row) return null
    return {
      id: Number(row.id),
      receiptId: Number(row.receipt_id),
      caller: row.caller,
      name: row.name,
      payload: JSON.parse(row.payload) as unknown,
      status: row.status,
      createdAt: row.created_at,
    }
  }

  listConfirmations(status = 'pending', limit = 50): {
    id: number
    receiptId: number
    caller: string
    name: string
    status: string
  }[] {
    const rows = this.#db
      .prepare('SELECT id, receipt_id, caller, name, status FROM confirmations WHERE status = ? ORDER BY id LIMIT ?')
      .all(status, limit) as unknown as {
      id: number
      receipt_id: number
      caller: string
      name: string
      status: string
    }[]
    return rows.map((r) => ({
      id: Number(r.id),
      receiptId: Number(r.receipt_id),
      caller: r.caller,
      name: r.name,
      status: r.status,
    }))
  }

  markConfirmation(id: number, status: 'accepted' | 'rejected' | 'expired'): void {
    this.#db.prepare('UPDATE confirmations SET status = ? WHERE id = ?').run(status, id)
  }
}

export function openStore(path: string, opts: OpenOptions = {}): Store {
  return new Store(path, opts)
}
