/**
 * 桌面面板：本机 HTTP + 浏览器独立窗口。
 *
 * 只监听 127.0.0.1，地址里带一次性令牌；默认空闲 15 分钟自退（配置页本来就该短命）。
 * 不自建 Electron：Chromium/Edge 的 --app 模式就够，三端行为一致、零额外依赖。
 */

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { resolve } from 'node:path'
import { loadConfigLayered, loadProjects, writeOverlay } from '../kernel/config.ts'
import { type ConfigField, describeConfig } from '../kernel/config-schema.ts'
import { assemble, PLUGIN_DIR } from '../kernel/wiring.ts'
import { openStore } from '../kernel/store.ts'
import { loadRules } from '../routing/rules.ts'
import { clearUiInfo, writeUiInfo } from './registry.ts'
import { summarizeWorkstation } from '../domain/workstation.ts'
import { pluginStatuses, togglePlugin, UnknownPluginError } from './plugins.ts'
import { discoverUi, readUiAsset } from './ui-catalog.ts'

// 页面**懒读**：这个模块被 main.ts 顶层 import，钩子进程也会把它拉进来。
// 以前在模块作用域读 html，dist 里少一个文件（比如构建中间态）就让 Stop 钩子直接崩掉，
// 症状是「窗口答完了，飞书什么都没收到」（2026-11-06 实测踩到）。
let appPageCache: string | undefined
function appPageHtml(): string {
  appPageCache ??= readFileSync(new URL('./app-page.html', import.meta.url), 'utf8')
  return appPageCache
}

function appPage(token: string, fields: ConfigField[]): string {
  return appPageHtml().replace('__TOKEN__', JSON.stringify(token)).replace('__FIELDS__', JSON.stringify(fields))
}

// 页面字段从配置本身推出来（见 kernel/config-schema.ts），不再维护白名单：
// 加一个配置项，页面下一次打开就有，不用改这里。

function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj
  for (const seg of path.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const segs = path.split('.')
  let cur: Record<string, unknown> = obj
  for (const seg of segs.slice(0, -1)) {
    const next = cur[seg]
    if (typeof next !== 'object' || next === null || Array.isArray(next)) cur[seg] = {}
    cur = cur[seg] as Record<string, unknown>
  }
  cur[segs.at(-1)!] = value
}

/** 按字段类型收窄；返回 undefined 表示值不合法。 */
function coerce(field: ConfigField, raw: unknown): unknown {
  switch (field.kind) {
    case 'bool':
      return typeof raw === 'boolean' ? raw : undefined
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(raw)
      return Number.isFinite(n) ? n : undefined
    }
    case 'select':
      return (field.options as readonly string[]).includes(String(raw)) ? String(raw) : undefined
    case 'text':
      return typeof raw === 'string' ? raw : undefined
    case 'json': {
      // 数组/对象类配置（策略、别名表）在页面上是 JSON 文本框：写错了就明确拒，不猜
      if (typeof raw !== 'string') return raw
      try {
        return JSON.parse(raw) as unknown
      } catch {
        return undefined
      }
    }
    case 'readonly':
      return undefined
  }
}

export interface UiOptions {
  root: string
  port?: number
  /** 0 = 不自动退出 */
  idleExitMs?: number
  /** 尝试用浏览器独立窗口打开 */
  open?: boolean
}

export interface UiHandle {
  url: string
  port: number
  close(): Promise<void>
}

interface Snapshot {
  ok: boolean
  error?: string
  mode?: string
  workspaces?: { id: string; name: string; executor: string; isolation: string; root: string }[]
  rules?: string[]
  sources?: { name: string; enabled: boolean; plugin: string }[]
  ports?: { sources: number; classifiers: number; executors: number; channels: number }
  stats?: {
    events: number
    intents: number
    outbox: Record<string, number>
    works: Record<string, number>
    analysis?: { ok: number; degraded: number; backlog: number }
  }
  recent?: {
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
    analysis?: { status: string; attempt?: number; origin?: string; summary?: string; latencyMs?: number }
  }[]
  /** 页面可编辑字段的当前生效值（基线 + 覆盖层合并后的结果） */
  values?: Record<string, unknown>
  /** 字段描述（页面按它渲染，不用认识字段名） */
  fields?: ConfigField[]
  /** 覆盖层文件是否存在（存在即说明本机改过配置） */
  overridden?: boolean
}

function workstationData(root: string): ReturnType<typeof summarizeWorkstation> {
  const config = loadConfigLayered(resolve(root, 'config/lingcub.yaml'), resolve(root, 'data/local.json'))
  const store = openStore(resolve(root, config.store.path), { readOnly: true })
  try {
    return summarizeWorkstation(store)
  } finally {
    store.close()
  }
}

function workstationSession(root: string, id: string) {
  const config = loadConfigLayered(resolve(root, 'config/lingcub.yaml'), resolve(root, 'data/local.json'))
  const store = openStore(resolve(root, config.store.path), { readOnly: true })
  try {
    return store.getSession(id)
  } finally {
    store.close()
  }
}

function workstationOutbox(root: string, status: 'pending' | 'dead' | 'done') {
  const config = loadConfigLayered(resolve(root, 'config/lingcub.yaml'), resolve(root, 'data/local.json'))
  const store = openStore(resolve(root, config.store.path), { readOnly: true })
  try {
    return store.listOutbox(status, 20).map((r) => ({
      id: r.id,
      dedupeKey: r.dedupeKey,
      kind: r.action.kind,
      lastError: r.lastError,
    }))
  } finally {
    store.close()
  }
}

function retryDeadOutbox(root: string, id: number): boolean {
  const config = loadConfigLayered(resolve(root, 'config/lingcub.yaml'), resolve(root, 'data/local.json'))
  const store = openStore(resolve(root, config.store.path))
  try {
    return store.retryDeadOutbox(id)
  } finally {
    store.close()
  }
}

async function uiCatalog(root: string) {
  const statuses = await pluginStatuses(root)
  return discoverUi(PLUGIN_DIR, new Set(statuses.enabled))
}

function messageTrace(root: string, eventId: string, externalId?: string) {
  const config = loadConfigLayered(resolve(root, 'config/lingcub.yaml'), resolve(root, 'data/local.json'))
  const store = openStore(resolve(root, config.store.path), { readOnly: true })
  try {
    if (!eventId) {
      if (!externalId) return null
      const found = store.findEventByExternalId(externalId)
      if (!found) return null
      return store.traceMessage(found.id)
    }
    return store.traceMessage(eventId)
  } finally {
    store.close()
  }
}

function analysisBacklog(root: string, limit: number, beforeMinutes: number) {
  const config = loadConfigLayered(resolve(root, 'config/lingcub.yaml'), resolve(root, 'data/local.json'))
  const store = openStore(resolve(root, config.store.path), { readOnly: true })
  try {
    return store
      .oldEventsWithoutAnalysis(
        new Date(Date.now() - beforeMinutes * 60_000).toISOString(),
        Math.min(100, Math.max(1, limit)),
      )
      .map((e) => ({
        id: e.id,
        source: e.source,
        externalId: e.externalId,
        receivedAt: e.receivedAt,
        text: e.text,
      }))
  } finally {
    store.close()
  }
}

function analysisDegraded(root: string, limit: number, sinceMinutes: number) {
  const config = loadConfigLayered(resolve(root, 'config/lingcub.yaml'), resolve(root, 'data/local.json'))
  const store = openStore(resolve(root, config.store.path), { readOnly: true })
  try {
    return store
      .degradedAnalyses(
        new Date(Date.now() - sinceMinutes * 60_000).toISOString(),
        Math.min(100, Math.max(1, limit)),
      )
      .map((x) => ({
        eventId: x.event.id,
        source: x.event.source,
        externalId: x.event.externalId,
        attempt: x.analysis.attempt ?? 1,
        error: x.analysis.error,
        analysisEventId: x.analysisEventId,
      }))
  } finally {
    store.close()
  }
}

function workstationSessions(root: string): {
  id: string
  title?: string
  executor: string
  workspace: string
  status: string
  lastActiveAt: string
}[] {
  const config = loadConfigLayered(resolve(root, 'config/lingcub.yaml'), resolve(root, 'data/local.json'))
  const store = openStore(resolve(root, config.store.path), { readOnly: true })
  try {
    return store
      .listSessions()
      .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))
      .slice(0, 50)
      .map((s) => ({
        id: s.id,
        ...(s.title ? { title: s.title } : {}),
        executor: s.executor,
        workspace: s.workspace,
        status: s.status,
        lastActiveAt: s.lastActiveAt,
      }))
  } finally {
    store.close()
  }
}

async function snapshot(root: string): Promise<Snapshot> {
  const configPath = resolve(root, 'config/lingcub.yaml')
  const overlayPath = resolve(root, 'data/local.json')
  try {
    const config = loadConfigLayered(configPath, overlayPath)
    const projects = loadProjects(resolve(root, 'config/projects.yaml'))
    const rules = loadRules(resolve(root, 'config/rules.yaml'))
    const { ports } = await assemble(PLUGIN_DIR, config, () => {})

    const out: Snapshot = {
      ok: true,
      mode: config.mode,
      workspaces: projects.workspaces.map((w) => ({
        id: w.id,
        name: w.name,
        executor: w.executor,
        isolation: w.isolation,
        root: w.root,
      })),
      rules: rules.rules.map((r) => r.id),
      sources: Object.entries(config.sources).map(([name, s]) => ({
        name,
        enabled: s.enabled,
        plugin: s.plugin,
      })),
      ports: {
        sources: ports.sources.size,
        classifiers: ports.classifiers.size,
        executors: ports.executors.size,
        channels: ports.channels.size,
      },
      fields: describeConfig(config),
      values: Object.fromEntries(
        describeConfig(config)
          .filter((f) => f.kind !== 'readonly')
          .map((f) => [f.path, getPath(config, f.path)]),
      ),
      overridden: existsSync(overlayPath),
    }

    const dbPath = resolve(root, config.store.path)
    if (existsSync(dbPath)) {
      const store = openStore(dbPath, { readOnly: true })
      try {
        out.stats = {
          events: store.countEvents(),
          intents: store.countIntents(),
          works: store.countWorks(),
          analysis: {
            ok: store.countAnalysis('ok', new Date(Date.now() - 24 * 3600_000).toISOString()),
            degraded: store.countAnalysis('degraded', new Date(Date.now() - 24 * 3600_000).toISOString()),
            backlog: store.countEventsWithoutAnalysis(new Date(Date.now() - 10 * 60_000).toISOString()),
          },
          outbox: {
            pending: store.countOutbox('pending'),
            dispatched: store.countOutbox('dispatched'),
            done: store.countOutbox('done'),
            dead: store.countOutbox('dead'),
          },
        }
        out.recent = store.recentEvents(20).map((e) => {
          const a = store.latestAnalysis(e.id)
          return {
            ...e,
            analysis: a
              ? { status: a.status, attempt: a.attempt, origin: a.origin, summary: a.summary, latencyMs: a.latencyMs }
              : undefined,
          }
        })
      } finally {
        store.close()
      }
    }
    return out
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

const TRACE_PAGE = (token: string): string => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>幺幺零 · 消息追踪</title>
<style>:root{color-scheme:light dark}body{font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;margin:0;padding:20px 24px;max-width:1100px}
input{font:inherit;width:360px;padding:4px}button{font:inherit;padding:4px 10px;margin-left:6px}
pre{white-space:pre-wrap;word-break:break-all;background:rgba(127,127,127,.08);padding:12px;border-radius:6px}
a{color:inherit}h2{font-size:13px;margin:20px 0 6px;opacity:.6}table{border-collapse:collapse;width:100%}td{padding:3px 10px 3px 0;vertical-align:top}td:first-child{white-space:nowrap;opacity:.6;width:1%}.ok{color:#1a7f37}.warn{color:#c33}</style></head><body>
<h1>幺幺零 · 消息追踪</h1>
<p><a href="/?t=${token}">← 返回面板</a></p>
<p><input id="id" placeholder="eventId"><button id="go">查看</button></p>
<div id="out">输入 eventId，查看 原始事件 → AI 分析 → 分发决策 → 发件箱 / 会话。</div>
<script>
const T=${JSON.stringify(token)};
const out=document.getElementById('out'), input=document.getElementById('id');
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const row=(k,v)=>'<tr><td>'+esc(k)+'</td><td>'+esc(v??'—')+'</td></tr>';
const table=rows=>'<table>'+rows+'</table>';
function render(t){
  const e=t.event||{};
  const aEv=(t.events||[]).find(x=>x.kind==='message.analyzed');
  const dEv=(t.events||[]).find(x=>x.kind==='distribution.decided');
  const a=aEv&&aEv.payload?aEv.payload.analysis:null;
  const d=dEv&&dEv.payload?dEv.payload.decision:null;
  let h='<h2>原始事件</h2>'+table(row('id',e.id)+row('来源',e.source)+row('时间',e.receivedAt)+row('会话',e.channel&&(e.channel.name||e.channel.id))+row('发送者',e.actor&&(e.actor.name||e.actor.id))+row('正文',e.text));
  h+='<h2>AI 分析</h2>'+(a?table(row('状态',a.status)+row('attempt',a.attempt||1)+row('来源',a.origin||'live')+row('摘要',a.summary)+row('紧急度',a.urgency)+row('实体',(a.entities||[]).join('、'))+row('上下文',a.contextVia+' · '+a.contextCount+' 条')+row('模型',a.model)+row('耗时',a.latencyMs!==undefined?a.latencyMs+'ms':'—')+row('错误',a.error)):'<div class="warn">未找到 message.analyzed</div>');
  h+='<h2>分发决策</h2>'+(d?table(row('规则',d.ruleId||'none')+row('出口',(d.targets||[]).join('、')||'none')):'<div class="warn">未找到 distribution.decided</div>');
  const ob=(t.outbox||[]); h+='<h2>发件箱</h2>'+(ob.length?table(ob.map(x=>row('#'+x.id,x.status+' · '+x.dedupeKey+' · '+(x.action&&x.action.kind)+' attempts='+x.attempts+(x.lastError?' · '+x.lastError:''))).join('')):'<div>暂无</div>');
  const ss=(t.sessions||[]); h+='<h2>会话</h2>'+(ss.length?table(ss.map(x=>row(x.id,x.status+' · '+x.workspace+' · '+(x.title||''))).join('')):'<div>暂无</div>');
  const os=(t.outcomes||[]); h+='<h2>结果回执</h2>'+(os.length?os.map(x=>'<div class="ok">'+esc(x.payload&&x.payload.text||'')+'</div>').join(''):'<div>暂无</div>');
  const ws=(t.works||[]); h+='<h2>工作项</h2>'+(ws.length?table(ws.map(x=>row(x.id,x.status+' · '+x.project+' · '+(x.sessionId||'未开窗'))).join('')):'<div>暂无</div>');
  h+='<details><summary>原始 JSON</summary><pre>'+esc(JSON.stringify(t,null,2))+'</pre></details>';
  out.innerHTML=h;
}
async function load(){
  const eventId=input.value.trim(); if(!eventId){out.textContent='缺少 eventId';return}
  out.textContent='读取中…';
  try{
    const r=await fetch('/api/trace?t='+T+'&eventId='+encodeURIComponent(eventId));
    const d=await r.json();
    if(d.ok) render(d.trace); else out.textContent='失败：'+(d.error||'未知');
  }catch(e){out.textContent='失败：'+e.message}
}
document.getElementById('go').onclick=load;
input.addEventListener('keydown',e=>{if(e.key==='Enter')load()});
const q=new URLSearchParams(location.search).get('eventId');
if(q){input.value=q;load()}
</script></body></html>`

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(body)
}

/** 用 Chromium/Edge 的 --app 起一个无地址栏窗口；没有就退回默认浏览器。 */
function openAppWindow(url: string): void {
  // 延迟 import，避免面板本身在无父子进程环境里也拉起子进程
  void import('node:child_process').then(({ spawn }) => {
    const candidates =
      process.platform === 'win32'
        ? [
            'C:/Program Files/Google/Chrome/Application/chrome.exe',
            'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
            'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
            'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
          ]
        : process.platform === 'darwin'
          ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
          : ['google-chrome', 'chromium', 'chromium-browser']
    const bin = candidates.find((c) => (c.includes('/') ? existsSync(c) : true))
    const args = ['--app=' + url, '--window-size=980,760']
    try {
      const child = bin
        ? spawn(bin, args, { detached: true, stdio: 'ignore', windowsHide: true })
        : spawn(
            process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open',
            process.platform === 'win32' ? ['/c', 'start', '', url] : [url],
            { detached: true, stdio: 'ignore' },
          )
      child.unref()
    } catch {
      process.stderr.write(`打开窗口失败，请手动访问：${url}\n`)
    }
  })
}

function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
  return new Promise((resolveP, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolveP(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export async function startUi(opts: UiOptions): Promise<UiHandle> {
  const token = randomBytes(16).toString('hex')
  const idleExitMs = opts.idleExitMs ?? 15 * 60_000
  const configPath = resolve(opts.root, 'config/lingcub.yaml')
  const overlayPath = resolve(opts.root, 'data/local.json')
  let idleTimer: NodeJS.Timeout | undefined
  let closed = false

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    // 探活不校验令牌：它只回 ok，不含任何状态
    if (url.pathname === '/healthz') return send(res, 200, 'text/plain', 'ok')
    // 插件静态页不接触宿主 API，也不需要把宿主令牌带进 iframe；只允许只读静态资源。
    if (!url.pathname.startsWith('/plugin-ui/') && url.searchParams.get('t') !== token) {
      return send(res, 403, 'text/plain', '令牌无效')
    }

    if (url.pathname === '/') {
      // 页面字段从当前生效配置推出来：加一个配置项不用改这里
      const cfgNow = loadConfigLayered(configPath, overlayPath)
      return send(res, 200, 'text/html; charset=utf-8', appPage(token, describeConfig(cfgNow)))
    }
    if (url.pathname === '/trace') {
      return send(res, 200, 'text/html; charset=utf-8', TRACE_PAGE(token))
    }
    if (url.pathname.startsWith('/plugin-ui/')) {
      const rest = url.pathname.slice('/plugin-ui/'.length)
      const slash = rest.indexOf('/')
      if (slash <= 0) {
        send(res, 404, 'text/plain; charset=utf-8', '插件页面不存在')
        return
      }
      void (async () => {
        try {
          const pluginId = decodeURIComponent(rest.slice(0, slash))
          const page = decodeURIComponent(rest.slice(slash + 1))
          const statuses = await pluginStatuses(opts.root)
          if (!statuses.enabled.includes(pluginId)) {
            send(res, 404, 'text/plain; charset=utf-8', '插件未启用')
            return
          }
          const asset = readUiAsset(PLUGIN_DIR, pluginId, page)
          if (!asset) {
            send(res, 404, 'text/plain; charset=utf-8', '插件资源不存在')
            return
          }
          const ext = page.slice(page.lastIndexOf('.')).toLowerCase()
          const type =
            ext === '.html'
              ? 'text/html; charset=utf-8'
              : ext === '.css'
                ? 'text/css; charset=utf-8'
                : ext === '.js'
                  ? 'text/javascript; charset=utf-8'
                  : ext === '.svg'
                    ? 'image/svg+xml'
                    : ext === '.png'
                      ? 'image/png'
                      : ext === '.jpg' || ext === '.jpeg'
                        ? 'image/jpeg'
                        : ext === '.webp'
                          ? 'image/webp'
                          : 'application/octet-stream'
          res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
          res.end(asset.body)
        } catch (e) {
          send(res, 500, 'text/plain; charset=utf-8', e instanceof Error ? e.message : String(e))
        }
      })()
      return
    }
    if (url.pathname === '/api/ui') {
      void uiCatalog(opts.root)
        .then((ui) => send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, ...ui })))
        .catch((e: unknown) =>
          send(
            res,
            500,
            'application/json; charset=utf-8',
            JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }),
          ),
        )
      return
    }
    if (url.pathname === '/api/state') {
      void snapshot(opts.root).then((s) => send(res, 200, 'application/json; charset=utf-8', JSON.stringify(s)))
      return
    }
    if (url.pathname === '/api/workstation') {
      void Promise.resolve()
        .then(() => workstationData(opts.root))
        .then((s) => send(res, 200, 'application/json; charset=utf-8', JSON.stringify(s)))
        .catch((e: unknown) =>
          send(
            res,
            500,
            'application/json; charset=utf-8',
            JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }),
          ),
        )
      return
    }
    if (url.pathname === '/api/trace') {
      const eventId = url.searchParams.get('eventId')?.trim()
      const externalId = url.searchParams.get('externalId')?.trim()
      if (!eventId && !externalId) {
        send(res, 400, 'application/json; charset=utf-8', JSON.stringify({ ok: false, error: '缺少 eventId 或 externalId' }))
        return
      }
      void Promise.resolve()
        .then(() => messageTrace(opts.root, eventId ?? '', externalId))
        .then((trace) => send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, trace })))
        .catch((e: unknown) =>
          send(
            res,
            500,
            'application/json; charset=utf-8',
            JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }),
          ),
        )
      return
    }
    if (url.pathname === '/api/analysis/backlog') {
      const limit = Number(url.searchParams.get('limit') ?? 20)
      const beforeMinutes = Number(url.searchParams.get('beforeMinutes') ?? 10)
      try {
        const rows = analysisBacklog(opts.root, limit, beforeMinutes)
        send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, rows }))
      } catch (e) {
        send(
          res,
          500,
          'application/json; charset=utf-8',
          JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }),
        )
      }
      return
    }
    if (url.pathname === '/api/analysis/degraded') {
      const limit = Number(url.searchParams.get('limit') ?? 20)
      const sinceMinutes = Number(url.searchParams.get('sinceMinutes') ?? 10)
      try {
        const rows = analysisDegraded(opts.root, limit, sinceMinutes)
        send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, rows }))
      } catch (e) {
        send(
          res,
          500,
          'application/json; charset=utf-8',
          JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }),
        )
      }
      return
    }
    if (url.pathname === '/api/workstation/sessions') {
      void Promise.resolve()
        .then(() => workstationSessions(opts.root))
        .then((s) => send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, sessions: s })))
        .catch((e: unknown) =>
          send(
            res,
            500,
            'application/json; charset=utf-8',
            JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }),
          ),
        )
      return
    }
    if (url.pathname === '/api/workstation/outbox') {
      const raw = url.searchParams.get('status') ?? 'pending'
      const status = raw === 'dead' || raw === 'done' ? raw : 'pending'
      void Promise.resolve()
        .then(() => workstationOutbox(opts.root, status))
        .then((rows) => send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, rows })))
        .catch((e: unknown) =>
          send(
            res,
            500,
            'application/json; charset=utf-8',
            JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }),
          ),
        )
      return
    }
    if (url.pathname === '/api/outbox/retry') {
      if (req.method !== 'POST') {
        send(res, 405, 'application/json; charset=utf-8', JSON.stringify({ ok: false, error: '只支持 POST' }))
        return
      }
      const id = Number(url.searchParams.get('id'))
      if (!Number.isInteger(id) || id <= 0) {
        send(res, 400, 'application/json; charset=utf-8', JSON.stringify({ ok: false, error: '缺少有效 id' }))
        return
      }
      try {
        const retried = retryDeadOutbox(opts.root, id)
        send(res, retried ? 200 : 409, 'application/json; charset=utf-8', JSON.stringify({ ok: retried, retried }))
      } catch (e) {
        send(
          res,
          500,
          'application/json; charset=utf-8',
          JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }),
        )
      }
      return
    }
    if (url.pathname === '/api/plugins') {
      void Promise.resolve()
        .then(() => pluginStatuses(opts.root))
        .then((s) => send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, ...s })))
        .catch((e: unknown) =>
          send(
            res,
            500,
            'application/json; charset=utf-8',
            JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }),
          ),
        )
      return
    }
    if (url.pathname === '/api/plugins/toggle' && req.method === 'POST') {
      void readBody(req)
        .then(async (raw) => {
          let body: { id?: unknown; enabled?: unknown }
          try {
            body = JSON.parse(raw) as { id?: unknown; enabled?: unknown }
          } catch {
            send(res, 400, 'application/json; charset=utf-8', JSON.stringify({ ok: false, error: '请求体不是 JSON' }))
            return
          }
          if (typeof body.id !== 'string' || !body.id || typeof body.enabled !== 'boolean') {
            send(
              res,
              400,
              'application/json; charset=utf-8',
              JSON.stringify({ ok: false, error: '请求需要 {id: string, enabled: boolean}' }),
            )
            return
          }
          const result = await togglePlugin(opts.root, body.id, body.enabled)
          send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, ...result }))
        })
        .catch((e: unknown) => {
          // 未知插件是请求问题（400）；其余（配置写不进去、plugin-admin 出错）按内部错误报
          const status = e instanceof UnknownPluginError ? 400 : 500
          send(
            res,
            status,
            'application/json; charset=utf-8',
            JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }),
          )
        })
      return
    }
    if (url.pathname.startsWith('/api/workstation/sessions/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/workstation/sessions/'.length))
      void Promise.resolve()
        .then(() => workstationSession(opts.root, id))
        .then((s) => {
          if (!s) {
            send(res, 404, 'application/json; charset=utf-8', JSON.stringify({ ok: false, error: '会话不存在' }))
            return
          }
          send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, session: s }))
        })
        .catch((e: unknown) =>
          send(
            res,
            500,
            'application/json; charset=utf-8',
            JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }),
          ),
        )
      return
    }
    if (url.pathname === '/api/restart' && req.method === 'POST') {
      // 只写请求文件：真正退出由常驻进程自己决定，面板不直接杀进程
      mkdirSync(resolve(opts.root, 'data'), { recursive: true })
      writeFileSync(resolve(opts.root, 'data/restart-request'), new Date().toISOString(), 'utf8')
      send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true }))
      return
    }
    if (url.pathname === '/api/config' && req.method === 'POST') {
      void readBody(req)
        .then((raw) => {
          const body = JSON.parse(raw) as { values?: Record<string, unknown> }
          const schema = describeConfig(loadConfigLayered(configPath, overlayPath))
          const patch: Record<string, unknown> = {}
          const rejected: string[] = []
          for (const [path, rawValue] of Object.entries(body.values ?? {})) {
            const field = schema.find((f) => f.path === path)
            if (!field) {
              rejected.push(`${path}：页面上没有这一项（执行器参数、命令行、字段映射不给改）`)
              continue
            }
            const value = coerce(field, rawValue)
            if (value === undefined) {
              rejected.push(`${path}：值不合法（${String(rawValue)}）`)
              continue
            }
            setPath(patch, path, value)
          }
          if (rejected.length) {
            send(res, 400, 'application/json; charset=utf-8', JSON.stringify({ ok: false, error: rejected.join('；') }))
            return
          }
          writeOverlay(configPath, overlayPath, patch)
          send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, saved: patch }))
        })
        .catch((e: unknown) =>
          send(
            res,
            400,
            'application/json; charset=utf-8',
            JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }),
          ),
        )
      return
    }
    send(res, 404, 'text/plain', 'not found')
  })

  const resetIdle = (): void => {
    if (idleExitMs <= 0) return
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      process.stderr.write('面板空闲超时，自动退出\n')
      void close()
    }, idleExitMs)
    idleTimer.unref()
  }

  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    if (idleTimer) clearTimeout(idleTimer)
    clearUiInfo(opts.root)
    await new Promise<void>((r) => server.close(() => r()))
  }

  server.on('request', resetIdle)
  await new Promise<void>((r, j) => {
    server.once('error', j)
    server.listen(opts.port ?? 0, '127.0.0.1', () => r())
  })
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : (opts.port ?? 0)
  const url = `http://127.0.0.1:${port}/?t=${token}`
  // 登记起来：三端入口再点一次就复用这个实例，不会堆出第二个服务
  writeUiInfo(opts.root, { port, token, pid: process.pid, url })
  resetIdle()
  if (opts.open) openAppWindow(url)
  return { url, port, close }
}
