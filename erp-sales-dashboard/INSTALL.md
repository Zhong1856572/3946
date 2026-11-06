# ERP 销售仪表盘 · 插件安装手册（详细版）

> 本文是 `README.md` 的展开版。只想快速装上的话，看 [README 第四节「三步安装」](./README.md#四三步安装) 就够了。
> 本手册额外覆盖：**手工安装步骤**（不想跑脚本时）、**GUI 路线**、**逐项验证清单**、**故障排查表**、**给非技术同事的一页纸**。

---

## 目录

1. [安装包里有什么](#一安装包里有什么)
2. [前置检查清单](#二前置检查清单)
3. [路线 A：DSH 原生安装（推荐）](#三路线-adsh-原生安装推荐)
4. [路线 B：脚本安装（自动优先原生）](#四路线-b脚本安装自动优先原生)
5. [路线 C：全手工安装](#五路线-c全手工安装)
6. [逐项验证清单](#六逐项验证清单)
7. [故障排查表](#七故障排查表)
8. [配置项说明](#八配置项说明)
9. [卸载](#九卸载)
10. [给非技术同事的一页纸](#十给非技术同事的一页纸)

---

## 一、安装包里有什么

解压后：

```
erp-sales-dashboard-plugin-1.4.0/
├── install.mjs / install.ps1 / install.sh        ← 安装器
├── uninstall.mjs / uninstall.ps1 / uninstall.sh  ← 卸载器
├── check-install.mjs / check-install.ps1 / check-install.sh  ← 安装核对（只读）
├── pack.mjs                                      ← 重新打包用
├── manifest.json                                 ← 机器可读元数据
├── README.md                                     ← 速查手册
├── INSTALL.md                                    ← 本文件
├── lib/                                          ← 安装器自己的依赖（.mjs 模块）
├── bundle/                                       ← 插件本体
└── erp-sales-dashboard-1.4.0.tgz                 ← 标准 npm 包（供 DSH 原生命令 / GUI 安装）
```

`bundle/` 就是插件的完整源代码与资源（`index.js` / `client.js` / `cordis.patch.yml` / `locale/` / `docs/` / 自检脚本），安装时会被拷到 DSH 目录下。

**安装包里没有任何凭据。** 所有取数都走目标机器上 DSH 已配置好的 MCP 连接器；AI 对话走目标机器上 DSH 已配置好的 LLM。
包内也不含 `docs/screenshots`（6MB 截图），需要看效果图看 `bundle/docs/` 之外的官方文档。

**完整性校验**：包根目录带 `SHA256SUMS.json`，列出包内每个文件的 sha256。校验方法：

```sh
# Windows（PowerShell 5.1 自带）
Get-Content .\SHA256SUMS.json | ConvertFrom-Json | ForEach-Object {
  $h = (Get-FileHash $_.path -Algorithm SHA256).Hash.ToLower()
  "{0}  {1}" -f ($(if ($h -eq $_.sha256) { 'OK  ' } else { 'FAIL' }), $_.path)
}
```

`node check-install.mjs` 会自动做同样的比对（见[第六节](#六逐项验证清单)）。

---

## 二、前置检查清单

打勾再往下走：

| # | 检查项 | 怎么查 | 不满足怎么办 |
|---|---|---|---|
| 1 | Node.js ≥ 18 | `node -v` | 去 https://nodejs.org/ 装 LTS |
| 2 | 装了 DSH 桌面版并能启动 | 打开 DSH 看左侧面板 | 先装 DSH |
| 3 | ERP MCP 连接器已连上 | DSH 的连接器/工具页里能看到 `mcp__erp__*` 的工具 | 在 DSH 里配置 ERP 数据分析连接器 |
| 4 | STD MCP 连接器已连上 | 同上，能看到 `mcp__std__*` | 配置 ERP Unified Analytics / STD 连接器 |
| 5 | 统筹 MCP 连接器已连上（可选） | 能看到 `mcp__planning__*` | 缺了也能用，只是部分板块取不到数 |
| 6 | 知道 DSH home 在哪 | 看 DSH 设置页；默认 `C:\Users\<你>\.dsh`（macOS/Linux `~/.dsh`） | 装的时候用 `--dsh-home` 指定 |
| 7 | 知道 profile 名 | 默认是 `desktop` | 装的时候用 `--profile` 指定 |

> **第 3~5 条最关键。** 插件不会自己去连 ERP，它只调用 DSH 里已经配好的 MCP 连接器。连接器没配的面板会显示「不可得」，不会报错，但也没有数。

### 2.1 怎么把三个 MCP 连接器接进目标机（照这张表填）

在目标机的 DSH 里打开**连接器 / 工具**页面 → 新建**自定义 MCP 连接**，按下面三项各建一个：

| 用途 | 连接地址（url） | 传输 | 鉴权方式 | 鉴权头名 | 密钥（x-api-key） |
|---|---|---|---|---|---|
| ERP 销售数据（主库） | `http://<MCP主机>:8001/mcp` | streamable-http | api-key | `x-api-key` | 向公司要 ERP 连接器的 key |
| STD 高纯/标准品 | `http://<MCP主机>:8006/mcp` | streamable-http | api-key | `x-api-key` | 向公司要 STD 连接器的 key |
| 统筹/采购（可选） | `http://<MCP主机>:8003/mcp` | streamable-http | api-key | `x-api-key` | 向公司要统筹连接器的 key |

要点（都实测过）：

- **连接器名随便起**，不用和本机一致。DSH 里工具全名 = `mcp__<连接器名>__<工具名>`，插件启动时会读
  `<DSH_HOME>/storages/mcp_connector.json`，**按 url 的端口自动认领**（8001→erp / 8006→std / 8003→统筹），
  认不到才需要你在 `cordis.patch.yml` 里显式写 `toolPrefixes`。
- **局域网明文 HTTP**：`<MCP主机>` 是内网地址，DSH 会拦 http，需要勾选/填写
  `allowInsecurePrivateNetwork: true`（连接器页面上的「允许内网明文 HTTP」之类选项）。
- **必须能访问公司内网**：这三个地址在内网，目标机不在内网就取不到数。
- 三个都接好后，`check-install.mjs` 会直连探测（erp 10 个工具 / std 4 个工具应全部命中），并打印实际认领到的前缀。
- 不想自己点页面也行：在目标机的 DSH 对话框里直接说
  「用 mcp_connector_configure 帮我加这三个 MCP 连接：url 分别是 …/8001/mcp、…/8006/mcp、…/8003/mcp，
  鉴权头 x-api-key，密钥是 …」，由 DSH 自己的连接器工具写入。

---

## 三、路线 A：DSH 原生安装（推荐）

DSH 自带插件管理命令，**这是最省事、也最不容易出错的一条路**。

安装包里带了 `erp-sales-dashboard-1.4.0.tgz`（标准 npm 包结构，`package/` 前缀，内容 = `bundle/`）。

### 3.1 命令行（Windows / macOS / Linux 通用）

```sh
dsh plugin --profile desktop add file:<erp-sales-dashboard-1.4.0.tgz 的绝对路径>
```

> `dsh plugin` 会把后面的参数**原样转发给 profile 目录里的 pnpm**，所以 `file:` 后面必须是**绝对路径**。
> 不知道 `dsh` 在哪？`dsh` 在 PATH 里就直接用；不在的话通常在这几个位置：
> Windows `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`
> 或 `<DSH 安装目录>/resources/runtime/cli/bin/dsh.cmd`；macOS `~/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`。

### 3.2 图形界面

DSH 的插件管理界面支持填 **tarball / 本地绝对路径**，把 `erp-sales-dashboard-1.4.0.tgz` 交给它即可。

### 3.3 这条命令做了什么

| 步 | 动作 | 落点 |
|---|---|---|
| 1 | 把 tgz 装进 profile | `<profile>/node_modules/@local/erp-sales-dashboard/`（pnpm 写入） |
| 2 | 写依赖 | `<profile>/package.json` → `dependencies["@local/erp-sales-dashboard"] = "file:<tgz 绝对路径>"` |
| 3 | 登记 bundle | `<profile>/package.json` → `dsh.profile.bundles` 追加 `"@local/erp-sales-dashboard"` |

### 3.4 这条命令**不做**的事（务必读）

- **不写 `cordis.patch.yml` 的配置块。** 装完你得**手工**补上[第五节 5.3](#53-改-profile-的-cordispatchyml)那一段 YAML，否则：
  - 缓存时长会用插件默认值（还是 6 小时，这项没影响）；
  - **AI 对话的 provider / model 不会写进去**，侧栏走插件的兜底逻辑；
  - **预警阈值**用插件内置默认值。
  - 不想手工补的话，装完再跑一次 `node install.mjs --force`，脚本是幂等的，会把配置块补齐（不会重复添加）。
- **不保证保留你原有的 bundles 登记。** DSH 的插件管理器是按 `node_modules` 里实际存在的插件**重建**这个列表的，只登记在 `package.json` 里、没装进 `node_modules` 的旧插件会被顺带清掉。装之前建议先备份 `<profile>/package.json`。

### 3.5 ⚠ 首次安装要重启 DSH

**首次安装必须重启**（插件要在 DSH 启动时扫描 profile 的 bundle 列表才会被注册）。关窗口 + 重新打开，别只关标签页。

> **已经装过一次、之后只是改了插件代码？不用重启。**
> 实测（2026-10-26）：改一下 profile 的 `cordis.patch.yml`（哪怕加一行注释），DSH 会重放补丁并**重新 import 插件代码**，
> 改动立刻生效。改完到浏览器里刷新一下面板即可。
> （`client.js` 是浏览器按需拉的静态文件，刷新页面就生效；`index.js` 走上面这条热重载。）

---

## 四、路线 B：脚本安装（自动优先原生）

不想手敲命令就跑脚本。脚本**默认也走 DSH 原生命令**，找不到 CLI 或原生安装失败时**自动回落到手工安装**，并在输出里写明回落原因。

### 4.1 Windows

```powershell
# 解压（PowerShell 5.1 自带）
Expand-Archive -Path .\erp-sales-dashboard-plugin-1.4.0.zip -DestinationPath D:\dsh-plugins

cd D:\dsh-plugins\erp-sales-dashboard-plugin-1.4.0

# 先干跑一遍，看清楚它要动哪些文件（不动任何文件）
node install.mjs --dry-run

# 正式安装
powershell -ExecutionPolicy Bypass -File .\install.ps1

# 核对
node check-install.mjs
```

> `install.ps1` 只是「找到 node + 转发参数 + 透传退出码」的薄包装，也可以直接 `node install.mjs`，效果完全一样。

### 4.2 macOS / Linux

```sh
unzip erp-sales-dashboard-plugin-1.4.0.zip -d ~/dsh-plugins
cd ~/dsh-plugins/erp-sales-dashboard-plugin-1.4.0

node install.mjs --dry-run
sh ./install.sh
node check-install.mjs
```

### 4.3 安装参数

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--profile <名称>` | `desktop` | DSH profile 名 |
| `--dsh-home <目录>` | `$DSH_HOME` → `~/.dsh` | DSH home |
| `--tgz <文件>` | 同级 `erp-sales-dashboard-1.4.0.tgz` | 直接指定要装的插件包（tgz） |
| `--bundle-dir <目录>` | 脚本同级 `bundle/` → 同级 `.tgz` | 插件包来源 |
| `--target <目录>` | `<dsh-home>/plugins/erp-sales-dashboard` | 插件安装目录（手工模式用） |
| `--dsh-cli <路径>` | 自动探测 | DSH 命令行路径（原生模式用） |
| `--native` | **默认开** | 强制走 DSH 原生插件命令 |
| `--no-native` | — | 强制走手工安装（拷贝目录 + 改配置 + 建链接） |
| `--config k=v,k=v` | — | 覆盖配置，见[第八节](#八配置项说明) |
| `--dry-run` | — | 只打印要做什么，**不落盘** |
| `--force` | — | 目标目录已存在时覆盖重装 |
| `--help` | — | 帮助 |

退出码：`0` 成功 / `1` 失败 / `2` 参数用错。

### 4.4 两种模式分别做了什么

**原生模式（默认）** —— 调 `dsh plugin --profile <p> add file:<tgz>`，子进程输出原样透传（pnpm 进度条、DSH 告警都看得到）：

| 步 | 动作 | 落点 |
|---|---|---|
| 1 | 现场打一个 tgz（排除截图/凭据/备份/缓存） | `<dsh-home>/plugins/erp-sales-dashboard-1.4.0.tgz` |
| 2 | 调 DSH 原生命令安装 | `<profile>/node_modules/@local/erp-sales-dashboard/`（pnpm 写入） |
| 3 | 写依赖 | `<profile>/package.json` → `dependencies["@local/erp-sales-dashboard"] = "file:<tgz 绝对路径>"` |
| 4 | 登记 bundle | `<profile>/package.json` → `dsh.profile.bundles` 含 `"@local/erp-sales-dashboard"`（**并把被 DSH 重建掉的原有登记补回**） |
| 5 | 写配置块 | `<profile>/cordis.patch.yml` → `- id: erp-sales-dashboard` 块（**有则替换，不追加第二条**） |
| 6 | 备份 | `<profile>/package.json.bak-<时间戳>`、`<profile>/cordis.patch.yml.bak-<时间戳>` |

**手工模式（`--no-native`）**：

| 步 | 动作 | 落点 |
|---|---|---|
| 1 | 拷贝插件包（自动跳过 `node_modules`、`cache`、`docs/screenshots`、`*.bak-*`、`*.local.json`） | `<dsh-home>/plugins/erp-sales-dashboard/` |
| 2 | 备份 | `<profile>/package.json.bak-<时间戳>`、`<profile>/cordis.patch.yml.bak-<时间戳>` |
| 3 | 加依赖 | `<profile>/package.json` → `dependencies["@local/erp-sales-dashboard"] = "link:<插件目录>"` |
| 4 | 登记 bundle | `<profile>/package.json` → `dsh.profile.bundles` 追加 `"@local/erp-sales-dashboard"` |
| 5 | 写配置块 | `<profile>/cordis.patch.yml` → `- id: erp-sales-dashboard` 块（**有则替换，不追加第二条**） |
| 6 | 建链接 | `<profile>/node_modules/@local/erp-sales-dashboard` → 插件目录（Windows 用 **junction**，不需要管理员） |

> 手工模式的依赖写的是 `link:<安装目录>`，**不是** `file:` tgz 路径 —— tgz 被挪走了依赖就断。

只动你自己 profile 里的**这一个插件块**和 **package.json 里的两行**；其它插件的配置、注释、排版全部原样保留。

### 4.5 原生失败会自动回落

找不到 DSH 命令行、pnpm 装不上、profile 里别的插件依赖不可解析……这些情况下脚本**不会直接失败**，而是自动回落到手工安装模式，并在输出里写明：

> 原生安装未成功，已回落到手工安装模式，原因：…

回落时依赖会写成 `link:<安装目录>`，功能完全一样，只是插件由我们拷过去而不是 pnpm 装。

---

## 五、路线 C：全手工安装（不想跑脚本、也不想用 GUI 时）

> 目标机器没装 Node、或者公司安全策略不让跑脚本时用这条路。

### 5.1 拷贝插件

把安装包里的 **`bundle/` 整个目录**拷到：

```
<dsh-home>\plugins\erp-sales-dashboard
```

拷贝时**删掉**这几项：`node_modules`、`cache`、`docs\screenshots`、`*.bak-*`、`mcp.endpoints.local.json`（这个是含真实凭据的本机文件，**绝不能带到别的机器**）。

### 4.2 改 profile 的 `package.json`

打开 `<dsh-home>\profiles\desktop\package.json`，做两处改动：

```jsonc
{
  "dependencies": {
    // … 其它依赖 …
    "@local/erp-sales-dashboard": "link:C:/Users/<你>/.dsh/plugins/erp-sales-dashboard"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // … 其它 bundle …
        "@local/erp-sales-dashboard"
      ]
    }
  }
}
```

⚠ **路径必须用正斜杠 `/`**，`C:\Users\...` 这种反斜杠写法在 JSON 里会被转义，DSH 读不出来。

### 5.3 改 profile 的 `cordis.patch.yml`

在 `<dsh-home>\profiles\desktop\cordis.patch.yml` 里加一个块（位置无所谓，DSH 按 id 找）：

```yaml
- id: erp-sales-dashboard
  name: '@local/erp-sales-dashboard'
  config:
    # 缓存有效期（毫秒）。21600000 = 6 小时：首屏打开不重复调取上游，
    # 同一组筛选条件在 6 小时内直接命中缓存。
    cacheTtlMs: 21600000
    requestTimeoutMs: 30000
    rowLimit: 100
    stdProbeBudget: 24
    tierSampleSize: 12
    customerSampleSize: 12
    visitSampleSize: 10
    exhaustiveBudget: 120
    # STD 判定探测的墙钟预算（毫秒）。上游 std MCP 单 session 串行、单条 6~8 秒，
    # 探测必须串行，这个预算是整段封顶（210 秒 = 3.5 分钟）。
    stdProbeBudgetMs: 210000
    # 销售序列在花名册里的顶层事业群名；新兵表只统计这个事业群的成员。
    salesFirstDepName: 业务咨询事业群
    # 新兵转正业绩门槛（元）。方案模板参数，ERP 没有对应字段。
    newbieTargetAmount: 200000
    # 智能预警阈值（红黄绿三色 + 自定义阈值）。只写要改的键即可；
    # 数值一律 0~1 的比率；非法值自动回退默认。
    # 方向：stdShare / bShare / collectionRate 越高越好；cShare 越低越好；growthDrop 是降幅红线。
    thresholds:
      stdShare: 0.6
      bShare: 0.4
      cShare: 0.15
      collectionRate: 0.9
      growthDrop: 0.2
    # AI 对话模型；留空则由插件按「agentDefaultModel 当前选择 → minimax → 其它」兜底。
    aiProvider: minimax-cn
    aiModel: MiniMax-M3.1-Flash
```

> 完整字段说明见 `bundle/cordis.patch.yml`。

### 5.4 建 node_modules 链接

```powershell
# Windows（junction，不需要管理员权限）
cmd /c mklink /J "<dsh-home>\profiles\desktop\node_modules\@local\erp-sales-dashboard" "<dsh-home>\plugins\erp-sales-dashboard"
```

```sh
# macOS / Linux
mkdir -p "<dsh-home>/profiles/desktop/node_modules/@local"
ln -s "<dsh-home>/plugins/erp-sales-dashboard" "<dsh-home>/profiles/desktop/node_modules/@local/erp-sales-dashboard"
```

> `node_modules\@local\` 这个目录如果不存在，先 `mkdir` 出来。

### 5.5 重启 DSH

**首次安装必须重启**（插件要在 DSH 启动时扫描 profile 的 bundle 列表才会被注册）。

> 已经装过一次、之后只是改了插件代码？改一下 profile 的 `cordis.patch.yml`（哪怕加一行注释），
> DSH 会重放补丁并**重新 import 插件代码**，改动立刻生效，浏览器刷新即可，不用重启。

---

## 六、逐项验证清单

装完按顺序过一遍，全绿才算装成功。

### 6.1 `node check-install.mjs`（只读，秒出）

它会逐项打勾：

- [ ] DSH home / profile 目录存在
- [ ] 插件目录存在，关键文件齐全（`index.js` / `client.js` / `package.json` / `cordis.patch.yml` / `icon.svg` / `locale/zh.json`）
- [ ] `node_modules` 链接存在且指向正确
- [ ] profile `package.json` 里有依赖 + bundles 登记
- [ ] profile `cordis.patch.yml` 里**恰好一条**插件块，配置值与预期一致
- [ ] `node --check index.js` / `node --check client.js` 语法通过
- [ ] 结尾提示「首次安装请重启 DSH → 打开左侧面板」

退出码 `0` = 全通过，`1` = 有项目不通过。

### 6.2 `node selfcheck.mjs`（插件自检，只读）

```sh
cd <dsh-home>/plugins/erp-sales-dashboard
node selfcheck.mjs
```

**117 项**行为级断言，覆盖：口径铁律、AI 对话契约、销售序列判定、新兵「未转正」口径、PII 判定、缓存规则、阈值可配置化、序列化与降级。

### 6.3 `node verify-host.mjs`（端到端取数，**需要 MCP 端点**）

```sh
node verify-host.mjs 2026-01-01 2026-10-25
```

产出真实 ERP 数据的响应体到 `docs/verify-host-output.json`。**需要先配端点**：

- 环境变量：`ERP_MCP_URL` / `ERP_MCP_KEY`、`STD_MCP_URL` / `STD_MCP_KEY`、`PLANNING_MCP_URL` / `PLANNING_MCP_KEY`
- 或在脚本同目录放 `mcp.endpoints.local.json`（**本地文件，不随安装包分发**）
- 或放 `mcp.endpoints.json`

```sh
# 手工新建 mcp.endpoints.local.json：填 url 与 x-api-key（结构见 §2.1）
node verify-host.mjs 2026-01-01 2026-10-25
```

端点写法：`"http://<MCP主机>:8001/mcp"`。

> `docs/verify-host-output.json`（开发机真实数据快照）**不随本仓库与安装包分发**，仅留存于开发机本地。

### 6.4 装进 DSH 后的目视验收

1. 重启 DSH
2. 左侧面板找到「**ERP 销售仪表盘**」
3. 第一次打开：等 4~5 分钟（首屏要拉真实数据）
4. 10 个页签逐个点开，确认有内容
5. 刷新一下页面再进 → 应当**秒开**（6 小时缓存命中）
6. 页签 8 → 看「缓存」卡片显示「命中」和剩余时间
7. 任选一页签点「AI 分析」→ 右侧滑出对话面板 → 问一句「本月回款率多少」→ 应有数

---

## 七、故障排查表

| 现象 | 最可能的原因 | 怎么修 |
|---|---|---|
| 面板里根本没有「ERP 销售仪表盘」 | 没重启 DSH（首次安装必须重启） | 重启 DSH（关窗口 + 重新打开，别只关标签页） |
| 同上，但 `check-install.mjs` 全绿 | profile 名不对 | 装的时候用 `--profile <真实名>`；DSH 设置页能看到当前 profile |
| `check-install.mjs` 报「链接指向不对」 | 手工建过链接，指向旧目录 | 删掉那个链接重跑 `node install.mjs --force` |
| 链接创建失败 / 权限不足 | 策略禁止建 junction | 用**管理员** PowerShell 重跑一次 `install.ps1`；或手工 `cmd /c mklink /J ...` |
| 页面所有数字都是「不可得」 | MCP 连接器没连 / 连不上 | 在 DSH 里检查 `mcp__erp__*` 连接器状态；确认能访问内网 MCP 主机 |
| 一直转圈不返回 | 上游 MCP 慢或被限流 | 等（首屏 4~5 分钟正常）；看页签 8 的「取数耗时」与「调用记录」 |
| AI 侧栏报错 | 没配 LLM provider | 配 `MINIMAX_CN_API_KEY`（默认模型 minimax-cn / MiniMax-M3.1-Flash），或在补丁块里改 `aiProvider` / `aiModel` |
| AI 侧栏答非所问 / 说「无法回答」 | 问的是当前页签之外的数据 | 侧栏只拿到**当前页签**的数据，换到对应页签再问 |
| 改了阈值页面没变 | 改了 `index.js` 而不是 `cordis.patch.yml` | 阈值在补丁层（热重载，刷新即可）；代码改动也可用「touch profile 的 cordis.patch.yml」触发热重载（首次安装才需重启） |
| 第二次打开还是重新拉数 | 缓存没写入 | 看页签 8 的「缓存」卡片；若显示「未命中」，检查取数过程有没有失败（失败的调用不会入缓存） |
| 装机需要连公司内网吗 | — | **需要**。ERP/STD/统筹 MCP 在内网（默认 `<MCP主机>:8001/8003/8006`） |

---

## 八、配置项说明

配置写在 profile 的 `cordis.patch.yml` 的 `- id: erp-sales-dashboard` 块里。

| 键 | 默认值 | 含义 |
|---|---|---|
| `cacheTtlMs` | `21600000` | 缓存有效期（毫秒）。默认 6 小时。改成 `3600000` 就是 1 小时。 |
| `requestTimeoutMs` | `30000` | 单次 MCP 调用超时（毫秒） |
| `rowLimit` | `100` | 明细类查询的行数上限 |
| `stdProbeBudget` | `24` | STD 判定探测的**货号个数**上限 |
| `stdProbeBudgetMs` | `210000` | STD 判定探测的**墙钟预算**（毫秒）。上游 std MCP 单 session 串行，探测必须串行 |
| `tierSampleSize` | `12` | 客户分档抽样客户数 |
| `customerSampleSize` | `12` | 客户分析抽样客户数 |
| `visitSampleSize` | `10` | 跟进记录抽样客户数 |
| `exhaustiveBudget` | `120` | 全量穷举的调用预算 |
| `salesFirstDepName` | `业务咨询事业群` | 销售序列在花名册里的顶层事业群名 |
| `newbieTargetAmount` | `200000` | 新兵转正业绩门槛（元） |
| `thresholds.stdShare` | `0.6` | STD 营收占比目标（0~1） |
| `thresholds.bShare` | `0.4` | B 类订单占比目标（0~1） |
| `thresholds.cShare` | `0.15` | C 类订单占比上限（0~1，越低越好） |
| `thresholds.collectionRate` | `0.9` | 回款率目标（0~1） |
| `thresholds.growthDrop` | `0.2` | 业绩降幅红线（0~1，超出即红色预警） |
| `aiProvider` | `minimax-cn` | AI 对话模型 provider；留空则由插件兜底选择 |
| `aiModel` | `MiniMax-M3.1-Flash` | AI 对话模型名 |

**非法值会自动回退默认**（NaN、越界、负数、非数字都不会让插件崩）。

安装时也能直接覆盖：

```sh
node install.mjs --config stdShare=0.65,cShare=0.1,cacheTtlMs=7200000 --force
```

> 阈值键写的是**扁平名**（`stdShare`），脚本会自动放进 `thresholds` 子对象。

---

## 九、卸载

```sh
# Windows
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
# macOS / Linux
sh ./uninstall.sh

# 连插件目录一起删
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 --purge
```

卸载会：

1. 备份 profile 的 `package.json` 与 `cordis.patch.yml`
2. 删掉 `package.json` 里的依赖与 bundles 登记
3. 删掉 `cordis.patch.yml` 里的插件块
4. 删掉 `node_modules` 里的链接
5. `--purge` 才删插件目录

卸载后建议**重启 DSH**，让插件从运行中的进程里彻底退出。

> 提示：卸载只删块**本体**，块上方你自己写的注释行会保留。

---

## 十、给非技术同事的一页纸

> **我想在另一台电脑上装这个看板，怎么做？**

1. 装 **Node.js 18 或更高版本**（nodejs.org，选 LTS，一路下一步）。
2. 把安装包 `erp-sales-dashboard-plugin-1.4.0.zip` 解压到一个固定目录，比如 `D:\dsh-plugins`。
3. 打开 PowerShell，粘贴这三行：

   ```powershell
   cd D:\dsh-plugins\erp-sales-dashboard-plugin-1.4.0
   powershell -ExecutionPolicy Bypass -File .\install.ps1
   node check-install.mjs
   ```

4. **关掉 DSH 再打开**（这一步不能省）。
5. 左侧面板找「**ERP 销售仪表盘**」。

**装不上打这个电话之前先看两件事**：

- 目标电脑上，DSH 里**有没有连上 ERP 的数据连接器**？（没连的话面板会一片「不可得」）
- 目标电脑**能不能连公司内网**？（ERP 数据在内网服务器上）

**装完要等很久吗？** 第一次要 4~5 分钟（在拉真实数据）；之后 6 小时内都是秒开。
