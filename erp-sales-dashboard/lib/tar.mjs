// ---------------------------------------------------------------------------
// 极简 tar / tar.gz 读写（只用 node:zlib，无第三方依赖）
// ---------------------------------------------------------------------------
// 用途：GUI「添加插件」路线会用 npm pack 产出 .tgz，安装器要能解开它。
//
// 【为什么必须用 pax 扩展头】
//   POSIX ustar 头里没有编码字段。含非 ASCII（如中文）文件名的 ustar 条目，
//   在 Windows 上会被 bsdtar/libarchive 按**系统 ANSI 代码页**解释，
//   于是「数据口径与准确性保障说明.md」被解成乱码文件名
//   （实测：鏁版嵁鍙ｅ緞...md）。
//   pax（typeflag 'x'）的 path= 属性按规范就是 UTF-8，libarchive / GNU tar 都认。
//   所以：**文件名含非 ASCII 或超过 100 字节时，自动改用 pax 扩展头**。
//   这与 npm pack 的行为一致。
//
// 出于安全考虑：解包时拒绝绝对路径与含 '..' 的条目（防目录穿越）。
// ---------------------------------------------------------------------------

import zlib from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'

const BLOCK = 512

function padOctal(value, len) {
  const text = value.toString(8)
  return text.padStart(len - 1, '0') + '\0'
}

function writeString(buf, str, offset, len) {
  buf.write(str.slice(0, len - 1), offset, 'utf8')
}

/** 名字里是否含非 ASCII，或字节数超过 ustar 的 100 字节上限 */
function needsPax(name) {
  const buf = Buffer.from(name, 'utf8')
  if (buf.length > 100) return true
  for (const b of buf) if (b > 0x7f) return true
  return false
}

/**
 * 生成一条 pax 记录： "<len> <key>=<value>\n"
 * len 是整条记录的**字节数**（含 len 自身与换行）。
 */
function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`
  let len = Buffer.byteLength(body, 'utf8') + 1
  for (let i = 0; i < 10; i += 1) {
    const record = `${len}${body}`
    const actual = Buffer.byteLength(record, 'utf8')
    if (actual === len) return Buffer.from(record, 'utf8')
    len = actual
  }
  return Buffer.from(`${len}${body}`, 'utf8')
}

/**
 * 解析 pax 扩展头的内容，取出 path / size 等属性。
 * 必须按**字节**走：len 是字节数，而 path 的值是 UTF-8 多字节，
 * 按字符切会错位。
 */
function parsePaxRecords(buf) {
  const out = {}
  let pos = 0
  while (pos < buf.length) {
    let sp = -1
    for (let i = pos; i < buf.length; i += 1) {
      if (buf[i] === 0x20) { sp = i; break }
    }
    if (sp < 0) break
    const len = parseInt(buf.toString('ascii', pos, sp), 10)
    if (!Number.isFinite(len) || len <= 0 || pos + len > buf.length) break
    // 记录体是 "<len> key=value\n"，去掉末尾换行
    const record = buf.toString('utf8', sp + 1, pos + len - 1)
    const eq = record.indexOf('=')
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1)
    pos += len
  }
  return out
}

/** 写一条 ustar 头；typeflag 形如 '0' / '5' / 'x' */
function buildHeader({ name, size, typeflag = '0', date }) {
  const header = Buffer.alloc(BLOCK, 0)
  const nameBuf = Buffer.from(name, 'utf8')
  // ustar 的 name 字段只有 100 字节；pax 条目的实际名字放在扩展头里
  Buffer.from(name, 'utf8').copy(header, 0, 0, 100)
  header.write(padOctal(0o644, 8), 100, 'ascii') // mode
  header.write(padOctal(0, 8), 108, 'ascii') // uid
  header.write(padOctal(0, 8), 116, 'ascii') // gid
  header.write(padOctal(size, 12), 124, 'ascii') // size
  const d = date || new Date()
  header.write(padOctal(d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds(), 12), 136, 'ascii')
  header.write('        ', 148, 'ascii') // checksum 占位（算校验和时按 8 个空格算）
  header.write(typeflag, 156, 'ascii')
  header.write('ustar\0', 257, 'ascii')
  header.write('00', 263, 'ascii')

  let sum = 0
  for (const byte of header) sum += byte
  header.write(padOctal(sum, 8), 148, 'ascii')
  return header
}

/**
 * 生成 tar.gz。
 * @param {Array<{name:string, data:Buffer, date?:Date}>} entries
 * @returns {Buffer}
 */
export function createTarGz(entries) {
  const chunks = []
  for (const entry of entries) {
    const name = entry.name.replace(/\\/g, '/')
    const data = entry.data

    if (needsPax(name)) {
      // pax 扩展头：path= 用 UTF-8 原样写
      const pax = paxRecord('path', name)
      const base = path.posix.basename(name).replace(/[^\x20-\x7e]/g, '_') || 'entry'
      chunks.push(buildHeader({ name: `PaxHeader/${base}`.slice(0, 100), size: pax.length, typeflag: 'x', date: entry.date }))
      chunks.push(pax)
      const pad = (BLOCK - (pax.length % BLOCK)) % BLOCK
      if (pad > 0) chunks.push(Buffer.alloc(pad, 0))
      // 真实文件头：name 字段放截断后的名字，真正的路径由 pax 的 path 决定
      chunks.push(buildHeader({ name, size: data.length, typeflag: '0', date: entry.date }))
    } else {
      chunks.push(buildHeader({ name, size: data.length, typeflag: '0', date: entry.date }))
    }

    chunks.push(data)
    const pad = (BLOCK - (data.length % BLOCK)) % BLOCK
    if (pad > 0) chunks.push(Buffer.alloc(pad, 0))
  }
  chunks.push(Buffer.alloc(BLOCK * 2, 0)) // 结束标记
  return zlib.gzipSync(Buffer.concat(chunks), { level: 9 })
}

/** 判断 tar 条目名是否安全（拒绝绝对路径与 '..'） */
export function isSafeEntryName(name) {
  if (!name) return false
  const norm = name.replace(/\\/g, '/')
  if (norm.startsWith('/') || /^[A-Za-z]:/.test(norm)) return false
  return !norm.split('/').includes('..')
}

/**
 * 解开 tar.gz 到目标目录。支持 ustar、GNU long name('L')、pax('x'/'g')。
 * @param {Buffer} gzBuffer
 * @param {string} destDir
 * @returns {{files:number, bytes:number, names:string[]}}
 */
export function extractTarGz(gzBuffer, destDir) {
  const tar = zlib.gunzipSync(gzBuffer)
  let pos = 0
  let longName = null
  let paxAttrs = null
  let files = 0
  let bytes = 0
  const names = []

  while (pos + BLOCK <= tar.length) {
    const header = tar.subarray(pos, pos + BLOCK)
    if (header.every((b) => b === 0)) break
    let name = header.toString('utf8', 0, 100).replace(/\0.*$/, '')
    const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/, '')
    if (prefix) name = `${prefix}/${name}`
    const sizeText = header.toString('ascii', 124, 136).replace(/\0.*$/, '').trim()
    const size = sizeText ? parseInt(sizeText, 8) : 0
    const type = String.fromCharCode(header[156] || 0x30)
    pos += BLOCK

    if (type === 'L') {
      longName = tar.toString('utf8', pos, pos + size).replace(/\0.*$/, '')
      pos += Math.ceil(size / BLOCK) * BLOCK
      continue
    }
    if (type === 'x') {
      paxAttrs = parsePaxRecords(tar.subarray(pos, pos + size))
      pos += Math.ceil(size / BLOCK) * BLOCK
      continue
    }
    if (type === 'g') {
      pos += Math.ceil(size / BLOCK) * BLOCK
      continue
    }
    if (longName) { name = longName; longName = null }
    if (paxAttrs && paxAttrs.path) { name = paxAttrs.path; paxAttrs = null }

    if (!isSafeEntryName(name)) {
      throw new Error(`tar 条目路径不安全，已中止：${name}`)
    }
    const outPath = path.join(destDir, name)
    if (type === '5') {
      fs.mkdirSync(outPath, { recursive: true })
    } else if (type === '0' || type === '\0' || type === '') {
      fs.mkdirSync(path.dirname(outPath), { recursive: true })
      const data = Buffer.from(tar.subarray(pos, pos + size))
      fs.writeFileSync(outPath, data)
      files += 1
      bytes += data.length
      names.push(name)
    }
    pos += Math.ceil(size / BLOCK) * BLOCK
  }
  return { files, bytes, names }
}
