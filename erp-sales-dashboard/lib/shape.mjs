// ---------------------------------------------------------------------------
// 形状容错的数组提取：同一个字段在不同版本/不同来源里可能是
//   1) 直接的数组            [ {...}, {...} ]
//   2) 包了一层的对象        { rows: [...] } / { data: [...] } / { items: [...] } / { list: [...] }
//   3) 以 key 为索引的对象    { "erp": {...}, "std": {...} }
// 三种都要能取出「行数组」，否则安装核对会误报「没装」。
// ---------------------------------------------------------------------------

/**
 * 把任意形状的值提取成「行数组」。
 * @param {*} value
 * @param {string[]} wrapperKeys 常见的包装键名
 * @returns {Array}
 */
export function toRows(value, wrapperKeys = ['rows', 'data', 'items', 'list', 'records']) {
  if (value == null) return []
  if (Array.isArray(value)) return value
  if (typeof value !== 'object') return []
  for (const key of wrapperKeys) {
    if (Array.isArray(value[key])) return value[key]
  }
  // 以 key 为索引的对象 → 取它的值里那些像「行」的（对象）元素
  const values = Object.values(value)
  if (values.length && values.every((v) => v && typeof v === 'object' && !Array.isArray(v))) {
    return values
  }
  return []
}

/** 取对象的第一个非空数组字段（用于 tables 这种动态表名） */
export function pickTable(tables, names) {
  if (!tables || typeof tables !== 'object') return null
  for (const name of names) {
    if (tables[name] !== undefined) return tables[name]
  }
  return null
}
