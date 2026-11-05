#!/usr/bin/env bash
# 单技能测试上传脚本
# 用法：
#   bash push.sh                # 交互式读取 token（推荐，不留痕）
#   GITHUB_TOKEN=xxx bash push.sh
#
# Token 需具备 repo 权限：
#   GitHub → Settings → Developer settings → Personal access tokens → Generate
#   勾选 repo 权限，建议设置过期时间（如 30 天）

set -euo pipefail

REPO="https://github.com/Zhong1856572/3946.git"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "$DIR"

if [ -z "${GITHUB_TOKEN:-}" ]; then
  echo "请输入 GitHub Personal Access Token（输入不回显）:"
  read -rs GITHUB_TOKEN
  echo
fi

if [ -z "${GITHUB_TOKEN}" ]; then
  echo "错误：未提供 token" >&2
  exit 1
fi

# 用临时 header 配置注入凭据，不写入磁盘
AUTH_HEADER="Authorization: Basic $(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 -w0)"

echo "→ 校验 token ..."
LOGIN=$(curl -s -H "$AUTH_HEADER" https://api.github.com/user | python -c "import json,sys; print(json.load(sys.stdin).get('login','UNKNOWN'))" 2>/dev/null || echo UNKNOWN)

if [ "$LOGIN" = "UNKNOWN" ]; then
  echo "✗ token 校验失败" >&2
  exit 1
fi
echo "  登录账号: $LOGIN"

echo "→ 检查目标仓库 ..."
PERM=$(curl -s -H "$AUTH_HEADER" https://api.github.com/repos/Zhong1856572/3946 | python -c "import json,sys; d=json.load(sys.stdin); print(d.get('permissions',{}).get('push',False))" 2>/dev/null || echo False)
if [ "$PERM" != "True" ]; then
  echo "✗ 该 token 对目标仓库无 push 权限" >&2
  exit 1
fi
echo "  push 权限: 确认"

echo "→ 提交 ..."
git config user.name "Zhong1856572"
git config user.email "zhong1856572@users.noreply.github.com"
git add -A
git commit -q -m "feat: 导入 numeric-table-anchor-consistency 技能（单技能测试上传）

多表数值文档跨表口径一致性生成与校验 SOP，单文件 162 行。
本机路径已脱敏为占位符。

Co-Authored-By: WorkBuddy <noreply@workbuddy.ai>" 2>&1 | tail -2 || echo "(无变更则跳过)"

echo "→ 推送到 GitHub ..."
git -c "http.extraHeader=$AUTH_HEADER" push -u origin HEAD:main 2>&1 | tail -5

echo
echo "✓ 完成 —— 请访问 https://github.com/Zhong1856572/3946 验证"
