/**
 * 飞书 docx XML 的块级纯逻辑：块扫描、按标题找小节、按 markdown 渲染小节 XML。
 * 只处理字符串，不碰平台；平台事实（块 id 只从 xml 取、block_replace 是同父闭区间）见 docs/006。
 *
 * 父子关系按「最近一个带 id 的祖先」算：`<ul>`、`<column>` 这类没有 id 的容器对调用方透明，
 * 因此同一父节点下的子块 = parentId 与 depth 都相同的块。小节替换只能在同一父节点内连续，
 * 所以 findSection 的终点不跨父节点。
 */

export interface XmlBlock {
  id: string
  tag: string
  parentId?: string
  depth: number
}

type Token =
  | { kind: 'text'; text: string }
  | { kind: 'open'; tag: string; id?: string }
  | { kind: 'self'; tag: string; id?: string }
  | { kind: 'close'; tag: string }

const NAME_RE = /^[A-Za-z][\w:.-]*/
const HEADING_TAG_RE = /^h[1-9]$/
const ID_ATTR_RE = /\bid\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/

function tokenize(xml: string): Token[] {
  const out: Token[] = []
  let text = ''
  let i = 0
  const flush = (): void => {
    if (text) out.push({ kind: 'text', text })
    text = ''
  }
  while (i < xml.length) {
    const lt = xml.indexOf('<', i)
    if (lt < 0) {
      text += xml.slice(i)
      break
    }
    text += xml.slice(i, lt)
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4)
      i = end < 0 ? xml.length : end + 3
      continue
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9)
      text += end < 0 ? xml.slice(lt + 9) : xml.slice(lt + 9, end)
      i = end < 0 ? xml.length : end + 3
      continue
    }
    const closing = xml[lt + 1] === '/'
    const nameStart = closing ? lt + 2 : lt + 1
    const name = NAME_RE.exec(xml.slice(nameStart))?.[0]
    if (!name) {
      // 正文里没转义的 `<`：当普通字符，别把后面整段吞掉
      text += xml[lt]
      i = lt + 1
      continue
    }
    flush()
    // 扫到本标签的 `>`；引号里的 `>`（属性值）不算结束
    let j = nameStart + name.length
    let quote: string | null = null
    for (; j < xml.length; j++) {
      const ch = xml[j]!
      if (quote) {
        if (ch === quote) quote = null
        continue
      }
      if (ch === '"' || ch === "'") {
        quote = ch
        continue
      }
      if (ch === '>') break
    }
    if (j >= xml.length) {
      // 标签没闭合：剩下的原样当文本丢弃，不再猜测结构
      i = xml.length
      break
    }
    const inner = xml.slice(nameStart + name.length, j)
    const selfClosing = !closing && /\/\s*$/.test(inner)
    const id = closing ? undefined : idOf(inner)
    out.push(
      closing
        ? { kind: 'close', tag: name }
        : { kind: selfClosing ? 'self' : 'open', tag: name, ...(id ? { id } : {}) },
    )
    i = j + 1
  }
  flush()
  return out
}

function idOf(attrs: string): string | undefined {
  const m = ID_ATTR_RE.exec(attrs)
  const id = m?.[1] ?? m?.[2] ?? m?.[3]
  return id ? id : undefined
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body.startsWith('#x')
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return NAMED_ENTITIES[body] ?? whole
  })
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

interface Scan {
  blocks: XmlBlock[]
  /** 标题块 + 去掉内联标签/实体后的可见文本；按文档顺序 */
  headings: { block: XmlBlock; text: string }[]
}

function scan(xml: string): Scan {
  const tokens = tokenize(xml)
  const stack: { tag: string; id?: string; index: number; block?: XmlBlock }[] = []
  const blocks: XmlBlock[] = []
  const headings: Scan['headings'] = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t.kind === 'text' || t.kind === 'close') {
      if (t.kind === 'close') {
        // 从栈顶找同名标签；找不到就是平台输出的噪音，忽略（不因此中止扫描）
        let k = stack.length - 1
        while (k >= 0 && stack[k]!.tag !== t.tag) k--
        if (k < 0) continue
        const frame = stack[k]!
        if (frame.block && HEADING_TAG_RE.test(frame.tag)) {
          headings.push({ block: frame.block, text: innerText(tokens, frame.index + 1, i) })
        }
        stack.length = k
      }
      continue
    }
    let depth = 0
    let parent: string | undefined
    for (const f of stack) {
      if (!f.id) continue
      depth++
      parent = f.id
    }
    const block: XmlBlock | undefined = t.id
      ? { id: t.id, tag: t.tag, ...(parent ? { parentId: parent } : {}), depth }
      : undefined
    if (block) blocks.push(block)
    if (t.kind === 'open') {
      stack.push({ tag: t.tag, ...(t.id ? { id: t.id } : {}), index: i, ...(block ? { block } : {}) })
    } else if (block && HEADING_TAG_RE.test(t.tag)) {
      headings.push({ block, text: '' })
    }
  }
  return { blocks, headings }
}

/** 元素内文：区间里的文本 token 拼起来，再去实体（内联标签本身不进文本）。 */
function innerText(tokens: readonly Token[], from: number, to: number): string {
  let s = ''
  for (let i = from; i < to; i++) {
    const t = tokens[i]!
    if (t.kind === 'text') s += t.text
  }
  return decodeEntities(s)
}

/** 按标签开闭扫描，返回带 id 的块（文档顺序）与最近 id 祖先关系；自闭合标签不压栈。 */
export function parseBlocks(xml: string): { id: string; tag: string; parentId?: string; depth: number }[] {
  return scan(xml).blocks
}

/**
 * 按标题可见文本精确匹配第一个 h1..h9，返回它所在小节的区间。
 * 终点 = 同一父节点下、该标题之后、下一个标题（任意 level）之前的最后一个带 id 块；
 * 后面没有兄弟块（或下一个块就是标题）时 endId 等于 headingId。
 */
export function findSection(
  xml: string,
  heading: string,
): { headingId: string; level: number; endId: string } | null {
  const { blocks, headings } = scan(xml)
  const want = heading.trim()
  const hit = headings.find((h) => h.text.trim() === want)
  if (!hit) return null
  const siblings = blocks.filter((b) => b.depth === hit.block.depth && b.parentId === hit.block.parentId)
  const at = siblings.indexOf(hit.block)
  const after = at < 0 ? [] : siblings.slice(at + 1)
  const nextHeading = after.findIndex((b) => HEADING_TAG_RE.test(b.tag))
  const region = nextHeading < 0 ? after : after.slice(0, nextHeading)
  return {
    headingId: hit.block.id,
    level: Number(hit.block.tag.slice(1)),
    endId: region.length ? region[region.length - 1]!.id : hit.block.id,
  }
}

/**
 * 生成小节 XML：`<hN>heading</hN>` + 正文转换（checkbox / 合并的 ul / 空段落 / 普通段落）。
 * 首尾空行不产出空段落；文本一律做 XML 转义。
 */
export function renderSectionXml(heading: string, body: string, level: number): string {
  if (!Number.isInteger(level) || level < 1 || level > 9) {
    throw new Error(`标题层级必须是 1..9 的整数：${String(level)}`)
  }
  const lines = body.split(/\r?\n/)
  while (lines.length && lines[0]!.trim() === '') lines.shift()
  while (lines.length && lines[lines.length - 1]!.trim() === '') lines.pop()

  const parts: string[] = [`<h${level}>${escapeXml(heading)}</h${level}>`]
  let inList = false
  const closeList = (): void => {
    if (!inList) return
    parts.push('</ul>')
    inList = false
  }
  for (const line of lines) {
    const text = line.trim()
    const checkbox = /^- \[( |x|X)\] (.*)$/.exec(text)
    if (checkbox) {
      closeList()
      const done = checkbox[1] === ' ' ? 'false' : 'true'
      parts.push(`<checkbox done="${done}">${escapeXml(checkbox[2]!)}</checkbox>`)
      continue
    }
    const bullet = /^- (.*)$/.exec(text)
    if (bullet) {
      if (!inList) {
        parts.push('<ul>')
        inList = true
      }
      parts.push(`<li>${escapeXml(bullet[1]!)}</li>`)
      continue
    }
    closeList()
    parts.push(text === '' ? '<p></p>' : `<p>${escapeXml(text)}</p>`)
  }
  closeList()
  return parts.join('')
}
