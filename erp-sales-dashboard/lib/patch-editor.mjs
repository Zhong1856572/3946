// ---------------------------------------------------------------------------
// cordis.patch.yml 的「行级」编辑器（不引第三方 YAML 库）
// ---------------------------------------------------------------------------
// 为什么不用 parse → dump 的方式：
//   profile 的 cordis.patch.yml 里全是用户的注释和排版，一旦整体重排版，
//   用户自己写的说明就全没了。所以这里只做「按块替换」：
//   ① 用 lib/mini-yaml.mjs 的解析器**读**（只读，不动格式）；
//   ② 用行级扫描**写**（只替换目标块，其余行原样保留）。
//
// 块的定义（与 DSH profile 补丁层的实际结构一致）：
//   顶层是一个序列，每项是 `- id: <插件id>` 开头的块，
//   块体是其后所有「缩进 > 0」的行；遇到下一个顶格 `- id:`、顶格 `key:`
//   或顶格注释行即结束。

import { parseMiniYaml } from './mini-yaml.mjs'
import { formatYamlScalar } from './config-defaults.mjs'

const ID_LINE_RE = /^-\s+id\s*:\s*(.*)$/

/**
 * 找出所有 `- id: <pluginId>` 块的位置。
 * @param {string[]} lines  按行拆开的文件内容（不含换行符）
 * @param {string} pluginId
 * @returns {Array<{id:string,start:number,end:number}>} end 为开区间
 */
export function findBlocks(lines, pluginId) {
  const blocks = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^\s/.test(line) || line.trim() === '') continue
    const matched = line.match(ID_LINE_RE)
    if (!matched) continue
    const id = String(matched[1] || '').trim().replace(/^['"]|['"]$/g, '')
    let end = i + 1
    while (end < lines.length) {
      const cur = lines[end]
      if (cur.trim() === '') { end += 1; continue }
      if (/^\s/.test(cur)) { end += 1; continue }
      if (/^\s*#/.test(cur)) break // 顶格注释属于「下一个块」，不算本块
      break
    }
    if (id === pluginId) blocks.push({ id, start: i, end })
    i = end - 1
  }
  return blocks
}

/**
 * 用解析器读出 profile 补丁层里某个块的 config（只读，不改格式）。
 * @param {string} text  cordis.patch.yml 全文
 * @param {string} pluginId
 * @returns {object|null} config 映射；找不到返回 null
 */
export function readBlockConfig(text, pluginId) {
  const parsed = parseMiniYaml(text)
  const list = Array.isArray(parsed) ? parsed : []
  const entry = list.find((item) => item && item.id === pluginId)
  if (!entry) return null
  if (!entry.config || typeof entry.config !== 'object') return null
  return entry.config
}

/**
 * 生成一个 `- id: xxx` 块的文本（含缩进，末尾带换行）。
 * @param {string} pluginId
 * @param {string} pkgName
 * @param {object} config
 * @param {object} comments 键 → 注释行数组
 * @returns {string}
 */
export function renderBlock(pluginId, pkgName, config, comments = {}) {
  const out = []
  out.push(`- id: ${pluginId}`)
  out.push(`  name: ${formatYamlScalar(pkgName)}`)
  out.push('  config:')
  for (const [key, value] of Object.entries(config)) {
    const note = comments[key]
    if (note) for (const c of note) out.push(`    ${c}`)
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const entries = Object.entries(value)
      // 空对象：**不写这一行**（写 `key: {}` 会被插件自带的迷你 YAML 解析器读成字符串 "{}"，
      // 写 `key:` 会被读成 null）。插件的默认值本来就是空对象，省掉即可；
      // 上面那段中文注释仍然保留，用户照着注释填就行。
      if (entries.length === 0) {
        continue
      }
      out.push(`    ${key}:`)
      for (const [k, v] of entries) {
        out.push(`      ${k}: ${formatYamlScalar(v)}`)
      }
    } else {
      out.push(`    ${key}: ${formatYamlScalar(value)}`)
    }
  }
  return `${out.join('\n')}\n`
}

/**
 * 在补丁层里 upsert 一个块：存在则替换，不存在则追加到文件末尾。
 * 只有目标块被改写，其余行（含注释与空行）原样保留。
 * @param {string} text  cordis.patch.yml 全文
 * @param {string} pluginId
 * @param {string} blockText  renderBlock 的输出
 * @returns {{text:string, action:'replaced'|'appended', count:number}}
 */
export function upsertBlock(text, pluginId, blockText) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  // split 会在结尾产生一个空串（文件以换行结尾时）
  const trailingNewline = lines.length > 0 && lines[lines.length - 1] === ''
  if (trailingNewline) lines.pop()

  const blocks = findBlocks(lines, pluginId)
  if (blocks.length > 0) {
    // 多个同名块：只保留第一个，其余删掉（保证「恰好一个」）
    const first = blocks[0]
    const removed = []
    for (let i = blocks.length - 1; i >= 1; i -= 1) removed.push(blocks[i])
    let work = lines.slice(0, first.start)
    const tail = lines.slice(first.end)
    work = work.concat(blockText.replace(/\r?\n$/, '').split(/\r?\n/)).concat(tail)
    // 删掉多余的重复块
    for (const b of removed) {
      const again = findBlocks(work, pluginId)
      if (again.length > 1) work.splice(again[again.length - 1].start, again[again.length - 1].end - again[again.length - 1].start)
    }
    return { text: work.join(eol) + (trailingNewline ? eol : ''), action: 'replaced', count: blocks.length }
  }

  const work = lines.slice()
  let body = blockText.replace(/\r?\n$/, '')
  if (work.length > 0) {
    // 与上一个块之间留一个空行；文件末尾本来就有空行就不重复加
    const last = work[work.length - 1]
    if (last.trim() !== '') work.push('')
  }
  work.push(...body.split(/\r?\n/))
  return { text: work.join(eol) + (trailingNewline ? eol : eol), action: 'appended', count: 0 }
}

/**
 * 从补丁层里删掉某个块（连同它前后那一对空行中的一个，保持版面整洁）。
 * @param {string} text
 * @param {string} pluginId
 * @returns {{text:string, removed:number}}
 */
export function removeBlock(text, pluginId) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const trailingNewline = lines.length > 0 && lines[lines.length - 1] === ''
  if (trailingNewline) lines.pop()
  const blocks = findBlocks(lines, pluginId)
  if (blocks.length === 0) return { text, removed: 0 }
  // 从后往前删，避免下标漂移
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const b = blocks[i]
    let start = b.start
    let end = b.end
    // 目标块前面那个空行也一并去掉（只在后面紧跟空行或已到文件末尾时才去）
    const afterBlankOrEof = end >= lines.length || lines[end].trim() === ''
    if (start > 0 && lines[start - 1].trim() === '' && afterBlankOrEof) start -= 1
    lines.splice(start, end - start)
  }
  return { text: lines.join(eol) + (trailingNewline ? eol : ''), removed: blocks.length }
}
