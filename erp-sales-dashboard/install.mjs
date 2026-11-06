#!/usr/bin/env node
// ---------------------------------------------------------------------------
// install.mjs —— ERP 销售仪表盘插件（@local/erp-sales-dashboard）离线安装器
// ---------------------------------------------------------------------------
// 用法：
//   node install.mjs                                  # 用脚本同级的 bundle/ 目录安装
//   node install.mjs --profile desktop --force        # 覆盖重装
//   node install.mjs --config stdShare=0.65,cShare=0.1
//   node install.mjs --dry-run                        # 只看要做什么，不落盘
//
// 首次装完请**重启 DSH**（插件在 DSH 启动时扫描 profile 的 bundle 列表才会被注册）。
// 已装过之后若只改插件代码：改一下 profile 的 cordis.patch.yml 即可触发热重载（实测 2026-10-26）。
//
// 退出码：0 成功 / 1 失败 / 2 参数用错
// ---------------------------------------------------------------------------

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseArgs, parseConfigOverrides, say, ok, warn, fail, section, die } from './lib/cli.mjs'
import {
  PLUGIN_ID, PLUGIN_PKG_NAME, PLUGIN_VERSION, PLUGIN_DISPLAY_NAME,
  DEFAULT_CONFIG, CONFIG_COMMENTS, ALL_CONFIG_KEYS, THRESHOLD_KEYS,
  applyConfigOverrides,
} from './lib/config-defaults.mjs'
import { upsertBlock, renderBlock } from './lib/patch-editor.mjs'
import {
  copyDir, removeDir, backupFile, ensureLink, removeLink, timestamp,
  defaultDshHome, toPosixPath, readTextFile, writeTextFile,
} from './lib/fsx.mjs'
import { extractTarGz, createTarGz } from './lib/tar.mjs'
import { collectBundleFiles, EXCLUDE_DESC, isExcludedRel } from './lib/bundle-files.mjs'
import { findDshCli, nativeInstall, nativeRemove, describeCandidates, stripProfileBom } from './lib/native.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = path.join(HERE, 'bundle')

const HELP = `
ERP 销售仪表盘插件（${PLUGIN_PKG_NAME}）安装器
版本 ${PLUGIN_VERSION}

用法：
  node install.mjs [选项]

选项：
  --profile <名称>       DSH profile 名，默认 desktop
  --dsh-home <目录>      DSH home，默认取环境变量 DSH_HOME，否则取用户主目录下的 .dsh
  --bundle-dir <目录>    插件包目录；默认取脚本同级的 bundle/，再退到同级的 .tgz
  --tgz <文件>           直接用现成的插件包文件（.tgz）安装；优先于 --bundle-dir
  --target <目录>        插件安装目标目录（仅手工模式），默认 <dsh-home>/plugins/erp-sales-dashboard
  --dsh-cli <路径>       DSH 命令行（dsh.cmd / dsh）的路径；找不到时可显式指定
                         也可用环境变量 DSH_CLI
  --config k=v,k=v       覆盖配置；阈值键：${THRESHOLD_KEYS.join(' / ')}
                         其它可覆盖键：${ALL_CONFIG_KEYS.filter((k) => !THRESHOLD_KEYS.includes(k)).join(' / ')}
  --no-native            不走 DSH 原生插件命令，直接用手工安装模式
  --dry-run              只打印将要做的改动，不写任何文件
  --force                目标目录已存在时覆盖重装
  --help                 显示本帮助

示例：
  node install.mjs --profile desktop
  node install.mjs --config stdShare=0.65,collectionRate=0.95
  node install.mjs --dsh-home "D:\\临时\\dsh-home" --dry-run
  node install.mjs --no-native            # 跳过 DSH 原生命令，手工装
  node install.mjs --dsh-cli "D:\\DSH\\resources\\runtime\\cli\\bin\\dsh.cmd"

安装方式：
  默认先试 **DSH 原生命令**（dsh plugin --profile <profile> add file:<包>.tgz），
  找不到 DSH 命令或命令失败时自动回落到手工安装模式（复制目录 + 改 profile 配置 + 建链接）。
  无论走哪条路，最后都会往 profile 的 cordis.patch.yml 写插件配置块 —— 原生命令不写这块。

注意：首次安装完请重启 DSH，插件才会被注册到运行中的进程里。
`

/** 打包/复制时要排除的东西（规则见 lib/bundle-files.mjs，pack.mjs 与本脚本共用同一份） */
const EXCLUDE_DESC_TEXT = EXCLUDE_DESC

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(HELP)
    process.exit(0)
  }

  // ---- 1. 解析参数 ----
  const profileName = typeof args.profile === 'string' && args.profile ? args.profile : 'desktop'
  const dshHome = typeof args['dsh-home'] === 'string' && args['dsh-home']
    ? path.resolve(args['dsh-home'])
    : defaultDshHome()
  const profileDir = path.join(dshHome, 'profiles', profileName)
  const targetDir = typeof args.target === 'string' && args.target
    ? path.resolve(args.target)
    : path.join(dshHome, 'plugins', PLUGIN_ID)
  const dryRun = args['dry-run'] === true || args['dry-run'] === 'true'
  const force = args.force === true || args.force === 'true'
  const useNative = !(args['no-native'] === true || args['no-native'] === 'true'
    || args.manual === true || args.manual === 'true')
  const dshCliExplicit = typeof args['dsh-cli'] === 'string' && args['dsh-cli'] ? args['dsh-cli'] : null

  let overrides
  try {
    overrides = parseConfigOverrides(args.config)
  } catch (e) {
    fail(e.message)
    process.exit(e.exitCode || 2)
  }
  let config
  try {
    config = applyConfigOverrides(overrides)
  } catch (e) {
    fail(e.message)
    process.exit(e.exitCode || 2)
  }

  // ---- 2. 校验 profile 目录 ----
  if (!fs.existsSync(profileDir) || !fs.statSync(profileDir).isDirectory()) {
    const profilesRoot = path.join(dshHome, 'profiles')
    const found = fs.existsSync(profilesRoot)
      ? fs.readdirSync(profilesRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
      : []
    fail(`找不到 profile 目录：${profileDir}`)
    if (found.length) {
      console.error(`    当前 DSH home 下已有的 profile：${found.join('、')}`)
      console.error(`    可以用 --profile <名称> 指定其中之一。`)
    } else {
      console.error(`    ${profilesRoot} 下没有任何 profile 目录，请先在 DSH 里创建/使用一个 profile。`)
    }
    process.exit(1)
  }

  // ---- 3. 解析插件包来源 ----
  const source = resolveBundleSource(args['bundle-dir'], args.tgz)
  if (source.error) {
    fail(source.error)
    process.exit(1)
  }

  section('安装计划')
  ok(`DSH home      ：${dshHome}`)
  ok(`profile       ：${profileName}（${profileDir}）`)
  ok(`插件包来源    ：${source.dir}`)
  ok(`安装方式      ：${useNative ? 'DSH 原生命令优先，失败自动回落到手工模式' : '手工模式（--no-native）'}`)
  ok(`安装目标目录  ：${targetDir}${useNative ? '（手工模式回退时才用）' : ''}`)
  ok(`依赖规格      ：${useNative ? 'file:<DSH home>/plugins/...tgz（由 DSH 原生命令写入）' : `link:${toPosixPath(targetDir)}`}`)
  ok(`配置覆盖      ：${Object.keys(overrides).length ? Object.entries(overrides).map(([k, v]) => `${k}=${v}`).join('，') : '无（全部用默认值）'}`)
  if (dryRun) warn('当前是 --dry-run：不会写任何文件')

  // ---- 4. 原生安装（DSH 官方插件命令）----
  if (useNative) {
    const native = tryNativeInstall({
      dshHome, profileName, profileDir, source, config, dshCliExplicit, dryRun,
    })
    if (native.done) {
      if (source.temp) removeDir(source.temp)
      process.exit(0)
    }
    warn(`原生安装未成功，已回落到手工安装模式，原因：${native.reason}`)
    // 原生尝试会在 <home>/plugins 下生成一个 tgz；手工模式用不到它，
    // 但不能贸然删（用户可能正是用 --tgz 指的这个文件），留着，卸载时会一起清掉。
    const leftover = path.join(dshHome, 'plugins', `erp-sales-dashboard-${PLUGIN_VERSION}.tgz`)
    if (fs.existsSync(leftover)) {
      warn(`（原生安装尝试生成的插件包文件保留在 ${leftover}，卸载时会被清理）`)
    }
    console.log('')
  }

  // ---- 5. 复制插件包 ----
  section('复制插件包')
  if (fs.existsSync(targetDir)) {
    if (!force) {
      fail(`目标目录已存在：${targetDir}`)
      console.error('    已安装过。要覆盖重装请加 --force。')
      process.exit(1)
    }
    if (!dryRun) {
      removeDir(targetDir)
      ok(`已删除旧目录（--force）：${targetDir}`)
    } else {
      warn(`（--dry-run）将删除旧目录：${targetDir}`)
    }
  }
  if (!dryRun) {
    const copied = copyDir(source.dir, targetDir, {
      skipNames: new Set(['node_modules', 'cache', 'screenshots']),
      skipFileRe: isExcludedRel,
      skipPathRe: /^docs\/screenshots(\/|$)/i,
    })
    ok(`已复制 ${copied.files} 个文件（${(copied.bytes / 1024).toFixed(0)} KB）到 ${targetDir}`)
    ok(`已排除：${EXCLUDE_DESC_TEXT}`)
    if (copied.skipped && copied.skipped.length) {
      ok(`实际排除 ${copied.skipped.length} 项${copied.skipped.length <= 6 ? `：${copied.skipped.join('、')}` : '（明细略）'}`)
    }
  } else {
    warn('（--dry-run）跳过复制')
  }

  // ---- 6. 备份并改写 profile 的两个文件 ----
  const pkgPath = path.join(profileDir, 'package.json')
  const patchPath = path.join(profileDir, 'cordis.patch.yml')
  const stamp = timestamp()
  const backups = []

  if (!dryRun) {
    const b1 = backupFile(pkgPath, stamp)
    const b2 = backupFile(patchPath, stamp)
    if (b1) backups.push(b1)
    if (b2) backups.push(b2)
  } else {
    const b1 = fs.existsSync(pkgPath) ? `${pkgPath}.bak-<时间戳>` : null
    const b2 = fs.existsSync(patchPath) ? `${patchPath}.bak-<时间戳>` : null
    if (b1) backups.push(b1)
    if (b2) backups.push(b2)
  }

  section('改写 profile 配置')
  const pkgResult = patchProfilePackageJson(pkgPath, targetDir, dryRun)
  if (pkgResult.error) { fail(pkgResult.error); process.exit(1) }
  ok(pkgResult.message)
  const patchResult = patchProfileCordis(patchPath, config, dryRun)
  if (patchResult.error) { fail(patchResult.error); process.exit(1) }
  ok(patchResult.message)

  // ---- 7. 建 node_modules 链接 ----
  section('建立 node_modules 链接')
  const linkPath = path.join(profileDir, 'node_modules', '@local', PLUGIN_PKG_NAME.split('/').pop())
  if (dryRun) {
    warn(`（--dry-run）将建立链接：${linkPath} → ${targetDir}`)
  } else {
    const link = ensureLink(linkPath, targetDir)
    if (link.action === 'created') ok(`已创建链接：${linkPath} → ${targetDir}`)
    else if (link.action === 'exists-ok') ok(`链接已存在且指向正确：${linkPath} → ${targetDir}`)
    else {
      ok(`链接原本指向别处（${link.previous || '未知'}），已替换为：${linkPath} → ${targetDir}`)
    }
  }

  // ---- 7. 汇总 ----
  section('安装完成')
  ok(`插件目录    ：${targetDir}`)
  ok(`profile 依赖：${pkgPath} → dependencies["${PLUGIN_PKG_NAME}"] = "link:${toPosixPath(targetDir)}"`)
  ok(`profile 登记：${pkgPath} → dsh.profile.bundles += "${PLUGIN_PKG_NAME}"`)
  ok(`补丁配置    ：${patchPath} → 唯一一条 - id: ${PLUGIN_ID}`)
  if (backups.length) for (const b of backups) ok(`备份文件    ：${b}`)
  else warn('没有可备份的旧文件（首次安装）')

  console.log('')
  warn('⚠ 首次安装请重启 DSH 才能生效（插件在启动时扫描 bundle 列表才会被注册）。之后若只改插件代码，改一下 profile 的 cordis.patch.yml 即可热重载。')
  ok(`下一步：node check-install.mjs${args.profile && args.profile !== 'desktop' ? ` --profile ${profileName}` : ''} 做安装后核对`)
  console.log('')
  if (source.temp) removeDir(source.temp)
  process.exit(0)
}

/**
 * 走 DSH 原生插件命令安装。
 *   dsh plugin --profile <profile> add file:<tgz 绝对路径>
 * 它会自动：① 把 tgz 装进 profile 的 node_modules/@local/<name>
 *          ② 把插件 id 追加进 profile package.json 的 dsh.profile.bundles
 *          ③ 把 dependencies 写成 "file:<tgz 绝对路径>"
 * **但它不写 profile 的 cordis.patch.yml 配置块** —— 那一步必须由本安装器补上。
 *
 * @returns {{done:boolean, reason?:string}}
 */
function tryNativeInstall({ dshHome, profileName, profileDir, source, config, dshCliExplicit, dryRun }) {
  section('原生安装（DSH 官方插件命令）')

  const cli = findDshCli(dshCliExplicit)
  if (!cli) {
    warn('没找到 DSH 命令行（dsh）。已逐个试过这些位置：')
    for (const c of describeCandidates(dshCliExplicit)) {
      warn(`    ${c.p}    ← ${c.why}`)
    }
    warn('找不到时可以显式指定：--dsh-cli <dsh.cmd 的完整路径>，或设环境变量 DSH_CLI。')
    return { done: false, reason: '找不到 DSH 命令行' }
  }
  ok(`DSH 命令行  ：${cli.path}（来源：${cli.source}）`)

  // 现场打一个 tgz（规则与 pack.mjs 同一份：排除截图/凭据/备份/缓存）
  // 如果用户已经给了现成的 tgz（--tgz），就把它复制到 DSH home 下的固定位置，
  // 这样依赖项指向的路径是稳定的（不会指向临时目录或用户随手放的桌面）。
  const tgzPath = path.join(dshHome, 'plugins', `erp-sales-dashboard-${PLUGIN_VERSION}.tgz`)
  let files = []
  let tgzBuf = null
  if (source.tgz) {
    tgzBuf = fs.readFileSync(source.tgz)
    files = collectBundleFiles(source.dir)
  } else {
    files = collectBundleFiles(source.dir)
    if (!files.length) {
      return { done: false, reason: `插件包目录是空的：${source.dir}` }
    }
    const entries = files.map((f) => ({
      name: `package/${f.rel}`,
      data: fs.readFileSync(f.full),
      date: f.mtime,
    }))
    tgzBuf = createTarGz(entries)
  }

  if (dryRun) {
    warn(`（--dry-run）将生成 ${tgzPath}（${files.length} 个文件，${(tgzBuf.length / 1024).toFixed(0)} KB）`)
    warn(`（--dry-run）将执行：${cli.path} plugin --profile ${profileName} add file:${tgzPath}`)
    return { done: false, reason: '--dry-run 不落盘' }
  }

  fs.mkdirSync(path.dirname(tgzPath), { recursive: true })
  fs.writeFileSync(tgzPath, tgzBuf)
  ok(`已生成插件包：${tgzPath}（${files.length} 个文件，${(tgzBuf.length / 1024).toFixed(0)} KB）`)
  ok(`已排除      ：${EXCLUDE_DESC_TEXT}`)

  // DSH 的插件管理器读 profile package.json 用裸 JSON.parse，不剥 BOM —— 先把这个坑堵上
  const bom = stripProfileBom(profileDir)
  if (bom.fixed) ok(bom.message)
  else ok(`BOM 检查    ：${bom.message}`)

  // 交给 DSH 官方命令去装；子进程输出原样透传（pnpm 进度条、DSH 告警都要看到）
  // 先记住 profile 里原有的 bundles 登记：
  // DSH 的插件管理器是**按 node_modules 里实际存在的插件重建** bundles 列表的，
  // 如果某个插件只登记在 package.json 里（没进 node_modules），会被顺带清掉。
  // 装完再把这些登记补回去，避免动到用户已有的插件。
  const pkgPath = path.join(profileDir, 'package.json')
  const bundlesBefore = readBundles(pkgPath)
  const res = nativeInstall({ cli, profile: profileName, tgzPath, home: dshHome, profileDir })
  if (!res.ok) {
    fail(`原生安装失败：${res.message}`)
    return { done: false, reason: res.message }
  }
  ok('DSH 原生命令执行成功：插件已装进 profile 的 node_modules，bundles 登记由 DSH 自动完成')

  // ---- 原生命令不写配置块，这里补上 ----
  const patchPath = path.join(profileDir, 'cordis.patch.yml')
  const stamp = timestamp()
  const backups = []
  const b1 = backupFile(pkgPath, stamp)
  const b2 = backupFile(patchPath, stamp)
  if (b1) backups.push(b1)
  if (b2) backups.push(b2)

  section('补写 profile 配置块（DSH 原生命令不写这块）')
  const pkgResult = ensureBundlesRegistered(pkgPath, bundlesBefore)
  if (pkgResult.error) {
    fail(pkgResult.error)
    reportHalfInstalledState({ dshHome, profileName, profileDir, tgzPath, reason: pkgResult.error })
    process.exit(1)
  }
  ok(pkgResult.message)
  if (pkgResult.restored && pkgResult.restored.length) {
    ok(`已把被 DSH 重建掉的原有 bundles 登记补回：${pkgResult.restored.join('、')}`)
  }
  const patchResult = patchProfileCordis(patchPath, config, false)
  if (patchResult.error) {
    fail(patchResult.error)
    reportHalfInstalledState({ dshHome, profileName, profileDir, tgzPath, reason: patchResult.error, cli, home: dshHome })
    process.exit(1)
  }
  ok(patchResult.message)

  section('安装完成（原生模式）')
  ok(`插件包      ：${tgzPath}`)
  ok(`安装位置    ：${path.join(profileDir, 'node_modules', '@local', PLUGIN_PKG_NAME.split('/').pop())}（由 pnpm 写入）`)
  ok(`profile 依赖：${pkgPath} → dependencies["${PLUGIN_PKG_NAME}"] = "file:…tgz"`)
  ok(`profile 登记：${pkgPath} → dsh.profile.bundles 含 "${PLUGIN_PKG_NAME}"`)
  ok(`补丁配置    ：${patchPath} → 唯一一条 - id: ${PLUGIN_ID}`)
  if (backups.length) for (const b of backups) ok(`备份文件    ：${b}`)

  console.log('')
  warn('⚠ 首次安装请重启 DSH 才能生效（插件在启动时扫描 bundle 列表才会被注册）。之后若只改插件代码，改一下 profile 的 cordis.patch.yml 即可热重载。')
  ok(`下一步：node check-install.mjs${profileName !== 'desktop' ? ` --profile ${profileName}` : ''} 做安装后核对`)
  console.log('')
  return { done: true }
}

/**
 * 「半装」状态处理。
 *
 * 原生安装是两步：① `dsh plugin add`（装包 + 写依赖 + 登记 bundles）
 *                ② 本安装器补写 cordis.patch.yml 的配置块
 * 如果 ① 成功、② 失败，就会留下「插件装上了但配置没写进去」的半装状态：
 * 插件能加载，但所有配置项走默认值（比如阈值、新兵门槛、AI 模型）。
 *
 * 这里把当前状态讲清楚，并**尽力自动回滚**（用 DSH 原生命令把插件摘掉）；
 * 回滚不了就明确告诉用户下一步该做什么。
 */
function reportHalfInstalledState({ dshHome, profileName, profileDir, tgzPath, reason, cli, home }) {
  console.log('')
  section('当前处于「半装」状态')
  fail(`失败原因：${reason}`)
  console.log('')
  console.log('已经做完的（不回滚就会保留）：')
  console.log(`  • 插件包已装进 profile 的 node_modules：${path.join(profileDir, 'node_modules', '@local', PLUGIN_PKG_NAME.split('/').pop())}`)
  console.log(`  • profile 依赖已登记：dependencies["${PLUGIN_PKG_NAME}"] = "file:…tgz"`)
  console.log(`  • profile bundles 已登记：dsh.profile.bundles 含 "${PLUGIN_PKG_NAME}"`)
  console.log(`  • 插件包文件：${tgzPath}`)
  console.log('')
  console.log('还没做完的：')
  console.log(`  • profile 的 cordis.patch.yml 里缺 - id: ${PLUGIN_ID} 的配置块`)
  console.log('    → 插件会加载，但所有配置项走默认值（阈值 / 新兵门槛 / AI 模型等都不是你设的值）。')
  console.log('')

  // 尽力自动回滚
  let rolledBack = false
  if (cli) {
    try {
      const rm = nativeRemove({ cli, profile: profileName, pkgName: PLUGIN_PKG_NAME, home: home || dshHome, profileDir })
      rolledBack = rm.ok
      if (rm.ok) {
        ok('已自动回滚：DSH 原生命令已把插件从 profile 里摘掉。')
      } else {
        warn(`自动回滚未成功：${rm.message}`)
      }
    } catch (e) {
      warn(`自动回滚时出错：${e.message}`)
    }
  } else {
    warn('没找到 DSH 命令行，无法自动回滚。')
  }

  console.log('')
  if (rolledBack) {
    console.log('下一步：')
    console.log(`  1) 修好上面的失败原因（多半是 cordis.patch.yml 的权限或格式问题）`)
    console.log(`  2) 重新执行：node install.mjs --profile ${profileName}`)
    console.log(`     装好后顺手清理残留的插件包：删除 ${tgzPath}`)
  } else {
    console.log('下一步（手动收尾，二选一）：')
    console.log(`  A. 卸载重来：node uninstall.mjs --profile ${profileName} --purge`)
    console.log(`  B. 保留现状并手工补配置块：在 ${path.join(profileDir, 'cordis.patch.yml')} 里`)
    console.log(`     加一段「- id: ${PLUGIN_ID}」的配置块；首次安装请重启 DSH（插件会以默认配置运行）`)
  }
  console.log('')
}

/**
 * 读 profile package.json 里现有的 dsh.profile.bundles 登记（读不到就当空数组）。
 */
function readBundles(pkgPath) {
  try {
    if (!fs.existsSync(pkgPath)) return []
    const data = JSON.parse(readTextFile(pkgPath))
    const list = data && data.dsh && data.dsh.profile && data.dsh.profile.bundles
    return Array.isArray(list) ? list.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

/**
 * 原生模式下 DSH 已经把插件 id 追加进 dsh.profile.bundles；
 * 万一没追加（例如旧版本 DSH），这里补上，但**不碰 dependencies**（那是 pnpm 管的）。
 *
 * 另外：DSH 的插件管理器会按 node_modules 里实际存在的插件**重建** bundles 列表，
 * 所以装之前就存在的其它插件登记可能被顺带清掉 —— 这里按装之前的快照补回去。
 */
function ensureBundlesRegistered(pkgPath, bundlesBefore = []) {
  let data = { name: `dsh-profile-${path.basename(path.dirname(pkgPath))}`, private: true }
  if (fs.existsSync(pkgPath)) {
    try {
      data = JSON.parse(readTextFile(pkgPath))
    } catch (e) {
      return { error: `profile 的 package.json 不是合法 JSON：${e.message}` }
    }
  }
  if (!data.dsh || typeof data.dsh !== 'object') data.dsh = {}
  if (!data.dsh.profile || typeof data.dsh.profile !== 'object') data.dsh.profile = {}
  if (!Array.isArray(data.dsh.profile.bundles)) data.dsh.profile.bundles = []
  const bundles = data.dsh.profile.bundles
  const restored = []
  for (const name of bundlesBefore) {
    if (name === PLUGIN_PKG_NAME) continue
    if (!bundles.includes(name)) { bundles.push(name); restored.push(name) }
  }
  if (bundles.includes(PLUGIN_PKG_NAME)) {
    const message = `profile package.json 的 bundles 已含 "${PLUGIN_PKG_NAME}"（DSH 原生命令已登记，无需改动）`
    if (!restored.length) return { message }
    writeTextFile(pkgPath, JSON.stringify(data, null, 2) + '\n', true)
    return { message, restored }
  }
  bundles.push(PLUGIN_PKG_NAME)
  writeTextFile(pkgPath, JSON.stringify(data, null, 2) + '\n', true)
  return {
    message: `profile package.json 已补登 bundles："${PLUGIN_PKG_NAME}"`,
    restored: restored.length ? restored : undefined,
  }
}

/** 解析插件包来源：--tgz > --bundle-dir > 同级 bundle/ > 同级 .tgz */
function resolveBundleSource(explicit, tgzExplicit) {
  // 显式指定一个 tgz 文件（用户已经拿到插件包时的常见场景）
  if (typeof tgzExplicit === 'string' && tgzExplicit) {
    const file = path.resolve(tgzExplicit)
    if (!fs.existsSync(file)) return { error: `指定的 --tgz 不存在：${file}` }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-sales-dashboard-'))
    try {
      const res = extractTarGz(fs.readFileSync(file), tmp)
      const root = path.join(tmp, 'package')
      const dir = fs.existsSync(root) ? root : tmp
      ok(`已从 ${path.basename(file)} 解出插件包（${res.files} 个文件）`)
      return { dir, temp: tmp, tgz: file }
    } catch (e) {
      try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
      return { error: `解开 ${path.basename(file)} 失败：${e.message}` }
    }
  }
  if (typeof explicit === 'string' && explicit) {
    const dir = path.resolve(explicit)
    if (!fs.existsSync(dir)) return { error: `指定的 --bundle-dir 不存在：${dir}` }
    return { dir }
  }
  if (fs.existsSync(PLUGIN_DIR) && fs.statSync(PLUGIN_DIR).isDirectory()) {
    return { dir: PLUGIN_DIR }
  }
  const tgz = path.join(HERE, `erp-sales-dashboard-${PLUGIN_VERSION}.tgz`)
  if (fs.existsSync(tgz)) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-sales-dashboard-'))
    try {
      const res = extractTarGz(fs.readFileSync(tgz), tmp)
      const root = path.join(tmp, 'package')
      const dir = fs.existsSync(root) ? root : tmp
      ok(`已从 ${path.basename(tgz)} 解出插件包（${res.files} 个文件）`)
      return { dir, temp: tmp }
    } catch (e) {
      return { error: `解开 ${path.basename(tgz)} 失败：${e.message}` }
    }
  }
  return {
    error: `找不到插件包。请用 --bundle-dir <目录> 指定，或把 bundle/ 目录（或 erp-sales-dashboard-${PLUGIN_VERSION}.tgz）放到脚本同级目录下。`,
  }
}

/** 改 profile 的 package.json：加依赖 + 加 bundles 登记 */
function patchProfilePackageJson(pkgPath, targetDir, dryRun) {
  let data = { name: `dsh-profile-${path.basename(path.dirname(pkgPath))}`, private: true }
  if (fs.existsSync(pkgPath)) {
    // readTextFile 会剥掉 UTF-8 BOM：Windows PowerShell 写的 BOM 会让 JSON.parse 直接抛错
    const text = readTextFile(pkgPath)
    try {
      data = JSON.parse(text)
    } catch (e) {
      return { error: `profile 的 package.json 不是合法 JSON：${e.message}` }
    }
  }
  const before = JSON.stringify(data)
  if (!data.dependencies || typeof data.dependencies !== 'object') data.dependencies = {}
  data.dependencies[PLUGIN_PKG_NAME] = `link:${toPosixPath(targetDir)}`
  if (!data.dsh || typeof data.dsh !== 'object') data.dsh = {}
  if (!data.dsh.profile || typeof data.dsh.profile !== 'object') data.dsh.profile = {}
  if (!Array.isArray(data.dsh.profile.bundles)) data.dsh.profile.bundles = []
  const bundles = data.dsh.profile.bundles
  if (!bundles.includes(PLUGIN_PKG_NAME)) bundles.push(PLUGIN_PKG_NAME)

  const after = JSON.stringify(data, null, 2) + '\n'
  if (before === JSON.stringify(data)) return { message: 'profile package.json 已经是目标状态（幂等）' }
  if (!dryRun) writeTextFile(pkgPath, after, true)
  return {
    message: `profile package.json 已更新：dependencies["${PLUGIN_PKG_NAME}"] + dsh.profile.bundles 追加 "${PLUGIN_PKG_NAME}"`,
  }
}

/** 改 profile 的 cordis.patch.yml：upsert 唯一一条插件块 */
function patchProfileCordis(patchPath, config, dryRun) {
  const text = readTextFile(patchPath)
  const blockText = renderBlock(PLUGIN_ID, PLUGIN_PKG_NAME, config, CONFIG_COMMENTS)
  const result = upsertBlock(text, PLUGIN_ID, blockText)
  if (dryRun) {
    return { message: `（--dry-run）将${result.action === 'replaced' ? '替换' : '追加'} profile cordis.patch.yml 里 - id: ${PLUGIN_ID} 的块` }
  }
  writeTextFile(patchPath, result.text, true)
  const dup = result.count > 1 ? `（清理了 ${result.count - 1} 条重复块）` : ''
  return {
    message: `profile cordis.patch.yml 已${result.action === 'replaced' ? '替换' : '追加'} - id: ${PLUGIN_ID} 的配置块${dup}`,
  }
}

main()
