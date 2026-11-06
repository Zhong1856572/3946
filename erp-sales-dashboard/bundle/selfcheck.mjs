/**
 * selfcheck.mjs —— @local/erp-sales-dashboard（Host 半）自检脚本
 * ============================================================================
 *
 * 用途
 * ---------------------------------------------------------------------------
 * 在插件交付前跑一遍「静态契约检查 + 动态行为检查」，确保：
 *   ① 包元数据（package.json / cordis.patch.yml）与框架约定一致，插件能被 patch 层装载；
 *   ② index.js 的导出面、路由前缀、工具名、并发编排等**硬性约定**没被改坏；
 *   ③ 纯函数（metrics）的边界值算得对 —— 这几个函数是所有派生口径的算术底座，
 *      一旦错了整块看板的数字都会跟着错；
 *   ④ HTTP 路由的降级行为正确：只收 POST、参数错返回 200 + ok:false、未知路由 404、
 *      上游工具全挂时**不整体 reject**（返回 ok:true + warnings）。
 *
 * 运行方式
 * ---------------------------------------------------------------------------
 *   node selfcheck.mjs
 * 退出码 0 = 全部通过；1 = 有失败项（明细见末尾汇总）。
 *
 * 约束
 * ---------------------------------------------------------------------------
 *   · 只用 Node 内置模块（fs / path / url），不引任何第三方依赖；
 *   · 只**读**本目录文件，不改任何东西（不跑 npm/pnpm、不写磁盘缓存）；
 *   · 静态检查读原文用 fs.readFileSync(..., 'utf8')，不经过 PowerShell，避免中文乱码。
 * ============================================================================
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const INDEX_FILE = path.join(HERE, 'index.js')
const PKG_FILE = path.join(HERE, 'package.json')
const PATCH_FILE = path.join(HERE, 'cordis.patch.yml')

/**
 * 动态载入 index.js。
 * 放在顶层（而不是塞进某个检查回调里）有两个原因：
 *   ① 检查回调是同步函数，不能在里面 await；
 *   ② 后面的检查（patch 配置 vs DEFAULTS）也要用到导出面，提前载入一份就够了。
 */
const mod = await import('./index.js')

// ---------------------------------------------------------------------------
// 迷你断言框架：逐项打印 OK/FAIL，最后给汇总 + 退出码
// ---------------------------------------------------------------------------
let total = 0
let failed = 0
const failureList = []

function section(title) {
  process.stdout.write(`\n[${title}]\n`)
}

/** 记录一项通过。 */
function pass(name, detail) {
  total += 1
  process.stdout.write(`  OK    ${name}${detail ? ` — ${detail}` : ''}\n`)
}

/** 记录一项失败（失败项进汇总表）。 */
function fail(name, detail) {
  total += 1
  failed += 1
  failureList.push({ name, detail })
  process.stdout.write(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}\n`)
}

/** 断言条件为真，否则抛错（由 run 捕获）。 */
function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/** 断言严格相等。 */
function assertEqual(actual, expected, message) {
  if (!Object.is(actual, expected)) {
    throw new Error(`${message}｜期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
  }
}

/** 断言近似相等（浮点）。 */
function assertClose(actual, expected, message, tolerance = 1e-9) {
  if (typeof actual !== 'number' || !Number.isFinite(actual) || Math.abs(actual - expected) > tolerance) {
    throw new Error(`${message}｜期望 ≈${expected}，实际 ${JSON.stringify(actual)}`)
  }
}

/** 同步检查：fn 抛错即失败。 */
function run(name, fn) {
  try {
    const detail = fn()
    pass(name, typeof detail === 'string' ? detail : '')
  } catch (error) {
    fail(name, error && error.message ? error.message : String(error))
  }
}

/** 异步检查：await fn()。 */
async function runAsync(name, fn) {
  try {
    const detail = await fn()
    pass(name, typeof detail === 'string' ? detail : '')
  } catch (error) {
    fail(name, error && error.message ? error.message : String(error))
  }
}

/**
 * 抹掉注释与字符串字面量，只留「真实代码」。
 *
 * 为什么要这么较真：静态检查问的是「代码里有没有做某事」，
 * 不是「文件里有没有出现过这几个字」。
 *   · 文件头注释里写着「禁止 export const Config」—— 那是说明，不是导出；
 *   · matrix 的 result 文案里提到上游 signing_completion_rate —— 那是告诉用户
 *     「为什么这个数不用上游值」，也不是把它当结果用。
 * 不做这个区分，检查就会变成噪音，久了就没人看它了。
 */
function stripCommentsAndStrings(source) {
  let out = ''
  let i = 0
  const n = source.length
  while (i < n) {
    const ch = source[i]
    const next = source[i + 1]
    if (ch === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i += 1
      i += 2
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      i += 1
      while (i < n && source[i] !== quote) {
        if (source[i] === '\\') i += 1
        i += 1
      }
      i += 1
      out += ' '
      continue
    }
    out += ch
    i += 1
  }
  return out
}

// ---------------------------------------------------------------------------
// 极简 YAML 解析器放在 lib/mini-yaml.mjs（selfcheck 与 verify-host 共用同一份，
// 免得两边各抄一份、各写一份配置，改了 cordis.patch.yml 就漂移）。
// 支持：注释行、缩进映射 `key: value`、序列 `- item`、
//       序列项内联映射 `- id: xxx`、嵌套块、行尾注释、单双引号标量。
// 不支持：锚点/多行标量/流式集合 —— 本文件用不到，也不该引入第三方解析器。
const { parseMiniYaml, readPluginConfig } = await import('./lib/mini-yaml.mjs')

/**
 * 在 cordis.patch.yml 全文里找出某个插件的 config 映射，**两种结构都认**：
 *   ① bundle 里的写法：顶层序列 → `- insert: [{ id, name, config }]`
 *   ② profile 里的写法：顶层序列 → 每个插件一项 `- id: xxx / name: xxx / config: {...}`
 * readPluginConfig 只认 ①，对 ② 会抛「找不到 id=... 的条目」，
 * 所以校验「两份 patch 必须同步」时要用这个兼容两种结构的版本。
 */
function findPluginConfig(text, pluginId) {
  const parsed = parseMiniYaml(text)
  const list = Array.isArray(parsed) ? parsed : []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    if (item.id === pluginId) return item.config || null
    const insert = Array.isArray(item.insert) ? item.insert : []
    const hit = insert.find((entry) => entry && entry.id === pluginId)
    if (hit) return hit.config || null
  }
  return null
}

// ---------------------------------------------------------------------------
// 读取被检查文件
// ---------------------------------------------------------------------------
const indexSource = fs.readFileSync(INDEX_FILE, 'utf8')
const pkgText = fs.readFileSync(PKG_FILE, 'utf8')
const patchText = fs.readFileSync(PATCH_FILE, 'utf8')

// ===========================================================================
// 1. package.json
// ===========================================================================
section('1. package.json 元数据')

let pkg = null
run('package.json 可被 JSON.parse 解析', () => {
  pkg = JSON.parse(pkgText)
  assert(pkg && typeof pkg === 'object', '解析结果不是对象')
  return `name=${pkg.name}`
})

run('包名为 @local/erp-sales-dashboard', () => {
  assertEqual(pkg.name, '@local/erp-sales-dashboard', '包名不符')
  return pkg.name
})

run('type 为 module（ESM）', () => {
  assertEqual(pkg.type, 'module', 'type 不符')
  return 'module'
})

run('exports["."] 指向 ./index.js', () => {
  assertEqual(pkg.exports['.'], './index.js', 'exports["."] 不符')
  return './index.js'
})

run('exports["./client"] 指向 ./client.js', () => {
  assertEqual(pkg.exports['./client'], './client.js', 'exports["./client"] 不符')
  return './client.js'
})

run('exports 暴露 locale/*.json 与 ./icon', () => {
  assert(typeof pkg.exports['./locale/*.json'] === 'string', '缺少 locale 导出')
  assert(typeof pkg.exports['./icon'] === 'string', '缺少 icon 导出')
  return 'locale/*.json + ./icon'
})

run('dsh.bundle.patch 指向 ./cordis.patch.yml', () => {
  assert(pkg.dsh && pkg.dsh.bundle, '缺少 dsh.bundle')
  assertEqual(pkg.dsh.bundle.patch, './cordis.patch.yml', 'dsh.bundle.patch 不符')
  return './cordis.patch.yml'
})

run('dsh.client 为 web 平台且立即装载', () => {
  assert(pkg.dsh && pkg.dsh.client, '缺少 dsh.client')
  assertEqual(pkg.dsh.client.platform, 'web', 'dsh.client.platform 不符')
  assertEqual(pkg.dsh.client.immediately, true, 'dsh.client.immediately 不符')
  assert(Array.isArray(pkg.dsh.client.inject), 'dsh.client.inject 必须是数组')
  return 'platform=web, immediately=true'
})

// ===========================================================================
// 2. cordis.patch.yml
// ===========================================================================
section('2. cordis.patch.yml 解析')

let patch = null
run('cordis.patch.yml 能被极简 YAML 解析器解析', () => {
  patch = parseMiniYaml(patchText)
  assert(patch !== null && patch !== undefined, '解析结果为空')
  return Array.isArray(patch) ? `顶层 ${patch.length} 个条目` : '顶层为映射'
})

run('顶层是序列且只有一个条目', () => {
  assert(Array.isArray(patch), '顶层不是序列')
  assertEqual(patch.length, 1, '顶层条目数不符')
  return '1 个条目'
})

run('条目内含 insert 序列', () => {
  const entry = patch[0]
  assert(entry && typeof entry === 'object', '条目不是映射')
  assert(Array.isArray(entry.insert), 'insert 不是序列')
  assertEqual(entry.insert.length, 1, 'insert 条目数不符')
  return 'insert: 1 个插件'
})

run('insert[0].id = erp-sales-dashboard', () => {
  assertEqual(patch[0].insert[0].id, 'erp-sales-dashboard', 'id 不符')
  return 'erp-sales-dashboard'
})

run('insert[0].name = @local/erp-sales-dashboard', () => {
  assertEqual(patch[0].insert[0].name, '@local/erp-sales-dashboard', 'name 不符')
  return '@local/erp-sales-dashboard'
})

run('insert[0].config 的键集合与 index.js 的 DEFAULTS 对齐（不多不少）', () => {
  const cfg = patch[0].insert[0].config
  assert(cfg && typeof cfg === 'object', 'config 不是映射')
  const keys = Object.keys(cfg).sort()
  // patch 里出现的每个键都必须在 DEFAULTS 里有同名项，否则配置会被静默忽略。
  const defaults = Object.keys(mod.DEFAULTS).sort()
  const unknown = keys.filter((k) => !defaults.includes(k))
  assertEqual(JSON.stringify(unknown), JSON.stringify([]), 'patch 里有 DEFAULTS 不认识的键')
  // 关键口径键必须出现（少了就退回默认值，属于配置漂移）。
  for (const required of [
    'cacheTtlMs',
    'requestTimeoutMs',
    'rowLimit',
    'stdProbeBudget',
    'stdProbeBudgetMs',
    'tierSampleSize',
    'customerSampleSize',
    'visitSampleSize',
    'exhaustiveBudget',
    'salesFirstDepName',
    'newbieTargetAmount',
    'thresholds',
    'aiProvider',
    'aiModel',
  ]) {
    assert(Object.prototype.hasOwnProperty.call(cfg, required), `patch 缺少配置项 ${required}`)
  }
  return `${keys.length} 个配置键：${keys.join(',')}`
})

run('patch 里的 thresholds 全部是合法比率（0~1），且不破坏内置默认口径', () => {
  const th = patch[0].insert[0].config.thresholds
  assert(th && typeof th === 'object', 'thresholds 不是映射')
  for (const [key, value] of Object.entries(th)) {
    assert(typeof value === 'number' && Number.isFinite(value), `thresholds.${key} 不是有限数字`)
    assert(value >= 0 && value <= 1, `thresholds.${key} = ${value} 越界（必须 0~1）`)
  }
  // patch 里写的阈值必须与 resolveThresholds 解析结果一致（证明配置真的能落到运行时）。
  const resolved = mod.resolveThresholds(th)
  for (const [key, value] of Object.entries(th)) {
    assertEqual(resolved[key], value, `thresholds.${key} 解析后与配置不一致`)
  }
  return `thresholds 生效：${Object.entries(th).map(([k, v]) => k + '=' + v).join(', ')}`
})

run('patch 的基线参数与 index.js 的 DEFAULTS 一致，抽样参数允许覆盖', () => {
  const cfg = patch[0].insert[0].config
  // 基线参数：缓存 / 超时 / 行数 / 预算 —— 这些是「口径底线」，patch 必须与 DEFAULTS 一致，
  // 否则同一份代码在不同环境下会算出不同的数，事后没人说得清用的是哪套参数。
  const baseline = ['cacheTtlMs', 'requestTimeoutMs', 'rowLimit', 'exhaustiveBudget']
  const mismatched = []
  for (const key of baseline) {
    if (!Object.is(Number(cfg[key]), Number(mod.DEFAULTS[key]))) {
      mismatched.push(`${key}: patch=${cfg[key]} defaults=${mod.DEFAULTS[key]}`)
    }
  }
  assert(mismatched.length === 0, `基线参数不一致 → ${mismatched.join('; ')}`)
  // 抽样参数（抽样家数 / STD 探测预算）是**部署侧可调**的：patch 允许覆盖 DEFAULTS，
  // 但必须是正整数，且必须在 DEFAULTS 里存在这个键（防止拼错键名后静默失效）。
  const overridable = ['tierSampleSize', 'customerSampleSize', 'visitSampleSize', 'stdProbeBudget']
  for (const key of overridable) {
    assert(key in mod.DEFAULTS, `DEFAULTS 里没有可覆盖键 ${key}`)
    const value = Number(cfg[key])
    assert(Number.isInteger(value) && value > 0, `patch 的 ${key} 必须为正整数，实际 ${cfg[key]}`)
  }
  const overrides = overridable.filter((key) => !Object.is(Number(cfg[key]), Number(mod.DEFAULTS[key])))
  return `基线 4 项一致；抽样参数覆盖 ${overrides.length} 项（${overrides.join(',') || '无'}）`
})

run('verify-host.mjs 直接读 cordis.patch.yml 取生产配置（不手抄，避免配置漂移）', () => {
  const verifySource = fs.readFileSync(path.join(HERE, 'selfcheck.mjs'), 'utf8')
  const verifyFile = path.join(HERE, 'verify-host.mjs')
  assert(fs.existsSync(verifyFile), '找不到 verify-host.mjs')
  const text = fs.readFileSync(verifyFile, 'utf8')
  assert(text.includes('readPluginConfig'), 'verify-host.mjs 没有用 readPluginConfig 读生产配置')
  assert(!/const config = \{\s*cacheTtlMs: 0,/.test(text), 'verify-host.mjs 里仍手抄了一份配置')
  return 'verify-host.mjs 与 selfcheck.mjs 共用 lib/mini-yaml.mjs 的同一份生产配置'
})

run('lib/mini-yaml.mjs 能读出 patch 的完整 config（键数与 DEFAULTS 一致 + thresholds 子映射）', () => {
  const cfg = readPluginConfig(patchText)
  const keys = Object.keys(cfg).sort()
  // 键数不写死：必须与 index.js DEFAULTS 的键集合完全一致（多一个少一个都算错）。
  const defaultKeys = Object.keys(mod.DEFAULTS).sort()
  const missing = defaultKeys.filter((k) => !keys.includes(k))
  const extra = keys.filter((k) => !defaultKeys.includes(k))
  assertEqual(missing.length, 0, `patch 缺少 DEFAULTS 的配置键：${missing.join(',')}`)
  assertEqual(extra.length, 0, `patch 出现 DEFAULTS 里没有的配置键：${extra.join(',')}`)
  assert(cfg.thresholds && typeof cfg.thresholds === 'object', 'thresholds 不是映射')
  assert(Object.prototype.hasOwnProperty.call(cfg.thresholds, 'stdShare'), 'thresholds 缺 stdShare')
  assertEqual(cfg.salesFirstDepName, '业务咨询事业群', 'salesFirstDepName 不符')
  assertEqual(cfg.newbieTargetAmount, 200000, 'newbieTargetAmount 不符')
  return `${keys.length} 个键（与 DEFAULTS 完全一致）；thresholds=${JSON.stringify(cfg.thresholds)}`
})

// ===========================================================================
// 3. index.js 静态检查
// ===========================================================================
section('3. index.js 静态检查')

run('index.js 非空且以 ESM 语法导出', () => {
  assert(indexSource.length > 1000, '文件过小，可能未写完')
  assert(/export\s+(const|function)\s+/.test(indexSource), '没有找到 ESM 导出')
  return `${indexSource.split('\n').length} 行`
})

run('**不导出 Config**（框架会对 export const Config 调 Config.validate 而崩溃）', () => {
  // 只看**真实代码**：注释里写的「禁止 export const Config」是说明文字，不是导出。
  // 所以先把注释和字符串字面量抹掉再找，避免把说明当违规。
  const code = stripCommentsAndStrings(indexSource)
  assert(!/export\s+const\s+Config\b/.test(code), '存在 export const Config')
  assert(!/export\s*\{[^}]*\bConfig\b[^}]*\}/.test(code), '存在 export { Config }')
  assert(!/export\s+(function|class|let|var)\s+Config\b/.test(code), '存在其它形式的 Config 导出')
  return '未导出 Config（注释/字符串中的同名字样不计）'
})

run('导出 inject = ["tools", "webServer"]', () => {
  assert(/export\s+const\s+inject\s*=\s*\[[^\]]*'tools'[^\]]*'webServer'[^\]]*\]/.test(indexSource), 'inject 声明不符')
  return "['tools', 'webServer']"
})

run('导出 DEFAULTS 且含 8 个配置键', () => {
  assert(/export\s+const\s+DEFAULTS\s*=/.test(indexSource), '未导出 DEFAULTS')
  for (const key of [
    'cacheTtlMs',
    'requestTimeoutMs',
    'rowLimit',
    'stdProbeBudget',
    'tierSampleSize',
    'customerSampleSize',
    'visitSampleSize',
    'exhaustiveBudget',
  ]) {
    assert(new RegExp(`\\b${key}\\s*:`).test(indexSource), `DEFAULTS 缺少 ${key}`)
  }
  return '8 个键齐全'
})

run('导出 apply(ctx, config)', () => {
  assert(/export\s+function\s+apply\s*\(\s*ctx\s*,\s*config\s*\)/.test(indexSource), '未导出 apply(ctx, config)')
  return 'apply(ctx, config)'
})

run('导出纯函数集合 metrics', () => {
  assert(/export\s+const\s+metrics\s*=\s*\{/.test(indexSource), '未导出 metrics')
  for (const key of ['ratio', 'clamp01', 'safeDiv', 'sumBy', 'groupSum', 'bucketAging', 'pctChange', 'weightedShare']) {
    assert(new RegExp(`\\b${key}\\b`).test(indexSource), `metrics 缺少 ${key}`)
  }
  return 'ratio/clamp01/safeDiv/sumBy/groupSum/bucketAging/pctChange/weightedShare'
})

run('路由前缀字面量 /erp-sales-dashboard/api', () => {
  assert(
    /path\s*:\s*['"]\/erp-sales-dashboard\/api['"]/.test(indexSource),
    "未找到 path: '/erp-sales-dashboard/api'",
  )
  return '/erp-sales-dashboard/api'
})

run('使用 mcp__erp__ 全前缀工具名', () => {
  const hits = indexSource.match(/mcp__erp__[a-z_]+/g) || []
  const unique = [...new Set(hits)]
  assert(unique.length >= 6, `只找到 ${unique.length} 个 mcp__erp__ 工具名`)
  return `${unique.length} 个：${unique.slice(0, 3).join(', ')} …`
})

run('使用 mcp__std__ 全前缀工具名', () => {
  const hits = indexSource.match(/mcp__std__[a-z_]+/g) || []
  const unique = [...new Set(hits)]
  assert(unique.length >= 2, `只找到 ${unique.length} 个 mcp__std__ 工具名`)
  return unique.join(', ')
})

run('并发取数使用 Promise.allSettled（单源失败不整体 reject）', () => {
  assert(indexSource.includes('Promise.allSettled'), '未使用 Promise.allSettled')
  return 'Promise.allSettled'
})

run('通过 ctx.tools.execute 调用 MCP，callId 带插件前缀', () => {
  assert(/ctx\.tools\.execute\s*\(/.test(indexSource), '未调用 ctx.tools.execute')
  assert(/erp-sales-dashboard:\$\{name\}|erp-sales-dashboard:/.test(indexSource), 'callId 未带 erp-sales-dashboard 前缀')
  return 'ctx.tools.execute + callId 前缀'
})

run('单次调用带 AbortSignal.timeout 超时', () => {
  assert(/AbortSignal\.timeout\s*\(/.test(indexSource), '未使用 AbortSignal.timeout')
  return 'AbortSignal.timeout'
})

run('完成率自算：未把上游 signing_completion_rate 当结果用（只允许出现在注释/说明文字里）', () => {
  // 上游 signing_completion_rate 是百分数（实测 114.71）且分母是年度目标，
  // CONTRACT §6 明确要求完成率自算。所以**代码里**不允许出现这个字段名。
  // 但注释和 matrix 的说明文字里提到它（说明「为什么不用它」）是必要且正确的，
  // 所以先把注释与字符串字面量抹掉，只在真实代码里找。
  const code = stripCommentsAndStrings(indexSource)
  const offending = code
    .split('\n')
    .map((line, index) => ({ line, index: index + 1 }))
    .filter(({ line }) => line.includes('signing_completion_rate'))
  assert(offending.length === 0, `第 ${offending.map((o) => o.index).join(', ')} 行在代码里用了上游完成率`)
  return '仅出现在注释/说明文字中'
})

run('只依赖 Node 内置模块（无第三方依赖）', () => {
  const specs = [...indexSource.matchAll(/(?:^|\n)\s*import\s[^'"]*['"]([^'"]+)['"]/g)].map((m) => m[1])
  assert(specs.length > 0, '没有找到 import 语句')
  const external = specs.filter((spec) => !spec.startsWith('node:') && !spec.startsWith('./') && !spec.startsWith('../'))
  assert(external.length === 0, `发现第三方依赖：${external.join(', ')}`)
  return specs.join(', ')
})

run('文件是 UTF-8 且中文注释未乱码（无 U+FFFD）', () => {
  assert(!indexSource.includes('\uFFFD'), '文件含替换字符 U+FFFD（编码已损坏）')
  const cjk = indexSource.match(/[\u4e00-\u9fa5]/g) || []
  assert(cjk.length > 200, `中文字符只有 ${cjk.length} 个，疑似乱码或注释缺失`)
  return `${cjk.length} 个中文字符`
})

run('契约要求的响应字段名全部出现在源码中', () => {
  const required = [
    'generatedAt',
    'period',
    'filters',
    'meta',
    'northStar',
    'overview',
    'quality',
    'collection',
    'customer',
    'funnel',
    'growth',
    'todo',
    'matrix',
    'calls',
    'warnings',
  ]
  const missing = required.filter((key) => !indexSource.includes(key))
  assert(missing.length === 0, `缺少字段：${missing.join(', ')}`)
  return `${required.length} 个顶层字段`
})

run('matrix 状态只用「可用 / 部分可用 / 不可用」三档', () => {
  const found = [...new Set(indexSource.match(/'(可用|部分可用|不可用)'/g) || [])].map((s) => s.slice(1, -1))
  const allowed = new Set(['可用', '部分可用', '不可用'])
  const illegal = found.filter((s) => !allowed.has(s))
  assert(illegal.length === 0, `出现非法状态：${illegal.join(', ')}`)
  return found.sort().join(' / ')
})

// ===========================================================================
// 4. 动态 import 与导出面
// ===========================================================================
section('4. 动态 import 与导出面')

run("动态 import('./index.js') 成功", () => {
  assert(mod && typeof mod === 'object', '模块导出为空')
  return `导出 ${Object.keys(mod).sort().join(', ')}`
})

run('inject 含 tools 与 webServer', () => {
  assert(Array.isArray(mod.inject), 'inject 不是数组')
  assert(mod.inject.includes('tools'), 'inject 缺 tools')
  assert(mod.inject.includes('webServer'), 'inject 缺 webServer')
  return JSON.stringify(mod.inject)
})

run('DEFAULTS 含全部键且取值符合约定', () => {
  assert(mod.DEFAULTS && typeof mod.DEFAULTS === 'object', 'DEFAULTS 不是对象')
  const expected = {
    cacheTtlMs: 21600000,
    requestTimeoutMs: 30000,
    rowLimit: 100,
    stdProbeBudget: 150,
    stdSigningMonthsMax: 4,
    stdSigningShipBudgetMs: 45000,
    tierSampleSize: 12,
    customerSampleSize: 12,
    visitSampleSize: 10,
    exhaustiveBudget: 120,
  }
  for (const [key, value] of Object.entries(expected)) {
    assert(Object.is(mod.DEFAULTS[key], value), `${key} 期望 ${value}，实际 ${mod.DEFAULTS[key]}`)
  }
  return JSON.stringify(expected)
})

run('apply 是函数', () => {
  assertEqual(typeof mod.apply, 'function', 'apply 不是函数')
  return 'function'
})

run('**没有导出 Config**', () => {
  assert(!('Config' in mod), '模块导出了 Config')
  assertEqual(mod.Config, undefined, 'mod.Config 不是 undefined')
  return '未导出 Config'
})

run('metrics 是对象且含全部纯函数', () => {
  assert(mod.metrics && typeof mod.metrics === 'object', 'metrics 不是对象')
  const keys = ['ratio', 'clamp01', 'safeDiv', 'sumBy', 'groupSum', 'bucketAging', 'pctChange', 'weightedShare']
  for (const key of keys) {
    assertEqual(typeof mod.metrics[key], 'function', `metrics.${key} 不是函数`)
  }
  return keys.join(', ')
})

run('metrics 不含 Config / apply 等非纯函数', () => {
  assert(!('Config' in mod.metrics), 'metrics 里有 Config')
  assert(!('apply' in mod.metrics), 'metrics 里有 apply')
  return 'metrics 纯函数集合'
})

// ===========================================================================
// 5. 纯函数用例
// ===========================================================================
section('5. metrics 纯函数用例')

const m = mod.metrics

run('ratio(1, 0) = null（分母非正 → 不可计算，不是 0）', () => {
  assertEqual(m.ratio(1, 0), null, 'ratio(1,0)')
  return 'null'
})

run('ratio(1, 2) = 0.5；ratio(3, 2) = 1.5（可大于 1，不做 clamp）', () => {
  assertEqual(m.ratio(1, 2), 0.5, 'ratio(1,2)')
  assertEqual(m.ratio(3, 2), 1.5, 'ratio(3,2)')
  return '0.5 / 1.5'
})

run('safeDiv(1, 0) = null；safeDiv(5, 2) = 2.5', () => {
  assertEqual(m.safeDiv(1, 0), null, 'safeDiv(1,0)')
  assertEqual(m.safeDiv(5, 2), 2.5, 'safeDiv(5,2)')
  return 'null / 2.5'
})

run('clamp01(2) = 1；clamp01(-1) = 0；clamp01(0.5) = 0.5', () => {
  assertEqual(m.clamp01(2), 1, 'clamp01(2)')
  assertEqual(m.clamp01(-1), 0, 'clamp01(-1)')
  assertEqual(m.clamp01(0.5), 0.5, 'clamp01(0.5)')
  return '1 / 0 / 0.5'
})

run('clamp01(null) = null（不可算不是 0）', () => {
  assertEqual(m.clamp01(null), null, 'clamp01(null)')
  return 'null'
})

run('bucketAging 边界：0/30 → 30天内，31/60 → 31-60天，61/90 → 61-90天，91 → 90天以上', () => {
  assertEqual(m.bucketAging(0), '30天内', 'bucketAging(0)')
  assertEqual(m.bucketAging(30), '30天内', 'bucketAging(30)')
  assertEqual(m.bucketAging(31), '31-60天', 'bucketAging(31)')
  assertEqual(m.bucketAging(60), '31-60天', 'bucketAging(60)')
  assertEqual(m.bucketAging(61), '61-90天', 'bucketAging(61)')
  assertEqual(m.bucketAging(90), '61-90天', 'bucketAging(90)')
  assertEqual(m.bucketAging(91), '90天以上', 'bucketAging(91)')
  return '7 个边界点全对'
})

run('bucketAging(null) = null', () => {
  assertEqual(m.bucketAging(null), null, 'bucketAging(null)')
  return 'null'
})

run('sumBy 求和', () => {
  assertEqual(m.sumBy([{ v: 1 }, { v: 2 }, { v: 3 }], (r) => r.v), 6, 'sumBy')
  assertEqual(m.sumBy(null, (r) => r.v), 0, 'sumBy(null)')
  return '6 / 非数组→0'
})

run('groupSum 分组求和返回 Map', () => {
  const map = m.groupSum(
    [
      { k: 'a', v: 1 },
      { k: 'a', v: 2 },
      { k: 'b', v: 5 },
    ],
    (r) => r.k,
    (r) => r.v,
  )
  assert(map instanceof Map, 'groupSum 未返回 Map')
  assertEqual(map.get('a'), 3, "groupSum('a')")
  assertEqual(map.get('b'), 5, "groupSum('b')")
  return "a=3, b=5"
})

run('pctChange(120, 100) ≈ 0.2；pctChange(80, 100) ≈ -0.2；基期 0 → null', () => {
  assertClose(m.pctChange(120, 100), 0.2, 'pctChange(120,100)')
  assertClose(m.pctChange(80, 100), -0.2, 'pctChange(80,100)')
  assertEqual(m.pctChange(100, 0), null, 'pctChange(100,0)')
  return '±0.2 / null'
})

run('weightedShare 按权重加权', () => {
  const value = m.weightedShare(
    [
      { w: 1, v: 10 },
      { w: 3, v: 20 },
    ],
    (r) => r.w,
    (r) => r.v,
  )
  assertClose(value, (10 * 1 + 20 * 3) / 4, 'weightedShare')
  assertEqual(m.weightedShare([], (r) => r.w, (r) => r.v), null, 'weightedShare([])')
  return '17.5 / 空→null'
})

run('countBy 计数', () => {
  assertEqual(m.countBy([1, 2, 3], (x) => x > 1), 2, 'countBy')
  assertEqual(m.countBy(null), 0, 'countBy(null)')
  return '2 / 非数组→0'
})

run('uniqueCount 去重计数（空键不计）', () => {
  assertEqual(m.uniqueCount([{ id: 'a' }, { id: 'a' }, { id: 'b' }], (r) => r.id), 2, 'uniqueCount')
  assertEqual(m.uniqueCount([{ id: '' }, { id: null }], (r) => r.id), 0, 'uniqueCount 空键')
  return '2 / 0'
})

run('uniqueStrings 去重并保持顺序', () => {
  assertEqual(JSON.stringify(m.uniqueStrings(['a', 'a', '', null, 'b'])), JSON.stringify(['a', 'b']), 'uniqueStrings')
  return "['a','b']"
})

run('diffDays 计算区间天数', () => {
  assertEqual(m.diffDays('2026-01-01', '2026-01-31'), 30, 'diffDays')
  assertEqual(m.diffDays('2026-01-01', '2026-01-01'), 0, 'diffDays 同日')
  assertEqual(m.diffDays('bad', '2026-01-01'), null, 'diffDays 非法')
  return '30 / 0 / null'
})

run('addDays 跨月加天数', () => {
  assertEqual(m.addDays('2026-01-31', 1), '2026-02-01', 'addDays')
  assertEqual(m.addDays('2026-01-01', 0), '2026-01-01', 'addDays 0 天')
  return '2026-02-01'
})

run('shiftYears 去年同期（闰日退到月末）', () => {
  // 约定：years 为正数表示**往前推**（1 = 去年同期，2 = 前年同期），
  // 与 index.js 内部的调用点一致（shiftYears(startDate, 1)）。
  assertEqual(m.shiftYears('2026-01-01', 1), '2025-01-01', 'shiftYears 去年')
  assertEqual(m.shiftYears('2026-02-29', 1), '2025-02-28', 'shiftYears 闰日')
  assertEqual(m.shiftYears('2026-01-01', 2), '2024-01-01', 'shiftYears 前年')
  return '2025-01-01 / 2025-02-28 / 2024-01-01'
})

run('dateOnly / monthKey 归一化时间字段', () => {
  assertEqual(m.dateOnly('2026-01-01 13:00:45'), '2026-01-01', 'dateOnly')
  assertEqual(m.dateOnly(null), null, 'dateOnly(null)')
  assertEqual(m.monthKey('2026-01-01 13:00:45'), '2026-01', 'monthKey')
  assertEqual(m.monthKey('bad'), null, 'monthKey 非法')
  return "2026-01-01 / 2026-01"
})

run('num / str / numOrNull 的三态语义', () => {
  assertEqual(m.num('12.5'), 12.5, "num('12.5')")
  assertEqual(m.num(null), 0, 'num(null)')
  assertEqual(m.str('a'), 'a', "str('a')")
  assertEqual(m.str(null), null, 'str(null)')
  assertEqual(m.numOrNull('abc'), null, "numOrNull('abc')")
  assertEqual(m.numOrNull('3'), 3, "numOrNull('3')")
  assertEqual(m.numOrNull(''), null, "numOrNull('')")
  return 'num:0 兜底 / str:null 保留 / numOrNull:null 不冒充'
})

// ===========================================================================
// 6. apply 与 HTTP 路由行为（用假 ctx，不打真实 MCP、不写磁盘缓存）
// ===========================================================================
section('6. apply 与路由行为')

/** 构造一个最小可用的假 ctx：webServer.register 收集注册项，tools.execute 全部报错。 */
function makeCtx(executeImpl) {
  const registrations = []
  return {
    registrations,
    ctx: {
      get(name) {
        if (name === 'webServer') {
          return {
            register(config) {
              registrations.push(config)
              return { dispose() {} }
            },
          }
        }
        if (name === 'agents') return { list: () => [] }
        return undefined
      },
      effect(fn) {
        fn()
      },
      tools: {
        execute: executeImpl || (async () => ({ isError: true, error: { code: 'UNKNOWN_TOOL', message: 'unknown tool' } })),
      },
    },
  }
}

let registration = null
run('apply 注册了 1 个 prefix 路由，路径正确', () => {
  const harness = makeCtx()
  // cacheTtlMs=0 → 不建磁盘缓存写入器，保证自检不写任何文件
  mod.apply(harness.ctx, { cacheTtlMs: 0 })
  assertEqual(harness.registrations.length, 1, '注册数量不符')
  registration = harness.registrations[0]
  assertEqual(registration.kind, 'prefix', "kind 不是 'prefix'")
  assertEqual(registration.path, '/erp-sales-dashboard/api', 'path 不符')
  assertEqual(typeof registration.handler, 'function', 'handler 不是函数')
  return "kind=prefix, path=/erp-sales-dashboard/api"
})

run('apply 在 webServer 缺失时不抛错（只告警）', () => {
  const broken = {
    get() {
      return undefined
    },
    effect() {
      throw new Error('不应执行 effect')
    },
    tools: { execute: async () => ({}) },
  }
  mod.apply(broken, { cacheTtlMs: 0 })
  return '未抛异常'
})

run('apply 在 config 为 null / 非对象时不抛错', () => {
  const harness = makeCtx()
  mod.apply(harness.ctx, null)
  mod.apply(harness.ctx, 'not-an-object')
  assertEqual(harness.registrations.length, 2, '两次 apply 应注册两次')
  return '两次均注册成功'
})

/** 构造假 req / res，驱动 handler。 */
function makeReq(method, url, bodyText = '') {
  return {
    method,
    url,
    on(event, cb) {
      if (event === 'data') cb(Buffer.from(bodyText, 'utf8'))
      else if (event === 'end') cb()
    },
    destroy() {},
  }
}

function makeRes() {
  const state = { status: 0, headers: null, body: null }
  return {
    state,
    writeHead(status, headers) {
      state.status = status
      state.headers = headers
    },
    end(body) {
      state.body = body
    },
  }
}

async function callHandler(method, url, bodyText) {
  const res = makeRes()
  await registration.handler(makeReq(method, url, bodyText), res)
  let parsed = null
  try {
    parsed = JSON.parse(res.state.body)
  } catch {
    parsed = null
  }
  return { status: res.state.status, body: parsed }
}

await runAsync('只接受 POST：GET /dashboard → 404', async () => {
  const result = await callHandler('GET', '/erp-sales-dashboard/api/dashboard')
  assertEqual(result.status, 404, '状态码不符')
  assertEqual(result.body.ok, false, 'ok 不符')
  return '404 + ok:false'
})

await runAsync('未知路由 → 404', async () => {
  const result = await callHandler('POST', '/erp-sales-dashboard/api/unknown-route', '{}')
  assertEqual(result.status, 404, '状态码不符')
  assertEqual(result.body.ok, false, 'ok 不符')
  return '404 + ok:false'
})

await runAsync('参数非法（日期格式错）→ 200 + ok:false（不 500）', async () => {
  const result = await callHandler(
    'POST',
    '/erp-sales-dashboard/api/dashboard',
    JSON.stringify({ startDate: '2026/01/01', endDate: '2026-10-25' }),
  )
  assertEqual(result.status, 200, '状态码不符')
  assertEqual(result.body.ok, false, 'ok 不符')
  assert(String(result.body.error).includes('startDate'), '错误信息未指出 startDate')
  return `200 + ok:false（${String(result.body.error).slice(0, 48)}…）`
})

await runAsync('区间非法（startDate > endDate）→ 200 + ok:false', async () => {
  const result = await callHandler(
    'POST',
    '/erp-sales-dashboard/api/dashboard',
    JSON.stringify({ startDate: '2026-10-25', endDate: '2026-01-01' }),
  )
  assertEqual(result.status, 200, '状态码不符')
  assertEqual(result.body.ok, false, 'ok 不符')
  return '200 + ok:false'
})

await runAsync('请求体 JSON 非法 → 200 + ok:false', async () => {
  const result = await callHandler('POST', '/erp-sales-dashboard/api/dashboard', '{ not json')
  assertEqual(result.status, 200, '状态码不符')
  assertEqual(result.body.ok, false, 'ok 不符')
  return '200 + ok:false'
})

await runAsync('上游工具全部失败 → 整体不 reject：ok:true + warnings + calls[].ok=false', async () => {
  const harness = makeCtx(async () => ({
    isError: true,
    error: { code: 'UNKNOWN_TOOL', message: 'unknown tool' },
  }))
  mod.apply(harness.ctx, { cacheTtlMs: 0 })
  const handler = harness.registrations[0].handler
  const res = makeRes()
  await handler(
    makeReq(
      'POST',
      '/erp-sales-dashboard/api/dashboard',
      JSON.stringify({ startDate: '2026-01-01', endDate: '2026-10-25' }),
    ),
    res,
  )
  const body = JSON.parse(res.state.body)
  assertEqual(res.state.status, 200, '状态码不符')
  assertEqual(body.ok, true, '整体不应 reject（ok 应为 true）')
  assert(Array.isArray(body.warnings) && body.warnings.length > 0, 'warnings 为空')
  assert(Array.isArray(body.calls) && body.calls.length > 0, 'calls 为空')
  const failedCalls = body.calls.filter((c) => c.ok === false)
  assert(failedCalls.length > 0, 'calls 中没有 ok:false 的条目')
  assert(typeof body.matrix === 'object' && Array.isArray(body.matrix), 'matrix 缺失')
  return `200 + ok:true，${body.warnings.length} 条告警，${failedCalls.length}/${body.calls.length} 个工具失败`
})

await runAsync('工具名必须是全前缀（callId 带插件前缀，工具名带 mcp__ 头）', async () => {
  const seen = []
  const harness = makeCtx(async (payload) => {
    seen.push(payload.name)
    return { isError: true, error: { code: 'UNKNOWN_TOOL', message: 'unknown tool' } }
  })
  mod.apply(harness.ctx, { cacheTtlMs: 0 })
  const res = makeRes()
  await harness.registrations[0].handler(
    makeReq(
      'POST',
      '/erp-sales-dashboard/api/dashboard',
      JSON.stringify({ startDate: '2026-01-01', endDate: '2026-10-25' }),
    ),
    res,
  )
  assert(seen.length > 0, '一次工具调用都没发生')
  // 形态：mcp__<连接器名>__<工具名>，连接器名可以是任意合法标识（换设备会变）。
  const badShape = seen.filter((name) => !/^mcp__[a-z0-9_-]+__[a-z0-9_]+$/.test(name))
  assert(badShape.length === 0, `工具名不是完整前缀形态：${badShape.join(', ')}`)
  // 首选前缀：必须是 erp / std（其它分组只在首选不可见时才作为兜底被试）。
  const firstPerTool = new Map()
  for (const name of seen) {
    const tool = name.split('__').slice(2).join('__')
    if (!firstPerTool.has(tool)) firstPerTool.set(tool, name)
  }
  const badPrimary = [...firstPerTool.values()].filter((n) => !/^mcp__(erp|std)__/.test(n))
  assert(badPrimary.length === 0, `首选前缀不是 erp/std：${badPrimary.join(', ')}`)
  // 兜底：首选不可见时应继续试别的连接器前缀（换设备 / 连接器改名场景）。
  const fallbacks = seen.filter((n) => !/^mcp__(erp|std)__/.test(n))
  assert(fallbacks.length > 0, '首选不可见时没有尝试兜底前缀')
  return `${seen.length} 次调用：首选 ${firstPerTool.size} 个工具为 mcp__erp__*/mcp__std__*，兜底前缀再试 ${fallbacks.length} 次`
})

// ===========================================================================
// 7. 口径形状自检（Client 半与 Host 半之间的字段契约）
// ===========================================================================
// 这一节检查的是「字段形状」，不是数值：
// 抽样口径警告必须挂在**父对象**上，客户端的抽样提示组件才认；
// 挂成裸数组或挂到每一行，前端拿不到，用户就会把样本当全量读。
section('7. 口径形状自检')

run('collection.aging / collection.overdue 下发为对象（抽样口径挂在父对象上）', () => {
  assert(/aging:\s*agingBlock/.test(indexSource), 'collection.aging 不是对象赋值')
  assert(/overdue:\s*overdueBlock/.test(indexSource), 'collection.overdue 不是对象赋值')
  assert(!/aging:\s*agingRowsSampled/.test(indexSource), 'collection.aging 仍是裸数组')
  assert(!/overdue:\s*overdueRowsSampled/.test(indexSource), 'collection.overdue 仍是裸数组')
  return 'aging/overdue 均为对象'
})

run('aging/overdue 对象含 sampled/sampleSize/totalKnown/totalKnownDetail/note/rows', () => {
  for (const block of ['agingBlock', 'overdueBlock']) {
    const start = indexSource.indexOf(`const ${block} = {`)
    assert(start > 0, `找不到 ${block} 的定义`)
    const body = indexSource.slice(start, start + 1200)
    for (const field of ['sampled:', 'sampleSize:', 'totalKnown:', 'totalKnownDetail:', 'note:', 'rows:']) {
      assert(body.includes(field), `${block} 缺少字段 ${field}`)
    }
  }
  return '两个块字段齐全'
})

run('collection.problem 保持对象且标 sampled:false（全量计数不是样本）', () => {
  assert(/problem:\s*\{/.test(indexSource), 'collection.problem 不是对象')
  assert(/sampled:\s*false/.test(indexSource), 'problem 未标 sampled:false')
  return '对象 + sampled:false'
})

run('funnel.threeYear 保持数组，行内自带 sampled + note', () => {
  assert(/const threeYear = \[/.test(indexSource), 'threeYear 不是数组')
  const start = indexSource.indexOf('function buildYearRow')
  assert(start > 0, '找不到 buildYearRow')
  const body = indexSource.slice(start, start + 2000)
  assert(/sampled:\s*true/.test(body), '三年对比行内没有 sampled:true')
  assert(/note:\s*`本行新增客户为抽样值/.test(body), '三年对比行内没有 note')
  return '数组 + 逐行 sampled/note'
})

run('新兵表不下发 ERP 没有的 4 个假列', () => {
  const start = indexSource.indexOf('const newbiesRows =')
  assert(start > 0, '找不到 newbiesRows')
  const body = indexSource.slice(start, start + 800)
  for (const key of ['productExam', 'skillExam', 'mentor', 'confirmDate']) {
    assert(!body.includes(key), `newbiesRows 仍下发 ${key}`)
  }
  return '4 个假列已移除'
})

run('排行表只列在役成员，0 业绩占位单列 rankingInactive', () => {
  assert(/rankingInactive:\s*\{/.test(indexSource), '缺少 rankingInactive')
  assert(/const activeRankingRows = filteredRanking\.filter\(isActiveMember\)/.test(indexSource), '在役过滤缺失')
  assert(/rankingFilterNote/.test(indexSource), '缺少过滤口径说明')
  return '在役过滤 + rankingInactive'
})

run('完成率带军令状目标覆盖度（targetMembers/targetBasis/targetNote）', () => {
  assert(/targetMembers:/.test(indexSource), '缺少 targetMembers')
  assert(/targetBasis:/.test(indexSource), '缺少 targetBasis')
  assert(/targetNote:/.test(indexSource), '缺少 targetNote')
  assert(/completionBasis:/.test(indexSource), '缺少 completionBasis')
  return '覆盖度字段齐全'
})

run('售后板块带 typeNote / majorBasis 口径说明', () => {
  assert(/typeNote:\s*afterSaleTypeNote/.test(indexSource), '缺少 typeNote')
  assert(/majorBasis:\s*afterSaleMajorBasis/.test(indexSource), '缺少 majorBasis')
  return 'typeNote + majorBasis'
})

run('beacon 日志不硬编码盘符路径', () => {
  assert(!/['"]D:\//.test(indexSource), '仍存在硬编码的 D:\\ 盘符路径')
  assert(/os\.tmpdir\(\)/.test(indexSource), '未使用 os.tmpdir() 作为日志兜底目录')
  return 'DSH_LOG_DIR || os.tmpdir()'
})

// ===========================================================================
// 8. v3 抽样口径自检（抽样对象选错 → ABC/分档/复购/沉睡全失真）
// ===========================================================================
// 背景（Lead 实测确认的根因）：
//   customer_analysis 带日期区间时，data.sales[] 只给「前 limit 个客户里、区间内有订单的客户」
//   的成交行；limit=500 时 500 行客户档案只有 36 行成交记录。
//   而 customers[] 的排序是 ERP 默认顺序（不是按成交额），所以「前 500 个客户」≠「Top 500 客户」。
//   拿它排序取 Top N 抽样 → 实测只覆盖区间签约额的 1.9%，ABC 结构卡与客户分档卡几乎没有代表性。
//   正确做法：用 total_performance_analysis.top_customers[]（按区间成交额降序的真实 Top 客户）播种。
section('8. v3 抽样口径自检')

run('抽样池用 top_customers 播种（不是拿 customer_analysis 的前 N 个当 Top N）', () => {
  assert(/rowsOf\(mainTotal, \['top_customers'\]\)/.test(indexSource), '未读取 mainTotal.top_customers')
  assert(/topCustomerSource/.test(indexSource), '缺少 top_customers 读取变量')
  // 金额/单数只许「抬高」，不许覆盖成更小的值（两个来源口径不同）
  assert(/Math\.max\(record\.amount, orderTotal\)/.test(indexSource), '金额未用 Math.max 抬高')
  assert(/Math\.max\(record\.orderCount, orderCount\)/.test(indexSource), '订单数未用 Math.max 抬高')
  assert(!/record\.amount = orderTotal/.test(indexSource), '金额被直接覆盖（会丢掉更大的口径）')
  // 未命中时要新建记录，保证后面能按 customer_pk 调 tier / c360 / customer_info
  assert(/customerIndex\.set\(key, record\)/.test(indexSource), '未命中 top_customers 时未新建客户记录')
  return 'top_customers 播种 + Math.max + 未命中新建'
})

run('ABC / 客户分档卡标注抽样源 sampleSource=top_customers', () => {
  const hits = indexSource.match(/sampleSource:\s*'top_customers'/g) || []
  assert(hits.length >= 2, `sampleSource:top_customers 只出现 ${hits.length} 处（应为 abc + tiers）`)
  assert(/sampleCustomers,/.test(indexSource), 'tiers 缺少 sampleCustomers')
  return `sampleSource 标注 ${hits.length} 处`
})

run('calls[] 的抽样类调用带序号与客户名（可追溯到具体客户）', () => {
  for (const prefix of ['客户分档#', '客户360#', '客户基础档案#']) {
    assert(indexSource.includes(prefix), `calls label 缺少序号前缀 ${prefix}`)
  }
  return '分档 / 360 / 基础档案 label 均带 #序号'
})

run('复购分档排除 0 单客户（行为级断言，不能只扫源码）', () => {
  assert(typeof mod.metrics.repurchaseDistribution === 'function', 'metrics 未导出 repurchaseDistribution')
  const dist = mod.metrics.repurchaseDistribution([
    { orderCount: 0 },
    { orderCount: 0 },
    { orderCount: 0 },
    { orderCount: 1 },
    { orderCount: 20 },
  ])
  assert(dist.excludedNoOrder === 3, `0 单客户排除数应为 3，实际 ${dist.excludedNoOrder}`)
  assert(dist.total === 2, `参与分档客户数应为 2，实际 ${dist.total}`)
  const byBucket = Object.fromEntries(dist.rows.map((r) => [r.bucket, r]))
  assert(byBucket['1-3次'].count === 1, '1-3次 档计数错误')
  assert(byBucket['4-12次'].count === 0, '4-12次 档计数错误')
  assert(byBucket['>12次'].count === 1, '>12次 档计数错误')
  assert(Math.abs(byBucket['1-3次'].share - 0.5) < 1e-9, 'share 分母不是参与分档的客户数')
  // 全 0 单时不能把 share 算成 0（应给 null）
  const empty = mod.metrics.repurchaseDistribution([{ orderCount: 0 }])
  assert(empty.total === 0 && empty.excludedNoOrder === 1, '全 0 单场景统计错误')
  assert(empty.rows.every((r) => r.share === null), '分母为 0 时 share 应为 null 而不是 0')
  return '排除 3 家 0 单客户，2 家参与分档'
})

run('复购分档下发 excludedNoOrder 与说明（分母口径必须可见）', () => {
  assert(/excludedNoOrder:\s*repurchaseExcludedNoOrder/.test(indexSource), '未下发 excludedNoOrder')
  assert(/sampleSize:\s*repurchaseTotal/.test(indexSource), '未下发复购分档 sampleSize')
  assert(/repurchaseNote/.test(indexSource), '缺少复购分档口径说明')
  return 'excludedNoOrder + sampleSize + note'
})

run('沉睡客户标注判定样本量（total 只是样本内判定结果）', () => {
  assert(/sampleSize:\s*dormantJudged/.test(indexSource), 'dormant 未下发 sampleSize')
  assert(/sampleTotal:\s*lookbackIndex\.size/.test(indexSource), 'dormant 未下发样本总量')
  assert(/dormantNote/.test(indexSource), '缺少沉睡客户口径说明')
  assert(/if \(!lastOrder\) continue/.test(indexSource), '无末次订单时间的客户未被排除')
  return 'sampleSize + sampleTotal + note'
})

run('跟进达标率标注抽样客户数（0 率保留真实值）', () => {
  assert(/sampleCustomers:\s*visitSamples\.length/.test(indexSource), 'follow 未下发 sampleCustomers')
  assert(/judgedCustomers:\s*followCustomers/.test(indexSource), 'follow 未下发 judgedCustomers')
  assert(/followNote/.test(indexSource), '缺少跟进达标率口径说明')
  return 'sampleCustomers + judgedCustomers + note'
})

run('matrix 复购/沉睡/跟进/ABC 的 result 文案同步新口径', () => {
  assert(/分母只含区间内订单数 ≥ 1 的客户/.test(indexSource), 'matrix 复购分档文案未更新')
  assert(/参与判定/.test(indexSource), 'matrix 沉睡/跟进文案未写样本口径')
  assert(/抽样源：区间成交额 Top 客户 top_customers/.test(indexSource), 'matrix ABC 文案未写抽样源')
  return '4 处 matrix 文案已同步'
})

// ===========================================================================
// 9. AI 对话接口自检（ai.chat 路由 + 历史折叠 + 候选模型）
// ===========================================================================
// 背景（Lead 实测踩过的坑）：
//   DSH 的 llm 服务一旦收到**带正文的 assistant 消息**就抛
//   `Cannot read properties of undefined (reading 'replayState')`，所有候选模型全失败 → 整个 ai.chat 500。
//   所以本插件必须用 foldHistoryToUserTurns 把多轮历史折成「只用 user 角色」再发。
//   这一节用假 llm / 假 ctx 把那条路径钉死，避免以后有人「顺手优化」回去。
section('9. AI 对话接口自检')

run('dispatch 里注册了 ai.chat 路由（带点的键名，不是 ai_chat）', () => {
  assert(/'ai\.chat':\s*\(\)\s*=>\s*aiChat\(ctx, args, settings\)/.test(indexSource), '未注册 ai.chat 路由')
  assert(!/ai_chat/.test(indexSource), '出现了错误的路由键 ai_chat')
  assert(/aiProvider:\s*null/.test(indexSource), 'DEFAULTS 缺少 aiProvider')
  assert(/aiModel:\s*null/.test(indexSource), 'DEFAULTS 缺少 aiModel')
  return "dispatch['ai.chat'] 已注册"
})

run('stripThink 去掉 <think> 思考块', () => {
  assert(typeof mod.ai.stripThink === 'function', '未导出 stripThink')
  const out = mod.ai.stripThink('<think>模型内部思考</think>最终结论')
  assert(out === '最终结论', `思考块未被去掉，实际 ${JSON.stringify(out)}`)
  // 未闭合的 think 块也要能兜住（模型被截断时会出现）
  const half = mod.ai.stripThink('前半段<think>后面全是思考')
  assert(half === '前半段', `未闭合 think 块未被清掉，实际 ${JSON.stringify(half)}`)
  return '完整块 / 未闭合块均已剥离'
})

run('normalizeChatMessages 丢空内容 / assistant 截 1500 / 只留末尾 12 条', () => {
  assert(typeof mod.ai.normalizeChatMessages === 'function', '未导出 normalizeChatMessages')
  const cleaned = mod.ai.normalizeChatMessages([
    { role: 'user', content: '  ' },
    { role: 'user', content: '问题一' },
    { role: 'system', content: '系统提示（应被当成 user 角色保留）' },
    { role: 'assistant', content: '答一' },
    { role: 'user', content: null },
  ])
  assert(cleaned.length === 3, `空内容未被丢掉，实际剩 ${cleaned.length} 条`)
  assert(cleaned[0].content === '问题一', '正常 user 消息被误改')
  // 非 assistant 角色一律按 user 处理
  assert(cleaned[1].role === 'user', 'system 角色未按 user 归一')

  const longAnswer = mod.ai.normalizeChatMessages([
    { role: 'assistant', content: 'x'.repeat(3000) },
  ])
  assert(longAnswer[0].content.length === 1500, `assistant 未截到 1500，实际 ${longAnswer[0].content.length}`)

  const many = mod.ai.normalizeChatMessages(
    Array.from({ length: 20 }, (_, i) => ({ role: 'user', content: `第${i}条` })),
  )
  assert(many.length === 12, `历史未截到 12 条，实际 ${many.length} 条`)
  assert(many[many.length - 1].content === '第19条', '保留的不是末尾的消息')
  return '空内容丢弃 / 1500 字截断 / 末尾 12 条'
})

run('foldHistoryToUserTurns 把多轮历史折成只用 user 角色（上游缺陷规避）', () => {
  assert(typeof mod.ai.foldHistoryToUserTurns === 'function', '未导出 foldHistoryToUserTurns')
  const folded = mod.ai.foldHistoryToUserTurns([
    { role: 'user', content: '第一个问题' },
    { role: 'assistant', content: '第一个答案' },
    { role: 'user', content: '第二个问题' },
  ])
  assert(folded.every((m) => m.role === 'user'), '折叠后仍存在 assistant 角色（会触发上游 replayState 报错）')
  assert(folded.length === 2, `折叠后应有 2 条 user 消息，实际 ${folded.length}`)
  assert(folded[0].content.includes('问：第一个问题'), '历史问句丢失')
  assert(folded[0].content.includes('答：第一个答案'), '历史答句没有折进同一条消息')
  assert(folded[1].content === '第二个问题', '最后一条问题没有单独成条')

  // 单轮不折：一条 user 进来还是一条 user 出去
  const single = mod.ai.foldHistoryToUserTurns([{ role: 'user', content: '只有一个问题' }])
  assert(single.length === 1 && single[0].role === 'user', '单轮被错误折叠')
  assert(single[0].content === '只有一个问题', '单轮内容被改写')

  // 空历史不炸
  const empty = mod.ai.foldHistoryToUserTurns([])
  assert(Array.isArray(empty) && empty.length === 0, '空历史未返回空数组')
  return '多轮折叠 / 单轮原样 / 空历史安全'
})

/** 造一个假 llm：listProviders / listModels / stream 都可控。 */
function makeFakeLlm(providers, models, chunks) {
  return {
    async listProviders() {
      return providers
    },
    async listModels(id) {
      return models[id] || []
    },
    stream() {
      return (async function* gen() {
        for (const chunk of chunks) yield chunk
      })()
    },
  }
}

await runAsync('collectCandidates 优先级正确且候选里不含任何密钥字段', async () => {
  assert(typeof mod.ai.collectCandidates === 'function', '未导出 collectCandidates')
  const llm = makeFakeLlm(
    [
      { id: 'minimax-cn', name: 'MiniMax' },
      { id: 'other-vendor', name: 'Other' },
    ],
    {
      'minimax-cn': [{ id: 'MiniMax-M3.1-Flash' }],
      'other-vendor': [{ id: 'other-model' }],
    },
    [],
  )
  const ctx = {
    get(key) {
      if (key === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'minimax-cn', model: 'MiniMax-M3.1-Flash' }) }
      }
      return undefined
    },
  }
  const candidates = await mod.ai.collectCandidates(llm, ctx, { aiProvider: null, aiModel: null })
  assert(candidates.length >= 2, `候选数量异常：${candidates.length}`)
  assert(candidates[0].provider === 'minimax-cn', `默认模型未排在首位，实际 ${candidates[0].provider}`)
  assert(
    candidates.some((c) => c.provider === 'other-vendor'),
    '注册表里的其它 provider 没有进入候选（兜底失效）',
  )
  // 候选对象只允许 provider / model 两个键，绝不能带 api key
  for (const candidate of candidates) {
    assertEqual(Object.keys(candidate).sort().join(','), 'model,provider', '候选对象带了额外字段')
  }
  const dumped = JSON.stringify(candidates)
  assert(!/api[-_]?key|secret|token|sk-/i.test(dumped), '候选里出现了疑似密钥字段')

  // 显式配置的 provider 必须排第一
  const configured = await mod.ai.collectCandidates(llm, ctx, {
    aiProvider: 'other-vendor',
    aiModel: null,
  })
  assert(configured[0].provider === 'other-vendor', '显式配置的 provider 未排在首位')
  assert(configured[0].model === 'other-model', '只给 provider 时未用该 provider 首个模型补齐 model')
  return '默认模型优先 / 注册表兜底 / 候选无密钥'
})

await runAsync('aiChat 返回 {ok:true,text,model}', async () => {
  assert(typeof mod.ai.aiChat === 'function', '未导出 aiChat')
  const llm = makeFakeLlm(
    [{ id: 'minimax-cn', name: 'MiniMax' }],
    { 'minimax-cn': [{ id: 'MiniMax-M3.1-Flash' }] },
    [
      { type: 'text-delta', text: 'OK' },
      { type: 'finish' },
    ],
  )
  const ctx = {
    get(key) {
      if (key === 'llm') return llm
      if (key === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'minimax-cn', model: 'MiniMax-M3.1-Flash' }) }
      }
      return undefined
    },
  }
  const result = await mod.ai.aiChat(
    ctx,
    {
      payload: { title: '销售作战看板', aiContext: { overview: { order_count: 10 } } },
      messages: [],
      question: '接单额为什么下滑？',
    },
    { aiProvider: null, aiModel: null },
  )
  assert(result.ok === true, '返回体缺少 ok:true')
  assert(result.text === 'OK', `正文不对：${JSON.stringify(result.text)}`)
  assert(result.model === 'minimax-cn/MiniMax-M3.1-Flash', `模型标识不对：${result.model}`)
  assert(Array.isArray(result.failures), '返回体缺少 failures 数组')
  return 'ok / text / model / failures 齐全'
})

await runAsync('aiChat 无问题且无历史时抛 TypeError（参数错 → 200）', async () => {
  const llm = makeFakeLlm([], {}, [])
  const ctx = {
    get(key) {
      if (key === 'llm') return llm
      return undefined
    },
  }
  let caught = null
  try {
    await mod.ai.aiChat(ctx, { payload: { title: 'x', aiContext: {} }, messages: [], question: '   ' }, {})
  } catch (error) {
    caught = error
  }
  assert(caught !== null, '空问题没有抛错')
  assert(caught instanceof TypeError, `抛出的不是 TypeError：${caught && caught.name}`)
  return '空问题抛 TypeError'
})

run('aiChat 走 foldHistoryToUserTurns（源码里确实是折完再发）', () => {
  assert(/const safeMessages = foldHistoryToUserTurns\(trimmed\)/.test(indexSource), 'aiChat 未调用 foldHistoryToUserTurns')
  assert(/\[dataTurn, \.\.\.safeMessages\]/.test(indexSource), '发模型的消息序列不是 [数据块, 折后的历史]')
  return '历史已折成 user 角色再发'
})

// ===========================================================================
// 10. 新兵只统计销售序列（v4-3 修正：白名单不能被非销售部门污染）
// ===========================================================================
section('10. 新兵销售序列过滤自检')

const SALES_FIRST_DEP = '业务咨询事业群'

// 实测样本：member_performance_analysis 覆盖全公司 12 名在册成员，混着非销售部门。
// 这里用真实数据形态复现那个坑：市场发展部 / 行政法宣部 的 dep_name 也在这份成员列表里。
const REAL_MEMBER_ROWS = [
  { username: 'YX90014', dep_name: '鲲鹏特战队', first_dep_name: '业务咨询事业群' },
  { username: 'YX90001', dep_name: '猛虎特训营', first_dep_name: '业务咨询事业群' },
  { username: 'YX90010', dep_name: '海豹特战队', first_dep_name: '业务咨询事业群' },
  { username: 'YX90017', dep_name: '市场发展部', first_dep_name: '市场发展部' },
  { username: 'STD0013', dep_name: '市场发展部', first_dep_name: '市场发展部' },
  { username: 'STD0069', dep_name: '行政法宣部', first_dep_name: '行政法宣部' },
  { username: 'STD0183', dep_name: '信息技术中心', first_dep_name: '信息技术中心' },
]
const REAL_RANKING_ROWS = [
  { member_id: 901, department_name: '鲲鹏特战队' },
  { member_id: 24, department_name: '猛虎特训营' },
  { member_id: 2, department_name: '业务咨询事业群' },
]

run('销售梯队白名单不含非销售部门', () => {
  const names = mod.metrics.buildSalesSquadNames(REAL_MEMBER_ROWS, REAL_RANKING_ROWS, SALES_FIRST_DEP)
  for (const bad of ['市场发展部', '行政法宣部', '信息技术中心', '分析纯化研究部']) {
    assert(!names.has(bad), `白名单混进了非销售部门「${bad}」`)
  }
  for (const good of ['鲲鹏特战队', '猛虎特训营', '海豹特战队', '蛟龙特训营', '战狼特战队', '业务咨询事业群']) {
    assert(names.has(good), `白名单缺了销售梯队「${good}」`)
  }
  return `白名单 = ${[...names].join(' / ')}`
})

run('新兵过滤：市场/行政/技术人员一律不入选', () => {
  const names = mod.metrics.buildSalesSquadNames(REAL_MEMBER_ROWS, REAL_RANKING_ROWS, SALES_FIRST_DEP)
  const notSales = [
    { staff_name: '业务员12', job_no: 'STD0106', dep_name: '市场发展部', first_dep_name: '市场发展部', second_dep_name: '市场发展部', status: 1 },
    { staff_name: '业务员09', job_no: 'STD0116', dep_name: '市场发展部', first_dep_name: '市场发展部', second_dep_name: '市场发展部', status: 1 },
    { staff_name: '业务员11', job_no: 'STD0071', dep_name: '行政法宣部', first_dep_name: '行政法宣部', second_dep_name: '行政法宣部', status: 1 },
  ]
  for (const staff of notSales) {
    assert(
      mod.metrics.isSalesStaffRow(staff, SALES_FIRST_DEP, names) === false,
      `非销售序列的「${staff.staff_name}」被判成了销售`,
    )
  }
  return '3 名非销售（市场 ×2 / 行政 ×1）全部被剔除'
})

run('新兵过滤：销售序列人员入选（哪怕 job_no 不是 YX 前缀）', () => {
  const names = mod.metrics.buildSalesSquadNames(REAL_MEMBER_ROWS, REAL_RANKING_ROWS, SALES_FIRST_DEP)
  const sales = [
    { staff_name: '业务员08', job_no: 'YX90061', dep_name: '蛟龙特训营', first_dep_name: '业务咨询事业群', second_dep_name: '蛟龙特训营', status: 1 },
    { staff_name: '业务员04', job_no: 'YX90060', dep_name: '猛虎特训营', first_dep_name: '业务咨询事业群', second_dep_name: '猛虎特训营', status: 1 },
    // first_dep_name 写成 '/' 的个别人（业务员业务员03）：靠部门白名单兜住
    { staff_name: '业务员03', job_no: 'YX90002', dep_name: '业务咨询事业群', first_dep_name: '/', second_dep_name: '业务咨询事业群', status: 1 },
  ]
  for (const staff of sales) {
    assert(
      mod.metrics.isSalesStaffRow(staff, SALES_FIRST_DEP, names) === true,
      `销售序列的「${staff.staff_name}」被判成了非销售`,
    )
  }
  return '3 名销售（含 first_dep_name 异常 1 名）全部入选'
})

run('YX 工号前缀不能单独当销售判据', () => {
  const names = mod.metrics.buildSalesSquadNames(REAL_MEMBER_ROWS, REAL_RANKING_ROWS, SALES_FIRST_DEP)
  // 市场发展部的业务员10工号也是 YX90017（真实数据），不能因为 YX 前缀就算销售
  const liu = { staff_name: '业务员10', job_no: 'YX90017', dep_name: '市场发展部', first_dep_name: '市场发展部', second_dep_name: '市场发展部', status: 1 }
  assert(mod.metrics.isSalesStaffRow(liu, SALES_FIRST_DEP, names) === false, 'YX 前缀把市场部的人判成了销售')
  return 'YX90017（市场发展部）未被误判'
})

// ===========================================================================
// 11. 智能预警阈值可配置（方案 01「三大能力」之二：红黄绿 + 自定义阈值）
// ===========================================================================
section('11. 预警阈值可配置自检')

run('默认阈值与方案口径一致', () => {
  const th = mod.resolveThresholds(undefined)
  assert(th.stdShare === 0.6, 'STD 目标应为 60%')
  assert(th.bShare === 0.4, 'B 类目标应为 40%')
  assert(th.cShare === 0.15, 'C 类上限应为 15%')
  assert(th.collectionRate === 0.9, '回款率目标应为 90%')
  assert(th.growthDrop === 0.2, '同比/环比降幅红线应为 20%')
  return 'STD 60% / B 40% / C 15% / 回款 90% / 降幅红线 20%'
})

run('自定义阈值覆盖生效（只写要改的键）', () => {
  const th = mod.resolveThresholds({ stdShare: 0.55, collectionRate: 0.85 })
  assert(th.stdShare === 0.55, '自定义 STD 目标未生效')
  assert(th.collectionRate === 0.85, '自定义回款率目标未生效')
  assert(th.bShare === 0.4, '没写的键应保留默认值')
  // 派生黄线：只改目标时黄线按 目标×0.8 重算，且必须低于目标
  assert(th.stdShareYellow <= th.stdShare, '派生黄线不应高于目标')
  assert(th.collectionRateYellow <= th.collectionRate, '派生黄线不应高于目标')
  return 'stdShare 0.55 / collectionRate 0.85，其余保持默认'
})

run('非法阈值被忽略并回退默认', () => {
  const th = mod.resolveThresholds({ stdShare: 1.8, bShare: 'abc', cShare: NaN, collectionRate: -0.2 })
  assert(th.stdShare === 0.6, '越界值应被忽略')
  assert(th.bShare === 0.4, '非数字应被忽略')
  assert(th.cShare === 0.15, 'NaN 应被忽略')
  assert(th.collectionRate === 0.9, '负数应被忽略')
  return '越界 / 非数字 / NaN / 负数 全部回退默认'
})

run('同比/环比状态按「降幅」方向判定（方案：降幅>20% 红，-20%~0 黄）', () => {
  const th = mod.resolveThresholds({})
  assert(mod.statusFromDelta(0.12, th) === 'good', '正增长应判绿')
  assert(mod.statusFromDelta(0, th) === 'good', '持平应判绿')
  assert(mod.statusFromDelta(-0.1, th) === 'warn', '降幅 10% 应判黄')
  assert(mod.statusFromDelta(-0.2, th) === 'bad', '降幅 20% 应判红')
  assert(mod.statusFromDelta(-0.35, th) === 'bad', '降幅 35% 应判红')
  assert(mod.statusFromDelta(null, th) === 'unknown', '缺失应判 unknown')
  return 'good/warn/bad/unknown 四态判定正确'
})

run('阈值改动会改变判定结果（证明「配置真的生效」）', () => {
  const loose = mod.resolveThresholds({ growthDrop: 0.5 })
  assert(mod.statusFromDelta(-0.35, loose) === 'warn', '放宽红线后降幅 35% 应判黄')
  assert(mod.statusFromDelta(-0.35, mod.resolveThresholds({})) === 'bad', '默认红线下降幅 35% 应判红')
  return 'growthDrop 0.2 → 0.5 后同一降幅由红转黄'
})

// ===========================================================================
// 12. 梯队名乱码归并（ERP 数据质量问题：0 业绩占位成员的部门名是坏字节）
// ===========================================================================
section('12. 梯队名乱码归并自检')

const MOJIBAKE_SQUAD = '\uFFFD\uFFFD\uFFFD狼特战队' // 实测：3 个 U+FFFD 替换字符 + 狼特战队
const KNOWN_SQUADS = ['鲲鹏特战队', '猛虎特训营', '海豹特战队', '蛟龙特训营', '战狼特战队', '业务咨询事业群']

run('乱码梯队名能按最长公共后缀归并回已知梯队', () => {
  const fixed = mod.metrics.repairSquadName(MOJIBAKE_SQUAD, KNOWN_SQUADS)
  assertEqual(fixed, '战狼特战队', '乱码梯队名归并结果不符')
  return '乱码名 → 战狼特战队'
})

run('没有乱码的名字原样返回', () => {
  for (const name of KNOWN_SQUADS) {
    assertEqual(mod.metrics.repairSquadName(name, KNOWN_SQUADS), name, '正常名字被改动了')
  }
  return '6 个已知梯队名原样返回'
})

run('无法归并的乱码名返回空串（不猜）', () => {
  assertEqual(mod.metrics.repairSquadName('\uFFFD\uFFFD\uFFFD完全无关', KNOWN_SQUADS), '', '不该归并却归并了')
  assertEqual(mod.metrics.repairSquadName('\uFFFD', KNOWN_SQUADS), '', '单个替换字符不该归并')
  return '公共后缀不足 3 字或并列 → 不归并'
})

run('并列候选时不归并（宁可保留原名也不猜）', () => {
  const tie = ['甲狼特战队', '乙狼特战队']
  assertEqual(mod.metrics.repairSquadName(MOJIBAKE_SQUAD, tie), '', '并列候选不该归并')
  return '甲/乙 两个同后缀候选 → 不归并'
})

// ===========================================================================
// 第 12 节：PII 判定不能误伤普通浮点数
// ---------------------------------------------------------------------------
// 背景：早期 PII 正则的视断言只排除数字、不排除小数点，于是
//   share = 0.050261205153015395  → 18 位数字命中「身份证号」
//   avg   = 5330.053140096618      → 12 位数字命中「座机号（无横线）」
// 后果：整份结果被判为「含敏感信息」→ 磁盘缓存永远写不进去
//       （6 小时缓存只剩内存那一份，DSH 一重启又要重拉 3~5 分钟），
//       并且每次都向用户显示一条不实的「含手机号/身份证」告警。
// ===========================================================================
section('12. PII 判定不误伤浮点数（磁盘缓存能落盘的前提）')

run('普通浮点数不被判成 PII', () => {
  const floats = [
    0.050261205153015395,
    -0.047216349541930935,
    5330.053140096618,
    0.6700793939611385,
    0.6580626643362737,
  ]
  for (const value of floats) {
    assert(!mod.metrics.containsPii(value), `浮点数 ${value} 被误判成 PII`)
    assert(!mod.metrics.containsPii({ share: value }), `含浮点数的对象被误判成 PII`)
  }
  return `${floats.length} 个真实出现过的浮点数全部不误判`
})

run('真实手机号 / 座机 / 身份证仍被判定为 PII', () => {
  assert(mod.metrics.containsPii('13812345678'), '手机号应被判为 PII')
  assert(mod.metrics.containsPii('0755-12345678'), '带横线座机应被判为 PII')
  assert(mod.metrics.containsPii('075512345678'), '无横线座机应被判为 PII')
  assert(mod.metrics.containsPii('110101199003071234'), '身份证应被判为 PII')
  assert(mod.metrics.containsPii('11010119900307123X'), '带 X 的身份证应被判为 PII')
  return '5 类真实 PII 全部命中'
})

run('联系方式类字段名直接判为 PII', () => {
  for (const key of ['phone', 'tel', 'mobile', 'id_card', 'idCard', 'bank_account', 'bank_no']) {
    assert(mod.metrics.containsPii({ [key]: '任意值' }), `字段 ${key} 应被判为 PII`)
  }
  return '7 个联系方式字段名全部命中'
})

run('单据号 / 货号 / 客户编码不误判', () => {
  for (const value of ['RM758338M', 'C90011', 'YX90017', '1234567890123', '占位成员01']) {
    assert(!mod.metrics.containsPii(value), `非 PII 值 ${value} 被误判`)
  }
  return '5 个常见业务编号全部不误判'
})

run('真实 payload 形态的对象不判为 PII（可落盘）', () => {
  const payloadLike = {
    northStar: { rows: [{ key: 'stdShare', value: 0.6580626643362737, rate: 1.0967711072271229 }] },
    customer: { top: [{ avg: 5330.053140096618, share: 0.059344020174979216 }] },
    collection: { kpis: [{ yoy: -0.047216349541930935 }] },
  }
  assert(!mod.metrics.containsPii(payloadLike), '真实形态的 payload 被误判为 PII')
  return '含比率/均额的对象不判为 PII'
})

// ===========================================================================
// 13. 新兵 = 未转正的业务咨询成员（用户 2026-10-26 澄清后的口径）
// ===========================================================================
section('13. 新兵「未转正」口径自检')

// 实测样本（2026-10-26 probe_newbie2.mjs）：staff_info 全量 224 行，
// 业务咨询事业群 89 人 = 在职 33 + 离职 56；在职 33 人里 positive_time 为空 = 10 人（未转正）。
const REAL_STAFF_ROWS = [
  // 未转正的在职销售（positive_time 为空）→ 应入选
  { staff_name: '业务员08', job_no: 'YX90061', dep_name: '蛟龙特训营', first_dep_name: '业务咨询事业群', second_dep_name: '蛟龙特训营', status: 1, level: 'A-1级-E1', post_name: '业务咨询经理', join_time: '2026-09-21', positive_time: null },
  { staff_name: '业务员04', job_no: 'YX90060', dep_name: '猛虎特训营', first_dep_name: '业务咨询事业群', second_dep_name: '猛虎特训营', status: 1, level: 'A-1级-E1', post_name: '业务咨询经理', join_time: '2026-09-21', positive_time: null },
  // 已转正的在职销售 → 应剔除
  { staff_name: '业务员07', job_no: 'YX90054', dep_name: '鲲鹏特战队', first_dep_name: '业务咨询事业群', second_dep_name: '鲲鹏特战队', status: 1, level: 'A-2级-E1', post_name: '业务咨询经理', join_time: '2026-05-06', positive_time: '2026-09-01' },
  { staff_name: '业务员06', job_no: 'YX90026', dep_name: '战狼特战队', first_dep_name: '业务咨询事业群', second_dep_name: '战狼特战队', status: 1, level: 'A-1级-E3', post_name: '业务咨询经理', join_time: '2025-03-03', positive_time: '2025-09-01' },
  // 离职且未转正 → 应剔除
  { staff_name: '业务员05', job_no: 'YX90029', dep_name: '蛟龙特训营', first_dep_name: '业务咨询事业群', second_dep_name: '蛟龙特训营', status: 0, level: 'S1', post_name: null, join_time: '2025-05-06', positive_time: null },
  // 非销售部门且未转正 → 应剔除
  { staff_name: '业务员10', job_no: 'YX90017', dep_name: '市场发展部', first_dep_name: '市场发展部', second_dep_name: '市场发展部', status: 1, level: 'A-1级-E1', post_name: '市场企划主管', join_time: '2026-01-05', positive_time: null },
  // 销售体系里的非销售岗（企划/推广）且未转正 → 应剔除
  { staff_name: '业务员13', job_no: 'STD0103', dep_name: '蛟龙特训营', first_dep_name: '业务咨询事业群', second_dep_name: '蛟龙特训营', status: 1, level: 'A-4级-B', post_name: '市场企划主管', join_time: '2026-08-17', positive_time: null },
]

run('未转正的在职销售入选，已转正/离职/非销售/非销售岗剔除', () => {
  const names = mod.metrics.buildSalesSquadNames(REAL_MEMBER_ROWS, REAL_RANKING_ROWS, SALES_FIRST_DEP)
  const { candidates, stats } = mod.metrics.selectNewcomers(REAL_STAFF_ROWS, {
    salesFirstDep: SALES_FIRST_DEP,
    salesSquadNames: names,
    baseDate: '2026-10-25',
  })
  const picked = candidates.map((s) => s.staff_name).sort()
  assert(picked.length === 2, `入选人数应为 2，实际 ${picked.length}（${picked.join('/')}）`)
  assert(picked.includes('业务员08') && picked.includes('业务员04'), `入选的人不对：${picked.join('/')}`)
  for (const bad of ['业务员07', '业务员06', '业务员05', '业务员10', '业务员13']) {
    assert(!picked.includes(bad), `不该入选的「${bad}」进了新兵表`)
  }
  assert(stats.total === 7, `花名册总人数统计错：${stats.total}`)
  assert(stats.nonSales === 1, `非销售剔除数应为 1，实际 ${stats.nonSales}`)
  assert(stats.left === 1, `离职剔除数应为 1，实际 ${stats.left}`)
  assert(stats.confirmed === 2, `已转正剔除数应为 2，实际 ${stats.confirmed}`)
  assert(stats.notSalesPost === 1, `非销售岗剔除数应为 1，实际 ${stats.notSalesPost}`)
  assert(stats.selected === 2, `入选数应为 2，实际 ${stats.selected}`)
  return `入选 ${picked.join('/')}；剔除链：非销售 ${stats.nonSales} → 离职 ${stats.left} → 已转正 ${stats.confirmed} → 非销售岗 ${stats.notSalesPost}`
})

run('转正日期晚于基准日（已排期未到期）也算未转正', () => {
  const names = mod.metrics.buildSalesSquadNames(REAL_MEMBER_ROWS, REAL_RANKING_ROWS, SALES_FIRST_DEP)
  const scheduled = [
    { staff_name: '未来的新兵', job_no: 'YX90099', dep_name: '蛟龙特训营', first_dep_name: '业务咨询事业群', second_dep_name: '蛟龙特训营', status: 1, level: 'A-1级-E1', post_name: '业务咨询经理', join_time: '2026-09-01', positive_time: '2027-01-01' },
  ]
  const { candidates } = mod.metrics.selectNewcomers(scheduled, {
    salesFirstDep: SALES_FIRST_DEP,
    salesSquadNames: names,
    baseDate: '2026-10-25',
  })
  assert(candidates.length === 1, '转正日期在未来的应算未转正')
  return '已排期未到期的转正日期 → 计入新兵'
})

run('新兵口径不随统计区间变化（未转正是当前状态）', () => {
  const names = mod.metrics.buildSalesSquadNames(REAL_MEMBER_ROWS, REAL_RANKING_ROWS, SALES_FIRST_DEP)
  const opts = { salesFirstDep: SALES_FIRST_DEP, salesSquadNames: names }
  const a = mod.metrics.selectNewcomers(REAL_STAFF_ROWS, { ...opts, baseDate: '2026-10-25' })
  const b = mod.metrics.selectNewcomers(REAL_STAFF_ROWS, { ...opts, baseDate: '2026-12-31' })
  assert(a.candidates.length === b.candidates.length, '不同区间给出了不同的人数')
  return `两个基准日均为 ${a.candidates.length} 人`
})

// ===========================================================================
// 14. MCP 工具名前缀自检（换设备不掉数据）
// ===========================================================================
// 这一节守的是「插件在别的机器上还调得到 ERP 数据」这件事：
// DSH 的工具全名 = mcp__<连接器名>__<工具名>，连接器名每台设备自己起，
// 所以前缀必须「可配置 + 运行时按 DSH 连接器注册表自动发现 + 首选不可见时能兜底」。
// ---------------------------------------------------------------------------

const CONNECTORS_LOCAL = [
  { serverName: 'erp', prefix: 'mcp__erp__', url: 'http://192.0.2.10:8001/mcp', port: 8001, enabled: true },
  { serverName: 'std', prefix: 'mcp__std__', url: 'http://192.0.2.10:8006/mcp', port: 8006, enabled: true },
  { serverName: 'planning', prefix: 'mcp__planning__', url: 'http://192.0.2.10:8003/mcp', port: 8003, enabled: true },
]

run('没有连接器信息时回退默认前缀，并只对必需分组提示', () => {
  const plan = mod.metrics.resolveToolPrefixes({}, [])
  assert(plan.prefixes.erp === 'mcp__erp__', `erp 应回退默认前缀，实际 ${plan.prefixes.erp}`)
  assert(plan.prefixes.std === 'mcp__std__', `std 应回退默认前缀，实际 ${plan.prefixes.std}`)
  assert(plan.sources.erp === 'default' && plan.sources.std === 'default', '来源应标为 default')
  const warns = mod.metrics.toolPrefixWarnings(plan)
  assert(warns.length === 2, `应只提示 2 个必需分组，实际 ${warns.length}`)
  assert(warns.some((w) => w.includes('toolPrefixes.erp')), '提示里没写清怎么配 erp 前缀')
  assert(!warns.some((w) => w.includes('planning')), '可选分组不该打扰用户')
  return `默认前缀；${warns.length} 条提示（planning 可选不提示）`
})

run('注册表里按端口认领连接器（换设备最常见的场景）', () => {
  const plan = mod.metrics.resolveToolPrefixes({}, CONNECTORS_LOCAL)
  assert(plan.sources.erp === 'discovered', `erp 来源应为 discovered，实际 ${plan.sources.erp}`)
  assert(plan.prefixes.erp === 'mcp__erp__', `erp 前缀不对：${plan.prefixes.erp}`)
  assert(plan.prefixes.std === 'mcp__std__', `std 前缀不对：${plan.prefixes.std}`)
  assert(mod.metrics.toolPrefixWarnings(plan).length === 0, '发现得到就不该再提示')
  return 'erp/std/planning 全部按端口认领成功'
})

run('连接器改名 + 端口不同：主前缀回退，但兜底候选里必须有新名字', () => {
  const renamed = [{ serverName: 'erp-cn', prefix: 'mcp__erp-cn__', url: 'http://10.0.0.9:9001/mcp', port: 9001, enabled: true }]
  const plan = mod.metrics.resolveToolPrefixes({}, renamed)
  assert(plan.prefixes.erp === 'mcp__erp__', '认不出端口时应回退默认前缀')
  assert(plan.alternates.erp.includes('mcp__erp-cn__'), `兜底候选里应有改名后的前缀，实际 ${plan.alternates.erp.join('/')}`)
  const toolPlan = mod.metrics.buildToolPlan(plan)
  assert(toolPlan.alternatesByName.get('mcp__erp__total_performance_analysis').includes('mcp__erp-cn__total_performance_analysis'), '改名后的工具全名没进兜底候选')
  return '主 mcp__erp__，兜底含 mcp__erp-cn__total_performance_analysis'
})

run('用户配置优先于自动发现', () => {
  const plan = mod.metrics.resolveToolPrefixes({ erp: 'mcp__my-erp__' }, CONNECTORS_LOCAL)
  assert(plan.sources.erp === 'config', `erp 来源应为 config，实际 ${plan.sources.erp}`)
  assert(plan.prefixes.erp === 'mcp__my-erp__', `配置的前缀没生效：${plan.prefixes.erp}`)
  assert(plan.sources.std === 'discovered', '其它分组仍应自动发现')
  const toolPlan = mod.metrics.buildToolPlan(plan)
  assert(toolPlan.names.total === 'mcp__my-erp__total_performance_analysis', `工具名没按配置拼：${toolPlan.names.total}`)
  return 'erp 用配置值，std 仍走发现'
})

run('非法前缀配置视为无效（回退默认，不生成怪工具名）', () => {
  const plan = mod.metrics.resolveToolPrefixes({ erp: 'erp', std: 123 }, CONNECTORS_LOCAL)
  assert(plan.prefixes.erp === 'mcp__erp__', `非法值应回退发现/默认，实际 ${plan.prefixes.erp}`)
  assert(plan.prefixes.std === 'mcp__std__', `非法值应回退发现/默认，实际 ${plan.prefixes.std}`)
  const toolPlan = mod.metrics.buildToolPlan(plan)
  assert(/^mcp__(erp|std)__[a-z0-9_]+$/.test(toolPlan.names.total), `工具名形态不对：${toolPlan.names.total}`)
  return '非法配置被忽略，工具名形态仍然合法'
})

run('端口解析：认端口靠 url，不靠猜名字', () => {
  assert(mod.metrics.portOfUrl('http://192.0.2.10:8001/mcp') === 8001, '端口解析失败')
  assert(mod.metrics.portOfUrl('http://192.0.2.10/mcp') === null, '无端口应返回 null')
  assert(mod.metrics.portOfUrl('') === null, '空 url 应返回 null')
  return 'http://host:port/mcp → 端口'
})

// ===========================================================================
// 10. 明细路由（customer.dashboard / member.dashboard / customer.geo）
// ===========================================================================
section('10. 明细路由自检')

run('DEFAULTS 含三条明细路由需要的预算键', () => {
  for (const key of ['detailBudget', 'geoBudgetMs', 'geoMaxRequests']) {
    assert(Object.prototype.hasOwnProperty.call(mod.DEFAULTS, key), `DEFAULTS 缺少 ${key}`)
    assert(Number(mod.DEFAULTS[key]) > 0, `DEFAULTS.${key} 必须为正数`)
  }
  // patch 两处配置也要有这三个键（verify-host.mjs 会硬校验键集合一致）。
  const cfg = patch[0].insert[0].config
  for (const key of ['detailBudget', 'geoBudgetMs', 'geoMaxRequests']) {
    assert(Object.prototype.hasOwnProperty.call(cfg, key), `cordis.patch.yml 缺少 ${key}`)
  }
  return `detailBudget=${mod.DEFAULTS.detailBudget} / geoBudgetMs=${mod.DEFAULTS.geoBudgetMs} / geoMaxRequests=${mod.DEFAULTS.geoMaxRequests}`
})

run('dispatch 注册了三条明细路由（键名带点，与前端路由表一致）', () => {
  // 注意：这里查的是**原始源码**，不是 stripCommentsAndStrings 的结果 ——
  // 路由名本身就是字符串字面量，抹掉字符串就查不到了。
  for (const route of ['customer.dashboard', 'member.dashboard', 'customer.geo']) {
    assert(indexSource.includes(`'${route}'`), `dispatch 里没有注册 ${route}`)
  }
  assert(indexSource.includes("'ai.chat'"), 'dispatch 里 ai.chat 路由丢了')
  // 路由提取必须小写化，否则前端传 'Customer.Dashboard' 会 404。
  assert(indexSource.includes('.toLowerCase()'), '路由提取没有小写化')
  return 'customer.dashboard / member.dashboard / customer.geo'
})

run('省份解析：只用信用代码/地址/地级市/区域名，绝不从公司名猜', () => {
  const resolve = mod.metrics.resolveGeoProvince
  assert(typeof resolve === 'function', 'metrics.resolveGeoProvince 不是函数')
  // 信用代码前缀
  const byCode = resolve({ customer_name: '某某城市公司', duty_paragraph: '91310115MA1HANBF4L' })
  assertEqual(byCode.province, '上海', '信用代码前缀未解析到上海')
  assertEqual(byCode.source, 'credit_code', 'source 不是 credit_code')
  // 地址前缀
  const byAddress = resolve({ customer_name: '某某', customer_address: '杭州市西湖区文三路 1 号' })
  assertEqual(byAddress.province, '浙江', '地址前缀未解析到浙江')
  // 地级市兜底（地址不含省名）
  const byCity = resolve({ customer_name: '某某', customer_address: '苏州市工业园区星湖街 1 号' })
  assertEqual(byCity.province, '江苏', '地级市兜底未解析到江苏')
  // 海外
  const overseas = resolve({ customer_name: '某某', country: 1 })
  assertEqual(overseas.province, '海外', 'country=1 未记为海外')
  assertEqual(overseas.source, 'overseas', 'source 不是 overseas')
  // **公司名里带地名但没有任何地址线索 → 一律不猜**
  const noClue = resolve({ customer_name: '示例客户04' })
  assertEqual(noClue.province, null, '竟然从公司名猜出了省份')
  assertEqual(noClue.source, null, 'source 应为 null')
  return '信用代码 / 地址 / 地级市 / 海外 四条路径可用；公司名不参与判定'
})

run('报价统计：金额合计取 metrics.amount_total（合并口径），不用明细行求和', () => {
  const build = mod.metrics.buildQuoteStats
  assert(typeof build === 'function', 'metrics.buildQuoteStats 不是函数')
  const stats = build({
    inquiryMetrics: { doc_count: 100 },
    inquiryRecords: [{ code: 'I1', customer_name: '客户甲', principal_name: '张三', reply_status: 1, add_time: '2026-10-01' }],
    quotationMetrics: { doc_count: 490, doc_count_before_merge: 2703, merged_away_count: 306, amount_total: 42051656.5 },
    // 明细里只有 2 单、合计 100 元 —— 如果拿明细行求和就会得到 100（错）
    quotationRecords: [
      { code: 'Q1', customer_name: '客户甲', principal_name: '张三', total_amount: 60, progress: 1, add_time: '2026-10-02' },
      { code: 'Q2', customer_name: '客户乙', principal_name: '李四', total_amount: 40, progress: 2, add_time: '2026-10-03' },
    ],
    periodOrderCount: 1200,
    rowLimit: 100,
  })
  assertEqual(stats.quotationAmount, 42051656.5, '报价金额没取合并口径的 amount_total')
  assertEqual(stats.quotationDocCount, 490, '报价单数应取 metrics.doc_count')
  assertEqual(stats.inquiryDocCount, 100, '询价单数应取 metrics.doc_count')
  assertEqual(stats.sampled, true, '明细派生统计必须标 sampled:true')
  assertEqual(stats.sampleSize, 2, 'sampleSize 应是明细行数')
  assertEqual(stats.totalKnown, 490, 'totalKnown 应是全量单据数')
  // 比率 0~1
  assert(stats.inquiryToQuotationRate > 1, 'inquiryToQuotationRate 可以 >1（quotation/inquiry）')
  // quotationToOrderRate = 订单数 ÷ 报价单数，两个计数口径不同，**允许 >1**。
  // clamp 到 1 就等于把「转化不过来」藏起来了 —— 那是假数据。
  assert(
    typeof stats.quotationToOrderRate === 'number' && stats.quotationToOrderRate >= 0,
    `quotationToOrderRate 应为非负数，实际 ${stats.quotationToOrderRate}`,
  )
  assert(stats.quotationToOrderRate > 1, 'mock 里订单数多于报价单数，比率应 >1（不许 clamp）')
  assert(
    String(stats.note || '').includes('可能大于 1'),
    'note 必须写明该比率可能大于 1（否则前端会当成概率渲染）',
  )
  return `金额 ${stats.quotationAmount}（合并口径）≠ 明细求和 100；报价→订单比率 ${stats.quotationToOrderRate}（不 clamp）`
})

run('明细路由的访客记录只取白名单字段（丢掉地址/电话）', () => {
  const code = stripCommentsAndStrings(indexSource)
  assert(code.includes('parseVisitPayload'), '源码里没有 parseVisitPayload')
  assert(code.includes('gift_content'), '白名单里缺 gift_content')
  assert(!/recipient_phone\s*[,}\]]/.test(code), '源码里把 recipient_phone 读进结果了')
  return '白名单：time / content / remarks / gift_content / visit_name'
})

/**
 * 明细路由的假 MCP：按工具名后缀返回不同形状的数据。
 * 目的是让三条路由真的跑一遍取数编排，检查「下游只拿到白名单字段」。
 */
function makeDetailMock() {
  const customerSearch = [{
    customer_pk: 13783,
    customer_code: 'C90012',
    customer_name: '示例客户01',
    customer_phone: '138****8888',
    customer_address: '上海*** 室',
    area_name: '',
    customer_kind: 'CRO终端科技公司',
    first_deal_time: '2021-03-11',
    principal_id: 77,
    principal_name: '业务员02',
  }]
  const masterRows = [
    {
      id: 13783,
      customer_id: 'C90012',
      customer_name: '示例客户01',
      customer_phone: '13800000000',
      customer_address: '上海市浦东新区康新公路3377号2幢301室',
      duty_paragraph: '91310115MA1HANBF4L',
      banks: '测试银行',
      banks_account: '6214830000000000',
      country: 0,
      area_name: '',
      customer_kind: 'CRO终端科技公司',
      principal_id: 77,
    },
    {
      id: 90001,
      customer_id: 'C90001',
      customer_name: '示例客户03',
      customer_phone: '13900000000',
      customer_address: '杭州市西湖区文三路 100 号',
      duty_paragraph: '',
      banks: null,
      banks_account: null,
      country: 0,
      area_name: '',
      customer_kind: '终端客户',
      principal_id: 77,
    },
    {
      id: 90002,
      customer_id: 'C90002',
      customer_name: '某某城市贸易公司',
      customer_phone: null,
      customer_address: null,
      duty_paragraph: null,
      banks: null,
      banks_account: null,
      country: 0,
      area_name: '',
      customer_kind: '终端客户',
      principal_id: 77,
    },
    {
      id: 90003,
      customer_id: 'C90003',
      customer_name: 'Overland Trading Ltd',
      customer_phone: null,
      customer_address: null,
      duty_paragraph: null,
      banks: null,
      banks_account: null,
      country: 1,
      area_name: '俄罗斯',
      customer_kind: '终端客户',
      principal_id: 77,
    },
  ]
  const byTool = (name) => {
    if (name.endsWith('sales_customer_search')) return customerSearch
    if (name.endsWith('sales_customer_360')) {
      return {
        profile: {
          customer_pk: 13783,
          customer_code: 'C90012',
          customer_name: '示例客户01',
          customer_phone: '13800000000',
          customer_address: '上海市浦东新区康新公路3377号2幢301室',
          customer_kind: 'CRO终端科技公司',
          principal_name: '业务员02',
          credit_limit: 500000,
          used_amount: 252000,
          remain_amount: 247300,
        },
        sales_metrics: {
          order_count: 3,
          signing_amount: 360000,
          collection_amount: 108000,
          uncollected_amount: 252000,
          unpaid_order_count: 0,
          partial_paid_order_count: 3,
          overdue_order_count: 0,
          problem_order_count: 0,
        },
        trend: [{ period: '2026-10', order_count: 3, signing_amount: 360000, collection_amount: 108000 }],
        visits: [{
          id: 1,
          type: 'call',
          data: JSON.stringify({
            time: '2026-10-20 10:00:00',
            content: '沟通了检测需求',
            recipient_phone: '13800000000',
            recipient_address: '上海市浦东新区康新公路3377号',
            visit_name: '业务员02',
          }),
          add_time: '2026-10-20 10:05:00',
        }],
        inquiries: [{ id: 1, code: 'INQ1', reply_status: 2 }],
        quotations: [{ id: 1, code: 'Q1', quotation_amount: 360000, progress: 2 }],
        after_sales: [{ id: 1, sale_code: 'S1', type: 1, status: 1, status2: 2 }],
        risk_tags: ['授信额度使用率 50.54%'],
      }
    }
    if (name.endsWith('customer_analysis')) {
      return {
        customers: [{
          id: 13783,
          customer_id: 'C90012',
          customer_name: '示例客户01',
          customer_phone: '13800000000',
          customer_address: '上海市浦东新区康新公路3377号2幢301室',
          duty_paragraph: '91310115MA1HANBF4L',
          banks: '测试银行',
          banks_account: '6214830000000000',
          country: 0,
          area_name: '',
          customer_kind: 'CRO终端科技公司',
          principal_id: 77,
        }],
        sales: [{
          customer_pk: 13783,
          customer_id: 'C90012',
          customer_name: '示例客户01',
          order_count: 48,
          total_amount: 2300000.00,
          back_money: 2300000.00,
          first_order_time: '2021-03-11',
          last_order_time: '2026-10-20',
        }],
      }
    }
    if (name.endsWith('customer_tier_rating')) {
      return {
        customer: { id: 13783, customer_id: 'C90012', customer_name: '示例客户01', principal_name: '业务员02' },
        candidates: [],
        metrics: {
          amount_12m: 900000,
          amount_cumulative: 2300000.00,
          order_count_12m: 3,
          order_count_all: 48,
          days_since_last_order: 5,
          first_order_time: '2021-03-11',
          last_order_time: '2026-10-20',
          continuous_years: 5,
          b_order_share: 0.4,
          category_names: [],
          risk_alerts: ['账期偏长'],
        },
        rating: {
          tier: 'A',
          tier_name: '核心客户',
          total_score: 78.4,
          breakdown: [{
            code: 'D1-1',
            dimension: '维度一',
            item: '成交规模',
            max_score: 20,
            score: 18,
            value: '90万',
            basis: '12 个月成交额',
            data_source: 'ERP',
            status: 'ok',
          }],
          dimension_scores: { 维度一: { score: 18, max_score: 20 } },
          next_tier_gap: 6.2,
          completeness_pct: 95.3,
          missing_items: [],
          risk_alerts: [],
        },
        qcc: null,
      }
    }
    if (name.endsWith('sales_order_collection_analysis')) {
      return {
        overview: {
          order_count: 3,
          signing_amount: 360000,
          collection_amount: 108000,
          uncollected_amount: 252000,
          unpaid_order_count: 0,
          partial_paid_order_count: 3,
          overdue_order_count: 1,
          problem_order_count: 0,
        },
        orders: [{
          sale_id: 1,
          sale_code: 'SO202610001',
          sale_state: 2,
          sale_ht_date: '2026-10-01',
          overdue_days: 120,
          account_period: 30,
          customer_pk: 13783,
          customer_code: 'C90012',
          customer_name: '示例客户01',
          member_id: 901,
          member_name: '业务员01',
          department_name: '鲲鹏特战队',
          signing_amount: 360000,
          collection_amount: 108000,
          uncollected_amount: 252000,
        }, {
          // 实机真实数据：overdue_days 为负数 = 这张单还没到期。
          // 直接下发会让前端显示「逾期 -63 天」，属于把数据说反，必须归一成 null。
          sale_id: 2,
          sale_code: 'SO202610002',
          sale_state: 1,
          sale_ht_date: '2026-10-20',
          overdue_days: -63,
          account_period: 30,
          customer_pk: 13783,
          customer_code: 'C90012',
          customer_name: '示例客户01',
          member_id: 901,
          member_name: '业务员01',
          department_name: '鲲鹏特战队',
          signing_amount: 0,
          collection_amount: 0,
          uncollected_amount: 0,
        }],
      }
    }
    if (name.endsWith('member_performance_analysis')) {
      return [{
        member_id: 901,
        member_name: '业务员01',
        username: 'YX90014',
        dep_name: '鲲鹏特战队',
        order_count: 204,
        customer_count: 17,
        order_total_amount: 5700000.00,
        finished_order_count: 180,
        unpaid_order_count: 10,
        acceptance_amount: 5400000,
        finish_back_money: 3000000,
        finish_paid_promo_fee: 100000,
        finish_amount: 870000,
        back_money: 870000,
        first_order_time: '2022-04-01',
        last_order_time: '2026-10-20',
      }]
    }
    if (name.endsWith('sales_person_360')) {
      return {
        profile: {
          member_id: 901,
          member_name: '业务员01',
          username: 'YX90014',
          department_id: '13',
          department_name: '鲲鹏特战队',
          staff_name: '业务员01',
          sex: '女',
          personal_tel: '13800000000',
          tel: '02112345678',
          email: 'someone@example.com',
          job: 'YX90014',
          join_time: '2022-03-01',
          status: 2,
          education: '本科',
          customer_count: 17,
          order_count: 204,
          signing_amount: 5700000.00,
          collection_amount: 4000000.00,
          uncollected_amount: 1704000.00,
          overdue_order_count: 21,
          problem_order_count: 0,
        },
        target: { target_amount: 5000000, warnings: [], signing_completion_rate: 114, collection_completion_rate: 80 },
        recent_orders: [{
          sale_code: 'SO202610001',
          sale_state: 2,
          sale_ht_date: '2026-10-01',
          overdue_days: 120,
          customer_name: '示例客户01',
          signing_amount: 360000,
          collection_amount: 108000,
          uncollected_amount: 252000,
        }, {
          // 负数 = 未到期，必须归一成 null（见 normalizeOverdueDays）。
          sale_code: 'SO202610002',
          sale_state: 1,
          sale_ht_date: '2026-10-20',
          overdue_days: -33,
          customer_name: '示例客户01',
          signing_amount: 0,
          collection_amount: 0,
          uncollected_amount: 0,
        }],
      }
    }
    if (name.endsWith('sales_performance_ranking')) {
      return {
        ranking: [{
          member_id: 901,
          member_name: '业务员01',
          department_id: '13',
          department_name: '鲲鹏特战队',
          customer_count: 17,
          order_count: 204,
          signing_amount: 5700000.00,
          collection_amount: 4000000.00,
          uncollected_amount: 1704000.00,
          overdue_order_count: 21,
          problem_order_count: 0,
          target_amount: 5000000,
          target_warning: null,
          signing_completion_rate: 114,
          collection_completion_rate: 80,
        }],
      }
    }
    if (name.endsWith('total_performance_analysis')) {
      return {
        overview: { order_count: 1200, customer_count: 320, member_count: 12, order_total_amount: 11900000.00 },
        trend: [],
        top_customers: [{
          customer_pk: 13783,
          customer_id: 'C90012',
          customer_name: '示例客户01',
          order_count: 3,
          order_total_amount: 900000,
        }],
      }
    }
    if (name.endsWith('customer_info')) return masterRows
    if (name.endsWith('staff_info')) {
      // 员工花名册（B4 用）：业务员「业务员01」在职，岗位是销售经理。
      // 故意带上手机号 / 身份证 / 银行账号 —— 用来验证 Host 端确实做了白名单过滤，
      // 这些字段绝不能出现在 member.dashboard 的响应里。
      return [{
        staff_id: 501,
        staff_name: '业务员01',
        job_no: 'YX90014',
        status: 1,
        status_name: '在职',
        level: 'A-3级-B',
        join_time: '2022-03-01',
        positive_time: '2022-09-01',
        dep_name: '鲲鹏特战队',
        first_dep_name: '业务咨询事业群',
        second_dep_name: '鲲鹏特战队',
        post_name: '销售经理',
        personal_tel: '13800000000',
        id_card_number: '310101199001011234',
        bank_acount: '6214830000000000',
      }]
    }
    return null
  }
  return async (payload) => {
    const data = byTool(payload.name)
    if (data === null) return { isError: true, error: { code: 'UNKNOWN_TOOL', message: `unknown tool ${payload.name}` } }
    return { isError: false, value: { content: [{ type: 'text', text: JSON.stringify({ data }) }] } }
  }
}

/** 跑一条明细路由并返回解析后的响应体。 */
async function callDetailRoute(route, body) {
  const harness = makeCtx(makeDetailMock())
  mod.apply(harness.ctx, { cacheTtlMs: 0, geoBudgetMs: 20000, geoMaxRequests: 20 })
  const res = makeRes()
  await harness.registrations[0].handler(
    makeReq('POST', `/erp-sales-dashboard/api/${route}`, JSON.stringify(body)),
    res,
  )
  return { status: res.state.status, body: JSON.parse(res.state.body) }
}

/**
 * 在明细 mock 之上**覆盖若干工具**的返回（键是工具名后缀）。
 *
 * 为什么要覆盖：默认 mock 里上游的 uncollected_amount 恰好等于「签约 − 已回款」，
 * 归一前后数值一样 —— 那样测不出「到底有没有归一」。
 * 所以专门造一份「上游虚高」的数据，才能证明 Host 端真的重算了一遍。
 */
function makeDetailMockWith(overrides) {
  const base = makeDetailMock()
  return async (payload) => {
    for (const [suffix, data] of Object.entries(overrides)) {
      if (!payload.name.endsWith(suffix)) continue
      // __fail 表示「这个工具真的挂了」—— 用来验证 Host 的降级路径。
      // 这条路径是真实会发生的：std 连接器（8006）整台宕机时，
      // staff_info 就取不到岗位与在职状态，这时必须留空并说明，不能猜。
      if (data && typeof data === 'object' && data.__fail) {
        return {
          isError: true,
          error: { code: 'UPSTREAM_ERROR', message: String(data.__fail) },
        }
      }
      return { isError: false, value: { content: [{ type: 'text', text: JSON.stringify({ data }) }] } }
    }
    return base(payload)
  }
}

/** 用指定 mock 跑一条明细路由（member.dashboard 等）。 */
async function callMemberRouteWith(executeImpl, body) {
  const harness = makeCtx(executeImpl)
  mod.apply(harness.ctx, { cacheTtlMs: 0 })
  const res = makeRes()
  await harness.registrations[0].handler(
    makeReq('POST', '/erp-sales-dashboard/api/member.dashboard', JSON.stringify(body)),
    res,
  )
  return { status: res.state.status, body: JSON.parse(res.state.body) }
}

/** 递归找出 payload 里所有「键名」，用于 PII 体检。 */
function collectKeys(value, out = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, out)
    return out
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      out.add(key)
      collectKeys(item, out)
    }
  }
  return out
}

/** 递归找出 payload 里所有字符串值，用于 PII 体检。 */
function collectStrings(value, out = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out)
    return out
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, out)
    return out
  }
  if (typeof value === 'string') out.push(value)
  return out
}

const PII_KEY_PATTERN = /^(address|customer_address|duty_paragraph|phone|customer_phone|personal_tel|tel|email|personal_email|mobile|id_card|id_card_number|bank|banks|banks_account|bank_account|recipient_phone|recipient_address|home_address|company_address)$/i

/**
 * 从源码里**按括号配对**精确切出某个函数的函数体。
 *
 * 为什么不用「从函数名切到下一个顶层 function」这种粗暴切法：
 *   明细路由的函数（collectCustomerGeo / fetchCustomerGeo）是嵌套在 apply() 里的，
 *   粗暴切法会把后面主看板的 disk.put 一起切进来，静态断言就会误报「geo 落盘了」。
 * 这里扫描时跳过字符串字面量与注释，只按 {} 配对，得到的才是这个函数真正的函数体。
 */
function extractFunctionSource(source, name) {
  const re = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`)
  const m = re.exec(source)
  if (!m) return ''
  let i = m.index
  while (i < source.length && source[i] !== '{') i++
  if (i >= source.length) return ''
  const start = i
  let depth = 0
  let quote = null
  let inLineComment = false
  let inBlockComment = false
  for (; i < source.length; i++) {
    const ch = source[i]
    const next = source[i + 1]
    if (inLineComment) {
      if (ch === '\n') inLineComment = false
      continue
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') { inBlockComment = false; i++ }
      continue
    }
    if (quote) {
      if (ch === '\\') { i++; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '/' && next === '/') { inLineComment = true; i++; continue }
    if (ch === '/' && next === '*') { inBlockComment = true; i++; continue }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  return source.slice(start)
}

await runAsync('customer.dashboard：缺参数 → 200 + ok:false（不 500）', async () => {
  const result = await callDetailRoute('customer.dashboard', {})
  assertEqual(result.status, 200, '状态码不符')
  assertEqual(result.body.ok, false, 'ok 不符')
  return '200 + ok:false'
})

await runAsync('customer.dashboard：返回契约字段齐全（camelCase），且不含任何 PII 字段', async () => {
  const result = await callDetailRoute('customer.dashboard', {
    name: '示例客户01',
    startDate: '2026-01-01',
    endDate: '2026-10-25',
  })
  assertEqual(result.status, 200, '状态码不符')
  assertEqual(result.body.ok, true, `ok 不符：${JSON.stringify(result.body).slice(0, 200)}`)
  // 顶层：与业务工作台原样一致（camelCase），且不再有顶层的 visits/afterSales 等散块。
  for (const key of [
    'period', 'generatedAt', 'resolved', 'profile', 'periodMetrics', 'lifetime',
    'rating', 'lifecycle', 'benchmark', 'orders', 'notes', 'warnings', 'calls',
  ]) {
    assert(Object.prototype.hasOwnProperty.call(result.body, key), `返回体缺少 ${key}`)
  }
  for (const key of ['customerPk', 'customerCode', 'customerName', 'principalName', 'candidates', 'ambiguous']) {
    assert(Object.prototype.hasOwnProperty.call(result.body.resolved || {}, key), `resolved 缺少 ${key}`)
  }
  for (const key of [
    'customerPk', 'customerCode', 'customerName', 'customerKind', 'areaName', 'firstDealTime',
    'principalName', 'creditLimit', 'usedAmount', 'remainAmount', 'creditUsageRate',
    'riskCoefficient', 'recommendedLimit', 'creditCalcTime', 'avgPaymentDays', 'riskTags',
  ]) {
    assert(Object.prototype.hasOwnProperty.call(result.body.profile || {}, key), `profile 缺少 ${key}`)
  }
  for (const key of [
    'orderCount', 'signingAmount', 'collectionAmount', 'uncollectedAmount', 'uncollectedAmountUpstream',
    'unpaidOrderCount', 'partialPaidOrderCount', 'overdueOrderCount', 'problemOrderCount',
    'finishedOrderCount', 'collectionRate', 'uncollectedRate', 'overdueOrderRate',
    'avgOrderAmount', 'firstOrderTime', 'lastOrderTime',
  ]) {
    assert(Object.prototype.hasOwnProperty.call(result.body.periodMetrics || {}, key), `periodMetrics 缺少 ${key}`)
  }
  for (const key of [
    'orderCount', 'signingAmount', 'collectionAmount', 'uncollectedAmount', 'uncollectedAmountUpstream',
    'unpaidOrderCount', 'partialPaidOrderCount', 'overdueOrderCount', 'problemOrderCount',
    'collectionRate', 'uncollectedRate', 'firstOrderTime', 'lastOrderTime',
  ]) {
    assert(Object.prototype.hasOwnProperty.call(result.body.lifetime || {}, key), `lifetime 缺少 ${key}`)
  }
  for (const key of [
    'available', 'ruleVersion', 'ruleSource', 'baseDate', 'totalScore', 'totalScoreRaw',
    'tier', 'tierName', 'nextTierGap', 'completenessPct', 'isLowerBound', 'missingItems',
    'riskAlerts', 'breakdown', 'dimensions', 'upgradeRules', 'vetoRules', 'metrics',
    'categoryNames', 'qcc',
  ]) {
    assert(Object.prototype.hasOwnProperty.call(result.body.rating || {}, key), `rating 缺少 ${key}`)
  }
  for (const key of [
    'amount12m', 'amountPrev12m', 'amountCumulative', 'collected12m', 'orderCount12m',
    'orderCountAll', 'daysSinceLastOrder', 'continuousYears', 'yoyRate', 'categoryCount',
    'overdueRate', 'overdueOrderCount12m', 'accountPeriodDays',
  ]) {
    assert(Object.prototype.hasOwnProperty.call(result.body.rating?.metrics || {}, key), `rating.metrics 缺少 ${key}`)
  }
  for (const key of ['monthlyTrend', 'visits', 'inquiries', 'quotations', 'afterSales', 'notes', 'counts']) {
    assert(Object.prototype.hasOwnProperty.call(result.body.lifecycle || {}, key), `lifecycle 缺少 ${key}`)
  }
  for (const key of ['visits', 'inquiries', 'quotations', 'afterSales']) {
    assert(Object.prototype.hasOwnProperty.call(result.body.lifecycle?.counts || {}, key), `lifecycle.counts 缺少 ${key}`)
  }
  for (const key of [
    'totalSigningAmount', 'totalOrderCount', 'totalCustomerCount', 'rank', 'rankTotal',
    'topList', 'shareOfTotal', 'isInTopList', 'avgPerCustomer',
  ]) {
    assert(Object.prototype.hasOwnProperty.call(result.body.benchmark || {}, key), `benchmark 缺少 ${key}`)
  }
  assert(Array.isArray(result.body.calls), 'calls 不是数组')
  // PII 体检：键名与字符串值都查一遍
  const keys = collectKeys(result.body)
  const piiKeys = [...keys].filter((k) => PII_KEY_PATTERN.test(k))
  assert(piiKeys.length === 0, `返回体出现 PII 字段名：${piiKeys.join(', ')}`)
  const strings = collectStrings(result.body)
  const piiValues = strings.filter((s) => /13800000000|138\*\*\*\*8888|6214830000000000|91310115MA1HANBF4L|someone@example\.com|02112345678|上海市浦东新区康新公路3377号/.test(s))
  assert(piiValues.length === 0, `返回体出现 PII 值：${piiValues.slice(0, 3).join(' | ')}`)
  return `字段齐全；PII 体检通过（${keys.size} 个键名、${strings.length} 个字符串）`
})

await runAsync('customer.dashboard：未回款口径归一（签约−已回款），上游原值另存', async () => {
  const result = await callDetailRoute('customer.dashboard', {
    name: '示例客户01',
    startDate: '2026-01-01',
    endDate: '2026-10-25',
  })
  const period = result.body.periodMetrics || {}
  const life = result.body.lifetime || {}
  // mock：区间签约 360000 / 已回款 108000 → 归一未回款 252000；上游原值也是 252000（口径一致）。
  assertEqual(period.uncollectedAmount, 252000, '区间未回款未按「签约−已回款」归一')
  assertEqual(period.uncollectedAmountUpstream, 252000, '区间上游未回款原值取错')
  assertEqual(life.uncollectedAmount, 0, '全周期未回款未归一')
  // 归一值必须能由签约额与已回款额复算出来（而不是照抄上游）。
  assert(
    period.signingAmount - period.collectionAmount === period.uncollectedAmount,
    '区间未回款与「签约−已回款」对不上',
  )
  assert(
    life.signingAmount - life.collectionAmount === life.uncollectedAmount,
    '全周期未回款与「签约−已回款」对不上',
  )
  return '区间 252000 / 全周期 0，均由签约额−已回款额复算一致'
})

await runAsync('customer.dashboard：benchmark 是总盘口径（不是抽样池排名）', async () => {
  const result = await callDetailRoute('customer.dashboard', {
    name: '示例客户01',
    startDate: '2026-01-01',
    endDate: '2026-10-25',
  })
  const bench = result.body.benchmark || {}
  assertEqual(bench.totalSigningAmount, 11900000.00, '总盘签单额取错')
  assertEqual(bench.totalOrderCount, 1200, '总盘订单数取错')
  assertEqual(bench.totalCustomerCount, 320, '总盘客户数取错')
  assertEqual(bench.rankTotal, 1, 'rankTotal 应等于 top_customers 的条数')
  assert(Array.isArray(bench.topList), 'topList 不是数组')
  assert(bench.topList.length >= 1, 'topList 为空')
  assert('rank' in bench.topList[0] && 'customerName' in bench.topList[0] && 'signingAmount' in bench.topList[0], 'topList 行字段不符')
  assert(typeof bench.shareOfTotal === 'number' || bench.shareOfTotal === null, 'shareOfTotal 类型不对')
  assert(typeof bench.isInTopList === 'boolean', 'isInTopList 不是布尔')
  assert(
    String((result.body.notes || []).join(' ')).includes('总盘口径'),
    'notes 里没写清 benchmark 是总盘口径',
  )
  return `总盘 ${bench.totalSigningAmount} 元 / ${bench.totalCustomerCount} 家客户`
})

await runAsync('member.dashboard：返回契约字段齐全，且 profile 里没有电话/邮箱', async () => {
  const result = await callDetailRoute('member.dashboard', {
    memberId: 901,
    startDate: '2026-01-01',
    endDate: '2026-10-25',
  })
  assertEqual(result.status, 200, '状态码不符')
  assertEqual(result.body.ok, true, `ok 不符：${JSON.stringify(result.body).slice(0, 200)}`)
  for (const key of [
    'period', 'generatedAt', 'resolved', 'profile', 'periodMetrics', 'target',
    'benchmark', 'collection', 'recentOrders', 'notes', 'warnings', 'calls',
  ]) {
    assert(Object.prototype.hasOwnProperty.call(result.body, key), `返回体缺少 ${key}`)
  }
  for (const key of ['memberId', 'memberName', 'username', 'departmentName', 'candidates', 'ambiguous']) {
    assert(Object.prototype.hasOwnProperty.call(result.body.resolved || {}, key), `resolved 缺少 ${key}`)
  }
  for (const key of ['memberId', 'memberName', 'username', 'departmentName', 'staffName', 'joinTime', 'education', 'status']) {
    assert(Object.prototype.hasOwnProperty.call(result.body.profile || {}, key), `profile 缺少 ${key}`)
  }
  for (const key of [
    'customerCount', 'orderCount', 'signingAmount', 'acceptanceAmount', 'finishedOrderCount',
    'unpaidOrderCount', 'finishAmount', 'finishAmountRate', 'uncollectedAmount', 'finishRate',
    'unpaidRate', 'collectionAmount', 'collectionRate', 'overdueOrderCount', 'problemOrderCount',
    'avgOrderAmount', 'avgCustomerAmount', 'firstOrderTime', 'lastOrderTime',
  ]) {
    assert(Object.prototype.hasOwnProperty.call(result.body.periodMetrics || {}, key), `periodMetrics 缺少 ${key}`)
  }
  for (const key of [
    'available', 'targetAmount', 'ytdSigningAmount', 'ytdCollectionAmount',
    'signingCompletionRate', 'collectionCompletionRate', 'signingGap',
    'completionBasisLabel', 'periodBasisLabel', 'warnings',
  ]) {
    assert(Object.prototype.hasOwnProperty.call(result.body.target || {}, key), `target 缺少 ${key}`)
  }
  for (const key of ['rank', 'rankTotal', 'departmentRank', 'departmentSize', 'departmentAvgSigning', 'companyAvgSigning', 'vsDepartmentAvg', 'vsCompanyAvg', 'peers', 'topMembers']) {
    assert(Object.prototype.hasOwnProperty.call(result.body.benchmark || {}, key), `benchmark 缺少 ${key}`)
  }
  for (const key of ['overview', 'orders']) {
    assert(Object.prototype.hasOwnProperty.call(result.body.collection || {}, key), `collection 缺少 ${key}`)
  }
  // PII 体检
  const keys = collectKeys(result.body)
  const piiKeys = [...keys].filter((k) => PII_KEY_PATTERN.test(k))
  assert(piiKeys.length === 0, `返回体出现 PII 字段名：${piiKeys.join(', ')}`)
  const strings = collectStrings(result.body)
  const piiValues = strings.filter((s) => /13800000000|02112345678|someone@example\.com/.test(s))
  assert(piiValues.length === 0, `返回体出现 PII 值：${piiValues.slice(0, 3).join(' | ')}`)
  return '字段齐全；profile 无 tel/email'
})

await runAsync('member.dashboard：年度完成率自算且允许 >100%（不 clamp）', async () => {
  const result = await callDetailRoute('member.dashboard', {
    memberId: 901,
    startDate: '2026-01-01',
    endDate: '2026-10-25',
  })
  const target = result.body.target || {}
  assertEqual(target.available, true, 'target.available 应为 true')
  assertEqual(target.targetAmount, 5000000, '年度目标额取错')
  // 分子取年度榜口径（ranking 的 signing_amount = 5700000.00）→ 完成率 1.14…，必须 >1。
  assert(
    typeof target.signingCompletionRate === 'number' && target.signingCompletionRate > 1,
    `年度完成率应 >1（允许超额），实际 ${target.signingCompletionRate}`,
  )
  assert(String(target.completionBasisLabel || '').includes('军令状'), '缺 completionBasisLabel 口径说明')
  assert(String(target.periodBasisLabel || '').length > 0, '缺 periodBasisLabel 口径说明')
  return `年度完成率 ${target.signingCompletionRate}（不 clamp）`
})

await runAsync('customer.geo：scope 非法 → 200 + ok:false', async () => {
  const result = await callDetailRoute('customer.geo', { scope: 'galaxy' })
  assertEqual(result.status, 200, '状态码不符')
  assertEqual(result.body.ok, false, 'ok 不符')
  return '200 + ok:false'
})

await runAsync('customer.geo：返回契约字段齐全，且不含地址/信用代码/电话', async () => {
  const result = await callDetailRoute('customer.geo', { scope: 'all' })
  assertEqual(result.status, 200, '状态码不符')
  assertEqual(result.body.ok, true, `ok 不符：${JSON.stringify(result.body).slice(0, 200)}`)
  for (const key of ['scope', 'generatedAt', 'summary', 'provinces', 'customers', 'uncovered', 'overseas', 'warnings', 'completeness', 'meta']) {
    assert(Object.prototype.hasOwnProperty.call(result.body, key), `返回体缺少 ${key}`)
  }
  for (const key of ['totalCustomers', 'locatedCustomers', 'uncoveredCustomers', 'overseasCustomers', 'coverageRate', 'provinceCount', 'topProvince']) {
    assert(Object.prototype.hasOwnProperty.call(result.body.summary || {}, key), `summary 缺少 ${key}`)
  }
  for (const key of ['requests', 'cacheHits', 'scanned', 'masterCustomers', 'truncated']) {
    assert(Object.prototype.hasOwnProperty.call(result.body.meta || {}, key), `meta 缺少 ${key}`)
  }
  const keys = collectKeys(result.body)
  const piiKeys = [...keys].filter((k) => PII_KEY_PATTERN.test(k))
  assert(piiKeys.length === 0, `返回体出现 PII 字段名：${piiKeys.join(', ')}`)
  const strings = collectStrings(result.body)
  const piiValues = strings.filter((s) => /13800000000|6214830000000000|91310115MA1HANBF4L|康新公路3377号|文三路/.test(s))
  assert(piiValues.length === 0, `返回体出现 PII 值：${piiValues.slice(0, 3).join(' | ')}`)
  return `字段齐全；PII 体检通过（${keys.size} 个键名）`
})

await runAsync('customer.geo：省份判定按信用代码/地址分流，判不出的进 uncovered、海外单列', async () => {
  const result = await callDetailRoute('customer.geo', { scope: 'all' })
  const located = result.body.customers || []
  const provinces = located.map((c) => c.province)
  assert(provinces.includes('上海'), `信用代码前缀应解析出上海，实际 ${provinces.join('/')}`)
  assert(provinces.includes('浙江'), `地址前缀应解析出浙江，实际 ${provinces.join('/')}`)
  assert(!provinces.includes('某某城市'), '不该从公司名猜出省份')
  const uncovered = result.body.uncovered || []
  assert(uncovered.length >= 1, '无地址线索的客户应进 uncovered')
  assert(uncovered.every((c) => !('province' in c)), 'uncovered 里不该再出现 province 字段（省份本来就判不出）')
  assert(uncovered.every((c) => 'customerName' in c && 'ownerName' in c && 'customerKind' in c), 'uncovered 行字段不符')
  const overseas = result.body.overseas || []
  assert(overseas.length >= 1, 'country=1 的客户应进 overseas')
  assert(overseas.every((c) => !('province' in c)), 'overseas 行不再单独带 province 字段')
  assert(overseas.every((c) => 'customerName' in c && 'ownerName' in c && 'customerKind' in c), 'overseas 行字段不符')
  const summary = result.body.summary || {}
  assertEqual(summary.totalCustomers, (located.length + uncovered.length + overseas.length), 'summary.totalCustomers 与分流数不一致')
  return `定位 ${located.length} / 未定位 ${uncovered.length} / 海外 ${overseas.length}`
})

await runAsync('customer.geo：provinces 契约字段齐全（scope=all 时金额与订单数为 null）', async () => {
  const result = await callDetailRoute('customer.geo', { scope: 'all' })
  const provinces = result.body.provinces || []
  assert(provinces.length >= 1, 'provinces 为空')
  for (const key of ['province', 'customerCount', 'signingAmount', 'orderCount', 'source', 'customerNames']) {
    assert(Object.prototype.hasOwnProperty.call(provinces[0], key), `provinces 行缺少 ${key}`)
  }
  assert(Array.isArray(provinces[0].customerNames), 'customerNames 不是数组')
  assertEqual(provinces[0].signingAmount, null, "scope='all' 时 signingAmount 应为 null（只有存量客户数）")
  assertEqual(provinces[0].orderCount, null, "scope='all' 时 orderCount 应为 null")
  const customers = result.body.customers || []
  for (const key of ['customerName', 'province', 'provinceSource', 'ownerName', 'customerKind', 'orderCount', 'signingAmount']) {
    assert(Object.prototype.hasOwnProperty.call(customers[0] || {}, key), `customers 行缺少 ${key}`)
  }
  assertEqual(result.body.meta?.source, 'customer_info+collection_analysis', 'meta.source 没写明工具链')
  return `provinces ${provinces.length} 个；scope=all 金额为 null`
})

await runAsync('customer.geo：一律不落盘（geo 结果不进磁盘缓存）', () => {
  // geo 过程要读 include_sensitive=true 的客户档案，payload 里只有省份名；
  // 但只要 geo 的结果或原始档案进了磁盘缓存，PII 就等于被明文写到磁盘上 —— 这里做静态断言。
  // 注意：必须按括号配对精确切函数体，不能用「切到下一个顶层 function」的粗暴办法，
  // 否则会把后面主看板的 disk.put 一并切进来，造成误报。
  for (const name of ['collectCustomerGeo', 'fetchCustomerGeo']) {
    const body = extractFunctionSource(indexSource, name)
    assert(body.length > 0, `源码里找不到 ${name}`)
    assert(!/\bdisk\s*\./.test(body), `${name} 里出现了磁盘缓存写入（disk.），geo 必须只走内存缓存`)
    assert(!/diskCache(File|Dir|Hash)/.test(body), `${name} 里出现了磁盘缓存路径，geo 必须只走内存缓存`)
  }
  return 'collectCustomerGeo / fetchCustomerGeo 内均无磁盘写入'
})

await runAsync('customer.geo：覆盖不到的部分必须在 warnings 里说清楚', async () => {
  const result = await callDetailRoute('customer.geo', { scope: 'all' })
  assert(Array.isArray(result.body.warnings), 'warnings 不是数组')
  assert(result.body.warnings.length > 0, '存在未定位客户却没有告警')
  assert(
    result.body.warnings.some((w) => String(w).includes('未能定位省份')),
    '缺少「未能定位省份」的说明',
  )
  const completeness = result.body.completeness || []
  assert(completeness.length > 0, 'completeness 为空')
  assert(completeness[0].totalKnown === false, '客户档案总数不可知，totalKnown 应为 false')
  return `${result.body.warnings.length} 条告警；completeness 已登记`
})

// ===========================================================================
// 第 5 轮口径修复自检（lead 实机验证后提的 5 条）
// ===========================================================================
section('第 5 轮：口径修复自检')

await runAsync('逾期天数归一：上游负值（未到期）→ null，另给布尔 overdue', async () => {
  // ── 纯函数层 ────────────────────────────────────────────────────────────
  const negative = mod.metrics.normalizeOverdueDays(-63)
  assertEqual(negative.overdueDays, null, '负数 overdue_days 必须归一成 null，不能把「还没到期」说成「逾期 -63 天」')
  assertEqual(negative.overdue, false, '负数（未到期）的 overdue 应为 false')
  const positive = mod.metrics.normalizeOverdueDays(120)
  assertEqual(positive.overdueDays, 120, '正数 overdue_days 应原样保留')
  assertEqual(positive.overdue, true, '正数（已逾期）的 overdue 应为 true')
  const unknown = mod.metrics.normalizeOverdueDays(null)
  assertEqual(unknown.overdueDays, null, '取不到时 overdueDays 应为 null')
  assertEqual(unknown.overdue, null, '取不到时 overdue 应为 null（不能给 false，把「不知道」说成「没逾期」）')

  // ── 路由层：customer.dashboard 的 orders[] ──────────────────────────────
  const customer = await callDetailRoute('customer.dashboard', {
    name: '示例客户01',
    startDate: '2026-01-01',
    endDate: '2026-10-25',
  })
  const rows = customer.body.orders || []
  const notDue = rows.find((row) => row.saleCode === 'SO202610002')
  const due = rows.find((row) => row.saleCode === 'SO202610001')
  assert(notDue, 'mock 里的未到期订单没进 orders[]')
  assert(due, 'mock 里的已逾期订单没进 orders[]')
  assertEqual(notDue.overdueDays, null, '未到期订单的 overdueDays 应为 null')
  assertEqual(notDue.overdue, false, '未到期订单的 overdue 应为 false')
  assertEqual(due.overdueDays, 120, '已逾期订单的 overdueDays 应原样保留')
  assertEqual(due.overdue, true, '已逾期订单的 overdue 应为 true')
  assert(
    String((customer.body.notes || []).join(' ')).includes('归一'),
    'notes 里没写清逾期天数的归一口径',
  )

  // ── 路由层：member.dashboard 的 recentOrders[] ──────────────────────────
  const member = await callDetailRoute('member.dashboard', {
    memberId: 901,
    startDate: '2026-01-01',
    endDate: '2026-10-25',
  })
  const recent = (member.body.recentOrders || []).find((row) => row.saleCode === 'SO202610002')
  assert(recent, 'mock 里的未到期订单没进 recentOrders[]')
  assertEqual(recent.overdueDays, null, 'recentOrders 的未到期订单 overdueDays 应为 null')
  assertEqual(recent.overdue, false, 'recentOrders 的未到期订单 overdue 应为 false')
  return '负值 → null + overdue=false；正值原样保留；notes 已写明归一口径'
})

await runAsync('订单状态：saleState 原始码保留 + saleStateLabel 中文标签（经验口径），notes 已写明依据', async () => {
  const customer = await callDetailRoute('customer.dashboard', {
    name: '示例客户01',
    startDate: '2026-01-01',
    endDate: '2026-10-25',
  })
  const rows = customer.body.orders || []
  const notDue = rows.find((row) => row.saleCode === 'SO202610002')
  const due = rows.find((row) => row.saleCode === 'SO202610001')
  assert(notDue && due, 'mock 里的订单没进 orders[]')
  assert(
    notDue.saleState === 1 || notDue.saleState === 2,
    'saleState 原始码没原样下发',
  )
  assertEqual(notDue.saleStateLabel, '在途未完成', 'sale_state=1 的中文标签应是「在途未完成」')
  assertEqual(due.saleStateLabel, '已完成', 'sale_state=2 的中文标签应是「已完成」')
  assert(
    String((customer.body.notes || []).join(' ')).includes('经验推断'),
    'notes 里没写清 saleStateLabel 是经验推断而非 ERP 官方码表',
  )

  const member = await callDetailRoute('member.dashboard', {
    memberId: 901,
    startDate: '2026-01-01',
    endDate: '2026-10-25',
  })
  const recent = (member.body.recentOrders || []).find((row) => row.saleCode === 'SO202610002')
  assert(recent, 'mock 里的未到期订单没进 recentOrders[]')
  assertEqual(recent.saleStateLabel, '在途未完成', 'recentOrders 的 saleStateLabel 也要有中文')
  return 'saleState 原始码 + saleStateLabel 中文（1=在途未完成 / 2=已完成），notes 已写明依据'
})

await runAsync('member.dashboard：collection.overview 自算 collectionRate（上游没给这个字段）', async () => {
  const member = await callDetailRoute('member.dashboard', {
    memberId: 901,
    startDate: '2026-01-01',
    endDate: '2026-10-25',
  })
  const ov = (member.body.collection || {}).overview || {}
  assert('collectionRate' in ov, 'collection.overview 缺 collectionRate')
  if (ov.signingAmount && ov.collectionAmount !== null) {
    const expect = Number((ov.collectionAmount / ov.signingAmount).toFixed(6))
    assertEqual(ov.collectionRate, expect, 'collection.overview.collectionRate 应等于 已回款 ÷ 签约额')
  }
  return 'collection.overview.collectionRate 自算，notes 已写明上游未直接给该字段'
})

await runAsync('报价统计：占比同时给样本内与全量两个口径（share / shareOfTotal）', () => {
  const stats = mod.metrics.buildQuoteStats({
    inquiryMetrics: { doc_count: 40 },
    inquiryRecords: [
      { code: 'Q1', customer_name: '客户甲', principal_name: '业务员A', add_time: '2026-10-01', reply_status: 1, product_count: 2 },
      { code: 'Q2', customer_name: '客户乙', principal_name: '业务员B', add_time: '2026-10-02', reply_status: 3, product_count: 1 },
    ],
    quotationMetrics: {
      doc_count: 490,
      doc_count_before_merge: 2703,
      merged_away_count: 306,
      amount_total: 58900000.00,
    },
    quotationRecords: [
      { code: 'B1', customer_name: '客户甲', principal_name: '业务员A', total_amount: 1500000, add_time: '2026-10-01', progress: 2, product_count: 3 },
      { code: 'B2', customer_name: '客户乙', principal_name: '业务员B', total_amount: 500000, add_time: '2026-10-02', progress: 1, product_count: 1 },
    ],
    periodOrderCount: 1200,
    rowLimit: 100,
  })
  // 口径必须落在**字段**里（前端不渲染 note）。
  assertEqual(stats.basis, 'sample', 'quoteStats 缺 basis=sample')
  assertEqual(stats.sampleAmount, 2000000, 'sampleAmount 应等于明细金额合计（样本口径）')
  assert(
    typeof stats.sampleShare === 'number' && stats.sampleShare > 0 && stats.sampleShare < 1,
    `sampleShare 应是 0~1 的样本覆盖率，实际 ${stats.sampleShare}`,
  )
  const topCustomer = stats.topQuotationCustomers[0]
  assert('share' in topCustomer, 'topQuotationCustomers 缺 share（样本内占比）')
  assert('shareOfTotal' in topCustomer, 'topQuotationCustomers 缺 shareOfTotal（与 KPI 同分母的全量占比）')
  assertEqual(topCustomer.share, 0.75, '样本内占比算错')
  assert(
    Math.abs(topCustomer.shareOfTotal - 1500000 / 58900000.00) < 1e-9,
    `全量占比算错：${topCustomer.shareOfTotal}`,
  )
  assert(
    Math.abs(stats.sampleShare - 2000000 / 58900000.00) < 1e-9,
    `sampleShare 算错：${stats.sampleShare}`,
  )
  assert('shareOfTotal' in stats.topQuotationPrincipals[0], 'topQuotationPrincipals 缺 shareOfTotal')
  assert(String(stats.note || '').includes('全量'), 'note 里没写明两个口径')
  return `share=${topCustomer.share}（样本内）/ shareOfTotal=${topCustomer.shareOfTotal.toFixed(6)}（与 KPI 同分母）`
})

await runAsync('geo 预算默认值：geoMaxRequests=300 / geoBudgetMs=300000，两处 patch 同步', () => {
  assertEqual(mod.DEFAULTS.geoMaxRequests, 300, 'DEFAULTS.geoMaxRequests 应为 300（实机 136 次请求吃满 120 上限）')
  assertEqual(mod.DEFAULTS.geoBudgetMs, 300000, 'DEFAULTS.geoBudgetMs 应为 300000')
  const cfg = readPluginConfig(patchText)
  assertEqual(Number(cfg.geoMaxRequests), 300, 'bundle 的 cordis.patch.yml 里 geoMaxRequests 应为 300')
  assertEqual(Number(cfg.geoBudgetMs), 300000, 'bundle 的 cordis.patch.yml 里 geoBudgetMs 应为 300000')
  // profile 侧的那份 patch 也必须同步 —— 只改一处会导致「打包的和跑的不是一个配置」。
  const profilePatch = path.join(
    process.env.DSH_PROFILE_DIR || path.join(process.env.USERPROFILE || '', '.dsh', 'profiles', 'desktop'),
    'cordis.patch.yml',
  )
  if (fs.existsSync(profilePatch)) {
    // profile 的 cordis.patch.yml 顶层是「每个插件一个 - id: xxx」的序列，
    // 跟 bundle 里「- insert: [{id, config}]」的写法不一样，所以不能直接用
    // readPluginConfig（它只认 insert 包裹的结构），这里两种结构都认。
    const profileCfg = findPluginConfig(fs.readFileSync(profilePatch, 'utf8'), 'erp-sales-dashboard')
    assert(profileCfg, 'profile 的 cordis.patch.yml 里找不到 erp-sales-dashboard 条目')
    assertEqual(Number(profileCfg.geoMaxRequests), 300, 'profile 的 cordis.patch.yml 里 geoMaxRequests 应为 300')
    assertEqual(Number(profileCfg.geoBudgetMs), 300000, 'profile 的 cordis.patch.yml 里 geoBudgetMs 应为 300000')
    return 'DEFAULTS 与两处 patch 三方一致（geoMaxRequests=300 / geoBudgetMs=300000）'
  }
  return 'DEFAULTS 与 bundle patch 一致（profile patch 不在本机，跳过）'
})

await runAsync('geo 订单分片：按 overview.order_count 判截断（上游 limit 硬顶 500），对半细分 ≤2 轮', () => {
  const code = stripCommentsAndStrings(indexSource)
  // 上游硬事实：limit 被硬顶在 500 行，传多大都只给 500 行 —— 单片必须按 500 取。
  assert(/ORDER_SLICE_LIMIT\s*=\s*500/.test(code), 'ORDER_SLICE_LIMIT 不是 500（上游 limit 被硬顶 500 行）')
  assert(/MAX_SPLIT_DEPTH\s*=\s*2/.test(code), 'MAX_SPLIT_DEPTH 不是 2')
  // 判截断必须用同一次响应的 overview.order_count，而不是「行数 == limit」。
  assert(
    /isOrderSliceTruncated\(\s*orders\.length\s*,\s*expected\s*,\s*ORDER_SLICE_LIMIT\s*\)/.test(code),
    '分片判定没有走 isOrderSliceTruncated(行数, 该片自己的 overview.order_count, 上限)',
  )
  assert(/overview\.order_count/.test(code), '没有读同一次响应里的 overview.order_count 来判截断')
  assert(
    !/orders\.length\s*<\s*ORDER_SLICE_LIMIT/.test(code),
    '还在用「行数 < limit」判截断 —— 上游 limit 传多大都只给 500 行，这个判据永远成立、拆不开',
  )
  assert(/depth\s*>=\s*MAX_SPLIT_DEPTH/.test(code), '缺少细分轮数上限判断')
  assert(/addDays\(/.test(code), '细分应按日期对半拆分')

  // ── 行为级：判截断规则本身 ────────────────────────────────────────────────
  const check = mod.metrics.isOrderSliceTruncated
  assert(typeof check === 'function', 'metrics 里没有导出 isOrderSliceTruncated')
  // 实机样本：2026-01 单月 687 单，接口只给 500 行 → 必须判定为「被截断」并细分
  assertEqual(check(500, 687, 500), true, '行数 500 < overview.order_count 687，应判定为被截断')
  // 拿到全了就不该再拆
  assertEqual(check(687, 687, 500), false, '行数与 overview.order_count 相等，不该再细分')
  assertEqual(check(500, 687, 2000), true, '即使 sliceLimit 写成 2000，也必须按 overview.order_count 判截断')
  // overview 取不到时的保守兜底：行数顶到上限就按可能截断处理
  assertEqual(check(500, null, 500), true, '取不到 overview.order_count 时应退回「行数顶到上限」的保守判据')
  assertEqual(check(499, null, 500), false, '取不到 overview.order_count 且行数没顶到上限时不应细分')
  return '单片 500 + 按 overview.order_count 判截断 + 对半细分最多 2 轮（行为级 5 个用例全过）'
})

await runAsync('geo 订单分片（端到端）：上游 limit 硬顶 500 时，靠 overview.order_count 细分后区间订单能取全', async () => {
  // ── 造一个「上游硬顶 500 行」的假 ERP ─────────────────────────────────────
  // lead 裸 RPC 实测的硬事实：limit 传多大都只给 500 行、没有翻页参数，
  // 但同一次响应的 overview.order_count 会如实报告**该窗口自己**的订单总数。
  // 这里按天合成订单：2026-01 共 687 单、2026-02 共 120 单（合计 807），
  // 窗口查询一律只返回前 500 行 —— 只有靠 overview.order_count 才能发现截断。
  const EPOCH = Date.parse('2026-01-01T00:00:00Z')
  const dayIndex = (dateStr) => Math.round((Date.parse(`${dateStr}T00:00:00Z`) - EPOCH) / 86400000)
  const dateOf = (idx) => new Date(EPOCH + idx * 86400000).toISOString().slice(0, 10)
  const dailyCount = (idx) => {
    if (idx < 0 || idx > 58) return 0
    if (idx < 31) return idx === 30 ? 27 : 22 // 1 月：30 天 × 22 + 最后一天 27 = 687
    return idx === 58 ? 12 : 4 // 2 月：27 天 × 4 + 最后一天 12 = 120
  }
  const ordersInWindow = (startDate, endDate) => {
    const rows = []
    for (let idx = dayIndex(startDate); idx <= dayIndex(endDate); idx += 1) {
      const date = dateOf(idx)
      for (let i = 0; i < dailyCount(idx); i += 1) {
        const even = idx % 2 === 0
        rows.push({
          sale_id: idx * 100 + i,
          sale_code: `SO${date.replace(/-/g, '')}${String(i).padStart(3, '0')}`,
          sale_ht_date: date,
          customer_pk: even ? 13783 : 90001,
          customer_code: even ? 'C90012' : 'C90001',
          customer_name: even ? '示例客户01' : '示例客户03',
          member_id: 901,
          member_name: '业务员01',
          department_name: '鲲鹏特战队',
          signing_amount: 1000,
          collection_amount: 1000,
          uncollected_amount: 0,
          overdue_days: 0,
        })
      }
    }
    return rows
  }
  const master = [
    {
      id: 13783,
      customer_id: 'C90012',
      customer_name: '示例客户01',
      customer_phone: '13800000000',
      customer_address: '上海市浦东新区康新公路3377号2幢301室',
      duty_paragraph: '91310115MA1HANBF4L',
      country: 0,
      area_name: '',
      customer_kind: 'CRO终端科技公司',
      principal_id: 77,
    },
    {
      id: 90001,
      customer_id: 'C90001',
      customer_name: '示例客户03',
      customer_phone: '13900000000',
      customer_address: '杭州市西湖区文三路 100 号',
      duty_paragraph: '',
      country: 0,
      area_name: '',
      customer_kind: '终端客户',
      principal_id: 77,
    },
  ]
  const collectionCalls = []
  const execute = async (payload) => {
    const args = payload.arguments || {}
    const wrap = (data) => ({ isError: false, value: { content: [{ type: 'text', text: JSON.stringify({ data }) }] } })
    if (payload.name.endsWith('member_performance_analysis')) {
      return wrap([{ member_id: 901, member_name: '业务员01', dep_name: '鲲鹏特战队' }])
    }
    if (payload.name.endsWith('customer_info')) return wrap(master)
    if (payload.name.endsWith('sales_order_collection_analysis')) {
      const all = ordersInWindow(String(args.start_date), String(args.end_date))
      const limit = Number(args.limit) || 500
      // 模拟上游硬顶：limit 传多大都只给 500 行，且没有翻页参数。
      const rows = all.slice(0, Math.min(limit, 500))
      collectionCalls.push({
        start: String(args.start_date),
        end: String(args.end_date),
        limit,
        returned: rows.length,
        real: all.length,
      })
      return wrap({
        overview: {
          order_count: all.length,
          signing_amount: all.length * 1000,
          collection_amount: all.length * 1000,
          uncollected_amount: 0,
          unpaid_order_count: 0,
          overdue_order_count: 0,
          problem_order_count: 0,
        },
        orders: rows,
      })
    }
    return { isError: true, error: { code: 'UNKNOWN_TOOL', message: `unknown tool ${payload.name}` } }
  }
  const harness = makeCtx(execute)
  mod.apply(harness.ctx, { cacheTtlMs: 0, geoBudgetMs: 20000, geoMaxRequests: 300 })
  const res = makeRes()
  await harness.registrations[0].handler(
    makeReq('POST', '/erp-sales-dashboard/api/customer.geo', JSON.stringify({
      scope: 'period',
      startDate: '2026-01-01',
      endDate: '2026-02-28',
    })),
    res,
  )
  const body = JSON.parse(res.state.body)
  assertEqual(res.state.status, 200, 'geo 路由没有返回 200')
  assertEqual(body.ok, true, `geo 路由返回 ok=false：${body.error}`)

  // ① 每片都按上游真实上限 500 取（不能传 2000，那会被上游硬顶、白白浪费）；
  //    例外是「区间订单总数（对账用）」那一次探测，它故意用 limit=1 只看总数。
  const probeCalls = collectionCalls.filter((c) => c.limit === 1)
  const sliceCalls = collectionCalls.filter((c) => c.limit !== 1)
  assertEqual(probeCalls.length, 1, `对账探测应该只调 1 次，实际 ${probeCalls.length} 次`)
  for (const call of sliceCalls) {
    assertEqual(call.limit, 500, `订单分片的 limit 不是 500：${call.start}~${call.end} → ${call.limit}`)
  }
  // ② 1 月（687 单 > 500）必须被拆成子窗口重查 —— 否则就会漏单
  const janCalls = sliceCalls.filter((c) => c.start === '2026-01-01' && c.end === '2026-01-31')
  assert(janCalls.length === 1, '1 月的窗口没有被单独读取')
  const monthWindows = new Set(['2026-01-01|2026-01-31', '2026-02-01|2026-02-28'])
  const subWindows = sliceCalls.filter((c) => !monthWindows.has(`${c.start}|${c.end}`))
  assert(subWindows.length >= 2, `没有出现按日期对半拆出的子窗口（当前子窗口 ${subWindows.length} 个）`)
  assert(
    subWindows.some((c) => c.real < 500),
    '子窗口的订单数应该都小于 500（拆开之后才拿得全）',
  )
  // ③ 拆完之后，区间订单必须取全（807 单），且不再报「未取全」
  const aggregated = (body.customers || []).reduce((sum, row) => sum + (row.orderCount || 0), 0)
  assertEqual(aggregated, 807, `聚合到的区间订单数不对（期望 807 = 687 + 120，实际 ${aggregated}）`)
  const incomplete = (body.warnings || []).filter((w) => w.includes('区间订单未取全'))
  assertEqual(incomplete.length, 0, `不该再报「区间订单未取全」：${incomplete.join(' / ')}`)
  assertEqual(body.meta.ordersTruncated, false, '订单不该被标记为截断')
  return `上游硬顶 500 时按 overview.order_count 细分：1 月 687 单拆成 ${subWindows.length} 个子窗口，区间订单取全 ${aggregated} 单，无「未取全」告警`
})

await runAsync('geo 省份客户名清单只给前 20 个（完整明细走 customers[]）', async () => {
  const code = stripCommentsAndStrings(indexSource)
  assert(/PROVINCE_CUSTOMER_NAMES_LIMIT\s*=\s*20/.test(code), 'PROVINCE_CUSTOMER_NAMES_LIMIT 不是 20')
  assert(
    /customerNames:\s*item\.customerNames\.slice\(0,\s*PROVINCE_CUSTOMER_NAMES_LIMIT\)/.test(code),
    'provinces[].customerNames 没有按 20 截断',
  )
  const result = await callDetailRoute('customer.geo', { scope: 'all' })
  const provinces = result.body.provinces || []
  assert(provinces.length >= 1, 'provinces 为空')
  for (const province of provinces) {
    assert(
      (province.customerNames || []).length <= 20,
      `省份 ${province.province} 的 customerNames 有 ${(province.customerNames || []).length} 个，超过 20`,
    )
  }
  return `provinces ${provinces.length} 个，每省 customerNames ≤ 20（完整明细在 customers[]）`
})

// ===========================================================================
// 8. 第 8 轮：A/B/E 类口径修复自检（task-2）
//
// 这一轮修的都是「数字看着像对的，其实口径是错的」：
//   A1 业务员档案的未回款额原本取的是**回款额**（back_money）；
//   A2 客户数原本用 uniqueCount(r.customer_count) —— 那数的是「客户数这个数字有多少不同取值」；
//   A3/A4/A5 未回款额没归一（上游把「已部分回款」的订单按全额计入未回款，数值虚高）；
//   A6 年度榜里查无此人时，缺口被算成「整个年度目标」；
//   B3 客户阶段算出来了却没下发；B4 岗位 / 中文在职状态缺失；B5 risks 字段没下发；
//   E2 Top 客户占比的分母是样本内合计；E3 售后「没闭环」和「不知道有没有闭环」混为一谈。
//
// 断言分两类：**静态**（源码里不该再有那个错误写法）与**行为级**（真跑一遍路由看返回值）。
// 只做静态断言不够 —— 写法改对了但值算错了，静态检查一样会通过；
// 只做行为断言也不够 —— 值对了但换个分支又错了。所以两类都写。
// ===========================================================================
section('8. 第 8 轮：A/B/E 类口径修复自检（task-2）')

const code8 = stripCommentsAndStrings(indexSource)

run('纯函数 normalizeUncollectedAmount：未回款 = 签约 − 已回款，上游原值另存', () => {
  assert(typeof mod.metrics.normalizeUncollectedAmount === 'function', 'metrics 未导出 normalizeUncollectedAmount')
  const full = mod.metrics.normalizeUncollectedAmount(100, 60, 100)
  assertEqual(full.value, 40, '归一未回款算错（应 100−60=40）')
  assertEqual(full.upstream, 100, '上游原值没有另存')
  assertEqual(full.basis, 'signing-minus-collection', 'basis 不对')
  const fallback = mod.metrics.normalizeUncollectedAmount(null, null, 55)
  assertEqual(fallback.value, 55, '取不到签约/回款时应回落上游原值')
  assertEqual(fallback.upstream, 55, '回落时上游原值也应保留')
  const empty = mod.metrics.normalizeUncollectedAmount(null, null, null)
  assertEqual(empty.value, null, '三个都取不到时应为 null（不是 0）')
  return '签约 100 / 回款 60 → 40（上游原值 100 另存）；取不到时回落上游；全空为 null'
})

run('纯函数 staffStatusLabel：0=离职 / 非0=在职 / 未知=null（不猜）', () => {
  assert(typeof mod.metrics.staffStatusLabel === 'function', 'metrics 未导出 staffStatusLabel')
  assertEqual(mod.metrics.staffStatusLabel(0), '离职', 'status=0 应为离职')
  assertEqual(mod.metrics.staffStatusLabel(1), '在职', 'status=1 应为在职')
  assertEqual(mod.metrics.staffStatusLabel(2), '在职', 'status=2（非 0）应为在职')
  assertEqual(mod.metrics.staffStatusLabel(null), null, '未知状态应为 null（前端显示「状态码 N」）')
  return '0→离职 / 非0→在职 / null→null'
})

run('纯函数 dedupCustomerJoin：同一客户多人跟单只算一次', () => {
  assert(typeof mod.metrics.dedupCustomerJoin === 'function', 'metrics 未导出 dedupCustomerJoin')
  const map = new Map([['101', '战狼特战队']])
  const result = mod.metrics.dedupCustomerJoin([
    { key: 'C1', principalId: 101 },
    { key: 'C1', principalId: 101 }, // 重复行
    { key: 'C2', principalId: 101 },
    { key: 'C3', principalId: 999 }, // join 不上成员
  ], map)
  assertEqual(result.joined, 2, '去重后 join 上的客户数应为 2')
  assertEqual(result.squadSets.get('战狼特战队').size, 2, '梯队去重客户数应为 2')
  assertEqual(result.memberSets.get('101').size, 2, '成员去重客户数应为 2')
  return '4 条记录（含 1 条重复）去重成 2 个客户，join 不上的不计入'
})

run('A1：业务员档案不再把回款额当未回款额（源码里已无该写法）', () => {
  assert(
    !/uncollectedAmount:\s*numOrNull\(row\.back_money\)/.test(code8),
    '成员行仍把 back_money（回款额）当未回款额',
  )
  assert(/normalizeUncollectedAmount\(\s*row\.order_total_amount/.test(code8), '成员行没有走归一函数')
  assert(/collectionAmount:\s*numOrNull\(row\.back_money\)/.test(code8), '成员行没有单独下发回款额')
  return '成员行改为「接单额 − 回款额」，并单独下发 collectionAmount'
})

await runAsync('A1/A5（行为）：member.dashboard 三处未回款都是「签约−已回款」，上游虚高的原值另存', async () => {
  // 造一份「上游把已部分回款的订单按全额计入未回款」的数据：
  // 签约 360000 / 已回 108000 → 真未回款 252000，但上游给 360000。
  const mock = makeDetailMockWith({
    sales_order_collection_analysis: {
      overview: {
        order_count: 3,
        signing_amount: 360000,
        collection_amount: 108000,
        uncollected_amount: 360000,
        unpaid_order_count: 0,
        partial_paid_order_count: 3,
        overdue_order_count: 1,
        problem_order_count: 0,
      },
      orders: [{
        sale_id: 1,
        sale_code: 'SO202610001',
        sale_state: 2,
        sale_ht_date: '2026-10-01',
        overdue_days: 120,
        customer_name: '示例客户01',
        member_id: 901,
        member_name: '业务员01',
        department_name: '鲲鹏特战队',
        signing_amount: 360000,
        collection_amount: 108000,
        uncollected_amount: 360000,
      }],
    },
    sales_person_360: {
      profile: {
        member_id: 901,
        member_name: '业务员01',
        username: 'YX90014',
        department_id: '13',
        department_name: '鲲鹏特战队',
        staff_name: '业务员01',
        join_time: '2022-03-01',
        status: 2,
        education: '本科',
        customer_count: 17,
        order_count: 204,
        signing_amount: 5700000.00,
        collection_amount: 4000000.00,
        uncollected_amount: 1704000.00,
        overdue_order_count: 21,
        problem_order_count: 0,
      },
      target: { target_amount: 5000000, warnings: [], signing_completion_rate: 114, collection_completion_rate: 80 },
      recent_orders: [{
        sale_code: 'SO202610001',
        sale_state: 2,
        sale_ht_date: '2026-10-01',
        overdue_days: 120,
        customer_name: '示例客户01',
        signing_amount: 360000,
        collection_amount: 108000,
        uncollected_amount: 360000,
      }],
    },
  })
  const result = await callMemberRouteWith(mock, {
    memberId: 901,
    startDate: '2026-01-01',
    endDate: '2026-10-25',
  })
  assertEqual(result.body.ok, true, `ok 不符：${JSON.stringify(result.body).slice(0, 200)}`)
  const period = result.body.periodMetrics || {}
  const overview = result.body.collection?.overview || {}
  const order0 = (result.body.collection?.orders || [])[0] || {}
  const recent0 = (result.body.recentOrders || [])[0] || {}
  assertEqual(period.uncollectedAmount, 252000, '区间未回款未按「签约−已回款」归一')
  assertEqual(period.uncollectedAmountUpstream, 360000, '区间上游未回款原值没有另存')
  assertEqual(overview.uncollectedAmount, 252000, 'collection.overview 未回款未归一')
  assertEqual(overview.uncollectedAmountUpstream, 360000, 'collection.overview 上游原值没有另存')
  assertEqual(order0.uncollectedAmount, 252000, 'collection.orders[] 未回款未归一')
  assertEqual(order0.uncollectedAmountUpstream, 360000, 'collection.orders[] 上游原值没有另存')
  assertEqual(recent0.uncollectedAmount, 252000, 'recentOrders[] 未回款未归一')
  assertEqual(recent0.uncollectedAmountUpstream, 360000, 'recentOrders[] 上游原值没有另存')
  return '上游给 360000（虚高）→ 全部归一为 252000（360000−108000），原值另存可对照'
})

run('A2：客户数不再用 uniqueCount(成员客户数)，改成三种口径并标 basis', () => {
  assert(!/uniqueCount\(filteredRanking/.test(code8), 'KPI 客户数仍在用 uniqueCount(filteredRanking, …)')
  assert(!/uniqueCount\(prevFilteredRanking/.test(code8), '去年同期客户数仍在用 uniqueCount(prevFilteredRanking, …)')
  assert(/customerCountBasis/.test(code8), '没有下发 customerCountBasis（前端无法知道这个数是哪种口径）')
  assert(/customerCountNote/.test(code8), '没有下发客户数口径说明')
  assert(/dedupCustomerJoin/.test(code8), '没有用「客户→负责人→成员→梯队」去重口径')
  return '三口径：erp-overview / dedup / member-sum，附口径说明'
})

run('A3：主看板未回款 = 上游展示 + 归一另存 + 口径说明（两层口径）', () => {
  // 第 9 轮实机复验后定稿：主 KPI 与业务工作台对齐 → 展示上游；明细/档案 → 归一。
  assert(/normalizeUncollectedAmount\(\s*uncollectedSigningBase/.test(code8), '主看板未回款没有走归一函数')
  assert(/uncollectedAmountUpstream/.test(code8), '主看板没有下发上游未回款原值')
  assert(/uncollectedAmountNormalized/.test(code8), '主看板没有下发归一后的未回款额')
  assert(/uncollectedNote/.test(code8), '主看板没有未回款口径说明')
  // 展示值必须优先上游（与业务工作台一致），只有上游取不到才用归一值顶上
  assert(
    /const uncollectedAmount = uncollectedAmountUpstream !== null\s*\?\s*uncollectedAmountUpstream\s*:\s*uncollectedAmountNormalized/.test(code8),
    '主 KPI 展示值没有优先用上游 uncollected_amount',
  )
  return '主 KPI 展示上游、归一值另存、差额写进 note（订单级仍按归一）'
})

run('A4：账龄/逾期明细按「签约−已回款」，回落上游时标明回落条数', () => {
  assert(
    /normalizeUncollectedAmount\(\s*order\.signing_amount/.test(code8),
    '账龄/逾期明细仍在直接用上游 uncollected_amount',
  )
  assert(/agingUncollectedNote/.test(code8), '没有账龄未回款口径说明')
  assert(/agingFallbackCount/.test(code8), '没有统计「取不到签约/回款而回落上游」的条数')
  return '账龄柱高与逾期金额均按归一口径，回落上游的条数写进 note'
})

run('E2：Top 客户同时给样本内占比与全量占比（share + shareOfTotal）', () => {
  assert(/shareOfTotal:\s*ratio\(record\.amount, totalSigningDenominator\)/.test(code8), 'Top 客户没有全量占比 shareOfTotal')
  assert(/shareBasis/.test(code8), 'Top 客户没有标出 share 的分母口径')
  assert(/totalSigningDenominator\s*=\s*numOrNull\(overviewRaw\.order_total_amount\)/.test(code8), '全量占比的分母不是区间接单额')
  return 'share=样本内占比，shareOfTotal=占全公司区间接单额的比例'
})

run('E3：售后闭环三态（closed/open/unknown），闭环率分母只算状态已知的', () => {
  assert(/closeState:/.test(code8), '售后行没有 closeState')
  assert(/unknownState/.test(code8), '售后块没有统计「状态未知」的条数')
  assert(/knownState/.test(code8), '售后块没有 knownState（闭环率的分母）')
  assert(
    !/closed:\s*num\(row\.status2\)\s*===\s*1/.test(code8),
    '还在用 status2===1 一刀切（状态缺失会被误判成未闭环）',
  )
  return "closed / open / unknown 三态，闭环率分母 = 状态已知的条数"
})

await runAsync('B3（行为）：customer.dashboard 下发客户阶段与首末单时间', async () => {
  const result = await callDetailRoute('customer.dashboard', {
    name: '示例客户01',
    startDate: '2026-01-01',
    endDate: '2026-10-25',
  })
  const lifecycle = result.body.lifecycle || {}
  assert(['新客期', '成长期', '成熟期', '沉睡期', '未知'].includes(lifecycle.stage), `stage 取值异常：${lifecycle.stage}`)
  assertEqual(lifecycle.stage, '成熟期', 'mock 客户连续合作 5 年，应判成熟期')
  assert(typeof lifecycle.stageBasis === 'string' && lifecycle.stageBasis.length > 0, '缺 stageBasis（阶段依据必须可见）')
  assertEqual(lifecycle.firstOrderTime, '2021-03-11', '首单时间取错')
  assertEqual(lifecycle.lastOrderTime, '2026-10-20', '末单时间取错')
  assertEqual(lifecycle.continuousYears, 5, '连续合作年数取错')
  assertEqual(lifecycle.daysSinceLastOrder, 5, '距末单天数取错')
  return `stage=${lifecycle.stage}；依据可见；首末单 2021-03-11 ~ 2026-10-20`
})

await runAsync('B5（行为）：两条路由的 profile.risks 都是字符串数组（前端逐条渲染）', async () => {
  const customer = await callDetailRoute('customer.dashboard', {
    name: '示例客户01',
    startDate: '2026-01-01',
    endDate: '2026-10-25',
  })
  const member = await callDetailRoute('member.dashboard', {
    memberId: 901,
    startDate: '2026-01-01',
    endDate: '2026-10-25',
  })
  for (const [label, body] of [['customer.dashboard', customer.body], ['member.dashboard', member.body]]) {
    const risks = body.profile?.risks
    assert(Array.isArray(risks), `${label} 的 profile.risks 不是数组`)
    assert(risks.length > 0, `${label} 的 profile.risks 是空数组（mock 里有逾期单，应当有风险提示）`)
    for (const item of risks) {
      assert(typeof item === 'string', `${label} 的 profile.risks 里有非字符串元素：${JSON.stringify(item)}`)
    }
  }
  const memberRisks = member.body.profile.risks.join(' | ')
  assert(memberRisks.includes('逾期'), `业务员路由的风险提示里没有逾期项：${memberRisks}`)
  return `客户路由 ${customer.body.profile.risks.length} 条 / 业务员路由 ${member.body.profile.risks.length} 条，均为字符串`
})

await runAsync('B4（行为）：member.dashboard 的岗位与中文在职状态来自员工档案', async () => {
  const result = await callDetailRoute('member.dashboard', {
    memberId: 901,
    startDate: '2026-01-01',
    endDate: '2026-10-25',
  })
  const profile = result.body.profile || {}
  assertEqual(profile.post, '销售经理', '岗位取错（应来自 staff_info.post_name）')
  assertEqual(profile.statusLabel, '在职', '中文在职状态取错')
  assertEqual(profile.statusSource, 'staff_info', '状态来源标错')
  // 员工档案里带 PII（手机号 / 身份证 / 银行账号），响应里一个字都不能有。
  const strings = collectStrings(result.body)
  const leaked = strings.filter((s) => /310101199001011234|6214830000000000/.test(s))
  assertEqual(leaked.length, 0, `员工档案的 PII 泄漏到响应里：${leaked.slice(0, 2).join(' | ')}`)
  return 'post=销售经理 / statusLabel=在职 / statusSource=staff_info；员工档案 PII 未外泄'
})

await runAsync('A6（行为）：年度榜查无此人时，完成率与缺口都是 null（不是 0、不是整个目标）', async () => {
  const mock = makeDetailMockWith({ sales_performance_ranking: { ranking: [] } })
  const result = await callMemberRouteWith(mock, {
    memberId: 901,
    startDate: '2026-01-01',
    endDate: '2026-10-25',
  })
  assertEqual(result.body.ok, true, `ok 不符：${JSON.stringify(result.body).slice(0, 200)}`)
  const target = result.body.target || {}
  assertEqual(target.targetAmount, 5000000, '年度目标额取错')
  assertEqual(target.available, false, '年度榜查无此人时 available 应为 false')
  assertEqual(target.ytdSigningAmount, null, '年度至今签约额取不到时必须是 null（不是 0）')
  assertEqual(target.signingCompletionRate, null, '完成率必须是 null（不是 0%）')
  assertEqual(target.collectionCompletionRate, null, '回款完成率必须是 null')
  assertEqual(target.signingGap, null, '缺口必须是 null（不是整个年度目标）')
  const warn = (target.warnings || []).join(' | ')
  assert(warn.includes('年度排行榜里没有该业务员'), `warnings 没有说明原因：${warn}`)
  return '目标 500 万但年度榜查无此人 → 完成率/缺口全为 null，并写明原因'
})

run('matrix：新增「客户数口径」「未回款口径归一」两行，状态仍只有三档', () => {
  assert(indexSource.includes('客户数口径（KPI）'), 'matrix 缺「客户数口径（KPI）」行')
  assert(indexSource.includes('未回款口径归一'), 'matrix 缺「未回款口径归一」行')
  assert(indexSource.includes('不再使用 uniqueCount'), 'matrix 没有说明客户数口径改了什么')
  return '两行已登记（状态：可用），并写明口径变更'
})

// ===========================================================================
// 9. 第 9 轮：STD 卡点分档文案 / staff 降级路径 / overview 未回款回归保护
// ===========================================================================
section('9. 第 9 轮：STD 卡点、staff 降级、未回款回归保护')

/**
 * 主看板的假 MCP。
 *
 * 这里只服务三件事：
 *   ① overview 级「未回款」归一后必须与上游值相等 —— 这是「主 KPI 与参照看板对齐」
 *      的回归保护：D5 参照看板的 3,700,000.00 = 签约 11,900,000.00 − 回款 8,200,000.00，
 *      恰好等于上游 uncollected_amount，所以 overview 这一层归一值必须等于上游值；
 *      （订单级两者不等时才需要归一 + 另存上游原值）
 *   ② STD 占比不可得时，quality.std.blockedAt 要能说清卡在哪一步；
 *   ③ matrix 的 STD 行体现同一个卡点。
 *
 * 其它工具一律返回失败 —— 它们失败只会让对应板块降级 + 写 warnings，
 * 不会让整条路由 reject（这正是插件承诺的行为，也是这里要顺带验一下的）。
 */
function makeDashboardMock(options) {
  const opts = options || {}
  const okData = (data) => ({
    isError: false,
    value: { content: [{ type: 'text', text: JSON.stringify({ data }) }] },
  })
  const failed = (message) => ({
    isError: true,
    error: { code: 'UPSTREAM_ERROR', message },
  })
  return async (payload) => {
    const name = payload.name
    if (name.endsWith('product_efficiency_analysis')) {
      if (opts.shippingFails) return failed('product_efficiency_analysis 不可用')
      const details = opts.shippingDetails || []
      return okData({ details, summary: { total_count: details.length } })
    }
    if (name.endsWith('std_product_info_query')) {
      if (opts.stdProbeFails) return failed('std 产品表不可用')
      return okData([])
    }
    if (name.endsWith('sales_order_collection_analysis')) {
      return okData({
        overview: opts.collectionOverview || {},
        orders: opts.collectionOrders || [],
      })
    }
    return failed(`unknown tool ${name}`)
  }
}

/** 用指定 mock 跑主看板路由。 */
async function callDashboardRouteWith(executeImpl, body) {
  const harness = makeCtx(executeImpl)
  mod.apply(harness.ctx, { cacheTtlMs: 0 })
  const res = makeRes()
  await harness.registrations[0].handler(
    makeReq('POST', '/erp-sales-dashboard/api/dashboard', JSON.stringify(body)),
    res,
  )
  return { status: res.state.status, body: JSON.parse(res.state.body) }
}

const DASHBOARD_RANGE = { startDate: '2026-01-01', endDate: '2026-10-25' }

run('纯函数 stdBlockedStage：三种卡点分别识别（shipping / no-goods / probe），成功时 null', () => {
  const m = mod.metrics
  assert(typeof m.stdBlockedStage === 'function', 'metrics 没导出 stdBlockedStage')
  assertEqual(m.stdBlockedStage({ ok: true, shippingRows: 5, goodsTotal: 3 }), null, '判定成功时必须是 null')
  assertEqual(m.stdBlockedStage({ ok: false, shippingRows: 0, goodsTotal: 0 }), 'shipping', '第一步就卡住时必须是 shipping')
  assertEqual(m.stdBlockedStage({ ok: false, shippingRows: 7, goodsTotal: 0 }), 'no-goods', '有明细但没货号时必须是 no-goods')
  assertEqual(m.stdBlockedStage({ ok: false, shippingRows: 7, goodsTotal: 3, goodsJudged: 0 }), 'probe', '判定全失败时必须是 probe')
  return 'shipping / no-goods / probe / null 四种都能判对'
})

run('纯函数 stdBlockedText：三种卡点文案互不相同，且都保留「不得按 0% 展示」', () => {
  const m = mod.metrics
  assert(typeof m.stdBlockedText === 'function', 'metrics 没导出 stdBlockedText')
  const shipping = m.stdBlockedText('shipping', { shippingRows: 0 })
  const probe = m.stdBlockedText('probe', { shippingRows: 3, goodsTotal: 2, goodsJudged: 0 })
  const noGoods = m.stdBlockedText('no-goods', { shippingRows: 3, goodsTotal: 0 })
  assert(shipping.includes('出库明细取不到'), `shipping 文案没说清卡在第一步：${shipping}`)
  assert(probe.includes('货号判定全部失败'), `probe 文案不对：${probe}`)
  assert(noGoods.includes('窗口内没有可用货号'), `no-goods 文案不对：${noGoods}`)
  const set = new Set([shipping, probe, noGoods])
  assertEqual(set.size, 3, '三种卡点的文案必须各不相同')
  for (const text of [shipping, probe, noGoods]) {
    assert(text.includes('不得按 0% 展示'), `文案缺少「不得按 0% 展示」：${text}`)
  }
  return '三条文案分开，且都写明「不得按 0% 展示」'
})

await runAsync('STD 卡点 shipping：出库明细取不到 → blockedAt=shipping + 首步文案 + 占比 null', async () => {
  const mock = makeDashboardMock({ shippingFails: true })
  const result = await callDashboardRouteWith(mock, DASHBOARD_RANGE)
  assertEqual(result.body.ok, true, '整体不应 reject')
  const std = (result.body.quality || {}).std || {}
  assertEqual(std.blockedAt, 'shipping', 'blockedAt 判错')
  assertEqual(std.status, 'unavailable', 'status 应为 unavailable')
  assertEqual(std.stdShare, null, '占比必须为 null（不是 0）')
  assert(String(std.note).includes('出库明细取不到'), `note 没写清卡在第一步：${std.note}`)
  assert(String(std.note).includes('不得按 0% 展示'), 'note 缺少「不得按 0% 展示」')
  return 'blockedAt=shipping，占比 null，文案指向第一步'
})

await runAsync('STD 卡点 probe：货号判定全失败 → blockedAt=probe + 判定文案', async () => {
  const mock = makeDashboardMock({
    shippingDetails: [{ sale_code: 'SO1', goods_code: 'G1' }],
    stdProbeFails: true,
    collectionOverview: { order_count: 1, signing_amount: 1000, collection_amount: 600, uncollected_amount: 400 },
    collectionOrders: [{ sale_code: 'SO1', signing_amount: 1000, collection_amount: 600, uncollected_amount: 400 }],
  })
  const result = await callDashboardRouteWith(mock, DASHBOARD_RANGE)
  assertEqual(result.body.ok, true, '整体不应 reject')
  const std = (result.body.quality || {}).std || {}
  assertEqual(std.blockedAt, 'probe', 'blockedAt 判错')
  assertEqual(std.status, 'unavailable', 'status 应为 unavailable')
  assertEqual(std.stdShare, null, '占比必须为 null（不是 0）')
  assert(String(std.note).includes('货号判定全部失败'), `note 不对：${std.note}`)
  return 'blockedAt=probe，占比 null，文案指向 STD 产品表'
})

await runAsync('STD 卡点 no-goods：明细拿到但窗口内没货号 → blockedAt=no-goods', async () => {
  const mock = makeDashboardMock({
    // 出库明细里的 sale_code 与订单对不上 → 签单额摊不到任何货号行上。
    shippingDetails: [{ sale_code: 'SO_OTHER', goods_code: 'G2' }],
    collectionOverview: { order_count: 1, signing_amount: 1000, collection_amount: 600, uncollected_amount: 400 },
    collectionOrders: [{ sale_code: 'SO1', signing_amount: 1000, collection_amount: 600, uncollected_amount: 400 }],
  })
  const result = await callDashboardRouteWith(mock, DASHBOARD_RANGE)
  assertEqual(result.body.ok, true, '整体不应 reject')
  const std = (result.body.quality || {}).std || {}
  assertEqual(std.blockedAt, 'no-goods', 'blockedAt 判错')
  assertEqual(std.status, 'unavailable', 'status 应为 unavailable')
  assertEqual(std.stdShare, null, '占比必须为 null（不是 0）')
  assert(String(std.note).includes('窗口内没有可用货号'), `note 不对：${std.note}`)
  return 'blockedAt=no-goods，占比 null'
})

run('matrix 的 STD 行也体现卡点（三种卡点各有文案，且保留「不得按 0% 展示」）', () => {
  assert(indexSource.includes('卡在第一步：出库明细取不到'), 'matrix 缺 shipping 卡点文案')
  assert(indexSource.includes('但窗口内没有可用货号'), 'matrix 缺 no-goods 卡点文案')
  assert(indexSource.includes('但货号判定全部失败'), 'matrix 缺 probe 卡点文案')
  assert(indexSource.includes('不得按 0% 展示'), 'matrix 的 STD 行丢了「不得按 0% 展示」')
  return '三档卡点文案都在 matrix 里'
})

await runAsync('staff 工具失败 → profile.post / statusLabel 置空，notes 写明「取数失败 / 不猜」', async () => {
  const mock = makeDetailMockWith({ staff_info: { __fail: 'std 服务不可用' } })
  const result = await callMemberRouteWith(mock, {
    memberId: 901,
    startDate: '2026-01-01',
    endDate: '2026-10-25',
  })
  assertEqual(result.body.ok, true, `ok 不符：${JSON.stringify(result.body).slice(0, 200)}`)
  const profile = result.body.profile || {}
  assert(!profile.post, `post 应为空，实际 ${JSON.stringify(profile.post)}`)
  assert(!profile.statusLabel, `statusLabel 应为空，实际 ${JSON.stringify(profile.statusLabel)}`)
  const notes = (result.body.notes || []).join(' | ')
  assert(notes.includes('取数失败'), `notes 没有区分「工具失败」与「查无此人」：${notes.slice(0, 300)}`)
  assert(notes.includes('不猜'), `notes 没有写明「不猜」：${notes.slice(0, 300)}`)
  assert(notes.includes('staff_info'), 'notes 没有指出是 staff_info 这条链路')
  return '岗位与在职状态留空（前端显示「—」），并写明是取数失败而非查无此人'
})

/**
 * 第 9 轮第 2 版：主 KPI 未回款口径改成「展示上游、归一值另存」。
 *
 * 这里的数字直接用 lead 真机实测值（2026-01-01~2026-10-25，refresh:true）：
 *   回款额 7,200,000.00、上游 uncollected_amount 4,815,000.00、
 *   签约−回款 = 4,800,000.00（两者差 15,000.00 —— 上游把部分回款按全额计入）。
 * 上一版断言「归一值 == 上游值」在真机上不成立（差 15,000），是假绿，已改成下面这些。
 */
const REAL_SIGNING = 12000000.00
const REAL_COLLECTION = 7200000.00
const REAL_UPSTREAM_UNCOLLECTED = 4815000.00
const REAL_NORMALIZED_UNCOLLECTED = 4800000.00

function makeUncollectedDashboardMock() {
  return makeDashboardMock({
    collectionOverview: {
      order_count: 1,
      signing_amount: REAL_SIGNING,
      collection_amount: REAL_COLLECTION,
      uncollected_amount: REAL_UPSTREAM_UNCOLLECTED,
      overdue_order_count: 1,
      problem_order_count: 0,
    },
    collectionOrders: [{
      sale_code: 'SO1',
      customer_name: '测试客户',
      customer_code: 'C001',
      member_name: '测试业务员',
      department_name: '鲲鹏特战队',
      overdue_days: 45,
      signing_amount: REAL_SIGNING,
      collection_amount: REAL_COLLECTION,
      uncollected_amount: REAL_UPSTREAM_UNCOLLECTED,
    }],
  })
}

await runAsync('主 KPI 未回款：展示值 = 上游 uncollected_amount（与业务工作台一致），归一值另存并给出差额', async () => {
  const result = await callDashboardRouteWith(makeUncollectedDashboardMock(), DASHBOARD_RANGE)
  assertEqual(result.body.ok, true, '整体不应 reject')
  const kpis = ((result.body.overview || {}).kpis) || []
  const item = kpis.find((k) => k.key === 'uncollected')
  assert(item, 'overview.kpis 里没有 uncollected')
  assertClose(Number(item.value), REAL_UPSTREAM_UNCOLLECTED, '主 KPI 展示值必须等于上游 uncollected_amount', 0.02)
  assertClose(Number(item.uncollectedAmountUpstream), REAL_UPSTREAM_UNCOLLECTED, '上游原值没带上来', 0.02)
  assertClose(Number(item.uncollectedAmountNormalized), REAL_NORMALIZED_UNCOLLECTED, '归一值必须是「签约 − 回款」', 0.02)
  assertClose(
    Number(item.uncollectedAmountUpstream) - Number(item.uncollectedAmountNormalized),
    15000.00,
    '上游与归一值的差额必须对得上',
    0.02,
  )
  assert(item.uncollectedBasis && String(item.uncollectedBasis).length > 0, 'uncollectedBasis 不能为空')
  assert(item.uncollectedNote && String(item.uncollectedNote).length > 0, 'uncollectedNote 不能为空（前端要显示口径）')
  assert(String(item.uncollectedNote).includes('主 KPI'), 'note 没说明主 KPI 用的是哪个口径')
  assert(String(item.uncollectedNote).includes('归一'), 'note 没说明明细用的是归一口径')
  return `展示值 ${item.value}（上游，与业务工作台一致）；归一值 ${item.uncollectedAmountNormalized}；差额 15000.00；四个口径字段齐全`
})

await runAsync('collection 数据卡的未回款项同样带齐四个口径字段（两处都要能显示口径）', async () => {
  const result = await callDashboardRouteWith(makeUncollectedDashboardMock(), DASHBOARD_RANGE)
  const card = ((result.body.collection || {}).kpis) || []
  const item = card.find((k) => k.key === 'uncollected')
  assert(item, 'collection.kpis 里没有 uncollected')
  assertClose(Number(item.value), REAL_UPSTREAM_UNCOLLECTED, '数据卡主数值也必须用上游口径', 0.02)
  assert(item.uncollectedAmountUpstream != null, '数据卡项缺 uncollectedAmountUpstream')
  assert(item.uncollectedAmountNormalized != null, '数据卡项缺 uncollectedAmountNormalized')
  assert(item.uncollectedBasis && String(item.uncollectedBasis).length > 0, '数据卡项缺 uncollectedBasis')
  assert(item.uncollectedNote && String(item.uncollectedNote).length > 0, '数据卡项缺 uncollectedNote')
  return '数据卡与 overview KPI 同名同义，四个字段齐全'
})

await runAsync('订单级（账龄 / 逾期明细）仍是归一口径，不随主 KPI 一起回退上游', async () => {
  const result = await callDashboardRouteWith(makeUncollectedDashboardMock(), DASHBOARD_RANGE)
  const collection = result.body.collection || {}
  const aging = collection.aging || {}
  const agingTotal = (aging.rows || []).reduce((sum, row) => sum + Number(row.amount || 0), 0)
  assertClose(agingTotal, REAL_NORMALIZED_UNCOLLECTED, '账龄金额必须是归一值（签约−回款），不能是上游值', 0.02)
  const overdue = collection.overdue || {}
  const overdueTotal = (overdue.rows || []).reduce((sum, row) => sum + Number(row.amount || 0), 0)
  assertClose(overdueTotal, REAL_NORMALIZED_UNCOLLECTED, '逾期明细金额必须是归一值', 0.02)
  return '账龄与逾期明细金额 = 4800000.00（归一），未随主 KPI 回退成上游 4,815,000.00'
})

await runAsync('售后数据取不到 → 闭环率 null（不是 0%），closeStateNote 写明「售后数据取不到」', async () => {
  const result = await callDashboardRouteWith(makeDashboardMock({ shippingFails: true }), DASHBOARD_RANGE)
  const aftersale = (result.body.collection || {}).aftersale || {}
  assertEqual(aftersale.dataAvailable, false, 'dataAvailable 应为 false（售后工具失败）')
  assertEqual(aftersale.rate, null, '闭环率必须下发 null，不是 0%（0% 会被读成「一单都没闭环」）')
  assertEqual(aftersale.status, 'unavailable', 'status 应为 unavailable')
  assert(
    String(aftersale.closeStateNote).includes('售后数据取不到'),
    `closeStateNote 没表达「售后数据取不到」：${aftersale.closeStateNote}`,
  )
  assert(String(aftersale.closeStateNote).includes('不是 0%'), 'closeStateNote 没写明「不是 0%」')
  return '闭环率 null + dataAvailable=false + closeStateNote 说明「售后数据取不到，不是 0%」'
})

// ===========================================================================
// 汇总
// ===========================================================================
process.stdout.write('\n' + '─'.repeat(64) + '\n')
if (failed === 0) {
  process.stdout.write(`汇总：共 ${total} 项检查，全部通过（0 失败）\n`)
  process.stdout.write('结果：自检通过 ✅\n')
  process.exit(0)
} else {
  process.stdout.write(`汇总：共 ${total} 项检查，通过 ${total - failed} 项，失败 ${failed} 项\n`)
  process.stdout.write('失败明细：\n')
  for (const item of failureList) {
    process.stdout.write(`  · ${item.name}${item.detail ? ` — ${item.detail}` : ''}\n`)
  }
  process.stdout.write('结果：自检未通过 ❌\n')
  process.exit(1)
}
