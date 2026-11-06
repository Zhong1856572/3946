// ---------------------------------------------------------------------------
// 插件安装的默认配置（唯一真相源）
// ---------------------------------------------------------------------------
// 这里的每个键都与 bundle 自身的 cordis.patch.yml 一一对应；
// bundle 的 cordis.patch.yml 是「插件作者视角的插入声明」，
// 本文件是「安装器写进 profile 补丁层时的默认值」。
// 二者必须保持一致：安装器不改 bundle，只负责把同样的值写进用户 profile。

export const PLUGIN_ID = 'erp-sales-dashboard'
/** npm 包名（profile dependencies 与 dsh.profile.bundles 里登记的名字） */
export const PLUGIN_PKG_NAME = '@local/erp-sales-dashboard'
/** 插件 id（profile cordis.patch.yml 里 - id: 的值） */
export const PLUGIN_VERSION = '1.4.0'
export const PLUGIN_DISPLAY_NAME = 'ERP 销售仪表盘'

/** 预警阈值允许被 --config 覆盖的键名（口径与方案 01「三大能力」一致） */
export const THRESHOLD_KEYS = ['stdShare', 'bShare', 'cShare', 'collectionRate', 'growthDrop']

/** 默认配置（按写入顺序） */
export const DEFAULT_CONFIG = {
  cacheTtlMs: 21600000,
  requestTimeoutMs: 30000,
  rowLimit: 100,
  stdProbeBudget: 24,
  tierSampleSize: 12,
  customerSampleSize: 12,
  visitSampleSize: 10,
  exhaustiveBudget: 120,
  stdProbeBudgetMs: 210000,
  detailBudget: 40,
  geoBudgetMs: 300000,
  geoMaxRequests: 300,
  salesFirstDepName: '业务咨询事业群',
  newbieTargetAmount: 200000,
  thresholds: {
    stdShare: 0.6,
    bShare: 0.4,
    cShare: 0.15,
    collectionRate: 0.9,
    growthDrop: 0.2,
  },
  aiProvider: 'minimax-cn',
  aiModel: 'MiniMax-M3.1-Flash',
  /**
   * MCP 工具名前缀（= DSH 连接器名）。空对象 = 自动发现。
   * 插件启动时读 <DSH_HOME>/storages/mcp_connector.json，按 url 端口认领连接器
   * （8001=erp / 8006=std / 8003=planning），换设备不用改这里。
   */
  toolPrefixes: {},
}

/** 每个配置键的中文说明（写进 profile 补丁层，让装机的人看得懂） */
export const CONFIG_COMMENTS = {
  cacheTtlMs: [
    '# 缓存有效期（毫秒）。21600000 = 6 小时：首屏打开不重复调取上游，',
    '# 同一组筛选条件在 6 小时内直接命中缓存。',
  ],
  stdProbeBudgetMs: [
    '# STD 判定探测的墙钟预算（毫秒）。上游 std MCP 单 session 串行、单条 6~8 秒，',
    '# 探测必须串行，这个预算是整段封顶（210 秒 = 3.5 分钟）。',
  ],
  detailBudget: [
    '# 明细路由（客户档案 / 业务员档案）的上游调用预算（次数）。',
  ],
  geoBudgetMs: [
    '# 客户地理分布路由的墙钟预算（毫秒）。扫描客户档案 + 分月取订单，',
    '# 超预算就如实写告警并标记截断，不假装全量。',
  ],
  geoMaxRequests: [
    '# 客户地理分布路由的最大上游调用次数。',
  ],
  salesFirstDepName: [
    '# 销售序列在花名册里的顶层事业群名；新兵表只统计这个事业群的成员。',
  ],
  newbieTargetAmount: [
    '# 新兵转正业绩门槛（元）。方案模板参数，ERP 没有对应字段。',
  ],
  thresholds: [
    '# 智能预警阈值（红黄绿三色 + 自定义阈值）。只写要改的键即可；',
    '# 数值一律 0~1 的比率；非法值自动回退默认。',
    '# 方向：stdShare / bShare / collectionRate 越高越好；cShare 越低越好；growthDrop 是降幅红线。',
  ],
  aiProvider: [
    '# AI 对话模型；留空则由插件按「agentDefaultModel 当前选择 → minimax → 其它」兜底。',
  ],
  toolPrefixes: [
    '# MCP 工具名前缀（= DSH 连接器名）。留空 = 自动发现：插件启动时读 DSH 连接器',
    '# 注册表按 url 端口认领（8001=erp / 8006=std / 8003=planning），换设备不用改这里。',
    '# 只有当本机连接器既不是默认名、端口也不是默认端口时才需要显式写，例如：',
    '#   toolPrefixes:',
    '#     erp: mcp__erp-cn__',
  ],
}

/** 顶层可被 --config 覆盖的标量键（thresholds 之外的） */
export const TOPLEVEL_CONFIG_KEYS = [
  'cacheTtlMs',
  'requestTimeoutMs',
  'rowLimit',
  'stdProbeBudget',
  'tierSampleSize',
  'customerSampleSize',
  'visitSampleSize',
  'exhaustiveBudget',
  'stdProbeBudgetMs',
  'detailBudget',
  'geoBudgetMs',
  'geoMaxRequests',
  'salesFirstDepName',
  'newbieTargetAmount',
  'aiProvider',
  'aiModel',
]

/**
 * 对象型配置键（值是一个映射，不是标量）。
 * --config 用「点号路径」覆盖：--config toolPrefixes.erp=mcp__erp-cn__
 */
export const OBJECT_CONFIG_KEYS = ['toolPrefixes']

/** toolPrefixes 允许的分组（与插件运行时 PREFIX_GROUPS 一致） */
export const TOOL_PREFIX_GROUPS = ['erp', 'std', 'planning']

/** --config 允许的全部键（含对象型键的点号子键） */
export const ALL_CONFIG_KEYS = [
  ...TOPLEVEL_CONFIG_KEYS,
  ...THRESHOLD_KEYS,
  ...OBJECT_CONFIG_KEYS,
  ...TOOL_PREFIX_GROUPS.map((g) => `toolPrefixes.${g}`),
]

/**
 * 把 --config 覆盖合并进默认配置。
 * @param {object} overrides 形如 { stdShare: 0.65, aiModel: 'xxx', 'toolPrefixes.erp': 'mcp__erp-cn__' }
 * @returns {object} 新的配置对象（深拷贝）
 */
export function applyConfigOverrides(overrides = {}) {
  const config = {
    ...DEFAULT_CONFIG,
    thresholds: { ...DEFAULT_CONFIG.thresholds },
    toolPrefixes: { ...DEFAULT_CONFIG.toolPrefixes },
  }
  for (const [rawKey, raw] of Object.entries(overrides)) {
    // thresholds.xxx 与 xxx 两种写法都认
    const key = rawKey.startsWith('thresholds.') ? rawKey.slice('thresholds.'.length) : rawKey
    if (key.startsWith('toolPrefixes.')) {
      const group = key.slice('toolPrefixes.'.length)
      if (!TOOL_PREFIX_GROUPS.includes(group)) {
        const err = new Error(`toolPrefixes 不认识的分组：${group}（可用：${TOOL_PREFIX_GROUPS.join(' / ')}）`)
        err.exitCode = 2
        throw err
      }
      config.toolPrefixes[group] = coerceScalar(raw)
      continue
    }
    if (OBJECT_CONFIG_KEYS.includes(key)) {
      const err = new Error(`--config 不能直接写 ${key}（它是对象型配置），请用点号写法，例如 --config ${key}.erp=mcp__erp-cn__`)
      err.exitCode = 2
      throw err
    }
    if (!ALL_CONFIG_KEYS.includes(key)) {
      const err = new Error(`未知的配置键：${key}（可用键：${ALL_CONFIG_KEYS.join(' / ')}）`)
      err.exitCode = 2
      throw err
    }
    const value = coerceScalar(raw)
    if (THRESHOLD_KEYS.includes(key)) config.thresholds[key] = value
    else config[key] = value
  }
  return config
}

/** 两个配置值是否等价（对象型按内容比，不看引用） */
export function configValueEquals(a, b) {
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).sort()
    const kb = Object.keys(b).sort()
    if (ka.length !== kb.length) return false
    return ka.every((k, i) => kb[i] === k && a[k] === b[k])
  }
  if (a === b) return true
  // 一边是数字/布尔、另一边是同义的字符串（--config 传进来的都是字符串）→ 按值比
  if (typeof a === 'number' || typeof a === 'boolean' || typeof b === 'number' || typeof b === 'boolean') {
    if (a === null || a === undefined || b === null || b === undefined) return false
    return coerceScalar(a) === coerceScalar(b)
  }
  return false
}

/** 把字符串标量转成 number / boolean / string */
export function coerceScalar(raw) {
  if (typeof raw === 'number' || typeof raw === 'boolean') return raw
  const text = String(raw).trim()
  if (text === 'true') return true
  if (text === 'false') return false
  if (text !== '' && /^-?\d+(\.\d+)?$/.test(text)) return Number(text)
  return text
}

/** YAML 标量序列化：能安全裸写就裸写，否则单引号 */
export function formatYamlScalar(value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : `'${String(value)}'`
  }
  const text = String(value)
  if (text === '') return "''"
  if (/^(true|false|null|yes|no|on|off|~)$/i.test(text)) return `'${text}'`
  if (/^\s|\s$/.test(text)) return `'${text.replace(/'/g, "''")}'`
  if (text.includes('\n')) return `'${text.replace(/'/g, '').replace(/\n/g, ' ')}'`
  // 冒号后带空格、井号、逗号等 YAML 敏感符号 → 走引号
  if (/:(\s|$)/.test(text) || /[#{}\[\],&*!|>'"%@`]/.test(text)) {
    return `'${text.replace(/'/g, "''")}'`
  }
  return text
}
