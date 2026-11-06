#!/usr/bin/env node
// ---------------------------------------------------------------------------
// pack.mjs —— 打出可分发的安装包
// ---------------------------------------------------------------------------
// 产出两个文件（都在本目录下）：
//   ① erp-sales-dashboard-plugin-<version>.zip   —— 完整分发包（安装器 + bundle/ + 文档）
//   ② erp-sales-dashboard-<version>.tgz          —— 只含 bundle/，供 DSH「添加插件」GUI 用
//
// zip 用纯 Node 手写（lib/zip.mjs，zlib.deflateRawSync + 中央目录），
// 不依赖 PowerShell 的 Compress-Archive，Windows / macOS / Linux 结果一致。
//
// 用法：
//   node pack.mjs
//   node pack.mjs --bundle-dir "D:/path/to/erp-sales-dashboard-bundle"
//   node pack.mjs --only zip
// ---------------------------------------------------------------------------

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { parseArgs, ok, warn, fail, section } from './lib/cli.mjs'
import { PLUGIN_VERSION } from './lib/config-defaults.mjs'
import { createZip, listZip, readZipEntry } from './lib/zip.mjs'
import { createTarGz, extractTarGz } from './lib/tar.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_BUNDLE_DIR = path.resolve(HERE, 'bundle')

/** 文件内容的 sha256（十六进制） */
function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

/** 安装器随包分发的文件（lib/ 下的模块自动全量带上，避免漏文件） */
const INSTALLER_FILES = [
  'install.mjs', 'install.ps1', 'install.sh',
  'uninstall.mjs', 'uninstall.ps1', 'uninstall.sh',
  'check-install.mjs', 'check-install.ps1', 'check-install.sh',
  'pack.mjs', 'manifest.json', 'README.md', 'INSTALL.md',
]

/** lib/ 下的所有 .mjs 模块（自动发现：新增模块不用改这里） */
function collectLibFiles() {
  const libDir = path.join(HERE, 'lib')
  if (!fs.existsSync(libDir)) return []
  return fs.readdirSync(libDir)
    .filter((n) => n.endsWith('.mjs') || n.endsWith('.js'))
    .sort()
    .map((n) => `lib/${n}`)
}

/** bundle 目录里要排除的东西 */
const EXCLUDE_DIRS = new Set(['node_modules', 'cache', 'screenshots'])
// *.local.json = 本机 MCP 端点；verify-host-output.json = 取数快照（内含真实客户名与金额，不随包分发）
// *.bak-*     = 任何以 .bak- 开头的备份文件（改配色/改代码时留下的中间产物），一律不进包
const EXCLUDE_FILE_RE = /(\.bak-[A-Za-z0-9_-]+$|\.local\.json$|^docs[\\/]verify-host-output\.json$)/i

function collectFiles(rootDir, baseDir = '') {
  const out = []
  const walk = (rel) => {
    const dir = path.join(rootDir, rel)
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relChild = rel ? path.join(rel, entry.name) : entry.name
      if (entry.isDirectory()) {
        if (EXCLUDE_DIRS.has(entry.name)) continue
        walk(relChild)
      } else if (entry.isFile()) {
        if (EXCLUDE_FILE_RE.test(relChild)) continue
        out.push(relChild)
      }
    }
  }
  walk(baseDir)
  return out
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('用法：node pack.mjs [--bundle-dir <目录>] [--only zip|tgz]')
    process.exit(0)
  }
  const bundleDir = path.resolve(
    typeof args['bundle-dir'] === 'string' && args['bundle-dir'] ? args['bundle-dir'] : DEFAULT_BUNDLE_DIR,
  )
  const only = typeof args.only === 'string' ? args.only : 'all'

  if (!fs.existsSync(bundleDir)) {
    fail(`找不到 bundle 目录：${bundleDir}`)
    process.exit(1)
  }

  const rootName = `erp-sales-dashboard-plugin-${PLUGIN_VERSION}`
  const entries = []

  // ---- 安装器文件 ----
  section('收集安装器文件')
  const installerFiles = [...INSTALLER_FILES, ...collectLibFiles()]
  for (const rel of installerFiles) {
    const full = path.join(HERE, rel)
    if (!fs.existsSync(full)) {
      warn(`跳过（不存在）：${rel}`)
      continue
    }
    entries.push({
      name: `${rootName}/${rel.replace(/\\/g, '/')}`,
      data: fs.readFileSync(full),
      date: fs.statSync(full).mtime,
    })
  }
  ok(`安装器文件 ${entries.length} 个`)

  // ---- bundle 文件 ----
  const bundleFiles = collectFiles(bundleDir)
  // 打包时给每个 bundle 文件算 sha256，写成包内的 SHA256SUMS.json。
  // 作用：安装后可以用它核对「装出来的文件与打包那一刻完全一致」，
  // 不受源目录后来被改动的影响（源目录是活的，比对活的源目录本身就有竞态）。
  const shaMap = {}
  for (const rel of bundleFiles) {
    const full = path.join(bundleDir, rel)
    shaMap[rel.replace(/\\/g, '/')] = sha256(fs.readFileSync(full))
  }
  const shaManifest = JSON.stringify({
    generatedAt: new Date().toISOString(),
    bundleVersion: PLUGIN_VERSION,
    fileCount: bundleFiles.length,
    files: shaMap,
  }, null, 2) + '\n'
  const shaBuf = Buffer.from(shaManifest, 'utf8')
  for (const rel of bundleFiles) {
    const full = path.join(bundleDir, rel)
    entries.push({
      name: `${rootName}/bundle/${rel.replace(/\\/g, '/')}`,
      data: fs.readFileSync(full),
      date: fs.statSync(full).mtime,
    })
  }
  entries.push({
    name: `${rootName}/bundle/SHA256SUMS.json`,
    data: shaBuf,
    date: fs.statSync(bundleDir).mtime,
  })
  ok(`bundle 文件 ${bundleFiles.length} 个（已排除 node_modules、cache、docs/screenshots、*.bak-*、*.local.json）`)
  ok(`校验清单    ：bundle/SHA256SUMS.json（${bundleFiles.length} 个文件的 sha256）`)

  // ---- 打 zip ----
  if (only === 'all' || only === 'zip') {
    section('打 zip')
    const zipPath = path.join(HERE, `${rootName}.zip`)
    const buf = createZip(entries)
    fs.writeFileSync(zipPath, buf)
    // 打包后自检：能列出条目，且能解出 manifest.json
    const listed = listZip(fs.readFileSync(zipPath))
    const probe = readZipEntry(fs.readFileSync(zipPath), `${rootName}/manifest.json`)
    if (!probe) {
      fail('打包自检失败：zip 里找不到 manifest.json')
      process.exit(1)
    }
    const parsed = JSON.parse(probe.toString('utf8'))
    ok(`zip 路径    ：${zipPath}`)
    ok(`zip 大小    ：${(buf.length / 1024).toFixed(1)} KB`)
    ok(`zip 条目数  ：${listed.length}`)
    ok(`打包自检    ：manifest.json 可解出，displayName = ${parsed.displayName}`)
  }

  // ---- 打 tgz（GUI 路线用）----
  if (only === 'all' || only === 'tgz') {
    section('打 tgz（DSH「添加插件」GUI 用）')
    const tgzEntries = []
    for (const rel of bundleFiles) {
      const full = path.join(bundleDir, rel)
      tgzEntries.push({
        name: `package/${rel.replace(/\\/g, '/')}`,
        data: fs.readFileSync(full),
        date: fs.statSync(full).mtime,
      })
    }
    tgzEntries.push({
      name: 'package/SHA256SUMS.json',
      data: shaBuf,
      date: fs.statSync(bundleDir).mtime,
    })
    const tgz = createTarGz(tgzEntries)
    const tgzPath = path.join(HERE, `erp-sales-dashboard-${PLUGIN_VERSION}.tgz`)
    fs.writeFileSync(tgzPath, tgz)
    ok(`tgz 路径   ：${tgzPath}`)
    ok(`tgz 大小   ：${(tgz.length / 1024).toFixed(1)} KB`)
    ok(`tgz 条目数 ：${tgzEntries.length}（路径前缀 package/）`)

    // 打包后自检：用自己的解包器回读一遍，文件名与内容都要对得上
    // （Windows 上 ustar 的非 ASCII 文件名会被按系统代码页解成乱码，
    //   所以这里必须验证 pax 扩展头确实生效）
    const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'esd-tgz-probe-'))
    try {
      const res = extractTarGz(fs.readFileSync(tgzPath), probeDir)
      const root = path.join(probeDir, 'package')
      if (res.files !== tgzEntries.length) {
        fail(`打包自检失败：tgz 解出 ${res.files} 个文件，期望 ${tgzEntries.length} 个`)
        process.exit(1)
      }
      for (const entry of tgzEntries) {
        const rel = entry.name.replace(/^package\//, '')
        const got = path.join(root, rel)
        if (!fs.existsSync(got)) {
          fail(`打包自检失败：tgz 里解不出 ${rel}（中文文件名可能没走 pax 扩展头）`)
          process.exit(1)
        }
        const same = fs.readFileSync(got).equals(entry.data)
        if (!same) {
          fail(`打包自检失败：${rel} 内容与源文件不一致`)
          process.exit(1)
        }
      }
      ok(`打包自检    ：tgz 回读 ${res.files} 个文件，文件名与内容逐个一致`)
    } finally {
      fs.rmSync(probeDir, { recursive: true, force: true })
    }
  }

  console.log('')
  ok('打包完成。')
  console.log('')
  process.exit(0)
}

main()
