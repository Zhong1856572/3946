// ---------------------------------------------------------------------------
// 纯 Node 的 ZIP 写入器 / 读取器（只用 node:zlib，无第三方依赖）
// ---------------------------------------------------------------------------
// Node 没有内置 zip 写入器，这里按 ZIP 规范手写：
//   本地文件头(0x04034b50) → 文件数据 → 中央目录头(0x02014b50) → 中央目录结束(0x06054b50)
// 压缩方式用 deflate（method=8），配合 zlib.deflateRawSync。
// 文件名统一用 UTF-8（通用标志位 0x0800）。

import zlib from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c
  }
  return table
})()

/** 标准 CRC32 */
export function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function dosDateTime(date) {
  const d = date || new Date()
  const year = Math.max(1980, d.getFullYear())
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f)
  const day = (((year - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f)
  return { time, date: day }
}

/**
 * 生成 zip。
 * @param {Array<{name:string, data:Buffer, date?:Date}>} entries
 * @returns {Buffer}
 */
export function createZip(entries) {
  const chunks = []
  const central = []
  let offset = 0

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name.replace(/\\/g, '/'), 'utf8')
    const raw = entry.data
    const deflated = zlib.deflateRawSync(raw, { level: 9 })
    const useDeflate = deflated.length < raw.length
    const payload = useDeflate ? deflated : raw
    const method = useDeflate ? 8 : 0
    const crc = crc32(raw)
    const { time, date } = dosDateTime(entry.date)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // 通用标志：UTF-8 文件名
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28) // extra len

    chunks.push(local, nameBuf, payload)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4) // version made by
    cd.writeUInt16LE(20, 6) // version needed
    cd.writeUInt16LE(0x0800, 8)
    cd.writeUInt16LE(method, 10)
    cd.writeUInt16LE(time, 12)
    cd.writeUInt16LE(date, 14)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(payload.length, 20)
    cd.writeUInt32LE(raw.length, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt16LE(0, 30) // extra
    cd.writeUInt16LE(0, 32) // comment
    cd.writeUInt16LE(0, 34) // disk start
    cd.writeUInt16LE(0, 36) // internal attrs
    // external attrs：普通文件权限。`<< 16` 会溢出成负的 int32，必须 >>> 0 转回无符号
    cd.writeUInt32LE((0o100644 << 16) >>> 0, 38)
    cd.writeUInt32LE(offset, 42)
    central.push(cd, nameBuf)

    offset += local.length + nameBuf.length + payload.length
  }

  const centralBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...chunks, centralBuf, end])
}

/**
 * 读取 zip 的条目清单（只读中央目录，不解压）。
 * @param {Buffer} buf
 * @returns {Array<{name:string, size:number, compressedSize:number, crc:number, method:number}>}
 */
export function listZip(buf) {
  // 从尾部找 EOCD
  let eocd = -1
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65535; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('不是合法的 zip 文件：找不到中央目录结束记录')
  const count = buf.readUInt16LE(eocd + 10)
  let ptr = buf.readUInt32LE(eocd + 16)
  const out = []
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) throw new Error('中央目录损坏')
    const method = buf.readUInt16LE(ptr + 10)
    const crc = buf.readUInt32LE(ptr + 16)
    const compressedSize = buf.readUInt32LE(ptr + 20)
    const size = buf.readUInt32LE(ptr + 24)
    const nameLen = buf.readUInt16LE(ptr + 28)
    const extraLen = buf.readUInt16LE(ptr + 30)
    const commentLen = buf.readUInt16LE(ptr + 32)
    const localOffset = buf.readUInt32LE(ptr + 42)
    const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen)
    out.push({ name, size, compressedSize, crc, method, localOffset })
    ptr += 46 + nameLen + extraLen + commentLen
  }
  return out
}

/**
 * 从 zip 中解出某个条目（按名字精确匹配）。
 * @param {Buffer} buf
 * @param {string} name
 * @returns {Buffer|null}
 */
export function readZipEntry(buf, name) {
  const list = listZip(buf)
  const hit = list.find((e) => e.name === name)
  if (!hit) return null
  const lh = hit.localOffset
  if (buf.readUInt32LE(lh) !== 0x04034b50) throw new Error('本地文件头损坏')
  const nameLen = buf.readUInt16LE(lh + 26)
  const extraLen = buf.readUInt16LE(lh + 28)
  const start = lh + 30 + nameLen + extraLen
  const payload = buf.subarray(start, start + hit.compressedSize)
  return hit.method === 8 ? zlib.inflateRawSync(payload) : Buffer.from(payload)
}

/**
 * 把整个 zip 解到目标目录。
 * 与 tar 一样拒绝绝对路径与 '..'（防目录穿越）。
 * @param {Buffer} buf
 * @param {string} destDir
 * @returns {{files:number, bytes:number, names:string[]}}
 */
export function extractZip(buf, destDir) {
  const list = listZip(buf)
  let files = 0
  let bytes = 0
  const names = []
  for (const entry of list) {
    const norm = entry.name.replace(/\\/g, '/')
    if (norm.startsWith('/') || /^[A-Za-z]:/.test(norm) || norm.split('/').includes('..')) {
      throw new Error(`zip 条目路径不安全，已中止：${entry.name}`)
    }
    const data = readZipEntry(buf, entry.name)
    if (!data) continue
    const outPath = path.join(destDir, norm)
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, data)
    files += 1
    bytes += data.length
    names.push(norm)
  }
  return { files, bytes, names }
}
