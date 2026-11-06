// ---------------------------------------------------------------------------
// lib/bundle-files.mjs —— bundle 目录的「哪些文件要进包」规则（单一事实源）
// ---------------------------------------------------------------------------
// pack.mjs（打 zip / tgz）与 install.mjs（手工安装 / 原生安装现场打包）
// 都用这一份规则，避免两边口径漂移。
//
// 排除项与原因：
//   node_modules/     依赖不该打进包
//   cache/            运行时缓存
//   docs/screenshots/ 6 MB 截图，单独放在 artifacts/ 里
//   *.bak-*           备份文件
//   *.local.json      本机凭据（mcp.endpoints.local.json 含真实 x-api-key）——**绝不能进包**
// ---------------------------------------------------------------------------

import fs from 'node:fs'
import path from 'node:path'

/** 按目录名排除（任意层级） */
export const EXCLUDE_DIRS = new Set(['node_modules', 'cache', 'screenshots'])
/** 按文件名排除 */
export const EXCLUDE_FILE_RE = /(\.bak-[0-9-]+$|\.local\.json$)/i
/** 给人看的说明，必须与上面的规则一致 */
export const EXCLUDE_DESC = 'node_modules/、cache/、docs/screenshots/、*.bak-*、*.local.json'

/** 相对路径（正斜杠）是否该排除 */
export function isExcludedRel(relPosix) {
  if (EXCLUDE_FILE_RE.test(relPosix)) return true
  const parts = relPosix.split('/')
  for (const p of parts) {
    if (EXCLUDE_DIRS.has(p)) return true
  }
  return false
}

/**
 * 收集 bundle 目录里要进包的文件。
 * @returns {Array<{rel:string, full:string, size:number, mtime:Date}>}
 */
export function collectBundleFiles(rootDir) {
  const root = path.resolve(rootDir)
  const out = []
  const walk = (rel) => {
    const dir = rel ? path.join(root, rel) : root
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const relChild = rel ? path.join(rel, entry.name) : entry.name
      const relPosix = relChild.replace(/\\/g, '/')
      if (entry.isDirectory()) {
        if (EXCLUDE_DIRS.has(entry.name)) continue
        walk(relChild)
      } else if (entry.isFile()) {
        if (isExcludedRel(relPosix)) continue
        const full = path.join(root, relChild)
        const st = fs.statSync(full)
        out.push({ rel: relPosix, full, size: st.size, mtime: st.mtime })
      }
    }
  }
  walk('')
  return out
}
