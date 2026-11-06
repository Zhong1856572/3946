#!/usr/bin/env node
// ---------------------------------------------------------------------------
// test-regression.mjs —— 安装包端到端回归（假 DSH home，不碰真机）
// ---------------------------------------------------------------------------
// 覆盖：
//   路线 A（zip）：解 zip → install → check → uninstall --purge → 残留核对
//   路线 B（tgz）：直接用 tgz → install → check → uninstall --purge → 残留核对
//   幂等：重复 install（--force）与重复 uninstall
//   字节级：装出来的文件与源 bundle 逐个一致
//   非破坏：安装/卸载不得动 profile 里原有的其它依赖与配置块
//
// 用法：node test-regression.mjs
// 退出码：0 全部通过 / 1 有失败
// ---------------------------------------------------------------------------

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { PLUGIN_ID, PLUGIN_PKG_NAME, PLUGIN_VERSION } from './lib/config-defaults.mjs'
import { extractZip } from './lib/zip.mjs'
import { findDshCli } from './lib/native.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BUNDLE_DIR = path.resolve(
  process.env.ESD_BUNDLE_DIR || path.resolve(HERE, 'bundle'),
)
// 发布件优先取 releases/（仓库里的分发位），没有再取插件根目录（node pack.mjs 的输出位）
const pickArtifact = (name) => {
  const inReleases = path.join(HERE, 'releases', name)
  return fs.existsSync(inReleases) ? inReleases : path.join(HERE, name)
}
const ZIP = pickArtifact(`erp-sales-dashboard-plugin-${PLUGIN_VERSION}.zip`)
const TGZ = pickArtifact(`erp-sales-dashboard-${PLUGIN_VERSION}.tgz`)

let failed = 0
let passed = 0
let skipped = 0
const check = (cond, text, detail) => {
  if (cond) { passed += 1; console.log(`  ✔ ${text}`); return true }
  failed += 1
  console.log(`  ✘ ${text}${detail ? ` —— ${detail}` : ''}`)
  return false
}
const section = (t) => console.log(`\n【${t}】`)
/** 说明性输出（不计入检查项） */
const ok = (t) => console.log(`  · ${t}`)
const warn = (t) => console.log(`  ! ${t}`)

/** 跑一个 node 脚本，返回 {code, out} */
function run(script, args, cwd) {
  const res = spawnSync(process.execPath, [script, ...args], {
    cwd: cwd || HERE, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' },
  })
  return { code: res.status, out: `${res.stdout || ''}${res.stderr || ''}` }
}

/** 建一个假 DSH home：profiles/desktop/{package.json,cordis.patch.yml} */
function makeFakeHome(root) {
  const profileDir = path.join(root, 'profiles', 'desktop')
  fs.mkdirSync(profileDir, { recursive: true })

  // 模拟「用户机器上还装着别的插件」。
  // ⚠ 这个 link: 必须指向**真实存在**的目录：
  //   DSH 的 reconcile 会遍历 profile 里所有 bundle，有一个解析不了就整体报错，
  //   于是 `dsh plugin add file:...` 会被带崩（原生安装假失败）。
  //   真实机器上别的插件是装好的，所以这里也要造一个装好的样子。
  const otherDir = path.join(root, 'other-plugin')
  fs.mkdirSync(otherDir, { recursive: true })
  fs.writeFileSync(path.join(otherDir, 'package.json'), JSON.stringify({
    name: '@local/other-plugin', version: '0.0.1', private: true,
  }, null, 2) + '\n', 'utf8')

  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-desktop',
    private: true,
    // 相对路径的 link:（相对 profile 目录），跨机器/跨盘符都稳
    dependencies: { '@local/other-plugin': 'link:../../other-plugin' },
    dsh: { profile: { bundles: ['@local/other-plugin'] } },
  }, null, 2) + '\n', 'utf8')
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), [
    '# 原有配置（模拟用户机器上别的插件）',
    '- insert:',
    '  - id: other-plugin',
    '    name: "@local/other-plugin"',
    '    config:',
    '      hello: world',
    '',
  ].join('\n'), 'utf8')
  return { root, profileDir }
}

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null } }

/** 把目录下的文件列成 {relPath: base64 内容} */
function fileMap(root) {
  const out = {}
  const walk = (rel) => {
    const dir = path.join(root, rel)
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const child = rel ? path.join(rel, e.name) : e.name
      if (e.isDirectory()) walk(child)
      else if (e.isFile()) out[child.replace(/\\/g, '/')] = fs.readFileSync(path.join(root, child)).toString('base64')
    }
  }
  walk('')
  return out
}

/** 文件内容的 sha256（十六进制） */
function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

/** 检查安装后的 profile 状态 */
function assertInstalled(fake, home, label) {
  const pkg = readJson(path.join(fake.profileDir, 'package.json'))
  check(!!pkg, `${label}：profile package.json 仍是合法 JSON`)
  if (!pkg) return
  const dep = pkg.dependencies && pkg.dependencies[PLUGIN_PKG_NAME]
  check(typeof dep === 'string' && dep.startsWith('link:'), `${label}：依赖已登记`, `实际 ${JSON.stringify(dep)}`)
  const bundles = pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles
  check(Array.isArray(bundles) && bundles.includes(PLUGIN_PKG_NAME), `${label}：bundles 已登记`)
  check(!!(pkg.dependencies && pkg.dependencies['@local/other-plugin']), `${label}：原有依赖没被动`)
  check(Array.isArray(bundles) && bundles.includes('@local/other-plugin'), `${label}：原有 bundles 登记没被动`)

  const patch = fs.readFileSync(path.join(fake.profileDir, 'cordis.patch.yml'), 'utf8')
  const count = patch.split('\n').filter((l) => l.trim() === `- id: ${PLUGIN_ID}`).length
  check(count === 1, `${label}：补丁里有且只有一条插件块`, `实际 ${count} 条`)
  check(patch.includes('- id: other-plugin'), `${label}：原有配置块没被动`)

  const link = path.join(fake.profileDir, 'node_modules', '@local', PLUGIN_PKG_NAME.split('/').pop())
  check(fs.existsSync(link), `${label}：node_modules 链接存在`)

  const target = path.join(home, 'plugins', PLUGIN_ID)
  check(fs.existsSync(path.join(target, 'index.js')), `${label}：插件目录已就位`)
  check(fs.existsSync(path.join(target, 'client.js')), `${label}：client.js 已就位`)
  check(fs.existsSync(path.join(target, 'docs', '数据口径与准确性保障说明.md')),
    `${label}：中文文档名没被解成乱码`)
  check(fs.existsSync(path.join(target, 'docs', '需求覆盖矩阵.md')),
    `${label}：中文文档名没被解成乱码（需求覆盖矩阵）`)
}

/** 检查卸载后的 profile 状态 */
function assertUninstalled(fake, home, label) {
  const pkg = readJson(path.join(fake.profileDir, 'package.json'))
  check(!!pkg, `${label}：profile package.json 仍是合法 JSON`)
  if (pkg) {
    check(!(pkg.dependencies && pkg.dependencies[PLUGIN_PKG_NAME]), `${label}：依赖已移除`)
    const bundles = pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles
    check(Array.isArray(bundles) && !bundles.includes(PLUGIN_PKG_NAME), `${label}：bundles 登记已移除`)
    check(!!(pkg.dependencies && pkg.dependencies['@local/other-plugin']), `${label}：原有依赖还在`)
    check(Array.isArray(bundles) && bundles.includes('@local/other-plugin'), `${label}：原有 bundles 登记还在`)
  }
  const patch = fs.readFileSync(path.join(fake.profileDir, 'cordis.patch.yml'), 'utf8')
  check(!patch.includes(`- id: ${PLUGIN_ID}`), `${label}：补丁块已移除`)
  check(patch.includes('- id: other-plugin'), `${label}：原有配置块还在`)
  const link = path.join(fake.profileDir, 'node_modules', '@local', PLUGIN_PKG_NAME.split('/').pop())
  check(!fs.existsSync(link), `${label}：node_modules 链接已移除`)
  const target = path.join(home, 'plugins', PLUGIN_ID)
  check(!fs.existsSync(target), `${label}：插件目录已删除（--purge）`)
}

/**
 * 与「打包那一刻的 bundle」逐字节比对。
 *
 * 不用活的源目录做比对：源 bundle 是会被持续改动的活目录，拿它当基准本身就有竞态
 * （打包后源目录又改了，比对必然不一致，而且说不清是谁的问题）。
 * 改为读包内自带的 bundle/SHA256SUMS.json（打包时算的 sha256 清单），
 * 校验「装出来的文件 = 打包那一刻的文件」，这才是安装包该保证的事。
 */
function assertSameAsSource(target, label) {
  const manifestPath = path.join(target, 'SHA256SUMS.json')
  if (!fs.existsSync(manifestPath)) {
    check(false, `${label}：安装目录里有 SHA256SUMS.json 校验清单`)
    return
  }
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch (e) {
    check(false, `${label}：SHA256SUMS.json 是合法 JSON`, e.message)
    return
  }
  const expected = manifest.files || {}
  const dst = fileMap(target)
  let mismatch = 0
  const problems = []
  for (const [rel, sha] of Object.entries(expected)) {
    const full = path.join(target, rel)
    if (!fs.existsSync(full)) { problems.push(`(缺失) ${rel}`); mismatch += 1; continue }
    const got = sha256(fs.readFileSync(full))
    if (got !== sha) { problems.push(`(内容不同) ${rel}`); mismatch += 1 }
  }
  // 反向：安装目录里不该有清单之外的文件
  for (const k of Object.keys(dst)) {
    if (k === 'SHA256SUMS.json') continue
    if (!(k in expected)) { problems.push(`(多出) ${k}`); mismatch += 1 }
  }
  check(mismatch === 0,
    `${label}：与打包时的 bundle 逐字节一致（${Object.keys(expected).length} 个文件，按包内 SHA256SUMS.json 校验）`,
    problems.slice(0, 5).join('；'))
}

// ---------------------------------------------------------------------------
// 原生安装路线（走 DSH 官方插件命令 `dsh plugin add file:<tgz>`）
// ---------------------------------------------------------------------------
// 与手工模式的差别（实测）：
//   • 插件由 pnpm 装进 profile/node_modules/@local/<name>（.pnpm 虚拟仓库里的实体目录）
//   • profile 依赖写成 "file:<tgz 绝对路径>"，不是 "link:<目录>"
//   • dsh.profile.bundles 由 DSH 自己追加
//   • cordis.patch.yml 的配置块仍然要由安装器补写
// ---------------------------------------------------------------------------
function assertNativeInstalled(fake, home, label) {
  const pkg = readJson(path.join(fake.profileDir, 'package.json'))
  check(!!pkg, `${label}：profile package.json 仍是合法 JSON`)
  if (!pkg) return
  const dep = pkg.dependencies && pkg.dependencies[PLUGIN_PKG_NAME]
  check(typeof dep === 'string' && dep.startsWith('file:'), `${label}：依赖是 file: 规格（原生安装）`, `实际 ${JSON.stringify(dep)}`)
  const bundles = pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles
  check(Array.isArray(bundles) && bundles.includes(PLUGIN_PKG_NAME), `${label}：bundles 已登记`)
  check(!!(pkg.dependencies && pkg.dependencies['@local/other-plugin']), `${label}：原有依赖没被动`)
  check(Array.isArray(bundles) && bundles.includes('@local/other-plugin'), `${label}：原有 bundles 登记没被动`)

  const patch = fs.readFileSync(path.join(fake.profileDir, 'cordis.patch.yml'), 'utf8')
  const count = patch.split('\n').filter((l) => l.trim() === `- id: ${PLUGIN_ID}`).length
  check(count === 1, `${label}：补丁里有且只有一条插件块（原生命令不写这块，是安装器补的）`, `实际 ${count} 条`)
  check(patch.includes('- id: other-plugin'), `${label}：原有配置块没被动`)

  const link = path.join(fake.profileDir, 'node_modules', '@local', PLUGIN_PKG_NAME.split('/').pop())
  check(fs.existsSync(link), `${label}：node_modules/@local 下有插件`)
  check(fs.existsSync(path.join(link, 'index.js')), `${label}：插件的 index.js 已就位`)
  check(fs.existsSync(path.join(link, 'client.js')), `${label}：插件的 client.js 已就位`)
  check(fs.existsSync(path.join(link, 'docs', '数据口径与准确性保障说明.md')),
    `${label}：中文文档名没被装成乱码`)

  const tgz = path.join(home, 'plugins', `erp-sales-dashboard-${PLUGIN_VERSION}.tgz`)
  check(fs.existsSync(tgz), `${label}：插件包文件已就位（依赖指向它）`, tgz)
}

function assertNativeUninstalled(fake, home, label) {
  const pkg = readJson(path.join(fake.profileDir, 'package.json'))
  check(!!pkg, `${label}：profile package.json 仍是合法 JSON`)
  if (pkg) {
    check(!(pkg.dependencies && pkg.dependencies[PLUGIN_PKG_NAME]), `${label}：依赖已删除`)
    const bundles = pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles
    check(Array.isArray(bundles) && !bundles.includes(PLUGIN_PKG_NAME), `${label}：bundles 登记已删除`)
    check(!!(pkg.dependencies && pkg.dependencies['@local/other-plugin']), `${label}：原有依赖没被动`)
  }
  const patch = fs.readFileSync(path.join(fake.profileDir, 'cordis.patch.yml'), 'utf8')
  check(!patch.includes(`- id: ${PLUGIN_ID}`), `${label}：插件配置块已删除`)
  check(patch.includes('- id: other-plugin'), `${label}：原有配置块没被动`)
  const link = path.join(fake.profileDir, 'node_modules', '@local', PLUGIN_PKG_NAME.split('/').pop())
  check(!fs.existsSync(link), `${label}：node_modules 里的插件已清理`)
  const tgz = path.join(home, 'plugins', `erp-sales-dashboard-${PLUGIN_VERSION}.tgz`)
  check(!fs.existsSync(tgz), `${label}：插件包文件已删除`)
}

/**
 * 跑原生安装路线。
 * @param {string} label 路线名
 * @param {{withSpace?:boolean}} opts withSpace=true 时把假 home 放在含空格的路径下，
 *        用来验证 Windows 上 `shell:true` 不加引号会把含空格的 tgz 路径拆断那个坑
 */
function runNativeRoute(label, opts = {}) {
  section(label)
  const cli = findDshCli()
  if (!cli) {
    warn(`${label}：本机没找到 DSH 命令行（dsh），跳过这条路线。`)
    warn('    装过 DSH 之后重跑本脚本即可；或用 --dsh-cli <路径> 指定。')
    skipped += 1
    return
  }
  ok(`${label}：DSH 命令行 ${cli.path}（来源：${cli.source}）`)

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'esd-native-'))
  const root = opts.withSpace ? path.join(tmp, '带 空格的目录') : tmp
  const home = path.join(root, 'dsh-home')
  const fake = makeFakeHome(home)
  const work = path.join(root, 'work dir')
  fs.mkdirSync(work, { recursive: true })
  for (const rel of ['install.mjs', 'uninstall.mjs', 'check-install.mjs']) {
    fs.copyFileSync(path.join(HERE, rel), path.join(work, rel))
  }
  fs.cpSync(path.join(HERE, 'lib'), path.join(work, 'lib'), { recursive: true })

  // 把插件包放到一个「路径里有空格和中文」的地方，用 --tgz 显式指过去。
  // 这样 `dsh plugin add file:<路径>` 的参数里就一定带空格 —— 正是要验证的那个坑。
  const tgzName = opts.withSpace ? '我的 插件包.tgz' : 'erp-sales-dashboard-1.4.0.tgz'
  const tgzSrc = path.join(root, tgzName)
  fs.copyFileSync(TGZ, tgzSrc)
  if (opts.withSpace) {
    check(/\s/.test(tgzSrc), `${label}：插件包路径确实含空格（${tgzSrc}）`)
  }

  // 1) 安装（native 是默认；--no-native 才走手工）
  const install = run('install.mjs', ['--dsh-home', home, '--profile', 'desktop', '--tgz', tgzSrc], work)
  check(install.code === 0, `${label}：install 退出码 0`,
    install.out.split('\n').filter((l) => l.includes('✘')).slice(0, 3).join(' | '))
  check(install.out.includes('原生安装（DSH 官方插件命令）'), `${label}：走了原生安装分支`)
  check(!install.out.includes('已回落到手工安装模式'), `${label}：没有回落到手工模式`)
  assertNativeInstalled(fake, home, label)

  // 2) 安装后核对
  const chk = run('check-install.mjs', ['--dsh-home', home, '--profile', 'desktop'], work)
  check(chk.code === 0, `${label}：check-install 全部通过`,
    chk.out.split('\n').filter((l) => l.includes('✘')).slice(0, 3).join(' | '))
  check(chk.out.includes('native'), `${label}：check-install 认出是 native 模式`)

  // 3) 卸载
  const un = run('uninstall.mjs', ['--dsh-home', home, '--profile', 'desktop', '--purge'], work)
  check(un.code === 0, `${label}：uninstall 退出码 0`,
    un.out.split('\n').filter((l) => l.includes('✘')).slice(0, 3).join(' | '))
  assertNativeUninstalled(fake, home, label)

  fs.rmSync(tmp, { recursive: true, force: true })
}

/** 跑一条完整路线。opts.mode = 'manual'（默认）| 'native' */
function runRoute(label, prepare, opts = {}) {
  const mode = opts.mode === 'native' ? 'native' : 'manual'
  section(label)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'esd-reg-'))
  const home = path.join(tmp, 'dsh-home')
  const fake = makeFakeHome(home)
  const work = path.join(tmp, 'work')
  fs.mkdirSync(work, { recursive: true })
  prepare(work)

  const baseArgs = ['--dsh-home', home, '--profile', 'desktop']
  // 手工模式必须显式 --no-native，否则安装器会先试原生命令
  const modeArgs = mode === 'manual' ? ['--no-native'] : []
  // 额外的 --config 覆盖（安装与核对要用同一份期望值）
  const extraArgs = Array.isArray(opts.extraArgs) ? opts.extraArgs : []

  // 1) 安装
  const install = run('install.mjs', [...baseArgs, ...modeArgs, ...extraArgs], work)
  check(install.code === 0, `${label}：install 退出码 0`, install.out.split('\n').filter((l) => l.includes('✘')).join(' | '))
  if (mode === 'native') {
    check(install.out.includes('原生安装（DSH 官方插件命令）'), `${label}：走了原生安装分支`)
    check(!install.out.includes('已回落到手工安装模式'), `${label}：没有回落到手工模式`)
    assertNativeInstalled(fake, home, label)
  } else {
    check(install.out.includes('手工模式'), `${label}：走了手工安装分支`)
    assertInstalled(fake, home, label)
    // 字节级比对：装出来的目录必须和源 bundle 一模一样
    assertSameAsSource(path.join(home, 'plugins', PLUGIN_ID), label)
  }
  if (typeof opts.afterInstall === 'function') opts.afterInstall(home, label)

  // 2) 安装后核对脚本
  const chk = run('check-install.mjs', [...baseArgs, ...extraArgs], work)
  check(chk.code === 0, `${label}：check-install 全部通过`,
    chk.out.split('\n').filter((l) => l.includes('✘')).slice(0, 3).join(' | '))
  if (mode === 'native') check(chk.out.includes('native'), `${label}：check-install 认出是 native 模式`)
  if (typeof opts.afterCheck === 'function') opts.afterCheck(chk.out, label)

  // 3) 幂等：再装一次（--force）
  const again = run('install.mjs', [...baseArgs, '--force', ...modeArgs, ...extraArgs], work)
  check(again.code === 0, `${label}：重复安装（--force）退出码 0`,
    again.out.split('\n').filter((l) => l.includes('✘')).slice(0, 3).join(' | '))
  const chk2 = run('check-install.mjs', [...baseArgs, ...extraArgs], work)
  check(chk2.code === 0, `${label}：重复安装后 check-install 仍全部通过`,
    chk2.out.split('\n').filter((l) => l.includes('✘')).slice(0, 3).join(' | '))

  // 4) 卸载
  const un = run('uninstall.mjs', [...baseArgs, '--purge'], work)
  check(un.code === 0, `${label}：uninstall 退出码 0`,
    un.out.split('\n').filter((l) => l.includes('✘')).slice(0, 3).join(' | '))
  if (mode === 'native') assertNativeUninstalled(fake, home, label)
  else assertUninstalled(fake, home, label)

  // 5) 卸载幂等：再卸一次应当报「没有安装痕迹」并返回 1
  const un2 = run('uninstall.mjs', [...baseArgs, '--purge'], work)
  check(un2.code === 1, `${label}：重复卸载被正确拒绝（退出码 1）`, `实际 ${un2.code}`)

  fs.rmSync(tmp, { recursive: true, force: true })
}

function main() {
  console.log(`ERP 销售仪表盘插件 —— 安装包端到端回归`)
  console.log(`源 bundle：${BUNDLE_DIR}`)
  console.log(`zip：${ZIP}`)
  console.log(`tgz：${TGZ}`)
  if (!fs.existsSync(BUNDLE_DIR)) { console.log('✘ 源 bundle 不存在，先跑 node pack.mjs'); process.exit(1) }
  if (!fs.existsSync(ZIP)) { console.log('✘ zip 不存在（releases/ 与插件根目录都没找到），先跑 node pack.mjs'); process.exit(1) }
  if (!fs.existsSync(TGZ)) { console.log('✘ tgz 不存在（releases/ 与插件根目录都没找到），先跑 node pack.mjs'); process.exit(1) }

  // 路线 A：zip —— 解开后从 bundle/ 目录装（原生安装：由安装器现场打 tgz 交给 dsh plugin add）
  runRoute('路线 A（zip + 原生安装）', (work) => {
    const res = extractZip(fs.readFileSync(ZIP), work)
    check(res.files > 0, `路线 A（zip）：zip 解出 ${res.files} 个文件`)
    const root = path.join(work, `erp-sales-dashboard-plugin-${PLUGIN_VERSION}`)
    check(fs.existsSync(path.join(root, 'install.mjs')), '路线 A（zip）：含 install.mjs')
    check(fs.existsSync(path.join(root, 'bundle', 'index.js')), '路线 A（zip）：含 bundle/index.js')
    check(fs.existsSync(path.join(root, 'bundle', 'docs', '数据口径与准确性保障说明.md')),
      '路线 A（zip）：中文文档名没被解成乱码')
    fs.cpSync(root, path.join(work, 'app'), { recursive: true })
    fs.rmSync(root, { recursive: true, force: true })
    // 让 work 目录就是 app 的内容：把 install.mjs 与 bundle/ 提到 work 根
    for (const name of fs.readdirSync(path.join(work, 'app'))) {
      fs.renameSync(path.join(work, 'app', name), path.join(work, name))
    }
    fs.rmSync(path.join(work, 'app'), { recursive: true, force: true })
  }, { mode: 'native' })

  // 路线 B：zip —— 手工模式（--no-native），产物要与源 bundle 逐字节一致
  runRoute('路线 B（zip + 手工模式）', (work) => {
    const res = extractZip(fs.readFileSync(ZIP), work)
    const root = path.join(work, `erp-sales-dashboard-plugin-${PLUGIN_VERSION}`)
    fs.cpSync(root, path.join(work, 'app'), { recursive: true })
    fs.rmSync(root, { recursive: true, force: true })
    for (const name of fs.readdirSync(path.join(work, 'app'))) {
      fs.renameSync(path.join(work, 'app', name), path.join(work, name))
    }
    fs.rmSync(path.join(work, 'app'), { recursive: true, force: true })
  }, { mode: 'manual' })

  // 路线 C：tgz —— 只放 install.mjs + lib/ + tgz，安装器自己解 tgz（原生安装）
  runRoute('路线 C（tgz + 原生安装）', (work) => {
    for (const rel of ['install.mjs', 'uninstall.mjs', 'check-install.mjs']) {
      fs.copyFileSync(path.join(HERE, rel), path.join(work, rel))
    }
    fs.cpSync(path.join(HERE, 'lib'), path.join(work, 'lib'), { recursive: true })
    fs.copyFileSync(TGZ, path.join(work, path.basename(TGZ)))
  }, { mode: 'native' })

  // 路线 D：tgz —— 手工模式（--no-native）
  runRoute('路线 D（tgz + 手工模式）', (work) => {
    for (const rel of ['install.mjs', 'uninstall.mjs', 'check-install.mjs']) {
      fs.copyFileSync(path.join(HERE, rel), path.join(work, rel))
    }
    fs.cpSync(path.join(HERE, 'lib'), path.join(work, 'lib'), { recursive: true })
    fs.copyFileSync(TGZ, path.join(work, path.basename(TGZ)))
  }, { mode: 'manual' })

  // 路线 E：原生安装（DSH 官方插件命令 dsh plugin add file:<tgz>）
  runNativeRoute('路线 E（原生安装）')

  // 路线 F：原生安装 + 路径含空格
  //   验证 Windows 上「shell:true 不给参数加引号」那个坑已修：
  //   tgz 路径、DSH home 路径、profile 路径全都带空格。
  runNativeRoute('路线 F（原生安装 + 路径含空格）', { withSpace: true })

  // 路线 G：--config 覆盖（含对象型 toolPrefixes）要真的写进 cordis.patch.yml
  runRoute('路线 G（--config 覆盖 + toolPrefixes）', (work) => {
    for (const rel of ['install.mjs', 'uninstall.mjs', 'check-install.mjs']) {
      fs.copyFileSync(path.join(HERE, rel), path.join(work, rel))
    }
    fs.cpSync(path.join(HERE, 'lib'), path.join(work, 'lib'), { recursive: true })
    fs.copyFileSync(TGZ, path.join(work, path.basename(TGZ)))
  }, {
    mode: 'manual',
    extraArgs: ['--config', 'toolPrefixes.erp=mcp__erp-cn__', '--config', 'thresholds.stdShare=0.65'],
    afterInstall: (home, label) => {
      const patchPath = path.join(home, 'profiles', 'desktop', 'cordis.patch.yml')
      const text = fs.existsSync(patchPath) ? fs.readFileSync(patchPath, 'utf8') : ''
      // 注意：不能只 grep "toolPrefixes:" —— 补丁里的中文注释也含这几个字，
      // 必须要求「真正生效的那一行」（不以 # 开头）。
      check(/^\s*toolPrefixes:\s*$/m.test(text), `${label}：补丁里写进了 toolPrefixes 映射`)
      check(/^\s+erp: mcp__erp-cn__\s*$/m.test(text), `${label}：补丁里写进了 erp 前缀 mcp__erp-cn__`)
      check(/^\s+stdShare: 0\.65\s*$/m.test(text), `${label}：补丁里写进了阈值 stdShare: 0.65`)
      check(!/\[object Object\]/.test(text), `${label}：补丁里没有把对象写成 [object Object]`)
    },
    afterCheck: (out, label) => {
      check(out.includes('toolPrefixes'), `${label}：check-install 输出了 toolPrefixes 结论`)
      check(out.includes('mcp__erp-cn__'), `${label}：check-install 显示了识别到的 erp 前缀`)
    },
  })

  console.log('')
  if (skipped) console.log(`（跳过 ${skipped} 条路线）`)
  if (failed === 0) {
    console.log(`✔ 全部通过：${passed} 项检查，0 失败。`)
    process.exit(0)
  }
  console.log(`✘ 有 ${failed} 项失败（通过 ${passed} 项）。`)
  process.exit(1)
}

main()
