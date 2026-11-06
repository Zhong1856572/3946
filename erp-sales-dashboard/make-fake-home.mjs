#!/usr/bin/env node
// ---------------------------------------------------------------------------
// make-fake-home.mjs —— 造一个假 DSH home，给手工调试/演示用
// ---------------------------------------------------------------------------
// 用法：
//   node make-fake-home.mjs                 # 打印假 home 路径（临时目录）
//   node make-fake-home.mjs --dir <目录>     # 造到指定目录
//   node make-fake-home.mjs --broken-dep    # 塞一个指向不存在目录的依赖（复现原生安装失败）
//   node make-fake-home.mjs --keep          # 不自动清理（配合 --dir 使用）
//
// 输出的路径直接喂给安装器：
//   node install.mjs --dsh-home <上面打印的路径> --profile desktop
// ---------------------------------------------------------------------------

import path from 'node:path'
import { makeTempFakeHome, makeFakeHome } from './lib/fake-home.mjs'
import { parseArgs } from './lib/cli.mjs'

const args = parseArgs(process.argv.slice(2))

if (args.help) {
  console.log(`
用法：
  node make-fake-home.mjs [--dir <目录>] [--broken-dep] [--keep]

  --dir <目录>      把假 home 造到指定目录（默认用系统临时目录）
  --broken-dep      额外塞一个 link: 到不存在目录的依赖，
                    用来复现「DSH 原生命令因其它插件装不上而整体失败」
  --keep            造完不打印清理提示
`)
  process.exit(0)
}

const withBrokenDep = args['broken-dep'] === true || args['broken-dep'] === 'true'

if (typeof args.dir === 'string' && args.dir) {
  const root = path.resolve(args.dir)
  const fake = makeFakeHome(root, { withBrokenDep })
  console.log(fake.root)
  process.exit(0)
}

const fake = makeTempFakeHome('esd-fake-', { withBrokenDep })
console.log(fake.root)
if (args.keep !== true && args.keep !== 'true') {
  console.error(`（profile 目录：${fake.profileDir}）`)
  console.error(`（临时目录，调试完可删：${fake.tmp}）`)
}
