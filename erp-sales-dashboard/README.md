# ERP 销售仪表盘（DSH 插件）

面向业务咨询销售线的作战看板，**DeepSeek Harness（DSH）插件**，v1.4.0。
共 10 个页签：业绩达成总览、订单质量与结构、回款与售后、客户资产与激活、
获客与转化、学习考核与成长、订单待办、客户档案（含中国省份地图）、业务员档案、
数据口径与可得性；并内置 **AI 分析侧边对话框**。

所有数据都通过 **DSH 里已配置的 MCP 连接器**只读取数，插件本身不连数据库、不写业务数据。

> 本插件放在仓库的 `erp-sales-dashboard/` 子目录下（仓库根目录是另一套技能库）。
> 克隆后请先 `cd erp-sales-dashboard` 再执行下面的安装命令。

---

## 一、在另一台 DSH 上安装

### 方式 A：DSH「添加插件」GUI（最省事）

1. 到本仓库的 `erp-sales-dashboard/releases/` 目录下载 `erp-sales-dashboard-1.4.0.tgz`；
2. DSH → 插件 → 添加插件 → 选这个 `.tgz`；
3. **重启 DSH**（bundle 在 DSH 启动时扫描 profile 的 bundle 列表才会被注册）。

### 方式 B：克隆仓库后跑安装器（Windows / macOS / Linux 通用）

```sh
git clone https://github.com/Zhong1856572/3946.git
cd erp-sales-dashboard

# Windows
powershell -ExecutionPolicy Bypass -File .\install.ps1
.\check-install.ps1          # 只读自检，逐条打印 ✔ / ✘

# macOS / Linux
sh ./install.sh
sh ./check-install.sh
```

安装器做四件事：把插件文件复制到 `<DSH_HOME>/plugins/erp-sales-dashboard`；
在 profile 的 `package.json` 里登记依赖与 `dsh.profile.bundles`；
在 `node_modules/@local/erp-sales-dashboard` 建链接；
把配置写进 profile 的 `cordis.patch.yml`。**全程离线、不触碰其它插件、每次改前自动备份被改的两个文件。**

> 装完 **必须重启 DSH**。之后只改插件代码的话，改一下 profile 的 `cordis.patch.yml` 即可触发热重载。

### 方式 C：只取插件本体（不想装安装器）

`erp-sales-dashboard/releases/` 里的 `.tgz` 前缀是 `package/`，直接解包到 `<DSH_HOME>/plugins/erp-sales-dashboard`，
再手工在 profile 的 `package.json` 里加依赖与 bundles 登记（见 `INSTALL.md` §2）。

---

## 二、前提条件

| 项 | 要求 |
| --- | --- |
| DSH | 桌面版（bundle + web client 插件体系） |
| Node | ≥ 18（安装器是 `.mjs`；没有的话用 DSH 自带运行时 `<应用根>/resources/runtime/`） |
| MCP 连接器 | **必须先在 DSH 里连上** ERP / STD 两个连接器，否则面板取不到数 |
| AI 侧栏 | 需要 DSH 里有可用的 LLM provider（默认 `minimax-cn / MiniMax-M3.1-Flash`，缺凭据时回退到 DSH 当前选中的模型） |

DSH 的 MCP 连接器「服务器名」每台机器可能不同，工具名形如 `mcp__<连接器名>__<工具名>`。
本插件支持 `toolPrefixes` 配置 + 运行时自动发现：配置的前缀在这台机器上不存在时，
插件会自动尝试其它前缀，并在面板「数据口径与可得性」页签给出**实际用到的连接器名**。

连接器的**地址、端口、鉴权头名、密钥**请看 `INSTALL.md` §2.1 —— 这些由使用者按自己公司的环境填，
**本仓库不提供、也不包含任何端点地址或密钥**。

---

## 三、仓库里没有什么（安全边界）

本仓库**刻意不包含**以下内容：

- ❌ 任何 MCP 端点地址、API Key、鉴权头值（连占位模板文件都不提供，避免被误当成默认配置填进去）；
- ❌ 开发机内网 IP（文档里一律写 `<MCP主机>`，代码里的 mock URL 用 RFC 5737 保留段 `192.0.2.x`）；
- ❌ 真实业务数据（取数快照 `docs/verify-host-output.json`、含真实客户名与金额的页面截图）。

插件取数一律走**目标机器自己的** DSH 连接器配置，仓库里的代码不含任何指向具体服务的地址。

> 端口号 8001 / 8006 / 8003 仍出现在代码里 —— 那是插件**按端口认领本机 DSH 连接器**的功能逻辑
> （认不到再在 `cordis.patch.yml` 里用 `toolPrefixes` 写死），不含任何地址或密钥。

### 脱敏处理清单（发布到本仓库时做过）

| 原值 | 处理后 |
| --- | --- |
| 开发机内网 IP | 文档写 `<MCP主机>`；代码 mock 用 RFC 5737 保留段 `192.0.2.10` |
| 三个 MCP 服务的 x-api-key | **删除**，仓库内不保留任何密钥 |
| `mcp.endpoints.local.json` / `mcp.endpoints.example.json` | **删除**（连占位模板也不发，避免被误当默认配置填进去） |
| 取数快照 `docs/verify-host-output.json` | **删除**（含真实客户名与金额） |
| 真实人名 / 公司名 | 替换为 `业务员NN` / `示例客户NN` / `占位成员NN` 等合成占位 |
| 真实工号 / 客户编码前缀 | 替换为保留段前缀（`YX9xx` / `C9xxxx`） |

---

## 四、目录结构

```
erp-sales-dashboard/
├── install.mjs / install.ps1 / install.sh        安装器
├── uninstall.mjs / uninstall.ps1 / uninstall.sh  卸载器
├── check-install.mjs / check-install.ps1 / check-install.sh   安装核对（只读）
├── pack.mjs                                      打包脚本
├── manifest.json                                 机器可读元数据
├── README.md        ← 本文件（仓库说明）
├── INSTALL.md       详细安装手册
├── lib/             安装器用的小模块
├── bundle/          插件本体（index.js / client.js / cordis.patch.yml / docs/ …）
└── releases/        可直接安装的 zip / tgz
```

插件本体的说明见 `bundle/README.md`；
**HTTP 契约与响应 schema 的唯一事实源**是 `bundle/CONTRACT.md`；
口径圣经是 `bundle/docs/数据口径与准确性保障说明.md`。

---

## 五、自检与回归

```sh
cd bundle && node selfcheck.mjs        # 静态体检，不连 ERP
node test-regression.mjs               # 端到端回归（需要能连到 MCP）
```
