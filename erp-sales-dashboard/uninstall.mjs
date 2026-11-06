#!/usr/bin/env node
// ---------------------------------------------------------------------------
// uninstall.mjs —— 卸载 ERP 销售仪表盘插件（@local/erp-sales-dashboard）
// ---------------------------------------------------------------------------
// 用法：
//   node uninstall.mjs                # 撤销安装（保留插件目录）
//   node uninstall.mjs --purge        # 连同插件目录一起删掉
//   node uninstall.mjs --dry-run      # 只看要撤销什么
//
// 卸载会先给 profile 的两个文件做备份（<name>.bak-<时间戳>）。
// 退出码：0 成功 / 1 失败 / 2 参数用错
// ---------------------------------------------------------------------------

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseArgs, say, ok, warn, fail, section } from './lib/cli.mjs'
import { PLUGIN_ID, PLUGIN_PKG_NAME, PLUGIN_VERSION } from './lib/config-defaults.mjs'
import { removeBlock } from './lib/patch-editor.mjs'
import { findDshCli, nativeRemove, describeCandidates } from './lib/native.mjs'
import {
  removeDir, removeLink, backupFile, timestamp, defaultDshHome, toPosixPath,
  readTextFile, writeTextFile, readJsonFile,
} from './lib/fsx.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

const HELP = `
ERP 销售仪表盘插件（${PLUGIN_PKG_NAME}）卸载器
版本 ${PLUGIN_VERSION}

用法：
  node uninstall.mjs [选项]

选项：
  --profile <名称>       DSH profile 名，默认 desktop
  --dsh-home <目录>      DSH home，默认取环境变量 DSH_HOME，否则取用户主目录下的 .dsh
  --target <目录>        插件安装目录，默认 <dsh-home>/plugins/erp-sales-dashboard
  --dsh-cli <路径>       DSH 命令行路径；native 模式下用它调 \`dsh plugin remove\`
  --purge                连同插件目录/插件包文件一起删除（默认保留）
  --dry-run              只打印将要撤销的改动，不动任何文件
  --help                 显示本帮助

注意：卸载后建议重启 DSH，让插件从运行中的进程里彻底退出。
`

function main() {
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
  const purge = args.purge === true || args.purge === 'true'
  const dryRun = args['dry-run'] === true || args['dry-run'] === 'true'

  if (!fs.existsSync(profileDir)) {
    fail(`找不到 profile 目录：${profileDir}`)
    process.exit(1)
  }

  const pkgPath = path.join(profileDir, 'package.json')
  const patchPath = path.join(profileDir, 'cordis.patch.yml')
  const linkPath = path.join(profileDir, 'node_modules', '@local', PLUGIN_PKG_NAME.split('/').pop())

  // ---- 先判断「装没装过」 ----
  const pkgData = fs.existsSync(pkgPath) ? readJsonFile(pkgPath) : null
  const hasDep = !!(pkgData && pkgData.dependencies && pkgData.dependencies[PLUGIN_PKG_NAME])
  const hasBundle = !!(pkgData && pkgData.dsh && pkgData.dsh.profile && Array.isArray(pkgData.dsh.profile.bundles)
    && pkgData.dsh.profile.bundles.includes(PLUGIN_PKG_NAME))
  const patchText = readTextFile(patchPath)
  const hasPatch = patchText.includes(`- id: ${PLUGIN_ID}`)
  const hasLink = fs.existsSync(linkPath)
  const hasTarget = fs.existsSync(targetDir)

  // ---- 判定安装模式 ----
  // native：DSH 原生命令装的（dependencies 写成 "file:<tgz>"，插件由 pnpm 装进 node_modules）
  // manual：手工模式装的（dependencies 写成 "link:<安装目录>"，node_modules 里是我们建的链接）
  const depSpec = pkgData && pkgData.dependencies ? pkgData.dependencies[PLUGIN_PKG_NAME] : undefined
  const isNative = typeof depSpec === 'string' && depSpec.startsWith('file:')
  // native：依赖指向的就是那个 tgz，路径直接从依赖里取；
  // manual：依赖是 link:<目录>，但安装器在试原生安装失败前**已经在 home/plugins 下生成了 tgz**，
  //        那是安装残留，同样要清理 —— 否则 profile 目录被删了还留个孤儿包。
  const tgzPath = isNative
    ? depSpec.slice('file:'.length).replace(/^"/, '').replace(/"$/, '')
    : path.join(dshHome, 'plugins', `erp-sales-dashboard-${PLUGIN_VERSION}.tgz`)
  const hasTgz = fs.existsSync(tgzPath)

  if (!hasDep && !hasBundle && !hasPatch && !hasLink && !hasTarget && !hasTgz) {
    fail(`没有检测到 ${PLUGIN_PKG_NAME} 的安装痕迹（profile：${profileName}），不做任何改动。`)
    process.exit(1)
  }

  section('卸载计划')
  ok(`profile       ：${profileName}（${profileDir}）`)
  ok(`安装模式      ：${isNative ? 'native（DSH 原生命令 / pnpm 安装）' : 'manual（手工安装：复制目录 + 链接）'}`)
  ok(`依赖条目      ：${hasDep ? `存在，将删除（${depSpec}）` : '无'}`)
  ok(`bundles 登记  ：${hasBundle ? '存在，将删除' : '无'}`)
  ok(`补丁配置块    ：${hasPatch ? '存在，将删除' : '无'}`)
  ok(`node_modules  ：${hasLink ? '存在，将删除' : '无'}`)
  ok(`插件目录      ：${hasTarget ? (purge ? '存在，将 --purge 删除' : '存在，默认保留（要删请加 --purge）') : '无'}`)
  ok(`插件包文件    ：${hasTgz ? `存在，将删除（${tgzPath}${isNative ? '' : '，安装残留'}）` : isNative ? '未找到（依赖里指向的路径不存在）' : '无（手工模式不留 tgz）'}`)
  if (dryRun) warn('当前是 --dry-run：不会改动任何文件')

  // ---- 备份 ----
  const stamp = timestamp()
  const backups = []
  if (!dryRun) {
    const b1 = backupFile(pkgPath, stamp)
    const b2 = backupFile(patchPath, stamp)
    if (b1) backups.push(b1)
    if (b2) backups.push(b2)
  }

  // ---- native 模式：让 pnpm 把插件从 profile 里摘掉 ----
  // 原生安装的包在 pnpm 的虚拟仓库里（node_modules/.pnpm/@local+erp-sales-dashboard@…），
  // 只删 node_modules/@local 下的链接会留下残渣，所以优先走 DSH 原生命令
  // （它内部就是 pnpm remove，会把虚拟仓库里的那份一起清掉）。
  if (isNative && hasLink && !dryRun) {
    section('调用 DSH 原生命令卸载（pnpm remove）')
    const cli = findDshCli(typeof args['dsh-cli'] === 'string' ? args['dsh-cli'] : undefined)
    if (!cli) {
      warn('没找到 DSH 命令行（dsh），改为手工清理：')
      for (const c of describeCandidates(typeof args['dsh-cli'] === 'string' ? args['dsh-cli'] : undefined)) {
        warn(`    ${c.p}    ← ${c.why}`)
      }
    } else {
      ok(`DSH 命令行：${cli.path}（来源：${cli.source}）`)
      const rm = nativeRemove({ cli, profile: profileName, pkgName: PLUGIN_PKG_NAME, home: dshHome, profileDir })
      if (rm.ok) {
        ok('DSH 原生命令卸载成功（pnpm 已把插件及其虚拟仓库目录一并清掉）')
      } else {
        warn(`DSH 原生命令卸载失败：${rm.message}`)
        warn('改为手工清理 node_modules 里的插件目录')
      }
    }
  }

  // ---- 改 package.json ----
  section('撤销 profile 配置')
  if (pkgData) {
    let changed = false
    if (pkgData.dependencies && PLUGIN_PKG_NAME in pkgData.dependencies) {
      delete pkgData.dependencies[PLUGIN_PKG_NAME]
      changed = true
    }
    if (pkgData.dsh && pkgData.dsh.profile && Array.isArray(pkgData.dsh.profile.bundles)) {
      const bundles = pkgData.dsh.profile.bundles
      const idx = bundles.indexOf(PLUGIN_PKG_NAME)
      if (idx >= 0) { bundles.splice(idx, 1); changed = true }
    }
    if (changed) {
      if (!dryRun) writeTextFile(pkgPath, JSON.stringify(pkgData, null, 2) + '\n', true)
      ok(`profile package.json 已撤销：删除 dependencies["${PLUGIN_PKG_NAME}"] 与 bundles 里的同名登记`)
    } else {
      ok('profile package.json 里没有本插件的条目，无需改动')
    }
  } else {
    warn('profile package.json 不存在，跳过')
  }

  // ---- 改 cordis.patch.yml ----
  if (fs.existsSync(patchPath)) {
    const res = removeBlock(patchText, PLUGIN_ID)
    if (res.removed > 0) {
      if (!dryRun) fs.writeFileSync(patchPath, res.text, 'utf8')
      ok(`profile cordis.patch.yml 已撤销：删除 ${res.removed} 条 - id: ${PLUGIN_ID} 的块`)
    } else {
      ok('profile cordis.patch.yml 里没有本插件的块，无需改动')
    }
  } else {
    warn('profile cordis.patch.yml 不存在，跳过')
  }

  // ---- 删链接 ----
  if (fs.existsSync(linkPath)) {
    if (!dryRun) removeLink(linkPath)
    ok(`node_modules 里的插件目录已清理：${linkPath}`)
  }

  // ---- 删插件目录 ----
  if (hasTarget) {
    if (purge) {
      if (!dryRun) removeDir(targetDir)
      ok(`插件目录已删除：${targetDir}`)
    } else {
      warn(`插件目录保留未删：${targetDir}（要删请加 --purge）`)
    }
  }

  // ---- 删插件包文件（native 模式装的时候留下的 tgz） ----
  if (hasTgz) {
    if (purge || isNative) {
      if (!dryRun) {
        try { fs.unlinkSync(tgzPath); ok(`插件包文件已删除：${tgzPath}`) }
        catch (e) { warn(`删除插件包文件失败：${e.message}`) }
      } else {
        warn(`（--dry-run）将删除插件包文件：${tgzPath}`)
      }
    } else {
      warn(`插件包文件保留未删：${tgzPath}（要删请加 --purge）`)
    }
  }

  section('卸载完成')
  if (backups.length) for (const b of backups) ok(`备份文件：${b}`)
  console.log('')
  warn('⚠ 请重启 DSH，让插件从运行中的进程里彻底退出。')
  console.log('')
  process.exit(0)
}

main()
