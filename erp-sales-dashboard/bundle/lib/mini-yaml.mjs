// ---------------------------------------------------------------------------
// 极简 YAML 解析器（只覆盖本项目 cordis.patch.yml 用到的子集）
// ---------------------------------------------------------------------------
// 支持：注释行、缩进映射 `key: value`、序列 `- item`、
//       序列项内联映射 `- id: xxx`、嵌套块、行尾注释、单双引号标量。
// 不支持：锚点 / 多行标量 / 流式集合 —— 本文件用不到，也不该引入第三方解析器。
//
// 抽成独立模块的原因：selfcheck.mjs（校验 patch 配置）与 verify-host.mjs
// （用生产配置跑端到端验证）都要读同一份 cordis.patch.yml。
// 以前两边各抄一份、各写一份配置，改了 patch 就会漂移 —— 现在只读这一个真相源。

const YAML_KEY_RE = /^([A-Za-z0-9_@./-]+):(?:\s+(.*))?$/

export function parseMiniYaml(text) {
  const lines = []
  for (const raw of String(text).split(/\r?\n/)) {
    if (raw.trim() === '') continue
    if (/^\s*#/.test(raw)) continue
    const indent = raw.length - raw.trimStart().length
    lines.push({ indent, content: raw.trim() })
  }

  let pos = 0
  const isSeqItem = (content) => content === '-' || content.startsWith('- ')

  function parseScalar(raw) {
    let text = String(raw).trim()
    if (text === '') return null
    if (text[0] === "'" || text[0] === '"') {
      const quote = text[0]
      const end = text.indexOf(quote, 1)
      return end > 0 ? text.slice(1, end) : text.slice(1)
    }
    const hash = text.indexOf(' #')
    if (hash >= 0) text = text.slice(0, hash).trim()
    if (text === 'true') return true
    if (text === 'false') return false
    if (text === 'null' || text === '~') return null
    if (/^-?\d+$/.test(text)) return Number(text)
    if (/^-?\d*\.\d+$/.test(text)) return Number(text)
    return text
  }

  function parseBlock(indent) {
    if (pos >= lines.length) return null
    return isSeqItem(lines[pos].content) ? parseSequence(indent) : parseMapping(indent)
  }

  function parseSequence(indent) {
    const out = []
    while (pos < lines.length && lines[pos].indent === indent && isSeqItem(lines[pos].content)) {
      const rest = lines[pos].content === '-' ? '' : lines[pos].content.slice(2).trim()
      if (rest === '') {
        pos += 1
        const childIndent = pos < lines.length ? lines[pos].indent : indent
        out.push(childIndent > indent ? parseBlock(childIndent) : null)
        continue
      }
      if (YAML_KEY_RE.test(rest)) {
        // 「- id: xxx」：把本行改写成内层映射的第一行（缩进 +2）
        lines[pos] = { indent: indent + 2, content: rest }
        out.push(parseMapping(indent + 2))
        continue
      }
      pos += 1
      out.push(parseScalar(rest))
    }
    return out
  }

  function parseMapping(indent) {
    const out = {}
    while (pos < lines.length && lines[pos].indent === indent && !isSeqItem(lines[pos].content)) {
      const matched = lines[pos].content.match(YAML_KEY_RE)
      if (!matched) {
        pos += 1
        continue
      }
      const key = matched[1]
      const rest = (matched[2] || '').trim()
      pos += 1
      if (rest === '') {
        if (pos < lines.length && lines[pos].indent > indent) {
          out[key] = parseBlock(lines[pos].indent)
        } else if (pos < lines.length && lines[pos].indent === indent && isSeqItem(lines[pos].content)) {
          out[key] = parseSequence(indent)
        } else {
          out[key] = null
        }
      } else {
        out[key] = parseScalar(rest)
      }
    }
    return out
  }

  return lines.length ? parseBlock(lines[0].indent) : null
}

/**
 * 从 cordis.patch.yml 里取出本插件的 config 块。
 * @param {string} text  cordis.patch.yml 全文
 * @param {string} pluginId  插件 id（默认 erp-sales-dashboard）
 * @returns {object} config 映射；找不到时抛错（宁可报错也不要静默用空配置）
 */
export function readPluginConfig(text, pluginId = 'erp-sales-dashboard') {
  const patch = parseMiniYaml(text)
  // cordis.patch.yml 的顶层是序列，元素是 `{insert: [...]}`；
  // 但也兼容顶层直接是映射 `{insert: [...]}` 的写法。
  const root = Array.isArray(patch) ? patch[0] : patch
  const insert = root && Array.isArray(root.insert) ? root.insert : []
  const entry = insert.find((item) => item && item.id === pluginId)
  if (!entry) throw new Error(`cordis.patch.yml 里找不到 id=${pluginId} 的条目`)
  const config = entry.config
  if (!config || typeof config !== 'object') {
    throw new Error(`cordis.patch.yml 里 id=${pluginId} 的条目没有 config 映射`)
  }
  return config
}
