// ---------------------------------------------------------------------------
// 插件运行所必需的数据层工具清单
//
// 判定口径：缺了它，仪表盘对应板块就取不到数（不是「少一个功能」而是「数据空」）。
// 清单**以插件 bundle 的调用为准**（bundle 的 TOOL 常量块），
// 安装器 check-install 会顺手扫一遍 bundle 源码，把「bundle 用到但没列进本清单」的
// 工具列成提示，防止两边悄悄漂移。
//
// ⚠️ 换设备时最容易踩的坑：DSH 里 MCP 连接器的「服务器名」不一定叫 erp / std / planning。
//    工具全名 = mcp__<连接器名>__<工具名>，连接器名一改，前缀就得跟着改。
//    插件侧对应配置项是 cordis.patch.yml 里的 config.toolPrefixes。
//
// 安全：这里只写工具名，不写任何连接器凭据。
// ---------------------------------------------------------------------------

/**
 * @type {{tool:string, required:boolean, usedBy:string, expectServer?:string}[]}
 * expectServer 只在「缺失」时用于提示该去连哪个 server，不参与匹配。
 */
export const REQUIRED_TOOLS = [
  // ---- erp 侧（销售主数据） ----
  { tool: 'total_performance_analysis', required: true, expectServer: 'erp', usedBy: '总业绩 / 趋势 / Top 客户（抽样源）' },
  { tool: 'sales_performance_ranking', required: true, expectServer: 'erp', usedBy: '业绩排名与军令状完成率' },
  { tool: 'member_performance_analysis', required: true, expectServer: 'erp', usedBy: '成员业绩明细（新兵表用 username 连接）' },
  { tool: 'sales_order_collection_analysis', required: true, expectServer: 'erp', usedBy: '回款 / 逾期 / 问题单' },
  { tool: 'customer_analysis', required: true, expectServer: 'erp', usedBy: '客户结构与新增客户' },
  { tool: 'customer_tier_rating', required: true, expectServer: 'erp', usedBy: 'ABCD 分档与 B 类订单占比' },
  { tool: 'customer_info', required: true, expectServer: 'erp', usedBy: '客户基础档案（直销/经销判定）' },
  { tool: 'quotation_query', required: true, expectServer: 'erp', usedBy: '报价与 STD 货号识别' },
  { tool: 'inquiry_plan_query', required: true, expectServer: 'erp', usedBy: '询盘 / 统筹完成量' },
  { tool: 'sales_customer_360', required: true, expectServer: 'erp', usedBy: '客户跟进记录（沉睡 / 跟进达标）' },
  // ---- std 侧 ----
  { tool: 'after_sale_management_query', required: true, expectServer: 'std', usedBy: '售后闭环' },
  { tool: 'std_product_info_query', required: true, expectServer: 'std', usedBy: 'STD 品牌判定' },
  { tool: 'performance_assessment', required: true, expectServer: 'std', usedBy: '绩效档位分布' },
  { tool: 'staff_info', required: true, expectServer: 'std', usedBy: '花名册（新兵 = 尚未转正的业务咨询成员）' },
]

/** 工具全名（带 mcp__<server>__ 前缀） */
export function fullToolName(server, tool) {
  return `mcp__${server}__${tool}`
}

/** 默认的连接器前缀（连接器名就是 erp / std / planning 时用这个） */
export const DEFAULT_TOOL_PREFIXES = {
  erp: 'mcp__erp__',
  std: 'mcp__std__',
  planning: 'mcp__planning__',
}

/**
 * 按连接器分组的代表性工具（用于「插件要调哪些工具名」的清单展示）。
 * planning 是可选的 —— 插件不依赖它出数，缺了不影响面板。
 */
export const CONNECTOR_GROUPS = [
  {
    server: 'erp',
    label: 'ERP 销售主数据',
    optional: false,
    tools: REQUIRED_TOOLS.filter((t) => t.expectServer === 'erp').map((t) => t.tool),
  },
  {
    server: 'std',
    label: 'STD / 人事 / 售后',
    optional: false,
    tools: REQUIRED_TOOLS.filter((t) => t.expectServer === 'std').map((t) => t.tool),
  },
  {
    server: 'planning',
    label: '统筹（可选）',
    optional: true,
    tools: [],
  },
]
