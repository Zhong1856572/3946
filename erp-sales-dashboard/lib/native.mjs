// ---------------------------------------------------------------------------
// lib/native.mjs —— DSH 原生插件安装 CLI（`dsh plugin ...`）的定位与调用
// ---------------------------------------------------------------------------
// 事实依据（本机实测）：
//   * `dsh plugin --help` 原文：
//       "manage a profile's plugins by forwarding the remaining arguments to pnpm
//        in the profile directory"
//     参数：--profile <name>（"the profile whose plugins to manage (initialized on
//     first use)"），其余参数**原样转发给 pnpm**（add <pkg> / remove <pkg> / why …）。
//   * 目录结构规律：`<应用根>/resources/runtime/cli/bin/dsh.cmd`（Windows）
//     `<应用根>/resources/runtime/cli/bin/dsh`（macOS/Linux）
//     `<应用根>` 就是 Electron 应用目录（里面有 resources/ 与 DeepSeek Harness.exe）。
//   * Windows 上 dsh 是 **.cmd 批处理**（只有 .cmd，没有 .exe），里面是：
//         @echo off
//         setlocal DisableDelayedExpansion
//         set "ELECTRON_RUN_AS_NODE=1"
//         "%~dp0..\..\..\..\DeepSeek Harness.exe" --expose-internals "…cli.js" %*
//         exit /b %errorlevel%
//     → Node 里必须 `spawn(cmd, args, { shell: true })`，用 execFile 直跑 .cmd 会 EINVAL/ENOENT。
//   * macOS/Linux 上 dsh 是可执行文件 → 直接 spawn，不需要 shell。
//
// 原生安装一条命令就能干三件事（实测）：
//   ① 把 tgz 装进 profile 的 node_modules/@local/<name>
//   ② 把插件 id 追加进 profile package.json 的 dsh.profile.bundles
//   ③ 把 dependencies 写成 "file:<tgz 绝对路径>"
// **但它不写 profile 的 cordis.patch.yml 配置块** —— 那一步必须由安装器补上。
// ---------------------------------------------------------------------------

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const IS_WIN = process.platform === 'win32'

/** 已知安装位置候选（按优先级）。全部逐个实测存在性，不存在就跳过。 */
function candidateList() {
  const home = os.homedir()
  const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
  if (IS_WIN) {
    return [
      path.join(localAppData, 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'),
      path.join(localAppData, 'Programs', 'deepseek-harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'),
      path.join(localAppData, 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'),
      'C:\\Program Files\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd',
      'C:\\Program Files (x86)\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd',
      'D:\\DSH-CN\\DSH\\resources\\runtime\\cli\\bin\\dsh.cmd',
      'D:\\DSH\\DSH Desktop\\resources\\runtime\\cli\\bin\\dsh.cmd',
    ]
  }
  return [
    '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh',
    path.join(home, 'Applications', 'DeepSeek Harness.app', 'Contents', 'Resources', 'runtime', 'cli', 'bin', 'dsh'),
    '/opt/DeepSeek Harness/resources/runtime/cli/bin/dsh',
    '/opt/deepseek-harness/resources/runtime/cli/bin/dsh',
    '/usr/local/bin/dsh',
    '/usr/bin/dsh',
  ]
}

/** 在 PATH 里找 dsh（Windows 找 dsh.cmd / dsh.exe / dsh；POSIX 找 dsh） */
function pathLookup() {
  const names = IS_WIN ? ['dsh.cmd', 'dsh.exe', 'dsh'] : ['dsh']
  const raw = process.env.PATH || ''
  const dirs = raw.split(path.delimiter).filter(Boolean)
  for (const dir of dirs) {
    for (const name of names) {
      const full = path.join(dir, name)
      if (isExecutable(full)) return full
    }
  }
  return null
}

/** 存在性 + 可执行性检查 */
export function isExecutable(p) {
  if (!p) return false
  try {
    if (!fs.existsSync(p)) return false
    const st = fs.statSync(p)
    if (!st.isFile()) return false
    if (IS_WIN) return true
    fs.accessSync(p, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 定位 DSH CLI。
 * @param {string} [explicit]  --dsh-cli 显式指定的路径
 * @returns {{path:string, source:string}|null}
 */
export function findDshCli(explicit) {
  const tried = []
  const consider = (p, source) => {
    if (!p) return null
    const abs = path.resolve(p)
    if (tried.includes(abs)) return null
    tried.push(abs)
    if (!isExecutable(abs)) return null
    return { path: abs, source }
  }

  // 1) 显式指定（--dsh-cli）
  if (explicit) {
    const hit = consider(explicit, '--dsh-cli')
    if (hit) return hit
    return null
  }
  // 2) 环境变量 DSH_CLI
  if (process.env.DSH_CLI) {
    const hit = consider(process.env.DSH_CLI, '环境变量 DSH_CLI')
    if (hit) return hit
  }
  // 3) PATH
  const onPath = pathLookup()
  if (onPath) {
    const hit = consider(onPath, 'PATH')
    if (hit) return hit
  }
  // 4) 已知安装位置
  for (const c of candidateList()) {
    const hit = consider(c, '已知安装位置')
    if (hit) return hit
  }
  return null
}

/** 把「试过哪些、为什么没选」讲清楚，方便用户自己指路径 */
export function describeCandidates(explicit) {
  const list = []
  if (explicit) list.push({ p: path.resolve(explicit), why: '--dsh-cli 指定' })
  if (process.env.DSH_CLI) list.push({ p: path.resolve(process.env.DSH_CLI), why: '环境变量 DSH_CLI' })
  for (const c of candidateList()) list.push({ p: c, why: '已知安装位置' })
  return list
}

/**
 * 调 dsh plugin。
 *
 * ⚠️ Windows 引号坑（必须走显式拼命令行，不能用 shell:true + args.join(' ')）：
 *     Node 在 `shell:true` 时是 `command + ' ' + args.join(' ')` 直接拼命令行，
 *     **不给参数加引号**。所以只要路径里有空格就会被 cmd 拆断：
 *       `C:\Program Files\DeepSeek Harness\...\dsh.cmd`（候选清单里就有这一条）
 *       `add file:C:\Users\张三\Desktop\我的 插件\...tgz`
 *     → 表现为参数被拆成多个，pnpm 报 "package not found" 之类看不懂的错。
 *     修法（Windows 分支）：自己给每个参数加引号，再用
 *     `cmd.exe /d /s /c "<拼好的命令行>"` 执行。/d 关 AutoRun，/s 用 cmd 的特殊引号规则。
 *
 * @param {object} o
 * @param {{path:string}} o.cli
 * @param {string} o.profile
 * @param {string[]} o.args      原样转发给 pnpm 的参数，例如 ['add', 'file:xxx.tgz']
 * @param {string} o.home        DSH home（写进子进程环境变量 DSH_HOME）
 * @param {string} o.cwd         子进程工作目录（profile 目录）
 * @param {boolean} [o.quiet]    true 时不把子进程输出透传到当前终端
 * @returns {{code:number, stdout:string, stderr:string, error?:string}}
 */
export function runDshPlugin({ cli, profile, args, home, cwd, quiet }) {
  const full = ['plugin', '--profile', profile, ...args]
  const env = { ...process.env }
  if (home) env.DSH_HOME = path.resolve(home)
  const isCmd = IS_WIN && /\.(cmd|bat)$/i.test(cli.path)
  const stdio = quiet ? 'pipe' : 'inherit'

  let res
  if (isCmd) {
    // 自己拼命令行并逐个加引号，绕开 Node shell:true 不加引号的问题。
    //
    // ⚠️ 这里还有第二层坑：Node 在 Windows 上默认会对参数做 C 风格转义
    //    （把参数里的 " 转成 \"）。把整条命令行当成一个参数交给 cmd /c 时，
    //    cmd 收到的是 '\"D:\...dsh.cmd\"' 这种带反斜杠的鬼东西，直接报
    //    「'\"xxx\"' is not recognized as an internal or external command」。
    //
    // 修法（实测有效）：① windowsVerbatimArguments: true —— 让 Node 原样传参不转义；
    //                  ② 整条命令行外面再包一层引号 —— cmd /s 会剥掉首尾这两个引号，
    //                     剥掉的正好是这层外壳，剩下的 "prog" "arg1" ... 原样交给 cmd。
    const quote = (s) => `"${String(s).replace(/"/g, '""')}"`
    const cmdline = `"${[quote(cli.path), ...full.map(quote)].join(' ')}"`
    res = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', cmdline], {
      cwd,
      env,
      encoding: 'utf8',
      stdio,
      windowsHide: true,
      windowsVerbatimArguments: true,
    })
  } else {
    res = spawnSync(cli.path, full, {
      cwd,
      env,
      encoding: 'utf8',
      stdio,
      windowsHide: true,
    })
  }
  if (res.error) {
    return { code: -1, stdout: res.stdout || '', stderr: res.stderr || '', error: res.error.message }
  }
  return {
    code: typeof res.status === 'number' ? res.status : -1,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
  }
}

/**
 * 原生安装：把 tgz 装进 profile。
 * @returns {{ok:boolean, code:number, message:string, output:string}}
 */
export function nativeInstall({ cli, profile, tgzPath, home, profileDir }) {
  const res = runDshPlugin({
    cli,
    profile,
    args: ['add', `file:${path.resolve(tgzPath)}`],
    home,
    cwd: profileDir,
  })
  const output = `${res.stdout || ''}${res.stderr || ''}`.trim()
  if (res.error) {
    return { ok: false, code: res.code, message: `调用 DSH CLI 出错：${res.error}`, output }
  }
  if (res.code !== 0) {
    return { ok: false, code: res.code, message: `DSH CLI 退出码 ${res.code}`, output }
  }
  return { ok: true, code: 0, message: 'DSH CLI 安装成功', output }
}

/**
 * DSH 的插件管理器读 profile package.json 时用的是裸 JSON.parse，
 * **不剥 UTF-8 BOM** —— 一旦文件带 BOM，DSH CLI 会直接崩：
 *     SyntaxError: Unexpected token '﻿', "﻿{"name":""... is not valid JSON
 *     at readProfileManifest (…/dsh-app-boot/lib/index.js:913:22)
 * （实测：用 PowerShell `Set-Content -Encoding utf8` 写出来的 profile package.json 就会带 BOM。）
 *
 * 所以在调用原生 CLI 之前先把这个坑堵上：带 BOM 就备份并改写成无 BOM。
 *
 * @returns {{fixed:boolean, message:string}}
 */
export function stripProfileBom(profileDir) {
  const pkgPath = path.join(profileDir, 'package.json')
  if (!fs.existsSync(pkgPath)) return { fixed: false, message: 'profile package.json 不存在，跳过 BOM 检查' }
  const raw = fs.readFileSync(pkgPath)
  if (!(raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf)) {
    return { fixed: false, message: 'profile package.json 无 BOM，无需处理' }
  }
  const stamp = new Date()
  const p = (n) => String(n).padStart(2, '0')
  const tag = `${stamp.getFullYear()}${p(stamp.getMonth() + 1)}${p(stamp.getDate())}-${p(stamp.getHours())}${p(stamp.getMinutes())}${p(stamp.getSeconds())}`
  const backup = `${pkgPath}.bak-${tag}`
  fs.copyFileSync(pkgPath, backup)
  fs.writeFileSync(pkgPath, raw.subarray(3))
  return {
    fixed: true,
    message: `profile package.json 带 UTF-8 BOM（DSH CLI 读不了），已备份为 ${path.basename(backup)} 并改写为无 BOM`,
  }
}

/**
 * 原生卸载：让 pnpm 把插件从 profile 里摘掉。
 * @returns {{ok:boolean, code:number, message:string, output:string}}
 */
export function nativeRemove({ cli, profile, pkgName, home, profileDir }) {
  const res = runDshPlugin({
    cli,
    profile,
    args: ['remove', pkgName],
    home,
    cwd: profileDir,
  })
  const output = `${res.stdout || ''}${res.stderr || ''}`.trim()
  if (res.error) {
    return { ok: false, code: res.code, message: `调用 DSH CLI 出错：${res.error}`, output }
  }
  if (res.code !== 0) {
    return { ok: false, code: res.code, message: `DSH CLI 退出码 ${res.code}`, output }
  }
  return { ok: true, code: 0, message: 'DSH CLI 卸载成功', output }
}
