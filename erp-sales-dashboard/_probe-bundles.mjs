// 临时探针：看原生安装后 DSH 怎么重建 profile 的 bundles 列表
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'esd-bundles-'))
const root = path.join(tmp, 'dsh-home')
const profileDir = path.join(root, 'profiles', 'desktop')
fs.mkdirSync(profileDir, { recursive: true })

const otherDir = path.join(root, 'other-plugin')
fs.mkdirSync(otherDir, { recursive: true })
fs.writeFileSync(path.join(otherDir, 'package.json'), JSON.stringify({
  name: '@local/other-plugin', version: '0.0.1', private: true,
}, null, 2) + '\n', 'utf8')

fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
  name: 'dsh-profile-desktop',
  private: true,
  dependencies: { '@local/other-plugin': 'link:../../other-plugin' },
  dsh: { profile: { bundles: ['@local/other-plugin'] } },
}, null, 2) + '\n', 'utf8')
fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), [
  '- insert:',
  '  - id: other-plugin',
  '    name: "@local/other-plugin"',
  '    config:',
  '      hello: world',
  '',
].join('\n'), 'utf8')

console.log('TMP =', tmp)
const res = spawnSync(process.execPath, [path.join(HERE, 'install.mjs'),
  '--dsh-home', root, '--profile', 'desktop',
  '--tgz', path.join(HERE, 'erp-sales-dashboard-1.4.0.tgz')], { encoding: 'utf8' })
console.log('EXIT =', res.status)
console.log((res.stdout || '').split('\n').filter((l) => /✔|✘|原生|回落/.test(l)).join('\n'))
console.log('--- profile package.json ---')
console.log(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
const nm = path.join(profileDir, 'node_modules', '@local')
console.log('--- node_modules/@local ---', fs.existsSync(nm) ? fs.readdirSync(nm) : '（没有）')
console.log('KEEP =', tmp)
