# Skill Library (Test Upload)

WorkBuddy 技能库备份仓库 —— **单技能测试上传**。

本次仅上传 1 个技能用于验证上传链路，内容已脱敏。

## 目录结构

```
skills/
└── numeric-table-anchor-consistency/
    └── SKILL.md
```

## 技能清单

| # | 技能 | 说明 |
|---|---|---|
| 1 | `numeric-table-anchor-consistency` | 多表数值文档（薪酬/费率/分档/测算表）的「跨表口径一致性」生成与校验 SOP |

## 说明

- 技能遵循 Agent Skills 规范，入口为 `SKILL.md`。
- 技能由 WorkBuddy 加载运行，路径为 `~/.workbuddy/skills/`。
- 涉及企业内部业务数据的技能已排除，详见 `脱敏审查报告.md`。

---

## 其他内容

| 目录 | 内容 |
| --- | --- |
| `erp-sales-dashboard/` | **ERP 销售仪表盘**（DeepSeek Harness 插件，v1.4.0）—— 面向业务咨询销售线的作战看板，含 10 个页签与 AI 分析侧栏 |

插件的安装方式、前提条件、安全边界与自检命令见
[`erp-sales-dashboard/README.md`](erp-sales-dashboard/README.md)；
可直接安装的发布包在 `erp-sales-dashboard/releases/`。

> 该插件仓库内**不含**任何 MCP 端点地址、密钥、内网 IP 与真实业务数据，
> 所需连接器信息由使用者按自己公司的环境自行填写。

