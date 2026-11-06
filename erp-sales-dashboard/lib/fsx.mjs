// ---------------------------------------------------------------------------
// 文件系统小工具：递归复制 / 备份 / 链接（junction vs symlink）
// ---------------------------------------------------------------------------
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/**
 * 复制目录树；跳过 node_modules 与 bak 文件；返回复制的文件数与总字节
 * opts.skipNames  Set<string>  按目录名跳过（任意层级）
 * opts.skipFileRe RegExp       按相对路径匹配跳过文件
 * opts.skipPathRe RegExp       按相对路径（正斜杠）跳过目录或文件，例如 /^docs\/screenshots(\/|$)/
 */
export function copyDir(srcDir, destDir, opts = {}) {
  const skipNames = new Set(opts.skipNames || ['node_modules'])
  const skipFileRe = opts.skipFileRe || null
  const skipPathRe = opts.skipPathRe || null
  const root = path.resolve(srcDir)
  let files = 0
  let bytes = 0
  const skipped = []

  if (!fs.existsSync(root)) {
    const err = new Error(`源目录不存在：${root}`)
    err.exitCode = 1
    throw err
  }
  fs.mkdirSync(destDir, { recursive: true })

  const walk = (rel) => {
    const from = rel ? path.join(root, rel) : root
    const to = rel ? path.join(destDir, rel) : destDir
    const entries = fs.readdirSync(from, { withFileTypes: true })
    for (const entry of entries) {
      const relChild = rel ? path.join(rel, entry.name) : entry.name
      const relPosix = relChild.replace(/\\/g, '/')
      if (entry.isDirectory()) {
        if (skipNames.has(entry.name)) { skipped.push(`${relPosix}/`); continue }
        if (skipPathRe && skipPathRe.test(relPosix)) { skipped.push(`${relPosix}/`); continue }
        fs.mkdirSync(path.join(destDir, relChild), { recursive: true })
        walk(relChild)
      } else if (entry.isFile()) {
        if (skipFileRe && skipFileRe(relChild)) { skipped.push(relPosix); continue }
        if (skipPathRe && skipPathRe.test(relPosix)) { skipped.push(relPosix); continue }
        fs.copyFileSync(path.join(from, entry.name), path.join(destDir, relChild))
        files += 1
        bytes += fs.statSync(path.join(destDir, relChild)).size
      }
    }
  }
  walk('')
  return { files, bytes, skipped }
}

/** 删除目录树（只删自己传进来的路径） */
export function removeDir(dir) {
  if (!fs.existsSync(dir)) return false
  fs.rmSync(dir, { recursive: true, force: true })
  return true
}

/** 生成备份文件名：<name>.bak-YYYYMMDD-HHMMSS */
export function backupPathFor(filePath, stamp = timestamp()) {
  const dir = path.dirname(filePath)
  const base = path.basename(filePath)
  return path.join(dir, `${base}.bak-${stamp}`)
}

/** 时间戳：20261026-140233 */
export function timestamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  )
}

/** 备份一个文件（内容原样复制），返回备份路径；文件不存在返回 null */
export function backupFile(filePath, stamp = timestamp()) {
  if (!fs.existsSync(filePath)) return null
  const dest = backupPathFor(filePath, stamp)
  fs.copyFileSync(filePath, dest)
  return dest
}

/** 解析符号链接/junction 的真实目标；不是链接返回 null */
export function readLinkTarget(linkPath) {
  try {
    const st = fs.lstatSync(linkPath)
    if (!st.isSymbolicLink()) return null
    return fs.realpathSync(linkPath)
  } catch {
    return null
  }
}

/** 目标目录的绝对路径（Windows 上把 / 换成 \） */
export function normalizePathForCompare(p) {
  if (!p) return null
  let out = path.resolve(p)
  if (process.platform === 'win32') out = out.replace(/\//g, '\\')
  return out.replace(/[\\/]+$/, '').toLowerCase()
}

/**
 * 创建指向 target 的链接。
 * Windows 用目录 junction（不需要管理员权限），POSIX 用普通 symlink。
 * 已存在时：指向同一个地方 → 返回 'exists-ok'；指向别处 → 先删再建，返回 'replaced'。
 */
export function ensureLink(linkPath, targetDir) {
  const target = path.resolve(targetDir)
  if (fs.existsSync(linkPath)) {
    const current = readLinkTarget(linkPath)
    if (current && normalizePathForCompare(current) === normalizePathForCompare(target)) {
      return { action: 'exists-ok', target }
    }
    fs.rmSync(linkPath, { recursive: true, force: true })
    fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
    return { action: 'replaced', target, previous: current }
  }
  fs.mkdirSync(path.dirname(linkPath), { recursive: true })
  fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
  return { action: 'created', target }
}

/** 删除链接（不动目标目录） */
export function removeLink(linkPath) {
  if (!fs.existsSync(linkPath)) return false
  fs.rmSync(linkPath, { recursive: true, force: true })
  return true
}

/** DSH home：环境变量 DSH_HOME 优先，否则 ~/.dsh */
export function defaultDshHome() {
  const fromEnv = process.env.DSH_HOME && process.env.DSH_HOME.trim()
  if (fromEnv) return path.resolve(fromEnv)
  return path.join(os.homedir(), '.dsh')
}

/** 把 Windows 路径转成正斜杠（写进 package.json 的 link: 规格用） */
export function toPosixPath(p) {
  return String(p).replace(/\\/g, '/')
}

const BOM = '\uFEFF'

/** 文件是否带 UTF-8 BOM */
export function hasBom(text) {
  return typeof text === 'string' && text.charCodeAt(0) === 0xfeff
}

/**
 * 读文本文件并**剥掉 UTF-8 BOM**。
 * Windows PowerShell 5.1 的 `Set-Content -Encoding UTF8` 会写 BOM，
 * 而 Node 的 JSON.parse 见到 BOM 直接抛「Unexpected token '﻿'」，
 * 所以凡是读用户 profile 里的 json/yml，都必须走这里。
 */
export function readTextFile(filePath) {
  if (!fs.existsSync(filePath)) return ''
  const text = fs.readFileSync(filePath, 'utf8')
  return hasBom(text) ? text.slice(1) : text
}

/** 读 JSON 文件（容忍 BOM）；解析失败返回 null */
export function readJsonFile(filePath) {
  try {
    const text = readTextFile(filePath)
    if (!text.trim()) return null
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** 写文本文件；keepBom=true 时原样保留原文件的 BOM（避免改动用户文件编码约定） */
export function writeTextFile(filePath, text, keepBom = false) {
  const prefix = keepBom && fs.existsSync(filePath) && hasBom(fs.readFileSync(filePath, 'utf8')) ? BOM : ''
  fs.writeFileSync(filePath, prefix + text, 'utf8')
}
