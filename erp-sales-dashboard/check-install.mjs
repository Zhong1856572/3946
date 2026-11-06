#!/usr/bin/env node
// ---------------------------------------------------------------------------
// check-install.mjs —— 只读核对 ERP 销售仪表盘插件的安装状态
// ---------------------------------------------------------------------------
// 用法：
//   node check-install.mjs
//   node check-install.mjs --profile desktop --dsh-home "D:\临时\dsh-home"
//
// 本脚本**只读**：不写、不删任何文件。
// 退出码：0 全部通过 / 1 有检查项不通过
// ---------------------------------------------------------------------------

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { parseArgs, parseConfigOverrides, ok, warn, fail, section } from './lib/cli.mjs'
import { PLUGIN_ID, PLUGIN_PKG_NAME, PLUGIN_VERSION, DEFAULT_CONFIG, THRESHOLD_KEYS, TOPLEVEL_CONFIG_KEYS, OBJECT_CONFIG_KEYS, TOOL_PREFIX_GROUPS, configValueEquals, formatYamlScalar } from './lib/config-defaults.mjs'
import { readBlockConfig, findBlocks } from './lib/patch-editor.mjs'
import { readLinkTarget, normalizePathForCompare, defaultDshHome, toPosixPath, readTextFile, readJsonFile } from './lib/fsx.mjs'
import { toRows, pickTable } from './lib/shape.mjs'
import { REQUIRED_TOOLS, fullToolName, CONNECTOR_GROUPS, DEFAULT_TOOL_PREFIXES } from './lib/required-tools.mjs'
import { loadEndpoints, probeMcpServer, describeEndpoint, MCP_SERVERS, loadConnectorStore, describeConnection, resolvePrefixPlan } from './lib/mcp-probe.mjs'

const HELP = `
ERP 销售仪表盘插件（${PLUGIN_PKG_NAME}）安装状态核对
版本 ${PLUGIN_VERSION}

用法：
  node check-install.mjs [选项]

选项：
  --profile <名称>       DSH profile 名，默认 desktop
  --dsh-home <目录>      DSH home，默认取环境变量 DSH_HOME，否则取用户主目录下的 .dsh
  --target <目录>        插件安装目录，默认 <dsh-home>/plugins/erp-sales-dashboard
  --config k=v,k=v       核对时按这些覆盖值比对（安装时用过 --config 就填一样的）；
                         阈值键：${THRESHOLD_KEYS.join(' / ')}
  --help                 显示本帮助

说明：没有用 --config 指定的键，如果安装后的值与默认值不同但**合法**，
      记为「自定义值」并通过；如果**不合法**（例如阈值不是 0~1 的数字），
      记为不通过——插件运行时会把它回退成默认值，等于配置没生效。
`

/** 配置值是否合法（与插件运行时自己的校验口径一致） */
function isValidConfigValue(key, value) {
  const bare = String(key).replace(/^thresholds\./, '')
  if (THRESHOLD_KEYS.includes(bare)) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
  }
  if (OBJECT_CONFIG_KEYS.includes(bare)) {
    // 对象型：每一项都必须是「mcp__<连接器名>__」形式的非空字符串
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    return Object.entries(value).every(([group, prefix]) => (
      TOOL_PREFIX_GROUPS.includes(group)
      && typeof prefix === 'string'
      && /^mcp__[A-Za-z0-9_.-]+__$/.test(prefix)
    ))
  }
  if (TOPLEVEL_CONFIG_KEYS.includes(bare)) {
    if (bare === 'salesFirstDepName' || bare === 'aiProvider' || bare === 'aiModel') {
      return typeof value === 'string' && value.trim().length > 0
    }
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
  }
  return true
}

let failed = 0
let warned = 0
const mark = (cond, text, hint) => {
  if (cond) { ok(text); return true }
  fail(text + (hint ? ` —— ${hint}` : ''))
  failed += 1
  return false
}
const soft = (cond, text) => {
  if (cond) { ok(text); return true }
  warn(text)
  warned += 1
  return false
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) { console.log(HELP); process.exit(0) }
  const profileName = typeof args.profile === 'string' && args.profile ? args.profile : 'desktop'
  const dshHome = typeof args['dsh-home'] === 'string' && args['dsh-home']
    ? path.resolve(args['dsh-home'])
    : defaultDshHome()
  const profileDir = path.join(dshHome, 'profiles', profileName)
  const targetDir = typeof args.target === 'string' && args.target
    ? path.resolve(args.target)
    : path.join(dshHome, 'plugins', PLUGIN_ID)
  const pkgPath = path.join(profileDir, 'package.json')
  const patchPath = path.join(profileDir, 'cordis.patch.yml')
  const linkPath = path.join(profileDir, 'node_modules', '@local', PLUGIN_PKG_NAME.split('/').pop())

  // ---- 判定安装模式与插件实际所在目录 ----
  // 两种模式并存：
  //   native：DSH 原生命令装的 —— 插件由 pnpm 装进 profile/node_modules/@local/<name>
  //           （pnpm 会把它做成一个指向 .pnpm/ 内部目录的链接），dependencies 写成
  //           "file:<tgz 绝对路径>"；
  //   manual：手工模式装的 —— 插件在 <home>/plugins/<id>，node_modules 里是 junction 指过去，
  //           dependencies 写成 "link:<安装目录绝对路径>"。
  // 判别主依据 = profile package.json 里的依赖规格（file: → native，link: → manual），
  // 路径只是辅助；这样 pnpm 造成的 junction 不会被误判成手工模式。
  const profilePkgEarly = readJsonFile(pkgPath)
  const depSpecEarly = profilePkgEarly && profilePkgEarly.dependencies
    ? profilePkgEarly.dependencies[PLUGIN_PKG_NAME]
    : undefined
  let installedDir = null
  let mode = 'unknown'
  if (typeof depSpecEarly === 'string' && depSpecEarly.startsWith('file:')) {
    mode = 'native'
  } else if (typeof depSpecEarly === 'string' && depSpecEarly.startsWith('link:')) {
    mode = 'manual'
  }
  const linkTarget = fs.existsSync(linkPath) ? readLinkTarget(linkPath) : null
  if (linkTarget && fs.existsSync(linkTarget)) {
    // 链接目标就是插件实际所在处（native 下是 pnpm 的 .pnpm 内部目录，manual 下是 plugins/<id>）
    installedDir = linkTarget
    if (mode === 'unknown') {
      mode = normalizePathForCompare(linkTarget) === normalizePathForCompare(targetDir) ? 'manual' : 'native'
    }
  } else if (fs.existsSync(path.join(linkPath, 'package.json'))) {
    installedDir = linkPath
    if (mode === 'unknown') mode = 'native'
  } else if (fs.existsSync(path.join(targetDir, 'package.json'))) {
    installedDir = targetDir
    if (mode === 'unknown') mode = 'manual'
  }
  const dir = installedDir || targetDir

  // 核对时可传 --config：安装时覆盖过的值，按覆盖值比对（而不是按默认值）
  let overrides = {}
  try {
    overrides = parseConfigOverrides(args.config)
  } catch (e) {
    fail(e.message)
    process.exit(e.exitCode || 2)
  }

  console.log(`ERP 销售仪表盘插件（${PLUGIN_PKG_NAME}）安装核对`)
  console.log(`DSH home：${dshHome}　profile：${profileName}`)

  // ---- 1. DSH home / profile ----
  section('1. DSH home 与 profile')
  mark(fs.existsSync(dshHome), `DSH home 存在：${dshHome}`)
  const profilesRoot = path.join(dshHome, 'profiles')
  const profiles = fs.existsSync(profilesRoot)
    ? fs.readdirSync(profilesRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    : []
  mark(fs.existsSync(profileDir), `profile 目录存在：${profileDir}`)
  if (profiles.length) ok(`当前 DSH home 下的 profile：${profiles.join('、')}`)

  // ---- 2. 插件目录内容 ----
  section('2. 插件目录内容')
  ok(`安装模式    ：${mode === 'native' ? 'native（DSH 原生命令 / pnpm 安装）' : mode === 'manual' ? 'manual（手工安装：复制目录 + 链接）' : '未识别'}`)
  ok(`插件目录    ：${dir}`)
  mark(fs.existsSync(dir) && fs.statSync(dir).isDirectory(), `插件目录存在：${dir}`)
  const bundlePkgPath = path.join(dir, 'package.json')
  if (fs.existsSync(bundlePkgPath)) {
    let bundlePkg = null
    try { bundlePkg = JSON.parse(readTextFile(bundlePkgPath)) } catch { bundlePkg = null }
    mark(!!bundlePkg && bundlePkg.name === PLUGIN_PKG_NAME,
      `插件 package.json 的 name 正确：${PLUGIN_PKG_NAME}`,
      bundlePkg ? `实际是 ${bundlePkg.name}` : '文件不是合法 JSON')
  } else {
    mark(false, '插件 package.json 存在', `${bundlePkgPath} 找不到`)
  }
  for (const rel of ['index.js', 'client.js', 'cordis.patch.yml', path.join('locale', 'zh.json'), 'icon.svg']) {
    mark(fs.existsSync(path.join(dir, rel)), `关键文件存在：${rel}`)
  }

  // ---- 3. node_modules 里的插件目录 ----
  section('3. node_modules 里的插件目录')
  const linkExists = fs.existsSync(linkPath)
  mark(linkExists, `node_modules/@local/${PLUGIN_PKG_NAME.split('/').pop()} 存在：${linkPath}`)
  if (linkExists) {
    const resolved = readLinkTarget(linkPath)
    if (!resolved) {
      // 不是符号链接/junction —— pnpm 直接落实体目录的情况
      ok(`插件目录由 pnpm 直接安装（不是链接）：${linkPath}`)
      mark(normalizePathForCompare(linkPath) === normalizePathForCompare(dir),
        '插件目录就是 node_modules 下这一份', `实际解析到 ${dir}`)
    } else {
      ok(`链接指向：${resolved}`)
      if (mode === 'native') {
        // native：pnpm 把它做成指向 .pnpm/ 内部目录的链接，这是正常的
        mark(fs.existsSync(path.join(resolved, 'package.json')),
          '链接目标是有效的插件目录（pnpm 内部目录）', `目标里没有 package.json：${resolved}`)
      } else {
        // 链接必须指向一个**真实存在、且就是本插件**的目录。
        // 不强制等于安装器托管目录 —— 用户可能自己把插件放在别处（开发机常见）。
        const resolvedDir = resolved
        const resolvedOk = fs.existsSync(path.join(resolvedDir, 'package.json'))
          && (readJsonFile(path.join(resolvedDir, 'package.json')) || {}).name === PLUGIN_PKG_NAME
        mark(resolvedOk, '链接指向的是本插件目录',
          `目标不是有效插件目录（缺 package.json 或 name 不对）：${resolvedDir}`)
        if (resolvedOk && normalizePathForCompare(resolvedDir) !== normalizePathForCompare(targetDir)) {
          console.log(`        （该目录不是安装器托管目录（${targetDir}），是自定义位置 —— 同样能用）`)
        }
      }
    }
  }

  // ---- 4. profile package.json ----
  section('4. profile package.json')
  let pkgData = null
  if (fs.existsSync(pkgPath)) {
    pkgData = readJsonFile(pkgPath)
    mark(!!pkgData, 'profile package.json 是合法 JSON')
  } else {
    mark(false, 'profile package.json 存在', pkgPath)
  }
  if (pkgData) {
    const dep = pkgData.dependencies ? pkgData.dependencies[PLUGIN_PKG_NAME] : undefined
    mark(typeof dep === 'string', `dependencies 里登记了 ${PLUGIN_PKG_NAME}`, `当前值：${dep}`)
    if (typeof dep === 'string') {
      if (dep.startsWith('link:')) {
        // 依赖必须指向一个**真实存在、且就是本插件**的目录。
        // 允许指向任意自定义位置（开发机常把插件放在源码目录），不强制安装器托管目录。
        const linked = dep.slice('link:'.length).replace(/^"/, '').replace(/"$/, '')
        const linkedDir = path.isAbsolute(linked) ? linked : path.resolve(profileDir, linked)
        const linkedPkg = fs.existsSync(path.join(linkedDir, 'package.json'))
          ? readJsonFile(path.join(linkedDir, 'package.json')) : null
        const linkedOk = !!linkedPkg && linkedPkg.name === PLUGIN_PKG_NAME
        mark(linkedOk, `依赖指向本插件目录（${linkedDir}）`,
          linkedPkg ? `目标 package.json 的 name 是 ${linkedPkg.name}，不是 ${PLUGIN_PKG_NAME}` : '目标目录里没有 package.json')
      } else if (dep.startsWith('file:')) {
        const tgz = dep.slice('file:'.length).replace(/^"/, '').replace(/"$/, '')
        mark(fs.existsSync(tgz), `依赖指向插件包文件（${tgz}）`, '该文件不存在')
      } else {
        mark(false, '依赖规格是 link: 或 file: 形式', `当前值：${dep}`)
      }
    }
    const bundles = pkgData.dsh && pkgData.dsh.profile && Array.isArray(pkgData.dsh.profile.bundles)
      ? pkgData.dsh.profile.bundles : []
    mark(bundles.includes(PLUGIN_PKG_NAME), `dsh.profile.bundles 里登记了 ${PLUGIN_PKG_NAME}`)
  }

  // ---- 5. profile cordis.patch.yml ----
  section('5. profile cordis.patch.yml')
  let patchConfig = null
  if (fs.existsSync(patchPath)) {
    const patchText = readTextFile(patchPath)
    const lines = patchText.split(/\r?\n/)
    const blocks = findBlocks(lines, PLUGIN_ID)
    mark(blocks.length === 1, `补丁里有且只有一条 - id: ${PLUGIN_ID} 的块`, `实际 ${blocks.length} 条`)
    const config = readBlockConfig(patchText, PLUGIN_ID)
    patchConfig = config
    mark(!!config, `能读出 - id: ${PLUGIN_ID} 的 config`)
    if (config) {
      // 比对口径：
      //   ① 用 --config 指定过的键 → 必须与覆盖值完全一致；
      //   ② 没指定且等于默认值      → 通过；
      //   ③ 没指定但被手工改过      → 值合法就算通过（标「自定义值」），不合法才不通过
      //      （插件运行时会回退默认值，配置等于没生效）
      const compare = (key, actual, def) => {
        if (Object.prototype.hasOwnProperty.call(overrides, key)) {
          const expect = overrides[key]
          // --config 传进来的是字符串，补丁里是 YAML 解析出来的数字/布尔，
          // 所以不能直接用 ===，要走 configValueEquals（数字按数值比）
          mark(configValueEquals(actual, expect),
            `config.${key} = ${JSON.stringify(expect)}（--config 指定的期望值）`,
            `实际 ${JSON.stringify(actual)}`)
          return
        }
        if (configValueEquals(actual, def)) {
          mark(true, `config.${key} = ${JSON.stringify(def)}（默认值）`)
          return
        }
        // 对象型配置（toolPrefixes）：逐个子键比对 --config 的期望值
        if (OBJECT_CONFIG_KEYS.includes(key)) {
          const actualObj = (actual && typeof actual === 'object' && !Array.isArray(actual)) ? actual : {}
          const expectedSub = Object.entries(overrides).filter(([k]) => k.startsWith(`${key}.`))
          const subOk = expectedSub.every(([k, v]) => actualObj[k.slice(key.length + 1)] === v)
          mark(subOk && isValidConfigValue(key, actualObj),
            `config.${key} = ${JSON.stringify(actualObj)}（${expectedSub.length ? '自定义值' : '默认值（未写入补丁 = 用插件默认的空对象）'}）`,
            subOk ? `实际 ${JSON.stringify(actualObj)}：不是合法的前缀写法` : '与 --config 指定的子键不一致')
          return
        }
        const valid = isValidConfigValue(key, actual)
        mark(valid,
          `config.${key} = ${JSON.stringify(actual)}（自定义值，默认 ${JSON.stringify(def)}）`,
          `实际 ${JSON.stringify(actual)}：不是合法值，插件运行时会回退成默认值 ${JSON.stringify(def)}`)
      }
      for (const [key, def] of Object.entries(DEFAULT_CONFIG)) {
        if (key === 'thresholds') continue
        compare(key, config[key], def)
      }
      const th = config.thresholds || {}
      for (const key of THRESHOLD_KEYS) {
        compare(`thresholds.${key}`, th[key], DEFAULT_CONFIG.thresholds[key])
      }
    }
  } else {
    mark(false, 'profile cordis.patch.yml 存在', patchPath)
  }

  // ---- 6. 语法自检 ----
  section('6. 插件源码语法自检')
  for (const rel of ['index.js', 'client.js']) {
    const file = path.join(dir, rel)
    if (!fs.existsSync(file)) {
      fail(`无法检查 ${rel}：文件不存在（${file}）`)
      failed += 1
      continue
    }
    const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
    mark(res.status === 0, `node --check ${rel} 通过`, (res.stderr || '').trim().split('\n')[0])
  }
  const selfcheck = path.join(dir, 'selfcheck.mjs')
  soft(fs.existsSync(selfcheck), '插件自检脚本在位：selfcheck.mjs（可手动跑 node selfcheck.mjs）')

  // ---- 7. 数据层就绪检查（离线读 DSH home 级的 MCP 连接器存储） ----
  section('7. 数据层就绪检查（MCP 连接器）')
  checkDataLayer(dshHome, dir)

  // ---- 8. MCP 工具名前缀自检（换设备能不能取到数） ----
  section('8. MCP 工具名前缀自检（换设备后能不能取到数）')
  await checkToolPrefixes(dshHome, profileName, profileDir, dir, patchConfig)

  // ---- 结论 ----
  console.log('')
  if (failed === 0) {
    ok(`全部检查通过（${warned} 条提示）。`)
    console.log('')
    console.log('装好了。' + '首次安装请重启 DSH（插件在 DSH 启动时扫描 profile 的 bundle 列表才会被注册）；之后若只是改了插件代码，改一下 profile 的 cordis.patch.yml 即可触发热重载（实测 2026-10-26）。')
    console.log('重启后打开左侧「ERP 销售仪表盘」：')
    console.log('  · 第一次取数约 4~5 分钟（80+ 次 MCP 调用，首屏会转圈）；')
    console.log('  · 之后 6 小时内秒开（命中缓存）；')
    console.log('  · 面板里显示「不可得」的板块，多半是连接器名对不上 —— 按第 8 节给的 toolPrefixes 改一下即可。')
    if (warned > 0) {
      console.log('')
      console.log('注意：上面带「!」的提示不影响安装，但请逐条确认（尤其是数据层缺失的项）。')
    }
    console.log('')
    process.exit(0)
  } else {
    fail(`有 ${failed} 项检查未通过。`)
    console.log('')
    console.log('下一步：修好上面的问题后重新运行 node check-install.mjs；必要时用 node install.mjs --force 重装。')
    console.log('')
    process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// 第 7 节：数据层就绪检查
//
// DSH 把 MCP 连接器状态存在 **DSH home 级** 的 storages/mcp_connector.json
// （注意：插件装在 profile 下，但连接器不在 profile 里）。
// tables.tool_catalog[] 每条记录 = 一个连接器实际暴露的工具清单，
// 所以可以**离线**回答「这台机器上有没有数据层」。
//
// 安全红线：这份文件里可能含 x-api-key 等凭据。
// 本函数**只读** serverName / tools / observedAt / 连接器的 key 与显示名，
// 绝不打印、绝不写盘任何 key / token / header 值。
// ---------------------------------------------------------------------------
function checkDataLayer(dshHome, targetDir) {
  const storePath = path.join(dshHome, 'storages', 'mcp_connector.json')

  if (!fs.existsSync(storePath)) {
    soft(false, `未找到连接器存储：${storePath}`)
    warn('    本机可能还没配过 MCP 连接器，仪表盘会没有数据。')
    warn('    配置指引：在 DSH 里连接「ERP业务咨询事业群数据分析」（erp / std / planning 三个服务），再重跑本脚本。')
    return
  }
  mark(true, `连接器存储存在：${storePath}`)

  const store = readJsonFile(storePath)
  if (!store) {
    soft(false, '连接器存储不是合法 JSON，跳过数据层核对')
    return
  }

  const tables = (store && store.tables) || {}
  const catalogRows = toRows(pickTable(tables, ['tool_catalog', 'toolCatalog']))
  const connectionRows = toRows(pickTable(tables, ['connections']))

  if (!catalogRows.length) {
    soft(false, '连接器存储里没有 tool_catalog 记录，无法核对工具清单')
    warn('    可能是 DSH 还没记录过工具目录；在 DSH 里打开一次相关 MCP 工具后再重跑。')
    return
  }

  // 连接器展示信息：serverName → { key, name, enabled }
  const connByServer = new Map()
  for (const c of connectionRows) {
    if (!c || typeof c !== 'object') continue
    const server = c.serverName
    if (!server) continue
    const prev = connByServer.get(server) || {}
    connByServer.set(server, {
      key: prev.key || c.key || '',
      name: prev.name || c.name || '',
      enabled: c.enabled !== false,
    })
  }

  // 工具名 → 该工具所属的目录记录
  // 注意：tools[] 里的元素可能是字符串（'total_performance_analysis'），
  // 也可能是对象（{name, description, inputSchema}）——两种都要认。
  const toolIndex = new Map()
  for (const row of catalogRows) {
    if (!row || typeof row !== 'object') continue
    const server = row.serverName || ''
    const tools = Array.isArray(row.tools) ? row.tools : []
    const count = tools.length
    for (const t of tools) {
      let name = null
      if (typeof t === 'string') name = t
      else if (t && typeof t === 'object' && typeof t.name === 'string') name = t.name
      if (!name) continue
      // 目录里可能存裸名（total_performance_analysis），也可能存全名（mcp__erp__total_performance_analysis）
      const bare = name.replace(/^mcp__[a-z0-9_-]+__/i, '')
      if (!toolIndex.has(bare)) {
        toolIndex.set(bare, {
          server,
          count,
          observedAt: row.observedAt || row.updatedAt || '',
        })
      }
    }
  }

  for (const item of REQUIRED_TOOLS) {
    const hit = toolIndex.get(item.tool)
    if (!hit) {
      const full = fullToolName(item.expectServer || 'erp', item.tool)
      if (item.required) {
        fail(`缺 ${full} —— 需要在 DSH 里配置对应连接器（${item.usedBy}）`)
      } else {
        warn(`缺 ${full}（可选，${item.usedBy}）—— 缺失时对应板块降级，不影响其它页签`)
      }
      continue
    }
    const conn = connByServer.get(hit.server) || { key: '', name: '', enabled: true }
    const connText = conn.key || conn.name
      ? `${conn.key || '?'}${conn.name ? ` / ${conn.name}` : ''}`
      : '（连接器显示名未知）'
    const obsText = hit.observedAt ? `，观测于 ${formatObservedAt(hit.observedAt)}` : ''
    ok(`${item.tool} → server '${hit.server}'（${connText}，${hit.count} 工具${obsText}）`)
    if (conn.enabled === false) {
      soft(false, `连接器 server '${hit.server}' 当前是停用状态，工具虽然登记着但调用会失败`)
    }
  }

  // 漂移检查：bundle 源码里用到、但没列进 REQUIRED_TOOLS 的 MCP 工具
  const bundleIndex = path.join(targetDir, 'index.js')
  if (fs.existsSync(bundleIndex)) {
    try {
      const src = readTextFile(bundleIndex)
      // 只认「键: 'mcp__xxx__yyy'」这种工具常量赋值行，避免把注释里的示例当成真实调用
      const used = new Set()
      const re = /^\s*[\w$]+\s*:\s*['"](mcp__(?:erp|std|planning)__)([a-z0-9_]+)['"]\s*,?\s*$/gim
      let m
      while ((m = re.exec(src)) !== null) used.add(m[2].toLowerCase())
      if (used.size) {
        const known = new Set(REQUIRED_TOOLS.map((t) => t.tool.toLowerCase()))
        const extra = [...used].filter((t) => !known.has(t)).sort()
        const missing = [...known].filter((t) => !used.has(t)).sort()
        if (extra.length) {
          soft(false, `插件源码还用到 ${extra.length} 个未列入必需清单的工具：${extra.join('、')}`)
          warn('    这些工具缺失时只会让对应板块降级，不会让整块面板打不开。')
        }
        if (missing.length) {
          soft(false, `必需清单里有 ${missing.length} 个工具插件源码没调用：${missing.join('、')}`)
        }
      }
    } catch {
      /* 读不到源码就跳过漂移检查，不影响主流程 */
    }
  }
}

/** observedAt 可能是 epoch 毫秒，也可能是 ISO 字符串 */
function formatObservedAt(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const d = new Date(value)
    if (!Number.isNaN(d.getTime())) {
      const p = (n) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    }
  }
  return String(value)
}

// ---------------------------------------------------------------------------
// 第 8 节：MCP 工具名前缀自检
//
// 为什么要有这一节：换一台设备时，DSH 里 MCP 连接器的「服务器名」很可能不是
// erp / std / planning。工具全名 = mcp__<连接器名>__<工具名>，
// 连接器名一改，插件发出去的调用就找不到人 —— 表现是面板整块显示「不可得」。
//
// 这一节做三件事（**全部只读**）：
//   ① 列出插件要调的连接器与完整工具名；
//   ② 能直连 MCP 服务的话，tools/list 核一遍服务侧工具是否齐全；
//   ③ 打印一段可直接粘贴的配置块，告诉用户连接器名不同时怎么改 toolPrefixes。
//
// 安全红线：绝不打印 key / token / header 值（只打印 url）。
// 探测失败一律降级为提示，不让整个安装核对失败 —— 连接器没配好 ≠ 安装失败。
// ---------------------------------------------------------------------------

/**
 * 读取「插件要哪些工具」的清单。
 * 优先读**已安装的 bundle 自带的** lib/required-tools.mjs（Lead 要求以 bundle 为准），
 * 读不到就退回安装器自带的副本。
 */
async function loadRequiredTools(installedDir) {
  const bundleFile = path.join(installedDir, 'lib', 'required-tools.mjs')
  if (fs.existsSync(bundleFile)) {
    try {
      const mod = await import(pathToFileURL(bundleFile).href)
      if (Array.isArray(mod.REQUIRED_TOOLS) && Array.isArray(mod.CONNECTOR_GROUPS)) {
        return {
          required: mod.REQUIRED_TOOLS,
          groups: mod.CONNECTOR_GROUPS,
          prefixes: mod.DEFAULT_TOOL_PREFIXES || DEFAULT_TOOL_PREFIXES,
          full: mod.fullToolName || fullToolName,
          from: bundleFile,
        }
      }
    } catch { /* bundle 副本读不动就用自带副本 */ }
  }
  return {
    required: REQUIRED_TOOLS,
    groups: CONNECTOR_GROUPS,
    prefixes: DEFAULT_TOOL_PREFIXES,
    full: fullToolName,
    from: '安装器自带清单',
  }
}

/** 打印一段可直接粘贴的 profile 补丁配置块 */
function buildConfigSnippet(dshHome, profileName, tools, detected, patchConfig = null) {
  const lines = []
  lines.push(`# ${path.join(dshHome, 'profiles', profileName, 'cordis.patch.yml')}`)
  lines.push(`- id: ${PLUGIN_ID}`)
  lines.push(`  name: "${PLUGIN_PKG_NAME}"`)
  lines.push('  config:')
  for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
    if (key === 'thresholds') continue
    // 对象型配置（toolPrefixes）单独处理：写嵌套映射，不能当标量写
    if (key === 'toolPrefixes') continue
    lines.push(`    ${key}: ${formatYamlScalar(value)}`)
  }
  const th = (patchConfig && patchConfig.thresholds) || DEFAULT_CONFIG.thresholds
  lines.push('    thresholds:')
  for (const [key, value] of Object.entries(th)) {
    lines.push(`      ${key}: ${formatYamlScalar(value)}`)
  }
  const configuredPrefixes = (patchConfig && patchConfig.toolPrefixes && typeof patchConfig.toolPrefixes === 'object')
    ? patchConfig.toolPrefixes
    : {}
  const prefixEntries = Object.entries(configuredPrefixes)
  if (prefixEntries.length) {
    lines.push('    toolPrefixes:')
    for (const [k, v] of prefixEntries) {
      lines.push(`      ${k}: ${formatYamlScalar(v)}`)
    }
  } else {
    lines.push('    # 连接器名不是 erp / std / planning 时，在这里改前缀（完整前缀，含两侧下划线）：')
  }
  const mismatched = []
  for (const group of tools.groups) {
    const actual = detected && detected[group.server]
    const expected = group.server
    if (actual && actual.serverName && actual.serverName !== expected) {
      mismatched.push({ group, actual })
      lines.push(`    #   ${expected}: 'mcp__${actual.serverName}__'   # ← 本机实测：连接器名是 ${actual.serverName}`)
    }
  }
  if (!mismatched.length && !prefixEntries.length) {
    lines.push("    #   erp: 'mcp__erp-cn__'")
    lines.push("    #   std: 'mcp__std__'")
    lines.push("    #   planning: 'mcp__planning__'")
  }
  return lines.join('\n')
}

async function checkToolPrefixes(dshHome, profileName, profileDir, installedDir, patchConfig = null) {
  const tools = await loadRequiredTools(installedDir)

  // ① 列出插件要调的连接器与完整工具名
  console.log('  插件要调的连接器与工具名（前缀 = mcp__<连接器名>__）：')
  for (const group of tools.groups) {
    const prefix = tools.prefixes[group.server] || `mcp__${group.server}__`
    const tag = group.optional ? '可选' : '必须'
    console.log(`    · ${group.server}（${tag}）— ${group.label}`)
    if (!group.tools.length) {
      console.log(`        ${prefix}*    # 插件不依赖它出数，缺了不影响面板`)
      continue
    }
    for (const tool of group.tools) {
      const item = tools.required.find((x) => x.tool === tool)
      console.log(`        ${prefix}${tool}${item ? `    # ${item.usedBy}` : ''}`)
    }
  }
  console.log(`    （工具清单来源：${tools.from}）`)
  console.log('')

  // ② 收集探测目标：端点文件/环境变量 + DSH 连接器存储
  const searchDirs = [
    installedDir,
    path.join(dshHome),
    profileDir,
    process.cwd(),
    path.dirname(fileURLToPath(import.meta.url)),
  ]
  const endpoints = loadEndpoints(searchDirs)
  const store = loadConnectorStore(dshHome)

  console.log('  这台机器上的 MCP 连接器（只显示地址与服务器名，不显示凭据）：')
  if (!store.exists) {
    warn(`没找到连接器存储：${store.source}`)
  } else if (store.error) {
    warn(`连接器存储读取失败（${store.error}）：${store.source}`)
  } else if (!store.connections.length) {
    warn('连接器存储里没有连接器记录')
  } else {
    for (const conn of store.connections) {
      const mark2 = conn.enabled ? '启用' : '停用'
      console.log(`    · ${describeConnection(conn)}（${mark2}）`)
    }
  }
  console.log('')

  // ---- 端口认领结论（与插件运行时同一套规则）----
  const prefixPlan = resolvePrefixPlan(store.exists && !store.error ? store.connections : [], (patchConfig && patchConfig.toolPrefixes) || {})
  console.log('  插件实际会用到的工具名前缀（插件启动时按「补丁配置 → 端口 → 连接器名 → 内置默认名」认领）：')
  for (const [group, plan] of Object.entries(prefixPlan)) {
    const line = `    · ${group.padEnd(8)} → ${plan.prefix.padEnd(22)}（${plan.reason}${plan.serverName ? `，连接器「${plan.serverName}」` : ''}${plan.port ? `，端口 ${plan.port}` : ''}）`
    console.log(line)
    if (group === 'erp' || group === 'std') {
      if (plan.source === 'default') {
        warn(`${group} 没有认领到连接器，将回退默认前缀 ${plan.prefix}；如果本机连接器不叫 ${group}，请在补丁里写 toolPrefixes.${group}=mcp__<连接器名>__`)
      }
    }
  }
  console.log('')

  const targets = []
  for (const server of MCP_SERVERS) {
    const e = endpoints[server]
    if (!e) continue
    targets.push({ server, url: e.url, key: e.key, serverName: server, label: e.label || server, source: e.source })
  }
  for (const conn of store.connections) {
    if (!conn.enabled) continue
    if (targets.some((t) => t.url === conn.url)) continue
    targets.push({
      server: null,
      url: conn.url,
      key: conn.apiKeyValue || '',
      serverName: conn.serverName || '',
      label: conn.name || conn.key || conn.url,
      source: store.source,
    })
  }
  for (const server of MCP_SERVERS) {
    if (!endpoints[server]) {
      warn(`没找到 ${server} 的服务端点（未设置环境变量，也没找到 mcp.endpoints.local.json）`)
    }
  }

  console.log('  直连探测（tools/list，只读，每个服务超时 15 秒）：')
  const probed = new Map()
  await Promise.all(targets.map(async (t) => {
    const r = await probeMcpServer({ url: t.url, key: t.key, timeoutMs: 15000 })
    probed.set(t.url, { target: t, result: r })
  }))

  const detected = {}
  let missingTotal = 0
  for (const group of tools.groups) {
    const need = tools.required.filter((t) => (t.expectServer || 'erp') === group.server)
    if (!need.length) {
      const any = [...probed.values()].find((p) => p.result.ok)
      if (any) {
        console.log(`    · ${group.server}（可选）：插件不依赖它出数（该连接器共 ${any.result.tools.length} 个工具）`)
      }
      continue
    }

    // 找出哪个连接器提供了这组工具
    let best = null
    for (const p of probed.values()) {
      if (!p.result.ok) continue
      const have = new Set(p.result.tools)
      const hit = need.filter((t) => have.has(t.tool))
      if (!hit.length) continue
      if (!best || hit.length > best.hit.length) {
        best = { target: p.target, hit: hit.map((h) => h.tool), tools: p.result.tools }
      }
    }

    if (!best) {
      const tried = [...probed.values()].filter((p) => !p.result.ok).map((p) => `${p.target.label}（${p.result.error}）`)
      if (tried.length) {
        warn(`未能直连 MCP 服务（原因：${tried.join('；')}），跳过 ${group.server} 服务侧核对；这不影响安装，只是无法预检数据源。`)
      } else {
        warn(`没有找到能提供 ${group.server} 侧工具的 MCP 服务；${group.server} 相关板块会显示「不可得」。`)
      }
      for (const t of need) {
        console.error(`        ✘ 缺 ${tools.full(group.server, t.tool)} —— ${t.usedBy}`)
      }
      missingTotal += need.length
      warned += 1
      continue
    }

    const have = new Set(best.tools)
    const missing = need.filter((t) => !have.has(t.tool))
    const actualName = best.target.serverName || ''
    const prefix = actualName ? `mcp__${actualName}__` : (tools.prefixes[group.server] || `mcp__${group.server}__`)

    if (missing.length) {
      missingTotal += missing.length
      console.error(`    ✘ ${group.server} 服务侧缺 ${missing.length} 个工具：`)
      for (const t of missing) {
        console.error(`        ✘ 缺 ${tools.full(group.server, t.tool)} —— ${t.usedBy}`)
      }
      warned += 1
    } else {
      ok(`${group.server} 服务侧工具齐全（${need.length}/${need.length}），连接器「${best.target.label}」`)
    }

    if (actualName && actualName !== group.server) {
      detected[group.server] = { serverName: actualName, label: best.target.label }
      warn(`本机 ${group.server} 侧的连接器实际叫「${actualName}」，插件默认按「${group.server}」找 → 面板会取不到数`)
      console.log(`        → 在 cordis.patch.yml 的 config 里加：toolPrefixes: { ${group.server}: '${prefix}' }`)
    } else {
      detected[group.server] = { serverName: actualName || group.server, label: best.target.label }
    }
  }
  if (missingTotal) {
    console.log('')
    console.log(`    ! 服务侧缺 ${missingTotal} 个工具：插件装好了，但对应板块会取不到数。`)
    console.log('      多半是这台机器的连接器名不叫 erp / std —— 按下面的 toolPrefixes 改一下即可。')
  }
  console.log('')

  // ③ 打印可直接粘贴的配置块
  console.log('  连接器名和默认不一样时（只有这种情况才需要改），把下面这段贴进你的 profile 补丁：')
  console.log('')
  for (const line of buildConfigSnippet(dshHome, profileName, tools, detected, patchConfig).split('\n')) {
    console.log(`    ${line}`)
  }
  console.log('')
}

main().catch((e) => {
  console.error('')
  console.error(`  ✘ check-install 自身出错：${(e && e.stack) ? e.stack : e}`)
  process.exit(2)
})
