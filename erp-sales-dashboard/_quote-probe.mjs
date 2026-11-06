import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const d = fs.mkdtempSync(path.join(os.tmpdir(), 'quote-probe-'))
const dir = path.join(d, '带 空格的目录')
fs.mkdirSync(dir, { recursive: true })
const cmd = path.join(dir, 'echo args.cmd')
fs.writeFileSync(cmd, '@echo off\r\necho ARG1=[%1] ARG2=[%2] ARG3=[%3]\r\n', 'ascii')

const full = ['plugin', '--profile', 'desktop', 'add', `file:${cmd} x.tgz`]
const quote = (s) => `"${String(s).replace(/"/g, '""')}"`

function run(label, args, opts) {
  const r = spawnSync(process.env.ComSpec || 'cmd.exe', args, { encoding: 'utf8', ...opts })
  console.log(`${label}:`)
  console.log('  code=', r.status)
  console.log('  out =', JSON.stringify(`${r.stdout || ''}${r.stderr || ''}`))
}

// A：Node 默认转义 + /s（当前实现）
run('A 默认参数转义 / 无外壳引号', ['/d', '/s', '/c', [quote(cmd), ...full.map(quote)].join(' ')], {})

// B：verbatim + 外壳再包一层
run('B verbatim + 外壳引号', ['/d', '/s', '/c', `"${[quote(cmd), ...full.map(quote)].join(' ')}"`], { windowsVerbatimArguments: true })

// C：verbatim + 无外壳引号
run('C verbatim + 无外壳引号', ['/d', '/s', '/c', [quote(cmd), ...full.map(quote)].join(' ')], { windowsVerbatimArguments: true })

// D：shell:true + 手工引号
run('D shell:true + 手工引号', [quote(cmd), ...full.map(quote)].join(' '), { shell: true })

fs.rmSync(d, { recursive: true, force: true })
