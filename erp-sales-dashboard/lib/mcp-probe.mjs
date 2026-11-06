// ---------------------------------------------------------------------------
// MCP 直连探测（只读）
//
// 用途：check-install 要回答「换一台设备后，这个插件能不能取到数」。
// 关键风险是**连接器名字对不上** —— DSH 里连接器的「服务器名」如果不是
// erp / std / planning，插件发出去的 mcp__<连接器名>__<工具名> 就找不到人。
//
// 本模块做两件事：
//   1) 从若干位置找到 MCP 服务的地址与凭据（文件优先，其次环境变量）；
//   2) 对每个服务做一次 MCP 握手 + tools/list，拿回**服务侧真实工具名**，
//      与插件要的清单比对。
//
// 安全红线（硬要求）：
//   · 只读，不写任何文件；
//   · **绝不打印 key / token / header 值**，只打印 url；
//   · 探测失败一律降级为提示，不让整个安装核对失败。
// ---------------------------------------------------------------------------

import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'

/** 插件需要的三个连接器（server 名 → 期望前缀） */
export const MCP_SERVERS = ['erp', 'std', 'planning']

/**
 * 各分组的默认端口与默认前缀。
 * 与插件运行时（bundle/index.js 的 PREFIX_GROUPS）保持一致：
 * 端口 8001=erp / 8006=std / 8003=planning。
 */
export const PREFIX_GROUP_DEFAULTS = {
  erp: { defaultPort: 8001, defaultPrefix: 'mcp__erp__' },
  std: { defaultPort: 8006, defaultPrefix: 'mcp__std__' },
  planning: { defaultPort: 8003, defaultPrefix: 'mcp__planning__' },
}

/** 从 url 里取端口（取不到返回 null） */
export function portOfUrl(url) {
  const m = /^[a-z]+:\/\/[^/:]+(?::(\d+))?/i.exec(String(url || ''))
  if (!m) return null
  return m[1] ? Number(m[1]) : null
}

/**
 * 按插件运行时的同一套规则，算出本机每个分组最终会用哪个前缀。
 * 规则：**用户配置 > 按端口认领 > 按连接器名认领 > 内置默认名**。
 *
 * 安全红线：本函数**只读 serverName / url / enabled**，
 * 绝不触碰 auth.apiKeyValue 等凭据字段，也绝不打印它们。
 *
 * @param {object[]} connections loadConnectorStore 的结果
 * @param {object} configured    补丁里的 config.toolPrefixes（可能为空对象）
 * @returns {object} group → { prefix, source, serverName, port, reason }
 */
export function resolvePrefixPlan(connections, configured = {}) {
  const usable = (Array.isArray(connections) ? connections : [])
    .filter((c) => c && c.enabled && c.url)
  const out = {}
  for (const [group, def] of Object.entries(PREFIX_GROUP_DEFAULTS)) {
    const userPrefix = (configured && typeof configured[group] === 'string' && configured[group].trim())
      ? String(configured[group]).trim()
      : ''
    if (userPrefix) {
      out[group] = { prefix: userPrefix, source: 'config', serverName: '', port: null, reason: '按补丁里的 toolPrefixes 配置' }
      continue
    }
    let hit = usable.find((c) => portOfUrl(c.url) === def.defaultPort)
    let reason = `按端口 ${def.defaultPort} 认领`
    if (!hit) {
      hit = usable.find((c) => String(c.serverName || '').toLowerCase() === group.toLowerCase())
      reason = '按连接器名匹配'
    }
    if (hit) {
      out[group] = {
        prefix: `mcp__${hit.serverName || group}__`,
        source: 'discovered',
        serverName: hit.serverName || '',
        port: portOfUrl(hit.url),
        reason,
      }
    } else {
      out[group] = {
        prefix: def.defaultPrefix,
        source: 'default',
        serverName: '',
        port: null,
        reason: '未认领到，回退内置默认名',
      }
    }
  }
  return out
}

/** 各 server 的环境变量名 */
const ENV_KEYS = {
  erp: { url: 'ERP_MCP_URL', key: 'ERP_MCP_KEY' },
  std: { url: 'STD_MCP_URL', key: 'STD_MCP_KEY' },
  planning: { url: 'PLANNING_MCP_URL', key: 'PLANNING_MCP_KEY' },
}

/**
 * 找 MCP 服务端点。
 * 查找顺序（先到先得，每个 server 独立）：本地文件 → 环境变量。
 *   文件：<搜索目录>/mcp.endpoints.local.json  →  <搜索目录>/mcp.endpoints.json
 *   环境变量：ERP_MCP_URL / ERP_MCP_KEY（std / planning 同理）
 *
 * @param {string[]} searchDirs 依次搜索的目录
 * @returns {Record<string, {url:string,key:string,label:string,source:string}>}
 */
export function loadEndpoints(searchDirs) {
  const out = {}

  const files = ['mcp.endpoints.local.json', 'mcp.endpoints.json']
  for (const fileName of files) {
    for (const dir of searchDirs) {
      if (!dir) continue
      const p = path.join(dir, fileName)
      let raw = null
      try { raw = fs.readFileSync(p, 'utf8') } catch { continue }
      let json = null
      try { json = JSON.parse(raw) } catch { continue }
      for (const server of MCP_SERVERS) {
        if (out[server]) continue
        const entry = json && json[server]
        if (entry && typeof entry === 'object' && entry.url) {
          out[server] = {
            url: String(entry.url),
            key: typeof entry.key === 'string' ? entry.key : '',
            label: typeof entry.label === 'string' ? entry.label : '',
            source: p,
          }
        }
      }
    }
  }

  for (const server of MCP_SERVERS) {
    if (out[server]) continue
    const url = process.env[ENV_KEYS[server].url]
    if (!url) continue
    out[server] = {
      url: String(url),
      key: process.env[ENV_KEYS[server].key] || '',
      label: '',
      source: `环境变量 ${ENV_KEYS[server].url}`,
    }
  }

  return out
}

/** 发一次 JSON-RPC；返回 {text, headers} */
function rpc(url, key, method, params, sid, timeoutMs) {
  return new Promise((resolve, reject) => {
    let target
    try { target = new URL(url) } catch (e) { reject(new Error(`地址不是合法 URL：${url}`)); return }
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params || {} })
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'Content-Length': Buffer.byteLength(body),
    }
    if (key) headers['x-api-key'] = key
    if (sid) headers['mcp-session-id'] = sid
    const mod = target.protocol === 'https:' ? https : http
    const req = mod.request(
      { protocol: target.protocol, hostname: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, method: 'POST', headers },
      (res) => {
        let data = ''
        res.on('data', (c) => { data += c })
        res.on('end', () => resolve({ text: data, headers: res.headers }))
      },
    )
    req.setTimeout(timeoutMs, () => { req.destroy(new Error(`连接超时（${timeoutMs}ms）`)) })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

/** 解析 MCP 响应：兼容纯 JSON 与 SSE（data: 行） */
function parseRpc(text) {
  let t = String(text || '')
  if (t.includes('data:')) {
    t = t.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n')
  }
  try { return JSON.parse(t) } catch { return null }
}

/**
 * 探测一个 MCP 服务：initialize → notifications/initialized → tools/list。
 * @returns {Promise<{ok:boolean, tools:string[], error:string|null}>}
 */
export async function probeMcpServer({ url, key, timeoutMs = 15000 }) {
  try {
    const init = await rpc(url, key, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'erp-sales-dashboard-check', version: '1' },
    }, null, timeoutMs)
    const initJson = parseRpc(init.text)
    if (initJson && initJson.error) {
      return { ok: false, tools: [], error: `握手被拒：${initJson.error.message || JSON.stringify(initJson.error)}` }
    }
    const sid = init.headers['mcp-session-id'] || init.headers['Mcp-Session-Id'] || null
    try {
      await rpc(url, key, 'notifications/initialized', {}, sid, timeoutMs)
    } catch { /* 通知失败不影响后续 tools/list */ }
    const list = await rpc(url, key, 'tools/list', {}, sid, timeoutMs)
    const json = parseRpc(list.text)
    if (!json) return { ok: false, tools: [], error: '响应不是合法 JSON-RPC' }
    if (json.error) {
      return { ok: false, tools: [], error: `tools/list 报错：${json.error.message || JSON.stringify(json.error)}` }
    }
    const tools = Array.isArray(json.result && json.result.tools) ? json.result.tools : []
    const names = tools
      .map((t) => (typeof t === 'string' ? t : (t && typeof t.name === 'string' ? t.name : '')))
      .filter(Boolean)
      // 服务侧存的是裸名；万一存了带前缀的全名，也剥掉再比
      .map((n) => n.replace(/^mcp__[a-z0-9_.-]+__/i, ''))
    return { ok: true, tools: names, error: null }
  } catch (e) {
    return { ok: false, tools: [], error: (e && e.message) ? String(e.message) : String(e) }
  }
}

/** 把 key 掩掉，只留 url 给人看（安全红线：永远不打印 key） */
export function describeEndpoint(entry) {
  if (!entry) return ''
  return `${entry.url}（来源：${entry.source}${entry.label ? `，${entry.label}` : ''}）`
}

/**
 * 读 DSH 自己的 MCP 连接器存储：<dshHome>/storages/mcp_connector.json
 *
 * 这是「这台机器上连接器到底叫什么」的第一手证据：
 *   · serverName  → 决定工具名的前缀段（mcp__<serverName>__<工具名>）；
 *   · url         → 服务地址；
 *   · auth        → api-key 模式的凭据（**只用来发起只读探测，绝不打印**）。
 *
 * 插件默认按 erp / std / planning 找连接器；这台机器上如果叫别的名字
 * （比如 erp-cn），面板就会整块「不可得」—— check-install 要把这件事说清楚。
 *
 * @returns {{source:string, exists:boolean, error:string|null, connections:object[]}}
 */
export function loadConnectorStore(dshHome) {
  const p = path.join(dshHome, 'storages', 'mcp_connector.json')
  let raw = null
  try { raw = fs.readFileSync(p, 'utf8') } catch {
    return { source: p, exists: false, error: null, connections: [] }
  }
  let json = null
  try { json = JSON.parse(raw) } catch {
    return { source: p, exists: true, error: '不是合法 JSON', connections: [] }
  }
  const table = json && json.tables && json.tables.connections
  const list = Array.isArray(table) ? table : (table && typeof table === 'object' ? Object.values(table) : [])
  const connections = []
  for (const c of list) {
    if (!c || typeof c !== 'object') continue
    const url = c.url || (c.server && c.server.url) || ''
    if (!url) continue
    const auth = c.auth || {}
    connections.push({
      key: c.key || '',
      connectorId: c.connectorId || '',
      name: c.name || '',
      serverName: c.serverName || '',
      url: String(url),
      enabled: c.enabled !== false,
      authMode: auth.mode || '',
      apiKeyHeader: auth.apiKeyHeader || 'x-api-key',
      apiKeyValue: typeof auth.apiKeyValue === 'string' ? auth.apiKeyValue : '',
    })
  }
  return { source: p, exists: true, error: null, connections }
}

/** 从连接器记录拼出探测目标（key 只往内传，不往外印） */
export function probeTargetFromConnection(conn) {
  return { url: conn.url, key: conn.apiKeyValue || '' }
}

/** 连接器显示名（不泄露任何凭据） */
export function describeConnection(conn) {
  const parts = [conn.url]
  parts.push(`服务器名=${conn.serverName || '(未设置)'}`)
  if (conn.name) parts.push(`显示名=${conn.name}`)
  if (!conn.enabled) parts.push('已停用')
  return parts.join('，')
}
