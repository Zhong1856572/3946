/**
 * @local/erp-sales-dashboard — Host 半（Node / 服务端侧数据服务层）
 * ============================================================================
 *
 * 一、插件定位
 * ---------------------------------------------------------------------------
 * 给**销售线**（业绩 / 客户 / 回款 / 获客 / 成长）看的 ERP 经营作战看板。
 * 全部数据来自 ERP（mcp__erp__*）与 STD（mcp__std__*）的**只读** MCP 工具，
 * 不落任何假数据、不做模拟兜底。
 *
 * 本文件只负责「取数 + 口径 + 缓存 + 降级」；前端渲染在 client.js（另一位同事负责）。
 * 两半的唯一接口契约是同目录的 CONTRACT.md，响应字段名必须一字不差。
 *
 * 二、与 @local/erp-dashboard（ERP 业务工作台）的差异
 * ---------------------------------------------------------------------------
 *   维度            erp-dashboard（业务工作台）        erp-sales-dashboard（本插件）
 *   视角            统筹 / 产品中心                    销售线（业绩/客户/回款/获客/成长）
 *   板块            业务总览/统筹/产品/绩效/风险/货号   业绩总览/订单质量/回款售后/客户激活/
 *                                                 获客转化/学习成长/订单待办
 *   主工具          mcp__std__* 为主                    mcp__erp__* 为主 + mcp__std__* 辅助
 *   核心口径        统筹/到货/库存                      军令状完成率、ABC 抽样、STD 占比、
 *                                                 账龄分桶、梯队效能、跟进达标率
 *   缓存/降级       6 小时缓存 + 分片读取               6 小时缓存 + 调用预算 + 抽样降级
 *
 *   架构上**刻意复用**它的工程约定（apply(ctx, config) + DEFAULTS + ctx.tools.execute
 *   + webServer.register({kind:'prefix'}) + Promise.allSettled + 磁盘缓存 + PII 扫描），
 *   以便两半行为一致、后续维护成本最低。
 *
 * 三、数据口径铁律（CONTRACT.md §6，两半都必须遵守）
 * ---------------------------------------------------------------------------
 *   1. 比率一律 0~1 小数（前端负责 ×100），金额一律「元」。
 *   2. 取不到就 null + note，绝不用 0 冒充、绝不编造、绝不用模拟数据兜底。
 *   3. 完成率**自算**：区间签约额 ÷ 军令状年度目标（分子分母同源）。
 *      **禁止**直接用上游 signing_completion_rate（它分母是年度目标、分子随区间变化）。
 *   4. 上游两套「业绩」字段不可混用：
 *      total_performance_analysis.order_total_amount（接单额）
 *      vs sales_performance_ranking.signing_amount（签约额）。
 *      同一张图里必须标注用了哪一套（本文件用 sub / label / matrix 标注）。
 *   5. STD 判定：std_product_info_query(page_type=1, code=X) 的返回里 **code 精确等于 X**
 *      才算 STD（上游 code 过滤是前缀/LIKE 匹配，会多返回更长的货号）。
 *   6. ERP 没有的能力要如实标注（线索渠道归因、订单级 ABC、订单级货号、培训数据），
 *      在 matrix[] 里登记并给出「不可得」的替代口径或空态说明。
 *   7. 部分源失败不整体 reject：单个工具失败 → 该板块降级 + warnings + calls[].ok=false。
 *   8. 不落盘 PII：客户 360 的 visits 只在内存里用，落盘前扫描手机号/身份证模式，
 *      命中就整份不落盘。
 *
 * 四、底线：宁可承认不完整，也不给「看起来完整其实缺数据」的结果
 * ---------------------------------------------------------------------------
 *   这是本插件的第一原则，落地为下面几条硬规矩：
 *     · 上游 limit 截断 → 在 matrix 的 result 里写明「受 limit=N 截断」，
 *       绝不把已读条数当成全量；
 *     · 抽样指标（ABC / 赛道 / 跟进达标）→ status 明确写 sampled，
 *       并给出 sampleCustomers / coverageShare，绝不外推成全量结论；
 *     · 上游没暴露的指标（如 C 类订单占比、渠道归因、培训场次）→ value=null，
 *       宁可少画一张图，也不画一张编出来的图；
 *     · 有 warnings 的结果**不入缓存**（半成品不固化），并在 meta.cacheNote 说明；
 *     · 调用预算触顶 → 明确写「仅覆盖 Top N 客户」的中文告警，而不是悄悄少取。
 *
 * 五、Client → Host 调用约定（同源 HTTP）
 * ---------------------------------------------------------------------------
 *   POST /erp-sales-dashboard/api/dashboard
 *     body: { startDate, endDate, squad?, member?, refresh? }
 *     → 200 { ok:true, ...payload }；参数错误 200 { ok:false, error }；内部错误 500。
 *   POST /erp-sales-dashboard/api/beacon
 *     body: { stage, extra? } → 200 { ok:true }（客户端启动阶段诊断探针）。
 *   POST /erp-sales-dashboard/api/ai.chat
 *     body: { payload: { title, aiContext }, messages: [{role, content}], question }
 *     → 200 { ok:true, text, model, failures }。
 *     AI 只做**解读**：模型能看到的数据就是本插件算出来的那份载荷，
 *     它答不出的口径就是真答不出（与「宁可承认不完整」的底线一致）。
 *   POST /erp-sales-dashboard/api/customer.dashboard
 *     body: { name | customerCode | customerPk, startDate, endDate, refresh? }
 *     → 200 { ok:true, period, generatedAt, resolved, profile, periodMetrics, lifetime,
 *             rating, lifecycle, benchmark, orders, notes, warnings, calls }。
 *     **这三条新路由的返回体统一用 camelCase**（与业务工作台原样一致，便于前端直接移植）；
 *     既有主 payload 仍是 snake_case —— 两套不要混用。
 *     periodMetrics = **所选区间口径**，lifetime = **全周期口径**，rating = **近 12 个月口径**，
 *     benchmark = **区间总盘口径**，四者在 notes 里逐条写清不许混。
 *     未回款口径**分两层**（主 KPI 与明细不是一个口径，notes 里逐条写清）：
 *       · 主 KPI / collection 数据卡：uncollectedAmount = ERP overview 上游值
 *         （与业务工作台《作战看板》一致，用户核对的是它）；
 *       · 账龄、逾期明细、客户档案订单、业务员档案订单：按「签约额 − 已回款额」归一
 *         （上游把部分回款按全额计入，订单级确实虚高）；
 *       · 归一值另存 uncollectedAmountNormalized，上游原值另存 uncollectedAmountUpstream，
 *         差额写进 uncollectedNote（前端在数字旁边就能看到口径，不会同名两个数却没人交代）。
 *   POST /erp-sales-dashboard/api/member.dashboard
 *     body: { memberId | memberName, startDate, endDate, refresh? }
 *     → 200 { ok:true, period, generatedAt, resolved, profile, periodMetrics, target,
 *             benchmark, collection, recentOrders, notes, warnings, calls }。
 *     target 是**年度口径**（年度至今业绩 ÷ 年度军令状目标，允许 >100% 不 clamp），
 *     与 periodMetrics 的区间口径不是一回事，notes 里写明。
 *   POST /erp-sales-dashboard/api/customer.geo
 *     body: { startDate, endDate, scope: 'period' | 'all', refresh? }
 *     → 200 { ok:true, scope, range, generatedAt, summary, provinces, customers,
 *             uncovered, overseas, warnings, completeness, meta }。
 *     省份**只从信用代码/地址/地级市/区域名**四条路径判定，绝不从公司名猜；
 *     地址、信用代码、电话、银行账号一律不下发、不落盘；覆盖不全必须写进 warnings。
 *     provinces[].customerNames 只给前 20 个（customerCount 仍是全量），
 *     完整客户明细统一走 customers[] —— 实机整份 payload 212KB，一半以上是客户名清单。
 *     区间订单按自然月分片读，每片 limit 500（**上游硬顶 500 行，limit 传多大都只给 500 行**）；
 *     判截断不看「行数 == limit」（那个判据永远成立、拆不开），而是看**同一次响应里的
 *     overview.order_count**（该窗口自己的订单总数）：行数 < overview.order_count 即被截断，
 *     就按日期对半细分重查（最多 2 轮），细分调用计入 geoMaxRequests 预算。
 *     三条明细路由各自 6 小时**内存**缓存（key 带参数，refresh=true 跳过），**一律不落盘** ——
 *     客户档案主数据里有 PII，落盘等于把 PII 明文写到磁盘上。
 *
 * 六、为什么**不导出 Config**
 * ---------------------------------------------------------------------------
 *   本框架会对 `export const Config` 调用 `Config.validate(...)`，而 schemastery 的
 *   z.object(...) 并不提供该方法 → 激活期抛 "Cannot read properties of undefined
 *   (reading 'validate')"，插件直接起不来。故改为导出 `DEFAULTS`，
 *   在 apply(ctx, config) 里与 patch 行传入的 config 合并。
 *
 * 只用 Node 内置模块（fs / path / crypto / url），不引任何第三方依赖。
 * ============================================================================
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

// webServer 是硬依赖：没有它就无法把数据送给浏览器端，插件也就没有意义。
export const inject = ['tools', 'webServer']

/**
 * 用户可调参数（patch 行的 config 会覆盖同名字段）。
 */
export const DEFAULTS = {
  /** 聚合结果缓存时长（毫秒）；6 小时 = 21600000。0 表示不缓存。 */
  cacheTtlMs: 21600000,
  /** 单次 MCP 工具调用超时（毫秒）。 */
  requestTimeoutMs: 30000,
  /** 各列表型数据源的记录条数上限（上游无 offset，翻不了页，故为硬上限）。 */
  rowLimit: 100,
  /**
   * STD 判定探测的货号数量上限（签单额降序 Top N）。
   * 2026-11-04 起口径改为**签单金额**：探测对象不再是「报价明细里的货号」，
   * 而是「出库明细里出现过、并按其订单签单额分摊过金额的货号」。
   */
  stdProbeBudget: 150,
  /**
   * STD 判定探测的**墙钟预算**（毫秒）。
   * 上游 std MCP 服务单 session 内串行处理、单条查询 6~8 秒，
   * 所以探测必须串行；本预算给整个探测阶段封顶，超时的货号按「未知」处理。
   * 命中本地货号判定缓存（std-goods-verdicts.json，90 天）的货号不消耗预算。
   */
  stdProbeBudgetMs: 90000,
  /**
   * 签单口径 STD 占比要回看的月份数上限（从区间末月往前数）。
   * 为什么不是整段区间：出库明细单次硬顶 500 行（一个月就 700+），
   * 要覆盖 10 个月得 20 次调用、近两分钟 —— 首屏扛不住，故按「近 N 个月」算，
   * 并在 payload 里如实给出覆盖到的窗口与它占区间签单额的比例。
   */
  stdSigningMonthsMax: 4,
  /** 出库明细取数的墙钟预算（毫秒）。到点就停手，已取到的部分照样算。 */
  stdSigningShipBudgetMs: 45000,
  /** 客户分档（S/A/B/C）抽样客户数。 */
  tierSampleSize: 12,
  /** 客户基础档案（customer_kind）抽样客户数。 */
  customerSampleSize: 12,
  /** 客户 360（跟进记录）抽样客户数。 */
  visitSampleSize: 10,
  /** 单次仪表盘渲染的 MCP 调用总预算。触顶即降级并写中文告警。 */
  exhaustiveBudget: 120,
  /**
   * 明细路由（customer.dashboard / member.dashboard）的上游调用预算。
   * 客户详情最多要「档案 + 360 + 分档 + 订单 + 对标分档」十几次调用，
   * 给个硬上限，超了就如实告警而不是无限打上游。
   */
  detailBudget: 40,
  /**
   * 客户地理分布路由（customer.geo）的**墙钟预算**（毫秒）。
   * 地理路由要自举扫描全部客户档案（按业务员分区，每区上游硬钳 500 条），
   * 天然是慢操作；预算一到就停手，把已扫到的部分交出去，
   * 并在 warnings 里写清「扫了多少分区、覆盖多少家」——
   * 宁可覆盖不全也要如实说，绝不假装是全量地图。
   */
  geoBudgetMs: 300000,
  /**
   * 客户地理分布路由的最大上游调用次数（自举扫描 + 订单分片）。
   * 2026-11-03 实机验证：120 上限在真实数据上**被吃光**（实际 136 次请求，
   * 告警「调用预算已达上限，客户档案补查未执行」）→ 一批客户根本没补查到档案，
   * 地图缺块却看不出是缺在哪儿。故提到 300；墙钟预算同步提到 300000。
   */
  geoMaxRequests: 300,
  /**
   * 销售序列在员工花名册里的顶层事业群名（2026-10-26 用户诉求：
   * 「统计新兵业绩，只取业务咨询事业群成员，也就是销售人员」）。
   * staff_info 里销售成员的 first_dep_name 就是这个值；非销售成员不是。
   */
  salesFirstDepName: '业务咨询事业群',
  /** 新兵转正业绩门槛（元）；方案模板参数，ERP 无对应字段。 */
  newbieTargetAmount: 200000,
  /**
   * 智能预警阈值覆盖（方案 01 三大能力之二：红黄绿三色 + 自定义预警阈值）。
   * 留空 / 不给键 = 用 THRESHOLD_DEFAULTS；
   * 只给部分键 = 其余保持默认；非法值（NaN / 越界 0~1）自动回退默认。
   * 例：{ stdShare: 0.55, collectionRate: 0.85, growthDrop: 0.15 }
   */
  thresholds: {},
  /**
   * MCP 工具名前缀（连接器名）覆盖：{ erp: 'mcp__erp__', std: 'mcp__std__', planning: 'mcp__planning__' }。
   *
   * 为什么需要它：DSH 的工具全名 = `mcp__<连接器 serverName>__<工具名>`，
   * 而连接器名是**每台设备自己起的**（本机叫 erp / std / planning，
   * 别的机器可能叫 erp-cn / my-erp）—— 前缀写死就整片「工具不可见」。
   *
   * 留空 = 运行时自动发现：读 DSH 的 MCP 连接器注册表
   *   <DSH_HOME>/storages/mcp_connector.json
   * 用 url 里的端口对上服务（8001=erp / 8006=std / 8003=planning），
   * 得出该设备真实的连接器名。发现顺序：
   *   用户配置 > 注册表按端口 > 注册表按连接器名 > 内置默认。
   */
  toolPrefixes: {},
  /**
   * AI 对话使用的模型：
   *   aiProvider / aiModel 留空时，由 collectCandidates 按
   *   「agentDefaultModel 当前选择 → minimax provider 首个模型 → 其它 provider 首个模型」兜底，
   *   所以 cordis.patch.yml 不配也能跑（默认会落到 minimax-cn/MiniMax-M3.1-Flash）。
   */
  aiProvider: null,
  aiModel: null,
}

// ---------------------------------------------------------------------------
// 工具名常量 —— 必须写全（mcp__erp__total_performance_analysis），
// 缩写（如 mcp__erp__total_performance）会命中不到。
// ---------------------------------------------------------------------------
const TOOL = {
  total: 'mcp__erp__total_performance_analysis',
  ranking: 'mcp__erp__sales_performance_ranking',
  member: 'mcp__erp__member_performance_analysis',
  collection: 'mcp__erp__sales_order_collection_analysis',
  customer: 'mcp__erp__customer_analysis',
  tier: 'mcp__erp__customer_tier_rating',
  c360: 'mcp__erp__sales_customer_360',
  customerInfo: 'mcp__erp__customer_info',
  customerSearch: 'mcp__erp__sales_customer_search',
  person360: 'mcp__erp__sales_person_360',
  quotation: 'mcp__erp__quotation_query',
  inquiry: 'mcp__erp__inquiry_plan_query',
  afterSale: 'mcp__std__after_sale_management_query',
  stdProduct: 'mcp__std__std_product_info_query',
  shipping: 'mcp__std__product_efficiency_analysis',
  performance: 'mcp__std__performance_assessment',
  staff: 'mcp__std__staff_info',
}

// ---------------------------------------------------------------------------
// MCP 工具名前缀：可配置 + 运行时自动发现（换设备不掉数据的关键）
// ---------------------------------------------------------------------------
/**
 * 每个工具属于哪个连接器分组（分组决定用哪个前缀）。
 * 与上面的 TOOL 常量一一对应；short 名由 TOOL 常量去掉默认前缀得到，
 * 这样**默认全名只在 TOOL 一处出现**（安装器扫包核对工具清单时依赖这一点）。
 */
const TOOL_GROUP = {
  total: 'erp',
  ranking: 'erp',
  member: 'erp',
  collection: 'erp',
  customer: 'erp',
  tier: 'erp',
  c360: 'erp',
  customerInfo: 'erp',
  customerSearch: 'erp',
  person360: 'erp',
  quotation: 'erp',
  inquiry: 'erp',
  afterSale: 'std',
  stdProduct: 'std',
  shipping: 'std',
  performance: 'std',
  staff: 'std',
}

/** 连接器分组定义：默认前缀 + 该服务的默认端口（用来在注册表里认领连接器）。 */
const PREFIX_GROUPS = {
  erp: { label: 'ERP 销售主数据', defaultPrefix: 'mcp__erp__', defaultPort: 8001, optional: false },
  std: { label: 'STD / 人事 / 售后', defaultPrefix: 'mcp__std__', defaultPort: 8006, optional: false },
  planning: { label: 'ERP 统筹（可选）', defaultPrefix: 'mcp__planning__', defaultPort: 8003, optional: true },
}

/** 从 url 里取端口（认领连接器用）。 */
function portOfUrl(url) {
  const matched = /:\d{2,5}(?:\/|$)/.exec(String(url || ''))
  if (!matched) return null
  const port = Number(String(matched[0]).replace(/[^\d]/g, ''))
  return Number.isFinite(port) && port > 0 ? port : null
}

/** 归一化用户写的前缀：必须是 mcp__xxx__ 形态，否则视为无效（回退默认）。 */
function normalizeToolPrefix(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return ''
  if (!text.startsWith('mcp__')) return ''
  return text.endsWith('__') ? text : `${text}__`
}

/**
 * DSH HOME 候选根目录（按可信度排序）。
 * DSH_PROFILE_DIR 通常是 <home>/profiles/<name>，据此上溯两级就是 home。
 */
function dshHomeCandidates() {
  const out = []
  const push = (value) => {
    if (!value) return
    const text = String(value)
    if (text && !out.includes(text)) out.push(text)
  }
  push(process.env.DSH_HOME ? String(process.env.DSH_HOME) : '')
  const profileDir = process.env.DSH_PROFILE_DIR ? String(process.env.DSH_PROFILE_DIR) : ''
  if (profileDir) {
    const parent = path.dirname(profileDir)
    if (path.basename(parent).toLowerCase() === 'profiles') push(path.dirname(parent))
    else push(parent)
  }
  try {
    push(path.join(os.homedir(), '.dsh'))
  } catch {
    /* 取不到 home 就跳过 */
  }
  try {
    let dir = path.dirname(fileURLToPath(import.meta.url))
    for (let i = 0; i < 8; i += 1) {
      const parent = path.dirname(dir)
      if (!parent || parent === dir) break
      dir = parent
      // 只认明显像 DSH 家目录的祖先（.dsh / profiles），避免在别的机器上
      // 误扫到无关目录里的同名 storages/mcp_connector.json。
      const base = path.basename(dir).toLowerCase()
      if (base === '.dsh' || base === 'profiles') push(dir)
    }
  } catch {
    /* 取不到插件自身位置就跳过 */
  }
  return out
}

/**
 * 读 DSH 的 MCP 连接器注册表。
 * 只取 serverName / url / enabled —— **绝不读 auth.apiKeyValue**，避免凭据外泄。
 */
function readMcpConnectors(roots) {
  const found = []
  for (const root of roots) {
    const file = path.join(root, 'storages', 'mcp_connector.json')
    let raw = ''
    try {
      raw = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    let parsed = null
    try {
      parsed = JSON.parse(raw)
    } catch {
      continue
    }
    const connections = parsed && parsed.tables && parsed.tables.connections
    if (!connections || typeof connections !== 'object') continue
    for (const conn of Object.values(connections)) {
      if (!conn || typeof conn !== 'object') continue
      const serverName = str(conn.serverName)
      if (!serverName) continue
      const url = str(conn.url)
      found.push({
        key: str(conn.key),
        name: str(conn.name),
        serverName,
        prefix: `mcp__${serverName}__`,
        url,
        port: portOfUrl(url),
        enabled: conn.enabled !== false,
      })
    }
    break
  }
  return found
}

/**
 * 把连接器认领到分组：先按端口（最可靠），再按连接器名与分组名同名。
 * 返回 { group → { prefix, serverName, url, reason } }
 */
function matchConnectorsToGroups(connectors) {
  const out = {}
  const usable = (Array.isArray(connectors) ? connectors : []).filter((c) => c && c.enabled)
  for (const [group, def] of Object.entries(PREFIX_GROUPS)) {
    let hit = usable.find((c) => c.port && c.port === def.defaultPort)
    let reason = hit ? `按端口 ${def.defaultPort} 匹配` : ''
    if (!hit) {
      hit = usable.find((c) => c.serverName.toLowerCase() === group.toLowerCase())
      if (hit) reason = '按连接器名匹配'
    }
    if (hit) out[group] = { prefix: hit.prefix, serverName: hit.serverName, url: hit.url, reason }
  }
  return out
}

/**
 * 解析最终生效的前缀。
 * 优先级：用户配置 > 注册表按端口 > 注册表按名称 > 内置默认。
 * alternates[group] = 其它可试的前缀（按顺序串行重试用）。
 */
function resolveToolPrefixes(configured, connectors) {
  const matches = matchConnectorsToGroups(connectors)
  const list = Array.isArray(connectors) ? connectors.filter((c) => c && c.enabled) : []
  const prefixes = {}
  const sources = {}
  const alternates = {}
  for (const [group, def] of Object.entries(PREFIX_GROUPS)) {
    const userPrefix = normalizeToolPrefix(configured && configured[group])
    const discovered = matches[group] ? matches[group].prefix : ''
    // 试的顺序：用户配置 → 注册表按端口认领到的 → 内置默认 → 其它已启用连接器（兜底）。
    const order = []
    for (const candidate of [userPrefix, discovered, def.defaultPrefix]) {
      if (candidate && !order.includes(candidate)) order.push(candidate)
    }
    for (const conn of list) {
      if (conn.prefix && !order.includes(conn.prefix)) order.push(conn.prefix)
    }
    const primary = userPrefix || discovered || def.defaultPrefix
    prefixes[group] = primary
    sources[group] = userPrefix ? 'config' : discovered ? 'discovered' : 'default'
    // 兜底候选最多 4 个，避免重试风暴。
    alternates[group] = order.filter((p) => p !== primary).slice(0, 4)
  }
  return { prefixes, sources, alternates, matches }
}

/**
 * 由前缀方案生成插件实际要调用的工具全名 + 每个工具的备选名。
 * names：TOOL 的 key → 实际全名；alternatesByName：全名 → 备选全名数组。
 */
function buildToolPlan(plan) {
  const names = {}
  const alternatesByName = new Map()
  for (const [key, defaultFull] of Object.entries(TOOL)) {
    const group = TOOL_GROUP[key]
    if (!group) continue
    const def = PREFIX_GROUPS[group]
    const short = defaultFull.startsWith(def.defaultPrefix)
      ? defaultFull.slice(def.defaultPrefix.length)
      : defaultFull
    const primary = `${plan.prefixes[group]}${short}`
    names[key] = primary
    const alts = (plan.alternates[group] || []).map((p) => `${p}${short}`).filter((n) => n !== primary)
    alternatesByName.set(primary, alts)
  }
  return { names, alternatesByName }
}

/** 前缀没被发现、只能回退默认时给用户的中文提示（可选分组不打扰用户）。 */
function toolPrefixWarnings(plan) {
  const out = []
  for (const [group, def] of Object.entries(PREFIX_GROUPS)) {
    if (def.optional) continue
    if (plan.sources[group] !== 'default') continue
    out.push(
      `未在 DSH 连接器注册表里找到「${def.label}」连接器，已回退默认前缀 ${def.defaultPrefix}；` +
        `若面板提示工具不可见，请在 cordis.patch.yml 里配置 config.toolPrefixes.${group} = "mcp__<你的连接器名>__"。`,
    )
  }
  return out
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MONTH_RE = /(\d{4})\D?(\d{2})/

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

/** 有限数值兜底：null/undefined/NaN → 0。 */
function num(value) {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

/** 文本兜底，保留 null 以便 UI 区分「无值」与「空串」。 */
function str(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** 可选数值：取不到就是 null（不拿 0 冒充）。 */
function numOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** 日期串校验：格式必须是 YYYY-MM-DD，且必须是真实存在的日历日。 */
function assertDate(value, field) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) {
    throw new TypeError(
      `erp-sales-dashboard: "${field}" must be a YYYY-MM-DD string, received ${JSON.stringify(value)}`,
    )
  }
  const parsed = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new RangeError(`erp-sales-dashboard: "${field}" is not a real calendar date: ${value}`)
  }
  if (value < '1970-01-01' || value > '2999-12-31') {
    throw new RangeError(`erp-sales-dashboard: "${field}" is out of the supported range: ${value}`)
  }
  return value
}

/** 两个日期之间相差的天数（to - from）；无法解析返回 null。 */
function diffDays(fromDate, toDate) {
  const a = Date.parse(`${fromDate}T00:00:00Z`)
  const b = Date.parse(`${toDate}T00:00:00Z`)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  return Math.round((b - a) / 86400000)
}

/** 日期加天数，返回 YYYY-MM-DD。 */
function addDays(dateStr, days) {
  const t = Date.parse(`${dateStr}T00:00:00Z`)
  if (!Number.isFinite(t)) return null
  return new Date(t + days * 86400000).toISOString().slice(0, 10)
}

/**
 * 日期整体往前推 N 年（去年同期 / 前年同期）。
 * 2 月 29 日在目标年没有对应日期时，退到当月最后一天（2 月 28 日）。
 */
function shiftYears(dateStr, years) {
  const parts = String(dateStr).split('-')
  if (parts.length !== 3) return dateStr
  const year = Number(parts[0]) - years
  const month = Number(parts[1])
  const day = Number(parts[2])
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const safeDay = Math.min(day, lastDay)
  return `${year}-${String(month).padStart(2, '0')}-${String(safeDay).padStart(2, '0')}`
}

/** 把各种时间字段（'YYYY-MM-DD HH:mm:ss' / ISO）统一截成日期部分。 */
function dateOnly(value) {
  if (value === null || value === undefined) return null
  const text = String(value)
  const m = text.match(/^\d{4}-\d{2}-\d{2}/)
  return m ? m[0] : null
}

/** 把各种时间字段统一成 YYYY-MM（漏斗月度走势用）。 */
function monthKey(value) {
  if (value === null || value === undefined) return null
  const m = String(value).match(MONTH_RE)
  if (!m) return null
  return `${m[1]}-${m[2]}`
}

/** 本地时区的 ISO 时间（带 +08:00 偏移），与契约示例格式一致。 */
function isoLocal(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  )
}

/**
 * 把上游报错压成**可展示**的一行。
 * 上游（尤其 SQL 报错）原文可能带换行、很长，直接渲染会破版且对业务无意义。
 * 统一：压掉换行与多余空白 → 截断到 limit 字 → 超出加省略号。
 */
function compactUpstreamMessage(text, limit = 160) {
  const flat = String(text === null || text === undefined ? '' : text).replace(/\s+/g, ' ').trim()
  if (!flat) return ''
  return flat.length > limit ? flat.slice(0, limit) + '…' : flat
}

// ---------------------------------------------------------------------------
// MCP 返回值解包
// ---------------------------------------------------------------------------

/**
 * 稳健解包 MCP 工具返回值。
 * 逐层尝试：value 本身是对象 → value.content[0].text 的 JSON → value 的 JSON 字符串
 * → structuredContent → data / result。任一层成功即返回 plain object，否则返回 {}。
 */
function unwrapToolValue(value) {
  const seen = new Set()

  const candidate = (input) => {
    if (input === null || input === undefined) return null
    if (typeof input === 'string') {
      const text = input.trim()
      if (!text.startsWith('{') && !text.startsWith('[')) return null
      try {
        return candidate(JSON.parse(text))
      } catch {
        return null
      }
    }
    if (typeof input !== 'object') return null
    if (seen.has(input)) return null
    seen.add(input)
    // 裸数组本身就是负载：staff_info / after_sale_management_query /
    // std_product_info_query 三个工具都是 { data: [...] } 形状，
    // 剥掉 data 后就是数组，这一层必须原样返回（否则会被当成空负载丢掉）。
    if (Array.isArray(input)) return input
    if (Array.isArray(input.content)) {
      for (const part of input.content) {
        if (part && typeof part === 'object' && typeof part.text === 'string') {
          const text = part.text.trim()
          if (!text.startsWith('{') && !text.startsWith('[')) continue
          try {
            const parsed = JSON.parse(text)
            if (parsed !== null && typeof parsed === 'object') {
              const nested = candidate(parsed)
              // 解析成功但里面没找到负载时不立刻放弃，继续看下一个 part。
              if (nested) return nested
            }
          } catch {
            /* 不是 JSON，继续看下一个 part */
          }
        }
      }
    }
    if (input.structuredContent !== undefined && input.structuredContent !== null) {
      const parsed = candidate(input.structuredContent)
      if (parsed) return parsed
    }
    if (input.data !== undefined && input.data !== null) {
      const parsed = candidate(input.data)
      if (parsed) return parsed
    }
    if (input.result !== undefined && input.result !== null) {
      const parsed = candidate(input.result)
      if (parsed) return parsed
    }
    // 「胖对象」本身就是负载：至少带一个已知负载键。
    // 'data' 也在白名单里 —— { data: {...} } 这种信封形状必须能原样返回，
    // 否则 unwrapData 就没有东西可剥了。
    const payloadKeys = [
      'overview', 'trend', 'top_customers', 'top_members',
      'ranking', 'orders', 'customers', 'sales', 'summary',
      'metrics', 'rating', 'qcc', 'profile', 'visits', 'after_sales',
      'records', 'groups', 'level_distribution', 'data',
    ]
    if (payloadKeys.some((key) => key in input)) return input
    return null
  }

  return candidate(value) ?? {}
}

/**
 * 剥掉 MCP 服务自己的 `data` 信封。
 * 部分工具返回 { data: {overview, trend, ...} }，部分返回 { data: [...] }，
 * 解包后仍可能残留一层 data —— 统一剥一次，后面直接访问字段。
 */
function unwrapData(payload) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    if (payload.data !== undefined && payload.data !== null) return payload.data
  }
  return payload
}

/** 从负载里取数组；兼容 裸数组 / {key: []} / {data: {key: []}} / {data: []}。 */
function rowsOf(payload, keys = []) {
  if (Array.isArray(payload)) return payload
  if (!payload || typeof payload !== 'object') return []
  for (const key of keys) {
    if (Array.isArray(payload[key])) return payload[key]
    if (payload.data && typeof payload.data === 'object' && Array.isArray(payload.data[key])) {
      return payload.data[key]
    }
  }
  if (payload.data && Array.isArray(payload.data)) return payload.data
  return []
}

/** 取负载里的对象字段；兼容 {key: {}} 与 {data: {key: {}}}。 */
function sectionOf(payload, key) {
  if (!payload || typeof payload !== 'object') return undefined
  if (payload[key] !== undefined) return payload[key]
  if (payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)) {
    if (payload.data[key] !== undefined) return payload.data[key]
  }
  return undefined
}

// ---------------------------------------------------------------------------
// MCP 调用
// ---------------------------------------------------------------------------

/**
 * 找出可用于工具可见性的 agent 作用域。
 * MCP 连接器注入的工具（mcp__erp__*）是**按 agent 作用域**注册的，
 * 在无 agent 的全局上下文里 lookup 会得到 unknown tool。
 */
function findAgentScopes(ctx) {
  try {
    const agents = ctx.get ? ctx.get('agents') : undefined
    if (!agents || typeof agents.list !== 'function') return []
    const list = agents.list()
    if (!Array.isArray(list)) return []
    // 最多试 3 个，避免异常情况下遍历过多会话。
    return list.slice(0, 3).filter((a) => a && typeof a === 'object')
  } catch {
    return []
  }
}

/**
 * 调用一个 MCP 工具。
 * 先试全局作用域，再试前 3 个 agent 作用域；**只有「工具不可见」**才换作用域重试
 * （换作用域对 SQL 报错毫无意义，只会多打一遍）。
 *
 * 额外支持**备选前缀**：同一台设备上连接器名可能与默认的 erp/std 不同，
 * 这时同一批工具要换前缀再试（alternates 由前缀发现方案给出，串行尝试）。
 */
async function callTool(ctx, name, args, timeoutMs, alternates) {
  const scopes = [undefined, ...findAgentScopes(ctx)]
  const candidates = [name, ...(Array.isArray(alternates) ? alternates.filter((a) => a && a !== name) : [])]
  const failures = []
  for (const candidate of candidates) {
    let invisibleEverywhere = true
    for (const agent of scopes) {
      let result
      try {
        result = await ctx.tools.execute({
          callId: `erp-sales-dashboard:${candidate}`,
          name: candidate,
          arguments: args,
          signal: AbortSignal.timeout(timeoutMs),
          ...(agent === undefined ? {} : { agent }),
        })
      } catch (error) {
        failures.push(`抛错: ${compactUpstreamMessage(error && error.message ? error.message : String(error))}`)
        invisibleEverywhere = false
        break
      }
      if (!result?.isError) return unwrapToolValue(result?.value)

      const info = result.error || {}
      const code = info.code || 'error'
      const label = agent === undefined ? '全局' : 'agent'
      failures.push(`${candidate} ${label}/${code}: ${compactUpstreamMessage(info.message) || '无 message'}`)
      // 不同服务给的 code 不一致（有的是 UNKNOWN_TOOL，有的只是 message 带 unknown tool），两种都认。
      const invisible =
        code === 'UNKNOWN_TOOL' ||
        /unknown tool|not found|不可见|不存在/i.test(String(info.message || ''))
      if (!invisible) {
        invisibleEverywhere = false
        break
      }
    }
    // 真实错误（不是「工具不可见」）→ 换前缀也没用，直接停。
    if (!invisibleEverywhere) break
  }
  throw new Error(
    `${name} 失败（尝试 ${scopes.length} 个作用域 × ${candidates.length} 个前缀）: ${failures.join(' | ')}`,
  )
}

// ---------------------------------------------------------------------------
// 纯函数工具（导出供 selfcheck 断言）
// ---------------------------------------------------------------------------

/** 除零安全比率；分母非正返回 null（语义上不可计算，不是 0）。 */
function ratio(numerator, denominator) {
  const bottom = num(denominator)
  if (bottom <= 0) return null
  const top = num(numerator)
  const value = top / bottom
  return Number.isFinite(value) ? value : null
}

/** 除零安全除法（分母可以为负；分母为 0 返回 null）。 */
function safeDiv(numerator, denominator) {
  const bottom = num(denominator)
  if (bottom === 0) return null
  const value = num(numerator) / bottom
  return Number.isFinite(value) ? value : null
}

/** 夹到 0~1；null / 非有限值原样返回 null。 */
function clamp01(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return null
  const n = Number(value)
  return n < 0 ? 0 : n > 1 ? 1 : n
}

/** 求和：rows.map(pick) 后累加。 */
function sumBy(rows, pick) {
  if (!Array.isArray(rows)) return 0
  let total = 0
  for (const row of rows) total += num(pick(row))
  return total
}

/** 分组求和：返回 Map<key, number>。 */
function groupSum(rows, keyOf, valueOf) {
  const map = new Map()
  if (!Array.isArray(rows)) return map
  for (const row of rows) {
    const key = keyOf(row)
    if (key === null || key === undefined) continue
    map.set(key, (map.get(key) || 0) + num(valueOf(row)))
  }
  return map
}

/**
 * 账龄分桶（未回款订单按逾期天数）。
 * 边界：<=30 → 30天内；31~60 → 31-60天；61~90 → 61-90天；>90 → 90天以上。
 */
function bucketAging(days) {
  const n = numOrNull(days)
  if (n === null) return null
  if (n <= 30) return '30天内'
  if (n <= 60) return '31-60天'
  if (n <= 90) return '61-90天'
  return '90天以上'
}

/**
 * 趋势里的最后一个自然月是否**未完结**。
 *
 * 为什么必须判断：环比（当月 vs 上月）在未完结月天然失真 —— 10 月 23 日的接单额
 * 去比 9 月整月，算出来 -40%，看起来像业绩崩塌，其实只是这个月还没过完。
 * 不标注就等于让用户自己去猜为什么 —— 那就是「数字会骗人」。
 *
 * 规则：区间末落在该月内且还没到月末 → 未完结；区间末已跨月 → 该月已完整。
 */
function isPartialMonthPeriod(period, endDate) {
  if (!period || !endDate) return false
  const endMonth = endDate.slice(0, 7)
  if (period !== endMonth) return false
  const year = Number(endDate.slice(0, 4))
  const month = Number(endDate.slice(5, 7))
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) return false
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return Number(endDate.slice(8, 10)) < lastDay
}

/** 同比 / 环比：(now - before) / before。基期缺失或非正 → null。 */
function pctChange(now, before) {
  const base = numOrNull(before)
  if (base === null || base <= 0) return null
  const current = numOrNull(now)
  if (current === null) return null
  const value = (current - base) / base
  return Number.isFinite(value) ? value : null
}

/** 加权平均占比：Σ(value×weight) ÷ Σweight。权重和为 0 → null。 */
function weightedShare(rows, weightOf, valueOf) {
  if (!Array.isArray(rows)) return null
  let weightSum = 0
  let valueSum = 0
  for (const row of rows) {
    const weight = num(weightOf(row))
    if (weight <= 0) continue
    weightSum += weight
    valueSum += num(valueOf(row)) * weight
  }
  if (weightSum <= 0) return null
  const value = valueSum / weightSum
  return Number.isFinite(value) ? value : null
}

/** 计数：rows.filter(pred).length。 */
function countBy(rows, pred) {
  if (!Array.isArray(rows)) return 0
  return rows.filter((row) => (typeof pred === 'function' ? pred(row) : true)).length
}

/** 去重计数（按 keyFn 取键）。 */
function uniqueCount(rows, keyOf) {
  if (!Array.isArray(rows)) return 0
  const set = new Set()
  for (const row of rows) {
    const key = keyOf(row)
    if (key === null || key === undefined || key === '') continue
    set.add(String(key))
  }
  return set.size
}

/** 去重后的字符串数组（保持出现顺序，去掉 null / 空串）。 */
function uniqueStrings(values) {
  const seen = new Set()
  const out = []
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue
    const text = String(value)
    if (seen.has(text)) continue
    seen.add(text)
    out.push(text)
  }
  return out
}

/**
 * 纯函数工具集合（导出给 selfcheck.mjs 做断言用）。
 * 里面**不包含**任何 I/O，也不包含 Config 之类的导出。
 */
export const metrics = {
  ratio,
  safeDiv,
  clamp01,
  sumBy,
  groupSum,
  bucketAging,
  pctChange,
  weightedShare,
  countBy,
  uniqueCount,
  uniqueStrings,
  diffDays,
  addDays,
  shiftYears,
  dateOnly,
  monthKey,
  num,
  str,
  numOrNull,
  isoLocal,
  /* ---- MCP 工具名前缀（换设备自动发现）相关纯函数 ---- */
  portOfUrl,
  normalizeToolPrefix,
  matchConnectorsToGroups,
  resolveToolPrefixes,
  buildToolPlan,
  toolPrefixWarnings,
  TOOL_GROUP,
  PREFIX_GROUPS,
  /**
   * 省份解析（纯函数，不碰 IO）。
   * 导出出来是为了让 selfcheck 能直接断言「绝不从公司名猜省份」这条口径：
   * 同一个公司名换不同地址，判定结果必须跟着地址走。
   */
  resolveGeoProvince,
  /**
   * 报价/询价统计（纯函数）。
   * 导出出来是为了让 selfcheck 能对「金额合计必须取 metrics.amount_total（合并口径），
   * 不能拿明细行 sum(total_amount) 冒充」这条口径做行为级断言。
   */
  buildQuoteStats,
  /**
   * 逾期天数归一（纯函数）。
   *
   * 导出出来是为了让 selfcheck 能对「上游给的负数 overdue_days 必须归一成 null，
   * 并另给一个布尔 overdue」这条口径做行为级断言 —— 因为实机数据里确实出现过
   * overdueDays=-63 这种「还没到期」的负值，直接下发会让前端显示「逾期 -63 天」。
   */
  normalizeOverdueDays,
  /**
   * 订单分片截断判定（纯函数）。
   *
   * 导出出来是为了让 selfcheck 能对「判截断必须用同一次响应的 overview.order_count，
   * 不能用『行数 == limit』」这条口径做行为级断言 —— 实机测出来上游 limit 被硬顶 500 行，
   * 用行数判定会永远拆不开、区间订单永远缺一块。
   */
  isOrderSliceTruncated,
  /**
   * 未回款口径归一（纯函数）。
   *
   * 导出出来是为了让 selfcheck 能对「未回款必须是 签约额 − 已回款额，
   * 取不到时才回落上游原值并标 basis」这条口径做行为级断言 ——
   * 上游 uncollected_amount 把部分回款按全额计入，不归一会让「在途未回款」虚高。
   */
  normalizeUncollectedAmount,
  /**
   * 员工在职状态标签（纯函数）：staff_info.status 0=离职、其余=在职。
   * 导出是为了让 selfcheck 能断言「statusName 是乱码时也不许拿乱码当标签」。
   */
  staffStatusLabel,
  /**
   * STD 卡点判定与卡点文案（纯函数）。
   *
   * 导出是为了让 selfcheck 能对「出库明细取不到 / 货号判定全失败 / 窗口内没有货号
   * 这三种卡点分别给不同文案」做行为级断言 —— 笼统一句「不可得」没法定位是谁坏了，
   * 也容易被读成「我们没有 STD 业务」。
   */
  stdBlockedStage,
  stdBlockedText,
  /**
   * 客户 → 负责人 → 成员 → 梯队 的去重连接（纯函数）。
   *
   * 导出是为了让 selfcheck 能对「同一客户被多人跟单时只能算一个客户」
   * 这条口径做行为级断言 —— A2 缺陷的根因就是拿「成员客户数」当客户数，
   * 那样算出来的是「客户数这个数字有多少种取值」，不是客户数。
   */
  dedupCustomerJoin,
  /**
   * 复购分档：**只统计区间内订单数 ≥ 1 的客户**。
   *
   * 导出成纯函数是为了让 selfcheck 能对「0 单客户必须被排除」这条口径做行为级断言，
   * 而不是只靠正则扫源码。0 单客户没买过，算进「1-3次」是错的。
   */
  repurchaseDistribution(records) {
    const buckets = new Map([
      ['1-3次', 0],
      ['4-12次', 0],
      ['>12次', 0],
    ])
    let excludedNoOrder = 0
    let total = 0
    for (const record of Array.isArray(records) ? records : []) {
      const orders = num(record?.orderCount ?? record?.orders)
      if (orders < 1) {
        excludedNoOrder += 1
        continue
      }
      const bucket = bucketRepurchase(orders)
      if (!buckets.has(bucket)) continue
      buckets.set(bucket, buckets.get(bucket) + 1)
      total += 1
    }
    return {
      rows: [...buckets.entries()].map(([bucket, count]) => ({
        bucket,
        count,
        share: ratio(count, total),
      })),
      total,
      excludedNoOrder,
    }
  },
  /**
   * 销售二级部门白名单（纯函数）。
   *
   * ⚠️ 绝不能直接用 `member_performance_analysis` 的**全部** dep_name 建白名单：
   *    那个接口统计的是全公司 12 名在册成员，混着市场发展部 / 行政法宣部 / 总工等非销售部门。
   *    早期版本用全量 dep_name，导致「市场发展部」「行政法宣部」的新人被误判成销售混进新兵表。
   *    现在只认三类来源：固定兜底名单 + ERP 侧 first_dep_name 命中事业群的成员 + 销售排行的部门。
   */
  buildSalesSquadNames(memberRows, rankingRows, salesFirstDep) {
    const names = new Set([
      '鲲鹏特战队', '猛虎特训营', '海豹特战队', '战狼特战队', '蛟龙特训营', '业务咨询事业群',
    ])
    for (const row of Array.isArray(memberRows) ? memberRows : []) {
      if (str(row?.first_dep_name) !== salesFirstDep) continue
      const squad = str(row?.dep_name)
      if (squad) names.add(squad)
    }
    // sales_performance_ranking 是销售排行，department_name 全是销售二级部门
    for (const row of Array.isArray(rankingRows) ? rankingRows : []) {
      const dept = str(row?.department_name)
      if (dept) names.add(dept)
    }
    return names
  },
  /**
   * 是不是销售序列（纯函数）。
   *
   * ⚠️ `job_no` 以 'YX' 开头**不能**当独立判据：市场发展部的业务员10 username 也是 YX90017。
   */
  isSalesStaffRow(staff, salesFirstDep, salesSquadNames) {
    const firstDep = str(staff?.first_dep_name)
    if (firstDep && firstDep === salesFirstDep) return true
    const dept = str(staff?.dep_name)
    if (dept && salesSquadNames.has(dept)) return true
    const second = str(staff?.second_dep_name)
    if (second && salesSquadNames.has(second)) return true
    return false
  },
  /**
   * 新兵筛选（纯函数）。
   *
   * 用户 2026-10-26 的定义：**「新兵是指 未转正 的 业务咨询成员」**。
   *
   * 实测（staff_info 全量 224 行，2026-10-26 探测）：
   *   · 业务咨询事业群 89 人 = 在职 33 + 离职 56；
   *   · 在职 33 人里 **positive_time 为空 = 10 人（未转正）**，其余 23 人 positive_time 有值且已过期（已转正）；
   *   · 全公司没有「转正日期在未来」的在职员工，所以本规则里那一支当前命中 0 人；
   *   · 这 10 人的岗位全部是「业务咨询经理」，职级全部是「A-1级-E1」。
   *
   * 入选条件（全部满足）：
   *   ① 在职：status ≠ 0（status=0 是离职；status_name 是 GBK 误解码乱码，只能用数值判）；
   *   ② 业务咨询销售序列：isSalesStaffRow；
   *   ③ **未转正**：positive_time 为空，或转正日期晚于基准日（已排期未到期）；
   *   ④ 销售岗：post_name 为空则放过；非空且不含「业务咨询 / 销售」则剔除
   *      （销售体系里混着「市场企划主管」「市场推广专员」这类非销售岗）。
   *
   * ⚠️ 不再按 join_time ∈ 区间筛人：「未转正」是**当前状态**而不是区间事件，
   *    按区间筛会让这张表随用户选的时间窗忽有忽无。区间只决定业绩 / 客户数的统计口径。
   */
  selectNewcomers(staffRows, options) {
    const opts = options || {}
    const salesFirstDep = opts.salesFirstDep
    const salesSquadNames = opts.salesSquadNames
    const baseDate = str(opts.baseDate)
    const stats = { total: 0, nonSales: 0, left: 0, confirmed: 0, notSalesPost: 0, selected: 0 }
    const candidates = []
    for (const staff of Array.isArray(staffRows) ? staffRows : []) {
      const name = str(staff?.staff_name)
      if (!name) continue
      stats.total += 1
      if (!metrics.isSalesStaffRow(staff, salesFirstDep, salesSquadNames)) {
        stats.nonSales += 1
        continue
      }
      if (num(staff?.status) === 0) {
        stats.left += 1
        continue
      }
      const positive = dateOnly(staff?.positive_time)
      if (positive && baseDate && positive <= baseDate) {
        stats.confirmed += 1
        continue
      }
      const post = str(staff?.post_name)
      if (post && !/业务咨询|销售/.test(post)) {
        stats.notSalesPost += 1
        continue
      }
      stats.selected += 1
      candidates.push(staff)
    }
    return { candidates, stats }
  },
  /**
   * 梯队名乱码归并（纯函数）。
   *
   * 背景（实测 2026-10-26）：`sales_performance_ranking` 里 member_id=32「占位成员01」
   * 的 department_name 是 "<3 个 U+FFFD 替换字符>狼特战队" —— 库里「战」字是坏字节，MCP 侧按 UTF-8 解出
   * U+FFFD 替换字符。它是 0 业绩占位成员，只在 top-100 截断时偶尔被切进来，
   * 于是页面上会多出一条「0 人的假梯队」。
   *
   * 修法：把含 U+FFFD 的名字剥掉替换字符后，按**最长公共后缀**去匹配已知梯队名；
   * 唯一命中且公共后缀 ≥3 字才归并，否则宁可不猜（返回空串让调用方保留原名并告警）。
   */
  repairSquadName(name, knownNames) {
    const raw = str(name)
    if (!raw || !raw.includes('\uFFFD')) return raw
    const cleaned = raw.replace(/\uFFFD/g, '')
    if (!cleaned) return ''
    const commonSuffix = (a, b) => {
      let n = 0
      while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n += 1
      return n
    }
    let best = ''
    let bestScore = 0
    let tie = false
    for (const known of Array.isArray(knownNames) ? knownNames : []) {
      const k = str(known)
      if (!k || k.includes('\uFFFD')) continue
      const score = Math.max(commonSuffix(cleaned, k), commonSuffix(k, cleaned))
      if (score > bestScore) {
        best = k
        bestScore = score
        tie = false
      } else if (score === bestScore && score > 0 && k !== best) {
        tie = true
      }
    }
    if (!best || bestScore < 3 || tie) return ''
    return best
  },
  /**
   * PII 判定（纯函数，导出供 selfcheck 做行为级断言）。
   *
   * 关键点：视断言必须排除小数点，否则普通浮点数会被误判成手机号/身份证
   * （详见 PII_PATTERNS 上方的注释）。这个误判曾导致磁盘缓存永远写不进去。
   */
  containsPii,
}

// ---------------------------------------------------------------------------
// 业务分类规则（口径选择的「为什么」都写在这里）
// ---------------------------------------------------------------------------

/**
 * 直销 / 经销 / 其他未知 —— 按 customer_kind 判定。
 *
 * 为什么不能只看「是不是代理」：ERP 的 customer_kind 枚举里还有
 * 终端客户、事业单位、经销商、代理商、其它等好几档，直接二分会把
 * 「事业单位」这类明显的直销主体算成未知。
 * 规则：命中代理/经销关键词 → 经销商；命中终端/直销/机构关键词 → 直销；
 * 都不命中或字段缺失 → 其他/未知（宁可归未知，也不乱归直销）。
 */
function classifyChannel(kind) {
  const text = str(kind)
  if (!text) return '其他/未知'
  if (/代理|经销|分销|渠道商|代理商/.test(text)) return '经销商'
  if (/终端|直销|事业单位|企事业|医院|学校|学院|研究所|研究院|工厂|药厂|科研/.test(text)) return '直销'
  return '其他/未知'
}

/**
 * 客户赛道 —— 按 customer_tier_rating 返回的 qcc.industry / sub_industry 粗分。
 * ERP 没有赛道字段，只能用企查查的行业分类做粗粒度归并；判不出就归「其他/未知」。
 */
function classifyTrack(industry, subIndustry) {
  const text = `${str(industry) || ''} ${str(subIndustry) || ''}`
  if (!text.trim()) return '其他/未知'
  if (/药|医药|制药|生物|CRO|经销|流通|医疗/.test(text)) return '药企/CRO/经销商'
  if (/化妆|日化|护肤|检验|检测|农|兽|饲料|疫苗/.test(text)) return '化妆品/检验检测/农兽药'
  return '其他/未知'
}

/**
 * 跟进频次标准 —— 按客户分档定档要求（契约：跟进达标率）。
 * A = 每周≥1 次，B = 每两周≥1 次，C = 每月≥1 次；S 按 A 档执行。
 */
function followStandard(tier, periodDays) {
  const level = str(tier)
  const days = Math.max(1, num(periodDays))
  if (level === 'A' || level === 'S') {
    return { label: '每周≥1次深度沟通', need: Math.ceil(days / 7) }
  }
  if (level === 'B') {
    return { label: '每两周≥1次深度沟通', need: Math.ceil(days / 14) }
  }
  return { label: '每月≥1次深度沟通', need: Math.ceil(days / 30) }
}

/** 比率 → 状态（good / warn / bad / unknown）。 */
function statusFromRate(rate, goodAt = 1, warnAt = 0.8) {
  if (rate === null || rate === undefined || !Number.isFinite(Number(rate))) return 'unknown'
  const value = Number(rate)
  if (value >= goodAt) return 'good'
  if (value >= warnAt) return 'warn'
  return 'bad'
}

/**
 * 同比/环比变化 → 状态。方向与「比率」相反：**降幅越大越差**。
 * 方案原文：「降幅 >20% 红色，-20%~0 黄色」→ 阈值来自 TH.growthDrop / TH.growthDropYellow。
 * 纯函数，便于自检覆盖。
 */
export function statusFromDelta(delta, th = THRESHOLD_DEFAULTS) {
  if (delta === null || delta === undefined || !Number.isFinite(Number(delta))) return 'unknown'
  const value = Number(delta)
  if (value >= 0) return 'good'
  const drop = -value
  if (drop >= num(th.growthDrop)) return 'bad'
  if (drop > num(th.growthDropYellow)) return 'warn'
  return 'good'
}

/**
 * 智能预警阈值默认值。
 * 方案 01「三大能力」之二要求「红黄绿三色 + **自定义预警阈值**」，
 * 所以这些数字不是写死在业务逻辑里，而是可被 settings.thresholds 覆盖。
 *
 * 方向性（各指标的好坏方向不同，不能用同一个 statusFromRate）：
 *   - stdShare / bShare / collectionRate：越高越好 → 低于 Yellow 判红，低于目标判黄
 *   - cShare：越低越好 → 高于上限判黄，高于 cShareRed 判红
 *   - growthDrop：同比/环比**降幅**超过该值判红，在 (0, 该值) 判黄（方案：降幅>20% 红，-20%~0 黄）
 */
export const THRESHOLD_DEFAULTS = {
  stdShare: 0.6,
  stdShareYellow: 0.48,
  bShare: 0.4,
  bShareYellow: 0.32,
  cShare: 0.15,
  cShareRed: 0.195,
  collectionRate: 0.9,
  collectionRateYellow: 0.7,
  squadCollectionRateLow: 0.6,
  growthDrop: 0.2,
  growthDropYellow: 0,
}

/**
 * 把用户传入的阈值覆盖解析成一组**合法且完整**的阈值。
 * 纯函数：非法值（NaN / Infinity / 非数字 / 越界）一律回退到默认值，
 * 缺失的键也用默认值补齐 —— 保证下游永远拿到确定的数字。
 */
export function resolveThresholds(input) {
  const out = { ...THRESHOLD_DEFAULTS }
  if (!input || typeof input !== 'object') return out
  for (const key of Object.keys(THRESHOLD_DEFAULTS)) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue
    const raw = input[key]
    const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    if (value < 0 || value > 1) continue
    out[key] = value
  }
  // 派生黄线：若只改了目标值而没给黄线，按目标 ×0.8 重算，保持一致
  if (!Object.prototype.hasOwnProperty.call(input, 'stdShareYellow') && out.stdShareYellow > out.stdShare) {
    out.stdShareYellow = Math.round(out.stdShare * 0.8 * 1000) / 1000
  }
  if (!Object.prototype.hasOwnProperty.call(input, 'bShareYellow') && out.bShareYellow > out.bShare) {
    out.bShareYellow = Math.round(out.bShare * 0.8 * 1000) / 1000
  }
  if (!Object.prototype.hasOwnProperty.call(input, 'collectionRateYellow') && out.collectionRateYellow > out.collectionRate) {
    out.collectionRateYellow = Math.round(out.collectionRate * 0.8 * 1000) / 1000
  }
  if (!Object.prototype.hasOwnProperty.call(input, 'cShareRed') && out.cShareRed < out.cShare) {
    out.cShareRed = Math.round(out.cShare * 1.3 * 1000) / 1000
  }
  return out
}

/** 复购分档：按客户下单次数分「1-3次 / 4-12次 / >12次」。 */
function bucketRepurchase(orderCount) {
  const n = num(orderCount)
  if (n <= 3) return '1-3次'
  if (n <= 12) return '4-12次'
  return '>12次'
}

// ---------------------------------------------------------------------------
// 磁盘缓存（PII 扫描 + 失败降级）
// ---------------------------------------------------------------------------

/**
 * 值里出现**独立**的 11 位手机号 / 座机号 / 18 位身份证号 → 整份不落盘。
 * 用前后视断言，避免在长数字串（毫秒时间戳、单据号）中间截出假手机号。
 *
 * ⚠️ v6 修正：视断言里**必须把小数点 `.` 也排除掉**。
 * 早期只排除数字，于是**普通浮点数会被误判成 PII**：
 *   - `share = 0.050261205153015395` → 其中的 18 位数字命中「身份证号」正则；
 *   - `avg = 5330.053140096618` → 其中的 12 位数字命中「座机号（无横线）」正则。
 * 后果很实际：① 整份结果被判为「含敏感信息」→ **磁盘缓存永远写不进去**（6 小时缓存只剩内存那一份，
 * DSH 一重启又要重拉 3~5 分钟）；② 每次都向用户显示一条**不实的**「含手机号/身份证」告警。
 * 现在小数点前后的数字串不再被当作独立号码，真实的手机号/座机/身份证仍能命中。
 */
const PII_PATTERNS = [
  /(?<![0-9.])1[3-9][0-9]{9}(?![0-9.])/,                 // 手机号
  /(?<![0-9.])0[0-9]{2,3}-[0-9]{7,8}(?![0-9.])/,          // 座机号（带横线）
  /(?<![0-9.])0[0-9]{2,3}[0-9]{7,8}(?![0-9.])/,           // 座机号（无横线）
  /(?<![0-9A-Za-z.])[0-9]{17}[0-9Xx](?![0-9A-Za-z.])/,     // 身份证号
]

/** 递归扫描对象里是否含手机号 / 身份证等 PII。 */
function containsPii(value, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return false
  if (typeof value === 'string') {
    if (!value) return false
    return PII_PATTERNS.some((re) => re.test(value))
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return false
    return PII_PATTERNS.some((re) => re.test(String(value)))
  }
  if (Array.isArray(value)) return value.some((item) => containsPii(item, depth + 1))
  if (typeof value !== 'object') return false
  for (const [key, item] of Object.entries(value)) {
    // 这些字段名本身就说明是联系方式/证件，命中即不落盘。
    if (/^(phone|tel|mobile|id_?card|bank_?account|bank_?no)$/i.test(key)) return true
    if (containsPii(item, depth + 1)) return true
  }
  return false
}

/**
 * 落盘目录：优先 DSH_PROFILE_DIR/cache/erp-sales-dashboard/，
 * 没有该环境变量时退回插件目录下的 cache/erp-sales-dashboard/。
 */
function diskCacheDir(settings) {
  const custom = settings && settings.cacheDir ? String(settings.cacheDir) : ''
  if (custom) return custom
  const profile = process.env.DSH_PROFILE_DIR ? String(process.env.DSH_PROFILE_DIR) : ''
  const base = profile
    ? path.join(profile, 'cache', 'erp-sales-dashboard')
    : path.join(path.dirname(fileURLToPath(import.meta.url)), 'cache', 'erp-sales-dashboard')
  return base
}

function diskCacheHash(key) {
  return crypto.createHash('md5').update(String(key)).digest('hex').slice(0, 12)
}

function diskCacheFile(dir, key) {
  return path.join(dir, `result-${diskCacheHash(key)}.json`)
}

/**
 * 磁盘缓存写入器。
 * 写盘前扫 PII（命中 → 整份不落盘，只留内存）；
 * 写盘失败 → 降级为纯内存 + 一条中文告警，绝不让路由 500。
 */
function createDiskCacheWriter(dir) {
  const problems = []
  const warned = new Set()
  let chain = Promise.resolve()

  function noteProblem(key, message) {
    const tag = `${key}::${message}`
    if (warned.has(tag)) return
    warned.add(tag)
    problems.push(`缓存落盘提示：${message}`)
  }

  async function writeOne(entry) {
    try {
      await fs.promises.mkdir(dir, { recursive: true })
      await fs.promises.writeFile(
        entry.file,
        JSON.stringify({ at: entry.at, key: entry.key, value: entry.value }),
        'utf8',
      )
    } catch (error) {
      noteProblem(entry.key, `写盘失败（已降级为纯内存缓存）：${error && error.message ? error.message : String(error)}`)
    }
  }

  return {
    put(key, value) {
      if (key === undefined || key === null || value === undefined) return
      if (containsPii(value)) {
        noteProblem(key, '缓存内容含手机号 / 身份证等敏感信息，按安全要求不落盘，仅保留在内存缓存中。')
        return
      }
      let text
      try {
        text = JSON.stringify(value)
      } catch {
        noteProblem(key, '缓存内容无法序列化，已跳过落盘。')
        return
      }
      if (text.length > 8 * 1024 * 1024) {
        noteProblem(key, '缓存体积超过 8MB 上限，已跳过落盘。')
        return
      }
      chain = chain.then(() =>
        writeOne({ file: diskCacheFile(dir, key), key: String(key), at: Date.now(), value }),
      )
    },
    flush() {
      return chain
    },
    drainProblems() {
      const list = problems.slice()
      problems.length = 0
      return list
    },
  }
}

/** 启动时把磁盘缓存读回来（未过 TTL 才恢复）；坏文件直接跳过。 */
function restoreDiskCaches(dir, ttlMs) {
  const restored = []
  if (!(ttlMs > 0)) return restored
  let files = []
  try {
    files = fs.readdirSync(dir)
  } catch {
    return restored
  }
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    try {
      const raw = fs.readFileSync(path.join(dir, file), 'utf8')
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object') continue
      const at = Number(parsed.at)
      if (!Number.isFinite(at)) continue
      if (Date.now() - at >= ttlMs) continue
      if (parsed.key === undefined || parsed.value === undefined) continue
      restored.push({ key: String(parsed.key), at, value: parsed.value })
    } catch {
      /* 坏文件跳过即可 */
    }
  }
  return restored
}

// ---------------------------------------------------------------------------
// STD 货号判定缓存（与时间区间**无关**的事实，独立于结果缓存）
// ---------------------------------------------------------------------------
/**
 * 为什么要单独一份缓存，而不是复用 result 缓存：
 *
 *   结果缓存的键是「区间 + 梯队 + 业务员」，换个区间就整份失效；
 *   而「这个货号是不是 STD 产品」是**产品属性**，与区间无关，
 *   有效期该以「月」计（默认 90 天），换区间照样能用。
 *
 * 为什么必须缓存：
 *   std_product_info_query **无法一次拉全 STD 货号目录**（limit 硬顶 500，
 *   按 code 前缀拆也是 500，实测前 5000 行仍不是全集），
 *   只能逐个货号 `code=<精确货号>` 探测，单条 6~8 秒、服务端串行 ——
 *   不缓存的话每次开看板都要把几百个货号重探一遍，必然撞墙钟预算。
 *
 * 结构：{ v: 1, codes: { 'RM90711R': { std: true, at: 1710000000000 } } }
 * 落盘失败 / 文件损坏一律静默降级为空表（判不出来就是 null，绝不猜）。
 */
const STD_VERDICT_FILE = 'std-goods-verdicts.json'
const STD_VERDICT_TTL_MS = 90 * 86400000
const STD_VERDICT_MAX_CODES = 20000

function stdVerdictFile(dir) {
  return path.join(dir, STD_VERDICT_FILE)
}

/** 读货号判定缓存；过期条目丢弃，坏文件当空表。 */
function loadStdVerdicts(dir, ttlMs) {
  const map = new Map()
  let parsed = null
  try {
    parsed = JSON.parse(fs.readFileSync(stdVerdictFile(dir), 'utf8'))
  } catch {
    return map
  }
  const codes = parsed && typeof parsed === 'object' ? parsed.codes : null
  if (!codes || typeof codes !== 'object') return map
  const ttl = ttlMs > 0 ? ttlMs : STD_VERDICT_TTL_MS
  const now = Date.now()
  for (const code of Object.keys(codes)) {
    const entry = codes[code]
    if (!entry || typeof entry !== 'object') continue
    const at = Number(entry.at)
    if (!Number.isFinite(at) || now - at >= ttl) continue
    if (entry.std !== true && entry.std !== false) continue
    map.set(String(code), { std: entry.std === true, at })
  }
  return map
}

/**
 * 写货号判定缓存：只保留未过期、按时间倒序的前 MAX 条，先写临时文件再 rename，
 * 保证任何时刻磁盘上都是「完整的旧文件」或「完整的新文件」，不会半截。
 */
function saveStdVerdicts(dir, map, ttlMs) {
  if (!map || map.size === 0) return
  try {
    const ttl = ttlMs > 0 ? ttlMs : STD_VERDICT_TTL_MS
    const now = Date.now()
    const entries = []
    for (const [code, entry] of map.entries()) {
      const at = Number(entry && entry.at)
      if (!Number.isFinite(at) || now - at >= ttl) continue
      entries.push([String(code), { std: entry.std === true, at }])
    }
    entries.sort((a, b) => b[1].at - a[1].at)
    const codes = {}
    for (const [code, entry] of entries.slice(0, STD_VERDICT_MAX_CODES)) codes[code] = entry
    fs.mkdirSync(dir, { recursive: true })
    const target = stdVerdictFile(dir)
    const tmp = `${target}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, savedAt: now, codes }), 'utf8')
    fs.renameSync(tmp, target)
  } catch {
    /* 落盘失败不影响本次结果，下次重新探测即可 */
  }
}

// ---------------------------------------------------------------------------
// 询报价明细统计（零新增 MCP 调用，纯派生）
// ---------------------------------------------------------------------------
/**
 * 由 quotation_query / inquiry_plan_query 的**明细记录 + metrics**派生出询报价统计块。
 *
 * 口径纪律（这块最容易出错，四条必须守住）：
 *   ① **单据数取 metrics.doc_count**（全量口径）；明细行数另设字段并注明被 rowLimit 截断。
 *      上游没有 offset，翻不了页，所以明细永远是前 N 条 → 任何基于明细的统计都是抽样口径。
 *   ② **报价金额合计取 metrics.amount_total**（合并口径），绝不能用明细行 sum(total_amount)：
 *      同一客户同一天的多份报价已被上游 merge_same_day 合并成一份，
 *      用明细行求和会把同一笔金额重复计进去。
 *   ③ 所有基于明细行的统计（待回复询价、回复状态分布、TOP 客户/业务员、最近明细）
 *      必须带 sampled / sampleSize / totalKnown / note。
 *   ④ 比率一律 0~1；取不到写 null，不写 0 冒充。
 *      例外说明（写在这里，免得以后有人「顺手 clamp 一下」把数据改假）：
 *        inquiryToQuotationRate = 报价单数 ÷ 询价单数
 *        quotationToOrderRate   = 区间订单数 ÷ 报价单数
 *      这两个比率的分子分母来自**不同的客户集**，本来就可能 > 1
 *      （订单数比报价单数还多，说明相当比例订单不是由报价单转化来的）。
 *      把它们 clamp 到 1 等于把「转化不过来」这件事藏起来 —— 那才是真正的假数据。
 *      真正的比例（回款率、完成率、份额…）才必须落在 0~1。
 *   ⑤ **份额必须给两个口径**：share（该条 ÷ 样本内金额合计）回答「抽样里占几成」，
 *      shareOfTotal（该条 ÷ 全量 amount_total，与同屏 KPI 同分母）回答「对全盘占几成」。
 *      只给 share 会让界面上的占比和 quotationAmount KPI 分母对不上（150 万 vs 1.9 亿）。
 *      另外用 basis='sample' / sampleAmount / sampleShare 把「这批抽样覆盖了全量多少」写进**字段**
 *      （参考实现把口径写在 section.note 里，而前端不渲染 note，所以必须落到字段上）。
 *
 * reply_status 归类（上游枚举）：
 *   已答复 = 2 答复中 / 3 已完成；
 *   待处理 = 0 默认 / 1 待领取 / 6 复核待确认 / 7 复核中；
 *   4 无方案项目 / 5 统筹已撤销 = 既不算已答复也不算待处理，单独归第三组。
 */
function buildQuoteStats(options) {
  const inquiryMetrics = options?.inquiryMetrics || {}
  const inquiryRecords = Array.isArray(options?.inquiryRecords) ? options.inquiryRecords : []
  const quotationMetrics = options?.quotationMetrics || {}
  const quotationRecords = Array.isArray(options?.quotationRecords) ? options.quotationRecords : []
  const periodOrderCount = numOrNull(options?.periodOrderCount)
  const rowLimit = num(options?.rowLimit) || 0

  const inquiryDocCount = numOrNull(inquiryMetrics.doc_count)
  const quotationDocCount = numOrNull(quotationMetrics.doc_count)
  const quotationAmount = numOrNull(quotationMetrics.amount_total)
  const inquiryRowCount = inquiryRecords.length
  const quotationRowCount = quotationRecords.length

  // ── 回复状态三分类 ──────────────────────────────────────────────────────
  const replyGroups = { answered: 0, pending: 0, closed: 0 }
  for (const record of inquiryRecords) {
    const reply = num(record.reply_status)
    if (reply === 2 || reply === 3) replyGroups.answered += 1
    else if (reply === 0 || reply === 1 || reply === 6 || reply === 7) replyGroups.pending += 1
    else replyGroups.closed += 1
  }
  const replyStatus = [
    { status: '已答复', count: replyGroups.answered, share: ratio(replyGroups.answered, inquiryRowCount) },
    { status: '待处理', count: replyGroups.pending, share: ratio(replyGroups.pending, inquiryRowCount) },
    { status: '无方案或已撤销', count: replyGroups.closed, share: ratio(replyGroups.closed, inquiryRowCount) },
  ]

  // ── TOP 客户 / 业务员（按明细行聚合，抽样口径）─────────────────────────
  const customerAgg = new Map()
  const principalAgg = new Map()
  for (const record of quotationRecords) {
    const amount = num(record.total_amount)
    const customerName = str(record.customer_name)
    const principalName = str(record.principal_name)
    if (customerName) {
      let item = customerAgg.get(customerName)
      if (!item) {
        item = { name: customerName, amount: 0, count: 0 }
        customerAgg.set(customerName, item)
      }
      item.amount += amount
      item.count += 1
    }
    if (principalName) {
      let item = principalAgg.get(principalName)
      if (!item) {
        item = { name: principalName, amount: 0, count: 0 }
        principalAgg.set(principalName, item)
      }
      item.amount += amount
      item.count += 1
    }
  }
  const detailAmount = sumBy(quotationRecords, (record) => record.total_amount)
  /**
   * 份额给两个口径（lead 第 5 轮要求）：
   *   · share       = 该条金额 ÷ **样本内**金额合计（detailAmount）→ 回答「在这批抽样里占几成」
   *   · shareOfTotal= 该条金额 ÷ **全量**报价金额（quotationAmount，即 KPI 用的那个数）→ 回答「对全盘占几成」
   * 只有 share 会让界面上的「占比」和同屏的 quotationAmount KPI 分母对不上
   * （一个按 150 万算、一个按 1.9 亿算），所以两个都下发，由前端按场景选。
   * 全量分母取不到时 shareOfTotal 给 null，不给 0 冒充。
   */
  const shareOfTotal = (amount) => (quotationAmount !== null && quotationAmount > 0
    ? ratio(amount, quotationAmount)
    : null)
  const topQuotationCustomers = [...customerAgg.values()]
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 10)
    .map((item) => ({
      name: item.name,
      amount: Number(item.amount.toFixed(2)),
      count: item.count,
      share: ratio(item.amount, detailAmount),
      shareOfTotal: shareOfTotal(item.amount),
    }))
  const topQuotationPrincipals = [...principalAgg.values()]
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 10)
    .map((item) => ({
      name: item.name,
      amount: Number(item.amount.toFixed(2)),
      count: item.count,
      share: ratio(item.amount, detailAmount),
      shareOfTotal: shareOfTotal(item.amount),
    }))

  // ── 最近明细（抽样口径）────────────────────────────────────────────────
  const recentInquiries = [...inquiryRecords]
    .sort((a, b) => String(b.add_time || '').localeCompare(String(a.add_time || '')))
    .slice(0, 20)
    .map((record) => ({
      code: str(record.code) ?? null,
      date: dateOnly(record.add_time) ?? null,
      customerName: str(record.customer_name) ?? null,
      principalName: str(record.principal_name) ?? null,
      replyStatus: str(record.reply_status_name) ?? null,
      replyStatusCode: numOrNull(record.reply_status),
      products: numOrNull(record.product_count),
    }))
  const recentQuotations = [...quotationRecords]
    .sort((a, b) => String(b.add_time || '').localeCompare(String(a.add_time || '')))
    .slice(0, 20)
    .map((record) => ({
      code: str(record.code) ?? null,
      date: dateOnly(record.add_time) ?? null,
      customerName: str(record.customer_name) ?? null,
      principalName: str(record.principal_name) ?? null,
      amount: numOrNull(record.total_amount),
      progress: str(record.progress_name) ?? null,
      progressCode: numOrNull(record.progress),
      products: numOrNull(record.product_count),
    }))

  const note =
    `口径：询价单数 ${inquiryDocCount ?? '未知'} / 报价单数 ${quotationDocCount ?? '未知'} 取自 metrics.doc_count（全量口径）；`
    + `明细行数 询价 ${inquiryRowCount} / 报价 ${quotationRowCount} 受上游 rowLimit=${rowLimit} 截断，`
    + `因此「待处理询价数 / 回复状态分布 / TOP 客户 / TOP 业务员 / 最近明细」均为抽样口径。`
    + `报价金额合计 ${quotationAmount ?? '未知'} 取 metrics.amount_total（合并口径：同一客户同一天多份报价只保留最新一份，`
    + `合并前金额 ${numOrNull(quotationMetrics.amount_total_before_merge) ?? '未知'}，合并掉 ${numOrNull(quotationMetrics.merged_away_count) ?? '未知'} 份，`
    + `单据数合并前 ${numOrNull(quotationMetrics.doc_count_before_merge) ?? '未知'} 份）。`
    + `询价→报价、报价→订单两个转化率的分子分母来自不同接口、不同客户集，仅作趋势参考，不等于真实转化率。`
    + `其中「报价→订单」= 区间订单数 ÷ 报价单数，两个计数口径不同，该值**可能大于 1**`
    + `（说明区间订单数多于平台报价单数，相当比例订单并非由报价单转化而来），不是概率，不能按 0~1 解读；`
    + `「询价→报价」= 报价单数 ÷ 询价单数，同样可能大于 1。`
    + `TOP10 是 ${quotationRowCount} 份抽样内的排名，不是全量 TOP10；占比已同时给出样本内（share）与全量（shareOfTotal）两个口径。`

  return {
    // 全量口径
    inquiryDocCount,
    quotationDocCount,
    quotationAmount,
    avgQuotationAmount: ratio(quotationAmount, quotationDocCount),
    inquiryToQuotationRate: ratio(quotationDocCount, inquiryDocCount),
    quotationToOrderRate: ratio(periodOrderCount, quotationDocCount),
    // 抽样口径
    sampled: true,
    basis: 'sample',
    sampleSize: quotationRowCount,
    totalKnown: quotationDocCount,
    /** 抽样明细的金额合计（样本口径，= TOP 各项 share 的分母） */
    sampleAmount: Number(num(detailAmount).toFixed(2)),
    /** 抽样金额占全量报价金额的比例（样本覆盖率） */
    sampleShare: ratio(detailAmount, quotationAmount),
    inquiryRowCount,
    quotationRowCount,
    pendingInquiryCount: replyGroups.pending,
    replyStatus,
    topQuotationCustomers,
    topQuotationPrincipals,
    recentInquiries,
    recentQuotations,
    note,
  }
}

// ---------------------------------------------------------------------------
// 主取数编排
// ---------------------------------------------------------------------------

/**
 * 取一份完整的销售作战看板数据。
 *
 * 编排原则：
 *   ① 并行 + 预算：主批次 / 同期批次用 Promise.allSettled 并行，
 *      全局调用预算 exhaustiveBudget 触顶即降级并写中文告警（不静默截断）。
 *   ② 失败不 reject：单个工具失败 → 该板块空值 + warnings + calls[].ok=false。
 *   ③ 抽样要说清楚：ABC / 赛道 / 跟进达标都是抽样口径，status 明确写 sampled，
 *      并给出 sampleCustomers 与 coverageShare。
 */
async function collectSalesDashboard(ctx, settings, req, toolPlan) {
  const startedAt = Date.now()
  const { startDate, endDate, squad, member } = req
  /**
   * 实际生效的 MCP 工具全名。
   * 本机 DSH 的连接器名不一定叫 erp / std（换设备常变），所以工具名按
   * 「前缀发现方案」拼（见 PREFIX_GROUPS / resolveToolPrefixes）。
   * 这里用局部 const TOOL 遮蔽模块级默认名，下面所有 run(TOOL.xxx) 自动用实际名，
   * 不用逐个改 27 处调用点。
   */
  const TOOL = (toolPlan && toolPlan.names) || buildToolPlan(resolveToolPrefixes({}, [])).names
  /** 工具全名 → 备选前缀拼出来的备选全名（工具不可见时串行重试）。 */
  const alternatesByName = (toolPlan && toolPlan.alternatesByName) || new Map()

  const calls = []
  const warnings = []
  // 前缀没被发现、只能回退默认时，先把话说明白，别让用户对着「工具不可见」猜。
  for (const text of (toolPlan && toolPlan.warnings) || []) warnings.push(text)
  const timeoutMs = Number(settings.requestTimeoutMs) > 0 ? Number(settings.requestTimeoutMs) : DEFAULTS.requestTimeoutMs
  const rowLimit = Math.max(1, Math.floor(num(settings.rowLimit)) || DEFAULTS.rowLimit)
  const budgetLimit = Math.max(1, Math.floor(num(settings.exhaustiveBudget)) || DEFAULTS.exhaustiveBudget)
  const tierSampleSize = Math.max(0, Math.floor(num(settings.tierSampleSize)) || 0)
  const customerSampleSize = Math.max(0, Math.floor(num(settings.customerSampleSize)) || 0)
  const visitSampleSize = Math.max(0, Math.floor(num(settings.visitSampleSize)) || 0)
  const stdProbeBudget = Math.max(0, Math.floor(num(settings.stdProbeBudget)) || 0)
  /** 智能预警阈值（可被 settings.thresholds 覆盖；解析后一定是合法且完整的数字）。 */
  const TH = resolveThresholds(settings.thresholds)
  /**
   * customer_analysis 单独放宽到 500（ERP 服务端硬上限）。
   *
   * 为什么不能跟着 rowLimit(100) 走：客户档案按「最近成交」排序返回，limit=100 时
   * 「新增客户数」只剩最近成交的 100 个客户里、首次成交落在区间内的那些 ——
   * 实测 2026=12 / 2025=3 / 2024=1，那不是新增客户数，是**样本伪值**。
   * 取满 500 仍然是抽样（ERP 客户总数 320+），所以输出侧必须标 sampled。
   */
  const customerLimit = Math.min(500, Math.max(rowLimit, 500))

  let budgetUsed = 0

  /**
   * 统一的 MCP 调用包装：记账（calls[]）、限时、预算、失败降级。
   * 返回值永远不抛错，调用方只需看 ok。
   */
  /**
   * @param {number} [timeoutOverrideMs] 单次调用的超时覆盖（默认用 settings.requestTimeoutMs）。
   *   上游 std MCP 服务单条查询本身就要 6~8 秒、且**单 session 内串行处理**，
   *   慢查询必须单独放宽超时，否则会被 AbortSignal 掐掉。
   */
  const run = async (tool, label, args, timeoutOverrideMs) => {
    if (budgetUsed >= budgetLimit) {
      const note = `调用预算已达上限（${budgetLimit} 次），${label} 未执行`
      calls.push({ tool, label, ok: false, ms: 0, note })
      warnings.push(note)
      return { ok: false, value: null }
    }
    budgetUsed += 1
    const t0 = Date.now()
    try {
      const callTimeoutMs = Number(timeoutOverrideMs) > 0 ? Number(timeoutOverrideMs) : timeoutMs
      const value = await callTool(ctx, tool, args, callTimeoutMs, alternatesByName.get(tool))
      calls.push({ tool, label, ok: true, ms: Date.now() - t0, note: '' })
      return { ok: true, value }
    } catch (error) {
      const note = compactUpstreamMessage(error && error.message ? error.message : String(error))
      calls.push({ tool, label, ok: false, ms: Date.now() - t0, note })
      warnings.push(`${label}取数失败：${note}`)
      return { ok: false, value: null }
    }
  }

  const prev = { startDate: shiftYears(startDate, 1), endDate: shiftYears(endDate, 1) }
  const prev2 = { startDate: shiftYears(startDate, 2), endDate: shiftYears(endDate, 2) }
  const lookbackStart = addDays(endDate, -365) || startDate

  // ── 主批次：本区间全部核心数据 ─────────────────────────────────────────
  const mainResults = await Promise.allSettled([
    run(TOOL.total, '总业绩与趋势', {
      start_date: startDate, end_date: endDate, trend: 'month', top_limit: 20,
    }),
    run(TOOL.ranking, '销售人员排行', {
      start_date: startDate, end_date: endDate, sort_by: 'signing_amount', limit: 100,
    }),
    // 销售成员明细：新兵业绩要按人给数，而 sales_performance_ranking 不带 username/job_no，
    // 没法把 staff_info 的花名册（job_no=YX90061）可靠地接到 ERP 的成员行上。
    // member_performance_analysis 才有 username ←→ job_no 这条稳定主键。
    run(TOOL.member, '销售成员业绩明细', {
      start_date: startDate, end_date: endDate, limit: 200,
    }),
    run(TOOL.collection, '订单与回款分析', {
      start_date: startDate, end_date: endDate, order_status: 'all', limit: rowLimit,
    }),
    run(TOOL.customer, '客户档案与成交', {
      start_date: startDate, end_date: endDate, limit: customerLimit,
    }),
    run(TOOL.quotation, '报价单明细', {
      start_date: startDate, end_date: endDate, view: 'detail', include_detail: true, limit: rowLimit,
    }),
    run(TOOL.inquiry, '询价单明细', {
      start_date: startDate, end_date: endDate, view: 'detail', include_detail: true, limit: rowLimit,
    }),
    run(TOOL.afterSale, '售后申请', {
      start_date: startDate, end_date: endDate, limit: rowLimit,
    }),
    run(TOOL.performance, '绩效档位分布', {
      year: Number(endDate.slice(0, 4)), month: Number(endDate.slice(5, 7)),
    }),
    run(TOOL.staff, '员工花名册', { limit: 500 }),
    run(TOOL.quotation, '报价单按月趋势', {
      start_date: startDate, end_date: endDate, view: 'by_month', include_detail: false, limit: rowLimit,
    }),
    run(TOOL.inquiry, '询价单按月趋势', {
      start_date: startDate, end_date: endDate, view: 'by_month', include_detail: false, limit: rowLimit,
    }),
    // 近 12 个月窗口：沉睡客户需要「历史上买过、最近没买」的客户，
    // 只查本区间会一个都查不出来（区间内有成交的客户 last_order_time 必然很新）。
    run(TOOL.customer, '客户档案（近12个月，用于沉睡客户）', {
      start_date: lookbackStart, end_date: endDate, limit: customerLimit,
    }),
  ])

  // ── 同期批次：去年同期 + 前年同期（同比 + 三年对比）────────────────────
  const yearResults = await Promise.allSettled([
    run(TOOL.total, `总业绩与趋势（${prev.startDate.slice(0, 4)}同期）`, {
      start_date: prev.startDate, end_date: prev.endDate, trend: 'month', top_limit: 20,
    }),
    run(TOOL.ranking, `销售人员排行（${prev.startDate.slice(0, 4)}同期）`, {
      start_date: prev.startDate, end_date: prev.endDate, sort_by: 'signing_amount', limit: 100,
    }),
    run(TOOL.quotation, `报价单（${prev.startDate.slice(0, 4)}同期）`, {
      start_date: prev.startDate, end_date: prev.endDate, view: 'detail', include_detail: false, limit: rowLimit,
    }),
    run(TOOL.inquiry, `询价单（${prev.startDate.slice(0, 4)}同期）`, {
      start_date: prev.startDate, end_date: prev.endDate, view: 'detail', include_detail: false, limit: rowLimit,
    }),
    run(TOOL.customer, `客户档案（${prev.startDate.slice(0, 4)}同期）`, {
      start_date: prev.startDate, end_date: prev.endDate, limit: customerLimit,
    }),
    run(TOOL.total, `总业绩与趋势（${prev2.startDate.slice(0, 4)}同期）`, {
      start_date: prev2.startDate, end_date: prev2.endDate, trend: 'month', top_limit: 20,
    }),
    run(TOOL.ranking, `销售人员排行（${prev2.startDate.slice(0, 4)}同期）`, {
      start_date: prev2.startDate, end_date: prev2.endDate, sort_by: 'signing_amount', limit: 100,
    }),
    run(TOOL.quotation, `报价单（${prev2.startDate.slice(0, 4)}同期）`, {
      start_date: prev2.startDate, end_date: prev2.endDate, view: 'detail', include_detail: false, limit: rowLimit,
    }),
    run(TOOL.inquiry, `询价单（${prev2.startDate.slice(0, 4)}同期）`, {
      start_date: prev2.startDate, end_date: prev2.endDate, view: 'detail', include_detail: false, limit: rowLimit,
    }),
    run(TOOL.customer, `客户档案（${prev2.startDate.slice(0, 4)}同期）`, {
      start_date: prev2.startDate, end_date: prev2.endDate, limit: customerLimit,
    }),
  ])

  const ok = (result) => (result && result.status === 'fulfilled' ? result.value : { ok: false, value: null })
  const main = mainResults.map(ok)
  const years = yearResults.map(ok)

  const mainTotal = unwrapData(main[0].value)
  const mainRanking = unwrapData(main[1].value)
  const mainMember = unwrapData(main[2].value)
  const mainCollection = unwrapData(main[3].value)
  const mainCustomer = unwrapData(main[4].value)
  const mainQuotation = unwrapData(main[5].value)
  const mainInquiry = unwrapData(main[6].value)
  const mainAfterSale = unwrapData(main[7].value)
  const mainPerformance = unwrapData(main[8].value)
  const mainStaff = unwrapData(main[9].value)
  const quoteByMonth = unwrapData(main[10].value)
  const inquiryByMonth = unwrapData(main[11].value)
  const lookbackCustomer = unwrapData(main[12].value)

  const prevTotal = unwrapData(years[0].value)
  const prevRanking = unwrapData(years[1].value)
  const prevQuotation = unwrapData(years[2].value)
  const prevInquiry = unwrapData(years[3].value)
  const prevCustomer = unwrapData(years[4].value)
  const prev2Total = unwrapData(years[5].value)
  const prev2Ranking = unwrapData(years[6].value)
  const prev2Quotation = unwrapData(years[7].value)
  const prev2Inquiry = unwrapData(years[8].value)
  const prev2Customer = unwrapData(years[9].value)

  const overviewRaw = sectionOf(mainTotal, 'overview') || {}
  const trendRows = rowsOf(mainTotal, ['trend'])
  const rankingRows = rowsOf(mainRanking, ['ranking'])
  /**
   * 梯队名乱码归并（见 metrics.repairSquadName 的说明）。
   * ERP 里有个 0 业绩占位成员「占位成员01」，department_name 是坏字节解出来的
   * "<3 个 U+FFFD 替换字符>狼特战队"。它只在 top-100 截断时偶尔被切进来，一旦出现就会在页面上多出一条
   * 「0 人的假梯队」。这里把它按最长公共后缀归并回「战狼特战队」，并记一条告警，
   * 让「做过归并」这件事在页面上看得见，而不是悄悄改数。
   *
   * 放在这里（而不是梯队聚合处）是因为筛选条件 matchFilter 也按梯队名过滤，
   * 归并必须在筛选之前完成，否则「按梯队筛选」会漏掉归并后的成员。
   */
  const rawSquadNames = uniqueStrings(rankingRows.map((r) => r.department_name))
  const cleanSquadNames = rawSquadNames.filter((n) => !n.includes('\uFFFD'))
  const squadNameFix = new Map()
  for (const raw of rawSquadNames) {
    if (!raw.includes('\uFFFD')) continue
    const fixed = metrics.repairSquadName(raw, cleanSquadNames)
    // 告警里把 U+FFFD 换成 □，否则页面上会显示成方块，用户看不出这是「上游数据坏了」
    // 还是「我们渲染坏了」；同时写明坏字节个数，证据不丢。
    const readable = String(raw).replace(/\uFFFD/g, '□')
    const badCount = (String(raw).match(/\uFFFD/g) || []).length
    if (fixed) {
      squadNameFix.set(raw, fixed)
      warnings.push(
        `ERP 返回的梯队名「${readable}」含 ${badCount} 个坏字节（0 业绩占位成员），已按最接近的已知梯队归并为「${fixed}」。`,
      )
    } else {
      warnings.push(
        `ERP 返回的梯队名「${readable}」含 ${badCount} 个坏字节且无法归并到已知梯队，已按原名保留（该梯队人数与业绩多为 0）。`,
      )
    }
  }
  const squadNameOfRow = (row) => {
    const raw = str(row?.department_name)
    if (squadNameFix.has(raw)) return squadNameFix.get(raw)
    // 去年同期等其它批次的行不在上面的归并表里，这里按同一规则现场归并一次，
    // 否则「按梯队筛选」在对比年份上会漏人。
    if (raw.includes('\uFFFD')) {
      const fixed = metrics.repairSquadName(raw, cleanSquadNames)
      if (fixed) return fixed
    }
    return raw
  }
  const collectionRaw = sectionOf(mainCollection, 'overview') || {}
  const orderRows = rowsOf(mainCollection, ['orders'])
  const customerRows = rowsOf(mainCustomer, ['customers'])
  const customerSales = rowsOf(mainCustomer, ['sales'])
  const quotationMetrics = sectionOf(mainQuotation, 'metrics') || {}
  const quotationRecords = rowsOf(mainQuotation, ['records'])
  const inquiryMetrics = sectionOf(mainInquiry, 'metrics') || {}
  const inquiryRecords = rowsOf(mainInquiry, ['records'])
  const afterSaleRows = rowsOf(mainAfterSale, ['data', 'records', 'after_sales'])
  /**
   * 售后数据本身取到了吗（区别于「取到了但一条记录都没有」）。
   *
   * std 服务整台宕机时，after_sale_management_query 调用失败 → afterSaleRows 为空，
   * 于是 closed / open / unknownState 全是 0。此时若照着算，闭环率就是「0%」——
   * 那是把「没取到数」说成「一单都没闭环」。所以这里把「工具失败」单独标出来，
   * 让闭环率按不可得（null）下发。
   */
  const afterSaleAvailable = Boolean(main[7] && main[7].ok)
  const performanceRows = rowsOf(sectionOf(mainPerformance, 'level_distribution') ?? mainPerformance, ['level_distribution'])
  const staffRows = rowsOf(mainStaff, ['data', 'records'])

  // ── STD 品牌判定（**签单金额口径**，提前启动与后续 ERP 取数并行）──────────
  /**
   * 用户 2026-11-04 明确要求：STD 品牌占比要看**签单金额**，不是报价单金额。
   *
   * 但 ERP 的订单行**不带货号**（sales_order_collection_analysis 的 orders[]
   * 只有 sale_code / 客户 / 金额，没有 goods_code），签单额本身没有货号维度。
   * 唯一能建立「订单 ↔ 货号」对应关系的入口是
   * product_efficiency_analysis(metric='inventory_shipping') 的 details[]：
   * 每行有 sale_code + goods_code（销售出库明细）。
   *
   * 于是口径链条是：
   *   ① 取区间内各月的出库明细 → sale_code → Set(goods_code)；
   *   ② 取同样的月份窗口的订单签单额 → sale_code → signing_amount；
   *   ③ 把每张订单的签单额**按货号行数平均分摊**到它的各个货号上；
   *   ④ 对出现过的货号逐个 std_product_info_query(code=…) 精确判定是否 STD；
   *   ⑤ 汇总 STD / 非 STD 的签单额。
   *
   * 三个上游硬限制决定了实现细节（全部为实机实测，不是猜的）：
   *   · 出库明细 details 单次**硬顶 500 行**（2026-10 实际 739 行）→ 必须按日期对半细分；
   *   · 只有「区间内已出库」的订单才有货号，2026-10 实测 253/463 单、
   *     **只覆盖 46.5% 签单额** → 覆盖率必须显式落到字段里，绝不能当成全量；
   *   · std_product_info_query **拉不全 STD 货号目录**（limit 硬顶 500，按前缀拆也是 500），
   *     只能逐货号探测，单条 6~8 秒且服务端串行 → 必须串行 + 墙钟预算 + 货号判定缓存。
   *   · std MCP 会整段宕机（实测 8006 ECONNREFUSED）→ 取数失败一律降级为 null + 中文告警，
   *     绝不把「取不到」写成 0%。
   *
   * 多行订单按行数平均分摊是**近似**：单行订单精确，多行订单（实测 96/253 单、
   * 平均 1.89 行）金额在行间均分，与真实行金额有偏差 —— 这条写进 note。
   */
  const goodsMap = buildGoodsMap(quotationRecords)
  const goodsList = [...goodsMap.values()].sort((a, b) => b.amount - a.amount)
  const stdVerdictTtlMs = STD_VERDICT_TTL_MS
  const stdVerdictDir = diskCacheDir(settings)
  const stdVerdicts = loadStdVerdicts(stdVerdictDir, stdVerdictTtlMs)
  const stdSigningMonthsMax = Math.max(1, Math.floor(num(settings.stdSigningMonthsMax)) || 4)
  const stdSigningShipBudgetMs = Math.max(10000, Number(settings.stdSigningShipBudgetMs) || 45000)
  const stdSigningTimeoutMs = Math.max(timeoutMs, 60000)
  const stdSigningProbeBudgetMs = Math.max(30000, Number(settings.stdProbeBudgetMs) || 90000)

  const probed = new Map() // 货号 → true / false（判定失败的货号**不入表**，对外按 null）
  let probeTargets = [] // [{ code, amount, orders }]，按签单额降序
  const stdSigning = {
    basis: 'signing',
    ok: false,
    monthsBack: 0,
    monthsMax: stdSigningMonthsMax,
    windowFrom: null,
    windowTo: null,
    periodSigningAmount: 0,
    windowSigningAmount: 0,
    signingAmount: 0,
    stdSigningAmount: 0,
    nonStdSigningAmount: 0,
    stdShare: null,
    coverageSigningShare: null,
    windowShareOfPeriod: null,
    ordersTotal: 0,
    ordersWithGoods: 0,
    shippingRows: 0,
    shippingTruncated: false,
    goodsAmountTotal: 0,
    goodsTotal: 0,
    goodsJudged: 0,
    goodsUnknown: 0,
    goodsProbed: 0,
    goodsCached: 0,
    budget: stdProbeBudget,
    stopped: 0,
    approvalNote: null,
    // 卡在哪一步：'shipping' | 'probe' | 'no-goods' | null（null = 没卡住）。
    // 在 stdProbePromise await 之后由 stdBlockedStage() 填，前端据此展示而不是只看到一句「不可得」。
    blockedAt: null,
    note: '',
  }
  const stdSigningPromise = (async () => {
    /** ① 月份窗口：从区间末月往前数，最多 stdSigningMonthsMax 个月，且不越出区间。 */
    const windows = []
    let cursor = endDate.slice(0, 7)
    for (let i = 0; i < stdSigningMonthsMax; i += 1) {
      const parts = cursor.split('-')
      const year = Number(parts[0])
      const month = Number(parts[1])
      if (!Number.isFinite(year) || !Number.isFinite(month)) break
      const firstDay = `${cursor}-01`
      const lastDay = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)
      const from = firstDay < startDate ? startDate : firstDay
      const to = lastDay > endDate ? endDate : lastDay
      if (from <= to) windows.push({ month: cursor, startDate: from, endDate: to })
      cursor = month === 1
        ? `${year - 1}-12`
        : `${year}-${String(month - 1).padStart(2, '0')}`
      if (cursor < startDate.slice(0, 7)) break
    }
    if (windows.length === 0) return
    const windowFrom = windows[windows.length - 1].startDate
    const windowTo = windows[0].endDate

    /** ② 出库明细：订单 → 货号集合（按日期对半细分突破 500 行硬顶）。 */
    const shipBySale = new Map()
    const shipStartedAt = Date.now()
    const SHIP_SLICE_LIMIT = 500
    const SHIP_MAX_DEPTH = 2
    let shipOutOfBudget = false
    const fetchShipping = async (window, depth) => {
      if (shipOutOfBudget) return
      if (Date.now() - shipStartedAt >= stdSigningShipBudgetMs) {
        shipOutOfBudget = true
        stdSigning.shippingTruncated = true
        return
      }
      const label = depth > 0
        ? `出库明细 ${window.startDate}~${window.endDate}（第 ${depth + 1} 级细分）`
        : `出库明细 ${window.startDate}~${window.endDate}`
      const result = await run(TOOL.shipping, label, {
        metric: 'inventory_shipping',
        start_date: window.startDate,
        end_date: window.endDate,
        limit: SHIP_SLICE_LIMIT,
      }, stdSigningTimeoutMs)
      if (!result.ok) return
      const details = rowsOf(result.value, ['details'])
      stdSigning.shippingRows += details.length
      for (const row of details) {
        const sale = str(row.sale_code)
        const code = str(row.goods_code)
        if (!sale || !code) continue
        let set = shipBySale.get(sale)
        if (!set) {
          set = new Set()
          shipBySale.set(sale, set)
        }
        set.add(code)
      }
      const summary = sectionOf(result.value, 'summary') || {}
      const expected = numOrNull(summary.total_count)
      // 判截断与订单分片同一铁律：看**这一次响应自己**的 summary.total_count，
      // 不看「返回行数是否顶到 limit」（limit 传多大上游都只给 500 行）。
      if (!isOrderSliceTruncated(details.length, expected, SHIP_SLICE_LIMIT)) return
      const span = diffDays(window.startDate, window.endDate)
      if (depth >= SHIP_MAX_DEPTH || span === null || span < 1) {
        stdSigning.shippingTruncated = true
        return
      }
      const mid = addDays(window.startDate, Math.floor(span / 2))
      if (!mid || mid >= window.endDate) {
        stdSigning.shippingTruncated = true
        return
      }
      await fetchShipping({ startDate: window.startDate, endDate: mid }, depth + 1)
      const next = addDays(mid, 1)
      if (next) await fetchShipping({ startDate: next, endDate: window.endDate }, depth + 1)
    }
    for (const window of windows) await fetchShipping(window, 0)

    /** ③ 同期订单签单额：sale_code → 签单额（同样按日期细分突破 500 行硬顶）。 */
    const orderAmount = new Map()
    const ORDER_SLICE_LIMIT = 500
    const ORDER_MAX_DEPTH = 2
    let ordersTruncated = false
    const fetchWindowOrders = async (window, depth) => {
      const label = depth > 0
        ? `签单额 ${window.startDate}~${window.endDate}（第 ${depth + 1} 级细分）`
        : `签单额 ${window.startDate}~${window.endDate}`
      const result = await run(TOOL.collection, label, {
        start_date: window.startDate,
        end_date: window.endDate,
        order_status: 'all',
        limit: ORDER_SLICE_LIMIT,
      })
      if (!result.ok) return
      const orders = rowsOf(result.value, ['orders'])
      for (const order of orders) {
        const sale = str(order.sale_code)
        if (!sale) continue
        const amount = num(order.signing_amount)
        orderAmount.set(sale, (orderAmount.get(sale) || 0) + (Number.isFinite(amount) ? amount : 0))
      }
      const overview = sectionOf(result.value, 'overview') || {}
      const expected = numOrNull(overview.order_count)
      if (!isOrderSliceTruncated(orders.length, expected, ORDER_SLICE_LIMIT)) return
      const span = diffDays(window.startDate, window.endDate)
      if (depth >= ORDER_MAX_DEPTH || span === null || span < 1) {
        ordersTruncated = true
        return
      }
      const mid = addDays(window.startDate, Math.floor(span / 2))
      if (!mid || mid >= window.endDate) {
        ordersTruncated = true
        return
      }
      await fetchWindowOrders({ startDate: window.startDate, endDate: mid }, depth + 1)
      const next = addDays(mid, 1)
      if (next) await fetchWindowOrders({ startDate: next, endDate: window.endDate }, depth + 1)
    }
    for (const window of windows) await fetchWindowOrders(window, 0)

    /** ④ 签单额按货号行数平均分摊到各货号。 */
    const goodsAmount = new Map()
    const goodsOrders = new Map()
    let windowSigning = 0
    let ordersWithGoods = 0
    let ordersTotal = 0
    for (const [sale, amount] of orderAmount.entries()) {
      ordersTotal += 1
      const safeAmount = Number.isFinite(amount) ? amount : 0
      windowSigning += safeAmount
      const set = shipBySale.get(sale)
      if (!set || set.size === 0) continue
      ordersWithGoods += 1
      const per = safeAmount / set.size
      for (const code of set) {
        goodsAmount.set(code, (goodsAmount.get(code) || 0) + per)
        goodsOrders.set(code, (goodsOrders.get(code) || 0) + 1)
      }
    }
    probeTargets = [...goodsAmount.entries()]
      .map(([code, amount]) => ({ code, amount, orders: goodsOrders.get(code) || 0 }))
      .filter((item) => item.amount > 0)
      .sort((a, b) => b.amount - a.amount)
    const goodsAmountTotal = sumBy(probeTargets, (item) => item.amount)

    /** ⑤ 逐货号判定：先吃缓存，再按签单额降序探测，受「个数预算 + 墙钟预算 + 覆盖 95% 金额」三重约束。 */
    let judgedAmount = 0
    for (const target of probeTargets) {
      const cached = stdVerdicts.get(target.code)
      if (!cached) continue
      probed.set(target.code, cached.std)
      stdSigning.goodsCached += 1
      judgedAmount += target.amount
    }
    const probeStartedAt = Date.now()
    const AMOUNT_SHARE_TARGET = 0.95
    for (const target of probeTargets) {
      if (probed.has(target.code)) continue
      if (goodsAmountTotal > 0 && judgedAmount / goodsAmountTotal >= AMOUNT_SHARE_TARGET) break
      if (stdSigning.goodsProbed >= stdProbeBudget) {
        stdSigning.stopped += 1
        continue
      }
      if (Date.now() - probeStartedAt >= stdSigningProbeBudgetMs) {
        stdSigning.stopped += 1
        continue
      }
      const result = await run(
        TOOL.stdProduct,
        `STD判定(${target.code})`,
        { page_type: '1', code: target.code },
        stdSigningTimeoutMs,
      )
      stdSigning.goodsProbed += 1
      if (!result.ok) continue
      const rows = rowsOf(unwrapData(result.value), ['data', 'records'])
      // 上游 code 过滤是**前缀/LIKE**匹配，会多返回更长的货号 —— 必须精确比对。
      const hit = rows.find((row) => String(row?.code ?? '') === target.code)
      const isStd = Boolean(hit)
      probed.set(target.code, isStd)
      stdVerdicts.set(target.code, { std: isStd, at: Date.now() })
      judgedAmount += target.amount
    }
    if (stdSigning.goodsProbed > 0) saveStdVerdicts(stdVerdictDir, stdVerdicts, stdVerdictTtlMs)

    /** ⑥ 汇总。 */
    let stdAmount = 0
    let nonStdAmount = 0
    for (const target of probeTargets) {
      const verdict = probed.get(target.code)
      if (verdict === true) stdAmount += target.amount
      else if (verdict === false) nonStdAmount += target.amount
    }
    const judgedSigning = stdAmount + nonStdAmount
    const periodSigning = num(collectionRaw.signing_amount) || sumBy(rankingRows, (r) => r.signing_amount)
    const judgedCount = probeTargets.filter((t) => probed.has(t.code)).length

    stdSigning.monthsBack = windows.length
    stdSigning.windowFrom = windowFrom
    stdSigning.windowTo = windowTo
    stdSigning.periodSigningAmount = Number.isFinite(periodSigning) ? periodSigning : 0
    stdSigning.windowSigningAmount = windowSigning
    stdSigning.signingAmount = judgedSigning
    stdSigning.stdSigningAmount = stdAmount
    stdSigning.nonStdSigningAmount = nonStdAmount
    stdSigning.stdShare = judgedSigning > 0 ? ratio(stdAmount, judgedSigning) : null
    stdSigning.coverageSigningShare = stdSigning.periodSigningAmount > 0
      ? ratio(judgedSigning, stdSigning.periodSigningAmount)
      : null
    stdSigning.windowShareOfPeriod = stdSigning.periodSigningAmount > 0
      ? ratio(windowSigning, stdSigning.periodSigningAmount)
      : null
    stdSigning.ordersTotal = ordersTotal
    stdSigning.ordersWithGoods = ordersWithGoods
    stdSigning.goodsAmountTotal = goodsAmountTotal
    stdSigning.goodsTotal = probeTargets.length
    stdSigning.goodsJudged = judgedCount
    stdSigning.goodsUnknown = probeTargets.length - judgedCount
    stdSigning.ok = judgedCount > 0 && judgedSigning > 0
    stdSigning.approvalNote = ordersTruncated
      ? `签单额订单分片细分 ${ORDER_MAX_DEPTH} 轮后仍有缺口，分摊基数可能偏小。`
      : null
    const parts = []
    parts.push(
      `口径：**签单金额**。取 ${windowFrom}~${windowTo}（近 ${windows.length} 个月）的销售出库明细，`
      + '把每张订单的签单额按货号行数平均分摊到各货号，再逐个判定是否 STD 产品。',
    )
    parts.push(
      `该窗口有 ${ordersWithGoods}/${ordersTotal} 单存在出库明细（其余订单未出库，无法归属货号），`
      + `窗口签单额 ${windowSigning.toFixed(2)} 元占区间签单额 `
      + `${(ratio(windowSigning, stdSigning.periodSigningAmount) === null ? '未知' : (ratio(windowSigning, stdSigning.periodSigningAmount) * 100).toFixed(1) + '%')}。`,
    )
    parts.push(
      `已判定 ${judgedCount}/${probeTargets.length} 个货号（缓存命中 ${stdSigning.goodsCached}、`
      + `本次探测 ${stdSigning.goodsProbed}），覆盖该窗口分摊金额 `
      + `${(goodsAmountTotal > 0 ? (judgedAmount / goodsAmountTotal * 100).toFixed(1) : '0.0')}%。`,
    )
    if (stdSigning.stopped > 0) {
      parts.push(`有 ${stdSigning.stopped} 个货号因探测预算（${stdProbeBudget} 个 / ${stdSigningProbeBudgetMs} ms）未判定，按未知处理，不计入分母。`)
    }
    if (stdSigning.shippingTruncated) parts.push('出库明细在墙钟预算内未取全，覆盖率可能偏低。')
    if (stdSigning.approvalNote) parts.push(stdSigning.approvalNote)
    parts.push('多行订单按行数均摊金额属近似（实测多行订单约占 38%、平均 1.89 行）。')
    if (!stdSigning.ok) {
      // 卡点要分清：是「出库明细就没取到」，还是「货号判定全失败」——
      // 两者要修的东西完全不一样（一个修 product_efficiency_analysis，一个修 std 产品表）。
      parts.push(`**${stdBlockedText(stdBlockedStage(stdSigning), stdSigning)}**`)
    }
    stdSigning.note = parts.join('')
  })()
  stdSigningPromise.catch(() => {}) // 兜底：绝不产生未处理的 rejection
  // 兼容旧命名：下游有多处引用 stdProbePromise / stdProbeStopped。
  const stdProbePromise = stdSigningPromise

  // ── 客户基础档案（客户主数据 → 客户成交 → 统一索引）────────────────────
  /**
   * 把 customer_analysis 的 customers[] 与 sales[] 拼成一张客户视图。
   * ERP 里 customers[].id 是主键、customer_id 是客户编码；sales[] 里对应
   * customer_pk / customer_id。两条线的键不完全一致，所以**双键并查**，
   * 先主键后编码，谁先命中用谁。
   */
  const customerIndex = buildCustomerIndex(customerRows, customerSales)

  // customer_analysis 的 customers[] 只给 principal_id（负责人 id），没有名字。
  // 成员排行表里有 member_id → member_name，用它把负责人名字补齐；
  // 对不上的保持 null（宁可空着，也不要挂错人名）。
  const memberNameById = new Map()
  for (const row of rankingRows) {
    const id = str(row.member_id)
    if (id) memberNameById.set(id, str(row.member_name))
  }
  for (const record of customerIndex.values()) {
    if (record.principalId === null || record.principalId === undefined) continue
    record.principalName = memberNameById.get(str(record.principalId)) || null
  }

  /**
   * ── 抽样池播种：用 total_performance_analysis.top_customers[] ──────────
   *
   * 为什么必须这么做（Lead 实测确认的坑）：
   *   customer_analysis 带日期区间时，返回的 data.sales[] **不是**该页所有客户的成交行，
   *   而是「前 limit 个客户里、在区间内有订单的客户」的成交行。
   *   实测：limit=500 + 日期区间 → customers 500 行，sales 只有 36 行。
   *   而 customers[] 的排序是 ERP 默认顺序（不是按成交额），
   *   所以「前 500 个客户」≠「Top 500 客户」。
   *   直接拿 sales[] 建索引去排序取 Top N，抽到的是「那几十个有成交的里的前 N 个」，
   *   实测只覆盖区间签约额的 1.9% —— ABC 结构卡和客户分档卡因此几乎没有代表性。
   *
   * top_customers[] 才是按区间成交额降序的**真实 Top 客户**（total_limit=20 调用时给 20 个），
   *   所以用它来播种：命中已有记录就把金额/单数「抬高」（Math.max，绝不覆盖成更小的值，
   *   因为 sales[] 与 top_customers 的金额口径可能不同），没命中就新建一条，
   *   保证后面能用 customer_pk 去调 customer_tier_rating / sales_customer_360 / customer_info。
   */
  const customerByPk = new Map()
  const customerByCode = new Map()
  const customerByName = new Map()
  const registerCustomer = (record) => {
    if (record.pk !== null && record.pk !== undefined) customerByPk.set(String(record.pk), record)
    if (record.code) customerByCode.set(String(record.code), record)
    if (record.name) customerByName.set(String(record.name), record)
  }
  for (const record of customerIndex.values()) registerCustomer(record)

  const topCustomerSource = rowsOf(mainTotal, ['top_customers'])
  let topCustomerSeeded = 0
  let topCustomerNew = 0
  for (const row of topCustomerSource) {
    const pk = row.customer_pk ?? null
    const code = row.customer_id ?? null
    const name = str(row.customer_name)
    const orderTotal = num(row.order_total_amount)
    const orderCount = num(row.order_count)
    let record = null
    if (pk !== null && pk !== undefined) record = customerByPk.get(String(pk)) || null
    if (!record && code !== null && code !== undefined) record = customerByCode.get(String(code)) || null
    if (!record && name) record = customerByName.get(name) || null
    if (record) {
      // 只抬高不覆盖：Math.max 保证两个口径里较大的那个胜出，绝不把大额改小。
      record.amount = Math.max(record.amount, orderTotal)
      record.orderCount = Math.max(record.orderCount, orderCount)
      topCustomerSeeded += 1
    } else {
      const key = String(pk ?? code ?? name ?? '')
      if (!key) continue
      record = {
        key,
        pk,
        code: code === null ? null : String(code),
        name,
        kind: null,
        principalId: null,
        principalName: null,
        firstDeal: null,
        area: '',
        orderCount,
        amount: orderTotal,
        backMoney: 0,
        lastOrder: null,
      }
      customerIndex.set(key, record)
      registerCustomer(record)
      topCustomerSeeded += 1
      topCustomerNew += 1
    }
  }

  // ── 抽样对象：按区间成交额降序取 Top N ─────────────────────────────────
  // 排序池 = customer_analysis 的客户档案 + top_customers 播种进来的真实 Top 客户。
  if (topCustomerSource.length === 0) {
    // 拿不到 Top 客户榜时只能回退到 customer_analysis 的成交行 —— 那不是 Top N，
    // 覆盖度会塌。必须把这件事说出来，而不是让页面上的抽样看起来像 Top N。
    warnings.push('区间 Top 客户榜不可得（total_performance_analysis 未返回 top_customers），抽样对象回退为 customer_analysis 的成交行，客户分档 / ABC 的样本覆盖率会明显偏低。')
  }
  const samplePool = [...customerIndex.values()].sort((a, b) => b.amount - a.amount)
  const tierTargets = samplePool.slice(0, tierSampleSize)
  const visitTargets = samplePool.slice(0, visitSampleSize)
  const infoTargets = samplePool.slice(0, customerSampleSize)

  const tierResults = await Promise.allSettled(
    tierTargets.map((c, i) => run(TOOL.tier, `客户分档#${i + 1}(${c.name})`, customerArgs(c))),
  )
  const visitResults = await Promise.allSettled(
    visitTargets.map((c, i) => run(TOOL.c360, `客户360#${i + 1}(${c.name})`, customerArgs(c))),
  )
  const infoResults = await Promise.allSettled(
    infoTargets.map((c, i) => run(TOOL.customerInfo, `客户基础档案#${i + 1}(${c.name})`, customerArgs(c))),
  )

  const tierSamples = []
  tierResults.forEach((result, index) => {
    if (result.status !== 'fulfilled' || !result.value?.ok) return
    const customer = tierTargets[index]
    const payload = unwrapData(result.value.value)
    const metricsRaw = sectionOf(payload, 'metrics') || {}
    const rating = sectionOf(payload, 'rating') || {}
    const qcc = sectionOf(payload, 'qcc') || {}
    tierSamples.push({
      key: customer.key,
      name: customer.name,
      code: customer.code,
      pk: customer.pk,
      tier: str(rating.tier),
      tierName: str(rating.tier_name),
      score: numOrNull(rating.total_score),
      bShare: numOrNull(metricsRaw.b_order_share),
      amount12m: num(metricsRaw.amount_12m),
      orderCount12m: num(metricsRaw.order_count_12m),
      overdueRate: numOrNull(metricsRaw.overdue_rate),
      industry: str(qcc.industry),
      subIndustry: str(qcc.sub_industry),
      insuredCount: numOrNull(qcc.insured_count),
      registCapital: numOrNull(qcc.regist_capital),
      track: classifyTrack(qcc.industry, qcc.sub_industry),
      amount: customer.amount,
      orders: customer.orderCount,
    })
  })

  const visitSamples = []
  visitResults.forEach((result, index) => {
    if (result.status !== 'fulfilled' || !result.value?.ok) return
    const customer = visitTargets[index]
    const payload = unwrapData(result.value.value)
    const profile = sectionOf(payload, 'profile') || {}
    const visits = rowsOf(payload, ['visits'])
    let inPeriod = 0
    for (const visit of visits) {
      const raw = visit && visit.data
      let when = dateOnly(visit?.add_time)
      if (raw && typeof raw === 'string') {
        try {
          const parsed = JSON.parse(raw)
          const inner = dateOnly(parsed?.time) || dateOnly(parsed?.add_time)
          if (inner) when = inner
        } catch {
          /* data 不是合法 JSON 就退回 add_time */
        }
      }
      if (!when) continue
      if (when >= startDate && when <= endDate) inPeriod += 1
    }
    visitSamples.push({
      key: customer.key,
      name: customer.name,
      kind: str(profile.customer_kind),
      visits: inPeriod,
      afterSales: rowsOf(payload, ['after_sales']).length,
    })
  })

  // customer_info 返回的是权威 customer_kind，覆盖 customer_analysis 里的粗分类。
  infoResults.forEach((result, index) => {
    if (result.status !== 'fulfilled' || !result.value?.ok) return
    const customer = infoTargets[index]
    const payload = unwrapData(result.value.value)
    const kind = str(payload.customer_kind) || str(sectionOf(payload, 'customer_kind'))
    if (!kind) return
    const record = customerIndex.get(customer.key)
    if (record) record.kind = kind
  })

  // ── STD 品牌判定（签单口径）：出库明细 → 签单额分摊 → 逐货号判定 ──────────
  // （判定已在主批次之后**提前启动**，此处只负责等它结束并汇报）
  await stdProbePromise
  // 判定卡在哪一步（shipping / probe / no-goods）。必须在 await 之后算 ——
  // 判定没跑完时 ok 还是 false，算了也是错的。
  stdSigning.blockedAt = stdBlockedStage(stdSigning)
  if (stdSigning.stopped > 0) {
    warnings.push(
      `STD 判定探测触达预算（${stdProbeBudget} 个货号 / ${stdSigningProbeBudgetMs} ms），`
      + `${stdSigning.stopped} 个货号未判定（按未知处理，不计入 STD 判定分母）。`,
    )
  }
  if (stdSigning.shippingTruncated) {
    warnings.push(
      '出库明细在墙钟预算内未取全（上游单次硬顶 500 行），签单口径 STD 占比的覆盖额可能偏低；'
      + '已按现状交付并在 std.note 中标注。',
    )
  }
  if (!stdSigning.ok && stdSigning.goodsTotal > 0) {
    warnings.push(
      'STD 品牌占比不可得：没有任何货号判定成功（std MCP 服务可能不可用），'
      + '占比按 null 处理，界面显示为「不可得」而不是 0%。',
    )
  }

  // ══════════════════════════════════════════════════════════════════════
  // 口径与派生计算
  // ══════════════════════════════════════════════════════════════════════
  const isFiltered = Boolean(squad || member)
  const filterNote = isFiltered
    ? '按梯队/业务员筛选时，总览取数来自全公司口径（total_performance_analysis 无法按人过滤），成员级数据已按筛选过滤。'
    : ''

  const prevRankingRows = rowsOf(prevRanking, ['ranking'])
  const prev2RankingRows = rowsOf(prev2Ranking, ['ranking'])

  const matchFilter = (row) => {
    if (squad && squadNameOfRow(row) !== squad) return false
    if (member && str(row.member_name) !== member) return false
    return true
  }
  const filteredRanking = rankingRows.filter(matchFilter)
  const prevFilteredRanking = prevRankingRows.filter(matchFilter)
  const targetRows = isFiltered ? filteredRanking : rankingRows
  const prevTargetRows = isFiltered ? prevFilteredRanking : prevRankingRows

  const signingByRank = sumBy(targetRows, (r) => r.signing_amount)
  const targetTotal = sumBy(targetRows, (r) => r.target_amount)
  /**
   * 全局完成率也有同一个口径问题（详见梯队行注释）：
   * 分子是全员接单额，分母只是「配了军令状」的成员的目标之和。
   * 全局数字保留（与参照看板一致），但必须把覆盖度摊开 —— 否则 64% 会被读成「大家没完成」。
   */
  const globalTargetMembers = countBy(targetRows, (r) => num(r.target_amount) > 0)
  const globalActiveMembers = countBy(targetRows, (r) => num(r.order_count) > 0)
  const globalActiveWithoutTarget = countBy(
    targetRows,
    (r) => num(r.order_count) > 0 && !(num(r.target_amount) > 0),
  )
  const globalTargetBasis = globalActiveWithoutTarget > 0 ? 'partial' : 'full'
  const globalSigningWithTarget = sumBy(
    targetRows.filter((r) => num(r.target_amount) > 0),
    (r) => r.signing_amount,
  )
  const globalTargetNote = globalTargetBasis === 'partial'
    ? `军令状目标仅覆盖 ${globalActiveMembers} 名有业绩成员中的 ${globalTargetMembers} 人（${globalActiveWithoutTarget} 人无目标），完成率被低估`
    : ''
  const targetCount = countBy(targetRows, (r) => num(r.target_amount) > 0)
  const prevSigningByRank = sumBy(prevTargetRows, (r) => r.signing_amount)
  const prevTargetTotal = sumBy(prevTargetRows, (r) => r.target_amount)

  const overviewTotal = num(overviewRaw.order_total_amount)
  const prevOverviewTotal = num(sectionOf(prevTotal, 'overview')?.order_total_amount)
  const prev2OverviewTotal = num(sectionOf(prev2Total, 'overview')?.order_total_amount)

  /**
   * 「业绩总额」的口径切换。
   * 不筛选 → 用 total_performance_analysis.order_total_amount（接单额，契约示例口径）；
   * 筛选 → 用成员级签约额合计（只有成员级能按梯队过滤）。
   * 两种口径在 sub 里写清楚，绝不混用。
   */
  const signingValue = isFiltered ? signingByRank : overviewTotal
  const signingSub = isFiltered
    ? '口径：sales_performance_ranking.signing_amount（签约额，已按筛选过滤）'
    : '口径：total_performance_analysis.order_total_amount（接单额）'
  const prevSigningValue = isFiltered ? prevSigningByRank : prevOverviewTotal
  const yoySigning = pctChange(signingValue, prevSigningValue)

  const collectionAmount = isFiltered
    ? sumBy(targetRows, (r) => r.collection_amount)
    : num(collectionRaw.collection_amount)
  // 去年同期的回款额用「去年同期成员排行」求和（回款工具本身没跑同期窗口，
  // 但排名里的 collection_amount 与它是同一套签约/回款口径，分子分母同源）。
  const prevCollectionAmount = isFiltered
    ? sumBy(prevTargetRows, (r) => r.collection_amount)
    : sumBy(prevRankingRows, (r) => r.collection_amount)
  /**
   * 上游未回款原值（主 KPI 展示用）。
   *
   * 「有行但这一列全是空」也算**取不到** → null；绝不能用 0 冒充 ——
   * 0 会被读成「一分都没回」，那是把数据说反。
   */
  const uncollectedAmountRaw = isFiltered
    ? (targetRows.some((r) => numOrNull(r.uncollected_amount) !== null)
      ? numOrNull(sumBy(targetRows, (r) => r.uncollected_amount))
      : null)
    : numOrNull(collectionRaw.uncollected_amount)
  const overdueCount = isFiltered
    ? sumBy(targetRows, (r) => r.overdue_order_count)
    : num(collectionRaw.overdue_order_count)
  const problemCount = isFiltered
    ? sumBy(targetRows, (r) => r.problem_order_count)
    : num(collectionRaw.problem_order_count)

  /**
   * 回款率 = collection_amount ÷ signing_amount。
   * 分子分母必须同源：回款工具自己的 overview.signing_amount（签约额口径）。
   */
  const collectionSigningBase = num(collectionRaw.signing_amount) || sumBy(rankingRows, (r) => r.signing_amount)
  const collectionRate = isFiltered
    ? ratio(sumBy(targetRows, (r) => r.collection_amount), sumBy(targetRows, (r) => r.signing_amount))
    : ratio(collectionAmount, collectionSigningBase)
  const prevCollectionSigningBase = sumBy(prevRankingRows, (r) => r.signing_amount)
  const prevCollectionRate = isFiltered
    ? ratio(sumBy(prevTargetRows, (r) => r.collection_amount), sumBy(prevTargetRows, (r) => r.signing_amount))
    : ratio(prevCollectionAmount, prevCollectionSigningBase)

  /**
   * 未回款口径：**主 KPI 用上游、明细用归一**（第 9 轮实机复验后的定稿）。
   *
   * 上游 uncollected_amount 把「部分回款」的订单按**全额**计入未回款，订单级数值偏大；
   * 但《业务咨询销售团队作战看板-2026YTD》这类业务工作台用的**就是**上游 overview 的
   * uncollected_amount —— 主 KPI 若换成归一值，就和业务工作台对不上（实机差 15,000.00 元，
   * 而用户核对的就是业务工作台）。所以分两层：
   *   · 主 KPI 与 collection 数据卡：展示**上游值**（与业务工作台一致）；
   *   · 账龄、逾期明细、客户档案订单、业务员档案订单：按「签约额 − 已回款额」**归一**
   *     （那里上游确实虚高，归一才有意义）。
   *
   * 两个数一起下发：value = 上游、uncollectedAmountNormalized = 归一、
   * uncollectedAmountUpstream = 上游原值，差额写进 uncollectedNote ——
   * 前端在数字旁边就能交代口径，不会出现「同名两个数」却没人说明。
   */
  const uncollectedSigningBaseRaw = isFiltered
    ? sumBy(targetRows, (r) => num(r.signing_amount))
    : collectionSigningBase
  // 签约额为 0 说明这一层压根没取到数（不是「签了 0 元」），所以按 null 处理、走回落分支
  const uncollectedSigningBase = uncollectedSigningBaseRaw > 0 ? uncollectedSigningBaseRaw : null
  const uncollectedCollectionBaseRaw = isFiltered
    ? sumBy(targetRows, (r) => num(r.collection_amount))
    : numOrNull(collectionRaw.collection_amount)
  const hasUncollectedCollectionBase = isFiltered
    ? targetRows.some((r) => numOrNull(r.collection_amount) !== null)
    : uncollectedCollectionBaseRaw !== null
  const uncollectedCollectionBase = hasUncollectedCollectionBase ? uncollectedCollectionBaseRaw : null
  const uncollectedNormalized = normalizeUncollectedAmount(
    uncollectedSigningBase,
    uncollectedCollectionBase,
    uncollectedAmountRaw,
  )
  const uncollectedAmountUpstream = uncollectedNormalized.upstream
  /** 归一值：只有真按「签约 − 回款」算出来才算数，否则 null（绝不用上游冒充归一值） */
  const uncollectedAmountNormalized = uncollectedNormalized.basis === 'signing-minus-collection'
    ? uncollectedNormalized.value
    : null
  /** 主 KPI 展示值：优先上游（与业务工作台一致）；上游取不到才用归一值顶上 */
  const uncollectedAmount = uncollectedAmountUpstream !== null
    ? uncollectedAmountUpstream
    : uncollectedAmountNormalized
  const uncollectedBasis = uncollectedAmountUpstream !== null
    ? '主 KPI＝ERP overview 上游 uncollected_amount（与业务工作台一致）；明细与档案＝签约−回款归一'
    : '上游 uncollected_amount 未取到，主 KPI 暂用签约−回款归一值'
  const uncollectedDiff = uncollectedAmountNormalized === null
    ? null
    : Number((uncollectedAmountUpstream - uncollectedAmountNormalized).toFixed(2))
  const uncollectedNote = uncollectedAmountUpstream === null
    ? '未回款口径：上游 uncollected_amount 未取到，主 KPI 暂用「签约额 − 已回款额」归一值'
      + `${num(uncollectedAmountNormalized)} 元；明细与档案（账龄、逾期、客户档案订单、业务员档案订单）同样按归一口径。`
    : `未回款口径：主 KPI 用 ERP overview 的 uncollected_amount ${uncollectedAmountUpstream} 元（与业务工作台一致）；`
      + '明细与档案（账龄、逾期、客户档案订单、业务员档案订单）按「签约额 − 已回款额」归一：'
      + `${uncollectedAmountNormalized === null ? '不可得（上游缺签约额或已回款额）' : `${uncollectedAmountNormalized} 元`}，`
      + `两者差 ${uncollectedDiff === null ? '不可得' : `${uncollectedDiff} 元`}`
      + '（上游把部分回款按全额计入未回款，故偏高）；归一值另存 uncollectedAmountNormalized，上游原值另存 uncollectedAmountUpstream。'

  const orderCount = isFiltered
    ? sumBy(targetRows, (r) => r.order_count)
    : num(overviewRaw.order_count)
  const prevOrderCount = isFiltered
    ? sumBy(prevTargetRows, (r) => r.order_count)
    : num(sectionOf(prevTotal, 'overview')?.order_count)
  /**
   * 成交客户数（口径修正在下方「客户→负责人→成员→梯队」去重那一段算）。
   *
   * 这里**不能**用 uniqueCount(filteredRanking, (r) => r.customer_count)：
   * 那算的是「每个成员的客户数」这个**数字**有多少个不同取值，
   * 不是客户数（5 个成员各 17 家客户 → 只会得到 1）。
   * 真正的去重客户数要按 customerIndex → 负责人 → 成员 → 梯队 join 之后统计，
   * 详见下方 joinedCustomerCount 那一段。
   */

  // 环比：trend 末两个月对比（末月为当月至今，是区间口径下的近似环比）。
  const trendSignature = trendRows.map((row) => ({
    period: str(row.period),
    signing: num(row.order_total_amount),
    collection: num(row.back_money),
    orders: num(row.order_count),
    customers: null, // ERP 的 trend[] 没有月度客户数，不能拿别处的数来凑
    acceptance: num(row.acceptance_amount),
  }))
  const momSigning = trendSignature.length >= 2
    ? pctChange(trendSignature[trendSignature.length - 1].signing, trendSignature[trendSignature.length - 2].signing)
    : null

  /**
   * 环比的可比性检查：趋势最后一个自然月往往**还没过完**（今天 10-23，当月只有 23 天）。
   * 这种情况下「当月 vs 上月整月」的环比天生失真，必须显式标注，
   * 否则页面上的 -40% 会被当成业绩崩塌 —— 那是口径问题，不是经营问题。
   */
  const lastTrendPeriod = trendSignature.length ? str(trendSignature[trendSignature.length - 1].period) : ''
  const partialMonth = isPartialMonthPeriod(lastTrendPeriod, endDate)
  const partialMonthNote = partialMonth
    ? `当月未完结（数据截至 ${endDate}），环比仅供参考`
    : ''
  const trendMonthState = {
    partial: partialMonth,
    dataThrough: endDate,
    note: partialMonthNote,
  }

  const prevTrendRows = rowsOf(prevTotal, ['trend'])
  const trendPrevSignature = prevTrendRows.map((row) => ({
    period: str(row.period),
    signing: num(row.order_total_amount),
    collection: num(row.back_money),
    orders: num(row.order_count),
  }))

  const periodDays = (diffDays(startDate, endDate) ?? 0) + 1

  // ── 梯队（department_name）聚合 ────────────────────────────────────────
  const squadNameOf = new Map()
  for (const row of rankingRows) squadNameOf.set(String(row.member_name), str(row.department_name))
  const squadRows = uniqueStrings(rankingRows.map(squadNameOfRow)).map((name) => {
    const members = rankingRows.filter((r) => squadNameOfRow(r) === name)
    const signing = sumBy(members, (r) => r.signing_amount)
    const target = sumBy(members, (r) => r.target_amount)
    const collection = sumBy(members, (r) => r.collection_amount)
    /**
     * 人数有两个口径，**都要给，不能混**：
     *   headcount / activeCount = 区间内 order_count > 0（真的开过单）的成员数（有业绩）；
     *   totalMembers            = 排行里出现该梯队的全部成员数（在册，含 0 业绩 / 离职占位成员）。
     *
     * 为什么必须分开：业务需求文档里写的人数（如「海豹 8 人 / 战狼 11 人 / 新兵 10 人 /
     * 鲲鹏 4 人 = 33 人销售」）与 ERP 在册成员数对不上（ERP 在册含大量 0 业绩占位）。
     * 直接拿在册数算人均产出，会把结论算成「人效被摊薄」—— 那是口径错，不是人效差。
     * 所以 headcount 统一给「有业绩人数」（与 CONTRACT 示例的 战狼 11 对齐），
     * 在册数另给 totalMembers，页面标注口径后再比较。
     */
    const activeCount = countBy(members, (r) => num(r.order_count) > 0)
    const totalMembers = members.length
    /**
     * 军令状目标的覆盖度 —— 完成率分母口径不对齐，会系统性低估完成率。
     *
     * 实测：ranking 里绝大多数中后排成员 target_amount = null（target_warning「未配置军令状目标。」），
     * 于是 squad.target = 「有目标成员的军令状之和」，而 squad.signing = 「全员接单额之和」。
     * 没有军令状的成员贡献了业绩却没贡献目标 → completion 被低估，看着像没完成，
     * 其实只是目标没配。所以必须把「有目标的成员数」摊开，并据此说明 completion 可不可信。
     */
    const targetMembers = countBy(members, (r) => num(r.target_amount) > 0)
    const activeWithoutTarget = countBy(
      members,
      (r) => num(r.order_count) > 0 && !(num(r.target_amount) > 0),
    )
    const signingWithTarget = sumBy(
      members.filter((r) => num(r.target_amount) > 0),
      (r) => r.signing_amount,
    )
    const targetBasis = activeWithoutTarget > 0 ? 'partial' : 'full'
    const completion = ratio(signing, target)
    const completionAligned = ratio(signingWithTarget, target)
    const targetNote = targetBasis === 'partial'
      ? `军令状目标仅覆盖 ${activeCount} 名有业绩成员中的 ${targetMembers} 人（${activeWithoutTarget} 人无目标），completion 被低估`
      : ''
    return {
      name,
      /**
       * headcount 取「有业绩人数」（与 CONTRACT 示例一致：战狼 11），totalMembers 给在册数。
       * 理由同北极星：在册数含大量 0 业绩 / 离职占位，拿它当分母会把人效算塌。
       * 两个口径都往外给，由页面标注口径后再比较 —— 不替用户选。
       */
      headcount: activeCount,
      activeCount,
      totalMembers,
      headcountNote: '人数两个口径：headcount/activeCount=区间内有业绩人数；totalMembers=ERP 在册成员数（含 0 业绩/离职占位）',
      targetMembers,
      targetBasis,
      targetNote,
      completionBasis: targetBasis,
      signing,
      target,
      completion,
      completionAligned,
      signingWithTarget,
      status: targetBasis === 'partial' ? 'warn' : statusFromRate(completion, 1, 0.8),
      perCapita: ratio(signing, activeCount),
      perCapitaActive: ratio(signing, activeCount),
      perCapitaTotal: ratio(signing, totalMembers),
      collectionRate: ratio(collection, signing),
      overdue: sumBy(members, (r) => r.overdue_order_count),
      customers: sumBy(members, (r) => r.customer_count),
      members,
    }
  })
  /**
   * 梯队的「客户数」优先用去重口径（客户 → 负责人 → 成员 → 梯队）。
   * join 不上（principal_id 与 member_id 不是同一套 id）时退回成员客户数合计，
   * 并在 matrix 里注明该口径可能跨成员重复。
   */
  const squadCustomerSets = new Map()
  let joinedCustomerCount = 0
  const memberIdToSquad = new Map(rankingRows.map((r) => [String(r.member_id), squadNameOfRow(r)]))
  for (const record of customerIndex.values()) {
    const squadName = memberIdToSquad.get(String(record.principalId))
    if (!squadName) continue
    joinedCustomerCount += 1
    if (!squadCustomerSets.has(squadName)) squadCustomerSets.set(squadName, new Set())
    squadCustomerSets.get(squadName).add(record.key)
  }
  for (const squad of squadRows) {
    if (joinedCustomerCount > 0 && squadCustomerSets.has(squad.name)) {
      squad.customers = squadCustomerSets.get(squad.name).size
    }
  }

  /**
   * 成交客户数（A2 修正）。
   *
   * 原实现：`isFiltered ? uniqueCount(filteredRanking, (r) => r.customer_count) : num(overviewRaw.customer_count)`
   * —— uniqueCount 数的是「每个成员报的客户数」这个**数字**有多少个不同取值，
   * 不是客户数（5 个成员各报 17 家客户，结果只会得到 1）。这个数根本不是客户数。
   *
   * 现在分三种口径，并明确标出来源：
   *   · 不筛选 → 用 ERP 全量区间客户数（total_performance_analysis.overview.customer_count）；
   *   · 筛选且能 join 上 → 用「客户 → 负责人 → 成员 → 梯队」去重后的真实客户数；
   *   · 筛选但 join 不上 → 退回成员客户数合计，并写明该口径可能跨成员重复。
   */
  const currentDedup = dedupCustomerJoin(customerIndex.values(), memberIdToSquad)
  const filterMemberId = member
    ? (filteredRanking.find((r) => str(r.member_name) === member)?.member_id ?? null)
    : null
  const memberCustomerCountFallback = num(sumBy(targetRows, (r) => r.customer_count))
  let customerCount
  let customerCountBasis
  if (!isFiltered) {
    customerCount = num(overviewRaw.customer_count)
    customerCountBasis = 'erp-overview'
  } else {
    const targetSet = filterMemberId !== null
      ? currentDedup.memberSets.get(String(filterMemberId))
      : currentDedup.squadSets.get(squad)
    if (currentDedup.joined > 0 && targetSet) {
      customerCount = targetSet.size
      customerCountBasis = 'dedup'
    } else {
      customerCount = memberCustomerCountFallback
      customerCountBasis = 'member-sum'
    }
  }
  const customerCountNote = customerCountBasis === 'erp-overview'
    ? '口径：total_performance_analysis.overview.customer_count（全量区间成交客户数）'
    : customerCountBasis === 'dedup'
      ? `口径：按「客户 → 负责人 → 成员 → 梯队」去重后的真实客户数（客户档案样本 ${customerIndex.size} 家，join 命中 ${currentDedup.joined} 家）`
      : `口径：成员客户数合计（客户档案与成员 id join 不上，无法去重；同一客户多人跟单时会计重复，且受 limit=${num(settings.rowLimit) || DEFAULTS.rowLimit} 截断）`

  // ── 成员排行 ──────────────────────────────────────────────────────────
  /**
   * 排行表里的 100 行 ≠ 100 个在跑业绩的销售。
   * 其中大量是「占位成员02」「业务员15」「业务员16」这类 0 业绩 / 离职占位成员。
   * 全量塞进排行表和业务员筛选器有两个后果：
   *   1) 页面会让人误以为有这么多人在跑业绩；
   *   2) 任何「人均」口径的分母被占位成员撑大。
   * 所以按在役拆开：在役 = 区间内 signing > 0 或 orders > 0；其余进「未产出成员」小节，
   * 并把过滤规则写进 note，让页面能说明白。
   */
  const isActiveMember = (row) => num(row.signing_amount) > 0 || num(row.order_count) > 0
  const activeRankingRows = filteredRanking.filter(isActiveMember)
  const inactiveRankingRows = filteredRanking.filter((row) => !isActiveMember(row))
  /**
   * 业务员筛选候选项：只给在役成员，并且**不按当前选中的业务员收窄**
   * （否则选中某人后，下拉框里就只剩他一个人，没法换人）。
   * 只按梯队收窄：选了哪个梯队，就列那个梯队在役的人。
   */
  const squadFilteredActiveMembers = (squad
    ? rankingRows.filter((r) => squadNameOfRow(r) === squad)
    : rankingRows
  ).filter(isActiveMember)
  const rankingSignature = [...activeRankingRows]
    .sort((a, b) => num(b.signing_amount) - num(a.signing_amount))
    .map((row, index) => {
      const signing = num(row.signing_amount)
      const target = num(row.target_amount)
      const completion = ratio(signing, target)
      const collection = num(row.collection_amount)
      const rate = ratio(collection, signing)
      const warningsForRow = []
      if (!(target > 0)) warningsForRow.push('未查到军令状目标，完成率无法计算')
      else if (completion < 0.5) warningsForRow.push(`完成率 ${(completion * 100).toFixed(1)}%，明显落后`)
      if (rate !== null && rate < TH.squadCollectionRateLow) warningsForRow.push(`回款率 ${(rate * 100).toFixed(1)}%，偏低`)
      if (num(row.problem_order_count) > 0) warningsForRow.push(`问题单 ${num(row.problem_order_count)} 张`)
      return {
        rank: index + 1,
        memberId: row.member_id ?? null,
        memberName: str(row.member_name),
        squad: squadNameOfRow(row),
        signing,
        target: target > 0 ? target : null,
        completion,
        collection,
        collectionRate: rate,
        customers: num(row.customer_count),
        orders: num(row.order_count),
        overdue: num(row.overdue_order_count),
        problem: num(row.problem_order_count),
        status: statusFromRate(completion, 1, 0.8),
        warning: warningsForRow.join('；'),
      }
    })
  const rankingInactiveSignature = [...inactiveRankingRows]
    .sort((a, b) => num(b.order_count) - num(a.order_count))
    .map((row) => ({
      memberId: row.member_id ?? null,
      memberName: str(row.member_name),
      squad: squadNameOfRow(row),
      signing: num(row.signing_amount),
      orders: num(row.order_count),
      target: num(row.target_amount) > 0 ? num(row.target_amount) : null,
    }))
  const rankingFilterNote =
    `排行表只列在役成员（区间内签约额 > 0 或订单数 > 0）：共 ${rankingSignature.length} 人；` +
    `另有 ${rankingInactiveSignature.length} 名 0 业绩/离职占位成员未列入排行（见「未产出成员」）。`

  // ── 新兵成长（staff_info ∩ 排行）────────────────────────────────────────
  const memberByName = new Map(rankingRows.map((r) => [str(r.member_name), r]))
  /**
   * 2026-10-26 用户诉求：「统计新兵业绩，只取 业务咨询事业群成员，也就是销售人员，
   * 不能把其他部门的人员加进来」。
   *
   * 之前这里直接遍历 staff_info 全量 500 人 —— 那是全公司花名册（技术/市场/行政/销售混在一起），
   * 区间内新入职 44 人里只有 21 人是销售，其余 23 人属于别的部门，必须剔除。
   *
   * 销售序列怎么认？
   *   ① staff_info.first_dep_name === '业务咨询事业群'（实测销售序列的顶层事业群就是这个）；
   *   ② staff_info.dep_name / second_dep_name ∈ **真销售梯队白名单**。
   *
   * ⚠️ 白名单不能直接取「member_performance_analysis 的全部 dep_name」——
   *    那个接口统计的是**全公司 12 名在册成员**，里面混着市场发展部、行政法宣部、总工等非销售部门；
   *    早期版本用全量 dep_name 建白名单，结果把「市场发展部 / 行政法宣部」的人也判成销售
   *    （业务员12·新媒体运营、业务员09·品牌宣发经理、业务员11·综合后勤 混进了新兵表）。
   *    现在白名单只从「ERP 里 first_dep_name === 业务咨询事业群 的成员」+ 「销售排行的部门」取，
   *    再并上销售二级部门的固定兜底名单。
   *
   * ⚠️ `job_no` 以 'YX' 开头**不能**当独立判据：市场发展部的业务员10 username 也是 YX90017。
   */
  const memberRows = rowsOf(mainMember, ['data', 'records'])
  const salesFirstDep = str(settings.salesFirstDepName) || '业务咨询事业群'
  const salesSquadNames = metrics.buildSalesSquadNames(memberRows, rankingRows, salesFirstDep)
  const erpMemberByUsername = new Map()
  const erpMemberByName = new Map()
  for (const row of memberRows) {
    const username = str(row.username)
    if (username) erpMemberByUsername.set(username.toUpperCase(), row)
    const memberName = str(row.member_name)
    if (memberName) erpMemberByName.set(memberName, row)
  }
  const rankingByMemberId = new Map()
  for (const row of rankingRows) {
    if (row.member_id !== undefined && row.member_id !== null) rankingByMemberId.set(String(row.member_id), row)
  }

  /**
   * 2026-10-26 用户澄清：「新兵是指 **未转正** 的 业务咨询成员」。
   * 所以这里不再是「区间内入职的人」，而是「当前尚未转正的在职销售」。
   * 筛选逻辑见 metrics.selectNewcomers 的注释（含实测口径）。
   */
  const newcomerSelection = metrics.selectNewcomers(staffRows, {
    salesFirstDep,
    salesSquadNames,
    baseDate: endDate,
  })
  const growthSignature = []
  for (const staff of newcomerSelection.candidates) {
    const name = str(staff.staff_name)
    const joinDate = dateOnly(staff.join_time)
    // 花名册 → ERP 成员：主键走 job_no ↔ username（YX90061 形态一致），退而用姓名。
    const jobNo = str(staff.job_no)
    const erpMember =
      (jobNo ? erpMemberByUsername.get(jobNo.toUpperCase()) : null) || erpMemberByName.get(name) || null
    const rankingMember = erpMember
      ? rankingByMemberId.get(String(erpMember.member_id)) || memberByName.get(name) || null
      : memberByName.get(name) || null
    const months = Math.max(0, Math.round((diffDays(joinDate, endDate) ?? 0) / 30))
    // 业绩口径：优先取「销售排行」的区间签约额（与排行表同源）；排行里没有这个人时，
    // 退回「销售成员业绩明细」的接单额，并标记来源，避免两个口径混用不说清。
    let signing = 0
    let signingSource = 'none'
    if (rankingMember) {
      signing = num(rankingMember.signing_amount)
      signingSource = 'ranking'
    } else if (erpMember) {
      signing = num(erpMember.order_total_amount)
      signingSource = 'member'
    }
    growthSignature.push({
      memberId: rankingMember?.member_id ?? erpMember?.member_id ?? null,
      memberName: name,
      squad: str(rankingMember?.department_name) || str(erpMember?.dep_name) || str(staff.dep_name),
      joinDate,
      months,
      level: str(staff.level),
      post: str(staff.post_name),
      jobNo,
      positiveTime: dateOnly(staff.positive_time),
      status: signing > 0 ? 'good' : 'warn',
      signing,
      signingSource,
      customers: rankingMember ? num(rankingMember.customer_count) : num(erpMember?.customer_count),
      orders: rankingMember ? num(rankingMember.order_count) : num(erpMember?.order_count),
    })
  }

  // ── 订单质量：ABC（抽样）────────────────────────────────────────────────
  const sampleCustomers = tierSamples.length
  const coverageAmount = sumBy(tierSamples, (s) => s.amount)
  const coverageShare = ratio(coverageAmount, signingValue)
  const bShare = weightedShare(tierSamples, (s) => s.amount12m || s.amount, (s) => s.bShare)
  const tierRows = []
  for (const tier of uniqueStrings(tierSamples.map((s) => s.tier))) {
    const group = tierSamples.filter((s) => s.tier === tier)
    const scores = group.map((s) => s.score).filter((v) => v !== null)
    tierRows.push({
      tier,
      count: group.length,
      share: ratio(group.length, sampleCustomers),
      score: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
      amount: sumBy(group, (s) => s.amount),
    })
  }
  const abcStatus = sampleCustomers > 0 ? 'sampled' : 'unavailable'

  // ── STD 占比（**签单口径**，2026-11-04 用户明确要求）─────────────────────
  /**
   * 口径纪律（三条，缺一条就会把数据讲错）：
   *   ① 分子分母**同源**：stdSigningAmount ÷ signingAmount，两者都是「已判定货号的签单额」。
   *      不能拿签字额做分子、报价额做分母 —— 那是两个完全不同的业务量级。
   *   ② 判定「失败」(未知) 与「不是 STD」(false) 必须分开：一个货号都没判定成功时，
   *      STD 占比是**未知**，不是 0%。报 0% 等于替 ERP 断言「我们确认没有 STD 业务」，那是编造。
   *   ③ 覆盖率要单独给：出库明细只能把「已出库订单」的签单额摊到货号上，
   *      实测只覆盖区间签单额的 46.5%，所以 stdShare 是**该覆盖范围内**的占比，
   *      不能当成全区间占比；coverageSigningShare 就是这个覆盖范围占区间的比例。
   * （报价口径的 amount 仍保留在 std.quoteAmount 里，只作对照，不再参与占比计算。）
   */
  const quoteDetailAmount = sumBy(goodsList, (g) => g.amount)
  const quoteAmount = quoteDetailAmount > 0 ? quoteDetailAmount : num(quotationMetrics.amount_total)
  const probedGoods = probeTargets.length
  const stdProbeOkCount = stdSigning.goodsJudged
  const stdAmount = stdSigning.stdSigningAmount
  const stdShare = stdSigning.stdShare
  const stdCoverageShare = stdSigning.coverageSigningShare
  const stdShareNote = stdSigning.ok
    ? `签单口径：取 ${stdSigning.windowFrom}~${stdSigning.windowTo} 的销售出库明细，`
      + `把订单签单额按货号行数分摊后逐个判定 STD；已判定 ${stdSigning.goodsJudged}/${stdSigning.goodsTotal} 个货号，`
      + `覆盖区间签单额 ${stdSigning.coverageSigningShare === null ? '未知' : `${(stdSigning.coverageSigningShare * 100).toFixed(1)}%`}`
      + `（${Number(num(stdSigning.signingAmount).toFixed(2))} / ${Number(num(stdSigning.periodSigningAmount).toFixed(2))} 元）。`
    // 不可得时**必须说清卡在哪一步**（shipping / probe / no-goods）——
    // 一句笼统的「不可得」既没法定位是谁坏了，也容易被读成「我们没有 STD 业务」。
    : stdBlockedText(stdBlockedStage(stdSigning), stdSigning)
  const stdRows = probeTargets.slice(0, 50).map((g) => ({
    code: g.code,
    name: null,
    amount: g.amount,
    orders: g.orders,
    std: probed.has(g.code) ? probed.get(g.code) : null,
  }))

  // ── 直销 / 经销 ───────────────────────────────────────────────────────
  const modelBuckets = new Map()
  for (const record of customerIndex.values()) {
    const kind = classifyChannel(record.kind)
    if (!modelBuckets.has(kind)) modelBuckets.set(kind, { kind, customers: 0, amount: 0 })
    const bucket = modelBuckets.get(kind)
    bucket.customers += 1
    bucket.amount += record.amount
  }
  const modelTotalAmount = sumBy([...modelBuckets.values()], (b) => b.amount)
  const modelRows = [...modelBuckets.values()]
    .sort((a, b) => b.amount - a.amount)
    .map((b) => ({ kind: b.kind, customers: b.customers, amount: b.amount, share: ratio(b.amount, modelTotalAmount) }))

  // ── 客户赛道（抽样）────────────────────────────────────────────────────
  const trackBuckets = new Map()
  for (const sample of tierSamples) {
    if (!trackBuckets.has(sample.track)) trackBuckets.set(sample.track, { track: sample.track, customers: 0, amount: 0 })
    const bucket = trackBuckets.get(sample.track)
    bucket.customers += 1
    bucket.amount += sample.amount
  }
  const trackTotalAmount = sumBy([...trackBuckets.values()], (b) => b.amount)
  const trackRows = [...trackBuckets.values()]
    .sort((a, b) => b.amount - a.amount)
    .map((b) => ({ track: b.track, customers: b.customers, amount: b.amount, share: ratio(b.amount, trackTotalAmount) }))

  // ── Top 货号 ──────────────────────────────────────────────────────────
  const goodsRows = goodsList.slice(0, 20).map((g) => ({
    code: g.code,
    name: g.name,
    amount: g.amount,
    orders: g.orders,
    repeatCustomers: g.customers.size,
    std: probed.has(g.code) ? probed.get(g.code) : null,
  }))

  // ── 回款与账龄 ─────────────────────────────────────────────────────────
  const agingBuckets = new Map([
    ['30天内', { bucket: '30天内', count: 0, amount: 0 }],
    ['31-60天', { bucket: '31-60天', count: 0, amount: 0 }],
    ['61-90天', { bucket: '61-90天', count: 0, amount: 0 }],
    ['90天以上', { bucket: '90天以上', count: 0, amount: 0 }],
  ])
  const overdueRows = []
  /**
   * 账龄柱高 / 逾期明细金额的未回款口径（A4）。
   *
   * 原来直接用上游 uncollected_amount，而上游把「部分回款」的订单按**全额**计入未回款
   * —— 一张签 10 万、已回 6 万的订单被记成 10 万未回款，账龄柱高与逾期金额全部虚高。
   * 现在改为「签约额 − 已回款额」；分子分母取不到时回落上游原值并计数，
   * 回落比例写进 note（不能让用户以为账龄金额是精确值）。
   */
  let agingFallbackCount = 0
  let agingNormalizedTotal = 0
  let agingUpstreamTotal = 0
  for (const order of orderRows) {
    const normalized = normalizeUncollectedAmount(order.signing_amount, order.collection_amount, order.uncollected_amount)
    const uncollected = normalized.value === null ? 0 : normalized.value
    if (normalized.fallback) {
      agingFallbackCount += 1
      agingUpstreamTotal += num(normalized.upstream)
    } else {
      agingNormalizedTotal += uncollected
    }
    if (uncollected <= 0) continue
    const days = num(order.overdue_days)
    const bucket = bucketAging(days) || '30天内'
    if (agingBuckets.has(bucket)) {
      agingBuckets.get(bucket).count += 1
      agingBuckets.get(bucket).amount += uncollected
    }
    if (days > 0) {
      overdueRows.push({
        customerName: str(order.customer_name),
        customerCode: str(order.customer_code),
        memberName: str(order.member_name),
        squad: str(order.department_name),
        amount: uncollected,
        days,
        accountPeriod: numOrNull(order.account_period),
        level: days > 90 ? '高' : days > 60 ? '中' : '低',
      })
    }
  }
  overdueRows.sort((a, b) => b.days - a.days)
  const agingUncollectedNote = agingFallbackCount > 0
    ? `账龄与逾期金额口径：签约额 − 已回款额；其中 ${agingFallbackCount} 条订单上游未给签约额/回款额，回落上游 uncollected_amount 原值（合计 ${Number(agingUpstreamTotal.toFixed(2))} 元，该部分偏高），已归一部分合计 ${Number(agingNormalizedTotal.toFixed(2))} 元。`
    : '账龄与逾期金额口径：签约额 − 已回款额（全部订单均可归一）。'

  /**
   * 订单明细是**样本**，计数 KPI 往往却是**全量** —— 两个口径并排展示会骗人。
   *
   * 实测：sales_order_collection_analysis.overview 给的是全量（逾期 313 单），
   * 而 orders[] 明细受 limit=rowLimit 截断（只有 ~100 条）。于是「逾期订单数 = 313」
   * 和「账龄分桶 = 98 单」并排，会被读成「全公司只有 98 张逾期单」。
   *
   * 因此凡是由**明细**算出来的数，一律带 sampled / sampleSize / totalKnown / note；
   * 由 overview 给的全量计数则标 sampled:false 并说明来源 —— 不把全量说成样本，
   * 也不把样本说成全量。
   */
  const orderSample = {
    sampled: true,
    sampleSize: orderRows.length,
    totalKnown: numOrNull(collectionRaw.order_count),
    totalKnownDetail: {
      orderCount: numOrNull(collectionRaw.order_count),
      unpaidOrderCount: numOrNull(collectionRaw.unpaid_order_count),
      overdueOrderCount: numOrNull(collectionRaw.overdue_order_count),
      problemOrderCount: numOrNull(collectionRaw.problem_order_count),
      uncollectedAmount: numOrNull(collectionRaw.uncollected_amount),
      // 归一后的全量未回款（签约 − 回款）；上面那行是上游原值，两者都留着做对照
      uncollectedAmountNormalized: uncollectedAmountNormalized,
    },
    note: `账龄与明细基于前 ${orderRows.length} 条订单样本，非全量（全量订单 ${numOrNull(collectionRaw.order_count) ?? '未知'} 单）；桶计数为 0 表示该桶在样本内为 0 单，不等于全量为 0。`,
  }
  const orderSampleShortNote = `明细基于前 ${orderRows.length} 条订单样本，非全量`
  /**
   * aging / overdue 都下发成**对象**而不是裸数组。
   *
   * 原因：裸数组挂不上字段，「这是抽样」这个口径警告就只能挂到每一行，
   * 前端的抽样提示组件只在「对象级 sampled===true」时才显示 —— 于是警告整段不显示，
   * 用户会把 98 单的样本账龄当成全量读。这是必须堵住的口径风险。
   *
   * 行内容不变，只是把 rows 挪进对象里；sampled/sampleSize/totalKnown/totalKnownDetail
   * 直接复用 orderSample，不再造第二份。
   */
  const agingBlock = {
    sampled: true,
    sampleSize: orderSample.sampleSize,
    totalKnown: orderSample.totalKnown,
    totalKnownDetail: orderSample.totalKnownDetail,
    note: `${orderSample.note} ${agingUncollectedNote}`,
    rows: [...agingBuckets.values()].map((bucket) => ({
      ...bucket,
      // 桶计数为 0 必须在行内说清楚是「样本内为 0」，不是「全量为 0」
      ...(bucket.count === 0 ? { note: '该桶在样本内为 0 单（不等于全量为 0）' } : {}),
    })),
  }
  const overdueBlock = {
    sampled: true,
    sampleSize: orderSample.sampleSize,
    totalKnown: orderSample.totalKnown,
    totalKnownDetail: orderSample.totalKnownDetail,
    note:
      `逾期明细基于前 ${orderRows.length} 条订单样本，非全量` +
      `（全量逾期 ${numOrNull(collectionRaw.overdue_order_count) ?? '未知'} 单，见 totalKnownDetail）；` +
      '行内为样本内逾期且未回款金额 > 0 的订单，按逾期天数倒序。' +
      agingUncollectedNote,
    rows: overdueRows,
  }

  // ── 售后闭环 ───────────────────────────────────────────────────────────
  const aftersaleTotal = afterSaleRows.length
  const aftersaleClosed = countBy(afterSaleRows, (r) => num(r.status2) === 1)
  /**
   * 售后闭环的三态（E3）。
   *
   * 原来只判 `status2 === 1`，于是 status2 **缺失**的记录全被算成「未闭环」，
   * 未闭环数虚高 —— 「没取到闭环状态」和「确实没闭环」被混成了同一个结论。
   * 现在拆成三态：
   *   · status2 = 1 → closeState 'closed'（已闭环）
   *   · status2 = 2 → closeState 'open'（未闭环）
   *   · status2 缺失/其它 → closeState 'unknown'（不可得，既不算闭环也不算未闭环）
   * 闭环率的分母只算**状态已知**的记录（closed + open），并把 unknown 单独报出来。
   */
  const aftersaleOpen = countBy(afterSaleRows, (r) => num(r.status2) === 2)
  const aftersaleUnknownState = aftersaleTotal - aftersaleClosed - aftersaleOpen
  const aftersaleKnownState = aftersaleClosed + aftersaleOpen
  /**
   * 售后时长有两个**不同**的口径，混用会得出错误结论，所以两个都算、都写清楚：
   *   avgHours      = check_time − add_time：投诉登记 → 核销/检查（更贴近「投诉→闭环」）；
   *   avgUpdateHours = update_time − add_time：登记 → 最后一次更新（往往只是流程流转，不是闭环）。
   * 样本量（hoursList/updateList 的长度）也一起给出 —— 只有几条记录时均值没有代表性。
   */
  const hoursList = []
  const updateList = []
  for (const row of afterSaleRows) {
    const add = Date.parse(String(row.add_time || '').replace(' ', 'T'))
    const check = Date.parse(String(row.check_time || '').replace(' ', 'T'))
    const update = Date.parse(String(row.update_time || '').replace(' ', 'T'))
    if (Number.isFinite(add) && Number.isFinite(check) && check >= add) {
      hoursList.push((check - add) / 3600000)
    }
    if (Number.isFinite(add) && Number.isFinite(update) && update >= add) {
      updateList.push((update - add) / 3600000)
    }
  }
  const avgHours = hoursList.length
    ? hoursList.reduce((a, b) => a + b, 0) / hoursList.length
    : null
  const avgUpdateHours = updateList.length
    ? updateList.reduce((a, b) => a + b, 0) / updateList.length
    : null
  const aftersaleNote =
    'avgHours 口径：check_time − add_time（投诉登记 → 核销/检查），' +
    `样本 ${hoursList.length} 条；avgUpdateHours 口径：update_time − add_time（登记 → 最后更新，非闭环时长），` +
    `样本 ${updateList.length} 条。样本量小时均值仅供参考。`
  /**
   * 售后数据的可得性说明（std 服务宕机时这一段是唯一能让读者看懂「为什么全是 0」的地方）。
   *
   * 三种情况分开说：
   *   · 工具调用失败（std 服务宕机）→ 一条记录都没取到，闭环率不可得（null），**不是 0%**；
   *   · 工具成功但一条记录都没有 → 同理不可得，不能说成「0% 闭环」；
   *   · 正常取到 → 分母只算状态已知的记录。
   */
  const aftersaleAvailabilityNote = !afterSaleAvailable
    ? '售后数据取不到（after_sale_management_query 调用失败，std 服务可能不可用）：'
      + 'closed / open / unknownState 全为 0 属于「没取到数」，闭环率不可得（null），**不是 0%**。'
    : afterSaleRows.length === 0
      ? '售后查询成功但没有返回任何记录：闭环率不可得（null），不是 0%。'
      : '售后数据已取到；闭环率分母只算状态已知的记录（closed + open）。'
  // 「重大售后」不是 ERP 的枚举字段，只能按描述/原因文本里的关键词识别 —— matrix 里已注明。
  const majorCount = countBy(afterSaleRows, (r) =>
    /重大|批量|召回|事故|严重/.test(`${str(r.thesis) || ''} ${str(r.back_cause) || ''} ${str(r.conclusion) || ''}`))
  const saleCodeToCustomer = new Map()
  for (const order of orderRows) saleCodeToCustomer.set(String(order.sale_code), order)
  /**
   * 售后类型：ERP 只给数字枚举码（type=4/5…），**没有码表**。
   * 这里不做任何猜测映射，原样透传数字并附一句说明 ——
   * 硬猜「4=质量投诉」之类的映射，一旦猜错就是凭空编造业务含义。
   */
  const afterSaleTypeNote = 'ERP 售后类型为数字枚举码，未提供码表，原样显示'
  const afterSaleMajorBasis = '正文关键词识别（近似口径，非 ERP 枚举字段）'
  const aftersaleRows = afterSaleRows.map((row) => {
    const order = saleCodeToCustomer.get(String(row.sale_code))
    const status2 = numOrNull(row.status2)
    return {
      saleCode: str(row.sale_code),
      goodsCode: str(row.goods_code),
      customer: order ? str(order.customer_name) : null,
      applicant: str(row.applicant_name),
      principal: str(row.principal_name),
      type: numOrNull(row.type),
      typeNote: afterSaleTypeNote,
      // 三态闭环：status2 缺失 = unknown，既不算闭环也不算未闭环（E3）
      closeState: status2 === 1 ? 'closed' : (status2 === 2 ? 'open' : 'unknown'),
      closed: status2 === 1,
      addTime: str(row.add_time),
    }
  })

  // ── 客户资产 ───────────────────────────────────────────────────────────
  /**
   * 复购分档的**分母必须是「区间内真的下过单的客户」**。
   *
   * 之前把 customer_analysis 返回的所有客户档案都塞进了分档，其中绝大多数在区间内
   * 没有订单记录（orderCount=0），于是「1-3次」档被撑到 99.4% —— 那是把「没买过」
   * 算成了「买过 1-3 次」，是错的。现在 orderCount<1 的客户直接排除并单独计数。
   * 逻辑放在 metrics.repurchaseDistribution（纯函数）里，自检可做行为级断言。
   */
  const repurchase = metrics.repurchaseDistribution([...customerIndex.values()])
  const repurchaseRows = repurchase.rows
  const repurchaseTotal = repurchase.total
  const repurchaseExcludedNoOrder = repurchase.excludedNoOrder
  const repurchaseNote = `仅统计区间内订单数 ≥ 1 的客户（分母 ${repurchaseTotal} 家）；另有 ${repurchaseExcludedNoOrder} 家客户区间内无订单记录，不计入复购分档`

  // 沉睡客户：用近 12 个月窗口找「历史买过、但最近 90 天没买」的客户。
  const lookbackIndex = buildCustomerIndex(
    rowsOf(lookbackCustomer, ['customers']),
    rowsOf(lookbackCustomer, ['sales']),
  )
  for (const record of lookbackIndex.values()) {
    if (record.principalId === null || record.principalId === undefined) continue
    record.principalName = memberNameById.get(str(record.principalId)) || null
  }
  const dormantThreshold = 90
  const dormantRows = []
  /**
   * 沉睡客户的判定**只能对有末次订单时间的客户做**：
   * customer_analysis 返回的客户档案里，只有一部分在近 12 个月窗口内有成交行
   * （sales[] 只给「区间内有订单的客户」），其余客户连 last_order_time 都没有。
   * 没时间戳 ≠ 没买过，所以这些客户**不参与判定**，而不是算成「沉睡」。
   * 因此 total 只是样本内判定出来的数量，必须同时给出样本量与说明。
   */
  let dormantJudged = 0
  for (const record of lookbackIndex.values()) {
    const lastOrder = dateOnly(record.lastOrder)
    if (!lastOrder) continue
    dormantJudged += 1
    const days = diffDays(lastOrder, endDate)
    if (days === null || days <= dormantThreshold) continue
    const member = memberByName.get(record.principalName) || null
    dormantRows.push({
      customerName: record.name,
      customerCode: record.code,
      memberName: record.principalName,
      lastOrder,
      days,
      amount: record.amount,
    })
  }
  dormantRows.sort((a, b) => b.days - a.days)
  const dormantNote = `仅对 customer_analysis 返回样本内有成交记录的客户判定沉睡（参与判定 ${dormantJudged} 家 / 样本 ${lookbackIndex.size} 家）；其余客户无末次订单时间不参与判定，total 不代表全量沉睡客户数`

  // 跟进达标率：只有「分档 + 跟进记录」都有的客户才能判定。
  const tierByKey = new Map(tierSamples.map((s) => [s.key, s]))
  const followBuckets = new Map()
  let followReached = 0
  let followCustomers = 0
  for (const visit of visitSamples) {
    const sample = tierByKey.get(visit.key)
    if (!sample || !sample.tier) continue
    const standard = followStandard(sample.tier, periodDays)
    const reached = visit.visits >= standard.need ? 1 : 0
    if (!followBuckets.has(sample.tier)) {
      followBuckets.set(sample.tier, { tier: sample.tier, standard: standard.label, customers: 0, reached: 0, rate: null })
    }
    const bucket = followBuckets.get(sample.tier)
    bucket.customers += 1
    bucket.reached += reached
    followReached += reached
    followCustomers += 1
  }
  const followRows = [...followBuckets.values()].map((b) => ({
    tier: b.tier,
    standard: b.standard,
    customers: b.customers,
    reached: b.reached,
    rate: ratio(b.reached, b.customers),
  }))
  const followNote = `跟进达标率基于抽样客户的 visits 记录计算：抽样 ${visitSamples.length} 家，其中 ${followCustomers} 家同时取得分档与跟进记录并参与判定；未达成为真实值（0 也是结论），不因「看起来不好看」改成 null`

  // 新增客户：区间内首次成交。
  const newCustomerRows = []
  for (const record of customerIndex.values()) {
    const firstDeal = dateOnly(record.firstDeal)
    if (!firstDeal || firstDeal < startDate || firstDeal > endDate) continue
    newCustomerRows.push({ customerName: record.name, firstDeal, amount: record.amount })
  }
  newCustomerRows.sort((a, b) => b.amount - a.amount)
  const prevCustomerIndex = buildCustomerIndex(
    rowsOf(prevCustomer, ['customers']),
    rowsOf(prevCustomer, ['sales']),
  )
  const prev2CustomerIndex = buildCustomerIndex(
    rowsOf(prev2Customer, ['customers']),
    rowsOf(prev2Customer, ['sales']),
  )
  const prevNewCustomerCount = countBy([...prevCustomerIndex.values()], (r) => {
    const firstDeal = dateOnly(r.firstDeal)
    return Boolean(firstDeal && firstDeal >= prev.startDate && firstDeal <= prev.endDate)
  })

  /**
   * 去年同期的成交客户数（与上面的 customerCount 同一套口径，否则同比是两个口径相除）。
   * 去年同期的客户档案用的是**去年那批 ranking 行的 member_id → 梯队**映射，
   * 不能拿今年的映射去 join（成员换梯队时会对不上）。
   */
  const prevMemberIdToSquad = new Map(prevRankingRows.map((r) => [String(r.member_id), squadNameOfRow(r)]))
  const prevDedup = dedupCustomerJoin(prevCustomerIndex.values(), prevMemberIdToSquad)
  const prevCustomerCount = !isFiltered
    ? num(sectionOf(prevTotal, 'overview')?.customer_count)
    : (() => {
      const targetSet = filterMemberId !== null
        ? prevDedup.memberSets.get(String(filterMemberId))
        : prevDedup.squadSets.get(squad)
      if (prevDedup.joined > 0 && targetSet) return targetSet.size
      return num(sumBy(prevTargetRows, (r) => r.customer_count))
    })()

  // Top 客户
  /**
   * Top 客户的两个占比（E2）。
   *
   * 原来只有 `share`，分母是 modelTotalAmount —— 那是**直销 + 经销两类桶的合计**，
   * 也就是「样本内能看到的客户总额」。客户档案来自 customer_analysis（limit 封顶 500，
   * 区间内还有大量客户根本没有成交行），这个分母**远小于全公司**，
   * 于是「Top 客户占比」会被算得偏大，看起来像「这家客户占了全公司 30% 的盘子」。
   *
   * 现在两个都给：
   *   · share       = 样本内占比（分母 = 样本内客户总额），保留但标明分母；
   *   · shareOfTotal= 全量占比（分母 = total_performance_analysis.overview.order_total_amount，
   *                 全公司区间接单额），这才是「占全公司多少」的真值。
   */
  const totalSigningDenominator = numOrNull(overviewRaw.order_total_amount)
  const topCustomerRows = [...customerIndex.values()]
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 20)
    .map((record) => ({
      customerName: record.name,
      customerCode: record.code,
      signing: record.amount,
      orders: record.orderCount,
      avg: ratio(record.amount, record.orderCount),
      share: ratio(record.amount, modelTotalAmount),
      shareBasis: 'sample-total（分母 = 直销+经销桶合计，即客户档案样本内客户总额）',
      shareOfTotal: ratio(record.amount, totalSigningDenominator),
    }))

  // ── 漏斗 ───────────────────────────────────────────────────────────────
  const inquiryCount = num(inquiryMetrics.doc_count)
  const quotationCount = num(quotationMetrics.doc_count)
  const stageSign = isFiltered
    ? sumBy(filteredRanking, (r) => r.order_count)
    : num(overviewRaw.order_count)
  const funnelStages = [
    {
      name: '询盘/统筹确认表',
      count: inquiryCount,
      rate: 1,
      note: 'inquiry_plan_query.metrics.doc_count',
      status: 'available',
    },
    {
      name: '报价单',
      count: quotationCount,
      rate: ratio(quotationCount, inquiryCount),
      note: 'quotation_query.metrics.doc_count',
      status: 'available',
    },
    {
      name: '签单',
      count: stageSign,
      rate: null,
      note: '区间订单总量，与上一段不同源，比值仅作参考',
      status: 'partial',
    },
    {
      name: '线索/渠道归因',
      count: null,
      rate: null,
      note: 'ERP 无线索与渠道来源字段',
      status: 'unavailable',
    },
  ]

  // 月度漏斗走势：优先用 by_month 视图（服务端按月聚合，不受 limit 截断）；
  // 拿不到就退化成「按明细记录 add_time 统计」（受 limit 截断，matrix 里注明）。
  const quoteMonthMap = monthCounts(quoteByMonth)
  const inquiryMonthMap = monthCounts(inquiryByMonth)
  const byMonthAvailable = quoteMonthMap.size > 0 || inquiryMonthMap.size > 0
  if (!byMonthAvailable) {
    for (const record of quotationRecords) {
      const key = monthKey(record.add_time)
      if (key) quoteMonthMap.set(key, (quoteMonthMap.get(key) || 0) + 1)
    }
    for (const record of inquiryRecords) {
      const key = monthKey(record.add_time)
      if (key) inquiryMonthMap.set(key, (inquiryMonthMap.get(key) || 0) + 1)
    }
  }
  const funnelTrend = trendSignature.map((row) => ({
    period: row.period,
    inquiry: inquiryMonthMap.has(row.period) ? inquiryMonthMap.get(row.period) : null,
    quotation: quoteMonthMap.has(row.period) ? quoteMonthMap.get(row.period) : null,
    orders: row.orders,
  }))

  /**
   * 询报价明细统计（**零新增 MCP 调用**，全部由上面已经取回的 quotation / inquiry 明细派生）。
   * 口径铁律见 buildQuoteStats 的注释：单据数取 metrics.doc_count（全量），
   * 明细行是抽样；报价金额取 metrics.amount_total（合并口径），不能用明细行求和。
   */
  const quoteStats = buildQuoteStats({
    inquiryMetrics,
    inquiryRecords,
    quotationMetrics,
    quotationRecords,
    periodOrderCount: stageSign,
    rowLimit,
  })

  // 三年对比（同期区间）
  const threeYear = [
    buildYearRow(Number(startDate.slice(0, 4)), mainTotal, mainQuotation, mainInquiry, customerIndex, startDate, endDate),
    buildYearRow(Number(prev.startDate.slice(0, 4)), prevTotal, prevQuotation, prevInquiry, prevCustomerIndex, prev.startDate, prev.endDate),
    buildYearRow(Number(prev2.startDate.slice(0, 4)), prev2Total, prev2Quotation, prev2Inquiry, prev2CustomerIndex, prev2.startDate, prev2.endDate),
  ]

  // ── 学习成长 ───────────────────────────────────────────────────────────
  const levelRows = performanceRows.map((row) => ({
    level: str(row.assess_level),
    count: num(row.count),
  }))
  /**
   * 新兵表只发 ERP 真有的字段。
   * productExam / skillExam / mentor / confirmDate 这 4 列 ERP 根本没有数据源，
   * 恒为 null 还占着表格列位 —— 页面看着「有这一列」，其实永远空白。
   * 宁可少一列，也不要给一列看起来存在、其实永远没有内容的假列。
   * 2026-10-26 起：只列销售序列（业务咨询事业群）的新人，并补上业绩/客户/订单与转正进度。
   * 「当前阶段」列原本是写死的模板文案（ERP 无对应数据源），一并去掉。
   */
  const newbieTarget = num(settings.newbieTargetAmount) || 200000
  const newbiesRows = growthSignature.map((row) => {
    const gap = Math.max(0, newbieTarget - row.signing)
    return {
      name: row.memberName,
      squad: row.squad,
      dept: null,
      joinDate: row.joinDate,
      months: row.months,
      level: row.level,
      post: row.post,
      positiveTime: row.positiveTime ?? null,
      signing: row.signing,
      signingSource: row.signingSource,
      customers: row.customers,
      orders: row.orders,
      target: newbieTarget,
      gap,
      progress: ratio(row.signing, newbieTarget),
      status: row.status,
    }
  })
  for (const row of newbiesRows) {
    const staff = staffRows.find((s) => str(s.staff_name) === row.name)
    if (staff) row.dept = str(staff.dep_name)
  }

  // ── 订单待办 ───────────────────────────────────────────────────────────
  const todoRows = []
  let todoSeq = 0
  const pushTodo = (row) => {
    todoSeq += 1
    todoRows.push({ id: `t-${String(todoSeq).padStart(3, '0')}`, ...row })
  }
  for (const order of overdueRows.slice(0, 120)) {
    const trigger = endDate
    pushTodo({
      type: '回款逾期',
      level: order.level,
      customer: order.customerName,
      sales: order.memberName,
      squad: order.squad,
      amount: order.amount,
      trigger,
      due: addDays(trigger, 30),
      note: `逾期 ${order.days} 天`,
    })
  }
  for (const record of inquiryRecords) {
    const reply = num(record.reply_status)
    // 1 待领取 / 2 答复中 / 6 复核待确认 / 7 复核中 —— 都算「还没报价」。
    if (![1, 2, 6, 7].includes(reply)) continue
    const trigger = dateOnly(record.add_time) || endDate
    pushTodo({
      type: '待报价',
      level: '中',
      customer: str(record.customer_name),
      sales: str(record.principal_name),
      squad: squadNameOf.get(str(record.principal_name)) ?? null,
      amount: null,
      trigger,
      due: addDays(trigger, 30),
      note: `询价单 ${str(record.code) || '—'} 待报价（状态 ${reply}）`,
    })
  }
  for (const row of aftersaleRows) {
    if (row.closed) continue
    const raw = afterSaleRows.find((r) => str(r.sale_code) === row.saleCode)
    const trigger = dateOnly(raw?.add_time) || endDate
    pushTodo({
      type: '售后待处理',
      level: '中',
      customer: row.customer,
      sales: row.principal,
      squad: null,
      amount: null,
      trigger,
      due: addDays(trigger, 30),
      note: `售后单 ${row.saleCode || '—'} 未闭环`,
    })
  }
  for (const member of filteredRanking) {
    const problem = num(member.problem_order_count)
    if (problem <= 0) continue
    pushTodo({
      type: '问题单',
      level: '中',
      customer: null,
      sales: str(member.member_name),
      squad: str(member.department_name),
      amount: null,
      trigger: endDate,
      due: addDays(endDate, 30),
      note: `区间内有 ${problem} 张问题单`,
    })
  }
  const levelOrder = { 高: 0, 中: 1, 低: 2 }
  todoRows.sort((a, b) => (levelOrder[a.level] ?? 3) - (levelOrder[b.level] ?? 3) || num(b.amount) - num(a.amount))
  const todoTruncated = todoRows.length > 300
  const todoFinal = todoRows.slice(0, 300)

  // ── 北极星 ─────────────────────────────────────────────────────────────
  /**
   * 「在册销售人数」的权威口径 = total_performance_analysis.overview.member_count
   * （区间内有成交的成员数，实测 47）。
   *
   * 绝对不能用 sales_performance_ranking 的记录条数当人数 —— 那是 100 条**在册占位**
   * （含 0 业绩 / 已离职成员）。用 100 算人均产出，参照看板的 99.2 万/人会变成 47.5 万/人，
   * 差一倍，人效结论直接反了。所以这里只认 overview.member_count，取不到才退回并注明。
   */
  const overviewMemberCount = numOrNull(overviewRaw.member_count)
  const headcount = overviewMemberCount !== null ? overviewMemberCount : (rankingRows.length || null)
  const perCapita = ratio(signingValue, headcount)
  const headcountNote = overviewMemberCount !== null
    ? '口径：total_performance_analysis.overview.member_count（区间内有成交的成员数，实测 47）；不使用 ranking 条数（在册占位含 0 业绩成员）'
    : '口径：sales_performance_ranking 记录数（在册成员，含 0 业绩占位）—— overview.member_count 不可得，数值仅供参考'
  const northStarRows = [
    {
      key: 'revenue',
      label: '年度营收',
      value: signingValue,
      target: targetTotal > 0 ? targetTotal : null,
      rate: ratio(signingValue, targetTotal),
      status: statusFromRate(ratio(signingValue, targetTotal), 1, 0.8),
      sub: signingSub,
    },
    {
      key: 'stdShare',
      label: 'STD 营收占比',
      value: stdShare,
      target: TH.stdShare,
      rate: stdShare === null ? null : ratio(stdShare, TH.stdShare),
      status: stdShare === null ? 'unknown' : statusFromRate(ratio(stdShare, TH.stdShare), 1, TH.stdShareYellow),
      sub: stdShareNote,
    },
    {
      key: 'bShare',
      label: 'B 类订单占比',
      value: bShare,
      target: TH.bShare,
      rate: ratio(bShare, TH.bShare),
      status: statusFromRate(ratio(bShare, TH.bShare), 1, TH.bShareYellow),
      sub: '口径：抽样加权',
    },
    {
      key: 'cShare',
      label: 'C 类订单占比',
      value: null,
      target: TH.cShare,
      rate: null,
      status: 'unknown',
      sub: '不可得：ERP 未暴露订单级 sale_level，客户分档只回 b_order_share',
    },
    {
      key: 'headcount',
      label: '在册销售人数',
      value: headcount,
      target: null,
      rate: null,
      status: 'unknown',
      sub: headcountNote,
    },
    {
      key: 'perCapita',
      label: '人均产出',
      value: perCapita,
      target: null,
      rate: null,
      status: 'unknown',
      sub: '区间接单额 ÷ 有成交成员数（headcount）',
    },
  ]

  // ── KPI ────────────────────────────────────────────────────────────────
  const kpis = [
    {
      key: 'signing',
      label: '业绩总额（接单额）',
      value: signingValue,
      unit: '元',
      target: targetTotal > 0 ? targetTotal : null,
      rate: ratio(signingValue, targetTotal),
      yoy: yoySigning,
      mom: momSigning,
      yoyStatus: statusFromDelta(yoySigning, TH),
      momStatus: statusFromDelta(momSigning, TH),
      status: globalTargetBasis === 'partial'
        ? 'warn'
        : statusFromRate(ratio(signingValue, targetTotal), 1, 0.8),
      sub: signingSub,
      targetMembers: globalTargetMembers,
      targetBasis: globalTargetBasis,
      targetNote: globalTargetNote,
      completionBasis: globalTargetBasis,
      completionAligned: ratio(globalSigningWithTarget, targetTotal),
    },
    {
      key: 'collection',
      label: '回款额',
      value: collectionAmount,
      unit: '元',
      target: null,
      rate: null,
      yoy: pctChange(collectionAmount, prevCollectionAmount),
      mom: null,
      status: statusFromRate(collectionRate, TH.collectionRate, TH.collectionRateYellow),
      sub: isFiltered
        ? '口径：sales_performance_ranking.collection_amount（已按筛选过滤）'
        : '口径：sales_order_collection_analysis.overview.collection_amount',
    },
    {
      key: 'collectionRate',
      label: '回款率',
      value: collectionRate,
      unit: '',
      target: TH.collectionRate,
      rate: ratio(collectionRate, TH.collectionRate),
      yoy: pctChange(collectionRate, prevCollectionRate),
      mom: null,
      status: statusFromRate(collectionRate, TH.collectionRate, TH.collectionRateYellow),
      sub: '口径：collection_amount ÷ signing_amount',
    },
    {
      key: 'orderCount',
      label: '订单数',
      value: orderCount,
      unit: '单',
      target: null,
      rate: null,
      yoy: pctChange(orderCount, prevOrderCount),
      mom: null,
      status: 'unknown',
      sub: isFiltered
        ? '口径：sales_performance_ranking.order_count（已按筛选过滤）'
        : '口径：total_performance_analysis.overview.order_count',
    },
    {
      key: 'customerCount',
      label: '成交客户数',
      value: customerCount,
      unit: '家',
      target: null,
      rate: null,
      yoy: pctChange(customerCount, prevCustomerCount),
      mom: null,
      status: 'unknown',
      sub: customerCountNote,
      customerCountBasis,
    },
    {
      key: 'uncollected',
      label: '未回款额',
      value: uncollectedAmount,
      unit: '元',
      target: null,
      rate: null,
      yoy: null,
      mom: null,
      status: 'unknown',
      sub: uncollectedNote,
      // 口径三件套都挂在这个 KPI item 上：前端要能在数字旁边显示「这是哪个口径」
      uncollectedNote,
      uncollectedAmountUpstream,
      uncollectedAmountNormalized,
      uncollectedBasis,
    },
    {
      key: 'overdue',
      label: '逾期订单数',
      value: overdueCount,
      unit: '单',
      target: null,
      rate: null,
      yoy: null,
      mom: null,
      status: overdueCount > 0 ? 'warn' : 'good',
      sub: isFiltered
        ? '口径：sales_performance_ranking.overdue_order_count（已按筛选过滤）'
        : '口径：sales_order_collection_analysis.overview.overdue_order_count',
    },
    {
      key: 'avgOrder',
      label: '客单价',
      value: ratio(signingValue, orderCount),
      unit: '元',
      target: null,
      rate: null,
      yoy: null,
      mom: null,
      status: 'unknown',
      sub: '口径：业绩总额 ÷ 订单数',
    },
  ]

  // 当月未完结时，所有带环比的 KPI 都要显式标注，否则环比数字会被当成业绩崩塌。
  if (partialMonth) {
    for (const kpi of kpis) {
      if (kpi.mom === null || kpi.mom === undefined) continue
      kpi.partialMonth = true
      kpi.note = partialMonthNote
    }
  }

  // ── matrix：方案指标 → ERP 承载对象 → 实测结果 → 状态 ───────────────────
  const matrix = buildMatrix({
    rowLimit,
    tierSampleSize,
    visitSampleSize,
    stdProbeBudget,
    stdSigning,
    byMonthAvailable,
    joinedCustomerCount,
    sampleCustomers,
    coverageShare,
    repurchaseTotal,
    repurchaseExcludedNoOrder,
    dormantJudged,
    lookbackSampleSize: lookbackIndex.size,
    visitSampleCount: visitSamples.length,
    followCustomers,
  })

  if (filterNote) warnings.push(filterNote)
  if (tierSampleSize > 0 && tierSamples.length < tierSampleSize) {
    warnings.push(`客户分档抽样达到预算上限，仅覆盖 Top ${tierSamples.length} 客户（计划 ${tierSampleSize}）。`)
  }
  if (todoTruncated) {
    warnings.push('订单待办条目超过 300 条，已按等级与金额截断显示。')
  }

  const payload = {
    ok: true,
    generatedAt: isoLocal(),
    period: {
      startDate,
      endDate,
      days: periodDays,
      prevStartDate: prev.startDate,
      prevEndDate: prev.endDate,
    },
    filters: {
      squad,
      member,
      squads: squadRows.map((s) => ({
        name: s.name,
        headcount: s.headcount,
        activeCount: s.activeCount,
        totalMembers: s.totalMembers,
        headcountNote: s.headcountNote,
      })),
      members: [...squadFilteredActiveMembers]
        .sort((a, b) => num(b.signing_amount) - num(a.signing_amount))
        .map((r) => ({ id: r.member_id ?? null, name: str(r.member_name), squad: squadNameOfRow(r) })),
    },
    meta: {
      cached: false,
      cacheTtlMs: Number(settings.cacheTtlMs) || 0,
      cacheNote: '',
      toolCalls: calls.length,
      budget: budgetLimit,
      elapsedMs: Date.now() - startedAt,
      /** 本次实际生效的预警阈值（自定义后的结果），供页面展示，避免"用户以为改了就生效了"。 */
      thresholds: { ...TH },
      /**
       * 本机实际生效的 MCP 连接器前缀（换设备时最有用的自证信息：
       * 面板上能直接看到「这次到底调的 mcp__xxx__」）。
       */
      toolPrefixes: { ...((toolPlan && toolPlan.prefixes) || {}) },
      /** 每组前缀的来源：config（用户配置）/ discovered（注册表自动发现）/ default（回退默认）。 */
      toolPrefixSource: { ...((toolPlan && toolPlan.sources) || {}) },
    },
    northStar: { rows: northStarRows },
    overview: {
      kpis,
      trend: trendSignature,
      trendPrev: trendPrevSignature,
      trendMonthState,
      squads: squadRows.map((s) => ({
        name: s.name,
        headcount: s.headcount,
        activeCount: s.activeCount,
        totalMembers: s.totalMembers,
        headcountNote: s.headcountNote,
        signing: s.signing,
        target: s.target > 0 ? s.target : null,
        targetMembers: s.targetMembers,
        targetBasis: s.targetBasis,
        targetNote: s.targetNote,
        completion: s.completion,
        completionBasis: s.completionBasis,
        completionAligned: s.completionAligned,
        status: s.status,
        perCapita: s.perCapita,
        perCapitaActive: s.perCapitaActive,
        perCapitaTotal: s.perCapitaTotal,
        collectionRate: s.collectionRate,
        overdue: s.overdue,
        customers: s.customers,
      })),
      ranking: rankingSignature,
      rankingInactive: {
        status: rankingInactiveSignature.length > 0 ? 'partial' : 'unavailable',
        count: rankingInactiveSignature.length,
        rows: rankingInactiveSignature,
        note: rankingFilterNote,
      },
      rankingFilterNote,
      growth: growthSignature,
      targets: { total: targetTotal, count: targetCount },
    },
    quality: {
      abc: {
        status: abcStatus,
        sampleSource: 'top_customers',
        sampleCustomers,
        coverageAmount,
        coverageShare,
        bShare,
        rows: tierRows,
        note: `抽样源为区间成交额 Top N 客户（total_performance_analysis.top_customers，已播种 ${topCustomerSeeded} 个，其中新建 ${topCustomerNew} 个）；ERP 未在订单级暴露 sale_level，按 customer_tier_rating.b_order_share 加权估算。`,
      },
      std: {
        status: stdSigning.ok ? (stdSigning.goodsJudged >= stdSigning.goodsTotal ? 'ok' : 'partial') : 'unavailable',
        basis: 'signing',
        basisLabel: '签单口径（销售出库明细 → 订单签单额按货号行数分摊 → 逐货号判定 STD 产品表）',
        // 卡在哪一步：'shipping'（出库明细就取不到）/ 'probe'（货号判定全失败）/
        // 'no-goods'（窗口内没有可用货号）/ null（没卡住）。前端据此展示，
        // 不要只渲染一句「不可得」—— 读者分不清是卡在第一步还是卡在判定。
        blockedAt: stdBlockedStage(stdSigning),
        // 签单口径（v1.4.0 起的主口径）
        stdSigningAmount: stdSigning.stdSigningAmount,
        nonStdSigningAmount: stdSigning.nonStdSigningAmount,
        signingAmount: stdSigning.signingAmount,
        periodSigningAmount: stdSigning.periodSigningAmount,
        windowSigningAmount: stdSigning.windowSigningAmount,
        coverageSigningShare: stdSigning.coverageSigningShare,
        windowShareOfPeriod: stdSigning.windowShareOfPeriod,
        windowFrom: stdSigning.windowFrom,
        windowTo: stdSigning.windowTo,
        monthsBack: stdSigning.monthsBack,
        monthsMax: stdSigning.monthsMax,
        ordersTotal: stdSigning.ordersTotal,
        ordersWithGoods: stdSigning.ordersWithGoods,
        shippingRows: stdSigning.shippingRows,
        shippingTruncated: stdSigning.shippingTruncated,
        goodsTotal: stdSigning.goodsTotal,
        goodsJudged: stdSigning.goodsJudged,
        goodsUnknown: stdSigning.goodsUnknown,
        goodsProbed: stdSigning.goodsProbed,
        goodsCached: stdSigning.goodsCached,
        goodsAmountTotal: stdSigning.goodsAmountTotal,
        stopped: stdSigning.stopped,
        // 主指标
        stdShare,
        // 报价口径（保留作对照，不再参与占比计算）
        quoteAmount,
        stdAmount,
        probedGoods,
        probedOk: stdProbeOkCount,
        budget: stdProbeBudget,
        coverageAmount: stdSigning.goodsAmountTotal,
        coverageShare: stdCoverageShare,
        note: stdShareNote,
        rows: stdRows,
      },
      model: {
        status: modelRows.length > 0 ? 'partial' : 'unavailable',
        note: '直销/经销占比的分母是**客户档案样本内**的客户总额（customer_analysis 返回的客户档案，limit 封顶 500），不是全公司客户总额；跨样本比较时只看结构比例，不要当份额读。',
        rows: modelRows,
      },
      track: {
        status: trackRows.length > 0 ? 'partial' : 'unavailable',
        rows: trackRows,
      },
      goods: {
        status: goodsRows.length > 0 ? 'partial' : 'unavailable',
        rows: goodsRows,
      },
    },
    collection: {
      kpis: [
        {
          key: 'collectionRate',
          label: '回款率',
          value: collectionRate,
          unit: '',
          target: TH.collectionRate,
          rate: ratio(collectionRate, TH.collectionRate),
          yoy: pctChange(collectionRate, prevCollectionRate),
          mom: null,
          status: statusFromRate(collectionRate, TH.collectionRate, TH.collectionRateYellow),
          sub: '口径：collection_amount ÷ signing_amount',
        },
        {
          key: 'collectionAmount',
          label: '回款额',
          value: collectionAmount,
          unit: '元',
          target: null,
          rate: null,
          yoy: pctChange(collectionAmount, prevCollectionAmount),
          mom: null,
          status: statusFromRate(collectionRate, TH.collectionRate, TH.collectionRateYellow),
          sub: '口径：sales_order_collection_analysis.overview.collection_amount',
        },
        {
          key: 'uncollected',
          label: '未回款额',
          value: uncollectedAmount,
          unit: '元',
          target: null,
          rate: null,
          yoy: null,
          mom: null,
          status: 'unknown',
          sub: uncollectedNote,
          // 与 overview.kpis[] 同名同义：主数值用上游（与业务工作台一致），归一值与口径说明一并下发
          uncollectedNote,
          uncollectedAmountUpstream,
          uncollectedAmountNormalized,
          uncollectedBasis,
        },
        {
          key: 'overdueCount',
          label: '逾期订单数',
          value: overdueCount,
          unit: '单',
          target: null,
          rate: null,
          yoy: null,
          mom: null,
          status: overdueCount > 0 ? 'warn' : 'good',
          sub: '口径：sales_order_collection_analysis.overview.overdue_order_count',
        },
        {
          key: 'overdue90',
          label: '超90天逾期额',
          value: sumBy(overdueRows.filter((r) => r.days > 90), (r) => r.amount),
          unit: '元',
          target: null,
          rate: null,
          yoy: null,
          mom: null,
          status: 'unknown',
          sampled: true,
          sampleSize: orderSample.sampleSize,
          totalKnown: orderSample.totalKnown,
          note: `${orderSampleShortNote}；本值 = 样本内 overdue_days > 90 的未回款金额合计，全量金额 ERP 未提供（overview 只给逾期单数）`,
          sub: '口径：未回款订单中 overdue_days > 90 的金额合计（样本口径）',
        },
      ],
      orderSample,
      // aging / overdue 是对象（不是裸数组）：抽样口径警告必须挂在父对象上，前端才显示
      aging: agingBlock,
      overdue: overdueBlock,
      aftersale: {
        status: afterSaleRows.length > 0 ? 'partial' : 'unavailable',
        // 工具失败 vs 查无记录：前端要能区分「没取到数」和「真的一条都没有」
        dataAvailable: afterSaleAvailable,
        total: aftersaleTotal,
        closed: aftersaleClosed,
        open: aftersaleOpen,
        unknownState: aftersaleUnknownState,
        knownState: aftersaleKnownState,
        // 闭环率分母只算状态已知的记录（closed + open），unknown 不进分母
        rate: ratio(aftersaleClosed, aftersaleKnownState),
        avgHours,
        avgUpdateHours,
        avgHoursSamples: hoursList.length,
        note: aftersaleNote,
        typeNote: afterSaleTypeNote,
        major: majorCount,
        majorBasis: afterSaleMajorBasis,
        closeStateNote:
          '售后闭环三态：status2=1 为已闭环（closed），status2=2 为未闭环（open），status2 缺失为不可得（unknown）；'
          + '闭环率分母只算状态已知的记录，unknown 不计入分母也不计入未闭环数。'
          + aftersaleAvailabilityNote,
        rows: aftersaleRows,
      },
      problem: {
        count: problemCount,
        // 问题单计数来自 overview.problem_order_count，本身就是**全量**，
        // 所以这里标 sampled:false —— 把全量数说成样本，比原来的问题更隐蔽。
        sampled: false,
        sampleSize: null,
        totalKnown: problemCount,
        note: '口径：sales_order_collection_analysis.overview.problem_order_count（全量计数，非样本）；ERP 未返回问题单明细列表',
      },
    },
    customer: {
      tiers: {
        status: sampleCustomers > 0 ? 'sampled' : 'unavailable',
        sampleSource: 'top_customers',
        sampleCustomers,
        rows: tierRows,
        note: `抽样源为区间成交额 Top N 客户（total_performance_analysis.top_customers）；覆盖区间签约额 ${coverageShare === null ? '未知' : `${(coverageShare * 100).toFixed(1)}%`}`,
      },
      repurchase: {
        status: repurchaseTotal > 0 ? 'partial' : 'unavailable',
        sampleSize: repurchaseTotal,
        excludedNoOrder: repurchaseExcludedNoOrder,
        note: repurchaseNote,
        rows: repurchaseRows,
      },
      dormant: {
        status: lookbackIndex.size > 0 ? 'partial' : 'unavailable',
        total: dormantRows.length,
        thresholdDays: dormantThreshold,
        sampleSize: dormantJudged,
        sampleTotal: lookbackIndex.size,
        note: dormantNote,
        rows: dormantRows,
      },
      follow: {
        status: followCustomers > 0 ? 'sampled' : 'unavailable',
        overallRate: ratio(followReached, followCustomers),
        sampleCustomers: visitSamples.length,
        judgedCustomers: followCustomers,
        note: followNote,
        rows: followRows,
      },
      newCustomers: {
        status: customerIndex.size > 0 ? 'partial' : 'unavailable',
        count: newCustomerRows.length,
        prev: prevNewCustomerCount,
        mom: pctChange(newCustomerRows.length, prevNewCustomerCount),
        // 新增客户数是**样本伪值**的前科重灾区：limit 太小会把老客户挤出去，
        // 「新增」只剩最近成交的那批客户里首次成交的少数几个。
        // 所以每次都把样本量摊开给页面，跨年比较时也必须看样本量。
        sampled: true,
        sampleSize: customerIndex.size,
        totalKnown: numOrNull(overviewRaw.customer_count),
        note: `基于 customer_analysis 返回的前 ${customerIndex.size} 个客户档案统计新增（ERP 无独立新增客户表）；区间内成交客户全量为 ${numOrNull(overviewRaw.customer_count) ?? '未知'} 家`,
        rows: newCustomerRows.slice(0, 50),
      },
      top: topCustomerRows,
    },
    funnel: {
      stages: funnelStages,
      trend: funnelTrend,
      attribution: {
        status: 'unavailable',
        rows: [],
        note: 'ERP 无渠道来源字段，9 渠道归因需外部线索系统。',
      },
      threeYear,
      quoteStats,
    },
    growth: {
      levels: { status: levelRows.length > 0 ? 'partial' : 'unavailable', rows: levelRows },
      newbies: {
        status: newbiesRows.length > 0 ? 'partial' : 'unavailable',
        rows: newbiesRows,
        note:
          `新兵口径（用户 2026-10-26 定义）：业务咨询事业群中**尚未转正**的在职成员，` +
          `判定依据是花名册 positive_time 为空（转正日期未回填），或转正日期晚于基准日 ${endDate}。` +
          `花名册共 ${newcomerSelection.stats.total} 人 → 剔除非销售序列 ${newcomerSelection.stats.nonSales} 人、` +
          `剔除已离职 ${newcomerSelection.stats.left} 人、剔除已转正 ${newcomerSelection.stats.confirmed} 人、` +
          `剔除非销售岗 ${newcomerSelection.stats.notSalesPost} 人，实际列示 ${newbiesRows.length} 人。` +
          `注意：「未转正」是当前状态而不是区间事件，所以这张表不随所选区间增减；` +
          `区间只影响业绩 / 客户数的统计口径（${startDate} ~ ${endDate}），入职月数按基准日 ${endDate} 计算。` +
          `业绩口径：优先取销售排行的区间签约额（signingSource=ranking），排行里没有的人退回销售成员明细的接单额（signingSource=member）。` +
          `转正门槛 ${Math.round(newbieTarget / 10000)} 万为方案模板参数（newbieTargetAmount），ERP 无转正目标字段。` +
          `产品考核/技能考核/导师/确认日期 ERP 未提供，不下发（宁可少一列，也不给永远空白的假列）。`,
      },
      training: {
        status: 'unavailable',
        note: 'ERP 无培训场次/参训率/满意度数据源。',
      },
    },
    todo: {
      status: todoFinal.length > 0 ? 'partial' : 'unavailable',
      rows: todoFinal,
    },
    matrix,
    calls,
    warnings,
  }

  return payload
}

// ---------------------------------------------------------------------------
// 客户 / 货号索引构造
// ---------------------------------------------------------------------------

/**
 * 把 customer_analysis 的 customers[] 与 sales[] 合成一张客户视图。
 * 返回 Map<key, record>，key 优先用主键，退化用客户编码。
 */
function buildCustomerIndex(customerRows, salesRows) {
  const byPk = new Map()
  const byCode = new Map()
  for (const row of customerRows) {
    const pk = row.id ?? row.customer_pk ?? null
    const code = row.customer_id ?? row.code ?? null
    const record = {
      key: String(pk ?? code ?? row.customer_name ?? ''),
      pk,
      code: code === null ? null : String(code),
      name: str(row.customer_name),
      kind: str(row.customer_kind),
      principalId: row.principal_id ?? null,
      principalName: null,
      firstDeal: row.first_deal_time ?? null,
      area: str(row.area_name),
      orderCount: 0,
      amount: 0,
      backMoney: 0,
      lastOrder: row.last_order_time ?? null,
    }
    if (!record.key) continue
    // 只有确实有主键时才进 byPk —— 否则 null 主键会挤在同一个 '' 键上互相串味。
    if (pk !== null && pk !== undefined) byPk.set(String(pk), record)
    if (record.code) byCode.set(record.code, record)
  }
  const index = new Map()
  for (const row of salesRows) {
    const pk = row.customer_pk ?? null
    const code = row.customer_id ?? null
    const base = (pk !== null && pk !== undefined ? byPk.get(String(pk)) : null)
      || (code !== null && code !== undefined ? byCode.get(String(code)) : null)
    const key = base ? base.key : String(pk ?? code ?? row.customer_name ?? '')
    if (!key) continue
    let record = index.get(key)
    if (!record) {
      record = base
        ? { ...base }
        : {
            key,
            pk,
            code: code === null ? null : String(code),
            name: str(row.customer_name),
            kind: null,
            principalId: null,
            principalName: null,
            firstDeal: row.first_order_time ?? null,
            area: null,
            orderCount: 0,
            amount: 0,
            backMoney: 0,
            lastOrder: null,
          }
      index.set(key, record)
    }
    record.orderCount += num(row.order_count)
    record.amount += num(row.total_amount)
    record.backMoney += num(row.back_money)
    const last = dateOnly(row.last_order_time)
    if (last && (!record.lastOrder || last > String(record.lastOrder).slice(0, 10))) {
      record.lastOrder = row.last_order_time
    }
    if (!record.firstDeal) record.firstDeal = row.first_order_time ?? null
  }
  // 客户主数据里也有成交信息（有些客户 sales[] 没有行）——补进索引。
  for (const record of [...byPk.values(), ...byCode.values()]) {
    if (!record.key || index.has(record.key)) continue
    index.set(record.key, { ...record })
  }
  return index
}

/** 构造按客户主键 / 名称定位的查询参数（优先主键，避免同名主体错配）。 */
function customerArgs(record) {
  if (record.pk !== null && record.pk !== undefined) return { customer_pk: record.pk }
  if (record.code) return { customer_code: record.code }
  return { customer_name: record.name }
}

/**
 * 把报价明细汇总成货号维度：金额、出现次数、涉及客户数。
 * 金额口径 = Σ(单价 × 数量)（报价口径，不是订单口径 —— ERP 没有订单级货号）。
 */
function buildGoodsMap(records) {
  const map = new Map()
  for (const record of records) {
    const details = Array.isArray(record?.details) ? record.details : []
    for (const detail of details) {
      const code = str(detail?.goods_code)
      if (!code) continue
      let entry = map.get(code)
      if (!entry) {
        entry = { code, name: str(detail.goods_name), amount: 0, orders: 0, customers: new Set() }
        map.set(code, entry)
      }
      if (!entry.name) entry.name = str(detail.goods_name)
      entry.amount += num(detail.price) * num(detail.number)
      entry.orders += 1
      const customer = str(record.customer_name) || str(record.customer_code)
      if (customer) entry.customers.add(customer)
    }
  }
  return map
}

/** 解析 by_month 视图的分组 → Map<'YYYY-MM', count>。 */
function monthCounts(payload) {
  const map = new Map()
  const groups = rowsOf(payload, ['groups'])
  for (const group of groups) {
    const period = monthKey(group?.period ?? group?.month ?? group?.date ?? group?.month_key)
    if (!period) continue
    const count = numOrNull(
      group?.count ?? group?.doc_count ?? group?.total ?? group?.quantity ?? group?.doc_num,
    )
    if (count === null) continue
    map.set(period, count)
  }
  return map
}

/** 三年对比的一行。 */
function buildYearRow(year, totalPayload, quotationPayload, inquiryPayload, customerIndex, startDate, endDate) {
  const overview = sectionOf(totalPayload, 'overview') || {}
  const quotationMetrics = sectionOf(quotationPayload, 'metrics') || {}
  const inquiryMetrics = sectionOf(inquiryPayload, 'metrics') || {}
  const newCustomers = countBy([...customerIndex.values()], (r) => {
    const firstDeal = dateOnly(r.firstDeal)
    return Boolean(firstDeal && firstDeal >= startDate && firstDeal <= endDate)
  })
  return {
    year,
    inquiry: numOrNull(inquiryMetrics.doc_count),
    quotation: numOrNull(quotationMetrics.doc_count),
    quotationAmount: numOrNull(quotationMetrics.amount_total),
    orders: numOrNull(overview.order_count),
    newCustomers,
    // 三年对比里的「新增客户」同样是抽样值，且**每年的样本量不同** ——
    // 拿一个数跨年比会得出「新增在暴涨/崩塌」的错误结论，所以每年都标样本量。
    newCustomersSampled: true,
    newCustomersSampleSize: customerIndex.size,
    newCustomersNote: `基于 customer_analysis 返回的前 ${customerIndex.size} 个客户档案统计（ERP 无独立新增客户表）；各年样本量不同，跨年比较需同时看样本量`,
    // 逐行可读的抽样标记（Client 端按行收集 sampled/note，去重后汇总成一行灰字）
    sampled: true,
    note: `本行新增客户为抽样值：基于 customer_analysis 返回的前 ${customerIndex.size} 个客户档案统计，各年样本量不同，跨年比较需同时看样本量`,
  }
}

/**
 * matrix：方案指标 → ERP 承载对象 → 实测结果 → 状态。
 * status 只有三档：可用 / 部分可用 / 不可用。
 */
function buildMatrix(info) {
  const {
    rowLimit, tierSampleSize, visitSampleSize, stdProbeBudget,
    stdSigning,
    byMonthAvailable, joinedCustomerCount, sampleCustomers,
    coverageShare, repurchaseTotal, repurchaseExcludedNoOrder,
    dormantJudged, lookbackSampleSize, visitSampleCount, followCustomers,
  } = info
  // 签单口径 STD 判定块（可缺省：老调用方/自检夹具可能不传，缺省时按空对象降级）
  const stdInfo = stdSigning && typeof stdSigning === 'object' ? stdSigning : {}
  const stdCoverage = Number(stdInfo.coverageSigningShare)
  const stdCoverageText = Number.isFinite(stdCoverage) ? `${(stdCoverage * 100).toFixed(1)}%` : '未知'
  // STD 卡在哪一步 —— matrix 也要说清楚，不能只说「没判出任何货号」。
  const stdStage = stdBlockedStage(stdInfo)
  const stdStageText = stdStage === 'shipping'
    ? '卡在第一步：出库明细取不到（product_efficiency_analysis 不可用），签单额无法摊到货号'
    : stdStage === 'no-goods'
      ? '出库明细取到了，但窗口内没有可用货号'
      : stdStage === 'probe'
        ? '出库明细取到了，但货号判定全部失败（std 产品表不可用）'
        : null
  return [
    {
      metric: '业绩总额 / 完成率',
      source: 'mcp__erp__total_performance_analysis + sales_performance_ranking',
      result:
        '可用；完成率为自算（区间接单额 ÷ 军令状年度目标），未采用上游 signing_completion_rate（上游为百分数且分母口径不明）；' +
        '军令状目标只覆盖部分有业绩成员（无目标成员贡献业绩却无目标），completion 偏低，已用 targetMembers/targetBasis/targetNote 标出',
      status: '可用',
    },
    {
      metric: '订单 ABC 结构',
      source: 'yx_sale.sale_level（未在订单接口暴露）',
      result: `抽样可得（抽样源：区间成交额 Top 客户 top_customers，覆盖 ${sampleCustomers} 家 / 区间签约额 ${coverageShare === null ? '未知' : `${(coverageShare * 100).toFixed(1)}%`}）`,
      status: '部分可用',
    },
    {
      metric: 'STD 品牌占比',
      source: 'mcp__std__product_efficiency_analysis(inventory_shipping) + mcp__std__std_product_info_query',
      result: stdInfo.ok
        ? `签单口径可得（近 ${stdInfo.monthsBack} 个月出库明细 → 签单额按货号分摊 → 逐货号判定；`
          + `已判定 ${stdInfo.goodsJudged}/${stdInfo.goodsTotal} 个货号，覆盖区间签单额 ${stdCoverageText}）`
        : `不可得（${stdStageText || '没有任何货号判定成功'}；占比按 null 下发，不得按 0% 展示）`,
      status: stdInfo.ok ? '部分可用' : '不可用',
    },
    {
      metric: '9 渠道归因 / 线索量',
      source: 'ERP 无字段',
      result: '不可得',
      status: '不可用',
    },
    {
      metric: 'C 类订单占比',
      source: 'ERP 未在订单接口暴露 sale_level（分档只回 b_order_share）',
      result: '不可得',
      status: '不可用',
    },
    {
      metric: '回款率 / 账龄分桶',
      source: 'mcp__erp__sales_order_collection_analysis.overview + orders[]',
      result: '可用',
      status: '可用',
    },
    {
      metric: '逾期订单明细',
      source: 'mcp__erp__sales_order_collection_analysis.orders[].overdue_days',
      result: `可用（受 limit=${rowLimit} 截断）；collection.overdue 为对象，sampled=true 标明样本口径，totalKnown 为全量订单数，样本内与全量不可混读`,
      status: '部分可用',
    },
    {
      metric: '售后闭环率',
      source: 'mcp__std__after_sale_management_query.status2',
      result: '可用；时长 avgHours 口径为 check_time − add_time（投诉→核销），avgUpdateHours 为 update_time − add_time（非闭环时长），两者不可混用；售后 type 为数字枚举码且无码表，原样显示；'
        + '**售后工具调用失败时（std 服务宕机）闭环率下发 null（不可得），不是 0%** —— closed/open/unknownState 全为 0 属于「没取到数」，'
        + 'collection.aftersale.dataAvailable=false、closeStateNote 里写明「售后数据取不到」',
      status: '可用',
    },
    {
      metric: '重大售后识别',
      source: 'mcp__std__after_sale_management_query.thesis/back_cause 自由文本',
      result: '正文关键词识别（近似口径，非 ERP 枚举字段）',
      status: '部分可用',
    },
    {
      metric: '客户分档（S/A/B/C）',
      source: 'mcp__erp__customer_tier_rating.rating',
      result: `抽样可得（抽样源：区间成交额 Top 客户 top_customers，覆盖 ${sampleCustomers} / 计划 ${tierSampleSize} 家）`,
      status: '部分可用',
    },
    {
      metric: 'B 类订单占比',
      source: 'mcp__erp__customer_tier_rating.metrics.b_order_share',
      result: '抽样加权估算',
      status: '部分可用',
    },
    {
      metric: '直销 / 经销结构',
      source: 'mcp__erp__customer_analysis.customers[].customer_kind + customer_info',
      result: `可用（受 limit=${rowLimit} 截断）`,
      status: '部分可用',
    },
    {
      metric: '客户赛道',
      source: 'mcp__erp__customer_tier_rating.qcc.industry',
      result: `抽样可得（覆盖 ${sampleCustomers} 家）`,
      status: '部分可用',
    },
    {
      metric: 'Top 产品 / 货号',
      source: 'mcp__erp__quotation_query.records[].details[]',
      result: '报价口径可得（ERP 无订单级货号）',
      status: '部分可用',
    },
    {
      metric: '复购分档',
      source: 'mcp__erp__customer_analysis.sales[].order_count',
      result: `部分可用（分母只含区间内订单数 ≥ 1 的客户 ${repurchaseTotal} 家；另有 ${repurchaseExcludedNoOrder} 家无订单记录已排除；受 limit=${rowLimit} 截断）`,
      status: '部分可用',
    },
    {
      metric: '沉睡客户',
      source: 'mcp__erp__customer_analysis（近 12 个月窗口）',
      result: `部分可用（仅对样本内有末次订单时间的客户判定，参与判定 ${dormantJudged} 家 / 样本 ${lookbackSampleSize} 家；受 limit=${rowLimit} 截断）`,
      status: '部分可用',
    },
    {
      metric: '跟进达标率',
      source: 'mcp__erp__sales_customer_360.visits[]',
      result: `抽样可得（计划 ${visitSampleSize} 家，实际抽样 ${visitSampleCount} 家、${followCustomers} 家参与判定）`,
      status: '部分可用',
    },
    {
      metric: '新增客户 / 同比',
      source: 'mcp__erp__customer_analysis.customers[].first_deal_time',
      result: '可用（新增客户为抽样值，customer_analysis 上限 500 条；已用 sampled/sampleSize/note 标出）',
      status: '部分可用',
    },
    {
      metric: '获客漏斗',
      source: 'mcp__erp__inquiry_plan_query + quotation_query + total_performance_analysis',
      result: '分段不同源，比值仅作参考',
      status: '部分可用',
    },
    {
      metric: '月度漏斗走势',
      source: 'quotation_query / inquiry_plan_query view=by_month',
      result: byMonthAvailable ? '可用' : `退化为按明细记录统计（受 limit=${rowLimit} 截断）`,
      status: byMonthAvailable ? '可用' : '部分可用',
    },
    {
      metric: '三年对比',
      source: 'mcp__erp__total_performance_analysis / quotation_query / inquiry_plan_query / customer_analysis',
      result: '同期区间三年对比可得',
      status: '可用',
    },
    {
      metric: '梯队效能 / 人均产出',
      source: 'mcp__erp__sales_performance_ranking.department_name',
      result:
        `${joinedCustomerCount > 0 ? '可用（客户数按客户→负责人→成员去重）' : `可用（客户数为成员客户数合计，受 limit=${rowLimit} 截断）`}` +
        '；人数两个口径：headcount/activeCount=区间内有业绩人数（与 CONTRACT 示例的 战狼 11 对齐），totalMembers=ERP 在册成员数（含 0 业绩占位），人均产出按有业绩人数算更贴近真实人效；' +
        '军令状目标覆盖度：targetMembers=配了目标的成员数，targetBasis=partial 表示部分有业绩成员无目标，completion 被低估（completionAligned 为同口径对照值）',
      status: '可用',
    },
    {
      metric: '客户数口径（KPI）',
      source: 'mcp__erp__total_performance_analysis.overview.customer_count / customer_analysis + sales_performance_ranking',
      result:
        '可用（三种口径，KPI 上以 customerCountBasis 标注当前用的是哪一种）：' +
        '① erp-overview=不筛选时用 ERP 全量区间成交客户数；' +
        '② dedup=筛选时按「客户→负责人→成员→梯队」去重的真实客户数；' +
        '③ member-sum=join 不上时退回成员客户数合计（可能跨成员重复，且受 limit 截断）；' +
        '**不再使用 uniqueCount(r.customer_count)** —— 那数的是「客户数这个数字有多少不同取值」，根本不是客户数',
      status: '可用',
    },
    {
      metric: '未回款口径（主 KPI 上游 / 明细归一）',
      source: 'sales_order_collection_analysis / member_performance_analysis / sales_customer_360',
      result:
        '可用（**两层口径，不混**）：主 KPI 与 collection 数据卡的「未回款额」用 ERP overview 上游 uncollected_amount'
        + '（与业务工作台《作战看板》一致，用户核对的是它）；'
        + '账龄、逾期明细、客户档案订单、业务员档案订单按「签约额 − 已回款额」归一（上游把部分回款的订单按全额计入，订单级虚高）；'
        + '归一值另存 uncollectedAmountNormalized、上游原值另存 uncollectedAmountUpstream，差额写进 uncollectedNote；'
        + '上游缺签约额或已回款额时归一值为 null，不拿上游冒充',
      status: '可用',
    },
    {
      metric: '业务员排行 / 在役口径',
      source: 'mcp__erp__sales_performance_ranking.ranking[]',
      result:
        '排行表与业务员筛选器只列在役成员（区间内签约额 > 0 或订单数 > 0）；' +
        '0 业绩 / 离职占位成员单列在 overview.rankingInactive，避免「有这么多人在跑业绩」的错觉，并防止人均口径分母被占位撑大',
      status: '部分可用',
    },
    {
      metric: '绩效档位分布',
      source: 'mcp__std__performance_assessment.level_distribution',
      result: '按区间末月快照，非区间汇总',
      status: '部分可用',
    },
    {
      metric: '新兵入职跟踪',
      source: 'mcp__std__staff_info.join_time（不覆盖销售序列）',
      result: '技术/市场/行政序列可见，销售序列缺失；产品考核/技能考核/师傅/预计转正日期 ERP 无数据源，不下发该列',
      status: '部分可用',
    },
    {
      metric: '培训场次 / 参训率',
      source: 'ERP 无字段',
      result: '不可得',
      status: '不可用',
    },
    {
      metric: '订单待办清单',
      source: 'sales_order_collection_analysis + inquiry_plan_query + after_sale_management_query + ranking',
      result: '可用（按等级截断）',
      status: '部分可用',
    },
  ]
}

// ---------------------------------------------------------------------------
// AI 对话（多轮）—— 用 Host 的 llm 服务解读「当前板块数据」
// ---------------------------------------------------------------------------
/**
 * 定位与边界（先说清楚这个模块**不做什么**）：
 *   · AI 只做**解读**，不参与取数、不参与口径计算。模型看到的只有前端传来的
 *     aiContext（也就是本插件刚算出来的那份载荷），所以它答不出的口径就是真答不出，
 *     不允许它「按经验补一个数」——这与本插件「宁可承认不完整」的口径底线一致。
 *   · 实现与 @local/erp-dashboard 的 ai.chat 同源（那边 index.js:7955-8324），
 *     差别只在请求体字段名与默认模型来源。
 *
 * 移植时做的两处适配（避免在本文件再造一套重复的通用工具函数）：
 *   ① 参照实现用 toArray()，本文件没有这个函数 —— 改用本文件已有的 rowsOf(raw, [])，
 *      语义一致（非数组一律当空数组）；
 *   ② str() / num() 两边语义完全一致（str 对非字符串返回 null），直接复用。
 */

/** 送进模型的对话历史条数上限（含本轮），避免上下文无限膨胀。 */
const CHAT_HISTORY_LIMIT = 12
/** 单条 assistant 回复的保留长度——模型自己会把长回复概括，不必原样回灌。 */
const CHAT_ASSISTANT_CHARS = 1500
/** 每轮都带的数据 JSON 截断长度，与单次解读保持一致。 */
const CHAT_CONTEXT_CHARS = 12000

/** 分析师角色段：定调「只讲数据里有的」。 */
const ANALYST_ROLE = [
  '你是一名严谨的企业经营数据分析师，服务于中国医药标准品/杂质对照品企业的销售团队。',
  '你会收到一个销售作战看板的结构化数据（JSON）。请直接给出可执行的分析，不要复述数据。',
  '重要：直接输出最终结论，不要输出思考过程，不要输出 <think> 标签。',
  '所有数字必须来自给你的 JSON；某个口径缺失就明确说「该口径不可得」，绝不允许估算或编造。',
].join('\n')

/** 对话模式的追加约束（比单次解读更短、结论先行）。 */
const CHAT_MODE_RULES = [
  '对话模式追加要求：',
  '1) 只回答与当前看板板块相关的问题；',
  '2) 若问题超出当前板块数据的范围，直接说明「当前只加载了本板块数据，无法回答」，不要猜测；',
  '3) 用中文 Markdown 回答；',
  '4) 先给结论，再给依据；',
  '5) 回答控制在 6 行以内。',
].join('\n')

/** 去掉模型内联的思考块（MiniMax 等会在 content 里输出 <think>…</think>）。 */
function stripThink(text) {
  return String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/gi, '')
    .replace(/<\/?think>/gi, '')
    .trim()
}

/**
 * 单次模型调用（多轮对话版）：接受一整串 {role, content} 消息。
 *
 * 与参照实现一致：options 固定 provider / model / system / messages / temperature /
 * maxTokens / signal，可选 reasoningEffort；流式消费 text-delta / reasoning-delta / finish。
 * finish.reason.kind==='error' → 取 reason.failure.message；'aborted' → 视为超时。
 */
async function streamOnceMessages(llm, candidate, system, messages, timeoutMs, effort, temperature) {
  const options = {
    provider: candidate.provider,
    model: candidate.model,
    system,
    messages: messages.map((message) => ({
      role: message.role,
      content: [{ type: 'text', text: String(message.content) }],
    })),
    temperature: temperature === undefined || temperature === null ? 0.3 : temperature,
    // 推理模型会先思考再作答，预算太小会导致正文写不出来。
    maxTokens: 30000,
    signal: AbortSignal.timeout(timeoutMs),
  }
  if (effort !== undefined && effort !== null) options.reasoningEffort = effort
  const stream = llm.stream(options)
  let text = ''
  let reasoning = ''
  let failure = null
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'reasoning-delta') reasoning += chunk.text
    else if (chunk.type === 'finish') {
      const reason = chunk.reason || {}
      if (reason.kind === 'error') failure = (reason.failure && reason.failure.message) || '模型调用失败'
      else if (reason.kind === 'aborted') failure = '模型调用超时或被中止'
    }
  }
  const answer = stripThink(text)
  if (failure !== null && answer === '') throw new Error(failure)
  if (answer === '') {
    throw new Error(
      `模型只产出了思考内容（${(reasoning + text).length} 字）而没有正文，通常是推理强度过高或 token 预算不足`,
    )
  }
  return answer
}

/** provider 的 id / name / label 只要有一处命中 /minimax/i 就算（大小写不敏感）。 */
function isMinimaxProvider(provider) {
  if (!provider) return false
  return /minimax/i.test(`${str(provider.id) || ''} ${str(provider.name) || ''} ${str(provider.label) || ''}`)
}

/**
 * 收集候选模型，优先级：
 *   1. settings.aiProvider（显式配置，最高）
 *   2. ctx.get('agentDefaultModel').currentSelection()（当前默认模型）
 *   3. 注册表里 id/name 匹配 minimax 的 provider 的首个模型
 *   4. 其它已注册 provider 的首个模型（兜底）
 *
 * 注意：这里只拿到 provider / model 两个标识，**任何 API key 都不会进入候选对象**。
 * llm.listProviders() / llm.listModels(id) 各自 try/catch，某个 provider 取不到模型就跳过。
 */
async function collectCandidates(llm, ctx, settings) {
  const candidates = []
  const preferred = settings && settings.aiProvider ? String(settings.aiProvider) : ''
  if (preferred !== '') {
    candidates.push({
      provider: preferred,
      model: settings && settings.aiModel ? String(settings.aiModel) : '',
    })
  }
  try {
    const modelSvc = ctx.get ? ctx.get('agentDefaultModel') : undefined
    const selection = modelSvc && typeof modelSvc.currentSelection === 'function' ? modelSvc.currentSelection() : null
    if (selection && selection.provider && selection.model) {
      candidates.push({ provider: selection.provider, model: selection.model })
    }
  } catch {
    /* 忽略：继续用注册表兜底 */
  }
  const modelsByProvider = new Map()
  let minimaxCandidate = null
  try {
    const providers = await llm.listProviders()
    for (const provider of (Array.isArray(providers) ? providers : []).slice(0, 6)) {
      const id = provider && provider.id
      if (!id) continue
      try {
        const models = await llm.listModels(id)
        const first = Array.isArray(models) && models.length > 0 ? models[0] : null
        if (first && first.id) {
          modelsByProvider.set(id, first.id)
          if (minimaxCandidate === null && isMinimaxProvider(provider)) {
            minimaxCandidate = { provider: id, model: first.id }
          }
        }
      } catch {
        /* 该 provider 取不到模型，跳过 */
      }
    }
  } catch {
    /* listProviders 不可用则只用默认模型 */
  }
  // 配置里只给了 provider 没给 model 时，用该 provider 的首个模型补上
  if (candidates.length > 0 && candidates[0].provider === preferred && candidates[0].model === '') {
    candidates[0].model = modelsByProvider.get(preferred) || ''
  }
  // minimax 插到「显式配置 / agentDefaultModel」之后、「其它 provider」之前。
  // 若上面两个来源本来就是 minimax，则已存在，不重复插入（保持它在前面的位置）。
  if (minimaxCandidate !== null && !candidates.some((c) => c.provider === minimaxCandidate.provider)) {
    candidates.push(minimaxCandidate)
  }
  for (const [id, model] of modelsByProvider) {
    if (candidates.some((c) => c.provider === id)) continue
    candidates.push({ provider: id, model })
  }
  return candidates
}

/**
 * 依次尝试候选模型：每个候选先跑低推理强度，失败再退回不指定。
 * 超时/中止直接换模型（换 effort 意义不大）；effort 相关报错才换 effort。
 * 最多试 5 个候选，全失败才抛错并带回每个候选的失败原因。
 */
async function runWithCandidates(usable, invoke, errorLabel) {
  const failures = []
  for (const candidate of usable.slice(0, 5)) {
    // 先用低推理强度（默认配置是 high，会把 token 全用在思考上）；
    // 低强度不被支持时再退回不指定。
    for (const effort of ['low', null]) {
      try {
        const text = await invoke(candidate, effort)
        if (text.trim() !== '') {
          return { ok: true, text, model: `${candidate.provider}/${candidate.model}`, failures }
        }
        failures.push(`${candidate.provider}/${candidate.model}: 返回空内容`)
        break
      } catch (error) {
        const message = error && error.message ? error.message : String(error)
        // 超时/中止：换模型比换 effort 更有意义
        if (/timeout|timed out|aborted|超时|中止/i.test(message)) {
          failures.push(`${candidate.provider}/${candidate.model}: ${message}`)
          break
        }
        if (effort === 'low' && /effort|reasoning|unsupported|invalid/i.test(message)) {
          continue
        }
        failures.push(`${candidate.provider}/${candidate.model}: ${message}`)
        break
      }
    }
  }
  throw new Error(`${errorLabel}（已尝试 ${Math.min(usable.length, 5)} 个模型）：${failures.join(' ｜ ')}`)
}

/**
 * 清洗前端回传的历史消息：只保留 user / assistant 两种角色、丢掉空内容，
 * assistant 内容截断到 CHAT_ASSISTANT_CHARS，并只保留末尾 CHAT_HISTORY_LIMIT 条。
 */
function normalizeChatMessages(raw) {
  const out = []
  // 本文件没有 toArray，用已有的 rowsOf 代替（语义一致：非数组一律当空数组）。
  for (const item of rowsOf(raw, [])) {
    const role = str(item && item.role) === 'assistant' ? 'assistant' : 'user'
    const content = str(item && item.content)
    // 纯空白（前端输入框残留的空格）视为无内容，别塞给模型
    if (content === null || content.trim() === '') continue
    out.push({ role, content: role === 'assistant' ? content.slice(0, CHAT_ASSISTANT_CHARS) : content })
  }
  return out.slice(-CHAT_HISTORY_LIMIT)
}

/**
 * 把多轮历史压成「只用 user 角色」的对话，再交给模型。
 *
 * 为什么必须这么做（真实实测，不是猜的）：
 * DSH 的 llm 服务一旦收到**带正文的 assistant 消息**就抛
 * `Cannot read properties of undefined (reading 'replayState')`，
 * 而且所有候选模型全部失败，整个 ai.chat 直接 500。对照实验：
 *   assistant content 为空串        → 正常
 *   assistant 完全没有 content 字段 → 正常
 *   连续两条 user（没有 assistant）  → 正常
 *   assistant content 有正文        → 失败
 * 说明这是上游对 assistant 回合的处理缺陷，不是我们消息形状不对。
 *
 * 但多轮对话又必须让模型看到「自己上一轮说了什么」，否则追问会答非所问。
 * 所以这里把历史的问/答成对折进一条 user 消息（最后一条问题单独成条），
 * 语义保住，同时只用 user 角色，避开上游缺陷。单轮时输出与改造前完全一致。
 */
function foldHistoryToUserTurns(messages) {
  const lastIndex = messages.length - 1
  const head = messages.slice(0, lastIndex)
  const tail = messages[lastIndex]
  const lines = []
  for (let i = 0; i < head.length; i += 1) {
    const m = head[i]
    if (m.role === 'assistant') continue
    let entry = `问：${m.content}`
    const next = head[i + 1]
    if (next && next.role === 'assistant' && String(next.content).trim() !== '') {
      entry += `\n答：${next.content}`
      i += 1
    }
    lines.push(entry)
  }
  const out = []
  if (lines.length === 1) out.push({ role: 'user', content: lines[0] })
  else if (lines.length > 1) {
    out.push({ role: 'user', content: `本次会话此前的对话记录：\n\n${lines.join('\n\n')}` })
  }
  if (tail && tail.role === 'user') out.push({ role: 'user', content: tail.content })
  return out
}

/**
 * AI 对话：在当前看板板块的数据范围内做多轮问答。
 *
 * 请求体：{ payload: { title, aiContext }, messages: [{role, content}], question }
 *   · payload.aiContext —— 当前板块的数据 JSON，每轮都带（不是只带一次）；
 *   · messages —— 前端回传的历史，会被 normalizeChatMessages 清洗；
 *   · question —— 本轮问题（可空：空但有历史也算有效追问）。
 *
 * 返回体与参照实现同构：{ ok, text, model, failures }，便于前端复用同一套渲染。
 * 异常直接抛出去，交给 HTTP handler 统一转成 {ok:false,error}。
 */
async function aiChat(ctx, request, settings) {
  const payload = request && request.payload ? request.payload : null
  // 必须用 ctx.get(...)：未声明的属性直接访问会抛错，整段 try/catch。
  const llm = ctx.get ? ctx.get('llm') : undefined
  if (!llm || typeof llm.stream !== 'function') {
    throw new Error('llm 服务不可用，无法执行 AI 对话')
  }

  const history = normalizeChatMessages(request && request.messages)
  const rawQuestion = str(request && request.question)
  // 纯空白同样按「没传问题」处理，否则会白跑一次模型。
  const question = rawQuestion === null || rawQuestion.trim() === '' ? null : rawQuestion
  // 既没有历史也没有新问题 = 没话可聊，直接报参数错，不要白跑一次模型。
  if (history.length === 0 && question === null) throw new TypeError('question 不能为空')

  const messages = history.slice()
  if (question !== null) {
    // 与最后一条 user 重复时不重复追加（前端通常会回显上一问）。
    const last = messages[messages.length - 1]
    if (!last || last.role !== 'user' || last.content !== question) {
      messages.push({ role: 'user', content: question })
    }
  }
  const trimmed = messages.slice(-CHAT_HISTORY_LIMIT)
  // 上游 llm 服务处理不了带正文的 assistant 回合（见 foldHistoryToUserTurns 注释），
  // 折成只用 user 角色再发。单轮时输出与改造前完全一致。
  const safeMessages = foldHistoryToUserTurns(trimmed)

  const title = String((payload && payload.title) || '销售作战看板')
  const context = payload && payload.aiContext ? payload.aiContext : payload
  const system = `${ANALYST_ROLE}\n${CHAT_MODE_RULES}`
  // 数据 JSON 作为本轮的第一条 user 消息，每轮都带（不是只带一次）。
  const dataTurn = {
    role: 'user',
    content: [
      `看板：${title}`,
      '数据 JSON：',
      JSON.stringify(context, null, 2).slice(0, CHAT_CONTEXT_CHARS),
    ].join('\n\n'),
  }

  const candidates = await collectCandidates(llm, ctx, settings)
  const usable = candidates.filter((c) => c.provider && c.model)
  if (usable.length === 0) throw new Error('未找到可用的模型配置，无法执行 AI 对话')

  return runWithCandidates(
    usable,
    (candidate, effort) => streamOnceMessages(llm, candidate, system, [dataTurn, ...safeMessages], 180000, effort, 0.5),
    'AI 对话失败',
  )
}

/**
 * 导出给 selfcheck.mjs 用的函数集合（纯函数 + 可注入假 llm 的异步函数）。
 *
 * 刻意**不叫 Config**：框架会对 `export const Config` 调 `Config.validate(...)`，
 * schemastery 的 z.object 上没有这个方法，插件会在激活期直接崩
 * （Cannot read properties of undefined (reading 'validate')）。
 */
export const ai = {
  stripThink,
  normalizeChatMessages,
  foldHistoryToUserTurns,
  isMinimaxProvider,
  collectCandidates,
  runWithCandidates,
  streamOnceMessages,
  aiChat,
  CHAT_HISTORY_LIMIT,
  CHAT_ASSISTANT_CHARS,
  CHAT_CONTEXT_CHARS,
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

/** 读取 HTTP 请求体并按 JSON 解析；空体返回 {}。 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      // 请求体只有日期与筛选条件，超过 64KB 一律视为异常调用。
      if (size > 64 * 1024) {
        reject(new RangeError('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch (error) {
        reject(new TypeError(`invalid JSON body: ${error.message}`))
      }
    })
    req.on('error', reject)
  })
}

// ---------------------------------------------------------------------------
// 六、明细路由：customer.dashboard / member.dashboard / customer.geo
//
// 主看板（dashboard）是「全局汇总」，这三条是「单客户 / 单业务员 / 地域」。
// 三条路由与主看板共用同一套 MCP 封装（callTool + 工具前缀方案 + 作用域重试），
// 但**口径彼此独立**，且每一条都必须在自己的文案里写死自己是什么口径：
//   · 区间口径（periodMetrics）= 用户选的那一段区间；
//   · 全周期口径（lifetime）= 该客户在 ERP 里的历史累计；
//   · 年度口径（target）= 今年 1/1 至今 ÷ 年度军令状目标。
// 三个口径混着说，页面上的数字就会互相打架，用户的结论必然是错的。
//
// 共同的底线（与主看板一致）：
//   · 取不到就写 null + 说明，绝不拿 0 冒充；
//   · 单个工具失败 → 该板块空值 + warnings + calls[].ok=false，整条路由不 reject；
//   · 抽样口径必须写 sampled / sampleSize / totalKnown；
//   · PII（手机号、邮箱、地址、统一社会信用代码、银行账号）绝不进 payload，也绝不落盘。
// ---------------------------------------------------------------------------

/** 明细路由的取数器：记账 calls[]、控预算、失败降级（绝不 reject）。 */
function createDetailRunner(ctx, toolPlan, settings, budget) {
  const calls = []
  const warnings = []
  const alternatesByName = (toolPlan && toolPlan.alternatesByName) || new Map()
  const timeoutMs = Number(settings.requestTimeoutMs) > 0 ? Number(settings.requestTimeoutMs) : DEFAULTS.requestTimeoutMs
  let used = 0
  const run = async (tool, label, args, timeoutOverrideMs) => {
    if (used >= budget) {
      const note = `调用预算已达上限（${budget} 次），「${label}」未执行`
      calls.push({ tool, label, ok: false, ms: 0, note })
      warnings.push(note)
      return { ok: false, value: null }
    }
    used += 1
    const startedAt = Date.now()
    try {
      const callTimeoutMs = Number(timeoutOverrideMs) > 0 ? Number(timeoutOverrideMs) : timeoutMs
      const value = await callTool(ctx, tool, args, callTimeoutMs, alternatesByName.get(tool))
      calls.push({ tool, label, ok: true, ms: Date.now() - startedAt, note: '' })
      return { ok: true, value }
    } catch (error) {
      const note = compactUpstreamMessage(error && error.message ? error.message : String(error))
      calls.push({ tool, label, ok: false, ms: Date.now() - startedAt, note })
      warnings.push(`「${label}」取数失败：${note}`)
      return { ok: false, value: null }
    }
  }
  return { calls, warnings, run, usedCount: () => used, budget }
}

/** 有并发上限的 map：ERP 服务并发一高就会整体变慢，这里限流。 */
async function mapLimit(items, limit, fn) {
  const list = Array.isArray(items) ? items : []
  const results = new Array(list.length)
  let cursor = 0
  const workerCount = Math.max(1, Math.min(num(limit) || 1, list.length))
  const workers = []
  for (let w = 0; w < workerCount; w += 1) {
    workers.push((async () => {
      for (;;) {
        const index = cursor
        cursor += 1
        if (index >= list.length) return
        try {
          results[index] = await fn(list[index], index)
        } catch {
          results[index] = null
        }
      }
    })())
  }
  await Promise.all(workers)
  return results
}

/**
 * 跟进记录 visits[].data 是**JSON 字符串**，里面混着 PII
 * （recipient_phone / recipient_address 之类）。
 * 这里只挑出白名单字段（时间 / 内容 / 备注 / 礼品 / 拜访对象），
 * 其余一律丢弃 —— 不是「暂时不用」，是**不许出现在 payload 与缓存里**。
 */
function parseVisitPayload(raw) {
  if (raw && typeof raw === 'object') return raw
  if (typeof raw !== 'string' || !raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * 客户生命周期阶段推导。
 * 判定依据全部来自 ERP 真实字段（首单时间 / 连续合作年数 / 距末单天数），
 * 阈值是**本插件自己定的业务口径**（ERP 没有「阶段」字段），所以必须把依据写进 note。
 */
function deriveCustomerStage(input) {
  const firstOrderTime = dateOnly(input?.firstOrderTime)
  const endDate = input?.endDate
  const continuousYears = numOrNull(input?.continuousYears)
  const daysSinceLastOrder = numOrNull(input?.daysSinceLastOrder)
  const periodOrderCount = numOrNull(input?.periodOrderCount)
  if (!firstOrderTime) {
    return { stage: '未知', basis: 'ERP 未提供首单时间，无法判定生命周期阶段' }
  }
  const days = diffDays(firstOrderTime, endDate)
  const months = days === null ? null : Math.max(0, Math.round(days / 30))
  const gap = daysSinceLastOrder
  let stage = '新客期'
  let basis = ''
  if (gap !== null && gap > 180) {
    stage = '沉睡期'
    basis = `距末单 ${gap} 天（> 180 天判沉睡）`
  } else if ((continuousYears ?? 0) >= 3 || (months !== null && months >= 36)) {
    stage = '成熟期'
    basis = `连续合作 ${continuousYears ?? Math.round((months || 0) / 12)} 年（≥ 3 年判成熟）`
  } else if (months !== null && months >= 12) {
    stage = '成长期'
    basis = `首单距今 ${months} 个月且尚未沉睡（≥ 12 个月判成长）`
  } else {
    stage = '新客期'
    basis = `首单距今 ${months ?? '未知'} 个月（< 12 个月判新客）`
  }
  const periodNote = periodOrderCount === null
    ? '区间内是否有成交不可得（订单明细未取到）。'
    : (periodOrderCount > 0 ? `区间内有 ${periodOrderCount} 单成交。` : '区间内无成交。')
  return { stage, basis: `${basis}。${periodNote}` }
}

/**
 * 年度口径窗口：今年 1/1 ~ 今天。
 * 若所选区间不是当前年份（查历史年度），年度窗口退化为该年的 1/1 ~ 区间末。
 */
function pickYearWindow(endDate) {
  const today = isoLocal().slice(0, 10)
  const year = Number(endDate.slice(0, 4))
  const todayYear = Number(today.slice(0, 4))
  const isCurrentYear = year === todayYear
  return {
    startDate: `${year}-01-01`,
    endDate: isCurrentYear ? (today > endDate ? endDate : today) : endDate,
    year,
    isCurrentYear,
  }
}

/** 把一个日期区间切成自然月窗口（上游没有 offset，只能靠换时间窗把订单取全）。 */
function monthWindowsBetween(startDate, endDate) {
  const windows = []
  let cursor = startDate
  let guard = 0
  while (cursor <= endDate && guard < 240) {
    guard += 1
    const year = Number(cursor.slice(0, 4))
    const month = Number(cursor.slice(5, 7))
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
    const monthEnd = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
    const end = monthEnd > endDate ? endDate : monthEnd
    windows.push({ startDate: cursor, endDate: end })
    const nextMonth = month === 12 ? 1 : month + 1
    const nextYear = month === 12 ? year + 1 : year
    cursor = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`
  }
  return windows
}

/**
 * 客户详情路由（customer.dashboard）。
 *
 * 口径分工（**三个口径不许混**）：
 *   · periodMetrics ← sales_customer_360.sales_metrics（区间口径）
 *   · lifetime      ← customer_analysis 的客户级汇总行（**不带日期参数** → 全周期口径）
 *   · rating        ← customer_tier_rating（分档标准自带 12 个月 / 全周期口径）
 */
/**
 * 状态码 → 中文文本。
 *
 * ERP 的状态字段一律是数字枚举，而且**没有随接口下发码表**。
 * 这里按已知约定自行映射，并在 notes 里注明「文本是插件按状态码映射的，
 * ERP 未提供码表」——不能让前端以为这些词是上游原样给的。
 */
const INQUIRY_STATUS_TEXT = { 0: '未定稿', 1: '进行中' }
const INQUIRY_REPLY_STATUS_TEXT = {
  0: '默认',
  1: '待领取',
  2: '答复中',
  3: '已完成',
  4: '无方案项目',
  5: '统筹已撤销',
  6: '复核待确认',
  7: '复核中',
}
const QUOTATION_STATUS_TEXT = { 0: '未定稿', 1: '进行中' }
const QUOTATION_PROGRESS_TEXT = { 0: '默认', 1: '跟进中', 2: '已成交', 3: '已终止' }

/** 询价单答复状态归类：已答复 / 待处理 / 无方案或已撤销。 */
function inquiryReplyState(code) {
  const value = numOrNull(code)
  if (value === null) return null
  if (value === 2 || value === 3) return '已答复'
  if (value === 4 || value === 5) return '无方案或已撤销'
  if (value === 0 || value === 1 || value === 6 || value === 7) return '待处理'
  return null
}

/** 报价单阶段：已成交 / 已过期 / 已定价 / 报价中。 */
function quotationStageText(row) {
  const progress = numOrNull(row?.progress)
  if (progress === 2) return '已成交'
  if (progress === 3) return '已终止'
  const expired = dateOnly(row?.expired_time)
  if (expired && expired < isoLocal().slice(0, 10)) return '已过期'
  if (dateOnly(row?.determine_time)) return '已定价'
  return '报价中'
}

/**
 * 逾期天数归一。
 *
 * 上游 `overdue_days` 的口径是「距离账期到期日的天数」：
 *   · 正数 = 已经逾期 N 天；
 *   · 负数 = 还没到期（还有 N 天到期）；
 *   · 0    = 今天到期。
 * 前端拿到的原值若是 -63，就会显示成「逾期 -63 天」——比没逾期还好看，
 * 属于把数据说反了。所以这里统一归一：
 *   · overdueDays < 0 → null（**未到期，不算逾期**）；
 *   · 另给一个布尔 overdue（只有 overdueDays > 0 才为 true），让前端
 *     不必再自己猜符号的含义。
 * 归一规则写进 notes，让看的人知道这个 null 是「未到期」而不是「取数失败」。
 */
function normalizeOverdueDays(value) {
  const raw = numOrNull(value)
  if (raw === null) return { overdueDays: null, overdue: null }
  if (raw < 0) return { overdueDays: null, overdue: false }
  return { overdueDays: raw, overdue: raw > 0 }
}

/**
 * 订单状态（sale_state）字典。
 *
 * ERP 本身**不提供** sale_state 的码表（参照插件 erp-dashboard 也只是原样透传数字），
 * 所以这里的文字不是官方字典，而是 lead 实测推出来的**经验口径**：
 * 取 2026-01 / 2026-04 / 2026-08 三个月的订单明细做交叉验证：
 *   · sale_state = 1 → 45 单，其中全额回款 8 / 未回款 33 / 部分回款 4，
 *     区间回款率 17.8%，逾期 18 单 → **在途未完成**；
 *   · sale_state = 2 → 260 单，其中全额回款 240 / 未回款 2 / 部分回款 18，
 *     区间回款率 92.3%，逾期 7 单 → **已完成**。
 * 因此：1 = 在途未完成，2 = 已完成。
 *
 * 口径纪律：原始码照样下发（saleState），文字另存（saleStateLabel），
 * 前端可只用文字；notes 里写明这是经验推断，不是 ERP 官方字典，
 * 真有官方码表时改这里即可。
 */
const SALE_STATE_TEXT = {
  1: '在途未完成',
  2: '已完成',
}

/**
 * 把 sale_state 映射成可读文字（取不到就返回 null，绝不猜）。
 */
function saleStateLabel(value) {
  const raw = numOrNull(value)
  if (raw === null) return null
  const key = String(raw)
  return SALE_STATE_TEXT[key] ?? `状态码 ${raw}`
}

/**
 * 判断「这一片订单是不是被上游截断了」。
 *
 * 实机硬事实（lead 裸 RPC 测出来的）：上游 sales_order_collection_analysis 的 limit
 * **被硬顶在 500 行** —— limit 传 2000 也只返回 500 行，而且**没有 offset / 翻页参数**。
 * 所以判截断**绝对不能看「返回行数 == limit」**：那个判据在 limit>500 时永远成立，
 * 结果就是永远触发不了拆分，区间订单永远缺一块（实机 5739 单只聚到 4731 单）。
 *
 * 正确判据是**同一次响应里的 overview.order_count**（上游给出的该窗口订单总数）：
 *   · 行数 < overview.order_count → 这一片被截断 → 按日期对半拆两片重查；
 *   · 每个子片用**它自己那次响应**的 overview.order_count 判定，
 *     不能拿父窗口的数去比子片（父窗口的数天然更大，会让子片一直判定为「被截断」）。
 * overview.order_count 取不到时，退回「行数顶到上游上限」的保守判据（宁可多拆一次）。
 */
function isOrderSliceTruncated(ordersLength, overviewOrderCount, sliceLimit) {
  const len = numOrNull(ordersLength) ?? 0
  const expected = numOrNull(overviewOrderCount)
  if (expected !== null) return len < expected
  const limit = numOrNull(sliceLimit) ?? 0
  return limit > 0 && len >= limit
}

/**
 * 未回款口径归一（**全插件共用的唯一入口**）。
 *
 * 上游的 `uncollected_amount` 不是「签约额 − 已回款额」，而是把**部分回款**的订单
 * 按**全额**计入未回款 —— 一张 10 万签单、已回 6 万的订单，上游记 10 万未回款，
 * 真实在途只有 4 万。于是：
 *   · 「在途未回款」比真实值高一截；
 *   · 账龄柱高、逾期明细金额、09 业务员档案的「未回款」全都虚高；
 *   · 同一个数在不同页面还不一样（客户档案页归一过、主看板没有）。
 *
 * 归一口径：**签约额 − 已回款额**（分子分母必须同源，都取同一张订单行）。
 * 上游原值另存 `upstream`，两套数都留着；差额写进 notes，让看的人自己判断。
 * 分子或分母取不到时**回落上游原值**并标 `basis:'upstream'` —— 宁可给上游口径，
 * 也不能凭空造一个数出来（那才是把数据说假）。
 *
 * @param {*} signing   签约额（上游 signing_amount / order_total_amount）
 * @param {*} collected 已回款额（上游 collection_amount / back_money）
 * @param {*} upstream  上游 uncollected_amount 原值（可空）
 * @returns {{value: number|null, upstream: number|null, basis: string, fallback: boolean}}
 */
function normalizeUncollectedAmount(signing, collected, upstream) {
  const sign = numOrNull(signing)
  const coll = numOrNull(collected)
  const up = numOrNull(upstream)
  if (sign !== null && coll !== null) {
    return {
      value: Number((sign - coll).toFixed(2)),
      upstream: up,
      basis: 'signing-minus-collection',
      fallback: false,
    }
  }
  return {
    value: up,
    upstream: up,
    basis: up === null ? 'unknown' : 'upstream',
    fallback: true,
  }
}

/**
 * 员工在职状态的中文标签。
 *
 * 口径来源：**staff_info.status**（ERP 员工档案）。
 * 实测该字段 0 = 离职、非 0 = 在职（含试用），而 status_name 是 GBK 误解码乱码，
 * 只能用数值判（与「新兵入职跟踪」那套判定同一个规则，见 selectNewcomers）。
 *
 * 注意：sales_person_360.profile.status 是**另一套编码**（在役业务员实测恒为 2），
 * 与 staff_info 的 0/1/2 不是一回事，所以这里**只认 staff_info 的值**，
 * 拿不到就返回 null 并在 notes 里说明「在职状态不可得」，绝不硬套一套码表。
 */
function staffStatusLabel(status) {
  const raw = numOrNull(status)
  if (raw === null) return null
  if (raw === 0) return '离职'
  return '在职'
}

/**
 * STD 签单口径**卡在哪一步**（纯函数）。
 *
 * 背景：STD 服务（8006）整台宕机时，`quality.std` 只剩一句「不可得」。
 * 但「不可得」有三种完全不同的原因，对应的处理方式也不同：
 *   · shipping —— **第一步就卡住了**：出库明细都取不到，签单额根本没法摊到货号上，
 *     所以一个货号都没探测过。这时候抱怨「判定失败」是误导：
 *     不是判定失败，是压根没走到判定那一步。
 *   · probe —— 出库明细拿到了，货号也识别出来了，但**逐个查 STD 产品表全失败**
 *     （std 产品表接口不可用 / 超时）。
 *   · no-goods —— 出库明细拿到了，但**窗口内没有可用货号**（签单额没落到任何货号行上）。
 *
 * 返回 'shipping' | 'probe' | 'no-goods' | null（null = 没卡，判定成功）。
 * 导出是为了让 selfcheck 能对「三种卡点分别给不同文案」做行为级断言。
 */
function stdBlockedStage(info) {
  const src = info && typeof info === 'object' ? info : {}
  if (src.ok) return null
  if (num(src.shippingRows) <= 0) return 'shipping'
  if (num(src.goodsTotal) <= 0) return 'no-goods'
  return 'probe'
}

/**
 * STD 卡点对应的中文说明（纯函数）。
 *
 * 三种卡点的文案必须**分开写**：读者要知道「卡在第一步」还是「卡在判定」，
 * 否则每次都只能看到一句「不可得」，既不知道该找谁修，也容易误以为是「我们没有 STD 业务」。
 *
 * 所有卡点都保留「不得按 0% 展示」这句 —— 判定不出来 ≠ 占比为 0，
 * 报 0% 等于替 ERP 断言「我们确认没有 STD 业务」，那是编造。
 */
function stdBlockedText(stage, info) {
  const src = info && typeof info === 'object' ? info : {}
  const suffix = '；占比未知（null），不得按 0% 展示'
  if (stage === 'shipping') {
    return '不可得：出库明细取不到（product_efficiency_analysis 不可用），无法把签单额摊到货号 → 签单口径 STD 占比不可得'
      + suffix
  }
  if (stage === 'no-goods') {
    return '不可得：出库明细拿到了，但窗口内没有可用货号' + suffix
  }
  if (stage === 'probe') {
    // 判定有结果但分摊金额为 0（货号行的行金额都是 0）也是一种「probe 卡住」，
    // 文案要分开，否则会把「算不出金额」说成「判定失败」。
    if (num(src.goodsJudged) > 0) {
      return '不可得：出库明细拿到了、货号也识别出来了，但分摊到货号的签单额为 0（出库明细里这些货号行的金额为 0）' + suffix
    }
    return '不可得：出库明细拿到了，但货号判定全部失败（std 产品表不可用）' + suffix
  }
  return '不可得：STD 签单口径没有成功判出任何货号' + suffix
}

/**
 * 把客户档案 join 到「负责人 → 成员 → 梯队」，统计**真实去重客户数**。
 *
 * 为什么必须要这一步（A2）：
 * `sales_performance_ranking.customer_count` 是**每个成员各自报的客户数**，
 * 同一个客户如果由两个成员跟单就会被数两次；把它 uniqueCount 一下更糟 ——
 * 那算的是「客户数这个数字有多少个不同取值」（5 个成员都报 17 家 → 结果是 1）。
 * 唯一能拿到真实客户数的地方是 customer_analysis 的客户档案：
 * 客户 → principal_id（负责人）→ member_id（成员）→ 梯队，逐级 join 后按客户去重。
 *
 * join 不上（principal_id 与 member_id 不是同一套 id）时返回 joined=0，
 * 调用方退回「成员客户数合计」，并在口径说明里写明该口径可能跨成员重复。
 *
 * @param {Iterable} customerRecords buildCustomerIndex 产出的客户记录
 * @param {Map<string,string>} memberIdToSquad 成员 id → 梯队名
 */
function dedupCustomerJoin(customerRecords, memberIdToSquad) {
  const squadSets = new Map()
  const memberSets = new Map()
  // joined 用**去重后的客户数**计数，而不是参与 join 的记录条数 ——
  // 调用方拿它当「这条口径能不能用」的开关，混进重复行会让计数虚高。
  const joinedKeys = new Set()
  for (const record of customerRecords) {
    const principalId = record.principalId
    if (principalId === null || principalId === undefined) continue
    const squadName = memberIdToSquad.get(String(principalId))
    if (!squadName) continue
    joinedKeys.add(record.key)
    if (!squadSets.has(squadName)) squadSets.set(squadName, new Set())
    squadSets.get(squadName).add(record.key)
    const memberKey = String(principalId)
    if (!memberSets.has(memberKey)) memberSets.set(memberKey, new Set())
    memberSets.get(memberKey).add(record.key)
  }
  return { joined: joinedKeys.size, squadSets, memberSets }
}

/**
 * 单客户详情路由（customer.dashboard）。
 *
 * 口径分工（**三套口径互不相通，notes 里逐条写明**）：
 *   · periodMetrics ← sales_customer_360.sales_metrics + sales_order_collection_analysis.overview
 *                     （**所选区间**口径）
 *   · lifetime      ← customer_analysis 的客户级汇总行 + 全周期订单窗口
 *                     （**全周期**口径，ERP 没有「至今」开关，只能用
 *                      start_date='2000-01-01' 的窗口把历史订单逼出来）
 *   · rating        ← customer_tier_rating（**近 12 个月**口径的分档）
 *   · benchmark     ← total_performance_analysis（**区间总盘**口径）
 *
 * 未回款口径归一：上游 uncollected_amount 把「部分回款」的订单按全额计入，
 * 数值虚高。本插件统一按「签约额 − 已回款额」自算，上游原值另存
 * uncollectedAmountUpstream，差额写进 notes —— 两套数都留着，让看的人自己判断。
 */
async function collectCustomerDashboard(ctx, settings, req, toolPlan) {
  const tools = (toolPlan && toolPlan.names) || TOOL
  const startDate = assertDate(req?.startDate, 'startDate')
  const endDate = assertDate(req?.endDate, 'endDate')
  if (startDate > endDate) {
    throw new RangeError(
      `erp-sales-dashboard: startDate (${startDate}) must not be after endDate (${endDate})`,
    )
  }
  const query = typeof req?.name === 'string' && req.name.trim() ? req.name.trim() : null
  const code = typeof req?.customerCode === 'string' && req.customerCode.trim() ? req.customerCode.trim() : null
  const pk = numOrNull(req?.customerPk)
  if (!query && !code && pk === null) {
    throw new TypeError('erp-sales-dashboard: customer.dashboard 需要 name / customerCode / customerPk 之一')
  }

  const runner = createDetailRunner(
    ctx,
    toolPlan,
    settings,
    Math.max(4, num(settings.detailBudget) || DEFAULTS.detailBudget),
  )
  const notes = []
  const warnings = runner.warnings

  // ── 1. 客户定位（同名多主体必须消歧）──────────────────────────────────
  let searchRows = []
  let resolvedPk = pk
  let resolvedCode = code
  let resolvedName = query
  let resolvedKind = null
  let resolvedPrincipal = null
  if (pk === null && !code && query) {
    const searchRes = await runner.run(tools.customerSearch, '客户检索', { customer_name: query, limit: 20 })
    searchRows = rowsOf(searchRes.value).filter((row) => row && typeof row === 'object')
    if (searchRows.length === 0) {
      throw new TypeError(`erp-sales-dashboard: 未找到客户「${query}」`)
    }
    const picked = searchRows[0]
    resolvedPk = numOrNull(picked.customer_pk)
    resolvedCode = str(picked.customer_code) ?? null
    resolvedName = str(picked.customer_name) ?? query
    resolvedKind = str(picked.customer_kind) ?? null
    resolvedPrincipal = str(picked.principal_name) ?? null
    if (searchRows.length > 1) {
      notes.push(
        `ERP 里有 ${searchRows.length} 个同名主体，已默认取第一个（${resolvedName} / ${resolvedCode || '无编码'}），其余候选见 resolved.candidates。`,
      )
    }
  }

  // ── 2. 核心取数（并行）────────────────────────────────────────────────
  const c360Args = { start_date: startDate, end_date: endDate, detail_limit: 60 }
  if (resolvedPk !== null) c360Args.customer_pk = resolvedPk
  else if (resolvedCode) c360Args.customer_code = resolvedCode
  else c360Args.customer_name = resolvedName

  // customer_analysis **不带日期** → sales[] 才是全周期口径（带日期就是区间口径）。
  const analysisArgs = { limit: 500 }
  if (resolvedPk !== null) analysisArgs.customer_pk = resolvedPk
  else if (resolvedCode) analysisArgs.customer_code = resolvedCode
  else analysisArgs.name = resolvedName

  const tierArgs = { base_date: endDate }
  if (resolvedCode) tierArgs.customer_code = resolvedCode
  else tierArgs.customer_name = resolvedName

  const collectionArgs = {
    start_date: startDate,
    end_date: endDate,
    order_status: 'all',
    limit: Math.max(50, num(settings.rowLimit) || DEFAULTS.rowLimit),
  }
  if (resolvedPk !== null) collectionArgs.customer_pk = resolvedPk
  else if (resolvedCode) collectionArgs.customer_code = resolvedCode
  else collectionArgs.customer_name = resolvedName

  // 全周期口径另取一次订单窗口：上游没有「至今」开关，只能把起点拉到建档之前。
  const lifetimeCollectionArgs = {
    start_date: '2000-01-01',
    end_date: endDate,
    order_status: 'all',
    limit: Math.max(50, num(settings.rowLimit) || DEFAULTS.rowLimit),
  }
  if (resolvedPk !== null) lifetimeCollectionArgs.customer_pk = resolvedPk
  else if (resolvedCode) lifetimeCollectionArgs.customer_code = resolvedCode
  else lifetimeCollectionArgs.customer_name = resolvedName

  const [c360Res, analysisRes, tierRes, collectionRes, lifetimeRes] = await Promise.all([
    runner.run(tools.c360, '客户 360 画像（区间口径）', c360Args),
    runner.run(tools.customer, '客户档案与全周期成交（无日期参数＝全周期）', analysisArgs),
    runner.run(tools.tier, '客户分档（S/A/B/C）', tierArgs),
    runner.run(tools.collection, '区间订单与回款', collectionArgs),
    runner.run(tools.collection, '全周期订单与回款（2000-01-01 起）', lifetimeCollectionArgs),
  ])

  const c360 = c360Res.value || {}
  const c360Profile = sectionOf(c360, 'profile') || {}
  const salesMetrics = sectionOf(c360, 'sales_metrics') || {}
  const c360Trend = rowsOf(c360, ['trend'])
  const c360Visits = rowsOf(c360, ['visits'])
  const c360Inquiries = rowsOf(c360, ['inquiries'])
  const c360Quotations = rowsOf(c360, ['quotations'])
  const c360AfterSales = rowsOf(c360, ['after_sales'])
  const c360RiskTags = rowsOf(c360, ['risk_tags'])
    .map((tag) => (typeof tag === 'string' ? tag : str(tag?.name) ?? null))
    .filter((tag) => tag !== null)

  const analysis = analysisRes.value || {}
  const analysisCustomers = rowsOf(analysis, ['customers'])
  const analysisSales = rowsOf(analysis, ['sales'])

  const tierPayload = tierRes.value || {}
  const ratingRaw = sectionOf(tierPayload, 'rating') || {}
  const tierMetrics = sectionOf(tierPayload, 'metrics') || {}
  const qccRaw = tierPayload.qcc && typeof tierPayload.qcc === 'object' ? tierPayload.qcc : null

  const collectionPayload = collectionRes.value || {}
  const collectionOverview = sectionOf(collectionPayload, 'overview') || {}
  const orderRows = rowsOf(collectionPayload, ['orders'])
  const lifetimeOverview = sectionOf(lifetimeRes.value || {}, 'overview') || {}

  // ── 3. 候选列表（同名消歧，带成交汇总）───────────────────────────────
  const salesByPk = new Map()
  for (const row of analysisSales) {
    if (!row) continue
    const key = numOrNull(row.customer_pk)
    if (key !== null && !salesByPk.has(String(key))) salesByPk.set(String(key), row)
  }
  const candidates = searchRows.map((row) => {
    const candidatePk = numOrNull(row.customer_pk)
    const sale = candidatePk !== null ? salesByPk.get(String(candidatePk)) : null
    return {
      customerPk: candidatePk,
      customerCode: str(row.customer_code) ?? null,
      customerName: str(row.customer_name) ?? null,
      orderCount: numOrNull(sale?.order_count),
      totalAmount: numOrNull(sale?.total_amount),
    }
  })

  // ── 4. 区间口径（periodMetrics）───────────────────────────────────────
  const periodSigning = numOrNull(salesMetrics.signing_amount) ?? numOrNull(collectionOverview.signing_amount)
  const periodCollection = numOrNull(salesMetrics.collection_amount) ?? numOrNull(collectionOverview.collection_amount)
  const periodUncollectedUpstream = numOrNull(salesMetrics.uncollected_amount) ?? numOrNull(collectionOverview.uncollected_amount)
  const periodUncollected = periodSigning !== null && periodCollection !== null
    ? Number((periodSigning - periodCollection).toFixed(2))
    : null
  const periodOrderCount = numOrNull(salesMetrics.order_count) ?? numOrNull(collectionOverview.order_count)
  const orderDates = orderRows
    .map((row) => dateOnly(row.sale_ht_date))
    .filter((value) => value !== null)
    .sort()
  const periodFirstOrderTime = orderDates.length > 0 ? orderDates[0] : null
  const periodLastOrderTime = orderDates.length > 0 ? orderDates[orderDates.length - 1] : null

  const periodMetrics = {
    orderCount: periodOrderCount,
    signingAmount: periodSigning,
    collectionAmount: periodCollection,
    uncollectedAmount: periodUncollected,
    uncollectedAmountUpstream: periodUncollectedUpstream,
    unpaidOrderCount: numOrNull(salesMetrics.unpaid_order_count) ?? numOrNull(collectionOverview.unpaid_order_count),
    partialPaidOrderCount:
      numOrNull(salesMetrics.partial_paid_order_count) ?? numOrNull(collectionOverview.partial_paid_order_count),
    overdueOrderCount: numOrNull(salesMetrics.overdue_order_count) ?? numOrNull(collectionOverview.overdue_order_count),
    problemOrderCount: numOrNull(salesMetrics.problem_order_count) ?? numOrNull(collectionOverview.problem_order_count),
    finishedOrderCount: null,
    collectionRate: ratio(periodCollection, periodSigning),
    uncollectedRate: ratio(periodUncollected, periodSigning),
    overdueOrderRate: ratio(
      numOrNull(salesMetrics.overdue_order_count) ?? numOrNull(collectionOverview.overdue_order_count),
      periodOrderCount,
    ),
    avgOrderAmount: ratio(periodSigning, periodOrderCount),
    firstOrderTime: periodFirstOrderTime,
    lastOrderTime: periodLastOrderTime,
  }
  notes.push(
    `periodMetrics 是**区间口径**（${startDate} ~ ${endDate}，来自 sales_customer_360.sales_metrics 与 sales_order_collection_analysis.overview），与 lifetime（全周期）、rating（近 12 个月）不是同一口径，不许混读。`,
  )
  notes.push(
    'ERP 在客户维度不提供「已完结订单数」，periodMetrics.finishedOrderCount 取不到，置 null（不是 0）。',
  )
  if (periodUncollected !== null && periodUncollectedUpstream !== null && Math.abs(periodUncollected - periodUncollectedUpstream) > 1) {
    notes.push(
      `未回款口径已归一：区间未回款按「签约额 − 已回款额」自算为 ${periodUncollected} 元，`
      + `上游 uncollected_amount 原值为 ${periodUncollectedUpstream} 元（部分回款的订单被按全额计入，故偏高）；差额 ${Number((periodUncollectedUpstream - periodUncollected).toFixed(2))} 元，原值另存 periodMetrics.uncollectedAmountUpstream。`,
    )
  }

  // ── 5. 全周期口径（lifetime）──────────────────────────────────────────
  const lifeRow = analysisSales.find((row) => {
    if (!row) return false
    if (resolvedPk !== null && numOrNull(row.customer_pk) === resolvedPk) return true
    if (resolvedCode && str(row.customer_id) === resolvedCode) return true
    return false
  }) || analysisSales[0] || null
  const lifetimeOrderCount = numOrNull(lifeRow?.order_count)
  const lifetimeSigning = numOrNull(lifeRow?.total_amount)
  const lifetimeCollection = numOrNull(lifeRow?.back_money)
  const lifetimeUncollected = lifetimeSigning !== null && lifetimeCollection !== null
    ? Number((lifetimeSigning - lifetimeCollection).toFixed(2))
    : null
  const lifetime = {
    orderCount: lifetimeOrderCount,
    signingAmount: lifetimeSigning,
    collectionAmount: lifetimeCollection,
    uncollectedAmount: lifetimeUncollected,
    uncollectedAmountUpstream: null,
    unpaidOrderCount: numOrNull(lifetimeOverview.unpaid_order_count),
    partialPaidOrderCount: numOrNull(lifetimeOverview.partial_paid_order_count),
    overdueOrderCount: numOrNull(lifetimeOverview.overdue_order_count),
    problemOrderCount: numOrNull(lifetimeOverview.problem_order_count),
    collectionRate: ratio(lifetimeCollection, lifetimeSigning),
    uncollectedRate: ratio(lifetimeUncollected, lifetimeSigning),
    firstOrderTime: dateOnly(lifeRow?.first_order_time) ?? null,
    lastOrderTime: dateOnly(lifeRow?.last_order_time) ?? null,
  }
  notes.push(
    'lifetime 是**全周期口径**：金额与订单数取 customer_analysis（不带日期参数）的客户级汇总行，逾期/未回款/问题单数取全周期订单窗口（2000-01-01 ~ 区间末）的汇总；与 periodMetrics 的区间口径不是同一口径。',
  )
  if (!lifetimeRes.ok) {
    warnings.push('全周期订单窗口取数失败，lifetime 里的逾期/未回款/问题单数为 null（不是 0）。')
  }
  // 全周期口径双来源交叉核对：对不上就如实告警，不偷偷选一个。
  const tierCumulative = numOrNull(tierMetrics.amount_cumulative)
  const tierOrderCountAll = numOrNull(tierMetrics.order_count_all)
  if (tierCumulative !== null && lifetimeSigning !== null && Math.abs(tierCumulative - lifetimeSigning) > 1) {
    warnings.push(
      `全周期金额两个来源不一致：customer_analysis 汇总行 ${lifetimeSigning} 元，customer_tier_rating.amount_cumulative ${tierCumulative} 元；已分别标注，未做取舍。`,
    )
  }
  if (tierOrderCountAll !== null && lifetimeOrderCount !== null && tierOrderCountAll !== lifetimeOrderCount) {
    warnings.push(
      `全周期订单数两个来源不一致：customer_analysis 汇总行 ${lifetimeOrderCount} 单，customer_tier_rating.order_count_all ${tierOrderCountAll} 单。`,
    )
  }

  // ── 6. 分档（rating）──────────────────────────────────────────────────
  const ratingBlock = {
    available: Object.keys(ratingRaw).length > 0,
    ruleVersion: str(ratingRaw.rule_version) ?? null,
    ruleSource: str(ratingRaw.rule_source) ?? null,
    baseDate: dateOnly(ratingRaw.base_date) ?? null,
    totalScore: numOrNull(ratingRaw.total_score),
    totalScoreRaw: numOrNull(ratingRaw.total_score_raw),
    tier: str(ratingRaw.tier) ?? null,
    tierName: str(ratingRaw.tier_name) ?? null,
    nextTierGap: numOrNull(ratingRaw.next_tier_gap),
    completenessPct: numOrNull(ratingRaw.completeness_pct),
    isLowerBound: ratingRaw.is_lower_bound === undefined ? null : ratingRaw.is_lower_bound === true,
    missingItems: rowsOf(ratingRaw, ['missing_items'])
      .map((item) => (typeof item === 'string' ? item : str(item?.item) ?? str(item?.name) ?? null))
      .filter((item) => item !== null),
    riskAlerts: rowsOf(ratingRaw, ['risk_alerts'])
      .map((item) => (typeof item === 'string' ? item : str(item?.message) ?? str(item?.alert) ?? null))
      .filter((item) => item !== null),
    breakdown: rowsOf(ratingRaw, ['breakdown']).map((item) => ({
      code: str(item.code) ?? null,
      dimension: str(item.dimension) ?? null,
      item: str(item.item) ?? null,
      maxScore: numOrNull(item.max_score),
      score: numOrNull(item.score),
      value: numOrNull(item.value),
      basis: str(item.basis) ?? null,
      dataSource: str(item.data_source) ?? null,
      status: str(item.status) ?? null,
    })),
    dimensions: Object.entries(
      ratingRaw.dimension_scores && typeof ratingRaw.dimension_scores === 'object' ? ratingRaw.dimension_scores : {},
    ).map(([name, value]) => ({
      name,
      score: numOrNull(value?.score),
      maxScore: numOrNull(value?.max_score),
      definedMax: numOrNull(value?.defined_max),
      undefinedScore: numOrNull(value?.undefined_score),
      scoreFolded: numOrNull(value?.score_folded),
    })),
    upgradeRules: rowsOf(ratingRaw, ['upgrade_rules']).map((item) => ({
      rule: str(item.rule) ?? null,
      hit: item.hit === undefined ? null : item.hit === true,
      detail: str(item.detail) ?? null,
      evidence: str(item.evidence) ?? null,
    })),
    vetoRules: rowsOf(ratingRaw, ['veto_rules']).map((item) => ({
      rule: str(item.rule) ?? null,
      hit: item.hit === undefined ? null : item.hit === true,
      detail: str(item.detail) ?? null,
      evidence: str(item.evidence) ?? null,
    })),
    metrics: {
      amount12m: numOrNull(tierMetrics.amount_12m),
      amountPrev12m: numOrNull(tierMetrics.amount_prev_12m),
      amountCumulative: numOrNull(tierMetrics.amount_cumulative),
      collected12m: numOrNull(tierMetrics.collected_12m),
      orderCount12m: numOrNull(tierMetrics.order_count_12m),
      orderCountAll: numOrNull(tierMetrics.order_count_all),
      daysSinceLastOrder: numOrNull(tierMetrics.days_since_last_order),
      continuousYears: numOrNull(tierMetrics.continuous_years),
      yoyRate: numOrNull(tierMetrics.yoy_rate),
      categoryCount: numOrNull(tierMetrics.category_count),
      overdueRate: numOrNull(tierMetrics.overdue_rate),
      overdueOrderCount12m: numOrNull(tierMetrics.overdue_order_count_12m),
      accountPeriodDays: numOrNull(tierMetrics.account_period_days),
    },
    categoryNames: rowsOf(tierMetrics, ['category_names'])
      .map((item) => (typeof item === 'string' ? item : str(item?.name) ?? null))
      .filter((item) => item !== null),
    qcc: qccRaw
      ? {
        name: str(qccRaw.name) ?? null,
        creditCode: str(qccRaw.credit_code) ?? null,
        status: str(qccRaw.status) ?? null,
        startDate: dateOnly(qccRaw.start_date) ?? null,
        registCapital: numOrNull(qccRaw.regist_capital),
        econKind: str(qccRaw.econ_kind) ?? null,
        personScope: str(qccRaw.person_scope) ?? null,
        insuredCount: numOrNull(qccRaw.insured_count),
        industry: str(qccRaw.industry) ?? null,
        subIndustry: str(qccRaw.sub_industry) ?? null,
        isListed: qccRaw.is_listed === undefined ? null : qccRaw.is_listed === true,
      }
      : null,
  }
  if (ratingBlock.tier === null) {
    warnings.push('客户分档取不到（customer_tier_rating 未返回 tier），rating 里的分数与档位为 null。')
  }

  // ── 7. 生命周期（lifecycle）───────────────────────────────────────────
  const firstOrderTime = dateOnly(tierMetrics.first_order_time) ?? lifetime.firstOrderTime
  const lastOrderTime = dateOnly(tierMetrics.last_order_time) ?? lifetime.lastOrderTime
  const stageInfo = deriveCustomerStage({
    firstOrderTime,
    continuousYears: numOrNull(tierMetrics.continuous_years),
    daysSinceLastOrder: numOrNull(tierMetrics.days_since_last_order),
    periodOrderCount: periodMetrics.orderCount,
    endDate,
  })
  const visits = c360Visits.map((row) => {
    const parsed = parseVisitPayload(row.data)
    return {
      time: str(parsed.time) ?? str(parsed.visit_time) ?? dateOnly(row.add_time) ?? null,
      recipientName: str(parsed.recipient_name) ?? str(parsed.recipient) ?? str(parsed.visit_name) ?? null,
      giftContent: str(parsed.gift_content) ?? null,
      remarks: str(parsed.remarks) ?? null,
      festival: str(parsed.festival) ?? null,
      completeState: str(parsed.complete_state) ?? str(parsed.state) ?? null,
    }
  })
  const inquiries = c360Inquiries.map((row) => {
    const replyStatus = numOrNull(row.reply_status)
    return {
      code: str(row.code) ?? null,
      status: numOrNull(row.status),
      statusText: str(row.status_name) ?? INQUIRY_STATUS_TEXT[numOrNull(row.status)] ?? null,
      replyStatus,
      replyText: str(row.reply_status_name) ?? INQUIRY_REPLY_STATUS_TEXT[replyStatus] ?? null,
      replyState: inquiryReplyState(replyStatus),
      addTime: dateOnly(row.add_time) ?? str(row.add_time) ?? null,
    }
  })
  const quotations = c360Quotations.map((row) => ({
    code: str(row.code) ?? null,
    quotationAmount: numOrNull(row.quotation_amount),
    progress: numOrNull(row.progress),
    progressText: str(row.progress_name) ?? QUOTATION_PROGRESS_TEXT[numOrNull(row.progress)] ?? null,
    statusText: str(row.status_name) ?? QUOTATION_STATUS_TEXT[numOrNull(row.status)] ?? null,
    stageText: quotationStageText(row),
    expiredTime: dateOnly(row.expired_time) ?? str(row.expired_time) ?? null,
  }))
  const afterSales = c360AfterSales.map((row) => {
    const status2 = numOrNull(row.status2)
    return {
      saleCode: str(row.sale_code) ?? null,
      type: numOrNull(row.type),
      typeText: null,
      status: numOrNull(row.status),
      statusText: status2 === 1 ? '已闭环' : (status2 === 2 ? '未闭环' : null),
      thesis: str(row.thesis) ?? null,
      conclusion: str(row.conclusion) ?? null,
      discussCount: null,
      replyCount: null,
      addTime: dateOnly(row.add_time) ?? str(row.add_time) ?? null,
      latestProcessTime: dateOnly(row.update_time) ?? str(row.update_time) ?? null,
    }
  })
  const lifecycle = {
    // ── 生命周期阶段（B3）──────────────────────────────────────────────
    // 原来 stage 只被算出来、写进 notes，**结构化字段里没有**，
    // 前端只能把 notes 整段贴出来自己解析文字 —— 既不好用也不可靠。
    // 现在 stage / stageBasis / 首末单时间 / 连续合作年数 / 距末单天数都单独下发，
    // stageBasis 说明这个阶段是按什么依据推出来的（口径是插件自定的，必须可追溯）。
    stage: stageInfo.stage,
    stageBasis: stageInfo.basis,
    firstOrderTime,
    lastOrderTime,
    continuousYears: numOrNull(tierMetrics.continuous_years),
    daysSinceLastOrder: numOrNull(tierMetrics.days_since_last_order),
    monthlyTrend: c360Trend.map((row) => ({
      period: str(row.period) ?? null,
      orderCount: numOrNull(row.order_count),
      signingAmount: numOrNull(row.signing_amount),
      collectionAmount: numOrNull(row.collection_amount),
    })),
    visits,
    inquiries,
    quotations,
    afterSales,
    notes: {
      stage:
        '生命周期阶段是**本插件自算**（ERP 无「生命周期」字段）：> 180 天未下单判沉睡期、'
        + '连续合作 ≥ 3 年判成熟期、首单距今 ≥ 12 个月判成长期、其余判新客期；'
        + 'stageBasis 给出每个阶段的具体依据，取不到依据时 stage 为「未知」而不是猜一个。',
      afterSales:
        'ERP 售后类型是数字枚举码且未提供码表，typeText 置 null；typeText / statusText 由插件按状态码映射，'
        + 'discussCount / replyCount 上游未提供，置 null；未闭环的售后（status2≠1）请配合 todo 使用。',
    },
    counts: {
      visits: visits.length,
      inquiries: inquiries.length,
      quotations: quotations.length,
      afterSales: afterSales.length,
    },
  }
  notes.push(
    `客户阶段为**本插件自算**（ERP 无「生命周期」字段）：${stageInfo.basis} 阈值口径：> 180 天未下单判沉睡、连续合作 ≥ 3 年判成熟、首单距今 ≥ 12 个月判成长、其余判新客。`,
  )
  notes.push(
    'lifecycle.visits 只保留时间/收件人姓名/礼品/备注/节日/完成状态；上游 visits[].data 里的手机号与地址整条丢弃（PII 红线）。',
  )
  notes.push(
    '询价/报价的状态文本由插件按状态码映射（ERP 未随接口下发码表），不代表上游原文。',
  )

  // ── 8. 对标（benchmark）：**总盘口径**，不是抽样排名 ───────────────────
  const benchRes = await runner.run(tools.total, '区间总盘（对标分母）', {
    start_date: startDate,
    end_date: endDate,
    trend: 'month',
    top_limit: 100,
  })
  const benchPayload = benchRes.value || {}
  const benchOverview = sectionOf(benchPayload, 'overview') || {}
  const topCustomers = rowsOf(benchPayload, ['top_customers'])
    .filter((row) => row && typeof row === 'object')
    .sort((a, b) => num(b.order_total_amount) - num(a.order_total_amount))
  const totalSigningAmount = numOrNull(benchOverview.order_total_amount)
  const totalOrderCount = numOrNull(benchOverview.order_count)
  const totalCustomerCount = numOrNull(benchOverview.customer_count)
  const selfIndex = topCustomers.findIndex((row) => {
    if (resolvedPk !== null && numOrNull(row.customer_pk) === resolvedPk) return true
    if (resolvedCode && str(row.customer_id) === resolvedCode) return true
    return resolvedName !== null && str(row.customer_name) === resolvedName
  })
  const selfTop = selfIndex >= 0 ? topCustomers[selfIndex] : null
  const benchmark = {
    totalSigningAmount,
    totalOrderCount,
    totalCustomerCount,
    rank: selfIndex >= 0 ? selfIndex + 1 : null,
    rankTotal: topCustomers.length,
    topList: topCustomers.slice(0, 10).map((row, index) => ({
      rank: index + 1,
      customerName: str(row.customer_name) ?? null,
      signingAmount: numOrNull(row.order_total_amount),
    })),
    shareOfTotal: ratio(
      selfTop ? num(selfTop.order_total_amount) : periodSigning,
      totalSigningAmount,
    ),
    isInTopList: selfIndex >= 0,
    avgPerCustomer: ratio(totalSigningAmount, totalCustomerCount),
  }
  if (!benchRes.ok) {
    warnings.push('区间总盘取数失败，benchmark 里的总盘金额/订单数/客户数与名次均为 null。')
  }
  notes.push(
    'benchmark 是**总盘口径**：分母取 total_performance_analysis.overview（order_total_amount 接单额、order_count、customer_count），'
    + 'topList / rank 取该接口的 top_customers（区间成交额前 100 名）。'
    + '客户不在 Top 榜里时 rank 为 null、isInTopList 为 false，shareOfTotal 仍按该客户区间签单额 ÷ 总盘接单额自算 —— '
    + '**分子是签约额、分母是接单额，两个口径不同，只作量级参考**，别当市场份额精确值用。',
  )

  notes.push(
    'orders[].overdueDays 取上游 overdue_days，**负值（未到期）归一为 null**，另给布尔 overdue（仅 overdueDays > 0 为 true）；'
    + 'null 表示「未逾期 / 尚未到期」，不是取数失败。',
  )

  notes.push(
    'orders[].saleState 是 ERP 的订单状态码（原始值），orders[].saleStateLabel 是**经验推断**的文字：'
    + '实测 2026-01/04/08 三个月，sale_state=1 的 45 单回款率仅 17.8%（在途未完成），'
    + 'sale_state=2 的 260 单回款率 92.3%（已完成）。ERP 本身没有官方码表，'
    + '原始码同时下发，取到官方字典后以官方为准。',
  )

  // ── 9. 订单明细 ───────────────────────────────────────────────────────
  const orders = orderRows
    .map((row) => {
      const signing = numOrNull(row.signing_amount)
      const collected = numOrNull(row.collection_amount)
      const overdue = normalizeOverdueDays(row.overdue_days)
      // 未回款：与主看板、periodMetrics、collection.overview 用**同一个**归一函数，
      // 免得同一笔订单在四个地方给出四个数。
      const uncollected = normalizeUncollectedAmount(
        row.signing_amount,
        row.collection_amount,
        row.uncollected_amount,
      )
      return {
        saleCode: str(row.sale_code) ?? null,
        saleState: numOrNull(row.sale_state),
        saleStateLabel: saleStateLabel(row.sale_state),
        saleMoneyBack: numOrNull(row.sale_money_back),
        saleDate: dateOnly(row.sale_ht_date) ?? null,
        overdueDays: overdue.overdueDays,
        overdue: overdue.overdue,
        accountPeriod: numOrNull(row.account_period),
        memberName: str(row.member_name) ?? null,
        departmentName: str(row.department_name) ?? null,
        signingAmount: signing,
        collectionAmount: collected,
        uncollectedAmount: uncollected.value,
        uncollectedAmountUpstream: uncollected.upstream,
      }
    })
    .sort((a, b) => num(b.uncollectedAmount) - num(a.uncollectedAmount))
    .slice(0, 200)

  // ── 10. 客户档案（白名单 + 风险标签）─────────────────────────────────
  const kindFallback = analysisCustomers
    .filter((row) => (resolvedPk !== null && numOrNull(row.id) === resolvedPk)
      || (resolvedCode && str(row.customer_id) === resolvedCode))
    .map((row) => str(row.customer_kind))
    .find((value) => value !== null && value !== undefined)
  const creditLimit = numOrNull(c360Profile.credit_limit)
  const usedAmount = numOrNull(c360Profile.used_amount)
  const creditUsageRate = ratio(usedAmount, creditLimit)

  /**
   * 风险提示（B5）：前端按**字符串数组**渲染（String(t)），所以这里必须给可读句子。
   *
   * 分档风控告警（rating.riskAlerts）与风险标签（profile.riskTags）前端各自成块渲染，
   * 这里**不重复**它们，只补「档案维度」的风险：逾期、问题单、额度水位、生命周期阶段。
   * 没有依据的项不写 —— 宁可少一条，也不要编一条风险出来吓人。
   */
  const customerRisks = []
  const customerOverdueCount = numOrNull(collectionOverview.overdue_order_count)
  if (customerOverdueCount !== null && customerOverdueCount > 0) {
    customerRisks.push(`区间逾期订单 ${customerOverdueCount} 单（sales_order_collection_analysis.overview，全量计数）`)
  }
  const customerProblemCount = numOrNull(collectionOverview.problem_order_count)
  if (customerProblemCount !== null && customerProblemCount > 0) {
    customerRisks.push(`区间问题订单 ${customerProblemCount} 单（ERP 标记为问题单）`)
  }
  if (creditUsageRate !== null && creditUsageRate >= 0.9) {
    customerRisks.push(`信用额度使用率 ${(creditUsageRate * 100).toFixed(1)}%（usedAmount ÷ creditLimit）`)
  }
  if (stageInfo.stage === '沉睡期') {
    customerRisks.push(`客户处于沉睡期：${stageInfo.basis}`)
  }
  const profileBlock = {
    customerPk: resolvedPk,
    customerCode: resolvedCode,
    customerName: resolvedName,
    customerKind: str(c360Profile.customer_kind) ?? resolvedKind ?? kindFallback ?? null,
    areaName: str(c360Profile.area_name) ?? null,
    firstDealTime: dateOnly(c360Profile.first_deal_time) ?? null,
    principalName: str(c360Profile.principal_name) ?? resolvedPrincipal ?? null,
    creditLimit,
    usedAmount,
    remainAmount: numOrNull(c360Profile.remain_amount),
    creditUsageRate: ratio(usedAmount, creditLimit),
    riskCoefficient: numOrNull(c360Profile.risk_coefficient),
    recommendedLimit: numOrNull(c360Profile.recommended_limit),
    creditCalcTime: str(c360Profile.credit_calc_time) ?? null,
    avgPaymentDays: numOrNull(c360Profile.avg_payment_days),
    riskTags: c360RiskTags,
    risks: customerRisks,
  }
  notes.push(
    '客户基础档案只保留业务字段；手机号、地址、网址、法定代表人、备注等一律不下发（PII 红线）。'
    + 'creditUsageRate = usedAmount ÷ creditLimit，额度 ≤ 0 时为 null。',
  )
  notes.push(
    'profile.risks 是**字符串数组**（前端逐条渲染），只包含有依据的风险（逾期 / 问题单 / 额度水位 / 沉睡期），'
    + '每条注明数据来源；分档风控告警在 rating.riskAlerts、风险标签在 profile.riskTags，三者不重复。',
  )
  notes.push(
    `订单明细受上游 limit=${num(settings.rowLimit) || DEFAULTS.rowLimit} 截断，orders 为区间内前 N 条（未回款额倒序，最多 200 条）；区间订单总数 ${collectionOverview.order_count ?? '未知'} 单。`,
  )

  return {
    ok: true,
    period: { startDate, endDate },
    generatedAt: isoLocal(),
    resolved: {
      customerPk: resolvedPk,
      customerCode: resolvedCode,
      customerName: resolvedName,
      principalName: profileBlock.principalName,
      candidates,
      ambiguous: candidates.length > 1,
    },
    profile: profileBlock,
    periodMetrics,
    lifetime,
    rating: ratingBlock,
    lifecycle,
    benchmark,
    orders,
    notes,
    warnings,
    calls: runner.calls,
  }
}

/**
 * 业务员详情路由（member.dashboard）。
 *
 * 口径分工：
 *   · periodMetrics ← member_performance_analysis + sales_order_collection_analysis（**区间口径**）
 *   · target        ← 年度至今业绩 ÷ 年度军令状目标（**年度口径**，自算，允许 > 100%）
 *   · benchmark     ← 年度排行榜算出的名次（**年度口径**）
 *   · recentOrders  ← sales_person_360.recent_orders（**不限区间**，需注意）
 */
async function collectMemberDashboard(ctx, settings, req, toolPlan) {
  const tools = (toolPlan && toolPlan.names) || TOOL
  const startDate = assertDate(req?.startDate, 'startDate')
  const endDate = assertDate(req?.endDate, 'endDate')
  if (startDate > endDate) {
    throw new RangeError(
      `erp-sales-dashboard: startDate (${startDate}) must not be after endDate (${endDate})`,
    )
  }
  const memberId = numOrNull(req?.memberId)
  const memberName = typeof req?.memberName === 'string' && req.memberName.trim() ? req.memberName.trim() : null
  if (memberId === null && !memberName) {
    throw new TypeError('erp-sales-dashboard: member.dashboard 需要 memberId 或 memberName 之一')
  }
  const rowLimit = Math.max(50, num(settings.rowLimit) || DEFAULTS.rowLimit)
  const runner = createDetailRunner(
    ctx,
    toolPlan,
    settings,
    Math.max(4, num(settings.detailBudget) || DEFAULTS.detailBudget),
  )
  const notes = []
  const warnings = runner.warnings
  const yearWindow = pickYearWindow(endDate)

  // ── 1. 业务员定位 ─────────────────────────────────────────────────────
  const memberRes = await runner.run(tools.member, '销售成员业绩明细（区间）', {
    start_date: startDate,
    end_date: endDate,
    limit: 500,
  })
  const memberRows = rowsOf(memberRes.value)
    .filter((row) => row && typeof row === 'object')
    .map((row) => {
      /**
       * 未回款（A1，P0）。
       *
       * member_performance_analysis **没有** uncollected_amount 字段，
       * 它给的是 back_money —— 那是**回款额**（实测：业务员01 order_total_amount 5700000.00、
       * back_money 4000000.00，是收回的钱）。
       * 原来直接 `uncollectedAmount: numOrNull(row.back_money)`，
       * 等于把「已收回的钱」显示成「还欠的钱」—— 业务员路由的未回款额比客户档案页大一截，
       * 数字大得离谱却完全看不出来（因为它长得像一个正常的未回款额）。
       *
       * 现在按统一口径自算：**签约额 − 回款额**；
       * 上游原值（本工具没有 → null）另存 uncollectedAmountUpstream，取数失败时不假装有数。
       */
      const memberUncollected = normalizeUncollectedAmount(
        row.order_total_amount,
        row.back_money,
        row.uncollected_amount,
      )
      return {
        memberId: numOrNull(row.member_id),
        memberName: str(row.member_name) ?? null,
        username: str(row.username) ?? null,
        departmentName: str(row.dep_name) ?? str(row.department_name) ?? null,
        roleName: str(row.role_name) ?? null,
        orderCount: numOrNull(row.order_count),
        customerCount: numOrNull(row.customer_count),
        signingAmount: numOrNull(row.order_total_amount),
        acceptanceAmount: numOrNull(row.acceptance_amount),
        finishedOrderCount: numOrNull(row.finished_order_count),
        unpaidOrderCount: numOrNull(row.unpaid_order_count),
        finishAmount: numOrNull(row.finish_amount),
        collectionAmount: numOrNull(row.back_money),
        uncollectedAmount: memberUncollected.value,
        uncollectedAmountUpstream: memberUncollected.upstream,
        uncollectedBasis: memberUncollected.basis,
        firstOrderTime: dateOnly(row.first_order_time) ?? null,
        lastOrderTime: dateOnly(row.last_order_time) ?? null,
      }
    })
  let targetId = memberId
  let targetName = memberName
  let candidates = []
  if (targetId === null) {
    const matched = memberRows.filter((row) => row.memberName === memberName)
    if (matched.length === 0) {
      throw new TypeError(`erp-sales-dashboard: 未找到业务员「${memberName}」`)
    }
    candidates = matched.map((row) => ({
      memberId: row.memberId,
      memberName: row.memberName,
      departmentName: row.departmentName,
      signingAmount: row.signingAmount,
    }))
    targetId = candidates[0].memberId
    targetName = candidates[0].memberName
    if (candidates.length > 1) {
      notes.push(`ERP 里有 ${candidates.length} 名同名业务员，已默认取第一个（${targetName}），其余候选见 resolved.candidates。`)
    }
  }

  // ── 2. 年度榜 + 360 + 订单（并行）────────────────────────────────────
  const personArgs = { limit: 20 }
  if (targetId !== null) personArgs.member_id = targetId
  else personArgs.member_id = targetId
  personArgs.start_date = startDate
  personArgs.end_date = endDate

  const collectionArgs = {
    start_date: startDate,
    end_date: endDate,
    order_status: 'all',
    limit: rowLimit,
  }
  if (targetId !== null) collectionArgs.member_id = targetId

  const [rankingRes, personRes, collectionRes] = await Promise.all([
    runner.run(tools.ranking, '年度军令状排行（年度口径）', {
      start_date: yearWindow.startDate,
      end_date: yearWindow.endDate,
      sort_by: 'signing_amount',
      limit: 500,
    }),
    runner.run(tools.person360, '业务员 360（业绩 / 军令状 / 最近订单）', personArgs),
    runner.run(tools.collection, '区间订单与回款', collectionArgs),
  ])

  const personPayload = personRes.value || {}
  const personProfile = sectionOf(personPayload, 'profile') || {}
  const personTarget = sectionOf(personPayload, 'target') || {}
  const personRecentOrders = rowsOf(personPayload, ['recent_orders'])

  const collectionPayload = collectionRes.value || {}
  const collectionOverview = sectionOf(collectionPayload, 'overview') || {}
  const orderRows = rowsOf(collectionPayload, ['orders'])

  /**
   * 区间未回款（A1 / A5）：全页统一「签约额 − 已回款额」。
   *
   * 优先用订单回款工具自己的 overview —— 它的 signing_amount（签约额）与
   * collection_amount（回款额）同源，算出来的差额才是真的「还欠多少」；
   * 成员业绩工具没有签约额字段（只有接单额与回款额），只能作次选，
   * 否则会出现「客户档案页一套数、业务员页另一套数」的比对灾难。
   */
  const overviewUncollected = normalizeUncollectedAmount(
    collectionOverview.signing_amount,
    collectionOverview.collection_amount,
    collectionOverview.uncollected_amount,
  )

  const rankingRows = rowsOf(rankingRes.value, ['ranking'])
    .filter((row) => row && typeof row === 'object')
    .map((row) => ({
      memberId: numOrNull(row.member_id),
      memberName: str(row.member_name) ?? null,
      departmentName: str(row.department_name) ?? null,
      signingAmount: numOrNull(row.signing_amount),
      collectionAmount: numOrNull(row.collection_amount),
      collectionRate: ratio(row.collection_amount, row.signing_amount),
      targetAmount: numOrNull(row.target_amount),
    }))
    .sort((a, b) => num(b.signingAmount) - num(a.signingAmount))

  const selfMember = memberRows.find((row) => row.memberId !== null && row.memberId === targetId) || null
  const selfRanking = rankingRows.find((row) => row.memberId !== null && row.memberId === targetId) || null
  const departmentName = str(personProfile.department_name) ?? selfMember?.departmentName ?? null
  const displayName = str(personProfile.member_name) ?? selfMember?.memberName ?? targetName

  // ── 3. 区间口径（periodMetrics）───────────────────────────────────────
  const periodSigning = numOrNull(selfMember?.signingAmount) ?? numOrNull(collectionOverview.signing_amount)
  const periodOrderCount = numOrNull(selfMember?.orderCount) ?? numOrNull(collectionOverview.order_count)
  const periodCustomerCount = numOrNull(selfMember?.customerCount)
  // 未回款（A1）：优先用订单回款工具的同源口径；取不到才回落成员业绩工具的自算值。
  const periodUncollected = overviewUncollected.value !== null
    ? overviewUncollected.value
    : (numOrNull(selfMember?.uncollectedAmount) ?? null)
  const periodUncollectedUpstream = overviewUncollected.upstream ?? numOrNull(selfMember?.uncollectedAmountUpstream)
  const periodAcceptance = numOrNull(selfMember?.acceptanceAmount)
  const periodFinishAmount = numOrNull(selfMember?.finishAmount)
  const periodFinishedOrders = numOrNull(selfMember?.finishedOrderCount)
  const periodUnpaidOrders = numOrNull(selfMember?.unpaidOrderCount) ?? numOrNull(collectionOverview.unpaid_order_count)
  const periodCollection = numOrNull(collectionOverview.collection_amount)
  const periodMetrics = {
    customerCount: periodCustomerCount,
    orderCount: periodOrderCount,
    signingAmount: periodSigning,
    acceptanceAmount: periodAcceptance,
    finishedOrderCount: periodFinishedOrders,
    unpaidOrderCount: periodUnpaidOrders,
    finishAmount: periodFinishAmount,
    finishAmountRate: ratio(periodFinishAmount, periodSigning),
    uncollectedAmount: periodUncollected,
    uncollectedAmountUpstream: periodUncollectedUpstream,
    finishRate: ratio(periodFinishedOrders, periodOrderCount),
    unpaidRate: ratio(periodUnpaidOrders, periodOrderCount),
    collectionAmount: periodCollection,
    collectionRate: ratio(periodCollection, periodSigning),
    overdueOrderCount: numOrNull(collectionOverview.overdue_order_count),
    problemOrderCount: numOrNull(collectionOverview.problem_order_count),
    avgOrderAmount: ratio(periodSigning, periodOrderCount),
    avgCustomerAmount: ratio(periodSigning, periodCustomerCount),
    firstOrderTime: selfMember?.firstOrderTime ?? null,
    lastOrderTime: selfMember?.lastOrderTime ?? null,
    note: `区间口径：仅统计 ${startDate} ~ ${endDate}（member_performance_analysis 区间业绩 + sales_order_collection_analysis 区间订单回款）；与下方 target 的年度口径不是同一口径。`,
  }

  // ── 4. 年度口径（target）──────────────────────────────────────────────
  const targetAmount = numOrNull(personTarget.target_amount)
  const ytdSigning = numOrNull(selfRanking?.signingAmount)
  const ytdCollection = numOrNull(selfRanking?.collectionAmount)
  const targetWarnings = Array.isArray(personTarget.warnings)
    ? personTarget.warnings.map((item) => (typeof item === 'string' ? item : str(item?.message) ?? null)).filter((item) => item !== null)
    : []
  if (targetAmount === null) {
    targetWarnings.push('ERP 未返回该业务员的年度军令状目标（sales_person_360.target.target_amount 为空），完成率不可得。')
  }
  if (ytdSigning === null && targetAmount !== null) {
    targetWarnings.push('年度排行榜里没有该业务员，年度至今签约额不可得，完成率不可得。')
  }
  if (!yearWindow.isCurrentYear) {
    targetWarnings.push(`所选区间年份为 ${yearWindow.year}，非当前年度；军令状目标取自 ERP 当前生效的目标，年度口径按 ${yearWindow.startDate} ~ ${yearWindow.endDate} 计算。`)
  }
  const target = {
    available: targetAmount !== null && ytdSigning !== null,
    targetAmount,
    ytdSigningAmount: ytdSigning,
    ytdCollectionAmount: ytdCollection,
    // 完成率允许 > 1（超年度目标就是超），不夹到 100%。
    //
    // A6：年度至今签约额**取不到**时，不能把它当成 0。
    // 原来 ratio() 内部把 null 记成 0，于是「年度排行榜里没有这个人」
    // 会显示成「完成率 0%、缺口 = 整个目标」—— 那是凭空造出来的结论。
    // 现在分子取不到一律返回 null（前端显示「—」），并由 warnings 说明原因。
    signingCompletionRate: targetAmount !== null && targetAmount > 0 && ytdSigning !== null
      ? ratio(ytdSigning, targetAmount)
      : null,
    collectionCompletionRate: targetAmount !== null && targetAmount > 0 && ytdCollection !== null
      ? ratio(ytdCollection, targetAmount)
      : null,
    signingGap: targetAmount !== null && ytdSigning !== null
      ? Number((targetAmount - num(ytdSigning)).toFixed(2))
      : null,
    completionBasisLabel: '年度至今业绩 ÷ 年度军令状目标（军令状为年度目标）',
    periodBasisLabel: '按所选区间的区间业绩，与上面的年度军令状不是同一口径',
    warnings: targetWarnings,
  }

  // ── 5. 对标（benchmark，年度口径）────────────────────────────────────
  const selfIndex = rankingRows.findIndex((row) => row.memberId !== null && row.memberId === targetId)
  const departmentRows = rankingRows.filter((row) => departmentName !== null && row.departmentName === departmentName)
  const departmentIndex = departmentRows.findIndex((row) => row.memberId !== null && row.memberId === targetId)
  const departmentAvg = departmentRows.length > 0
    ? Number((sumBy(departmentRows, (row) => row.signingAmount) / departmentRows.length).toFixed(2))
    : null
  const companyAvg = rankingRows.length > 0
    ? Number((sumBy(rankingRows, (row) => row.signingAmount) / rankingRows.length).toFixed(2))
    : null
  const benchmark = {
    rank: selfIndex >= 0 ? selfIndex + 1 : null,
    rankTotal: rankingRows.length,
    departmentRank: departmentIndex >= 0 ? departmentIndex + 1 : null,
    departmentSize: departmentRows.length,
    departmentAvgSigning: departmentAvg,
    companyAvgSigning: companyAvg,
    vsDepartmentAvg: departmentAvg !== null && selfRanking
      ? Number((num(selfRanking.signingAmount) - departmentAvg).toFixed(2))
      : null,
    vsCompanyAvg: companyAvg !== null && selfRanking
      ? Number((num(selfRanking.signingAmount) - companyAvg).toFixed(2))
      : null,
    peers: departmentRows.map((row) => ({
      memberId: row.memberId,
      memberName: row.memberName,
      signingAmount: row.signingAmount,
      collectionRate: row.collectionRate,
      isSelf: row.memberId !== null && row.memberId === targetId,
    })),
    topMembers: rankingRows.slice(0, 10).map((row, index) => ({
      rank: index + 1,
      memberName: row.memberName,
      departmentName: row.departmentName,
      signingAmount: row.signingAmount,
    })),
    note: `对标为**年度口径**（${yearWindow.startDate} ~ ${yearWindow.endDate} 的排行榜），与 periodMetrics 的区间口径不是同一口径。`,
  }

  // ── 6. 订单与最近订单 ────────────────────────────────────────────────
  const collectionOrders = orderRows
    .map((row) => {
      const overdue = normalizeOverdueDays(row.overdue_days)
      // 未回款（A5）：上游 uncollected_amount 把「已部分回款的订单」按全额计入，
      // 数值偏高；统一按「签约额 − 已回款额」自算，取不到才回落上游原值。
      const uncollected = normalizeUncollectedAmount(
        row.signing_amount,
        row.collection_amount,
        row.uncollected_amount,
      )
      return {
        saleCode: str(row.sale_code) ?? null,
        customerName: str(row.customer_name) ?? null,
        saleDate: dateOnly(row.sale_ht_date) ?? null,
        overdueDays: overdue.overdueDays,
        overdue: overdue.overdue,
        signingAmount: numOrNull(row.signing_amount),
        collectionAmount: numOrNull(row.collection_amount),
        uncollectedAmount: uncollected.value,
        uncollectedAmountUpstream: uncollected.upstream,
      }
    })
    .sort((a, b) => num(b.uncollectedAmount) - num(a.uncollectedAmount))
  const recentOrders = personRecentOrders.map((row) => {
    const overdue = normalizeOverdueDays(row.overdue_days)
    const uncollected = normalizeUncollectedAmount(
      row.signing_amount,
      row.collection_amount,
      row.uncollected_amount,
    )
    return {
      saleCode: str(row.sale_code) ?? null,
      saleState: numOrNull(row.sale_state),
      saleStateLabel: saleStateLabel(row.sale_state),
      customerName: str(row.customer_name) ?? null,
      saleDate: dateOnly(row.sale_ht_date) ?? null,
      overdueDays: overdue.overdueDays,
      overdue: overdue.overdue,
      signingAmount: numOrNull(row.signing_amount),
      collectionAmount: numOrNull(row.collection_amount),
      uncollectedAmount: uncollected.value,
      uncollectedAmountUpstream: uncollected.upstream,
    }
  })

  // ── 7. 风险提示（B5）──────────────────────────────────────────────────
  //
  // 前端把 profile.risks 当**字符串数组**渲染（String(t)），
  // 所以这里必须给可读句子；没有依据的项**不写**，宁可少一条也不编一条。
  // 每条都带口径（哪个工具的哪个字段），让人能自己复核。
  const memberRisks = []
  const memberThresholds = resolveThresholds(settings.thresholds)
  const overdueOrderCount = numOrNull(collectionOverview.overdue_order_count)
  if (overdueOrderCount !== null && overdueOrderCount > 0) {
    memberRisks.push(`区间逾期订单 ${overdueOrderCount} 单（sales_order_collection_analysis.overview，全量计数）`)
  }
  const problemOrderCount = numOrNull(collectionOverview.problem_order_count)
  if (problemOrderCount !== null && problemOrderCount > 0) {
    memberRisks.push(`区间问题订单 ${problemOrderCount} 单（ERP 标记为问题单）`)
  }
  const memberPeriodCollectionRate = ratio(periodCollection, periodSigning)
  if (memberPeriodCollectionRate !== null && memberPeriodCollectionRate < memberThresholds.collectionRateYellow) {
    memberRisks.push(
      `区间回款率 ${(memberPeriodCollectionRate * 100).toFixed(1)}%，低于黄色线 ${(memberThresholds.collectionRateYellow * 100).toFixed(0)}%（已回款 ÷ 签约额，自算）`,
    )
  }
  if (targetAmount !== null && targetAmount > 0 && ytdSigning !== null) {
    const targetRate = ratio(ytdSigning, targetAmount)
    if (targetRate !== null && targetRate < 1) {
      memberRisks.push(
        `年度军令状完成率 ${(targetRate * 100).toFixed(1)}%，缺口 ${Number((targetAmount - num(ytdSigning)).toFixed(2))} 元（年度至今签约额 ÷ 年度目标，自算）`,
      )
    }
  }

  // ── 8. 员工档案（岗位 / 在职状态）─────────────────────────────────────
  //
  // B4：业务员路由的档案里原来只有「状态码」，没有岗位、没有中文在职状态。
  // sales_person_360 的 status 是它自己的一套编码（实测两名在役业务员都返回 2），
  // **不能**当成 staff_info 的 0=离职/非0=在职 来解释 —— 所以中文标签只能来自员工档案。
  // 这里按姓名精确匹配一次员工档案（上游按姓名 LIKE 过滤，返回后仍要精确比对，
  // 否则会把同名同事的岗位挂到别人头上）。
  // 员工档案里含手机号 / 身份证 / 银行账号，**只取白名单字段**，其余整条丢弃（PII 红线）。
  const staffRes = await runner.run(tools.staff, `员工档案（岗位 / 在职状态：${displayName}）`, {
    name: displayName,
    limit: 10,
  })
  const staffRows = rowsOf(staffRes.value, ['data', 'records'])
  const staffMatch = staffRows.find((row) => str(row.staff_name) === displayName)
    || staffRows.find((row) => str(row.staff_name) === str(personProfile.staff_name))
    || (staffRows.length === 1 ? staffRows[0] : null)
  const staffStatus = numOrNull(staffMatch?.status)
  const staffPost = str(staffMatch?.post_name) ?? null
  const staffStatusText = staffStatusLabel(staffStatus)
  if (staffStatus === 0) {
    memberRisks.push('员工档案显示该业务员已离职（staff_info.status=0），请核对业绩归属期间')
  }
  if (!staffMatch) {
    // 两种取不到要分开说：工具整个失败（std 服务宕机）vs 接口通了但没匹配到人。
    // 前者是系统故障，后者是数据问题 —— 排查的人不一样。
    notes.push(
      staffRes.ok
        ? '员工档案（staff_info）未匹配到该业务员，岗位 post 与中文在职状态 statusLabel 置空；前端会显示「—」而不是猜一个状态。'
        : '员工档案（staff_info）取数失败（std 服务可能不可用），岗位 post 与中文在职状态 statusLabel 置空；前端会显示「—」，不猜。',
    )
  }

  const profileBlock = {
    memberId: numOrNull(personProfile.member_id) ?? targetId,
    memberName: displayName,
    username: str(personProfile.username) ?? selfMember?.username ?? null,
    departmentName,
    staffName: str(personProfile.staff_name) ?? null,
    joinTime: dateOnly(personProfile.join_time) ?? null,
    education: str(personProfile.education) ?? null,
    // 岗位（B4）：只有员工档案（staff_info.post_name）有岗位；
    // sales_person_360 的 job 是工号/登录名，不是岗位，绝不拿来顶。
    post: staffPost,
    // 在职状态：优先员工档案的（0=离职 / 非0=在职，可翻译成中文）；
    // 取不到就保留 sales_person_360 的原始码，并给 statusLabel=null（前端显示「状态码 N」）。
    status: staffStatus !== null ? staffStatus : numOrNull(personProfile.status),
    statusLabel: staffStatusText,
    statusSource: staffMatch ? 'staff_info' : 'sales_person_360',
    // 风险提示（B5）：前端按字符串数组渲染，所以这里必须给**可读句子**，不是对象。
    risks: memberRisks,
    note: '人员档案只保留业务字段；手机号、座机、邮箱、性别、身份证、银行账号等一律不下发（PII 红线）。',
  }

  notes.push(`periodMetrics 是**区间口径**（${startDate} ~ ${endDate}），target 与 benchmark 是**年度口径**（${yearWindow.startDate} ~ ${yearWindow.endDate}），两者不是同一口径。`)
  notes.push('recentOrders 来自 sales_person_360.recent_orders，**不受所选区间限制**，是最近若干单。')
  notes.push(`区间订单明细受上游 limit=${rowLimit} 截断；区间订单总数 ${collectionOverview.order_count ?? '未知'} 单。`)
  notes.push('上游 sales_person_360 返回的 signing_completion_rate 是百分数（114.02 表示 114.02%），已弃用；本页完成率为自算。')
  notes.push('collection.orders[] / recentOrders[] 的 overdueDays 取上游 overdue_days，**负值（未到期）归一为 null**，另给布尔 overdue（仅 overdueDays > 0 为 true）；null 表示「未逾期 / 尚未到期」，不是取数失败。')
  notes.push('recentOrders[].saleState 是 ERP 的订单状态码（原始值），recentOrders[].saleStateLabel 是**经验推断**的文字：实测 2026-01/04/08 三个月，sale_state=1 的 45 单回款率仅 17.8%（在途未完成），sale_state=2 的 260 单回款率 92.3%（已完成）。ERP 本身没有官方码表，原始码同时下发，取到官方字典后以官方为准。')
  notes.push('collection.overview.collectionRate 是本页自算的区间回款率（已回款 ÷ 签约额），与 periodMetrics.collectionRate 同源同口径；上游 overview 未直接给该字段。')
  notes.push('未回款口径（A1/A5）：本页所有未回款额（periodMetrics / collection.overview / collection.orders[] / recentOrders[]）统一为「签约额 − 已回款额」；上游 uncollected_amount 把部分回款的订单按全额计入，数值偏高，原值另存 *Upstream 字段。')
  notes.push('年度军令状（A6）：年度至今签约额取不到时，完成率与缺口 signingGap 一律为 null（不按 0 算），原因见 target.warnings。')
  notes.push('profile.post（岗位）与 profile.statusLabel（中文在职状态）来自员工档案 staff_info（按姓名精确匹配）；取不到时为空，前端显示「—」，不猜。岗位只取 staff_info.post_name 这一个字段，**未与其它数据源交叉校验**（ERP 没有第二个岗位字段可比，sales_person_360.job 是工号不是岗位）。profile.risks 是**字符串数组**（前端逐条渲染），只包含有依据的风险，每条注明数据来源。')

  return {
    ok: true,
    generatedAt: isoLocal(),
    period: { startDate, endDate },
    resolved: {
      memberId: targetId,
      memberName: displayName,
      username: profileBlock.username,
      departmentName,
      candidates,
      ambiguous: candidates.length > 1,
    },
    profile: profileBlock,
    periodMetrics,
    target,
    benchmark,
    collection: {
      overview: {
        orderCount: numOrNull(collectionOverview.order_count),
        signingAmount: numOrNull(collectionOverview.signing_amount),
        collectionAmount: numOrNull(collectionOverview.collection_amount),
        // 未回款（A5）：与客户档案页、periodMetrics 用同一套归一口径（签约 − 回款）。
        uncollectedAmount: overviewUncollected.value,
        uncollectedAmountUpstream: overviewUncollected.upstream,
        collectionRate: (() => {
          const sign = numOrNull(collectionOverview.signing_amount)
          const coll = numOrNull(collectionOverview.collection_amount)
          if (sign === null || coll === null || sign === 0) return null
          return Number((coll / sign).toFixed(6))
        })(),
        unpaidOrderCount: numOrNull(collectionOverview.unpaid_order_count),
        overdueOrderCount: numOrNull(collectionOverview.overdue_order_count),
        problemOrderCount: numOrNull(collectionOverview.problem_order_count),
      },
      orders: collectionOrders,
    },
    recentOrders,
    notes,
    warnings,
    calls: runner.calls,
  }
}

// ---------------------------------------------------------------------------
// 客户地理分布（customer.geo）
//
// 三条铁律：
//   ① 省份只能从「统一社会信用代码 / 地址 / 地级市 / 区域名」四条路径里来，
//      **绝不许从公司名猜** —— 公司名里带地名的极多，猜错就是错数据。
//   ② 响应里只放白名单字段，**不把 customer_info 的原始行透传**
//      （里面有手机号、座机、银行账号、统一社会信用代码）。
//   ③ 覆盖率必须如实报出来：客户档案里只有一部分带中文地址，其余是新建空档案。
//
// 静态表与判定逻辑从 @local/erp-dashboard 机械移植（只改了名字），不重写。
// ---------------------------------------------------------------------------

/**
 * provinces[].customerNames 里每个省最多下发的客户名个数。
 * 实机 payload 212KB，主要就是被「江苏 173 个客户名」撑起来的；
 * 完整明细统一走 customers[]，前端点省时按 province 过滤即可。
 */
const PROVINCE_CUSTOMER_NAMES_LIMIT = 20

/** 省级行政区划码 → 省名（统一社会信用代码第 3-4 位）。一个字都不许改。 */
const GEO_PROVINCE_BY_CODE = {
  '11': '北京', '12': '天津', '13': '河北', '14': '山西', '15': '内蒙古',
  '21': '辽宁', '22': '吉林', '23': '黑龙江',
  '31': '上海', '32': '江苏', '33': '浙江', '34': '安徽', '35': '福建', '36': '江西', '37': '山东',
  '41': '河南', '42': '湖北', '43': '湖南', '44': '广东', '45': '广西', '46': '海南',
  '50': '重庆', '51': '四川', '52': '贵州', '53': '云南', '54': '西藏',
  '61': '陕西', '62': '甘肃', '63': '青海', '64': '宁夏', '65': '新疆',
  '71': '台湾', '81': '香港', '82': '澳门', '91': '境外',
}

/** 地址前缀 → 省名（要求地址以它**开头**才算命中）。 */
const GEO_PROVINCE_ADDRESS_ALIASES = {
  '北京': '北京', '北京市': '北京',
  '天津': '天津', '天津市': '天津',
  '河北': '河北', '河北省': '河北',
  '山西': '山西', '山西省': '山西',
  '内蒙古': '内蒙古', '内蒙古自治区': '内蒙古', '内蒙': '内蒙古',
  '辽宁': '辽宁', '辽宁省': '辽宁',
  '吉林': '吉林', '吉林省': '吉林',
  '黑龙江': '黑龙江', '黑龙江省': '黑龙江',
  '上海': '上海', '上海市': '上海',
  '江苏': '江苏', '江苏省': '江苏',
  '浙江': '浙江', '浙江省': '浙江',
  '安徽': '安徽', '安徽省': '安徽',
  '福建': '福建', '福建省': '福建',
  '江西': '江西', '江西省': '江西',
  '山东': '山东', '山东省': '山东',
  '河南': '河南', '河南省': '河南',
  '湖北': '湖北', '湖北省': '湖北',
  '湖南': '湖南', '湖南省': '湖南',
  '广东': '广东', '广东省': '广东',
  '广西': '广西', '广西壮族自治区': '广西',
  '海南': '海南', '海南省': '海南',
  '重庆': '重庆', '重庆市': '重庆',
  '四川': '四川', '四川省': '四川',
  '贵州': '贵州', '贵州省': '贵州',
  '云南': '云南', '云南省': '云南',
  '西藏': '西藏', '西藏自治区': '西藏',
  '陕西': '陕西', '陕西省': '陕西',
  '甘肃': '甘肃', '甘肃省': '甘肃',
  '青海': '青海', '青海省': '青海',
  '宁夏': '宁夏', '宁夏回族自治区': '宁夏',
  '新疆': '新疆', '新疆维吾尔自治区': '新疆',
  '台湾': '台湾', '台湾省': '台湾',
  '香港': '香港', '香港特别行政区': '香港',
  '澳门': '澳门', '澳门特别行政区': '澳门',
}

/** 地址前缀匹配用：按长度倒序，保证「黑龙江省」先于「黑」这类短前缀。 */
const GEO_PROVINCE_ADDRESS_KEYS = Object.keys(GEO_PROVINCE_ADDRESS_ALIASES).sort((a, b) => b.length - a.length)

/** area_name 精确等于这些名字时才认。 */
const GEO_PROVINCE_NAME_SET = new Set(Object.values(GEO_PROVINCE_BY_CODE).filter((name) => name !== '境外'))

/**
 * 地级市 → 省（兜底路径）。
 * 写成「省:市、市、…」的紧凑格式，加载时展开成对象。
 * 自治州同时给了简称（"德宏州" 这类简称在地址里更常见）。
 */
const GEO_CITY_TABLE_RAW = [
  '北京:北京',
  '天津:天津',
  '上海:上海',
  '重庆:重庆',
  '河北:石家庄,唐山,秦皇岛,邯郸,邢台,保定,张家口,承德,沧州,廊坊,衡水',
  '山西:太原,大同,阳泉,长治,晋城,朔州,晋中,运城,忻州,临汾,吕梁',
  '内蒙古:呼和浩特,包头,乌海,赤峰,通辽,鄂尔多斯,呼伦贝尔,巴彦淖尔,乌兰察布,兴安盟,锡林郭勒盟,阿拉善盟',
  '辽宁:沈阳,大连,鞍山,抚顺,本溪,丹东,锦州,营口,阜新,辽阳,盘锦,铁岭,朝阳,葫芦岛',
  '吉林:长春,吉林,四平,辽源,通化,白山,松原,白城,延边,延边朝鲜族自治州',
  '黑龙江:哈尔滨,齐齐哈尔,鸡西,鹤岗,双鸭山,大庆,伊春,佳木斯,七台河,牡丹江,黑河,绥化,大兴安岭,大兴安岭地区',
  '江苏:南京,无锡,徐州,常州,苏州,南通,连云港,淮安,盐城,扬州,镇江,泰州,宿迁',
  '浙江:杭州,宁波,温州,嘉兴,湖州,绍兴,金华,衢州,舟山,台州,丽水',
  '安徽:合肥,芜湖,蚌埠,淮南,马鞍山,淮北,铜陵,安庆,黄山,滁州,阜阳,宿州,六安,亳州,池州,宣城',
  '福建:福州,厦门,莆田,三明,泉州,漳州,南平,龙岩,宁德',
  '江西:南昌,景德镇,萍乡,九江,新余,鹰潭,赣州,吉安,宜春,抚州,上饶',
  '山东:济南,青岛,淄博,枣庄,东营,烟台,潍坊,济宁,泰安,威海,日照,临沂,德州,聊城,滨州,菏泽',
  '河南:郑州,开封,洛阳,平顶山,安阳,鹤壁,新乡,焦作,濮阳,许昌,漯河,三门峡,南阳,商丘,信阳,周口,驻马店,济源',
  '湖北:武汉,黄石,十堰,宜昌,襄阳,鄂州,荆门,孝感,荆州,黄冈,咸宁,随州,恩施,恩施土家族苗族自治州,神农架,神农架林区',
  '湖南:长沙,株洲,湘潭,衡阳,邵阳,岳阳,常德,张家界,益阳,郴州,永州,怀化,娄底,湘西,湘西土家族苗族自治州',
  '广东:广州,韶关,深圳,珠海,汕头,佛山,江门,湛江,茂名,肇庆,惠州,梅州,汕尾,河源,阳江,清远,东莞,中山,潮州,揭阳,云浮',
  '广西:南宁,柳州,桂林,梧州,北海,防城港,钦州,贵港,玉林,百色,贺州,河池,来宾,崇左',
  '海南:海口,三亚,三沙,儋州,五指山,琼海,文昌,万宁,东方,定安,屯昌,澄迈,临高,白沙,昌江,乐东,陵水,保亭,琼中',
  '四川:成都,自贡,攀枝花,泸州,德阳,绵阳,广元,遂宁,内江,乐山,南充,眉山,宜宾,广安,达州,雅安,巴中,资阳,阿坝,阿坝藏族羌族自治州,甘孜,甘孜藏族自治州,凉山,凉山彝族自治州',
  '贵州:贵阳,六盘水,遵义,安顺,毕节,铜仁,黔西南,黔西南布依族苗族自治州,黔东南,黔东南苗族侗族自治州,黔南,黔南布依族苗族自治州',
  '云南:昆明,曲靖,玉溪,保山,昭通,丽江,普洱,临沧,楚雄,楚雄彝族自治州,红河,红河哈尼族彝族自治州,文山,文山壮族苗族自治州,西双版纳,西双版纳傣族自治州,大理,大理白族自治州,德宏,德宏傣族景颇族自治州,怒江,怒江傈僳族自治州,迪庆,迪庆藏族自治州',
  '西藏:拉萨,日喀则,昌都,林芝,山南,那曲,阿里,阿里地区',
  '陕西:西安,铜川,宝鸡,咸阳,渭南,延安,汉中,榆林,安康,商洛',
  '甘肃:兰州,嘉峪关,金昌,白银,天水,武威,张掖,平凉,酒泉,庆阳,定西,陇南,临夏,临夏回族自治州,甘南,甘南藏族自治州',
  '青海:西宁,海东,海北,海南,黄南,果洛,玉树,海西',
  '宁夏:银川,石嘴山,吴忠,固原,中卫',
  '新疆:乌鲁木齐,克拉玛依,吐鲁番,哈密,昌吉,昌吉回族自治州,博尔塔拉,博尔塔拉蒙古自治州,巴音郭楞,巴音郭楞蒙古自治州,阿克苏,阿克苏地区,克孜勒苏,克孜勒苏柯尔克孜自治州,喀什,喀什地区,和田,和田地区,伊犁,伊犁哈萨克自治州,塔城,塔城地区,阿勒泰,阿勒泰地区',
  '台湾:台北,高雄,台中,台南,基隆,新竹,嘉义,桃园',
  '香港:香港',
  '澳门:澳门',
].join('\n')

/** 地级市 → 省，展开后的查找表（同名城市只保留第一次出现的归属）。 */
const GEO_CITY_TO_PROVINCE = (() => {
  const map = new Map()
  for (const line of GEO_CITY_TABLE_RAW.split('\n')) {
    const sep = line.indexOf(':')
    if (sep <= 0) continue
    const province = line.slice(0, sep).trim()
    for (const piece of line.slice(sep + 1).split(',')) {
      const city = piece.trim()
      if (city && !map.has(city)) map.set(city, province)
    }
  }
  return map
})()

/** 地级市名 → 是否自带行政后缀（自带的后缀要整体匹配，不能再拼「市」）。 */
const GEO_CITY_SUFFIXED = new Set(
  [...GEO_CITY_TO_PROVINCE.keys()].filter((city) => /[市州盟区县]$/.test(city)),
)

/**
 * 地址里找省级前缀（要求在地址**开头**命中）。
 * 「海南藏族自治州」不能算海南（那是青海的海南州）。
 */
function geoMatchProvinceInAddress(address) {
  for (const key of GEO_PROVINCE_ADDRESS_KEYS) {
    if (address.startsWith(key)) return GEO_PROVINCE_ADDRESS_ALIASES[key]
  }
  return null
}

/**
 * 地址里找地级市（尽力匹配，命中即返回省名）。
 * 城市名后面要跟行政后缀（市/州/地区/盟），避免「朝阳区」被误判成辽宁朝阳。
 */
function geoMatchCityInAddress(address) {
  for (const [city, province] of GEO_CITY_TO_PROVINCE) {
    if (GEO_CITY_SUFFIXED.has(city)) {
      if (address.includes(city)) return province
      continue
    }
    if (address.includes(city + '市')
      || address.includes(city + '州')
      || address.includes(city + '地区')
      || address.includes(city + '盟')) {
      return province
    }
  }
  return null
}

/**
 * 解析客户档案行的省份。
 * 返回 { province, source }；source ∈ credit_code / address / address_city / area / overseas / null。
 * country === 1（海外）最先判：海外客户不进中国地图，单独统计。
 */
function resolveGeoProvince(row) {
  const item = row && typeof row === 'object' ? row : {}
  if (num(item.country) === 1) return { province: '海外', source: 'overseas' }
  const duty = str(item.duty_paragraph)
  if (duty) {
    const code = duty.slice(2, 4)
    if (/^\d{2}$/.test(code) && GEO_PROVINCE_BY_CODE[code]) {
      return { province: GEO_PROVINCE_BY_CODE[code], source: 'credit_code' }
    }
  }
  const address = str(item.customer_address)
  if (address) {
    const byPrefix = geoMatchProvinceInAddress(address)
    if (byPrefix) return { province: byPrefix, source: 'address' }
    const byCity = geoMatchCityInAddress(address)
    if (byCity) return { province: byCity, source: 'address_city' }
  }
  const area = str(item.area_name)
  if (area) {
    const trimmed = area.trim()
    if (GEO_PROVINCE_NAME_SET.has(trimmed)) return { province: trimmed, source: 'area' }
  }
  return { province: null, source: null }
}

/** 客户档案行 + 省份解析结果整成白名单结构（绝不透传原始行）。 */
function geoCustomerRow(raw, resolved, ownerName, orderCount, signingAmount) {
  const row = raw && typeof raw === 'object' ? raw : {}
  const pk = row.id === undefined || row.id === null ? null : num(row.id)
  return {
    customerPk: pk,
    customerCode: str(row.customer_id) ?? str(row.customer_code) ?? null,
    customerName: str(row.customer_name) ?? null,
    province: resolved ? resolved.province : null,
    provinceSource: resolved ? resolved.source : null,
    ownerName: ownerName ?? null,
    customerKind: str(row.customer_kind) ?? null,
    orderCount: orderCount === undefined ? null : orderCount,
    signingAmount: signingAmount === undefined ? null : signingAmount,
  }
}

/**
 * 客户地理分布路由（customer.geo）。
 *
 * scope='all'    全部存量客户（客户档案主数据）
 * scope='period' 区间内有成交的客户（订单聚合 + join 客户档案）
 *
 * 取数代价与降级：
 *   · 客户档案主数据要**自举扫描**（上游 customer_info 的 limit 被硬钳到 500，
 *     没有翻页也没有 total 字段）：先不带 principal_id 扫一遍拿到 500 条 →
 *     从里面收集 principal_id → 每个业务员再扫一遍 → 最多 3 轮 → 按 pk 去重。
 *   · 区间订单同理没有 offset，只能**按自然月分片**重读再按 sale_id 去重。
 *   · 墙钟预算（geoBudgetMs）与调用数上限（geoMaxRequests）一到就停手，
 *     把已拿到的部分交出去并在 warnings 里写清扫了多少分区、覆盖多少家 ——
 *     宁可覆盖不全也要如实说，绝不假装是全量地图。
 */
async function collectCustomerGeo(ctx, settings, req, toolPlan, geoState) {
  const tools = (toolPlan && toolPlan.names) || TOOL
  const rawScope = req?.scope === undefined || req?.scope === null || req?.scope === '' ? 'period' : String(req.scope).trim()
  if (rawScope !== 'period' && rawScope !== 'all') {
    throw new TypeError(`erp-sales-dashboard: scope 只能是 period（区间成交客户）或 all（全部存量客户），收到 ${JSON.stringify(req.scope)}`)
  }
  const scope = rawScope === 'all' ? 'all' : 'period'
  const startDate = scope === 'period' ? assertDate(req?.startDate, 'startDate') : null
  const endDate = scope === 'period' ? assertDate(req?.endDate, 'endDate') : null
  if (startDate && endDate && startDate > endDate) {
    throw new RangeError(`erp-sales-dashboard: startDate (${startDate}) must not be after endDate (${endDate})`)
  }

  const budgetMs = Math.max(15000, num(settings.geoBudgetMs) || DEFAULTS.geoBudgetMs)
  const maxRequests = Math.max(4, num(settings.geoMaxRequests) || DEFAULTS.geoMaxRequests)
  const runner = createDetailRunner(ctx, toolPlan, settings, maxRequests)
  const warnings = runner.warnings
  const deadline = Date.now() + budgetMs
  let requests = 0

  // ── 业务员名单（principal_id → 姓名）─────────────────────────────────
  const memberRes = await runner.run(tools.member, '业务员名单（客户负责人映射）', { limit: 500 })
  requests += 1
  const memberNames = new Map()
  for (const row of rowsOf(memberRes.value)) {
    if (!row) continue
    const id = numOrNull(row.member_id)
    const name = str(row.member_name)
    if (id !== null && name) memberNames.set(String(id), name)
  }

  // ── 客户档案主数据（自举扫描，只留内存）────────────────────────────
  const masterRows = new Map()
  const discovered = new Set()
  const cappedPartitions = []
  let masterFailed = false
  let pending = [null]
  let round = 0
  while (pending.length > 0 && round < 3) {
    if (Date.now() > deadline) {
      warnings.push(`客户档案扫描超过墙钟预算（${budgetMs} ms），已停止扩展分区；已扫到 ${masterRows.size} 家。`)
      break
    }
    const ids = pending
    pending = []
    const results = await mapLimit(ids, 6, async (principalId) => {
      if (Date.now() > deadline) return { principalId, skipped: true }
      const args = { include_sensitive: true, limit: 500 }
      if (principalId !== null && principalId !== undefined) args.principal_id = principalId
      const res = await runner.run(
        tools.customerInfo,
        principalId === null ? '客户档案扫描（全部）' : `客户档案扫描（业务员 ${principalId}）`,
        args,
      )
      requests += 1
      return { principalId, res }
    })
    for (const item of results) {
      if (!item) continue
      if (item.skipped) continue
      if (!item.res || !item.res.ok) {
        masterFailed = true
        continue
      }
      const rows = rowsOf(item.res.value)
      if (rows.length >= 500) cappedPartitions.push(item.principalId)
      for (const row of rows) {
        if (!row) continue
        const pk = row.id
        if (pk === undefined || pk === null) continue
        if (!masterRows.has(String(pk))) masterRows.set(String(pk), row)
        const pid = row.principal_id
        if (pid !== undefined && pid !== null && !discovered.has(String(pid))) {
          discovered.add(String(pid))
          if (round < 2) pending.push(pid)
        }
      }
    }
    round += 1
  }
  const masterCustomers = masterRows.size
  if (cappedPartitions.length > 0) {
    warnings.push(
      `有 ${cappedPartitions.length} 个客户档案分区单次返回达到上游 500 条上限，其客户数可能超过上限；`
      + `上游不提供客户总数，缺口无法核对。本次已读到 ${masterCustomers} 家客户档案，地图按这 ${masterCustomers} 家绘制。`,
    )
  }
  const masterCompleteness = {
    label: '客户档案',
    read: masterCustomers,
    total: null,
    totalKnown: false,
    complete: masterFailed === false && cappedPartitions.length === 0,
    missing: null,
    reason: cappedPartitions.length > 0 ? 'exhausted' : (masterFailed ? 'upstream-failed' : null),
    note: cappedPartitions.length > 0
      ? `上游单次最多返回 500 条档案，本次已按业务员分区扫描，共读到 ${masterCustomers} 家；其中 ${cappedPartitions.length} 个分区仍撞到 500 条上限，缺口无法核对。`
      : '',
    requests,
    cacheHits: 0,
  }

  let customers = []
  let scanned = 0
  let truncated = false

  if (scope === 'all') {
    scanned = masterCustomers
    customers = [...masterRows.values()].map((row) => {
      const resolved = resolveGeoProvince(row)
      const ownerName = memberNames.get(String(row.principal_id)) ?? null
      return geoCustomerRow(row, resolved, ownerName, null, null)
    })
  } else {
    // ── 区间口径：按自然月分片把订单取全，再按客户聚合 ──────────────────
    const windows = monthWindowsBetween(startDate, endDate)
    const orderSeen = new Set()
    const byCustomer = new Map()
    let overviewOrderCount = null
    const overviewRes = await runner.run(tools.collection, '区间订单总数（对账用）', {
      start_date: startDate,
      end_date: endDate,
      order_status: 'all',
      limit: 1,
    })
    requests += 1
    if (overviewRes.ok) {
      const overview = sectionOf(overviewRes.value, 'overview') || {}
      overviewOrderCount = numOrNull(overview.order_count)
    } else {
      warnings.push('区间订单总数查询失败，无法核对区间订单是否取全。')
    }

    /**
     * 单片订单读取。
     *
     * 上游 sales_order_collection_analysis 的 limit **被硬顶在 500 行**
     * （实机实测：limit 传 2000 也只返回 500 行，同一次响应里 overview.order_count=687），
     * 而且**没有 offset / 翻页参数** —— 所以「某月订单数 > 500」时那一月会被悄悄截断
     * （实机：区间 5739 单只聚到 4731 单）。
     * 这里的做法：
     *   ① 每片按上游真实上限 limit=500 取；
     *   ② 判截断**不看「返回行数 == limit」**（上游会截，传 2000 时这个判据永远成立、永远拆不开），
     *      而是看**同一次响应里的 overview.order_count**（该窗口自己的订单总数）：
     *      行数 < overview.order_count → 这一片被截断 → 按日期对半拆成两片重查；
     *      每片各用自己的 overview.order_count 判定（不能拿父窗口的数去比子片），
     *      递归最多 2 轮（1→2→4 片）。月订单量 700 左右时 2 片就够。
     *      拿不到 overview.order_count 时退回「行数顶到上游上限」的旧判据，宁可多拆一次。
     *   ③ 细分到顶仍不完整 → 如实标 truncated 并写告警，不假装取全。
     * 细分产生的额外调用同样计入 geoMaxRequests 预算（requests 变量），超预算即停手。
     */
    const ORDER_SLICE_LIMIT = 500
    const MAX_SPLIT_DEPTH = 2
    const fetchWindowOrders = async (window, depth) => {
      if (Date.now() > deadline) {
        truncated = true
        warnings.push(`区间订单读取超过墙钟预算（${budgetMs} ms），已停止分片；已读到 ${byCustomer.size} 个客户。`)
        return []
      }
      const label = depth > 0
        ? `区间订单 ${window.startDate}~${window.endDate}（第 ${depth + 1} 级细分）`
        : `区间订单 ${window.startDate}~${window.endDate}`
      const res = await runner.run(tools.collection, label, {
        start_date: window.startDate,
        end_date: window.endDate,
        order_status: 'all',
        limit: ORDER_SLICE_LIMIT,
      })
      requests += 1
      if (!res.ok) return []
      const orders = rowsOf(res.value, ['orders'])
      /**
       * 判截断：用**这一片自己的** overview.order_count（上游对同一个窗口返回的总单数）。
       * 实机硬事实：limit 传多大都只给 500 行，所以「行数 == limit」这个判据在 limit>500 时
       * 永远为真、永远不触发拆分；必须拿 overview.order_count 做基准。
       */
      const overview = sectionOf(res.value, 'overview') || {}
      const expected = numOrNull(overview.order_count)
      if (!isOrderSliceTruncated(orders.length, expected, ORDER_SLICE_LIMIT)) return orders
      // 被截断：按日期对半拆
      const span = diffDays(window.startDate, window.endDate)
      if (depth >= MAX_SPLIT_DEPTH || span === null || span < 1) {
        truncated = true
        warnings.push(
          `区间订单 ${window.startDate}~${window.endDate} 细分 ${depth} 轮后仍不完整`
          + `（接口报告 ${expected ?? '未知'} 单，实际只返回 ${orders.length} 单；`
          + `上游单次最多返回 ${ORDER_SLICE_LIMIT} 行且没有翻页参数），该片可能仍有缺口；`
          + '已按现状交付并标记 truncated。',
        )
        return orders
      }
      const midOffset = Math.floor(span / 2)
      const mid = addDays(window.startDate, midOffset)
      if (!mid || mid >= window.endDate) {
        truncated = true
        warnings.push(`区间订单 ${window.startDate}~${window.endDate} 无法再按日期对半拆分，已按现状交付并标记 truncated。`)
        return orders
      }
      const left = await fetchWindowOrders({ startDate: window.startDate, endDate: mid }, depth + 1)
      const right = await fetchWindowOrders({ startDate: addDays(mid, 1), endDate: window.endDate }, depth + 1)
      // 父片的 500 行与子片有重叠，但都留着：子片若因预算/失败没读全，父片还能兜住一部分，
      // 重叠部分由调用方的 orderSeen（sale_id / sale_code）去重，不会重复计数。
      return [...orders, ...left, ...right]
    }

    for (const window of windows) {
      if (Date.now() > deadline) {
        truncated = true
        warnings.push(`区间订单读取超过墙钟预算（${budgetMs} ms），已停止分片；已读到 ${byCustomer.size} 个客户。`)
        break
      }
      const windowOrders = await fetchWindowOrders(window, 0)
      for (const order of windowOrders) {
        if (!order) continue
        const key = str(order.sale_id) ?? str(order.sale_code)
        if (key) {
          if (orderSeen.has(key)) continue
          orderSeen.add(key)
        }
        const pk = order.customer_pk
        if (pk === undefined || pk === null) continue
        const customerKey = String(pk)
        let item = byCustomer.get(customerKey)
        if (!item) {
          item = {
            customerPk: num(pk),
            customerCode: str(order.customer_code) ?? null,
            customerName: str(order.customer_name) ?? null,
            ownerName: str(order.member_name) ?? null,
            orderCount: 0,
            signingAmount: 0,
          }
          byCustomer.set(customerKey, item)
        }
        item.orderCount += 1
        // 负数照实累加：红冲单会把金额拉低，不能截断成 0。
        item.signingAmount += num(order.signing_amount)
      }
    }
    const aggregatedOrders = [...byCustomer.values()].reduce((sum, item) => sum + item.orderCount, 0)
    if (overviewOrderCount !== null && overviewOrderCount > aggregatedOrders) {
      truncated = true
      warnings.push(`区间订单未取全：接口报告 ${overviewOrderCount} 单，实际聚合 ${aggregatedOrders} 单。`)
    }
    // join 客户档案：主数据里没有的补查一次（只在预算允许时）。
    const missing = [...byCustomer.values()].filter((item) => !masterRows.has(String(item.customerPk)))
    if (missing.length > 0 && Date.now() <= deadline) {
      const fetched = await mapLimit(missing, 6, async (item) => {
        if (Date.now() > deadline) return { item, row: null }
        const res = await runner.run(tools.customerInfo, `客户档案补查（${item.customerName || item.customerPk}）`, {
          customer_pk: item.customerPk,
          include_sensitive: true,
          limit: 1,
        })
        requests += 1
        if (!res.ok) return { item, row: null }
        const rows = rowsOf(res.value)
        return { item, row: rows[0] || null }
      })
      for (const entry of fetched) {
        if (!entry || !entry.row) continue
        masterRows.set(String(entry.item.customerPk), entry.row)
      }
    }
    scanned = byCustomer.size
    customers = [...byCustomer.values()].map((item) => {
      const raw = masterRows.get(String(item.customerPk))
      const resolved = raw ? resolveGeoProvince(raw) : { province: null, source: null }
      const ownerName = item.ownerName || (raw ? (memberNames.get(String(raw.principal_id)) ?? null) : null)
      const merged = raw
        ? { ...raw, customer_code: raw.customer_code ?? item.customerCode, customer_name: raw.customer_name ?? item.customerName }
        : { id: item.customerPk, customer_id: item.customerCode, customer_name: item.customerName }
      return geoCustomerRow(merged, resolved, ownerName, item.orderCount, Number(item.signingAmount.toFixed(2)))
    })
  }

  // ── 分流：国内可定位 / 定位不到 / 海外 ────────────────────────────────
  // 对外只给契约里的字段：客户名、省份、省份来源、负责人、客户类型、订单数、签单额。
  // 内部主键与编码不外发（前端也不需要，少发一份是一份）。
  const located = []
  const uncovered = []
  const overseas = []
  for (const row of customers) {
    if (row.province === '海外') {
      overseas.push({
        customerName: row.customerName,
        ownerName: row.ownerName,
        customerKind: row.customerKind,
      })
    } else if (row.province) {
      located.push({
        customerName: row.customerName,
        province: row.province,
        provinceSource: row.provinceSource,
        ownerName: row.ownerName,
        customerKind: row.customerKind,
        orderCount: row.orderCount,
        signingAmount: row.signingAmount,
      })
    } else {
      uncovered.push({
        customerName: row.customerName,
        ownerName: row.ownerName,
        customerKind: row.customerKind,
      })
    }
  }
  if (uncovered.length > 0) {
    warnings.push(`有 ${uncovered.length} 个客户未能定位省份（缺中文地址 / 缺统一社会信用代码 / 缺档案），已列在 uncovered 里，未做任何猜测。`)
  }

  const hasAmounts = scope === 'period'
  const provinceMap = new Map()
  for (const row of located) {
    let item = provinceMap.get(row.province)
    if (!item) {
      item = {
        province: row.province,
        customerCount: 0,
        signingAmount: hasAmounts ? 0 : null,
        orderCount: hasAmounts ? 0 : null,
        source: row.provinceSource,
        // 省份下的客户名清单：前端地图常要「点省看客户」，列出来最省事。
        customerNames: [],
      }
      provinceMap.set(row.province, item)
    }
    item.customerCount += 1
    if (row.customerName) item.customerNames.push(row.customerName)
    if (hasAmounts) {
      item.signingAmount = Number((num(item.signingAmount) + num(row.signingAmount)).toFixed(2))
      item.orderCount = num(item.orderCount) + num(row.orderCount)
    }
  }
  const provinces = [...provinceMap.values()]
    .sort((a, b) => b.customerCount - a.customerCount || String(a.province).localeCompare(String(b.province)))
    .map((item) => ({
      province: item.province,
      customerCount: item.customerCount,
      signingAmount: item.signingAmount,
      orderCount: item.orderCount,
      source: item.source,
      // 省份下的客户名清单**只保留前 20 个**：实机 payload 212KB，
      // 光「江苏 173 个客户名」就占一大截，而前端点省份看明细时用 customers[]
      // 按 province 过滤就能拿到完整名单（全量客户明细都在 customers[] 里，
      // 带 customerName/province/provinceSource/ownerName/customerKind/orderCount/signingAmount）。
      // customerCount 仍是该省**全量**客户数，不受截断影响。
      customerNames: item.customerNames.slice(0, PROVINCE_CUSTOMER_NAMES_LIMIT),
      customerNamesTruncated: item.customerNames.length > PROVINCE_CUSTOMER_NAMES_LIMIT,
    }))

  const total = customers.length
  const summary = {
    totalCustomers: total,
    locatedCustomers: located.length,
    uncoveredCustomers: uncovered.length,
    overseasCustomers: overseas.length,
    coverageRate: total > 0 ? Number((located.length / total).toFixed(4)) : null,
    provinceCount: provinces.length,
    topProvince: provinces.length > 0
      ? { province: provinces[0].province, customerCount: provinces[0].customerCount }
      : null,
  }

  const value = {
    ok: true,
    scope,
    range: scope === 'period' ? { startDate, endDate } : null,
    generatedAt: isoLocal(),
    summary,
    provinces,
    customers: located,
    uncovered,
    overseas,
    warnings,
    completeness: [masterCompleteness],
    meta: {
      requests,
      cacheHits: 0,
      scanned,
      masterCustomers,
      // 写明用的是哪条工具链，别让看的人猜数据从哪来。
      source: 'customer_info+collection_analysis',
      truncated: truncated || cappedPartitions.length > 0,
      ordersTruncated: truncated,
      masterTruncated: cappedPartitions.length > 0,
    },
  }

  // 客户档案主数据**只留内存**（里面有地址、电话、信用代码，落盘就是 PII 明文）；
  // 这里只缓存已经过白名单过滤的最终结果。
  if (geoState && geoState.cache) geoState.cache.set(scope === 'all' ? 'geo|all' : `geo|period|${startDate}|${endDate}`, value)
  return value
}

export function apply(ctx, config) {
  try {
    // patch 行的 config 会作为第二参数传入；缺省字段回落到 DEFAULTS。
    const settings = { ...DEFAULTS, ...(config && typeof config === 'object' ? config : {}) }
    const ttlMs = Number(settings.cacheTtlMs) >= 0 ? Number(settings.cacheTtlMs) : DEFAULTS.cacheTtlMs

    /**
     * MCP 工具名前缀方案（换设备不掉数据的关键）。
     * 顺序：用户配置 config.toolPrefixes > DSH 连接器注册表自动发现 > 内置默认。
     * 注册表在 <DSH_HOME>/storages/mcp_connector.json（只读 serverName/url/enabled，
     * **不碰里面的凭据字段**）。
     */
    const prefixPlan = resolveToolPrefixes(settings.toolPrefixes, readMcpConnectors(dshHomeCandidates()))
    const toolPlan = {
      ...buildToolPlan(prefixPlan),
      prefixes: prefixPlan.prefixes,
      sources: prefixPlan.sources,
      warnings: toolPrefixWarnings(prefixPlan),
    }

    /** 整份响应级缓存（内存）。key = sales|start|end|squad|member。 */
    const resultCache = new Map()
    /** 「上次没缓存住」的中文说明（同一 key 一份）。 */
    const cacheNotes = new Map()
    /**
     * 明细路由（customer.dashboard / member.dashboard / customer.geo）的缓存。
     * 与主看板分开：三种路由的参数维度完全不同，混在一个 Map 里 key 会打架。
     * **只放内存**：客户档案主数据里有地址、电话、统一社会信用代码，
     * 落盘就等于把 PII 明文写到磁盘上。
     */
    const detailCache = new Map()
    /** 地理路由的运行期状态（缓存 + 后续可扩展的扫描状态）。 */
    const geoState = { cache: new Map() }

    /**
     * 明细路由的缓存读取：命中返回 true 并把 cached 标记写进 meta。
     * refresh=true 时直接跳过缓存（用户点「刷新」= 彻底重取）。
     */
    function readDetailCache(key, refresh) {
      if (refresh || ttlMs <= 0) return null
      const hit = detailCache.get(key)
      if (!hit) return null
      if (Date.now() - hit.at >= ttlMs) return null
      const value = hit.value
      if (value && typeof value === 'object') {
        value.meta = { ...(value.meta || {}), cached: true, cacheUntil: hit.at + ttlMs }
      }
      return value
    }

    /** 明细路由的缓存写入：命中即返回缓存里的那一份。 */
    function writeDetailCache(key, value) {
      if (ttlMs > 0) detailCache.set(key, { at: Date.now(), value })
      return value
    }

    const diskDirectory = diskCacheDir(settings)
    const disk = ttlMs > 0 ? createDiskCacheWriter(diskDirectory) : null
    if (disk && ttlMs > 0) {
      for (const item of restoreDiskCaches(diskDirectory, ttlMs)) {
        resultCache.set(item.key, { at: item.at, value: item.value })
      }
    }

    /** 把落盘告警并进响应的 warnings（写盘失败必须让用户看见）。 */
    function withDiskWarnings(value) {
      if (!disk || !value || typeof value !== 'object' || Array.isArray(value)) return value
      const problems = disk.drainProblems()
      if (problems.length === 0) return value
      if (!Array.isArray(value.warnings)) value.warnings = []
      for (const text of problems) {
        if (!value.warnings.includes(text)) value.warnings.push(text)
      }
      return value
    }

    /**
     * 取一份完整的销售看板数据（缓存 + 落盘 + 降级都在这里）。
     */
    async function fetchDashboard(request) {
      const startDate = assertDate(request?.startDate, 'startDate')
      const endDate = assertDate(request?.endDate, 'endDate')
      if (startDate > endDate) {
        throw new RangeError(
          `erp-sales-dashboard: startDate (${startDate}) must not be after endDate (${endDate})`,
        )
      }
      const squad = typeof request?.squad === 'string' && request.squad.trim() ? request.squad.trim() : null
      const member = typeof request?.member === 'string' && request.member.trim() ? request.member.trim() : null
      const refresh = request?.refresh === true

      const key = `sales|${startDate}|${endDate}|${squad || ''}|${member || ''}`
      const now = Date.now()
      if (!refresh && ttlMs > 0) {
        const hit = resultCache.get(key)
        if (hit && now - hit.at < ttlMs) {
          const value = hit.value
          value.meta = { ...(value.meta || {}), cached: true, cacheUntil: hit.at + ttlMs }
          return value
        }
      }

      const value = await collectSalesDashboard(ctx, settings, { startDate, endDate, squad, member }, toolPlan)
      const warnings = Array.isArray(value.warnings) ? value.warnings : []
      const calls = Array.isArray(value.calls) ? value.calls : []
      const failedCalls = calls.filter((c) => c && c.ok === false)

      /**
       * 缓存判定（2026-10-26 用户诉求：「点击进去统计完数据后，会缓存 6 个小时，
       * 而不是每次我进去都需要重新拉取数据」）。
       *
       * 旧规则是「**零告警**才进缓存」，看起来稳妥，实际把缓存彻底废掉了：
       * 本插件的 STD 判定探测**恒定**会带一条信息类告警（「STD 判定探测达到预算上限
       * N 个货号」——数据本身是完整的，只是按预算取前 N 个货号），
       * 于是 warnings.length 永远 ≥ 1 → 结果永远不入缓存 → 每次进页面都要重拉 3~5 分钟。
       * 这正是用户反馈的现象。
       *
       * 新规则按**数据是否完整**判定，而不是按「有没有提示」判定：
       *   · 有失败调用（calls[].ok === false）→ 数据不完整，不缓存，下次重新取数；
       *   · 只有信息类告警 → 数据完整，照样缓存 6 小时，告警随结果一起显示。
       */
      if (ttlMs > 0 && failedCalls.length === 0) {
        resultCache.set(key, { at: Date.now(), value })
        if (disk) {
          disk.put(key, value)
          // 等落盘完成再返回：磁盘缓存是「重启 DSH 后仍命中」的那一份，
          // 如果不 await，写盘是个悬空的异步任务，进程退出/重启就丢了。
          // 这里只多花几毫秒（140KB JSON），换来缓存的确定性。
          await disk.flush()
        }
        if (warnings.length > 0) {
          cacheNotes.set(
            key,
            `本次结果含 ${warnings.length} 条提示（部分口径按预算取数，非取数失败），已缓存 ${Math.round(ttlMs / 60000)} 分钟；提示随结果一起显示。`,
          )
        } else {
          cacheNotes.delete(key)
        }
      } else if (failedCalls.length > 0) {
        cacheNotes.set(
          key,
          `本次有 ${failedCalls.length} 个数据源取数失败，结果不完整，未写入缓存；下次打开将重新取数。`,
        )
      }
      const note = cacheNotes.get(key)
      if (note) value.meta = { ...(value.meta || {}), cacheNote: note }
      if (ttlMs > 0) {
        value.meta = {
          ...(value.meta || {}),
          cacheTtlMs: ttlMs,
          cacheUntil: Date.now() + ttlMs,
        }
      }
      return value
    }

    /**
     * 单客户详情路由：缓存 + 参数校验 + 降级都在这里。
     * 缓存 key 带上客户标识与区间；refresh=true 跳过缓存（彻底重取）。
     */
    async function fetchCustomerDashboard(request) {
      const name = typeof request?.name === 'string' ? request.name.trim() : ''
      const code = typeof request?.customerCode === 'string' ? request.customerCode.trim() : ''
      const pk = numOrNull(request?.customerPk)
      const startDate = assertDate(request?.startDate, 'startDate')
      const endDate = assertDate(request?.endDate, 'endDate')
      const refresh = request?.refresh === true
      const key = `customer.dashboard|${pk ?? ''}|${code}|${name}|${startDate}|${endDate}`
      const hit = readDetailCache(key, refresh)
      if (hit) return hit
      const value = await collectCustomerDashboard(ctx, settings, { ...request, startDate, endDate }, toolPlan)
      return writeDetailCache(key, value)
    }

    /** 单业务员详情路由（缓存策略同客户详情）。 */
    async function fetchMemberDashboard(request) {
      const memberId = numOrNull(request?.memberId)
      const memberName = typeof request?.memberName === 'string' ? request.memberName.trim() : ''
      const startDate = assertDate(request?.startDate, 'startDate')
      const endDate = assertDate(request?.endDate, 'endDate')
      const refresh = request?.refresh === true
      const key = `member.dashboard|${memberId ?? ''}|${memberName}|${startDate}|${endDate}`
      const hit = readDetailCache(key, refresh)
      if (hit) return hit
      const value = await collectMemberDashboard(ctx, settings, { ...request, startDate, endDate }, toolPlan)
      return writeDetailCache(key, value)
    }

    /**
     * 客户地理分布路由（缓存策略同客户详情）。
     * scope='all' 不带日期；scope='period' 必须带区间。
     */
    async function fetchCustomerGeo(request) {
      const scope = request?.scope === undefined || request?.scope === null || request?.scope === ''
        ? 'period'
        : String(request.scope).trim()
      const refresh = request?.refresh === true
      let startDate = ''
      let endDate = ''
      if (scope === 'period') {
        startDate = assertDate(request?.startDate, 'startDate')
        endDate = assertDate(request?.endDate, 'endDate')
      }
      const key = scope === 'all' ? 'customer.geo|all' : `customer.geo|period|${startDate}|${endDate}`
      const hit = readDetailCache(key, refresh)
      if (hit) return hit
      const value = await collectCustomerGeo(
        ctx,
        settings,
        { ...request, scope, startDate, endDate },
        toolPlan,
        geoState,
      )
      return writeDetailCache(key, value)
    }

    // ── Client 入口（同源 HTTP）────────────────────────────────────────────
    const webServer = (() => {
      try {
        return typeof ctx.get === 'function' ? ctx.get('webServer') : ctx.webServer
      } catch {
        return undefined
      }
    })()

    if (webServer !== undefined && typeof webServer.register === 'function') {
      ctx.effect(() =>
        webServer.register({
          kind: 'prefix',
          path: '/erp-sales-dashboard/api',
          handler: async (req, res) => {
            const send = (status, payload) => {
              res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify(payload))
            }
            const method = String(req.method || 'GET').toUpperCase()
            const route = new URL(req.url || '/', 'http://localhost').pathname
              .replace(/^\/erp-sales-dashboard\/api\/?/, '')
              .replace(/\/+$/, '')
              .toLowerCase()
            // 只接受 POST（与 erp-dashboard 同款）。
            if (method !== 'POST') {
              send(404, { ok: false, error: `no such route: ${method} /${route}` })
              return
            }

            let args = {}
            try {
              args = await readJsonBody(req)
            } catch (error) {
              send(200, { ok: false, error: compactUpstreamMessage(error && error.message ? error.message : String(error)) })
              return
            }

            const dispatch = {
              // 销售作战看板主路由
              dashboard: () => fetchDashboard(args || {}),
              // 诊断探针（确认客户端启动阶段）
              beacon: () => {
                appendBeacon(args)
                return { ok: true }
              },
              // AI 多轮对话（对当前板块数据做解读；路由名是带点的 'ai.chat'）
              'ai.chat': () => aiChat(ctx, args, settings),
              // 单客户详情（路由名带点 → 前端路由表要用小写同名）
              'customer.dashboard': () => fetchCustomerDashboard(args || {}),
              // 单业务员详情
              'member.dashboard': () => fetchMemberDashboard(args || {}),
              // 客户地理分布
              'customer.geo': () => fetchCustomerGeo(args || {}),
            }

            if (!Object.prototype.hasOwnProperty.call(dispatch, route)) {
              send(404, { ok: false, error: `no such route: ${method} /${route}` })
              return
            }
            try {
              const value = await dispatch[route]()
              send(200, withDiskWarnings(value))
            } catch (error) {
              const message = error && error.message ? error.message : String(error)
              const isInputError = error instanceof TypeError || error instanceof RangeError
              send(isInputError ? 200 : 500, { ok: false, error: message })
              if (!isInputError) console.warn(`[erp-sales-dashboard] ${route} failed:`, error)
            }
          },
        }),
      )
    } else {
      console.warn('[erp-sales-dashboard] webServer 服务不可用，客户端取数路由未注册')
    }
  } catch (error) {
    // apply 绝不抛：可选 UI 插件不能阻断 DSH 启动。
    console.warn('[erp-sales-dashboard] apply 失败（已忽略）:', error)
  }
}

/**
 * 诊断探针：把客户端回报的启动阶段追加到日志。
 * 只写状态文本，不写任何业务数据。
 *
 * 路径不能硬编码到某个盘符目录（那是别人机器上的路径，且会往磁盘根目录乱扔文件）：
 * 优先 DSH_LOG_DIR，其次系统临时目录，保证任何机器上都能写、且不污染用户目录。
 */
const BEACON_LOG = path.join(process.env.DSH_LOG_DIR || os.tmpdir(), 'erp-sales-dashboard-beacon.log')
function appendBeacon(info) {
  try {
    const fsPromises = fs.promises
    const line = `${new Date().toISOString()} ${JSON.stringify(info)}\n`
    fsPromises
      .mkdir(path.dirname(BEACON_LOG), { recursive: true })
      .then(() => fsPromises.appendFile(BEACON_LOG, line, 'utf8'))
      .catch((error) => console.warn('[erp-sales-dashboard] beacon write failed:', error))
  } catch (error) {
    console.warn('[erp-sales-dashboard] beacon write failed:', error)
  }
}
