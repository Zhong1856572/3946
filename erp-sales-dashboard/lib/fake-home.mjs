// ---------------------------------------------------------------------------
// lib/fake-home.mjs —— 造一个假 DSH home，用于安装包回归测试（不碰真机）
// ---------------------------------------------------------------------------
// 生成的目录结构（最小可用）：
//   <root>/profiles/desktop/package.json
//   <root>/profiles/desktop/cordis.patch.yml
//
// ⚠ 必须**用 Node 写文件**，不能用 PowerShell 的 `Set-Content -Encoding utf8`
//    —— 那会写 UTF-8 BOM，而 DSH 的插件管理器读 profile package.json 用的是
//    裸 JSON.parse（不剥 BOM），会直接崩：
//       SyntaxError: Unexpected token '﻿', "﻿{"name":""... is not valid JSON
//       at readProfileManifest (…/dsh-app-boot/lib/index.js:913:22)
//    我们的安装器在调用原生 CLI 前会自动剥掉 BOM（见 lib/native.mjs stripProfileBom），
//    但 fixture 本身应当保持干净，这样测出来的才是真实路径。
// ---------------------------------------------------------------------------

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * @param {string} root        假 DSH home 根目录
 * @param {object} [opts]
 * @param {boolean} [opts.withBrokenDep=false]
 *        true 时塞一个**指向不存在目录**的依赖 link:D:/somewhere/other。
 *        用来复现「DSH 原生命令会因其它插件装不上而整体失败」的真实场景
 *        （DSH 的 reconcile 会遍历 profile 里所有 bundle，有一个解析不了就抛错）。
 * @param {string} [opts.profile='desktop']
 */
export function makeFakeHome(root, opts = {}) {
  const profileName = opts.profile || 'desktop'
  const withBrokenDep = opts.withBrokenDep === true
  const profileDir = path.join(root, 'profiles', profileName)
  fs.mkdirSync(profileDir, { recursive: true })

  const pkg = {
    name: `dsh-profile-${profileName}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [] } },
  }
  if (withBrokenDep) {
    pkg.dependencies['@local/other-plugin'] = 'link:D:/somewhere/other'
    pkg.dsh.profile.bundles.push('@local/other-plugin')
  }
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n', 'utf8')

  const patch = [
    '# 原有配置（模拟用户机器上别的插件）',
    '- insert:',
    '  - id: other-plugin',
    '    name: "@local/other-plugin"',
    '    config:',
    '      hello: world',
    '',
  ].join('\n')
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), patch, 'utf8')

  return { root, profileDir, profileName, withBrokenDep }
}

/** 造一个假 DSH home 的临时目录，返回 {home, cleanup} */
export function makeTempFakeHome(prefix = 'esd-home-', opts = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const fake = makeFakeHome(path.join(tmp, 'dsh-home'), opts)
  return {
    ...fake,
    tmp,
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
  }
}
