# @local/erp-sales-dashboard —— ERP 销售仪表盘（DSH 插件）

> 本插件是 **ERP 业务工作台**（`@local/erp-dashboard`）的**销售线延伸版**：
> 复用其架构（Host 半 `index.js` + Client 半 `client.js`）、数据口径纪律与**深色中性视觉语言**
> （v1.2.0 起配色整体对齐 DSH 设计系统，见「二·七、配色系统」），
> 但**另起一套指标体系与页面结构**，专门实现《业绩经营数据看板思路 1025》《业务咨询销售团队数据看板方案 1025》
> 《全军作战数据看板（完整版 1025）》《销售部门经营数据看板 1025》四份文档提出的销售管理需求，
> 并以《业务咨询销售团队作战看板-2026YTD.html》的**真实 ERP 数值**作为验收基准。

---

## 一、它与「ERP 业务工作台」的关系

| 维度 | ERP 业务工作台 `@local/erp-dashboard` | 本插件 `@local/erp-sales-dashboard` |
|---|---|---|
| 定位 | 全公司经营总览（订单/回款/成员/客户四块） | **销售管理决策台**（梯队、目标、订单质量、获客、待办） |
| 核心问题 | 「现在生意怎么样？」 | 「我干得好不好？我今天该干什么？客户怎么样？新客户从哪来？我在哪个阶段？」 |
| 指标口径 | 接单额、回款额、订单数、客户数 | 业绩总额双口径、完成率自算、ABC 加权、STD 占比、ABCD 分档、获客漏斗、跟进达标、待办闭环 |
| 页面结构 | 概览 + 成员 + 客户 + 订单 | 10 个页签（见下） |
| 复用 | — | 架构 / 路由 / 解包 / 缓存 / 降级 / 视觉语言 全部对齐 |

**不重复造轮子**：两个插件可同时挂在侧栏，共用同一套 ERP MCP 工具与同一把 API Key。

---

## 一·五、v1.4.0 本版改动（2026-11-04）

三件事，按用户诉求排序：

### 1. STD 品牌占比：改「签单金额」口径 + 缩到合适尺寸

- **口径**：`出库明细（product_efficiency_analysis.inventory_shipping）` 给出「订单↔货号」→
  同期订单的签单额**按货号行数平均分摊** → 逐货号查 STD 产品表精确判定 → 汇总 STD / 非 STD 签单额。
  不再用报价单金额（报价只是意向，签单才是收入）。旧报价口径作为对照保留在 `quoteAmount` / `stdAmount`。
- **尺寸**：`.esd-svg{width:100%}` 会把环图拉满整张卡 → 环图改 `size:168` 并给内联 px 尺寸，
  右侧改成 5 行数值明细（每行带悬浮详情）。
- **新增货号判定缓存** `std-goods-verdicts.json`（TTL 90 天）：货号是不是 STD 与区间无关，
  命中缓存不消耗探测预算，第二次打开面板从分钟级降到秒级。
- **卡点分档**：`quality.std.blockedAt` = `shipping` / `probe` / `no-goods` / `null`，
  分别对应「出库明细取不到」「货号判定全失败」「窗口内没货号」。**任何情况下 `stdShare` 为 null 都不渲染 0%。**

### 2. 所有分析图表加「鼠标悬浮详细信息」浮层

- 照搬 ERP 业务工作台的 `tipBind` / `TipLayer` 范式（模块级单例浮层 + 函数式内容 + 视口翻边 + 壳层兜底收起）。
- 覆盖：柱图 / 横条 / 漏斗 / 环图 / 叠条 / **KPI 卡** / **图例** / **迷你条** / **中国地图省份** / **折线点**。
- 原生 `<title>` 一律保留作无障碍兜底。详见「二·七、配色系统」之后的悬浮提示说明与 `CONTRACT.md` §8。

### 3. 按只读审计报告修复 24 条逻辑缺陷

| 级别 | 修复 |
|---|---|
| P0 | 业务员档案「在途未回款」曾把**回款额**当未回款额（页签 9 显示的是已回款）→ 改走统一归一函数 |
| P0 | 客户档案四张生命周期表从顶层取数而 Host 挂在 `lifecycle.*` 下 → 恒空，同屏计数却有数字，自相矛盾 |
| P1 | 客户数曾用「各成员客户数的不同取值个数」当客户数 → 改三口径（erp-overview / dedup / member-sum）+ basis 标注 |
| P1 | 未回款额：主看板与客户档案两套口径 → 主 KPI 用 ERP overview 值（与业务工作台一致）并另存归一值，明细与档案用「签约−回款」归一 |
| P1 | 账龄/逾期明细金额用上游虚高值 → 归一 + 回落条数写进 note |
| P1 | 生命周期阶段算了没下发（`deriveCustomerStage`）→ 补 `stage` 等 5 字段 |
| P1 | 售后曾是 `closed = (status2===1)`，缺状态即判未闭环 → 三态 `closed/open/unknown`，闭环率分母只用 `knownState` |
| P2 | 负值柱图消失、横条未 clamp、三年转化率把 0 当无数据、`unavailable` 英文直显、`signingGap` 假缺口、Top 客户占比分母不明、地图未读 `meta.truncated` 等 15 条 |

回归保护：`selfcheck.mjs` 从 148 项 → **171 项**（新增纯函数用例 + 行为级断言 + matrix 文案断言）。

---

## 二、十个页签（对应需求文档章节）

| # | 页签 | 对应文档 | 主要内容 |
|---|---|---|---|
| 1 | 业绩总览 | 方案 02 (1/4)(2/4) | 7 大 KPI（业绩总额/STD 占比/B 类占比/C 类占比/新增合作客户/回款率/复购率）、年度累计 + 当月累计双口径、12 个月走势、各梯队效能、个人排名、新兵转正进度、**业绩效率与回款健康度（客户端派生：客单价走势 / 回款率衰减 pp / 在途未回款累积 / 人员未回款 TOP10）** |
| 2 | 订单质量 | 方案 02 (3/4) | A/B/C 订单结构与占比、**加权业绩模型**（1×A + 1.2×B + 0.5×C，系数可配）、STD 品牌订单月度趋势、赛道/直销-经销模式拆分 |
| 3 | 回款售后 | 方案 02 (4/4) | 回款率与账龄（30/31-60/61-90/>90 天）、超 90 天逾期明细、售后投诉闭环率与平均处理时长、问题单 |
| 4 | 客户分级 | 方案 03 (1/2)(2/2) | ABCD 四级分档（营收占比/复购率）、客户价值跃迁路径、沉睡客户预警、A/B/C 跟进达标率 |
| 5 | 获客转化 | 方案 04 | 线索→有效→高价值→询盘→报价→签单 全链路漏斗、转化率趋势、询盘/报价量三年对比、**询报价明细统计（询价/报价单量与金额、询价→报价 / 报价→订单转化率、待回复询价数、回复状态分布、报价额 TOP10 客户与业务员、最近 40 条询价/报价明细）** |
| 6 | 学习成长 | 方案 05 | 绩效档位分布、**新兵成长跟踪**（新兵 = 尚未转正的业务咨询成员：入职时长 / 层级 / 区间业绩 / 距转正门槛 / 转正进度）、培训与考核通过率 |
| 7 | 订单待办 | 方案 06 | 待跟进/回款逾期/待报价/售后待处理/开票提醒 六类待办，按等级/销售/到期排序 |
| 8 | **客户档案** | 业务工作台「客户分析」 | **单客户 360**：同名主体消歧、客户评级卡（规则版本/得分/11 项明细/升降级与否决规则）、区间 vs 全周期双口径对比、7 项经营 KPI、档案与授信、月度趋势、部门对标与排名、生命周期四 Fold（拜访/询价/报价/售后）、区间订单明细、**客户省份地图**（34 省热力图 + 色阶图例 + 点击省份展开客户明细 + 覆盖率/海外/未识别清单） |
| 9 | **业务员档案** | 业务工作台「业务员分析」 | **单业务员 360**：军令状卡（年度目标/自算年度完成率/双 Meter）、区间业绩 9 KPI、档案卡、**同侪对标**（公司/梯队排名、梯队均值对比、peer 明细）、订单回款明细、最近订单 |
| 10 | 口径与数据 | 全文 | 指标→ERP 字段映射、每个数字的来源工具与调用记录、**数据可得性矩阵**（哪些指标 ERP 给不了、为什么） |

> **v1.3.0 页签调整**（用户 2026-11-04 要求）：① 页签 2「订单质量与结构」移除**货号判定明细**表与 **Top 产品**整块；
> ② **「数据口径与可得性」移到最末尾（页签 10）**，客户档案 / 业务员档案前移为页签 8 / 9。
> Host 半仍计算 `quality.goods` 与 `std.rows`（复用已拉到的报价明细，**不增加任何 MCP 调用**），只是前端不再展示。

> 页签 8/9 与页签 1/5 的新增区块对应用户 2026-11-03 的要求：「借鉴 ERP 业务工作台的**业绩分析 / 客户分析 / 业务员分析**三个板块内容，补充到 ERP 销售仪表盘，重复的统计保留，没有的就加入进来」。
> 落法：**实体下钻能力（客户档案 / 业务员档案 / 省份地图）新增两个页签**；**业绩分析独有的询报价明细统计并入页签 5**；
> **回款率衰减 / 在途累积 / 客单价走势 / 人员未回款 TOP10 并入页签 1**。后两类**零新增 MCP 调用**（全部由已取到的数据派生），不增加加载时间。

> **原则**：任何在 ERP 里取不到、或只有样本没有全量的指标，一律**如实标注**（样本量、覆盖率、抽样方式），
> 不用模拟值冒充真实值。方案文档里的示例数字（1250万、1380w、93% 等）**不是真实数据**，插件一律以 ERP 实测为准。

---

## 二·五、AI 分析侧栏（参照「ERP 业务工作台」的 AI 对话）

每个页签的右上角有 **「AI 分析」** 按钮，点开后**主内容右侧并排滑出对话侧栏**（不是全屏浮层、不遮蒙层；
主内容 `flex:1 1 auto` 自动变窄）。侧栏可逐页签打开、可多轮追问。

| 环节 | 实现 |
|---|---|
| 入口 | Toolbar 刷新按钮旁的「AI 分析」按钮（`.esd-btn`），未取到数据时禁用 |
| 请求 | `POST /erp-sales-dashboard/api/ai.chat`，体 `{ payload: { title, aiContext }, messages, question }`；响应 `{ ok, text, model, failures }` |
| 上下文 | `buildAiContext(tabId, data)` **只喂当前页签那一块** + `period` + `filters`；aiContext 截 12000 字符；history 只留末尾 12 条、assistant 截 1500 字 |
| 模型 | 候选优先级 `config.aiProvider/aiModel` → `ctx.get('agentDefaultModel').currentSelection()` → 注册表里 minimax 首个模型 → 其它 provider 首个模型；**候选只带 provider/model，绝不落 API key** |
| 角色 | 严谨的企业经营数据分析师；**所有数字必须来自 JSON**，缺失口径就直说不可得；只答当前板块，越界就回「当前只加载了本板块数据，无法回答」；中文 Markdown、先结论后依据、6 行以内 |
| 历史折叠 | **历史必须折成只用 user 角色**（`foldHistoryToUserTurns`：把「问/答」成对折成一条 `问：…\n答：…`）。原因：DSH llm 服务收到**带正文的 assistant 消息**会抛 `Cannot read properties of undefined (reading 'replayState')`，全候选失败 → 500；实测空 assistant / 无 content 字段 / 连续两条 user 都正常 |
| 交互 | Enter 发送、Shift+Enter 换行；发送中显示「思考中…」并禁用发送；**失败时回滚该条 user 消息并把原文放回草稿**；正文纯文本渲染（`white-space:pre-wrap`），**绝不用 dangerouslySetInnerHTML** |
| 上下文变化 | `ctxSig = useMemo(JSON.stringify(ctx), [ctx])`；ctx 变了 → 清空对话并在顶部插入系统提示「数据已更新（X），下面的对话基于最新数据。」 |
| 侧栏形态 | 每个打开过的页签**常驻挂载**（display 切换）→ 切走再切回对话不丢；关闭只 `display:none` 不卸载；窄屏（≤900px）改为上下排列（宽 100%、高 46%） |

> **能力边界**：AI 只能看到**当前页签**已取到的数据，且是**抽样口径**的指标（ABC 结构、客户分档、复购分布、沉睡、跟进）。
> 它可以帮你解读和追问，但**不能**回答 ERP 没取到的指标，也不能替代口径说明。

---

## 二·六、实体档案三条新路由（页签 8 / 9）

页签 8/9 的数据来自 Host 半的三条独立路由（**不塞进主 payload**，避免主看板变慢变大）：

| 路由 | 请求体 | 关键返回 |
|---|---|---|
| `POST /erp-sales-dashboard/api/customer.dashboard` | `{ name, startDate, endDate, refresh }` | `resolved`（消歧候选 `candidates` / `ambiguous`）、`profile`、`periodMetrics`（区间）、`lifetime`（全周期）、`rating`（评级规则版本/得分/11 项 breakdown）、`lifecycle`（monthlyTrend/visits/inquiries/quotations/afterSales/counts）、`benchmark`（总盘排名）、`orders[]`、`notes[]`、`warnings[]`、`calls[]` |
| `POST /erp-sales-dashboard/api/member.dashboard` | `{ memberId, memberName, startDate, endDate, refresh }` | `resolved`、`profile`、`periodMetrics`（16 项）、`target`（**年度口径自算**的完成率，允许 >100%）、`benchmark`（公司/梯队对标 + peers）、`collection`（overview + orders[]）、`recentOrders[]`、`notes[]`、`warnings[]`、`calls[]` |
| `POST /erp-sales-dashboard/api/customer.geo` | `{ startDate, endDate, scope: 'period' \| 'all', refresh }` | `summary`（总数/已定位/未识别/海外/覆盖率/省份数）、`provinces[]`（省份→客户数/签约额/订单数/来源）、`customers[]`（全量明细）、`uncovered[]`、`overseas[]`、`completeness[]`、`meta`（请求数/是否截断） |

**关键设计**：
- **四套口径互不混用**：`periodMetrics` = 所选区间；`lifetime` = 客户全周期；`rating.metrics` = 近 12 个月；`benchmark` = 总盘口径。卡片上分别标注，不允许混着比。
- **省份绝不靠公司名猜**：解析优先级 = `country===1`（海外）→ 统一社会信用代码第 3-4 位省码 → 地址省名前缀 → 地址地级市表 → `area_name` → 都不中就进 `uncovered` 并在页面上列出。
- **PII 红线**：电话、座机、邮箱、地址、统一社会信用代码、银行账号、法律代表人、官网 **一律不进 payload、不进缓存**；档案卡只留业务字段，页面上的「档案」不含联系方式。
- **同名多主体不猜**：客户名命中多个主体时返回 `candidates` + `ambiguous=true`，由用户在页面上点选，不默认选第一个。
- **地图纯内存缓存**：不落盘（与主看板 6 小时磁盘缓存是两套）。
- **降级**：单工具失败不 reject，退化出数 + `warnings`；geo 失败**只影响地图卡**，页签其余部分照常。

---

## 二·七、配色系统（v1.2.0 起对齐 DSH 设计系统）

> 依据用户诉求：「颜色还需要重新调整，主要调整颜色，你参照 ERP 业务工作台的 字体颜色来搭配处理」。
> 完整规范见 `docs/配色规范.md`。

**本插件不再有自己的配色**，颜色全部取自 DSH 设计系统别名（`--dsw-alias-*`），
与 ERP 业务工作台（`@local/erp-dashboard` `client.js:124-141` 的 `--e-*` 令牌块）**同一套色板**：
中性灰阶 + 近白强调色，状态色只用于红/绿/橙。

| 语义 | 本插件变量 | DSH 别名 | 深色主题实际值 |
|---|---|---|---|
| 主文字 | `--ink` | `label-primary` | `#f9fafb` |
| 次级文字（副标题/卡注/KPI label/图例/轴/表头/提示） | `--ink-2` | `label-secondary` | `#cfd3d6` |
| 三级弱化（空态/附注/AI 署名） | `--muted` | `label-tertiary` | `#adb2b8` |
| 强调（选中/主序列/focus） | `--gold` / `--gold-l` | `brand-primary` | `#f9fafb` |
| 对比序列 | `--blue` | `color-mix(brand-primary 55%, label-secondary)` | `#b8babe` |
| 页面底 / 卡片底 / 次级容器底 | `--navy-950` / `--navy-900` / `--navy-850` | `bg-base` / `bg-layer-1` / `bg-layer-2` | `#151517` / `#232324` / `#2c2c2e` |
| 主描边 / 次描边 | `--line` / `--line-soft` | `border-l2` / `border-l1` | `#ffffff1f` / `#ffffff0f` |
| 超限 / 预警 / 达标 / 无数据 | `--red` / `--amber` / `--green` / `--idle` | `state-error/warn/success/idle-primary` | `#f25a5a` / `#f59e0b` / `#22c55e` / `#545557` |
| 地图 6 档色阶 | `--esd-geo-lv0..lv5` | `color-mix(brand-primary 32/45/58/71/84%, bg-layer-2)` | — |

**规则**：
- 颜色一律 `var(--令牌, #兜底)`，CSS/JS 里**不再出现写死的 rgba/hex**；别名缺失时靠兜底值退化。
- 状态标签三件套：边框 `color-mix(状态色 45%, transparent)` + 文字原始状态色 + 底 `color-mix(状态色 12%, transparent)`。
- 卡片一律**实心底**（`bg-layer-1`），不再用半透明白叠层（在不同底色上会发灰）。
- 语义令牌必须**同时声明在 `.esd-root / .esdc-root / .esd-shell` 三个根选择器**上，否则子树 `var()` 解析失败 → SVG 退回黑色。
- 改动配色后必须做 **CSS 结构体检**（括号配平 + 关键规则进 CSSOM）：顶层一个游离 `}` 会让 Chromium
  把紧跟其后的整条规则当作「无 prelude 的块」**整条丢弃** —— v1.2.0 开发期就因此让 `.esd-root`
  根容器规则（底色/布局/`color`）失效，表格单元与空态文字全部退回宿主默认黑色。

---

## 三、目录结构

```
erp-sales-dashboard-bundle/
├── package.json          # DSH 插件清单（bundle + client 双半包）
├── cordis.patch.yml      # 插件自带的配置补丁（被 profile patch 覆盖时以此为底）
├── index.js              # Host 半：取数编排 + 口径计算 + HTTP 路由
├── client.js             # Client 半：React 面板 + 手写 SVG 图表 + 深色中性视觉（配色取 DSH 设计系统）
├── selfcheck.mjs         # 自检：静态体检（不连 ERP）
├── verify-host.mjs       # 端到端验证：裸 MCP JSON-RPC 复刻 ctx.tools.execute
├── lib/mini-yaml.mjs     # 零依赖 YAML 读写（profile patch 编辑用）
# 注：MCP 端点/凭据文件（mcp.endpoints.*.json）**不随本仓库分发**
├── locale/zh.json        # 中文词典
├── locale/en.json        # 英文词典
├── icon.svg              # 侧栏图标
├── CONTRACT.md           # **唯一事实源**：HTTP 契约、响应 JSON schema、口径铁律
└── docs/
    ├── 数据口径与准确性保障说明.md   # 口径圣经：每个指标怎么算、为什么这么算
    ├── 需求覆盖矩阵.md               # 需求文档 → 页签/字段的覆盖与缺口对照
    ├── 配色规范.md                   # v1.2.0 配色：令牌映射表、语义规则、工程铁律、验收方法
    └── screenshots/                 # 10 个页签 + AI 侧栏的实拍截图
```

---

## 四、安装

### 4.1 【推荐】装到另一台设备：用「安装包」

分发件是 `erp-sales-dashboard-plugin-1.2.0.zip`（由 `erp-sales-dashboard-plugin\pack.mjs` 生成）。解压后：

```powershell
# Windows（PowerShell 5.1 与 7+ 都可以）
.\install.ps1                          # 装到 ~/.dsh/profiles/desktop
.\install.ps1 -Profile desktop         # 指定 profile
.\check-install.ps1                    # 装完自检，逐条打印 ✔ / ✘
.\uninstall.ps1                        # 卸载
```

```bash
# macOS / Linux
./install.sh
./check-install.sh
./uninstall.sh
```

安装脚本做四件事（与 §4.2 的手工步骤一一对应）：把插件文件复制到 `<DSH_HOME>/plugins/erp-sales-dashboard`；在 profile 的 `package.json` 里登记依赖与 `dsh.profile.bundles`；在 `node_modules/@local/erp-sales-dashboard` 建链接（Windows 用 junction，POSIX 用 symlink）；把配置写进 profile 的 `cordis.patch.yml`。**全程离线、不触碰其它插件、每次改前自动备份被改的两个文件。**

装完 **必须重启 DSH**（bundle 在 DSH 启动时扫描）。卸载用 `uninstall.ps1` / `uninstall.sh`，加 `--purge` 会连插件目录一起删。

> **换设备前必看**：DSH 里 MCP 连接器的「服务器名」每台机器可能不同，工具名形如 `mcp__<连接器名>__<工具名>`。
> 本插件支持 `toolPrefixes` 配置 + 运行时自动发现：配置的前缀在这台机器上不存在时，插件会自动尝试其它前缀，
> 并在面板「数据口径与可得性」页签给出实际用到的连接器名。仍不生效时，在 profile 的 `cordis.patch.yml` 里写死：
>
> ```yaml
> toolPrefixes:
>   erp: 'mcp__erp-cn__'
>   std: 'mcp__std__'
>   planning: 'mcp__planning__'
> ```

### 4.2 手工安装（开发机 / 排查用）

插件以 **junction 链接**方式装进 DSH profile：

```powershell
# 1) 依赖登记
#    C:\Users\PC\.dsh\profiles\desktop\package.json
#      dependencies: "@local/erp-sales-dashboard": "link:D:/path/to/erp-sales-dashboard-bundle"
#      dsh.profile.bundles: 追加 "@local/erp-sales-dashboard"
# 2) 建立 junction
New-Item -ItemType Junction `
  -Path 'C:\Users\PC\.dsh\profiles\desktop\node_modules\@local\erp-sales-dashboard' `
  -Target 'D:/path/to/erp-sales-dashboard-bundle'
# 3) profile 补丁（config 覆盖插件默认值）
#    C:\Users\PC\.dsh\profiles\desktop\cordis.patch.yml
#      - id: erp-sales-dashboard
#        name: "@local/erp-sales-dashboard"
#        config: { cacheTtlMs: 21600000, requestTimeoutMs: 30000, rowLimit: 100, ... }
# 4) **重启 DSH**（bundle 在启动时扫描）
#    —— 或者：改一下本文件（profile 的 cordis.patch.yml，哪怕加一行注释），
#       DSH 会重放补丁并重新 import 插件代码，index.js 的改动同样生效。
```

配置项：

| key | 默认 | 含义 |
|---|---|---|
| `cacheTtlMs` | 21600000（6h） | 结果缓存时长，0 = 不缓存 |
| `requestTimeoutMs` | 30000 | 单次 MCP 调用超时 |
| `rowLimit` | 100 | 列表类工具的取数上限（服务端硬钳 500） |
| `stdProbeBudget` | 150 | STD 品牌判定最多探测多少个货号（按**签单额**降序逐个精确探测；命中货号判定缓存的**不占**这个额度） |
| `stdProbeBudgetMs` | 90000 | STD 探测阶段的**墙钟预算**（上游 std 服务单条查询 6~8 秒且单 session 内串行，探测必须串行；本预算给整段封顶，超时货号按「未知」处理） |
| `stdSigningMonthsMax` | 4 | 签单口径 STD 占比**从区间末月往前最多回看几个月**。出库明细单次硬顶 500 行（一个月 700+ 行），取满整个区间要 20 次调用、近两分钟，首屏扛不住 → 按「近 N 个月」算，覆盖窗口与比例写进 `std.note` |
| `stdSigningShipBudgetMs` | 45000 | 出库明细（订单↔货号）取数的**墙钟预算**；到点停手，已取到的部分照样参与计算 |
| `tierSampleSize` | 12 | 客户分档抽样个数（分档接口不支持批量，只能逐客户调） |
| `customerSampleSize` | 12 | 客户基础档案抽样个数 |
| `visitSampleSize` | 10 | 拜访/跟进记录抽样深度（`sales_customer_360` 逐客户调用） |
| `exhaustiveBudget` | 120 | 单板块穷尽式读取的调用次数硬上限 |
| `detailBudget` | 40 | 实体档案（客户/业务员）单次查询最多展开多少条明细（订单/询价/报价/售后） |
| `geoBudgetMs` | 300000 | 客户省份地图的**墙钟预算**（默认 5 分钟）。地图要逐个业务员分区扫客户档案，调用量大 |
| `geoMaxRequests` | 300 | 客户省份地图最多发多少次上游请求（含订单分片）。超预算即停手并在 `warnings` 里写明 |
| `salesFirstDepName` | 业务咨询事业群 | 判定「销售序列」的准一线（`staff_info.first_dep_name`）；新兵表只统计**这个事业群里尚未转正**的在职成员 |
| `newbieTargetAmount` | 200000 | 新兵转正门槛（元），用于「距转正差额」与「转正进度」 |
| `aiProvider` | null | AI 对话用的 provider id（留空 = 自动挑：settings → agentDefaultModel → 注册表 minimax → 其它） |
| `aiModel` | null | AI 对话用的 model id（留空 = 用该 provider 首个模型） |
| `thresholds` | `{}` | **智能预警阈值覆盖**（方案 01「三大能力」之二：红黄绿三色 + 自定义预警阈值）。只写要改的键即可，其余保持默认；非法值（NaN / 越界 0~1 / 负数）自动回退默认。可调：`stdShare` 0.6、`bShare` 0.4、`cShare` 0.15、`collectionRate` 0.9、`growthDrop` 0.2。派生黄线自动按目标 × 0.8 重算 |
| `toolPrefixes` | `{}`（留空 = 自动发现） | **MCP 工具名前缀**（= DSH 连接器的「服务器名」）。DSH 里工具全名 = `mcp__<连接器名>__<工具名>`，连接器名每台设备自己起，所以**不能写死**。留空时插件启动会读 DSH 的连接器注册表 `<DSH_HOME>/storages/mcp_connector.json`，**按 url 端口认领**（8001=erp / 8006=std / 8003=planning），认领结果下发到面板页签 10。只有当本机连接器**既不是默认名、端口也不是默认端口**时，才需要在这里显式写：`toolPrefixes: { erp: 'mcp__erp-cn__' }`。首选前缀取不到时会自动试兜底前缀；**真实报错会立即停下**，不会用试错掩盖故障。 |

### 4.3 换设备时最容易踩的三个坑

1. **MCP 连接器没连上** —— 插件拿不到 ERP 数据，面板会大面积显示「不可得」。
   先在 DSH 里把 ERP（8001）、STD（8006）两个连接器连上并启用；统筹（8003）是可选的。
   连接器的**服务器名随便起**，插件会自动认领；面板页签 10 会显示「本机连接器」实际用的是哪个名字。
2. **连接器端口不是默认端口** —— 端口认领失败就退回内置默认名，如果本机连接器也不叫 `erp`，
   按页签 10 的提示在 `cordis.patch.yml` 里写 `toolPrefixes`。首次安装需要重启 DSH；已装过之后改这一行即可触发热重载（实测：DSH 会在补丁层变化时重新 import 插件代码）。
3. **`index.js` 是启动期加载的** —— 改完插件代码必须**重启 DSH**；
   `client.js` 刷新页面即生效；`cordis.patch.yml` 改了会自动热重载。

> **首次加载耗时**：本插件一次完整取数约 80 次 MCP 调用（分档 / 客户档案 / 拜访 / STD 货号探测是逐个串行调用的），
> 真机实测 **约 4~5 分钟**（其中 STD 探测单独占 2~3 分钟）。结果按 `cacheTtlMs`（6 小时）缓存，第二次打开是秒开。
> 需要更快就调小 `stdProbeBudget` / `tierSampleSize`（代价是 STD 覆盖率与 ABC 抽样代表性下降）。
>
> **为什么 STD 探测必须串行**：上游 std MCP 服务在**单 session 内串行处理**请求，单条 `std_product_info_query`
> 本身就要 6~8 秒。实测并发 8 个探测时，单次耗时被拉长到 41~55 秒，全部超过 `requestTimeoutMs`（30s）被掐掉，
> 结果是 STD 占比直接变成 `null`。因此 v4 起 STD 探测改为**串行 + 单次放宽到 60s + 墙钟封顶**，
> 并且**提前启动**与 ERP 侧取数重叠，压缩总耗时。
>
> **让改动生效（重要，v7 实测，v9 二次确认）**：
> - `client.js`（Client 半）是浏览器按需拉取的静态文件 → **刷新页面即可生效**；
> - `cordis.patch.yml` 里的配置项由 DSH 热重载 → **无需重启**；
> - `index.js`（Host 半）由 DSH 在**加载插件时** import 一次并缓存。**单纯改 `index.js` 不会自动重新加载**
>   （2026-10-26 实测：改完 index.js 后真机响应仍是旧行为 —— 旧版 PII 误判告警仍在，
>   而更早加入的 `meta.thresholds` 已在，说明它是「上一次重新加载时」的快照）。
>   让新代码生效有两种办法：
>   1. **重启 DSH**（最稳，推荐）；
>   2. **改一下 profile 的 `cordis.patch.yml`**（哪怕只加一行注释）→ DSH 重放补丁并**重新 import 插件代码**
>      → 2026-10-26 v7 就是用这个办法把 PII 修复与坏字节归并推上真机的。
>
>   **v9 二次确认（2026-10-26 15:2x，探针路由实测）**：往 `index.js` 里临时加一条 `POST /api/buildtag` 路由，
>   只改 `index.js` 不动补丁 → 真机请求返回 **404 旧路由表**；随后只在 profile 的 `cordis.patch.yml` 末尾
>   加一行注释 → 真机立刻返回 **200 + 新路由**。结论：**DSH 不监视 bundle 文件，但会在补丁层变化时重新 import 插件代码**。
>   （探测路由已删除，profile 补丁里的探针注释也已移除；改补丁时注意保持 UTF-8 无 BOM。）

---

## 五、验证

```powershell
# 端到端：真的连 ERP、真的跑 apply()、真的出数
node 'D:/path/to/erp-sales-dashboard-bundle/verify-host.mjs' 2026-01-01 2026-10-25

# 静态自检
node 'D:/path/to/erp-sales-dashboard-bundle/selfcheck.mjs'

# 实体档案三条路由的端到端验证（客户档案 / 业务员档案 / 省份地图 + PII 体检）
node '<工作目录>/_analysis/_verify_detail_routes.mjs'
```

`verify-host.mjs` 会：
1. 用裸 JSON-RPC 建 MCP session（ERP 8001 / STD 8006 / 统筹 8003），**复刻 DSH 的 `ctx.tools.execute`**；
2. 伪造 `ctx`（`get/effect/tools.execute`）、伪造 webServer 注册表、伪造 req/res；
3. `import('./index.js')` → `apply(ctx, config)` → POST `/erp-sales-dashboard/api/dashboard`；
4. 打印各板块摘要 + 失败调用清单，并把完整响应写入 `docs/verify-host-output.json`；
5. 断言 `index.js` **没有**导出 `Config`（导出会让框架调 `Config.validate()` 而在激活期崩溃）。

`_verify_detail_routes.mjs` 复用同一套 harness，另外打三条实体档案路由，做 **PII 体检**（扫 phone/tel/address/duty_paragraph/id_card/bank/email/website/legal_person/remark/recipient_address/recipient_phone 键名），
并断言 bundle 的 `cordis.patch.yml` 配置键集合与 `index.js` 的 `DEFAULTS` **完全一致**（不一致直接失败）。

### 最近一次验证结果（2026-11-03，区间 2026-01-01 ~ 2026-10-25）

| 项目 | 结果 |
|---|---|
| 端到端取数 | HTTP 200 / 81 次 MCP 调用 / **0 次失败** / 1 条信息类告警（STD 预算上限）/ 约 156 秒 |
| 静态自检 | `selfcheck.mjs` **148 项全过**（含第 10 节实体档案路由、逾期归一、报价双口径、geo 预算与瘦身、订单状态码标注、collectionRate 自算断言） |
| 实体档案三路由 | 实机 **247 次 MCP 调用 / 0 失败**：客户档案 7.8s、业务员档案 2.9s、省份地图 31.9s；PII 体检 **0 命中**；地图缓存目录只落主看板 1 个文件（geo 未落盘） |
| 并发一致性 | `verify-host.mjs --parallel`（复刻 DSH 并发调用）与串行结果**完全一致** |
| 缓存 | `--cache-test` 两次同参数请求：**52.3s → 1ms**（命中磁盘缓存），`meta.cached=true`、`meta.cacheUntil` 正确 |
| AI 对话 | 真实调用 MiniMax：`ok:true`，`model=minimax-cn/MiniMax-M3.1-Flash`；空问题返回 `ok:false` + 「question 不能为空」；GET / 未知名 → 404 |
| 新兵口径 | `growth.newbies` **10 行全部为未转正的销售序列**（蛟龙/猛虎/鲲鹏，岗位全为「业务咨询经理」），note 写明「花名册 224 人 → 剔除非销售序列 134 人、剔除离职 56 人、剔除已转正 24 人、实际列示 10 人」 |
| 浏览器验收 | 10 个页签全部渲染、**0 个 console 错误**（页签 8 地图 svg 已渲染、页签 9 业务员档案 17 张卡）；AI 侧栏 14/14 项通过（并排布局、建议问题、多轮追问、错误回滚）；筛选下拉字色 DOM 验收通过（select/option = **#f9fafb**、font-weight 600/500） |
| 配色（v1.2.0） | 配色探针两轮（注入 DSH 真实别名 / 不注入走兜底）**结果一致**：根容器 `#151517` 底 + `#f9fafb` 主文字、卡片 `#232324`、表头 `#2c2c2e`、筛选下拉 `#f9fafb`、徽章 = 原始状态色 + 12% 底 + 45% 边框、空态 `#545557`；地图 34 省按客户数分 6 档着色；CSS 结构体检：括号配平、无游离 `}`、关键规则全部进 CSSOM |
| 订单状态码 | `saleState` 保留 ERP 原始码，另给 `saleStateLabel`（1=在途未完成 / 2=已完成）；依据三个月实测：码 1 的 45 单回款率 17.8%、码 2 的 260 单回款率 92.3% —— **经验推断，非官方码表**，notes 已注明 |

---

## 六、口径铁律（Host 半必须遵守）

1. 所有比率字段一律 **0~1**，百分号只在 UI 层渲染。
2. 取不到的指标用 **`null`**，绝不用 `0` 冒充。
3. **完成率自己算** = 区间签约额 ÷ 年度军令状目标；**禁用**上游 `signing_completion_rate`（分子区间、分母年度，口径错位）。
4. `total_performance_analysis.order_total_amount` 与 `sales_performance_ranking.signing_amount` **不可混用**。
5. STD 判定 = 货号在 STD 产品表中 **code 精确相等**（表查询是 LIKE 前缀匹配，必须精确比对）。
6. 列表类工具 limit 硬钳 500 且**无分页** → 用「换时间窗（按月/按天二分）」+「换维度」策略续读，并如实登记 completeness。
7. 部分源失败**不 reject**，降级出数并写入 `warnings` + `calls[].note`。
8. PII（电话/地址/身份证/银行账号）**不落盘**，不进入任何缓存文件。
9. **缓存以「有没有取数失败」为准，不以「有没有告警」为准**：`calls[].ok === false` 为 0 条即入缓存（TTL 6 小时），
   告警（warnings）属信息类提示，随结果一起显示并一起缓存；早期用「零告警才缓存」导致恒有 1 条 STD 预算告警 → 缓存永不命中 → 每次进面板重拉 3~5 分钟。
10. **新兵 = 尚未转正的业务咨询成员**（用户 2026-10-26 澄清后的口径）：
    判定**不按 `join_time ∈ 统计区间`**，而按「当前状态」筛 —— 「未转正」是状态，不是区间事件，
    所以这张表的**名单不随所选区间增减**，区间只影响业绩 / 客户数的统计口径（入职月数按基准日计算）。
    三步筛选（`staff_info` 是全公司花名册，技术/市场/行政都在里面）：
    ① **先确认是销售序列** —— 三条依据取**或**：`first_dep_name = 业务咨询事业群`（准一线，可配 `salesFirstDepName`）、
       `dep_name` 或 `second_dep_name` 命中**销售二级部门白名单**（鲲鹏特战队/猛虎特训营/海豹特战队/战狼特战队/蛟龙特训营/业务咨询事业群，
       白名单 = 固定兜底 ∪ `first_dep_name=事业群` 成员的 `dep_name` ∪ `sales_performance_ranking.department_name`）；
       ② 再剔除 `status === 0`（离职）；③ 再剔除**非销售岗**（`post_name` 不是「业务咨询经理」）；
    ④ 最后剔除**已转正**：`positive_time` 有值且 ≤ 基准日 → 已转正，不算新兵；
       `positive_time` 为空（转正日期未回填）→ 算未转正；`positive_time` 晚于基准日（已排期未到期）→ 也算未转正。
    **不要用「`job_no` 以 YX 开头」当判据** —— 市场发展部业务员10的 username 也是 `YX90017`（实测），会把非销售放进新兵表；
    早期版本正是因此漏进 3 个市场/行政人员，v5 起已删除该规则。
    新兵业绩用 `job_no ↔ member_performance_analysis.username` 主键连接（`sales_performance_ranking` 没有 username）。
11. **STD 探测必须串行**（上游 std MCP 单 session 内串行，单条 6~8 秒），见上文。
12. **AI 对话只把 user 角色的历史发给模型**（assistant 带正文会让 DSH llm 服务抛 `replayState` → 全候选模型失败）。
13. **屏幕显示与导出内容必须一致**：表格单元格的「屏幕值」和「导出值（TSV/CSV）」必须来自同一个格式化函数。
    DataTable 的约定是 `col.render`（屏幕）优先、其次 `col.text`（导出与屏幕共用）、最后原始值；
    **如果要在同一格里同时显示数值和徽章，就必须在 `render` 里两者都渲染**，否则屏幕会被导出值顶掉。
    v4 之前页签 1 梯队「完成率」就因此在屏幕上整列不显示（已修）。
14. **预警阈值可配置，配置以 `cordis.patch.yml` 为唯一真相源**：阈值不在业务逻辑里写死，统一走
    `resolveThresholds(settings.thresholds)` —— 非法值（NaN / 越界 0~1 / 负数）**自动回退默认**，
    只给部分键时其余保持默认，派生黄线按「目标 × 0.8」自动重算；
    实际生效值随 `meta.thresholds` 下发，页面第 10 页签有「智能预警阈值（本次生效）」卡片，不靠文字说明。
15. **梯队名乱码必须归并，且必须留痕**：`sales_performance_ranking` 里 0 业绩占位成员「占位成员01」的
    `department_name` 是坏字节解出来的 `"<U+FFFD×3>狼特战队"`（库里「战」字是坏字节）。
    它在 top-100 截断时会被切进来，页面上就会多出一条「0 人的假梯队」。
    修法：剥掉替换字符后按**最长公共后缀**匹配已知梯队名，**唯一命中且公共后缀 ≥3 字**才归并，
    否则宁可不猜（保留原名并告警）；归并**必须记一条 `warnings`**，页面看得见「做过归并」，不是悄悄改数。
    归并发生在**筛选之前**（否则按梯队筛选会漏掉被归并的成员）。
16. **PII 判定必须排除小数点两侧**：判「含手机号/身份证」的视断言要写成 `(?<![0-9.]) … (?![0-9.])`，
    不能只排除数字。否则普通浮点数会被误判成 PII（`0.050261205153015395` 里那 18 位数字像身份证，
    `5330.053140096618` 里那 12 位数字像座机）→ ① 整份结果被判为「含敏感信息」→ **磁盘缓存永远写不进去**
    （6 小时缓存只剩内存那一份，DSH 一重启就要重拉 3~5 分钟）；② 每次都向用户显示一条**不实的**「含手机号/身份证」告警。
    真实手机号 / 座机 / 身份证仍然命中（selfcheck 第 12 节 5 项行为级断言守住这条）。
17. **MCP 工具名前缀不得写死**：工具全名 = `mcp__<连接器名>__<工具名>`，连接器名每台设备自己起。
    插件启动时读 DSH 的连接器注册表 `<DSH_HOME>/storages/mcp_connector.json`（只读 `serverName`/`url`/`enabled`，
    **绝不读 `auth.apiKeyValue` 等凭据**），**按 url 端口认领**（8001=erp / 8006=std / 8003=planning），
    认不出再按 serverName 同名，最后回退内置默认名。前缀优先级：`config.toolPrefixes` > 注册表按端口 > 注册表按名 > 内置默认。
    首选前缀「工具不可见」时会**依次试兜底前缀**（配置 → 发现 → 默认 → 其它已启用连接器，去重后最多 4 个），
    但**真实错误（抛错 / 非不可见的 isError）必须立即停**，不能拿试错掩盖真实故障。
    生效前缀与来源写进 `meta.toolPrefixes` / `meta.toolPrefixSource`，页签 10「MCP 连接器（本机）」展示，
    认领不到时给 amber 提示与 `cordis.patch.yml` 的配置指引。
18. **未回款额必须归一**：`uncollectedAmount = 签约额 − 已回款额`。上游 `uncollected_amount` 会把**部分回款**订单按全额计入未回款，虚高；
    上游原值另存 `uncollectedAmountUpstream`，两者不等时在 `notes` 写差额，不悄悄覆盖。
19. **逾期天数必须归一**：上游给的是「距账期到期日的天数」，**负数 = 还没到期，不是逾期**。
    负数一律置 `null`，另给布尔 `overdue`（>0 才 true）；取不到时 `overdue` 也给 `null`，页面显示「未逾期」中性色，**不显示负数**。
20. **四套口径互不混用**（实体档案）：`periodMetrics` = 所选区间；`lifetime` = 客户全周期；
    `rating.metrics` = 近 12 个月；`benchmark` = 总盘口径。卡片上分别标注，不允许跨口径比较。
21. **同名多主体不猜**：`customer.dashboard` 按客户名命中多个主体时，返回 `resolved.candidates` + `resolved.ambiguous=true`，
    由用户在页面上点选；不默认选第一个，也不把多个主体的数加总。
22. **省份绝不靠公司名猜**：解析优先级 = `country===1`（海外）→ 统一社会信用代码第 3-4 位省码 → 地址省名前缀 →
    地址地级市表 → `area_name`；都不中就落 `uncovered` 并在页面列出未识别清单。
23. **PII 红线（实体档案加严）**：电话、座机、邮箱、地址、统一社会信用代码、银行账号、法律代表人、官网、备注
    **一律不进 payload、不进缓存**；`visits[]` 只保留白名单字段（时间/内容/礼品/拜访人），上游 `visits[].data` 里的
    `recipient_phone` / `recipient_address` 必须剥掉；`customer_info` 拿到的明文地址只用于**当场解析省份**，不外发。
24. **实体档案必须限流**：`detailBudget`（明细条数）、`geoBudgetMs`（墙钟）、`geoMaxRequests`（请求数）三重封顶；
    超预算即停手并在 `warnings` / `completeness` 里如实写明「取到多少、还差多少、为什么停」。
25. **报价 TOP 榜必须双口径**：样本内排名用 `share`（÷ 样本金额），与 KPI 同分母的占比用 `shareOfTotal`（÷ 全量报价额）；
    块级给 `basis:'sample'` + `sampleAmount` + `sampleShare`，页面必须写明「TOP10 基于 N 份抽样，不是全量 TOP10」。
26. **上游 limit 硬钳 500**：列表类工具传多大 limit 都只回 500 行（同一次响应的 `overview.order_count` 才是真实单数）。
    因此**截断判定一律用 `orders.length < overview.order_count`**，不能用「行数 < 我们请求的 limit」；
    确需全量时按日期对半拆窗重查（深度 ≤2），并用 `sale_id`/`sale_code` 去重兜住重叠。
27. **订单状态码不猜，但可标注推断**：`saleState` 原样保留 ERP 原始码（数字），另给 `saleStateLabel`
    （1 = 在途未完成、2 = 已完成）。该映射是**实测推断而非 ERP 官方码表** ——
    依据 2026-01/04/08 三个月：码 1 的 45 单回款率 17.8%、码 2 的 260 单回款率 92.3%。
    前端优先显示 `saleStateLabel`，缺失才退回「状态码 N」；`notes` 必须写明这是经验推断。
28. **配色只取 DSH 设计系统别名，不写死色值**：所有颜色一律 `var(--令牌, #兜底)`，
    令牌在 `.esd-root / .esdc-root / .esd-shell` **三个根选择器上同时声明**（只写一个 → 子树 `var()` 失效 → SVG 变黑）。
29. **CSS 结构必须体检**：括号配平 + 关键规则进 CSSOM（工作区 `_preview/diag3.mjs`）。
    顶层一个游离 `}` 会让 Chromium 把紧跟其后的整条规则当作「无 prelude 的块」**整条丢弃** ——
    v1.2.0 开发期就因此让 `.esd-root` 根容器规则（底色/布局/`color`）失效，
    表格单元与空态文字全部退回宿主默认黑色。改完 Client 半必须跑 `node --check` + 自检 + 配色探针。
30. **卡片底用实心层，不用半透明白叠层**：`bg-layer-1` 实底；半透明叠层在不同底色上会发灰、且会透出下层内容。

详见 `CONTRACT.md`。

---

## 七、已知边界（诚实声明）

- **A/B/C 订单分档**：ERP 的 `yx_sale.sale_level`（2 = B 类）只在 `customer_tier_rating` 的 `b_order_share` 里间接可读，
  且该接口**不支持批量**（每次只能一个客户）。因此团队级 ABC 占比只能**抽样**并标注样本量与覆盖率。
  抽样池取自 `total_performance_analysis.top_customers`（区间成交额 Top N 客户，真实降序），
  **不是** `customer_analysis` 的前 N 行 —— 后者按 ERP 默认顺序返回、且带日期区间时 `sales[]` 只回「页内有订单的客户」
  （实测 limit=500 + 日期只有 36 行），用它抽样会只覆盖 1.9% 的营收。
- **STD 占比**：STD 产品表无法全量枚举（limit≤500 且无分页），只能按报价金额 Top N 货号逐个精确探测，
  因此 STD 占比是**按金额覆盖率口径**，并标注已探测货号数与覆盖率。
  上游 std 服务单 session 内串行、单条查询 6~8 秒，所以探测**必须串行**（并发会全部超时 → 占比变 null）；
  探测受 `stdProbeBudget`（货号数）与 `stdProbeBudgetMs`（墙钟）双重封顶，超出部分按「未知」处理并计入 `warnings`。
- **获客 9 渠道归因 / 渠道 CPL**：ERP 无渠道字段，无法从 ERP 生成 → 在「口径与数据」页的**数据可得性矩阵**中如实标注「ERP 不承载」。
- **市场发展部 / 行政法宣部 / 政委双轨制考核**：属管理动作数据，ERP 只提供业绩与回款作为其**数据来源列**，
  权重与得分由管理侧维护，插件只渲染 ERP 可验证的部分。
- **客户跟进达标率**：基于 `sales_customer_360.visits[]` 的抽样，标注样本客户数与抽样方式。
- **复购分档**：分母只算「区间内订单数 ≥ 1」的客户，区间内无订单记录的客户单独计数（`excludedNoOrder`）并排除。
- **沉睡客户**：只有拿到末次订单时间的客户才能判定沉睡，因此该数是**样本口径**（卡片上标了参与判定的家数）。
- **抽样池不随梯队筛选收窄**：`filters.squad` 只影响业绩/订单/排名类板块；
  分档、跟进、拜访三类抽样用的是**全局 Top 客户**（ERP 的 `top_customers` 不带部门字段，无法按梯队切）。
  按梯队筛选时这三张卡仍反映全局 Top 客户，卡片上已注明抽样源。
- **新兵表的三个限制**：① 口径是「**当前尚未转正**的业务咨询事业群在职销售成员」，是**状态快照**，
  不随所选统计区间增减（区间只影响业绩/客户数口径）；技术/市场/行政人员、已离职人员、已转正人员、销售体系里的非销售岗（如企划）均已剔除；
  ② 新兵业绩按 `job_no ↔ member_performance_analysis.username` 连接，少数连不上的会落到 `signingSource = 'none'`（显示 0）；
  ③ 产品/技能考核明细、师傅评价、预计转正日期 **ERP 无字段**，表中不展示，「转正进度」只是金额进度（业绩 ÷ 门槛），不等于公司转正评审结论。
- **AI 对话的能力边界**：只回答**当前页签已加载的数据**（每页签只传该板块的切片 + 统计区间 + 筛选条件），
  问超出范围的问题会回「当前只加载了本板块数据，无法回答」；模型输出是分析建议，不是事实源，
  数字口径以页面卡片与「数据口径」页签为准。
- **梯队名乱码来自上游**：ERP 库里「战狼特战队」这个名称存在坏字节，MCP 侧按 UTF-8 解出替换字符。
  插件会按最长公共后缀归并回正确梯队名并在告警里写明（页面可见），但**根因在上游数据库**，
  需要运维侧修数据才能彻底消失。
- **客户省份地图的覆盖率不是 100%**：地图要逐个业务员分区扫 `customer_info`（上限 500/区），
  全量客户约 8,000 家，实测**扫描 300 家区间有成交的客户、定位 285 家（覆盖率 95.0%）**，
  未识别 1 家、海外 58 家。**未识别清单与「区间外客户」不在图上**，页面上分别列出，不假装全覆盖。
- **地图的订单额是区间口径、档案是全量口径**：省份的签约额来自区间订单聚合，客户档案来自全量客户表，
  两者的分母不同，页面已分别标注。
- **实体档案的明细受上游 limit 硬钳**：区间订单明细最多 500 行/次，询价/报价明细同理；
  超过部分用「按日期拆窗 + 去重」续读，仍超上限就在 `notes` 写明「区间订单明细受上游 limit=100 截断；区间订单总数 N 单」。
- **业务员「同侪对标」的排名范围有限**：`benchmark.rank` 只在 Top 100 内有值；梯队内样本 < 2 人时不出对标结论。
- **客户评级的得分有下限标记**：`rating.isLower_bound=true` 表示部分评分项因数据缺失被折叠，
  `rating.missingItems[]` 列出缺哪些，`completenessPct` 给出完整度 —— 得分不能当作绝对结论。
- **询报价 TOP10 是抽样内排名**：报价/询价明细上游硬钳 100 行，TOP 榜是**这 100 份抽样内**的排名，
  页面固定标注样本量与样本金额占比，不是全量 TOP10。
