# @local/erp-sales-dashboard — 契约与口径说明书（唯一事实源）

> 本文件是 Host 半（index.js）与 Client 半（client.js）的唯一接口契约。
> 两半各自实现时**不得**擅自增删字段；需要新增字段先改本文件。

---

## 1. 插件定位

**一句话**：给销售线（不是给统筹/产品中心）看的 ERP 经营作战看板，覆盖《业绩经营数据看板思路1025.docx》
的指标口径 + 《业务咨询销售团队数据看板方案1025.pptx》的 6 章结构 + 《全军作战数据看板（完整版1025）.xlsx》
的字段级明细，全部取自 ERP / STD 的**只读 MCP 工具**，不落任何假数据。

参照对象：`@local/erp-dashboard`（ERP 业务工作台）。本插件**复用它的架构与视觉语言**，但目标用户、
指标口径、工具组合完全不同。

| 维度 | erp-dashboard（业务工作台） | **erp-sales-dashboard（本插件）** |
|---|---|---|
| 视角 | 统筹 / 产品中心 | **销售线（业绩/客户/回款/获客/成长）** |
| 板块 | 业务总览 / 统筹 / 产品 / 绩效 / 风险 / 货号 | **业绩总览 / 订单质量 / 回款售后 / 客户激活 / 获客转化 / 学习成长 / 订单待办** |
| 主工具 | mcp__std__* 为主 | **mcp__erp__* 为主 + mcp__std__* 辅助** |

---

## 2. 目录与文件

```
D:/path/to/erp-sales-dashboard-bundle/
├── package.json          # 已写好（name=@local/erp-sales-dashboard, exports ./ 和 ./client）
├── cordis.patch.yml      # 已写好（insert 插件条目 + config 默认值）
├── locale\zh.json        # 已写好
├── locale\en.json        # 已写好
├── icon.svg              # 已写好
├── CONTRACT.md           # 本文件
├── index.js              # Host 半（待写）
├── client.js             # Client 半（待写）
├── selfcheck.mjs         # 静态自检（待写）
└── docs\口径与数据可得性.md  # 口径说明（待写）
```

---

## 3. HTTP 契约

### 3.1 路由前缀

`webServer.register({ kind: 'prefix', path: '/erp-sales-dashboard/api', handler })`
—— 与 erp-dashboard 同款：**只有 POST**，路由名从 URL 里剥前缀后取。

### 3.2 `POST /erp-sales-dashboard/api/dashboard`

请求体（JSON）：

```jsonc
{
  "startDate": "2026-01-01",   // 必填，YYYY-MM-DD
  "endDate":   "2026-10-25",   // 必填，YYYY-MM-DD
  "squad":  "",                // 可选，销售梯队（= ERP 二级部门名），空 = 全部
  "member": "",                // 可选，业务员姓名，空 = 全部
  "refresh": false             // 可选，true = 跳过结果缓存强制重取
}
```

响应体：`{ ok: true, ...payload }`；失败 `{ ok:false, error:"..." }`（HTTP 200 表示参数错误，500 表示内部错误）。

### 3.3 `POST /erp-sales-dashboard/api/beacon`

请求体 `{ stage: string, extra?: object }` → 响应 `{ ok: true }`。用于 Client 启动阶段诊断探针。

### 3.4 `POST /erp-sales-dashboard/api/ai.chat`

当前板块的**多轮对话式 AI 分析**（参照 erp-dashboard 的 `ai.chat`）。

请求体：

```jsonc
{
  "payload": {
    "title": "业绩总览",                 // 当前页签名
    "aiContext": { "northStar": {}, "overview": {}, "period": {}, "filters": {} }  // 当前板块数据
  },
  "messages": [ { "role": "user", "content": "本月完成率多少？" } ],  // 历史（只取 role/content）
  "question": "哪些梯队落后？"           // 本轮问题
}
```

响应体：

```jsonc
{ "ok": true, "text": "……模型回答……", "model": "minimax-cn/MiniMax-M3.1-Flash", "failures": [] }
```

失败：`{ ok: false, "error": "…" }`。

**实现铁律（Host 半）**

- 候选模型优先级：`settings.aiProvider` → `ctx.get('agentDefaultModel').currentSelection()` → 注册表里匹配 `/minimax/i` 的 provider 首个模型 → 其它 provider 首个模型；**候选对象里绝不放 API key**。
- 每个候选先试 `reasoningEffort='low'`，再试 `null`；最多 5 个候选；全失败抛
  `AI 分析失败（已尝试 N 个模型）：<每条原因用 ｜ 连接>`。
- **必须把多轮历史折成只用 user 角色的消息再发**（`foldHistoryToUserTurns`）：DSH 的 llm 服务
  一旦收到**带正文的 assistant 消息**就抛 `Cannot read properties of undefined (reading 'replayState')`，
  所有候选模型全失败 → 接口 500。对照实验：assistant content 空串 / 无 content 字段 / 连续两条 user 都正常。
- `aiContext` 截断到 12000 字符；history 只保留末尾 12 条，assistant 内容截 1500 字符。
- 超时 180000ms；对话 temperature 0.5、`maxTokens` 30000。
- 回答正文为空但有思考内容时，报错「模型只产出了思考内容（N 字）而没有正文，通常是推理强度过高或 token 预算不足」。

### 3.5 实体档案三条路由（页签 8 客户档案 / 页签 9 业务员档案）

新增于 v1.1.0，对应用户要求「借鉴 ERP 业务工作台的**业绩分析 / 客户分析 / 业务员分析**三个板块」。
三条路由**独立于主 dashboard**，不塞进主 payload（避免主看板变大变慢）。
**字段名一律 camelCase**（主 payload 保持 snake_case，两套不混用）。

#### 3.5.1 `POST /erp-sales-dashboard/api/customer.dashboard`

请求体：`{ name: string, startDate: string, endDate: string, refresh?: boolean }`
（`name` 可以是客户名或客户编码；`startDate/endDate` 用主 payload 的区间，**不受主 payload 的 squad/member 筛选影响**。）

响应体：

```jsonc
{
  "ok": true,
  "period": { "startDate": "2026-01-01", "endDate": "2026-10-25" },
  "generatedAt": "2026-11-03T08:20:00.000Z",
  "resolved": {
    "customerPk": 1120, "customerCode": "F00264",
    "customerName": "示例客户02", "principalName": "业务员01",
    "candidates": [ { "customerPk": 1120, "customerCode": "F00264", "customerName": "…", "orderCount": 48, "totalAmount": 2300000.00 } ],
    "ambiguous": true            // true = 同名多主体，必须让用户点选，不要默认选第一个
  },
  "profile": {                   // 无 phone / address / duty_paragraph / remark
    "customerPk": 1120, "customerCode": "F00264", "customerName": "…",
    "customerKind": "终端客户", "areaName": "", "firstDealTime": "2023-11-21",
    "principalName": "业务员01",
    "creditLimit": 0, "usedAmount": 0, "remainAmount": 0, "creditUsageRate": null,
    "riskCoefficient": null, "recommendedLimit": null, "avgPaymentDays": null,
    "creditCalcTime": null, "riskTags": []
  },
  "periodMetrics": {             // 【口径一】所选区间
    "orderCount": 17, "signingAmount": 1250000.00, "collectionAmount": 980000.00,
    "uncollectedAmount": 270000.00,           // = 签约 − 已回款（归一值）
    "uncollectedAmountUpstream": 285000.00,   // 上游原值（部分回款按全额计入，虚高）
    "unpaidOrderCount": 2, "partialPaidOrderCount": 7,
    "overdueOrderCount": 5, "problemOrderCount": 0, "finishedOrderCount": null,
    "collectionRate": 0.7892, "uncollectedRate": 0.2108, "overdueOrderRate": 0.2941,
    "avgOrderAmount": 73529.41, "firstOrderTime": "2026-01-21", "lastOrderTime": "2026-09-28",
    "note": "…区间口径说明…"
  },
  "lifetime": {                 // 【口径二】客户全周期
    "orderCount": 48, "signingAmount": 2300000.00, "collectionAmount": 1900000.00,
    "uncollectedAmount": 400000.00, "uncollectedAmountUpstream": null,
    "partialPaidOrderCount": 25, "overdueOrderCount": 19, "collectionRate": 0.8404,
    "firstOrderTime": "2023-11-21", "lastOrderTime": "2026-10-27"
  },
  "rating": {                   // 【口径三】近 12 个月（customer_tier_rating）
    "available": true, "ruleVersion": "v3.1.0-fold100", "ruleSource": "…",
    "baseDate": "2026-11-03", "totalScore": 69.77, "totalScoreRaw": 60.02,
    "tier": "A", "tierName": "核心客户", "nextTierGap": 10.23,
    "completenessPct": 0.86, "isLowerBound": false, "missingItems": [],
    "riskAlerts": [], "breakdown": [ /* 11 项评分明细 */ ], "dimensions": [ /* … */ ],
    "upgradeRules": [], "vetoRules": [], "metrics": { /* … */ }, "categoryNames": [],
    "qcc": null                  // 企查查不可得时为 null，前端不渲染该块
  },
  "lifecycle": {
    "monthlyTrend": [ { "period": "2026-01", "orderCount": 2, "signingAmount": 1, "collectionAmount": 1 } ],
    "visits": [ { "time": "…", "content": "…", "giftContent": "…", "visitName": "…" } ],  // 白名单字段，无收件人电话/地址
    "inquiries": [], "quotations": [], "afterSales": [],
    "notes": { "afterSales": [] }, "counts": { "visits": 1, "inquiries": 0, "quotations": 1, "afterSales": 1 }
  },
  "benchmark": {                // 【口径四】总盘
    "totalSigningAmount": 11900000.00, "totalOrderCount": 5770, "totalCustomerCount": 320,
    "rank": 1, "rankTotal": 100, "topList": [ { "rank": 1, "customerName": "…", "signingAmount": 1 } ],
    "shareOfTotal": 0.0753, "isInTopList": true, "avgPerCustomer": 37187.50
  },
  "orders": [ { "saleCode": "…", "saleState": 1, "saleStateLabel": "在途未完成",
                "saleMoneyBack": 1, "saleDate": "…",
                "overdueDays": null, "overdue": false, "accountPeriod": "…",
                "memberName": "…", "departmentName": "…",
                "signingAmount": 1, "collectionAmount": 1, "uncollectedAmount": 1 } ],
  "notes": [ "…" ], "warnings": [ "…" ],
  "calls": [ { "tool": "…", "label": "…", "ok": true, "ms": 123, "note": "…" } ]
}
```

#### 3.5.2 `POST /erp-sales-dashboard/api/member.dashboard`

请求体：`{ memberId?: number, memberName?: string, startDate: string, endDate: string, refresh?: boolean }`（二者至少给一个）

响应体：

```jsonc
{
  "ok": true, "generatedAt": "…", "period": { "startDate": "…", "endDate": "…" },
  "resolved": { "memberId": 901, "memberName": "业务员01", "username": "YX90014",
                "departmentName": "鲲鹏特战队", "candidates": [], "ambiguous": false },
  "profile": { "memberId": 901, "memberName": "业务员01", "username": "YX90014",
               "departmentName": "鲲鹏特战队", "staffName": "…", "joinTime": "…",
               "education": "…", "status": 2,
               "note": "人员档案只保留业务字段；手机号、座机、邮箱、性别等一律不下发（PII 红线）。" },
  "periodMetrics": { "customerCount": 1, "orderCount": 1, "signingAmount": 1,
                     "acceptanceAmount": 1, "finishAmount": 1, "finishAmountRate": 0.4942,
                     "finishRate": 0.6176, "uncollectedAmount": 1, "unpaidRate": 0.2304,
                     "collectionRate": 0.7016, "overdueOrderCount": 21, "problemOrderCount": 1,
                     "avgOrderAmount": 28000.00, "avgCustomerAmount": 335000.00, "note": "…" },
  "target": { "available": true, "targetAmount": 5000000,
              "ytdSigningAmount": 5700000.00, "ytdCollectionAmount": 4000000.00,
              "signingCompletionRate": 1.140218526,   // 允许 > 1（超额完成）
              "collectionCompletionRate": 0.800001136, "signingGap": -700000.00,
              "completionBasisLabel": "…", "periodBasisLabel": "…", "warnings": [] },
  "benchmark": { "rank": 1, "rankTotal": 103, "departmentRank": 1, "departmentSize": 12,
                 "departmentAvgSigning": 1, "companyAvgSigning": 1,
                 "vsDepartmentAvg": 1, "vsCompanyAvg": 1,
                 "peers": [ { "memberId": 901, "memberName": "业务员01", "signingAmount": 1,
                              "collectionRate": 0.7, "isSelf": true } ],
                 "topMembers": [ { "rank": 1, "memberName": "…", "departmentName": "…", "signingAmount": 1 } ],
                 "note": "…" },
  "collection": { "overview": { "orderCount": 1, "signingAmount": 1, "collectionAmount": 1,
                                "uncollectedAmount": 1, "collectionRate": 0.7016,
                                "unpaidOrderCount": 1, "overdueOrderCount": 1,
                                "problemOrderCount": 1 },
                  "orders": [ /* 同 orders 行结构 */ ] },
  "recentOrders": [ /* 同 orders 行结构；不受区间限制 */ ],
  "notes": [ "…" ], "warnings": [ "…" ], "calls": [ /* … */ ]
}
```

#### 3.5.3 `POST /erp-sales-dashboard/api/customer.geo`

请求体：`{ startDate: string, endDate: string, scope: 'period' | 'all', refresh?: boolean }`

响应体：

```jsonc
{
  "ok": true, "scope": "period", "range": { "startDate": "…", "endDate": "…" },
  "generatedAt": "…",
  "summary": { "totalCustomers": 300, "locatedCustomers": 285, "uncoveredCustomers": 1,
               "overseasCustomers": 58, "coverageRate": 0.9529, "provinceCount": 30,
               "topProvince": { "province": "江苏", "customerCount": 120 } },
  "provinces": [ { "province": "江苏", "customerCount": 120, "signingAmount": 1700000.00,
                    "orderCount": 758, "source": "credit_code",
                    "customerNames": [ "…（最多 20 个）" ], "customerNamesTruncated": true } ],
  "customers": [ { "customerName": "…", "province": "江苏", "provinceSource": "credit_code",
                   "ownerName": "…", "customerKind": "终端客户",
                   "orderCount": 3, "signingAmount": 1 } ],
  "uncovered": [ { "customerName": "…", "ownerName": "…", "customerKind": "…" } ],
  "overseas":  [ { "customerName": "…", "ownerName": "…", "customerKind": "…" } ],
  "warnings": [ "…" ],
  "completeness": [ { "label": "客户档案", "read": 2200, "total": null, "totalKnown": false,
                      "complete": false, "missing": null, "reason": "exhausted",
                      "note": "…", "requests": 36, "cacheHits": 0 } ],
  "meta": { "requests": 136, "cacheHits": 0, "scanned": 300, "masterCustomers": 2200,
            "source": "customer_info+collection_analysis",
            "truncated": true, "ordersTruncated": false, "masterTruncated": true }
}
```

**geo 铁律**：省份解析优先级 = `country===1`（海外）→ 信用代码第 3-4 位省码 → 地址省名前缀 → 地址地级市表 → `area_name`；
**绝不能用公司名猜省份**；都不中落 `uncovered`。地图结果**只放内存缓存，不落盘**。
省份明细表必须用 `customers[]` 按 `province` 过滤渲染（`provinces[].customerNames` 会被截断到 20 个）。

---

## 4. 响应 payload 结构（完整 schema）

> 数值单位：**金额一律「元」**（除特别标注）；比率一律 **0~1 的小数**（前端负责 ×100 显示）；
> 占比类字段另给 `share`（0~1）。所有可能取不到的值用 `null`，**不要用 0 冒充**。

```jsonc
{
  "ok": true,
  "generatedAt": "2026-10-25T23:00:00+08:00",
  "period": { "startDate": "2026-01-01", "endDate": "2026-10-25", "days": 298, "prevStartDate": "2025-01-01", "prevEndDate": "2025-10-25" },

  "filters": {
    "squad": null,                       // 当前筛选的梯队
    "member": null,
    "squads": [ { "name": "战狼特战队", "headcount": 11 } ],   // 可选梯队清单
    "members": [ { "id": 221, "name": "业务员14", "squad": "战狼特战队" } ] // 可选人员清单
  },

  "meta": {
    "cached": false,                     // 本次是否命中缓存
    "cacheTtlMs": 21600000,
    "cacheUntil": 1796000000000,         // 本次结果的缓存到期时间戳（ms）
    "cacheNote": "",                     // 缓存说明（中文）：为什么入/不入缓存
    "toolCalls": 47,                     // 实际 MCP 调用次数
    "budget": 120,                       // 调用预算上限
    "elapsedMs": 8200,
    "thresholds": {                      // v6：本次实际生效的预警阈值（唯一真相源 = cordis.patch.yml 的 config.thresholds）
      "stdShare": 0.6,                   // STD 营收占比目标
      "bShare": 0.4,                     // B 类订单占比目标
      "cShare": 0.15,                    // C 类订单占比上限
      "collectionRate": 0.9,             // 回款率目标
      "growthDrop": 0.2,                 // 同比/环比降幅红线
      "source": "patch"                  // "patch" = 来自配置；"default" = 全部用默认值
    },
    "squadMerges": [                     // v6：梯队名归并记录（上游坏字节）
      { "from": "<3 个 U+FFFD 替换字符>狼特战队", "to": "战狼特战队", "basis": "suffix", "suffixLen": 3, "members": 1 }
    ],
    "toolPrefixes": {                    // v10：本次实际使用的 MCP 工具名前缀（= DSH 连接器名）
      "erp": "mcp__erp__",
      "std": "mcp__std__",
      "planning": "mcp__planning__"
    },
    "toolPrefixSource": {                // v10：每个分组的来源，便于一眼看出是配的还是发现的
      "erp": "discovered",               // "config" = 来自 config.toolPrefixes；"discovered" = 读连接器注册表认领；"default" = 内置默认
      "std": "discovered",
      "planning": "discovered"
    }
  },

  "northStar": {
    "rows": [
      { "key": "revenue",  "label": "年度营收",     "value": 11900000.00, "target": 100000000, "rate": 0.475, "status": "warn", "sub": "口径：区间接单额" },
      { "key": "stdShare", "label": "STD 营收占比", "value": 0.55, "target": 0.60, "rate": 0.92, "status": "warn", "sub": "口径：报价口径（ERP 无订单级货号）" },
      { "key": "bShare",   "label": "B 类订单占比", "value": 0.38, "target": 0.40, "rate": 0.95, "status": "warn", "sub": "口径：抽样加权" },
      { "key": "cShare",   "label": "C 类订单占比", "value": 0.12, "target": 0.15, "rate": 0.80, "status": "warn", "sub": "口径：抽样加权，C 类越低越好" },
      { "key": "headcount","label": "在册销售人数", "value": 47, "target": null, "rate": null, "status": "unknown", "sub": "ERP 在册成员数" },
      { "key": "perCapita","label": "人均产出",     "value": 1000000.00, "target": null, "rate": null, "status": "unknown", "sub": "区间接单额 ÷ 在册人数" }
    ]
  },

  "overview": {
    "kpis": [
      {
        "key": "signing", "label": "业绩总额（接单额）", "value": 11900000.00, "unit": "元",
        "target": null, "rate": null,        // rate = value/target
        "yoy": 0.120, "mom": null,            // 同比 / 环比，0~1 小数
        "status": "good",                    // good | warn | bad | unknown
        "sub": "口径：total_performance_analysis.order_total_amount"
      }
    ],
    "trend":  [ { "period": "2026-01", "signing": 1200000, "collection": 870000, "orders": 480, "customers": 210, "acceptance": 1100000 } ],
    "trendPrev": [ { "period": "2025-01", "signing": 850000, "collection": 600000, "orders": 452 } ],  // 去年同期，按月份对齐
    "squads": [
      { "name": "鲲鹏特战队",
        "headcount": 8,                     // 区间内有业绩人数（= activeCount）
        "activeCount": 8,                  // 同 headcount，语义化别名
        "totalMembers": 12,                // ERP 在册成员数（含 0 业绩/离职占位）
        "headcountNote": "人数两个口径：headcount/activeCount=区间内有业绩人数；totalMembers=ERP 在册成员数（含 0 业绩/离职占位）",
        "signing": 9000000.00, "target": 10000000,
        "targetMembers": 2,                // 军令状目标覆盖到的人数
        "targetBasis": "partial",          // partial | full | null
        "targetNote": "军令状目标仅覆盖 8 名有业绩成员中的 2 人（6 人无目标），completion 被低估",
        "completion": 0.9383,              // = signing / target（分母只覆盖 targetMembers 名）
        "completionBasis": "partial",
        "completionAligned": 0.8571,       // 同口径对照：signing ÷ 按覆盖人数折算的目标
        "status": "warn",                  // targetBasis=partial 时强制降级为 warn
        "perCapita": 360000.00, "perCapitaActive": 360000.00, "perCapitaTotal": 281912.11,
        "collectionRate": 0.4910, "overdue": 54, "customers": 53 }
    ],
    "ranking": [
      { "rank": 1, "memberId": 901, "memberName": "业务员01", "squad": "鲲鹏特战队",
        "signing": 5700000.00, "target": 5000000, "completion": 1.14,
        "collection": 5929200.00, "collectionRate": 0.6588,
        "customers": 17, "orders": 204, "overdue": 31, "problem": 0,
        "status": "good", "warning": "" }
    ],
    "rankingInactive": {                   // 0 业绩 / 离职占位成员（不参与排名表）
      "status": "partial", "count": 58,
      "rows": [ { "memberId": 0, "memberName": "占位成员02", "squad": "…", "signing": 0 } ]
    },
    "growth": [
      { "memberId": 903, "memberName": "张三", "squad": "新兵特训营", "joinDate": "2026-08-01",
        "months": 3, "level": "A-3级-B", "status": "good", "signing": 150000 }
    ],
    "targets": { "total": 17000000, "count": 41 }   // 军令状目标合计（覆盖到的人数）
  },

  "quality": {
    "abc": {
      "status": "sampled",              // sampled | unavailable
      "sampleSource": "top_customers",  // 抽样源：区间成交额 Top N 客户（total_performance_analysis.top_customers）
      "sampleCustomers": 12,            // 参与分档判定的客户数
      "coverageAmount": 4800000.00,    // 抽样覆盖的签约额
      "coverageShare": 0.2701,          // 抽样覆盖占总签约额比例（实测 27.0%）
      "bShare": 0.1991,                 // B 类订单占比（抽样加权）
      "rows": [ { "tier": "A", "count": 10, "share": 0.8333, "score": 75.349, "amount": 3600000.00 } ],
      "note": "抽样源为区间成交额 Top N 客户（total_performance_analysis.top_customers，已播种 20 个，其中新建 19 个）；ERP 未在订单级暴露 sale_level，按 customer_tier_rating.b_order_share 加权估算。"
    },
    "std": {
      "status": "partial",              // partial | unavailable
      "basis": "报价口径（quotation.details.goods_code 判定 STD 产品表）",
      "quoteAmount": 1500000,
      "stdAmount": 900000,
      "stdShare": 0.6581,
      "probedGoods": 24,                // 实际探测的货号数
      "probedOk": 24,                   // 成功判定为 STD 的货号数
      "budget": 24,                     // stdProbeBudget
      "coverageAmount": 950000,        // 已判定货号覆盖的报价额
      "coverageShare": 0.6701,          // 覆盖率
      "note": "口径：报价明细货号判定 STD 产品表；未探测货号按非 STD 计，故为下限估计",
      "rows": [ { "code": "RM758338M", "name": "琥珀酸美托洛尔杂质38", "amount": 520000, "std": true } ]
    },
    "model": {
      "status": "partial",
      "rows": [ { "kind": "直销", "customers": 310, "amount": 6000000, "share": 0.63 },
                { "kind": "经销商", "customers": 120, "amount": 2400000, "share": 0.25 },
                { "kind": "其他/未知", "customers": 40, "amount": 1100000, "share": 0.12 } ]
    },
    "track": {
      "status": "partial",
      "rows": [ { "track": "药企/CRO/经销商", "customers": 200, "amount": 5000000, "share": 0.53 },
                { "track": "化妆品/检验检测/农兽药", "customers": 90, "amount": 1600000, "share": 0.17 } ]
    },
    "goods": {
      "status": "partial",
      "rows": [ { "code": "RM758338M", "name": "…", "amount": 520000, "orders": 12, "repeatCustomers": 7, "std": true } ]
    }
  },

  "collection": {
    "kpis": [ { "key": "collectionRate", "label": "回款率", "value": 0.567, "unit": "", "target": 0.9, "rate": 0.63, "yoy": -0.38, "mom": null, "status": "bad", "sub": "口径：collection_amount ÷ signing_amount" } ],
    "aging": {
      "sampled": true,                  // 账龄/明细基于订单样本，非全量
      "sampleSize": 100,
      "totalKnown": 1180,               // 全量订单数（overview.order_count）
      "totalKnownDetail": { "orderCount": 1180, "unpaidOrderCount": 250,
                            "overdueOrderCount": 313, "problemOrderCount": 17,
                            "uncollectedAmount": 3700000.00 },
      "note": "账龄基于前 100 条订单样本，非全量（全量逾期 313 单，见 totalKnownDetail）",
      "rows": [ { "bucket": "30天内", "count": 0, "amount": 0, "note": "该桶无数据" },
                 { "bucket": "31-60天", "count": 0, "amount": 0 },
                 { "bucket": "61-90天", "count": 39, "amount": 237140.00 },
                 { "bucket": "90天以上", "count": 59, "amount": 463880.00 } ]
    },
    "overdue": {
      "sampled": true, "sampleSize": 100, "totalKnown": 1180,
      "totalKnownDetail": { "orderCount": 1180, "unpaidOrderCount": 250,
                            "overdueOrderCount": 313, "problemOrderCount": 17,
                            "uncollectedAmount": 3700000.00 },
      "note": "逾期明细基于前 100 条订单样本，非全量（全量逾期 313 单）",
      "rows": [ { "customerName": "…", "customerCode": "C12345", "memberName": "…", "squad": "…",
                  "amount": 320000, "days": 128, "accountPeriod": 60, "level": "高" } ]
    },
    "aftersale": { "status": "partial", "total": 100, "closed": 71, "rate": 0.71,
                   "avgHours": 2.1327, "avgUpdateHours": 3.5, "avgHoursSamples": 71,
                   "major": 1, "majorBasis": "正文关键词识别（近似口径）",
                   "typeNote": "ERP 售后类型为数字枚举码，未提供码表，原样显示",
                   "note": "售后总量与闭环率基于区间内售后样本",
                   "rows": [ { "saleCode": "…", "goodsCode": "…", "customer": "…",
                              "applicant": "…", "principal": "…", "type": 4, "typeNote": "…",
                              "closed": true, "addTime": "2026-10-23 13:53:03" } ] },
    "problem": { "count": 17, "sampled": false, "sampleSize": null, "totalKnown": 17,
                 "note": "口径：sales_order_collection_analysis.overview.problem_order_count（全量计数，非样本）；ERP 未返回问题单明细列表" }
  },

  "customer": {
    "tiers": { "status": "sampled",
      "sampleSource": "top_customers", "sampleCustomers": 12,
      "rows": [ { "tier": "A", "count": 10, "share": 0.8333, "score": 75.349, "amount": 3600000.00 } ],
      "note": "抽样源为区间成交额 Top N 客户；覆盖区间签约额 27.0%" },
    "repurchase": { "status": "partial",
      "sampleSize": 55,                 // 分母：区间内 orderCount ≥ 1 的客户数
      "excludedNoOrder": 464,           // 区间内无订单记录、被排除的客户数
      "note": "仅统计区间内订单数 ≥ 1 的客户（分母 55 家）；另有 464 家客户区间内无订单记录，不计入复购分档",
      "rows": [ { "bucket": "1-3次", "count": 34, "share": 0.6182 },
                { "bucket": "4-12次", "count": 3, "share": 0.0545 },
                { "bucket": ">12次", "count": 18, "share": 0.3273 } ] },
    "dormant": { "status": "partial", "total": 6, "thresholdDays": 90,
      "sampleSize": 36,                 // 实际参与判定的客户数（有成交记录）
      "sampleTotal": 500,               // customer_analysis 返回的样本总量
      "note": "仅对样本内有成交记录的客户判定沉睡；其余客户无末次订单时间不参与判定，total 不代表全量沉睡客户数",
      "rows": [ { "customerName": "…", "customerCode": "…", "memberName": "…", "lastOrder": "2026-05-11", "days": 167, "amount": 120000 } ] },
    "follow": { "status": "sampled", "overallRate": 0,
      "sampleCustomers": 10,            // 抽样客户数
      "judgedCustomers": 10,            // 实际参与达标判定的客户数
      "note": "跟进达标率基于抽样客户的 visits 记录计算；未达成为真实值（0 也是结论），不因「看起来不好看」改成 null",
      "rows": [ { "tier": "A", "standard": "每周≥1次深度沟通", "customers": 9, "reached": 0, "rate": 0 } ] },
    "newCustomers": { "status": "partial", "count": 24, "prev": 25, "mom": -0.04,
      "sampled": true, "sampleSize": 519, "totalKnown": 519,
      "note": "基于 customer_analysis 样本（limit=500 + 区间）判定新增合作客户",
      "rows": [ { "customerName": "…", "firstDeal": "2026-10-08", "amount": 120000 } ] },
    "top": [ { "customerName": "…", "customerCode": "C00001", "signing": 1200000, "orders": 36, "avg": 33333.33, "share": 0.067 } ]
  },

  "funnel": {
    "stages": [ { "name": "询盘/统筹确认表", "count": 640, "rate": 1, "note": "inquiry_plan_query.metrics.doc_count", "status": "available" },
                { "name": "报价单", "count": 480, "rate": 0.749, "note": "quotation_query.metrics.doc_count", "status": "available" },
                { "name": "签单", "count": 1200, "rate": null, "note": "区间订单总量，与上一段不同源，比值仅作参考", "status": "partial" },
                { "name": "线索/渠道归因", "count": null, "rate": null, "note": "ERP 无线索与渠道来源字段", "status": "unavailable" } ],
    "trend": [ { "period": "2026-01", "inquiry": 280, "quotation": 210, "orders": 480 } ],
    "attribution": { "status": "unavailable", "rows": [], "note": "ERP 无渠道来源字段，9 渠道归因需外部线索系统。" },
    "threeYear": [ { "year": 2026, "inquiry": 19000, "quotation": 14000, "quotationAmount": 58900000.00,
                     "orders": 1200, "newCustomers": 24, "sampled": true, "sampleSize": 519,
                     "note": "新增客户数基于 customer_analysis 样本判定" } ],

    // v1.1.0 新增：询报价明细统计（零新增 MCP 调用，从既有 inquiry/quotation records 派生）
    "quoteStats": {
      "inquiryDocCount": 4200,      // 询价单全量单数（inquiry_plan_query.metrics.doc_count）
      "inquiryRowCount": 100,        // 实际取到的明细行数（上游硬钳 100）
      "quotationDocCount": 2900,    // 报价单全量单数（quotation_query.metrics.doc_count）
      "quotationRowCount": 100,
      "quotationAmount": 58900000.00,// 报价金额全量（用 metrics.amount_total，**不能**用明细行求和）
      "avgQuotationAmount": 4207.14,
      "inquiryToQuotationRate": 0.7372,   // 报价单数 ÷ 询价单数
      "quotationToOrderRate": 0.3985,     // 订单数 ÷ 报价单数
      "pendingInquiryCount": 8,           // 待处理询价（reply_status 0/1/6/7）
      "sampled": true, "sampleSize": 100, "totalKnown": 2900,
      "basis": "sample",
      "sampleAmount": 504394, "sampleShare": 0.0079428,
      "replyStatus": [ { "status": "已答复", "count": 85, "share": 0.85 },
                       { "status": "待处理", "count": 8, "share": 0.08 },
                       { "status": "无方案或已撤销", "count": 7, "share": 0.07 } ],
      "topQuotationCustomers": [ { "name": "…", "amount": 108000, "count": 1,
                                   "share": 0.1383,        // 样本内占比
                                   "shareOfTotal": 0.0010982 } ],  // 全量占比（与 KPI 同分母）
      "topQuotationPrincipals": [ { "name": "…", "amount": 174080, "count": 4,
                                    "share": 0.2487, "shareOfTotal": 0.0019754 } ],
      "recentInquiries": [ { "code": "P202610241340461", "date": "2026-10-24",
                             "customerName": "…", "principalName": "…",
                             "replyStatus": "已完成", "replyStatusCode": 3, "products": 2 } ],
      "recentQuotations": [ { "code": "P20261023104", "date": "2026-10-23",
                              "customerName": "…", "principalName": "…", "amount": 4700,
                              "progress": "默认", "progressCode": 0, "products": 2 } ],
      "note": "TOP10 基于 100 份抽样（占报价总额 0.8%），不是全量 TOP10；样本内排名。"
    }
  },

  "growth": {
    "levels": { "status": "partial", "rows": [ { "level": "A", "count": 46 }, { "level": "B", "count": 491 } ] },
    "newbies": { "status": "partial",
      "rows": [ { "name": "业务员08", "squad": "蛟龙特训营", "dept": "蛟龙特训营",
                  "joinDate": "2026-09-21", "months": 1, "level": "A-1级-E1", "post": "业务咨询经理",
                  "positiveTime": null,
                  "signing": 186500, "signingSource": "ranking",
                  "customers": 4, "orders": 5,
                  "target": 200000, "gap": 13500, "progress": 0.9325,
                  "status": "good" } ],
      "note": "新兵口径（用户 2026-10-26 定义）：业务咨询事业群中尚未转正的在职成员（positive_time 为空，或晚于基准日）。…" },
    "training": { "status": "unavailable", "note": "ERP 无培训场次/参训率/满意度数据源。" }
  },

  "todo": {
    "status": "partial",
    "rows": [ { "id": "t-001", "type": "回款逾期", "level": "高", "customer": "…", "sales": "…", "squad": "…",
                "amount": 320000, "trigger": "2026-10-25", "due": "2026-11-24", "note": "逾期 128 天" } ]
  },

  "matrix": [
    { "metric": "业绩总额 / 完成率", "source": "mcp__erp__total_performance_analysis + sales_performance_ranking", "result": "可用", "status": "可用" },
    { "metric": "订单 ABC 结构", "source": "yx_sale.sale_level（未在订单接口暴露）", "result": "抽样可得", "status": "部分可用" },
    { "metric": "STD 品牌占比", "source": "mcp__std__std_product_info_query + quotation.details", "result": "报价口径可得", "status": "部分可用" },
    { "metric": "9 渠道归因 / 线索量", "source": "ERP 无字段", "result": "不可得", "status": "不可用" }
  ],

  "calls": [ { "tool": "mcp__erp__total_performance_analysis", "label": "总业绩与趋势", "ok": true, "ms": 820, "note": "" } ],
  "warnings": [ "客户档案扫描达到预算上限，仅覆盖 Top 12 客户。" ]
}
```

---

## 5. 指标 → 数据源映射（Host 半必须实现的取数清单）

| 板块 | 工具 | 关键参数 | 取到的关键字段 |
|---|---|---|---|
| 总览 | `mcp__erp__total_performance_analysis` | start_date, end_date, trend=month, top_limit=20 | overview.* / trend[] / top_customers[] / top_members[] |
| 排名 | `mcp__erp__sales_performance_ranking` | start_date, end_date, sort_by=signing_amount, limit=100 | ranking[]: member_name, department_name, signing_amount, collection_amount, target_amount, overdue_order_count, problem_order_count |
| 回款 | `mcp__erp__sales_order_collection_analysis` | start_date, end_date, order_status=all, limit=rowLimit | overview: signing/collection/uncollected_amount, unpaid/partial/overdue/problem 计数；orders[]: customer, member, department, amount, overdue_days, account_period |
| 客户档案 | `mcp__erp__customer_analysis` | start_date, end_date, limit=rowLimit | customers[]: customer_id, customer_name, customer_kind, principal_id, first_deal_time, add_time；sales[]: order_count, total_amount, back_money, last_order_time |
| 客户分档 | `mcp__erp__customer_tier_rating` | customer_name 或 customer_pk | metrics.b_order_share, metrics.amount_12m, rating.tier, rating.total_score, qcc.industry |
| 客户 360 | `mcp__erp__sales_customer_360` | customer_pk | visits[]（跟进记录）, after_sales[], profile.customer_kind |
| 客户基础 | `mcp__erp__customer_info` | customer_pk | customer_kind（终端/全国代理/事业单位…） |
| 报价 | `mcp__erp__quotation_query` | start_date, end_date, view=detail, include_detail=true, limit=rowLimit | metrics.doc_count/amount_total/product_line_count；records[].details[].goods_code/price/number |
| 询盘 | `mcp__erp__inquiry_plan_query` | start_date, end_date, view=detail, include_detail=true, limit=rowLimit | metrics.doc_count/customer_count/product_line_count；records[].reply_status |
| 售后 | `mcp__std__after_sale_management_query` | start_date, end_date, limit | status2（1 已闭环）、type、goods_code、sale_code、add_time |
| STD 判定 | `mcp__std__std_product_info_query` | page_type=**'1'**（字符串）, code=<货号> | code 精确匹配 ⇒ 该货号是 STD 产品 |
| 绩效档位 | `mcp__std__performance_assessment` | year, month | level_distribution[] |
| 员工 | `mcp__std__staff_info` | limit | join_time, level, dep_name, status |

> 工具名必须**完整写全**（`mcp__erp__total_performance_analysis`），不能写 `mcp__erp__total_performance`。

---

## 6. 口径铁律（两半都必须遵守）

1. **比率用 0~1 小数**，不用百分数；金额一律「元」；前端负责换算显示。
2. **取不到就 `null` + note**，绝不用 0 冒充、绝不编造数字、绝不用模拟数据兜底。
3. **完成率自算**：`区间签约额 ÷ 军令状年度目标`（分子分母同源）。**禁止**直接用上游
   `signing_completion_rate`（它的分母是年度目标、分子随区间变化，口径不成立）。
4. **上游两套「业绩」字段不可混用**：`total_performance_analysis.order_total_amount`（接单额）
   与 `sales_performance_ranking.signing_amount`（签约额）语义不同，同一张图里必须标注用了哪一套。
5. **STD 判定**：`std_product_info_query(page_type='1', code=X)` 的返回里 **code 精确等于 X** 才算 STD
   （code 过滤是前缀匹配，会多返回更长的货号）。
   ⚠️ `page_type` 必须是**字符串** `'1'`，传数字 `1` 会被上游 pydantic 校验拒绝
   （`Input should be a valid string`）。
6. **ERP 没有的能力要如实标注**（线索渠道归因、订单级 ABC、订单级货号、培训数据），
   在 `matrix` 里登记，并给出「不可得」的替代口径或空态说明。
7. **部分源失败不整体 reject**：单个工具失败 → 该板块降级 + `warnings` + `calls[].ok=false`。
8. **不落盘 PII**：`sales_customer_360` 的 visits 里含姓名/电话/地址，**只在内存里用**，
   不写进缓存文件；写缓存前扫描手机号/身份证模式，命中就整份不落盘。
   ⚠️ 扫描正则的前后视断言**必须排除小数点**（`(?<![0-9.]) … (?![0-9.])`）：
   只排除数字时，普通浮点数（`0.050261205153015395` / `5330.053140096618`）会被误判成身份证/座机，
   导致 ① 磁盘缓存永远写不进去（6 小时缓存只剩内存那一份，重启 DSH 就要重拉 3~5 分钟）；
   ② 每次都显示一条不实的「含手机号/身份证」告警。真实手机号/座机/身份证仍必须命中
   （selfcheck 第 12 节 5 项行为级断言守住这条）。
9. **抽样必须来自「按成交额排序」的源**：客户分档/ABC/复购/沉睡/跟进的抽样池用
   `total_performance_analysis.top_customers`（真实按区间成交额降序）播种，
   **不能**用 `customer_analysis.data.sales[]`（该数组在带日期区间时只回 ~36 行，
   实测覆盖率仅 1.9%；改用 top_customers 后覆盖率 27.0%）。
   抽样口径一律随数据下发：`sampleSource` / `sampleCustomers` / `sampleSize` / `coverageShare` / `note`。
10. **分母必须说清是谁**：复购分档只统计 `orderCount ≥ 1` 的客户，其余计入 `excludedNoOrder`
    并在 note 中写明；沉睡客户给出 `sampleSize`（参与判定）与 `sampleTotal`（样本总量），
    避免把样本值当全量值。
11. **STD 探测必须串行**：上游 std MCP 服务在**单 session 内串行处理**请求，单条
    `std_product_info_query` 本身要 6~8 秒。实测并发 8 个探测时单次耗时被拉长到 41~55 秒，
    全部超过 `requestTimeoutMs`（30s）被 AbortSignal 掐掉 → STD 占比变成 `null`。
    因此 STD 探测要**逐个 await**，单次超时放宽到 `max(requestTimeoutMs, 60s)`，
    并用 `stdProbeBudgetMs` 墙钟预算给整段封顶（超时的货号按「未知」处理 + 中文告警）。
    探测可**提前启动**与 ERP 侧取数重叠，压缩总耗时。
12. **缓存以「有没有取数失败」为准，不以「有没有告警」为准**：
    判定条件是 `calls[].ok === false` 的条数为 0 → 结果入内存缓存 + 落盘（TTL = `cacheTtlMs`，默认 6 小时）；
    告警（warnings，如「STD 探测达到预算上限」）属于**信息类提示**，随结果一起显示并一起缓存。
    早期版本用「零告警才缓存」，导致本插件恒有 1 条 STD 预算告警 → 缓存永不命中 → 每次进面板重拉 3~5 分钟。
    有取数失败 → 不入缓存，note 写明「本次有 N 个数据源取数失败，结果不完整，未写入缓存」。
    命中缓存时 `meta.cached = true` 且 `meta.cacheUntil = 命中时刻 + TTL`；新算的结果 `meta.cacheUntil = now + TTL`，
    前端据此显示「剩余 X 小时 Y 分」。
13. **新兵 = 尚未转正的业务咨询成员**（用户 2026-10-26 澄清后的口径）：
    **不按 `join_time ∈ 统计区间` 筛人**，而按「当前状态」筛 —— 「未转正」是**状态**、不是**区间事件**，
    所以这张表的**名单不随所选区间增减**；区间只影响业绩 / 客户数的统计口径（入职月数按基准日计算）。
    筛选四步（顺序固定）：
    ① **先判销售序列**。`staff_info` 是全公司花名册（技术/市场/行政都在里面），必须先判定再入表。判定依据（任一命中即为销售）：
       `first_dep_name === '业务咨询事业群'`（`settings.salesFirstDepName` 可配）／
       `dep_name` 或 `second_dep_name` 命中**销售二级部门白名单**。
       白名单 = 固定兜底名单（鲲鹏特战队/猛虎特训营/海豹特战队/战狼特战队/蛟龙特训营/业务咨询事业群）
       ∪ `member_performance_analysis` 中 `first_dep_name === 事业群` 成员的 `dep_name`
       ∪ `sales_performance_ranking.department_name`。
    ② 再剔除 `status === 0`（离职）。
    ③ 再剔除**非销售岗**（`post_name` 不是「业务咨询经理」——销售体系里也挂着企划/推广岗）。
    ④ 最后剔除**已转正**：`positive_time` 有值且 ≤ 基准日 → 已转正；`positive_time` 为空（转正日期未回填）→ 算未转正；
       `positive_time` 晚于基准日（已排期未到期）→ 也算未转正。
    ⚠️ **不要用「`job_no` 以 `YX` 开头」当判据** —— 市场发展部业务员10的 username 也是 `YX90017`（实测），
    早期版本正是因此把 3 个市场/行政人员漏进新兵表；v5 起该规则已删除，`isSalesStaffRow` 只认上面三条。
    新兵业绩用 `job_no ↔ member_performance_analysis.username` 做主键连接（`sales_performance_ranking` **没有 username**，连不上），
    签约额优先取 `ranking.signing_amount`，取不到再退到 `member.order_total_amount`，都取不到填 0 并把 `signingSource` 标成 `'none'`。
    ⚠️ `staff_info.status_name` 是 GBK 误解码乱码（'绂昏亴'/'璇曠敤'），**只能用 `status` 数值**。
14. **AI 对话只能收到 user 角色的历史**：见 §3.4 的实现铁律（assistant 带正文会让 DSH llm 服务抛 `replayState`）。
15. **屏幕显示与导出内容必须一致**：表格单元格的屏幕值和导出值（TSV/CSV）必须来自同一个格式化函数。
    DataTable 约定 `col.render`（屏幕）优先 → `col.text`（导出与屏幕共用）→ 原始值；
    要在同格显示数值+徽章时**必须在 `render` 里两者都渲染**（否则屏幕会被导出值顶掉）。
16. **预警阈值可配置，且生效值必须可见**：阈值**不写死在业务逻辑里**，统一走
    `resolveThresholds(settings.thresholds)`。默认 `THRESHOLD_DEFAULTS` =
    `{ stdShare: 0.6, bShare: 0.4, cShare: 0.15, collectionRate: 0.9, growthDrop: 0.2 }`
    （方案文档口径：STD≥60%、B≥40%、C≤15%、回款目标 90%、降幅红线 20%）。
    - 只写要改的键即可，其余保持默认；
    - **非法值（NaN / 越界 0~1 / 负数）自动回退默认**，不静默变成 0；
    - 派生黄线（目标 ±20% 带宽）按「目标 × 0.8」自动重算，不需要另外配；
    - 生效值随 `meta.thresholds` 下发（带 `source: 'patch' | 'default'`），页面第 10 页签展示。
    - 唯一真相源是 `cordis.patch.yml` 的 `config.thresholds`。
17. **上游脏数据归并要留痕**：`sales_performance_ranking` 里 0 业绩占位成员的 `department_name`
    含坏字节（`"<3 个 U+FFFD 替换字符>狼特战队"`）。归并规则（`metrics.normalizeSquadName`）：
    剥掉替换字符与不可见字符 → 与已知梯队名求**最长公共后缀** → **唯一命中且后缀长度 ≥ 3** 才归并，
    否则保留原名并告警（不猜）。归并记录进 `meta.squadMerges`，并**至少写一条 `warnings`**。
    ⚠️ 归并必须发生在**梯队筛选之前**，否则按正确梯队名筛选会漏掉被归并的成员。
18. **连接器名（工具名前缀）不得写死**：DSH 里 MCP 连接器的「服务器名」每台设备可能不同，
    工具名 = `mcp__<连接器名>__<工具名>`。取数必须走 `config.toolPrefixes`
    （键 `erp`/`std`/`planning`）+ 运行时自动发现/回退，并把**实际用到的前缀**下发到面板
    （页签 10 可见）。前缀试探**必须串行**（上游 std 服务单 session 串行、每条 6~8 秒），
    并受 `requestTimeoutMs` 保护。发现不到时**如实报不可得**，不得静默返回 0 或用假数据填充。
    **自动发现的实现口径（v10 已落地）**：
    - 注册表位置 `<DSH_HOME>/storages/mcp_connector.json`（`tables.connections[*].serverName` / `.url` / `.enabled`）。
      `DSH_HOME` 依次取 `process.env.DSH_HOME` → 由 `DSH_PROFILE_DIR` 上溯两级 → `os.homedir()/.dsh`。
      **只读 serverName/url/enabled，绝不读取 `auth.apiKeyValue` 等凭据字段**。
    - 认领顺序：先按 **url 端口**（8001=erp / 8006=std / 8003=planning），再按 serverName 同名。
    - 前缀优先级：`config.toolPrefixes`（用户配置）> 注册表按端口 > 注册表按名 > 内置默认。
    - 首选前缀不可见（UNKNOWN_TOOL / unknown tool / not found / 不可见 / 不存在）时，
      **依次试兜底前缀**（配置 → 发现 → 默认 → 其它已启用连接器，去重后最多 4 个）；
      **真实错误（抛错或非「工具不可见」的 isError）必须立即停止**，不得继续试探掩盖真实故障。
    - 每个分组最多产出 **2 条**告警，且只对**非可选**分组提示（`planning` 可选，不提示）。
    - 生效前缀与来源写入 `meta.toolPrefixes` / `meta.toolPrefixSource`（`config|discovered|default`）。
19. **未回款额必须归一**：`uncollectedAmount = 签约额 − 已回款额`。上游 `uncollected_amount` 会把**部分回款**订单按全额计入未回款，虚高；
    上游原值另存 `uncollectedAmountUpstream`，两者不等时在 `notes` 写差额，不悄悄覆盖。
20. **逾期天数必须归一**：上游给的是「距账期到期日的天数」，**负数 = 还没到期，不是逾期**。
    负数一律置 `null`，另给布尔 `overdue`（>0 才 true）；取不到时 `overdue` 也给 `null`。
21. **四套口径互不混用**（实体档案）：`periodMetrics` = 所选区间；`lifetime` = 客户全周期；
    `rating.metrics` = 近 12 个月；`benchmark` = 总盘口径。卡片上分别标注，不允许跨口径比较。
22. **同名多主体不猜**：客户名命中多个主体时返回 `resolved.candidates` + `resolved.ambiguous=true`，由用户点选；
    不默认选第一个，也不把多个主体的数加总。
23. **省份绝不靠公司名猜**：解析优先级 = `country===1`（海外）→ 信用代码第 3-4 位省码 → 地址省名前缀 →
    地址地级市表 → `area_name`；都不中落 `uncovered` 并在页面列出。地图结果**只放内存缓存，不落盘**。
24. **PII 红线（实体档案加严）**：电话、座机、邮箱、地址、统一社会信用代码、银行账号、法律代表人、官网、备注
    一律不进 payload、不进缓存；`visits[]` 只保留白名单字段，上游 `visits[].data` 里的
    `recipient_phone` / `recipient_address` 必须剥掉；`customer_info` 拿到的明文地址只用于**当场解析省份**，不外发。
25. **实体档案必须限流**：`detailBudget`（明细条数）、`geoBudgetMs`（墙钟）、`geoMaxRequests`（请求数）三重封顶；
    超预算即停手并在 `warnings` / `completeness` 里写明「取到多少、还差多少、为什么停」。
26. **报价 TOP 榜必须双口径**：样本内排名用 `share`（÷ 样本金额），与 KPI 同分母的占比用 `shareOfTotal`（÷ 全量报价额）；
    块级给 `basis:'sample'` + `sampleAmount` + `sampleShare`，页面必须写明「TOP10 基于 N 份抽样，不是全量 TOP10」。
27. **上游 limit 硬钳 500**：列表类工具传多大 limit 都只回 500 行（同一次响应的 `overview.order_count` 才是真实单数）。
    截断判定一律用 `orders.length < overview.order_count`；确需全量时按日期对半拆窗重查（深度 ≤2），
    并用 `sale_id`/`sale_code` 去重兜住重叠。
28. **订单状态码不猜，但可标注推断**：`saleState` 原样保留 ERP 原始码（数字），
    另给 `saleStateLabel`（1=在途未完成 / 2=已完成）。该映射是**实测推断**而非 ERP 官方码表 ——
    依据：2026-01/04/08 三个月，`sale_state=1` 的 45 单回款率 17.8%、`sale_state=2` 的 260 单回款率 92.3%。
    前端优先显示 `saleStateLabel`，缺失才退回「状态码 N」；`notes` 里必须写明这是经验推断。
29. **配色只取 DSH 设计系统别名，不写死色值**（v1.2.0 起）：所有颜色一律 `var(--令牌, #兜底)`；
    语义令牌必须在 `.esd-root` / `.esdc-root` / `.esd-shell` **三个根选择器上同时声明**
    （只写一个 → 子树 `var()` 解析失败 → SVG 退回黑色）。色板与 ERP 业务工作台（`@local/erp-dashboard`）一致：
    主文字 `label-primary`、次文字 `label-secondary`、弱化 `label-tertiary`、强调 `brand-primary`、
    状态色 `state-error/warn/success/idle-primary`、底色 `bg-base`/`bg-layer-1`/`bg-layer-2`。
    完整映射见 `docs/配色规范.md`。
30. **CSS 结构必须体检**：括号配平 + 关键规则进 CSSOM。顶层一个游离 `}` 会让 Chromium
    把紧跟其后的整条规则当作「无 prelude 的块」**整条丢弃** —— 曾导致 `.esd-root` 根容器规则
    （底色 / 布局 / `color`）失效，表格单元与空态文字全部退回宿主默认黑色。
31. **卡片底用实心层**（`bg-layer-1`），不用半透明白叠层：叠层在不同底色上发灰，且会透出下层内容。
32. **状态标签三件套**：边框 `color-mix(状态色 45%, transparent)` + 文字用**原始状态色** + 底 `color-mix(状态色 12%, transparent)`；
    不允许用浅色变体文字（与参照插件 `.erpdc-rtag` 语义一致）。
33. **STD 占比按签单金额，不按报价金额**（v1.4.0 起）：链条 =
    `product_efficiency_analysis(inventory_shipping).details[]` 给订单↔货号 →
    `sales_order_collection_analysis.orders[]` 给 `sale_code→signing_amount` →
    订单签单额按货号行数**平均分摊** → 逐货号 `std_product_info_query` 精确判定。
    ⚠️ 分摊是近似（单货号订单精确、多货号均摊）；页面必须同时给出回看窗口与覆盖比例。
34. **STD 货号全集不可枚举，只能逐货号精确探测**：`std_product_info_query` 不带 code 时能列目录，
    但 limit 硬顶 500（实测 rows=500 distinct=500 即截断；按 `RM0…RM9` 前缀各查 500，合计 5000 仍不全）。
    **绝不能用「拉到的目录里没有」反推「不是 STD」** —— 曾因此算出 0.00% 的错误结论。
35. **与区间无关的产品属性要单独缓存**：结果缓存按区间失效，但「货号是不是 STD」不会随区间变。
    落盘到 `std-goods-verdicts.json`（TTL 90 天、上限 2 万条、写 `.tmp` 再 `renameSync` 原子替换、
    坏文件当空表），命中缓存**不消耗探测预算**。否则每次都把探测预算烧在同样几十个货号上。
36. **取不到 ≠ 0**：签单口径 STD 在 std 服务不可用时必须 `status='unavailable'` + `stdShare=null` +
    note 明写「占比未知（null），不得按 0% 展示」。**任何情况下都不把「取不到」画成 0%。**

---

## 7. Host 半实现要点（index.js）

- `export const inject = ['tools', 'webServer']`（硬依赖 webServer）
- **不要导出 `Config`**（框架会调 `Config.validate`，会炸）。改成 `export const DEFAULTS = {...}` +
  在 `apply(ctx, config)` 里合并 `config`。
- `apply(ctx, config)`：取 `ctx.get('webServer')`，`ctx.effect(() => webServer.register({...}))`。
- `apply` 整体必须不抛（可选 UI 插件不能阻断 DSH 启动）；所有 `ctx.get()` 都要 try/catch。
- MCP 调用走 `ctx.tools.execute({ callId, name, arguments, signal: AbortSignal.timeout(ms), agent? })`；
  工具按 **agent 作用域**注册，需先试全局再试 `ctx.get('agents').list()` 前 3 个作用域。
- 并行取数：`Promise.allSettled`，全局调用预算 `exhaustiveBudget`（默认 120），
  超预算的板块降级并写 warnings。
- **STD 判定探测单独串行**（见铁律 11）：不要把它放进 `Promise.allSettled` 的并发批次，
  否则上游 std 服务串行排队会把每次调用拖到 41~55 秒，全部超时。
- 结果缓存：`cacheTtlMs`（默认 21600000 = 6 小时），key = `sales|start|end|squad|member`；
  `refresh=true` 跳过缓存。**入缓存的判定是「没有取数失败」（`calls[].ok === false` 为 0 条）**，
  告警属信息类提示、随结果一起缓存（见铁律 12）；并给中文 `cacheNote` + `meta.cacheUntil`。
- 磁盘缓存可选：有则写 `DSH_PROFILE_DIR/cache/erp-sales-dashboard/<hash>.json`，写盘失败降级为纯内存 + warning。
- AI 对话：新增路由 `ai.chat`（见 §3.4），llm 服务用 `ctx.get('llm')`，默认模型用
  `ctx.get('agentDefaultModel').currentSelection()`；**候选对象里绝不放 API key**；
  历史必须 `foldHistoryToUserTurns` 折成 user 角色（否则 DSH llm 服务抛 `replayState` 全候选失败）。
- 额外导出纯函数供自检：`export const metrics = { ratio, clamp01, safeDiv, bucketAging, sumBy, resolveThresholds, normalizeSquadName, ... }`（不要导出 `Config`）。
- **阈值解析**：`export const THRESHOLD_DEFAULTS` + `resolveThresholds(settings.thresholds)`；
  唯一真相源是 `cordis.patch.yml` 的 `config.thresholds`；非法值回退默认；生效值写入 `meta.thresholds`。
- **梯队名归并**：`metrics.normalizeSquadName(raw, knownSquads)` 在**筛选前**对每个 `department_name` 归并，
  记录进 `meta.squadMerges` + 至少一条 `warnings`（见铁律 17）。
- 预警阈值卡片在页签 10 展示 `meta.thresholds`（含 `source`），让阈值可见可查。

## 8. Client 半实现要点（client.js）

- `window.__ModuleLoader__.load({ id: '@local/erp-sales-dashboard', factory(require) { ... } })`
- `PANEL_KEY = 'erp-sales-dashboard'`；`slots.inject('sidebar.panellist', ...)` 注册图标 +
  `slots.inject('main', ...)` 注册主面板。**两处 options 都必须带 `name`**（keyed 槽位也要）。
- 只用 `ctx.get(...)`，全部 try/catch；apply 不抛；不写顶层 `inject`。
- 样式：`document.createElement('style')` 内联注入（带 `data-plugin="erp-sales-dashboard"` 标记），
  `ctx.effect(() => () => el.remove())` 清理。
- **CSS 语义别名必须同时声明在所有根选择器上**（`.esd-root, .esdc-root, .esd-shell`），
  否则 `var()` 解析失败 → SVG fill 变黑（这是 erp-dashboard 踩过的坑）。
- 图表：**手写 SVG**，不引第三方图表库（沿用 `业务咨询销售团队作战看板-2026YTD.html` 的画法）。
- 视觉规范（**v1.2.0 起改为对齐 DSH 设计系统，不再自带金色**，详见 `docs/配色规范.md`）：
  令牌块在 client.js 顶部 CSS 里，全部挂 DSH 别名 + 兜底值，例如
  `--ink:var(--dsw-alias-label-primary,#f9fafb)`、`--muted:var(--dsw-alias-label-tertiary,#adb2b8)`、
  `--card:var(--dsw-alias-bg-layer-1,#232324)`、`--line:var(--dsw-alias-border-l1,#ffffff0f)`、
  状态色 `--red/--amber/--green` = `state-error/warn/success-primary`、中性 `--idle` = `state-idle-primary`。
  卡片底必须是**实心层**（`bg-layer-1`/`bg-layer-2`），不能用半透明白渐变叠在页面底上。
  字体 `"Segoe UI","Microsoft YaHei","PingFang SC",system-ui`，等宽 `ui-monospace,"Consolas"`。
- **悬浮详情浮层**（v1.4.0 新增，用户要求「像 ERP 业务工作台一样，鼠标放上去显示详细信息」）：
  - 实现范式照搬 `D:\DSH-CN\测试空间\erp-dashboard-bundle\client.js` 的 `tipBind` / `TipLayer`，
    换成 `esd-` 前缀：`tipState` / `tipSubs` / `tipEmit` / `tipHide` / `tipShowAt` / `tipRows` /
    `tipAnchor` / `tipBind` / `tipClass` / `shellTipProps` / `TipLayer` / `datumTip`。
  - **模块级单例**，不是每个图各挂一层（否则叠层、收不掉）。`TipLayer` 只渲染一处，
    在 `PanelShell` 根 children 末尾：`h(TipLayer, { key: 'esd-tip-layer' })`。
  - 绑定写法固定为 `Object.assign({ key, className: 'esd-tipable' }, tipBind(content))`
    —— `className` 必须**显式合并** `esd-tipable`，不能让 spread 覆盖掉。
  - `content` 可以是**函数**（每次 hover 现算），这样数据刷新后提示内容自动跟随。
  - 根节点挂 `shellTipProps()`：`onMouseOver` 里若 `target.closest('.esd-tipable')` 为空就 `tipHide`，
    `onMouseLeave` 兜底 —— 元素被卸载时浏览器**不会**补发 mouseleave，只能靠壳层兜底收浮层。
  - 已接入：`BarChart` / `HBarChart` / `FunnelChart` / `DonutChart` / `ShareBar` / KPI 卡 / 图例 /
    迷你条 / 地图省份 / ComboChart 折线点。
  - **原生 `<title>` 一律保留**作无障碍与降级兜底（浮层是增强，不是替代）。
  - 浮层 CSS：`position:fixed; z-index:70; pointer-events:none`（不挡鼠标）+ `background:bg-layer-2`
    + `border:border-l2` + `min-width:150px; max-width:340px`；视口翻边（`BW=300 BH=190 OFF=14`）防溢出。
- 交互：全局筛选（起止日期 / 梯队 / 业务员）+ 刷新；表格支持「复制 TSV」「导出 CSV」；
  每个不可得指标给明确空态文案，不画假图。
- 组件分区（**10 个页签**，v1.1.0 从 8 个扩到 10 个）：
  1. 业绩达成总览（北极星 + 7 KPI + 近 6 月趋势 + 梯队效能 + 个人排名 + 新兵成长
     **+ 业绩效率与回款健康度（客户端派生：客单价走势 / 回款率衰减 pp / 在途未回款累积 / 人员未回款 TOP10）**）
  2. 订单质量与结构（ABC 抽样口径 + STD 品牌占比 + 直销/经销 + 赛道；**v1.3.0 起移除「货号判定明细」表与「Top 产品」整块**）
  3. 回款与售后（回款 KPI + 账龄柱状 + >90 天逾期明细 + 售后闭环）
  4. 客户资产与激活（ABCD 分档 + 复购分档 + 沉睡客户 + 跟进达标率 + 新增客户 + Top 客户）
  5. 获客与转化（漏斗 + 月度走势 + 三年对比 + 渠道归因可得性说明
     **+ 询报价明细统计（7 KPI + 回复状态分布 + 报价额 TOP10 客户/业务员 + 最近询价报价明细）**）
  6. 学习考核与成长（绩效档位 + 新人入职跟踪 + 培训可得性说明）
  7. 订单待办（自动生成待办清单，按类型/等级筛选）
  8. **客户档案**（客户选择器 + 同名主体消歧 + 客户评级卡 + 区间/全周期双口径 + 7 KPI + 档案与授信
     + 月度趋势 + 部门对标 + 生命周期四 Fold + 区间订单明细 + **中国地图 34 省热力图**）
  9. **业务员档案**（成员选择器 + 军令状卡 + 区间业绩 9 KPI + 档案卡 + 同侪对标 + 订单回款明细 + 最近订单）
  10. 数据口径与可得性（matrix 表格 + MCP 调用记录 + 告警）
- **页签 8/9 的取数是「首次进入才请求」**，不是一进面板就发 geo 请求；geo 只在客户档案页签内请求。
  降级：customer.dashboard 失败 → 整页红横幅 + 重试；geo 失败 → **只影响地图卡**，保留上次成功数据。
- **省份明细表必须用 `customers[]` 按 `province` 过滤渲染**，不要用 `provinces[].customerNames`（会被截断到 20 个）。
- **客户档案 / 业务员档案两条路由的字段名是 camelCase**（主 payload 是 snake_case），移植参照实现时**不要照抄它的字段名 bug**
  （erp-dashboard 的 AI 上下文读过 `resolved.department`（实际是 `departmentName`）、`pm.collectionAmount`（不存在）、
  `o.code/o.orderDate/o.amount`（实际是 `saleCode/saleDate/signingAmount`）→ 恒显示「—」）。
- **逾期天数展示**：`overdueDays` 为 null 或 ≤0 → 显示「未逾期」中性色，**不显示负数**；布尔 `overdue` 供着色。
- **筛选下拉字色**：DSH 主界面全局样式给表单控件写了灰色 `-webkit-text-fill-color`，
  所以 `.esd-field select` 与 `select option` 必须**同时**设 `color` 与 `-webkit-text-fill-color`（带 `!important`），
  否则「销售梯队 / 业务员」下拉里的字仍是灰色、难以查看。
- **AI 分析侧栏**（新增，参照 erp-dashboard 的 `AiChat` + `AiColumn`）：
  - 入口按钮放 Toolbar（刷新按钮旁），点击把「当前页签 id + 该页签的 aiContext」交给 `openAi`。
  - 侧栏是**主内容 flex 流内的常规子节点**（不是 fixed 浮层、无蒙层），主内容 `flex:1 1 auto` 自动变窄；
    `.esd-body` 改 flex，主内容包 `.esd-main`（`flex:1 1 auto; min-width:0; overflow:auto`），`.esd-ai-col` 为并列兄弟。
  - 每个点过 AI 按钮的页签**常驻挂载**（display 切换）→ 切页签/关侧栏都不丢对话历史；关闭只 `display:none` 不卸载。
  - 上下文等价性比较要**剔除顶层 `warnings`**（提示性文案不算数据变化），否则切页签回来对话被清空。
  - `ctxSig = useMemo(() => JSON.stringify(ctx), [ctx])` 作依赖；ctx 变化 → 清空对话 + 顶部插 system 提示。
  - 发送失败要**回滚该条 user 消息并把原文放回草稿**；**绝不用 `dangerouslySetInnerHTML`**。
  - 类名一律 `esd-` 前缀（`esd-aichat*` / `esd-ai-col*`）。
  - ⚠️ 本插件的 CSS 是**反引号模板字符串**：模板内注释里禁止出现反引号与 `${`，否则整个文件 SyntaxError。
    自检脚本会 strip 注释，查不出这类问题 → **改完必须对真实文件跑 `node --check client.js`**。

---

## 9. 跨设备安装与 MCP 连接（可移植性契约）

插件要能在**另一台没装过本插件的设备**上装起来并取到数。为此定了下面几条硬约束。

### 9.1 分发件构成

| 交付物 | 作用 |
|---|---|
| `erp-sales-dashboard-plugin-1.0.0.zip` | **给用户拿走的那个包**：安装器 + bundle 副本 + 文档 |
| `erp-sales-dashboard-1.0.0.tgz` | 包内附带的 pnpm 可安装包，供 `dsh plugin … add file:…tgz` 用 |
| `manifest.json` | 包元信息（id、版本、入口、校验、已知边界） |
| `install.mjs / install.ps1 / install.sh` | 安装器（跨平台；`.ps1`/`.sh` 只是转调 `.mjs`） |
| `check-install.*` / `uninstall.*` | 安装后自检 / 卸载 |
| `bundle/` | 插件本体（index.js、client.js、selfcheck.mjs、verify-host.mjs、cordis.patch.yml、locale、icon.svg、docs） |

**分发包内不得出现**：`mcp.endpoints.local.json`（真实 x-api-key）、`*.bak-*` 备份、
`docs/screenshots/`（6MB 截图）、`node_modules/`、`cache/`。打包后必须**逐条目复核**。

### 9.2 安装路径（三条，优先级从高到低）

1. **DSH 原生插件命令**（首选，官方路径）：
   ```bash
   dsh plugin --profile <profile> add file:<绝对路径>/erp-sales-dashboard-1.0.0.tgz
   ```
   事实依据（实测）：`dsh plugin --help` 原文 "manage a profile's plugins by forwarding
   the remaining arguments to pnpm in the profile directory"；该命令会自动把插件装进
   `profiles/<p>/node_modules/@local/erp-sales-dashboard`、把插件 id 追加进 profile
   `package.json` 的 `dsh.profile.bundles`、把 `dependencies` 写成 `file:<tgz>`。
   ⚠️ **它不写 `cordis.patch.yml`** → 安装器在原生模式成功后**必须补写配置块**。
   ⚠️ DSH 读 profile `package.json` 用裸 `JSON.parse`、**不剥 UTF-8 BOM**（带 BOM 直接崩），
   所以调 CLI 之前必须先把 BOM 剥掉（并备份）。
2. **DSH 图形界面**「添加插件」→ 选 tgz / 本地包，走的正是上面那条 pnpm 通路。
3. **手工安装**（兜底，DSH CLI 不可用 / 离线）：复制 bundle 到 `<DSH_HOME>/plugins/erp-sales-dashboard`，
   在 profile `package.json` 登记 `dependencies`（`link:<安装目录绝对路径>`）与 `dsh.profile.bundles`，
   在 `node_modules/@local/` 建 junction（Windows）/ symlink（POSIX），并把配置写进 `cordis.patch.yml`。

安装器行为要求：原生模式失败时**自动回落到手工模式**并说明原因；**全程离线**；
**改前自动备份**被改的两个 profile 文件；**不触碰其它插件**。

### 9.3 安装后要重启 DSH（首次安装）

**首次安装必须重启 DSH** —— 插件要在 DSH 启动时扫描 profile 的 bundle 列表才会被注册。

但**「已装过、之后只是改插件代码」不需要重启**（实测 2026-10-26）：改一下 profile 的
`cordis.patch.yml`（哪怕加一行注释），DSH 会重放补丁并**重新 import 插件代码**，`index.js`
的改动立刻生效。
（`client.js` 是浏览器按需拉的静态文件，刷新页面即生效；`cordis.patch.yml` 的配置由 DSH 热重载。）

### 9.4 MCP 连接前提（两台机器的差异点）

DSH 里 MCP 连接器的「服务器名」每台机器可能不同，工具名形如 `mcp__<连接器名>__<工具名>`。
本插件用到的三组前缀：

| 用途 | 默认前缀 | 服务端口 | 工具 |
|---|---|---|---|
| ERP 业务咨询事业群 | `mcp__erp__` | 8001 | 22 个 |
| STD / 统一分析 | `mcp__std__` | 8006 | 66 个 |
| 统筹 | `mcp__planning__` | 8003 | 若干 |

因此：

- `config.toolPrefixes`（对象，键 `erp`/`std`/`planning`，值为**完整前缀**如 `mcp__erp__`）
  是唯一真相源，写在 profile 的 `cordis.patch.yml` 里；
- 前缀在本机不存在时，Host 半要能**自动发现/回退**（候选：配置值 → 内置默认 → 其它已知候选），
  并把**实际用到的前缀**下发到面板（页签 10「数据口径与可得性」可见），让用户知道自己机器上的连接器名；
- 发现不到时**如实报不可得**，不得静默返回 0；
- **不得把连接器名写死在业务逻辑里**（`index.js` 顶部已有 `TOOL` 常量表，改成按前缀拼接即可）；
- 前缀试探必须**串行**（上游 std 服务单 session 内串行、每条 6~8 秒），并受 `requestTimeoutMs` 保护。

**直连兜底**（不依赖 DSH 连接器注册，适用于「这台机器还没配 MCP 连接器」的情况）：
`verify-host.mjs` 支持直连模式，端点与凭据按以下优先级解析：
环境变量 `ERP_MCP_URL`/`ERP_MCP_KEY`、`STD_MCP_URL`/`STD_MCP_KEY`、`PLANNING_MCP_URL`/`PLANNING_MCP_KEY`
→ 同目录 `mcp.endpoints.local.json` → 同目录 `mcp.endpoints.json`。
端点与凭据一律**不随包、不随仓库分发**（既不提供模板文件，也不写入任何交付文档）；
目标机器上的开发者自行按上面的优先级准备（环境变量或自建 `mcp.endpoints.local.json`）。

### 9.5 其它运行前提

- **首次取数约 4~5 分钟**（80+ 次 MCP 调用；其中 STD 探测必须串行，见铁律 11）；
  之后命中 6 小时缓存，秒开。
- DSH 里必须**先连上** ERP / STD 两个 MCP 连接器，否则所有板块都取不到数。
- 需要 `node` 运行时：安装器是 `.mjs`，要 Node ≥ 18；没有 Node 的机器请用
  DSH 自带运行时（`<应用根>/resources/runtime/`）。
