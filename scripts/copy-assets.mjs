import { cpSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = resolve(ROOT, 'src/plugins')
const OUT = resolve(ROOT, 'dist/plugins')
const DESKTOP_SRC = resolve(ROOT, 'src/desktop')
const DESKTOP_OUT = resolve(ROOT, 'dist/desktop')

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

let copied = 0
for (const file of walk(SRC)) {
  // tsc 只处理 .ts；VBS 等平台资产要跟着插件目录一起进 dist。
  const target = resolve(OUT, relative(SRC, file))
  const rel = relative(SRC, file).replaceAll('\\', '/')
  const isPlatformAsset = /\.(vbs|cmd|ps1|exe)$/i.test(file)
  const isUiAsset = /(^|\/)ui\.json$/i.test(rel) || /(^|\/)ui\/.+\.(html|css|js|svg|png|jpe?g|webp|woff2?)$/i.test(rel)
  if (!isPlatformAsset && !isUiAsset) continue
  mkdirSync(dirname(target), { recursive: true })
  cpSync(file, target)
  copied++
}
if (copied) console.log(`插件资产：复制 ${copied} 个文件到 dist/plugins`)

for (const name of ['app-page.html']) {
  const src = resolve(DESKTOP_SRC, name)
  const target = resolve(DESKTOP_OUT, name)
  mkdirSync(dirname(target), { recursive: true })
  cpSync(src, target)
}
console.log('桌面资产：复制 1 个文件到 dist/desktop')
