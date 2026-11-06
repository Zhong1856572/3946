// ---------------------------------------------------------------------------
// 安装器三个脚本共用的 CLI 解析与输出helper
// ---------------------------------------------------------------------------

/** 可以重复传多次的参数（后一次追加，不是覆盖） */
const REPEATABLE_KEYS = new Set(['config'])

/** 解析 --key value / --key=value / --flag 形式的参数 */
export function parseArgs(argv) {
  const out = { _: [] }
  const assign = (key, value) => {
    if (REPEATABLE_KEYS.has(key)) {
      if (out[key] === undefined) out[key] = []
      else if (!Array.isArray(out[key])) out[key] = [out[key]]
      out[key].push(value)
      return
    }
    out[key] = value
  }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) { out._.push(token); continue }
    const body = token.slice(2)
    const eq = body.indexOf('=')
    if (eq >= 0) {
      assign(body.slice(0, eq), body.slice(eq + 1))
      continue
    }
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      assign(body, next)
      i += 1
    } else {
      out[body] = true
    }
  }
  return out
}

/** 解析 --config a=1,b=2 */
export function parseConfigOverrides(raw) {
  const result = {}
  if (!raw) return result
  const text = Array.isArray(raw) ? raw.join(',') : String(raw)
  for (const part of text.split(',')) {
    const item = part.trim()
    if (!item) continue
    const eq = item.indexOf('=')
    if (eq < 0) {
      const err = new Error(`--config 的格式应为 key=value，收到：${item}`)
      err.exitCode = 2
      throw err
    }
    result[item.slice(0, eq).trim()] = item.slice(eq + 1).trim()
  }
  return result
}

/** 统一的中文输出 */
export function say(...args) { console.log(...args) }
export function ok(text) { console.log(`  ✔ ${text}`) }
export function warn(text) { console.log(`  ! ${text}`) }
export function fail(text) { console.error(`  ✘ ${text}`) }
export function section(text) { console.log(`\n【${text}】`) }

/** 统一的失败退出 */
export function die(message, code = 1) {
  console.error(`\n✘ 安装器错误：${message}\n`)
  process.exit(code)
}

/** 打印帮助后退出 */
export function printHelp(text) {
  console.log(text)
  process.exit(0)
}
