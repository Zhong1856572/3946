// ---------------------------------------------------------------------------
// verify-host.mjs —— ERP 销售仪表盘 Host 半的**端到端**离线验证脚本
//
// 用途：在不启动 DSH 的前提下，用裸 MCP JSON-RPC 复刻 DSH 的 `ctx.tools.execute`
//       行为，把 Host 半的 apply() 真正跑一遍，拿到**真实 ERP 数据**的响应体，
//       从而验证：取数编排、口径计算、降级策略、warnings 与调用记录是否正确。
//
// 用法：
//   node verify-host.mjs                       # 默认区间：本年 1/1 → 今天
//   node verify-host.mjs 2026-01-01 2026-10-25 # 指定区间
//   node verify-host.mjs --parallel            # 并发调用（默认按服务器串行排队）
//   node verify-host.mjs --out payload.json    # 指定输出文件
//   node verify-host.mjs --cache-test          # 缓存行为验证（连打 3 次，验证 6 小时缓存命中）
//
// 注意：ERP 的 8003/8007 服务在**同一 session 并发调用**时会串号（历史教训），
//       因此本脚本默认**按服务器串行排队**；--parallel 仅用于对比观察。
// ---------------------------------------------------------------------------
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/**
 * MCP 端点与 x-api-key **不再硬编码在脚本里** —— 本脚本会随安装包分发，凭据不能外流。
 * 读取优先级：
 *   1) 环境变量：ERP_MCP_URL / ERP_MCP_KEY、STD_MCP_URL / STD_MCP_KEY、PLANNING_MCP_URL / PLANNING_MCP_KEY
 *   2) 本目录 mcp.endpoints.local.json（开发机本地文件，**不随安装包分发**）
 *   3) 本目录 mcp.endpoints.json（使用者自备）
 * 端点写法："http://192.0.2.10:8001/mcp" 或 "192.0.2.10:8001"（缺 path 按 /mcp 补）。
 */
const ENDPOINT_FAMILIES = {
  erp: { prefix: 'mcp__erp__', defaultPort: 8001, label: 'ERP业务咨询事业群数据分析' },
  std: { prefix: 'mcp__std__', defaultPort: 8006, label: 'ERP Unified Analytics / STD' },
  planning: { prefix: 'mcp__planning__', defaultPort: 8003, label: 'ERP统筹数据分析' },
}

function loadEndpointConfig() {
  const localFile = ['mcp.endpoints.local.json', 'mcp.endpoints.json']
    .map((n) => path.join(HERE, n))
    .find((p) => fs.existsSync(p))
  let fromFile = {}
  if (localFile) {
    try {
      fromFile = JSON.parse(fs.readFileSync(localFile, 'utf8'))
    } catch (e) {
      console.error(`[verify-host] 端点配置解析失败：${localFile} → ${e.message}`)
      process.exit(1)
    }
  }
  const cfg = {}
  for (const name of Object.keys(ENDPOINT_FAMILIES)) {
    const up = name.toUpperCase()
    const f = fromFile[name] || {}
    cfg[name] = {
      url: process.env[`${up}_MCP_URL`] || f.url || '',
      key: process.env[`${up}_MCP_KEY`] || f.key || '',
      label: f.label || ENDPOINT_FAMILIES[name].label,
    }
  }
  return cfg
}

function parseEndpoint(url, defaultPort) {
  const m = String(url || '').match(/^(?:https?:\/\/)?([^/:?#]+)(?::(\d+))?([^?#]*)/)
  if (!m || !m[1]) return { host: '127.0.0.1', port: defaultPort, path: '/mcp' }
  return { host: m[1], port: m[2] ? Number(m[2]) : defaultPort, path: m[3] || '/mcp' }
}

const ENDPOINTS = loadEndpointConfig()
const SERVERS = {}
for (const [name, meta] of Object.entries(ENDPOINT_FAMILIES)) {
  const ep = ENDPOINTS[name]
  if (!ep.url && !ep.key) {
    console.error(
      `[verify-host] 缺少 ${name} 的 MCP 端点配置。请设置环境变量 ${name.toUpperCase()}_MCP_URL / ` +
      `${name.toUpperCase()}_MCP_KEY，或在脚本同目录放置 mcp.endpoints.local.json（本仓库与安装包都不提供端点模板文件，请按 INSTALL.md §2.1 自行准备）。`,
    )
    process.exit(1)
  }
  SERVERS[meta.prefix] = { ...parseEndpoint(ep.url, meta.defaultPort), key: ep.key, label: ep.label }
}

const argv = process.argv.slice(2)
const flags = new Set(argv.filter((a) => a.startsWith('--')))
const positional = argv.filter((a) => !a.startsWith('--'))
const outIndex = argv.indexOf('--out')
const OUT_FILE = outIndex >= 0 ? argv[outIndex + 1] : path.join(HERE, 'docs', 'verify-host-output.json')
const PARALLEL = flags.has('--parallel')
const CACHE_TEST = flags.has('--cache-test')

function todayStr() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
const START = positional[0] || `${new Date().getFullYear()}-01-01`
const END = positional[1] || todayStr()

// ── 裸 MCP JSON-RPC ────────────────────────────────────────────────────────
function rpc(srv, method, params, sid, rid) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: rid, method, params: params || {} })
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'x-api-key': srv.key,
    }
    if (sid) headers['mcp-session-id'] = sid
    const req = http.request({ host: srv.host, port: srv.port, path: srv.path, method: 'POST', headers, timeout: 120000 }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => resolve({ text: data, headers: res.headers }))
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

function parseSse(raw) {
  let t = raw
  if (t.includes('data:')) {
    t = t.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n')
  }
  try { return JSON.parse(t) } catch { return { __unparsed: raw.slice(0, 400) } }
}

const sessions = new Map()   // host:port → session id
const queues = new Map()     // port → Promise（串行队列）

async function ensureSession(srv) {
  const sk = `${srv.host}:${srv.port}`
  if (sessions.has(sk)) return sessions.get(sk)
  const init = await rpc(srv, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'erp-sales-dashboard-verify', version: '1' },
  }, null, 1)
  const sid = init.headers['mcp-session-id'] || init.headers['Mcp-Session-Id']
  await rpc(srv, 'notifications/initialized', {}, sid, 2)
  sessions.set(sk, sid)
  return sid
}

function routeOf(name) {
  for (const prefix of Object.keys(SERVERS)) {
    if (name.startsWith(prefix)) {
      return { prefix, server: SERVERS[prefix], tool: name.slice(prefix.length) }
    }
  }
  throw new Error(`未知工具名：${name}`)
}

let callSeq = 0
async function rawToolCall(name, args) {
  const { prefix, server, tool } = routeOf(name)
  const sid = await ensureSession(server)
  const r = await rpc(server, 'tools/call', { name: tool, arguments: args || {} }, sid, ++callSeq)
  const j = parseSse(r.text)
  const result = j.result || {}
  if (result.isError) {
    const text = (result.content || []).map((c) => c.text || '').join(' ')
    throw new Error(`${name} isError: ${text.slice(0, 200)}`)
  }
  // 忠实复刻 MCP 工具返回信封：{ content: [{ type: 'text', text: '<json>' }] }
  return { value: result }
}

/** 按服务器串行排队，避免同一 session 并发串号。 */
function serial(port, fn) {
  const prev = queues.get(port) || Promise.resolve()
  const next = prev.then(fn, fn)
  queues.set(port, next.catch(() => {}))
  return next
}

// ── 伪造 DSH 宿主 ─────────────────────────────────────────────────────────
const callLog = []
async function toolsExecute({ name, arguments: args }) {
  const { server } = routeOf(name)
  const started = Date.now()
  try {
    const value = PARALLEL
      ? await rawToolCall(name, args)
      : await serial(server.port, () => rawToolCall(name, args))
    callLog.push({ tool: name, ok: true, ms: Date.now() - started })
    return value
  } catch (e) {
    callLog.push({ tool: name, ok: false, ms: Date.now() - started, note: String(e.message || e).slice(0, 160) })
    throw e
  }
}

const registered = []
const services = {
  webServer: {
    register(opts) {
      registered.push(opts)
      return () => {}
    },
  },
  agents: { list: () => [] },
  locale: { register: () => {} },
}

const ctx = {
  get(key) { return services[key] },
  effect(fn) { try { const r = fn(); return typeof r === 'function' ? r : undefined } catch { return undefined } },
  tools: { execute: toolsExecute },
}

// ── 伪造 HTTP 请求/响应 ───────────────────────────────────────────────────
// 注意：插件的 readJsonBody 走的是 **Node 事件风格**（req.on('data'/'end'/'error')），
// 所以这里必须用真正的 EventEmitter 并在下一个 tick 派发，否则 handler 的 Promise 永不落定
// （Node 会以 exit code 13 = "unsettled top-level await" 收场）。
function makeReq(method, url, body) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  const buf = Buffer.from(payload, 'utf8')
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = { 'content-type': 'application/json', 'content-length': String(buf.length) }
  req.setEncoding = () => {}
  req.resume = () => {}
  setImmediate(() => {
    if (buf.length) req.emit('data', buf)
    req.emit('end')
  })
  return req
}

function makeRes() {
  const out = { status: 0, headers: null, body: '' }
  return {
    out,
    writeHead(status, headers) { out.status = status; out.headers = headers },
    end(payload) { out.body = payload === undefined ? '' : String(payload) },
  }
}

// ── 主流程 ────────────────────────────────────────────────────────────────
const mod = await import(pathToFileURL(path.join(HERE, 'index.js')).href)
if (typeof mod.apply !== 'function') {
  console.error('FAIL: index.js 没有导出 apply()')
  process.exit(1)
}
if (Object.prototype.hasOwnProperty.call(mod, 'Config')) {
  console.error('FAIL: index.js 导出了 Config —— 框架会对它调 validate() 导致激活期崩溃')
  process.exit(1)
}

// 验证配置 = **生产配置的唯一真相源**（cordis.patch.yml 里的 config 块）。
// 以前这里手抄了一份，改了 patch 就会漂移（曾经抽样预算不一致）；
// 现在直接读 patch，改一处两边同步。
//
// 注意：**不再把 cacheTtlMs 覆盖成 0**。早期这么做是为了"验证时别吃缓存"，
// 但它会让交付的 payload 里 meta.cacheTtlMs=0、meta.cacheUntil 缺失，
// 页面第 8 页签的缓存卡就显示「TTL 0 小时」——看起来像 bug。
// 现在改为：TTL 用生产值，缓存新鲜度靠**请求体 refresh=true** 保证（见下方请求构造），
// 落盘目录指向真实 profile 的缓存目录，顺带给用户预热一份磁盘缓存（重启后首屏秒开）。
const { readPluginConfig } = await import('./lib/mini-yaml.mjs')
const patchText = fs.readFileSync(path.join(HERE, 'cordis.patch.yml'), 'utf8')
const config = { ...readPluginConfig(patchText) }

// 断言：patch 的 config 键集合必须与 index.js 的 DEFAULTS 一致（不多不少），
// 否则说明 patch 写了个插件根本不认识的键（要么报错要么被静默忽略）。
const patchKeys = Object.keys(config).sort()
const defaultKeys = Object.keys(mod.DEFAULTS).sort()
const unknownKeys = patchKeys.filter((k) => !defaultKeys.includes(k))
if (unknownKeys.length) {
  console.error('FAIL: cordis.patch.yml 里有 index.js 不认识的配置键：', unknownKeys)
  process.exit(1)
}
// cacheTtlMs 不再被覆盖，patch 与 DEFAULTS 的键必须完全一致。
const missingKeys = defaultKeys.filter((k) => !patchKeys.includes(k))
if (missingKeys.length) {
  console.error('FAIL: cordis.patch.yml 缺少 index.js DEFAULTS 里的配置键：', missingKeys)
  process.exit(1)
}
console.log(`✔ 验证配置直接取自 cordis.patch.yml（${patchKeys.length} 个键，与 DEFAULTS 完全一致）`)

if (!CACHE_TEST) {
  // 落盘到真实 profile 的缓存目录（与 DSH 运行时同一位置），不污染 bundle 目录。
  // cacheDir 是插件内部支持的键（diskCacheDir 会读它），但它不属于用户配置面，
  // 所以放在「键集合断言」之后再设，避免被当成 patch 里多出来的配置键。
  const profileDir = process.env.DSH_PROFILE_DIR
    || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'profiles', 'desktop')
  config.cacheDir = path.join(profileDir, 'cache', 'erp-sales-dashboard')
}

// ── 缓存行为验证模式 ──────────────────────────────────────────────────────
// 用户反馈「每次进面板都要重拉 3~5 分钟」，根因是早期版本用「零告警才缓存」，
// 而本插件恒有 1 条 STD 预算告警 → 缓存永不命中。
// 这里用生产 TTL（6 小时）连打 3 次，验证：第 1 次算并写缓存、第 2 次命中缓存且秒回、
// 第 3 次带 refresh=true 时强制重取。
if (CACHE_TEST) {
  const os = await import('node:os')
  const cacheDir = path.join(os.tmpdir(), 'erp-sales-dashboard-cachetest')
  fs.rmSync(cacheDir, { recursive: true, force: true })
  config.cacheTtlMs = 21600000      // 6 小时，与生产一致
  config.cacheDir = cacheDir        // 落盘到临时目录，不污染 bundle
  config.stdProbeBudget = 3         // 只为让这次验证跑得快一点，缓存机制与探测预算无关
  config.tierSampleSize = 2
  config.customerSampleSize = 2
  config.visitSampleSize = 2
}

mod.apply(ctx, config)

const route = registered.find((r) => String(r.path || '').includes('erp-sales-dashboard'))
if (!route) {
  console.error('FAIL: 没有注册 /erp-sales-dashboard 路由，实际注册了：', registered.map((r) => r.path))
  process.exit(1)
}

console.log(`▶ 区间 ${START} ~ ${END}（${PARALLEL ? '并发' : '按服务器串行'}）`)

// ── 缓存行为验证：连打 3 次 ────────────────────────────────────────────────
// 第 1 次：真取数 → 写缓存（cached=false）
// 第 2 次：同参数 → 必须命中缓存（cached=true）且秒回
// 第 3 次：带 refresh=true → 必须绕过缓存重取（cached=false）
async function callDashboard(body) {
  const req = makeReq('POST', `${route.path}/dashboard`, body)
  const res = makeRes()
  const started = Date.now()
  await route.handler(req, res)
  return { status: res.out.status, body: res.out.body, ms: Date.now() - started }
}

if (CACHE_TEST) {
  console.log('\n===== 缓存行为验证（TTL 6 小时）=====')
  const first = await callDashboard({ startDate: START, endDate: END })
  const p1 = JSON.parse(first.body)
  console.log(`① 第 1 次（真取数）  : HTTP ${first.status} / ${first.ms}ms / cached=${p1.meta?.cached} / cacheUntil=${p1.meta?.cacheUntil ? new Date(p1.meta.cacheUntil).toISOString() : '无'}`)
  console.log(`   cacheNote        : ${p1.meta?.cacheNote || '（无）'}`)
  console.log(`   warnings         : ${(p1.warnings || []).length} 条（告警不该阻止缓存）`)

  const second = await callDashboard({ startDate: START, endDate: END })
  const p2 = JSON.parse(second.body)
  console.log(`② 第 2 次（应命中）  : HTTP ${second.status} / ${second.ms}ms / cached=${p2.meta?.cached} / cacheUntil=${p2.meta?.cacheUntil ? new Date(p2.meta.cacheUntil).toISOString() : '无'}`)

  const third = await callDashboard({ startDate: START, endDate: END, refresh: true })
  const p3 = JSON.parse(third.body)
  console.log(`③ 第 3 次（refresh） : HTTP ${third.status} / ${third.ms}ms / cached=${p3.meta?.cached}`)

  const problems = []
  if (p1.meta?.cached !== false) problems.push('第 1 次不应命中缓存')
  if (p1.meta?.cacheUntil === undefined) problems.push('第 1 次缺 meta.cacheUntil')
  if (p2.meta?.cached !== true) problems.push('第 2 次没有命中缓存（用户会每次重拉）')
  if (p2.meta?.cacheUntil === undefined) problems.push('第 2 次缺 meta.cacheUntil')
  if (second.ms >= first.ms) problems.push(`第 2 次（${second.ms}ms）没有比第 1 次（${first.ms}ms）快`)
  if (p2.northStar?.rows?.[0]?.value !== p1.northStar?.rows?.[0]?.value) problems.push('命中缓存的数值与首次不一致')
  if (p3.meta?.cached !== false) problems.push('refresh=true 没有绕过缓存')
  if (problems.length) {
    console.log('\n❌ 缓存验证失败：')
    for (const p of problems) console.log('   ·', p)
    process.exit(1)
  }
  console.log('\n✅ 缓存验证通过：首次取数后写入缓存 → 再次进入命中缓存（秒回）→ refresh 可强制重取')
  console.log(`   提速比：${first.ms}ms → ${second.ms}ms（${(first.ms / Math.max(second.ms, 1)).toFixed(1)}×）`)
  process.exit(0)
}

const t0 = Date.now()
const req = makeReq('POST', `${route.path}/dashboard`, { startDate: START, endDate: END, refresh: true })
const res = makeRes()
await route.handler(req, res)
const elapsed = Date.now() - t0

console.log(`◀ HTTP ${res.out.status}，用时 ${elapsed}ms，响应 ${res.out.body.length} 字节`)
if (res.out.status !== 200) {
  console.error(res.out.body.slice(0, 800))
  process.exit(1)
}

let payload
try {
  payload = JSON.parse(res.out.body)
} catch (e) {
  console.error('FAIL: 响应不是合法 JSON', e.message)
  process.exit(1)
}

fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true })
fs.writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2), 'utf8')
console.log(`✔ 完整响应已写入 ${OUT_FILE}`)

// ── 摘要 ─────────────────────────────────────────────────────────────────
const p = payload
console.log('\n===== 摘要 =====')
console.log('ok               :', p.ok)
console.log('period           :', p.period && `${p.period.startDate} ~ ${p.period.endDate}`)
console.log('meta             :', JSON.stringify(p.meta || {}))
console.log('warnings         :', (p.warnings || []).length, '条')
for (const w of p.warnings || []) console.log('   ⚠', w)
console.log('northStar rows   :', (p.northStar?.rows || []).length)
console.log('overview.kpis    :', (p.overview?.kpis || []).length)
console.log('overview.trend   :', (p.overview?.trend || []).length, '期；trendPrev', (p.overview?.trendPrev || []).length, '期')
console.log('squads           :', (p.overview?.squads || []).map((s) => `${s.name}:${s.headcount}人/${Math.round((s.signing || 0) / 10000)}万`).join('  '))
console.log('ranking          :', (p.overview?.ranking || []).length, '人；growth', (p.overview?.growth || []).length, '人')
console.log('quality.std      :', JSON.stringify(p.quality?.std || {}).slice(0, 300))
console.log('quality.abc      :', JSON.stringify(p.quality?.abc || {}).slice(0, 260))
console.log('collection.aging :', JSON.stringify(p.collection?.aging || []).slice(0, 200))
console.log('collection.overdue:', (p.collection?.overdue?.rows || []).length, '条（样本）；aftersale', JSON.stringify(p.collection?.aftersale || {}).slice(0, 200))
console.log('customer.tiers   :', JSON.stringify(p.customer?.tiers || {}).slice(0, 220))
console.log('customer.repurchase:', JSON.stringify(p.customer?.repurchase || {}).slice(0, 220))
console.log('funnel.stages    :', JSON.stringify(p.funnel?.stages || []).slice(0, 420))
console.log('funnel.threeYear :', JSON.stringify(p.funnel?.threeYear || []))
console.log('growth.levels    :', JSON.stringify(p.growth?.levels || {}).slice(0, 200))
console.log('todo rows        :', (p.todo?.rows || []).length)
console.log('matrix rows      :', (p.matrix || []).length)
console.log('calls            :', (p.calls || []).length, '（本脚本直连', callLog.length, '）')

const failed = (p.calls || []).filter((c) => !c.ok)
if (failed.length) {
  console.log('\n--- 失败的调用 ---')
  for (const f of failed) console.log('   ✗', f.tool, f.note || '')
}

process.exit(0)
